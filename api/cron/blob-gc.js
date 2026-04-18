/**
 * /api/cron/blob-gc — Garbage Collector de Blobs antigos
 *
 * Vercel Blob NÃO tem TTL/lifecycle rules automáticos (doc oficial 18/04/2026:
 * "there is no way to assign a TTL to a Vercel Blob object"). Implementamos
 * cleanup manual via cron diário.
 *
 * Estratégia:
 *   - list({ prefix, cursor, limit: 1000 }) paginado por prefix.
 *   - Filtra por uploadedAt < Date.now() - retention_ms.
 *   - del([urls]) em batch (64 por call pra respeitar rate limit 4500/min Pro).
 *
 * Paths CUIDADO:
 *   - leads/pending/, leads/converted/  — NÃO limpar (lidos pelo CRM conversion handler).
 *   - ctwa/{phone}.json                 — NÃO limpar (lidos pelo crm-webhook ao enriquecer Purchase).
 *   - conversions/                      — NÃO limpar (histórico financeiro).
 *
 * Paths SAFE pra retention:
 *   - logs/                 → 30 dias (log drains, auditoria operacional)
 *   - webhooks/wa/          → 30 dias (backup emergencial Chatwoot crash)
 *   - webhooks/{type}/      → 60 dias (vercel webhook events, auditoria deploys)
 *   - media/{phone}/        →  7 dias (mídia WA pro Chatwoot — consumido rápido)
 *
 * Pricing impact:
 *   - del() é FREE (doc oficial: "del() operations are free... counted toward
 *     rate limits but not billing").
 *   - list() é Advanced Op ($5/1M) — ~10-50 calls/dia tolerável.
 *   - Economia de storage: $0.023/GB-month * GB liberados.
 *
 * Rate limits Pro: 4500 advanced-ops/min. Batch 64 del/loop + sleep 200ms
 * entre batches garante folga (~19k/min, abaixo do teto).
 */

import { list, del } from '@vercel/blob';

// Retention policy (dias por prefix).
// CHAVES PERIGOSAS (leads/, ctwa/, conversions/) INTENCIONALMENTE AUSENTES.
const RETENTION_DAYS = {
  'logs/':         30,   // log-drains
  'webhooks/wa/':  30,   // backup WhatsApp (só fallback se Chatwoot crashar)
  'webhooks/':     60,   // vercel webhook events (deploys, firewall, alerts)
  'media/':         7,   // media WA baixada da Meta pro Chatwoot
};

// Ordem de processamento: mais específico primeiro (webhooks/wa/ antes de webhooks/).
// list({ prefix: 'webhooks/' }) matches TUDO incluindo webhooks/wa/ — pela ordem,
// webhooks/wa/ é limpo com retenção curta (30d) PRIMEIRO; depois webhooks/ pega
// o resto (60d) sem pegar os da wa/ já limpos.
const ORDERED_PREFIXES = [
  'logs/',
  'webhooks/wa/',
  'webhooks/',
  'media/',
];

const BATCH_SIZE = 64;
const BATCH_SLEEP_MS = 200;
const LIST_PAGE_LIMIT = 1000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Coleta URLs de blobs mais velhos que `retentionDays` num prefix específico.
 * Retorna array de URLs. Usa paginação via cursor.
 *
 * Evita pegar subprefixos MAIS específicos da mesma família (ex: webhooks/wa/
 * ao listar webhooks/) — a comparação startsWith filtra os filhos já tratados.
 */
async function collectExpired(prefix, retentionDays, skipPrefixes = []) {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const expired = [];
  let cursor;
  let listed = 0;

  do {
    const result = await list({ prefix, cursor, limit: LIST_PAGE_LIMIT });
    listed += result.blobs.length;

    for (const blob of result.blobs) {
      // Skip subprefixes já tratados em iteração anterior.
      if (skipPrefixes.some(sp => blob.pathname.startsWith(sp))) continue;

      const uploadedMs = blob.uploadedAt ? new Date(blob.uploadedAt).getTime() : 0;
      if (uploadedMs && uploadedMs < cutoffMs) {
        expired.push(blob.url);
      }
    }

    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  return { expired, listed };
}

/**
 * Deleta em batches respeitando rate limit.
 * del() é free, mas cada URL conta como 1 Advanced Op (rate limit).
 */
async function deleteBatched(urls) {
  let deleted = 0;
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    const batch = urls.slice(i, i + BATCH_SIZE);
    try {
      await del(batch);
      deleted += batch.length;
    } catch (e) {
      console.error(`[BLOB-GC] del batch ${i}-${i + batch.length} failed:`, e.message);
    }
    if (i + BATCH_SIZE < urls.length) await sleep(BATCH_SLEEP_MS);
  }
  return deleted;
}

export default async function handler(req, res) {
  // Auth: Vercel Cron envia Bearer ${CRON_SECRET}.
  if (!process.env.CRON_SECRET) {
    console.error('[BLOB-GC] CRON_SECRET ausente — endpoint bloqueado');
    return res.status(503).json({ error: 'cron_secret_not_configured' });
  }
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: 'blob_token_not_configured' });
  }

  // Dry-run mode: ?dry=1 lista o que seria deletado sem executar.
  const dryRun = req.query?.dry === '1';
  const startMs = Date.now();
  const report = {};

  const processedPrefixes = [];
  for (const prefix of ORDERED_PREFIXES) {
    try {
      const retention = RETENTION_DAYS[prefix];
      // Child prefixes já processados DEVEM ser pulados ao listar pais.
      // Ex: ao processar 'webhooks/', skip tudo que começa com 'webhooks/wa/' (já tratado).
      const childSkips = processedPrefixes.filter(p => p.startsWith(prefix) && p !== prefix);
      const { expired, listed } = await collectExpired(prefix, retention, childSkips);

      let deleted = 0;
      if (!dryRun && expired.length > 0) {
        deleted = await deleteBatched(expired);
      }

      report[prefix] = {
        retention_days: retention,
        listed,
        expired: expired.length,
        deleted,
        child_skips: childSkips,
      };
      processedPrefixes.push(prefix);
    } catch (e) {
      console.error(`[BLOB-GC] prefix "${prefix}" failed:`, e.message);
      report[prefix] = { error: e.message };
    }
  }

  const duration = Date.now() - startMs;
  const totalDeleted = Object.values(report)
    .reduce((acc, r) => acc + (r.deleted || 0), 0);
  const totalExpired = Object.values(report)
    .reduce((acc, r) => acc + (r.expired || 0), 0);

  console.log(`[BLOB-GC] ${dryRun ? 'DRY-RUN' : 'EXECUTED'} duration=${duration}ms expired=${totalExpired} deleted=${totalDeleted}`);

  return res.status(200).json({
    ok: true,
    dry_run: dryRun,
    duration_ms: duration,
    total_expired: totalExpired,
    total_deleted: totalDeleted,
    report,
    // Paths INTENCIONALMENTE fora do GC (documentação operacional).
    protected_prefixes: ['leads/', 'ctwa/', 'conversions/'],
  });
}
