import nodemailer from 'nodemailer';
import { put, list } from '@vercel/blob';
// PIXEL_ID + GRAPH_BASE + PARTNER_AGENT NÃO importados — refatoração 20/04/2026
// delegou CAPI send pra _lib/capi.js sendCapiEvents que usa internamente.
import { ALLOWED_ORIGINS, getPixelByHost, isOriginAllowed } from './_lib/config.js';
import { sha256, normalizePhoneBR, escapeHtml, sanitizeHeader, sanitizeUrl, maskPhone as maskPhoneLocal } from './_lib/security.js';
import { buildUserData } from './_lib/piiBuilder.js';
import { sendCapiEvents, filterValidEvents } from './_lib/capi.js';
import { sendWAMEvent, WAM_ALLOWED_EVENTS } from './_lib/capi-wam.js';

const EMAIL_FROM  = process.env.EMAIL_FROM  || 'espacoicelaserrecife2@gmail.com';
const EMAIL_PASS  = process.env.EMAIL_PASS;
const EMAIL_TO    = (process.env.EMAIL_TO   || 'espacoicelaserrecife2@gmail.com,thiagosml@gmail.com').split(',');

function parseDevice(ua) {
  if (!ua) return { modelo: '—', os: '—', navegador: '—' };
  let modelo = '—', os = '—', navegador = '—';

  // OS
  if (/iPhone/.test(ua)) {
    os = 'iOS';
    const m = ua.match(/iPhone\s*OS\s*([\d_]+)/);
    if (m) os = 'iOS ' + m[1].replace(/_/g, '.');
  } else if (/Android/.test(ua)) {
    const m = ua.match(/Android\s*([\d.]+)/);
    os = m ? 'Android ' + m[1] : 'Android';
  }

  // Modelo
  if (/iPhone(\d+),(\d+)/.test(ua)) {
    const gen = { '12,1':'11','13,1':'12 mini','13,2':'12','13,3':'12 Pro','13,4':'12 Pro Max',
      '14,2':'13 Pro','14,3':'13 Pro Max','14,4':'13 mini','14,5':'13','14,7':'14',
      '14,8':'14 Plus','15,2':'14 Pro','15,3':'14 Pro Max','15,4':'15','15,5':'15 Plus',
      '16,1':'15 Pro','16,2':'15 Pro Max','17,1':'16','17,2':'16 Plus','17,3':'16 Pro',
      '17,4':'16 Pro Max' };
    const k = ua.match(/iPhone(\d+,\d+)/)[1];
    modelo = gen[k] ? 'iPhone ' + gen[k] : 'iPhone ' + k;
  } else if (/iPhone/.test(ua)) {
    modelo = 'iPhone';
  } else {
    const m = ua.match(/;\s*([^;)]+)\s+Build\//);
    if (m) modelo = m[1].trim();
  }

  // Navegador / App
  if (/Instagram/.test(ua)) navegador = 'Instagram In-App';
  else if (/FBAV|FBAN/.test(ua)) navegador = 'Facebook In-App';
  else if (/CriOS/.test(ua)) navegador = 'Chrome iOS';
  else if (/Safari/.test(ua) && !/Chrome/.test(ua)) navegador = 'Safari';
  else if (/Chrome/.test(ua)) navegador = 'Chrome';
  else navegador = 'Outro';

  return { modelo, os, navegador };
}

// Fix LOW AI review 20/04/2026 (L7): transporter module-level singleton.
// Mesma otimização de M11 em whatsapp.js — amortiza TLS handshake entre invocações warm.
let _mailTransport = null;
function getMailTransport() {
  if (!_mailTransport && EMAIL_PASS) {
    _mailTransport = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
    });
  }
  return _mailTransport;
}

