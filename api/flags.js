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

// Cache in-memory do fallback HTTP. Vercel serverless warm-invocations
// compartilham memória → evita hit na Edge Config API cada request.
// TTL 30s pra não serve stale se dashboard mudar. Edge Config real-time
// seria >1s consistency mesmo, então 30s é aceitável.
const EDGE_CONFIG_CACHE = new Map();  // Map<edgeKey, {value, expiresAt}>
const EDGE_CONFIG_CACHE_TTL_MS = 30_000;

async function getEdgeConfigHttp(edgeKey) {
  const cached = EDGE_CONFIG_CACHE.get(edgeKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (!process.env.EDGE_CONFIG) return undefined;
  try {
    const edgeUrl = new URL(process.env.EDGE_CONFIG);
    const itemUrl = `${edgeUrl.origin}${edgeUrl.pathname}/item/${encodeURIComponent(edgeKey)}${edgeUrl.search}`;
    const r = await fetch(itemUrl, { cache: 'no-store' });
    if (r.ok) {
      const value = await r.json();
      EDGE_CONFIG_CACHE.set(edgeKey, { value, expiresAt: Date.now() + EDGE_CONFIG_CACHE_TTL_MS });
      return value;
    }
    if (r.status === 404) {
      EDGE_CONFIG_CACHE.set(edgeKey, { value: undefined, expiresAt: Date.now() + EDGE_CONFIG_CACHE_TTL_MS });
      return undefined;
    }
    throw new Error(`http:${r.status}`);
  } catch (e) {
    throw new Error(`http-exception:${e.message}`);
  }
}

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Cache-Control', 'no-store');

  // Health check: ?health=1 retorna status do Edge Config + Flags setup
  // sem consumir dados reais. Útil pra dashboard monitoring/alerting.
  if (req.query.health === '1') {
    const checks = {
      hasEdgeConfig: !!process.env.EDGE_CONFIG,
      hasFlagsSecret: !!process.env.FLAGS_SECRET,
      edgeConfigReachable: false,
      sdkWorks: false,
    };
    // Test HTTP direto
    if (process.env.EDGE_CONFIG) {
      try {
        const edgeUrl = new URL(process.env.EDGE_CONFIG);
        const digestUrl = `${edgeUrl.origin}${edgeUrl.pathname}/digest${edgeUrl.search}`;
        const r = await fetch(digestUrl, { cache: 'no-store' });
        checks.edgeConfigReachable = r.ok;
      } catch {}
    }
    // Test SDK
    try {
      const { digest } = await import('@vercel/edge-config');
      await digest();
      checks.sdkWorks = true;
    } catch {}
    const allOk = checks.hasEdgeConfig && checks.edgeConfigReachable;
    return res.status(allOk ? 200 : 503).json({ ok: allOk, checks });
  }

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
  //
  // Estratégia dupla: tenta SDK primeiro (@vercel/edge-config), mas em bundles
  // serverless Vercel o SDK às vezes falha por não achar peer dep
  // @vercel/edge-config-fs (confirmado bug prod 18/04/2026).
  // Fallback: HTTP direto na Edge Config API — EDGE_CONFIG env var contém
  // URL+token:  https://edge-config.vercel.com/ecfg_XXX?token=YYY
  // Item endpoint: {EDGE_CONFIG_BASE}/item/{key} (reuse query string pro auth).
  const debug = String(req.query.debug || '') === '1';
  let edgeValue, edgeError;
  const keyMap = { 'cta-variant': 'cta_variant' };
  const edgeKey = keyMap[flagName] || flagName.replace(/-/g, '_');

  try {
    const { get } = await import('@vercel/edge-config');
    edgeValue = await get(edgeKey);
  } catch (sdkErr) {
    // SDK lança em Vercel serverless porque @vercel/edge-config-fs não é
    // encontrado (top-level import em edge-config.ts — bug upstream v1.4.3).
    // Fallback HTTP direto + cache in-memory 30s warm invocations.
    edgeError = `sdk:${sdkErr.message}`;
    try {
      edgeValue = await getEdgeConfigHttp(edgeKey);
    } catch (httpErr) {
      edgeError += ` | ${httpErr.message}`;
    }
  }

  const value = edgeValue ?? fallback;
  await setFlagValuesHeader(flagName, value);
  const body = {
    value,
    source: edgeValue !== undefined ? 'edge-config' : (edgeError ? 'error-fallback' : 'fallback'),
  };
  if (debug) {
    body.debug = {
      headerStatus,
      edgeKey,
      edgeError: edgeError || null,
      hasFlagsSecret: !!process.env.FLAGS_SECRET,
      hasEdgeConfig: !!process.env.EDGE_CONFIG,
    };
  }
  return res.status(200).json(body);
}
