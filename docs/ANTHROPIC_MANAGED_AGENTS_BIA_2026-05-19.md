# Anthropic Managed Agents + Bia - Apurado LIVE 2026-05-19

Data: 2026-05-19
Escopo: pesquisa oficial Anthropic/Vercel + validacao do codigo Bia/SAB no repo IceLaser.

## Validacao local/LIVE

- Repo: `landing-page`
- HEAD: `8d6ad035f37b22852a44d8f739d67d0c9f99f77f`
- `origin/main`: `8d6ad035f37b22852a44d8f739d67d0c9f99f77f`
- Working tree: somente `PLAN_CORRECOES_17_05_2026.md` untracked.
- `npm test`: 115/115 pass.
- P0 direct path sem auth: hotfix ja aplicado e validado em producao; direct sem token retorna 401.

## Bia ja e Managed Agents

O codigo usa `managed-agents-2026-04-01` em:

- `api/bia-session-create.js`
- `api/bia-direct.js`
- `api/bia-session-poll.js`
- `api/cron/bia-daily-review.js`
- `api/cron/bia-postback.js`
- `api/_lib/session-reuse.js`

`api/cron/bia-skill-refresh.js` usa `skills-2025-10-02`.

Conclusao: nao existe migracao "para Managed Agents"; a Bia ja esta nessa arquitetura. A decisao correta e quais features novas adotar.

## Snapshot Anthropic LIVE sanitizado

Coordinator:

- id: `agent_018zZxrjHftuiePCuJEUNTqL`
- name: `Bia Master Coordinator`
- version: 41
- model: `claude-sonnet-4-6`
- skill: `skill_01VmKCpBmg717nKmCAWgnUYS`, version `latest`
- tools_count: 2
- mcp_count: 0
- updated_at: `2026-05-15T23:24:55.825324Z`

Learning Agent:

- id: `agent_01FjS6Unkb4y8RjnwfuBbAsW`
- name: `Bia Learning Mode FASE 1B`
- version: 6
- model: `claude-sonnet-4-6`
- skills: none
- tools_count: 2
- mcp_count: 0
- updated_at: `2026-05-13T07:00:16.718659Z`

Environment:

- id: `env_01ANo8eEPnZ3P51da4TQz2HR`
- name: `bia-prod-env`
- runtime: null in API response
- networking: null in API response
- created_at: `2026-05-13T02:02:04.131178Z`

Skill versions:

- `skill_version_01SWtSoWt53LXFnhkcoAftAK`, version `1778637927224958`, created `2026-05-13T02:05:28Z`
- `skill_version_01JEcyZuqB2tccGAW1riYiMG`, version `1778639438751697`, created `2026-05-13T02:30:39Z`
- `skill_version_01GpsqaGcRKmFDAngxF1AbEh`, version `1778650253699232`, created `2026-05-13T05:30:54Z`
- `skill_version_01NnoxQUzssX6xPVdy65aJjp`, version `1778656778530150`, created `2026-05-13T07:19:39Z`

Local `.last_synced_version` aponta para a primeira/mais antiga: `skill_version_01SWtSoWt53LXFnhkcoAftAK`.

## Lancamento Anthropic 2026-05-19

Fontes oficiais:

- Anthropic blog: https://claude.com/blog/claude-managed-agents-updates
- Self-hosted Sandboxes: https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes
- MCP Tunnels: https://platform.claude.com/docs/en/agents-and-tools/mcp-tunnels/overview
- Vercel Sandbox for Managed Agents: https://vercel.com/kb/guide/run-claude-managed-agent-tools-with-vercel-sandbox

Novidades:

1. Self-hosted sandboxes for Managed Agents.
   - Orquestracao fica na Anthropic.
   - Execucao de tools roda na infra do cliente ou provider.
   - Providers citados: Cloudflare, Daytona, Modal, Vercel.
   - Util para data residency, redes privadas e controle de runtime.
   - Para Bia agora: nao e prioridade, porque Bia depende de memory stores gerenciados e a stack cloud atual ja funciona.

