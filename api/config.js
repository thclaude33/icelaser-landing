/**
 * /api/config — lê configurações dinâmicas do Vercel Edge Config
 * Resposta: { urgencia_vagas: '3', urgencia_data: 'hoje 23:59' }
 *
 * Oferta encerra automaticamente às 00:00 BRT (TZ America/Recife — vale pra PE+PB).
 * Texto exibido: "hoje 23:59" — reseta sozinho à meia-noite quando muda o dia,
 * pois o frontend re-fetch /api/config no load + countdown JS recalcula horas até 23:59:59.
 *
 * Override manual via Edge Config dashboard (opcional):
 *   urgencia_vagas  → ex: "3"
 *   urgencia_data   → ex: "hoje 23:59"  (default automático)
 */

// Retorna o texto de prazo da oferta — sempre "hoje 23:59" no fuso BRT.
// Como o countdown JS recalcula a cada page load (e zera à meia-noite), o texto
// fica consistente: hoje significa "o dia em que você está vendo isso".
function prazoHoje() {
  return 'hoje 23:59';
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
      urgencia_data: items.urgencia_data ?? prazoHoje(),
    });
  } catch {
    return res.status(200).json({
      urgencia_vagas: '3',
      urgencia_data: prazoHoje(),
    });
  }
}
