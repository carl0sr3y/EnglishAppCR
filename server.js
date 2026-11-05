'use strict';

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { Pool } = require('pg');
const { parseDeckText, deckToText, unitToText, deckCount, normalize, LEVELS } = require('./parser');

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const INVITE_CODE = (process.env.INVITE_CODE || '').trim();
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const REGISTRATION_CLOSED = (process.env.REGISTRATION || '').trim().toLowerCase() === 'closed';
const INTERVALS = [1, 3, 7, 14, 30]; // días hasta el siguiente repaso, por caja
const MAX_DECKS = 1500;

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
  kind text not null check (kind in ('cards','exercises','lesson','reading','writing')),
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
create table if not exists activities (
  id bigserial primary key,
  user_id int not null references users(id) on delete cascade,
  deck_id int references decks(id) on delete set null,
  deck_title text not null,
  kind text not null check (kind in ('lesson','reading','writing')),
  day date not null,
  text text,
  score_ok int,
  score_total int,
  words int,
  created_at timestamptz not null default now()
);
create index if not exists activities_user_day_idx on activities(user_id, day);
create table if not exists units (
  id serial primary key,
  level text not null check (level in ('A1','A2','B1','B2','C1','C2')),
  number int not null,
  title text not null,
  description text not null default '',
  audience text not null default 'all' check (audience in ('all','general','personal')),
  published boolean not null default false,
  created_at timestamptz not null default now()
);
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
alter table decks add column if not exists unit_id int references units(id) on delete cascade;
create index if not exists decks_unit_idx on decks(unit_id);
alter table users add column if not exists profile text not null default 'general';
alter table users add column if not exists level text;
alter table activities add column if not exists target text;
alter table activities drop constraint if exists activities_kind_check;
alter table activities add constraint activities_kind_check check (kind in ('lesson','reading','writing','speaking'));
alter table units add column if not exists user_id int references users(id) on delete cascade;
do $$
begin
  -- una sola vez: antes "general" significaba "todos"; ahora "todos" es 'all' y 'general' es "solo plan general"
  if not exists (select 1 from pg_constraint where conname = 'units_audience_check' and pg_get_constraintdef(oid) like '%''all''%') then
    alter table units drop constraint if exists units_audience_check;
    update units set audience = 'all' where audience = 'general';
    alter table units add constraint units_audience_check check (audience in ('all','general','personal'));
  end if;
end $$;
alter table units alter column audience set default 'all';
alter table units drop constraint if exists units_level_number_audience_key;
create unique index if not exists units_ident on units (level, number, audience, coalesce(user_id, 0));
alter table decks drop constraint if exists decks_kind_check;
alter table decks add constraint decks_kind_check check (kind in ('cards','exercises','lesson','reading','writing'));
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
      'select u.id, u.username, u.is_admin, u.profile, u.level from sessions s join users u on u.id = s.user_id where s.token_hash = $1 and s.expires_at > now()',
      [sha(token)]
    );
    if (!r.rows[0]) return err(res, 401, 'Tu sesión expiró. Inicia sesión de nuevo.');
    req.user = r.rows[0];
    req.user.personal = req.user.profile === 'personal';
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
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'public', 'icons', 'favicon-32.png')));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: 0,
  setHeaders(res, filePath) {
    // el servicio y el manifiesto siempre deben revisarse, para que las actualizaciones lleguen
    if (/(sw\.js|manifest\.webmanifest)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
  }
}));
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
// Regla de visibilidad: el administrador ve todo. Un usuario ve un mazo si el mazo está publicado y, cuando pertenece
// a una unidad, la unidad está publicada y es general (o el usuario tiene el plan personalizado).
// A = es administrador, P = tiene plan personalizado, ME = id del usuario.
//  - 'all':      la ven todos.
//  - 'general':  solo las cuentas con plan general.
//  - 'personal': solo la cuenta elegida (si la unidad no tiene cuenta elegida, como antes: todas las de plan personalizado).
const AUD = (P, ME) => `(u.audience = 'all' or (u.audience = 'general' and not ${P}::boolean) or (u.audience = 'personal' and ${P}::boolean and (u.user_id is null or u.user_id = ${ME}::int)))`;
const VIS = (A, P, ME) => `(${A}::boolean or (d.published = true and (d.unit_id is null or (u.published = true and ${AUD(P, ME)}))))`;
const UVIS = (A, P, ME) => `(${A}::boolean or (u.published = true and ${AUD(P, ME)}))`;
// "Unidades" de un mazo: tarjetas, ejercicios o preguntas (una lección o una tarea de escritura cuentan como 1).
const UNITS_SQL = `(select count(*)::int from items i where i.deck_id = d.id and (d.kind <> 'reading' or (i.data->'q') is not null))`;
const levelIdx = l => LEVELS.indexOf(l);
const sortUnits = (a, b) => (levelIdx(a.level) - levelIdx(b.level)) || (a.number - b.number) || (a.id - b.id);

