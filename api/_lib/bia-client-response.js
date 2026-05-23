export const SAFE_CLIENT_FALLBACK = 'Oi! 💜 Tô aqui. Me conta o que precisar.';

const CLIENT_RESPONSE_RE = /<(resposta_cliente|para_cliente)>([\s\S]*?)<\/\1>/i;

const INTERNAL_PATTERNS = [
  /(?:^|\n)\s*(?:[-*_]\s*){0,3}\*{0,2}\s*⚠️?\s*Alerta interno\b/i,
  /\bVit[oó]ria precisa ver isso\b/i,
  /\/bia-audit-log\//i,
  /\blast_followup_step\b/i,
  /\bshouldSendNow\s*\(/i,
  /\bpollSessionForResponse\b/i,
  /\|\s*-{3,}\s*\|/,
  /\bViola[cç][oõ]es detectadas\b/i,
  /\bRecomenda[cç][aã]o para Vit[oó]ria\b/i,
  /\bGate hor[aá]rio\b/i,
  /\bhandler Vercel\b/i,
  /\bProfile atualizado com flag\b/i,
  /\bAudit log salvo\b/i,
];

const META_CONFIRMATION_RE = /^(profile|perfil)[^\n]{0,40}(criad|salv|confirm|atualiz|registrad|anotad|escrit)/i;

function compactPreview(text, max = 200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function isMetaConfirmation(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length >= 80) return false;
  return META_CONFIRMATION_RE.test(t);
}

export function looksLikeInternalContent(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  return INTERNAL_PATTERNS.some((pattern) => pattern.test(t));
}

export function isSafeForClientHistory(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (!t) return false;
  return !looksLikeInternalContent(t) && !isMetaConfirmation(t);
}

export function stripClientResponseDelimiters(text) {
  if (!text || typeof text !== 'string') return null;
  const match = CLIENT_RESPONSE_RE.exec(text);
  return match ? match[2].trim() : null;
}

export function collectAgentMessages(events = [], { baselineEventCount = 0 } = {}) {
  if (!Array.isArray(events)) return [];
  return events
    .map((event, idx) => {
      if (event?.type !== 'agent.message') return null;
      const text = (event.content || [])
        .filter((part) => part?.type === 'text' && part.text)
        .map((part) => part.text)
        .join('\n')
        .trim();
      return { idx, text };
    })
    .filter((message) => message && message.idx >= baselineEventCount && message.text);
}

function blockedResult(reason, candidate = null) {
  return {
    ok: false,
    reason,
    blockedAgentMsgIdx: candidate?.idx ?? -1,
    blockedTextPreview: compactPreview(candidate?.text || ''),
  };
}

export function extractClientResponseFromEvents(events = [], options = {}) {
  const messages = collectAgentMessages(events, options);
  if (messages.length === 0) {
    return blockedResult('no_agent_messages');
  }

  const delimited = messages
    .map((message) => ({ ...message, delimitedText: stripClientResponseDelimiters(message.text) }))
    .filter((message) => message.delimitedText !== null);

  if (delimited.length > 0) {
    // Quando session-reuse acumula múltiplos turnos com <resposta_cliente>,
    // delimited[0] é a resposta VELHA. Honra preferSafeCandidate='last' como
    // o caminho de fallback safe (linha 102) já faz, escolhendo a mais recente.
    const preferLast = options.preferSafeCandidate === 'last';
    const chosen = preferLast ? delimited[delimited.length - 1] : delimited[0];
    const text = chosen.delimitedText.trim();
    if (!text) return blockedResult('empty_delimited_response', chosen);
    if (isMetaConfirmation(text)) return blockedResult('meta_delimited_response', chosen);
    if (looksLikeInternalContent(text)) return blockedResult('internal_delimited_response', chosen);
    return { ok: true, text, agentMsgIdx: chosen.idx, source: preferLast ? 'delimited_last' : 'delimited' };
  }

  const safeMessages = messages.filter((message) => (
    !isMetaConfirmation(message.text) && !looksLikeInternalContent(message.text)
  ));

  if (safeMessages.length > 0) {
    const preferLast = options.preferSafeCandidate === 'last';
    const chosen = preferLast ? safeMessages[safeMessages.length - 1] : safeMessages[0];
    return {
      ok: true,
      text: chosen.text.trim(),
      agentMsgIdx: chosen.idx,
      source: preferLast ? 'compat_last_safe' : 'compat_first_safe',
    };
  }

  return blockedResult('no_safe_agent_message', messages[0]);
}

export function responseOrFallbackFromEvents(events = [], options = {}) {
  const result = extractClientResponseFromEvents(events, options);
  if (result.ok) return result;

  if (result.blockedAgentMsgIdx >= 0) {
    return {
      ok: true,
      text: SAFE_CLIENT_FALLBACK,
      agentMsgIdx: result.blockedAgentMsgIdx,
      source: 'safe_fallback',
      fallback: true,
      blockedReason: result.reason,
      blockedTextPreview: result.blockedTextPreview,
    };
  }

  return result;
}
