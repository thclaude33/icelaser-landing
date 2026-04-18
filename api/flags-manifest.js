/**
 * /.well-known/vercel/flags (via rewrite em vercel.json)
 *
 * Flags Discovery Endpoint — Vercel Toolbar/Flags Explorer consome este
 * endpoint pra listar as flags do projeto.
 * Docs: https://vercel.com/docs/flags/flags-explorer/reference
 *
 * Schema oficial ApiData:
 *   { definitions: {}, hints?: [], overrideEncryptionMode?: 'plaintext'|'encrypted' }
 *
 * Requisitos (ausentes antes):
 *  1. FLAGS_SECRET env var configurado (senão verifyAccess sempre rejeita).
 *  2. Cada definition precisa `origin` (URL management) pra deep-link no toolbar.
 *  3. Header x-flags-sdk-version informa versão SDK ao toolbar.
 *  4. overrideEncryptionMode='encrypted' evita que user manipule cookie override.
 *  5. Se FLAGS_SECRET ausente, retorna 503 explícito em vez de 401 silencioso.
 */

export default async function handler(req, res) {
  if (!process.env.FLAGS_SECRET) {
    console.error('[FLAGS] FLAGS_SECRET não configurado — Flags Explorer desabilitado');
    return res.status(503).json({ error: 'FLAGS_SECRET not configured' });
  }

  // Package `flags` (v4+) é o oficial atual Vercel; @vercel/flags (v3) é deprecated.
  // Preferimos `flags` pra ter `version` exportada (necessária no x-flags-sdk-version header).
  let verifyAccess, version;
  try {
    const mod = await import('flags');
    verifyAccess = mod.verifyAccess;
    version = mod.version;
  } catch {
    // Fallback: @vercel/flags v3 ainda funciona mas sem version.
    const mod = await import('@vercel/flags');
    verifyAccess = mod.verifyAccess;
  }

  const access = await verifyAccess(req.headers['authorization']);
  if (!access) return res.status(401).json(null);

  // Header informando versão do SDK ao Flags Explorer (Meta docs).
  if (version) res.setHeader('x-flags-sdk-version', String(version));

  res.status(200).json({
    definitions: {
      'cta-variant': {
        description: 'Variante do botão CTA principal da landing page IceLaser',
        // origin: URL pra onde o toolbar leva ao clicar em "manage flag".
        // Aponta pro próprio Vercel dashboard da env var no Edge Config.
        origin: 'https://vercel.com/thclaude33/icelaser-landing/edge-config',
        options: [
          { value: 'avaliar', label: 'Avaliar (padrão)' },
          { value: 'axila_gratis', label: 'Axila Grátis' },
          { value: 'whatsapp', label: 'WhatsApp direto' },
        ],
      },
    },
    // encrypted previne manipulação do cookie vercel-flag-overrides pelo user.
    overrideEncryptionMode: 'encrypted',
  });
}
