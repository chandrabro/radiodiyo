/* Browser text-to-speech for the AI host (speechSynthesis). Exposes window.HostVoice. */
(function () {
  'use strict';

  function supported() { return 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window; }

  /** Voices load asynchronously in some browsers; wait briefly for them. */
  function getVoices() {
    return new Promise(function (resolve) {
      if (!supported()) return resolve([]);
      var synth = window.speechSynthesis;
      var v = synth.getVoices();
      if (v.length) return resolve(v);
      var done = false;
      function finish() { if (!done) { done = true; resolve(synth.getVoices()); } }
      synth.addEventListener('voiceschanged', finish, { once: true });
      setTimeout(finish, 1500);
    });
  }

  function langOf(v) { return String(v.lang || '').toLowerCase().replace('_', '-'); }

  /** Voices that match "en" or "ne". */
  function voicesFor(voices, lang) {
    return voices.filter(function (v) { return langOf(v).split('-')[0] === lang; });
  }

  /**
   * Choose a voice for the language.
   * Returns { voice, lang, notice } where notice explains any fallback ('' when none).
   */
  function pick(voices, lang, preferredName) {
    lang = lang === 'ne' ? 'ne' : 'en';
    var tag = lang === 'ne' ? 'ne-NP' : 'en-US';
    if (!supported()) return { voice: null, lang: tag, notice: 'This browser cannot speak (no speech support). Host lines will be shown as text.' };

    var list = voicesFor(voices, lang);
    var chosen = preferredName && voices.filter(function (v) { return v.name === preferredName; })[0];
    if (chosen && langOf(chosen).split('-')[0] === lang) return { voice: chosen, lang: chosen.lang, notice: '' };
    if (list.length) {
      var best = list.filter(function (v) { return v.default; })[0] || list[0];
      return { voice: best, lang: best.lang, notice: '' };
    }
    if (lang === 'ne') {
      var hi = voicesFor(voices, 'hi')[0];
      if (hi) {
        return { voice: hi, lang: hi.lang, notice: 'No Nepali voice on this device. Using a Hindi voice (' + hi.name + '), which can read Devanagari but may sound different.' };
      }
      return { voice: null, lang: tag, notice: 'No Nepali voice on this device, so the default voice is used and may read Nepali poorly. Try Chrome on Android, or install a Nepali voice in your system settings.' };
    }
    return { voice: null, lang: tag, notice: 'No English voice found, using the device default voice.' };
  }

  /** Speak text. Resolves when finished (or on error / timeout). Calls onStart when audio begins. */
  function speak(text, choice, onStart) {
    return new Promise(function (resolve) {
      if (!supported() || !text) return resolve(false);
      var synth = window.speechSynthesis;
      var u = new SpeechSynthesisUtterance(text);
      if (choice && choice.voice) u.voice = choice.voice;
      u.lang = (choice && choice.lang) || 'en-US';
      u.rate = 1;
      u.pitch = 1;
      var finished = false;
      function end(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(guard);
        resolve(ok);
      }
      // Safety net: some browsers never fire onend when speech is interrupted.
      var guard = setTimeout(function () { try { synth.cancel(); } catch (e) { /* ignore */ } end(false); }, 30000);
      u.onstart = function () { if (onStart) onStart(); };
      u.onend = function () { end(true); };
      u.onerror = function () { end(false); };
      try {
        synth.cancel();
        synth.speak(u);
      } catch (e) { end(false); }
    });
  }

  function cancel() { if (supported()) { try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } } }

  /** Call from a click handler once: mobile browsers only allow speech after a user gesture. */
  function unlock() {
    if (!supported()) return;
    try {
      var u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  window.HostVoice = { supported: supported, getVoices: getVoices, voicesFor: voicesFor, pick: pick, speak: speak, cancel: cancel, unlock: unlock };
})();
