/**
 * /api/config â lÃª configuraÃ§Ãµes dinÃ¢micas do Vercel Edge Config
 * Resposta: { urgencia_vagas: '3', urgencia_data: 'domingo 05/04' }
 *
 * Para configurar no dashboard:
 *   urgencia_vagas  â ex: "3"
 *   urgencia_data   â ex: "domingo 05/04"
 */

// Calcula o prÃ³ximo domingo a partir de hoje (fuso de Recife, UTC-3)
function proximoDomingo() {
  const now = new Date(Date.now() - 3 * 60 * 60 * 1000); // UTC-3
  const dia = now.getUTCDay(); // 0=dom, 1=seg, ..., 6=sÃ¡b
  const diasAte = dia === 0 ? 7 : 7 - dia; // se hoje Ã© dom, prÃ³ximo dom = +7
  const proximo = new Date(now.getTime() + diasAte * 24 * 60 * 60 * 1000);
  const dd = String(proximo.getUTCDate()).padStart(2, '0');
  const mm = String(proximo.getUTCMonth() + 1).padStart(2, '0');
  return `domingo ${dd}/${mm}`;
}

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
      urgencia_data: data ?? proximoDomingo(),
    });
  } catch {
    return res.status(200).json({
      urgencia_vagas: '3',
      urgencia_data: proximoDomingo(),
    });
  }
}
