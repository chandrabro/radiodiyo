'use strict';
const test = require('node:test');
const assert = require('node:assert');
const S = require('../public/js/schedule.js');

const lib = [
  { id: 'a', title: 'A', artist: 'x', url: 'u/a', duration: 100 },
  { id: 'b', title: 'B', artist: 'x', url: 'u/b', duration: 200 },
  { id: 'c', title: 'C', artist: 'x', url: 'u/c', duration: 300 },
  { id: 'nodur', title: 'N', artist: 'x', url: 'u/n', duration: 0 },
];
const base = () => ({
  library: lib,
  playlists: [
    { id: 'p1', name: 'Morning', trackIds: ['a', 'b'] },
    { id: 'pd', name: 'Default', trackIds: ['c'] },
  ],
  schedule: [],
  settings: { timezone: 'Asia/Kathmandu', defaultPlaylistId: 'pd' },
});

// Kathmandu is UTC+05:45. 2026-11-02 is a Monday.
const ktm = (iso) => Date.parse(iso + '+05:45');

test('zonedParts converts to Kathmandu day and seconds', () => {
  const p = S.zonedParts(ktm('2026-11-02T08:30:15'), 'Asia/Kathmandu');
  assert.strictEqual(p.day, 1); // Monday
  assert.strictEqual(Math.floor(p.sec), 8 * 3600 + 30 * 60 + 15);
});

test('joins the playlist at the correct position', () => {
  const st = base();
  st.schedule.push({ id: 's1', days: [1], start: '08:00', end: '10:00', type: 'playlist', playlistId: 'p1' });
  // 08:00 + 150s -> playlist a(100) + b(200): 150s in = 50s into b
  const np = S.nowPlaying(st, ktm('2026-11-02T08:02:30'));
  assert.strictEqual(np.track.id, 'b');
  assert.ok(Math.abs(np.offset - 50) < 0.01);
  assert.ok(Math.abs(np.remaining - 150) < 0.01);
  assert.strictEqual(np.source, 'slot');
});

test('playlist loops and key changes per cycle', () => {
  const st = base();
  st.schedule.push({ id: 's1', days: [1], start: '08:00', end: '10:00', type: 'playlist', playlistId: 'p1' });
  const first = S.nowPlaying(st, ktm('2026-11-02T08:00:10'));
  const second = S.nowPlaying(st, ktm('2026-11-02T08:05:10')); // 310s: a again (cycle 1)
  assert.strictEqual(first.track.id, 'a');
  assert.strictEqual(second.track.id, 'a');
  assert.notStrictEqual(first.key, second.key);
});

test('two clients at the same instant get the same answer', () => {
  const st = base();
  st.schedule.push({ id: 's1', days: [1], start: '08:00', end: '10:00', type: 'playlist', playlistId: 'p1' });
  const t = ktm('2026-11-02T09:13:37');
  assert.deepStrictEqual(S.nowPlaying(st, t).key, S.nowPlaying(JSON.parse(JSON.stringify(st)), t).key);
});

test('falls back to default playlist when nothing is scheduled', () => {
  const st = base();
  const np = S.nowPlaying(st, ktm('2026-11-02T03:00:00'));
  assert.strictEqual(np.track.id, 'c');
  assert.strictEqual(np.source, 'default');
});

test('falls back to whole library when no default playlist exists', () => {
  const st = base();
  st.settings.defaultPlaylistId = '';
  const np = S.nowPlaying(st, ktm('2026-11-02T03:00:00'));
  assert.ok(['a', 'b', 'c'].includes(np.track.id)); // never the 0-duration track
});

test('nothing scheduled + auto genre: plays free Jamendo music, not the library', () => {
  const st = base();
  st.settings.defaultPlaylistId = '';
  st.settings.defaultGenre = 'Relaxing';
  const cache = { relaxing: [
    { id: 'j1', title: 'J1', artist: 'y', url: 'u/j1', duration: 100 },
    { id: 'j2', title: 'J2', artist: 'y', url: 'u/j2', duration: 100 },
  ] };
  const t = ktm('2026-11-02T03:00:00');
  const np = S.nowPlaying(st, t, { genreCache: cache });
  assert.ok(['j1', 'j2'].includes(np.track.id));
  assert.strictEqual(np.source, 'default');
  // two listeners get the same track at the same instant
  assert.strictEqual(S.nowPlaying(st, t, { genreCache: cache }).track.id, np.track.id);
});

