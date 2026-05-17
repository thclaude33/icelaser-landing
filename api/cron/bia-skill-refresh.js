// api/cron/bia-skill-refresh.js
// FASE 4 (15/05/2026) — Drift detector skill production × source local.
//
// PROPÓSITO:
//   Detectar quando version da skill em produção (Anthropic) diverge da version
//   commitada em `landing-page/knowledge-base/skill-source/.last_synced_version`.
//
// CENÁRIO DRIFT:
//   - Vitória/CD faz upload direto via Anthropic console (skip flow local)
//   - source local fica stale → próximo update via flow regenera ZIP com content velho
//   - Sem alerta = silencioso. Cron pega isso.
//
// MECÂNICA:
//   1. GET latest_version Anthropic
//   2. Read `skill-source/.last_synced_version` (committed locally)
//   3. Comparar IDs
//   4. Se diferem → alerta `[BIA-SKILL-DRIFT]` (email + bucket 4h dedup via Blob)
//
// FAIL-OPEN: erros API ou arquivo missing → registra mas não bloqueia.
//
// SCHEDULE: '30 2 * * *' (diário 02:30 UTC) — definido em vercel.json.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';
import { put, list } from '@vercel/blob';
import { skipIfNotPrimary } from '../_lib/primary-project.js';

const ANTHROPIC_BASE = 'https://api.anthropic.com/v1';
const BIA_SKILL_ID = 'skill_01VmKCpBmg717nKmCAWgnUYS';
const SOURCE_VERSION_FILE = 'knowledge-base/skill-source/.last_synced_version';
const ALERT_BUCKET_HOURS = 4;
const ALERT_BLOB_PREFIX = 'bia/skill-drift-alerts/';

function isAuthorized(req) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;
  const auth = req.headers?.authorization || req.headers?.Authorization || '';
  return auth === `Bearer ${expected}`;
}

async function readLocalSyncedVersion() {
  // Resolve path relative to repo root. process.cwd() in Vercel function = repo root.
  const filePath = path.join(process.cwd(), SOURCE_VERSION_FILE);
  try {
    const data = await fs.readFile(filePath, 'utf-8');
    return data.trim() || null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function alertSentRecently() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return false;
  try {
    const { blobs } = await list({ prefix: ALERT_BLOB_PREFIX });
    if (!blobs || blobs.length === 0) return false;
    const recentMs = Date.now() - ALERT_BUCKET_HOURS * 3600 * 1000;
    return blobs.some((b) => new Date(b.uploadedAt).getTime() > recentMs);
  } catch (err) {
    console.error(`[SKILL-DRIFT] alert dedup check failed: ${err?.message || err}`);
    return false;
  }
}

async function markAlertSent(payload) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const key = `${ALERT_BLOB_PREFIX}${Date.now()}.json`;
    await put(key, JSON.stringify(payload), {
      access: 'public',
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: 'application/json',
    });
  } catch (err) {
    console.error(`[SKILL-DRIFT] mark alert failed: ${err?.message || err}`);
  }
}

async function sendDriftEmail({ liveVersion, localVersion, latestCreated }) {
  if (!process.env.EMAIL_PASS || !process.env.EMAIL_FROM || !process.env.EMAIL_TO) {
    return { sent: false, reason: 'missing_email_env' };
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_FROM, pass: process.env.EMAIL_PASS },
  });
  const recipients = String(process.env.EMAIL_TO || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const subject = `[BIA-SKILL-DRIFT] Production skill diverge do source local`;
  const body = `
Drift detectado em skill_01VmKCpBmg717nKmCAWgnUYS (Bia Vendedora Premium).

Production latest_version: ${liveVersion}
Local synced version    : ${localVersion || '(NÃO commitada)'}
Production created_at   : ${latestCreated || '?'}
Checked at              : ${new Date().toISOString()}

Causa provável: upload direto Anthropic console sem passar pelo flow
landing-page/knowledge-base/skill-source/.

Ação:
1. Verificar version production via API (skills/skill_01VmK.../versions)
2. Re-sincronizar source local: dump SKILL.md via probe + commit
3. Atualizar .last_synced_version
4. Documentar mudança em SAB Reference

Bucket dedup ${ALERT_BUCKET_HOURS}h. Próximo alerta só após esse intervalo.
`.trim();
  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: recipients,
    subject,
    text: body,
  });
  return { sent: true, recipients };
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  // Multi-projeto race guard (16/05/2026 — 3 projetos = 3× drift check + 3× emails alerta).
  if (skipIfNotPrimary(res, 'bia-skill-refresh')) return;

  if (!process.env.ANTHROPIC_API_KEY_ICELASER) {
    return res.status(500).json({ error: 'missing_env_anthropic' });
  }

  const apiHeaders = {
    'x-api-key': process.env.ANTHROPIC_API_KEY_ICELASER,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'skills-2025-10-02',
  };

  const stats = {
    skill_id: BIA_SKILL_ID,
    checked_at: new Date().toISOString(),
    live_version: null,
    local_synced_version: null,
    drift: false,
    alert: 'not_sent',
  };

  try {
    // 1. GET latest version production
    const resp = await fetch(`${ANTHROPIC_BASE}/skills/${BIA_SKILL_ID}/versions?limit=1`, { headers: apiHeaders });
    if (!resp.ok) {
      const text = await resp.text();
      return res.status(502).json({ error: 'skill_versions_fetch_failed', status: resp.status, detail: text.slice(0, 500), stats });
    }
    const data = await resp.json();
    const latest = (data.data || [])[0] || null;
    if (!latest) {
      return res.status(200).json({ ok: true, ...stats, note: 'no_versions_found' });
    }
    stats.live_version = latest.version;
    stats.live_created_at = latest.created_at;

    // 2. Read local synced version
    stats.local_synced_version = await readLocalSyncedVersion();

    // 3. Compare
    if (stats.local_synced_version === stats.live_version) {
      return res.status(200).json({ ok: true, ...stats, in_sync: true });
    }

    // 4. Drift detected — check bucket dedup before alert
    stats.drift = true;
    if (await alertSentRecently()) {
      stats.alert = 'skipped_recent';
      return res.status(200).json({ ok: true, ...stats });
    }

    const emailResult = await sendDriftEmail({
      liveVersion: stats.live_version,
      localVersion: stats.local_synced_version,
      latestCreated: stats.live_created_at,
    });
    if (emailResult.sent) {
      await markAlertSent({
        live_version: stats.live_version,
        local_synced_version: stats.local_synced_version,
        sent_at: stats.checked_at,
        recipients: emailResult.recipients,
      });
      stats.alert = 'sent';
      stats.alert_recipients = emailResult.recipients;
    } else {
      stats.alert = `skipped_${emailResult.reason}`;
    }
    return res.status(200).json({ ok: true, ...stats });
  } catch (err) {
    return res.status(500).json({ error: 'unhandled', detail: String(err?.message || err), stats });
  }
}
