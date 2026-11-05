'use strict';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
function today() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- API ---------- */
async function api(path, opts) {
  opts = opts || {};
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? {'Content-Type': 'application/json'} : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin'
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* sin cuerpo */ }
  const isAuthCall = path.startsWith('/api/login') || path.startsWith('/api/register') || path.startsWith('/api/password');
  if (res.status === 401 && !isAuthCall) { if (window.onAuthLost) window.onAuthLost(); throw new Error('auth'); }
  if (!res.ok) { const e = new Error((data && data.error) || 'Error inesperado.'); e.data = data; throw e; }
  return data;
}

/* ---------- tema claro / oscuro ---------- */
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelectorAll('.themebtn').forEach(b => { b.textContent = t === 'dark' ? 'Modo claro' : 'Modo oscuro'; b.setAttribute('aria-pressed', t === 'dark'); });
}
function initTheme() {
  document.querySelectorAll('.themebtn').forEach(b => b.addEventListener('click', () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    lsSet('theme', t); applyTheme(t);
  }));
  applyTheme(document.documentElement.dataset.theme || 'dark');
}

/* ---------- avisos ---------- */
function toast(msg, kind) {
  let box = $('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.setAttribute('role', 'status'); document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = 'toast glass ' + (kind || '');
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => {
    t.style.transition = 'opacity .4s, transform .4s';
    t.style.opacity = '0'; t.style.transform = 'translateY(8px)';
    setTimeout(() => t.remove(), 420);
  }, 3200);
}

/* ---------- animaciones ---------- */
function countUp(el, to, suffix) {
  suffix = suffix || '';
  if (reduceMotion() || typeof to !== 'number') { el.textContent = to + suffix; return; }
  const t0 = performance.now(), dur = 800;
  (function frame(t) {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = Math.round(to * eased) + suffix;
    if (p < 1) requestAnimationFrame(frame);
  })(t0);
}
function stagger(container) {
  Array.from(container.children).forEach((c, i) => { c.style.setProperty('--i', Math.min(i, 12)); });
}
function replay(el, cls) { el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls); }

/* ---------- pestañas con píldora deslizante ---------- */
function makeTabs(root, onChange) {
  const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
  let pill = root.querySelector('.pill');
  if (!pill) { pill = document.createElement('span'); pill.className = 'pill'; pill.setAttribute('aria-hidden', 'true'); root.prepend(pill); }
  const current = () => tabs.find(t => t.getAttribute('aria-selected') === 'true') || tabs[0];
  function place() {
    const b = current();
    if (!b || !b.offsetWidth) return;
    pill.style.width = b.offsetWidth + 'px';
    pill.style.transform = 'translateX(' + b.offsetLeft + 'px)';
  }
  function select(name, silent) {
    const b = tabs.find(t => t.dataset.tab === name) || tabs[0];
    tabs.forEach(t => t.setAttribute('aria-selected', t === b ? 'true' : 'false'));
    place();
    if (!silent && onChange) onChange(b.dataset.tab);
  }
  tabs.forEach(t => t.addEventListener('click', () => select(t.dataset.tab)));
  window.addEventListener('resize', place);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(place);
  requestAnimationFrame(place);
  return { select, refresh: () => requestAnimationFrame(place) };
}

/* ---------- varios ---------- */
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; u.rate = 0.85;
  speechSynthesis.cancel(); speechSynthesis.speak(u);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch (e) { return false; }
}
