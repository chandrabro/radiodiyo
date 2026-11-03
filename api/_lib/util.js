'use strict';
const crypto = require('crypto');

function sha(s) {
  return crypto.createHash('sha256').update(String(s)).digest();
}

/** Constant-time string comparison. */
function safeEqual(a, b) {
  return crypto.timingSafeEqual(sha(a), sha(b));
}

/** Token handed to the admin browser after a correct password. Derived from the password
 *  with HMAC, so the server needs no session storage and the password itself is never kept. */
function adminToken() {
  const pw = process.env.ADMIN_PASSWORD || '';
  return crypto.createHmac('sha256', pw).update('ai-radio-admin-v1').digest('hex');
}

function isAdmin(req) {
  if (!process.env.ADMIN_PASSWORD) return false;
  const h = String(req.headers['authorization'] || '');
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  return safeEqual(m[1], adminToken());
}

function getBody(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') {
    try { return JSON.parse(b); } catch (e) { return {}; }
  }
  return {};
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '');
  return xf.split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** Tiny in-memory sliding-window limiter. Best effort only (each serverless instance has its own memory). */
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return function hit(key) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    arr.push(now);
    hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    return arr.length <= max;
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { safeEqual, adminToken, isAdmin, getBody, clientIp, makeLimiter, sleep };
