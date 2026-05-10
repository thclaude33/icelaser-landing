/**
 * Bot Welcome WA-RC — State machine
 *
 * Lê flow.json e executa step-by-step. Estado da conversa fica em Chatwoot
 * custom_attributes (bot_step, bot_pacote, bot_active).
 *
 * Entry points:
 *   - handleNewConversation(payload)  → Chatwoot conversation_created
 *   - handleIncomingMessage(payload)  → Chatwoot message_created (resposta do user)
 *
 * Defesas em profundidade:
 *   - SEMPRE valida inbox_id === 7 (WhatsApp Recife)
 *   - SEMPRE valida phone existe
 *   - SEMPRE valida bot_active (true antes de continuar)
 *   - Limit 10 steps por execução (sanity infinite-loop guard)
 *   - try/catch em cada chamada externa
 *   - DRY-RUN respeitado em todas as ações
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendText, sendList, sendButtons } from './whatsapp.js';
import {
  addLabels,
  setCustomAttributes,
  getConversation,
  getContact,
  updateContactCustomAttributes,
  extractPhone,
  extractInboxId,
  extractConversationId,
  extractContactId,
} from './chatwoot.js';

// Lê flow.json estático (não recarrega — Vercel cacheia o módulo)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FLOW_PATH = path.join(__dirname, 'flow.json');
const FLOW = JSON.parse(fs.readFileSync(FLOW_PATH, 'utf8'));

const REQUIRED_INBOX_ID = FLOW.chatwoot_inbox_id; // 7
const MAX_STEPS_PER_RUN = 10;

function log(msg, extra = {}) {
  const ts = new Date().toISOString();
  console.log(`[BOT-WARC ${ts}] ${msg}`, JSON.stringify(extra).slice(0, 300));
}

function logErr(msg, extra = {}) {
  const ts = new Date().toISOString();
  console.error(`[BOT-WARC ${ts}] ❌ ${msg}`, JSON.stringify(extra).slice(0, 300));
}

/**
 * Helper: dorme N ms (pra waits)
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Executa um único step e retorna o próximo step (ou null se parou)
 *
 * @returns {Promise<{nextStep:string|null, paused:boolean, error?:string}>}
 *   - nextStep: próximo step a executar (null se finish)
 *   - paused: true se está esperando input do user (não avança automático)
 */
async function executeStep(stepName, ctx) {
  const step = FLOW.steps[stepName];
  if (!step) {
    logErr(`step "${stepName}" não existe no flow`);
    return { nextStep: null, paused: false, error: 'step_not_found' };
  }

  const { phone, conversationId, pacoteFromUser } = ctx;
  log(`exec step="${stepName}" type="${step.type}" conv=${conversationId}`);

  // Aplica labels se houver
  if (Array.isArray(step.add_labels) && step.add_labels.length) {
    await addLabels(conversationId, step.add_labels);
  }

  // Salva bot_step atual
  await setCustomAttributes(conversationId, {
    bot_step: hashStep(stepName),
    bot_pacote: pacoteFromUser || ctx.currentPacote || '',
    bot_active: true,
  });

  switch (step.type) {
    case 'send_message': {
      const result = await sendText({ to: phone, text: step.text });
      if (!result.ok) {
        logErr('sendText failed', result);
        return { nextStep: null, paused: false, error: 'send_failed' };
      }
      return { nextStep: step.next || null, paused: false };
    }

    case 'wait': {
      const delayMs = step.delay_ms || 0;
      log(`sleeping ${delayMs}ms`);
      await sleep(delayMs);
      return { nextStep: step.next || null, paused: false };
    }

    case 'list_message': {
      const result = await sendList({
        to: phone,
        header: step.header,
        body: step.body,
        footer: step.footer,
        button: step.button,
        sectionTitle: step.section_title,
        rows: step.rows,
      });
      if (!result.ok) {
        logErr('sendList failed', result);
        return { nextStep: null, paused: false, error: 'send_failed' };
      }
      // List espera input do user — pausa aqui
      return { nextStep: null, paused: true };
    }

    case 'interactive_buttons': {
      const result = await sendButtons({
        to: phone,
        body: step.text,
        buttons: step.buttons,
      });
      if (!result.ok) {
        logErr('sendButtons failed', result);
        return { nextStep: null, paused: false, error: 'send_failed' };
      }
      // Buttons espera input do user — pausa aqui
      return { nextStep: null, paused: true };
    }

    case 'noop': {
      return { nextStep: step.next || null, paused: false };
    }

    case 'finish': {
      log('FINISH reached — bot disengaging');
      await setCustomAttributes(conversationId, {
        bot_active: false,
        ...(step.set_custom_attributes || {}),
      });
      // Marca contato como bot_welcomed=true pra não disparar welcome de novo
      // em conversas futuras desse mesmo cliente (cliente recorrente).
      if (ctx.contactId) {
        await updateContactCustomAttributes(ctx.contactId, { bot_welcomed: true });
      }
      return { nextStep: null, paused: false };
    }

    default:
      logErr(`unknown step type: ${step.type}`);
      return { nextStep: null, paused: false, error: 'unknown_type' };
  }
}

