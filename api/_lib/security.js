/**
 * Utilitários de segurança compartilhados.
 */

import crypto from 'crypto';

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

/**
 * Fix MEDIUM AI deep v3 (security.js:8): sha256 case-preserving pra external_id
 * e outros valores case-sensitive (IDs, tokens). Meta spec external_id: preserve case.
 */
export function sha256Preserve(value) {
  return crypto.createHash('sha256').update(String(value).trim()).digest('hex');
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
 *
 * Fix LOW AI deep v3 (security.js:77): SEMPRE faz comparação constant-time mesmo
 * quando lengths diferem. Antes: early return revelava length via timing diff.
 * Agora: pad buffers ao max length, comparação sempre igual + flag separada.
 */
export function timingSafeStringEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  const maxLen = Math.max(ab.length, bb.length, 1);
  const pa = Buffer.alloc(maxLen);
  const pb = Buffer.alloc(maxLen);
  ab.copy(pa);
  bb.copy(pb);
  const sameLength = ab.length === bb.length;
  const constantTimeMatch = crypto.timingSafeEqual(pa, pb);
  return sameLength && constantTimeMatch;
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
  // Fix INFO AI deep v3 (security.js:146): handle "55 0081 99999..." edge case.
  // Input assim vira "550081999...". Strip zeros após 55 quando DDD inválido.
  if (digits.startsWith('55') && digits.length > 12) {
    // Rechecar: se após "55" vem "00..." strip os zeros do DDD (padding DDI errado).
    const afterPrefix = digits.slice(2).replace(/^0+/, '');
    digits = `55${afterPrefix}`;
  }
  // Se já tem prefixo 55 + DDD válido (11-99) — mantém.
  if (digits.startsWith('55') && digits.length >= 12 && digits.length <= 13) {
    const ddd = parseInt(digits.slice(2, 4), 10);
    if (ddd >= 11 && ddd <= 99) {
      // Fix LOW AI deep v3 (security.js:147): validar min length após normalização.
      // BR fixo = 12 chars (55+DDD+8), cel = 13 chars (55+DDD+9). < 12 = inválido.
      return digits;
    }
  }
  const result = `55${digits.replace(/^55/, '')}`; // evita 5555... se re-normalizar
  // Validação final: resultado precisa ter 12 ou 13 chars. Menos = input inválido.
  if (result.length < 12 || result.length > 13) {
    // Input não contém dígitos válidos — retorna null em vez de string inválida
    return null;
  }
  return result;
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

/**
 * Sanitiza header SMTP — remove CR/LF pra prevenir header injection (CRLF).
 * Uso obrigatório em subject, from name, to, replyTo, cc, bcc quando
 * o valor pode conter user input.
 *
 * Nodemailer recente (pós 6.6.1) valida address object, mas NÃO valida
 * subject nem name do from. Envelope.size + transport.name vulneráveis
 * em 8.0.4 (CVE-2026). Defesa em profundidade: sanitizar SEMPRE.
 *
 * @param {string} str - valor do header
 * @param {number} maxLen - tamanho máximo (subject ≤ 998 chars RFC 5322; na prática ≤ 100)
 */
export function sanitizeHeader(str, maxLen = 200) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/[\r\n\t\v\f\0]/g, ' ')  // todos whitespace ctl chars viram espaço
    .replace(/\s+/g, ' ')              // colapsa múltiplos espaços
    .trim()
    .slice(0, maxLen);
}

/**
 * Valida URL pra uso em href= em email HTML — só permite http(s): e mailto:.
 * javascript:, data:, vbscript: são vetores XSS clássicos em clients HTML
 * (Gmail bloqueia a maioria mas defesa em profundidade).
 *
 * @param {string} url
 * @returns {string} URL safe ou string vazia (href="" renderiza sem link)
 */
export function sanitizeUrl(url) {
  if (!url) return '';
  const trimmed = String(url).trim();
  // Matches protocolo válido: http://, https://, mailto:, tel:, whatsapp://
  // case-insensitive + trim prevent newlines/tabs bypass
  if (/^(https?:|mailto:|tel:|whatsapp:)/i.test(trimmed)) {
    return trimmed.replace(/[\r\n\t]/g, '');  // strip ctrl chars mesmo em URL válida
  }
  return '';
}
