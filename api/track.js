import crypto from 'crypto';
import { put } from '@vercel/blob';

const PIXEL_ID    = '2774496306216737';
const EMAIL_FROM  = process.env.EMAIL_FROM  || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS  = process.env.EMAIL_PASS;
const EMAIL_TO    = (process.env.EMAIL_TO   || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');

async function enviarEmailLead(nome, telefone) {
  if (!EMAIL_PASS) { console.warn('[EMAIL LEAD] EMAIL_PASS não configurado — email ignorado'); return; }
  try {
    const nodemailer = (await import('nodemailer')).default;
    const t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
    });
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' });
    const telLimpo = telefone.replace(/\D/g, '');
    const waLink = `https://wa.me/55${telLimpo}`;
    const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
      <div style="background:#1a1a2e;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0">🔥 Novo Lead — Landing Page</h2>
        <p style="color:#aaa;margin:5px 0 0">${agora}</p>
      </div>
      <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee">
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:8px 0;color:#666;width:100px">Nome</td>
              <td style="padding:8px 0"><strong>${nome}</strong></td></tr>
          <tr><td style="padding:8px 0;color:#666">Telefone</td>
              <td style="padding:8px 0">
                <a href="${waLink}" style="color:#25D366;font-weight:bold">${telefone}</a>
              </td></tr>
          <tr><td style="padding:8px 0;color:#666">Origem</td>
              <td style="padding:8px 0"><span style="background:#1877f2;color:#fff;font-size:11px;padding:2px 8px;border-radius:4px">📲 Landing Page</span></td></tr>
        </table>
        <div style="margin-top:16px;text-align:center">
          <a href="${waLink}" style="background:#25D366;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block">
            💬 Abrir WhatsApp
          </a>
        </div>
      </div>
    </div>`;
    await t.sendMail({
      from: `"IceLaser Bot" <${EMAIL_FROM}>`,
      to: EMAIL_TO.join(','),
      subject: `🔥 Lead LP — ${nome} | IceLaser`,
      html,
    });
  } catch (e) {
    console.error('[EMAIL LEAD]', e.message);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function normalizePhone(phone) {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('55')) return digits;
  return '55' + digits;
}

export default async function handler(req, res) {
  const allowedOrigins = [
    'https://icelaser-landing.vercel.app',
    'https://icelaser-landing-c9in.vercel.app',
    'https://icelaser.com.br',
    'https://www.icelaser.com.br',
  ];
  const origin = req.headers['origin'] || '';
  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  res.setHeader('Access-Control-Allow-Origin', corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    event_name = 'Lead',
    event_id,
    nome,
    telefone,
    event_source_url,
    client_user_agent,
    fbp,
    fbc,
    // UTM + Meta Ads tracking params (origem completa do lead)
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    ad_id, adset_id, campaign_id, placement,
  } = req.body || {};

  // IP capturado server-side (Vercel injeta nos headers) — melhora EMQ
  const client_ip_address =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.headers['x-real-ip'] ||
    req.socket?.remoteAddress ||
    undefined;

  const userData = { country: [sha256('br')] };

  if (telefone) {
    userData.ph = [sha256(normalizePhone(telefone))];
  }

  if (nome) {
    const parts = nome.trim().toLowerCase().split(/\s+/);
    userData.fn = [sha256(parts[0])];
    if (parts.length > 1) userData.ln = [sha256(parts[parts.length - 1])];
  }

  if (client_user_agent) userData.client_user_agent = client_user_agent;
  if (client_ip_address) userData.client_ip_address = client_ip_address;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const payload = {
    data: [{
      event_name,
      event_time: Math.floor(Date.now() / 1000),
      event_id,
      event_source_url: event_source_url || 'https://icelaser-landing-c9in.vercel.app/',
      action_source: 'website',
      user_data: userData,
    }],
  };

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'META_ACCESS_TOKEN not configured' });

  try {
    // Roda email + CAPI em paralelo — ambos aguardados antes de responder
    const promises = [
      fetch(
        `https://graph.facebook.com/v25.0/${PIXEL_ID}/events?access_token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }
      ),
    ];

    // Email + Blob só no evento Lead (evita duplicata com CompleteRegistration)
    if (event_name === 'Lead' && nome && telefone) {
      promises.push(enviarEmailLead(nome, telefone));

      // Salva lead no Blob (só se token configurado)
      if (process.env.BLOB_READ_WRITE_TOKEN) {
      const ts = new Date().toISOString();
      const fileName = `leads/pending/${ts.replace(/[:.]/g, '-')}_${nome.split(' ')[0].toLowerCase()}.json`;
      promises.push(
        put(fileName, JSON.stringify({
          nome,
          telefone,
          timestamp: ts,
          event_id,
          event_source_url: event_source_url || 'https://icelaser-landing-c9in.vercel.app/',
          client_user_agent: client_user_agent || req.headers['user-agent'],
          client_ip_address,
          fbp: fbp || undefined,
          fbc: fbc || undefined,
          // Origem completa: campanha, anúncio, público, placement
          utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          ad_id, adset_id, campaign_id, placement,
          converted: false,
        }), {
          access: 'public',
          contentType: 'application/json',
        }).catch(e => console.error('[BLOB LEAD]', e.message))
      );
      } // end BLOB_READ_WRITE_TOKEN check
    }

    const [metaResponse] = await Promise.all(promises);
    const result = await metaResponse.json();
    return res.status(200).json({ ok: true, events_received: result.events_received });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
