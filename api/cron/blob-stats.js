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

const KNOWN_PREFIXES = [
  'leads/pending/',
  'leads/converted/',
  'ctwa/',
  'conversions/',
  'logs/',
  'webhooks/',
  'webhooks/wa/',
  'media/',
];

const DAY_MS = 24 * 60 * 60 * 1000;

async function statsForPrefix(prefix, details = false) {
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
  };

  let cursor;
  const allBlobs = [];
  do {
    const result = await list({ prefix, cursor, limit: 1000 });
    for (const blob of result.blobs) {
      stats.total++;
      stats.total_size_bytes += blob.size || 0;

      if (!blob.uploadedAt) {
        stats.uploadedAt_null++;
        continue;
      }
      const ms = new Date(blob.uploadedAt).getTime();
      if (!Number.isFinite(ms)) {
        stats.uploadedAt_null++;
        continue;
      }

      if (ms >= cutoff24h) stats.last_24h++;
      if (ms >= cutoff7d) stats.last_7d++;
      if (ms >= cutoff30d) stats.last_30d++;
      else stats.older_30d++;

      if (!stats.oldest || ms < new Date(stats.oldest).getTime()) stats.oldest = blob.uploadedAt;
      if (!stats.newest || ms > new Date(stats.newest).getTime()) stats.newest = blob.uploadedAt;

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
  const results = {};

  for (const prefix of prefixes) {
    try {
      results[prefix] = await statsForPrefix(prefix, details);
    } catch (e) {
      results[prefix] = { error: e.message };
    }
  }

  return res.status(200).json({
    ok: true,
    duration_ms: Date.now() - startMs,
    now_iso: new Date().toISOString(),
    prefixes: results,
  });
}
