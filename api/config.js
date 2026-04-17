/**
 * /api/config â lÃª configuraÃ§Ãµes dinÃ¢micas do Vercel Edge Config
 * Resposta: { urgencia_vagas: '3', urgencia_data: 'domingo 05/04' }
 *
 * Para configurar no dashboard:
 *   urgencia_vagas  â ex: "3"
 *   urgencia_data   â ex: "domingo 05/04"
 */

// Calcula o próximo domingo a partir de hoje no fuso de Recife (America/Recife).
// Usa Intl.DateTimeFormat pra evitar bug de DST e edge cases do cálculo manual UTC-3.
function proximoDomingo() {
  const TZ = 'America/Recife';
  // Parts no fuso correto via Intl — evita drift em DST/edge hours
  const partsNow = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(new Date());
  const get = (t) => partsNow.find((p) => p.type === t)?.value;
  const [year, month, day, wdShort] = [get('year'), get('month'), get('day'), get('weekday')];
  const dia = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wdShort];
  const diasAte = dia === 0 ? 7 : 7 - dia;
  // Constrói Date usando UTC noon pra evitar qualquer drift de timezone; soma dias
  const baseUtc = Date.UTC(+year, +month - 1, +day, 12, 0, 0);
  const proximo = new Date(baseUtc + diasAte * 24 * 60 * 60 * 1000);
  const dd = String(proximo.getUTCDate()).padStart(2, '0');
  const mm = String(proximo.getUTCMonth() + 1).padStart(2, '0');
  return `domingo ${dd}/${mm}`;
}

// ALLOWED_ORIGINS importado de _lib/config.js (única fonte de verdade).
import { ALLOWED_ORIGINS } from './_lib/config.js';

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
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
