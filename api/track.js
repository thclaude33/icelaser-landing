import nodemailer from 'nodemailer';
import { put, list } from '@vercel/blob';
import { PIXEL_ID, ALLOWED_ORIGINS, GRAPH_BASE } from './_lib/config.js';
import { sha256, normalizePhoneBR, escapeHtml, sanitizeHeader, sanitizeUrl } from './_lib/security.js';
import { buildUserData } from './_lib/piiBuilder.js';
import { PARTNER_AGENT } from './_lib/capi.js';

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

async function enviarEmailLead(nome, telefone, origem = {}) {
  if (!EMAIL_PASS) { console.warn('[EMAIL LEAD] EMAIL_PASS não configurado — email ignorado'); return; }
  try {
    const t = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: EMAIL_FROM, pass: EMAIL_PASS },
    });
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
  // CORS: só seta Access-Control-Allow-Origin pra origens permitidas.
  // Antes caía em fallback ALLOWED_ORIGINS[0] — permissivo demais, browser
  // bloqueava na prática mas ruído pra debug de CORS.
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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
  const userData = await buildUserData({
    email: normalizedEmail || undefined,
    phone: normalizedPhone || undefined,
    first_name: firstName || undefined,
    last_name: lastName || undefined,
    city: 'recife',
    state: 'pe',
    zip_code: '50000',
    country: 'br',
    gender: 'f',             // público alvo 100% feminino (mulheres 20-44)
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
      const blobs = await list({ prefix: 'leads/', limit: 100 });
      for (const blob of blobs.blobs) {
        if (blob.size > 200) {
          const res = await fetch(blob.url);
          const data = await res.json();
          const blobTel = (data.telefone || '').replace(/\D/g, '');
          if (blobTel && telDigits.endsWith(blobTel.slice(-8))) {
            if (!finalFbp && data.fbp) finalFbp = data.fbp;
            if (!finalFbc && data.fbc) finalFbc = data.fbc;
            if (finalFbp && finalFbc) break;
          }
        }
      }
      if (finalFbp !== fbp || finalFbc !== fbc) {
        console.log(`[TRACK] Recovered from Blob: fbp=${!!finalFbp} fbc=${!!finalFbc} for ${telefone}`);
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
  const custom_data = {};
  if (event_name === 'CompleteRegistration') {
    custom_data.value = 0;
    custom_data.currency = 'BRL';
    custom_data.status = 'submitted';
    custom_data.content_name = 'Avaliacao Gratuita LP';
    custom_data.customer_segmentation = 'new_customer_to_business';
  } else if (event_name === 'InitiateCheckout') {
    custom_data.value = 0;
    custom_data.currency = 'BRL';
    custom_data.content_name = 'Form Avaliacao Gratuita';
    custom_data.customer_segmentation = 'new_customer_to_business';
  } else if (event_name === 'Lead') {
    custom_data.value = 0;
    custom_data.currency = 'BRL';
    custom_data.content_name = 'Avaliacao Gratuita LP';
    custom_data.content_category = 'depilacao_laser';
    custom_data.lead_event_source = 'landing_page';
    custom_data.customer_segmentation = 'new_customer_to_business';
  } else if (event_name === 'ViewContent') {
    custom_data.value = 0;
    custom_data.currency = 'BRL';
    custom_data.content_name = 'LP Avaliacao Gratuita';
    custom_data.content_category = 'depilacao_laser';
    custom_data.customer_segmentation = 'new_customer_to_business';
  } else if (event_name === 'PageView') {
    // PageView não precisa de custom_data — só user_data para matching.
    // customer_segmentation não se aplica (Meta docs só cita em eventos de funil).
  }

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

  // event_time: se browser mandou e é válido (dentro da janela 7d Meta), usa ele.
  // Senão, now. Isso sincroniza pixel.eventTime ↔ CAPI.eventTime — melhor pra attribution.
  const nowSec = Math.floor(Date.now() / 1000);
  const minValidTime = nowSec - 7 * 24 * 3600 + 600;  // 7d window com margem
  const parsedBodyTime = Number(bodyEventTime);
  const eventTime = Number.isFinite(parsedBodyTime) && parsedBodyTime >= minValidTime && parsedBodyTime <= nowSec
    ? parsedBodyTime
    : nowSec;

  const payload = {
    data: [{
      event_name,
      event_time: eventTime,
      event_id,
      event_source_url: event_source_url || 'https://icelasers.com.br/',
      action_source: 'website',
      user_data: userData,
      ...(Object.keys(custom_data).length > 0 && { custom_data }),
    }],
    // Meta best practice: partner_agent identifica plataforma (<23 chars, >=2 letras).
    partner_agent: PARTNER_AGENT,
  };

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return res.status(500).json({ error: 'META_ACCESS_TOKEN not configured' });

  try {
    // Roda email + CAPI em paralelo — ambos aguardados antes de responder
    // Authorization: Bearer (mais seguro que access_token na URL — evita leak em logs)
    const promises = [
      fetch(
        `${GRAPH_BASE}/${PIXEL_ID}/events`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify(payload),
        }
      ),
    ];

    // Email + Blob no evento Lead (com ou sem telefone — WA direto não tem tel)
    if (event_name === 'Lead' && nome) {
      // Fire-and-forget: email não bloqueia a resposta ao usuário
      enviarEmailLead(nome, telefone, {
        email,
        event_source_url, utm_source, utm_medium, utm_campaign,
        utm_content, utm_term, ad_id, ad_name, adset_id, adset_name,
        campaign_id, campaign_name, placement, site_source_name, platform,
        client_user_agent, client_ip_address, fbp, fbc,
        screen_width, screen_height, language, timezone, referrer,
        landing_url, time_on_page, scroll_depth,
      }).catch(e => console.error('[EMAIL LEAD]', e.message));

      // Salva lead no Blob (só se token configurado)
      if (process.env.BLOB_READ_WRITE_TOKEN) {
      const ts = new Date().toISOString();
      // Sanitiza firstName pra evitar path traversal / chars inválidos no filename
      const firstName = nome.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20) || 'anon';
      const fileName = `leads/pending/${ts.replace(/[:.]/g, '-')}_${firstName}.json`;
      promises.push(
        put(fileName, JSON.stringify({
          nome,
          telefone,
          email: email || undefined,
          timestamp: ts,
          event_id,
          event_source_url: event_source_url || 'https://icelasers.com.br/',
          client_user_agent: client_user_agent || req.headers['user-agent'],
          client_ip_address,
          fbp: fbp || undefined,
          fbc: fbc || undefined,
          // Origem completa: campanha, anúncio, público, placement
          utm_source, utm_medium, utm_campaign, utm_content, utm_term,
          ad_id, ad_name, adset_id, adset_name, campaign_id, campaign_name,
          placement, site_source_name, platform,
          // Qualificação
          screen_width, screen_height, language, timezone, referrer,
          landing_url, time_on_page, scroll_depth,
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

    // Monitorar X-App-Usage e X-Business-Use-Case-Usage pra antecipar rate limits
    const appUsage = metaResponse.headers.get('x-app-usage');
    if (appUsage) {
      try {
        const usage = JSON.parse(appUsage);
        if (usage.call_count > 80 || usage.total_cputime > 80 || usage.total_time > 80) {
          console.warn(`[TRACK] ⚠️ Rate limit approaching: call_count=${usage.call_count}% cpu=${usage.total_cputime}% time=${usage.total_time}%`);
        }
      } catch {}
    }
    const bucUsage = metaResponse.headers.get('x-business-use-case-usage');
    if (bucUsage) {
      try {
        const buc = JSON.parse(bucUsage);
        for (const [bizId, entries] of Object.entries(buc)) {
          for (const e of entries) {
            if (e.call_count > 80 || e.total_cputime > 80 || e.total_time > 80) {
              console.warn(`[BUC] ⚠️ ${e.type} limit approaching: call=${e.call_count}% cpu=${e.total_cputime}% time=${e.total_time}% | recover=${e.estimated_time_to_regain_access}min`);
            }
          }
        }
      } catch {}
    }

    // Error handling com is_transient e blame_field_specs
    if (result.error) {
      const { code, error_subcode, message, is_transient } = result.error;
      const blame = result.error.blame_field_specs ? ` | blame: ${JSON.stringify(result.error.blame_field_specs)}` : '';
      console.error(`[TRACK CAPI ERROR] code=${code} subcode=${error_subcode} transient=${is_transient} event=${event_name} msg=${message}${blame}`);

      // Retry 1x em erros transientes
      if (is_transient) {
        await new Promise(r => setTimeout(r, 1000));
        const retryRes = await fetch(
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
        const retryResult = await retryRes.json();
        if (!retryResult.error) {
          console.log(`[TRACK] Retry succeeded for ${event_name}`);
        }
      }
    }

    // Server-set cookies: bypass iOS ITP 7-day JS cookie limit
    // HTTP Set-Cookie headers persist up to 180 days even in Safari
    const cookieOpts = 'Path=/; SameSite=Lax; Secure; Max-Age=15552000'; // 180 days
    const setCookies = [];
    if (finalFbp) setCookies.push(`_fbp=${finalFbp}; ${cookieOpts}`);
    if (finalFbc) setCookies.push(`_fbc=${finalFbc}; ${cookieOpts}`);
    if (setCookies.length > 0) res.setHeader('Set-Cookie', setCookies);

    return res.status(200).json({ ok: true, events_received: result.events_received });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
