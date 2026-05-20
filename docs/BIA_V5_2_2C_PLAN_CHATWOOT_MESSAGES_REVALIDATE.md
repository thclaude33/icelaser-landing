# Bia V5.2.2c Plan - Chatwoot Full Messages Revalidate

Data: 2026-05-19
Status: patch local preparado e validado, pronto para commit/push.

## Problema

O revalidate do follow-up da Bia em `api/cron/bia-followup-cascade.js` foi adicionado na V5.2.2b para impedir follow-up antigo quando webhook do Chatwoot falha.

Bug confirmado pelo source do Chatwoot:

- `GET /api/v1/accounts/{account_id}/conversations/{id}` renderiza a conversa com no maximo a ultima mensagem.
- Se o cliente respondeu e depois veio uma activity message, label, assignee ou outro evento interno, a resposta do cliente pode deixar de aparecer no array `messages`.
- O revalidate passaria silenciosamente e poderia mandar follow-up indevido.

Fonte:

- https://raw.githubusercontent.com/chatwoot/chatwoot/develop/app/views/api/v1/conversations/partials/_conversation.json.jbuilder

Validacao LIVE em producao, conversa 559 do inbox WhatsApp Recife:

- `GET /api/v1/accounts/{account_id}/conversations/559` retornou HTTP 200 com `messages.length = 1`.
- `GET /api/v1/accounts/{account_id}/conversations/559/messages` retornou HTTP 200 com `payload.length = 14`.
- O token de producao puxado via `vercel env pull --environment=production` respondeu HTTP 200 nos dois endpoints.

## Fix planejado

Alterar `fetchChatwootConversation(convId)` para:

1. Buscar status/labels da conversa:
   - `GET /api/v1/accounts/{account_id}/conversations/{id}`

2. Buscar historico recente completo:
   - `GET /api/v1/accounts/{account_id}/conversations/{id}/messages`

3. Injetar `conversation.messages = payload` do endpoint de messages.

4. Uniformizar erro de rede:
   - network/ECONNREFUSED/DNS vira `{ ok:false, status:0, network_error:true }`
   - sem throw solto para o loop externo.

## Paginacao

O endpoint `/messages` retorna a pagina recente de mensagens. Para o revalidate atual, uma pagina e suficiente porque a janela comparada por `sinceMs` vem do ultimo step de follow-up (`last_step_sent_at` ou `started_at`), normalmente intraday e recente. Se no futuro a cascade passar a validar janelas longas com mais de uma pagina de mensagens apos `sinceMs`, evoluir para paginacao usando o cursor/parametro suportado pelo Chatwoot.

## Testes adicionados

Arquivo:

- `tests/bia-followup-safety.test.js`

Cenarios:

- `fetchChatwootConversation uses messages index, not only show last message`
- `fetchChatwootConversation returns network errors instead of throwing`

O primeiro teste simula:

- show da conversa retorna so activity message como ultima mensagem
- endpoint `/messages` retorna incoming do cliente + activity
- `validateFollowupConversation` bloqueia com `incoming_after_followup_state`

## Validacao local feita

```bash
node --check api/cron/bia-followup-cascade.js
node --test tests/bia-followup-safety.test.js
npm test
git diff --check
```

Resultado:

- `node --check`: OK
- teste focado: 9/9 pass
- suite completa: 131/131 pass
- `git diff --check`: OK

## Comandos para executar quando aprovado

```bash
git add api/cron/bia-followup-cascade.js tests/bia-followup-safety.test.js docs/BIA_V5_2_2C_PLAN_CHATWOOT_MESSAGES_REVALIDATE.md
git commit -m "fix(bia): revalidate follow-up against full Chatwoot messages"
git push origin main
```

## Fora do escopo

- Nao altera agent Anthropic live.
- Nao altera skill.
- Nao mexe em Webhooks/Dreams/Opus.
- Nao altera routing Recife/JPA.
