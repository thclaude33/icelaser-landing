import { list } from '@vercel/blob';

export const FOLLOWUP_CTWA_MAX_AGE_MS = 70 * 3600 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export function ctwaPhoneVariants(rawPhone) {
  const digits = String(rawPhone || '').replace(/\D/g, '');
  if (!digits) return [];
  const variants = new Set([digits]);
  if (!digits.startsWith('55') && digits.length >= 10 && digits.length <= 11) {
    variants.add(`55${digits}`);
  }
  const br = digits.startsWith('55') ? digits : `55${digits}`;
  if (br.length === 12) {
    variants.add(`${br.slice(0, 4)}9${br.slice(4)}`);
  }
  if (br.length === 13 && br[4] === '9') {
    variants.add(`${br.slice(0, 4)}${br.slice(5)}`);
  }
  return Array.from(variants).filter(Boolean);
}

function blobTimestampMs(data = {}, blob = {}) {
  const raw = data.timestamp || data.created_at || blob.uploadedAt || null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function isRecentCtwaBlob(data = {}, blob = {}, anchorMs = Date.now(), maxAgeMs = FOLLOWUP_CTWA_MAX_AGE_MS) {
  if (!data?.ctwa_clid) return false;
  const ts = blobTimestampMs(data, blob);
  if (!ts) return false;
  return ts >= anchorMs - maxAgeMs && ts <= anchorMs + CLOCK_SKEW_MS;
}

export async function getRecentCtwaContextForPhone(rawPhone, opts = {}) {
  if (!process.env.BLOB_READ_WRITE_TOKEN && !opts.listFn) return { is_ctwa: false };
  const variants = ctwaPhoneVariants(rawPhone);
  if (variants.length === 0) return { is_ctwa: false };

  const listFn = opts.listFn || list;
  const fetchFn = opts.fetchFn || fetch;
  const anchorMs = opts.anchorMs || Date.now();
  const maxAgeMs = opts.maxAgeMs || FOLLOWUP_CTWA_MAX_AGE_MS;
  let best = null;

  try {
    for (const phoneKey of variants) {
      let cursor;
      do {
        const result = await listFn({ prefix: `ctwa/${phoneKey}`, cursor, limit: 100 });
        for (const blob of result.blobs || []) {
          try {
            const resp = await fetchFn(blob.url, { signal: AbortSignal.timeout(3000) });
            if (!resp.ok) continue;
            const data = await resp.json();
            if (isRecentCtwaBlob(data, blob, anchorMs, maxAgeMs)) {
              const ts = blobTimestampMs(data, blob);
              if (!best || ts > best.timestamp_ms) {
                best = {
                  is_ctwa: true,
                  ctwa_clid: data.ctwa_clid,
                  phone_variant: phoneKey,
                  timestamp_ms: ts,
                  template_free_until_at: new Date(ts + maxAgeMs).toISOString(),
                };
              }
            }
          } catch (err) {
            console.warn(`[FU-CTWA] blob read failed variant=${phoneKey}: ${err?.message || err}`);
          }
        }
        cursor = result.hasMore ? result.cursor : undefined;
      } while (cursor);
    }
  } catch (err) {
    console.warn(`[FU-CTWA] lookup failed phone=${String(rawPhone || '').slice(-4)}: ${err?.message || err}`);
  }
  if (best) {
    console.log(`[FU-CTWA] found recent ctwa_clid for phone_variant=${best.phone_variant}`);
    return best;
  }
  return { is_ctwa: false };
}

export async function hasRecentCtwaClidForPhone(rawPhone, opts = {}) {
  const ctx = await getRecentCtwaContextForPhone(rawPhone, opts);
  return ctx.is_ctwa === true;
}
