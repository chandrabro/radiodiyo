'use strict';
// Server clock, so every listener can correct a wrong device clock and hear the same thing.
module.exports = function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ now: Date.now() });
};
