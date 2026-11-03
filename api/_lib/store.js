'use strict';
// Storage in a free Supabase project (REST API, service_role key, server side only).
//  - radio_state:    one JSON document ("main") with library, playlists, schedule, settings
//  - radio_messages: listener song requests / dedications (read only by the admin)
// If Supabase is not configured, the app falls back to public/data/state.json in the repo.

function hasDb() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function headers(extra) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return Object.assign(
    { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    extra || {}
  );
}

function url(table) {
  return String(process.env.SUPABASE_URL).replace(/\/+$/, '') + '/rest/v1/' + table;
}

async function fail(r, what) {
  const t = (await r.text()).slice(0, 200);
  throw new Error('Supabase ' + what + ' failed (' + r.status + '): ' + t);
}

async function loadState() {
  const r = await fetch(url('radio_state') + '?id=eq.main&select=data', { headers: headers() });
  if (!r.ok) await fail(r, 'read');
  const rows = await r.json();
  return rows.length ? rows[0].data : null;
}

async function saveState(data) {
  const r = await fetch(url('radio_state') + '?on_conflict=id', {
    method: 'POST',
    headers: headers({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ id: 'main', data, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) await fail(r, 'write');
}

async function addMessage(row) {
  const r = await fetch(url('radio_messages'), {
    method: 'POST',
    headers: headers({ Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!r.ok) await fail(r, 'message write');
}

async function listMessages(limit) {
  const r = await fetch(url('radio_messages') + '?select=id,created_at,kind,name,text&order=created_at.desc&limit=' + (limit || 100), { headers: headers() });
  if (!r.ok) await fail(r, 'message read');
  return r.json();
}

async function deleteMessage(id) {
  const r = await fetch(url('radio_messages') + '?id=eq.' + encodeURIComponent(id), { method: 'DELETE', headers: headers({ Prefer: 'return=minimal' }) });
  if (!r.ok) await fail(r, 'message delete');
}

module.exports = { hasDb, loadState, saveState, addMessage, listMessages, deleteMessage };
