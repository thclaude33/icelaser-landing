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
import { brtISO, isVercelCron } from '../_lib/time.js';

// Retention policy (dias por prefix).
// CHAVES PERIGOSAS (leads/, ctwa/, conversions/) INTENCIONALMENTE AUSENTES.
const RETENTION_DAYS = {
  'logs/':         30,   // log-drains
  // Fix MEDIUM AI review 20/04/2026 (M9): webhooks/wa/ contém PII (telefone,
  // nome, mensagem WA). Retenção 30d era excessiva pro uso (fallback Chatwoot
  // crash) e aumentava superfície LGPD. 7 dias cobre janela realista (se
  // Chatwoot cair e msg não chegar, reprocessing manual é em <1 semana).
  'webhooks/wa/':   7,
  'webhooks/':     60,   // vercel webhook events (deploys, firewall, alerts)
  'media/':         7,   // media WA baixada da Meta pro Chatwoot
  'dedup/wa/':      7,   // dedup keys persistentes (alinha com Meta webhook retry window)
};

// Ordem de processamento: mais específico primeiro (webhooks/wa/ antes de webhooks/).
// list({ prefix: 'webhooks/' }) matches TUDO incluindo webhooks/wa/ — pela ordem,
// webhooks/wa/ é limpo com retenção curta (7d) PRIMEIRO; depois webhooks/ pega
// o resto (60d) sem pegar os da wa/ já limpos (via skipPrefixes).
// Fix MEDIUM AI deep v3 (blob-gc.js:53): webhooks/ depois de webhooks/wa/ só
// vai processar blobs antigos (60d cutoff) que restaram não-tratados. Mantém
// ordem atual — skipPrefixes garante isolação.
const ORDERED_PREFIXES = [
  'logs/',
  'webhooks/wa/',
  'webhooks/',
  'media/',
  'dedup/wa/',
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
async function collectExpired(prefix, retentionDays, skipPrefixes = [], deadlineMs = 0) {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const expired = [];
  let cursor;
  let listed = 0;
  let truncated = false;

  do {
    // Fix Observability 20/04/2026: deadline abort (blob-gc 504 em 06:15 prod).
    // Mesmo pattern aplicado em blob-stats — prefixes grandes (webhooks/wa/) com
    // milhares de blobs podem paginar + collect por minutos. Retorna parcial.
    if (deadlineMs && Date.now() > deadlineMs) {
      truncated = true;
      break;
    }
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

  return { expired, listed, truncated };
}

/**
 * Deleta em batches respeitando rate limit.
 * del() é free, mas cada URL conta como 1 Advanced Op (rate limit).
 */
async function deleteBatched(urls, deadlineMs = 0) {
  let deleted = 0;
  let stopped = false;
  for (let i = 0; i < urls.length; i += BATCH_SIZE) {
    // Fix Observability 20/04/2026: deadline check em deleteBatched também.
    // Grandes volumes de expired (retention cleanup após migration) podem ter
    // milhares de URLs → batches × sleep acumula. Retorna parcial pra não 504.
    if (deadlineMs && Date.now() > deadlineMs) {
      stopped = true;
      break;
    }
    const batch = urls.slice(i, i + BATCH_SIZE);
    try {
      await del(batch);
      deleted += batch.length;
    } catch (e) {
      console.error(`[BLOB-GC] del batch ${i}-${i + batch.length} failed:`, e.message);
    }
    if (i + BATCH_SIZE < urls.length) await sleep(BATCH_SLEEP_MS);
  }
  return { deleted, stopped };
}

export default async function handler(req, res) {
  // Auth: Vercel Cron envia Bearer ${CRON_SECRET} + User-Agent "vercel-cron/1.0".
  // Bypass tolerado pra testing manual com dry-run via Bearer correto.
  if (!process.env.CRON_SECRET) {
    console.error('[BLOB-GC] CRON_SECRET ausente — endpoint bloqueado');
    return res.status(503).json({ error: 'cron_secret_not_configured' });
  }
  const hasValidBearer = req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`;
  const isCron = isVercelCron(req);
  // Permite: Vercel Cron (UA vercel-cron + Bearer) OU manual com Bearer correto
  // (útil pra dry-run em dev/debug). Defense-in-depth não exclui testing legítimo.
  if (!hasValidBearer) {
    console.warn(`[BLOB-GC] unauthorized ua="${(req.headers['user-agent']||'').slice(0,60)}"`);
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({ error: 'blob_token_not_configured' });
  }

  // Dry-run mode: ?dry=1 lista o que seria deletado sem executar.
  const dryRun = req.query?.dry === '1';
  const startMs = Date.now();
  // Fix Observability 20/04/2026: deadline 25s (dentro timeout 30s Vercel).
  // Prefixes acima do cutoff retornam parcial com `truncated:true`. Próxima
  // execução do cron 24h depois continua do zero — limpa o que restou.
  const deadlineMs = startMs + 25000;
  const report = {};

  const processedPrefixes = [];
  for (const prefix of ORDERED_PREFIXES) {
    // Se deadline já estourou, skip prefixes restantes.
    if (Date.now() > deadlineMs) {
      report[prefix] = { skipped: true, reason: 'deadline_exceeded_before_start' };
      continue;
    }
    try {
      const retention = RETENTION_DAYS[prefix];
      const childSkips = processedPrefixes.filter(p => p.startsWith(prefix) && p !== prefix);
      const { expired, listed, truncated: collectTruncated } = await collectExpired(prefix, retention, childSkips, deadlineMs);

      let deleted = 0;
      let deleteStopped = false;
      if (!dryRun && expired.length > 0) {
        const delResult = await deleteBatched(expired, deadlineMs);
        deleted = delResult.deleted;
        deleteStopped = delResult.stopped;
      }

      report[prefix] = {
        retention_days: retention,
        listed,
        expired: expired.length,
        deleted,
        child_skips: childSkips,
        collect_truncated: collectTruncated,
        delete_stopped: deleteStopped,
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

  console.log(`[BLOB-GC] ${dryRun ? 'DRY-RUN' : 'EXECUTED'} ${brtISO()} trigger=${isCron ? 'cron' : 'manual'} duration=${duration}ms expired=${totalExpired} deleted=${totalDeleted}`);

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
