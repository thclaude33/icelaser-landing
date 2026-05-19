/**
 * Edge Middleware
 * 1. Redirect domínios vercel.app → icelasers.com.br
 * 2. Gera _fbp server-side pra novos visitantes (bypassa iOS ITP 7d → 180d)
 * 3. Captura _fbc server-side quando URL tem ?fbclid= (antes do JS rodar)
 * 4. Rate limiting best-effort por IP (WARN-ONLY; enforce via env)
 *
 * NOTA: ViewContent CAPI foi removido daqui pois index.html já dispara
 * browser pixel + CAPI via /api/track com o mesmo event_id (vc_XXXX),
 * garantindo deduplicação correta.
 */

import { next, rewrite } from '@vercel/edge';

/**
 * Matcher exclui paths que NÃO devem passar pelo middleware:
 *  - api/: serverless handlers próprios
 *  - .well-known/: protocolo reservado (Vercel Flags Explorer exige resposta
 *    DIRETA do /.well-known/vercel/flags, não 301 redirect de preview URL →
 *    icelasers.com.br; senão Flags Explorer retorna INVALID_WELL_KNOWN_FLAGS_BLOCKED).
 *  - _vercel/: Vercel internal (Analytics, Speed Insights)
 *  - fonts/, assets/, *.woff2, favicon.ico, apple-touch-icon.png: static assets
 *    genéricos. JP precisa passar por middleware em manifest/meta/robots/sitemap
 *    para não servir artefatos Recife no domínio jpa.icelasers.com.br.
 */
export const config = {
  matcher: [
    '/manifest.json',
    '/meta.json',
    '/robots.txt',
    '/sitemap.xml',
    '/privacidade/:path*',
    '/((?!api/|\\.well-known/|_vercel/|fonts/|assets/|.*\\.(?:woff2?|ttf|eot|ico|png|jpg|jpeg|svg|webp|avif)$).*)',
  ],
};

const FBP_MAX_AGE = 15552000; // 180 dias (bypassa iOS ITP 7d do JS cookie)
const FBC_MAX_AGE = 7776000;  // 90 dias — padrão Meta pra _fbc

// Rate limit: 120 requests por minuto por IP (conservador pra não impactar usuários legítimos)
// Edge Runtime: Map persiste por instance enquanto quente. Reset em cold start — best effort.
const RL_WINDOW_MS = 60_000;
const RL_MAX = parseInt(process.env.RATE_LIMIT_MAX || '120', 10);
const RL_ENFORCE = process.env.RATE_LIMIT_ENFORCE === '1';
const rlBuckets = new Map();

/**
 * Calcula subdomainIndex conforme Meta SDK oficial (nodejs ParamBuilder.js):
 *   etld_plus_1.split('.').length - 1
 *
 * Verificado executando o SDK real (test-subdomain.mjs) contra icelasers.com.br:
 *   host=icelasers.com.br          → subdomainIndex=2
 *   host=www.icelasers.com.br      → subdomainIndex=2 (TLD composto .com.br)
 *   host=example.com               → subdomainIndex=1
 *   host=www.example.com           → subdomainIndex=1
 *
 * `.com.br` é TLD composto (2-part TLD): Meta SDK usa public suffix list e
 * interpreta ambos icelasers.com.br e www.icelasers.com.br como eTLD+1=icelasers.com.br
 * → index = 3 - 1 = 2 em ambos os casos. Consistência crítica com Pixel browser
 * (que carrega o mesmo SDK via unpkg CDN) — mismatch aqui causa Events Manager flag.
 */
function computeSubdomainIndex(host) {
  if (!host) return 2;
  // Strip port (host:port) e lowercase.
  const clean = host.split(':')[0].toLowerCase();
  
  // Known multi-part (2-level) TLDs: .com.br, .co.uk, .co.in, etc.
  // Para esses casos, o eTLD+1 exclui subdomínios como www.
  // Exemplos: icelasers.com.br e www.icelasers.com.br ambos têm eTLD+1 = icelasers.com.br
  const multiPartTlds = ['.com.br', '.co.uk', '.co.in', '.co.za', '.ac.uk', '.com.au', '.co.nz'];
  for (const tld of multiPartTlds) {
    if (clean.endsWith(tld)) {
      // Extract eTLD+1: remove tld suffix, take last segment before it, append tld
      const beforeTld = clean.slice(0, -(tld.length));
      const lastSegment = beforeTld.split('.').pop();
      const etld1 = lastSegment + tld;
      const segments = etld1.split('.').filter(Boolean);
      return Math.max(1, segments.length - 1);
    }
  }
  
  // For single-part TLDs (.com, .org, etc.), use standard calculation
  const segments = clean.split('.').filter(Boolean);
  if (segments.length === 0) return 2;
  return Math.max(1, segments.length - 1);
}

