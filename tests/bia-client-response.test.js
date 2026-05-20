import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SAFE_CLIENT_FALLBACK,
  extractClientResponseFromEvents,
  looksLikeInternalContent,
  responseOrFallbackFromEvents,
} from '../api/_lib/bia-client-response.js';

function agentMessage(text) {
  return { type: 'agent.message', content: [{ type: 'text', text }] };
}

function toolUse() {
  return { type: 'agent.tool_use', name: 'bash' };
}

test('extracts delimited customer response and ignores internal text around it', () => {
  const result = extractClientResponseFromEvents([
    agentMessage('interno antes\n<resposta_cliente>Oi! 💜</resposta_cliente>\n⚠️ Alerta interno depois'),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Oi! 💜');
  assert.equal(result.agentMsgIdx, 0);
  assert.equal(result.source, 'delimited');
});

test('blocks internal alert reports', () => {
  const result = extractClientResponseFromEvents([
    agentMessage('⚠️ Alerta interno — Vitória precisa ver isso\n\nViolações detectadas'),
  ]);

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_safe_agent_message');
  assert.equal(result.blockedAgentMsgIdx, 0);
});

test('blocks audit log paths and operational internals', () => {
  assert.equal(looksLikeInternalContent('/bia-audit-log/2026-05-20/arquivo.md'), true);
  assert.equal(looksLikeInternalContent('last_followup_step: 6'), true);
  assert.equal(looksLikeInternalContent('handler Vercel shouldSendNow()'), true);
  assert.equal(looksLikeInternalContent('pollSessionForResponse escolheu errado'), true);
});

test('blocks markdown audit table separators', () => {
  assert.equal(looksLikeInternalContent('| Violação | Detalhe |\n|---|---|'), true);
});

test('allows legitimate short customer replies', () => {
  for (const text of ['Oi! 💜', 'Perfeito', 'Amanhã às 14h dá certo']) {
    const result = extractClientResponseFromEvents([agentMessage(text)]);
    assert.equal(result.ok, true);
    assert.equal(result.text, text);
  }
});

test('allows legitimate customer named Vitoria', () => {
  const result = extractClientResponseFromEvents([
    agentMessage('Oi Vitória! 💜 Tudo bem?'),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Oi Vitória! 💜 Tudo bem?');
});

test('allows legitimate single pipe in price text', () => {
  const text = 'Fica R$297 | 12x sem juros, se fizer sentido pra você 💜';
  const result = extractClientResponseFromEvents([agentMessage(text)]);

  assert.equal(result.ok, true);
  assert.equal(result.text, text);
});

test('compatibility mode chooses first safe current-turn reply over later internal report', () => {
  const result = extractClientResponseFromEvents([
    { type: 'user.message', content: [{ type: 'text', text: 'oi' }] },
    agentMessage('Oi, Thiago! 💜 Tô aqui. Me conta o que precisar.'),
    toolUse(),
    agentMessage('--- **⚠️ Alerta interno — Vitória precisa ver isso**\n\nlast_followup_step: 6'),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Oi, Thiago! 💜 Tô aqui. Me conta o que precisar.');
  assert.equal(result.agentMsgIdx, 1);
  assert.equal(result.source, 'compat_first_safe');
});

test('compatibility mode no longer lets longest internal report beat shorter customer reply', () => {
  const internal = [
    '⚠️ Alerta interno — Vitória precisa ver isso',
    'Violações detectadas',
    'Spam sequencial',
    'last_followup_step: 6',
  ].join('\n\n');
  const result = extractClientResponseFromEvents([
    agentMessage('Pode mandar sua dúvida 💜'),
    agentMessage(internal.repeat(20)),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Pode mandar sua dúvida 💜');
  assert.equal(result.agentMsgIdx, 0);
});

test('fallback result carries blocked event idx for per-turn dedup', () => {
  const result = responseOrFallbackFromEvents([
    { type: 'user.message', content: [{ type: 'text', text: 'oi' }] },
    agentMessage('⚠️ Alerta interno — Vitória precisa ver isso'),
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.text, SAFE_CLIENT_FALLBACK);
  assert.equal(result.fallback, true);
  assert.equal(result.agentMsgIdx, 1);
  assert.equal(result.blockedReason, 'no_safe_agent_message');
});

test('baselineEventCount limits extraction to the current turn', () => {
  const result = extractClientResponseFromEvents([
    agentMessage('Resposta antiga'),
    { type: 'session.status_idle' },
    { type: 'user.message', content: [{ type: 'text', text: 'novo oi' }] },
    agentMessage('Resposta nova'),
  ], { baselineEventCount: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Resposta nova');
  assert.equal(result.agentMsgIdx, 3);
});

test('preferSafeCandidate last chooses latest safe response after filtering internals', () => {
  const result = extractClientResponseFromEvents([
    agentMessage('Resposta antiga'),
    agentMessage('Resposta nova'),
    agentMessage('⚠️ Alerta interno — Vitória precisa ver isso'),
  ], { preferSafeCandidate: 'last' });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'Resposta nova');
  assert.equal(result.agentMsgIdx, 1);
  assert.equal(result.source, 'compat_last_safe');
});
