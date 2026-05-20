# Bia P0 - Internal Message Leak Guard Plan

Date: 2026-05-20
Status: investigation validated, patch not yet applied
Severity: P0

## Incident

An internal compliance/audit alert intended for operations was selected as the customer-facing Bia response and sent through the Chatwoot/WhatsApp path.

Observed pattern:

- Bia produced a short valid customer response.
- Bia then used tools to update internal state/audit.
- Bia produced a long internal alert after the tool calls.
- The handler selected the last `agent.message` after the last `agent.tool_use`.
- That internal alert was posted to Chatwoot as an outgoing customer message.

## Root Cause

The system currently treats any `agent.message` as a possible customer response and uses heuristics to choose one:

- Prefer the last `agent.message` after the last `agent.tool_use`.
- Fallback to the longest `agent.message`.
- Filter only short profile/meta confirmations.

This is fail-open. If the agent emits internal content as `agent.message`, the handler may post it to the customer.

## Affected Files

The vulnerable selection logic is duplicated in:

- `api/bia-session-create.js`
- `api/bia-direct.js`
- `api/cron/bia-postback.js`

Also relevant:

- `api/bia-session-poll.js` exposes the last `agent.message` to authenticated tooling; it should use the same safe extraction so operators do not see ambiguous/internal content as the Bia response.

## Why Skill Patch Alone Is Not Enough

The code already documents a prior soft fix where the managed-agent instructions told Bia not to emit `agent.message` after tool use. The incident still happened. A skill instruction reduces probability; it does not create a deterministic boundary.

The reliable fix is a hard contract enforced by code:

- Client-facing text must be explicitly marked.
- Internal/audit text must never be posted if the marker is missing or ambiguous.
- Internal-looking content must be blocked even if the agent violates the contract.

## Correct Fix

Create a shared extractor in `api/_lib/bia-client-response.js` and use it everywhere.

Behavior:

1. Prefer explicit client delimiters:
   - `<resposta_cliente>...</resposta_cliente>`
   - optionally support `<para_cliente>...</para_cliente>` as an alias.

2. If delimiter is present:
   - extract only the delimited body.
   - reject if empty, too short, or internal-looking.

3. If no delimiter is present:
   - temporary compatibility mode:
     - inspect current-turn `agent.message` events.
     - filter meta/internal-looking content.
     - choose the safest candidate.
   - fail closed if all candidates are ambiguous or internal-looking.

4. Guard internal content:
   - block audit/report headings, tables, file paths, internal recipient names, debug terms, operational checklists, code paths, stack words, and "alerta interno" patterns.

5. Return structured result:
   - `{ ok: true, text, agentMsgIdx, source }`
   - `{ ok: false, reason, blockedTextPreview }`

6. Callers must never post blocked content.
   - `bia-session-create.js`: if blocked, post a fixed safe fallback or no message, and log a P0 alert internally.
   - `bia-direct.js`: same extraction and block behavior.
   - `bia-postback.js`: skip posting and record `skipped_internal_content`.
   - `bia-session-poll.js`: return the safe extracted response or `blocked_internal_content`, not raw last message.

## Final Refinements From Cross-Review

These refinements are required in the P0 commit.

### A. High-precision guard only

The internal-content guard must be pattern-based, never a loose keyword blacklist.

Allowed legitimate examples:

- `Oi Vitória! 💜 Tudo bem?`
- `Oi! 💜`
- `Perfeito`
- `Amanhã às 14h dá certo`
- `R$297 | 12x sem juros`

Blocked examples:

- `⚠️ Alerta interno`
- `Vitória precisa ver isso`
- `/bia-audit-log/...`
- `last_followup_step`
- `shouldSendNow()`
- `pollSessionForResponse`
- markdown audit table separator such as `|---|---|`
- large operational reports with headings like `Violações detectadas`, `Status do cliente`, `Recomendação interna`.

Do not block a normal customer reply just because it contains the word `Vitória`, a pipe character, a short sentence, or an emoji.

### B. Compatibility mode is load-bearing

Until the managed-agent skill is patched to always emit `<resposta_cliente>...</resposta_cliente>`, production traffic will rely on compatibility mode.

Compatibility mode rule:

1. Collect current-turn `agent.message` events after the baseline event index when available.
2. Remove empty/meta/internal-looking candidates.
3. If exactly one safe candidate remains, use it.
4. If multiple safe candidates remain, choose the first safe candidate from the turn, not the last and not the longest.
5. If no safe candidate remains, fail closed.

This specifically fixes the observed incident where the correct short reply came first and the internal audit came later after tool calls.

### C. Fail-closed must not leave reactive customers silent

For reactive paths, failing closed must not create a no-response customer experience.

