/**
 * /api/conversion — Registra conversão (Purchase) no Facebook CAPI
 *
 * Fluxo:
 *   1. Recebe nome + telefone + valor do lead que converteu
 *   2. Busca lead original no Vercel Blob (leads/pending/*)
 *   3. Envia Purchase event ao Facebook CAPI com dados originais (fbp, fbc, IP, UA)
 *   4. Move lead de leads/pending/ para leads/converted/
 *
 * Autenticação: header x-api-key deve bater com CONVERSION_API_KEY env var
 */

import crypto from 'crypto';
import { list, put, del } from '@vercel/blob';
import { PIXEL_ID, GRAPH_BASE, DEFAULT_PURCHASE_VALUE } from './_lib/config.js';
import { normalizePhoneBR, maskName, maskPhone } from './_lib/security.js';
import { buildUserData } from './_lib/piiBuilder.js';
import { PARTNER_AGENT } from './_lib/capi.js';

// Alias local (fonte de verdade em _lib/security.js).
const normalizePhone = normalizePhoneBR;

async function findLeadInBlob(nome, telefone) {
  const telDigits = normalizePhone(telefone);
  const nomeLower = nome.trim().toLowerCase();

  // Fix HIGH AI deep review v2 (b3 conversion.js:40): limit 100, sem paginate
  // completo (antes: do-while cursor pegava TODOS leads, O(N) fetches). Agora:
  // priorizar leads recentes (Blob DESC uploadedAt) + Promise.allSettled paralelo.
  // Fix: Vercel Blob list() não garante DESC order — sort manual necessário pra
  // realmente priorizar leads recentes e evitar perder conversões de leads antigos.
  const result = await list({ prefix: 'leads/pending/', limit: 100 });
  const candidates = (result.blobs || []).filter(b => b.size > 200);
  // Sort DESC by uploadedAt (mais recentes primeiro) para priorizar leads novos
  const blobs = candidates.sort((a, b) => {
    const aTime = a.uploadedAt ? new Date(a.uploadedAt).getTime() : 0;
    const bTime = b.uploadedAt ? new Date(b.uploadedAt).getTime() : 0;
    return bTime - aTime; // DESC: maior timestamp primeiro
  });
  const datas = await Promise.allSettled(
    blobs.map(async (blob) => {
      const res = await fetch(blob.url);
      const data = await res.json();
      return { data, blob };
    })
  );

  // Match priority (strict first):
  //   1. Telefone exato
  //   2. Nome exato
  //   3. Primeiro nome igual E últimos 8 dígitos batem (conservative fallback)
  for (const r of datas) {
    if (r.status !== 'fulfilled') continue;
    const { data, blob } = r.value;
    const leadTel = normalizePhone(data?.telefone || '');
    const leadNome = (data?.nome || '').trim().toLowerCase();
    if (telDigits && leadTel === telDigits) return { data, blob };
  }
  for (const r of datas) {
    if (r.status !== 'fulfilled') continue;
    const { data, blob } = r.value;
    const leadNome = (data?.nome || '').trim().toLowerCase();
    if (nomeLower && leadNome === nomeLower) return { data, blob };
  }
  for (const r of datas) {
    if (r.status !== 'fulfilled') continue;
    const { data, blob } = r.value;
    const leadTel = normalizePhone(data?.telefone || '');
    const leadNome = (data?.nome || '').trim().toLowerCase();
    if (nomeLower && telDigits && leadNome && leadTel) {
      const nomePrimeiro = leadNome.split(/\s+/)[0];
      const telSuffix = telDigits.slice(-8);
      if (nomePrimeiro === nomeLower.split(/\s+/)[0] && leadTel.endsWith(telSuffix)) {
        return { data, blob };
      }
    }
  }
  return null;
}

