// api/_lib/cascade.js
// PROMPT 2 — Cascade Follow-up: templates, timing, ARM/DISARM, render.
//
// FASES:
//   FASE 1 (intra-dia): 14 steps em rajada, abandona se estourar 20:30 (vai pra F2 step 0)
//   FASE 2 (D+1): 3 msgs (manhã/tarde/noite) com janela horária
//   FASE 3 (D+2): igual F2
//   FASE 4 (D+3 / D+5 / D+7 / silêncio / D+15): 4 sends finais
//
// DISARM (3 condições):
//   1. Cliente responde — handler bia-session-create.js DEL no início
//   2. Atendente humana posta — crm-webhook.js DEL via timestamp check
//   3. Label terminal (compra_realizada / desqualificado / lead_quente)
//
// SNAPSHOT KV: nome_curto + pacote_oferecido cravados na ARMA. Refresh @24h.
//
// $0 marginal Anthropic — templates fixos, sem Coord call.

import { kvSet, kvGet, kvDel, kvZadd, kvZrem, kvIncrWithExpire } from './kv-rate-limit.js';
import { shouldSendNow, nextWindowStart } from './send-window.js';

const KV_NAMESPACE = 'fu';
const KV_INDEX = 'fu:idx:scheduled';
const KV_KILLSWITCH = 'fu:killswitch';
const STATE_TTL_SEC = 30 * 24 * 3600;             // 30 dias rolling
const LAST_BIA_OUTGOING_TTL_SEC = 300;            // 5min — detect humana via timestamp
const DAILY_COUNT_TTL_SEC = 25 * 3600;            // 25h
const DAILY_MAX_SENDS = 6;                        // hard limit anti-spam
const SNAPSHOT_REFRESH_AFTER_MS = 24 * 3600 * 1000; // 24h

// ─────────────────────────────────────────────────────────────────────────
// INTERVALS — minutos cumulativos relativos ao started_at (FASE 1)
// ─────────────────────────────────────────────────────────────────────────

// F1 (14 steps): 4min, 10min, 16min, 26min, 50min, 1h20, 1h50, 2h30, 4h, 5h30, 7h, 8h30, 10h, 13h
export const F1_INTERVALS_MIN = [4, 10, 16, 26, 50, 80, 110, 150, 240, 330, 420, 510, 600, 780];

// F2/F3 (3 steps each): horários alvo BRT — manhã/tarde/noite
// Aplicados ao próximo dia (F2) e D+2 (F3)
export const F2F3_TARGET_HOURS_BRT = [10, 14.5, 19]; // 10:00, 14:30, 19:00

// F4 (4 steps): D+3, D+5, D+7, D+15 — alvo 10:00 BRT
export const F4_DAY_OFFSETS = [3, 5, 7, 15];

// ─────────────────────────────────────────────────────────────────────────
// TEMPLATES — 24 finais (14 F1 + 3 F2 + 3 F3 + 4 F4)
// Placeholder {nome} substituído via renderTemplate.
// Condicionais (pacote_oferecido) via funções "a" / "b" no map.
// ─────────────────────────────────────────────────────────────────────────

