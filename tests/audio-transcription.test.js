import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractAudioBlobUrl,
  prepareAudioMessageForBia,
  sanitizeAudioHistoryReferences,
} from '../api/_lib/audio-transcription.js';

// ---------- helpers ----------
const ENV_KEYS = [
  'BIA_AUDIO_TRANSCRIPTION_ENABLED',
  'BIA_AUDIO_TRANSCRIPTION_MAX_BYTES',
  'BIA_AUDIO_TRANSCRIPTION_TIMEOUT_MS',
  'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_WORKERS_AI_TOKEN',
];

function snapshotEnv() {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap) {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
}
function setupEnv({ enabled = true, maxBytes, timeoutMs } = {}) {
  if (enabled) process.env.BIA_AUDIO_TRANSCRIPTION_ENABLED = '1';
  else delete process.env.BIA_AUDIO_TRANSCRIPTION_ENABLED;
  process.env.CLOUDFLARE_ACCOUNT_ID = 'test-account';
  process.env.CLOUDFLARE_WORKERS_AI_TOKEN = 'test-token';
  if (maxBytes !== undefined) process.env.BIA_AUDIO_TRANSCRIPTION_MAX_BYTES = String(maxBytes);
  else delete process.env.BIA_AUDIO_TRANSCRIPTION_MAX_BYTES;
  if (timeoutMs !== undefined) process.env.BIA_AUDIO_TRANSCRIPTION_TIMEOUT_MS = String(timeoutMs);
  else delete process.env.BIA_AUDIO_TRANSCRIPTION_TIMEOUT_MS;
}

function fakeBlobResp(buf, headers = {}) {
  const h = new Map();
  h.set('content-type', headers['content-type'] || 'audio/ogg');
  if (headers['content-length'] !== undefined) h.set('content-length', String(headers['content-length']));
  return {
    ok: true,
    status: 200,
    headers: { get: (k) => h.get(String(k).toLowerCase()) || null },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
  };
}
function fakeWhisperOk(text) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: { text }, errors: [] }),
    text: async () => '',
  };
}
function fakeWhisperHttpFail(status) {
  return {
    ok: false,
    status,
    text: async () => `whisper error ${status}`,
    json: async () => ({}),
  };
}
function fakeWhisperUnsuccessful() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ success: false, errors: [{ message: 'invalid format' }] }),
    text: async () => '',
  };
}

const VALID_AUDIO_TEXT =
  '🎤 Áudio recebido\n🔗 https://m9l85zfzwaaraaia.public.blob.vercel-storage.com/media/558799665726/1779891143711_audio.ogg';

// ---------- extractAudioBlobUrl ----------
test('extractAudioBlobUrl detecta URL Blob válida', () => {
  assert.equal(
    extractAudioBlobUrl(VALID_AUDIO_TEXT),
    'https://m9l85zfzwaaraaia.public.blob.vercel-storage.com/media/558799665726/1779891143711_audio.ogg',
  );
});

test('extractAudioBlobUrl rejeita URL externa (anti-SSRF)', () => {
  const text = '🎤 Áudio recebido\n🔗 https://evil.example.com/foo.ogg';
  assert.equal(extractAudioBlobUrl(text), null);
});

test('extractAudioBlobUrl rejeita hostname similar mas não permitido', () => {
  // host fake querendo enganar o suffix match
  const text = '🎤 Áudio recebido\n🔗 https://public.blob.vercel-storage.com.evil.com/x.ogg';
  assert.equal(extractAudioBlobUrl(text), null);
});

test('extractAudioBlobUrl rejeita HTTP (não-HTTPS)', () => {
  const text = '🎤 Áudio recebido\n🔗 http://x.public.blob.vercel-storage.com/foo.ogg';
  assert.equal(extractAudioBlobUrl(text), null);
});

test('extractAudioBlobUrl retorna null para texto comum / vazio / null', () => {
  assert.equal(extractAudioBlobUrl('Oi, tudo bem?'), null);
  assert.equal(extractAudioBlobUrl(''), null);
  assert.equal(extractAudioBlobUrl(null), null);
  assert.equal(extractAudioBlobUrl(undefined), null);
});

