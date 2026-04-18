/**
 * _lib/time.js — helpers timezone-aware pra BRT (America/Recife).
 *
 * CONTEXTO:
 *   - Vercel Cron é SEMPRE UTC (doc oficial 2026).
 *   - Node.js em Vercel Functions roda em UTC por default (TZ env var é reservada).
 *   - IceLaser é local Recife/PE = UTC-3 atualmente.
 *
 * Por que `Intl.DateTimeFormat('America/Recife')` em vez de `UTC - 3` hardcoded:
 *   - Mesma verbosidade.
 *   - Lida automaticamente com qualquer mudança futura de fuso sem precisar patch.
 */

/**
 * Retorna parts da data em America/Recife via Intl.
 * Default keys: year, month, day, hour, minute, second, weekday (long).
 *
 * @param {Date} date - default Date agora
 * @param {object} options - override Intl options
 * @returns {{year,month,day,hour,minute,second,weekday}}
 */
export function brtParts(date = new Date(), options = {}) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Recife',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'short',
    ...options,
  });
  const out = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = part.value;
  }
  return out;
}

/**
 * Hora BRT (0-23) — substitui `new Date().getUTCHours()` em lógica dependente
 * do horário local de Recife.
 *
 * Exemplo: daily-report precisa saber se é "Manhã" (8h BRT) ou "Noite" (20h BRT).
 * Vercel cron dispara às 11h UTC (=8h BRT) e 23h UTC (=20h BRT).
 * getUTCHours dá 11/23 — funciona por coincidência. brtHour() dá 8/20 — correto.
 */
export function brtHour(date = new Date()) {
  return parseInt(brtParts(date).hour, 10);
}

/**
 * Retorna 'Manhã'/'Tarde'/'Noite' baseado na hora BRT.
 * Thresholds: 5-11 manhã, 12-17 tarde, 18-4 noite.
 */
export function brtPeriod(date = new Date()) {
  const h = brtHour(date);
  if (h >= 5 && h <= 11) return 'Manhã';
  if (h >= 12 && h <= 17) return 'Tarde';
  return 'Noite';
}

/**
 * ISO string em BRT: "2026-04-18 15:30:45 BRT" (human-readable, sem timezone drift).
 */
export function brtISO(date = new Date()) {
  const p = brtParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} BRT`;
}

/**
 * Valida se o request veio do Vercel Cron scheduler oficial.
 * Vercel docs (2026): "Vercel Functions triggered by a cron job will always
 * contain vercel-cron/1.0 as the user agent".
 *
 * Uso defense-in-depth COMBINADO com Bearer CRON_SECRET — se secret vazar,
 * atacante ainda precisa fakear user-agent (trivial mas soma-se à barreira).
 *
 * @param {import('http').IncomingMessage | Request} req
 * @returns {boolean}
 */
export function isVercelCron(req) {
  const ua = (req.headers?.['user-agent']
    || req.headers?.get?.('user-agent')
    || '').toLowerCase();
  return ua.includes('vercel-cron');
}
