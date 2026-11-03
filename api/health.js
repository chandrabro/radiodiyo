'use strict';
// Setup checker: shows which environment variables the server can see (never their values).
// Open  https://YOUR-SITE/api/health  after deploying.
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const has = (n) => Boolean(process.env[n] && String(process.env[n]).trim());
  const names = ['ADMIN_PASSWORD', 'JAMENDO_CLIENT_ID', 'GEMINI_API_KEY', 'MISTRAL_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'];
  const found = {};
  names.forEach((n) => { found[n] = has(n) ? 'set' : 'MISSING or empty'; });
  // Helps spot a typo in a variable name: lists similar names that DO exist on the server.
  const similar = Object.keys(process.env).filter((k) => /ADMIN|JAMENDO|GEMINI|MISTRAL|SUPABASE/i.test(k) && !names.includes(k));
  res.status(200).json({
    ok: has('ADMIN_PASSWORD'),
    variables: found,
    similarNamesFound: similar,
    environment: process.env.VERCEL_ENV || 'local',
    deployment: process.env.VERCEL_URL || 'local',
    note: 'Values are never shown. "similarNamesFound" lists variables with a wrong spelling, if any.',
  });
};
