/* Admin "Go live": microphone + library audio mixed with Web Audio, broadcast to listeners over PeerJS (WebRTC). */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }] };
  var LISTENER_WARN = 20;
  var DUCK_GAIN = 0.2;

  var live = false;
  var ctx = null, micStream = null, micGain = null, analyser = null, dest = null;
  var musicEl = null, musicGain = null, musicSrc = null;
  var peer = null;
  var calls = {};            // listener peer id -> MediaConnection
  var muted = false;
  var duckTimer = null, clockTimer = null, startedAt = 0;
  var wakeLock = null;
  var buf = null;
  var beatTimer = null;
  var beatWarned = false;

  function show(el, on) { el.classList.toggle('hidden', !on); }
  function msg(text, kind) {
    var el = $('liveMsg');
    el.className = 'notice ' + (kind || 'info');
    el.textContent = text || '';
    show(el, !!text);
  }
  function setBadge(on) {
    var b = $('adminLiveBadge');
    b.classList.toggle('live', on);
    b.lastElementChild.textContent = on ? 'LIVE' : 'OFF AIR';
  }
  function updateCount() {
    var n = Object.keys(calls).length;
    $('liveCount').textContent = n;
    var w = $('liveWarn');
    if (n > LISTENER_WARN) {
      w.className = 'notice';
      w.textContent = n + ' listeners are connected. Your device uploads a separate audio stream to each one, so above about ' + LISTENER_WARN + ' the audio may stutter or drop. Consider asking some people to listen later.';
      show(w, true);
    } else show(w, false);
  }

  // Tell the server (and so every listener) that the station is live / not live.
  // While live this is repeated every 10 s as a heartbeat: if this tab dies, the show ends by itself.
  function postLive(on) {
    var A = window.Admin;
    return fetch('/api/live', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + Core.getToken() },
      body: JSON.stringify({ on: on, id: A.getState().settings.liveId }),
    }).then(function (r) {
      if (r.status === 401) { A.authFailed(); return false; }
      if (r.status === 501 && on && !beatWarned) {
        beatWarned = true;
        msg('You are LIVE, but the shared live signal needs Supabase. Listeners will find you through the direct connection only, which can be slower and less reliable.', 'info');
      }
      return r.ok;
    }).catch(function () { return false; });
  }

  async function goLive() {
    if (live) return;
    var A = window.Admin;
    if (!window.Peer) return msg('The PeerJS library could not load (check your connection or ad blocker).', 'err');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return msg('This browser cannot access the microphone. Use a current Chrome, Edge, Firefox or Safari over https.', 'err');

    $('liveBtn').disabled = true;
    msg('Asking for microphone permission…', 'info');
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    } catch (e) {
      $('liveBtn').disabled = false;
      var m = e && e.name === 'NotAllowedError' ? 'Microphone permission was denied. Allow it in the browser address bar and try again.'
        : e && e.name === 'NotFoundError' ? 'No microphone was found on this device.'
        : 'Could not open the microphone: ' + (e && e.message || e);
      return msg(m, 'err');
    }

    // The listener page finds you by this id, so it must be saved with the station settings first.
    var liveId = A.ensureLiveId();
    if (A.isSupabase()) {
      msg('Saving station settings so listeners can find the broadcast…', 'info');
      await A.save();
    } else {
      msg('Supabase is not configured: listeners only learn this broadcast id from public/data/state.json. Export the JSON, commit it to GitHub (first time only), then go live.', 'info');
    }

    // Audio graph: mic -> micGain -> dest ; music -> musicGain -> dest (+ speakers so you can hear it)
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    if (ctx.state === 'suspended') await ctx.resume();
    dest = ctx.createMediaStreamDestination();
    var micSrc = ctx.createMediaStreamSource(micStream);
    micGain = ctx.createGain();
    micGain.gain.value = muted ? 0 : 1;
    analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    buf = new Uint8Array(analyser.fftSize);
    micSrc.connect(analyser);          // meter/ducking read the raw mic, even while muted
    micSrc.connect(micGain);
    micGain.connect(dest);             // never routed to your speakers: no feedback

    musicEl = new Audio();
    musicEl.crossOrigin = 'anonymous'; // required to mix; hosts without CORS give silence
    musicEl.preload = 'auto';
    musicSrc = ctx.createMediaElementSource(musicEl);
    musicGain = ctx.createGain();
    musicGain.gain.value = parseFloat($('liveVol').value);
    musicSrc.connect(musicGain);
    musicGain.connect(dest);
    musicGain.connect(ctx.destination);
    musicEl.addEventListener('error', function () { $('liveNow').textContent = 'That track could not be loaded for the broadcast (dead link or the host blocks mixing).'; });
    musicEl.addEventListener('ended', function () { $('liveNow').textContent = 'Track finished.'; });

    // Signalling
    peer = new Peer(liveId, { config: ICE });
    peer.on('open', function () {
      live = true;
      startedAt = Date.now();
      setBadge(true);
      $('liveBtn').disabled = false;
      $('liveBtn').textContent = '⏹ Stop broadcast';
      $('liveBtn').classList.remove('primary');
      $('liveBtn').classList.add('danger');
      show($('liveControls'), true);
      msg('You are LIVE. Keep this tab open and the screen awake.', 'ok');
      requestWake();
      beatWarned = false;
      postLive(true);
      beatTimer = setInterval(function () { postLive(true); }, 10000);
      clockTimer = setInterval(function () {
        var s = Math.floor((Date.now() - startedAt) / 1000);
        $('liveTime').textContent = 'On air ' + Core.fmtDuration(s);
      }, 1000);
      duckTimer = setInterval(meterTick, 60);
    });
    peer.on('connection', function (conn) {
      // A listener announced itself: call them back with the mixed stream.
      conn.on('open', function () {
        if (!live || calls[conn.peer]) return;
        var call = peer.call(conn.peer, dest.stream);
        calls[conn.peer] = call;
        updateCount();
        var drop = function () { delete calls[conn.peer]; updateCount(); };
        call.on('close', drop);
        call.on('error', drop);
        conn.on('close', function () { try { call.close(); } catch (e) { /* ignore */ } drop(); });
        if (call.peerConnection) {
          call.peerConnection.addEventListener('iceconnectionstatechange', function () {
            var st = call.peerConnection.iceConnectionState;
            if (st === 'failed' || st === 'closed' || st === 'disconnected') setTimeout(function () {
              if (calls[conn.peer] === call && call.peerConnection && ['failed', 'closed'].indexOf(call.peerConnection.iceConnectionState) >= 0) { try { call.close(); } catch (e) { /* ignore */ } drop(); }
            }, 5000);
          });
        }
      });
    });
    peer.on('disconnected', function () { if (live) { msg('Lost the signalling server. Reconnecting…', 'info'); try { peer.reconnect(); } catch (e) { /* ignore */ } } });
    peer.on('error', function (err) {
      if (err.type === 'unavailable-id') { msg('This broadcast id is already in use. Is another tab or device already live? Close it first.', 'err'); cleanup(); }
      else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') msg('Network problem with the PeerJS signalling server: ' + err.message, 'err');
      else if (err.type !== 'peer-unavailable') msg('Broadcast error: ' + err.message, 'err');
    });
  }

  function meterTick() {
    if (!analyser) return;
    analyser.getByteTimeDomainData(buf);
    var peak = 0;
    for (var i = 0; i < buf.length; i++) { var v = Math.abs(buf[i] - 128) / 128; if (v > peak) peak = v; }
    $('micMeter').style.width = Math.min(100, peak * 180) + '%';
    // ducking: when you talk (and are not muted), lower the music smoothly
    var target = parseFloat($('liveVol').value);
    if ($('duckOn').checked && !muted && peak > 0.06) target = target * DUCK_GAIN;
    if (musicGain) musicGain.gain.setTargetAtTime(target, ctx.currentTime, 0.12);
  }

  async function requestWake() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not supported or denied */ }
  }
  document.addEventListener('visibilitychange', function () { if (live && document.visibilityState === 'visible') requestWake(); });

  function cleanup() {
    var wasLive = live;
    live = false;
    clearInterval(duckTimer); clearInterval(clockTimer); clearInterval(beatTimer);
    if (wasLive) postLive(false); // listeners go back to the schedule right away
    Object.keys(calls).forEach(function (k) { try { calls[k].close(); } catch (e) { /* ignore */ } });
    calls = {};
    try { if (peer) peer.destroy(); } catch (e) { /* ignore */ }
    peer = null;
    try { if (musicEl) { musicEl.pause(); musicEl.removeAttribute('src'); } } catch (e) { /* ignore */ }
    if (micStream) micStream.getTracks().forEach(function (t) { t.stop(); });
    micStream = null;
    try { if (ctx) ctx.close(); } catch (e) { /* ignore */ }
    ctx = null; analyser = null;
    try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ }
    wakeLock = null;
    setBadge(false);
    updateCount();
    $('liveBtn').disabled = false;
    $('liveBtn').textContent = '🎙️ Go live';
    $('liveBtn').classList.add('primary');
    $('liveBtn').classList.remove('danger');
    $('liveTime').textContent = '';
    $('micMeter').style.width = '0';
    show($('liveControls'), false);
  }

  $('liveBtn').addEventListener('click', function () {
    if (live) {
      if (!confirm('Stop the live broadcast? Listeners will return to the scheduled programme.')) return;
      cleanup();
      msg('Broadcast ended. Listeners are back on the schedule.', 'ok');
    } else goLive();
  });

  $('muteBtn').addEventListener('click', function () {
    muted = !muted;
    if (micGain) micGain.gain.value = muted ? 0 : 1;
    $('muteBtn').textContent = muted ? '🔇 Unmute mic' : '🎤 Mute mic';
    $('muteBtn').classList.toggle('danger', muted);
  });

  $('liveVol').addEventListener('input', function () {
    if (musicGain && ctx) musicGain.gain.setTargetAtTime(parseFloat($('liveVol').value), ctx.currentTime, 0.05);
  });

  $('livePlay').addEventListener('click', async function () {
    if (!live) return msg('Go live first.', 'info');
    var id = $('liveTrack').value;
    var t = window.Admin.getState().library.filter(function (x) { return x.id === id; })[0];
    if (!t) return;
    if (ctx.state === 'suspended') await ctx.resume();
    musicEl.src = t.url;
    try {
      await musicEl.play();
      $('liveNow').textContent = 'Playing into the broadcast: ' + t.title;
    } catch (e) {
      $('liveNow').textContent = 'Could not play "' + t.title + '" (dead link or blocked).';
    }
  });
  $('liveStop').addEventListener('click', function () {
    if (musicEl) { musicEl.pause(); }
    $('liveNow').textContent = 'Music stopped.';
  });

  window.addEventListener('beforeunload', function (e) { if (live) { e.preventDefault(); e.returnValue = ''; } });
})();
