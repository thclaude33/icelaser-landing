/**
 * /api/crm-webhook — Recebe eventos do Chatwoot CRM
 * Quando label muda → dispara CAPI/Pixel automaticamente
 *
 * Labels → Eventos CAPI:
 *   🧊 Lead Frio       → Lead (cold_lead)
 *   🔥 Lead Quente     → Lead + CompleteRegistration (hot_lead)
 *   💰 Compra Realizada → Lead + CR + InitiateCheckout + Purchase
 */

import { put, list } from '@vercel/blob';
import { PIXEL_ID, GRAPH_BASE, DEFAULT_PURCHASE_VALUE, DEFAULT_PREDICTED_LTV } from './_lib/config.js';
import { sha256, normalizePhoneBR, verifyChatwootSignature, timingSafeStringEqual, maskPhone, maskEmail, maskName, getRawBody } from './_lib/security.js';
import { buildUserData, hashPII } from './_lib/piiBuilder.js';
import { PARTNER_AGENT } from './_lib/capi.js';

// Raw body necessário pra validação HMAC (re-serialização JSON.stringify não
// preserva byte-por-byte o body original que Chatwoot usou pra computar signature).
export const config = {
  api: { bodyParser: false },
};

// Alias local (normalizePhoneBR é a única fonte de verdade em _lib/security.js).
const normalizePhone = normalizePhoneBR;

/**
 * Valida webhook Chatwoot usando DUAS camadas:
 *  1. HMAC signature oficial (Chatwoot 3.17+): HMAC-SHA256(secret, "{ts}.{body}")
 *  2. Query token (fallback pra Chatwoot < 3.17): ?auth=TOKEN na URL do webhook
 *
 * Chatwoot antigo (como o rodando no Railway, versão 2024) não envia HMAC.
 * Workaround: incluir token na URL do webhook configurada em Chatwoot Settings.
 * URL: https://icelasers.com.br/api/crm-webhook?auth=XXXX
 *
 * Modo WARN-ONLY por padrão. Ativar bloqueio via CHATWOOT_WEBHOOK_ENFORCE=1.
 */
function validateChatwootWebhook(req, rawBody) {
  const secret = process.env.CHATWOOT_WEBHOOK_SECRET;
  const queryToken = process.env.CHATWOOT_WEBHOOK_QUERY_TOKEN;

  // SEGURANÇA: se NENHUM método de auth configurado, REJEITAR (fail-safe).
  // Antes permitia tudo se env vars faltassem — webhook aberto pra spoofing,
  // polui EMQ/tracking. Força explicitar ao menos um método em env.
  if (!secret && !queryToken) return { valid: false, mode: 'no-auth-configured' };

  // 1. Try HMAC signature (Chatwoot 3.17+)
  const sig = req.headers['x-chatwoot-signature'];
  const ts = req.headers['x-chatwoot-timestamp'];
  if (secret && sig && ts) {
    const valid = verifyChatwootSignature(rawBody, sig, ts, secret);
    return { valid, mode: valid ? 'hmac-valid' : 'hmac-invalid' };
  }

  // 2. Fallback: query token na URL (compat com Chatwoot antigo)
  if (queryToken) {
    const reqUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const providedToken = reqUrl.searchParams.get('auth') || '';
    if (timingSafeStringEqual(providedToken, queryToken)) {
      return { valid: true, mode: 'query-token-valid' };
    }
    return { valid: false, mode: 'query-token-invalid-or-missing' };
  }

  // Secret configurado mas Chatwoot não enviou signature (old version)
  return { valid: false, mode: 'no-signature' };
}

