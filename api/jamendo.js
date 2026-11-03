'use strict';
// Proxy for the Jamendo API (Creative Commons music). Keeps the client id on the server and
// returns a stable, cacheable list so every listener gets the same "auto music" sequence.

module.exports = async function handler(req, res) {
  try {
    // Clean up the value: a pasted line break, space or quotes would make Jamendo reject it.
    const clientId = String(process.env.JAMENDO_CLIENT_ID || '').trim().replace(/^["']+|["']+$/g, '').trim();
    if (!clientId) {
      return res.status(500).json({ error: 'JAMENDO_CLIENT_ID is not set. See the README for how to get a free key.' });
    }
    const tag = String(req.query.tag || '').toLowerCase().replace(/[^a-z0-9 ,\-]/g, '').trim().slice(0, 60);
    if (!tag) return res.status(400).json({ error: 'Missing ?tag=genre-or-mood' });
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 30));

    const url = new URL('https://api.jamendo.com/v3.0/tracks/');
    url.search = new URLSearchParams({
      client_id: clientId,
      format: 'json',
      limit: String(limit),
      fuzzytags: tag.replace(/\s*,\s*/g, '+').replace(/\s+/g, '+'),
      audioformat: 'mp32',
      order: 'popularity_total', // stable ordering = same list for everyone
      boost: 'popularity_total',
    }).toString();

    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) return res.status(502).json({ error: 'Jamendo returned HTTP ' + r.status });
    const j = await r.json();
    if (j.headers && j.headers.status === 'failed') {
      return res.status(502).json({ error: 'Jamendo: ' + (j.headers.error_message || 'request failed') });
    }
    const tracks = (j.results || [])
      .filter((t) => t.audio && Number(t.duration) > 0)
      .map((t) => ({
        id: 'jamendo-' + t.id,
        title: t.name,
        artist: t.artist_name,
        url: t.audio,
        duration: Number(t.duration),
        license: t.license_ccurl || '',
        source: 'jamendo',
        tags: [tag],
      }));

    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ tracks });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
