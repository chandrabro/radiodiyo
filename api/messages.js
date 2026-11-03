'use strict';
// Listener song requests / dedications.
//   POST   (public, rate limited)  -> store a message
//   GET    (admin)                 -> list latest messages
//   DELETE (admin) ?id=<uuid>      -> remove one
// Messages are private: only the admin can read them, nothing is shown publicly.
const store = require('./_lib/store');
const { isAdmin, getBody, clientIp, makeLimiter } = require('./_lib/util');

const allowed = makeLimiter(3, 10 * 60 * 1000); // 3 messages / 10 min / IP (best effort)
const KINDS = ['request', 'dedication', 'greeting'];
const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (!store.hasDb()) return res.status(501).json({ error: 'Messages need Supabase to be set up.' });

    if (req.method === 'POST') {
      const b = getBody(req);
      if (b.website) return res.status(200).json({ ok: true }); // honeypot filled: silently drop bots
      if (!allowed(clientIp(req))) return res.status(429).json({ error: 'Too many messages. Please wait a few minutes.' });
      const kind = KINDS.includes(b.kind) ? b.kind : 'request';
      const name = clean(b.name, 40);
      const text = clean(b.text, 200);
      if (!name) return res.status(400).json({ error: 'Please enter your name.' });
      if (text.length < 3) return res.status(400).json({ error: 'Please write a short message.' });
      await store.addMessage({ kind, name, text });
      return res.status(200).json({ ok: true });
    }

    if (!isAdmin(req)) return res.status(401).json({ error: 'Not logged in' });

    if (req.method === 'GET') return res.status(200).json({ messages: await store.listMessages(100) });

    if (req.method === 'DELETE') {
      const id = String(req.query.id || '');
      if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad id' });
      await store.deleteMessage(id);
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
