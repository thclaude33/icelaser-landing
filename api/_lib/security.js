/**
 * Utilitários de segurança compartilhados.
 */

import crypto from 'crypto';

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

/**
 * Valida assinatura HMAC-SHA256 simples (sem timestamp).
 * Compatível com Meta WhatsApp (X-Hub-Signature-256): HMAC(secret, body).
 * @param {Buffer|string} rawBody - body cru (antes do JSON.parse)
 * @param {string} signature - header recebido (com ou sem prefixo 'sha256=')
 * @param {string} secret - segredo compartilhado
 */
export function verifyHmacSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;

  const sigValue = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  // Validar formato hex ESTRITO antes do Buffer.from — ele é tolerante a chars
  // não-hex (ignora silenciosamente), o que aceita signatures corrompidas.
  if (!/^[a-f0-9]{64}$/i.test(sigValue)) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

  try {
    const sigBuf = Buffer.from(sigValue, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

/**
 * Valida assinatura Chatwoot (formato oficial v3.x).
 * Formato: X-Chatwoot-Signature: sha256=HMAC-SHA256(secret, "{timestamp}.{body}")
 * Docs: https://www.chatwoot.com/hc/user-guide/articles/1677693021-how-to-use-webhooks
 *
 * @param {Buffer} rawBody - body cru
 * @param {string} signature - valor do header X-Chatwoot-Signature (com prefixo sha256=)
 * @param {string} timestamp - valor do header X-Chatwoot-Timestamp (Unix seconds)
 * @param {string} secret - segredo configurado no webhook
 * @param {number} maxAgeSeconds - rejeita timestamps mais antigos que isso (anti-replay). Default 300s (5min).
 */
export function verifyChatwootSignature(rawBody, signature, timestamp, secret, maxAgeSeconds = 300) {
  if (!secret || !signature || !timestamp) return false;

  // Anti-replay: rejeita requests com timestamp muito antigo
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > maxAgeSeconds) return false;

  const sigValue = signature.startsWith('sha256=') ? signature.slice(7) : signature;
  // Validar hex estrito antes do Buffer.from (ver comentário em verifyHmacSignature).
  if (!/^[a-f0-9]{64}$/i.test(sigValue)) return false;
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  const payload = `${timestamp}.${bodyStr}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  try {
    const sigBuf = Buffer.from(sigValue, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

/**
 * Comparação timing-safe de strings (verify_token, etc).
 */
export function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Mascara PII em logs (LGPD compliance).
 */
export function maskPhone(phone) {
  if (!phone) return '';
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `${digits.slice(0, 4)}****${digits.slice(-2)}`;
}

export function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${local[0] || '*'}***@${domain}`;
}

export function maskName(name) {
  if (!name) return '';
  const parts = String(name).trim().split(/\s+/);
  return parts[0] || '***';
}

/**
 * Lê body cru (Buffer) do request. Necessário pra validar HMAC.
 * Requer `export const config = { api: { bodyParser: false } }` no handler.
 */
export function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    req.on('data', (c) => chunks.push(Buffer.from(c)));
    req.on('end', () => settle(resolve, Buffer.concat(chunks)));
    req.on('error', (e) => settle(reject, e));
    // Edge case: cliente aborta connection no meio da request (TCP FIN/RST).
    // Sem este handler o Promise nunca resolve/reject → handler hang + timeout
    // da function a 30s. Tratar como erro pra falhar cedo.
    req.on('aborted', () => settle(reject, new Error('Request aborted')));
    req.on('close', () => {
      if (!settled) settle(reject, new Error('Connection closed before end'));
    });
  });
}

/**
 * Normaliza telefone BR pro formato E.164 sem prefixo '+' (só dígitos).
 *
 * Regras:
 *  1. Strip non-digits
 *  2. Remove leading zeros (prefixo internacional "00" ou DDI zero — ex: "005511999")
 *  3. Se já começa com "55" + DDD brasileiro válido (11-99) → mantém
 *  4. Senão → prefixa "55"
 *
 * Casos cobertos:
 *  "81999990000"       → "5581999990000"  (sem DDI)
 *  "5581999990000"     → "5581999990000"  (com DDI, correto)
 *  "+55 81 99999-0000" → "5581999990000"  (formato humano)
 *  "0055 81 99999..."  → "5581999990000"  (prefixo internacional)
 *  "55 0081 99999..."  → "5581999990000"  (DDI com zero — ajuste edge)
 */
export function normalizePhoneBR(phone) {
  let digits = String(phone).replace(/\D/g, '').replace(/^0+/, '');
  // Se já tem prefixo 55 + DDD válido (11-99) — mantém.
  // DDD brasileiro é 2º e 3º dígitos depois de 55. Valid range: 11-99 (exclui 00,01-10).
  if (digits.startsWith('55') && digits.length >= 12 && digits.length <= 13) {
    const ddd = parseInt(digits.slice(2, 4), 10);
    if (ddd >= 11 && ddd <= 99) return digits;
  }
  return `55${digits}`;
}

/**
 * Escapa HTML pra prevenir XSS em templates de email.
 * Uso: `<strong>${escapeHtml(nome)}</strong>` nos templates de enviarEmail.
 *
 * Atendentes IceLaser recebem emails dos forms; user podia injetar
 * <script>, <img onerror>, etc via campos nome/email/telefone. Fix previne
 * renderização de HTML malicioso nos clients Gmail/Outlook/Apple Mail.
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;');
}
