'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { parseDeckText, deckToText, normalize } = require('./parser');

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const INVITE_CODE = (process.env.INVITE_CODE || '').trim();
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const REGISTRATION_CLOSED = (process.env.REGISTRATION || '').trim().toLowerCase() === 'closed';
const INTERVALS = [1, 3, 7, 14, 30]; // días hasta el siguiente repaso, por caja
const MAX_DECKS = 300;

if (!process.env.DATABASE_URL) {
  console.error('Falta la variable de entorno DATABASE_URL.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false,
  max: 10
});
const q = (text, params) => pool.query(text, params);

const SCHEMA = `
create table if not exists users (
  id serial primary key,
  username text not null,
  username_lower text not null unique,
  salt text not null,
  pass_hash text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  token_hash text primary key,
  user_id int not null references users(id) on delete cascade,
  expires_at timestamptz not null
);
create table if not exists decks (
  id serial primary key,
  owner_id int not null references users(id) on delete cascade,
  title text not null,
  kind text not null check (kind in ('cards','exercises')),
  published boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists items (
  id serial primary key,
  deck_id int not null references decks(id) on delete cascade,
  position int not null,
  data jsonb not null
);
create index if not exists items_deck_idx on items(deck_id, position);
create table if not exists progress (
  user_id int not null references users(id) on delete cascade,
  item_id int not null references items(id) on delete cascade,
  box int not null default 0,
  due date not null,
  reps int not null default 0,
  first_day date not null,
  primary key (user_id, item_id)
);
create table if not exists attempts (
  id bigserial primary key,
  user_id int not null references users(id) on delete cascade,
  deck_id int references decks(id) on delete set null,
  deck_title text not null,
  kind text not null,
  prompt text not null,
  expected text not null,
  answer text not null,
  correct boolean not null,
  retry boolean not null default false,
  day date not null,
  created_at timestamptz not null default now()
);
create index if not exists attempts_user_day_idx on attempts(user_id, day);
create table if not exists notes (
  user_id int not null references users(id) on delete cascade,
  day date not null,
  text text not null,
  primary key (user_id, day)
);
`;

// Migración para bases creadas con la primera versión (columna "shared" -> "published").
// Es segura de ejecutar siempre: si ya está migrada, no hace nada.
const MIGRATE = `
alter table decks add column if not exists published boolean not null default false;
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = current_schema() and table_name = 'decks' and column_name = 'shared') then
    execute 'update decks set published = shared';
    execute 'alter table decks drop column shared';
  end if;
end $$;
`;

/* ---------------------------------------------------------------- utilidades */
const err = (res, status, msg, extra) => res.status(status).json(Object.assign({ ok: false, error: msg }, extra || {}));
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

function isDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
function addDays(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function maskSentence(en, ex) {
  const re = new RegExp(en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  return ex.replace(re, '_____');
}
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function hashPassword(password, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (e, key) => {
      if (e) return reject(e);
      resolve({ salt: salt.toString('hex'), hash: key.toString('hex') });
    });
  });
}
async function verifyPassword(password, saltHex, hashHex) {
  const { hash } = await hashPassword(password, saltHex);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(hashHex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  (header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* cookie inválida */ }
    }
  });
  return out;
}
function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', 'sid=' + token + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + 30 * 86400 + (IS_PROD ? '; Secure' : ''));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (IS_PROD ? '; Secure' : ''));
}
async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q("insert into sessions(token_hash, user_id, expires_at) values ($1,$2, now() + interval '30 days')", [sha(token), userId]);
  setSessionCookie(res, token);
}

/* límite de intentos de acceso (en memoria; suficiente para una app pequeña) */
const attemptsMap = new Map();
function limiter(max, windowMs) {
  return (req, res, next) => {
    const key = req.ip + ':' + req.path;
    const now = Date.now();
    let e = attemptsMap.get(key);
    if (!e || e.reset < now) e = { count: 0, reset: now + windowMs };
    e.count++;
    attemptsMap.set(key, e);
    if (e.count > max) return err(res, 429, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attemptsMap) if (v.reset < now) attemptsMap.delete(k);
}, 10 * 60 * 1000).unref();

