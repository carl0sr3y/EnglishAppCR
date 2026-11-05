'use strict';
/*
  Práctica de pronunciación.

  Cómo funciona (y sus límites):
  - El navegador transcribe tu voz (reconocimiento de voz del propio navegador) y aquí se compara lo que
    entendió con la frase que debías decir, palabra por palabra.
  - La nota es APROXIMADA: mide cuánto de lo que dijiste fue entendido, no la pronunciación sonido por sonido.
  - Mientras el navegador reconoce tu voz NO se graba tu audio: en muchos teléfonos solo una de las dos cosas
    puede usar el micrófono a la vez, y si compiten el reconocimiento falla. Si quieres escucharte, hay un
    botón aparte («Escucharme»). Ese audio se queda en tu dispositivo; al servidor solo van la frase, lo que
    se entendió y la nota.
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
  const esc_ = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const WHY = {
    'not-allowed': 'Permite el micrófono en tu navegador para poder calificarte.',
    'service-not-allowed': 'Tu navegador no permite el reconocimiento de voz.',
    network: 'El reconocimiento de voz necesita conexión a internet.',
    'audio-capture': 'No pude usar el micrófono. Cierra otras apps que lo estén usando e inténtalo de nuevo.',
    'no-speech': 'No te escuché. Pulsa Grabar, espera un instante y di la frase completa.'
  };

  function mount(el, opts) {
    const target = opts.target;
    el.classList.add('sp');
    el.innerHTML =
      '<div class="row"><button type="button" class="btn ghost sm" data-sp="model">Escuchar modelo</button>' +
      '<button type="button" class="btn sp-rec" data-sp="rec" aria-pressed="false">Grabar</button></div>' +
      '<div class="sp-status small muted" aria-live="polite"></div><div class="sp-result" hidden></div><div class="sp-player"></div>';
    const $s = sel => el.querySelector(sel);
    const recBtn = $s('[data-sp="rec"]'), statusEl = $s('.sp-status'), resultEl = $s('.sp-result'), playerEl = $s('.sp-player');

    // reconocimiento (calificación)
    let rec = null, recording = false, finished = true, alts = [], lastError = '', timer = null, safety = null;
    // grabación para escucharte (sin calificación)
    let pb = null, pbStream = null, pbChunks = [], pbUrl = null, pbOn = false, pbBtn = null;

    const setStatus = t => { statusEl.textContent = t; };
    const idleText = SR
      ? 'Pulsa Grabar, di la frase en voz alta y espera tu nota.'
      : 'Tu navegador no puede calificar tu voz. Para recibir una nota usa Chrome o Edge. Aun así puedes grabarte y escucharte.';
    setStatus(supported() ? idleText : 'Este navegador no permite grabar. Prueba con Chrome o Edge.');
    if (!supported()) recBtn.disabled = true;

    function setRecording(on, btn, labelOn, labelOff) {
      const b = btn || recBtn;
      b.textContent = on ? (labelOn || 'Detener') : (labelOff || 'Grabar');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.classList.toggle('recording', on);
    }

    /* ----- escucharte (solo grabación, sin nota) ----- */
    function releasePb() { if (pbStream) { pbStream.getTracks().forEach(t => t.stop()); pbStream = null; } }
    async function startPlayback(btn) {
      pbBtn = btn;
      try {
        pbStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        pb = new MediaRecorder(pbStream); pbChunks = [];
        pb.ondataavailable = e => { if (e.data && e.data.size) pbChunks.push(e.data); };
        pb.onstop = () => {
          releasePb(); pbOn = false; setRecording(false, pbBtn, 'Detener', pbBtn === recBtn ? 'Grabar' : 'Escucharme');
          if (pbUrl) URL.revokeObjectURL(pbUrl);
          if (pbChunks.length) {
            pbUrl = URL.createObjectURL(new Blob(pbChunks, { type: pb.mimeType || 'audio/webm' }));
            playerEl.innerHTML = '<div class="sp-audio"><span class="small muted">Tu voz</span><audio controls src="' + pbUrl + '"></audio></div>';
            setStatus('Escúchate y compárate con el modelo.');
          }
        };
        pb.start(); pbOn = true; setRecording(true, pbBtn, 'Detener');
        setStatus('Grabando… di la frase y pulsa Detener.');
        timer = setTimeout(stopPlayback, 20000);
      } catch (e) {
        pbOn = false; setRecording(false, pbBtn, 'Detener', pbBtn === recBtn ? 'Grabar' : 'Escucharme');
        setStatus(e && e.name === 'NotAllowedError' ? 'Permite el micrófono en tu navegador para grabarte.' : 'No pude usar el micrófono.');
      }
    }
    function stopPlayback() { clearTimeout(timer); if (pb && pb.state === 'recording') { try { pb.stop(); } catch (e) { /* */ } } }

    /* ----- calificar (reconocimiento de voz) ----- */
    function start() {
      playerEl.innerHTML = ''; resultEl.hidden = true; resultEl.innerHTML = '';
      alts = []; lastError = ''; finished = false;
      setRecording(true); recording = true; setStatus('Escuchando… di la frase.');
      try {
        rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.maxAlternatives = 3; rec.continuous = false;
        rec.onresult = e => {
          const list = [];
          const nAlt = Math.min(3, (e.results[0] && e.results[0].length) || 1);
          for (let a = 0; a < nAlt; a++) {
            let t = '';
            for (let k = 0; k < e.results.length; k++) { const r = e.results[k]; t += ((r[a] || r[0]).transcript || '') + ' '; }
            list.push(t.trim());
          }
          alts = list;
          if (list[0]) setStatus('Te escucho: «' + list[0] + '»');
        };
        rec.onerror = e => { lastError = (e && e.error) || 'error'; };
        rec.onend = () => finalize();
        rec.start();
      } catch (e) { rec = null; recording = false; finished = true; setRecording(false); setStatus('No pude iniciar el reconocimiento de voz.'); return; }
      timer = setTimeout(stop, 15000);
    }
    function stop() {
      if (!recording) return;
      clearTimeout(timer); recording = false; setRecording(false); setStatus('Procesando…');
      if (rec) { try { rec.stop(); } catch (e) { /* */ } }
      safety = setTimeout(finalize, 2500);
    }
    function log(score, said) {
      if (!root.api) return;
      root.api('/api/speech', { method: 'POST', body: { today: root.today(), deckId: opts.deckId || null, target, heard: said, score } })
        .then(() => { if (opts.onScore) opts.onScore(score); })
        .catch(e => { if (e.message !== 'auth' && root.toast) root.toast('No pude guardar la práctica: ' + e.message, 'bad'); });
    }
    function finalize() {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(safety);
      recording = false; setRecording(false);
      resultEl.hidden = false;
      // de las alternativas que propone el navegador se toma la que mejor coincide con la frase
      let best = null;
      alts.filter(Boolean).forEach(t => { const r = scorePronunciation(target, t); if (!best || r.score > best.r.score) best = { heard: t, r }; });
      let html = '';
      if (best) {
        const g = grade(best.r.score);
        html += '<div class="sp-score ' + g.cls + '"><b>' + best.r.score + '</b><span>' + g.text + '</span></div>' +
          '<div class="sp-words">' + best.r.words.map(w => '<span class="w ' + w.state + '">' + esc_(w.w) + '</span>').join(' ') + '</div>' +
          '<div class="small muted">Se entendió: «' + esc_(best.heard) + '»' + (best.r.extra.length ? ' · de más: ' + esc_(best.r.extra.join(' ')) : '') + '</div>';
        log(best.r.score, best.heard);
        setStatus(best.r.score >= 85 ? 'Muy bien. Puedes pasar a la siguiente.' : 'Escucha el modelo y vuelve a intentarlo.');
      } else {
        html += '<div class="msg bad">' + esc_(WHY[lastError] || 'No pude entender lo que dijiste. Acércate al micrófono, habla claro y vuelve a intentarlo.') + '</div>';
        setStatus('');
      }
      html += '<div class="row" style="margin-top:8px"><button type="button" class="btn ghost sm" data-sp="again">Intentar otra vez</button>' +
        (canRecord() ? '<button type="button" class="btn ghost sm" data-sp="mine">Escucharme</button>' : '') + '</div>' +
        '<p class="tiny muted" style="margin:8px 0 0">Nota aproximada: se basa en lo que entiende tu navegador.</p>';
      resultEl.innerHTML = html;
    }

    el.addEventListener('click', e => {
      const b = e.target.closest('[data-sp]'); if (!b || !el.contains(b)) return;
      const act = b.dataset.sp;
      if (act === 'model') { if (root.speak) root.speak(target); }
      else if (act === 'rec') {
        if (SR) { if (recording) stop(); else if (finished) start(); }
        else if (pbOn) stopPlayback(); else startPlayback(recBtn);
      }
      else if (act === 'again') { resultEl.hidden = true; resultEl.innerHTML = ''; playerEl.innerHTML = ''; setStatus(idleText); }
      else if (act === 'mine') { if (pbOn) stopPlayback(); else if (!recording) startPlayback(b); }
    });
    return {
      destroy() {
        clearTimeout(timer); clearTimeout(safety);
        if (pbUrl) URL.revokeObjectURL(pbUrl);
        if (pb && pb.state === 'recording') { try { pb.stop(); } catch (e) { /* */ } }
        releasePb();
        if (rec) { try { rec.abort(); } catch (e) { /* */ } }
      }
    };
  }

  root.Speech = Object.assign({ mount, supported }, api_);
})(typeof window !== 'undefined' ? window : globalThis);