async function getAccessibleDeck(deckId, user) {
  const r = await q(
    `select d.id, d.title, d.kind, d.published, d.unit_id from decks d left join units u on u.id = d.unit_id
      where d.id = $1 and ${VIS('$2', '$3', '$4')}`, [deckId, user.is_admin, Boolean(user.personal), user.id]);
  return r.rows[0] || null;
}

app.get('/api/decks', auth, wrap(async (req, res) => {
  const today = isDate(req.query.today) ? req.query.today : new Date().toISOString().slice(0, 10);
  const decks = (await q(
    `select d.id, d.title, d.kind, d.unit_id, ${UNITS_SQL} as total
       from decks d left join units u on u.id = d.unit_id
      where ${VIS('$1', '$2', '$3')}
      order by d.created_at, d.id`, [req.user.is_admin, Boolean(req.user.personal), req.user.id])).rows;
  const counts = (await q(
    `select i.deck_id,
            count(*) filter (where p.item_id is null)::int as fresh,
            count(*) filter (where p.item_id is not null and p.due <= $2::date)::int as due
       from items i left join progress p on p.item_id = i.id and p.user_id = $1
      group by i.deck_id`, [req.user.id, today])).rows;
  const acts = (await q(
    `select deck_id, count(*)::int as times, to_char(max(day), 'YYYY-MM-DD') as last_day,
            bool_or(day = $2::date) as done_today,
            (array_agg(score_ok order by created_at desc))[1] as score_ok,
            (array_agg(score_total order by created_at desc))[1] as score_total
       from activities where user_id = $1 and deck_id is not null and kind <> 'speaking' group by deck_id`, [req.user.id, today])).rows;
  const byDeck = new Map(counts.map(c => [c.deck_id, c]));
  const actBy = new Map(acts.map(a => [a.deck_id, a]));
  res.json({
    ok: true,
    decks: decks.map(d => {
      const c = byDeck.get(d.id) || {};
      const a = actBy.get(d.id) || {};
      return Object.assign({}, d, {
        fresh: c.fresh || 0, due: c.due || 0,
        times: a.times || 0, last_day: a.last_day || null, done_today: Boolean(a.done_today),
        score_ok: a.score_ok == null ? null : a.score_ok, score_total: a.score_total == null ? null : a.score_total
      });
    })
  });
}));

// Ruta de aprendizaje: unidades por nivel, con el avance de este usuario y la siguiente unidad recomendada.
app.get('/api/path', auth, wrap(async (req, res) => {
  const uid = req.user.id, admin = req.user.is_admin, personal = Boolean(req.user.personal);
  const units = (await q(
    `select u.id, u.level, u.number, u.title, u.description, u.audience, u.published
       from units u where ${UVIS('$1', '$2', '$3')}`, [admin, personal, uid])).rows;
  const decks = (await q(
    `select d.id, d.kind, d.unit_id,
            (select count(*)::int from items i where i.deck_id = d.id and (d.kind <> 'reading' or (i.data->'q') is not null)) as total,
            (select count(*)::int from progress p join items i on i.id = p.item_id where p.user_id = $1 and i.deck_id = d.id) as started,
            (select count(*)::int from attempts a where a.user_id = $1 and a.deck_id = d.id) as attempts,
            (select count(*)::int from activities x where x.user_id = $1 and x.deck_id = d.id and x.kind <> 'speaking') as acts
       from decks d join units u on u.id = d.unit_id
      where ${VIS('$2', '$3', '$4')}`, [uid, admin, personal, uid])).rows;
  const isDone = d => d.kind === 'cards' ? (d.total > 0 && d.started >= d.total) : d.kind === 'exercises' ? d.attempts > 0 : d.acts > 0;
  const byUnit = new Map();
  decks.forEach(d => { const e = byUnit.get(d.unit_id) || { total: 0, done: 0 }; e.total++; if (isDone(d)) e.done++; byUnit.set(d.unit_id, e); });
  const full = units.map(u => Object.assign({}, u, byUnit.get(u.id) || { total: 0, done: 0 })).filter(u => u.total > 0 || admin).sort(sortUnits);
  const general = full.filter(u => u.audience !== 'personal');
  const personalUnits = full.filter(u => u.audience === 'personal');
  const levels = LEVELS.map(l => ({ level: l, units: general.filter(u => u.level === l) })).filter(l => l.units.length);

  const incomplete = u => u.total > 0 && u.done < u.total;
  let rec = null;
  if (personal) rec = personalUnits.find(incomplete) || null;
  if (!rec) {
    const pref = req.user.level;
    rec = (pref && general.find(u => u.level === pref && incomplete(u))) || general.find(incomplete) || null;
  }
  res.json({ ok: true, level: req.user.level || null, profile: req.user.profile, levels, personal: personalUnits, recommendedUnitId: rec ? rec.id : null });
}));

