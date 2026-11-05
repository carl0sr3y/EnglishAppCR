'use strict';
/*
  Práctica de pronunciación.

  Cómo funciona (y sus límites):
  - El navegador transcribe tu voz (reconocimiento de voz del propio navegador) y aquí se compara lo que
    entendió con la frase que debías decir, palabra por palabra.
  - La nota es APROXIMADA: mide cuánto de lo que dijiste fue entendido, no la pronunciación sonido por sonido.
  - Tu audio se guarda solo en tu dispositivo para que te escuches; no se sube al servidor.
    Al servidor solo van la frase, lo que se entendió y la nota.
*/
(function (root) {
  /* ---------- normalización y comparación de palabras (también se usa en las pruebas) ---------- */
  const CONTRACTIONS = [
    [/\bi'm\b/g, 'i am'], [/\byou're\b/g, 'you are'], [/\bwe're\b/g, 'we are'], [/\bthey're\b/g, 'they are'],
    [/\bhe's\b/g, 'he is'], [/\bshe's\b/g, 'she is'], [/\bit's\b/g, 'it is'], [/\bthat's\b/g, 'that is'],
    [/\bwhat's\b/g, 'what is'], [/\bi've\b/g, 'i have'], [/\bi'll\b/g, 'i will'],
    [/\bcan't\b/g, 'can not'], [/\bcannot\b/g, 'can not'], [/\bwon't\b/g, 'will not'], [/\b([a-z]+)n't\b/g, '$1 not']
  ];
  const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  function numWords(n) { return n < 20 ? ONES[n] : TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : ''); }

  function words(s) {
    let t = String(s == null ? '' : s).toLowerCase().replace(/[’‘`´]/g, "'");
    CONTRACTIONS.forEach(([re, to]) => { t = t.replace(re, to); });
    t = t.replace(/[^a-z0-9' ]+/g, ' ').replace(/\b\d{1,2}\b/g, d => numWords(parseInt(d, 10)));
    return t.split(/\s+/).filter(Boolean);
  }

  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  const similarity = (a, b) => 1 - levenshtein(a, b) / Math.max(a.length, b.length);

  // Devuelve la nota (0-100) y el estado de cada palabra de la frase objetivo: ok / close / miss.
  function scorePronunciation(target, heard) {
    const T = words(target), H = words(heard);
    const n = T.length, m = H.length;
    if (!n) return { score: 0, words: [], extra: [], heard: H };
    const weight = (a, b) => (a === b ? 1 : (similarity(a, b) >= 0.75 ? 0.7 : 0));
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = 1; i <= n; i++) {
      for (let j = 1; j <= m; j++) {
        let best = Math.max(dp[i - 1][j], dp[i][j - 1]);
        const w = weight(T[i - 1], H[j - 1]);
        if (w > 0) best = Math.max(best, dp[i - 1][j - 1] + w);
        dp[i][j] = best;
      }
    }
    const state = new Array(n).fill('miss');
    const used = new Array(m).fill(false);
    let i = n, j = m;
    while (i > 0 && j > 0) {
      const w = weight(T[i - 1], H[j - 1]);
      if (w > 0 && dp[i][j] === dp[i - 1][j - 1] + w) { state[i - 1] = w === 1 ? 'ok' : 'close'; used[j - 1] = true; i--; j--; }
      else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
      else j--;
    }
    const extra = H.filter((_, k) => !used[k]);
    const raw = (dp[n][m] - 0.25 * extra.length) / n;
    return { score: Math.max(0, Math.min(100, Math.round(raw * 100))), words: T.map((w, k) => ({ w, state: state[k] })), extra, heard: H };
  }
  function grade(score) {
    if (score >= 85) return { text: 'Muy bien', cls: 'good' };
    if (score >= 60) return { text: 'Casi', cls: 'mid' };
    return { text: 'Repítelo', cls: 'low' };
  }

  const api_ = { words, scorePronunciation, grade, similarity };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api_; return; }

  /* ---------- widget de grabación (solo en el navegador) ---------- */
  const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
  const canRecord = () => Boolean(root.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && root.MediaRecorder);
  const supported = () => Boolean(SR || canRecord());

  function mount(el, opts) {
    const target = opts.target;
    el.classList.add('sp');
    el.innerHTML =
      '<div class="row"><button type="button" class="btn ghost sm" data-sp="model">Escuchar modelo</button>' +
      '<button type="button" class="btn sp-rec" data-sp="rec" aria-pressed="false">Grabar</button></div>' +
      '<div class="sp-status small muted" aria-live="polite"></div><div class="sp-result" hidden></div>';
    const $s = sel => el.querySelector(sel);
    const recBtn = $s('[data-sp="rec"]'), statusEl = $s('.sp-status'), resultEl = $s('.sp-result');
    let rec = null, recorder = null, stream = null, chunks = [], heard = '', recording = false, finished = false;
    let pending = 0, timer = null, safety = null, lastError = '', blobUrl = null, usedRecognition = false;

    const setStatus = t => { statusEl.textContent = t; };
    const idleText = SR ? 'Pulsa Grabar y di la frase en voz alta.' : 'Tu navegador no puede calificar tu voz, pero puedes grabarte y escucharte.';
    setStatus(supported() ? idleText : 'Este navegador no permite grabar. Prueba con Chrome o Edge.');
    if (!supported()) recBtn.disabled = true;

    function releaseStream() { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; } }
    function setRecording(on) {
      recording = on; recBtn.textContent = on ? 'Detener' : 'Grabar'; recBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      recBtn.classList.toggle('recording', on);
    }

    async function start() {
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      resultEl.hidden = true; resultEl.innerHTML = '';
      heard = ''; chunks = []; lastError = ''; finished = false; pending = 0; usedRecognition = false;
      setRecording(true); setStatus('Escuchando… di la frase.');

      if (SR) {
        try {
          rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false;
          rec.onresult = e => { let t = ''; for (let k = 0; k < e.results.length; k++) t += e.results[k][0].transcript + ' '; heard = t.trim(); };
          rec.onerror = e => { lastError = e.error || 'error'; };
          rec.onend = () => { if (recorder && recorder.state === 'recording') { try { recorder.stop(); } catch (x) { /* */ } } oneDone(); };
          rec.start(); pending++; usedRecognition = true;
        } catch (e) { rec = null; }
      }
      if (canRecord()) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          recorder = new MediaRecorder(stream);
          recorder.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
          recorder.onstop = () => { releaseStream(); oneDone(); };
          recorder.start(); pending++;
        } catch (e) { recorder = null; lastError = lastError || (e && e.name === 'NotAllowedError' ? 'not-allowed' : 'audio-capture'); }
      }
      if (pending === 0) { setRecording(false); setStatus(lastError === 'not-allowed' ? 'Permite el micrófono en tu navegador para grabar.' : 'No pude usar el micrófono.'); return; }
      timer = setTimeout(stop, 20000);
    }

    function stop() {
      if (!recording) return;
      clearTimeout(timer); setRecording(false); setStatus('Procesando…');
      if (rec) { try { rec.stop(); } catch (e) { /* */ } }
      if (recorder && recorder.state === 'recording') { try { recorder.stop(); } catch (e) { /* */ } }
      safety = setTimeout(finalize, 2500);
    }
    function oneDone() { pending--; if (pending <= 0) { if (recording) { setRecording(false); } finalize(); } }

    function log(score, said) {
      if (!root.api) return;
      root.api('/api/speech', { method: 'POST', body: { today: root.today(), deckId: opts.deckId || null, target, heard: said, score } })
        .then(() => { if (opts.onScore) opts.onScore(score); })
        .catch(e => { if (e.message !== 'auth' && root.toast) root.toast('No pude guardar la práctica: ' + e.message, 'bad'); });
    }
    const esc_ = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function finalize() {
      if (finished) return; finished = true; clearTimeout(safety); clearTimeout(timer); releaseStream();
      if (recording) setRecording(false);
      resultEl.hidden = false;
      let html = '';
      if (chunks.length) {
        blobUrl = URL.createObjectURL(new Blob(chunks, { type: (recorder && recorder.mimeType) || 'audio/webm' }));
      }
      const audio = blobUrl ? '<div class="sp-audio"><span class="small muted">Tu voz</span><audio controls src="' + blobUrl + '"></audio></div>' : '';
      if (usedRecognition && heard) {
        const r = scorePronunciation(target, heard), g = grade(r.score);
        html += '<div class="sp-score ' + g.cls + '"><b>' + r.score + '</b><span>' + g.text + '</span></div>' +
          '<div class="sp-words">' + r.words.map(w => '<span class="w ' + w.state + '">' + esc_(w.w) + '</span>').join(' ') + '</div>' +
          '<div class="small muted">Se entendió: «' + esc_(heard) + '»' + (r.extra.length ? ' · de más: ' + esc_(r.extra.join(' ')) : '') + '</div>' + audio;
        log(r.score, heard);
        setStatus(r.score >= 85 ? 'Muy bien. Puedes pasar a la siguiente.' : 'Escucha el modelo y vuelve a intentarlo.');
      } else if (usedRecognition && lastError && lastError !== 'no-speech' && lastError !== 'aborted' && !chunks.length) {
        const why = { 'not-allowed': 'Permite el micrófono en tu navegador.', 'service-not-allowed': 'Tu navegador no permite el reconocimiento de voz.', network: 'El reconocimiento de voz necesita conexión a internet.' }[lastError] || 'No pude escucharte. Inténtalo de nuevo.';
        html += '<div class="msg bad">' + esc_(why) + '</div>';
        setStatus('');
      } else if (chunks.length) {
        // sin transcripción: el usuario se evalúa solo
        html += (usedRecognition ? '<div class="small muted">No pude entender la grabación para calificarla.</div>' : '') + audio +
          '<div class="small" style="margin-top:8px">Escúchate y compara con el modelo. ¿Cómo te sonó?</div>' +
          '<div class="row" style="margin-top:6px"><button type="button" class="btn ghost sm" data-self="90">Bien</button><button type="button" class="btn ghost sm" data-self="60">Más o menos</button><button type="button" class="btn ghost sm" data-self="30">Tengo que repetir</button></div>';
        setStatus('');
      } else {
        html += '<div class="msg bad">No te escuché. Acércate al micrófono y habla un poco más alto.</div>';
        setStatus('');
      }
      html += '<div class="row" style="margin-top:8px"><button type="button" class="btn ghost sm" data-sp="again">Intentar otra vez</button></div>' +
        '<p class="tiny muted" style="margin:8px 0 0">Nota aproximada: se basa en lo que entiende tu navegador. Tu audio se queda en tu dispositivo.</p>';
      resultEl.innerHTML = html;
    }

    el.addEventListener('click', e => {
      const b = e.target.closest('[data-sp],[data-self]'); if (!b || !el.contains(b)) return;
      if (b.dataset.sp === 'model') { if (root.speak) root.speak(target); }
      else if (b.dataset.sp === 'rec') { if (recording) stop(); else start(); }
      else if (b.dataset.sp === 'again') { resultEl.hidden = true; resultEl.innerHTML = ''; setStatus(idleText); }
      else if (b.dataset.self) {
        const sc = parseInt(b.dataset.self, 10);
        log(sc, '(autoevaluación)');
        resultEl.querySelectorAll('[data-self]').forEach(x => { x.disabled = true; });
        b.classList.add('chosen'); setStatus('Anotado.');
      }
    });
    return { destroy() { if (blobUrl) URL.revokeObjectURL(blobUrl); releaseStream(); if (rec) { try { rec.abort(); } catch (e) { /* */ } } } };
  }

  root.Speech = Object.assign({ mount, supported }, api_);
})(typeof window !== 'undefined' ? window : globalThis);
