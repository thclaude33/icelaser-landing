// api/_lib/send-window.js
// FASE PRÉ-3 ITEM C — Janela horária HARD 08:00-20:30 BRT.
//
// Cravado 15/05/2026 após user reportar suspeita "Bia mandou msg aleatória"
// (na verdade era smoke do CD, mas regra é necessária pra evitar Bia disparar
// proativo de madrugada em produção V9 quando follow-up cascade for implementado).
//
// REGRAS:
//   - RESPOSTA reativa a cliente (session_type='reactive_reply'): SEMPRE permite,
//     qualquer hora (cliente esperando resposta às 3am = responde).
//   - FOLLOW-UP / REABORDAGEM (session_type='proactive_followup' OU outros):
//     APENAS 08:00-20:30 BRT. Fora janela = bloqueia + agenda 08:00 dia seguinte.
//
// Implementação DST-safe via Intl.DateTimeFormat 'America/Sao_Paulo'.

const SEND_WINDOW_START_MIN = 480;  // 08:00 = 8*60
const SEND_WINDOW_END_MIN = 1230;   // 20:30 = 20*60 + 30

function getBRTParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  return {
    year: parseInt(parts.find((p) => p.type === 'year').value),
    month: parseInt(parts.find((p) => p.type === 'month').value),
    day: parseInt(parts.find((p) => p.type === 'day').value),
    hour: parseInt(parts.find((p) => p.type === 'hour').value),
    minute: parseInt(parts.find((p) => p.type === 'minute').value),
  };
}

export function isWithinSendWindow(now = new Date()) {
  const p = getBRTParts(now);
  const totalMin = p.hour * 60 + p.minute;
  return totalMin >= SEND_WINDOW_START_MIN && totalMin <= SEND_WINDOW_END_MIN;
}

export function nextWindowStart(now = new Date()) {
  const p = getBRTParts(now);
  const totalMin = p.hour * 60 + p.minute;
  // Se já passou de 20:30, próximo 08:00 é amanhã. Se antes de 08:00, é hoje.
  // Se dentro janela, retorna o atual (caller deve checar isWithinSendWindow primeiro).
  const baseDate = new Date(Date.UTC(p.year, p.month - 1, p.day, 11, 0, 0)); // 08:00 BRT = 11:00 UTC (UTC-3)
  if (totalMin > SEND_WINDOW_END_MIN) {
    // Próximo dia 08:00
    return new Date(baseDate.getTime() + 24 * 3600 * 1000);
  }
  if (totalMin < SEND_WINDOW_START_MIN) {
    // Hoje 08:00 (ainda não chegou)
    return baseDate;
  }
  return baseDate; // dentro janela — retorna hoje 08:00 como referência
}

/**
 * Decide se Bia pode ENVIAR msg agora baseado em session metadata + janela.
 *
 * @param {object} sessionMetadata - { session_type: 'reactive_reply' | 'proactive_followup' | ... }
 * @param {Date} now - opcional, defaults to new Date()
 * @returns {{ ok: boolean, reason?: string, next_send_at?: string }}
 */
export function shouldSendNow(sessionMetadata, now = new Date()) {
  const sessionType = sessionMetadata?.session_type || null;

  // RESPOSTA reativa a cliente: SEMPRE OK (cliente esperando, responde)
  if (sessionType === 'reactive_reply') return { ok: true };

  // Sem session_type definido (sessions legacy ou direct path) = trata como reactive (safe default)
  if (!sessionType) return { ok: true, fallback: 'no_session_type' };

  // FOLLOW-UP / REABORDAGEM / outros tipos proativos: aplica janela
  if (!isWithinSendWindow(now)) {
    return {
      ok: false,
      reason: 'outside_send_window',
      next_send_at: nextWindowStart(now).toISOString(),
      session_type: sessionType,
    };
  }
  return { ok: true };
}