app.put('/api/level', auth, wrap(async (req, res) => {
  const level = req.body.level == null || req.body.level === '' ? null : String(req.body.level);
  if (level !== null && LEVELS.indexOf(level) === -1) return err(res, 400, 'Nivel no válido.');
  await q('update users set level = $1 where id = $2', [level, req.user.id]);
  res.json({ ok: true, level });
}));

/* ---------- administración ---------- */
app.get('/api/admin/decks', auth, requireAdmin, wrap(async (req, res) => {
  const decks = (await q(
    `select d.id, d.title, d.kind, d.published, d.unit_id, to_char(d.created_at, 'YYYY-MM-DD') as created,
            ${UNITS_SQL} as total,
            (select count(*)::int from attempts a where a.deck_id = d.id) + (select count(*)::int from activities x where x.deck_id = d.id) as attempts,
            (select count(*)::int from (select a.user_id from attempts a where a.deck_id = d.id
                                        union select x.user_id from activities x where x.deck_id = d.id) u2) as learners
       from decks d order by d.created_at, d.id`)).rows;
  res.json({ ok: true, decks });
}));

// Comprueba que la cuenta elegida para contenido personal existe y tiene plan personalizado. Devuelve el mensaje de error o null.
async function checkPersonalTarget(userId) {
  const id = parseInt(userId, 10);
  const u = id ? (await q('select id, is_admin, profile from users where id = $1', [id])).rows[0] : null;
  if (!u || u.is_admin) return { error: 'Elige un usuario para el contenido personal.' };
  if (u.profile !== 'personal') return { error: 'Ese usuario no tiene plan personalizado. Cámbiaselo en la pestaña Usuarios.' };
  return { id: u.id };
}

app.get('/api/admin/units', auth, requireAdmin, wrap(async (req, res) => {
  const units = (await q(
    `select u.id, u.level, u.number, u.title, u.description, u.audience, u.published, u.user_id,
            (select x.username from users x where x.id = u.user_id) as username,
            (select count(*)::int from decks d where d.unit_id = u.id) as decks
       from units u`)).rows.sort(sortUnits);
  res.json({ ok: true, units });
}));

app.get('/api/admin/units/:id', auth, requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const u = id ? (await q('select id, level, number, title, description, audience, user_id from units where id = $1', [id])).rows[0] : null;
  if (!u) return err(res, 404, 'Unidad no encontrada.');
  const decks = (await q('select id, title, kind from decks where unit_id = $1 order by created_at, id', [id])).rows;
  for (const d of decks) d.items = (await q('select data from items where deck_id = $1 order by position', [d.id])).rows.map(r => r.data);
  res.json({ ok: true, unit: u, text: unitToText(u, decks) });
}));

app.patch('/api/admin/units/:id', auth, requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return err(res, 400, 'Unidad no válida.');
  const sets = [], vals = [];
  const add = (col, v) => { vals.push(v); sets.push(col + ' = $' + vals.length); };
  if (typeof req.body.published === 'boolean') add('published', req.body.published);
  if (['all', 'general', 'personal'].indexOf(req.body.audience) !== -1) {
    add('audience', req.body.audience);
    if (req.body.audience === 'personal') {
      const t = await checkPersonalTarget(req.body.userId);
      if (t.error) return err(res, 400, t.error);
      add('user_id', t.id);
    } else add('user_id', null);
  }
  if (typeof req.body.title === 'string' && req.body.title.trim()) add('title', req.body.title.trim().slice(0, 100));
  if (typeof req.body.description === 'string') add('description', req.body.description.trim().slice(0, 300));
  if (!sets.length) return err(res, 400, 'Nada que cambiar.');
  vals.push(id);
  try {
    const r = await q('update units set ' + sets.join(', ') + ' where id = $' + vals.length + ' returning id, published, audience, user_id', vals);
    if (!r.rows[0]) return err(res, 404, 'Unidad no encontrada.');
    res.json({ ok: true, unit: r.rows[0] });
  } catch (e) {
    if (e.code === '23505') return err(res, 409, 'Ya existe una unidad con ese nivel, número y destinatario.');
    throw e;
  }
}));

