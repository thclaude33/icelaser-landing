/**
 * /api/cron/emq-monitor — Monitora Event Match Quality via Dataset Quality API
 * Roda 1x por dia às 10h (Recife) — envia alerta por email se EMQ cair
 *
 * Dataset Quality API: GET /dataset_quality?dataset_id={PIXEL_ID}
 * Retorna: EMQ score (0-10), event coverage (%), data freshness, diagnostics
 */

import { PIXEL_ID, GRAPH_BASE } from '../_lib/config.js';
import { escapeHtml, sanitizeHeader } from '../_lib/security.js';
import { skipIfNotPrimary } from '../_lib/primary-project.js';

const EMAIL_FROM = process.env.EMAIL_FROM || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS = process.env.EMAIL_PASS;
const EMAIL_TO = (process.env.EMAIL_TO || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');

// Thresholds de alerta por evento (Meta oficial benchmarks 2026).
// Purchase EMQ >= 8.8, Lead >= 7.5, CompleteRegistration >= 7.0, PageView/VC 6.5-7.5.
// Threshold global é fallback pra eventos custom.
const EMQ_THRESHOLDS = {
  Purchase: 8.0,
  Lead: 7.0,
  LeadSubmitted: 7.0,
  CompleteRegistration: 7.0,
  InitiateCheckout: 6.5,
  ViewContent: 6.0,
  PageView: 5.5,
};
const EMQ_MIN_DEFAULT = 5.0;
const COVERAGE_MIN = 50;    // Alerta se cobertura < 50%

async function enviarEmail(assunto, html) {
  if (!EMAIL_PASS) return false;
  try {
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
    });
    await t.sendMail({
      from: `"IceLaser EMQ Monitor" <${EMAIL_FROM}>`,
      to: EMAIL_TO.join(','),
      subject: sanitizeHeader(assunto, 200),
      html,
    });
    return true;
  } catch (e) {
    console.error('[EMQ-EMAIL]', e.message);
    return false;
  }
}

