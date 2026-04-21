/**
 * /api/debug-blob — diagnóstico one-shot do Vercel Blob
 *
 * Tenta put() em vários paths diferentes e retorna status por cada um.
 * Usar pra descobrir por que webhooks/wa/ não salva mas webhooks/ad_account/ salva.
 *
 * Remover após debug.
 */
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  const results = {};
  const envOk = !!process.env.BLOB_READ_WRITE_TOKEN;
  const tokenPreview = (process.env.BLOB_READ_WRITE_TOKEN || '').slice(0, 25);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  const tests = [
    { name: 'wa',         path: `webhooks/wa/DEBUG_${ts}.json` },
    { name: 'ad_account', path: `webhooks/ad_account/DEBUG_${ts}.json` },
    { name: 'page',       path: `webhooks/page/DEBUG_${ts}.json` },
    { name: 'raw',        path: `webhooks/DEBUG_${ts}.json` },
    { name: 'debug',      path: `debug/${ts}.json` },
  ];

  for (const t of tests) {
    try {
      const r = await put(t.path, JSON.stringify({ test: t.name, ts }), {
        access: 'public',
        contentType: 'application/json',
        cacheControlMaxAge: 0,
        addRandomSuffix: true,
      });
      results[t.name] = { ok: true, url: r?.url?.slice(0, 80), pathname: r?.pathname };
    } catch (e) {
      results[t.name] = { ok: false, error: e.message, code: e.code, name: e.name };
    }
  }

  return res.status(200).json({
    env_token_present: envOk,
    token_prefix: tokenPreview,
    runtime_timestamp: ts,
    results,
  });
}
