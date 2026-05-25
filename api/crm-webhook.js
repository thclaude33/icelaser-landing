/**
 * /api/crm-webhook — Recebe eventos do Chatwoot CRM
 * Quando label muda → dispara CAPI/Pixel automaticamente
 *
 * Labels → Eventos CAPI (atualizado PR #40 — 27/04/2026):
 *   conversation_created sem label → sem Lead automático (V5 Pixel-only)
 *   ❌ Desqualificado   → LeadDesqualificado (custom, audience exclusion)
 *   🧊 Lead Frio        → LeadFrio (custom, audience exclusion)
 *   🔥 Lead Quente      → CompleteRegistration + Qualified Lead (downstream)
 *   💳 Link Pagamento   → InitiateCheckout
 *   💰 Compra Realizada → (CR + QL backfill cond) + InitiateCheckout + Purchase
 *   📧 Marketing Opt-In → Subscribe
 *
 * V5: Lead automático de chegada removido para não poluir o sinal de
 * otimização. O backfill `_compra_lead` permanece para compras orgânicas.
 */

import { put, list } from '@vercel/blob';
import { PIXEL_ID, PIXEL_ID_JPA, GRAPH_BASE, DEFAULT_PURCHASE_VALUE, DEFAULT_PREDICTED_LTV, PAGE_ID, PAGE_ID_JPA } from './_lib/config.js';
import { sha256, normalizePhoneBR, verifyChatwootSignature, timingSafeStringEqual, maskPhone, maskEmail, maskName, getRawBody } from './_lib/security.js';
import { buildUserData } from './_lib/piiBuilder.js';
import { PARTNER_AGENT } from './_lib/capi.js';
import { computeCompraRealizadaGuards } from './_lib/funnel-guards.js';
import { normalizeChangedAttributes, hasLabelChange, extractPreviousLabels, extractCurrentLabels } from './_lib/label-change.js';
import { decideTargetDataset, parsePurchaseValue, isRoutingEnabled, DATASET_PIXEL_LP } from './_lib/purchase-routing.js';
import { disarmCascade, isOutgoingFromBia } from './_lib/cascade.js';
import { clearActiveSession } from './_lib/session-reuse.js';

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
  // Se HMAC válido → aceita. Se HMAC INVÁLIDO → cai pra fallback query token
  // (defesa contra regen do secret no Chatwoot dessincronizar com Vercel env).
  const sig = req.headers['x-chatwoot-signature'];
  const ts = req.headers['x-chatwoot-timestamp'];
  if (secret && sig && ts) {
    const valid = verifyChatwootSignature(rawBody, sig, ts, secret);
    if (valid) return { valid: true, mode: 'hmac-valid' };
    // HMAC falhou: NÃO retorna invalid ainda — tenta fallback query token abaixo.
  }

  // 2. Fallback: query token na URL (compat com Chatwoot antigo + recovery
  // quando secret HMAC desincroniza após recriar webhook).
  if (queryToken) {
    const reqUrl = new URL(req.url, `https://${req.headers.host || 'localhost'}`);
    const providedToken = reqUrl.searchParams.get('auth') || '';
    if (timingSafeStringEqual(providedToken, queryToken)) {
      // Diferencia se HMAC tava presente mas inválido (cai aqui após fallback) vs query-token direto
      const mode = (sig && ts) ? 'hmac-invalid-but-query-token-valid' : 'query-token-valid';
      return { valid: true, mode };
    }
    return { valid: false, mode: (sig && ts) ? 'hmac-invalid-and-query-token-invalid' : 'query-token-invalid-or-missing' };
  }

  // Secret configurado mas Chatwoot não enviou signature válida E sem query token
  return { valid: false, mode: sig && ts ? 'hmac-invalid' : 'no-signature' };
}