function generateFbp(host) {
  // Formato oficial Meta: fb.{subdomainIndex}.{timestamp_ms}.{random}
  // Fix LOW AI deep v3 (middleware.js:66): Math.random() edge runtime = xorshift128+
  // determinístico por isolate. crypto.getRandomValues é CSPRNG disponível em Edge.
  // Evita collisions teóricas em cold start + múltiplos users mesmo ms.
  const idx = computeSubdomainIndex(host);
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  // Convert bytes to decimal número representável em JS (16 dígitos ~= 53 bits).
  let rand = 0;
  for (const b of arr) rand = (rand * 256 + b) % 1e16;
  return `fb.${idx}.${Date.now()}.${Math.floor(rand)}`;
}

function buildFbcFromClid(fbclid, host) {
  // Formato oficial Meta: fb.{subdomainIndex}.{creationTime_ms}.{fbclid}
  // timestamp em MILISSEGUNDOS (doc oficial Meta 2026).
  // fbclid CASE-SENSITIVE — nunca alterar.
  const idx = computeSubdomainIndex(host);
  return `fb.${idx}.${Date.now()}.${fbclid}`;
}

/**
 * Extrai fbclid da query string aplicando o mesmo algoritmo da Meta
 * capi-param-builder SDK oficial (client_js/shared/utils/urlUtil.js).
 * Aceita ?fbclid=X, &fbclid=X, #fbclid=X ou fim de URL.
 * Replace + com espaco e depois decodeURIComponent recuperam o valor
 * ORIGINAL gerado pela Meta (antes do browser codar).
 */
