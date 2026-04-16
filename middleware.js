/**
 * Edge Middleware
 * 1. Redirect domínios vercel.app → icelasers.com.br
 * 2. Gera _fbp server-side pra novos visitantes (bypassa iOS ITP 7d → 180d)
 * 3. Rate limiting best-effort por IP (WARN-ONLY; enforce via env)
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

// Rate limit: 120 requests por minuto por IP (conservador pra não impactar usuários legítimos)
// Edge Runtime: Map persiste por instance enquanto quente. Reset em cold start — best effort.
const RL_WINDOW_MS = 60_000;
const RL_MAX = parseInt(process.env.RATE_LIMIT_MAX || '120', 10);
const RL_ENFORCE = process.env.RATE_LIMIT_ENFORCE === '1';
const rlBuckets = new Map();

function generateFbp() {
  // Formato oficial Meta: fb.{subdomainIndex}.{timestamp_ms}.{random}
  // subdomainIndex=1 pra icelasers.com.br (apex domain)
  return `fb.1.${Date.now()}.${Math.floor(Math.random() * 1e16)}`;
}

function checkRateLimit(ip) {
  if (!ip) return { ok: true, count: 0 };
  const now = Date.now();
  const bucket = rlBuckets.get(ip);

  if (!bucket || now - bucket.start > RL_WINDOW_MS) {
    rlBuckets.set(ip, { start: now, count: 1 });
    // GC leve: limpar buckets velhos esporadicamente
    if (rlBuckets.size > 5000) {
      for (const [k, v] of rlBuckets) {
        if (now - v.start > RL_WINDOW_MS) rlBuckets.delete(k);
      }
    }
    return { ok: true, count: 1 };
  }

  bucket.count += 1;
  return { ok: bucket.count <= RL_MAX, count: bucket.count };
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

  // 2. Rate limit check (WARN-ONLY por padrão)
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || request.headers.get('x-real-ip')
    || '';
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    console.warn(`[RATE-LIMIT] ip=${ip} count=${rl.count} enforce=${RL_ENFORCE}`);
    if (RL_ENFORCE) {
      return new Response('Too Many Requests', {
        status: 429,
        headers: { 'Retry-After': '60' },
      });
    }
  }

  // 3. Gera _fbp server-side se não existir
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
