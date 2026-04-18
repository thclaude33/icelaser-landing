/**
 * /api/flags — lê feature flag do Edge Config com suporte a override do Toolbar.
 * Query: ?flag=cta-variant&fallback=avaliar
 * Resposta: { value: 'avaliar' | 'axila_gratis' | 'whatsapp' }
 *
 * Ordem de precedência:
 *   1. Cookie `vercel-flag-overrides` (Flags Explorer Toolbar override)
 *   2. Edge Config valor atual
 *   3. fallback da query
 *
 * Flag gerenciada em: Vercel Dashboard → Edge Config → cta_variant
 * Docs: https://vercel.com/docs/flags/flags-explorer/reference#override-cookie
 */

import { ALLOWED_ORIGINS } from './_lib/config.js';

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Cache-Control', 'no-store');

  // Sanitização: req.query pode vir como array se URL tem ?flag=a&flag=b.
  // Stringify defensively pra evitar `.replace is not a function` em array.
  const flagName = String(req.query.flag || 'cta-variant');
  const fallback = String(req.query.fallback || 'avaliar');

  // 1. Toolbar override (se FLAGS_SECRET configurado e cookie presente).
  // Usa package `flags` v4 (tem decryptOverrides). @vercel/flags v3 não expõe.
  const overrideCookie = (req.headers['cookie'] || '')
    .match(/(?:^|;\s*)vercel-flag-overrides=([^;]+)/)?.[1];
  if (overrideCookie && process.env.FLAGS_SECRET) {
    try {
      const { decryptOverrides } = await import('flags');
      const overrides = await decryptOverrides(decodeURIComponent(overrideCookie));
      if (overrides && flagName in overrides) {
        console.log(`[FLAGS] ${flagName} overridden by Toolbar: ${overrides[flagName]}`);
        return res.status(200).json({ value: overrides[flagName] });
      }
    } catch (e) {
      console.warn('[FLAGS] decryptOverrides failed:', e.message);
    }
  }

  // 2. Edge Config
  try {
    const { get } = await import('@vercel/edge-config');
    const keyMap = { 'cta-variant': 'cta_variant' };
    const edgeKey = keyMap[flagName] || flagName.replace(/-/g, '_');
    const value = (await get(edgeKey)) ?? fallback;

    // Reporta valor ao Flags Explorer via header (encoded) pra mostrar o atual
    res.setHeader(
      'x-flags-values',
      Buffer.from(JSON.stringify({ [flagName]: value })).toString('base64')
    );

    return res.status(200).json({ value });
  } catch (e) {
    console.warn('[FLAGS] Edge Config fallback:', e.message);
    return res.status(200).json({ value: fallback });
  }
}
