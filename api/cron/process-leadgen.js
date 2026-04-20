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
        report.skipped++;
        continue;
      }

      try {
        // 2. Fetch payload saved
        const payloadResp = await fetch(blob.url);
        const payload = await payloadResp.json();

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
              await fetch(`${GRAPH_BASE}/${PIXEL_ID}/events`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CAPI_TOKEN}` },
                body: JSON.stringify({
                  data: [{
                    event_name: 'Lead',
                    event_time: Math.floor(Date.now() / 1000),
                    event_id: `leadgen_${leadId}`,  // idempotent
                    action_source: 'system_generated',
                    user_data: userData,
                    custom_data: {
                      event_source: 'crm',
                      lead_event_source: 'Chatwoot',
                      leadgen_form_id: String(payload.form_id || ''),
                      ...(payload.ad_id ? { ad_id: String(payload.ad_id) } : {}),
                      content_name: 'Meta Lead Ad Form Submission',
                      content_category: 'depilacao_laser',
                      currency: 'BRL',
                      value: 0,
                      customer_segmentation: 'new_customer_to_business',
                    },
                  }],
                  partner_agent: PARTNER_AGENT,
                }),
              });
            } catch { /* CAPI falha não bloqueia DLQ success */ }
          }

          // Mark processed
          await put(`leadgen/processed/${leadId}.json`, JSON.stringify({
            leadgen_id: leadId,
            contact_id: contactId,
            processed_at: new Date().toISOString(),
            processed_by: 'dlq_cron',
          }), { access: 'public', addRandomSuffix: false, contentType: 'application/json' });
          report.processed++;
          report.items.push({ leadId, contactId, status: 'ok' });
        } else {
          throw new Error('chatwoot_no_contact_id');
        }
      } catch (itemErr) {
        report.failed++;
        report.items.push({ leadId, error: itemErr.message });
        // Não deletar blob pending — próxima iteração retry
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