async function auth(req, res, next) {
  try {
    const token = parseCookies(req.headers.cookie).sid;
    if (!token) return err(res, 401, 'No has iniciado sesión.');
    const r = await q(
      'select u.id, u.username, u.is_admin from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()',
      [sha(token)]
    );
    if (!r.rows[0]) return err(res, 401, 'Tu sesión expiró. Inicia sesión de nuevo.');
    req.user = r.rows[0];
    next();
  } catch (e) { next(e); }
}

/* ---------------------------------------------------------------- app */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '300kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  // protección básica contra peticiones de otros sitios
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin) {
      let host = '';
      try { host = new URL(origin).host; } catch (e) { /* ignorar */ }
      if (host !== req.headers.host) return err(res, 403, 'Origen no permitido.');
    }
  }
  next();
});

app.get(['/admin', '/admin/'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));
app.get('/health', (req, res) => res.json({ ok: true }));

/* ---------- cuentas ---------- */
function requireAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) return err(res, 403, 'Solo para administración.');
  next();
}
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,24}$/;
const USERNAME_MSG = 'Usuario: de 3 a 24 caracteres (letras, números, guion, guion bajo o punto).';
const PASSWORD_MSG = 'La contraseña debe tener al menos 8 caracteres.';

app.get('/api/config', (req, res) => res.json({ inviteRequired: Boolean(INVITE_CODE), registrationClosed: REGISTRATION_CLOSED }));

// Registro público: SIEMPRE crea usuarios normales (nunca administradores).
app.post('/api/register', limiter(10, 15 * 60 * 1000), wrap(async (req, res) => {
  if (REGISTRATION_CLOSED) return err(res, 403, 'El registro está cerrado. Pide a la administración que te cree una cuenta.');
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!USERNAME_RE.test(username)) return err(res, 400, USERNAME_MSG);
  if (password.length < 8 || password.length > 200) return err(res, 400, PASSWORD_MSG);
  if (INVITE_CODE && String(req.body.invite || '').trim() !== INVITE_CODE) return err(res, 403, 'Código de invitación incorrecto.');

  const { salt, hash } = await hashPassword(password);
  let r;
  try {
    r = await q(
      'insert into users(username, username_lower, salt, pass_hash, is_admin) values ($1,$2,$3,$4,false) returning id, username, is_admin',
      [username, username.toLowerCase(), salt, hash]
    );
  } catch (e) {
    if (e.code === '23505') return err(res, 409, 'Ese usuario ya existe. Elige otro.');
    throw e;
  }
  await createSession(res, r.rows[0].id);
  res.json({ ok: true, user: r.rows[0] });
}));

app.post('/api/login', limiter(15, 15 * 60 * 1000), wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const r = await q('select id, username, is_admin, salt, pass_hash from users where username_lower = $1', [username]);
  const u = r.rows[0];
  // se calcula el hash aunque el usuario no exista, para no revelar qué usuarios existen
  const ok = u ? await verifyPassword(password, u.salt, u.pass_hash) : (await hashPassword(password), false);
  if (!ok) return err(res, 401, 'Usuario o contraseña incorrectos.');
  await createSession(res, u.id);
  res.json({ ok: true, user: { id: u.id, username: u.username, is_admin: u.is_admin } });
}));

