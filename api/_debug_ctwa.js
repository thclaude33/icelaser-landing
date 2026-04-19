/**
 * Debug temporário: lista ctwa/ blobs com content pra uma phone específica.
 * PROTEGIDO: requer CRON_SECRET no Authorization Bearer.
 * Use: GET /api/_debug_ctwa?phone=558183345175
 * Remover após debug.
 */
import { list } from '@vercel/blob';

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) return res.status(503).json({ error: 'cron_secret_not_configured' });
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'blob_not_configured' });

  const phone = String(req.query?.phone || '').replace(/\D/g, '');
  if (!phone || phone.length < 8) return res.status(400).json({ error: 'invalid phone' });
  const tail = phone.slice(-8);

  try {
    const result = await list({ prefix: 'ctwa/', limit: 500 });
    const matches = result.blobs.filter(b => b.pathname.includes(tail));
    const contents = [];
    for (const m of matches.slice(0, 3)) {
      try {
        const r = await fetch(m.url);
        const data = await r.json();
        contents.push({
          pathname: m.pathname,
          uploadedAt: m.uploadedAt,
          data,
        });
      } catch (e) {
        contents.push({ pathname: m.pathname, error: e.message });
      }
    }
    return res.status(200).json({
      phone_tail: tail,
      total_in_prefix: result.blobs.length,
      matches_count: matches.length,
      contents,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
