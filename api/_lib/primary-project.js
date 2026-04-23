/**
 * Primary project guard — cron deduplication helper.
 *
 * PROBLEMA (descoberto 23/04/2026): Os 3 Vercel projects deployam o mesmo
 * `vercel.json` → mesmos 7 crons agendados 3x em paralelo:
 *   - process-leadgen: 864 runs/dia (vs 288 esperado)
 *   - daily-report:    6 emails/dia (vs 2)        ← SMTP quota + spam flag
 *   - blob-gc:         3 runs/dia simultâneos     ← race condition em del()
 *   - emq-monitor/capi-alerts/etc: 3x Meta API calls (desperdício)
 *
 * SOLUÇÃO: Guard pelo VERCEL_PROJECT_ID. Apenas o project "primary"
 * (icelaser-landing, dono do domínio icelasers.com.br) executa trabalho
 * real. Outros 2 retornam skipped HTTP 200 (permite Vercel marcar cron
 * como OK sem disparar re-try).
 *
 * Docs: https://vercel.com/docs/environment-variables/system-environment-variables
 * Verificado empíricamente em 23/04/2026 14:30 BRT — 3 projects retornaram
 * VERCEL_PROJECT_ID distintos em runtime.
 *
 * ESCAPE HATCHES (defensivo):
 *   - CRON_PRIMARY_PROJECT_ID  → override do primary (failover manual)
 *   - CRON_FORCE_SKIP=1        → kill switch (skip em TODO project)
 *
 * FAIL-SAFE: em ambiente local/dev onde VERCEL_PROJECT_ID não existe,
 * retorna true (não bloqueia) — pra permitir testes.
 */

// icelaser-landing — dono do domínio icelasers.com.br (production canonical)
const PRIMARY_PROJECT_ID_DEFAULT = 'prj_K4SFQS6tZsB7ahf5Yny0RsqIPOwb';

/**
 * @returns {boolean} true se este projeto deve executar o cron.
 */
export function isPrimaryProject() {
  // Kill switch — para TUDO se algum cron estiver fazendo estrago
  if (process.env.CRON_FORCE_SKIP === '1') return false;

  const currentProjectId = process.env.VERCEL_PROJECT_ID;

  // Fail-safe local/dev: VERCEL_PROJECT_ID só existe em Vercel runtime.
  // Em node --test ou dev local, retornar true pra não bloquear execução.
  if (!currentProjectId) return true;

  // Override pra failover: se primary cair, setar CRON_PRIMARY_PROJECT_ID
  // no project de failover e removendo no primary original.
  const primaryId = process.env.CRON_PRIMARY_PROJECT_ID || PRIMARY_PROJECT_ID_DEFAULT;
  return currentProjectId === primaryId;
}

/**
 * Helper pra chamar em qualquer cron handler. Se NÃO é primary, envia
 * response JSON skipped + retorna true (handler DEVE retornar early).
 *
 * @param {*} res - Vercel response object
 * @param {string} cronName - identificador do cron pra logs
 * @returns {boolean} true se skipou (handler deve retornar), false se deve continuar
 */
export function skipIfNotPrimary(res, cronName) {
  if (isPrimaryProject()) return false;

  // Sanitize cron name pra evitar log injection (CWE-117)
  const safeCron = String(cronName || 'unknown').replace(/[^\w.-]/g, '_').slice(0, 40);
  const projectId = process.env.VERCEL_PROJECT_ID || '(none)';

  console.log(`[CRON-DEDUP] skipped cron=${safeCron} project=${projectId.slice(0, 12)} reason=not_primary`);

  res.status(200).json({
    ok: true,
    skipped: 'not_primary_project',
    cron: safeCron,
    project_id: projectId.slice(0, 20),
  });
  return true;
}

// Exported pra tests / visibility
export const PRIMARY_PROJECT_ID = PRIMARY_PROJECT_ID_DEFAULT;
