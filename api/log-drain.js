/**
 * /api/log-drain — Receptor de Log Drains do Vercel
 * Recebe logs de runtime das funções e salva no Vercel Blob
 * Verifica assinatura HMAC-SHA1 (x-vercel-signature) para autenticidade
 */

import crypto from 'crypto';
import { put } from '@vercel/blob';

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  // x-vercel-verify obrigatório para validação do Log Drain
  res.setHeader('x-vercel-verify', process.env.VERCEL_LOG_DRAIN_VERIFY || 'dc04cc178d4addf38b1a252e26f92b0f7b1d0f64');

  if (req.method === 'GET') {
    return res.status(200).send('ok');
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);

  // Verifica assinatura HMAC-SHA1 do Vercel Log Drain (fail-closed)
  const secret = process.env.LOG_DRAIN_SECRET;
  if (!secret) {
    console.error('[LOG-DRAIN] LOG_DRAIN_SECRET não configurado — rejeitando request');
    return res.status(500).json({ error: 'Log drain not configured' });
  }
  const sig      = req.headers['x-vercel-signature'] || '';
  const expected = crypto.createHmac('sha1', secret).update(rawBody).digest('hex');
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Invalid signature' });
  }

  // Se BLOB_READ_WRITE_TOKEN não está configurado, apenas loga e retorna 200
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.log('[LOG-DRAIN] Blob token not set — skipping storage, logs received ok');
    return res.status(200).json({ ok: true, note: 'blob_not_configured' });
  }

  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const fileName = `logs/${ts.split('T')[0]}/${ts}.json`;

    await put(fileName, rawBody || '{}', {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: true,
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[LOG-DRAIN]', err.message);
    return res.status(200).json({ ok: true, note: 'blob_error', error: err.message });
  }
}
