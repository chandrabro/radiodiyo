'use strict';
// Proxy for the Jamendo API (Creative Commons music). Keeps the client id on the server and
// returns a stable, cacheable list so every listener gets the same "auto music" sequence.
//
// It tries several simple searches until one returns tracks:
//   1) exact tag   2) fuzzy tag   3) free-text search   4) exact tag without sorting

function mapTracks(j, tag, clientId) {
  return (j.results || [])
    .filter((t) => t.audio && Number(t.duration) > 0)
    .map((t) => ({
      id: 'jamendo-' + t.id,
      title: t.name,
      artist: t.artist_name,
      url: t.audio,
      // Backup sources the player tries if the first one fails on a device.
      alts: [
        t.audiodownload_allowed && t.audiodownload ? t.audiodownload : '',
        'https://api.jamendo.com/v3.0/tracks/file/?client_id=' + encodeURIComponent(clientId) + '&id=' + encodeURIComponent(t.id) + '&action=stream&audioformat=mp32',
      ].filter(Boolean),
      duration: Number(t.duration),
      license: t.license_ccurl || '',
      source: 'jamendo',
      tags: [tag],
    }));
}

async function ask(clientId, extra, limit) {
  const url = new URL('https://api.jamendo.com/v3.0/tracks/');
  const params = Object.assign({ client_id: clientId, format: 'json', limit: String(limit) }, extra);
  url.search = new URLSearchParams(params).toString();
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('Jamendo returned HTTP ' + r.status);
  const j = await r.json();
  if (j.headers && j.headers.status === 'failed') throw new Error('Jamendo: ' + (j.headers.error_message || 'request failed'));
  return j;
}

module.exports = async function handler(req, res) {
  try {
    // Clean up the value: a pasted line break, space or quotes would make Jamendo reject it.
    const clientId = String(process.env.JAMENDO_CLIENT_ID || '').trim().replace(/^["']+|["']+$/g, '').trim();
    if (!clientId) {
      return res.status(500).json({ error: 'JAMENDO_CLIENT_ID is not set. See the README for how to get a free key.' });
    }
    const raw = String(req.query.tag || '').toLowerCase().replace(/[^a-z0-9 ,\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
    if (!raw) return res.status(400).json({ error: 'Missing ?tag=genre-or-mood' });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));
    const plus = raw.replace(/\s*,\s*/g, '+').replace(/\s+/g, '+');

    const attempts = [
      { tags: plus, order: 'popularity_total' },
      { fuzzytags: plus, order: 'popularity_total' },
      { search: raw.replace(/,/g, ' '), order: 'popularity_total' },
      { tags: plus },
    ];

    let last = null;
    for (let i = 0; i < attempts.length; i++) {
      last = await ask(clientId, attempts[i], limit);
      const tracks = mapTracks(last, raw, clientId);
      if (tracks.length) {
        res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
        return res.status(200).json({ tracks });
      }
    }

    // Nothing found: do not cache, and show Jamendo's own message to help diagnose.
    res.setHeader('Cache-Control', 'no-store');
    const h = (last && last.headers) || {};
    return res.status(200).json({
      tracks: [],
      jamendo: { status: h.status, code: h.code, warnings: h.warnings, error_message: h.error_message, results_count: h.results_count },
    });
  } catch (e) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(502).json({ error: String(e.message || e) });
  }
};