export const TEMPLATES = {
  F1: [
    // step 0..13
    'Oi {nome}! Ficou alguma dúvida? Tô aqui pra te ajudar 💜',
    'Tô aqui se quiser falar de valores ou agendamento {nome}, é só responder 😊',
    null, // step 2 condicional — usar getTemplate
    '{nome}, agenda dessa semana tá enchendo. Quer que eu separe um horário pra você?',
    'Posso te mostrar foto da clínica ou do Crystal 3D Plus se ajudar a decidir {nome} 😊',
    'Lembrete: 12× sem juros + cancelamento ZERO a qualquer momento — sem amarras {nome} 💜',
    'Reservo um horário sem compromisso {nome}? Só pra garantir caso queira fechar.',
    'Tô por aqui quando {nome} quiser retomar 💜 Sem pressão nenhuma.',
    'Brinde dessa semana ainda tá rodando {nome} — quer aproveitar antes de virar?',
    'Ficou alguma dúvida específica {nome}? Me conta que eu te ajudo a decidir 😊',
    '{nome}, ainda interessada? Sem pressão — só quero garantir que não te incomodo à toa 💜',
    'Tô fechando os agendamentos do mês {nome} — quer garantir?',
    'Tô fechando hoje {nome} 💜 Amanhã continuo por aqui se quiser conversar.',
    'Vou pausar por aqui hoje {nome}. Quando quiser retomar, é só me chamar 😊',
  ],
  F2: [
    'Bom dia {nome}! 💜 Pensou no pacote? Se surgiu alguma dúvida nova, tô aqui.',
    'Oi {nome}! Tô puxando agendamentos da semana — quer entrar?',
    'Boa noite {nome}! Última chance hoje de fechar com o brinde — quer?',
  ],
  F3: [
    'Oi {nome}, tudo bem? 💜 Tô aqui ainda. Posso te ajudar com algo?',
    null, // step 1 condicional
    'Boa noite {nome}! Se mudou de ideia, é só me chamar — tô por aqui 😊',
  ],
  F4: [
    'Oi {nome}, tudo bem? Voltei rapidinho 💜',
    '{nome}, quer ver os pacotes novos dessa semana?',
    'Última passada por aqui {nome} 💜 Se quiser conversar, é só me chamar.',
    'Oi {nome}! Lembra de mim? 💜 Tem promo nova essa semana — quer ver?',
  ],
};

// Condicionais (pacote_oferecido)
const CONDITIONAL_TEMPLATES = {
  // F1 step 2
  'F1.2': {
    with_pacote: '{nome}, gero o link de pagamento agora — abre em qualquer banco, 12× sem juros 💜',
    without_pacote: '{nome}, posso te mostrar valores agora? Te explico tudo 💜',
  },
  // F3 step 1
  'F3.1': {
    with_pacote: 'Lembrete {nome}: link de pagamento abre em qualquer banco, débito ou crédito 12×.',
    without_pacote: 'Oi {nome}! Quer ver os pacotes da semana? Tem opções pra todo orçamento 💜',
  },
};

// ─────────────────────────────────────────────────────────────────────────
// HELPERS de tempo / index keys
// ─────────────────────────────────────────────────────────────────────────

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
  // YYYY-MM-DD no fuso BRT
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  return p; // já vem YYYY-MM-DD
}

/**
 * Calcula scheduled_at (ISO + epoch sec) baseado em phase/step + started_at.
 *
 * F1 step N: started_at + F1_INTERVALS_MIN[N] minutos
 * F2 step N: D+1 às F2F3_TARGET_HOURS_BRT[N]
 * F3 step N: D+2 às F2F3_TARGET_HOURS_BRT[N]
 * F4 step N: D + F4_DAY_OFFSETS[N] às 10:00 BRT
 */
export function computeScheduledAt(phase, step, startedAtMs) {
  if (phase === 1) {
    const min = F1_INTERVALS_MIN[step];
    if (min === undefined) return null;
    return new Date(startedAtMs + min * 60 * 1000);
  }
  const dayOffset = phase === 2 ? 1 : phase === 3 ? 2 : phase === 4 ? F4_DAY_OFFSETS[step] : null;
  if (dayOffset === null || dayOffset === undefined) return null;
  // Horário alvo BRT
  const targetHour = phase === 4 ? 10 : F2F3_TARGET_HOURS_BRT[step];
  if (targetHour === undefined) return null;
  // started_at + dayOffset dias, hora=targetHour BRT
  // Convert BRT (UTC-3) hour → UTC hour (targetHour + 3)
  const startBRT = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(startedAtMs));
  const [y, m, d] = startBRT.split('-').map(Number);
  const baseUTC = new Date(Date.UTC(y, m - 1, d + dayOffset, 0, 0, 0));
  const wholeHours = Math.floor(targetHour);
  const minutes = Math.round((targetHour - wholeHours) * 60);
  // BRT é UTC-3 (DST off em SP desde 2019)
  baseUTC.setUTCHours(wholeHours + 3, minutes, 0, 0);
  return baseUTC;
}

/**
 * Próximo step válido — retorna {phase, step, scheduledAt} ou null se chegou no fim.
 */
