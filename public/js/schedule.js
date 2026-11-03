/* Schedule engine: pure functions, no DOM. Works in the browser (window.RadioSchedule) and in Node (tests).
 *
 * Everyone hears the same thing because the answer to "what is playing now?" depends only on
 * (schedule, library, timezone, clock). The listener joins the current track at the right offset.
 *
 * state = { library:[{id,title,artist,url,duration,...}], playlists:[{id,name,trackIds:[]}],
 *           schedule:[{id,days:[0-6],start:"HH:MM",end:"HH:MM",type:"playlist|track|genre",
 *                      playlistId,trackId,genre,label}],
 *           settings:{timezone,defaultPlaylistId} }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RadioSchedule = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var fmtCache = {};

  function formatter(tz) {
    if (!fmtCache[tz]) {
      fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    }
    return fmtCache[tz];
  }

  /** Day of week (0=Sunday) and seconds since local midnight in the given timezone. */
  function zonedParts(ms, tz) {
    var f;
    try { f = formatter(tz || 'UTC'); } catch (e) { f = formatter('UTC'); }
    var p = {};
    f.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    var h = parseInt(p.hour, 10) % 24;
    return {
      day: DAY_INDEX[p.weekday],
      sec: h * 3600 + parseInt(p.minute, 10) * 60 + parseInt(p.second, 10) + (ms % 1000 + 1000) % 1000 / 1000,
    };
  }

  function toSec(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return 0;
    return Math.min(86400, parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60);
  }

  /** Slot active at `ms`, with seconds elapsed since it began and seconds until it ends. */
  function findSlot(state, ms) {
    var tz = (state.settings && state.settings.timezone) || 'Asia/Kathmandu';
    var parts = zonedParts(ms, tz);
    var prevDay = (parts.day + 6) % 7;
    var best = null;
    (state.schedule || []).forEach(function (slot) {
      var days = slot.days || [];
      var s = toSec(slot.start);
      var e = toSec(slot.end);
      var elapsed = null, remaining = null;
      if (e > s) {
        if (days.indexOf(parts.day) >= 0 && parts.sec >= s && parts.sec < e) { elapsed = parts.sec - s; remaining = e - parts.sec; }
      } else {
        // Overnight slot (end <= start): runs past midnight into the next day.
        if (days.indexOf(parts.day) >= 0 && parts.sec >= s) { elapsed = parts.sec - s; remaining = 86400 - parts.sec + e; }
        else if (days.indexOf(prevDay) >= 0 && parts.sec < e) { elapsed = parts.sec + 86400 - s; remaining = e - parts.sec; }
      }
      if (elapsed !== null && (!best || elapsed < best.elapsed)) {
        best = { slot: slot, elapsed: elapsed, remaining: remaining };
      }
    });
    return best;
  }

  function usable(t, skip) {
    return t && t.url && Number(t.duration) > 0 && !(skip && skip.has(t.id));
  }

  function byId(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /** Ordered tracks for a slot (or for the default fallback when slot is null). */
  function resolveTracks(state, slot, opts) {
    opts = opts || {};
    var lib = state.library || [];
    var out = [];
    if (slot && slot.type === 'playlist') {
      var pl = byId(state.playlists || [], slot.playlistId);
      if (pl) (pl.trackIds || []).forEach(function (id) { var t = byId(lib, id); if (t) out.push(t); });
    } else if (slot && slot.type === 'track') {
      var one = byId(lib, slot.trackId);
      if (one) out.push(one);
    } else if (slot && slot.type === 'genre') {
      var cache = opts.genreCache || {};
      out = (cache[String(slot.genre || '').toLowerCase().trim()] || []).slice();
    } else {
      // Nothing scheduled. Order of preference:
      // 1) the chosen default playlist, 2) free auto music (Jamendo genre), 3) the whole library.
      var st = state.settings || {};
      var dpl = byId(state.playlists || [], st.defaultPlaylistId);
      if (dpl) (dpl.trackIds || []).forEach(function (id) { var t = byId(lib, id); if (t) out.push(t); });
      if (!out.filter(function (t) { return usable(t, opts.skip); }).length && st.defaultGenre) {
        var gc = (opts.genreCache || {})[String(st.defaultGenre).toLowerCase().trim()];
        if (gc && gc.length) out = gc.slice();
      }
      if (!out.filter(function (t) { return usable(t, opts.skip); }).length) out = lib.slice();
    }
    return out.filter(function (t) { return usable(t, opts.skip); });
  }

  /**
   * What should be playing at time `ms`?
   * Returns { track, offset (s into the track), remaining (s), key, slot, source, index } or null.
   * `key` changes whenever a new track starts (even when the same track loops).
   */
  function nowPlaying(state, ms, opts) {
    opts = opts || {};
    var hit = findSlot(state, ms);
    var tracks = hit ? resolveTracks(state, hit.slot, opts) : [];
    var source = 'slot';
    var elapsed = hit ? hit.elapsed : 0;
    var slotId = hit ? hit.slot.id : 'default';
    if (!tracks.length) {
      source = 'default';
      slotId = 'default';
      tracks = resolveTracks(state, null, opts);
      elapsed = ms / 1000; // default loop is anchored to the clock, so it is the same for everyone
      hit = null;
    }
    if (!tracks.length) return null;

    var total = 0;
    tracks.forEach(function (t) { total += Number(t.duration); });
    var cycle = Math.floor(elapsed / total);
    var pos = elapsed - cycle * total;
    for (var i = 0; i < tracks.length; i++) {
      var d = Number(tracks[i].duration);
      if (pos < d) {
        return {
          track: tracks[i],
          offset: pos,
          remaining: d - pos,
          index: i,
          key: slotId + ':' + cycle + ':' + i,
          slot: hit ? hit.slot : null,
          source: source,
        };
      }
      pos -= d;
    }
    return null;
  }

  /** Short description of what a slot plays, for display. */
  function describeSlot(state, slot) {
    if (!slot) return 'Default playlist';
    if (slot.label) return slot.label;
    if (slot.type === 'playlist') { var pl = byId(state.playlists || [], slot.playlistId); return pl ? 'Playlist: ' + pl.name : 'Playlist'; }
    if (slot.type === 'track') { var t = byId(state.library || [], slot.trackId); return t ? 'Recording: ' + t.title : 'Recording'; }
    if (slot.type === 'genre') return 'Auto music: ' + (slot.genre || 'mixed');
    return 'Scheduled';
  }

  /** Upcoming programme changes in the next `hours`. First item is what is on now. */
  function upcoming(state, ms, hours, max) {
    var out = [];
    var lastKey = null;
    var steps = Math.ceil((hours || 24) * 60);
    for (var i = 0; i <= steps && out.length < (max || 6); i++) {
      var t = ms + i * 60000;
      var hit = findSlot(state, t);
      var key = hit ? hit.slot.id : 'default';
      if (key !== lastKey) {
        out.push({ startMs: i === 0 ? ms : t, label: describeSlot(state, hit && hit.slot), slotId: key, now: i === 0 });
        lastKey = key;
      }
    }
    return out;
  }

  return {
    DAY_NAMES: DAY_NAMES,
    zonedParts: zonedParts,
    findSlot: findSlot,
    resolveTracks: resolveTracks,
    nowPlaying: nowPlaying,
    describeSlot: describeSlot,
    upcoming: upcoming,
    toSec: toSec,
  };
});
