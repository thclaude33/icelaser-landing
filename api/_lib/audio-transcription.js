// api/_lib/audio-transcription.js
// Pre-transcribe WhatsApp audio messages BEFORE sending to Bia (Anthropic).
//
// Background (27/05/2026 — incidente conv 615 Janaina):
//   api/whatsapp.js converte áudio em texto literal "🎤 Áudio recebido\n🔗 <blob_url>"
//   e encaminha pro Chatwoot. O Coord agent v48 tem custom tool `transcribe_audio`
//   registrada, mas a Anthropic Managed Agents API NÃO EXPÕE submit_tool_result
//   (validado LIVE 4 endpoints → 404). Logo, qualquer custom tool fica em
//   stop_reason=requires_action sem caminho técnico de resolução, session vira
//   idle sem agent.message, cliente nunca recebe resposta.
//
//   Solução: transcrever server-side ANTES de criar a sessão Anthropic. Bia
//   recebe texto puro ("🎤 Áudio transcrito: ...") e responde normalmente.
//
// Stack: Cloudflare Workers AI Whisper (@cf/openai/whisper-large-v3-turbo).
//   Validado LIVE 27/05/2026 — aceita .ogg/Opus do WhatsApp diretamente, sem
//   conversão ffmpeg. Latência ~1.86s pra áudio de 4.5s. Free tier 10k
//   neurons/dia cobre volume IceLaser (~30-100 áudios/dia).

const AUDIO_MARKER = /🎤\s+Áudio\s+recebido\s*\n🔗\s+(https?:\/\/[^\s]+)/;
const AUDIO_HISTORY_MARKER = /🎤\s+Áudio\s+recebido\s*\n🔗\s+https?:\/\/[^\s]+/g;

// Anti-SSRF: aceitar somente URLs do Vercel Blob público.
// Hostname tem padrão `<random>.public.blob.vercel-storage.com`.
const ALLOWED_HOST_SUFFIX = '.public.blob.vercel-storage.com';

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024; // 15MB ≈ ~15min de Opus 64kbps
const DEFAULT_TIMEOUT_MS = 20_000;
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4/accounts';
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const TRANSCRIPT_PREFIX = '🎤 Áudio transcrito:';
const HISTORY_PLACEHOLDER = '[áudio anterior]';

function envValue(name) {
  return String(process.env[name] || '').trim();
}

function isEnabled() {
  return envValue('BIA_AUDIO_TRANSCRIPTION_ENABLED') === '1';
}

function getMaxBytes() {
  const v = Number(envValue('BIA_AUDIO_TRANSCRIPTION_MAX_BYTES'));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_BYTES;
}

function getTimeoutMs() {
  const v = Number(envValue('BIA_AUDIO_TRANSCRIPTION_TIMEOUT_MS'));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_TIMEOUT_MS;
}

/**
 * Extrai a URL do Blob de áudio do texto da mensagem.
 * Aceita só HTTPS para hosts `*.public.blob.vercel-storage.com`.
 * Retorna `null` se não houver áudio ou se a URL for de host não permitido.
 */
