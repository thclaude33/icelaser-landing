/**
 * Edge Middleware — Redirect 301 + CAPI ViewContent server-side
 * 1. Redirect domínios vercel.app → icelasers.com.br
 * 2. Dispara ViewContent CAPI server-side pra CADA visita (cobertura 100%)
 *
 * IMPORTANTE: Edge Runtime não suporta Node.js crypto.
 * Usa Web Crypto API (crypto.subtle) disponível globalmente no Edge.
 */

const PIXEL_ID = '2774496306216737';

export const config = {
  matcher: ['/((?!api/).*)'],
};

async function sha256(value) {
  const encoded = new TextEncoder().encode(String(value).trim().toLowerCase());
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function middleware(request) {
  const host = request.headers.get('host') || '';

  // Redirect .vercel.app → icelasers.com.br
  if (host.includes('.vercel.app')) {
    const url = new URL(request.url);
    url.hostname = 'icelasers.com.br';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }

  // Só disparar CAPI pra requests de página (não assets)
  const url = new URL(request.url);
  const path = url.pathname;
  if (path !== '/' && path !== '/index.html') return;

  // Não disparar pra bots/crawlers
  const ua = request.headers.get('user-agent') || '';
  if (/bot|crawl|spider|facebook|meta|google|bing/i.test(ua)) return;

  // Extrair dados do request
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.ip || '';
  const cookies = request.headers.get('cookie') || '';
  const fbpMatch = cookies.match(/(?:^|;\s*)_fbp=([^;]*)/);
  const fbcMatch = cookies.match(/(?:^|;\s*)_fbc=([^;]*)/);
  const fbp = fbpMatch ? fbpMatch[1] : undefined;
  const fbc = fbcMatch ? fbcMatch[1] : undefined;

  // Gerar event_id server-side (será o mesmo usado pelo browser pra dedup)
  // Formato: sv_{timestamp}_{random} — prefixo sv_ pra diferenciar do browser vc_
  const eventId = 'sv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);

  // user_data com dados server-side (mais completos que browser)
  const userData = {
    client_user_agent: ua,
    client_ip_address: ip,
    country: [await sha256('br')],
    st: [await sha256('pe')],
    ct: [await sha256('recife')],
    zp: [await sha256('50000')],
  };
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  if (fbp) userData.external_id = [await sha256(fbp)];

  const payload = {
    data: [{
      event_name: 'ViewContent',
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      event_source_url: request.url.split('?')[0].replace(/\/$/, '') || 'https://icelasers.com.br',
      action_source: 'website',
      user_data: userData,
      custom_data: {
        value: 0,
        currency: 'BRL',
        content_name: 'LP Avaliacao Gratuita',
        content_category: 'depilacao_laser',
      },
    }],
  };

  const token = process.env.META_ACCESS_TOKEN;
  if (!token) return;

  // Disparar CAPI assíncrono (não bloqueia a página)
  // Meta deduplica server+browser ViewContent pelo fbp+event_name (método 2)
  // Se browser também enviar, Meta mantém 1. Se browser falhar, server garante cobertura.
  const capiUrl = `https://graph.facebook.com/v25.0/${PIXEL_ID}/events?access_token=${token}`;
  fetch(capiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
