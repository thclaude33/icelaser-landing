/**
 * /api/cron/blob-stats — Read-only diagnóstico do Blob store
 *
 * Útil pra investigar "por que o daily-report mostra 0 leads/24h?" sem mexer
 * nos crons existentes. Lista por prefix:
 *  - contagem total
 *  - contagem últimas 24h / 7d / 30d
 *  - últimas 5 entries com uploadedAt
 *  - tamanho total (MB)
 *
 * Auth: CRON_SECRET (Bearer). Read-only — não muta nada.
 *
 * Query params:
 *  - prefix=leads/pending/  (default inspeciona todos os prefixes conhecidos)
 *  - details=1              (inclui sample de blobs)
 */

import { list } from '@vercel/blob';

// Fix MEDIUM AI deep v3 (blob-stats.js:48/blob-gc.js:48): dedup/wa/ + alerts/
// estavam ausentes do KNOWN_PREFIXES. blob-gc.js limpa dedup/wa/, mas dashboard
// via blob-stats não listava. Agora mostra cobertura completa.
const KNOWN_PREFIXES = [
  'leads/pending/',
  'leads/converted/',
  'ctwa/',
  'conversions/',
  'logs/',
  'webhooks/',
  'webhooks/wa/',
  'media/',
  'dedup/wa/',
  'alerts/',
  // FIX V4.1 (Codex C2): leadgen/* esquecido — dashboard não via DLQ leadgen
  'leadgen/pending/',
  'leadgen/processed/',
  'leadgen/failed/',
  // FIX V4 (Codex P0-3 DLQ): wa/* novas filas pós-fix
  'wa/pending/',
  'wa/processed/',
  'wa/dead/',
];

const DAY_MS = 24 * 60 * 60 * 1000;

async function statsForPrefix(prefix, details = false, deadlineMs = 0) {
  const now = Date.now();
  const cutoff24h = now - DAY_MS;
  const cutoff7d = now - 7 * DAY_MS;
  const cutoff30d = now - 30 * DAY_MS;

  const stats = {
    prefix,
    total: 0,
    last_24h: 0,
    last_7d: 0,
    last_30d: 0,
    older_30d: 0,
    total_size_bytes: 0,
    uploadedAt_null: 0,
    oldest: null,
    newest: null,
    samples: [],
    truncated: false,
  };

  let cursor;
  const allBlobs = [];
  do {
    // Fix Investigation #2 (Vercel Observability 20/04/2026): abort cedo se
    // deadline próximo (5 timeouts 504 em 48h antes do fix). Prefixes grandes
    // como webhooks/wa/ podiam paginar por minutos com list() limit 1000.
    if (deadlineMs && Date.now() > deadlineMs) {
      stats.truncated = true;
      break;
    }
    const result = await list({ prefix, cursor, limit: 1000 });
    // Fix LOW AI deep v3 (blob-stats.js:84): cache Date parse em variáveis locais
    // em vez de re-parsing `new Date(stats.oldest)` a cada iteração.
    let oldestMs = stats.oldest ? new Date(stats.oldest).getTime() : null;
    let newestMs = stats.newest ? new Date(stats.newest).getTime() : null;
    for (const blob of result.blobs) {
      stats.total++;
      stats.total_size_bytes += blob.size || 0;

      if (!blob.uploadedAt) {
        stats.uploadedAt_null++;
        // Fix MEDIUM AI deep v3 (blob-stats.js:81): blobs com uploadedAt null
        // devem contar em older_30d (conservative: assumir antigos se sem timestamp).
        stats.older_30d++;
        continue;
      }
      const ms = new Date(blob.uploadedAt).getTime();
      if (!Number.isFinite(ms)) {
        stats.uploadedAt_null++;
        stats.older_30d++;
        continue;
      }

      if (ms >= cutoff24h) stats.last_24h++;
      if (ms >= cutoff7d) stats.last_7d++;
      if (ms >= cutoff30d) stats.last_30d++;
      else stats.older_30d++;

      if (oldestMs === null || ms < oldestMs) {
        oldestMs = ms;
        stats.oldest = blob.uploadedAt;
      }
      if (newestMs === null || ms > newestMs) {
        newestMs = ms;
        stats.newest = blob.uploadedAt;
      }

      if (details) allBlobs.push({ pathname: blob.pathname, uploadedAt: blob.uploadedAt, size: blob.size });
    }
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  if (details) {
    // Top 5 mais recentes.
    stats.samples = allBlobs
      .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
      .slice(0, 5);
  }

  stats.total_size_mb = Math.round(stats.total_size_bytes / 1024 / 1024 * 100) / 100;
  return stats;
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'cron_secret_not_configured' });
  }
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: 'blob_token_not_configured' });
  }

  const singlePrefix = req.query?.prefix;
  const details = req.query?.details === '1';
  const prefixes = singlePrefix ? [String(singlePrefix)] : KNOWN_PREFIXES;

  const startMs = Date.now();
  // Fix Investigation #2: deadline 25s (dentro do timeout 30s Vercel) permite
  // retornar parcial. Paralelizar prefixes via Promise.allSettled. Antes:
  // 8 prefixes sequenciais × pagination → 5 timeouts 504 em 48h.
  const deadlineMs = startMs + 25000;
  const results = {};

  const pairs = await Promise.allSettled(
    prefixes.map(async (prefix) => [prefix, await statsForPrefix(prefix, details, deadlineMs)])
  );
  for (let i = 0; i < pairs.length; i++) {
    const prefix = prefixes[i];
    const outcome = pairs[i];
    if (outcome.status === 'fulfilled') {
      results[prefix] = outcome.value[1];
    } else {
      results[prefix] = { error: outcome.reason?.message || 'unknown' };
    }
  }

  return res.status(200).json({
    ok: true,
    duration_ms: Date.now() - startMs,
    deadline_hit: Date.now() > deadlineMs,
    now_iso: new Date().toISOString(),
    prefixes: results,
  });
}