async function enviarEmailLead(nome, telefone, origem = {}) {
  if (!EMAIL_PASS) { console.warn('[EMAIL LEAD] EMAIL_PASS não configurado — email ignorado'); return; }
  try {
    const t = getMailTransport();
    const agora = new Date().toLocaleString('pt-BR', { timeZone: 'America/Recife' });
    const telLimpo = (telefone || '').replace(/\D/g, '');
    const waLink = telLimpo ? `https://wa.me/55${telLimpo}` : '';

    // Identifica qual LP
    const lpUrl = origem.event_source_url || '';
    let lpNome = 'Landing Page';
    if (lpUrl.includes('icelaser-landing-c9in')) lpNome = 'icelaser-landing-c9in';
    else if (lpUrl.includes('icelaser-landing.vercel')) lpNome = 'icelaser-landing';
    else if (lpUrl.includes('landing-page-six')) lpNome = 'landing-page-six-xi-77';
    else if (lpUrl.includes('icelaser.com.br')) lpNome = 'icelaser.com.br';

    // Plataforma / Campanha / Adset / Anúncio
    const plataforma = origem.utm_source === 'ig' ? 'Instagram' : origem.utm_source === 'facebook' ? 'Facebook' : origem.utm_source || '—';
    const campanha = origem.campaign_name || origem.utm_campaign || '—';
    const campanhaId = origem.campaign_id || '—';
    const adset = origem.adset_name || origem.utm_content || '—';
    const adsetId = origem.adset_id || '—';
    const anuncio = origem.ad_name || '—';
    const adId = origem.ad_id || '—';
    const angulo = origem.utm_term || '—';
    const placement = origem.placement || '—';
    const siteSrc = origem.site_source_name || origem.platform || '—';
    const temUtm = origem.utm_source ? true : false;

    // Dispositivo / OS / Navegador
    const device = parseDevice(origem.client_user_agent);
    const ip = origem.client_ip_address || '—';

    // Pixel cookies
    const fbp = origem.fbp || '—';
    const fbc = origem.fbc ? 'Sim (fbclid capturado)' : 'Não';

    // Dados de qualificação
    const tela = (origem.screen_width && origem.screen_height) ? `${origem.screen_width}x${origem.screen_height}` : '—';
    const idioma = origem.language || '—';
    const tz = origem.timezone || '—';
    const referer = origem.referrer || '—';
    const tempoNaPagina = origem.time_on_page ? `${origem.time_on_page}s` : '—';
    const scrollDepth = origem.scroll_depth ? `${origem.scroll_depth}%` : '—';

    const origemBadge = temUtm
      ? `<span style="background:#1877f2;color:#fff;font-size:11px;padding:2px 8px;border-radius:4px">📲 ${plataforma} Ads</span>`
      : `<span style="background:#6c757d;color:#fff;font-size:11px;padding:2px 8px;border-radius:4px">📲 ${lpNome}</span>`;

    const row = (label, value, color) => value && value !== '—'
      ? `<tr><td style="padding:6px 0;color:#666;width:120px;font-size:13px;vertical-align:top">${label}</td>
             <td style="padding:6px 0;font-size:13px"><code style="background:${color || '#eee'};padding:2px 6px;border-radius:3px">${value}</code></td></tr>`
      : '';

    // XSS-safe: user-controlled fields (nome, telefone, email) passam por escapeHtml.
    // Campos internos (lpNome, plataforma, device.*, etc) são determinísticos — safe as-is.
    const nomeSafe = escapeHtml(nome);
    const telefoneSafe = escapeHtml(telefone);
    const emailSafe = escapeHtml(origem.email);
    const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:auto">
      <div style="background:#1a1a2e;padding:20px;border-radius:8px 8px 0 0">
        <h2 style="color:#fff;margin:0">🔥 ${telefone ? 'Novo Lead' : 'Clique WA Direto'} — ${lpNome}</h2>
        <p style="color:#aaa;margin:5px 0 0">${agora}</p>
      </div>
      <div style="background:#f9f9f9;padding:20px;border-radius:0 0 8px 8px;border:1px solid #eee">

        <div style="background:#fff;border:1px solid #ddd;border-radius:6px;padding:14px;margin-bottom:14px">
          <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Dados do Lead</div>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:6px 0;color:#666;width:120px;font-size:13px">Nome</td>
                <td style="padding:6px 0;font-size:15px"><strong>${nomeSafe}</strong></td></tr>
            <tr><td style="padding:6px 0;color:#666;font-size:13px">Telefone</td>
                <td style="padding:6px 0">${telLimpo ? `<a href="${waLink}" style="color:#25D366;font-weight:bold;font-size:15px">${telefoneSafe}</a>` : '<span style="color:#999">WA Direto (sem formulário)</span>'}</td></tr>
            ${origem.email ? `<tr><td style="padding:6px 0;color:#666;font-size:13px">E-mail</td>
                <td style="padding:6px 0;font-size:13px"><a href="mailto:${emailSafe}" style="color:#1877f2">${emailSafe}</a></td></tr>` : ''}
            <tr><td style="padding:6px 0;color:#666;font-size:13px">Origem</td>
                <td style="padding:6px 0">${origemBadge}</td></tr>
          </table>
        </div>

        <div style="background:#fff;border:1px solid #ddd;border-radius:6px;padding:14px;margin-bottom:14px">
          <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Dispositivo</div>
          <table style="width:100%;border-collapse:collapse">
            ${row('Aparelho', device.modelo, '#e8f5e9')}
            ${row('Sistema', device.os, '#e3f2fd')}
            ${row('Navegador', device.navegador, '#fce4ec')}
            ${row('IP', ip)}
          </table>
        </div>

        <div style="background:#fff;border:1px solid #ddd;border-radius:6px;padding:14px;margin-bottom:14px">
          <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Meta Ads — Campanha</div>
          <table style="width:100%;border-collapse:collapse">
            ${row('Plataforma', plataforma, '#e8eaf6')}
            ${row('Posicionamento', placement, '#e8eaf6')}
            ${row('Fonte', siteSrc, '#e8eaf6')}
            ${row('Campanha', campanha, '#e8eaf6')}
            ${row('Campaign ID', campanhaId, '#f3e5f5')}
          </table>
        </div>

        <div style="background:#fff;border:1px solid #ddd;border-radius:6px;padding:14px;margin-bottom:14px">
          <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Meta Ads — Conjunto de Anúncios</div>
          <table style="width:100%;border-collapse:collapse">
            ${row('Conjunto', adset, '#e0f2f1')}
            ${row('Adset ID', adsetId, '#f3e5f5')}
            ${row('Ângulo Criativo', angulo, '#fff3e0')}
          </table>
        </div>

        <div style="background:#fff;border:1px solid #ddd;border-radius:6px;padding:14px;margin-bottom:14px">
          <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Meta Ads — Anúncio</div>
          <table style="width:100%;border-collapse:collapse">
            ${row('Anúncio', anuncio, '#fce4ec')}
            ${row('Ad ID', adId, '#f3e5f5')}
          </table>
        </div>

        <div style="background:#fff;border:1px solid #ddd;border-radius:6px;padding:14px;margin-bottom:14px">
          <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Qualificação do Lead</div>
          <table style="width:100%;border-collapse:collapse">
            ${row('Landing Page', lpNome, '#fff3e0')}
            ${row('Tela', tela, '#fafafa')}
            ${row('Idioma', idioma, '#fafafa')}
            ${row('Timezone', tz, '#fafafa')}
            ${row('Tempo na página', tempoNaPagina, '#e8f5e9')}
            ${row('Scroll atingido', scrollDepth, '#e8f5e9')}
            ${row('Referrer', referer, '#fafafa')}
          </table>
        </div>

        <div style="background:#fff;border:1px solid #ddd;border-radius:6px;padding:14px;margin-bottom:14px">
          <div style="font-size:11px;color:#999;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Pixel & CAPI</div>
          <table style="width:100%;border-collapse:collapse">
            ${row('fbp (cookie)', fbp, '#fafafa')}
            ${row('fbc (click ID)', fbc, '#fafafa')}
          </table>
        </div>

        <div style="margin-top:16px;text-align:center">
          <a href="${waLink}" style="background:#25D366;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block;font-size:15px">
            💬 Abrir WhatsApp
          </a>
        </div>
      </div>
    </div>`;
    // sanitizeHeader aplicado global no subject — plataforma vem de utm_source
    // controlado por atacante (URL query param). CRLF em utm_source poderia
    // injetar Bcc: attacker@evil via subject (CVE-class).
    // Fix M15 + escapeHtml-subject: nome raw no subject. sanitizeHeader strips CRLF
    // (SMTP header injection prevention). HTML entities NÃO são interpretadas em
    // plain text email headers — escapeHtml causaria &lt; e &gt; literalmente visíveis.
    const subject = sanitizeHeader(
      `🔥 ${telefone ? 'Lead' : 'Clique WA'} ${temUtm ? plataforma : 'LP'} — ${nome} | ${lpNome}`,
      200
    );
    await t.sendMail({
      from: `"IceLaser Bot" <${EMAIL_FROM}>`,
      to: EMAIL_TO.join(','),
      subject,
      html,
    });
  } catch (e) {
    console.error('[EMAIL LEAD]', e.message);
  }
}

// Alias local pra manter nome anterior (normalizePhoneBR vem de _lib/security.js).
const normalizePhone = normalizePhoneBR;

export default async function handler(req, res) {
  const origin = req.headers['origin'] || '';
  // CORS: s�� seta Access-Control-Allow-Origin pra origens permitidas.
  // Antes caía em fallback ALLOWED_ORIGINS[0] — permissivo demais, browser
  // bloqueava na prática mas ruído pra debug de CORS.
  // isOriginAllowed: ALLOWED_ORIGINS estático + Vercel preview URLs com slug JP
  // (jpa/jp-routing/bancarios). Necessário pra testes em previews JP via PR.
  if (isOriginAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Fix LOW AI review 20/04/2026 (L9): validar body parseado. Se Vercel não
  // parsear (Content-Type errado, body vazio), destructuring silenciosamente
  // resulta em tudo undefined → evento sem dados enviado ao Meta.
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  const {
    event_name = 'Lead',
    event_id,
    event_time: bodyEventTime,  // opcional: pixel browser envia pra sync com CAPI server
    nome,
    telefone,
    email,
    event_source_url,
    client_user_agent,
    fbp,
    fbc,
    // UTM + Meta Ads tracking params (origem completa do lead)
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name,
    placement, site_source_name, platform,
    // Dados de qualificação do lead
    screen_width, screen_height, language, timezone, referrer,
    landing_url, time_on_page, scroll_depth,
    // Fix HIGH AI deep v3 (track.js:CUSTOM_DATA override): accept frontend
    // custom_data overrides pra alinhar Pixel browser↔CAPI server (ex: ViewContent
    // value=300 no browser precisa espelhar no CAPI pra dedup 100%).
    value: bodyValue,
    currency: bodyCurrency,
    content_name: bodyContentName,
    content_category: bodyContentCategory,
  } = req.body || {};

  // IP: prioridade _cip cookie (IPv6 capturado pelo browser via api64.ipify.org)
  // Fallback: headers do Vercel (geralmente IPv4)
  const stripMappedIPv4 = (ip) => ip.replace(/^::ffff:/i, '');
  const cipCookie = (req.headers['cookie'] || '').match(/(?:^|;\s*)_cip=([^;]+)/);
  const cipIp = cipCookie ? cipCookie[1].trim() : undefined;
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  const rawIp = xff[0] || req.headers['x-real-ip'] || req.socket?.remoteAddress || undefined;
  const client_ip_address = cipIp || (rawIp ? stripMappedIPv4(rawIp) : undefined);

  // Parse nome em first_name/last_name ANTES de chamar buildUserData
  // (SDK Meta normaliza + hasheia + deriva f5first/f5last/fi automaticamente).
  let firstName = null, lastName = null;
  if (nome) {
    const parts = nome.trim().split(/\s+/);
    firstName = parts[0];
    if (parts.length > 1) lastName = parts[parts.length - 1];
  }

  // external_id: identidade estável (email > phone). NÃO usar fbp como fallback
  // (fbp já é matching key nativa; duplicar via external_id infla multi-user-per-IP).
  const normalizedPhone = telefone ? normalizePhone(telefone) : null;
  const normalizedEmail = email ? email.toLowerCase().trim() : null;
  const externalIdRaw = normalizedEmail || normalizedPhone;

  // buildUserData: wrapper do SDK oficial Meta capi-param-builder-nodejs v1.2.1.
  // Aplica normalização canônica (lowercase, strip ws+punct, RFC2822 email,
  // e.164 phone sem prefixo 0, mapeamento país/estado completo) + SHA-256 via SDK.
  // Deriva automaticamente f5first, f5last, fi (partial matching advanced keys
  // do Meta Java SDK oficial) quando first_name/last_name presentes.
  // Fix HIGH AI audit 20/04/2026 (consistência M12): remover gender:'f' hardcoded.
  // Meta penaliza mismatch (leads masculinos ~1-5%) mais que ausência. city/state/zip
  // mantidos (99%+ leads são de Recife — Meta usa IP fallback se errado é suave).
  const userData = await buildUserData({
    email: normalizedEmail || undefined,
    phone: normalizedPhone || undefined,
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    city: 'recife',
    state: 'pe',
    zip_code: '50000',
    country: 'br',
    external_id: externalIdRaw || undefined,
  });

  if (client_user_agent) userData.client_user_agent = client_user_agent;
  if (client_ip_address) userData.client_ip_address = client_ip_address;

  // fbp/fbc: usa valor do request, ou recupera do Blob se cookie expirou (iOS ITP 7d/_fbc 24h)
  let finalFbp = fbp;
  let finalFbc = fbc;
  if ((!fbp || !fbc) && telefone && process.env.BLOB_READ_WRITE_TOKEN) {
    try {
      const telDigits = telefone.replace(/\D/g, '');
      // Fix MEDIUM AI review 20/04/2026 (M13): paralelizar fetches via Promise.allSettled.
      // Antes: fetch sequencial de até 100 blobs = 2-10s extra no request user-facing.
      // Agora: 1 list() + N fetches concorrentes, short-circuit assim que achou match.
      const blobs = await list({ prefix: 'leads/', limit: 100 });
      const candidates = blobs.blobs.filter(b => b.size > 200);
      const datas = await Promise.allSettled(
        candidates.map(b => fetch(b.url).then(r => r.json()))
      );
      for (const result of datas) {
        if (result.status !== 'fulfilled') continue;
        const data = result.value;
        // Fix MEDIUM AI review 20/04/2026 (M14): `const res` shadowava o Vercel
        // Response do handler — renomeado pra blobData pra evitar armadilha.
        const blobTel = (data?.telefone || '').replace(/\D/g, '');
        if (blobTel && telDigits.endsWith(blobTel.slice(-8))) {
          if (!finalFbp && data.fbp) finalFbp = data.fbp;
          if (!finalFbc && data.fbc) finalFbc = data.fbc;
          if (finalFbp && finalFbc) break;
        }
      }
      if (finalFbp !== fbp || finalFbc !== fbc) {
        // Fix MEDIUM AI deep v3 (track.js:351): PII (telefone) no log em plaintext.
        // maskPhone é consistente com resto do código (mesma sanitização em outros logs).
        console.log(`[TRACK] Recovered from Blob: fbp=${!!finalFbp} fbc=${!!finalFbc} for ${maskPhoneLocal(telefone)}`);
      }
    } catch (e) {
      console.warn('[TRACK] Blob recovery failed:', e.message);
    }
  }
  if (finalFbp) userData.fbp = finalFbp;
  if (finalFbc) userData.fbc = finalFbc;

  // custom_data: todos os eventos (exceto PageView) recebem value+currency pra
  // evitar diagnóstico Meta, e customer_segmentation conforme enum oficial 2026.
  // Visitantes da LP são sempre "new_customer_to_business" — já filtramos
  // Pixel Custom Audience "Compradores+Leads Quentes 180d" antes de enviar?
  // Não — o customer_segmentation é declarado do ponto de vista do evento
  // específico (primeiro touchpoint LP = new), não do histórico do usuário.
  // Fix INFO AI review 20/04/2026 (I1): lookup table em vez de if/else repetitivo.
  // Base comum (value:0, currency:BRL, customer_segmentation:new) aplicada uniformemente.
  // PageView intencionalmente AUSENTE — só user_data pro matching.
  const CUSTOM_DATA_MAP = {
    CompleteRegistration: { status: 'submitted', content_name: 'Avaliacao Gratuita LP' },
    InitiateCheckout:     { content_name: 'Form Avaliacao Gratuita' },
    Lead:                 { content_name: 'Avaliacao Gratuita LP', content_category: 'depilacao_laser', lead_event_source: 'landing_page' },
    ViewContent:          { content_name: 'LP Avaliacao Gratuita', content_category: 'depilacao_laser' },
  };
  const custom_data = {};
  const baseData = CUSTOM_DATA_MAP[event_name];
  if (baseData) {
    Object.assign(custom_data, {
      value: 0,
      currency: 'BRL',
      customer_segmentation: 'new_customer_to_business',
      ...baseData,
    });
  }
  // Fix HIGH AI deep v3 (track.js:CUSTOM_DATA override): frontend explicit overrides.
  // Quando Pixel browser envia value/currency/content_name pra match específico
  // (ex: ViewContent value=300), honrar aqui evita divergência CAPI vs Pixel.
  // Meta dedup melhor quando custom_data.value é IDÊNTICO em browser+server events.
  if (typeof bodyValue === 'number' && Number.isFinite(bodyValue)) custom_data.value = bodyValue;
  if (typeof bodyCurrency === 'string' && bodyCurrency.length === 3) custom_data.currency = bodyCurrency;
  if (typeof bodyContentName === 'string' && bodyContentName.length > 0 && bodyContentName.length <= 200) custom_data.content_name = bodyContentName;
  if (typeof bodyContentCategory === 'string' && bodyContentCategory.length > 0 && bodyContentCategory.length <= 200) custom_data.content_category = bodyContentCategory;

  // Validação: garantir MATCHING KEY real (não só geo).
  // Meta v13+ rejeita eventos só com geo+UA sem identifier.
  // Evento é matchable se tem: em, ph, fn+ln, external_id, fbp, fbc, madid
  const hasMatchingKey = !!(
    userData.em || userData.ph || (userData.fn && userData.ln) ||
    userData.external_id || userData.fbp || userData.fbc
  );
  if (!hasMatchingKey) {
    return res.status(400).json({ error: 'Insufficient user_data for matching (need em/ph/fn+ln/external_id/fbp/fbc)' });
  }

  // Fix MEDIUM AI review 20/04/2026 (M17): event_id OBRIGATÓRIO pra dedup
  // Pixel↔CAPI. Se frontend não enviar (bug JS, race condition), cair pra 400
  // força fix no client em vez de double-counting silencioso no Events Manager.
  if (!event_id || typeof event_id !== 'string' || event_id.length < 8) {
    return res.status(400).json({ error: 'event_id required for dedup (min 8 chars)' });
  }

  // event_time: se browser mandou e é válido (dentro da janela 7d Meta), usa ele.
  // Senão, now. Isso sincroniza pixel.eventTime ↔ CAPI.eventTime — melhor pra attribution.
  const nowSec = Math.floor(Date.now() / 1000);
  const minValidTime = nowSec - 7 * 24 * 3600 + 600;  // 7d window com margem
  const parsedBodyTime = Number(bodyEventTime);
  const eventTime = Number.isFinite(parsedBodyTime) && parsedBodyTime >= minValidTime && parsedBodyTime <= nowSec
    ? parsedBodyTime
    : nowSec;

  // partner_agent adicionado automaticamente por sendCapiEvents (_lib/capi.js).
  // Fix 22/04/2026 (WAM diagnostic "server events ViewContent not deduplicated"):
  // original_event_data self-reference explicita pro Meta que esse CAPI server
  // event é a versão server do MESMO event browser (mesmo event_id). Hint oficial
  // Meta pra reforçar dedup Pixel↔CAPI alem do match event_name+event_id padrao.
  // Ref: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/original-event/
  const originalEventData = { event_name, event_id };
  const eventPayload = {
    event_name,
    event_time: eventTime,
    event_id,
    event_source_url: event_source_url || 'https://icelasers.com.br/',
    action_source: 'website',
    user_data: userData,
    ...(Object.keys(custom_data).length > 0 && { custom_data }),
    original_event_data: originalEventData,
  };

  // Multi-tenant Pixel routing — resolve qual Pixel usar baseado em Origin/host.
  // jpa.icelasers.com.br → Pixel JP (1386967056530127). Outros → Pixel Recife (default).
  // Origin header tem URL completa do client (ex: 'https://jpa.icelasers.com.br'),
  // extraímos só o host pra getPixelByHost match.
  let routedPixelId;
  let isJpRoute = false;
  try {
    const originHeader = req.headers['origin'] || '';
    const originHost = originHeader ? new URL(originHeader).host : '';
    routedPixelId = getPixelByHost(originHost);
    isJpRoute = routedPixelId !== process.env.META_PIXEL_ID && routedPixelId === '1386967056530127';
  } catch (e) {
    routedPixelId = getPixelByHost(null);
  }

  // Token routing — CAPI_DATASET_TOKEN (Recife) é dataset-scoped, não posta no Pixel JP.
  // Pra JP: prefer CAPI_DATASET_TOKEN_JP (gerar via Events Manager UI), fallback META_ACCESS_TOKEN.
  // Pra Recife: prefer CAPI_DATASET_TOKEN, fallback META_ACCESS_TOKEN.
  const token = isJpRoute
    ? (process.env.CAPI_DATASET_TOKEN_JP || process.env.META_ACCESS_TOKEN)
    : (process.env.CAPI_DATASET_TOKEN || process.env.META_ACCESS_TOKEN);
  if (!token) return res.status(500).json({ error: 'meta_token_not_configured' });

  try {
    // REFATORAÇÃO 20/04/2026 — usar _lib/capi.js sendCapiEvents + filterValidEvents
    // Antes: lógica inline de fetch+retry+rate-limit-monitor+JSON-parse defensive
    // duplicada com conversion.js e crm-webhook.js. Diverge ao longo do tempo.
    // Agora: helper central com retry 2x (backoff 1s+2s), defensive JSON parse,
    // X-App-Usage/BUC monitor em 1 lugar. filterValidEvents clampa event_time
    // imutavelmente + valida required fields.
    //
    // Email + Blob em paralelo fire-and-forget (não bloqueiam CAPI response).
    if (event_name === 'Lead' && nome) {
      enviarEmailLead(nome, telefone, {
        email,
        event_source_url, utm_source, utm_medium, utm_campaign,
        utm_content, utm_term, ad_id, ad_name, adset_id, adset_name,
        campaign_id, campaign_name, placement, site_source_name, platform,
        client_user_agent, client_ip_address, fbp, fbc,
        screen_width, screen_height, language, timezone, referrer,
        landing_url, time_on_page, scroll_depth,
      }).catch(e => console.error('[EMAIL LEAD]', e.message));

      if (process.env.BLOB_READ_WRITE_TOKEN) {
        const ts = new Date().toISOString();
        const safeFirstName = nome.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'anon';
        const fileName = `leads/pending/${ts.replace(/[:.]/g, '-')}_${safeFirstName}.json`;
        put(fileName, JSON.stringify({
          nome, telefone, email: email || undefined, timestamp: ts, event_id,
          event_source_url: event_source_url || 'https://icelasers.com.br/',
          client_user_agent: client_user_agent || req.headers['user-agent'],
          client_ip_address,
          fbp: fbp || undefined, fbc: fbc || undefined,
          city: 'recife', state: 'pe', zip_code: '50000', country: 'br',
          external_id: externalIdRaw || undefined,
          utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name,
          placement, site_source_name, platform,
          screen_width, screen_height, language, timezone, referrer,
          landing_url, time_on_page, scroll_depth,
          converted: false,
        }), {
          access: 'public',
          addRandomSuffix: true,
          contentType: 'application/json',
        }).catch(e => console.error('[BLOB LEAD]', e.message));
      }
    }

    // Validação + clamp via filterValidEvents (immutable — preserva events original).
    const validatedEvents = filterValidEvents([eventPayload]);
    if (validatedEvents.length === 0) {
      return res.status(400).json({ error: 'event failed validation' });
    }

    // routedPixelId já resolvido acima (escopo handler) — multi-tenant Pixel routing.
    // CAPI send via helper central: retry 2x, rate limit monitor, defensive parse.
    const result = await sendCapiEvents(validatedEvents, token, { pixelId: routedPixelId });
    const finalResult = result;
    const capiSuccess = !result.error;
    if (result.error) {
      const { code, error_subcode, message, is_transient } = result.error;
      console.error(`[TRACK CAPI ERROR] code=${code} subcode=${error_subcode} transient=${is_transient} event=${event_name} msg=${message}`);
    }

    // Fix 21/04/2026: FAN-OUT WAM Dataset. Browser já envia via fbq duplo
    // (Pixel + WAM) mas server-side só ia pro Pixel → WAM perdia server
    // redundancy e EMQ do event_id server.
    //
    // Fix 22/04/2026: GATE por WAM_ALLOWED_EVENTS ANTES de chamar sendWAMEvent.
    // Antes, todo /api/track POST (ex: PageView) gerava skip log ruído +
    // latência desnecessária de function call. Agora só dispara pra events
    // whitelist (ViewContent/Lead/CR/Purchase/IC etc). PageView fica fora
    // silenciosamente — é evento web Pixel-only, não tem equivalente no WAM.
    if (WAM_ALLOWED_EVENTS.has(event_name)) {
      try {
        const wamResp = await sendWAMEvent({
          event_name,
          event_id,
          event_time: eventTime,
          user_data: { ...userData },
          custom_data,
          action_source: 'website',
          // Fix 22/04/2026: original_event_data self-reference — ajuda Meta
          // consolidar server-side WAM event com Pixel browser WAM event
          // (ambos com mesmo event_id). Sem isso, diagnostic "server events
          // not deduplicated" aparece mesmo com event_id batendo.
          original_event_data: originalEventData,
        });
        if (wamResp?.skipped) console.log(`[WAM TRACK] skipped ${event_name}: ${wamResp.skipped}`);
        else if (wamResp?.error) console.warn(`[WAM TRACK] err ${event_name}: ${wamResp.error.message}`);
        else console.log(`[WAM TRACK] ✅ ${event_name} received=${wamResp?.events_received}`);
      } catch (wamErr) {
        console.warn('[WAM TRACK] exception:', wamErr.message);
      }
    }

    // Server-set cookies: bypass iOS ITP 7-day JS cookie limit
    // HTTP Set-Cookie headers persist up to 180 days even in Safari
    // Cookies setados independente de CAPI success (benefit user mesmo se Meta errou)
    // Fix MEDIUM AI review 20/04/2026 (M16): Domain=.icelasers.com.br garante que
    // cookie é visível em subdomínios (www/api/staging). Sem Domain=, é host-only
    // → se LP está em www.icelasers.com.br e api em icelasers.com.br, cookies
    // divergem e Pixel browser+CAPI server geram _fbp diferentes (dedup falha).
    const cookieOpts = 'Path=/; Domain=.icelasers.com.br; SameSite=Lax; Secure; Max-Age=15552000'; // 180 days
    const setCookies = [];
    if (finalFbp) setCookies.push(`_fbp=${finalFbp}; ${cookieOpts}`);
    if (finalFbc) setCookies.push(`_fbc=${finalFbc}; ${cookieOpts}`);
    if (setCookies.length > 0) res.setHeader('Set-Cookie', setCookies);

    // HIGH fix 19/04/2026: antes retornava 200 mesmo se CAPI errou não-transiente.
    // LP não sabia que evento não chegou na Meta. Agora reflete realidade.
    // 502 Bad Gateway é correto: proxy (nosso) recebeu erro do upstream (Meta).
    if (!capiSuccess) {
      return res.status(502).json({
        ok: false,
        error: 'capi_upstream_error',
        details: finalResult.error?.message || 'CAPI non-transient error',
      });
    }
    return res.status(200).json({ ok: true, events_received: finalResult.events_received });
  } catch (err) {
    // Fix MEDIUM AI review 20/04/2026 (M18): não retornar err.message ao cliente.
    // Pode vazar URLs internas, tokens parciais, stack traces (info disclosure).
    // Detalhes logados internamente; resposta pública = mensagem genérica.
    console.error('[TRACK] Unhandled:', err?.message, err?.stack?.split('\n').slice(0, 3).join(' | '));
    return res.status(500).json({ error: 'internal_error' });
  }
}
