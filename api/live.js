'use strict';
// Live broadcast signal, shared by everyone.
//   GET  (public)  -> { on, id }   is the station live right now? (and the broadcaster's PeerJS id)
//   POST (admin)   -> { on, id }   go live / stop. While live, the admin page re-sends this every
//                                  10 seconds as a heartbeat, so if the tab closes the broadcast
//                                  counts as ended after FRESH_MS and listeners return to the schedule.
const store = require('./_lib/store');
const { isAdmin, getBody } = require('./_lib/util');

const FRESH_MS = 30 * 1000;
const ID_RE = /^[A-Za-z0-9_-]{6,80}$/;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      if (!store.hasDb()) return res.status(200).json({ on: false, id: '', storage: 'none' });
      const row = await store.loadRow('live');
      const d = (row && row.data) || {};
      const on = Boolean(d.on && ID_RE.test(String(d.id || '')) && Date.now() - Number(d.ts || 0) < FRESH_MS);
      return res.status(200).json({ on, id: on ? d.id : '', storage: 'supabase' });
    }

    if (req.method === 'POST') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'Not logged in' });
      if (!store.hasDb()) return res.status(501).json({ error: 'Live status needs Supabase.' });
      const b = getBody(req);
      const on = b.on === true;
      const id = String(b.id || '');
      if (on && !ID_RE.test(id)) return res.status(400).json({ error: 'Bad broadcast id' });
      await store.saveRow('live', { on, id: on ? id : '', ts: Date.now() });
      return res.status(200).json({ ok: true, on });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