export default async function handler(req, res) {
  // Endpoint server-to-server — sem CORS público
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Autenticação — sem fallback: CONVERSION_API_KEY é obrigatório
  const apiKey = process.env.CONVERSION_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'CONVERSION_API_KEY not configured' });
  const reqKey = req.headers['x-api-key'] || req.body?.api_key;
  // Fix HIGH AI deep review v2 (b3 conversion.js:76): timing-safe comparison
  // previne timing attacks na API key.
  const keyBuf = Buffer.from(String(apiKey));
  const reqBuf = Buffer.from(String(reqKey || ''));
  if (keyBuf.length !== reqBuf.length || !crypto.timingSafeEqual(keyBuf, reqBuf)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  const { nome, telefone, value = DEFAULT_PURCHASE_VALUE, currency = 'BRL' } = req.body || {};

  if (!nome && !telefone) {
    return res.status(400).json({ error: 'nome or telefone required' });
  }

  const parsedValue = Number(value);
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return res.status(400).json({ error: 'value must be a positive number' });
  }

  // Prefer dataset-scoped CAPI_DATASET_TOKEN, fallback META_ACCESS_TOKEN
  const token = process.env.CAPI_DATASET_TOKEN || process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'meta_token_not_configured' });

  try {
    // 1. Busca lead original no Blob
    const lead = await findLeadInBlob(nome || '', telefone || '');

    // 2. Monta user_data via SDK oficial Meta capi-param-builder-nodejs v1.2.1.
    // Normaliza+hasheia conforme regras Meta (RFC2822 email, e.164 phone,
    // strip ws+punct em nome/cidade, country/state mapping) e deriva advanced
    // matching partial keys (f5first, f5last, fi) automaticamente.
    const tel = telefone || lead?.data?.telefone;
    const nm = nome || lead?.data?.nome;
    let firstName = null, lastName = null;
    if (nm) {
      const parts = nm.trim().split(/\s+/);
      firstName = parts[0];
      if (parts.length > 1) lastName = parts[parts.length - 1];
    }
    // Fix HIGH AI deep review v2 (b3 conversion.js:116): não hardcodar gender/city/state.
      // Se lead tem esses dados no Blob original, usar. Caso contrário, deixar vazio
      // (Meta prefere ausência a dado errado — degrada EMQ pra matches não-esperados).
    const userData = await buildUserData({
      phone: tel ? normalizePhone(tel) : undefined,
      first_name: firstName || undefined,
      last_name: lastName || undefined,
      city: lead?.data?.city || undefined,
      state: lead?.data?.state || undefined,
      zip_code: lead?.data?.zip_code || undefined,
      country: lead?.data?.country || 'br',
    });

    // Dados originais da sessão do lead (fbp, fbc, IP, UA) — maximiza match quality
    if (lead?.data) {
      if (lead.data.client_user_agent) userData.client_user_agent = lead.data.client_user_agent;
      if (lead.data.client_ip_address) userData.client_ip_address = lead.data.client_ip_address;
      if (lead.data.fbp) userData.fbp = lead.data.fbp;
      if (lead.data.fbc) userData.fbc = lead.data.fbc;
    }

    // 3. Envia Purchase event ao Facebook CAPI
    // event_id com entropy crypto.randomUUID (não Math.random).
    const eventId = 'purchase_' + Date.now() + '_' + crypto.randomUUID().slice(0, 8);

    const payload = {
      data: [{
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: eventId,
        event_source_url: lead?.data?.event_source_url || 'https://icelasers.com.br/',
        action_source: 'website',
        user_data: userData,
        custom_data: {
          value: parsedValue,
          currency,
          content_name: 'Depilacao Laser',
          content_category: 'depilacao_laser',
          content_type: 'product',
          customer_segmentation: 'new_customer_to_business',
        },
      }],
      partner_agent: PARTNER_AGENT,
    };

    // Authorization Bearer (evita expor token na URL / logs)
    const metaRes = await fetch(
      `${GRAPH_BASE}/${PIXEL_ID}/events`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
      }
    );
    // Fix CRITICAL AI deep review v2 (b3 conversion.js:169): defensive JSON parse
    // + verificar se CAPI retornou erro. Antes: res.json() cru + retornava 200 OK
    // mesmo se Meta rejeitou. Purchase perdidos silenciosamente.
    const rawText = await metaRes.text();
    let metaResult;
    try { metaResult = JSON.parse(rawText); }
    catch {
      console.error(`[CONVERSION] CAPI non-JSON response (${metaRes.status}): ${rawText.substring(0,200)}`);
      return res.status(502).json({ ok: false, error: 'capi_non_json_response' });
    }
    if (metaResult?.error) {
      console.error(`[CONVERSION] CAPI error: code=${metaResult.error.code} msg=${metaResult.error.message}`);
      return res.status(502).json({ ok: false, error: 'capi_upstream_error' });
    }
    if (!metaResult?.events_received) {
      console.error('[CONVERSION] CAPI returned 0 events_received');
      return res.status(502).json({ ok: false, error: 'capi_zero_received' });
    }

    // 4. Move lead para converted/ no Blob — só após CAPI confirmado.
    if (lead?.blob) {
      const convertedData = {
        ...lead.data,
        converted: true,
        converted_at: new Date().toISOString(),
        purchase_value: parsedValue,
        purchase_event_id: eventId,
      };
      const newPath = lead.blob.pathname.replace('leads/pending/', 'leads/converted/');
      // Fix HIGH AI deep review v2 (b3 conversion.js:181): addRandomSuffix evita
      // enumeration de path PII. access:'public' mantido (store Vercel Blob é public-only).
      await put(newPath, JSON.stringify(convertedData), {
        access: 'public',
        addRandomSuffix: true,
        contentType: 'application/json',
      });
      await del(lead.blob.url).catch(() => {});
    }

    // Fix HIGH AI deep review v2 (b3 conversion.js:193): mascarar PII na response.
    return res.status(200).json({
      ok: true,
      events_received: metaResult.events_received,
      event_id: eventId,
      lead_found: !!lead,
      lead_nome: maskName(lead?.data?.nome || nome),
      lead_telefone: maskPhone(lead?.data?.telefone || telefone),
      message: lead
        ? `Purchase event enviado com dados completos do lead original (EMQ alto)`
        : `Purchase event enviado com dados fornecidos (lead não encontrado no Blob)`,
    });
  } catch (err) {
    console.error('[CONVERSION]', err?.message, err?.stack?.split('\n').slice(0,3).join(' | '));
    return res.status(500).json({ error: 'internal_error' });
  }
}