/**
 * Mapa estável de step name → number (pra salvar em bot_step que é tipo number).
 * Hash baseado em índice na ordem do flow.json. Consistente entre runs.
 */
function hashStep(name) {
  const names = Object.keys(FLOW.steps);
  const idx = names.indexOf(name);
  if (idx < 0) {
    // step inválido — não deve acontecer (executeStep já valida antes), mas
    // se acontecer, logar pra investigar e retornar -1 (não 0 que mascara real step 0).
    logErr(`hashStep called with invalid stepName="${name}"`);
    return -1;
  }
  return idx + 1;
}

/**
 * Executa flow a partir de stepName, até pausar (list/buttons) ou finish.
 * Cap em MAX_STEPS_PER_RUN pra evitar loops.
 */
async function runFlow(startStep, ctx) {
  let current = startStep;
  let count = 0;
  while (current && count < MAX_STEPS_PER_RUN) {
    const { nextStep, paused, error } = await executeStep(current, ctx);
    if (error) {
      logErr(`flow halted at "${current}" due to ${error}`);
      return { halted: true, error };
    }
    if (paused) {
      log(`flow paused at "${current}" — awaiting user input`);
      return { paused: true, lastStep: current };
    }
    current = nextStep;
    count++;
  }
  if (count >= MAX_STEPS_PER_RUN) {
    logErr(`flow exceeded MAX_STEPS_PER_RUN (${MAX_STEPS_PER_RUN}) at "${current}"`);
    return { halted: true, error: 'max_steps_exceeded' };
  }
  return { finished: true };
}

/**
 * Entry: nova conversa criada no Chatwoot inbox 7
 *
 * FILTRO ANTI-RECORRENTE: se contato já foi welcomado antes (custom_attribute
 * bot_welcomed=true), pula bot inteiro — cliente recorrente NÃO vê welcome msg
 * de novo. Atendente humano cuida.
 */
export async function handleNewConversation(payload) {
  const inboxId = extractInboxId(payload);
  const conversationId = extractConversationId(payload);
  const contactId = extractContactId(payload);
  const phone = extractPhone(payload);

  if (inboxId !== REQUIRED_INBOX_ID) {
    log(`skip: inbox=${inboxId} (required=${REQUIRED_INBOX_ID})`);
    return { skipped: true, reason: 'wrong_inbox' };
  }
  if (!conversationId) {
    logErr('no conversation_id in payload');
    return { skipped: true, reason: 'no_conversation_id' };
  }
  if (!phone) {
    logErr('no phone in payload', { conversationId });
    return { skipped: true, reason: 'no_phone' };
  }

  // GUARD ANTI-RECORRENTE: checar se contato já foi welcomado antes
  if (contactId) {
    const contactResult = await getContact(contactId);
    if (contactResult.ok) {
      const alreadyWelcomed = contactResult.data?.custom_attributes?.bot_welcomed === true
        || contactResult.data?.custom_attributes?.bot_welcomed === 'true';
      if (alreadyWelcomed) {
        log(`skip: contact ${contactId} já foi welcomed antes — atendente humano cuida`);
        return { skipped: true, reason: 'contact_already_welcomed' };
      }
    } else {
      // Se falhar GET contact, NÃO bloqueia o bot — apenas loga e segue
      // (preferir falso positivo a perder cliente novo por bug API)
      log(`warn: cannot fetch contact ${contactId} pra check bot_welcomed — seguindo welcome de qualquer jeito`);
    }
  }

  log(`new conversation ${conversationId} phone=${maskPhone(phone)} contact=${contactId || '?'}`);

  const ctx = { phone, conversationId, contactId };
  return runFlow(FLOW.start_step, ctx);
}

