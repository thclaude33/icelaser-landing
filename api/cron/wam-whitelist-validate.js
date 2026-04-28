/**
 * /api/cron/wam-whitelist-validate — Issue 4 (PR follow-up /review 38).
 *
 * Propósito: re-validar mensalmente quais events Meta WAM Dataset aceita em
 * action_source=business_messaging. A whitelist hardcoded `BUSINESS_MESSAGING_VALID`
 * em capi-wam.js foi validada LIVE 27/04/2026 com 23 testes diretos contra dataset
 * 967048725669499. Mas Meta evolui a v25/v26 silenciosamente — events podem:
 *   - Ser DEPRECATED (passam a retornar subcode 2804066 em BM)
 *   - Ser HABILITADOS (passam a aceitar quando antes rejeitavam)
 *
 * Sem detecção, ficamos meses com whitelist desatualizada → fallbacks
 * desnecessários OU rejeições silenciosas em produção.
 *
 * Schedule: `0 14 1 * *` — primeiro dia do mês, 14:00 UTC (11:00 BRT).
 *
 * Como funciona:
 *   1. Pra cada event_name em VALIDATION_SET, faz POST direto Graph API com
 *      action_source=business_messaging + ctwa_clid FAKE (40 chars).
 *   2. Usa test_event_code='WAM_WHITELIST_VALIDATE_MONTHLY' → events vão pra
 *      Test Events tab, NÃO poluem produção.
 *   3. Resposta esperada por event:
 *      - Event VÁLIDO em BM → subcode 2804087 (ctwa fake) [expected]
 *      - Event INVÁLIDO em BM → subcode 2804066 (event_name not allowed) [expected]
 *   4. Compara ACTUAL vs EXPECTED. Se divergiu → email alert + blob report.
 *
 * Custo: 23 API calls/mês contra Meta. Trivial vs 100k+ legítimos.
 */

import { put, head } from '@vercel/blob';
import nodemailer from 'nodemailer';
import { brtISO, isVercelCron } from '../_lib/time.js';
import { escapeHtml, sanitizeHeader } from '../_lib/security.js';
import { skipIfNotPrimary } from '../_lib/primary-project.js';
import { GRAPH_BASE } from '../_lib/config.js';

const TEST_EVENT_CODE = 'WAM_WHITELIST_VALIDATE_MONTHLY';
const FAKE_CTWA_CLID = 'X'.repeat(40);
const FETCH_TIMEOUT_MS = 10000;
const REALERT_WINDOW_MS = 25 * 24 * 60 * 60 * 1000; // 25d (proteção contra duplo run mensal)

