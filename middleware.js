/**
 * Edge Middleware — Redirect 301
 * 1. Redirect domínios vercel.app → icelasers.com.br
 *
 * NOTA: ViewContent CAPI foi removido daqui pois index.html já dispara
 * browser pixel + CAPI via /api/track com o mesmo event_id (vc_XXXX),
 * garantindo deduplicação correta. O middleware disparava com sv_XXXX
 * causando contagem dupla (sem deduplicação entre sv_ e vc_).
 */

export const config = {
  matcher: ['/((?!api/).*)'],
};

export default function middleware(request) {
  const host = request.headers.get('host') || '';

  // Redirect .vercel.app → icelasers.com.br
  if (host.includes('.vercel.app')) {
    const url = new URL(request.url);
    url.hostname = 'icelasers.com.br';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }
}