async function sendCAPI(events, token, retryCount = 0) {
  // Authorization: Bearer (mais seguro que access_token na URL)
  // partner_agent: Meta best practice — identifica plataforma emissora (<23 chars, >=2 letras).
  const res = await fetch(
    `${GRAPH_BASE}/${PIXEL_ID}/events`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ data: events, partner_agent: PARTNER_AGENT }),
    }
  );

  // Monitorar X-App-Usage e X-Business-Use-Case-Usage pra antecipar rate limits
  const appUsage = res.headers.get('x-app-usage');
  if (appUsage) {
    try {
      const usage = JSON.parse(appUsage);
      if (usage.call_count > 80 || usage.total_cputime > 80 || usage.total_time > 80) {
        console.warn(`[CAPI] ⚠️ Rate limit approaching: call_count=${usage.call_count}% cpu=${usage.total_cputime}% time=${usage.total_time}%`);
      }
    } catch {}
  }
  const bucUsage = res.headers.get('x-business-use-case-usage');
  if (bucUsage) {
    try {
      const buc = JSON.parse(bucUsage);
      for (const [bizId, entries] of Object.entries(buc)) {
        for (const e of entries) {
          if (e.call_count > 80 || e.total_cputime > 80 || e.total_time > 80) {
            console.warn(`[BUC] ⚠️ ${e.type} limit approaching: call=${e.call_count}% cpu=${e.total_cputime}% time=${e.total_time}% | recover=${e.estimated_time_to_regain_access}min`);
          }
        }
      }
    } catch {}
  }

  const result = await res.json();

  // Error handling com is_transient e blame_field_specs
  if (result.error) {
    const { code, error_subcode, message, is_transient, error_user_title } = result.error;
    const blame = result.error.blame_field_specs ? ` | blame: ${JSON.stringify(result.error.blame_field_specs)}` : '';
    console.error(`[CAPI ERROR] code=${code} subcode=${error_subcode} transient=${is_transient} msg=${message}${blame}`);

    // Retry apenas em erros transientes (max 2 retries com backoff)
    if (is_transient && retryCount < 2) {
      const delay = (retryCount + 1) * 1000; // 1s, 2s
      console.log(`[CAPI] Retrying in ${delay}ms (attempt ${retryCount + 1}/2)...`);
      await new Promise(r => setTimeout(r, delay));
      return sendCAPI(events, token, retryCount + 1);
    }
  }

  return result;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Prefer dataset-scoped token (CAPI_DATASET_TOKEN) — gerado no Events Manager > API de
  // Conversões. Escopo reduzido: só consegue postar events no pixel. Fallback pro
  // META_ACCESS_TOKEN (System User broad scope) se ainda não setado.
  const token = process.env.CAPI_DATASET_TOKEN || process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'meta_token_not_configured' });

  // Ler raw body (bodyParser:false) — necessário pra HMAC validar byte-por-byte
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    console.error('[CRM-WEBHOOK] raw body read failed:', e.message);
    return res.status(400).json({ error: 'body read failed' });
  }

  // ── Auth check (HMAC signature OU query token) — WARN-ONLY por padrão ──
  // Ativa enforcement com CHATWOOT_WEBHOOK_ENFORCE=1 depois de validar.
  const authCheck = validateChatwootWebhook(req, rawBody);
  if (!authCheck.valid) {
    const enforce = process.env.CHATWOOT_WEBHOOK_ENFORCE === '1';
    console.warn(`[CRM-WEBHOOK] ⚠️ AUTH ${authCheck.mode} | enforce=${enforce}`);
    if (enforce) {
      return res.status(401).json({ error: 'unauthorized', mode: authCheck.mode });
    }
  }

  // Parse JSON manualmente (bodyParser:false)
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8') || '{}');
  } catch (e) {
    console.error('[CRM-WEBHOOK] invalid JSON:', e.message);
    return res.status(400).json({ error: 'invalid json' });
  }
  const event = body.event;

  // Log com contadores, sem PII completa
  const labelsPreview = JSON.stringify(
    (body.conversation || body.data || {}).labels || (body.changed_attributes || [])
  ).slice(0, 120);
  console.log(`[CRM-WEBHOOK] event=${event} | auth=${authCheck.mode} | labels=${labelsPreview}`);

  // ── OUTER TRY/CATCH ──
  // Envolve todo o processamento — buildUserData, list Blob, fetch Graph,
  // sendCAPI. Antes da 25ª passada só o sendCAPI estava protegido (linha ~657),
  // então throws em buildUserData/list/fetch escapavam pro runtime e geravam
  // 500 sem stack trace. 24× 500s em 18/04 confirmaram.
  try {

  // Capturar ctwa_clid de mensagens novas (message_created do Chatwoot)
  // O Chatwoot inclui source_id (wamid) — verificar se a msg tem referral de anúncio CTWA
  if (event === 'message_created' && body.message_type === 0) {
    const sourceId = body.source_id || '';
    const phone = body.sender?.phone_number || body.conversation?.meta?.sender?.phone_number || '';
    const inboxId = body.inbox?.id || body.conversation?.inbox_id || '';

    // Só processar mensagens do inbox WhatsApp (inbox 7)
    if (sourceId && sourceId.startsWith('wamid.') && phone) {
      // Buscar referral via Graph API (se a msg veio de anúncio CTWA, terá referral)
      try {
        const msgResp = await fetch(
          `${GRAPH_BASE}/${sourceId}?fields=referral`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        const msgData = await msgResp.json();

        if (msgData.referral?.ctwa_clid) {
          const ctwaClid = msgData.referral.ctwa_clid;
          const sourceUrl = msgData.referral.source_url || '';
          const headline = msgData.referral.headline || '';
          console.log(`[CRM-WEBHOOK] 🎯 CTWA Lead! clid=${ctwaClid.substring(0,20)}... phone=${maskPhone(phone)} source=${sourceUrl}`);

          // Salvar ctwa_clid no Blob vinculado ao telefone
          if (process.env.BLOB_READ_WRITE_TOKEN) {
            try {
              // Sanitiza pra evitar path traversal no pathname Blob
              const telDigits = String(phone).replace(/\D/g, '').slice(0, 20);
              if (!telDigits) throw new Error('invalid phone');
              // @vercel/blob 2.x: `allowOverwrite: true` é obrigatório quando path existir.
              // Sem isso, se user já veio de outro CTWA ad antes, put() falha com 409.
              await put(`ctwa/${telDigits}.json`, JSON.stringify({
                ctwa_clid: ctwaClid,
                phone: telDigits,
                source_url: sourceUrl,
                headline,
                body: msgData.referral.body || '',
                source_type: msgData.referral.source_type || '',
                timestamp: new Date().toISOString(),
                wamid: sourceId,
              // Fix MEDIUM AI review 20/04/2026 (M5): addRandomSuffix previne enumeration
              // do pathname (ctwa/{phone}.json era guessable → leak de ctwa_clid + ad_metadata).
              // Recovery em crm-webhook.js usa list({prefix:'ctwa/'})+iterate, não afetado.
              }), { access: 'public', addRandomSuffix: true, contentType: 'application/json', allowOverwrite: true });
              console.log(`[CRM-WEBHOOK] ✅ ctwa_clid salvo no Blob: ctwa/${telDigits}-*.json`);
            } catch (e) {
              console.warn(`[CRM-WEBHOOK] Blob save ctwa failed: ${e.message}`);
            }
          }
        }
      } catch (e) {
        // Graph API pode não suportar buscar referral por wamid — silenciar
      }
    }

    // message_created não precisa de mais processamento (labels são em conversation_updated)
    return res.status(200).json({ ok: true, event: 'message_created', processed: true });
  }

  // Processa conversation_created e conversation_updated
  if (event !== 'conversation_updated' && event !== 'contact_updated' && event !== 'conversation_created') {
    return res.status(200).json({ ok: true, skipped: true, event });
  }

  // BUG FIX #1: Só processar conversation_updated se houve mudança de labels
  // Chatwoot envia conversation_updated em qualquer atualização (msg enviada, lida, status, etc.)
  // Sem esse filtro, cada mensagem dispararia CAPI com todos os labels existentes → eventos duplicados
  //
  // NOTA: Chatwoot v3.x / v4.x envia mudança de labels em `label_list` (array) ou
  // `cached_label_list` (string CSV). A chave `labels` NUNCA aparece em changed_attributes.
  // Fix 17/04/2026: procurar label_list (array) primeiro, fallback cached_label_list.
  // Fix MEDIUM AI review 20/04/2026 (M1): Chatwoot pode enviar changed_attributes
  // como objeto em vez de array. Array.isArray coerce previne TypeError em .some/.filter.
  const rawChanged = body.changed_attributes || [];
  const changedAttributes = Array.isArray(rawChanged) ? rawChanged : [rawChanged];
  const hasLabelChange = changedAttributes.some(attr =>
    attr.label_list !== undefined || attr.labels !== undefined
  );
  if (event === 'conversation_updated' && !hasLabelChange) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no_label_change' });
  }

  // BUG FIX #2 + #4: Extrair labels ANTERIORES e calcular labels NOVOS (adicionados agora)
  // Bug #2: customerSeg baseado em previousLabels (não labels atuais)
  // Bug #4: processar APENAS labels recém-adicionados (evita re-disparar Purchase quando
  //         outra label é adicionada em conversa que já tinha compra_realizada)
  const previousLabels = changedAttributes
    .filter(attr => attr.label_list !== undefined || attr.labels !== undefined)
    .flatMap(attr => (attr.label_list?.previous_value ?? attr.labels?.previous_value) || []);

  // Extrai dados — Chatwoot pode enviar em body.conversation, body.data ou flat (body é a conversa)
  const conversation = body.conversation || body.data || body;
  const contact = conversation.meta?.sender || conversation.contact || body.sender || {};
  const allLabels = conversation.labels || body.labels || [];

  // Labels a processar: APENAS os novos (adicionados neste evento)
  // Se não temos previousLabels (ex: conversation_created), processar todos
  const labels = previousLabels.length > 0
    ? allLabels.filter(l => !previousLabels.includes(l))
    : allLabels;
  // Mescla atributos de CONTATO e de CONVERSA — purchase_value pode estar em qualquer um
  const customAttrs = {
    ...(contact.custom_attributes || {}),
    ...(conversation.custom_attributes || {}),
  };

  const nome = contact.name || '';
  const telefone = contact.phone_number || customAttrs.phone || '';
  const email = contact.email || '';

  if (!nome && !telefone) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no_contact_data' });
  }

  // Monta user_data pra CAPI via SDK oficial Meta capi-param-builder-nodejs v1.2.1.
  // Normaliza (email RFC2822, phone e.164 strip zeros, nome lowercase+strip punct,
  // country/state mapping completo), hasheia SHA-256 e deriva advanced matching
  // partial keys (f5first, f5last, fi) automaticamente pra aumentar EMQ.
  const now = Math.floor(Date.now() / 1000);
  let firstName = null, lastName = null;
  if (nome) {
    const parts = nome.trim().split(/\s+/);
    firstName = parts[0];
    if (parts.length > 1) lastName = parts[parts.length - 1];
  }
  const userData = await buildUserData({
    email: email || undefined,
    phone: telefone ? normalizePhone(telefone) : undefined,
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    city: 'recife',
    state: 'pe',
    zip_code: '50000',
    country: 'br',
    gender: 'f',
  });

  // UTMs do contato (se vieram da LP)
  let fbp = customAttrs.fbp || undefined;
  // Bug fix: customAttrs.fbclid pode ser o fbclid RAW (sem o prefixo fb.X.ts.)
  // Nesse caso precisa ser convertido pro formato oficial fbc antes de enviar ao CAPI.
  // subdomainIndex=2 pro apex icelasers.com.br — verificado via SDK Meta capi-param-builder-nodejs v1.2.1.
  const rawFbclid = customAttrs.fbclid;
  let fbc = customAttrs.fbc ||
    (rawFbclid
      ? (rawFbclid.startsWith('fb.') ? rawFbclid : `fb.2.${Date.now()}.${rawFbclid}`)
      : undefined);
  let ctwaClid = customAttrs.ctwa_clid || undefined;

  // Recuperar fbp/fbc/ctwa_clid/originalLeadData do Blob — CONSOLIDADO em 1 leitura por bucket
  // BUG FIX #3: antes eram 2 leituras de leads/ separadas (fbp/fbc + originalLeadData)
  //
  // BUG FIX #4 (25ª passada, 18/04/2026): `ctwaData` precisa ser declarado no
  // escopo SUPERIOR pois é referenciado em linhas 423+ (profile_name enrichment)
  // e 454+ (ad_metadata → crmBase). Antes era `let ctwaData = null` dentro do
  // if (telefone && BLOB_READ_WRITE_TOKEN) — causava ReferenceError em
  // requests com telefone vazio ou BLOB_READ_WRITE_TOKEN ausente.
  // Era o root cause dos 35× 500s em conversation_created/updated.
  let originalLeadData = null;
  let ctwaData = null;
  // EMQ fix (19/04/2026): ip/UA ausentes em 86% dos Leads CRM → EMQ caiu 8.3→6.5.
  // Causa: CRM-webhook não recuperava client_ip_address / client_user_agent do Blob.
  // /api/track.js salva ambos em leads/pending quando user preenche form LP.
  // Agora recupera aqui pra enriquecer Lead CAPI server-side → EMQ sobe.
  let clientIp = null;
  let clientUa = null;
  if (telefone && process.env.BLOB_READ_WRITE_TOKEN) {
    const telDigits = telefone.replace(/\D/g, '');

    // 1. Recuperar CTWA data completa do Blob (salvo pelo whatsapp.js).
    //    Além de ctwa_clid, recuperamos profile_name, ad_metadata e outros campos
    //    enriquecidos — pra usar em advanced matching + ad attribution nos events
    //    Lead Quente / Purchase disparados pelo label do Chatwoot.
    try {
      // Limit 200 (era 50) — volume CTWA alto pode perder clicks antigos.
      // Fix MEDIUM AI review 20/04/2026 (M6).
      const ctwaBlobs = await list({ prefix: 'ctwa/', limit: 200 });
      for (const blob of ctwaBlobs.blobs) {
        // Phone match usa últimos 11 dígitos (padrão celular BR: 2 DDD + 9 dígitos).
        // Antes era slice(-8) que colidia entre DDDs (81 vs 11 com mesmo sufixo).
        // Fix HIGH via AI code review 19/04/2026 (Claude Opus 4.6).
        if (blob.pathname.includes(telDigits.slice(-11))) {
          const blobResp = await fetch(blob.url);
          const data = await blobResp.json();
          if (data && (data.ctwa_clid || data.profile_name || data.ad_metadata)) {
            ctwaData = data;
            if (!ctwaClid && data.ctwa_clid) ctwaClid = data.ctwa_clid;
            console.log(`[CRM-WEBHOOK] Recovered CTWA data from Blob: clid=${!!data.ctwa_clid} profile=${!!data.profile_name} ad_meta=${!!data.ad_metadata}`);
            break;
          }
        }
      }
    } catch (e) {
      console.warn('[CRM-WEBHOOK] CTWA Blob recovery failed:', e.message);
    }

    // 2. Leitura de leads/ para fbp/fbc E originalLeadData
    // Bug anterior: limit:100 perdia leads antigos → fbp recovery = 2.1% no EMQ.
    // Fix: busca em leads/pending/ primeiro (match mais provável nos recentes),
    //      depois leads/converted/ se não achou. Fetch PARALELO em batches de 10
    //      pra caber no timeout 30s da função mesmo com 500 leads.
    if (!fbp || !fbc || !originalLeadData) {
      const searchPrefixes = ['leads/pending/', 'leads/converted/'];
      outerSearch: for (const prefix of searchPrefixes) {
        try {
          // Limit 100 (era 500) — priorizando leads recentes (Blob API desc uploadedAt).
          // Fix HIGH AI review 19/04/2026: list+fetch 500 blobs podia estourar timeout 30s.
          // Trade-off aceitável: leads de >48h raramente mudam label no Chatwoot depois.
          const leadBlobs = await list({ prefix, limit: 100 });
          const candidates = leadBlobs.blobs.filter(b => b.size > 200);
          // Batches de 10 fetches paralelos (não bloqueante vs 500 sequenciais)
          for (let i = 0; i < candidates.length; i += 10) {
            const batch = candidates.slice(i, i + 10);
            const datas = await Promise.all(
              batch.map(async (blob) => {
                try { return await (await fetch(blob.url)).json(); }
                catch { return null; }
              })
            );
            for (const data of datas) {
              if (!data) continue;
              const blobTel = (data.telefone || '').replace(/\D/g, '');
              // Match 11-digit + guard blobTel.length >= 10 previne false positives em leads antigos.
              // Phone BR: cel=11, fixo=10 chars. slice(-11) num fixo 10 retorna string inteira.
              if (blobTel && blobTel.length >= 10 && telDigits.endsWith(blobTel.slice(-11))) {
                if (!fbp && data.fbp) fbp = data.fbp;
                if (!fbc && data.fbc) fbc = data.fbc;
                // EMQ fix: recuperar client_ip + client_user_agent do form submit LP
                if (!clientIp && data.client_ip_address) clientIp = data.client_ip_address;
                if (!clientUa && data.client_user_agent) clientUa = data.client_user_agent;
                if (!originalLeadData && data.event_id) {
                  // Clamp event_time dentro da janela 7d (Meta rejeita > 7d)
                  const originalTs = Math.floor(new Date(data.timestamp).getTime() / 1000);
                  const nowTs = Math.floor(Date.now() / 1000);
                  const minValid = nowTs - 6 * 24 * 3600;
                  const clampedTs = Math.max(originalTs, minValid);
                  originalLeadData = {
                    event_name: 'Lead',
                    event_time: clampedTs,
                    event_id: data.event_id,
                  };
                  console.log(`[CRM-WEBHOOK] Found original Lead: event_id=${data.event_id} clamped=${clampedTs !== originalTs}`);
                }
                // Short-circuit: para quando os campos críticos foram recuperados.
                // clientIp e clientUa são enriquecimento opcional (86% dos leads não têm).
                // Fix HIGH AI review 19/04/2026.
                if (fbp && fbc && originalLeadData) break outerSearch;
              }
            }
          }
        } catch (e) {
          console.warn(`[CRM-WEBHOOK] Blob ${prefix} recovery failed: ${e.message}`);
        }
      }
    }

    if (fbp || fbc || ctwaClid) console.log(`[CRM-WEBHOOK] Recovered from Blob: fbp=${!!fbp} fbc=${!!fbc} ctwa=${!!ctwaClid} origLead=${!!originalLeadData}`);
  }

  // Se tem ctwa_clid mas não fbc, derivar fbc do ctwa_clid (formato oficial Meta)
  // subdomainIndex=2 pro apex icelasers.com.br (.com.br TLD composto → SDK calcula 2).
  if (ctwaClid && !fbc) {
    fbc = `fb.2.${Date.now()}.${ctwaClid}`; // Date.now() em ms (não segundos)
    console.log(`[CRM-WEBHOOK] fbc derivado do ctwa_clid: ${fbc.slice(0, 30)}...`);
  }

  // external_id: identidade estável (email > phone > nome).
  // NÃO usar fbp como fallback (fbp já é matching key nativa; duplicar infla multi-user-per-IP).
  // Normalização via SDK oficial Meta: lowercase + strip whitespace_only + sha256.
  let externalIdRaw = null;
  if (email) externalIdRaw = email;
  else if (telefone) externalIdRaw = normalizePhone(telefone);
  else if (nome) externalIdRaw = nome;
  if (externalIdRaw) {
    const extHash = await hashPII(externalIdRaw, 'external_id');
    if (extHash) userData.external_id = [extHash];
  }

  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  // EMQ fix: client_ip_address + client_user_agent recuperados do Blob lead original.
  // Meta docs: ip e UA são high-priority matching keys. Sem eles EMQ Lead ficava em 6.5
  // (86% sem IP/UA). Com recovery via Blob, sobe pra ~8.0+ quando user veio via LP form.
  if (clientIp) userData.client_ip_address = clientIp;
  if (clientUa) userData.client_user_agent = clientUa;

  // lead_id: highest-priority user_data field para Conversion Leads (Meta spec)
  // https://developers.facebook.com/docs/marketing-api/conversions-api/conversion-leads-integration/payload-specification
  // Chatwoot contact.id é identidade estável entre conversations do mesmo user →
  // dedupe perfeito + Conversion Leads stage progression tracking funcional.
  // NÃO hasheado (é identifier, não PII).
  if (contact.id) {
    userData.lead_id = String(contact.id);
  }

  if (ctwaClid) {
    userData.ctwa_clid = ctwaClid; // user_data — posição oficial Meta para CTWA
    // NOTA: `whatsapp_business_account_id` REMOVIDO em 25ª passada (18/04/2026).
    // Meta API v25 rejeita esse campo em user_data OU original_event_data com
    // `OAuthException code=1 "An unknown error has occurred"` quando presente
    // junto com ctwa_clid. Descoberto via reprodução direta Graph API em 4 testes:
    //   T1: só ctwa_clid → 200 events_received:1 ✅
    //   T2: só waba_id → erro code=1 ❌
    //   T3: ambos em user_data → erro code=1 ❌
    //   T5: waba em original_event_data → erro code=1 ❌
    // Causou 3 event_received missing na recovery dos 14 labels.
    // Se Meta re-habilitar: re-adicionar em original_event_data junto
    // com action_source=business_messaging + messaging_channel=whatsapp.
  }

  // ENRIQUECIMENTO CTWA — se Blob tem profile_name do WhatsApp E nome do
  // Chatwoot veio vazio, injetar fn/ln/f5first/fi derivados do profile_name.
  // Isso permite matching high-EMQ em users que nunca preencheram form (só CTWA).
  if (ctwaData && ctwaData.profile_name && !userData.fn) {
    try {
      const profileParts = String(ctwaData.profile_name).trim().split(/\s+/);
      const profileFirst = profileParts[0] || null;
      const profileLast = profileParts.length > 1 ? profileParts[profileParts.length - 1] : null;
      if (profileFirst) {
        const enriched = await buildUserData({
          first_name: profileFirst,
          last_name: profileLast || undefined,
        });
        if (enriched.fn) userData.fn = enriched.fn;
        if (enriched.ln) userData.ln = enriched.ln;
        if (enriched.fi) userData.fi = enriched.fi;
        if (enriched.f5first) userData.f5first = enriched.f5first;
        if (enriched.f5last) userData.f5last = enriched.f5last;
        console.log(`[CRM-WEBHOOK] Enriquecido user_data com profile_name do CTWA (${maskName(ctwaData.profile_name)})`);
      }
    } catch (e) {
      console.warn('[CRM-WEBHOOK] profile_name enrichment failed:', e.message);
    }
  }

  // Tenta recuperar URL da LP original salva nos atributos; fallback para domínio canônico
  const eventSourceUrl = customAttrs.landing_url
    || customAttrs.event_source_url
    || customAttrs.lp_url
    || 'https://icelasers.com.br/';

  // Ad metadata do CTWA (via Meta Graph lookup salvo no Blob) — propagar
  // campaign_id/adset_id/ad_id pra custom_data de TODOS os events CRM.
  // Meta Andromeda 2026 usa esses IDs pra attribution cross-device.
  const ctwaAdMeta = ctwaData && ctwaData.ad_metadata ? ctwaData.ad_metadata : null;

  // action_source dinâmico baseado em CTWA presence (Meta Conversion Leads spec):
  //  - 'business_messaging' quando ctwaClid presente (CTWA ad → WhatsApp conversation)
  //  - 'system_generated' quando lead vem via CRM label update sem CTWA origin
  // Fix MEDIUM AI review 20/04/2026 (M3).
  const actionSource = ctwaClid ? 'business_messaging' : 'system_generated';

  // Factory: cada chamada retorna novo objeto com shallow clone de user_data,
  // evitando referência compartilhada que poluiria todos os eventos do batch.
  // Bug CRITICAL detectado via AI code review 19/04/2026 (Claude Opus 4.6).
  const mkBaseEvent = () => ({
    event_source_url: eventSourceUrl,
    action_source: actionSource,
    user_data: { ...userData },         // shallow clone — arrays dentro (em, ph, fn...) ficam shared mas são imutáveis na prática
  });

  // custom_data base para todos os eventos CRM (conforme guia Meta Conversion Leads)
  const crmBase = {
    event_source: 'crm',         // obrigatório para Conversion Leads
    // Attribution CTWA full (via Meta Graph API lookup em whatsapp.js):
    ...(ctwaAdMeta?.ad_id ? { ad_id: ctwaAdMeta.ad_id } : {}),
    ...(ctwaAdMeta?.ad_name ? { ad_name: ctwaAdMeta.ad_name } : {}),
    ...(ctwaAdMeta?.adset_id ? { adset_id: ctwaAdMeta.adset_id } : {}),
    ...(ctwaAdMeta?.adset_name ? { adset_name: ctwaAdMeta.adset_name } : {}),
    ...(ctwaAdMeta?.campaign_id ? { campaign_id: ctwaAdMeta.campaign_id } : {}),
    ...(ctwaAdMeta?.campaign_name ? { campaign_name: ctwaAdMeta.campaign_name } : {}),
    ...(ctwaAdMeta?.optimization_goal ? { optimization_goal: ctwaAdMeta.optimization_goal } : {}),
    ...(ctwaAdMeta?.destination_type ? { destination_type: ctwaAdMeta.destination_type } : {}),
    ...(ctwaAdMeta?.publisher_platforms ? { publisher_platforms: ctwaAdMeta.publisher_platforms } : {}),
    ...(ctwaAdMeta?.campaign_objective ? { campaign_objective: ctwaAdMeta.campaign_objective } : {}),
    lead_event_source: 'Chatwoot', // nome do CRM
  };

  const events = [];
  // Dedup edge case: se contact.id ausente, adicionar fallback + jitter
  // pra não colidir event_id entre contatos diferentes no mesmo segundo
  const contactKey = contact.id || (telefone ? telefone.replace(/\D/g, '') : 'unk');
  const jitter = Math.random().toString(36).slice(2, 6);
  const eventId = `crm_${contactKey}_${now}_${jitter}`;
  const orderId = `order_${contactKey}_${now}`;

  // customerSeg: 3 sinais combinados pra detectar existing customer
  //   1. previousLabels tinha compra_realizada (label já estava)
  //   2. customAttrs.has_purchased === true (flag custom)
  //   3. Lead original no Blob tem `converted: true` (achado acima via leads/converted/)
  // Gap #3 antigo: se user teve compra em CONV ANTERIOR (outro contact_id), antes ficava
  // sempre new_customer. Agora o lookup em leads/converted/ resolve.
  const wasAlreadyPurchased =
    previousLabels.includes('compra_realizada') ||
    previousLabels.includes('💰 Compra Realizada') ||
    customAttrs.has_purchased === true ||
    customAttrs.has_purchased === 'true' ||
    // originalLeadData recuperado de leads/converted/ → já tinha purchase antes
    (originalLeadData && originalLeadData.event_id && originalLeadData.event_id.startsWith('purchase_'));
  const customerSeg = wasAlreadyPurchased ? 'existing_customer_to_business' : 'new_customer_to_business';

  // helper: verifica se algum label está presente (case-insensitive, suporta variações)
  const hasLabel = (...variants) => labels.some(l => variants.includes(l) || variants.includes(l.toLowerCase()));

  // ❌ DESQUALIFICADO — Hybrid approach (Meta best practice 2026):
  //   1. Standard `Lead` event (mantém EMQ calculation + predicted_ltv=0 signal
  //      pra Andromeda AI evitar lookalikes de perfis similares)
  //   2. Custom `LeadDesqualificado` event (permite criar Audience "Lead Desqualificado"
  //      no Events Manager → usar como EXCLUSION list em targeting de campanhas)
  //
  // Conversion Leads spec (official Meta 2026): event_name é free-form pra stages CRM.
  // Meta recomenda STANDARD EVENT pra optimization + CUSTOM pra audience features.
  // https://developers.facebook.com/docs/marketing-api/conversions-api/conversion-leads-integration/payload-specification
  if (hasLabel('desqualificado', '❌ Desqualificado', '❌_desqualificado', 'disqualified', 'unqualified')) {
    const disqCustomData = {
      ...crmBase,
      content_name: 'Lead Desqualificado - CRM',
      lead_type: 'disqualified',
      status: 'disqualified',
      quality: 'unqualified',
      disqualification_reason: 'fora_do_publico_alvo',
      currency: 'BRL',
      value: 0,                       // sinal negativo explícito
      predicted_ltv: 0,               // "EVITE este perfil" — Andromeda signal
      customer_segmentation: customerSeg,
    };
    events.push(
      // 1) Standard Lead event — otimização (EMQ calculado, predicted_ltv=0 signal)
      {
        ...mkBaseEvent(),
        event_name: 'Lead',
        event_time: now,
        event_id: `${eventId}_disqualified`,
        custom_data: disqCustomData,
      },
      // 2) Custom LeadDesqualificado event — audience creation (exclude list)
      //    event_id diferente pra Meta NÃO deduplicar (são sinais distintos).
      {
        ...mkBaseEvent(),
        event_name: 'LeadDesqualificado',
        event_time: now,
        event_id: `${eventId}_disqualified_audience`,
        custom_data: disqCustomData,
      },
    );
  }

  // 🧊 LEAD FRIO — sinal fraco (lead vai reagir mas não converter alto)
  if (hasLabel('lead_frio', '🧊 Lead Frio', '🧊_lead_frio', 'cold_lead', 'lead frio', 'frio')) {
    events.push({
      ...mkBaseEvent(),
      event_name: 'Lead',
      event_time: now,
      event_id: `${eventId}_cold_lead`,
      custom_data: {
        ...crmBase,
        content_name: 'Lead Frio - CRM',
        lead_type: 'cold_lead',
        status: 'unqualified',
        currency: 'BRL',
        value: 50,                      // sinal fraco mas não zero
        predicted_ltv: 200,             // LTV baixo esperado
        customer_segmentation: customerSeg,
      },
    });
  }

  // 🔥 LEAD QUENTE — sinal forte (mais provável converter em Purchase)
  if (hasLabel('lead_quente', '🔥 Lead Quente', '🔥_lead_quente', 'hot_lead', 'lead quente', 'quente')) {
    events.push(
      {
        ...mkBaseEvent(),
        event_name: 'Lead',
        // event_time: now (antes -3600). Backdating hardcoded desalinhava dedup Pixel↔CAPI
        // quando Pixel browser disparou Lead no tempo real T (form submit) e CAPI chega
        // com T-3600. Meta prioriza proximidade temporal na reconciliação dedup.
        // Também invertia ordem do funnel (CR appearance antes de Lead).
        // Fix HIGH via AI code review 19/04/2026 (Claude Opus 4.6).
        event_time: now,
        event_id: `${eventId}_hot_lead`,
        custom_data: {
          ...crmBase,
          content_name: 'Lead Quente - CRM',
          lead_type: 'hot_lead',
          currency: 'BRL',
          value: 300,                                 // sinal forte
          predicted_ltv: DEFAULT_PREDICTED_LTV,       // LTV esperado (~980)
          customer_segmentation: customerSeg,
        },
      },
      {
        ...mkBaseEvent(),
        event_name: 'CompleteRegistration',
        event_time: now,
        event_id: `${eventId}_hot_cr`,
        custom_data: {
          ...crmBase,
          content_name: 'Lead Quente - CRM',
          status: 'converted',
          currency: 'BRL',
          value: 300,                                 // alinhado com Lead event
          predicted_ltv: DEFAULT_PREDICTED_LTV,
          customer_segmentation: customerSeg,
        },
      }
    );
  }

  // Helper: parse seguro. `parseFloat(0) || DEFAULT` cai no DEFAULT — bug.
  // Usar Number.isFinite + >0 pra detectar zero-by-error de real 0.
  const safeValorParse = (raw) => {
    const n = parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PURCHASE_VALUE;
  };

  // 💳 LINK DE PAGAMENTO (atendente enviou link / cliente vai pagar)
  if (hasLabel('link_pagamento', '💳 Link Pagamento', '💳_link_pagamento', 'link pagamento', 'pagamento', 'checkout')) {
    const valor = safeValorParse(customAttrs.purchase_value);
    events.push({
      ...mkBaseEvent(),
      event_name: 'InitiateCheckout',
      event_time: now,
      event_id: `${eventId}_ic`,
      custom_data: { ...crmBase, currency: 'BRL', value: valor, content_name: 'Link Pagamento - CRM', customer_segmentation: customerSeg },
    });
  }

  // 💰 COMPRA REALIZADA
  if (hasLabel('compra_realizada', '💰 Compra Realizada', '💰_compra_realizada', 'purchase', 'compra realizada', 'comprou', 'vendido', 'sold')) {
    const valor = safeValorParse(customAttrs.purchase_value);
    events.push(
      {
        ...mkBaseEvent(),
        event_name: 'InitiateCheckout',
        event_time: now - 1800,
        event_id: `${eventId}_purchase_ic`,
        custom_data: { ...crmBase, currency: 'BRL', value: valor, content_name: 'Compra CRM', customer_segmentation: customerSeg },
      },
      {
        ...mkBaseEvent(),
        event_name: 'Purchase',
        event_time: now,
        event_id: `${eventId}_purchase`,
        ...(originalLeadData && { original_event_data: originalLeadData }),
        custom_data: {
          ...crmBase,
          currency: 'BRL',
          value: valor,
          predicted_ltv: DEFAULT_PREDICTED_LTV,
          content_name: 'Pacote Depilacao Laser',
          content_type: 'product',
          num_items: 1,
          order_id: orderId,
          customer_segmentation: customerSeg,
        },
      }
    );
  }

  if (events.length === 0) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no_matching_labels' });
  }

  // Validação de batch: filtrar eventos inválidos antes de enviar
  // (se 1 evento inválido no batch, a Meta rejeita o batch INTEIRO)
  const validEvents = events.filter(evt => {
    if (!evt.event_name || !evt.event_time || !evt.action_source) {
      console.warn(`[CRM-WEBHOOK] Evento inválido removido: ${JSON.stringify(evt).substring(0, 100)}`);
      return false;
    }
    if (!evt.user_data || Object.keys(evt.user_data).length === 0) {
      console.warn(`[CRM-WEBHOOK] Evento sem user_data removido: ${evt.event_name}`);
      return false;
    }
    return true;
  });

  if (validEvents.length === 0) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'all_events_invalid' });
  }

  const result = await sendCAPI(validEvents, token);
  // Fix MEDIUM AI review 20/04/2026 (M4): events_received pode ser undefined se
  // CAPI retornou erro (ex: invalid_token). Explicitar 0 pra JSON ser sempre determinístico.
  const eventsReceived = result?.events_received ?? 0;
  console.log(`[CRM-WEBHOOK] ${event} | contact=${maskName(nome)} phone=${maskPhone(telefone)} email=${maskEmail(email)} | labels: ${labels.join(',')} | CAPI: ${eventsReceived} eventos | ctwa:${!!ctwaClid} | seg:${customerSeg}`);
  return res.status(200).json({
    ok: true,
    contact: nome,
    labels,
    events_sent: validEvents.length,
    events_received: eventsReceived,
    ctwa_clid: !!ctwaClid,
    customer_segmentation: customerSeg,
  });

  } catch (err) {
    // OUTER catch — protege TODO o processamento (buildUserData, list Blob,
    // fetch Graph, sendCAPI). Captura stack trace completo pra debug.
    // Investigação 18/04/2026: 24× 500s em 24h sem log visível pois o catch
    // interno só cobria sendCAPI. Agora cobre tudo após o parse do body.
    const ctx = {
      event: event || 'unknown',
      message: err?.message || 'no message',
      stack: (err?.stack || '').split('\n').slice(0, 6).join(' | '),
      auth_mode: authCheck?.mode || 'unknown',
      has_conversation: !!body?.conversation,
      has_labels: !!(body?.conversation?.labels || body?.changed_attributes),
    };
    console.error(`[CRM-WEBHOOK][500]`, JSON.stringify(ctx));
    // Fix HIGH AI review 19/04/2026: não expor err.message (pode leak stack path,
    // connection strings, token secrets). ctx completo já loggado via console.error.
    return res.status(500).json({ error: 'internal_error' });
  }
}