- `bia-session-create.js`: if extraction is blocked/ambiguous, post a fixed safe fallback instead of the blocked content.
- `bia-direct.js`: return the fixed safe fallback in the API response instead of blocked content.
- `bia-postback.js`: if it owns the only pending response path for that turn, post the fixed safe fallback or raise a real internal alert for human takeover. Do not only increment a stats counter.
- `bia-session-poll.js`: return `blocked_internal_content` and a safe fallback field; never return the raw internal text as `bia_response`.

Suggested fallback:

`Oi! 💜 Tô aqui. Me conta o que precisar.`

The fallback must also get a per-turn dedup key.

### E. Consolidate existing duplicate extractors

`extractClientResponse` already exists twice and must be removed from the callers:

- `api/bia-session-create.js`
- `api/cron/bia-postback.js`

Both currently return `text.trim()` and are not safe. The new shared helper replaces them. Do not leave old local copies alive, or the codebase will split-brain again.

`api/bia-direct.js` and `api/bia-session-poll.js` must also use the same helper.

### F. Blocked-result dedup must stay per-turn

When extraction fails closed, the result must still carry the best relevant `agentMsgIdx` or `blockedAgentMsgIdx`.

Reason: session reuse already had a historical dedup bug when falling back to `sess_${sessionId}`. A blocked fallback response must not dedup against an older turn in the same reused session.

Required shape:

- success: `{ ok: true, text, agentMsgIdx, source }`
- blocked: `{ ok: false, reason, blockedAgentMsgIdx, blockedTextPreview }`

Callers must use that event index when building the dedup key for the fallback/blocked turn.

### D. Follow-up outside P0

Move Bia's self-audit/compliance-review behavior out of the customer-facing Coordinator and into an offline process.

This is required follow-up work, but not part of the P0 hotfix. The P0 hotfix is the deterministic output guard.

## Skill Contract Patch

After code guard is live, patch the managed-agent skill/instructions:

- `agent.message` must contain only the customer-facing reply.
- Customer-facing reply must be wrapped in `<resposta_cliente>...</resposta_cliente>`.
- Internal audit/compliance observations must go only to the approved audit-log tool or profile/internal storage.
- Never print "Vitória", audit reports, file paths, tables, implementation notes, or internal recommendations in the customer message.

The code guard remains permanent even after the skill patch.

## Tests Required

Add tests for the shared extractor:

- extracts delimited response and ignores internal text after it.
- blocks "Alerta interno" report.
- blocks markdown audit tables.
- blocks `/bia-audit-log/...` paths.
- blocks "Vitória precisa ver isso".
- blocks `last_followup_step`, `shouldSendNow`, `handler Vercel`, code/file-path terms.
- compatibility mode selects a normal customer reply when no delimiter exists.
- compatibility mode fails closed when only internal content exists.
- post-tool internal alert cannot beat earlier customer reply.
- longest internal report cannot beat shorter customer reply.
- legitimate short replies are allowed.
- legitimate customer named `Vitória` is allowed.
- legitimate price/table-like text with a single `|` is allowed.
- markdown audit table separator `|---|---|` is blocked.
- compatibility mode chooses the first safe current-turn reply when a later internal report exists.
- blocked result carries a usable event index for per-turn fallback dedup.

Add integration coverage for:

- `bia-session-create.js`
- `bia-direct.js`
- `cron/bia-postback.js`
- `bia-session-poll.js`

## Validation Commands

Preflight:

```bash
cd "/Users/grupoice/Desktop/claude/vs code/landing-page"
git status --short
git rev-parse HEAD
git rev-parse origin/main
node --check api/bia-session-create.js
node --check api/bia-direct.js
node --check api/cron/bia-postback.js
node --check api/bia-session-poll.js
npm test
```

After patch:

```bash
node --check api/_lib/bia-client-response.js
node --check api/bia-session-create.js
node --check api/bia-direct.js
node --check api/cron/bia-postback.js
node --check api/bia-session-poll.js
node --test tests/bia-client-response.test.js
npm test
git diff --check
```

Optional live verification after deploy:

```bash
curl -sS "https://www.icelasers.com.br/api/health" -m 10 -w "\nHTTP=%{http_code}\n"
curl -sS "https://jpa.icelasers.com.br/api/health" -m 10 -w "\nHTTP=%{http_code}\n"
curl -sS "https://icelaser-landing.vercel.app/api/health" -m 10 -w "\nHTTP=%{http_code}\n"
```

Do not trigger real customer sends during validation.

## Deploy Order

1. Code guard + shared extractor.
2. Tests green.
3. Deploy.
4. Skill contract patch.
5. Optional live smoke using a controlled test conversation only.

## Non-Goals

- Do not change follow-up cadence in this patch.
- Do not alter Chatwoot auth in this patch.
- Do not touch JPA/Kommo/CAPI.
- Do not rely on a skill instruction as the only protection.
