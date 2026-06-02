// api/_lib/cascade.js
// Bia Follow-up V5.3 — shadow test cadence.
//
// FASES:
//   FASE 1: free-form via Chatwoot dentro da janela WhatsApp 0-24h.
//   FASE 2: templates Meta aprovados D+1. D+2 fica preparado, mas disabled.
//
// DISARM:
//   1. Cliente responde — bia-session-create.js DEL no início.
//   2. Atendente humana posta — crm-webhook.js DEL via timestamp check.
//   3. Label terminal (compra_realizada / desqualificado / lead_quente).
//
// Valores 16/20/24 são de shadow mode. Recalibrar antes de remover o gate
// inbox 7 + label bia_teste em bia-session-create.js.

import { kvSet, kvGet, kvDel, kvZadd, kvZrem, kvIncrWithExpire } from './kv-rate-limit.js';

const KV_NAMESPACE = 'fu';
const KV_INDEX = 'fu:idx:scheduled';
const KV_KILLSWITCH = 'fu:killswitch';
const STATE_TTL_SEC = 30 * 24 * 3600;
const LAST_BIA_OUTGOING_TTL_SEC = 300;
export const OUTGOING_SELF_DETECT_THRESHOLD_MS = LAST_BIA_OUTGOING_TTL_SEC * 1000;
const DAILY_COUNT_TTL_SEC = 25 * 3600;

export const SCHEMA_VERSION = 4;
export const FREEFORM_EXPIRES_AFTER_MS = 23 * 3600 * 1000;
export const TEMPLATE_FREE_UNTIL_AFTER_MS = 70 * 3600 * 1000;

// VALORES DE TESTE (shadow mode) — recalibrar antes do go-live geral.
const DAILY_MAX_SENDS = 20;                       // por conversa/dia BRT
export const MAX_SENDS_PER_CASCADE = 24;          // por cascade armada
const SNAPSHOT_REFRESH_AFTER_MS = 24 * 3600 * 1000;

// Dia 1 (dia que a conversa chega) — cadência definida pela operação:
// 5min · 15min · 45min · 1h10 · 1h50 · 2h30 · 3h30 · 4h50 · 5h30
export const F1_INTERVALS_MIN = [5, 15, 45, 70, 110, 150, 210, 290, 330];

const F1_MESSAGES = [
  'Oi {nome}! Conseguiu ver direitinho? Se tiver qualquer dúvida, tô aqui 💜',
  'Posso te explicar com calma como funcionam os pacotes e valores, se quiser 😊',
  'Me fala quais áreas você pensa em fazer que eu te ajudo a escolher o pacote mais certinho pra sua rotina 💜',
  'E se a dúvida for dor, resultado ou forma de pagamento, pode perguntar sem vergonha tá?',
  'Posso te mostrar uma opção mais econômica pra começar e outra mais completa, pra você comparar com calma 💜',
  '{nome}, quer que eu veja qual pacote combina melhor com o que você quer fazer agora?',
  'Dá pra parcelar em até 12x sem juros. Se quiser, te mostro como ficaria de um jeito bem simples.',
  'Passando só pra saber se ficou alguma dúvida específica sobre áreas, valores ou atendimento 💜',
  'Vou deixar por aqui por enquanto 💜 Quando quiser retomar, me chama que eu te ajudo com calma.',
];

export const F1_STEPS = F1_INTERVALS_MIN.map((offsetMin, idx) => ({
  id: `F1-${idx}`,
  kind: 'freeform',
  enabled: true,
  offsetMin,
  text: F1_MESSAGES[idx],
}));

