/**
 * WhatsApp Cloud API helpers (Recife)
 *
 * Envia mensagens nativas via WABA Recife (920807647253970) pra phone_number_id
 * 1140709345781659 (+55 81 99574-9947). Suporta text, interactive buttons (max 3)
 * e interactive list_message (até 10 rows).
 *
 * REGRA DE OURO: sempre logar [WA-BOT] com status code + Meta messages.id.
 * Sem await ao retorno: caller decide se aguarda.
 *
 * DRY-RUN: se process.env.CHATWOOT_BOT_DRY_RUN === '1', NÃO envia — só loga
 * o payload que seria enviado. Pra smoke test em produção sem afetar leads reais.
 */

const PHONE_NUMBER_ID = '1140709345781659';
const GRAPH_BASE = 'https://graph.facebook.com/v25.0';

/**
 * Sanitiza phone pra formato Meta E.164 sem '+' (ex: '5581995749947')
 */
function sanitizePhone(raw) {
  return String(raw || '').replace(/\D/g, '');
}

/**
 * Truncate text safely (WhatsApp tem limites estritos em CHARS REAIS, não UTF-16 code units)
 *
 * BUG fixado: `.length` e `.slice` de string JS contam UTF-16 code units.
 * Emoji multi-codepoint (ex: 💜 = surrogate pair, 2 code units) era contado errado.
 * Resultado: "Sim, quero agendar 💜" (20 chars reais) tinha .length=21 → truncava
 * adicionando "…" pos-19, DESTRUINDO o emoji. WhatsApp recebia "Sim, quero agendar …"
 * e quando user clicava button, content do echo perdia o 💜 → fuzzy match falhava.
 *
 * Fix: Array.from(str) itera CODE POINTS reais (emoji 💜 = 1 elemento).
 */
function truncate(s, max) {
  const str = String(s || '');
  const codePoints = Array.from(str);
  if (codePoints.length <= max) return str;
  return codePoints.slice(0, max - 1).join('') + '…';
}

/**
 * POST genérico pra Graph API com retry simples em 5xx transientes
 */
async function postWhatsApp(payload, retryCount = 0) {
  const token = process.env.META_ACCESS_TOKEN;
  if (!token) {
    return { ok: false, error: 'META_ACCESS_TOKEN missing' };
  }

  const dryRun = process.env.CHATWOOT_BOT_DRY_RUN === '1';
  if (dryRun) {
    console.log('[WA-BOT DRY-RUN] payload:', JSON.stringify(payload).slice(0, 500));
    return { ok: true, dryRun: true, messageId: 'dry-run-fake-id' };
  }

  const url = `${GRAPH_BASE}/${PHONE_NUMBER_ID}/messages`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error('[WA-BOT] network error:', e.message);
    return { ok: false, error: 'network', detail: e.message };
  }

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    console.error(`[WA-BOT] non-JSON response (${res.status}):`, rawText.slice(0, 200));
    return { ok: false, status: res.status, error: 'non-json', body: rawText.slice(0, 200) };
  }

  if (data.error) {
    const isTransient = res.status >= 500 || data.error.is_transient;
    console.error(`[WA-BOT ERROR] code=${data.error.code} msg=${data.error.message} status=${res.status}`);
    if (isTransient && retryCount < 2) {
      const delay = (retryCount + 1) * 1000;
      console.log(`[WA-BOT] retry in ${delay}ms (attempt ${retryCount + 1}/2)`);
      await new Promise(r => setTimeout(r, delay));
      return postWhatsApp(payload, retryCount + 1);
    }
    return { ok: false, status: res.status, error: data.error };
  }

  const messageId = data?.messages?.[0]?.id || null;
  console.log(`[WA-BOT] sent ${payload.type || 'unknown'} → ${messageId || '?'}`);
  return { ok: true, messageId, status: res.status };
}

/**
 * Envia texto simples
 */
export async function sendText({ to, text }) {
  return postWhatsApp({
    messaging_product: 'whatsapp',
    to: sanitizePhone(to),
    type: 'text',
    text: { preview_url: false, body: truncate(text, 4096) },
  });
}

/**
 * Envia interactive list_message (até 10 rows organizadas em sections)
 *
 * @param {Object} opts
 * @param {string} opts.to - phone E.164 sem +
 * @param {string} opts.header - max 60 chars (texto cabeçalho)
 * @param {string} opts.body - max 1024 chars (corpo)
 * @param {string} opts.footer - max 60 chars
 * @param {string} opts.button - max 20 chars (texto do botão que abre a lista)
 * @param {string} opts.sectionTitle - max 24 chars
 * @param {Array<{id:string, title:string, description?:string}>} opts.rows
 */
export async function sendList({ to, header, body, footer, button, sectionTitle, rows }) {
  const payload = {
    messaging_product: 'whatsapp',
    to: sanitizePhone(to),
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: truncate(body, 1024) },
      action: {
        button: truncate(button, 20),
        sections: [
          {
            title: truncate(sectionTitle, 24),
            rows: (rows || []).slice(0, 10).map(r => ({
              id: truncate(r.id, 200),
              title: truncate(r.title, 24),
              description: r.description ? truncate(r.description, 72) : undefined,
            })),
          },
        ],
      },
    },
  };
  if (header) payload.interactive.header = { type: 'text', text: truncate(header, 60) };
  if (footer) payload.interactive.footer = { text: truncate(footer, 60) };

  return postWhatsApp(payload);
}

/**
 * Envia interactive buttons (até 3 quick reply buttons)
 *
 * @param {Object} opts
 * @param {string} opts.to
 * @param {string} opts.body - max 1024 chars
 * @param {string} opts.footer - opcional
 * @param {Array<{id:string, title:string}>} opts.buttons - max 3
 */
export async function sendButtons({ to, body, footer, buttons }) {
  const payload = {
    messaging_product: 'whatsapp',
    to: sanitizePhone(to),
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: truncate(body, 1024) },
      action: {
        buttons: (buttons || []).slice(0, 3).map(b => ({
          type: 'reply',
          reply: {
            id: truncate(b.id, 256),
            title: truncate(b.title, 20),
          },
        })),
      },
    },
  };
  if (footer) payload.interactive.footer = { text: truncate(footer, 60) };

  return postWhatsApp(payload);
}