app.post('/api/logout', wrap(async (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) await q('delete from sessions where token_hash = $1', [sha(token)]);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

app.get('/api/me', auth, (req, res) => res.json({ ok: true, user: req.user }));

app.post('/api/password', auth, limiter(10, 15 * 60 * 1000), wrap(async (req, res) => {
  const current = String(req.body.current || '');
  const next = String(req.body.next || '');
  if (next.length < 8 || next.length > 200) return err(res, 400, PASSWORD_MSG);
  const u = (await q('select salt, pass_hash from users where id = $1', [req.user.id])).rows[0];
  if (!(await verifyPassword(current, u.salt, u.pass_hash))) return err(res, 403, 'La contraseña actual no es correcta.');
  const { salt, hash } = await hashPassword(next);
  await q('update users set salt = $1, pass_hash = $2 where id = $3', [salt, hash, req.user.id]);
  const token = parseCookies(req.headers.cookie).sid;
  await q('delete from sessions where user_id = $1 and token_hash <> $2', [req.user.id, sha(token)]);
  res.json({ ok: true });
}));

/* ---------- mazos (lo que ve el usuario) ---------- */
async function getAccessibleDeck(deckId, user) {
  const r = await q('select id, title, kind, published from decks where id = $1 and (published = true or $2::boolean)', [deckId, user.is_admin]);
  return r.rows[0] || null;
}

app.get('/api/decks', auth, wrap(async (req, res) => {
  const today = isDate(req.query.today) ? req.query.today : new Date().toISOString().slice(0, 10);
  const decks = (await q(
    `select d.id, d.title, d.kind,
            (select count(*)::int from items i where i.deck_id = d.id) as total
       from decks d
      where d.published = true or $1::boolean
      order by d.created_at, d.id`, [req.user.is_admin])).rows;
  const counts = (await q(
    `select i.deck_id,
            count(*) filter (where p.item_id is null)::int as fresh,
            count(*) filter (where p.item_id is not null and p.due <= $2::date)::int as due
       from items i left join progress p on p.item_id = i.id and p.user_id = $1
      group by i.deck_id`, [req.user.id, today])).rows;
  const byDeck = new Map(counts.map(c => [c.deck_id, c]));
  res.json({
    ok: true,
    decks: decks.map(d => Object.assign({}, d, {
      fresh: (byDeck.get(d.id) || {}).fresh || 0,
      due: (byDeck.get(d.id) || {}).due || 0
    }))
  });
}));

/* ---------- administración ---------- */
app.get('/api/admin/decks', auth, requireAdmin, wrap(async (req, res) => {
  const decks = (await q(
    `select d.id, d.title, d.kind, d.published, to_char(d.created_at, 'YYYY-MM-DD') as created,
            (select count(*)::int from items i where i.deck_id = d.id) as total,
            (select count(*)::int from attempts a where a.deck_id = d.id) as attempts,
            (select count(distinct a.user_id)::int from attempts a where a.deck_id = d.id) as learners
       from decks d order by d.created_at, d.id`)).rows;
  res.json({ ok: true, decks });
}));

app.get('/api/admin/decks/:id', auth, requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const d = id ? (await q('select id, title, kind, published from decks where id = $1', [id])).rows[0] : null;
  if (!d) return err(res, 404, 'Mazo no encontrado.');
  const items = (await q('select data from items where deck_id = $1 order by position', [id])).rows.map(r => r.data);
  res.json({ ok: true, deck: d, items, text: deckToText(d, items) });
}));

app.patch('/api/admin/decks/:id', auth, requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || typeof req.body.published !== 'boolean') return err(res, 400, 'Datos no válidos.');
  const r = await q('update decks set published = $1 where id = $2 returning id, published', [req.body.published, id]);
  if (!r.rows[0]) return err(res, 404, 'Mazo no encontrado.');
  res.json({ ok: true, deck: r.rows[0] });
}));

app.delete('/api/admin/decks/:id', auth, requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = id ? await q('delete from decks where id = $1 returning id', [id]) : { rows: [] };
  if (!r.rows[0]) return err(res, 404, 'Mazo no encontrado.');
  res.json({ ok: true });
}));