app.delete('/api/admin/units/:id', auth, requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const r = id ? await q('delete from units where id = $1 returning id', [id]) : { rows: [] };
  if (!r.rows[0]) return err(res, 404, 'Unidad no encontrada.');
  res.json({ ok: true });
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
  if (text.length > 400000) return err(res, 400, 'El texto es demasiado grande.');

  const parsed = parseDeckText(text);
  if (parsed.errors.length) return res.status(400).json({ ok: false, error: 'Hay líneas que corregir.', errors: parsed.errors.slice(0, 50) });
  if (!parsed.decks.length) return err(res, 400, 'No encontré ningún mazo (@deck, @exercises, @lesson, @reading o @writing) en el texto.');

  const mode = req.body.mode === 'replace' ? 'replace' : 'add';
  // Destino elegido en el panel: 'all' (todos), 'general' (solo plan general) o 'personal' (un usuario con plan personalizado).
  // Si no llega, se usa la línea "audience:" del archivo (o 'all').
  const destAud = ['all', 'general', 'personal'].indexOf(req.body.audience) !== -1 ? req.body.audience : null;
  let destUser = null;
  if (destAud === 'personal') {
    const t = await checkPersonalTarget(req.body.userId);
    if (t.error) return err(res, 400, t.error);
    destUser = t.id;
  }
  const audOf = u => destAud || u.audience || 'all';
  const userOf = u => (audOf(u) === 'personal' ? destUser : null);
  const label = u => u.level + '.' + u.number;
  const summary = parsed.decks.map(d => ({ title: d.title, kind: d.kind, count: deckCount(d), unit: d.unit == null ? null : label(parsed.units[d.unit]) }));

  const existing = [];
  for (const u of parsed.units) {
    const r = await q('select id from units where level = $1 and number = $2 and audience = $3 and coalesce(user_id, 0) = coalesce($4::int, 0)', [u.level, u.number, audOf(u), userOf(u)]);
    existing.push(r.rows[0] ? r.rows[0].id : null);
  }
  const targetName = destUser ? (await q('select username from users where id = $1', [destUser])).rows[0].username : null;
  const unitsSummary = parsed.units.map((u, i) => ({ level: u.level, number: u.number, title: u.title, audience: audOf(u), username: audOf(u) === 'personal' ? targetName : null, exists: existing[i] !== null }));
  if (req.body.dryRun) return res.json({ ok: true, preview: summary, units: unitsSummary, mode });

  const total = (await q('select count(*)::int as c from decks')).rows[0].c;
  if (total + parsed.decks.length > MAX_DECKS) return err(res, 400, 'Llegaste al máximo de ' + MAX_DECKS + ' mazos. Elimina alguno.');

  const published = req.body.published !== false;
  const client = await pool.connect();
  try {
    await client.query('begin');
    const unitIds = [];
    for (let i = 0; i < parsed.units.length; i++) {
      const u = parsed.units[i];
      let id = existing[i];
      if (id !== null) {
        if (mode === 'replace') await client.query('delete from decks where unit_id = $1', [id]);
        await client.query('update units set title = $1, description = case when $2 = \'\' then description else $2 end where id = $3', [u.title, u.description, id]);
      } else {
        const ur = await client.query(
          'insert into units(level, number, title, description, audience, user_id, published) values ($1,$2,$3,$4,$5,$6,$7) returning id',
          [u.level, u.number, u.title, u.description, audOf(u), userOf(u), published]);
        id = ur.rows[0].id;
      }
      unitIds.push(id);
    }
    for (const d of parsed.decks) {
      const unitId = d.unit == null ? null : unitIds[d.unit];
      const dr = await client.query('insert into decks(owner_id, title, kind, published, unit_id) values ($1,$2,$3,$4,$5) returning id',
        [req.user.id, d.title, d.kind, unitId === null ? published : true, unitId]);
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
  res.json({ ok: true, created: summary, units: unitsSummary, published, mode });
}));

app.get('/api/admin/users', auth, requireAdmin, wrap(async (req, res) => {
  const today = isDate(req.query.today) ? req.query.today : new Date().toISOString().slice(0, 10);
  const users = (await q(
    `select u.id, u.username, u.is_admin, u.profile, u.level, to_char(u.created_at, 'YYYY-MM-DD') as created,
            (select count(*)::int from units x where x.user_id = u.id) as personal_units,
            (select to_char(max(a.created_at), 'YYYY-MM-DD') from attempts a where a.user_id = u.id) as last_activity,
            (select count(*)::int from attempts a where a.user_id = u.id and a.retry = false and a.day between $1::date - 6 and $1::date) as week_total,
            (select count(*)::int from attempts a where a.user_id = u.id and a.retry = false and a.correct and a.day between $1::date - 6 and $1::date) as week_ok
       from users u order by u.is_admin desc, u.created_at, u.id`, [today])).rows;
  res.json({ ok: true, users, me: req.user.id });
}));