export const TEMPLATE_STEPS = [
  {
    id: 'T1_D1_0930_DUVIDA',
    kind: 'template',
    enabled: true,
    dayOffset: 1,
    hourBRT: 9,
    minuteBRT: 30,
    templateName: 'bia_d1_duvida_recife_v1',
  },
  {
    id: 'T1_D1_1200_PACOTES',
    kind: 'template',
    enabled: true,
    dayOffset: 1,
    hourBRT: 12,
    minuteBRT: 0,
    templateName: 'bia_d1_pacotes_recife_v1',
  },
  {
    id: 'T1_D1_1430_AGENDA',
    kind: 'template',
    enabled: true,
    dayOffset: 1,
    hourBRT: 14,
    minuteBRT: 30,
    templateName: 'bia_d1_agenda_recife_v1',
  },
  {
    id: 'T1_D1_1700_PARCELAS',
    kind: 'template',
    enabled: true,
    dayOffset: 1,
    hourBRT: 17,
    minuteBRT: 0,
    templateName: 'bia_d1_parcelas_recife_v1',
  },
  {
    id: 'T1_D1_1930_RETOMAR',
    kind: 'template',
    enabled: true,
    dayOffset: 1,
    hourBRT: 19,
    minuteBRT: 30,
    templateName: 'bia_d1_retomar_recife_v1',
  },
  {
    id: 'T2_D2_PREPARED',
    kind: 'template',
    enabled: false,
    dayOffset: 2,
    hourBRT: 14,
    minuteBRT: 30,
    templateName: null,
  },
];

export const TEMPLATES = {
  F1: F1_MESSAGES,
};

function stateKey(convId) {
  return `${KV_NAMESPACE}:thread:${convId}:state`;
}
function lastBiaOutgoingKey(convId) {
  return `${KV_NAMESPACE}:thread:${convId}:last_bia_outgoing_at`;
}
function dailyCountKey(convId, dateStr) {
  return `${KV_NAMESPACE}:thread:${convId}:daily_count:${dateStr}`;
}
function todayBRT() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function brtDateParts(ms) {
  const str = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
  return str.split('-').map(Number);
}

function makeBrtDateTimeFromStart(startedAtMs, dayOffset, hourBRT, minuteBRT) {
  const [y, m, d] = brtDateParts(startedAtMs);
  return new Date(Date.UTC(y, m - 1, d + dayOffset, hourBRT + 3, minuteBRT, 0, 0));
}

export function getStepConfig(phase, step) {
  if (phase === 1) return F1_STEPS[step] || null;
  if (phase === 2) return TEMPLATE_STEPS[step] || null;
  return null;
}

export function getPhaseSteps(phase) {
  if (phase === 1) return F1_STEPS;
  if (phase === 2) return TEMPLATE_STEPS;
  return [];
}

export function getScheduleAnchorMs(state = {}, phase = state.phase) {
  if (phase === 1) return Date.parse(state.f1_anchor_at || state.started_at);
  return Date.parse(state.started_at);
}

export function computeScheduledAt(phase, step, startedAtMs) {
  const cfg = getStepConfig(phase, step);
  if (!cfg || cfg.enabled === false) return null;
  if (cfg.kind === 'freeform') {
    return new Date(startedAtMs + cfg.offsetMin * 60 * 1000);
  }
  if (cfg.kind === 'template') {
    return makeBrtDateTimeFromStart(startedAtMs, cfg.dayOffset, cfg.hourBRT, cfg.minuteBRT);
  }
  return null;
}

export function computeScheduledAtForState(state, phase = state.phase, step = state.step) {
  const anchorMs = getScheduleAnchorMs(state, phase);
  if (Number.isNaN(anchorMs)) return null;
  return computeScheduledAt(phase, step, anchorMs);
}

export function scheduleCurrentStepAt(state, scheduledAt) {
  const scheduledAtDate = scheduledAt instanceof Date ? scheduledAt : new Date(scheduledAt);
  const cfg = getStepConfig(state.phase, state.step);
  const nextState = { ...state, scheduled_at: scheduledAtDate.toISOString() };
  if (cfg?.kind === 'freeform') {
    const anchorMs = scheduledAtDate.getTime() - cfg.offsetMin * 60 * 1000;
    nextState.f1_anchor_at = new Date(anchorMs).toISOString();
  }
  return nextState;
}