app.post('/api/admin/import', auth, requireAdmin, wrap(async (req, res) => {
  const text = req.body.text;
  if (typeof text !== 'string' || !text.trim()) return err(res, 400, 'Pega algún texto o sube un archivo.');
  if (text.length > 250000) return err(res, 400, 'El texto es demasiado grande.');

  const parsed = parseDeckText(text);
  if (parsed.errors.length) return res.status(400).json({ ok: false, error: 'Hay líneas que corregir.', errors: parsed.errors.slice(0, 50) });
  if (!parsed.decks.length) return err(res, 400, 'No encontré ningún @deck ni @exercises en el texto.');

  const summary = parsed.decks.map(d => ({ title: d.title, kind: d.kind, count: d.items.length }));
  if (req.body.dryRun) return res.json({ ok: true, preview: summary });

  const total = (await q('select count(*)::int as c from decks')).rows[0].c;
  if (total + parsed.decks.length > MAX_DECKS) return err(res, 400, 'Llegaste al máximo de ' + MAX_DECKS + ' mazos. Elimina alguno.');

  const published = req.body.published !== false;
  const client = await pool.connect();
  try {
    await client.query('begin');
    for (const d of parsed.decks) {
      const dr = await client.query('insert into decks(owner_id, title, kind, published) values ($1,$2,$3,$4) returning id', [req.user.id, d.title, d.kind, published]);
      await client.query(
        `insert into items(deck_id, position, data)
         select $1, ord - 1, elem from jsonb_array_elements($2::jsonb) with ordinality as t(elem, ord)`,
        [dr.rows[0].id, JSON.stringify(d.items)]
      );
    }
    await client.query('commit');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
  res.json({ ok: true, created: summary, published });
}));

app.get('/api/admin/users', auth, requireAdmin, wrap(async (req, res) => {
  const today = isDate(req.query.today) ? req.query.today : new Date().toISOString().slice(0, 10);
  const users = (await q(
    `select u.id, u.username, u.is_admin, to_char(u.created_at, 'YYYY-MM-DD') as created,
            (select to_char(max(a.created_at), 'YYYY-MM-DD') from attempts a where a.user_id = u.id) as last_activity,
            (select count(*)::int from attempts a where a.user_id = u.id and a.retry = false and a.day between $1::date - 6 and $1::date) as week_total,
            (select count(*)::int from attempts a where a.user_id = u.id and a.retry = false and a.correct and a.day between $1::date - 6 and $1::date) as week_ok
       from users u order by u.is_admin desc, u.created_at, u.id`, [today])).rows;
  res.json({ ok: true, users, me: req.user.id });
}));

app.post('/api/admin/users', auth, requireAdmin, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!USERNAME_RE.test(username)) return err(res, 400, USERNAME_MSG);
  if (password.length < 8 || password.length > 200) return err(res, 400, PASSWORD_MSG);
  const { salt, hash } = await hashPassword(password);
  try {
    const r = await q(
      'insert into users(username, username_lower, salt, pass_hash, is_admin) values ($1,$2,$3,$4,$5) returning id, username, is_admin',
      [username, username.toLowerCase(), salt, hash, Boolean(req.body.is_admin)]);
    res.json({ ok: true, user: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return err(res, 409, 'Ese usuario ya existe.');
    throw e;
  }
}));

const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function tempPassword() {
  let out = '';
  for (let i = 0; i < 10; i++) out += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
  return out;
}

app.post('/api/admin/users/:id/reset-password', auth, requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = id ? (await q('select id, username from users where id = $1', [id])).rows[0] : null;
  if (!u) return err(res, 404, 'Usuario no encontrado.');
  const temp = tempPassword();
  const { salt, hash } = await hashPassword(temp);
  await q('update users set salt = $1, pass_hash = $2 where id = $3', [salt, hash, id]);
  await q('delete from sessions where user_id = $1', [id]);
  res.json({ ok: true, username: u.username, password: temp });
}));