app.patch('/api/admin/users/:id', auth, requireAdmin, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const profile = req.body.profile;
  if (!id || (profile !== 'general' && profile !== 'personal')) return err(res, 400, 'Datos no válidos.');
  const r = await q('update users set profile = $1 where id = $2 returning id, profile', [profile, id]);
  if (!r.rows[0]) return err(res, 404, 'Usuario no encontrado.');
  res.json({ ok: true, user: r.rows[0] });
}));

app.post('/api/admin/users', auth, requireAdmin, wrap(async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!USERNAME_RE.test(username)) return err(res, 400, USERNAME_MSG);
  if (password.length < 8 || password.length > 200) return err(res, 400, PASSWORD_MSG);
  const { salt, hash } = await hashPassword(password);
  try {
    const r = await q(
      'insert into users(username, username_lower, salt, pass_hash, is_admin, profile) values ($1,$2,$3,$4,$5,$6) returning id, username, is_admin, profile',
      [username, username.toLowerCase(), salt, hash, Boolean(req.body.is_admin), req.body.profile === 'personal' ? 'personal' : 'general']);
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
  const base = { ok: true, kind: deck.kind, deckId: deck.id, title: deck.title };

  if (deck.kind === 'exercises') {
    const rows = (await q('select id, data from items where deck_id = $1 order by position', [deck.id])).rows;
    return res.json(Object.assign(base, { items: shuffle(rows.map(r => ({ id: r.id, q: r.data.q }))) }));
  }

  if (deck.kind === 'lesson') {
    const row = (await q('select data from items where deck_id = $1 order by position limit 1', [deck.id])).rows[0];
    const act = (await q(
      `select count(*)::int as n, coalesce(bool_or(day = $3::date), false) as today
         from activities where user_id = $1 and deck_id = $2 and kind = 'lesson'`, [req.user.id, deck.id, today])).rows[0];
    return res.json(Object.assign(base, { blocks: row ? row.data.blocks : [], read: act.n > 0, readToday: act.today }));
  }

  if (deck.kind === 'reading') {
    const rows = (await q('select id, data from items where deck_id = $1 order by position', [deck.id])).rows;
    const textRow = rows.find(r => r.data.text);
    return res.json(Object.assign(base, {
      paragraphs: textRow ? textRow.data.text : [],
      questions: rows.filter(r => r.data.q).map(r => ({ id: r.id, q: r.data.q, options: shuffle(r.data.options.slice()) }))
    }));
  }

  if (deck.kind === 'writing') {
    const row = (await q('select data from items where deck_id = $1 order by position limit 1', [deck.id])).rows[0];
    const d = row ? row.data : { prompt: [], min: 0, tips: [] };
    const history = (await q(
      `select to_char(day, 'YYYY-MM-DD') as day, words, text from activities
        where user_id = $1 and deck_id = $2 and kind = 'writing' order by created_at desc limit 5`, [req.user.id, deck.id])).rows;
    return res.json(Object.assign(base, { prompt: d.prompt, min: d.min || 0, tips: d.tips || [], history }));
  }

  // tarjetas
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
  res.json(Object.assign(base, { items }));
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
       from items i join decks d on d.id = i.deck_id left join units u on u.id = d.unit_id
      where i.id = $1 and ${VIS('$2', '$3', '$4')}`, [itemId, req.user.is_admin, Boolean(req.user.personal), req.user.id]);
  const item = r.rows[0];
  if (!item) return err(res, 404, 'Elemento no encontrado.');

  // preguntas de lectura (opción múltiple): no usan repetición espaciada
  if (item.kind === 'reading') {
    if (!item.data.q) return err(res, 400, 'Elemento no válido.');
    const choice = String(req.body.choice == null ? '' : req.body.choice).slice(0, 300);
    const expected = item.data.options[item.data.correct];
    const correct = choice === expected;
    await q(
      `insert into attempts(user_id, deck_id, deck_title, kind, prompt, expected, answer, correct, retry, day)
       values ($1,$2,$3,'reading',$4,$5,$6,$7,false,$8)`,
      [req.user.id, item.deck_id, item.title, item.data.q, expected, choice, correct, today]);
    return res.json({ ok: true, correct, expected, example: null, why: item.data.why || '' });
  }
  if (item.kind !== 'cards' && item.kind !== 'exercises') return err(res, 400, 'Este tipo de mazo no tiene respuestas que comprobar.');

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

// Marca como hecha una lección o una lectura.
app.post('/api/complete', auth, wrap(async (req, res) => {
  const deckId = parseInt(req.body.deckId, 10);
  const today = req.body.today;
  const kind = req.body.kind;
  if (!deckId || !isDate(today) || (kind !== 'lesson' && kind !== 'reading')) return err(res, 400, 'Datos no válidos.');
  const deck = await getAccessibleDeck(deckId, req.user);
  if (!deck || deck.kind !== kind) return err(res, 404, 'Mazo no encontrado.');
  let ok = null, total = null;
  if (kind === 'reading') {
    total = parseInt(req.body.total, 10); ok = parseInt(req.body.ok, 10);
    if (!(total >= 1 && total <= 50 && ok >= 0 && ok <= total)) return err(res, 400, 'Resultado no válido.');
  }
  await q(
    `insert into activities(user_id, deck_id, deck_title, kind, day, score_ok, score_total) values ($1,$2,$3,$4,$5,$6,$7)`,
    [req.user.id, deck.id, deck.title, kind, today, ok, total]);
  res.json({ ok: true });
}));

// Guarda un texto escrito (se incluye en el informe para que una IA lo corrija).
app.post('/api/writing', auth, wrap(async (req, res) => {
  const deckId = parseInt(req.body.deckId, 10);
  const today = req.body.today;
  if (!deckId || !isDate(today)) return err(res, 400, 'Datos no válidos.');
  const deck = await getAccessibleDeck(deckId, req.user);
  if (!deck || deck.kind !== 'writing') return err(res, 404, 'Tarea no encontrada.');
  const text = String(req.body.text || '').trim();
  if (text.length > 6000) return err(res, 400, 'El texto es demasiado largo (máximo 6000 caracteres).');
  const words = text.split(/\s+/).filter(Boolean).length;
  const row = (await q('select data from items where deck_id = $1 order by position limit 1', [deck.id])).rows[0];
  const min = row && row.data.min ? row.data.min : 0;
  if (!words) return err(res, 400, 'Escribe tu texto antes de guardar.');
  if (words < min) return err(res, 400, 'Escribe al menos ' + min + ' palabras (llevas ' + words + ').');
  await q(
    `insert into activities(user_id, deck_id, deck_title, kind, day, text, words) values ($1,$2,$3,'writing',$4,$5,$6)`,
    [req.user.id, deck.id, deck.title, today, text, words]);
  res.json({ ok: true, words });
}));

// Guarda un intento de práctica oral (la nota es aproximada: la calcula el navegador al transcribir tu voz).
app.post('/api/speech', auth, wrap(async (req, res) => {
  const today = req.body.today;
  if (!isDate(today)) return err(res, 400, 'Fecha no válida.');
  const target = String(req.body.target || '').trim().slice(0, 400);
  const heard = String(req.body.heard == null ? '' : req.body.heard).trim().slice(0, 400);
  const score = parseInt(req.body.score, 10);
  if (!target || !(score >= 0 && score <= 100)) return err(res, 400, 'Datos no válidos.');
  let deckId = null, title = 'Práctica de voz';
  if (req.body.deckId) {
    const d = await getAccessibleDeck(parseInt(req.body.deckId, 10), req.user);
    if (d) { deckId = d.id; title = d.title; }
  }
  const words = target.split(/\s+/).filter(Boolean).length;
  await q(
    `insert into activities(user_id, deck_id, deck_title, kind, day, text, target, score_ok, score_total, words)
     values ($1,$2,$3,'speaking',$4,$5,$6,$7,100,$8)`,
    [req.user.id, deckId, title, today, heard, target, score, words]);
  res.json({ ok: true });
}));

// Frases para practicar la pronunciación: ejemplos de tarjetas y de lecciones (de la unidad pedida primero).
app.get('/api/phrases', auth, wrap(async (req, res) => {
  const n = Math.max(1, Math.min(10, parseInt(req.query.n, 10) || 5));
  const unitId = parseInt(req.query.unit, 10) || null;
  const rows = (await q(
    `select d.id as deck_id, d.kind, d.unit_id, i.data
       from items i join decks d on d.id = i.deck_id left join units u on u.id = d.unit_id
      where d.kind in ('cards', 'lesson') and ${VIS('$1', '$2', '$3')}`, [req.user.is_admin, Boolean(req.user.personal), req.user.id])).rows;
  const pool = [];
  rows.forEach(r => {
    if (r.kind === 'cards') pool.push({ deckId: r.deck_id, unit: r.unit_id, text: r.data.ex, es: r.data.es });
    else (r.data.blocks || []).forEach(b => { if (b.t === 'ex') pool.push({ deckId: r.deck_id, unit: r.unit_id, text: b.en, es: b.es || '' }); });
  });
  const seen = new Set();
  const list = pool.filter(p => {
    const w = String(p.text || '').trim().split(/\s+/).length;
    const k = String(p.text || '').toLowerCase();
    if (w < 3 || w > 25 || seen.has(k)) return false;
    seen.add(k); return true;
  });
  const scoped = unitId ? list.filter(p => p.unit === unitId) : [];
  const rest = list.filter(p => scoped.indexOf(p) === -1);
  const ordered = shuffle(scoped).concat(shuffle(rest)).slice(0, n);
  res.json({ ok: true, phrases: ordered.map(p => ({ deckId: p.deckId, text: p.text, es: p.es })) });
}));

// Plan del día: qué toca y qué ya hiciste hoy. Con ?unit=ID, el tema nuevo sale de esa unidad.
app.get('/api/today', auth, wrap(async (req, res) => {
  const today = req.query.today;
  if (!isDate(today)) return err(res, 400, 'Fecha no válida.');
  const np = Math.max(0, Math.min(50, parseInt(req.query.new, 10) || 0));
  const unitId = parseInt(req.query.unit, 10) || null;
  const uid = req.user.id, admin = req.user.is_admin, personal = Boolean(req.user.personal);
  const inScope = d => unitId === null || d.unit_id === unitId;

  const decks = (await q(
    `select d.id, d.title, d.kind, d.unit_id from decks d left join units u on u.id = d.unit_id
      where ${VIS('$1', '$2', '$3')} order by d.created_at, d.id`, [admin, personal, uid])).rows;
  const cardRows = (await q(
    `select i.deck_id,
            count(*) filter (where p.item_id is null)::int as fresh,
            count(*) filter (where p.item_id is not null and p.due <= $2::date)::int as due,
            count(*) filter (where p.first_day = $2::date)::int as seen_today
       from items i join decks d on d.id = i.deck_id left join units u on u.id = d.unit_id
       left join progress p on p.item_id = i.id and p.user_id = $1
      where d.kind = 'cards' and ${VIS('$3', '$4', '$5')}
      group by i.deck_id`, [uid, today, admin, personal, uid])).rows;
  const byDeck = new Map(cardRows.map(r => [r.deck_id, r]));
  let due = 0, newAvail = 0, newToday = 0, cardDecks = 0, dueDeck = null, newDeck = null;
  decks.filter(d => d.kind === 'cards').forEach(d => {
    const c = byDeck.get(d.id) || { fresh: 0, due: 0, seen_today: 0 };
    cardDecks++; due += c.due; newToday += c.seen_today;
    const avail = inScope(d) ? Math.min(c.fresh, Math.max(0, np - c.seen_today)) : 0;
    newAvail += avail;
    if (!dueDeck && c.due > 0) dueDeck = d.id;
    if (!newDeck && avail > 0) newDeck = d.id;
  });
  const reviewedToday = (await q(
    `select count(*)::int as n from attempts where user_id = $1 and day = $2::date and kind = 'cards' and retry = false`, [uid, today])).rows[0].n;

  const acts = (await q(
    `select deck_id, to_char(max(day), 'YYYY-MM-DD') as last_day from activities
      where user_id = $1 and deck_id is not null and kind <> 'speaking' group by deck_id`, [uid])).rows;
  const lastBy = new Map(acts.map(a => [a.deck_id, a.last_day]));
  const todayActs = (await q('select kind, deck_title from activities where user_id = $1 and day = $2::date order by created_at desc', [uid, today])).rows;
  const speakingToday = todayActs.filter(a => a.kind === 'speaking').length;

  const pick = kind => {
    const list = decks.filter(d => d.kind === kind && inScope(d));
    const doneT = todayActs.find(a => a.kind === kind);
    let next;
    if (kind === 'lesson') next = list.find(d => !lastBy.has(d.id));
    else next = list.slice().sort((a, b) => (lastBy.get(a.id) || '').localeCompare(lastBy.get(b.id) || ''))[0];
    return { total: list.length, doneToday: Boolean(doneT), todayTitle: doneT ? doneT.deck_title : null, next: next ? { id: next.id, title: next.title } : null };
  };
  const note = (await q('select 1 from notes where user_id = $1 and day = $2::date', [uid, today])).rows.length > 0;

  res.json({
    ok: true,
    cards: { decks: cardDecks, due, newAvail, newToday, reviewedToday, dueDeck, newDeck },
    lesson: pick('lesson'), reading: pick('reading'), writing: pick('writing'), speakingToday, note
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
  '@unit A1.1 Título de la unidad   (opcional: agrupa los mazos que vienen después; niveles A1, A2, B1, B2, C1, C2)',
  'desc: Descripción corta',
  '',
  '@deck Título del mazo',
  'palabra en inglés | traducción | frase de ejemplo que contenga la palabra | alternativa1; alternativa2',
  '',
  '@exercises Título de los ejercicios',
  'Frase con ___ hueco => respuesta1 / respuesta2 | explicación breve',
  '',
  '@lesson Título de la lección',
  '## Subtítulo',
  'Un párrafo de explicación.',
  '- elemento de lista',
  '> English example | traducción',
  '! Nota o consejo destacado',
  '',
  '@reading Título de la lectura',
  'Párrafo del texto (cada línea es un párrafo).',
  '? Pregunta | opción A; opción B*; opción C | explicación breve (la correcta lleva *)',
  '',
  '@writing Título de la tarea',
  'Instrucción de la tarea.',
  'min: 25',
  'tip: Un consejo útil'
].join('\n');

async function buildReport(user, period, date) {
  const start = period === 'week' ? addDays(date, -6) : date;
  const att = (await q(
    `select deck_title, kind, prompt, expected, answer, correct, retry, to_char(day,'YYYY-MM-DD') as day
       from attempts where user_id = $1 and day between $2::date and $3::date order by created_at`, [user.id, start, date])).rows;
  const acts = (await q(
    `select deck_title, kind, text, target, score_ok, score_total, words, to_char(day,'YYYY-MM-DD') as day
       from activities where user_id = $1 and day between $2::date and $3::date order by created_at`, [user.id, start, date])).rows;
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
    lessons: acts.filter(a => a.kind === 'lesson').map(a => ({ deck: a.deck_title, day: a.day })),
    readings: acts.filter(a => a.kind === 'reading').map(a => ({ deck: a.deck_title, day: a.day, correct: a.score_ok, total: a.score_total })),
    writings: acts.filter(a => a.kind === 'writing').map(a => ({ deck: a.deck_title, day: a.day, words: a.words, text: a.text })),
    speaking: acts.filter(a => a.kind === 'speaking').map(a => ({ deck: a.deck_title, day: a.day, target: a.target, heard: a.text, score: a.score_ok })),
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
  L.push('2. Corrige los textos de la sección «Textos que escribí»: devuélveme cada texto corregido y una lista breve de mis errores con su explicación.');
  L.push('3. Si hay una sección de pronunciación, dime qué palabras o sonidos debo practicar y dame consejos concretos para cada una.');
  L.push('4. Propón un plan de repaso para los próximos 7 días, con tiempos realistas.');
  L.push('5. Crea ejercicios, tarjetas, lecciones, lecturas o tareas de escritura nuevas sobre mis puntos débiles, EXACTAMENTE en este formato de texto (lo importaré en mi app), sin explicaciones extra dentro del bloque:');
  L.push('');
  L.push('```');
  L.push(FORMAT_HELP);
  L.push('```');
  L.push('');
  L.push('## Resumen');
  if (!r.summary.attempts) {
    L.push('Sin respuestas registradas en este periodo.');
  } else {
    L.push('- Respuestas (primer intento): ' + r.summary.attempts);
    L.push('- Aciertos: ' + r.summary.correct + ' (' + r.summary.accuracy + ' %)');
    L.push('- Reintentos tras un fallo: ' + r.summary.retries);
  }
  L.push('- Lecciones leídas: ' + r.lessons.length + ' · Lecturas hechas: ' + r.readings.length + ' · Textos escritos: ' + r.writings.length + ' · Prácticas de pronunciación: ' + r.speaking.length);
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
  if (r.lessons.length || r.readings.length) {
    L.push('');
    L.push('## Lecciones y lecturas');
    r.lessons.forEach(l => L.push('- Lección leída (' + l.day + '): ' + l.deck));
    r.readings.forEach(l => L.push('- Lectura (' + l.day + '): ' + l.deck + ' — ' + l.correct + '/' + l.total + ' preguntas bien'));
  }
  L.push('');
  L.push('## Errores (de más a menos frecuentes)');
  if (!r.mistakes.length) L.push('Sin errores registrados.');
  r.mistakes.forEach(m => {
    L.push('- [' + m.deck + '] ' + m.prompt + ' | esperado: "' + m.expected + '" | mis respuestas: ' + (m.answers.length ? m.answers.map(a => '"' + a + '"').join(', ') : '(en blanco / no lo sabía)') + ' | veces: ' + m.times);
  });
  if (r.speaking.length) {
    const avg = Math.round(r.speaking.reduce((t, x) => t + x.score, 0) / r.speaking.length);
    L.push('');
    L.push('## Práctica de pronunciación');
    L.push('Nota aproximada (0-100): mide cuánto de lo que dije entendió el reconocimiento de voz del navegador, no la pronunciación sonido por sonido. Promedio: ' + avg + ' en ' + r.speaking.length + ' intentos. Los más bajos:');
    r.speaking.slice().sort((x, y) => x.score - y.score).slice(0, 12).forEach(x => {
      L.push('- ' + x.score + ' · debía decir: "' + x.target + '" · se entendió: "' + (x.heard || '(nada)') + '"');
    });
  }
  if (r.writings.length) {
    L.push('');
    L.push('## Textos que escribí (corrígelos)');
    r.writings.forEach(w => {
      L.push('### ' + w.deck + ' (' + w.day + ', ' + w.words + ' palabras)');
      L.push('```');
      L.push(w.text);
      L.push('```');
    });
  }
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
