/**
 * Test suite: primary-project.js — Cron deduplication guard
 *
 * Fix 23/04/2026: Os 3 Vercel projects (icelaser-landing, landing-page,
 * icelaser-landing-c9in) deployam o mesmo vercel.json → mesmos 7 crons
 * agendados 3x em paralelo. Guard pelo VERCEL_PROJECT_ID garante que só
 * o projeto primary executa trabalho real — outros dois retornam skipped.
 *
 * Docs ref: https://vercel.com/docs/environment-variables/system-environment-variables
 * - VERCEL_PROJECT_ID é auto-injected em runtime (build+runtime)
 * - Requer "Enable access to System Environment Variables" no project Settings
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('isPrimaryProject', () => {
  let originalEnv;
  beforeEach(() => { originalEnv = { ...process.env }; });
  afterEach(() => { process.env = originalEnv; });

  test('retorna true quando VERCEL_PROJECT_ID === PRIMARY_PROJECT_ID', async () => {
    process.env.VERCEL_PROJECT_ID = 'prj_K4SFQS6tZsB7ahf5Yny0RsqIPOwb';
    const mod = await import(`../api/_lib/primary-project.js?v=${Date.now()}_a`);
    assert.equal(mod.isPrimaryProject(), true);
  });

  test('retorna false quando VERCEL_PROJECT_ID é diferente', async () => {
    process.env.VERCEL_PROJECT_ID = 'prj_whDsSC9VoXWm5l2Ppa5lRSG8mvjS'; // landing-page
    const mod = await import(`../api/_lib/primary-project.js?v=${Date.now()}_b`);
    assert.equal(mod.isPrimaryProject(), false);
  });

  test('retorna false pra icelaser-landing-c9in', async () => {
    process.env.VERCEL_PROJECT_ID = 'prj_jEJ5mS5weGLpF3eXtL5ijvtyDrBw';
    const mod = await import(`../api/_lib/primary-project.js?v=${Date.now()}_c`);
    assert.equal(mod.isPrimaryProject(), false);
  });

  test('Fail-safe: retorna true quando VERCEL_PROJECT_ID ausente (dev/local)', async () => {
    delete process.env.VERCEL_PROJECT_ID;
    const mod = await import(`../api/_lib/primary-project.js?v=${Date.now()}_d`);
    // Fail-safe: em local dev/tests onde VERCEL_PROJECT_ID não existe, NÃO bloquear.
    // Caso contrário, "node --test" ou script local nunca executaria crons.
    assert.equal(mod.isPrimaryProject(), true);
  });

  test('Override via CRON_PRIMARY_PROJECT_ID env var (escape hatch)', async () => {
    // Permite override pra failover manual: se primary cair, muda env var
    // no project de failover temporariamente.
    process.env.VERCEL_PROJECT_ID = 'prj_whDsSC9VoXWm5l2Ppa5lRSG8mvjS';
    process.env.CRON_PRIMARY_PROJECT_ID = 'prj_whDsSC9VoXWm5l2Ppa5lRSG8mvjS';
    const mod = await import(`../api/_lib/primary-project.js?v=${Date.now()}_e`);
    assert.equal(mod.isPrimaryProject(), true, 'override deve permitir failover');
  });

  test('Force-skip via CRON_FORCE_SKIP env var (kill switch)', async () => {
    // Kill-switch: se algum cron estiver fazendo estrago, FORCE_SKIP=1 mata tudo
    process.env.VERCEL_PROJECT_ID = 'prj_K4SFQS6tZsB7ahf5Yny0RsqIPOwb';
    process.env.CRON_FORCE_SKIP = '1';
    const mod = await import(`../api/_lib/primary-project.js?v=${Date.now()}_f`);
    assert.equal(mod.isPrimaryProject(), false, 'kill-switch deve sobrescrever');
  });
});

describe('skipIfNotPrimary — helper de response skip', () => {
  let originalEnv;
  beforeEach(() => { originalEnv = { ...process.env }; });
  afterEach(() => { process.env = originalEnv; });

  test('retorna response JSON skipped quando NÃO primary', async () => {
    process.env.VERCEL_PROJECT_ID = 'prj_whDsSC9VoXWm5l2Ppa5lRSG8mvjS';
    const mod = await import(`../api/_lib/primary-project.js?v=${Date.now()}_g`);
    let captured = null;
    const fakeRes = {
      status(code) { captured = { code }; return this; },
      json(body) { captured.body = body; return this; },
    };
    const skipped = mod.skipIfNotPrimary(fakeRes, 'test-cron');
    assert.equal(skipped, true, 'deve retornar true (skipped)');
    assert.equal(captured.code, 200);
    assert.equal(captured.body.ok, true);
    assert.equal(captured.body.skipped, 'not_primary_project');
    assert.equal(captured.body.cron, 'test-cron');
    assert.ok(captured.body.project_id, 'deve incluir project_id pra debug');
  });

  test('retorna false quando É primary (não chama res)', async () => {
    process.env.VERCEL_PROJECT_ID = 'prj_K4SFQS6tZsB7ahf5Yny0RsqIPOwb';
    const mod = await import(`../api/_lib/primary-project.js?v=${Date.now()}_h`);
    let called = false;
    const fakeRes = { status: () => { called = true; return fakeRes; }, json: () => fakeRes };
    const skipped = mod.skipIfNotPrimary(fakeRes, 'test-cron');
    assert.equal(skipped, false);
    assert.equal(called, false, 'res NÃO deve ser chamado quando primary');
  });

  test('cron name é safe-sanitized (evita log injection)', async () => {
    process.env.VERCEL_PROJECT_ID = 'prj_whDsSC9VoXWm5l2Ppa5lRSG8mvjS';
    const mod = await import(`../api/_lib/primary-project.js?v=${Date.now()}_i`);
    let captured = null;
    const fakeRes = {
      status() { return this; },
      json(body) { captured = body; return this; },
    };
    mod.skipIfNotPrimary(fakeRes, 'bad\ncron\rname\t<script>');
    // Deve sanitizar pra evitar log injection / XSS em dashboards
    assert.ok(!/[\n\r\t<>]/.test(captured.cron), 'cron name sem caracteres perigosos');
  });
});