export function extractAudioBlobUrl(text) {
  if (typeof text !== 'string' || !text) return null;
  const m = text.match(AUDIO_MARKER);
  if (!m) return null;
  try {
    const url = new URL(m[1]);
    if (url.protocol !== 'https:') return null;
    if (!url.hostname.endsWith(ALLOWED_HOST_SUFFIX)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function downloadAudio(url) {
  const maxBytes = getMaxBytes();
  const timeoutMs = getTimeoutMs();
  let resp;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    return { ok: false, reason: 'download_error', detail: String(err?.message || err).slice(0, 150) };
  }
  if (!resp.ok) {
    return { ok: false, reason: 'download_http_error', status: resp.status };
  }
  const contentLengthHeader = resp.headers.get('content-length');
  const declaredLength = Number(contentLengthHeader || 0);
  if (declaredLength > 0 && declaredLength > maxBytes) {
    return { ok: false, reason: 'audio_too_large', bytes: declaredLength, max: maxBytes };
  }
  let buf;
  try {
    buf = Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    return { ok: false, reason: 'download_body_error', detail: String(err?.message || err).slice(0, 150) };
  }
  if (buf.length > maxBytes) {
    return { ok: false, reason: 'audio_too_large', bytes: buf.length, max: maxBytes };
  }
  return { ok: true, buffer: buf };
}

async function callWhisper(audioBuffer, language = 'pt') {
  const accountId = envValue('CLOUDFLARE_ACCOUNT_ID');
  const token = envValue('CLOUDFLARE_WORKERS_AI_TOKEN');
  if (!accountId || !token) {
    return { ok: false, reason: 'cloudflare_env_missing' };
  }
  const timeoutMs = getTimeoutMs();
  const body = JSON.stringify({
    audio: audioBuffer.toString('base64'),
    task: 'transcribe',
    language,
  });
  let resp;
  try {
    resp = await fetch(`${CLOUDFLARE_API}/${accountId}/ai/run/${WHISPER_MODEL}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, reason: 'whisper_request_error', detail: String(err?.message || err).slice(0, 150) };
  }
  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    return { ok: false, reason: 'whisper_http_error', status: resp.status, detail: detail.slice(0, 200) };
  }
  let data;
  try {
    data = await resp.json();
  } catch (err) {
    return { ok: false, reason: 'whisper_invalid_response', detail: String(err?.message || err).slice(0, 150) };
  }
  if (!data?.success) {
    const detail = JSON.stringify(data?.errors || data || {}).slice(0, 200);
    return { ok: false, reason: 'whisper_unsuccessful', detail };
  }
  const text = data?.result?.text;
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, reason: 'whisper_empty_text' };
  }
  return { ok: true, text: text.trim() };
}

/**
 * Mensagem segura quando a transcrição falha. Pede pra Bia solicitar texto.
 * Nunca devolve a URL do Blob — evita que a Bia tente chamar a custom tool
 * `transcribe_audio` (sem executor server-side) e trave a sessão.
 */
function failureFallback() {
  return '(Sistema: cliente enviou áudio mas a transcrição automática não funcionou agora. Responda de forma simpática pedindo que ela escreva a mensagem em texto, sem entrar em detalhes técnicos.)';
}

/**
 * Entry point.
 *
 * Recebe o texto cru da mensagem do cliente (formato Chatwoot). Se contiver
 * referência a áudio "🎤 Áudio recebido\n🔗 <blob_url>", baixa o áudio, manda
 * pro Cloudflare Whisper e retorna a transcrição. Caso contrário, retorna o
 * texto original sem alteração.
 *
 * Retorno:
 *   { transcribed: true,  text: '🎤 Áudio transcrito: "<transcript>"' }       ← sucesso
 *   { transcribed: false, text: <original> }                                  ← sem áudio
 *   { transcribed: false, text: <original>, reason: 'feature_disabled' }     ← flag off
 *   { transcribed: false, text: <fallback>, reason: <error_reason> }         ← falhou
 *
 * Garante NUNCA repassar URL de Blob na mensagem entregue à Bia em caso de
 * falha — evita que a Bia tente chamar a custom tool transcribe_audio.
 */
export async function prepareAudioMessageForBia(messageText) {
  const original = String(messageText || '');
  if (!original) return { transcribed: false, text: original };

  const audioUrl = extractAudioBlobUrl(original);
  if (!audioUrl) return { transcribed: false, text: original };

  if (!isEnabled()) {
    return { transcribed: false, text: original, reason: 'feature_disabled' };
  }

  const t0 = Date.now();
  const dl = await downloadAudio(audioUrl);
  if (!dl.ok) {
    console.error(`[BIA-AUDIO] download fail reason=${dl.reason} status=${dl.status || ''}`);
    return { transcribed: false, text: failureFallback(), reason: dl.reason };
  }

  const transcript = await callWhisper(dl.buffer, 'pt');
  if (!transcript.ok) {
    console.error(`[BIA-AUDIO] whisper fail reason=${transcript.reason} status=${transcript.status || ''}`);
    return { transcribed: false, text: failureFallback(), reason: transcript.reason };
  }

  const safeText = transcript.text.replace(/"/g, '\\"');
  console.log(`[BIA-AUDIO] transcribed bytes=${dl.buffer.length} chars=${transcript.text.length} ms=${Date.now() - t0}`);
  return { transcribed: true, text: `${TRANSCRIPT_PREFIX} "${safeText}"` };
}

/**
 * Substitui referências antigas a áudio (`🎤 Áudio recebido\n🔗 <url>`) no
 * histórico Chatwoot por `[áudio anterior]`. Evita que a Bia/Coord veja URLs
 * de Blob de turnos passados e tente chamar a tool `transcribe_audio` retroativamente.
 */
export function sanitizeAudioHistoryReferences(text) {
  if (typeof text !== 'string' || !text) return text;
  return text.replace(AUDIO_HISTORY_MARKER, HISTORY_PLACEHOLDER);
}