2. MCP Tunnels.
   - Conecta Claude a MCP servers em rede privada sem expor diretamente a internet.
   - Research Preview / request access.
   - Para Bia agora: nao se aplica, pois Chatwoot/Meta/Vercel ja sao acessiveis por HTTP/token. Futuro: ERP/agenda interna IceLaser.

3. Atualizacao de MCP/tool config em sessao ativa.
   - Reduz necessidade de matar sessoes para ajustar ferramentas.
   - Para Bia: util futuramente em rollout de tool/skill, mas ainda exige plano de rollback.

4. Auto-spill de tool output grande.
   - Outputs grandes viram arquivos no sandbox, com preview para o modelo.
   - Para Bia: ganho indireto em daily review/relatorios, sem patch imediato.

## Features recentes que importam para Bia

### Webhooks Managed Agents

Fonte: https://platform.claude.com/docs/en/managed-agents/webhooks

Pontos validados:

- Webhooks sao criados no Console Anthropic.
- Payload e propositalmente pequeno: `type` e `id`; o handler deve buscar o objeto completo pela API.
- Exemplo oficial usa evento `session.status_idled`.
- Entrega tem assinatura `X-Webhook-Signature`.

Impacto Bia:

- Substitui ou reduz `api/cron/bia-postback.js`.
- Nao implementar usando `session.status_idle` no webhook; esse nome aparece no event stream, mas webhook usa `session.status_idled`.
- Primeiro rodar paralelo com postback como fallback por alguns dias.

### Session event stream

Fonte: https://platform.claude.com/docs/en/managed-agents/events-and-streaming

Pontos:

- Eventos incluem `user.message`, `agent.message`, `agent.tool_use`, `agent.tool_result`, `session.status_idle`, `session.status_terminated`, spans de model usage.
- Usage de spans inclui cache fields, o que bate com eventos reais da Bia com `cache_read_input_tokens`.

Impacto Bia:

- Para observabilidade e postback, melhor buscar eventos da sessao do que depender de created_at da session.

### Dreams

Fonte: https://platform.claude.com/docs/en/managed-agents/dreams

Pontos:

- Research Preview.
- Reorganiza/refina memory stores a partir de experiencias passadas.
- Cria output memory store separado; input nao e modificado diretamente.

Impacto Bia:

- Candidato real para substituir `api/cron/bia-daily-review.js`.
- Nao usar direto em producao: criar PoC paralelo em output store, comparar com daily review manual por 7 dias.

### Memory

Fonte: https://platform.claude.com/docs/en/managed-agents/memory

Pontos:

- Managed Agents tem memory stores como recurso nativo.
- Ha modos de acesso por recurso (`read_only` / `read_write`) na anexacao.

Impacto Bia:

- Hoje o codigo anexa 4 memory stores sem modo explicito.
- Proxima correcao recomendada: `KB_MASTER` como `read_only`; `BIA_LEARNINGS`, `BIA_LEAD_PROFILES`, `BIA_AUDIT_LOG` continuam `read_write` somente onde necessario.

### Outcomes

Fonte: https://platform.claude.com/docs/en/managed-agents/define-outcomes

Pontos:

- Define objetivo/rubrica e deixa o agent tentar ate a avaliacao passar.

Impacto Bia:

- Pode substituir parte da cascade de follow-up no futuro.
- Nao aplicar agora: follow-up atual e deterministico; Outcomes adiciona custo/variabilidade.

### Multi-agent

Fonte: https://platform.claude.com/docs/en/managed-agents/multi-agent

Pontos:

- Coordinator pode delegar a subagents/threads.

Impacto Bia:

- Candidato futuro para separar vendas, suporte, agenda e compliance.
- Nao aplicar em V5.2.2: aumenta custo e superficie de erro antes de estabilizar skill/auth/follow-up.

### Prompt caching e cache diagnostics

Fontes:

- Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Cache diagnostics: https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics

Pontos:

- Docs oficiais de `cache_control` e `cache-diagnostics` estao na area Claude API/Messages.
- Managed Agents ja reporta cache usage em spans/events.