export function getNextStep(state) {
  const phase = Number(state.phase || 1);
  const step = Number(state.step || 0);

  if (phase === 1) {
    const nextFreeformStep = step + 1;
    if (nextFreeformStep < F1_STEPS.length) {
      const scheduledAt = computeScheduledAt(1, nextFreeformStep, getScheduleAnchorMs(state, 1));
      return scheduledAt ? { phase: 1, step: nextFreeformStep, scheduledAt } : null;
    }
    return getFirstTemplateStepAtOrAfter(state, -Infinity);
  }

  if (phase === 2) {
    const nextTemplateStep = step + 1;
    const cfg = TEMPLATE_STEPS[nextTemplateStep];
    if (!cfg || cfg.enabled === false) return null;
    const scheduledAt = computeScheduledAt(2, nextTemplateStep, Date.parse(state.started_at));
    return scheduledAt ? { phase: 2, step: nextTemplateStep, scheduledAt } : null;
  }

  return null;
}

export function getFirstTemplateStepAtOrAfter(state, nowMs = Date.now()) {
  const startedAtMs = Date.parse(state.started_at);
  if (Number.isNaN(startedAtMs)) return null;
  for (let step = 0; step < TEMPLATE_STEPS.length; step += 1) {
    const cfg = TEMPLATE_STEPS[step];
    if (!cfg || cfg.enabled === false) return null;
    const scheduledAt = computeScheduledAt(2, step, startedAtMs);
    if (scheduledAt && scheduledAt.getTime() >= nowMs) {
      return { phase: 2, step, scheduledAt };
    }
  }
  return null;
}

export function migrateToTemplatePhase(state, nowMs = Date.now()) {
  return getFirstTemplateStepAtOrAfter(state, nowMs);
}

export function migrateToPhase2(state) {
  return migrateToTemplatePhase(state, Date.now());
}

export async function armCascade(convId, sessionId, snapshot = {}) {
  if (process.env.FOLLOWUP_ENABLED !== '1') {
    return { ok: false, reason: 'followup_disabled_env' };
  }
  const ks = await kvGet(KV_KILLSWITCH);
  if (ks.ok && ks.value === 'off') {
    return { ok: false, reason: 'killswitch_off' };
  }
  if (!convId) return { ok: false, reason: 'no_conv_id' };

  // Idempotência: se já há cascade ARMADA do schema atual, não re-armar (não reinicia o relógio
  // a cada resposta da Bia). State de schema antigo (< SCHEMA_VERSION) é ignorado e re-armado
  // fresco com a cadência nova — senão um cascade velho "acordaria" com agenda/step velhos.
  const existingState = await kvGet(stateKey(convId));
  if (existingState.ok && existingState.value) {
    let parsedExisting = null;
    try { parsedExisting = JSON.parse(existingState.value); } catch { parsedExisting = null; }
    if (parsedExisting && Number(parsedExisting.schema_version) >= SCHEMA_VERSION) {
      return { ok: true, reason: 'already_armed', conv_id: convId };
    }
  }

  const now = new Date();
  const nowMs = now.getTime();
  const scheduledAt = computeScheduledAt(1, 0, nowMs);
  if (!scheduledAt) return { ok: false, reason: 'compute_schedule_failed' };
  const defaultTemplateFreeUntilMs = nowMs + TEMPLATE_FREE_UNTIL_AFTER_MS;
  const snapshotTemplateFreeUntilMs = Date.parse(snapshot.template_free_until_at || '');
  const templateFreeUntilMs = Number.isNaN(snapshotTemplateFreeUntilMs)
    ? defaultTemplateFreeUntilMs
    : Math.min(defaultTemplateFreeUntilMs, snapshotTemplateFreeUntilMs);

  const state = {
    schema_version: SCHEMA_VERSION,
    phase: 1,
    step: 0,
    started_at: now.toISOString(),
    f1_anchor_at: now.toISOString(),
    freeform_expires_at: new Date(nowMs + FREEFORM_EXPIRES_AFTER_MS).toISOString(),
    template_free_until_at: new Date(templateFreeUntilMs).toISOString(),
    scheduled_at: scheduledAt.toISOString(),
    session_id_arm: sessionId || null,
    nome_snapshot: snapshot.nome_curto || null,
    pacote_snapshot: snapshot.pacote_oferecido || null,
    telefone: snapshot.telefone || snapshot.phone || null,
    is_ctwa: snapshot.is_ctwa === true,
    total_sent_count: 0,
    snapshot_refreshed_at: now.toISOString(),
  };

  await kvSet(stateKey(convId), JSON.stringify(state), STATE_TTL_SEC);
  await kvZadd(KV_INDEX, Math.floor(scheduledAt.getTime() / 1000), String(convId));
  await kvSet(lastBiaOutgoingKey(convId), now.toISOString(), LAST_BIA_OUTGOING_TTL_SEC);

  return { ok: true, scheduled_at: state.scheduled_at, conv_id: convId };
}

