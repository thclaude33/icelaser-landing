/**
 * Test suite: pending-queue.js — fila de mensagens em rajada (incidente Rosane 614).
 * Runtime: node:test (node 18+).
 *
 * Estratégia: kvFetch usa globalThis.fetch contra a REST do Upstash (path-style).
 * Montamos um fake-Redis em memória e monkey-patch do fetch pra rotear comandos.
 * Testa a LÓGICA real: peek-não-remove (at-least-once P0), ack remove N,
 * msg que chega no meio sobrevive (P1), dedup, reindex, anti-loop.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

function makeFakeRedis(opts = {}) {
  const str = new Map();
  const listM = new Map();
  const zset = new Map();
  const failOnce = new Set(opts.failOnce || []);
  const getL = (k) => { if (!listM.has(k)) listM.set(k, []); return listM.get(k); };
  const norm = (i, len) => (i < 0 ? len + i : i);

  return async function fakeFetch(url) {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
    const [cmd, ...a] = parts;
    if (failOnce.has(cmd)) {
      failOnce.delete(cmd);
      return { ok: false, status: 500, text: async () => JSON.stringify({ error: `forced_${cmd}_failure` }) };
    }
    let result = null;
    switch (cmd) {
      case 'set': {
        const nx = a.slice(2).includes('NX');
        if (nx && str.has(a[0])) { result = null; break; }
        str.set(a[0], a[1]); result = 'OK'; break;
      }
      case 'get': result = str.has(a[0]) ? str.get(a[0]) : null; break;
      case 'del': {
        let r = 0;
        if (str.delete(a[0])) r++;
        if (listM.delete(a[0])) r++;
        if (zset.delete(a[0])) r++;
        result = r; break;
      }
      case 'incr': { const n = Number(str.get(a[0]) || 0) + 1; str.set(a[0], String(n)); result = n; break; }
      case 'expire': result = 1; break;
      case 'rpush': { const l = getL(a[0]); l.push(a[1]); result = l.length; break; }
      case 'llen': result = (listM.get(a[0]) || []).length; break;
      case 'lrange': {
        const l = listM.get(a[0]) || [];
        result = l.slice(norm(Number(a[1]), l.length), norm(Number(a[2]), l.length) + 1); break;
      }
      case 'ltrim': {
        const l = listM.get(a[0]) || [];
        listM.set(a[0], l.slice(norm(Number(a[1]), l.length), norm(Number(a[2]), l.length) + 1));
        result = 'OK'; break;
      }
      case 'zadd': { if (!zset.has(a[0])) zset.set(a[0], new Map()); zset.get(a[0]).set(a[2], Number(a[1])); result = 1; break; }
      case 'zrem': { const z = zset.get(a[0]); result = z && z.delete(a[1]) ? 1 : 0; break; }
      case 'zrangebyscore': {
        const z = zset.get(a[0]) || new Map();
        const min = a[1] === '-inf' ? -Infinity : Number(a[1]);
        const max = a[2] === '+inf' ? Infinity : Number(a[2]);
        result = [...z.entries()].filter(([, s]) => s >= min && s <= max).sort((x, y) => x[1] - y[1]).map(([m]) => m);
        break;
      }
      default: result = null;
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ result }) };
  };
}

describe('pending-queue — at-least-once + dedup + reindex', () => {
  let originalFetch, originalEnv, pq;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    process.env.KV_REST_API_URL = 'https://fake.upstash.io';
    process.env.KV_REST_API_TOKEN = 'faketoken';
    globalThis.fetch = makeFakeRedis();
    pq = await import(`../api/_lib/pending-queue.js?v=${Date.now()}`);
  });
  afterEach(() => { globalThis.fetch = originalFetch; process.env = originalEnv; });

  test('peekPending NÃO remove — at-least-once (P0)', async () => {
    await pq.enqueuePending('614', '5581', 'msg1', '1');
    await pq.enqueuePending('614', '5581', 'msg2', '2');
    const p1 = await pq.peekPending('614');
    const p2 = await pq.peekPending('614');
    assert.equal(p1.count, 2);
    assert.equal(p2.count, 2, 'peek é idempotente — não consome a fila');
    assert.equal(p1.items[0].text, 'msg1');
    assert.equal(p1.items[1].text, 'msg2');
  });

  test('ackPending remove só os N entregues; msg que chega no meio sobrevive (P0/P1)', async () => {
    await pq.enqueuePending('614', '5581', 'msg1', '1');
    await pq.enqueuePending('614', '5581', 'msg2', '2');
    const peek = await pq.peekPending('614'); // n=2 (o que será injetado)
    assert.equal(peek.count, 2);
    // chega uma 3ª DURANTE o drain (antes do ack)
    await pq.enqueuePending('614', '5581', 'msg3-durante-drain', '3');
    // ack remove só os 2 entregues
    await pq.ackPending('614', peek.count);
    const after = await pq.peekPending('614');
    assert.equal(after.count, 1, 'msg que chegou durante o drain NÃO foi perdida');
    assert.equal(after.items[0].text, 'msg3-durante-drain');
  });

  test('dedup por msg_id — retry do Chatwoot não duplica', async () => {
    const a = await pq.enqueuePending('614', '5581', 'x', '99');
    const b = await pq.enqueuePending('614', '5581', 'x', '99');
    assert.equal(a.dedup, false);
    assert.equal(b.dedup, true);
    const peek = await pq.peekPending('614');
    assert.equal(peek.count, 1);
  });

  test('enqueuePending não promete fila quando RPUSH falha e libera dedup para retry', async () => {
    globalThis.fetch = makeFakeRedis({ failOnce: ['rpush'] });
    const a = await pq.enqueuePending('615', '5581', 'x', '100');
    assert.equal(a.ok, false);
    assert.match(a.error, /rpush|forced/i);

    const b = await pq.enqueuePending('615', '5581', 'x', '100');
    assert.equal(b.ok, true);
    assert.equal(b.dedup, false, 'retry precisa conseguir enfileirar a mesma msg_id');
    const peek = await pq.peekPending('615');
    assert.equal(peek.count, 1);
  });

  test('reindexIfRemaining: sobrou → re-ZADD; vazio → ZREM (P1-órfão)', async () => {
    await pq.enqueuePending('700', '5581', 'a', '1');
    await pq.enqueuePending('700', '5581', 'b', '2');
    // entrega 1, sobra 1 → deve continuar no índice
    await pq.ackPending('700', 1);
    let r = await pq.reindexIfRemaining('700');
    assert.equal(r.remaining, 1);
    assert.equal(r.reindexed, true);
    assert.ok((await pq.listPendingConvs(20, 0)).includes('700'), 'conv ainda no índice');
    // entrega a última, sobra 0 → sai do índice
    await pq.ackPending('700', 1);
    r = await pq.reindexIfRemaining('700');
    assert.equal(r.remaining, 0);
    assert.ok(!(await pq.listPendingConvs(20, 0)).includes('700'), 'conv removida do índice');
  });

  test('inject marker set/get/clear', async () => {
    await pq.setInjected('614', { sid: 'sesn_x', n: 2, baselineLen: 10 });
    const m = await pq.getInjected('614');
    assert.equal(m.sid, 'sesn_x');
    assert.equal(m.n, 2);
    await pq.clearInjected('614');
    assert.equal(await pq.getInjected('614'), null);
  });

  test('clearPendingAll limpa lista + índice + marker', async () => {
    await pq.enqueuePending('800', '5581', 'oi', '1');
    await pq.setInjected('800', { sid: 's', n: 1, baselineLen: 0 });
    await pq.clearPendingAll('800');
    assert.equal((await pq.peekPending('800')).count, 0);
    assert.ok(!(await pq.listPendingConvs(20, 0)).includes('800'));
    assert.equal(await pq.getInjected('800'), null);
  });

  test('anti-loop: bumpDrainCycle marca exceeded após MAX_CYCLES (3)', async () => {
    let last;
    for (let i = 0; i < 5; i++) last = await pq.bumpDrainCycle('614');
    assert.equal(last.exceeded, true);
  });
});