// ---------- sanitizeAudioHistoryReferences ----------
test('sanitizeAudioHistoryReferences substitui refs antigas por [áudio anterior]', () => {
  const input = [
    '[10:00] CLIENTE: Oi',
    '[10:01] CLIENTE: 🎤 Áudio recebido',
    '🔗 https://m9l85zfzwaaraaia.public.blob.vercel-storage.com/media/x/a.ogg',
    '[10:02] BIA: Tudo bem!',
  ].join('\n');
  const out = sanitizeAudioHistoryReferences(input);
  assert.match(out, /\[áudio anterior\]/);
  assert.equal(out.includes('m9l85zfzwaaraaia'), false);
  assert.equal(out.includes('🔗'), false);
});

test('sanitizeAudioHistoryReferences preserva texto sem refs', () => {
  const input = '[10:00] CLIENTE: Oi, quero info';
  assert.equal(sanitizeAudioHistoryReferences(input), input);
});

test('sanitizeAudioHistoryReferences trata input vazio/null', () => {
  assert.equal(sanitizeAudioHistoryReferences(''), '');
  assert.equal(sanitizeAudioHistoryReferences(null), null);
});

// ---------- prepareAudioMessageForBia ----------
test('prepareAudioMessageForBia no-op para texto comum', async () => {
  const r = await prepareAudioMessageForBia('Oi, tudo bem?');
  assert.equal(r.transcribed, false);
  assert.equal(r.text, 'Oi, tudo bem?');
  assert.equal(r.reason, undefined);
});

test('prepareAudioMessageForBia no-op quando feature desativada (mantém texto)', async () => {
  const snap = snapshotEnv();
  setupEnv({ enabled: false });
  try {
    const r = await prepareAudioMessageForBia(VALID_AUDIO_TEXT);
    assert.equal(r.transcribed, false);
    assert.equal(r.text, VALID_AUDIO_TEXT);
    assert.equal(r.reason, 'feature_disabled');
  } finally {
    restoreEnv(snap);
  }
});

test('prepareAudioMessageForBia transcreve com sucesso via Whisper', async () => {
  const snap = snapshotEnv();
  setupEnv();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('vercel-storage.com')) return fakeBlobResp(Buffer.from([1, 2, 3, 4]), { 'content-length': 100 });
    if (u.includes('cloudflare.com')) return fakeWhisperOk('Bom dia, quero info sobre depilação.');
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const r = await prepareAudioMessageForBia(VALID_AUDIO_TEXT);
    assert.equal(r.transcribed, true);
    assert.equal(r.text, '🎤 Áudio transcrito: "Bom dia, quero info sobre depilação."');
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snap);
  }
});

test('prepareAudioMessageForBia escapa aspas dentro do transcript', async () => {
  const snap = snapshotEnv();
  setupEnv();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('vercel-storage.com')) return fakeBlobResp(Buffer.from([1, 2, 3, 4]));
    if (u.includes('cloudflare.com')) return fakeWhisperOk('Ela disse "oi" pra mim');
    throw new Error('unexpected');
  };
  try {
    const r = await prepareAudioMessageForBia(VALID_AUDIO_TEXT);
    assert.equal(r.transcribed, true);
    assert.equal(r.text, '🎤 Áudio transcrito: "Ela disse \\"oi\\" pra mim"');
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snap);
  }
});

test('prepareAudioMessageForBia retorna fallback seguro em falha HTTP do Whisper', async () => {
  const snap = snapshotEnv();
  setupEnv();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('vercel-storage.com')) return fakeBlobResp(Buffer.from([1, 2, 3, 4]));
    if (u.includes('cloudflare.com')) return fakeWhisperHttpFail(500);
    throw new Error('unexpected');
  };
  try {
    const r = await prepareAudioMessageForBia(VALID_AUDIO_TEXT);
    assert.equal(r.transcribed, false);
    assert.equal(r.reason, 'whisper_http_error');
    assert.match(r.text, /transcrição automática não funcionou/);
    // garante NÃO vazamento da URL Blob na mensagem entregue à Bia
    assert.equal(r.text.includes('m9l85zfzwaaraaia'), false);
    assert.equal(r.text.includes('public.blob.vercel-storage.com'), false);
    assert.equal(r.text.includes('🔗'), false);
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snap);
  }
});

