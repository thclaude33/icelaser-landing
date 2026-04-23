/**
 * /api/cron/process-leadgen — Dead Letter Queue reprocessing
 *
 * Processa blobs `leadgen/pending/*` criados pelo whatsapp.js leadgen handler
 * quando Chatwoot/CAPI falha (Railway down, timeout, rede). Garante que lead
 * NUNCA se perde mesmo se infra downstream estiver indisponível.
 *
 * Pipeline:
 *   1. List blobs em leadgen/pending/
 *   2. Skip se blob.pathname também existe em leadgen/processed/
 *   3. Fetch lead data via Graph API (pode já estar arquivado Meta → skip)
 *   4. Reutilizar mesma lógica do webhook handler (createContact + conversation)
 *   5. Mark processed (move blob pra processed/)
 *
 * TTL: blob-gc.js limpa pending/ após 30 dias.
 *
 * Schedule: a cada 5 min via vercel.json — retry window razoável pra Railway recovery.
 */

import { list, put, del } from '@vercel/blob';
import { PIXEL_ID, GRAPH_BASE } from '../_lib/config.js';
import { PARTNER_AGENT } from '../_lib/capi.js';
import { buildUserData } from '../_lib/piiBuilder.js';
import { brtISO, isVercelCron } from '../_lib/time.js';
import { sendWAMEvent } from '../_lib/capi-wam.js';

const META_TOKEN = process.env.META_ACCESS_TOKEN;
const CAPI_TOKEN = process.env.CAPI_DATASET_TOKEN || META_TOKEN;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || '1';
const CHATWOOT_LEADS_INBOX_ID = process.env.CHATWOOT_LEADS_INBOX_ID || '8';