app.delete('/api/admin/users/:id', auth, requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return err(res, 400, 'Usuario no válido.');
  if (id === req.user.id) return err(res, 400, 'No puedes eliminar tu propia cuenta de administración.');
  const r = await q('delete from users where id = $1 returning id', [id]);
  if (!r.rows[0]) return err(res, 404, 'Usuario no encontrado.');
  res.json({ ok: true });
}));

app.get('/api/admin/users/:id/report', auth, requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = id ? (await q('select id, username from users where id = $1', [id])).rows[0] : null;
  if (!u) return err(res, 404, 'Usuario no encontrado.');
  await sendReport(req, res, u);
}));

/* ---------- estudio ---------- */
app.get('/api/decks/:id/queue', auth, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const deck = id ? await getAccessibleDeck(id, req.user) : null;
  if (!deck) return err(res, 404, 'Mazo no encontrado.');
  const today = isDate(req.query.today) ? req.query.today : null;
  if (!today) return err(res, 400, 'Falta la fecha de hoy.');
  const newLimit = Math.max(0, Math.min(50, parseInt(req.query.new, 10) || 0));

  if (deck.kind === 'exercises') {
    const rows = (await q('select id, data from items where deck_id = $1 order by position', [deck.id])).rows;
    return res.json({ ok: true, kind: 'exercises', title: deck.title, items: shuffle(rows.map(r => ({ id: r.id, q: r.data.q }))) });
  }

  const due = (await q(
    `select i.id, i.data from items i join progress p on p.item_id = i.id and p.user_id = $1
      where i.deck_id = $2 and p.due <= $3::date`, [req.user.id, deck.id, today])).rows;
  const seenToday = (await q(
    `select count(*)::int as c from progress p join items i on i.id = p.item_id
      where p.user_id = $1 and i.deck_id = $2 and p.first_day = $3::date`, [req.user.id, deck.id, today])).rows[0].c;
  const room = Math.max(0, newLimit - seenToday);
  const fresh = room ? (await q(
    `select i.id, i.data from items i left join progress p on p.item_id = i.id and p.user_id = $1
      where i.deck_id = $2 and p.item_id is null order by i.position limit $3`, [req.user.id, deck.id, room])).rows : [];

  const mk = (r, isNew) => ({ id: r.id, es: r.data.es, masked: maskSentence(r.data.en, r.data.ex), first: r.data.en[0], len: r.data.en.replace(/ /g, '').length, isNew });
  const items = shuffle(due.map(r => mk(r, false)).concat(fresh.map(r => mk(r, true))));
  res.json({ ok: true, kind: 'cards', title: deck.title, items });
}));