export async function disarmCascade(convId, reason) {
  if (!convId) return { ok: false, reason: 'no_conv_id' };
  await kvDel(stateKey(convId));
  await kvZrem(KV_INDEX, String(convId));
  console.log(`[FU-DISARM] conv=${convId} reason=${reason}`);
  return { ok: true, conv_id: convId, reason };
}

export async function markBiaOutgoing(convId) {
  if (!convId) return { ok: false, reason: 'no_conv_id' };
  return kvSet(lastBiaOutgoingKey(convId), new Date().toISOString(), LAST_BIA_OUTGOING_TTL_SEC);
}

export async function isOutgoingFromBia(convId, thresholdMs = OUTGOING_SELF_DETECT_THRESHOLD_MS) {
  const r = await kvGet(lastBiaOutgoingKey(convId));
  if (!r.ok || !r.value) return false;
  const lastMs = Date.parse(r.value);
  if (Number.isNaN(lastMs)) return false;
  return (Date.now() - lastMs) < thresholdMs;
}

export function getTemplate(phase, step) {
  const cfg = getStepConfig(phase, step);
  if (!cfg || cfg.kind !== 'freeform') return null;
  return cfg.text || null;
}

export function renderTemplate(template, nome) {
  if (!template) return '';
  let txt = template;
  if (nome && typeof nome === 'string' && nome.trim().length > 0) {
    txt = txt.replace(/\{nome\}/g, nome.trim());
  } else {
    txt = txt.replace(/,?\s*\{nome\}\s*,?/g, ' ');
    txt = txt.replace(/\s+([!?.])/g, '$1');
    txt = txt.replace(/\s{2,}/g, ' ');
    txt = txt.replace(/^Oi\s+!/, 'Oi!');
  }
  return txt.trim();
}

export function buildSnapshotFromContext(senderName, biaResponseText) {
  const out = {};
  if (senderName && typeof senderName === 'string') {
    const first = String(senderName).trim().split(/\s+/)[0];
    if (first && first.length >= 2 && /^[A-Za-zÀ-ÿ]+$/.test(first)) {
      out.nome_curto = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    }
  }
  if (biaResponseText && typeof biaResponseText === 'string') {
    const m = biaResponseText.match(/\bP([1-7])\b/);
    if (m) out.pacote_oferecido = `P${m[1]}`;
  }
  return out;
}

export function parseProfileYaml(content) {
  if (!content || typeof content !== 'string') return {};
  const out = {};
  const nomeMatch = content.match(/^nome_curto:\s*"?([^"\n]*)"?/m);
  if (nomeMatch && nomeMatch[1] && nomeMatch[1] !== 'null') {
    out.nome_curto = nomeMatch[1].trim();
  }
  const pacMatch = content.match(/^pacote_oferecido:\s*"?([^"\n]*)"?/m);
  if (pacMatch && pacMatch[1] && pacMatch[1] !== 'null') {
    out.pacote_oferecido = pacMatch[1].trim();
  }
  return out;
}

export async function incrDailyCount(convId) {
  const date = todayBRT();
  return kvIncrWithExpire(dailyCountKey(convId, date), DAILY_COUNT_TTL_SEC);
}

export async function getDailyCount(convId) {
  const date = todayBRT();
  const r = await kvGet(dailyCountKey(convId, date));
  if (!r.ok || !r.value) return 0;
  return Number(r.value) || 0;
}

export {
  KV_INDEX,
  KV_KILLSWITCH,
  STATE_TTL_SEC,
  DAILY_MAX_SENDS,
  SNAPSHOT_REFRESH_AFTER_MS,
  stateKey,
  lastBiaOutgoingKey,
};
