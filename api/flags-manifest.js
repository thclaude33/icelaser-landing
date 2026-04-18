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

  // Package `flags` v4+ (oficial atual Vercel). @vercel/flags v3 deprecated
  // (npm emit deprecation warning). Removido de package.json nesta passada.
  const { verifyAccess, version } = await import('flags');

  const access = await verifyAccess(req.headers['authorization']);
  if (!access) return res.status(401).json(null);

  // Header informando versão do SDK ao Flags Explorer (Vercel docs).
  if (version) res.setHeader('x-flags-sdk-version', String(version));

  res.status(200).json({
    definitions: {
      'cta-variant': {
        description: 'Variante do botão CTA principal da landing page IceLaser',
        // origin: URL onde time gerencia a flag. Aponta pro Vercel dashboard
        // do projeto — toolbar abre o painel do projeto pra editar Edge Config.
        origin: 'https://vercel.com/thclaude33/icelaser-landing',
        options: [
          { value: 'avaliar', label: 'Avaliar (padrão)' },
          { value: 'axila_gratis', label: 'Axila Grátis' },
          { value: 'whatsapp', label: 'WhatsApp direto' },
        ],
      },
    },
    // encrypted previne manipulação do cookie vercel-flag-overrides pelo user.
    // Requer FLAGS_SECRET setado (checado no início do handler).
    overrideEncryptionMode: 'encrypted',
  });
}