test('prepareAudioMessageForBia retorna fallback quando Whisper success=false', async () => {
  const snap = snapshotEnv();
  setupEnv();
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('vercel-storage.com')) return fakeBlobResp(Buffer.from([1, 2, 3, 4]));
    if (u.includes('cloudflare.com')) return fakeWhisperUnsuccessful();
    throw new Error('unexpected');
  };
  try {
    const r = await prepareAudioMessageForBia(VALID_AUDIO_TEXT);
    assert.equal(r.transcribed, false);
    assert.equal(r.reason, 'whisper_unsuccessful');
    assert.match(r.text, /transcrição automática não funcionou/);
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snap);
  }
});

test('prepareAudioMessageForBia rejeita áudio acima do limite (Content-Length declarado)', async () => {
  const snap = snapshotEnv();
  setupEnv({ maxBytes: 100 });
  const originalFetch = global.fetch;
  global.fetch = async () =>
    fakeBlobResp(Buffer.alloc(2000), { 'content-length': 2000 });
  try {
    const r = await prepareAudioMessageForBia(VALID_AUDIO_TEXT);
    assert.equal(r.transcribed, false);
    assert.equal(r.reason, 'audio_too_large');
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snap);
  }
});

test('prepareAudioMessageForBia rejeita áudio acima do limite (body maior que header)', async () => {
  const snap = snapshotEnv();
  setupEnv({ maxBytes: 100 });
  const originalFetch = global.fetch;
  global.fetch = async () => fakeBlobResp(Buffer.alloc(2000)); // sem content-length
  try {
    const r = await prepareAudioMessageForBia(VALID_AUDIO_TEXT);
    assert.equal(r.transcribed, false);
    assert.equal(r.reason, 'audio_too_large');
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snap);
  }
});

test('prepareAudioMessageForBia retorna fallback quando envs Cloudflare ausentes', async () => {
  const snap = snapshotEnv();
  setupEnv();
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
  delete process.env.CLOUDFLARE_WORKERS_AI_TOKEN;
  const originalFetch = global.fetch;
  global.fetch = async () => fakeBlobResp(Buffer.from([1, 2, 3, 4]));
  try {
    const r = await prepareAudioMessageForBia(VALID_AUDIO_TEXT);
    assert.equal(r.transcribed, false);
    assert.equal(r.reason, 'cloudflare_env_missing');
    assert.match(r.text, /transcrição automática não funcionou/);
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snap);
  }
});

test('prepareAudioMessageForBia ignora silenciosamente URL externa (não chama Whisper)', async () => {
  const snap = snapshotEnv();
  setupEnv();
  let whisperCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('cloudflare.com')) whisperCalled = true;
    throw new Error('should not fetch');
  };
  try {
    const text = '🎤 Áudio recebido\n🔗 https://evil.example.com/foo.ogg';
    const r = await prepareAudioMessageForBia(text);
    assert.equal(r.transcribed, false);
    assert.equal(r.text, text); // sem mudança — não detectou áudio válido
    assert.equal(whisperCalled, false);
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snap);
  }
});

test('prepareAudioMessageForBia retorna fallback quando download falha (HTTP)', async () => {
  const snap = snapshotEnv();
  setupEnv();
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 404,
    headers: { get: () => null },
    arrayBuffer: async () => new ArrayBuffer(0),
    text: async () => '',
    json: async () => ({}),
  });
  try {
    const r = await prepareAudioMessageForBia(VALID_AUDIO_TEXT);
    assert.equal(r.transcribed, false);
    assert.equal(r.reason, 'download_http_error');
    assert.match(r.text, /transcrição automática não funcionou/);
  } finally {
    global.fetch = originalFetch;
    restoreEnv(snap);
  }
});
