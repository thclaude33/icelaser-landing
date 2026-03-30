/**
 * /.well-known/vercel/flags (via rewrite)
 * Endpoint obrigatório para o Vercel Flags Dashboard mostrar as flags.
 */

export default async function handler(req, res) {
  const { verifyAccess } = await import('@vercel/flags');

  const access = await verifyAccess(req.headers['authorization']);
  if (!access) {
    res.status(401).json(null);
    return;
  }

  res.status(200).json({
    definitions: {
      'cta-variant': {
        description: 'Variante do botão CTA principal da landing page IceLaser',
        options: [
          { value: 'avaliar', label: 'Avaliar (padrão)' },
          { value: 'axila_gratis', label: 'Axila Grátis' },
          { value: 'whatsapp', label: 'WhatsApp direto' },
        ],
      },
    },
  });
}
