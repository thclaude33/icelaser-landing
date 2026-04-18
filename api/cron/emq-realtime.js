/**
 * /api/cron/emq-realtime — Endpoint read-only EMQ em tempo real via Dataset Quality API.
 *
 * Difere do emq-monitor.js (cron diário que envia email): este endpoint é HTTP-triggered,
 * retorna JSON estruturado pra consumo por dashboards externos (Grafana, Datadog, script
 * próprio). Auth via CRON_SECRET Bearer.
 *
 * Fonte: Meta Dataset Quality API v25.0 (docs 18/04/2026)
 * Docs: https://developers.facebook.com/docs/marketing-api/conversions-api/dataset-quality-api
 *
 * Campos puxados (todos oficiais):
 *   - event_match_quality.composite_score           — 0-10 EMQ score
 *   - event_match_quality.match_key_feedback[]      — coverage % por identifier (em/ph/fn/etc)
 *   - event_match_quality.diagnostics[]             — issues ativos + % eventos afetados
 *   - event_coverage.percentage + goal_percentage   — Pixel coverage vs meta ≥75%
 *   - acr.percentage                                 — Additional Conversions Reported (7d avg)
 *   - data_freshness.upload_frequency               — real_time | hourly | daily | weekly
 *   - dedup_key_feedback[]                           — event_id/fbp/external_id dedup health
 *
 * Thresholds por evento (JARVIS — Meta benchmarks 2026):
 *   Purchase ≥ 8.8  |  Lead/LeadSubmitted/CR ≥ 7.0  |  IC ≥ 6.5  |  VC ≥ 6.0  |  PV ≥ 5.5
 *
 * Uso:
 *   GET /api/cron/emq-realtime
 *   Authorization: Bearer <CRON_SECRET>
 *
 * Response:
 *   {
 *     ok: true,
 *     pixel_id, pulled_at_brt,
 *     events: [{ event_name, emq, status, coverage, freshness, acr, warnings[] }],
 *     summary: { healthy: N, warning: M, critical: P, avg_emq: X.XX }
 *   }
 */

import { PIXEL_ID, GRAPH_BASE } from '../_lib/config.js';
import { brtISO } from '../_lib/time.js';

const EMQ_THRESHOLDS = {
  Purchase: 8.0,            // Meta benchmark 8.8; 8.0 é tolerância JARVIS
  Lead: 7.0,                // CAPI Lead form
  LeadSubmitted: 7.0,       // CAPI LeadSubmitted (business_messaging CTWA)
  LeadDesqualificado: 7.0,  // Custom event — mesmo threshold
  CompleteRegistration: 7.0,
  InitiateCheckout: 6.5,
  ViewContent: 6.0,
  PageView: 5.5,
};
const EMQ_MIN_DEFAULT = 5.0;
const COVERAGE_MIN = 50;    // abaixo = critical

