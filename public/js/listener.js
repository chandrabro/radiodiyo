/* दियो online radio: public listener page.
 * Schedule-synced playback, free default music, AI host, live broadcast, sleep timer, requests. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var audio = $('player');
  var liveAudio = $('liveAudio');
  var cabinet = $('cabinet');
  var ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] };
  var DUCK_LEVEL = 0.2;
  var SLEEP_STEPS = [0, 15, 30, 60]; // minutes; 0 = off

  var state = Core.defaultState();
  var stateJson = '';
  var storage = 'file';
  var genreCache = {};
  var genreTried = {};
  var genreFailed = {};
  var bad = new Set();            // tracks that failed to load (skipped locally)
  var started = false;            // listener pressed play
  var hadPlayed = false;
  var currentKey = null;
  var currentNp = null;
  var earlyPrevKey = null;        // set when we advanced a moment before the schedule boundary
  var lastTrack = null;
  var trackCount = 0;
  var prefetch = null;            // { key, promise }
  var ducking = false;
  var hostBusy = false;
  var hostCooldownUntil = 0;
  var lastResync = 0;
  var pendingMeta = null;
  var voices = [];
  var voiceChoice = null;
  var history = [];
  var sleepIdx = 0;
  var sleepEnd = 0;
  var statusTag = '';
  var attempt = 0;               // which audio source of the current track we are trying
  var lastBadAt = 0;
  var userVol = parseFloat(safeGet('radio_vol'));
  if (!isFinite(userVol)) userVol = 0.8;

  // live
  var liveActive = false;
  var peer = null;
  var liveConn = null;

  function safeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function safeSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ---------- small UI helpers ----------
  function show(el, on) { el.classList.toggle('hidden', !on); }
  function setStatus(msg, kind, tag) {
    var el = $('status');
    el.className = 'notice ' + (kind || '');
    el.textContent = msg || '';
    statusTag = msg ? (tag || '') : '';
    show(el, Boolean(msg));
  }
  function clearStatus(tag) { if (!tag || statusTag === tag) setStatus(''); }
  function setPlayIcon(playing) {
    $('playIcon').innerHTML = playing ? '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
    $('playBtn').setAttribute('aria-label', playing ? 'Stop' : 'Play');
    $('playLabel').innerHTML = playing ? 'रोक्नुहोस्<small>Stop</small>' : 'सुन्नुहोस्<small>Listen</small>';
  }
  function setPlaying(on) { cabinet.classList.toggle('is-playing', Boolean(on)); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function applyVolume() {
    audio.volume = Math.max(0, Math.min(1, userVol * (ducking ? DUCK_LEVEL : 1)));
    liveAudio.volume = Math.max(0, Math.min(1, userVol));
  }
  function tz() { return state.settings.timezone || 'Asia/Kathmandu'; }
  function stationName() { return state.settings.stationName || 'दियो online radio'; }

  // The dial needle "tunes" to a spot that depends on the track, like finding a station.
  function tune(seed) {
    var h = 7;
    String(seed || 'x').split('').forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) >>> 0; });
    $('needle').style.left = (7 + (h % 860) / 10) + '%';
  }

  // ---------- volume knob ----------
  var knob = $('volKnob');
  var drag = null;
  function setVol(v) {
    userVol = Math.max(0, Math.min(1, v));
    safeSet('radio_vol', String(userVol));
    applyVolume();
    updateKnob();
  }
  function updateKnob() {
    knob.style.setProperty('--rot', (-135 + userVol * 270) + 'deg');
    knob.setAttribute('aria-valuenow', String(Math.round(userVol * 100)));
    $('volPct').textContent = Math.round(userVol * 100) + '%';
  }
  knob.addEventListener('pointerdown', function (e) {
    drag = { x: e.clientX, y: e.clientY, v: userVol };
    try { knob.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
  });
  knob.addEventListener('pointermove', function (e) {
    if (!drag) return;
    setVol(drag.v + ((drag.y - e.clientY) + (e.clientX - drag.x)) / 160);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (n) { knob.addEventListener(n, function () { drag = null; }); });
  knob.addEventListener('keydown', function (e) {
    var step = { ArrowUp: 0.05, ArrowRight: 0.05, ArrowDown: -0.05, ArrowLeft: -0.05, PageUp: 0.1, PageDown: -0.1 }[e.key];
    if (step !== undefined) { setVol(userVol + step); e.preventDefault(); }
    else if (e.key === 'Home') { setVol(0); e.preventDefault(); }
    else if (e.key === 'End') { setVol(1); e.preventDefault(); }
  });
  knob.addEventListener('wheel', function (e) { setVol(userVol + (e.deltaY < 0 ? 0.04 : -0.04)); e.preventDefault(); }, { passive: false });
  updateKnob();
  applyVolume();

  // ---------- state ----------
  async function refreshState(first) {
    var res = await Core.loadState();
    storage = res.storage || 'file';
    show($('requestCard'), storage === 'supabase');
    var json = JSON.stringify(res.state);
    if (json !== stateJson) {
      stateJson = json;
      state = res.state;
      $('stationName').textContent = stationName();
      $('dialName').textContent = stationName().split(' ')[0];
      document.title = stationName();
      renderUpcoming();
      pickVoice();
      if (!first) bad.clear();
    }
    if (res.from === 'backup') setStatus('इन्टरनेट वा सर्भर उपलब्ध छैन: पछिल्लो सुरक्षित तालिका प्रयोग हुँदैछ। (Offline: using the last saved schedule.)', 'info', 'state');
    else if (!state.library.length && !state.settings.defaultGenre && !state.schedule.length) setStatus('यो स्टेसनमा अहिले कुनै गीत छैन। (No tracks yet: add some in the admin page.)', 'info', 'state');
    else clearStatus('state');
  }

  function wantedGenres() {
    var list = [];
    (state.schedule || []).forEach(function (s) { if (s.type === 'genre' && s.genre) list.push(String(s.genre)); });
    var st = state.settings;
    if (st.defaultGenre && !st.defaultPlaylistId) list.push(String(st.defaultGenre)); // free default music
    return list;
  }

  function ensureGenres() {
    wantedGenres().forEach(function (raw) {
      var g = raw.toLowerCase().trim();
      if (!g || genreCache[g] || (genreTried[g] && Date.now() - genreTried[g] < 60000)) return;
      genreTried[g] = Date.now();
      Core.api('/api/jamendo?tag=' + encodeURIComponent(g) + '&limit=40')
        .then(function (j) {
          var list = (j.tracks || []).filter(function (t) { return t.duration > 0; });
          if (list.length) genreCache[g] = list; // an empty result is not cached, so it is retried
          genreFailed[g] = !list.length;
          renderUpcoming();
        })
        .catch(function () { genreFailed[g] = true; /* retried in a minute; the schedule falls back to the library */ });
    });
  }

  function currentNow(opts) {
    return RadioSchedule.nowPlaying(state, Core.now() + ((opts && opts.plusMs) || 0), { genreCache: genreCache, skip: bad });
  }

  // ---------- main loop ----------
  function tick() {
    var ms = Core.now();
    $('clock').textContent = Core.timeInZone(ms, tz(), false);
    if (sleepEnd) {
      if (Date.now() >= sleepEnd) { sleepDone(); return; }
      var mins = Math.ceil((sleepEnd - Date.now()) / 60000);
      $('sleepText').textContent = mins + 'm';
    }
    if (liveActive) return;
    ensureGenres();

    var np = currentNow();
    if (!np) {
      if (bad.size && Date.now() - lastBadAt > 20000) bad.clear(); // give failed tracks another chance
      $('npTitle').textContent = started ? 'ट्यून हुँदैछ…' : 'सुन्न बटन थिच्नुहोस्';
      $('npArtist').innerHTML = '&nbsp;';
      $('npMeta').innerHTML = '&nbsp;';
      if (started) {
        var g = String(state.settings.defaultGenre || '').toLowerCase().trim();
        if (g && genreFailed[g]) setStatus('निःशुल्क संगीत अहिले लोड हुन सकेन। (Free music could not load. The admin should check the Jamendo key.)', 'err', 'genre');
        else setStatus('ट्यून हुँदैछ… निःशुल्क संगीत लोड हुँदैछ। (Tuning in…)', 'info', 'tune');
      }
      return;
    }
    clearStatus('tune'); clearStatus('genre');
    renderNowPlaying(np);
    if (!started) return;

    // Advanced early (audio ended slightly before the boundary): wait for the schedule to catch up.
    if (earlyPrevKey && np.key === earlyPrevKey) { schedulePrefetch(currentNp); return; }
    if (np.key === currentKey) earlyPrevKey = null;

    if (np.key !== currentKey) { playNp(np); return; }

    // same track: correct drift
    var drift = Math.abs(audio.currentTime - np.offset);
    if (!audio.paused && audio.readyState >= 2 && drift > 3 && Date.now() - lastResync > 15000) {
      lastResync = Date.now();
      try { audio.currentTime = np.offset; } catch (e) { /* ignore */ }
    }
    if (audio.paused && !audio.ended && audio.readyState >= 2 && started) audio.play().catch(onPlayBlocked);
    schedulePrefetch(np);
  }

  function renderNowPlaying(np) {
    $('npTitle').textContent = np.track.title || 'Untitled';
    $('npArtist').textContent = np.track.artist || '';
    $('npMeta').textContent = np.source === 'default' && !np.slot ? 'दियो संगीत · ' + defaultLabel() : RadioSchedule.describeSlot(state, np.slot);
    var dur = Number(np.track.duration) || 0;
    $('timeCur').textContent = Core.fmtDuration(np.offset);
    $('timeDur').textContent = Core.fmtDuration(dur);
    $('barFill').style.width = (dur ? Math.min(100, (np.offset / dur) * 100) : 0) + '%';
    if ('mediaSession' in navigator && window.MediaMetadata && started) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: np.track.title || '', artist: np.track.artist || '', album: stationName() });
      } catch (e) { /* ignore */ }
    }
  }

  function defaultLabel() {
    var st = state.settings;
    if (st.defaultPlaylistId) return 'Playlist';
    if (st.defaultGenre && genreCache[String(st.defaultGenre).toLowerCase().trim()]) return 'Free music · ' + st.defaultGenre;
    return 'Library';
  }

  function pushHistory(track) {
    if (history[0] && history[0].id === track.id) return;
    history.unshift({ id: track.id, title: track.title, artist: track.artist });
    history = history.slice(0, 7);
    var past = history.slice(1, 7);
    show($('historyCard'), past.length > 0);
    $('history').innerHTML = past.map(function (h) {
      return '<li><span>' + Core.esc(h.title) + '</span><span>' + Core.esc(h.artist || '') + '</span></li>';
    }).join('');
  }

  function srcList(t) { return [t.url].concat(Array.isArray(t.alts) ? t.alts : []).filter(Boolean); }

  // Load one of the track's audio sources and jump to the right position once it is ready.
  function loadSrc(track, offset, key) {
    if (pendingMeta) audio.removeEventListener('loadedmetadata', pendingMeta);
    pendingMeta = function () {
      pendingMeta = null;
      if (currentKey !== key) return;
      if (offset > 1.5 && isFinite(audio.duration) && offset < audio.duration - 1) {
        try { audio.currentTime = offset; } catch (e) { /* ignore */ }
      }
      audio.play().catch(onPlayBlocked);
    };
    audio.addEventListener('loadedmetadata', pendingMeta);
    audio.src = srcList(track)[attempt] || track.url;
    audio.load();
  }

  function playNp(np) {
    var track = np.track;
    var prev = currentNp ? currentNp.track : lastTrack;
    var isJoin = !hadPlayed || np.offset > 6; // joining mid-track: no host intro
    hadPlayed = true;
    currentKey = np.key;
    currentNp = np;
    earlyPrevKey = null;
    lastTrack = track;
    tune(track.id);
    pushHistory(track);

    attempt = 0;
    loadSrc(track, np.offset, np.key);
    applyVolume();

    if (!isJoin) maybeHost(np, prev);
  }

  function onPlayBlocked() { if (started) show($('tapNotice'), true); }

  audio.addEventListener('playing', function () {
    show($('tapNotice'), false);
    setPlayIcon(true);
    setPlaying(true);
    clearStatus('track');
  });
  audio.addEventListener('pause', function () { if (!liveActive) setPlaying(false); });

  audio.addEventListener('ended', function () {
    if (!started || !currentNp || liveActive) return;
    // Jump straight to the start of the next track to avoid a gap; the loop then waits for the clock to catch up.
    var next = currentNow({ plusMs: Math.max(0, currentNp.remaining) * 1000 });
    var nowNp = currentNow();
    if (next && nowNp && next.key !== currentKey) {
      if (nowNp.key === currentKey) earlyPrevKey = currentKey;
      playNp(next);
    } else {
      tick();
    }
  });

  audio.addEventListener('error', function () {
    if (!started || !currentNp || !audio.getAttribute('src')) return;
    var code = audio.error ? audio.error.code : 0;
    if (code === 1) return; // aborted on purpose (we switched track): not a failure
    var t = currentNp.track;
    if (!navigator.onLine) {
      setStatus('इन्टरनेट छैन जस्तो छ। जडान आउने प्रतीक्षा गर्दै… (Offline)', 'info', 'net');
      return;
    }
    // Try the track's backup audio sources before giving up on it.
    var list = srcList(t);
    if (attempt + 1 < list.length) {
      attempt++;
      var cur = currentNow();
      loadSrc(t, cur && cur.key === currentKey ? cur.offset : currentNp.offset, currentKey);
      return;
    }
    bad.add(t.id);
    lastBadAt = Date.now();
    setStatus('"' + (t.title || 'track') + '" लोड हुन सकेन (error ' + code + '), अर्को गीतमा जाँदै। (Skipping a broken track.)', 'err', 'track');
    currentKey = null;
    earlyPrevKey = null;
    setTimeout(tick, 300);
  });

  window.addEventListener('online', function () { clearStatus('net'); currentKey = null; tick(); });
  window.addEventListener('offline', function () { if (started) setStatus('इन्टरनेट छैन जस्तो छ। (You appear to be offline.)', 'info', 'net'); });

  // ---------- play / stop ----------
  function startPlayback() {
    started = true;
    HostVoice.unlock();
    setPlayIcon(true);
    show($('tapNotice'), false);
    if (liveActive) { liveAudio.play().catch(function () {}); return; }
    currentKey = null;
    hadPlayed = false; // first track after pressing play joins mid-track: no host intro
    tick();
  }
  function stopPlayback() {
    started = false;
    audio.pause();
    liveAudio.pause();
    HostVoice.cancel();
    ducking = false;
    applyVolume();
    setPlayIcon(false);
    setPlaying(false);
    currentKey = null;
    clearStatus('tune'); clearStatus('track');
  }
  $('playBtn').addEventListener('click', function () { if (!started) startPlayback(); else { stopPlayback(); resetSleep(); } });

  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.setActionHandler('play', function () { if (!started) startPlayback(); });
      navigator.mediaSession.setActionHandler('pause', function () { if (started) { stopPlayback(); resetSleep(); } });
      navigator.mediaSession.setActionHandler('stop', function () { if (started) { stopPlayback(); resetSleep(); } });
    } catch (e) { /* not supported */ }
  }

  // ---------- sleep timer ----------
  function resetSleep() {
    sleepIdx = 0; sleepEnd = 0;
    $('sleepBtn').classList.remove('on');
    show($('sleepText'), false); show($('sleepIcon'), true);
    $('sleepBtn').setAttribute('aria-label', 'Sleep timer: off');
  }
  function sleepDone() {
    resetSleep();
    stopPlayback();
    setStatus('सुत्ने टाइमर सकियो। शुभ रात्रि! (Sleep timer finished. Good night!)', 'ok', 'sleep');
    setTimeout(function () { clearStatus('sleep'); }, 8000);
  }
  $('sleepBtn').addEventListener('click', function () {
    sleepIdx = (sleepIdx + 1) % SLEEP_STEPS.length;
    var m = SLEEP_STEPS[sleepIdx];
    if (!m) { resetSleep(); setStatus('सुत्ने टाइमर बन्द। (Sleep timer off)', 'info', 'sleep'); setTimeout(function () { clearStatus('sleep'); }, 3000); return; }
    sleepEnd = Date.now() + m * 60000;
    $('sleepBtn').classList.add('on');
    show($('sleepText'), true); show($('sleepIcon'), false);
    $('sleepText').textContent = m + 'm';
    $('sleepBtn').setAttribute('aria-label', 'Sleep timer: ' + m + ' minutes');
    setStatus(m + ' मिनेटमा रेडियो बन्द हुनेछ। (Radio will stop in ' + m + ' minutes.)', 'info', 'sleep');
    setTimeout(function () { clearStatus('sleep'); }, 4000);
  });

  // ---------- AI host ----------
  function hostCfg() { return state.settings.host || {}; }

  function dueNext() {
    var h = hostCfg();
    return h.enabled && (trackCount + 1) % Math.max(1, h.every) === 0 && Date.now() >= hostCooldownUntil;
  }

  function fetchLine(prevTrack, nextTrack) {
    var h = hostCfg();
    var st = state.settings;
    // An English voice cannot read Devanagari, so use the English station name unless the host speaks Nepali.
    var station = h.language === 'ne' ? stationName() : (st.stationNameEn || stationName());
    return Core.api('/api/host', {
      method: 'POST',
      body: {
        title: nextTrack.title, artist: nextTrack.artist,
        prevTitle: prevTrack ? prevTrack.title : '', prevArtist: prevTrack ? prevTrack.artist : '',
        hostName: h.name, personality: h.personality, language: h.language, custom: h.custom,
        station: station, timezone: tz(),
        useWeather: Boolean(h.useWeather), lat: h.lat, lon: h.lon,
      },
    }).then(function (j) { return j.line || null; })
      .catch(function (e) {
        // Rate limit or AI failure: skip host lines for a while, keep the music going.
        if (e.status === 429 || e.status === 503) hostCooldownUntil = Date.now() + 90000;
        return null;
      });
  }

  function schedulePrefetch(np) {
    if (!np || !started || !dueNext() || np.remaining > 35) return;
    var nextNp = currentNow({ plusMs: np.remaining * 1000 + 500 });
    if (!nextNp || nextNp.key === np.key) return;
    if (prefetch && prefetch.key === nextNp.key) return;
    prefetch = { key: nextNp.key, promise: fetchLine(np.track, nextNp.track) };
  }

  async function maybeHost(np, prevTrack) {
    var h = hostCfg();
    if (!h.enabled || hostBusy) return;
    trackCount++;
    if (trackCount % Math.max(1, h.every) !== 0) return;
    if (Date.now() < hostCooldownUntil) return;
    var p = prefetch && prefetch.key === np.key ? prefetch.promise : fetchLine(prevTrack, np.track);
    prefetch = null;
    var line = await Promise.race([p, sleep(3500).then(function () { return null; })]);
    if (!line || currentKey !== np.key || !started || liveActive) return; // skipped: just keep playing
    speakLine(line);
  }

  async function speakLine(line) {
    var h = hostCfg();
    hostBusy = true;
    var box = $('hostLine');
    box.innerHTML = '<b>' + Core.esc(h.name || 'Host') + ':</b> ' + Core.esc(line);
    show(box, true);
    if (voiceChoice && voiceChoice.notice) { $('hostNotice').textContent = voiceChoice.notice; show($('hostNotice'), true); }
    else show($('hostNotice'), false);
    var spoke = await HostVoice.speak(line, voiceChoice, function () { ducking = true; applyVolume(); });
    ducking = false;
    applyVolume();
    hostBusy = false;
    setTimeout(function () { if (!hostBusy) show(box, false); }, spoke ? 4000 : 9000); // if it couldn't speak, leave the text up a bit longer
  }

  async function pickVoice() {
    var h = hostCfg();
    var lang = h.language === 'ne' ? 'ne' : 'en';
    voices = await HostVoice.getVoices();
    var mine = safeGet('radio_voice_' + lang) || '';
    voiceChoice = HostVoice.pick(voices, lang, mine || (h.voices && h.voices[lang]) || '');
    var sel = $('voiceSelect');
    var list = HostVoice.voicesFor(voices, lang);
    sel.innerHTML = '<option value="">Automatic</option>' + list.map(function (v) {
      return '<option value="' + Core.esc(v.name) + '"' + (v.name === mine ? ' selected' : '') + '>' + Core.esc(v.name + ' (' + v.lang + ')') + '</option>';
    }).join('');
    if (voiceChoice.notice && h.enabled && started) { $('hostNotice').textContent = voiceChoice.notice; show($('hostNotice'), true); }
  }
  $('voiceSelect').addEventListener('change', function (e) {
    var lang = hostCfg().language === 'ne' ? 'ne' : 'en';
    safeSet('radio_voice_' + lang, e.target.value);
    voiceChoice = HostVoice.pick(voices, lang, e.target.value);
  });

  // ---------- upcoming ----------
  function renderUpcoming() {
    var list = RadioSchedule.upcoming(state, Core.now(), 24, 6);
    var ul = $('upnext');
    if (!list.length) { ul.innerHTML = '<li class="muted">Nothing scheduled: free music plays.</li>'; }
    else {
      ul.innerHTML = list.map(function (it) {
        var label = it.label === 'Default playlist' ? 'दियो संगीत · ' + defaultLabel() : it.label;
        return '<li><span>' + Core.esc(label) + '</span><time>' + (it.now ? 'अहिले · On air' : Core.timeInZone(it.startMs, tz(), false)) + '</time></li>';
      }).join('');
    }
    $('tzNote').textContent = 'समय: ' + tz().replace('_', ' ') + ' (' + tz().split('/').pop().replace('_', ' ') + ')';
  }

  // ---------- live broadcast (PeerJS, listener side) ----------
  function setLiveBadge(on) {
    $('liveBadge').classList.toggle('live', on);
    $('liveText').textContent = on ? 'LIVE' : 'OFF AIR';
    cabinet.classList.toggle('is-live', on);
  }

  function startLive(stream) {
    if (liveActive) return;
    liveActive = true;
    setLiveBadge(true);
    audio.pause();
    HostVoice.cancel();
    ducking = false;
    $('npLabel').textContent = 'लाइभ प्रसारण · Live';
    $('npTitle').textContent = 'LIVE: प्रत्यक्ष प्रसारण';
    $('npArtist').textContent = stationName();
    $('npMeta').textContent = 'प्रसारण सकिएपछि तालिका फर्किनेछ।';
    $('barFill').style.width = '100%';
    $('needle').style.left = '50%';
    liveAudio.srcObject = stream;
    applyVolume();
    liveAudio.onplaying = function () { setPlaying(true); setPlayIcon(true); };
    if (started) liveAudio.play().catch(function () { show($('tapNotice'), true); });
    else show($('tapNotice'), true);
  }

  function stopLive() {
    if (!liveActive) return;
    liveActive = false;
    setLiveBadge(false);
    try { liveAudio.pause(); liveAudio.srcObject = null; } catch (e) { /* ignore */ }
    $('npLabel').textContent = 'अहिले बज्दैछ · Now playing';
    setPlaying(false);
    currentKey = null;
    hadPlayed = false;
    setTimeout(tick, 200);
  }

  function onCall(call) {
    call.answer();
    call.on('stream', function (stream) { startLive(stream); });
    call.on('close', stopLive);
    call.on('error', stopLive);
    if (call.peerConnection) {
      call.peerConnection.addEventListener('iceconnectionstatechange', function () {
        var s = call.peerConnection.iceConnectionState;
        if (s === 'failed' || s === 'closed') stopLive();
      });
    }
  }

  function connectLoop() {
    var id = state.settings.liveId;
    if (!window.Peer || !id || liveActive) return;
    if (!peer || peer.destroyed) {
      peer = new Peer({ config: ICE });
      peer.on('call', onCall);
      peer.on('error', function () { /* "peer-unavailable" simply means nobody is live right now */ });
      peer.on('disconnected', function () { try { peer.reconnect(); } catch (e) { /* ignore */ } });
      return; // connect once it has opened (next loop)
    }
    if (!peer.open) return;
    if (liveConn && liveConn.open) return;
    var c = peer.connect(id, { reliable: true });
    liveConn = c;
    var t = setTimeout(function () { if (!c.open) { try { c.close(); } catch (e) { /* ignore */ } } }, 9000);
    c.on('open', function () { clearTimeout(t); });
    c.on('close', function () { clearTimeout(t); stopLive(); });
    c.on('error', function () { clearTimeout(t); });
  }

  // ---------- share / install ----------
  $('shareBtn').addEventListener('click', async function () {
    var data = { title: stationName(), text: stationName() + ' सुन्नुहोस्!', url: location.origin };
    try {
      if (navigator.share) { await navigator.share(data); return; }
      await navigator.clipboard.writeText(data.url);
      setStatus('लिङ्क कपी भयो। (Link copied.)', 'ok', 'share');
      setTimeout(function () { clearStatus('share'); }, 3000);
    } catch (e) { /* share cancelled or clipboard blocked */ }
  });

  var deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    show($('installBtn'), true);
  });
  $('installBtn').addEventListener('click', async function () {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    try { await deferredInstall.userChoice; } catch (e) { /* ignore */ }
    deferredInstall = null;
    show($('installBtn'), false);
  });
  window.addEventListener('appinstalled', function () { show($('installBtn'), false); });
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () { /* optional */ }); });

  // ---------- requests / dedications ----------
  $('rqName').value = safeGet('radio_name') || '';
  $('requestForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var msg = $('rqMsg');
    var btn = $('rqSend');
    btn.disabled = true;
    try {
      await Core.api('/api/messages', { method: 'POST', body: {
        kind: $('rqKind').value, name: $('rqName').value, text: $('rqText').value, website: $('rqWebsite').value } });
      safeSet('radio_name', $('rqName').value.trim());
      $('rqText').value = '';
      msg.className = 'notice ok';
      msg.textContent = 'धन्यवाद! तपाईंको सन्देश पठाइयो। (Thank you, your message was sent.)';
    } catch (err) {
      msg.className = 'notice err';
      msg.textContent = err.message;
    }
    show(msg, true);
    btn.disabled = false;
  });

  // ---------- init ----------
  async function init() {
    setPlayIcon(false);
    $('clock').textContent = '';
    tune('start');
    await Core.syncClock();
    await refreshState(true);
    renderUpcoming();
    tick();
    setInterval(tick, 500);
    setInterval(renderUpcoming, 30000);
    setInterval(function () { refreshState(false).catch(function () {}); }, 60000);
    setInterval(function () { bad.clear(); }, 10 * 60000);
    setInterval(function () { Core.syncClock(); }, 10 * 60000);
    setInterval(connectLoop, 8000);
    setTimeout(connectLoop, 1500);
    pickVoice();
  }
  init();
})();
