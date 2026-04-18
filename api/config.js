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

  // HTTP batch via REST API Edge Config (1 request pra 2 keys).
  // SDK @vercel/edge-config v1.4.3 tem bug upstream em Vercel serverless
  // (Cannot find module @vercel/edge-config-fs) — HTTP direto contorna.
  // getAll(['k1','k2']) endpoint: {base}/items?keys=k1&keys=k2 (1 roundtrip).
  async function fetchBatch(keys) {
    if (!process.env.EDGE_CONFIG) return {};
    try {
      const edgeUrl = new URL(process.env.EDGE_CONFIG);
      const params = new URLSearchParams(edgeUrl.search);
      for (const k of keys) params.append('keys', k);
      const itemsUrl = `${edgeUrl.origin}${edgeUrl.pathname}/items?${params.toString()}`;
      const r = await fetch(itemsUrl, { cache: 'no-store' });
      if (r.ok) return await r.json();
    } catch (e) {
      console.warn('[CONFIG] batch fetch failed:', e.message);
    }
    return {};
  }

  try {
    const items = await fetchBatch(['urgencia_vagas', 'urgencia_data']);
    return res.status(200).json({
      urgencia_vagas: items.urgencia_vagas ?? '3',
      urgencia_data: items.urgencia_data ?? proximoDomingo(),
    });
  } catch {
    return res.status(200).json({
      urgencia_vagas: '3',
      urgencia_data: proximoDomingo(),
    });
  }
}