async function sendCAPI(events, token, retryCount = 0, targetPixelId = PIXEL_ID) {
  // Authorization: Bearer (mais seguro que access_token na URL)
  // partner_agent: Meta best practice — identifica plataforma emissora (<23 chars, >=2 letras).
  // targetPixelId: FIX 26/04/2026 cross-clinic — quando lead é JP (page_id JP),
  // override pra Pixel JP (1386967056530127). Default Pixel Recife.
  let res;
  try {
    res = await fetch(
      `${GRAPH_BASE}/${targetPixelId}/events`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ data: events, partner_agent: PARTNER_AGENT }),
        signal: AbortSignal.timeout(8000),
      }
    );
  } catch (err) {
    const result = {
      error: {
        message: err?.message || 'fetch_failed',
        code: err?.name || 'FETCH_EXCEPTION',
        is_transient: true,
      },
    };
    console.error(`[CAPI FETCH CRM] attempt=${retryCount} ${result.error.code}: ${result.error.message}`);
    if (retryCount < 2) {
      const delay = (retryCount + 1) * 1000;
      await new Promise(r => setTimeout(r, delay));
      return sendCAPI(events, token, retryCount + 1, targetPixelId);
    }
    return result;
  }

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

  // Fix LOW AI review 20/04/2026 (L3): defensive JSON parse. Meta pode retornar
  // HTML (503/Cloudflare maintenance), res.json() lança SyntaxError não-informativo.
  const rawText = await res.text();
  let result;
  try {
    result = JSON.parse(rawText);
  } catch {
    console.error(`[CAPI] Non-JSON response (${res.status}): ${rawText.substring(0, 200)}`);
    return { error: { message: 'non-json response', code: res.status, is_transient: true } };
  }

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
      return sendCAPI(events, token, retryCount + 1, targetPixelId);
    }
  } else {
    // Fix CRITICAL 20/04/2026 (silent failure investigation): Meta CAPI retorna
    // `messages[]` com WARNINGS mesmo sem error. Eventos podem ter events_received>0
    // mas serem degradados/dropados em processamento assíncrono (match quality baixo,
    // event_source_url não verificado, user_data parcial). Antes invisível → user
    // reportou "CRM events não aparecem". Agora: log TUDO.
    const eventsReceived = result?.events_received ?? 0;
    if (Array.isArray(result.messages) && result.messages.length > 0) {
      const names = events.map(e => e.event_name).join(',');
      console.warn(`[CAPI WARN CRM] events=${names} received=${eventsReceived} messages=${JSON.stringify(result.messages)} fbtrace=${result.fbtrace_id || 'n/a'}`);
    }
    if (eventsReceived === 0) {
      const names = events.map(e => e.event_name).join(',');
      console.error(`[CAPI SILENT_DROP CRM] events=${names} received=0 sent=${events.length} fbtrace=${result.fbtrace_id || 'n/a'}`);
    }
    if (eventsReceived && eventsReceived < events.length) {
      console.warn(`[CAPI PARTIAL_DROP CRM] received=${eventsReceived}/${events.length} fbtrace=${result.fbtrace_id || 'n/a'}`);
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

  // ────────────────────────────────────────────────────────────────────
  // 🤖 BOT WELCOME WA-RC — await síncrono delegation
  // ────────────────────────────────────────────────────────────────────
  // Delega pro bot quando: inbox=7 (WhatsApp Recife) + bot habilitado.
  // AWAIT obrigatório — Vercel mata promises pendentes após response.
  // Feature flag: CHATWOOT_BOT_ENABLED='1' (default '0' = bot desativado).
  // Dry-run flag : CHATWOOT_BOT_DRY_RUN='1' (loga payload, não envia mensagens).
  //
  // SHADOW MODE GUARD (13/05/2026): se conv tem label `bia_teste`, Bia AI é
  // quem processa via /api/bia-session-create — Bot Welcome deve PULAR pra
  // evitar conflito (2 respostas paralelas no WhatsApp do cliente).
  if (process.env.CHATWOOT_BOT_ENABLED === '1') {
    const botInboxId = body.inbox_id || body.inbox?.id || body.conversation?.inbox_id;
    // FIX 14/05/2026: aceitar string OU number — Chatwoot envia inbox_id como string em alguns eventos.
    // Bug antigo: `botInboxId === 7` (strict) podia falhar quando Chatwoot mandava `'7'` string.
    const isWhatsAppRecife = Number(botInboxId) === 7;
    const isBotEvent = event === 'conversation_created' || event === 'message_created';

    // Shadow Mode label guard — Bia AI handles instead of Bot Welcome.
    // Labels podem vir em: body.conversation.labels (array) | body.labels (array)
    // | body.conversation.cached_label_list (CSV string) | body.cached_label_list.
    const labelSources = [
      body.conversation?.labels,
      body.labels,
    ];
    const csvSources = [
      body.conversation?.cached_label_list,
      body.cached_label_list,
    ];
    const labelArray = labelSources.find((l) => Array.isArray(l)) || [];
    const labelCsv = csvSources.find((s) => typeof s === 'string') || '';
    const allLabelsForGate = [
      ...labelArray.map((l) => String(l).toLowerCase()),
      ...labelCsv.split(',').map((l) => l.trim().toLowerCase()).filter(Boolean),
    ];
    const hasBiaTesteLabel = allLabelsForGate.includes('bia_teste');

    if (isWhatsAppRecife && isBotEvent && hasBiaTesteLabel) {
      console.log(`[CRM-BOT] skipped: bia_teste label present — Bia AI handles this conv | event=${event} conv=${body.id || body.conversation?.id || '?'}`);
    } else if (isWhatsAppRecife && isBotEvent) {
      // AWAIT SÍNCRONO — Vercel serverless mata promises pendentes após response.
      // Bot roda ANTES do CAPI normal processar. ~5s adicional (welcome+wait3s+dispatch).
      // Em DRY-RUN não envia nada, logs only. Em produção pode chegar a 10s — Chatwoot tolera.
      try {
        const { handleNewConversation, handleIncomingMessage } = await import('./chatwoot-bot/index.js');
        const fn = event === 'conversation_created' ? handleNewConversation : handleIncomingMessage;
        const botResult = await fn(body);
        console.log(`[CRM-BOT] event=${event} conv=${body.id || body.conversation?.id || '?'} result=${JSON.stringify(botResult).slice(0, 200)}`);
        // FIX P1-D (Codex 17/05/2026): se bot reportou erro retryable (Chatwoot get conv 5xx,
        // setCustomAttributes falhou), retornar 502 ANTES de CAPI. Chatwoot retenta webhook —
        // bot tenta de novo, CAPI roda no retry bem-sucedido (idempotente via event_id).
        // Antes: log só, sem retry — bot ficava travado sem estado.
        if (botResult?.retryable === true) {
          const convId = body.id || body.conversation?.id || '?';
          console.error(`[CRM-BOT] 🚨 retryable error conv=${convId} reason=${botResult?.error || 'unknown'} — returning 502 for Chatwoot retry`);
          return res.status(502).json({ error: 'bot_retryable', detail: botResult?.error || 'unknown' });
        }
      } catch (e) {
        // Bot pode falhar — log mas NÃO afeta processamento CAPI normal abaixo
        console.error(`[CRM-BOT] error (non-blocking): ${e?.message || e}`);
      }
    }
  }

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
      // Fix HIGH AI deep v3 (crm-webhook.js:199): Graph API por wamid nem sempre
      // funciona — logar resposta (não só silenciar). Se Meta rejeitar com erro
      // conhecido, útil pra saber se endpoint tá dando dados ou sempre 400.
      try {
        const msgResp = await fetch(
          `${GRAPH_BASE}/${sourceId}?fields=referral`,
          { headers: { 'Authorization': `Bearer ${token}` } }
        );
        if (!msgResp.ok) {
          const errTxt = (await msgResp.text()).substring(0, 150);
          console.warn(`[CRM-WEBHOOK] Graph referral lookup ${msgResp.status} for ${sourceId.substring(0,20)}: ${errTxt}`);
        }
        const msgData = msgResp.ok ? await msgResp.json() : {};

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
              // Fix HIGH AI deep review v2 B2 (crm-webhook.js:231): addRandomSuffix + allowOverwrite
              // são mutuamente contraditórios. Com suffix random, path é único por put() → allowOverwrite
              // nunca dispara. Remover allowOverwrite (redundante). Trade-off: cada CTWA click cria Blob
              // novo (esperado — preserva histórico). Recovery usa list+iterate, não afetado.
              }), { access: 'public', addRandomSuffix: true, contentType: 'application/json' });
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

  // PROMPT 2 — DISARM cascade quando atendente humana posta msg outgoing.
  // Diferencia humana × Bia via timestamp KV: se NOW - last_bia_outgoing > 60s → humana.
  // Bia recém-postou → last_bia_outgoing < 60s → ignora (própria msg via webhook echo).
  if (event === 'message_created' && (body.message_type === 1 || body.message_type === 'outgoing')) {
    const convOutId = body.conversation?.id ?? body.conversation_id;
    if (convOutId) {
      try {
        const fromBia = await isOutgoingFromBia(convOutId);
        if (!fromBia) {
          // PROMPT 2: desarma cascade
          if (process.env.FOLLOWUP_ENABLED === '1') {
            await disarmCascade(convOutId, 'human_manual_reply');
          }
          // PROMPT 4: humana posta = invalida session reuse (próxima msg cliente = session fresh
          // pra Bia retomar contexto baseado no que humana já respondeu)
          await clearActiveSession(convOutId, 'human_manual_reply');
        }
      } catch (e) {
        console.error(`[CRM-DISARM-OUTGOING] conv=${convOutId} ${e?.message || e}`);
      }
    }
    return res.status(200).json({ ok: true, event: 'message_created_outgoing', processed: true });
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
  // Fix MEDIUM AI deep v3 (crm-webhook.js:262): changed_attributes pode vir como
  // objeto com múltiplas chaves {label_list:{...}, status:{...}} — coerção pra
  // array de entries preserva todas as keys (antes: [rawChanged] virava [{label_list,status}]
  // e hasLabelChange funcionava, MAS em filter por label_list perdemos info contextual).
  // Fix CRITICAL 23/04/2026: Chatwoot v3/v4 envia mudança de labels principalmente
  // via `cached_label_list` (CSV string) em conversation_updated — não sempre
  // inclui `label_list` (array). Observado LIVE em logs 14:50-14:51 UTC hoje:
  // gerente marcou lead_frio/lead_quente, todos os conversation_updated tinham
  // changed_attributes=[{updated_at:...},{cached_label_list:...}] SEM label_list.
  // Código antigo só verificava label_list/labels → skipped no_label_change →
  // NENHUM CAPI disparado. Lib `label-change.js` centraliza detecção pra testar.
  const changedAttributes = normalizeChangedAttributes(body.changed_attributes);
  const labelChangeDetected = hasLabelChange(changedAttributes);
  if (event === 'conversation_updated' && !labelChangeDetected) {
    try {
      const keys = changedAttributes.map(a => Object.keys(a || {})).flat().slice(0, 10);
      console.log(`[CRM-WEBHOOK] skipped no_label_change | keys=${JSON.stringify(keys)}`);
    } catch { /* debug não pode quebrar */ }
    return res.status(200).json({ ok: true, skipped: true, reason: 'no_label_change' });
  }

  // BUG FIX #2 + #4: Extrair labels ANTERIORES e calcular labels NOVOS (adicionados agora)
  // Bug #2: customerSeg baseado em previousLabels (não labels atuais)
  // Bug #4: processar APENAS labels recém-adicionados (evita re-disparar Purchase quando
  //         outra label é adicionada em conversa que já tinha compra_realizada)
  const previousLabels = extractPreviousLabels(changedAttributes);

  // Extrai dados — Chatwoot pode enviar em body.conversation, body.data ou flat (body é a conversa)
  const conversation = body.conversation || body.data || body;
  const contact = conversation.meta?.sender || conversation.contact || body.sender || {};
  // Fix CRITICAL 23/04/2026 (parte 2): quando Chatwoot envia payload com
  // cached_label_list no changed_attributes mas SEM conversation.labels replicado,
  // fallback pra extrair labels atuais do changed_attributes.cached_label_list.current_value.
  // Observado em prod hoje: conversation_updated com cached_label_list trigger hasLabelChange=true
  // mas conversation.labels vinha vazio → allLabels=[] → events=[] → skipped no_matching_labels.
  const allLabelsFromBody = conversation.labels || body.labels;
  const allLabels = (Array.isArray(allLabelsFromBody) && allLabelsFromBody.length > 0)
    ? allLabelsFromBody
    : extractCurrentLabels(changedAttributes);

  // Labels a processar: APENAS os novos (adicionados neste evento)
  // Se não temos previousLabels (ex: conversation_created), processar todos
  const labels = previousLabels.length > 0
    ? allLabels.filter(l => !previousLabels.includes(l))
    : allLabels;

  // PROMPT 2 — DISARM cascade em labels terminais
  // compra_realizada = lead fechou → não tem porque seguir follow-up
  // desqualificado = lead morto → não persegue
  // lead_quente = gerente vai atender manual → cascade duplicaria esforço
  const DISARM_LABELS = ['compra_realizada', 'desqualificado', 'lead_quente'];
  const convIdForFU = conversation?.id ?? body.conversation_id;
  if (convIdForFU && labels.some((l) => DISARM_LABELS.includes(String(l).toLowerCase()))) {
    try {
      // PROMPT 2: cascade DEL
      if (process.env.FOLLOWUP_ENABLED === '1') {
        await disarmCascade(convIdForFU, 'label_terminal');
      }
      // PROMPT 4: invalida session reuse — lead terminal (fechado/desqualificado/quente
      // pra atendente humana) não deve ter contexto reusado se cliente voltar depois
      await clearActiveSession(convIdForFU, 'label_terminal');
    } catch (e) {
      console.error(`[CRM-DISARM-LABEL] conv=${convIdForFU} ${e?.message || e}`);
    }
  }
  // Mescla atributos de CONTATO e de CONVERSA — purchase_value pode estar em qualquer um
  const customAttrs = {
    ...(contact.custom_attributes || {}),
    ...(conversation.custom_attributes || {}),
  };

  // Cross-clinic detection — detectar AQUI (antes de buildUserData) pra propagar
  // page_id correto pro user_data em TODOS os events. Vercel Agent review (PR #36)
  // pegou que page_id em user_data ficava Recife mesmo pra leads JP — quebrava
  // attribution Conversion Leads CRM JP. Detectado pelo customAttrs.page_id que
  // whatsapp.js:1224 propaga do leadgen webhook Meta.
  const _leadPageIdRaw = customAttrs?.page_id ? String(customAttrs.page_id) : null;
  const _isJpLead = _leadPageIdRaw === PAGE_ID_JPA;
  const userDataPageId = _isJpLead ? PAGE_ID_JPA : PAGE_ID;

  const nome = contact.name || '';
  const telefone = contact.phone_number || customAttrs.phone || '';
  const email = contact.email || '';

  if (!nome && !telefone) {
    console.log(`[CRM-WEBHOOK] skipped no_contact_data | event=${event} has_body_sender=${!!body.sender} has_conv_contact=${!!conversation.contact} has_meta_sender=${!!conversation.meta?.sender}`);
    return res.status(200).json({ ok: true, skipped: true, reason: 'no_contact_data' });
  }

  // Monta user_data pra CAPI via SDK oficial Meta capi-param-builder-nodejs v1.2.1.
  // Normaliza (email RFC2822, phone e.164 strip zeros, nome lowercase+strip punct,
  // country/state mapping completo), hasheia SHA-256 e deriva advanced matching
  // partial keys (f5first, f5last, fi) automaticamente pra aumentar EMQ.
  // Fix: use webhook timestamp (x-chatwoot-timestamp header) for idempotency.
  // If webhook is retried by Chatwoot, same timestamp ensures identical event_id,
  // enabling Meta's dedup to work correctly (without duplicates from retries).
  // Chatwoot sends timestamp in Unix seconds (already validated in verifyChatwootSignature).
  //
  // Fix HIGH 20/04/2026 (H7): clamp chatwootTs a ±5min do server time.
  // Em WARN-ONLY mode (CHATWOOT_WEBHOOK_ENFORCE !== '1'), atacante pode spoofar
  // header pra ts arbitrário → event_time no futuro → Meta 2804003 ou bypass
  // dedup (mesmo wamid mas ts distintos). Window 5min = tolerância realista
  // de clock drift mas impede manipulação maliciosa.
  const chatwootTs = req.headers['x-chatwoot-timestamp'];
  const parsedTs = chatwootTs ? parseInt(chatwootTs, 10) : null;
  const serverNow = Math.floor(Date.now() / 1000);
  const now = (parsedTs && Number.isFinite(parsedTs) && Math.abs(parsedTs - serverNow) < 300)
    ? parsedTs
    : serverNow;
  if (parsedTs && now !== parsedTs) {
    console.warn(`[CRM-WEBHOOK] chatwootTs drift >5min (ts=${parsedTs} server=${serverNow}) → using serverNow`);
  }
  let firstName = null, lastName = null;
  if (nome) {
    const parts = nome.trim().split(/\s+/);
    firstName = parts[0];
    if (parts.length > 1) lastName = parts[parts.length - 1];
  }
  // Fix HIGH 20/04/2026 (H1): external_id passed INTO buildUserData pra
  // consistência com track.js. Antes crm-webhook fazia hashPII manual após
  // buildUserData, podendo divergir do path track.js → dedup cross-event falhava.
  // Agora mesmo input (email > phone > nome) flui pelo mesmo SDK normalizer.
  const normalizedPhoneForExtId = telefone ? normalizePhone(telefone) : null;
  const externalIdRaw = email || normalizedPhoneForExtId || nome || null;
  const userData = await buildUserData({
    email: email || undefined,
    phone: telefone ? normalizePhone(telefone) : undefined,
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    // FIX V4.2 (Codex N1): reusa _isJpLead já existente linha 476.
    // Antes hardcoded Recife — contaminava EMQ JP no CAPI.
    city: _isJpLead ? 'joao pessoa' : 'recife',
    state: _isJpLead ? 'pb' : 'pe',
    zip_code: _isJpLead ? '58000' : '50000',
    country: 'br',
    external_id: externalIdRaw || undefined,
    // FIX EMQ 26/04/2026 — adicionar page_id da clínica correta.
    // Meta best practice 2026: page_id é matching key high-priority pra
    // datasets messaging E system_generated CRM events. capi-wam.js já
    // adiciona page_id automaticamente pro WAM (linha 155), mas sendCAPI
    // do Pixel LP NÃO enriquecia. Sem page_id no Pixel LP, EMQ Qualified
    // Lead ficava em 6.6/10 (target 8.0+).
    // FIX 26/04/2026 v2 (Vercel Agent review PR#36): NÃO usar PAGE_ID
    // hardcoded — usar `userDataPageId` derivado de customAttrs.page_id
    // pra leads JP receberem PAGE_ID_JPA (não PAGE_ID Recife). Sem isso,
    // attribution Conversion Leads CRM JP quebra mesmo com Pixel routing OK.
    page_id: userDataPageId || undefined,
    // Fix HIGH AI audit 20/04/2026 (crm-webhook.js:349): remover gender:'f' hardcoded
    // pra consistência com M12 aplicado em whatsapp.js. Meta penaliza mismatch mais
    // que ausência — leads masculinos (~5%) estavam degradando EMQ com gender errado.
    // Se gender vier de custom_attrs ou dados Chatwoot, ainda pode ser populado adiante.
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
      // Phone match usa últimos 11 dígitos (padrão celular BR: 2 DDD + 9 dígitos).
      // Antes era slice(-8) que colidia entre DDDs (81 vs 11 com mesmo sufixo).
      // Fix HIGH via AI code review 19/04/2026 (Claude Opus 4.6).
      // Fix H-2 (22/04/2026 audit linha-a-linha): pathnames reais em prod são
      // `ctwa/55{DDD}{phone}.json` (safeFrom em whatsapp.js:468 = 12-13 digits
      // começando com "55"). slice(-11) remove os "55" → pattern `ctwa/{11d}.`
      // NUNCA bate (char[5] "5" vs "8"). Validado LIVE 30 blobs amostrados = 0
      // matches, attribution CRM quebrada 100% desde que safeFrom começou com 55.
      //
      // Fix Q1 (23/04/2026 AI review Opus 4.6): trocar `includes()` por
      // `endsWith()` ancorado à direita. `includes()` permite substring match
      // em qualquer posição — risco teórico de false positive se dois phones
      // distintos compartilham os 11 últimos dígitos via substring (improvável
      // com DDD+celular BR, mas defensivo). `endsWith()` garante match exato
      // apenas quando phoneKey termina o path (sem o .json/suffix random).
      // Formato esperado: `ctwa/55XXXXXXXXXXX.json` ou `ctwa/55XXXXXXXXXXX-abc.json`.
      const phoneKey = telDigits.slice(-11);
      let cursor;
      let foundCtwa = false;
      do {
        const ctwaBlobs = await list({ prefix: 'ctwa/', cursor, limit: 100 });
        for (const blob of ctwaBlobs.blobs || []) {
          const blobPhoneStr = blob.pathname
            .slice(5)                          // remove 'ctwa/'
            .replace(/\.json$/, '')            // remove .json extension
            .replace(/-[A-Za-z0-9]+$/, '');    // remove -suffix random (se addRandomSuffix)
          if (blob.pathname.startsWith('ctwa/') && blobPhoneStr.endsWith(phoneKey)) {
            // Fix VA-1 (23/04/2026 AI review Opus 4.6): AbortSignal.timeout(5s) pra
            // proteger handler. Blob store latência alta pode travar webhook up to
            // 60s (Pro timeout) e Chatwoot retenta → webhook storm. 5s é generoso
            // pra fetch JSON <10KB do Blob CDN.
            const blobResp = await fetch(blob.url, { signal: AbortSignal.timeout(5000) });
            const data = await blobResp.json();
            if (data && (data.ctwa_clid || data.profile_name || data.ad_metadata)) {
              ctwaData = data;
              if (!ctwaClid && data.ctwa_clid) ctwaClid = data.ctwa_clid;
              console.log(`[CRM-WEBHOOK] Recovered CTWA data from Blob: clid=${!!data.ctwa_clid} profile=${!!data.profile_name} ad_meta=${!!data.ad_metadata}`);
              foundCtwa = true;
              break;
            }
          }
        }
        if (foundCtwa) break;
        cursor = ctwaBlobs.hasMore ? ctwaBlobs.cursor : undefined;
      } while (cursor);
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
              // Fix: normalize leading zeros before matching to handle cases where:
              //  - telDigits has country code (55) but blobTel doesn't
              //  - either number has stray leading zeros from data quality issues
              const telDigitsNorm = telDigits.replace(/^0+/, '') || telDigits;
              const blobTelNorm = blobTel.replace(/^0+/, '') || blobTel;
              if (blobTel && blobTel.length >= 10 && telDigitsNorm.endsWith(blobTelNorm)) {
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

  // Fix HIGH 20/04/2026 (H1): external_id agora é passado diretamente ao
  // buildUserData acima (linha 369) — SDK oficial Meta normaliza + hasheia.
  // Bloco manual removido pra eliminar divergência com track.js.

  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  // EMQ fix: client_ip_address + client_user_agent recuperados do Blob lead original.
  // Meta docs: ip e UA são high-priority matching keys. Sem eles EMQ Lead ficava em 6.5
  // (86% sem IP/UA). Com recovery via Blob, sobe pra ~8.0+ quando user veio via LP form.
  if (clientIp) userData.client_ip_address = clientIp;
  if (clientUa) userData.client_user_agent = clientUa;

  // Fix CRITICAL 20/04/2026: REMOVIDO lead_id = contact.id.
  // Meta docs oficiais (https://developers.facebook.com/docs/marketing-api/
  // conversions-api/conversion-leads-integration/payload-specification):
  //   "lead_id: The ID generated by Facebook for each lead. It is a 15 to 17
  //    digit number."
  // contact.id do Chatwoot é 5-7 dígitos ≠ Meta-generated 15-17 digit. Enviar
  // formato errado pode causar Meta a REJEITAR o matching ou degradar EMQ.
  // IceLaser não usa Lead Ads forms nativos (leads vêm de LP + CTWA), logo
  // NUNCA temos Meta leadgen_id válido → external_id (phone hashed) + em/ph/fn/ln
  // são o primary matching path. ctwa_clid fornece attribution pra CTWA.
  //
  // Se no futuro adotarmos Lead Ads nativos: recuperar leadgen_id via
  // GET /{form_id}/leads?fields=id&access_token=PAGE_TOKEN e atribuir a userData.lead_id.
  //
  // Custom data mantém referência Chatwoot ID pra debug via custom_data.crm_contact_id
  // (não é matching key, só identificador interno pra investigar no Meta Events Manager).
  const crmContactId = contact.id ? String(contact.id) : null;

  // Fix 21/04/2026 (wizard CRM Conversion Leads): recuperar leadgen_id REAL Meta
  // do contact.custom_attributes (setado em whatsapp.js:1225 quando lead chega via
  // leadgen webhook). Meta docs payload-specification:
  //   "lead_id: 15-17 digit number from leadgen_id webhook field. HIGHEST priority
  //    matching key."
  // Sem lead_id, wizard CRM Integration trava em 20% (Etapa 2) mesmo com events
  // corretos — Meta exige match com leadgen_id da Lead Ad pra progredir.
  const leadgenId = customAttrs?.leadgen_id || contact?.custom_attributes?.leadgen_id;
  const isValidLeadgenId = leadgenId && /^\d{15,17}$/.test(String(leadgenId));
  if (isValidLeadgenId) {
    userData.lead_id = String(leadgenId);
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

  // Fix HIGH 20/04/2026 (H2): validar event_source_url contra domínios verificados.
  // Meta Conversion Leads spec: event_source_url deve ser do domínio verificado no
  // Events Manager, senão Meta dropa silenciosamente ou rejeita matching. customAttrs
  // pode vir do Chatwoot CRM com URL de terceiros (wa.me, chatwoot.com, etc) →
  // validar hostname antes de usar, fallback pro canonical IceLaser.
  const VERIFIED_DOMAINS = ['icelasers.com.br', 'www.icelasers.com.br'];
  let eventSourceUrl = 'https://icelasers.com.br/';
  const candidateUrl = customAttrs.landing_url
    || customAttrs.event_source_url
    || customAttrs.lp_url;
  if (candidateUrl) {
    try {
      const parsed = new URL(String(candidateUrl));
      if (VERIFIED_DOMAINS.includes(parsed.hostname) && parsed.protocol === 'https:') {
        eventSourceUrl = candidateUrl;
      } else {
        console.warn(`[CRM-WEBHOOK] event_source_url hostname="${parsed.hostname}" não verificado → fallback canonical`);
      }
    } catch {
      console.warn(`[CRM-WEBHOOK] event_source_url inválido "${String(candidateUrl).slice(0,60)}" → fallback canonical`);
    }
  }

  // Ad metadata do CTWA (via Meta Graph lookup salvo no Blob) �� propagar
  // campaign_id/adset_id/ad_id pra custom_data de TODOS os events CRM.
  // Meta Andromeda 2026 usa esses IDs pra attribution cross-device.
  const ctwaAdMeta = ctwaData && ctwaData.ad_metadata ? ctwaData.ad_metadata : null;

  // Fix M-3 (22/04/2026 audit linha-a-linha): action_source SEMPRE system_generated
  // no Pixel LP. Antes variava pra business_messaging quando ctwaClid presente, mas:
  //  (1) Pixel LP 2774... é dataset WEBSITE, não messaging → business_messaging é
  //      action_source EXCLUSIVO de datasets messaging (WAM 967...)
  //  (2) mkBaseEvent não adicionava messaging_channel quando business_messaging →
  //      Meta silent drop potencial (spec 2026 exige messaging_channel obrigatório)
  //  (3) Attribution CTWA já é feita EXCLUSIVAMENTE no WAM via processarCTWA em
  //      whatsapp.js (LeadSubmitted com action_source=business_messaging + messaging_channel=whatsapp)
  // Semântica correta: events CRM são label updates (system_generated), events CTWA
  // nativos são business_messaging (só via WAM).
  const actionSource = 'system_generated';

  // Factory: cada chamada retorna novo objeto com shallow clone de user_data,
  // evitando referência compartilhada que poluiria todos os eventos do batch.
  // Bug CRITICAL detectado via AI code review 19/04/2026 (Claude Opus 4.6).
  const mkBaseEvent = () => ({
    event_source_url: eventSourceUrl,
    action_source: actionSource,
    user_data: { ...userData },         // shallow clone — arrays dentro (em, ph, fn...) ficam shared mas são imutáveis na prática
  });

  // custom_data base para todos os eventos CRM (conforme guia Meta Conversion Leads)
  // Helper: spread só se valor truthy (evita poluir payload com null/undefined).
  const ifSet = (k, v) => (v !== null && v !== undefined && v !== '') ? { [k]: v } : {};
  const m = ctwaAdMeta || {};
  let crmBase = {
    event_source: 'crm',         // obrigatório para Conversion Leads
    lead_event_source: 'Chatwoot',
    // ── ATTRIBUTION CTWA FULL (via Meta Graph API lookup em whatsapp.js) ──
    // ad
    ...ifSet('ad_id', m.ad_id),
    ...ifSet('ad_name', m.ad_name),
    ...ifSet('ad_status', m.ad_status),
    ...ifSet('account_id', m.account_id),
    // creative (key pra creative testing analysis)
    ...ifSet('creative_id', m.creative_id),
    ...ifSet('creative_name', m.creative_name),
    ...ifSet('creative_body', m.creative_body),
    ...ifSet('creative_cta', m.creative_cta),
    ...ifSet('creative_image_url', m.creative_image_url),
    ...ifSet('creative_video_id', m.creative_video_id),
    ...ifSet('creative_thumbnail', m.creative_thumbnail),
    // adset
    ...ifSet('adset_id', m.adset_id),
    ...ifSet('adset_name', m.adset_name),
    ...ifSet('adset_status', m.adset_status),
    ...ifSet('optimization_goal', m.optimization_goal),
    ...ifSet('destination_type', m.destination_type),
    ...ifSet('billing_event', m.billing_event),
    ...ifSet('bid_strategy', m.bid_strategy),
    ...ifSet('attribution_window_event', m.attribution_window_event),
    ...ifSet('attribution_window_days', m.attribution_window_days),
    ...ifSet('adset_daily_budget_cents', m.adset_daily_budget_cents),
    ...ifSet('adset_lifetime_budget_cents', m.adset_lifetime_budget_cents),
    ...ifSet('adset_start_time', m.adset_start_time),
    ...ifSet('adset_end_time', m.adset_end_time),
    // campaign
    ...ifSet('campaign_id', m.campaign_id),
    ...ifSet('campaign_name', m.campaign_name),
    ...ifSet('campaign_status', m.campaign_status),
    ...ifSet('campaign_objective', m.campaign_objective),
    ...ifSet('buying_type', m.buying_type),
    ...ifSet('special_ad_categories', m.special_ad_categories),
    ...ifSet('campaign_daily_budget_cents', m.campaign_daily_budget_cents),
    ...ifSet('campaign_lifetime_budget_cents', m.campaign_lifetime_budget_cents),
    ...ifSet('campaign_start_time', m.campaign_start_time),
    ...ifSet('campaign_stop_time', m.campaign_stop_time),
    ...ifSet('smart_promotion_type', m.smart_promotion_type),
    ...ifSet('pacing_type', m.pacing_type),
    // placements
    ...ifSet('publisher_platforms', m.publisher_platforms),
    ...ifSet('facebook_positions', m.facebook_positions),
    ...ifSet('instagram_positions', m.instagram_positions),
    ...ifSet('messenger_positions', m.messenger_positions),
    // cohort (targeting basics, anonimizado — sem GPS coords)
    ...ifSet('target_age_min', m.target_age_min),
    ...ifSet('target_age_max', m.target_age_max),
    ...ifSet('target_genders', m.target_genders),
    ...ifSet('target_geo_country', m.target_geo_country),
    ...ifSet('target_geo_region_id', m.target_geo_region_id),
    ...ifSet('target_geo_city_id', m.target_geo_city_id),
    // promoted (page+wa identifiers)
    ...ifSet('promoted_page_id', m.promoted_page_id),
    ...ifSet('promoted_wa_phone_id', m.promoted_wa_phone_id),
    ...ifSet('promoted_wa_phone_number', m.promoted_wa_phone_number),
    // referência interna Chatwoot pra debugging (não é matching key)
    ...ifSet('crm_contact_id', crmContactId),
  };

  // Fix P1 (AI review): payload size guard. Meta limits ~25KB por evento.
  // Em burst com creative_body + asset URLs, pode estourar. Truncar campos
  // pesados primeiro (creative_body, depois URLs longas).
  const MAX_CUSTOM_DATA_BYTES = 20000;
  const sizeNow = () => Buffer.byteLength(JSON.stringify(crmBase), 'utf8');
  if (sizeNow() > MAX_CUSTOM_DATA_BYTES) {
    delete crmBase.creative_body;
    if (sizeNow() > MAX_CUSTOM_DATA_BYTES) {
      delete crmBase.creative_image_url;
      delete crmBase.creative_thumbnail;
    }
    if (sizeNow() > MAX_CUSTOM_DATA_BYTES) {
      console.warn(`[CRM-WEBHOOK] custom_data ainda > ${MAX_CUSTOM_DATA_BYTES}B após truncate (${sizeNow()}B)`);
    }
  }

  const events = [];
  // Fix HIGH AI deep review v2 B2 (crm-webhook.js:572): jitter 4 chars (~1.7M combinations)
  // tinha probabilidade real de collision em bursts + NÃO é idempotente. Meta retenta
  // webhooks → mesmo contact+label gera event_id diferente → duplicata no Meta.
  // Novo: determinístico por (contactKey + label_set + eventIdSeed) — Meta dedup OK.
  // labels array → sort + join para hash stable. Se Chatwoot re-envia o mesmo update, eventId
  // idêntico → Meta dedup aceita 1ª e rejeita retries.
  //
  // FIX 26/04/2026 v2 (Vercel Agent review PR#37):
  // `now` é clamped a serverNow se chatwoot ts drift >5min → em retries Chatwoot
  // tardios (>5min) o eventId mudava entre tentativas → Meta NÃO dedupava →
  // events DUPLICADOS. Solução: usar `eventIdSeed` que prefere parsedTs
  // (chatwoot ts raw, mesmo se drift) ou body.id (webhook payload id estável),
  // ANTES de cair em now (serverNow). Garante eventId estável across retries.
  // event_time continua usando `now` (clamped) — Meta exige timestamp em janela 7d.
  const contactKey = contact.id || (telefone ? telefone.replace(/\D/g, '') : 'unk');
  const labelsKey = [...labels].sort().join(',').replace(/[^a-z0-9,_-]/gi, '').slice(0, 60);
  const eventIdSeed = parsedTs && Number.isFinite(parsedTs)
    ? parsedTs
    : (body?.id ? `b${body.id}` : now);
  const eventId = `crm_${contactKey}_${eventIdSeed}_${labelsKey}`;
  // Fix 22/04/2026: orderId ESTÁVEL por venda (não por webhook firing).
  // Antes: `order_${contactKey}_${now}` → mudava a cada webhook → Meta
  // tratava retries como orders distintos → cobertura order_id = 0% no painel.
  // Agora: usa conversation.id do Chatwoot (imutável, único por venda).
  // Fallback: contact.id (também imutável). Jamais usar `now` no orderId.
  const conversationId = conversation?.id ? String(conversation.id) : null;
  const orderId = conversationId
    ? `order_cw${conversationId}`
    : `order_contact${contactKey}`;

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
  // Fix LOW AI review 20/04/2026 (L2): normalizar AMBOS os lados em lowercase.
  // Antes comparava variants literais contra l.toLowerCase() — se variant fosse
  // 'Lead_Quente' (mixed) e label 'lead_quente' (lower), matching falhava.
  const hasLabel = (...variants) => {
    const lowerVariants = variants.map(v => String(v).toLowerCase());
    return labels.some(l => lowerVariants.includes(String(l).toLowerCase()));
  };

  // V5 Pixel-only: conversation_created sem label NÃO vira Lead automático.
  // O antigo evento automático de chegada fabricava sinal de topo de funil
  // e podia inflar Lead sem conversão real. O backfill `_compra_lead` abaixo
  // permanece para não deixar compras orgânicas órfãs no funil.

  // ❌ DESQUALIFICADO — APENAS custom event pra audience exclusion.
  //
  // Fix 27/04/2026 (PR #39 v2 — research Opus 4.6 + Meta CRM Integration docs):
  // Andromeda NÃO usa "negative conversion events" como signal de otimização —
  // aprende por AUSÊNCIA de progressão downstream. Cliente desqualificado JÁ
  // recebeu Lead via fluxo natural (auto-Lead conversation_created OU outras
  // labels prévias). Disparar OUTRO Lead aqui (mesmo com value=0) pollui
  // counters de conversão e gera contagem dupla.
  //
  // Mantemos APENAS custom `LeadDesqualificado` → cria Audience pra EXCLUSION
  // em targeting (filtro de delivery, não signal otimização).
  if (hasLabel('desqualificado', '❌ Desqualificado', '❌_desqualificado', 'disqualified', 'unqualified')) {
    events.push({
      ...mkBaseEvent(),
      event_name: 'LeadDesqualificado',
      event_time: now,
      event_id: `${eventId}_disqualified_audience`,
      ...(originalLeadData && { original_event_data: originalLeadData }),
      custom_data: {
        ...crmBase,
        content_name: 'Lead Desqualificado - CRM',
        lead_type: 'disqualified',
        status: 'disqualified',
        quality: 'unqualified',
        disqualification_reason: 'fora_do_publico_alvo',
        currency: 'BRL',
        value: 0,
        predicted_ltv: 0,
        customer_segmentation: customerSeg,
      },
    });
  }

  // 📧 MARKETING OPT-IN — user aceitou receber comunicações WhatsApp marketing/newsletter.
  // Label `marketing_opt_in` criada Chatwoot 26/04/2026 (id 16). Atendente marca quando
  // user explicitamente concorda em receber promos/conteúdo recorrente. Dispara
  // Subscribe Meta event — sinaliza opt-in pro Andromeda otimizar campanhas
  // de retargeting/CRM nurture pra users qualificados a receber comunicação.
  if (hasLabel('marketing_opt_in', '📧 Marketing Opt-In', 'marketing opt in', 'subscribed')) {
    events.push({
      ...mkBaseEvent(),
      event_name: 'Subscribe',
      event_time: now,
      event_id: `${eventId}_subscribe`,
      ...(originalLeadData && { original_event_data: originalLeadData }),
      custom_data: {
        ...crmBase,
        content_name: 'Marketing Opt-In - CRM',
        lead_type: 'marketing_opt_in',
        status: 'subscribed',
        currency: 'BRL',
        value: 0,                       // opt-in não tem valor monetário direto
        predicted_ltv: DEFAULT_PREDICTED_LTV,
        customer_segmentation: customerSeg,
      },
    });
  }

  // 🧊 LEAD FRIO — cliente nunca respondeu ou abandonou (não respondeu nem saudação).
  //
  // Fix 27/04/2026 (PR #39 v2 — research Opus 4.6): NÃO disparar `Lead` aqui —
  // Lead já foi disparado via fluxo natural quando cliente apareceu. Disparar
  // mais um polui sinal positivo Andromeda. Apenas custom `LeadFrio` →
  // audience EXCLUSION em campaigns futuras (filtro de delivery).
  //
  // Andromeda aprende negativamente por AUSÊNCIA de progressão downstream:
  // Lead emitido mas não progrediu pra CR/QL/Purchase → algoritmo infere
  // "perfil não converte". Custom event LeadFrio reforça via audience exclusion.
  //
  // event_name 'LeadFrio' VALIDADO LIVE Pixel LP system_generated/website
  // (test_event_code TEST27042026_FUNNEL_FIX → events_received=1).
  if (hasLabel('lead_frio', '🧊 Lead Frio', '🧊_lead_frio', 'cold_lead', 'lead frio', 'frio')) {
    events.push({
      ...mkBaseEvent(),
      event_name: 'LeadFrio',
      event_time: now,
      event_id: `${eventId}_cold_lead_audience`,
      ...(originalLeadData && { original_event_data: originalLeadData }),
      custom_data: {
        ...crmBase,
        content_name: 'Lead Frio - CRM',
        lead_type: 'cold_lead',
        status: 'unresponsive',
        quality: 'low',
        currency: 'BRL',
        value: 0,                       // sem valor monetário
        predicted_ltv: 0,               // EVITE perfil similar
        customer_segmentation: customerSeg,
      },
    });
  }

  // 🔥 LEAD QUENTE — cliente engajou + atendente qualificou.
  //
  // Fix 27/04/2026 (PR #39 v2 — research Opus 4.6): NÃO disparar `Lead` aqui —
  // Lead já foi disparado via fluxo natural. Disparar Lead value=300 sobre o
  // Lead já emitido cria DOIS Leads pro mesmo cliente com values conflitantes.
  //
  // Mantemos APENAS events DOWNSTREAM (CompleteRegistration + Qualified Lead):
  // são esses que o Conversion Leads CRM funnel usa pra otimização. Andromeda
  // aprende positivamente pela PROGRESSÃO Lead→CR→QL.
  if (hasLabel('lead_quente', '🔥 Lead Quente', '🔥_lead_quente', 'hot_lead', 'lead quente', 'quente')) {
    events.push(
      {
        ...mkBaseEvent(),
        event_name: 'CompleteRegistration',
        event_time: now,
        event_id: `${eventId}_hot_cr`,
        ...(originalLeadData && { original_event_data: originalLeadData }),
        custom_data: {
          ...crmBase,
          content_name: 'Lead Quente - CRM',
          status: 'converted',
          currency: 'BRL',
          value: 300,                                 // alinhado com Lead event
          predicted_ltv: DEFAULT_PREDICTED_LTV,
          customer_segmentation: customerSeg,
        },
      },
      // FIX 26/04/2026 v2 — event_name 'Qualified Lead' (com espaço).
      // Anterior commit 3e9071b usava 'QualifiedLead' (camelCase) — Meta tratava
      // como event SEPARADO do funnel "Qualified Lead". Validado LIVE Graph API:
      // os dois são aceitos mas NÃO normalizados. Conversion Leads CRM funil
      // mapeia apenas a versão com espaço.
      // Sem este disparo, label `lead_quente` Chatwoot só gera Lead+CR — perde
      // sinal de qualificação. event_id distinto pra Meta NÃO dedup (sinais
      // semanticamente distintos: Lead=1º contato, CR=registro, Qualified Lead=
      // qualificação humana).
      {
        ...mkBaseEvent(),
        event_name: 'Qualified Lead',
        event_time: now,
        event_id: `${eventId}_hot_qualified`,
        ...(originalLeadData && { original_event_data: originalLeadData }),
        custom_data: {
          ...crmBase,
          content_name: 'Lead Quente - CRM',
          lead_type: 'qualified_lead',
          status: 'qualified',
          currency: 'BRL',
          value: 300,
          predicted_ltv: DEFAULT_PREDICTED_LTV,
          customer_segmentation: customerSeg,
        },
      }
    );
  }

  // Helper: parse seguro. `parseFloat(0) || DEFAULT` cai no DEFAULT — bug.
  // Usar Number.isFinite + >0 pra detectar zero-by-error de real 0.
  // Fix 23/04/2026: usa parsePurchaseValue (handles BR format "R$ 1.018,80")
  // com fallback DEFAULT_PURCHASE_VALUE pra backward-compat.
  const safeValorParse = (raw) => {
    try {
      const n = parsePurchaseValue(raw);
      return n !== null && n > 0 ? n : DEFAULT_PURCHASE_VALUE;
    } catch {
      // Fail-safe: se nova lib falhar, usa método antigo
      const n = parseFloat(raw);
      return Number.isFinite(n) && n > 0 ? n : DEFAULT_PURCHASE_VALUE;
    }
  };

  // 💳 LINK DE PAGAMENTO (atendente enviou link / cliente vai pagar)
  if (hasLabel('link_pagamento', '💳 Link Pagamento', '💳_link_pagamento', 'link pagamento', 'pagamento', 'checkout')) {
    const valor = safeValorParse(customAttrs.purchase_value);
    events.push({
      ...mkBaseEvent(),
      event_name: 'InitiateCheckout',
      event_time: now,
      event_id: `${eventId}_ic`,
      ...(originalLeadData && { original_event_data: originalLeadData }),
      custom_data: {
        ...crmBase,
        currency: 'BRL',
        value: valor,
        content_name: 'Link Pagamento - CRM',
        customer_segmentation: customerSeg,
        order_id: orderId,
      },
    });
  }

  // 💰 COMPRA REALIZADA
  if (hasLabel('compra_realizada', '💰 Compra Realizada', '💰_compra_realizada', 'purchase', 'compra realizada', 'comprou', 'vendido', 'sold')) {
    const valor = safeValorParse(customAttrs.purchase_value);
    // Fix H-3 (22/04/2026 audit linha-a-linha): CLAUDE.md documenta funil
    // `compra_realizada → Lead + CR + IC + Purchase` (4 eventos). Código antigo
    // só disparava IC+Purchase → atendente que pulava lead_quente direto pra
    // compra (caso real Suellen conv 314) deixava funil Meta incompleto →
    // Andromeda AI otimizava com dados pobres.
    //
    // Fix Q2 (23/04/2026 AI review Opus 4.6): adicionar `hasColdNow` no guard
    // needLead. Cenário regressão detectado: operador adiciona lead_frio +
    // compra_realizada SIMULTANEAMENTE no mesmo webhook. previousLabels vazio
    // (primeiro contato). Block lead_frio acima dispara Lead com event_id
    // `_cold_lead`. Sem `hasColdNow` no guard, needLead=true → dispara Lead com
    // event_id `_compra_lead` (diferente) → Meta NÃO dedupa → 2 Leads enviados
    // por 1 conversão real → infla CPL, corrompe Andromeda optimization.
    //
    // Regra completa: ver api/_lib/funnel-guards.js com tabela de verdade.
    // Função extraída pra ser testável em isolamento (tests/funnel-guards.test.js).
    // Fix 27/04/2026 v2 (post-PR #40 ultrareview Bug 2): RESTAURADO backfill `Lead`.
    // Auto-Lead em conversation_created (PR #37) raramente dispara em prod (gate
    // `labels.length===0` falha quando Chatwoot envia conversation com labels já
    // populadas). Removido em PR #40 confiando em "Lead já foi disparado via
    // fluxo natural" — premissa quebrada no cenário organic+direct purchase.
    //
    // Cliente orgânico WA (sem CTWA) que vai DIRETO de Lead Frio ou nada pra
    // compra_realizada NÃO recebe Lead nenhum sem este backfill → Conversion
    // Leads CRM funnel orphan (CR/QL/Purchase sem Lead). Tests funnel-guards #1
    // e #8 ainda assertam needLead:true pra "direto → compra".
    //
    // Meta dedup via event_id estável `_compra_lead` evita contagem dupla quando
    // auto-Lead JÁ disparou (cenário CTWA com conversation_created sem labels).
    const { needLead, needCR } = computeCompraRealizadaGuards(labels, previousLabels);
    if (needLead) {
      events.push({
        ...mkBaseEvent(),
        event_name: 'Lead',
        event_time: now - 3600,
        event_id: `${eventId}_compra_lead`,
        ...(originalLeadData && { original_event_data: originalLeadData }),
        custom_data: {
          ...crmBase,
          content_name: 'Lead (inferido via Compra) - CRM',
          lead_type: 'hot_lead',
          currency: 'BRL',
          value: 300,
          predicted_ltv: DEFAULT_PREDICTED_LTV,
          customer_segmentation: customerSeg,
        },
      });
    }
    if (needCR) {
      events.push({
        ...mkBaseEvent(),
        event_name: 'CompleteRegistration',
        event_time: now - 2400,
        event_id: `${eventId}_compra_cr`,
        ...(originalLeadData && { original_event_data: originalLeadData }),
        custom_data: {
          ...crmBase,
          content_name: 'Lead (inferido via Compra) - CRM',
          status: 'converted',
          currency: 'BRL',
          value: 300,
          predicted_ltv: DEFAULT_PREDICTED_LTV,
          customer_segmentation: customerSeg,
        },
      });
      // FIX 26/04/2026 v2 — backfill 'Qualified Lead' (com espaço) quando
      // atendente pula direto de Lead Frio pra compra_realizada. Mesma lógica
      // do CR backfill: se exigiu CR backfill, exigiu Qualified Lead também.
      // Mantém funil Conversion Leads consistente.
      // event_time = now - 2100 → ordem temporal funil (Lead emitido em backfill acima):
      //   Lead (-3600) < CR (-2400) < Qualified Lead (-2100) < IC (-1800) < Purchase (now)
      events.push({
        ...mkBaseEvent(),
        event_name: 'Qualified Lead',
        event_time: now - 2100,
        event_id: `${eventId}_compra_qualified`,
        ...(originalLeadData && { original_event_data: originalLeadData }),
        custom_data: {
          ...crmBase,
          content_name: 'Lead (inferido via Compra) - CRM',
          lead_type: 'qualified_lead',
          status: 'qualified',
          currency: 'BRL',
          value: 300,
          predicted_ltv: DEFAULT_PREDICTED_LTV,
          customer_segmentation: customerSeg,
        },
      });
    }
    events.push(
      {
        ...mkBaseEvent(),
        event_name: 'InitiateCheckout',
        event_time: now - 1800,
        event_id: `${eventId}_purchase_ic`,
        ...(originalLeadData && { original_event_data: originalLeadData }),
        custom_data: {
          ...crmBase,
          currency: 'BRL',
          value: valor,
          content_name: 'Compra CRM',
          customer_segmentation: customerSeg,
          order_id: orderId,
        },
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
    console.log(`[CRM-WEBHOOK] skipped no_matching_labels | event=${event} allLabels=${JSON.stringify(allLabels)} newLabels=${JSON.stringify(labels)} previousLabels=${JSON.stringify(previousLabels)}`);
    return res.status(200).json({ ok: true, skipped: true, reason: 'no_matching_labels' });
  }

  // Validação de batch: filtrar eventos inválidos antes de enviar
  // (se 1 evento inválido no batch, a Meta rejeita o batch INTEIRO)
  const validEvents = events.filter(evt => {
    if (!evt.event_name || !evt.event_time || !evt.action_source) {
      console.warn(`[CRM-WEBHOOK] Evento inválido removido: event_name=${evt.event_name} event_time=${evt.event_time} action_source=${evt.action_source} event_id=${evt.event_id}`);
      return false;
    }
    if (!evt.user_data || Object.keys(evt.user_data).length === 0) {
      console.warn(`[CRM-WEBHOOK] Evento sem user_data removido: ${evt.event_name}`);
      return false;
    }
    return true;
  });

  if (validEvents.length === 0) {
    return res.status(422).json({ ok: false, skipped: true, reason: 'all_events_invalid' });
  }

  // ═════════════════════════════════════════════════════════════════════
  // ROTEAMENTO BINÁRIO DATASETS (fix 23/04/2026 double counting)
  // ═════════════════════════════════════════════════════════════════════
  // Problema descoberto LIVE: Meta NÃO faz dedup cross-dataset. Creative
  // Testing contou 2× Purchase da Bruna (R$ 2.037,60 = R$ 1.018,80 × 2)
  // pq fan-out enviava pros 2 datasets simultaneamente.
  //
  // Solução: decidir UM dataset por evento baseado em:
  //   1. customAttrs.payment_method (atendente marca no Chatwoot)
  //   2. ctwa_clid presente (inferência: veio de CTWA)
  //   3. leadgen_id presente (inferência: Lead Ad nativo)
  //   4. Fallback → WAM (80% vendas IceLaser via WA link)
  //
  // SAFETY:
  //   - Feature flag PURCHASE_ROUTING_ENABLED=0 desabilita (fallback: envio aos 2)
  //   - Try/catch defensivo — se routing falhar, mantém comportamento antigo
  //   - Log explícito do target + reason pra auditoria
  let routingDecision = null;
  try {
    if (isRoutingEnabled()) {
      routingDecision = decideTargetDataset({ customAttrs, ctwa_clid: ctwaClid });
      console.log(`[CRM-WEBHOOK ROUTING] target=${routingDecision.target} reason=${routingDecision.reason} ctwa=${!!ctwaClid} payment_method="${customAttrs?.payment_method || '(none)'}"`);
    } else {
      console.log('[CRM-WEBHOOK ROUTING] DISABLED via env — fallback fan-out');
    }
  } catch (routingErr) {
    console.error('[CRM-WEBHOOK ROUTING] error → fail-safe fan-out:', routingErr.message);
    routingDecision = null;
  }
  const shouldSendPixelLP = !routingDecision || routingDecision.target === DATASET_PIXEL_LP;

  // ═════════════════════════════════════════════════════════════════════
  // CROSS-CLINIC ROUTING (FIX 26/04/2026)
  // ═════════════════════════════════════════════════════════════════════
  // Detectar clínica baseado em customAttrs.page_id (vem do webhook leadgen
  // Meta via whatsapp.js:1224). Se page_id == JP, override Pixel destination
  // pra Pixel JP (1386967056530127) + token JP (CAPI_DATASET_TOKEN_JP).
  // Sem isso, leads do Lead Ad form Page JP que caem no Chatwoot Recife
  // (inbox 8) gerariam events no Pixel Recife — Conversion Leads CRM JP fica
  // zerado e cross-clinic data leak. Detected na sessão 26/04 ~19h BRT.
  // TODO when 3rd clinic added: replace string equality with a Map<page_id, {pixel,token}>.
  // Reuse cross-clinic detection done up-top (line ~344) — same source of truth
  // pra user_data.page_id E pixel routing. _leadPageIdRaw / _isJpLead foram
  // computed antes do buildUserData pra propagar page_id correto no user_data.
  const leadPageId = _leadPageIdRaw;
  const isJpLead = _isJpLead;
  const targetPixelId = isJpLead ? PIXEL_ID_JPA : PIXEL_ID;
  // Token fallback: CAPI_DATASET_TOKEN_JP > META_ACCESS_TOKEN > original (Recife) token.
  // If CAPI_DATASET_TOKEN_JP undefined for a JP lead, log warn so operator notices
  // missing env var (silent fallback risks wrong-scope token rejection at Meta).
  let targetToken = token;
  if (isJpLead) {
    const jpToken = process.env.CAPI_DATASET_TOKEN_JP;
    if (!jpToken) {
      console.warn('[CRM-WEBHOOK CROSS-CLINIC] ⚠️ CAPI_DATASET_TOKEN_JP missing — falling back to META_ACCESS_TOKEN. Configure dataset-scoped JP token to avoid permission risks.');
    }
    targetToken = jpToken || process.env.META_ACCESS_TOKEN || token;
    console.log(`[CRM-WEBHOOK CROSS-CLINIC] page_id=${leadPageId} → JP routing → Pixel ${PIXEL_ID_JPA}`);
  } else if (!leadPageId) {
    // page_id missing — covers organic WhatsApp / manual contact creation / pre-fix legacy
    // contacts. Defaults to Recife (existing behavior). Audit log to track frequency.
    console.log(`[CRM-WEBHOOK CROSS-CLINIC] no page_id → default Pixel Recife (legacy/organic contact)`);
  }

  // ═════════════════════════════════════════════════════════════════════
  // ENVIO PIXEL LP (só se target=pixel_lp OU routing desabilitado)
  // ═════════════════════════════════════════════════════════════════════
  //
  // Fix 27/04/2026 v2 (post-PR #40 ultrareview Bug 1): custom audience events
  // (LeadFrio, LeadDesqualificado) SEMPRE pro Pixel LP independente do routing.
  // Razão: custom audience events vivem no Pixel dataset (não WAM), e
  // WAM_SUPPORTED_EVENTS + capi-wam.js whitelist NÃO incluem esses nomes →
  // em default WAM routing seriam silenciosamente filtrados → audience nunca
  // popula. Validado LIVE: Pixel LP aceita system_generated/website 100%.
  const AUDIENCE_ONLY_EVENTS = new Set(['LeadFrio', 'LeadDesqualificado']);
  const audienceOnlyEvents = validEvents.filter(e => AUDIENCE_ONLY_EVENTS.has(e.event_name));
  const funnelEvents = validEvents.filter(e => !AUDIENCE_ONLY_EVENTS.has(e.event_name));

  let result = { events_received: 0 };
  let audienceResult = { events_received: 0 };

  // Audience events: SEMPRE pro Pixel LP (bypass routing)
  if (audienceOnlyEvents.length > 0) {
    audienceResult = await sendCAPI(audienceOnlyEvents, targetToken, 0, targetPixelId);
    console.log(`[CRM-WEBHOOK] Audience events forced→Pixel LP: ${audienceOnlyEvents.length} events, received=${audienceResult?.events_received ?? 0}`);
  }

  // Funnel events: V5 Pixel-only. Mesmo que alguma decisão legada não seja
  // Pixel, enviamos para o Pixel correto e não para WAM.
  if (!shouldSendPixelLP) {
    console.warn(`[CRM-WEBHOOK] routing target não-Pixel ignorado no V5; enviando Pixel LP`);
  }
  if (funnelEvents.length > 0) {
    result = await sendCAPI(funnelEvents, targetToken, 0, targetPixelId);
  }
  // Fix MEDIUM AI review 20/04/2026 (M4): events_received pode ser undefined se
  // CAPI retornou erro (ex: invalid_token). Explicitar 0 pra JSON ser sempre determinístico.
  // Fix 27/04/2026 v2 (Vercel Agent finding PR #41): incluir audienceResult no total
  // pra não subreport audience-only events (LeadFrio/LeadDesqualificado) que vão
  // pelo mesmo Pixel LP via path forçado.
  const eventsReceived = (result?.events_received ?? 0) + (audienceResult?.events_received ?? 0);

  console.log(`[CRM-WEBHOOK] ${event} | contact=${maskName(nome)} phone=${maskPhone(telefone)} email=${maskEmail(email)} | labels: ${labels.join(',')} | CAPI: ${eventsReceived} eventos | WAM disabled | ctwa:${!!ctwaClid} | seg:${customerSeg}`);
  if (result?.error || audienceResult?.error || eventsReceived < validEvents.length) {
    return res.status(502).json({
      ok: false,
      error: result?.error?.message || audienceResult?.error?.message || 'capi_incomplete_delivery',
      contact: maskName(nome),
      labels,
      events_sent: validEvents.length,
      events_received: eventsReceived,
      wam_disabled: true,
      ctwa_clid: !!ctwaClid,
      customer_segmentation: customerSeg,
    });
  }
  return res.status(200).json({
    ok: true,
    // Fix LOW AI review 20/04/2026 (L1): mask PII na response (pode vazar em
    // logs de proxies/CDN intermediários). Chatwoot já tem o dado internamente.
    contact: maskName(nome),
    labels,
    events_sent: validEvents.length,
    events_received: eventsReceived,
    wam_disabled: true,
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
