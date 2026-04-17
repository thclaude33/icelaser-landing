/**
 * /api/flags — lê feature flag do Edge Config
 * Query: ?flag=cta-variant&fallback=avaliar
 * Resposta: { value: 'avaliar' | 'axila_gratis' | 'whatsapp' }
 *
 * Flag gerenciada em: Vercel Dashboard → Flags → cta-variant
 */

import { ALLOWED_ORIGINS } from './_lib/config.js';

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Cache-Control', 'no-store');

  const flagName = req.query.flag || 'cta-variant';
  const fallback = req.query.fallback || 'avaliar';

  try {
    const { get } = await import('@vercel/edge-config');
    const keyMap = { 'cta-variant': 'cta_variant' };
    const edgeKey = keyMap[flagName] || flagName.replace(/-/g, '_');
    const value = (await get(edgeKey)) ?? fallback;

    // Reporta ao Dashboard de Flags via header
    res.setHeader(
      'x-flags-values',
      Buffer.from(JSON.stringify({ [flagName]: value })).toString('base64')
    );

    return res.status(200).json({ value });
  } catch {
    return res.status(200).json({ value: fallback });
  }
}