Impacto Bia:

- Nao adicionar `cache_control` em `/v1/sessions` ou `/events` sem confirmar que a API aceita esse campo nesse endpoint.
- Melhor acao agora: medir cache usage dos events e testar qualquer cache_control em staging/smoke isolado antes de deploy.

### Claude Opus 4.7

Fonte: https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7

Impacto Bia:

- Upgrade de qualidade deve ser testado primeiro no Learning/Dreams, nao no Coordinator live.
- Antes de mudar Coordinator: pin de agent/skill, skill cleanup e eval de 20 conversas reais.

## Vercel Sandbox

Fontes:

- Guide Managed Agents + Vercel Sandbox: https://vercel.com/kb/guide/run-claude-managed-agent-tools-with-vercel-sandbox
- Pricing: https://vercel.com/docs/vercel-sandbox/pricing

Impacto Bia:

- Bom para self-hosted tools/data residency.
- Nao e primeira prioridade da Bia porque a dor atual e auth/drift/follow-up/skill, nao runtime de tool.

## Plano revisado para Bia

### V5.2.2b - fazer agora, manual e seguro

1. Corrigir `bia-skill-refresh.js`.
   - `limit=20/50`, ordenar por `created_at` desc.
   - Comparar `.last_synced_version` com `latest.id`, nao com `latest.version`.

2. Corrigir `bia-followup-cascade.js`.
   - Revalidar Chatwoot antes de postar.
   - Se conversa fechada/label terminal/humana recente, limpar ou adiar.

3. Corrigir TTL outgoing.
   - `isOutgoingFromBia` default 60s -> 300s para alinhar com marker TTL.

4. Proteger `GET /api/chatwoot-bot?test=1`.
   - Exigir `CHATWOOT_BOT_INTERNAL_TOKEN` tambem no modo test.

5. Endurecer fail-open pos-POST.
   - Se `kvSet/kvZadd/kvDel/kvZrem` falhar depois de mensagem enviada, logar erro forte e criar marcador de risco.

6. Documentar `.env.example`.
   - Anthropic/Bia/KV/Follow-up/Chatwoot Bot envs sem valores reais.

### V5.2.2c - skill/agent com GO separado

1. Limpar `SKILL.md`.
   - Remover/condicionar sazonal vencido.
   - Corrigir v3/v4.
   - Reduzir hard rules que deixam Haiku/Sonnet literal demais.

2. Re-upload skill.
   - Atualizar `.last_synced_version` para o id novo.

3. Pin agent/skill.
   - Sair de `latest` somente com snapshot e rollback.

### V5.3 - adotar novidades Anthropic com rollout seguro

1. Webhooks em paralelo com `bia-postback`.
   - Handler `api/anthropic-webhook.js`.
   - Evento de webhook: `session.status_idled`.
   - Dedupe por event id.
   - Buscar sessao/eventos completos pela API antes de postar no Chatwoot.
   - Manter cron como fallback por 7 dias.

2. Dreams PoC.
   - Rodar contra BIA_LEARNINGS e ultimas sessoes.
   - Output memory store separado.
   - Promocao manual depois de comparar.

3. Opus 4.7 no Learning/Dreams primeiro.
   - Coordinator so depois de eval e pin.

4. Self-hosted Sandbox/Vercel depois.
   - Apenas se houver necessidade real de data residency/private tools.

## Correcoes contra analise VSCode/Claude Code

- Correto: Bia ja e Managed Agents.
- Correto: P0 direct path sem auth existia e foi corrigido.
- Correto: skill drift monitor esta quebrado.
- Correto: `cache_control` nao existe no codigo.
- Ajuste: cache_control nao deve ser prometido para Managed Agents `/sessions/events` sem contrato/teste; os eventos ja mostram cache nativo.
- Ajuste: webhook event para Console e `session.status_idled`, nao `session.status_idle`.
- Ajuste: `bia-postback` gera 1440 chamadas/dia no projeto primario, nao 12960 chamadas Anthropic/dia, porque `skipIfNotPrimary` evita execucao nos secundarios.