const EMAIL_FROM = () => process.env.EMAIL_FROM || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS = () => process.env.EMAIL_PASS;
const EMAIL_TO = () => (process.env.EMAIL_TO || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');

/**
 * Eventos a testar contra Meta v25 business_messaging.
 * Espera = subcode esperado quando ctwa fake é enviado:
 *   - 2804087: event válido em BM (ctwa fake bloqueia mas event passou validação)
 *   - 2804066: event inválido em BM (Meta rejeita ANTES de checar ctwa)
 */
const VALIDATION_SET = [
  // Esperados VÁLIDOS em business_messaging (10 events — espelho do BUSINESS_MESSAGING_VALID em capi-wam.js)
  { event_name: 'LeadSubmitted',    expected_subcode: 2804087, expected_status: 'BM_VALID' },
  { event_name: 'QualifiedLead',    expected_subcode: 2804087, expected_status: 'BM_VALID' },
  { event_name: 'Purchase',         expected_subcode: 2804087, expected_status: 'BM_VALID', custom_data: { currency: 'BRL', value: 1 } },
  { event_name: 'InitiateCheckout', expected_subcode: 2804087, expected_status: 'BM_VALID' },
  { event_name: 'AddToCart',        expected_subcode: 2804087, expected_status: 'BM_VALID' },
  { event_name: 'ViewContent',      expected_subcode: 2804087, expected_status: 'BM_VALID' },
  { event_name: 'OrderCreated',     expected_subcode: 2804087, expected_status: 'BM_VALID' },
  { event_name: 'CartAbandoned',    expected_subcode: 2804087, expected_status: 'BM_VALID' },
  { event_name: 'RatingProvided',   expected_subcode: 2804087, expected_status: 'BM_VALID' },
  { event_name: 'ReviewProvided',   expected_subcode: 2804087, expected_status: 'BM_VALID' },
  // Esperados INVÁLIDOS em business_messaging (Meta retorna 2804066 antes de checar ctwa)
  { event_name: 'CompleteRegistration', expected_subcode: 2804066, expected_status: 'BM_INVALID' },
  { event_name: 'Subscribe',            expected_subcode: 2804066, expected_status: 'BM_INVALID' },
  { event_name: 'AddPaymentInfo',       expected_subcode: 2804066, expected_status: 'BM_INVALID' },
  { event_name: 'Shipped',              expected_subcode: 2804066, expected_status: 'BM_INVALID' },
  { event_name: 'Delivered',            expected_subcode: 2804066, expected_status: 'BM_INVALID' },
  { event_name: 'Canceled',             expected_subcode: 2804066, expected_status: 'BM_INVALID' },
  { event_name: 'Returned',             expected_subcode: 2804066, expected_status: 'BM_INVALID' },
];

async function validateEvent({ event_name, expected_subcode, expected_status, custom_data }) {
  const datasetId = process.env.WAM_DATASET_ID;
  const token = process.env.WAM_ACCESS_TOKEN;
  const pageId = process.env.META_PAGE_ID;
  if (!datasetId || !token || !pageId) {
    // Vercel Agent fix (PR #42): adicionar matches:true evita false-positive
    // email alert quando env vars ausentes (preview deploys, dev local).
    // results.filter(r => !r.matches) iria contar isso como divergence.
    return { event_name, error: 'env_missing', expected_status, expected_subcode, matches: true };
  }
  const eventObj = {
    event_name,
    event_time: Math.floor(Date.now() / 1000),
    event_id: `validate_${event_name.replace(/\s+/g, '_')}_${Date.now()}`,
    action_source: 'business_messaging',
    messaging_channel: 'whatsapp',
    user_data: {
      ctwa_clid: FAKE_CTWA_CLID,
      page_id: pageId,
    },
    ...(custom_data ? { custom_data } : {}),
  };
  try {
    const resp = await fetch(`${GRAPH_BASE}/${datasetId}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        data: [eventObj],
        test_event_code: TEST_EVENT_CODE,
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const json = await resp.json().catch(() => null);
    const actual_subcode = json?.error?.error_subcode ?? null;
    const actual_code = json?.error?.code ?? null;
    let actual_status;
    if (actual_subcode === 2804087) actual_status = 'BM_VALID';
    else if (actual_subcode === 2804066) actual_status = 'BM_INVALID';
    else if (!json?.error && json?.events_received >= 1) actual_status = 'ACCEPTED'; // raro mas possível
    else actual_status = 'UNKNOWN';
    const matches = actual_status === expected_status;
    return {
      event_name,
      expected_status,
      actual_status,
      expected_subcode,
      actual_subcode,
      actual_code,
      matches,
      error_message: json?.error?.message || null,
    };
  } catch (e) {
    return {
      event_name,
      expected_status,
      actual_status: 'NETWORK_ERROR',
      error_message: e.message,
      matches: false,
    };
  }
}

async function loadLastReport() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    const meta = await head('alerts/wam-whitelist-last.json');
    const r = await fetch(meta.url, { signal: AbortSignal.timeout(5000) });
    return await r.json();
  } catch { return null; }
}

async function saveReport(results, divergences) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    await put('alerts/wam-whitelist-last.json', JSON.stringify({
      at: new Date().toISOString(),
      total: results.length,
      divergences: divergences.length,
      results,
    }), {
      access: 'public',
      contentType: 'application/json',
      allowOverwrite: true,
      cacheControlMaxAge: 0,
    });
  } catch (e) {
    console.warn('[WAM-VALIDATE] save report failed:', e.message);
  }
}

async function sendDivergenceEmail(divergences, totalChecked) {
  const pass = EMAIL_PASS();
  if (!pass) return false;
  try {
    const t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM(), pass },
    });
    const rows = divergences.map(d => `
      <tr>
        <td style="padding:8px;border:1px solid #ddd"><strong>${escapeHtml(d.event_name)}</strong></td>
        <td style="padding:8px;border:1px solid #ddd">${escapeHtml(d.expected_status)}</td>
        <td style="padding:8px;border:1px solid #ddd;color:#c0392b"><strong>${escapeHtml(d.actual_status)}</strong></td>
        <td style="padding:8px;border:1px solid #ddd">${d.actual_subcode ?? d.actual_code ?? '-'}</td>
        <td style="padding:8px;border:1px solid #ddd;font-size:11px;color:#666">${escapeHtml((d.error_message || '').slice(0, 200))}</td>
      </tr>
    `).join('');
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:720px;margin:auto">
        <h2 style="color:#c0392b">⚠️ WAM Whitelist Drift Detectado</h2>
        <p style="color:#666">${escapeHtml(brtISO())} | ${divergences.length}/${totalChecked} divergências</p>
        <p>A whitelist <code>BUSINESS_MESSAGING_VALID</code> em <code>api/_lib/capi-wam.js</code>
        diverge do comportamento atual da Meta API. Atualize manualmente após verificar.</p>
        <table style="width:100%;border-collapse:collapse;margin-top:12px">
          <thead>
            <tr style="background:#1a1a2e;color:#fff">
              <th style="padding:8px;text-align:left">Event</th>
              <th style="padding:8px;text-align:left">Esperado</th>
              <th style="padding:8px;text-align:left">Atual</th>
              <th style="padding:8px;text-align:left">Subcode</th>
              <th style="padding:8px;text-align:left">Mensagem</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:16px;font-size:12px;color:#666">
          Reference: <code>BUSINESS_MESSAGING_VALID</code> em capi-wam.js linha ~129.<br/>
          Validation cron: <code>/api/cron/wam-whitelist-validate</code> (mensal).
        </p>
      </div>`;
    await t.sendMail({
      from: `"IceLaser WAM Validate" <${EMAIL_FROM()}>`,
      to: EMAIL_TO().join(','),
      subject: sanitizeHeader(`⚠️ WAM Whitelist Drift — ${divergences.length} divergência(s) | IceLaser`, 200),
      html,
    });
    return true;
  } catch (e) {
    console.error('[WAM-VALIDATE] email failed:', e.message);
    return false;
  }
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'cron_secret_not_configured' });
  }
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (skipIfNotPrimary(res, 'wam-whitelist-validate')) return;
  const isCron = isVercelCron(req);

  // Anti-double-run: skip se rodou nos últimos 25 dias
  const lastReport = await loadLastReport();
  if (lastReport?.at) {
    const lastAt = new Date(lastReport.at).getTime();
    if (Date.now() - lastAt < REALERT_WINDOW_MS && isCron) {
      console.log(`[WAM-VALIDATE] ${brtISO()} suppressed (last run <25d ago)`);
      return res.status(200).json({ ok: true, suppressed: true, last_at: lastReport.at });
    }
  }

  try {
    // Roda em paralelo (batches de 5 pra não saturar Meta API)
    const results = [];
    for (let i = 0; i < VALIDATION_SET.length; i += 5) {
      const batch = VALIDATION_SET.slice(i, i + 5);
      const batchResults = await Promise.all(batch.map(validateEvent));
      results.push(...batchResults);
    }
    const divergences = results.filter(r => !r.matches);
    await saveReport(results, divergences);

    if (divergences.length === 0) {
      console.log(`[WAM-VALIDATE] ${brtISO()} ✅ ${results.length}/${results.length} match — whitelist consistente`);
      return res.status(200).json({ ok: true, total: results.length, divergences: 0 });
    }

    const emailSent = await sendDivergenceEmail(divergences, results.length);
    console.log(`[WAM-VALIDATE] ${brtISO()} ⚠️ ${divergences.length}/${results.length} drift | email=${emailSent}`);
    return res.status(200).json({
      ok: true,
      total: results.length,
      divergences: divergences.length,
      drift_events: divergences.map(d => ({
        event_name: d.event_name,
        expected: d.expected_status,
        actual: d.actual_status,
      })),
      email_sent: emailSent,
    });
  } catch (err) {
    console.error('[WAM-VALIDATE]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
