/**
 * /api/crm-webhook — Recebe eventos do Chatwoot CRM
 * Quando label muda → dispara CAPI/Pixel automaticamente
 *
 * Labels → Eventos CAPI:
 *   🧊 Lead Frio       → Lead (cold_lead)
 *   🔥 Lead Quente     → Lead + CompleteRegistration (hot_lead)
 *   💰 Compra Realizada → Lead + CR + InitiateCheckout + Purchase
 */

import crypto from 'crypto';
import { put, list } from '@vercel/blob';

const PIXEL_ID = '2774496306216737';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('55')) return digits;
  return '55' + digits;
}

async function sendCAPI(events, token, retryCount = 0) {
  const res = await fetch(
    `https://graph.facebook.com/v25.0/${PIXEL_ID}/events?access_token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: events }),
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

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'META_ACCESS_TOKEN not configured' });

  const body = req.body || {};
  const event = body.event;

  // Log completo pra debug
  console.log(`[CRM-WEBHOOK] event=${event} | keys=${Object.keys(body).join(',')} | labels=${JSON.stringify((body.conversation || body.data || {}).labels || (body.changed_attributes || []))}`);

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
          `https://graph.facebook.com/v25.0/${sourceId}?fields=referral&access_token=${token}`
        );
        const msgData = await msgResp.json();

        if (msgData.referral?.ctwa_clid) {
          const ctwaClid = msgData.referral.ctwa_clid;
          const sourceUrl = msgData.referral.source_url || '';
          const headline = msgData.referral.headline || '';
          console.log(`[CRM-WEBHOOK] 🎯 CTWA Lead! clid=${ctwaClid.substring(0,20)}... phone=${phone} source=${sourceUrl}`);

          // Salvar ctwa_clid no Blob vinculado ao telefone
          if (process.env.BLOB_READ_WRITE_TOKEN) {
            try {
              const telDigits = phone.replace(/\D/g, '');
              await put(`ctwa/${telDigits}.json`, JSON.stringify({
                ctwa_clid: ctwaClid,
                phone: telDigits,
                source_url: sourceUrl,
                headline,
                body: msgData.referral.body || '',
                source_type: msgData.referral.source_type || '',
                timestamp: new Date().toISOString(),
                wamid: sourceId,
              }), { access: 'public', contentType: 'application/json' });
              console.log(`[CRM-WEBHOOK] ✅ ctwa_clid salvo no Blob: ctwa/${telDigits}.json`);
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
  const changedAttributes = body.changed_attributes || [];
  const hasLabelChange = changedAttributes.some(attr => attr.labels !== undefined);
  if (event === 'conversation_updated' && !hasLabelChange) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no_label_change' });
  }

  // BUG FIX #2: Extrair labels ANTERIORES para determinar corretamente customerSeg
  // Necessário para saber se compra_realizada é nova (new_customer) ou já existia (existing_customer)
  const previousLabels = changedAttributes
    .filter(attr => attr.labels !== undefined)
    .flatMap(attr => attr.labels?.previous_value || []);

  // Extrai dados — Chatwoot pode enviar em body.conversation, body.data ou flat (body é a conversa)
  const conversation = body.conversation || body.data || body;
  const contact = conversation.meta?.sender || conversation.contact || body.sender || {};
  const labels = conversation.labels || body.labels || [];
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

  // Monta user_data pra CAPI
  const now = Math.floor(Date.now() / 1000);
  const userData = { country: [sha256('br')], st: [sha256('pe')], ct: [sha256('recife')], zp: [sha256('50000')], ge: [sha256('f')] };

  if (telefone) userData.ph = [sha256(normalizePhone(telefone))];
  if (email) userData.em = [sha256(email.toLowerCase())];
  if (nome) {
    const parts = nome.trim().toLowerCase().split(/\s+/);
    userData.fn = [sha256(parts[0])];
    if (parts.length > 1) userData.ln = [sha256(parts[parts.length - 1])];
  }

  // UTMs do contato (se vieram da LP)
  let fbp = customAttrs.fbp || undefined;
  // Bug fix: customAttrs.fbclid pode ser o fbclid RAW (sem o prefixo fb.1.ts.)
  // Nesse caso precisa ser convertido pro formato oficial fbc antes de enviar ao CAPI
  const rawFbclid = customAttrs.fbclid;
  let fbc = customAttrs.fbc ||
    (rawFbclid
      ? (rawFbclid.startsWith('fb.') ? rawFbclid : `fb.1.${Date.now()}.${rawFbclid}`)
      : undefined);
  let ctwaClid = customAttrs.ctwa_clid || undefined;

  // Recuperar fbp/fbc/ctwa_clid/originalLeadData do Blob — CONSOLIDADO em 1 leitura por bucket
  // BUG FIX #3: antes eram 2 leituras de leads/ separadas (fbp/fbc + originalLeadData)
  let originalLeadData = null;
  if (telefone && process.env.BLOB_READ_WRITE_TOKEN) {
    const telDigits = telefone.replace(/\D/g, '');

    // 1. Recuperar ctwa_clid do Blob (salvo pelo whatsapp.js quando cliente veio de anúncio CTWA)
    if (!ctwaClid) {
      try {
        const ctwaBlobs = await list({ prefix: 'ctwa/', limit: 50 });
        for (const blob of ctwaBlobs.blobs) {
          if (blob.pathname.includes(telDigits.slice(-8))) {
            const blobResp = await fetch(blob.url);
            const data = await blobResp.json();
            if (data.ctwa_clid) {
              ctwaClid = data.ctwa_clid;
              console.log(`[CRM-WEBHOOK] Recovered ctwa_clid from Blob: ${ctwaClid.substring(0, 20)}...`);
              break;
            }
          }
        }
      } catch (e) {
        console.warn('[CRM-WEBHOOK] CTWA Blob recovery failed:', e.message);
      }
    }

    // 2. Leitura ÚNICA de leads/ para fbp/fbc E originalLeadData
    if (!fbp || !fbc || !originalLeadData) {
      try {
        const leadBlobs = await list({ prefix: 'leads/', limit: 100 });
        for (const blob of leadBlobs.blobs) {
          if (blob.size > 200) {
            const blobResp = await fetch(blob.url);
            const data = await blobResp.json();
            const blobTel = (data.telefone || '').replace(/\D/g, '');
            if (blobTel && telDigits.endsWith(blobTel.slice(-8))) {
              if (!fbp && data.fbp) fbp = data.fbp;
              if (!fbc && data.fbc) fbc = data.fbc;
              if (!originalLeadData && data.event_id) {
                originalLeadData = {
                  event_name: 'Lead',
                  event_time: Math.floor(new Date(data.timestamp).getTime() / 1000),
                  event_id: data.event_id,
                };
                console.log(`[CRM-WEBHOOK] Found original Lead: event_id=${data.event_id}`);
              }
              if (fbp && fbc && originalLeadData) break;
            }
          }
        }
      } catch (e) {
        console.warn('[CRM-WEBHOOK] Blob leads recovery failed:', e.message);
      }
    }

    if (fbp || fbc || ctwaClid) console.log(`[CRM-WEBHOOK] Recovered from Blob: fbp=${!!fbp} fbc=${!!fbc} ctwa=${!!ctwaClid} origLead=${!!originalLeadData}`);
  }

  // Se tem ctwa_clid mas não fbc, derivar fbc do ctwa_clid (formato oficial Meta)
  if (ctwaClid && !fbc) {
    fbc = `fb.1.${Date.now()}.${ctwaClid}`; // Bug fix: Date.now() em ms (não segundos)
    console.log(`[CRM-WEBHOOK] fbc derivado do ctwa_clid: ${fbc.slice(0, 30)}...`);
  }

  // external_id: prefere nome, fallback pra telefone (garante matching mesmo sem nome)
  if (nome) {
    userData.external_id = [sha256(nome.trim().toLowerCase())];
  } else if (telefone) {
    userData.external_id = [sha256(normalizePhone(telefone))];
  }

  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (ctwaClid) {
    userData.ctwa_clid = ctwaClid; // user_data — posição oficial Meta para CTWA
    userData.whatsapp_business_account_id = '920807647253970';
  }

  // Tenta recuperar URL da LP original salva nos atributos; fallback para domínio canônico
  const eventSourceUrl = customAttrs.landing_url
    || customAttrs.event_source_url
    || customAttrs.lp_url
    || 'https://icelasers.com.br/';

  const baseEvent = {
    event_source_url: eventSourceUrl,
    action_source: 'system_generated',  // CRM events: system_generated (não chat)
    user_data: userData,
  };

  // custom_data base para todos os eventos CRM (conforme guia Meta Conversion Leads)
  const crmBase = {
    event_source: 'crm',         // obrigatório para Conversion Leads
    lead_event_source: 'Chatwoot', // nome do CRM
  };

  const events = [];
  const eventId = `crm_${contact.id || 'unknown'}_${now}`;
  const orderId = `order_${contact.id || 'unknown'}_${now}`;

  // BUG FIX #2: customerSeg baseado em labels ANTERIORES, não nas atuais
  // Se compra_realizada já estava antes desta atualização → existing_customer
  // Se está sendo adicionada agora (não estava em previousLabels) → new_customer
  const wasAlreadyPurchased = previousLabels.includes('compra_realizada') || previousLabels.includes('💰 Compra Realizada');
  const customerSeg = wasAlreadyPurchased ? 'existing_customer_to_business' : 'new_customer_to_business';

  // helper: verifica se algum label está presente (case-insensitive, suporta variações)
  const hasLabel = (...variants) => labels.some(l => variants.includes(l) || variants.includes(l.toLowerCase()));

  // ❌ DESQUALIFICADO
  if (hasLabel('desqualificado', '❌ Desqualificado', '❌_desqualificado', 'disqualified', 'unqualified')) {
    events.push({
      ...baseEvent,
      event_name: 'Lead',
      event_time: now,
      event_id: `${eventId}_disqualified`,
      custom_data: {
        ...crmBase,
        content_name: 'Lead Desqualificado - CRM',
        lead_type: 'disqualified',
        status: 'disqualified',
        quality: 'unqualified',
        disqualification_reason: 'fora_do_publico_alvo',
        customer_segmentation: 'new_customer_to_business',
      },
    });
  }

  // 🧊 LEAD FRIO
  if (hasLabel('lead_frio', '🧊 Lead Frio', '🧊_lead_frio', 'cold_lead', 'lead frio', 'frio')) {
    events.push({
      ...baseEvent,
      event_name: 'Lead',
      event_time: now,
      event_id: `${eventId}_cold_lead`,
      custom_data: {
        ...crmBase,
        content_name: 'Lead Frio - CRM',
        lead_type: 'cold_lead',
        status: 'unqualified',
        customer_segmentation: customerSeg,
      },
    });
  }

  // 🔥 LEAD QUENTE
  if (hasLabel('lead_quente', '🔥 Lead Quente', '🔥_lead_quente', 'hot_lead', 'lead quente', 'quente')) {
    events.push(
      {
        ...baseEvent,
        event_name: 'Lead',
        event_time: now - 3600,
        event_id: `${eventId}_hot_lead`,
        custom_data: { ...crmBase, content_name: 'Lead Quente - CRM', lead_type: 'hot_lead', customer_segmentation: customerSeg },
      },
      {
        ...baseEvent,
        event_name: 'CompleteRegistration',
        event_time: now,
        event_id: `${eventId}_hot_cr`,
        custom_data: { ...crmBase, content_name: 'Lead Quente - CRM', status: 'converted', currency: 'BRL', value: 150.00, customer_segmentation: customerSeg },
      }
    );
  }

  // 💳 LINK DE PAGAMENTO (atendente enviou link / cliente vai pagar)
  if (hasLabel('link_pagamento', '💳 Link Pagamento', '💳_link_pagamento', 'link pagamento', 'pagamento', 'checkout')) {
    const valor = parseFloat(customAttrs.purchase_value) || 497;
    events.push({
      ...baseEvent,
      event_name: 'InitiateCheckout',
      event_time: now,
      event_id: `${eventId}_ic`,
      custom_data: { ...crmBase, currency: 'BRL', value: valor, content_name: 'Link Pagamento - CRM', customer_segmentation: customerSeg },
    });
  }

  // 💰 COMPRA REALIZADA
  if (hasLabel('compra_realizada', '💰 Compra Realizada', '💰_compra_realizada', 'purchase', 'compra realizada', 'comprou', 'vendido', 'sold')) {
    const valor = parseFloat(customAttrs.purchase_value) || 497;
    events.push(
      {
        ...baseEvent,
        event_name: 'InitiateCheckout',
        event_time: now - 1800,
        event_id: `${eventId}_purchase_ic`,
        custom_data: { ...crmBase, currency: 'BRL', value: valor, content_name: 'Compra CRM', customer_segmentation: customerSeg },
      },
      {
        ...baseEvent,
        event_name: 'Purchase',
        event_time: now,
        event_id: `${eventId}_purchase`,
        ...(originalLeadData && { original_event_data: originalLeadData }),
        custom_data: {
          ...crmBase,
          currency: 'BRL',
          value: valor,
          predicted_ltv: 980,
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

  try {
    const result = await sendCAPI(validEvents, token);
    console.log(`[CRM-WEBHOOK] ${event} | ${nome} | labels: ${labels.join(',')} | CAPI: ${result.events_received} eventos | ctwa:${!!ctwaClid} | seg:${customerSeg}`);
    return res.status(200).json({
      ok: true,
      contact: nome,
      labels,
      events_sent: validEvents.length,
      events_received: result.events_received,
      ctwa_clid: !!ctwaClid,
      customer_segmentation: customerSeg,
    });
  } catch (err) {
    console.error('[CRM-WEBHOOK]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
