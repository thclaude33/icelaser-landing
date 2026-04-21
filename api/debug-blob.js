/**
 * /api/debug-blob — diagnóstico Vercel Blob
 *
 * Modos:
 *  GET  /api/debug-blob           → 5 paths small (50 bytes)
 *  GET  /api/debug-blob?size=3000 → 1 path webhooks/wa/ com payload 3KB (simula webhook real)
 *  GET  /api/debug-blob?mode=replica → replica EXATA do backupBlob (mesmo pathPrefix + options)
 */
import { put } from '@vercel/blob';

export default async function handler(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const size = parseInt(url.searchParams.get('size') || '0', 10);
  const mode = url.searchParams.get('mode') || '';
  const envOk = !!process.env.BLOB_READ_WRITE_TOKEN;
  const tokenPreview = (process.env.BLOB_READ_WRITE_TOKEN || '').slice(0, 25);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  if (mode === 'replica') {
    // Replica EXATA do backupBlob em whatsapp.js:833-857
    const fakePayload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{
        id: '920807647253970',
        changes: [{
          value: {
            messaging_product: 'whatsapp',
            metadata: { phone_number_id: '1140709345781659' },
            contacts: [{ profile: { name: 'DEBUG_REPLICA' }, wa_id: '5581988887777' }],
            messages: [{
              from: '5581988887777',
              id: `wamid.REPLICA_${Date.now()}`,
              timestamp: String(Math.floor(Date.now() / 1000)),
              type: 'text',
              text: { body: 'replica test from debug-blob endpoint' }
            }]
          },
          field: 'messages'
        }]
      }]
    });
    const rawBody = Buffer.from(fakePayload); // simula rawBody (Buffer)

    const body = JSON.parse(rawBody.toString());
    const firstMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const fromPhone = firstMsg?.from || 'status';
    const safePhone = String(fromPhone).replace(/[^0-9a-z]/gi, '').slice(0, 20) || 'unknown';
    const pathPrefix = body.object === 'ad_account' ? 'webhooks/ad_account'
                    : body.object === 'page'       ? 'webhooks/page'
                    : 'webhooks/wa';
    const filename = `${pathPrefix}/${ts}_${safePhone}.json`;

    const log = [];
    log.push(`start: object=${body.object}, hasToken=${envOk}`);
    log.push(`path: ${filename} (${rawBody.length} bytes)`);
    let result = null, error = null, timing = 0;
    const t0 = Date.now();
    try {
      result = await put(filename, rawBody.toString(), {
        access: 'public',
        contentType: 'application/json',
        cacheControlMaxAge: 0,
        addRandomSuffix: true,
      });
      timing = Date.now() - t0;
      log.push(`put OK in ${timing}ms: url=${result?.url?.slice(0, 100)} path=${result?.pathname}`);
    } catch (e) {
      timing = Date.now() - t0;
      error = { name: e.name, message: e.message, code: e.code, stack: e.stack?.slice(0, 300) };
      log.push(`put THREW in ${timing}ms: ${e.message}`);
    }

    return res.status(200).json({
      mode: 'replica',
      env_token_present: envOk,
      path_attempted: filename,
      body_size_bytes: rawBody.length,
      timing_ms: timing,
      result,
      error,
      log,
    });
  }

  if (size > 0) {
    // Test com payload específico
    const payload = 'x'.repeat(size);
    const path = `webhooks/wa/SIZETEST_${size}_${ts}.json`;
    const t0 = Date.now();
    try {
      const r = await put(path, payload, {
        access: 'public',
        contentType: 'application/json',
        cacheControlMaxAge: 0,
        addRandomSuffix: true,
      });
      return res.status(200).json({ ok: true, size, path_attempted: path, timing_ms: Date.now() - t0, url: r?.url, pathname: r?.pathname });
    } catch (e) {
      return res.status(200).json({ ok: false, size, path_attempted: path, timing_ms: Date.now() - t0, error: e.message, name: e.name, code: e.code });
    }
  }

  // Modo padrão: 5 paths small
  const results = {};
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
