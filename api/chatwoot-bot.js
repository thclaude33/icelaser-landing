/**
 * /api/chatwoot-bot — Endpoint dedicado do bot Welcome WA-RC (Recife)
 *
 * Recebe payloads do Chatwoot via 2 caminhos:
 *   1. Delegação interna do /api/crm-webhook (fire-and-forget)
 *   2. Chamadas diretas pra debug/smoke test (com auth token)
 *
 * Métodos:
 *   GET  /api/chatwoot-bot                      → health check
 *   GET  /api/chatwoot-bot?test=1               → dry-run simulado
 *   POST /api/chatwoot-bot                      → processar payload Chatwoot
 *     ?event=conversation_created               → start flow
 *     ?event=message_created                    → continuar flow
 *
 * Headers necessários (POST):
 *   x-bot-internal-token: process.env.CHATWOOT_BOT_INTERNAL_TOKEN
 *
 * Variáveis de ambiente:
 *   CHATWOOT_BOT_ENABLED         '1' pra ativar (default '0' = desativado)
 *   CHATWOOT_BOT_DRY_RUN         '1' pra modo dry-run (não envia mensagens)
 *   CHATWOOT_BOT_INTERNAL_TOKEN  token pra validar chamadas (mesma string usada pelo crm-webhook)
 *   META_ACCESS_TOKEN            pra enviar WhatsApp Cloud API
 *   CHATWOOT_API_TOKEN           pra Chatwoot Railway (default fallback hard-coded)
 */

import { handleNewConversation, handleIncomingMessage } from './chatwoot-bot/index.js';

export const config = {
  api: { bodyParser: true },
};

const FLOW_VERSION = '1.0.0';

export function checkBotInternalAuth(req) {
  const internalToken = process.env.CHATWOOT_BOT_INTERNAL_TOKEN;
  if (!internalToken) {
    return { ok: false, http: 503, error: 'bot_misconfigured', mode: 'env_missing_fail_closed' };
  }
  const providedToken = req.headers?.['x-bot-internal-token'];
  if (providedToken !== internalToken) {
    return { ok: false, http: 401, error: 'unauthorized', mode: 'missing_or_invalid' };
  }
  return { ok: true, mode: 'x_bot_internal_token' };
}

export default async function handler(req, res) {
  // ──────────────────────────────────────────────────────────────
  // GET: health check + dry-run test
  // ──────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const enabled = process.env.CHATWOOT_BOT_ENABLED === '1';
    const dryRun = process.env.CHATWOOT_BOT_DRY_RUN === '1';

    const healthResp = {
      ok: true,
      service: 'chatwoot-bot',
      flow_version: FLOW_VERSION,
      enabled,
      dry_run: dryRun,
      timestamp: new Date().toISOString(),
    };

    // Modo test: dispara handleNewConversation com payload mock
    if (req.query?.test === '1') {
      const auth = checkBotInternalAuth(req);
      if (!auth.ok) {
        if (auth.http === 503) {
          console.error('[CHATWOOT-BOT] CHATWOOT_BOT_INTERNAL_TOKEN not set — test fail-closed');
        } else {
          console.warn('[CHATWOOT-BOT] unauthorized GET test attempt');
        }
        return res.status(auth.http).json({ ...healthResp, test: true, error: auth.error, detail: auth.mode });
      }
      const mockPayload = {
        event: 'conversation_created',
        id: 999999,
        inbox_id: 7,
        meta: {
          sender: {
            phone_number: '+5581999999999', // fake number, NÃO vai enviar real em DRY-RUN
            name: 'TEST USER',
          },
        },
      };
      try {
        const result = await handleNewConversation(mockPayload);
        return res.status(200).json({ ...healthResp, test: true, result });
      } catch (e) {
        return res.status(500).json({ ...healthResp, test: true, error: e.message, stack: e.stack?.split('\n').slice(0, 5) });
      }
    }

    return res.status(200).json(healthResp);
  }

  // ──────────────────────────────────────────────────────────────
  // POST: processar payload do Chatwoot
  // ──────────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Validar token interno (fail-safe: rejeita se env var não configurada).
  // Antes: `if (internalToken && providedToken !== internalToken)` permitia
  // bypass quando CHATWOOT_BOT_INTERNAL_TOKEN não setada — buraco de segurança.
  // Agora: token OBRIGATÓRIO no Vercel. Sem token configurado = 503 fail-closed.
  const auth = checkBotInternalAuth(req);
  if (!auth.ok && auth.http === 503) {
    console.error('[CHATWOOT-BOT] CHATWOOT_BOT_INTERNAL_TOKEN not set — fail-closed');
    return res.status(503).json({ error: 'bot_misconfigured' });
  }
  if (!auth.ok) {
    console.warn('[CHATWOOT-BOT] unauthorized POST attempt');
    return res.status(401).json({ error: 'unauthorized' });
  }

  // Validar bot habilitado
  if (process.env.CHATWOOT_BOT_ENABLED !== '1') {
    console.log('[CHATWOOT-BOT] disabled via env, skipping');
    return res.status(200).json({ ok: true, skipped: true, reason: 'bot_disabled' });
  }

  const event = req.query?.event || req.body?.event;
  const payload = req.body || {};

  console.log(`[CHATWOOT-BOT] POST event=${event} conv=${payload.id || payload.conversation?.id || '?'} inbox=${payload.inbox_id || payload.inbox?.id || '?'}`);

  try {
    let result;
    if (event === 'conversation_created') {
      result = await handleNewConversation(payload);
    } else if (event === 'message_created') {
      result = await handleIncomingMessage(payload);
    } else {
      return res.status(200).json({ ok: true, skipped: true, reason: 'unhandled_event', event });
    }
    return res.status(200).json({ ok: true, event, result });
  } catch (e) {
    console.error('[CHATWOOT-BOT] handler error:', e.message, e.stack?.split('\n').slice(0, 3));
    // Sempre retornar 200 pra não fazer Chatwoot tentar redeliverar e poluir CAPI
    return res.status(200).json({ ok: false, error: e.message });
  }
}
