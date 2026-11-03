'use strict';
const { safeEqual, adminToken, getBody, clientIp, makeLimiter, sleep } = require('./_lib/util');

const allowed = makeLimiter(8, 10 * 60 * 1000); // 8 attempts / 10 min / IP (best effort)

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ error: 'ADMIN_PASSWORD is not set on the server. Add it in Vercel environment variables.' });
  }
  if (!allowed(clientIp(req))) {
    return res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' });
  }
  const { password } = getBody(req);
  if (typeof password !== 'string' || !safeEqual(password, process.env.ADMIN_PASSWORD)) {
    await sleep(700);
    return res.status(401).json({ error: 'Wrong password' });
  }
  return res.status(200).json({ token: adminToken() });
};
