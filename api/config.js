/**
 * /api/config — lê configurações dinâmicas do Vercel Edge Config
 * Resposta: { urgencia_vagas: '3', urgencia_data: 'domingo 29/03' }
 *
 * Para configurar no dashboard:
 *   urgencia_vagas  → ex: "3"
 *   urgencia_data   → ex: "domingo 30/03"
 */

const ALLOWED_ORIGINS = [
  'https://icelaser-landing.vercel.app',
  'https://icelaser-landing-c9in.vercel.app',
  'https://landing-page-six-xi-77.vercel.app',
  'https://icelaser.com.br',
  'https://www.icelaser.com.br',
];

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Cache-Control', 'no-store');

  try {
    const { get } = await import('@vercel/edge-config');
    const [vagas, data] = await Promise.all([
      get('urgencia_vagas').catch(() => null),
      get('urgencia_data').catch(() => null),
    ]);
    return res.status(200).json({
      urgencia_vagas: vagas ?? '3',
      urgencia_data: data ?? 'domingo 29/03',
    });
  } catch {
    return res.status(200).json({
      urgencia_vagas: '3',
      urgencia_data: 'domingo 29/03',
    });
  }
}
