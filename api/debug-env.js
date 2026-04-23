/**
 * TEMPORARY endpoint — validar se VERCEL_PROJECT_ID + outros system env vars
 * são auto-injetados em runtime. Remover após validação.
 *
 * Acesso: GET /api/debug-env?secret={CRON_SECRET}
 */
export default function handler(req, res) {
  const expected = process.env.CRON_SECRET;
  const provided = req.query?.secret || req.headers?.authorization?.replace(/^Bearer\s+/i, '');
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  return res.status(200).json({
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_URL: process.env.VERCEL_URL,
    VERCEL_REGION: process.env.VERCEL_REGION,
    VERCEL_PROJECT_ID: process.env.VERCEL_PROJECT_ID || '(undefined)',
    VERCEL_DEPLOYMENT_ID: process.env.VERCEL_DEPLOYMENT_ID || '(undefined)',
    VERCEL_TARGET_ENV: process.env.VERCEL_TARGET_ENV,
    VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
    VERCEL_GIT_REPO_SLUG: process.env.VERCEL_GIT_REPO_SLUG,
    VERCEL_GIT_COMMIT_SHA: process.env.VERCEL_GIT_COMMIT_SHA,
  });
}