export function getNextStep(state) {
  const { phase, step, started_at } = state;
  const startedAtMs = Date.parse(started_at);
  let nextPhase = phase;
  let nextStep = step + 1;
  // Limite por fase
  const limits = { 1: F1_INTERVALS_MIN.length, 2: 3, 3: 3, 4: F4_DAY_OFFSETS.length };
  if (nextStep >= limits[phase]) {
    nextPhase = phase + 1;
    nextStep = 0;
    if (nextPhase > 4) return null; // fim da cascade
  }
  const scheduledAt = computeScheduledAt(nextPhase, nextStep, startedAtMs);
  return scheduledAt ? { phase: nextPhase, step: nextStep, scheduledAt } : null;
}

/**
 * Migra FASE 1 → FASE 2 step 0 (caso F1 estoure janela 20:30 BRT em qualquer step).
 */
export function migrateToPhase2(state) {
  const startedAtMs = Date.parse(state.started_at);
  const scheduledAt = computeScheduledAt(2, 0, startedAtMs);
  return { phase: 2, step: 0, scheduledAt };
}

// ─────────────────────────────────────────────────────────────────────────
// ARM / DISARM
// ─────────────────────────────────────────────────────────────────────────

/**
 * ARMA cascade após resposta Bia postada com sucesso.
 *
 * @param {string|number} convId
 * @param {string} sessionId       Anthropic session_id (referência)
 * @param {object} snapshot        { nome_curto, pacote_oferecido } extraído do profile.md
 */
export async function armCascade(convId, sessionId, snapshot = {}) {
  if (process.env.FOLLOWUP_ENABLED !== '1') {
    return { ok: false, reason: 'followup_disabled_env' };
  }
  // Killswitch runtime
  const ks = await kvGet(KV_KILLSWITCH);
  if (ks.ok && ks.value === 'off') {
    return { ok: false, reason: 'killswitch_off' };
  }
  if (!convId) return { ok: false, reason: 'no_conv_id' };

  const now = new Date();
  const nowMs = now.getTime();
  const scheduledAt = computeScheduledAt(1, 0, nowMs); // F1 step 0 = +4min
  if (!scheduledAt) return { ok: false, reason: 'compute_schedule_failed' };

  const state = {
    phase: 1,
    step: 0,
    started_at: now.toISOString(),
    scheduled_at: scheduledAt.toISOString(),
    session_id_arm: sessionId || null,
    nome_snapshot: snapshot.nome_curto || null,
    pacote_snapshot: snapshot.pacote_oferecido || null,
    snapshot_refreshed_at: now.toISOString(),
  };

  await kvSet(stateKey(convId), JSON.stringify(state), STATE_TTL_SEC);
  const scoreEpoch = Math.floor(scheduledAt.getTime() / 1000);
  await kvZadd(KV_INDEX, scoreEpoch, String(convId));
  await kvSet(lastBiaOutgoingKey(convId), now.toISOString(), LAST_BIA_OUTGOING_TTL_SEC);

  return { ok: true, scheduled_at: state.scheduled_at, conv_id: convId };
}

/**
 * DESARMA cascade (3 condições): cliente respondeu / humana posta / label terminal.
 */
export async function disarmCascade(convId, reason) {
  if (!convId) return { ok: false, reason: 'no_conv_id' };
  await kvDel(stateKey(convId));
  await kvZrem(KV_INDEX, String(convId));
  console.log(`[FU-DISARM] conv=${convId} reason=${reason}`);
  return { ok: true, conv_id: convId, reason };
}

/**
 * REGISTRA timestamp da última msg outgoing da Bia (anti-collision com webhook humana detect).
 * Handler bia-session-create.js + cron/bia-postback.js chamam isso após postChatwoot success.
 */
export async function markBiaOutgoing(convId) {
  if (!convId) return;
  await kvSet(lastBiaOutgoingKey(convId), new Date().toISOString(), LAST_BIA_OUTGOING_TTL_SEC);
}

/**
 * Detecta se outgoing msg recebida no webhook é da própria Bia (true) ou humana (false).
 * Bia posta → mark timestamp → se NOW - last_bia < 60s = própria Bia.
 */
export async function isOutgoingFromBia(convId, thresholdMs = 60000) {
  const r = await kvGet(lastBiaOutgoingKey(convId));
  if (!r.ok || !r.value) return false; // nenhum mark → assume humana (safe default)
  const lastMs = Date.parse(r.value);
  if (Number.isNaN(lastMs)) return false;
  return (Date.now() - lastMs) < thresholdMs;
}