test('auto genre not loaded yet (or Jamendo down): falls back to the library', () => {
  const st = base();
  st.settings.defaultPlaylistId = '';
  st.settings.defaultGenre = 'relaxing';
  const np = S.nowPlaying(st, ktm('2026-11-02T03:00:00'), { genreCache: {} });
  assert.ok(['a', 'b', 'c'].includes(np.track.id));
});

test('default playlist still wins over auto genre', () => {
  const st = base();
  st.settings.defaultGenre = 'relaxing';
  const cache = { relaxing: [{ id: 'j1', title: 'J1', artist: 'y', url: 'u/j1', duration: 100 }] };
  assert.strictEqual(S.nowPlaying(st, ktm('2026-11-02T03:00:00'), { genreCache: cache }).track.id, 'c');
});

test('wrong day does not match the slot', () => {
  const st = base();
  st.schedule.push({ id: 's1', days: [2], start: '08:00', end: '10:00', type: 'playlist', playlistId: 'p1' });
  assert.strictEqual(S.nowPlaying(st, ktm('2026-11-02T08:30:00')).source, 'default');
});

test('overnight slot spans midnight (evening and next-morning parts)', () => {
  const st = base();
  st.schedule.push({ id: 'night', days: [1], start: '22:00', end: '02:00', type: 'track', trackId: 'b' });
  const late = S.nowPlaying(st, ktm('2026-11-02T23:00:00')); // Monday 23:00
  const early = S.nowPlaying(st, ktm('2026-11-03T01:00:00')); // Tuesday 01:00, still Monday's slot
  const after = S.nowPlaying(st, ktm('2026-11-03T02:30:00'));
  assert.strictEqual(late.slot.id, 'night');
  assert.strictEqual(early.slot.id, 'night');
  assert.strictEqual(after.source, 'default');
  // 01:00 is 3h = 10800s after 22:00; track b loops every 200s -> 10800 % 200 = 0
  assert.ok(Math.abs(early.offset) < 0.01);
});

test('single recording slot loops', () => {
  const st = base();
  st.schedule.push({ id: 's1', days: [1], start: '12:00', end: '13:00', type: 'track', trackId: 'a' });
  const np = S.nowPlaying(st, ktm('2026-11-02T12:03:00')); // 180s, a is 100s -> 80s in
  assert.strictEqual(np.track.id, 'a');
  assert.ok(Math.abs(np.offset - 80) < 0.01);
});

test('genre slot uses the genre cache, and empty cache falls back to default', () => {
  const st = base();
  st.schedule.push({ id: 'g', days: [1], start: '14:00', end: '15:00', type: 'genre', genre: 'Lofi' });
  const t = ktm('2026-11-02T14:00:30');
  assert.strictEqual(S.nowPlaying(st, t).source, 'default');
  const cache = { lofi: [{ id: 'j1', title: 'J', artist: 'y', url: 'u/j', duration: 100 }] };
  const np = S.nowPlaying(st, t, { genreCache: cache });
  assert.strictEqual(np.track.id, 'j1');
  assert.strictEqual(np.source, 'slot');
});

test('skipping a broken track removes it from the sequence', () => {
  const st = base();
  st.schedule.push({ id: 's1', days: [1], start: '08:00', end: '10:00', type: 'playlist', playlistId: 'p1' });
  const np = S.nowPlaying(st, ktm('2026-11-02T08:00:10'), { skip: new Set(['a']) });
  assert.strictEqual(np.track.id, 'b');
});

test('returns null when there is nothing playable', () => {
  const st = base();
  st.library = [];
  assert.strictEqual(S.nowPlaying(st, Date.now()), null);
});

test('upcoming lists programme changes with the current one first', () => {
  const st = base();
  st.schedule.push({ id: 's1', days: [1], start: '08:00', end: '10:00', type: 'playlist', playlistId: 'p1', label: 'Morning Show' });
  const up = S.upcoming(st, ktm('2026-11-02T07:00:00'), 6, 5);
  assert.strictEqual(up[0].now, true);
  assert.strictEqual(up[0].label, 'Default playlist');
  assert.strictEqual(up[1].label, 'Morning Show');
  assert.strictEqual(up[2].label, 'Default playlist');
});