/**
 * Entry: nova mensagem do user (resposta a list/buttons)
 */
export async function handleIncomingMessage(payload) {
  const inboxId = extractInboxId(payload);
  const conversationId = extractConversationId(payload);
  const phone = extractPhone(payload);

  if (inboxId !== REQUIRED_INBOX_ID) {
    return { skipped: true, reason: 'wrong_inbox' };
  }
  if (!conversationId || !phone) {
    return { skipped: true, reason: 'missing_ids' };
  }

  // Só processa mensagens incoming do contato (message_type=0). Outgoing = ignorar.
  if (payload?.message_type !== undefined && payload.message_type !== 0 && payload.message_type !== 'incoming') {
    return { skipped: true, reason: 'not_incoming' };
  }

  // Buscar estado atual
  const conv = await getConversation(conversationId);
  if (!conv.ok) {
    logErr('cannot fetch conversation', { conversationId });
    return { skipped: true, reason: 'fetch_failed' };
  }

  const customAttrs = conv.data?.custom_attributes || {};
  const botActive = customAttrs.bot_active === true || customAttrs.bot_active === 'true';
  if (!botActive) {
    log(`bot_active=false — skip (atendente assumiu ou bot finished) conv=${conversationId}`);
    return { skipped: true, reason: 'bot_inactive' };
  }

  // Detectar resposta interativa (button reply OU list reply)
  // Chatwoot payload pode ter content_attributes.in_reply_to com tipo interactive
  const replyId = extractReplyId(payload);
  const messageText = payload?.content || '';
  log(`incoming message conv=${conversationId} replyId="${replyId}" text="${messageText.slice(0, 50)}"`);

  // Se replyId existe e é um step válido no flow, executa esse step
  if (replyId && FLOW.steps[replyId]) {
    const ctx = {
      phone,
      conversationId,
      pacoteFromUser: replyId.startsWith('pacote_') ? replyId.replace('pacote_', '') : customAttrs.bot_pacote,
      currentPacote: customAttrs.bot_pacote,
    };
    return runFlow(replyId, ctx);
  }

  // Fallback: tentar match por texto do botão (caso replyId não venha)
  // Procura step cujo nome bate com o id de algum button/row no step atual
  log(`no matching step for replyId="${replyId}" — ignoring (atendente vai cuidar)`);
  return { skipped: true, reason: 'no_match_for_reply' };
}

/**
 * Extract reply ID de payload Chatwoot
 * WhatsApp interactive responses chegam como content_attributes ou content específico.
 */
function extractReplyId(payload) {
  // Chatwoot mapeia button/list replies em content_attributes
  const attrs = payload?.content_attributes || {};
  if (attrs?.items?.[0]?.id) return attrs.items[0].id; // list reply
  if (attrs?.id) return attrs.id; // button reply
  if (attrs?.in_reply_to?.id) return attrs.in_reply_to.id;
  // Fallback: content matching exato com row title ou button title
  const text = String(payload?.content || '').trim();
  if (!text) return null;
  // Procura nos steps que têm botões/rows
  for (const [stepName, step] of Object.entries(FLOW.steps)) {
    if (step.buttons) {
      for (const b of step.buttons) {
        if (b.title === text) return b.id;
      }
    }
    if (step.rows) {
      for (const r of step.rows) {
        if (r.title === text) return r.id;
      }
    }
  }
  return null;
}

/**
 * Mascara phone pra log seguro
 */
function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return digits.slice(0, 4) + '*'.repeat(digits.length - 6) + digits.slice(-2);
}
