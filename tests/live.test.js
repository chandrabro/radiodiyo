'use strict';
const test = require('node:test');
const assert = require('node:assert');

// In-memory fake of the Supabase REST table radio_state
const rows = new Map();
global.fetch = async (url, opts) => {
  const u = new URL(url);
  if (!u.pathname.endsWith('/radio_state')) throw new Error('unexpected ' + url);
  if ((opts && opts.method) === 'POST') {
    const b = JSON.parse(opts.body);
    rows.set(b.id, b);
    return { ok: true, status: 201, text: async () => '' };
  }
  const id = u.searchParams.get('id').replace('eq.', '');
  return { ok: true, status: 200, json: async () => (rows.has(id) ? [rows.get(id)] : []) };
};
process.env.SUPABASE_URL = 'https://x.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
process.env.ADMIN_PASSWORD = 'pw';

const live = require('../api/live.js');
const { adminToken } = require('../api/_lib/util.js');

function call(method, body, auth) {
  return new Promise((resolve) => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
    live({ method, body, headers: auth ? { authorization: 'Bearer ' + adminToken() } : {} }, res);
  });
}

test('not live by default', async () => {
  const r = await call('GET');
  assert.deepStrictEqual([r.code, r.body.on, r.body.storage], [200, false, 'supabase']);
});
test('only the admin can start a broadcast', async () => {
  assert.strictEqual((await call('POST', { on: true, id: 'radio-abc123' }, false)).code, 401);
});
test('rejects a bad broadcast id', async () => {
  assert.strictEqual((await call('POST', { on: true, id: 'bad id!' }, true)).code, 400);
});
test('going live is visible to everyone, with the id', async () => {
  assert.strictEqual((await call('POST', { on: true, id: 'radio-abc123' }, true)).code, 200);
  const r = await call('GET');
  assert.deepStrictEqual([r.body.on, r.body.id], [true, 'radio-abc123']);
});
test('stopping ends it for everyone immediately', async () => {
  await call('POST', { on: false }, true);
  const r = await call('GET');
  assert.deepStrictEqual([r.body.on, r.body.id], [false, '']);
});
test('if the admin tab dies (no heartbeat) the broadcast expires by itself', async () => {
  await call('POST', { on: true, id: 'radio-abc123' }, true);
  assert.strictEqual((await call('GET')).body.on, true);
  const realNow = Date.now;
  Date.now = () => realNow() + 31000; // 31 s later, no heartbeat
  try { assert.strictEqual((await call('GET')).body.on, false); } finally { Date.now = realNow; }
});
test('a heartbeat keeps it alive', async () => {
  await call('POST', { on: true, id: 'radio-abc123' }, true);
  const realNow = Date.now;
  Date.now = () => realNow() + 20000;
  try { await call('POST', { on: true, id: 'radio-abc123' }, true); } finally { Date.now = realNow; }
  Date.now = () => realNow() + 40000; // 20 s after the heartbeat
  try { assert.strictEqual((await call('GET')).body.on, true); } finally { Date.now = realNow; }
});