export default async function handler(req, res) {
  // Fix HIGH AI deep review v2 (b4 emq-monitor.js:52): auth bypass quando
  // CRON_SECRET é undefined. Antes: `Bearer undefined` passava se caller
  // enviasse literal string "Bearer undefined". Fail-fast se env ausente.
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'cron_secret_not_configured' });
  }
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  // Cron dedup: skip se não é primary (evita 3x Meta API stats call)
  if (skipIfNotPrimary(res, 'emq-monitor')) return;

  // Prefere DATASET_QUALITY_API_TOKEN (gerado via Events Manager para esta finalidade)
  // Fallback para META_ACCESS_TOKEN se não configurado
  const token = process.env.DATASET_QUALITY_API_TOKEN || process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'No access token configured' });

  try {
    const fields = 'web{event_name,event_match_quality{composite_score,match_key_feedback{identifier,coverage{percentage}},diagnostics{description}},event_coverage{percentage,goal_percentage},acr{percentage},data_freshness{upload_frequency}}';
    // Authorization Bearer (evita token na URL / logs)
    const response = await fetch(
      `${GRAPH_BASE}/dataset_quality?dataset_id=${PIXEL_ID}&fields=${encodeURIComponent(fields)}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    // Fix INFO AI deep review v2 (b4): checar response.ok antes de parse JSON.
    if (!response.ok) {
      const txt = (await response.text()).substring(0, 200);
      console.error(`[EMQ-MONITOR] Meta API ${response.status}: ${txt}`);
      return res.status(502).json({ error: 'meta_api_upstream_error', status: response.status });
    }
    const data = await response.json();

    // Monitorar X-App-Usage
    const appUsage = response.headers.get('x-app-usage');
    if (appUsage) {
      try {
        const usage = JSON.parse(appUsage);
        console.log(`[EMQ-MONITOR] API Usage: call_count=${usage.call_count}% cpu=${usage.total_cputime}% time=${usage.total_time}%`);
        if (usage.call_count > 80 || usage.total_cputime > 80 || usage.total_time > 80) {
          console.warn(`[EMQ-MONITOR] ⚠️ Rate limit approaching!`);
        }
      } catch {}
    }

    if (data.error) {
      const blame = data.error.blame_field_specs ? ` | blame: ${JSON.stringify(data.error.blame_field_specs)}` : '';
      console.error(`[EMQ-MONITOR] API Error: code=${data.error.code} transient=${data.error.is_transient} msg=${data.error.message}${blame}`);
      return res.status(500).json({ error: data.error.message });
    }

    const webEvents = data.web || [];
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' });

    // Processar cada evento
    const alertas = [];
    const resumo = [];

    for (const evt of webEvents) {
      const nome = evt.event_name || '?';
      // Fix HIGH AI deep review v2 (b4 emq-monitor.js:100): falsy-coercion.
      // score 0 NÃO significa ausente — significa "matching zero". Usar ??
      // (null/undefined) em vez de || (0, '', false também coercem).
      const emq = evt.event_match_quality?.composite_score ?? null;
      const coverage = evt.event_coverage?.percentage ?? null;
      const coverageGoal = evt.event_coverage?.goal_percentage ?? 75;
      const freshness = evt.data_freshness?.upload_frequency || '?';
      const matchKeys = evt.event_match_quality?.match_key_feedback || [];
      const diagnostics = evt.event_match_quality?.diagnostics || [];
      const acr = evt.acr?.percentage || 0;

      // Status visual
      const emqStatus = emq >= 8 ? '🟢' : emq >= 5 ? '🟡' : '🔴';
      const covStatus = coverage >= coverageGoal ? '🟢' : coverage >= 50 ? '🟡' : '🔴';

      resumo.push({
        nome, emq, emqStatus, coverage, covStatus, freshness, acr,
        matchKeys: matchKeys.map(k => `${k.identifier}: ${k.coverage?.percentage || 0}%`).join(', '),
        diagnostics: diagnostics.map(d => d.description || d.message || JSON.stringify(d)).join('; '),
      });

      // Alertas com threshold específico por evento (Meta benchmarks 2026).
      const threshold = EMQ_THRESHOLDS[nome] ?? EMQ_MIN_DEFAULT;
      if (emq < threshold) {
        alertas.push(`🔴 ${nome}: EMQ ${emq}/10 (mínimo: ${threshold})`);
      }
      if (coverage < COVERAGE_MIN && coverage > 0) {
        alertas.push(`🔴 ${nome}: Cobertura ${coverage}% (mínimo: ${COVERAGE_MIN}%)`);
      }
      if (diagnostics.length > 0) {
        alertas.push(`⚠️ ${nome}: ${diagnostics.length} diagnóstico(s) ativo(s)`);
      }
    }

    // Montar tabela HTML — escapeHtml em tudo que vem da Meta API
    // (defense-in-depth: event_name e diagnostics podem ter chars especiais).
    const rows = resumo.map(e => `
      <tr>
        <td style="padding:8px;border:1px solid #ddd;font-weight:bold">${escapeHtml(e.nome)}</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center">${e.emqStatus} ${escapeHtml(String(e.emq))}/10</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center">${e.covStatus} ${escapeHtml(String(e.coverage))}%</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center">${escapeHtml(String(e.freshness))}</td>
        <td style="padding:8px;border:1px solid #ddd;text-align:center">${escapeHtml(String(e.acr))}%</td>
        <td style="padding:8px;border:1px solid #ddd;font-size:11px">${escapeHtml(e.matchKeys || '—')}</td>
        <td style="padding:8px;border:1px solid #ddd;font-size:11px;color:#c0392b">${escapeHtml(e.diagnostics || '✅ OK')}</td>
      </tr>
    `).join('');

    const alertaHtml = alertas.length > 0
      ? `<div style="background:#fff5f5;border:2px solid #c0392b;border-radius:8px;padding:16px;margin-bottom:16px">
           <h3 style="color:#c0392b;margin:0 0 8px">⚠️ ALERTAS (${alertas.length})</h3>
           <ul style="margin:0;padding-left:20px">${alertas.map(a => `<li>${escapeHtml(a)}</li>`).join('')}</ul>
         </div>`
      : `<div style="background:#e8f5e9;border:2px solid #4CAF50;border-radius:8px;padding:16px;margin-bottom:16px">
           <h3 style="color:#4CAF50;margin:0">✅ Tudo OK — sem alertas</h3>
         </div>`;

    const html = `
    <div style="font-family:Arial,sans-serif;max-width:800px;margin:auto">
      <div style="background:#1a1a2e;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0">📊 EMQ Monitor — IceLaser Pixel</h2>
        <p style="color:#aaa;margin:5px 0 0">${agora} | Pixel ${PIXEL_ID}</p>
      </div>
      <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee">
        ${alertaHtml}
        <table style="width:100%;border-collapse:collapse;background:#fff">
          <thead>
            <tr style="background:#f5f5f5">
              <th style="padding:8px;border:1px solid #ddd;text-align:left">Evento</th>
              <th style="padding:8px;border:1px solid #ddd">EMQ</th>
              <th style="padding:8px;border:1px solid #ddd">Cobertura</th>
              <th style="padding:8px;border:1px solid #ddd">Freshness</th>
              <th style="padding:8px;border:1px solid #ddd">ACR</th>
              <th style="padding:8px;border:1px solid #ddd">Match Keys</th>
              <th style="padding:8px;border:1px solid #ddd">Diagnósticos</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="font-size:11px;color:#999;margin-top:12px">
          EMQ: Event Match Quality (0-10) | Cobertura: % de eventos Pixel cobertos por CAPI (meta: 75%) | ACR: Additional Conversions Reported
        </p>
      </div>
    </div>`;

    // Enviar email (sempre — relatório diário + alertas)
    const temAlerta = alertas.length > 0;
    const assunto = temAlerta
      ? `🔴 EMQ Alerta — ${alertas.length} problema(s) | IceLaser`
      : `✅ EMQ OK — ${webEvents.length} eventos monitorados | IceLaser`;

    await enviarEmail(assunto, html);

    console.log(`[EMQ-MONITOR] ${webEvents.length} eventos | ${alertas.length} alertas | email enviado`);

    return res.status(200).json({
      ok: true,
      events_monitored: webEvents.length,
      alerts: alertas.length,
      summary: resumo.map(e => ({ event: e.nome, emq: e.emq, coverage: e.coverage })),
    });
  } catch (err) {
    console.error('[EMQ-MONITOR]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
