'use strict';
// Fallback proxy for https://archive.org/metadata/ITEM (used only if the browser is blocked by CORS).

module.exports = async function handler(req, res) {
  try {
    const id = String(req.query.id || '').trim();
    if (!/^[A-Za-z0-9._\-]{1,200}$/.test(id)) return res.status(400).json({ error: 'Invalid Internet Archive identifier' });
    const r = await fetch('https://archive.org/metadata/' + encodeURIComponent(id));
    if (!r.ok) return res.status(502).json({ error: 'archive.org returned HTTP ' + r.status });
    const j = await r.json();
    if (!j || !j.files) return res.status(404).json({ error: 'Item not found or has no files' });
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    return res.status(200).json({ metadata: j.metadata || {}, files: j.files });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
