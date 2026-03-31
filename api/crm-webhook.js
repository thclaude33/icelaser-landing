/**
 * /api/crm-webhook — Recebe eventos do Chatwoot CRM
 * Quando label muda → dispara CAPI/Pixel automaticamente
 *
 * Labels → Eventos CAPI:
 *   🧊 Lead Frio       → Lead (cold_lead)
 *   🔥 Lead Quente     → Lead + CompleteRegistration (hot_lead)
 *   💰 Compra Realizada → Lead + CR + InitiateCheckout + Purchase
 */

import crypto from 'crypto'

const PIXEL_ID = '2774496306216737';

function sha256(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('55')) return digits;
  return '55' + digits;
}

async function sendCAPI(events, token) {
  const res = await fetch(
    `https://graph.facebook.com/v25.0/${PIXEL_ID}/events?access_token=${token}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: events }),
    }
  );
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'META_ACCESS_TOKEN not configured' });

  const body = req.body || {};
  const event = body.event;

  // Log completo pra debug
  console.log(`[CRM-WEBHOOK] event=${event} | keys=${Object.keys(body).join(',')} | labels=${JSON.stringify((body.conversation || body.data || {}).labels || (body.changed_attributes || []))}`);

  // Processa conversation_created e conversation_updated
  if (event !== 'conversation_updated' && event !== 'contact_updated' && event !== 'conversation_created') {
    return res.status(200).json({ ok: true, skipped: true, event });
  }

  // Extrai dados — Chatwoot pode enviar em body.conversation ou body.data
  const conversation = body.conversation || body.data || body;
  const contact = conversation.meta?.sender || conversation.contact || body.sender || {};
  const labels = conversation.labels || body.labels || [];
  const customAttrs = contact.custom_attributes || {};

  const nome = contact.name || '';
  const telefone = contact.phone_number || customAttrs.phone || '';
  const email = contact.email || '';

  if (!nome && !telefone) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no_contact_data' });
  }

  // Monta user_data pra CAPI
  const now = Math.floor(Date.now() / 1000);
  const userData = { country: [sha256('br')], st: [sha256('pe')], ct: [sha256('recife')] };

  if (telefone) userData.ph = [sha256(normalizePhone(telefone))];
  if (email) userData.em = [sha256(email.toLowerCase())];
  if (nome) {
    const parts = nome.trim().toLowerCase().split(/\s+/);
    userData.fn = [sha256(parts[0])];
    if (parts.length > 1) userData.ln = [sha256(parts[parts.length - 1])];
  }

  // UTMs do contato (se vieram da LP)
  const fbp = customAttrs.fbp || undefined;
  const fbc = customAttrs.fbclid || undefined;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const baseEvent = {
    event_source_url: 'https://icelaser-landing.vercel.app/',
    action_source: 'website',
    user_data: userData,
  };

  const events = [];
  const eventId = `crm_${contact.id || 'unknown'}_${now}`;

  // ❌ DESQUALIFICADO
  if (labels.includes('desqualificado') || labels.includes('❌ Desqualificado') || labels.includes('❌_desqualificado')) {
    events.push({
      ...baseEvent,
      event_name: 'Lead',
      event_time: now,
      event_id: `${eventId}_disqualified`,
      custom_data: {
        content_name: 'Lead Desqualificado - CRM',
        lead_type: 'disqualified',
        status: 'disqualified',
        quality: 'unqualified',
        disqualification_reason: 'fora_do_publico_alvo',
      },
    });
  }

  // 🧊 LEAD FRIO
  if (labels.includes('lead_frio') || labels.includes('🧊 Lead Frio') || labels.includes('🧊_lead_frio')) {
    events.push({
      ...baseEvent,
      event_name: 'Lead',
      event_time: now,
      event_id: `${eventId}_cold_lead`,
      custom_data: {
        content_name: 'Lead Frio - CRM',
        lead_type: 'cold_lead',
        status: 'unqualified',
      },
    });
  }

  // 🔥 LEAD QUENTE
  if (labels.includes('lead_quente') || labels.includes('🔥 Lead Quente') || labels.includes('🔥_lead_quente')) {
    events.push(
      {
        ...baseEvent,
        event_name: 'Lead',
        event_time: now - 3600,
        event_id: `${eventId}_hot_lead`,
        custom_data: { content_name: 'Lead Quente - CRM', lead_type: 'hot_lead' },
      },
      {
        ...baseEvent,
        event_name: 'CompleteRegistration',
        event_time: now,
        event_id: `${eventId}_hot_cr`,
        custom_data: { content_name: 'Lead Quente - CRM', status: 'converted', currency: 'BRL', value: 150.00 },
      }
    );
  }

  // 💰 COMPRA REALIZADA
  if (labels.includes('compra_realizada') || labels.includes('💰 Compra Realizada') || labels.includes('💰_compra_realizada')) {
    const valor = parseFloat(customAttrs.purchase_value) || 497;
    events.push(
      {
        ...baseEvent,
        event_name: 'Lead',
        event_time: now - 7200,
        event_id: `${eventId}_purchase_lead`,
        custom_data: { content_name: 'Compra CRM', lead_type: 'hot_lead' },
      },
      {
        ...baseEvent,
        event_name: 'CompleteRegistration',
        event_time: now - 3600,
        event_id: `${eventId}_purchase_cr`,
        custom_data: { content_name: 'Compra CRM', status: 'converted', currency: 'BRL', value: valor || 150.00 },
      },
      {
        ...baseEvent,
        event_name: 'InitiateCheckout',
        event_time: now - 1800,
        event_id: `${eventId}_purchase_ic`,
        custom_data: { currency: 'BRL', value: valor },
      },
      {
        ...baseEvent,
        event_name: 'Purchase',
        event_time: now,
        event_id: `${eventId}_purchase`,
        custom_data: {
          currency: 'BRL',
          value: valor,
          content_name: 'Pacote Depilacao Laser',
          content_type: 'product',
          num_items: 1,
        },
      }
    );
  }

  if (events.length === 0) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'no_matching_labels' });
  }

  try {
    const result = await sendCAPI(events, token);
    console.log(`[CRM-WEBHOOK] ${event} | ${nome} | labels: ${labels.join(',')} | CAPI: ${result.events_received} eventos`);
    return res.status(200).json({
      ok: true,
      contact: nome,
      labels,
      events_sent: events.length,
      events_received: result.events_received,
    });
  } catch (err) {
    console.error('[CRM-WEBHOOK]', err.message);
    return res.status(500).json({ error: err.message });
  }
}
