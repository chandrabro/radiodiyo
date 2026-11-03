/* Admin page: login, library, playlists, schedule, host settings, data. Exposes window.Admin for live.js. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = Core.esc;
  var state = Core.defaultState();
  var dirty = false;
  var storageMode = 'file';
  var voices = [];
  var toastTimer = null;

  function show(el, on) { el.classList.toggle('hidden', !on); }

  function toast(msg, kind) {
    var el = $('toast');
    el.className = 'notice ' + (kind || 'ok');
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { show(el, false); }, kind === 'err' ? 9000 : 4000);
  }

  function markDirty() {
    dirty = true;
    $('saveState').textContent = 'Unsaved changes';
    $('saveState').className = 'dirty small';
    Core.saveBackup(state); // local backup on every change
  }

  // ---------- login ----------
  async function checkSession() {
    if (!Core.getToken()) return false;
    try {
      // Probe with an authenticated write of nothing is unsafe; instead trust the token until a request returns 401.
      return true;
    } catch (e) { return false; }
  }

  $('loginForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var err = $('loginErr');
    show(err, false);
    try {
      var j = await Core.api('/api/login', { method: 'POST', body: { password: $('pw').value } });
      Core.setToken(j.token);
      $('pw').value = '';
      await enter();
    } catch (ex) {
      err.textContent = ex.message;
      show(err, true);
    }
  });

  $('logoutBtn').addEventListener('click', function () {
    if (dirty && !confirm('You have unsaved changes. Log out anyway?')) return;
    Core.setToken('');
    location.reload();
  });

  function authFailed() {
    Core.setToken('');
    toast('Your session expired. Please log in again.', 'err');
    setTimeout(function () { location.reload(); }, 1500);
  }

  // ---------- load / save ----------
  async function load() {
    var res = await Core.loadState();
    state = res.state;
    try {
      var r = await Core.api('/api/state');
      storageMode = r.storage || 'file';
    } catch (e) { storageMode = 'file'; }
    // prefer a newer local backup only if the server had nothing
    $('storageNote').textContent = storageMode === 'supabase'
      ? 'Storage: Supabase (saved online). Everyone sees your changes within about a minute.'
      : 'Storage: repo file (Supabase is not configured). "Save changes" keeps a copy in this browser only; export the JSON and commit it to GitHub to publish.';
  }

  async function save() {
    Core.saveBackup(state);
    if (storageMode !== 'supabase') {
      dirty = false;
      $('saveState').textContent = 'Saved in this browser only';
      $('saveState').className = 'muted small';
      toast('Supabase isn\'t set up, so this is only saved in this browser. Use Export JSON and commit it to publish.', 'info');
      return;
    }
    $('saveBtn').disabled = true;
    try {
      await Core.api('/api/state', { method: 'POST', auth: true, body: state });
      dirty = false;
      $('saveState').textContent = 'All changes saved';
      $('saveState').className = 'muted small';
      toast('Saved. Listeners will pick it up within about a minute.');
    } catch (e) {
      if (e.status === 401) return authFailed();
      toast('Could not save online: ' + e.message + ' (a copy is kept in this browser).', 'err');
    } finally {
      $('saveBtn').disabled = false;
    }
  }
  $('saveBtn').addEventListener('click', save);
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  // ---------- tabs ----------
  $('tabs').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tab]');
    if (!b) return;
    var name = b.getAttribute('data-tab');
    Array.prototype.forEach.call($('tabs').children, function (x) { x.classList.toggle('active', x === b); });
    ['library', 'playlists', 'schedule', 'host', 'live', 'inbox', 'data'].forEach(function (t) { show($('tab-' + t), t === name); });
    if (name === 'schedule' || name === 'playlists') renderSchedule();
    if (name === 'live') renderLiveTracks();
    if (name === 'inbox') loadInbox();
  });

  // ---------- library ----------
  // ---------- preview player (play / pause icons) ----------
  var ICON_PLAY = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
  var ICON_PAUSE = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  var preview = new Audio();
  var previewUrl = '';

  // Make every preview button show pause for the track that is playing and play for all others.
  function syncPreviewIcons() {
    var playing = !preview.paused && !preview.ended && !!previewUrl;
    Array.prototype.forEach.call(document.querySelectorAll('[data-play],[data-jprev]'), function (b) {
      var on = playing && b.getAttribute('data-url') === previewUrl;
      b.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
      b.setAttribute('aria-label', on ? 'Pause preview' : 'Play preview');
      b.setAttribute('title', on ? 'Pause' : 'Play preview');
      b.classList.toggle('active', on);
    });
  }
  function togglePreview(url, title) {
    if (previewUrl === url && !preview.paused && !preview.ended) { preview.pause(); return; }
    if (previewUrl !== url || preview.ended) { previewUrl = url; preview.src = url; }
    preview.play().catch(function () {
      toast('Could not play "' + title + '". The link may be dead or blocked.', 'err');
      previewUrl = '';
      syncPreviewIcons();
    });
  }
  ['play', 'playing', 'pause', 'ended', 'error', 'emptied'].forEach(function (ev) { preview.addEventListener(ev, syncPreviewIcons); });

  function addTracks(list) {
    var have = {};
    state.library.forEach(function (t) { have[t.url] = true; });
    var added = 0;
    list.forEach(function (t) {
      if (!t.url || have[t.url]) return;
      have[t.url] = true;
      state.library.push(t);
      added++;
    });
    if (added) { markDirty(); renderLibrary(); }
    return added;
  }

  function renderLibrary() {
    $('libCount').textContent = state.library.length;
    show($('libEmpty'), !state.library.length);
    $('libBody').innerHTML = state.library.map(function (t, i) {
      return '<tr>' +
        '<td><input type="text" data-edit="title" data-i="' + i + '" value="' + esc(t.title) + '" aria-label="Title"><div class="small muted">' + esc(t.artist || '') + '</div></td>' +
        '<td><span class="pill ' + esc(t.source) + '">' + esc(t.source) + '</span></td>' +
        '<td>' + Core.fmtDuration(t.duration) + '</td>' +
        '<td><input type="text" data-edit="tags" data-i="' + i + '" value="' + esc((t.tags || []).join(', ')) + '" aria-label="Tags" placeholder="tag, tag"></td>' +
        '<td><button class="sm iconbtn" data-play="' + i + '" data-url="' + esc(t.url) + '" aria-label="Play preview">' + ICON_PLAY + '</button> <button class="sm danger" data-del="' + i + '" aria-label="Delete">Delete</button></td>' +
        '</tr>';
    }).join('');
    renderPlaylists();
    renderSchedule();
    syncPreviewIcons();
  }

  $('libBody').addEventListener('click', function (e) {
    var d = e.target.closest('[data-del]');
    var p = e.target.closest('[data-play]');
    if (d) {
      var i = +d.getAttribute('data-del');
      var t = state.library[i];
      if (!confirm('Delete "' + t.title + '" from the library? It will also be removed from playlists and schedule slots.')) return;
      if (previewUrl === t.url) { preview.pause(); previewUrl = ''; }
      state.library.splice(i, 1);
      state.playlists.forEach(function (pl) { pl.trackIds = pl.trackIds.filter(function (id) { return id !== t.id; }); });
      state.schedule = state.schedule.filter(function (s) { return !(s.type === 'track' && s.trackId === t.id); });
      markDirty(); renderLibrary();
    } else if (p) {
      var tr = state.library[+p.getAttribute('data-play')];
      togglePreview(tr.url, tr.title);
    }
  });
  $('libBody').addEventListener('change', function (e) {
    var el = e.target;
    var i = el.getAttribute('data-i');
    if (i == null) return;
    var t = state.library[+i];
    if (el.getAttribute('data-edit') === 'title') t.title = el.value.trim() || t.title;
    else t.tags = el.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    markDirty();
  });

  // Jamendo
  async function jamSearch() {
    var tag = $('jmTag').value.trim();
    var out = $('jmResults');
    if (!tag) return toast('Type a genre or mood first.', 'err');
    out.innerHTML = '<p class="muted">Searching…</p>';
    try {
      var j = await Core.api('/api/jamendo?tag=' + encodeURIComponent(tag) + '&limit=30');
      var tracks = j.tracks || [];
      if (!tracks.length) { out.innerHTML = '<p class="muted">No tracks found. Try another tag.</p>'; return; }
      out.innerHTML = '<p><button id="jmAddAll" class="sm">Add all ' + tracks.length + '</button></p>' + tracks.map(function (t, i) {
        return '<div class="pickrow"><div class="t"><b>' + esc(t.title) + '</b> <span class="muted">· ' + esc(t.artist) + ' · ' + Core.fmtDuration(t.duration) + '</span></div>' +
          '<button class="sm iconbtn" data-jprev="' + i + '" data-url="' + esc(t.url) + '" aria-label="Play preview">' + ICON_PLAY + '</button><button class="sm primary" data-jadd="' + i + '">Add</button></div>';
      }).join('');
      out._tracks = tracks;
      syncPreviewIcons();
    } catch (e) {
      out.innerHTML = '<div class="notice err">' + esc(e.message) + '</div>';
    }
  }
  $('jmSearch').addEventListener('click', jamSearch);
  $('jmTag').addEventListener('keydown', function (e) { if (e.key === 'Enter') jamSearch(); });
  $('jmResults').addEventListener('click', function (e) {
    var out = $('jmResults');
    var a = e.target.closest('[data-jadd]');
    var pv = e.target.closest('[data-jprev]');
    if (e.target.id === 'jmAddAll') { toast('Added ' + addTracks(out._tracks) + ' tracks.'); }
    else if (a) { toast(addTracks([out._tracks[+a.getAttribute('data-jadd')]]) ? 'Added.' : 'Already in the library.', 'ok'); }
    else if (pv) { var jt = out._tracks[+pv.getAttribute('data-jprev')]; togglePreview(jt.url, jt.title); }
  });

  // Internet Archive
  async function iaLoad() {
    var id = Core.archiveId($('iaInput').value);
    var out = $('iaResults');
    if (!id) return toast('Paste an archive.org item link or identifier.', 'err');
    out.innerHTML = '<p class="muted">Reading item…</p>';
    var meta;
    try {
      var r = await fetch('https://archive.org/metadata/' + encodeURIComponent(id));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      meta = await r.json();
    } catch (e) {
      try { meta = await Core.api('/api/archive?id=' + encodeURIComponent(id)); } // server fallback if the browser is blocked
      catch (e2) { out.innerHTML = '<div class="notice err">Could not read this item: ' + esc(e2.message) + '</div>'; return; }
    }
    var files = (meta.files || []).filter(function (f) { return /\.(mp3|ogg|oga|opus|m4a|aac|wav|flac)$/i.test(f.name || '') && f.source !== 'metadata'; });
    // Prefer originals; if an original is lossless (wav/flac), the derivative MP3 is much lighter to stream.
    var hasMp3 = files.some(function (f) { return /\.mp3$/i.test(f.name); });
    if (hasMp3) files = files.filter(function (f) { return /\.mp3$/i.test(f.name); });
    if (!files.length) { out.innerHTML = '<div class="notice err">No audio files found in "' + esc(id) + '". Is the item public and processed?</div>'; return; }
    var itemTitle = (meta.metadata && meta.metadata.title) || id;
    if (Array.isArray(itemTitle)) itemTitle = itemTitle[0];
    out._items = files.map(function (f) {
      var name = f.title || String(f.name).replace(/\.[^.]+$/, '').split('/').pop();
      return { id: 'ia-' + id + '-' + f.name, title: name, artist: String(Array.isArray(meta.metadata && meta.metadata.creator) ? meta.metadata.creator[0] : (meta.metadata && meta.metadata.creator) || ''),
        url: Core.archiveStreamUrl(id, f.name), duration: Core.parseLength(f.length), source: 'archive', tags: [id] };
    });
    out.innerHTML = '<p>' + files.length + ' audio file(s) in <b>' + esc(itemTitle) + '</b> <button class="sm" id="iaAddAll">Add all</button></p>' + out._items.map(function (t, i) {
      return '<div class="pickrow"><div class="t">' + esc(t.title) + ' <span class="muted">· ' + (t.duration ? Core.fmtDuration(t.duration) : 'length unknown (will be measured)') + '</span></div><button class="sm primary" data-iadd="' + i + '">Add</button></div>';
    }).join('');
  }
  $('iaLoad').addEventListener('click', iaLoad);
  $('iaInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') iaLoad(); });
  $('iaResults').addEventListener('click', async function (e) {
    var out = $('iaResults');
    var items = null;
    if (e.target.id === 'iaAddAll') items = out._items.slice();
    else { var a = e.target.closest('[data-iadd]'); if (a) items = [out._items[+a.getAttribute('data-iadd')]]; }
    if (!items) return;
    e.target.disabled = true;
    for (var i = 0; i < items.length; i++) {
      if (!items[i].duration) items[i].duration = await Core.probeDuration(items[i].url, 15000);
      if (!items[i].duration) { toast('Skipped "' + items[i].title + '": couldn\'t read its length.', 'err'); items[i] = null; }
    }
    toast('Added ' + addTracks(items.filter(Boolean)) + ' recording(s).');
    e.target.disabled = false;
  });

  // Direct + Drive (shared: probe, then add)
  async function addByUrl(url, title, artist, source, btn) {
    btn.disabled = true;
    var prev = btn.textContent;
    btn.textContent = 'Testing…';
    var dur = await Core.probeDuration(url, 15000);
    btn.disabled = false;
    btn.textContent = prev;
    if (!dur) {
      var manual = prompt('Could not load this audio (dead link, not shared publicly, or blocked). If you are sure it works, type its length in seconds to add it anyway, or Cancel.');
      dur = parseFloat(manual);
      if (!(dur > 0)) return toast('Not added: the audio could not be loaded.', 'err');
    }
    addTracks([{ id: Core.uid('trk'), title: title || 'Untitled', artist: artist || '', url: url, duration: dur, source: source, tags: [] }]);
    toast('Added "' + (title || 'Untitled') + '".');
  }
  $('drAdd').addEventListener('click', function () {
    var d = Core.driveToDirect($('drLink').value);
    if (!d) return toast('That doesn\'t look like a Google Drive share link.', 'err');
    addByUrl(d.url, $('drTitle').value.trim() || 'Drive recording', '', 'drive', $('drAdd'));
  });
  $('dlAdd').addEventListener('click', function () {
    var u = $('dlUrl').value.trim();
    if (!/^https?:\/\//i.test(u)) return toast('Enter a full http(s) audio URL.', 'err');
    var guess = decodeURIComponent(u.split('?')[0].split('/').pop() || '').replace(/\.[^.]+$/, '');
    addByUrl(u, $('dlTitle').value.trim() || guess, $('dlArtist').value.trim(), 'direct', $('dlAdd'));
  });

  // ---------- playlists ----------
  function renderPlaylists() {
    var box = $('plList');
    if (!state.playlists.length) { box.innerHTML = '<p class="muted small">No playlists yet.</p>'; return; }
    box.innerHTML = state.playlists.map(function (pl, pi) {
      var total = 0;
      pl.trackIds.forEach(function (id) { var t = state.library.filter(function (x) { return x.id === id; })[0]; if (t) total += t.duration; });
      return '<details class="card"><summary>' + esc(pl.name) + ' <span class="muted small">· ' + pl.trackIds.length + ' tracks · ' + Core.fmtDuration(total) + '</span></summary>' +
        '<div class="row"><div><label>Name</label><input type="text" data-plname="' + pi + '" value="' + esc(pl.name) + '"></div><button class="danger" data-pldel="' + pi + '">Delete playlist</button></div>' +
        '<label>Tracks (checked = in this playlist; order = order checked)</label>' +
        (state.library.length ? state.library.map(function (t) {
          var idx = pl.trackIds.indexOf(t.id);
          return '<div class="pickrow"><input type="checkbox" data-pltrack="' + pi + '" data-tid="' + esc(t.id) + '"' + (idx >= 0 ? ' checked' : '') + ' aria-label="' + esc(t.title) + '"><div class="t">' + esc(t.title) + ' <span class="muted small">' + esc(t.artist || '') + '</span></div>' +
            (idx >= 0 ? '<span class="pill">#' + (idx + 1) + '</span><button class="sm" data-plup="' + pi + '" data-tid="' + esc(t.id) + '" aria-label="Move up">↑</button><button class="sm" data-pldown="' + pi + '" data-tid="' + esc(t.id) + '" aria-label="Move down">↓</button>' : '') + '</div>';
        }).join('') : '<p class="muted small">Add tracks to the library first.</p>') +
        '</details>';
    }).join('');
  }
  $('plAdd').addEventListener('click', function () {
    var n = $('plName').value.trim();
    if (!n) return toast('Give the playlist a name.', 'err');
    state.playlists.push({ id: Core.uid('pl'), name: n, trackIds: [] });
    $('plName').value = '';
    markDirty(); renderPlaylists(); renderSchedule();
  });
  $('plList').addEventListener('change', function (e) {
    var el = e.target;
    if (el.hasAttribute('data-plname')) { state.playlists[+el.getAttribute('data-plname')].name = el.value.trim() || 'Playlist'; markDirty(); renderSchedule(); return; }
    if (el.hasAttribute('data-pltrack')) {
      var pl = state.playlists[+el.getAttribute('data-pltrack')];
      var tid = el.getAttribute('data-tid');
      if (el.checked) { if (pl.trackIds.indexOf(tid) < 0) pl.trackIds.push(tid); } else pl.trackIds = pl.trackIds.filter(function (x) { return x !== tid; });
      markDirty(); keepOpen(el);
    }
  });
  function keepOpen(el) {
    var open = {};
    Array.prototype.forEach.call($('plList').querySelectorAll('details'), function (d, i) { open[i] = d.open; });
    renderPlaylists();
    Array.prototype.forEach.call($('plList').querySelectorAll('details'), function (d, i) { d.open = !!open[i]; });
  }
  $('plList').addEventListener('click', function (e) {
    var del = e.target.closest('[data-pldel]');
    var up = e.target.closest('[data-plup]');
    var dn = e.target.closest('[data-pldown]');
    if (del) {
      var i = +del.getAttribute('data-pldel');
      if (!confirm('Delete playlist "' + state.playlists[i].name + '"?')) return;
      var id = state.playlists[i].id;
      state.playlists.splice(i, 1);
      state.schedule = state.schedule.filter(function (s) { return !(s.type === 'playlist' && s.playlistId === id); });
      if (state.settings.defaultPlaylistId === id) state.settings.defaultPlaylistId = '';
      markDirty(); renderPlaylists(); renderSchedule();
    } else if (up || dn) {
      var b = up || dn;
      var pl = state.playlists[+b.getAttribute(up ? 'data-plup' : 'data-pldown')];
      var k = pl.trackIds.indexOf(b.getAttribute('data-tid'));
      var j = up ? k - 1 : k + 1;
      if (k < 0 || j < 0 || j >= pl.trackIds.length) return;
      var tmp = pl.trackIds[k]; pl.trackIds[k] = pl.trackIds[j]; pl.trackIds[j] = tmp;
      markDirty(); keepOpen(b);
    }
  });

  // ---------- schedule ----------
  var selectedDays = [1, 2, 3, 4, 5];
  function renderDays() {
    $('scDays').innerHTML = RadioSchedule.DAY_NAMES.map(function (n, i) {
      return '<label class="inline"><input type="checkbox" data-day="' + i + '"' + (selectedDays.indexOf(i) >= 0 ? ' checked' : '') + '> ' + n.slice(0, 3) + '</label>';
    }).join('');
  }
  $('scDays').addEventListener('change', function (e) {
    var d = +e.target.getAttribute('data-day');
    selectedDays = selectedDays.filter(function (x) { return x !== d; });
    if (e.target.checked) selectedDays.push(d);
  });

  function renderSchedule() {
    var type = $('scType').value;
    show($('scWhat'), type !== 'genre');
    show($('scGenre'), type === 'genre');
    $('scWhatLabel').textContent = type === 'playlist' ? 'Playlist' : type === 'track' ? 'Recording' : 'Genre or mood';
    if (type === 'playlist') $('scWhat').innerHTML = state.playlists.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>'; }).join('') || '<option value="">(create a playlist first)</option>';
    else if (type === 'track') $('scWhat').innerHTML = state.library.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.title) + '</option>'; }).join('') || '<option value="">(add to the library first)</option>';

    var sorted = state.schedule.slice().sort(function (a, b) { return RadioSchedule.toSec(a.start) - RadioSchedule.toSec(b.start); });
    show($('scEmpty'), !sorted.length);
    $('scBody').innerHTML = sorted.map(function (s) {
      var days = (s.days || []).slice().sort().map(function (d) { return RadioSchedule.DAY_NAMES[d].slice(0, 3); }).join(' ');
      return '<tr><td>' + days + '</td><td>' + esc(fmt12(s.start)) + ' – ' + esc(fmt12(s.end)) + (RadioSchedule.toSec(s.end) <= RadioSchedule.toSec(s.start) ? ' <span class="pill">+1 day</span>' : '') + '</td><td>' + esc(RadioSchedule.describeSlot(state, s)) + '</td><td style="white-space:nowrap"><button class="sm" data-scedit="' + esc(s.id) + '">Edit</button> <button class="sm danger" data-scdel="' + esc(s.id) + '">Remove</button></td></tr>';
    }).join('');

    var st = state.settings;
    var cur = st.defaultPlaylistId || (st.defaultGenre ? '__auto' : '__library');
    $('defPl').innerHTML = '<option value="__auto">Free music from Jamendo (automatic, recommended)</option>' +
      '<option value="__library">My whole library</option>' +
      state.playlists.map(function (p) { return '<option value="' + esc(p.id) + '">Playlist: ' + esc(p.name) + '</option>'; }).join('');
    $('defPl').value = cur;
    $('defGenre').value = st.defaultGenre || '';
    show($('defGenreWrap'), cur === '__auto');
  }
  $('scType').addEventListener('change', renderSchedule);
  $('defPl').addEventListener('change', function () {
    var v = $('defPl').value;
    if (v === '__auto') { state.settings.defaultPlaylistId = ''; state.settings.defaultGenre = state.settings.defaultGenre || 'relaxing'; }
    else if (v === '__library') { state.settings.defaultPlaylistId = ''; state.settings.defaultGenre = ''; }
    else state.settings.defaultPlaylistId = v;
    markDirty(); renderSchedule();
  });
  $('defGenre').addEventListener('change', function () {
    state.settings.defaultGenre = $('defGenre').value.trim().toLowerCase() || 'relaxing';
    markDirty(); renderSchedule();
  });
  // ----- time pickers: hour / minute / AM-PM dropdowns (editable on every device) -----
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmt12(hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return String(hhmm || '');
    var h = parseInt(m[1], 10);
    return (h % 12 || 12) + ':' + m[2] + ' ' + (h >= 12 && h < 24 ? 'PM' : 'AM');
  }
  function initTimePickers() {
    ['scStart', 'scEnd'].forEach(function (pref) {
      var hs = '', ms = '', i;
      for (i = 1; i <= 12; i++) hs += '<option value="' + i + '">' + i + '</option>';
      for (i = 0; i < 60; i++) ms += '<option value="' + pad2(i) + '">' + pad2(i) + '</option>';
      $(pref + 'H').innerHTML = hs;
      $(pref + 'M').innerHTML = ms;
    });
    writeTime('scStart', '08:00');
    writeTime('scEnd', '10:00');
  }
  function readTime(pref) {
    var h = parseInt($(pref + 'H').value, 10) % 12;
    if ($(pref + 'P').value === 'PM') h += 12;
    return pad2(h) + ':' + $(pref + 'M').value;
  }
  function writeTime(pref, hhmm) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '08:00')) || ['', '8', '00'];
    var h = parseInt(m[1], 10) % 24;
    $(pref + 'P').value = h >= 12 ? 'PM' : 'AM';
    $(pref + 'H').value = String(h % 12 || 12);
    $(pref + 'M').value = m[2];
  }
  initTimePickers();

  // ----- add / edit / remove slots -----
  var editingId = '';
  function resetSlotForm() {
    editingId = '';
    $('scAdd').textContent = 'Add to timetable';
    $('scFormTitle').textContent = 'Add a time slot';
    show($('scCancel'), false);
  }
  $('scCancel').addEventListener('click', resetSlotForm);

  $('scAdd').addEventListener('click', function () {
    var type = $('scType').value;
    var slot = { id: editingId || Core.uid('slot'), days: selectedDays.slice().sort(), start: readTime('scStart'), end: readTime('scEnd'), type: type, label: $('scLabel').value.trim() };
    if (!slot.days.length) return toast('Pick at least one day.', 'err');
    if (slot.start === slot.end) return toast('Start and end must be different (for all day use 12:00 AM to 11:59 PM).', 'err');
    if (type === 'playlist') { slot.playlistId = $('scWhat').value; if (!slot.playlistId) return toast('Create a playlist first.', 'err'); }
    else if (type === 'track') { slot.trackId = $('scWhat').value; if (!slot.trackId) return toast('Add a recording to the library first.', 'err'); }
    else { slot.genre = $('scGenre').value.trim(); if (!slot.genre) return toast('Type a genre or mood.', 'err'); }
    var clash = state.schedule.some(function (o) {
      return o.id !== slot.id && o.days.some(function (d) { return slot.days.indexOf(d) >= 0; }) && RadioSchedule.toSec(o.start) < RadioSchedule.toSec(slot.end) && RadioSchedule.toSec(slot.start) < RadioSchedule.toSec(o.end) && RadioSchedule.toSec(o.end) > RadioSchedule.toSec(o.start) && RadioSchedule.toSec(slot.end) > RadioSchedule.toSec(slot.start);
    });
    var wasEditing = !!editingId;
    if (wasEditing) state.schedule = state.schedule.map(function (o) { return o.id === slot.id ? slot : o; });
    else state.schedule.push(slot);
    resetSlotForm();
    markDirty(); renderSchedule();
    var base = wasEditing ? 'Slot updated.' : 'Slot added.';
    toast(clash ? base + ' It overlaps another slot: the slot that started most recently wins.' : base, clash ? 'info' : 'ok');
  });

  $('scBody').addEventListener('click', function (e) {
    var del = e.target.closest('[data-scdel]');
    var ed = e.target.closest('[data-scedit]');
    if (del) {
      var id = del.getAttribute('data-scdel');
      if (editingId === id) resetSlotForm();
      state.schedule = state.schedule.filter(function (s) { return s.id !== id; });
      markDirty(); renderSchedule();
    } else if (ed) {
      var slot = state.schedule.filter(function (s) { return s.id === ed.getAttribute('data-scedit'); })[0];
      if (!slot) return;
      editingId = slot.id;
      selectedDays = (slot.days || []).slice();
      renderDays();
      writeTime('scStart', slot.start);
      writeTime('scEnd', slot.end);
      $('scType').value = slot.type;
      renderSchedule();
      if (slot.type === 'genre') $('scGenre').value = slot.genre || '';
      else $('scWhat').value = slot.type === 'playlist' ? slot.playlistId : slot.trackId;
      $('scLabel').value = slot.label || '';
      $('scAdd').textContent = 'Save changes to this slot';
      $('scFormTitle').textContent = 'Edit time slot';
      show($('scCancel'), true);
      $('scFormTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });

  // ---------- host ----------
  function loadHostForm() {
    var h = state.settings.host;
    $('hEnabled').checked = !!h.enabled;
    $('hName').value = h.name || '';
    $('hPers').value = h.personality;
    $('hLang').value = h.language;
    $('hEvery').value = String(h.every);
    $('hCustom').value = h.custom || '';
    $('hWeather').checked = !!h.useWeather;
    $('hLat').value = h.lat; $('hLon').value = h.lon;
  }
  function readHostForm() {
    var h = state.settings.host;
    h.enabled = $('hEnabled').checked;
    h.name = $('hName').value.trim() || 'Maya';
    h.personality = $('hPers').value;
    h.language = $('hLang').value;
    h.every = parseInt($('hEvery').value, 10) || 1;
    h.custom = $('hCustom').value.trim();
    h.useWeather = $('hWeather').checked;
    h.lat = parseFloat($('hLat').value) || 0; h.lon = parseFloat($('hLon').value) || 0;
  }
  ['hEnabled', 'hName', 'hPers', 'hCustom', 'hWeather', 'hLat', 'hLon', 'hEvery'].forEach(function (id) {
    $(id).addEventListener('change', function () { readHostForm(); markDirty(); });
  });
  async function fillVoices() {
    voices = await HostVoice.getVoices();
    var lang = $('hLang').value;
    var list = HostVoice.voicesFor(voices, lang);
    var cur = state.settings.host.voices[lang] || '';
    $('hVoice').innerHTML = '<option value="">Automatic</option>' + list.map(function (v) {
      return '<option value="' + esc(v.name) + '"' + (v.name === cur ? ' selected' : '') + '>' + esc(v.name + ' (' + v.lang + ')') + '</option>';
    }).join('');
    var ch = HostVoice.pick(voices, lang, cur);
    $('hVoiceNotice').textContent = ch.notice;
    show($('hVoiceNotice'), !!ch.notice);
  }
  $('hLang').addEventListener('change', function () { readHostForm(); markDirty(); fillVoices(); });
  $('hVoice').addEventListener('change', function () {
    state.settings.host.voices[$('hLang').value] = $('hVoice').value;
    markDirty();
    fillVoices();
  });
  $('hTest').addEventListener('click', async function () {
    readHostForm();
    var h = state.settings.host;
    var out = $('hTestOut');
    HostVoice.unlock();
    $('hTest').disabled = true;
    out.textContent = 'Asking the AI…';
    show(out, true);
    try {
      var j = await Core.api('/api/host', { method: 'POST', body: {
        title: 'Sunrise Walk', artist: 'Test Artist', prevTitle: 'Evening Light', prevArtist: 'Demo Band',
        hostName: h.name, personality: h.personality, language: h.language, custom: h.custom,
        station: state.settings.stationName, timezone: state.settings.timezone, useWeather: h.useWeather, lat: h.lat, lon: h.lon } });
      out.innerHTML = '<b>' + esc(h.name) + ':</b> ' + esc(j.line);
      var ch = HostVoice.pick(voices, h.language, h.voices[h.language]);
      await HostVoice.speak(j.line, ch);
    } catch (e) {
      out.innerHTML = '<span style="color:#ff9aa5">' + esc(e.message) + '</span>';
    }
    $('hTest').disabled = false;
  });

  // ---------- station & data ----------
  function loadStationForm() {
    $('stName').value = state.settings.stationName || '';
    $('stNameEn').value = state.settings.stationNameEn || '';
    $('stTz').value = state.settings.timezone || 'Asia/Kathmandu';
    var zones = ['Asia/Kathmandu', 'Asia/Kolkata', 'Asia/Dhaka', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];
    try { if (Intl.supportedValuesOf) zones = Intl.supportedValuesOf('timeZone'); } catch (e) { /* use short list */ }
    $('tzList').innerHTML = zones.map(function (z) { return '<option>' + z + '</option>'; }).join('');
    updateTzNow();
  }
  function updateTzNow() {
    var tz = $('stTz').value || 'Asia/Kathmandu';
    try { $('stTzNow').textContent = 'Current time there: ' + Core.timeInZone(Core.now(), tz, true); }
    catch (e) { $('stTzNow').textContent = ''; }
  }
  $('stName').addEventListener('change', function () { state.settings.stationName = $('stName').value.trim() || 'दियो online radio'; $('adminStation').textContent = state.settings.stationName; markDirty(); });
  $('stNameEn').addEventListener('change', function () { state.settings.stationNameEn = $('stNameEn').value.trim() || 'Diyo Online Radio'; markDirty(); });

  // ---------- inbox (listener requests & dedications) ----------
  var KIND_LABEL = { request: 'Song request', dedication: 'Dedication', greeting: 'Greeting' };
  async function loadInbox() {
    var box = $('inboxList');
    if (!Core.getToken()) return;
    box.innerHTML = '<p class="muted">Loading…</p>';
    try {
      var j = await Core.api('/api/messages', { auth: true });
      var list = j.messages || [];
      $('inboxCount').textContent = list.length;
      if (!list.length) { box.innerHTML = '<p class="muted">No messages yet.</p>'; return; }
      box.innerHTML = list.map(function (m) {
        return '<div class="msg"><div class="body"><span class="pill">' + esc(KIND_LABEL[m.kind] || m.kind) + '</span> <b>' + esc(m.name) + '</b> <span class="muted small">' +
          esc(Core.timeInZone(Date.parse(m.created_at), state.settings.timezone, false)) + '</span><div>' + esc(m.text) + '</div></div>' +
          '<button class="sm danger" data-msgdel="' + esc(m.id) + '">Delete</button></div>';
      }).join('');
    } catch (e) {
      if (e.status === 401) return authFailed();
      box.innerHTML = '<div class="notice err">' + esc(e.message) + (e.status === 501 ? ' Requests need Supabase (see the README).' : '') + '</div>';
    }
  }
  $('inboxRefresh').addEventListener('click', loadInbox);
  $('inboxList').addEventListener('click', async function (e) {
    var b = e.target.closest('[data-msgdel]');
    if (!b) return;
    b.disabled = true;
    try { await Core.api('/api/messages?id=' + encodeURIComponent(b.getAttribute('data-msgdel')), { method: 'DELETE', auth: true }); loadInbox(); }
    catch (err) { b.disabled = false; toast('Could not delete: ' + err.message, 'err'); }
  });
  $('stTz').addEventListener('change', function () {
    var z = $('stTz').value.trim();
    try { new Intl.DateTimeFormat('en', { timeZone: z }); } catch (e) { toast('"' + z + '" isn\'t a valid timezone name (example: Asia/Kathmandu).', 'err'); $('stTz').value = state.settings.timezone; return; }
    state.settings.timezone = z; markDirty(); updateTzNow();
  });
  setInterval(updateTzNow, 1000);

  $('exportBtn').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'radio-state-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  });
  $('importBtn').addEventListener('click', function () { $('importFile').click(); });
  $('importFile').addEventListener('change', function () {
    var f = $('importFile').files[0];
    if (!f) return;
    var rd = new FileReader();
    rd.onload = function () {
      try {
        var j = JSON.parse(rd.result);
        if (!j || typeof j !== 'object' || !Array.isArray(j.library)) throw new Error('This file is not a radio state export.');
        if (!confirm('Replace everything (' + state.library.length + ' tracks, ' + state.schedule.length + ' slots) with the imported file (' + j.library.length + ' tracks)?')) return;
        state = Core.normalize(j);
        markDirty(); renderAll();
        toast('Imported. Press "Save changes" to publish it.');
      } catch (e) { toast('Import failed: ' + e.message, 'err'); }
      $('importFile').value = '';
    };
    rd.readAsText(f);
  });

  // ---------- live tab helpers ----------
  function renderLiveTracks() {
    var sel = $('liveTrack');
    var keep = sel.value;
    sel.innerHTML = state.library.map(function (t) { return '<option value="' + esc(t.id) + '">' + esc(t.title) + '</option>'; }).join('') || '<option value="">(library is empty)</option>';
    if (keep) sel.value = keep;
  }

  function renderAll() {
    $('adminStation').textContent = state.settings.stationName || '';
    renderLibrary(); renderPlaylists(); renderSchedule(); renderDays(); loadHostForm(); loadStationForm(); fillVoices(); renderLiveTracks();
  }

  async function enter() {
    show($('loginView'), false);
    show($('appView'), true);
    await Core.syncClock();
    await load();
    renderAll();
  }

  window.Admin = {
    getState: function () { return state; },
    markDirty: markDirty,
    toast: toast,
    save: save,
    authFailed: authFailed,
    ensureLiveId: function () {
      if (!state.settings.liveId) { state.settings.liveId = 'radio-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 8); markDirty(); }
      return state.settings.liveId;
    },
    isSupabase: function () { return storageMode === 'supabase'; },
  };

  (async function init() {
    if (await checkSession()) {
      try { await enter(); return; } catch (e) { /* fall through to login */ }
    }
    show($('loginView'), true);
  })();
})();