function classify(emq, threshold, coverage) {
  const warnings = [];
  let status = 'healthy';
  if (emq < threshold) { status = 'critical'; warnings.push(`EMQ ${emq} < threshold ${threshold}`); }
  else if (emq < threshold + 1) { status = 'warning'; warnings.push(`EMQ ${emq} próximo do threshold ${threshold}`); }
  if (coverage !== null && coverage < COVERAGE_MIN) {
    status = 'critical';
    warnings.push(`Coverage ${coverage}% < minimum ${COVERAGE_MIN}%`);
  }
  return { status, warnings };
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'cron_secret_not_configured' });
  }
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Tokens com escopo Ads: usa DATASET_QUALITY_API_TOKEN (recomendação Meta) ou
  // fallback pro META_ACCESS_TOKEN System User geral. Sem token = 503.
  const token = process.env.DATASET_QUALITY_API_TOKEN || process.env.META_ACCESS_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'meta_token_not_configured' });
  }

  // Fields completos — composite_score + match_key_feedback + diagnostics +
  // event_coverage + acr + data_freshness. Agrupado em 1 request.
  // NOTA: `dedup_key_feedback` foi DESCONTINUADO pela Meta na API v25 (retorna
  // "nonexisting field" desde 18/04/2026). Substituído pelo painel interno de
  // deduplicação em Events Manager (não exposto via Graph API). Se Meta voltar
  // a expor, re-adicionar aqui.
  const fields = 'web{event_name,event_match_quality{composite_score,match_key_feedback{identifier,coverage{percentage}},diagnostics{name,percentage,affected_event_count}},event_coverage{percentage,goal_percentage},acr{percentage},data_freshness{upload_frequency}}';

  try {
    const url = `${GRAPH_BASE}/dataset_quality?dataset_id=${PIXEL_ID}&fields=${encodeURIComponent(fields)}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await response.json();

    if (data.error) {
      console.error(`[EMQ-REALTIME] Meta API error: ${data.error.message}`);
      return res.status(502).json({ error: 'meta_api_error', details: data.error });
    }

    const webEvents = data.web || [];
    const events = [];
    const summary = { healthy: 0, warning: 0, critical: 0, emq_sum: 0, emq_count: 0 };

    for (const ev of webEvents) {
      const name = ev.event_name || '?';
      const emq = ev.event_match_quality?.composite_score ?? null;
      const threshold = EMQ_THRESHOLDS[name] ?? EMQ_MIN_DEFAULT;
      const coverage = ev.event_coverage?.percentage ?? null;
      const coverageGoal = ev.event_coverage?.goal_percentage ?? 75;
      const freshness = ev.data_freshness?.upload_frequency ?? null;
      const acr = ev.acr?.percentage ?? null;

      const matchKeys = (ev.event_match_quality?.match_key_feedback || [])
        .map(k => ({ identifier: k.identifier, coverage: k.coverage?.percentage }))
        .filter(k => k.coverage !== undefined);
      const diagnostics = (ev.event_match_quality?.diagnostics || [])
        .map(d => ({
          name: d.name,
          pct_affected: d.percentage,
          count_affected: d.affected_event_count,
        }));
      // dedup_key_feedback DESCONTINUADO pela Meta API v25 — não disponível mais
      const dedupFeedback = [];

      const { status, warnings } = classify(emq, threshold, coverage);
      if (emq !== null) {
        summary[status]++;
        summary.emq_sum += emq;
        summary.emq_count++;
      }

      events.push({
        event_name: name,
        emq, threshold, status,
        coverage_pct: coverage,
        coverage_goal_pct: coverageGoal,
        freshness,
        acr_pct: acr,
        match_keys: matchKeys,
        diagnostics,
        dedup_feedback: dedupFeedback,
        warnings,
      });
    }

    const avgEmq = summary.emq_count > 0
      ? Math.round((summary.emq_sum / summary.emq_count) * 100) / 100
      : null;

    // Monitor X-App-Usage (rate limit Meta) — log se > 80%
    const appUsageHeader = response.headers.get('x-app-usage');
    if (appUsageHeader) {
      try {
        const usage = JSON.parse(appUsageHeader);
        if (usage.call_count > 80 || usage.total_time > 80) {
          console.warn(`[EMQ-REALTIME] Meta API rate limit approaching: ${appUsageHeader}`);
        }
      } catch {}
    }

    console.log(`[EMQ-REALTIME] ${brtISO()} events=${events.length} avg_emq=${avgEmq} healthy=${summary.healthy} warn=${summary.warning} crit=${summary.critical}`);

    return res.status(200).json({
      ok: true,
      pixel_id: PIXEL_ID,
      pulled_at_brt: brtISO(),
      pulled_at_iso: new Date().toISOString(),
      summary: {
        total: events.length,
        healthy: summary.healthy,
        warning: summary.warning,
        critical: summary.critical,
        avg_emq: avgEmq,
      },
      events,
      thresholds_used: EMQ_THRESHOLDS,
    });
  } catch (err) {
    console.error('[EMQ-REALTIME]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
