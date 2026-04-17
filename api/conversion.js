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

import { list, put, del } from '@vercel/blob';
import { PIXEL_ID, GRAPH_BASE, DEFAULT_PURCHASE_VALUE } from './_lib/config.js';
import { sha256, normalizePhoneBR } from './_lib/security.js';

// Alias local (fonte de verdade em _lib/security.js).
const normalizePhone = normalizePhoneBR;

async function findLeadInBlob(nome, telefone) {
  const telDigits = normalizePhone(telefone);
  const nomeLower = nome.trim().toLowerCase();

  // Lista todos os leads pendentes
  let cursor;
  let allBlobs = [];
  do {
    const result = await list({ prefix: 'leads/pending/', cursor, limit: 100 });
    allBlobs = allBlobs.concat(result.blobs);
    cursor = result.hasMore ? result.cursor : undefined;
  } while (cursor);

  // Busca o lead mais recente que bate nome + telefone.
  // Match estrito (telefone exato OU nome exato) + fallback conservador
  // (primeiro nome inclui o passado E telefone parcial bate últimos 8 dígitos).
  // Critério anterior `leadNome.includes(nomeLower)` dava false positive
  // entre clientes com nomes semelhantes (ex: "ana" match de "ana silva" e "ana costa").
  for (const blob of allBlobs.reverse()) {
    try {
      const res = await fetch(blob.url);
      const data = await res.json();
      const leadTel = normalizePhone(data.telefone || '');
      const leadNome = (data.nome || '').trim().toLowerCase();

      // 1. Match estrito por telefone (sempre prioritário)
      if (telDigits && leadTel === telDigits) return { data, blob };
      // 2. Match estrito por nome
      if (nomeLower && leadNome === nomeLower) return { data, blob };
      // 3. Fallback: primeiro nome igual E últimos 8 dígitos do telefone batem
      if (nomeLower && telDigits && leadNome && leadTel) {
        const nomePrimeiro = leadNome.split(/\s+/)[0];
        const telSuffix = telDigits.slice(-8);
        if (nomePrimeiro === nomeLower.split(/\s+/)[0] && leadTel.endsWith(telSuffix)) {
          return { data, blob };
        }
      }
    } catch { /* skip corrupt entries */ }
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
  if (reqKey !== apiKey) {
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

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'META_ACCESS_TOKEN not configured' });

  try {
    // 1. Busca lead original no Blob
    const lead = await findLeadInBlob(nome || '', telefone || '');

    // 2. Monta user_data com dados originais (melhor EMQ) ou dados fornecidos
    // Incluir geo-defaults como nos outros endpoints pra consistência de matching
    const userData = {
      country: [sha256('br')],
      st: [sha256('pe')],
      ct: [sha256('recife')],
      zp: [sha256('50000')],
      ge: [sha256('f')],
    };

    const tel = telefone || lead?.data?.telefone;
    const nm = nome || lead?.data?.nome;

    if (tel) userData.ph = [sha256(normalizePhone(tel))];
    if (nm) {
      const parts = nm.trim().toLowerCase().split(/\s+/);
      userData.fn = [sha256(parts[0])];
      if (parts.length > 1) userData.ln = [sha256(parts[parts.length - 1])];
    }

    // Dados originais da sessão do lead (fbp, fbc, IP, UA) — maximiza match quality
    if (lead?.data) {
      if (lead.data.client_user_agent) userData.client_user_agent = lead.data.client_user_agent;
      if (lead.data.client_ip_address) userData.client_ip_address = lead.data.client_ip_address;
      if (lead.data.fbp) userData.fbp = lead.data.fbp;
      if (lead.data.fbc) userData.fbc = lead.data.fbc;
    }

    // 3. Envia Purchase event ao Facebook CAPI
    const eventId = 'purchase_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

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
        },
      }],
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
    const metaResult = await metaRes.json();

    // 4. Move lead para converted/ no Blob
    if (lead?.blob) {
      const convertedData = {
        ...lead.data,
        converted: true,
        converted_at: new Date().toISOString(),
        purchase_value: Number(value),
        purchase_event_id: eventId,
      };
      const newPath = lead.blob.pathname.replace('leads/pending/', 'leads/converted/');
      await put(newPath, JSON.stringify(convertedData), {
        access: 'public',
        contentType: 'application/json',
      });
      await del(lead.blob.url).catch(() => {});
    }

    return res.status(200).json({
      ok: true,
      events_received: metaResult.events_received,
      event_id: eventId,
      lead_found: !!lead,
      lead_nome: lead?.data?.nome || nome,
      lead_telefone: lead?.data?.telefone || telefone,
      message: lead
        ? `Purchase event enviado com dados completos do lead original (EMQ alto)`
        : `Purchase event enviado com dados fornecidos (lead não encontrado no Blob)`,
    });
  } catch (err) {
    console.error('[CONVERSION]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
