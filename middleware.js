/**
 * Edge Middleware
 * 1. Redirect domínios vercel.app → icelasers.com.br
 * 2. Gera _fbp server-side pra novos visitantes (bypassa iOS ITP 7d → 180d)
 *
 * NOTA: ViewContent CAPI foi removido daqui pois index.html já dispara
 * browser pixel + CAPI via /api/track com o mesmo event_id (vc_XXXX),
 * garantindo deduplicação correta.
 */

import { next } from '@vercel/edge';

export const config = {
  matcher: ['/((?!api/).*)'],
};

const FBP_MAX_AGE = 15552000; // 180 dias (bypassa iOS ITP 7d do JS cookie)

function generateFbp() {
  // Formato oficial Meta: fb.{subdomainIndex}.{timestamp_ms}.{random}
  // subdomainIndex=1 pra icelasers.com.br (apex domain)
  return `fb.1.${Date.now()}.${Math.floor(Math.random() * 1e16)}`;
}

export default function middleware(request) {
  const host = request.headers.get('host') || '';

  // 1. Redirect .vercel.app → icelasers.com.br
  if (host.includes('.vercel.app')) {
    const url = new URL(request.url);
    url.hostname = 'icelasers.com.br';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }

  // 2. Gera _fbp server-side se não existir
  //    iOS Safari ITP limita JS-set cookies a 7 dias — HTTP-set Max-Age vale até 180 dias
  const cookies = request.headers.get('cookie') || '';
  const hasFbp = /(?:^|;\s*)_fbp=/.test(cookies);

  if (!hasFbp) {
    const response = next();
    response.headers.append(
      'Set-Cookie',
      `_fbp=${generateFbp()}; Path=/; Max-Age=${FBP_MAX_AGE}; SameSite=Lax; Secure`
    );
    return response;
  }
}
