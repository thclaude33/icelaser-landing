// api/cron/bia-skill-refresh.js
// P9.7 — Cron diário (Vercel) que ECOA um heartbeat de refresh da skill Bia Vendedora Premium.
// IMPORTANTE: re-upload da skill (zip + POST /skills/{id}/versions) é trabalho de CD aprovado,
// NÃO automatizado aqui. Este cron só registra timestamp + valida que a skill ainda existe na API,
// pra fail-fast se alguém deletar/movar manualmente.

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const BIA_SKILL_ID = 'skill_01VmKCpBmg717nKmCAWgnUYS';

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return auth === `Bearer ${expected}`;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const apiKey = process.env.ANTHROPIC_API_KEY_ICELASER;
  if (!apiKey) {
    return res.status(500).json({ error: 'missing_env', detail: 'ANTHROPIC_API_KEY_ICELASER not set' });
  }

  // Endpoint /skills/{id}/versions exige o beta `skills-2025-10-02` (validado LIVE 13/05/2026).
  // managed-agents-2026-04-01 isolado retorna 404 Not found.
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'skills-2025-10-02',
  };

  try {
    const verResp = await fetch(`${ANTHROPIC_BASE}/skills/${BIA_SKILL_ID}/versions?limit=5`, { headers });
    const verText = await verResp.text();
    if (!verResp.ok) {
      return res.status(502).json({
        error: 'skill_check_failed',
        status: verResp.status,
        detail: verText.slice(0, 500),
      });
    }
    const data = JSON.parse(verText);
    const versions = Array.isArray(data.data) ? data.data : [];
    const latest = versions[0] || null;

    return res.status(200).json({
      ok: true,
      skill_id: BIA_SKILL_ID,
      versions_count: versions.length,
      latest_version_id: latest?.id ?? null,
      latest_created_at: latest?.created_at ?? null,
      checked_at: new Date().toISOString(),
      note: 'Refresh real (re-zip + POST versions) é manual via CD review pipeline.',
    });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err) });
  }
}
