'use strict';
const store = require('./_lib/store');
const { isAdmin, getBody } = require('./_lib/util');

const MAX_BYTES = 900 * 1024;

function clean(input) {
  if (!input || typeof input !== 'object') throw new Error('Body must be a JSON object');
  const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  return {
    version: 1,
    library: arr(input.library, 3000),
    playlists: arr(input.playlists, 200),
    schedule: arr(input.schedule, 500),
    settings: input.settings && typeof input.settings === 'object' ? input.settings : {},
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      if (!store.hasDb()) {
        // No database: tell the browser to use the static file in the repo.
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).json({ state: null, storage: 'file' });
      }
      const state = await store.loadState();
      res.setHeader('Cache-Control', 'public, s-maxage=10, stale-while-revalidate=30');
      return res.status(200).json({ state, storage: 'supabase' });
    }

    if (req.method === 'POST') {
      res.setHeader('Cache-Control', 'no-store');
      if (!isAdmin(req)) return res.status(401).json({ error: 'Not logged in' });
      if (!store.hasDb()) {
        return res.status(501).json({
          error:
            'Supabase is not configured, so the server cannot save. Use "Export JSON", put the file at public/data/state.json in your repo, and push to GitHub.',
        });
      }
      const data = clean(getBody(req));
      if (Buffer.byteLength(JSON.stringify(data)) > MAX_BYTES) {
        return res.status(413).json({ error: 'State is too large (max ~900 KB).' });
      }
      await store.saveState(data);
      return res.status(200).json({ ok: true, savedAt: new Date().toISOString() });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
