/* Shared helpers used by the listener and admin pages. Exposes window.Core. */
(function () {
  'use strict';

  var LS_BACKUP = 'radio_state_backup_v1';
  var TOKEN_KEY = 'radio_admin_token';
  var clockOffset = 0; // server time - device time (ms)

  function defaultState() {
    return {
      version: 1,
      library: [],
      playlists: [],
      schedule: [],
      settings: {
        stationName: 'दियो online radio',
        stationNameEn: 'Diyo Online Radio',
        timezone: 'Asia/Kathmandu',
        defaultPlaylistId: '',
        defaultGenre: 'relaxing',
        liveId: '',
        host: {
          enabled: true,
          name: 'Maya',
          personality: 'calm',
          language: 'en',
          every: 1,
          custom: '',
          voices: { en: '', ne: '' },
          useWeather: false,
          city: 'Kathmandu',
          lat: 27.7172,
          lon: 85.324,
        },
      },
    };
  }

  function normalize(s) {
    var d = defaultState();
    if (!s || typeof s !== 'object') return d;
    var st = s.settings || {};
    var host = Object.assign({}, d.settings.host, st.host || {});
    host.voices = Object.assign({ en: '', ne: '' }, (st.host && st.host.voices) || {});
    host.every = Math.max(1, parseInt(host.every, 10) || 1);
    var settings = Object.assign({}, d.settings, st, { host: host });
    if (!settings.stationName || settings.stationName === 'AI Radio Station') settings.stationName = d.settings.stationName;
    if (!settings.stationNameEn) settings.stationNameEn = d.settings.stationNameEn;
    return {
      version: 1,
      library: Array.isArray(s.library) ? s.library : [],
      playlists: Array.isArray(s.playlists) ? s.playlists : [],
      schedule: Array.isArray(s.schedule) ? s.schedule : [],
      settings: settings,
    };
  }

  function now() { return Date.now() + clockOffset; }

  /** Ask the server for its clock (best of 3 samples) so a wrong phone clock doesn't desync listeners. */
  async function syncClock() {
    var best = null;
    for (var i = 0; i < 3; i++) {
      try {
        var t0 = Date.now();
        var r = await fetch('/api/time', { cache: 'no-store' });
        var t1 = Date.now();
        if (!r.ok) continue;
        var j = await r.json();
        var rtt = t1 - t0;
        if (!best || rtt < best.rtt) best = { rtt: rtt, offset: j.now + rtt / 2 - t1 };
      } catch (e) { /* offline: keep previous offset */ }
    }
    if (best) clockOffset = best.offset;
    return clockOffset;
  }

  /** Load the station state: server (Supabase) -> repo file -> local backup -> empty default. */
  async function loadState() {
    var storage = 'file';
    try {
      var r = await fetch('/api/state', { cache: 'no-store' });
      if (r.ok) {
        var j = await r.json();
        storage = (j && j.storage) || 'file';
        if (j && j.state) {
          var st = normalize(j.state);
          saveBackup(st);
          return { state: st, from: 'server', storage: storage };
        }
      }
    } catch (e) { /* fall through */ }
    try {
      var r2 = await fetch('/data/state.json', { cache: 'no-store' });
      if (r2.ok) {
        var st2 = normalize(await r2.json());
        var hasContent = st2.library.length || st2.schedule.length || st2.playlists.length;
        if (hasContent) {
          saveBackup(st2);
          return { state: st2, from: 'file', storage: storage };
        }
        // Untouched repo file: keep this browser's own backup if it has work in it.
        var bk = readBackup();
        if (bk && (bk.library.length || bk.schedule.length || bk.playlists.length)) return { state: bk, from: 'backup', storage: storage };
        return { state: st2, from: 'default', storage: storage };
      }
    } catch (e) { /* fall through */ }
    var b = readBackup();
    if (b) return { state: b, from: 'backup', storage: storage };
    return { state: defaultState(), from: 'default', storage: storage };
  }

  function saveBackup(st) {
    try { localStorage.setItem(LS_BACKUP, JSON.stringify(st)); } catch (e) { /* storage full or blocked */ }
  }
  function readBackup() {
    try {
      var raw = localStorage.getItem(LS_BACKUP);
      return raw ? normalize(JSON.parse(raw)) : null;
    } catch (e) { return null; }
  }

  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ } }

  /** JSON fetch wrapper. Throws Error with a readable message. */
  async function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (opts.auth) headers.Authorization = 'Bearer ' + getToken();
    var res;
    try {
      res = await fetch(path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store',
      });
    } catch (e) {
      throw new Error('Network error. Are you offline?');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON */ }
    if (!res.ok) {
      var err = new Error((data && data.error) || 'Request failed (' + res.status + ')');
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function uid(prefix) {
    return (prefix || 'id') + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(Number(sec) || 0));
    var m = Math.floor(sec / 60), s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ---------- audio source helpers ----------

  /** Google Drive share link (or bare id) -> direct stream URL. Returns null if no file id is found. */
  function driveToDirect(input) {
    var s = String(input || '').trim();
    var id = null;
    var m = /\/file\/d\/([A-Za-z0-9_-]{10,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s) || /\/d\/([A-Za-z0-9_-]{10,})/.exec(s);
    if (m) id = m[1];
    else if (/^[A-Za-z0-9_-]{20,}$/.test(s)) id = s;
    return id ? { id: id, url: 'https://drive.google.com/uc?export=download&id=' + id } : null;
  }

  /** archive.org URL or identifier -> identifier. */
  function archiveId(input) {
    var s = String(input || '').trim();
    var m = /archive\.org\/(?:details|download|metadata|embed)\/([^/?#\s]+)/i.exec(s);
    if (m) return decodeURIComponent(m[1]);
    return /^[A-Za-z0-9._\-]+$/.test(s) ? s : null;
  }

  function archiveStreamUrl(id, file) {
    return 'https://archive.org/download/' + encodeURIComponent(id) + '/' + String(file).split('/').map(encodeURIComponent).join('/');
  }

  /** archive.org file "length" can be seconds ("245.3") or "mm:ss" / "h:mm:ss". */
  function parseLength(v) {
    if (v == null || v === '') return 0;
    var s = String(v);
    if (s.indexOf(':') >= 0) {
      return s.split(':').reduce(function (acc, p) { return acc * 60 + (parseFloat(p) || 0); }, 0);
    }
    return parseFloat(s) || 0;
  }

  /** Load just the metadata of an audio URL to learn its duration. Resolves 0 on failure. */
  function probeDuration(url, timeoutMs) {
    return new Promise(function (resolve) {
      var a = new Audio();
      var done = false;
      function finish(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        a.removeAttribute('src');
        try { a.load(); } catch (e) { /* ignore */ }
        resolve(v);
      }
      var timer = setTimeout(function () { finish(0); }, timeoutMs || 12000);
      a.preload = 'metadata';
      a.onloadedmetadata = function () { finish(isFinite(a.duration) ? a.duration : 0); };
      a.onerror = function () { finish(0); };
      a.src = url;
    });
  }

  function timeInZone(ms, tz, withSeconds) {
    try {
      return new Intl.DateTimeFormat([], {
        timeZone: tz, hour: '2-digit', minute: '2-digit', second: withSeconds ? '2-digit' : undefined, hour12: false,
      }).format(new Date(ms));
    } catch (e) {
      return new Date(ms).toTimeString().slice(0, 8);
    }
  }

  window.Core = {
    defaultState: defaultState, normalize: normalize, now: now, syncClock: syncClock,
    loadState: loadState, saveBackup: saveBackup, readBackup: readBackup,
    getToken: getToken, setToken: setToken, api: api, uid: uid,
    fmtDuration: fmtDuration, esc: esc, driveToDirect: driveToDirect, archiveId: archiveId,
    archiveStreamUrl: archiveStreamUrl, parseLength: parseLength, probeDuration: probeDuration,
    timeInZone: timeInZone,
  };
})();
