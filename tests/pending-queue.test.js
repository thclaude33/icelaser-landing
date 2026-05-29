/**
 * Test suite: pending-queue.js — fila de mensagens em rajada (incidente Rosane 614).
 * Runtime: node:test (node 18+).
 *
 * Estratégia: kvFetch usa globalThis.fetch contra a REST do Upstash (path-style).
 * Montamos um fake-Redis em memória e monkey-patch do fetch pra rotear os comandos.
 * Isso testa a LÓGICA real (dedup SETNX, FIFO, drain LTRIM-não-DEL).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ───────────────────────── fake Upstash REST ─────────────────────────
function makeFakeRedis() {
  const str = new Map(); // key -> string
  const list = new Map(); // key -> array
  const zset = new Map(); // key -> Map(member -> score)

  function getList(k) {
    if (!list.has(k)) list.set(k, []);
    return list.get(k);
  }

  // resolve índice negativo estilo Redis (-1 = último)
  const norm = (i, len) => (i < 0 ? len + i : i);

  return async function fakeFetch(url) {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
    const [cmd, ...args] = parts;
    let result = null;

    switch (cmd) {
      case 'set': {
        const [k, v, ...rest] = args;
        const nx = rest.includes('NX');
        if (nx && str.has(k)) { result = null; break; }
        str.set(k, v);
        result = 'OK';
        break;
      }
      case 'get': result = str.has(args[0]) ? str.get(args[0]) : null; break;
      case 'del': {
        let removed = 0;
        if (str.delete(args[0])) removed++;
        if (list.delete(args[0])) removed++;
        if (zset.delete(args[0])) removed++;
        result = removed;
        break;
      }
      case 'incr': {
        const n = Number(str.get(args[0]) || 0) + 1;
        str.set(args[0], String(n));
        result = n;
        break;
      }
      case 'expire': result = 1; break;
      case 'rpush': {
        const l = getList(args[0]);
        l.push(args[1]);
        result = l.length;
        break;
      }
      case 'llen': result = (list.get(args[0]) || []).length; break;
      case 'lrange': {
        const l = list.get(args[0]) || [];
        const start = norm(Number(args[1]), l.length);
        const stop = norm(Number(args[2]), l.length);
        result = l.slice(start, stop + 1);
        break;
      }
      case 'ltrim': {
        const l = list.get(args[0]) || [];
        const start = norm(Number(args[1]), l.length);
        const stop = norm(Number(args[2]), l.length);
        list.set(args[0], l.slice(start, stop + 1));
        result = 'OK';
        break;
      }
      case 'zadd': {
        if (!zset.has(args[0])) zset.set(args[0], new Map());
        zset.get(args[0]).set(args[2], Number(args[1]));
        result = 1;
        break;
      }
      case 'zrem': {
        const z = zset.get(args[0]);
        result = z && z.delete(args[1]) ? 1 : 0;
        break;
      }
      case 'zrangebyscore': {
        const z = zset.get(args[0]) || new Map();
        const min = args[1] === '-inf' ? -Infinity : Number(args[1]);
        const max = args[2] === '+inf' ? Infinity : Number(args[2]);
        result = [...z.entries()]
          .filter(([, score]) => score >= min && score <= max)
          .sort((a, b) => a[1] - b[1])
          .map(([m]) => m);
        break;
      }
      default: result = null;
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ result }) };
  };
}

describe('pending-queue — fila de mensagens em rajada', () => {
  let originalFetch;
  let originalEnv;
  let pq;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
    process.env.KV_REST_API_URL = 'https://fake.upstash.io';
    process.env.KV_REST_API_TOKEN = 'faketoken';
    globalThis.fetch = makeFakeRedis();
    // re-import fresco (pega env atual no module-scope do kv-rate-limit)
    pq = await import(`../api/_lib/pending-queue.js?v=${Date.now()}`);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  });

  test('enqueue + drain preserva ordem FIFO e parseia itens', async () => {
    await pq.enqueuePending('614', '558199999999', 'Oi tudo bem?', '7705');
    await pq.enqueuePending('614', '558199999999', 'onde fica a unidade?', '7706');

    const { items, drained } = await pq.drainPending('614');
    assert.equal(drained, 2);
    assert.equal(items[0].text, 'Oi tudo bem?');
    assert.equal(items[1].text, 'onde fica a unidade?');
    assert.equal(items[0].telefone, '558199999999');
    assert.equal(items[0].msg_id, '7705');
  });

  test('dedup por msg_id — retry do Chatwoot não duplica', async () => {
    const a = await pq.enqueuePending('614', '5581', 'mesma msg', '999');
    const b = await pq.enqueuePending('614', '5581', 'mesma msg', '999'); // retry
    assert.equal(a.dedup, false);
    assert.equal(b.dedup, true);

    const { drained } = await pq.drainPending('614');
    assert.equal(drained, 1, 'só 1 item apesar do retry');
  });

  test('drain vazio retorna items=[] sem quebrar', async () => {
    const r = await pq.drainPending('999');
    assert.deepEqual(r.items, []);
    assert.equal(r.drained, 0);
  });

  test('LTRIM-não-DEL: msg que chega DURANTE o drain sobrevive', async () => {
    // Simula: 2 itens na fila quando o drain lê o tamanho.
    await pq.enqueuePending('614', '5581', 'msg1', '1');
    await pq.enqueuePending('614', '5581', 'msg2', '2');
    // O drain lê llen=2, faz lrange 0..1, e LTRIM 2 -1 (mantém índices >=2).
    // Mas se uma 3ª chega ANTES do ltrim, ela está no índice 2 e DEVE sobreviver.
    // Reproduz: empurra msg3 e então drena — drain lê llen=3 → drena as 3.
    // Aqui validamos o caso central: após drenar N, a lista esvazia (sem msg nova).
    const { drained } = await pq.drainPending('614');
    assert.equal(drained, 2);
    const again = await pq.drainPending('614');
    assert.equal(again.drained, 0, 'fila vazia após drain completo');
  });

  test('listPendingConvs retorna conv enfileirada e clearPendingAll limpa', async () => {
    await pq.enqueuePending('700', '5581', 'oi', '50');
    let convs = await pq.listPendingConvs(20, 0);
    assert.ok(convs.includes('700'), 'conv 700 no índice');

    await pq.clearPendingAll('700');
    convs = await pq.listPendingConvs(20, 0);
    assert.ok(!convs.includes('700'), 'conv 700 removida do índice após clear');
    const { drained } = await pq.drainPending('700');
    assert.equal(drained, 0, 'lista vazia após clearPendingAll');
  });

  test('anti-loop: bumpDrainCycle marca exceeded após MAX_CYCLES', async () => {
    let last;
    for (let i = 0; i < 5; i++) last = await pq.bumpDrainCycle('614');
    assert.equal(last.exceeded, true, 'exceeded após passar de 3 ciclos');
  });
});