function fetchCw(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'cron_secret_not_configured' });
  const hasValidBearer = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
  if (!hasValidBearer) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'blob_not_configured' });

  const startMs = Date.now();
  const deadlineMs = startMs + 25000; // 25s dentro Vercel 30s timeout
  const report = { processed: 0, skipped: 0, failed: 0, items: [] };

  try {
    // 1. Listar pending
    const pending = await list({ prefix: 'leadgen/pending/', limit: 50 });
    const processed = await list({ prefix: 'leadgen/processed/', limit: 100 });
    const processedIds = new Set(
      (processed.blobs || []).map(b => b.pathname.split('/').pop().replace('.json', ''))
    );

    for (const blob of pending.blobs || []) {
      if (Date.now() > deadlineMs) {
        report.skipped += (pending.blobs.length - report.processed - report.failed);
        break;
      }
      const leadId = blob.pathname.split('/').pop().replace('.json', '');
      if (processedIds.has(leadId)) {
        // Fix 21/04/2026: auto-cleanup de órfãos. Se leadgen/pending/ contém blob
        // que já está em leadgen/processed/, significa que o del() no whatsapp.js
        // falhou (swallow catch). Deletar aqui previne skipped recorrente cada
        // 5min. Safe: o lead JÁ foi processado com sucesso (tem processed entry).
        try {
          await del(blob.url);
          console.log(`[DLQ-CRON] 🧹 órfão deletado: ${blob.pathname} (já processed)`);
        } catch (e) {
          console.warn(`[DLQ-CRON] órfão delete falhou: ${blob.pathname} — ${e.message}`);
        }
        report.skipped++;
        continue;
      }

      try {
        // 2. Fetch payload saved
        const payloadResp = await fetch(blob.url);
        const payload = await payloadResp.json();

        // Fix MEDIUM #4 AI review 20/04: retry_count + failed/ bucket pra evitar
        // retry infinito em leads com erro permanente (malformed, etc).
        // Blob original salvo em whatsapp.js leadgen handler não tem retry_count —
        // primeiro cron run inicia em 1. Após 10 tentativas → mover pra failed/.
        const retryCount = (payload.retry_count || 0) + 1;
        const MAX_RETRIES = 10;
        if (retryCount > MAX_RETRIES) {
          console.error(`[DLQ-CRON] lead ${leadId} excedeu ${MAX_RETRIES} retries — movendo pra failed/`);
          await put(`leadgen/failed/${leadId}.json`, JSON.stringify({
            ...payload,
            moved_at: new Date().toISOString(),
            final_retry_count: retryCount,
            reason: 'max_retries_exceeded',
          }), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
          // Também marca processed pra não reprocessar
          await put(`leadgen/processed/${leadId}.json`, JSON.stringify({
            leadgen_id: leadId,
            note: 'moved_to_failed',
            processed_at: new Date().toISOString(),
          }), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
          report.failed++;
          report.items.push({ leadId, error: 'max_retries_exceeded' });
          continue;
        }

        // 3. Fetch lead data via Graph API
        if (!META_TOKEN) {
          report.failed++;
          report.items.push({ leadId, error: 'no META_TOKEN' });
          continue;
        }
        const leadResp = await fetch(`${GRAPH_BASE}/${leadId}`, {
          headers: { 'Authorization': `Bearer ${META_TOKEN}` },
        });
        if (!leadResp.ok) {
          // Meta can archive test leads, 404 is OK — mark as processed pra não re-tentar
          if (leadResp.status === 400 || leadResp.status === 404) {
            await put(`leadgen/processed/${leadId}.json`, JSON.stringify({
              leadgen_id: leadId,
              note: 'meta_graph_404_skipped',
              processed_at: new Date().toISOString(),
            }), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
            report.skipped++;
            continue;
          }
          throw new Error(`graph_api_${leadResp.status}`);
        }
        const leadData = await leadResp.json();
        const fields = leadData.field_data || [];
        const nome = fields.find(f => f.name === 'full_name')?.values?.[0] || '?';
        const tel = fields.find(f => f.name === 'phone_number')?.values?.[0] || '';
        const email = fields.find(f => f.name === 'email')?.values?.[0] || '';
        const extraFields = {};
        fields.forEach(f => {
          if (!['full_name', 'phone_number', 'email'].includes(f.name)) {
            extraFields[f.name] = f.values?.[0] || '';
          }
        });

        // 4. Chatwoot — criar contato + conversa
        if (!CHATWOOT_API_TOKEN || !CHATWOOT_BASE_URL) {
          report.failed++;
          continue;
        }
        const identifier = `leadgen_${leadId}`;
        const cwHeaders = { 'Content-Type': 'application/json', 'api_access_token': CHATWOOT_API_TOKEN };
        let contactId = null;

        // Dedup
        const searchResp = await fetchCw(
          `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${encodeURIComponent(identifier)}`,
          { headers: cwHeaders }
        );
        const searchJson = await searchResp.json();
        if (searchJson?.payload?.length > 0) {
          const match = searchJson.payload.find(c => c.identifier === identifier);
          if (match) contactId = match.id;
        }

        if (!contactId) {
          const digits = String(tel || '').replace(/\D/g, '');
          const e164 = digits ? (digits.startsWith('55') ? `+${digits}` : `+55${digits}`) : null;
          const contactBody = {
            inbox_id: Number(CHATWOOT_LEADS_INBOX_ID),
            name: String(nome || 'Lead Meta').slice(0, 100),
            identifier,
            ...(e164 ? { phone_number: e164 } : {}),
            ...(email && email.includes('@') ? { email } : {}),
            custom_attributes: {
              leadgen_id: String(leadId),
              leadgen_form_id: String(payload.form_id || ''),
              leadgen_ad_id: String(payload.ad_id || ''),
              lead_source: 'Meta Lead Ad',
              created_at_meta: new Date().toISOString(),
              retry_from_dlq: true,
              ...extraFields,
            },
          };
          const createResp = await fetchCw(
            `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/contacts`,
            { method: 'POST', headers: cwHeaders, body: JSON.stringify(contactBody) }
          );
          const createJson = await createResp.json();
          contactId = createJson?.payload?.contact?.id;
        }

        if (contactId) {
          // Criar conversa
          const msg = [
            '🎯 Novo Lead Meta Ads (retry DLQ)',
            '',
            `Nome: ${nome}`,
            email ? `Email: ${email}` : null,
            tel ? `Telefone: ${tel}` : null,
            ...Object.entries(extraFields).filter(([_, v]) => v).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v}`),
            '',
            `Lead ID: ${leadId}`,
            `Form: ${payload.form_id || '-'}`,
            payload.ad_id ? `Ad ID: ${payload.ad_id}` : null,
            `Origem: Meta Lead Ad (reprocessed via DLQ cron)`,
          ].filter(Boolean).join('\n');
          await fetchCw(
            `${CHATWOOT_BASE_URL}/api/v1/accounts/${CHATWOOT_ACCOUNT_ID}/conversations`,
            {
              method: 'POST',
              headers: cwHeaders,
              body: JSON.stringify({
                source_id: identifier,
                inbox_id: Number(CHATWOOT_LEADS_INBOX_ID),
                contact_id: contactId,
                status: 'open',
                message: { content: msg, message_type: 'incoming' },
              }),
            }
          );

          // 5. CAPI Lead event (mesmo formato do handler original)
          if (CAPI_TOKEN) {
            try {
              const telDigits = String(tel || '').replace(/\D/g, '');
              let firstName = null, lastName = null;
              if (nome && nome !== '?') {
                const parts = String(nome).trim().split(/\s+/);
                firstName = parts[0];
                if (parts.length > 1) lastName = parts[parts.length - 1];
              }
              const userData = await buildUserData({
                email: email && email.includes('@') ? email : undefined,
                phone: telDigits || undefined,
                first_name: firstName || undefined,
                last_name: lastName || undefined,
                city: 'recife', state: 'pe', country: 'br',
                external_id: email || telDigits || undefined,
              });
              if (/^\d{15,17}$/.test(String(leadId))) userData.lead_id = String(leadId);
              if (process.env.META_PAGE_ID) userData.page_id = process.env.META_PAGE_ID;
              const eventTime = Math.floor(Date.now() / 1000);
              const customData = {
                event_source: 'crm',
                lead_event_source: 'Chatwoot',
                leadgen_form_id: String(payload.form_id || ''),
                ...(payload.ad_id ? { ad_id: String(payload.ad_id) } : {}),
                content_name: 'Meta Lead Ad Form Submission',
                content_category: 'depilacao_laser',
                currency: 'BRL',
                value: 0,
                customer_segmentation: 'new_customer_to_business',
              };
              // Fix CRITICAL 23/04/2026 (silent error investigation): antes o fetch
              // era fire-and-forget — qualquer erro Meta (subcode X, events_received=0,
              // messages=[...]) passava silencioso. Causa: user reportou coverage Lead 0%
              // no wizard Pixel LP mesmo com 2 leadgens reais processados hoje. Sem log
              // de response, impossível diagnosticar se Meta estava dropping.
              // Agora: parse response, loga subcode/messages, persist em Blob alerts/
              // pra cron capi-alerts enviar email se acumular erros.
              const leadCapiResp = await fetch(`${GRAPH_BASE}/${PIXEL_ID}/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CAPI_TOKEN}` },
                body: JSON.stringify({
                  data: [{
                    event_name: 'Lead',
                    event_time: eventTime,
                    event_id: `leadgen_${leadId}`,  // idempotent
                    action_source: 'system_generated',
                    user_data: userData,
                    custom_data: customData,
                  }],
                  partner_agent: PARTNER_AGENT,
                }),
              });
              const leadCapiJson = await leadCapiResp.json().catch(() => ({}));
              if (leadCapiJson.error) {
                console.error(`[DLQ-CRON CAPI] ⚠️ Rejected: code=${leadCapiJson.error.code} subcode=${leadCapiJson.error.error_subcode} msg=${leadCapiJson.error.message} lead_id=${leadId}`);
                // Persist em Blob alerts/capi-errors/ pra cron capi-alerts detectar
                try {
                  const alertKey = `alerts/capi-errors/${Date.now()}-${leadCapiJson.error.error_subcode || leadCapiJson.error.code || 'unknown'}-${Math.random().toString(36).slice(2, 8)}.json`;
                  await put(alertKey, JSON.stringify({
                    at: new Date().toISOString(),
                    source: 'pixel_lp_dlq_leadgen',
                    pixel_id: PIXEL_ID,
                    event_name: 'Lead',
                    event_id: `leadgen_${leadId}`,
                    lead_id: String(leadId),
                    action_source: 'system_generated',
                    error_code: leadCapiJson.error.code,
                    error_subcode: leadCapiJson.error.error_subcode,
                    error_type: leadCapiJson.error.type,
                    error_message: leadCapiJson.error.message,
                    fbtrace_id: leadCapiJson.fbtrace_id,
                  }), {
                    access: 'public', addRandomSuffix: false,
                    contentType: 'application/json', cacheControlMaxAge: 0,
                  });
                } catch { /* alert persistence não pode quebrar DLQ */ }
              } else {
                const received = leadCapiJson.events_received ?? 0;
                if (Array.isArray(leadCapiJson.messages) && leadCapiJson.messages.length > 0) {
                  console.warn(`[DLQ-CRON CAPI WARN] received=${received} messages=${JSON.stringify(leadCapiJson.messages)} lead_id=${leadId}`);
                }
                if (received === 0) {
                  console.error(`[DLQ-CRON CAPI SILENT_DROP] received=0 fbtrace=${leadCapiJson.fbtrace_id || 'n/a'} lead_id=${leadId}`);
                }
                console.log(`[DLQ-CRON CAPI] ✅ Lead fired lead_id=${leadId} received=${received}`);
              }
              // Fix 21/04/2026: FAN-OUT WAM dataset. Helper decide skipar se sem ctwa_clid+page_id.
              try {
                const wamResp = await sendWAMEvent({
                  event_name: 'Lead',
                  event_id: `leadgen_${leadId}`,
                  event_time: eventTime,
                  user_data: { ...userData },
                  custom_data: customData,
                });
                if (wamResp?.skipped) {
                  console.log(`[DLQ-CRON WAM] skipped: ${wamResp.skipped} lead_id=${leadId}`);
                } else if (wamResp?.error) {
                  console.warn(`[DLQ-CRON WAM] error: ${wamResp.error.message} lead_id=${leadId}`);
                } else {
                  console.log(`[DLQ-CRON WAM] ✅ received=${wamResp?.events_received} lead_id=${leadId}`);
                }
              } catch (wamErr) { console.error(`[DLQ-CRON WAM] exception: ${wamErr.message} lead_id=${leadId}`); }
            } catch (capiErr) { console.error(`[DLQ-CRON CAPI] exception: ${capiErr.message} lead_id=${leadId}`); }
          }

          // Mark processed + delete pending (fix MEDIUM #5)
          await put(`leadgen/processed/${leadId}.json`, JSON.stringify({
            leadgen_id: leadId,
            contact_id: contactId,
            processed_at: new Date().toISOString(),
            processed_by: 'dlq_cron',
            retry_count: retryCount,
          }), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
          try { await del(blob.url); } catch { /* swallow */ }
          report.processed++;
          report.items.push({ leadId, contactId, status: 'ok', retries: retryCount });
        } else {
          throw new Error('chatwoot_no_contact_id');
        }
      } catch (itemErr) {
        // Fix MEDIUM #4 AI review: persist retry_count no blob pending pra próxima iteração
        try {
          await put(blob.pathname, JSON.stringify({
            ...payload,
            retry_count: retryCount,
            last_error: itemErr.message,
            last_attempt_at: new Date().toISOString(),
          }), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
        } catch { /* swallow */ }
        report.failed++;
        report.items.push({ leadId, error: itemErr.message, retries: retryCount });
      }
    }
  } catch (listErr) {
    console.error('[DLQ-CRON] list failed:', listErr.message);
    return res.status(500).json({ error: 'list_failed', detail: listErr.message });
  }

  const duration = Date.now() - startMs;
  console.log(`[DLQ-CRON] ${brtISO()} duration=${duration}ms processed=${report.processed} failed=${report.failed} skipped=${report.skipped}`);
  return res.status(200).json({ ok: true, duration_ms: duration, report });
}
