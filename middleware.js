/**
 * Edge Middleware — Redirect 301 de domínios vercel.app → icelasers.com.br
 * Preserva path + query params (UTMs, fbclid, etc.)
 * Não afeta chamadas /api/ (webhooks, CAPI, pixel proxy)
 */

export const config = {
  matcher: ['/((?!api/).*)'],
};

export default function middleware(request) {
  const host = request.headers.get('host') || '';

  if (host.includes('.vercel.app')) {
    const url = new URL(request.url);
    url.hostname = 'icelasers.com.br';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }
}