// ─────────────────────────────────────────────────────────────────────────
// RENDER TEMPLATE
// ─────────────────────────────────────────────────────────────────────────

/**
 * Pega template (com fallback condicional pacote_oferecido).
 */
export function getTemplate(phase, step, pacoteOferecido) {
  const key = `F${phase}.${step}`;
  if (CONDITIONAL_TEMPLATES[key]) {
    return pacoteOferecido
      ? CONDITIONAL_TEMPLATES[key].with_pacote
      : CONDITIONAL_TEMPLATES[key].without_pacote;
  }
  const arr = TEMPLATES[`F${phase}`];
  if (!arr || !arr[step]) return null;
  return arr[step];
}

/**
 * Substitui {nome} no template. Sem nome → remove placeholder + limpa pontuação/espaços.
 */
export function renderTemplate(template, nome) {
  if (!template) return '';
  let txt = template;
  if (nome && typeof nome === 'string' && nome.trim().length > 0) {
    txt = txt.replace(/\{nome\}/g, nome.trim());
  } else {
    // Sem nome: tira ", {nome}" / " {nome}" / "{nome} " / "{nome}," / "{nome}!"
    txt = txt.replace(/,?\s*\{nome\}\s*,?/g, ' ');
    txt = txt.replace(/\s+([!?.])/g, '$1');
    txt = txt.replace(/\s{2,}/g, ' ');
    // Edge: começo "Oi !" → "Oi!"
    txt = txt.replace(/^Oi\s+!/, 'Oi!');
  }
  return txt.trim();
}

// ─────────────────────────────────────────────────────────────────────────
// SNAPSHOT — construído a partir do contexto disponível no handler
// ─────────────────────────────────────────────────────────────────────────
//
// LIMITAÇÃO Anthropic API: memory_stores REST API expõe apenas metadata
// (path, byte_size, created_at), NÃO o content. Content só é acessível via
// Bash tool dentro de sessions ativas (mount /mnt/memory/...).
//
// SOLUÇÃO V1: snapshot construído no handler via contexto disponível:
//   - nome_curto: extra.sender_name do Chatwoot webhook (primeiro nome)
//   - pacote_oferecido: regex P[1-7] na resposta postada pela Bia
//
// Refresh @24h: V2 future-work (requer session ephemeral $0.05/snapshot).

/**
 * Constrói snapshot a partir do contexto do handler.
 *
 * @param {string} senderName       Nome completo vindo do Chatwoot (ex: "Maria Silva")
 * @param {string} biaResponseText  Resposta Bia postada (extrair pacote via regex)
 * @returns { nome_curto, pacote_oferecido }
 */
export function buildSnapshotFromContext(senderName, biaResponseText) {
  const out = {};
  // Primeiro nome capitalizado
  if (senderName && typeof senderName === 'string') {
    const first = String(senderName).trim().split(/\s+/)[0];
    if (first && first.length >= 2 && /^[A-Za-zÀ-ÿ]+$/.test(first)) {
      out.nome_curto = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
    }
  }
  // Pacote ofertado: primeiro match P[1-7] na resposta Bia
  if (biaResponseText && typeof biaResponseText === 'string') {
    const m = biaResponseText.match(/\bP([1-7])\b/);
    if (m) out.pacote_oferecido = `P${m[1]}`;
  }
  return out;
}

/**
 * Parse YAML frontmatter simples — extrai nome_curto + pacote_oferecido.
 * NÃO usa lib YAML (KISS, evita dep). Regex tolerante.
 */
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

// ─────────────────────────────────────────────────────────────────────────
// DAILY COUNT — anti-spam max 6 sends/dia
// ─────────────────────────────────────────────────────────────────────────

/**
 * Incrementa contador diário + retorna count.
 * Se passou de DAILY_MAX_SENDS → caller deve pular send + reagendar.
 */
export async function incrDailyCount(convId) {
  const date = todayBRT();
  return kvIncrWithExpire(dailyCountKey(convId, date), DAILY_COUNT_TTL_SEC);
}

/**
 * Verifica se daily count atingiu limit (sem incrementar).
 */
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