function extractFbclid(urlOrQuery) {
  if (!urlOrQuery) return null;
  const regex = /[?#&]fbclid(=([^&#]*)|&|#|$)/;
  const results = regex.test(urlOrQuery) ? urlOrQuery.match(regex) : null;
  if (!results) return null;
  if (!results[2]) return '';
  try {
    return decodeURIComponent(results[2].replace(/\+/g, ' '));
  } catch {
    return results[2];
  }
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
  // EXCEÇÃO: preview URLs com branch jp-routing OU contém "jpa" no slug
  // são usadas pra testar a LP JP — não redireciona pra prod Recife.
  // Heurística simples: se o slug tem "jpa", trata como JP (rewrite abaixo).
  const isJpPreview = host.includes('.vercel.app') && /jpa|jp-routing|bancarios/i.test(host);
  if (host.includes('.vercel.app') && !isJpPreview) {
    const url = new URL(request.url);
    url.hostname = 'icelasers.com.br';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }

  // 1b. Detecta host JP — rewrite efetivo aplicado no FINAL do middleware
  // (junto com cookies fbp/fbc, pra não bypassa-los).
  // jpa.icelasers.com.br ou preview Vercel com "jpa" no slug serve index-jpa.html.
  const isJpHost = host === 'jpa.icelasers.com.br' || isJpPreview;

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

  // 3. Cookie setup pra fbp/fbc (bypassa iOS Safari ITP; HTTP-set vale mais que JS)
  const cookies = request.headers.get('cookie') || '';
  const url = new URL(request.url);
  // fbclid: extração IDÊNTICA à Meta capi-param-builder oficial (urlUtil.js).
  // Source: https://github.com/facebook/capi-param-builder/blob/main/client_js/shared/utils/urlUtil.js
  // `decodeURIComponent(m[2].replace(/\+/g, ' '))` — exato mesmo código Meta SDK.
  // Consistência crítica: server-side e client-side SDK DEVEM extrair fbclid
  // do mesmo jeito, senão cookie fica dessincronizado entre middleware e Pixel browser.
  const fbclid = extractFbclid(url.search);

  const hasFbp = /(?:^|;\s*)_fbp=/.test(cookies);
  const fbcCookieMatch = cookies.match(/(?:^|;\s*)_fbc=([^;]+)/);
  const existingFbc = fbcCookieMatch ? fbcCookieMatch[1] : null;

  // Critério pra setar fbc:
  //  - não existe cookie _fbc AINDA → setar se tem fbclid
  //  - existe mas fbclid da URL atual é DIFERENTE → atualizar (click novo)
  let shouldSetFbc = false;
  if (fbclid) {
    if (!existingFbc) {
      shouldSetFbc = true;
    } else {
      // Extrai o fbclid do cookie existente (último segmento após "fb.1.ts.")
      const existingClid = existingFbc.split('.').slice(3).join('.');
      if (existingClid !== fbclid) shouldSetFbc = true;
    }
  }

  // Fix MEDIUM AI deep v3 (middleware.js:174): Domain=.icelasers.com.br pra
  // cookies funcionarem cross-subdomain (www/api). Sem Domain= cookies são
  // host-only e divergem do Set-Cookie de /api/track (que agora usa Domain=).
  // Se host não é icelasers.com.br (ex: vercel.app preview), omite Domain.
  const isProdHost = typeof host === 'string' && host.endsWith('icelasers.com.br');
  const domainAttr = isProdHost ? '; Domain=.icelasers.com.br' : '';
  const cookiesToSet = [];
  if (!hasFbp) {
    cookiesToSet.push(
      `_fbp=${generateFbp(host)}; Path=/${domainAttr}; Max-Age=${FBP_MAX_AGE}; SameSite=Lax; Secure`
    );
  }
  if (shouldSetFbc) {
    cookiesToSet.push(
      `_fbc=${buildFbcFromClid(fbclid, host)}; Path=/${domainAttr}; Max-Age=${FBC_MAX_AGE}; SameSite=Lax; Secure`
    );
  }

  // Helper pra construir response final — aplica rewrite jpa.* → /index-jpa.html
  // OU /v2/* → /v2-jpa/* OU next() pra Recife (sem rewrite). Cookies fbp/fbc são anexados.
  //
  // FIX BUG 1 (Codex 17/05/2026): JP /v2/ servia conteúdo Recife em produção.
  // Antes: middleware só fazia rewrite JP em '/' e '/index.html'. Path /v2 caía em
  // vercel.json (line 202) redirect global /v2 → /v2/ que servia /v2/index.html Recife.
  // Agora: JP host + /v2[/...] → reescreve pra /v2-jpa/... incluindo assets.
  const buildResponse = () => {
    if (isJpHost) {
      const rewriteUrl = new URL(request.url);
      if (url.pathname === '/manifest.json') {
        rewriteUrl.pathname = '/manifest-jpa.json';
        return rewrite(rewriteUrl);
      }
      if (url.pathname === '/meta.json') {
        rewriteUrl.pathname = '/meta-jpa.json';
        return rewrite(rewriteUrl);
      }
      if (url.pathname === '/robots.txt') {
        rewriteUrl.pathname = '/robots-jpa.txt';
        return rewrite(rewriteUrl);
      }
      if (url.pathname === '/sitemap.xml') {
        rewriteUrl.pathname = '/sitemap-jpa.xml';
        return rewrite(rewriteUrl);
      }
      if (url.pathname === '/privacidade' || url.pathname === '/privacidade/') {
        rewriteUrl.pathname = '/privacidade-jpa/index.html';
        return rewrite(rewriteUrl);
      }
      // Home
      if (url.pathname === '/' || url.pathname === '/index.html') {
        rewriteUrl.pathname = '/index-jpa.html';
        return rewrite(rewriteUrl);
      }
      // /v2 ou /v2/ ou /v2/index.html → /v2-jpa/index.html
      if (url.pathname === '/v2' || url.pathname === '/v2/' || url.pathname === '/v2/index.html') {
        rewriteUrl.pathname = '/v2-jpa/index.html';
        return rewrite(rewriteUrl);
      }
      // /v2/assets/* → /v2-jpa/assets/* (preserva tracking.js/imagens JP)
      if (url.pathname.startsWith('/v2/assets/')) {
        rewriteUrl.pathname = url.pathname.replace('/v2/assets/', '/v2-jpa/assets/');
        return rewrite(rewriteUrl);
      }
      // /v2/<outros sub-paths> → /v2-jpa/<sub-path>
      if (url.pathname.startsWith('/v2/')) {
        rewriteUrl.pathname = url.pathname.replace('/v2/', '/v2-jpa/');
        return rewrite(rewriteUrl);
      }
    }
    return next();
  };

  if (cookiesToSet.length > 0) {
    const baseResponse = buildResponse();
    // Defensive: construir nova Response com Headers mutáveis garantidamente.
    // Algumas versões do Edge Runtime retornam Response com headers immutável após
    // rewrite() — clonar via new Headers() + new Response() previne TypeError silent.
    // Comportamento idêntico ao append() direto quando headers são mutáveis (ambos OK).
    const headers = new Headers(baseResponse.headers);
    for (const c of cookiesToSet) headers.append('Set-Cookie', c);
    return new Response(baseResponse.body, {
      status: baseResponse.status,
      statusText: baseResponse.statusText,
      headers,
    });
  }
  // Fix AI audit 20/04/2026 (middleware.js:221): explicit return next() no
  // fallthrough path. Antes: função terminava sem return quando nenhum cookie
  // precisava setar → Vercel Edge retorna undefined → comportamento default é
  // passar a request adiante, mas explicitar é mais claro + safer pra futuras
  // mudanças. Agora também trata rewrite jpa.* → /index-jpa.html via buildResponse.
  return buildResponse();
}
