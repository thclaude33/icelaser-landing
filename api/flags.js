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

  // Helper: seta `x-flags-values` header pro Flags Explorer (Vercel Toolbar).
  // Estratégia dupla: tenta encryptFlagValues (seguro, exige FLAGS_SECRET 256-bit
  // válido); se falhar por qualquer razão, FALLBACK pra base64 plaintext.
  // Antes: falha no encrypt deixava header VAZIO → toolbar não via valor.
  // `encryptFlagValues` lança se FLAGS_SECRET não é exatamente 32 bytes base64url.
  let headerStatus = 'unset';
  async function setFlagValuesHeader(name, value) {
    const fallbackBase64 = () => {
      try {
        res.setHeader(
          'x-flags-values',
          Buffer.from(JSON.stringify({ [name]: value })).toString('base64'),
        );
        headerStatus = 'base64';
      } catch (e) {
        headerStatus = `fail:${e.message}`;
      }
    };
    if (!process.env.FLAGS_SECRET) {
      fallbackBase64();
      return;
    }
    try {
      const { encryptFlagValues } = await import('flags');
      const encrypted = await encryptFlagValues({ [name]: value });
      res.setHeader('x-flags-values', encrypted);
      headerStatus = 'encrypted';
    } catch (e) {
      console.warn('[FLAGS] encrypt failed, base64 fallback:', e.message);
      fallbackBase64();
    }
  }

  // 1. Toolbar override (se FLAGS_SECRET configurado e cookie presente).
  const overrideCookie = (req.headers['cookie'] || '')
    .match(/(?:^|;\s*)vercel-flag-overrides=([^;]+)/)?.[1];
  if (overrideCookie && process.env.FLAGS_SECRET) {
    try {
      const { decryptOverrides } = await import('flags');
      const overrides = await decryptOverrides(decodeURIComponent(overrideCookie));
      if (overrides && flagName in overrides) {
        const val = overrides[flagName];
        console.log(`[FLAGS] ${flagName} overridden by Toolbar: ${val}`);
        await setFlagValuesHeader(flagName, val);
        return res.status(200).json({ value: val, source: 'toolbar-override' });
      }
    } catch (e) {
      console.warn('[FLAGS] decryptOverrides failed:', e.message);
    }
  }

  // 2. Edge Config. Query `?debug=1` retorna info diagnóstico (não vaza valores).
  const debug = String(req.query.debug || '') === '1';
  try {
    const { get } = await import('@vercel/edge-config');
    const keyMap = { 'cta-variant': 'cta_variant' };
    const edgeKey = keyMap[flagName] || flagName.replace(/-/g, '_');
    const edgeValue = await get(edgeKey);
    const value = edgeValue ?? fallback;
    await setFlagValuesHeader(flagName, value);
    const body = {
      value,
      source: edgeValue !== undefined ? 'edge-config' : 'fallback',
    };
    if (debug) body.debug = { headerStatus, edgeKey, hasFlagsSecret: !!process.env.FLAGS_SECRET, hasEdgeConfig: !!process.env.EDGE_CONFIG };
    return res.status(200).json(body);
  } catch (e) {
    console.warn('[FLAGS] Edge Config fallback:', e.message);
    await setFlagValuesHeader(flagName, fallback);
    const body = { value: fallback, source: 'error-fallback' };
    if (debug) body.debug = { headerStatus, error: e.message, hasFlagsSecret: !!process.env.FLAGS_SECRET, hasEdgeConfig: !!process.env.EDGE_CONFIG };
    return res.status(200).json(body);
  }
}