app.post('/api/answer', auth, wrap(async (req, res) => {
  const itemId = parseInt(req.body.itemId, 10);
  const today = req.body.today;
  if (!itemId || !isDate(today)) return err(res, 400, 'Datos no válidos.');
  const answer = String(req.body.answer || '').slice(0, 300);
  const skipped = Boolean(req.body.skipped);
  const retry = Boolean(req.body.retry);

  const r = await q(
    `select i.id, i.data, d.id as deck_id, d.title, d.kind
       from items i join decks d on d.id = i.deck_id
      where i.id = $1 and (d.published = true or $2::boolean)`, [itemId, req.user.is_admin]);
  const item = r.rows[0];
  if (!item) return err(res, 404, 'Elemento no encontrado.');

  const accepted = item.kind === 'cards' ? [item.data.en].concat(item.data.alt || []) : item.data.a;
  const correct = !skipped && normalize(answer) !== '' && accepted.some(a => normalize(a) === normalize(answer));
  const prompt = item.kind === 'cards' ? item.data.es + ' — ' + maskSentence(item.data.en, item.data.ex) : item.data.q;

  if (item.kind === 'cards') {
    const cur = (await q('select box from progress where user_id = $1 and item_id = $2', [req.user.id, itemId])).rows[0];
    let box = cur ? cur.box : 0;
    let due;
    if (correct) {
      if (retry) { box = 1; due = addDays(today, 1); }
      else { box = Math.min(box + 1, 5); due = addDays(today, INTERVALS[box - 1]); }
    } else {
      box = 1; due = today;
    }
    await q(
      `insert into progress(user_id, item_id, box, due, reps, first_day) values ($1,$2,$3,$4,1,$5)
       on conflict (user_id, item_id) do update set box = excluded.box, due = excluded.due, reps = progress.reps + 1`,
      [req.user.id, itemId, box, due, today]);
  }

  await q(
    `insert into attempts(user_id, deck_id, deck_title, kind, prompt, expected, answer, correct, retry, day)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [req.user.id, item.deck_id, item.title, item.kind, prompt, accepted[0], skipped ? '' : answer, correct, retry, today]);

  res.json({
    ok: true, correct, expected: accepted[0],
    example: item.kind === 'cards' ? item.data.ex : null,
    why: item.kind === 'exercises' ? (item.data.why || '') : null
  });
}));

/* ---------- notas del día y estadísticas ---------- */
app.get('/api/note', auth, wrap(async (req, res) => {
  if (!isDate(req.query.day)) return err(res, 400, 'Fecha no válida.');
  const r = await q('select text from notes where user_id = $1 and day = $2', [req.user.id, req.query.day]);
  res.json({ ok: true, text: r.rows[0] ? r.rows[0].text : '' });
}));
app.put('/api/note', auth, wrap(async (req, res) => {
  if (!isDate(req.body.day)) return err(res, 400, 'Fecha no válida.');
  const text = String(req.body.text || '').slice(0, 4000);
  if (!text.trim()) await q('delete from notes where user_id = $1 and day = $2', [req.user.id, req.body.day]);
  else await q('insert into notes(user_id, day, text) values ($1,$2,$3) on conflict (user_id, day) do update set text = excluded.text', [req.user.id, req.body.day, text]);
  res.json({ ok: true });
}));

app.get('/api/stats', auth, wrap(async (req, res) => {
  const today = req.query.today;
  if (!isDate(today)) return err(res, 400, 'Fecha no válida.');
  const boxes = (await q('select box, count(*)::int as n from progress where user_id = $1 group by box', [req.user.id])).rows;
  const week = (await q(
    `select count(*)::int as total, count(*) filter (where correct)::int as ok
       from attempts where user_id = $1 and retry = false and day between $2::date - 6 and $2::date`, [req.user.id, today])).rows[0];
  const todayN = (await q('select count(*)::int as n from attempts where user_id = $1 and day = $2', [req.user.id, today])).rows[0].n;
  const days = (await q('select distinct to_char(day, \'YYYY-MM-DD\') as d from attempts where user_id = $1 order by d desc limit 90', [req.user.id])).rows.map(r => r.d).filter(d => d <= today);
  let streak = 0;
  let cursor = days[0] === today ? today : addDays(today, -1);
  for (const d of days) {
    if (d === cursor) { streak++; cursor = addDays(cursor, -1); } else if (d < cursor) break;
  }
  const b = [0, 0, 0, 0, 0, 0];
  boxes.forEach(x => { b[x.box] = x.n; });
  res.json({ ok: true, boxes: b, week, today: todayN, streak });
}));

/* ---------- informe descargable ---------- */
const FORMAT_HELP = [
  '@deck Título del mazo',
  'palabra en inglés | traducción | frase de ejemplo que contenga la palabra | alternativa1; alternativa2',
  '',
  '@exercises Título de los ejercicios',
  'Frase con ___ hueco => respuesta1 / respuesta2 | explicación breve'
].join('\n');

async function buildReport(user, period, date) {
  const start = period === 'week' ? addDays(date, -6) : date;
  const att = (await q(
    `select deck_title, kind, prompt, expected, answer, correct, retry, to_char(day,'YYYY-MM-DD') as day
       from attempts where user_id = $1 and day between $2::date and $3::date order by created_at`, [user.id, start, date])).rows;
  const notes = (await q(
    `select to_char(day,'YYYY-MM-DD') as day, text from notes where user_id = $1 and day between $2::date and $3::date order by day`, [user.id, start, date])).rows;
  const boxRows = (await q('select box, count(*)::int as n from progress where user_id = $1 group by box order by box', [user.id])).rows;

  const first = att.filter(a => !a.retry);
  const total = first.length;
  const ok = first.filter(a => a.correct).length;

  const group = (rows, keyFn) => {
    const m = new Map();
    rows.forEach(a => {
      const k = keyFn(a);
      const e = m.get(k) || { key: k, total: 0, ok: 0 };
      e.total++; if (a.correct) e.ok++;
      m.set(k, e);
    });
    return Array.from(m.values());
  };
  const byDeck = group(first, a => a.deck_title);
  const byDay = group(first, a => a.day).sort((x, y) => (x.key < y.key ? -1 : 1));

  const mistakes = new Map();
  first.filter(a => !a.correct).forEach(a => {
    const k = a.deck_title + '||' + a.prompt + '||' + a.expected;
    const e = mistakes.get(k) || { deck: a.deck_title, prompt: a.prompt, expected: a.expected, times: 0, answers: [] };
    e.times++;
    if (a.answer && !e.answers.includes(a.answer) && e.answers.length < 3) e.answers.push(a.answer);
    mistakes.set(k, e);
  });
  const mistakeList = Array.from(mistakes.values()).sort((x, y) => y.times - x.times);

  return {
    user: user.username, period, start, end: date,
    summary: { attempts: total, correct: ok, accuracy: total ? Math.round(ok * 100 / total) : null, retries: att.length - total },
    byDeck: byDeck.map(d => ({ deck: d.key, attempts: d.total, correct: d.ok, accuracy: Math.round(d.ok * 100 / d.total) })),
    byDay: byDay.map(d => ({ day: d.key, attempts: d.total, correct: d.ok })),
    mistakes: mistakeList,
    boxes: boxRows.reduce((o, r) => { o[r.box] = r.n; return o; }, {}),
    notes
  };
}

function reportToMarkdown(r) {
  const L = [];
  const per = r.period === 'week' ? 'semanal' : 'diario';
  L.push('# Informe de estudio de idiomas (' + per + ')');
  L.push('');
  L.push('- Estudiante: ' + r.user);
  L.push('- Periodo: ' + (r.start === r.end ? r.start : r.start + ' a ' + r.end));
  L.push('');
  L.push('## Instrucciones para la IA');
  L.push('Actúa como tutor de idiomas. Con los datos de este informe:');
  L.push('1. Identifica los 3 a 5 patrones de error más importantes y su causa probable.');
  L.push('2. Propón un plan de repaso para los próximos 7 días, con tiempos realistas.');
  L.push('3. Crea ejercicios y tarjetas nuevas sobre mis puntos débiles, EXACTAMENTE en este formato de texto (lo importaré en mi app), sin explicaciones extra dentro del bloque:');
  L.push('');
  L.push('```');
  L.push(FORMAT_HELP);
  L.push('```');
  L.push('');
  L.push('## Resumen');
  if (!r.summary.attempts) {
    L.push('Sin intentos registrados en este periodo.');
  } else {
    L.push('- Respuestas (primer intento): ' + r.summary.attempts);
    L.push('- Aciertos: ' + r.summary.correct + ' (' + r.summary.accuracy + ' %)');
    L.push('- Reintentos tras un fallo: ' + r.summary.retries);
  }
  const bx = [1, 2, 3, 4, 5].map(b => 'caja ' + b + ': ' + (r.boxes[b] || 0)).join(', ');
  L.push('- Estado de las tarjetas (repetición espaciada): ' + bx + '. La caja 5 significa "dominada".');
  if (r.byDeck.length) {
    L.push('');
    L.push('## Por mazo');
    r.byDeck.forEach(d => L.push('- ' + d.deck + ': ' + d.correct + '/' + d.attempts + ' (' + d.accuracy + ' %)'));
  }
  if (r.period === 'week' && r.byDay.length) {
    L.push('');
    L.push('## Por día');
    r.byDay.forEach(d => L.push('- ' + d.day + ': ' + d.correct + '/' + d.attempts));
  }
  L.push('');
  L.push('## Errores (de más a menos frecuentes)');
  if (!r.mistakes.length) L.push('Sin errores registrados.');
  r.mistakes.forEach(m => {
    L.push('- [' + m.deck + '] ' + m.prompt + ' | esperado: "' + m.expected + '" | mis respuestas: ' + (m.answers.length ? m.answers.map(a => '"' + a + '"').join(', ') : '(en blanco / no lo sabía)') + ' | veces: ' + m.times);
  });
  if (r.notes.length) {
    L.push('');
    L.push('## Mis notas de autoevaluación');
    r.notes.forEach(n => { L.push('### ' + n.day); L.push(n.text); });
  }
  L.push('');
  return L.join('\n');
}

async function sendReport(req, res, target) {
  const period = req.query.period === 'week' ? 'week' : 'day';
  const date = req.query.date;
  if (!isDate(date)) return err(res, 400, 'Fecha no válida.');
  const report = await buildReport(target, period, date);
  const asJson = req.query.format === 'json';
  const safeUser = target.username.replace(/[^A-Za-z0-9_.-]/g, '_');
  const name = 'informe-' + safeUser + '-' + (period === 'week' ? 'semana' : 'dia') + '-' + date + (asJson ? '.json' : '.md');
  res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
  if (asJson) res.type('application/json; charset=utf-8').send(JSON.stringify(report, null, 2));
  else res.type('text/markdown; charset=utf-8').send(reportToMarkdown(report));
}
app.get('/api/report', auth, wrap(async (req, res) => sendReport(req, res, req.user)));

/* ---------- errores ---------- */
app.use('/api', (req, res) => err(res, 404, 'Ruta no encontrada.'));
app.use((e, req, res, next) => { // eslint-disable-line no-unused-vars
  if (e && e.type === 'entity.too.large') return err(res, 413, 'El contenido es demasiado grande.');
  if (e && e.type === 'entity.parse.failed') return err(res, 400, 'Solicitud no válida.');
  console.error(e);
  err(res, 500, 'Error del servidor. Inténtalo de nuevo.');
});

async function ensureAdmin() {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) {
    console.warn('AVISO: define ADMIN_USERNAME y ADMIN_PASSWORD para crear la cuenta de administración.');
    return;
  }
  if (!USERNAME_RE.test(ADMIN_USERNAME) || ADMIN_PASSWORD.length < 8) {
    console.warn('AVISO: ADMIN_USERNAME o ADMIN_PASSWORD no son válidos (usuario 3-24 caracteres, contraseña de al menos 8).');
    return;
  }
  const existing = (await q('select id, is_admin from users where username_lower = $1', [ADMIN_USERNAME.toLowerCase()])).rows[0];
  if (existing) {
    if (!existing.is_admin) await q('update users set is_admin = true where id = $1', [existing.id]);
    return;
  }
  const { salt, hash } = await hashPassword(ADMIN_PASSWORD);
  await q('insert into users(username, username_lower, salt, pass_hash, is_admin) values ($1,$2,$3,$4,true)', [ADMIN_USERNAME, ADMIN_USERNAME.toLowerCase(), salt, hash]);
  console.log('Cuenta de administración creada: ' + ADMIN_USERNAME);
}

(async () => {
  try {
    await q(SCHEMA);
    await q(MIGRATE);
    await ensureAdmin();
    app.listen(PORT, '0.0.0.0', () => console.log('Escuchando en el puerto ' + PORT));
  } catch (e) {
    console.error('No se pudo iniciar la base de datos:', e.message);
    process.exit(1);
  }
})();
