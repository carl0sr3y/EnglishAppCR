'use strict';
// Prueba de humo: arranca el servidor y recorre los flujos principales.
// Uso: DATABASE_URL=postgres://... node test/smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3999;
const BASE = 'http://127.0.0.1:' + PORT;
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FALLA ' + name + (extra ? ' -> ' + JSON.stringify(extra) : '')); }
}
class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, headers) {
    const res = await fetch(BASE + url, {
      method, redirect: 'manual',
      headers: Object.assign({ cookie: this.cookie }, body ? { 'content-type': 'application/json' } : {}, headers || {}),
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch (e) { /* texto */ }
    return { status: res.status, json, text, headers: res.headers };
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn('node', ['server.js'], { env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'test', INVITE_CODE: 'amigos2026' }), stdio: ['ignore', 'pipe', 'pipe'] });
  srv.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + '/health'); if (r.ok) break; } catch (e) { await sleep(150); } }

  const T = '2026-11-04';
  const admin = new Client(), friend = new Client(), anon = new Client();

  console.log('Cuentas');
  let r = await anon.req('GET', '/api/config');
  check('config indica que se requiere invitación', r.json.inviteRequired === true);
  r = await anon.req('GET', '/api/decks');
  check('sin sesión => 401', r.status === 401);
  r = await admin.req('POST', '/api/register', { username: 'carlos', password: 'corta' });
  check('contraseña corta rechazada', r.status === 400);
  r = await admin.req('POST', '/api/register', { username: 'carlos', password: 'password123', invite: 'mal' });
  check('invitación incorrecta rechazada', r.status === 403);
  r = await admin.req('POST', '/api/register', { username: 'carlos', password: 'password123', invite: 'amigos2026' });
  check('registro correcto', r.status === 200 && r.json.user.username === 'carlos');
  check('el primer usuario es admin', r.json.user.is_admin === true);
  check('cookie HttpOnly', /HttpOnly/i.test(r.headers.get('set-cookie') || ''));
  r = await anon.req('POST', '/api/register', { username: 'CARLOS', password: 'password123', invite: 'amigos2026' });
  check('usuario duplicado (sin importar mayúsculas)', r.status === 409);
  r = await anon.req('POST', '/api/login', { username: 'carlos', password: 'incorrecta1' });
  check('login con clave incorrecta => 401', r.status === 401);
  r = await anon.req('POST', '/api/login', { username: 'nadie', password: 'incorrecta1' });
  check('login con usuario inexistente => mismo 401', r.status === 401 && r.json.error === 'Usuario o contraseña incorrectos.');
  r = await friend.req('POST', '/api/register', { username: 'amiga', password: 'password456', invite: 'amigos2026' });
  check('segundo usuario no es admin', r.status === 200 && r.json.user.is_admin === false);
  r = await admin.req('POST', '/api/login', { username: 'Carlos', password: 'password123' });
  check('login ignora mayúsculas del usuario', r.status === 200);
  r = await admin.req('POST', '/api/decks/import', { text: 'x' }, { origin: 'https://sitio-malo.com' });
  check('origen ajeno bloqueado', r.status === 403);

  console.log('Importación');
  r = await admin.req('POST', '/api/decks/import', { text: '@deck Roto\nbrush | pincel\nlinea suelta\n@exercises Vacío\n' });
  check('errores por línea', r.status === 400 && r.json.errors.length >= 3, r.json);
  check('error de frase sin la palabra', (await admin.req('POST', '/api/decks/import', { text: '@deck A\ncat | gato | The dog runs.' })).json.errors[0].msg.includes('cat'));
  const sample = fs.readFileSync(path.join(__dirname, '..', 'ejemplo-semana1.txt'), 'utf8');
  r = await admin.req('POST', '/api/decks/import', { text: sample, dryRun: true });
  check('revisión previa lista 5 mazos', r.status === 200 && r.json.preview.length === 5, r.json);
  r = await admin.req('GET', '/api/decks?today=' + T);
  check('la revisión previa no guardó nada', r.json.decks.length === 0);
  r = await admin.req('POST', '/api/decks/import', { text: sample, shared: true });
  check('importación guardada', r.status === 200 && r.json.created.length === 5, r.json);
  r = await friend.req('POST', '/api/decks/import', { text: '@deck Mío de ella\nbrush | pincel | I use a brush.', shared: true });
  check('usuario normal importa', r.status === 200);

  console.log('Permisos');
  r = await admin.req('GET', '/api/decks?today=' + T);
  const adminDecks = r.json.decks;
  check('admin ve sus 5 mazos y no el privado de la amiga', adminDecks.length === 5, adminDecks.map(d => d.title));
  r = await friend.req('GET', '/api/decks?today=' + T);
  check('la amiga ve 5 compartidos + el suyo', r.json.decks.length === 6, r.json.decks.map(d => d.title));
  const hers = r.json.decks.find(d => d.title === 'Mío de ella');
  check('compartir sólo lo puede hacer el admin (su mazo quedó privado)', hers && hers.shared === false);
  r = await admin.req('GET', '/api/decks/' + hers.id + '/queue?today=' + T + '&new=5');
  check('admin no puede estudiar mazo privado ajeno', r.status === 404);
  const art = adminDecks.find(d => d.title === 'Semana 1 - Arte');
  r = await friend.req('DELETE', '/api/decks/' + art.id);
  check('la amiga no puede borrar un mazo compartido ajeno', r.status === 404);

  console.log('Estudio y repetición espaciada');
  r = await friend.req('POST', '/api/decks/import', { text: '@deck Prueba SRS\nalpha | uno | The alpha is here.\nbeta | dos | The beta is here.\ngamma | tres | The gamma is here.\ndelta | cuatro | The delta is here.' });
  r = await friend.req('GET', '/api/decks?today=' + T);
  const srs = r.json.decks.find(d => d.title === 'Prueba SRS');
  r = await friend.req('GET', '/api/decks/' + srs.id + '/queue?today=' + T + '&new=3');
  check('cola con 3 tarjetas nuevas (límite diario)', r.status === 200 && r.json.items.length === 3 && r.json.items.every(i => i.isNew), r.json);
  check('la cola no filtra la respuesta', !JSON.stringify(r.json).includes('"en"') && !/alpha|beta|gamma/.test(JSON.stringify(r.json.items.map(i => i.es))));
  check('la frase llega con la palabra oculta', r.json.items.every(i => i.masked.includes('_____') && !/alpha|beta|gamma|delta/i.test(i.masked)));
  const byEs = {}; r.json.items.forEach(i => { byEs[i.es] = i; });
  const word = { uno: 'alpha', dos: 'beta', tres: 'gamma', cuatro: 'delta' };
  const A = byEs.uno, B = byEs.dos, C = byEs.tres;

  r = await friend.req('POST', '/api/answer', { itemId: C.id, answer: 'GAMMA.', today: T });
  check('acierto a la primera (mayúsculas y punto tolerados)', r.json.correct === true && r.json.expected === 'gamma');
  r = await friend.req('POST', '/api/answer', { itemId: B.id, answer: 'zzz', today: T });
  check('fallo revela la respuesta', r.json.correct === false && r.json.expected === 'beta');
  r = await friend.req('POST', '/api/answer', { itemId: A.id, answer: '', skipped: true, today: T });
  check('"No lo sé" cuenta como fallo', r.json.correct === false && r.json.expected === 'alpha');
  r = await friend.req('POST', '/api/answer', { itemId: A.id, answer: 'alpha', today: T, retry: true });
  check('reintento correcto', r.json.correct === true);

  r = await friend.req('GET', '/api/decks/' + srs.id + '/queue?today=' + T + '&new=3');
  check('hoy: queda sólo la fallada B (y ninguna nueva extra: límite diario)', r.json.items.length === 1 && r.json.items[0].id === B.id, r.json.items);
  r = await friend.req('GET', '/api/decks/' + srs.id + '/queue?today=2026-11-05&new=0');
  check('mañana: A (reintento), B (fallada) y C (caja 1)', [A.id, B.id, C.id].every(x => r.json.items.map(i => i.id).includes(x)) && r.json.items.length === 3, r.json.items.map(i => i.id));
  r = await friend.req('POST', '/api/answer', { itemId: C.id, answer: 'gamma', today: '2026-11-05' });
  r = await friend.req('GET', '/api/decks/' + srs.id + '/queue?today=2026-11-06&new=0');
  check('C acertada otra vez (caja 2) no vuelve al día siguiente', !r.json.items.map(i => i.id).includes(C.id));
  r = await friend.req('GET', '/api/decks/' + srs.id + '/queue?today=2026-11-07&new=0');
  check('C no vuelve a los 2 días', !r.json.items.map(i => i.id).includes(C.id));
  r = await friend.req('GET', '/api/decks/' + srs.id + '/queue?today=2026-11-08&new=0');
  check('C vuelve a los 3 días (caja 2)', r.json.items.map(i => i.id).includes(C.id));
  r = await friend.req('GET', '/api/decks/' + srs.id + '/queue?today=' + T + '&new=0');
  r = await friend.req('GET', '/api/decks/' + srs.id + '/queue?today=2026-11-06&new=5');
  check('cada día se ofrecen nuevas hasta el límite (la que queda sin empezar)', r.json.items.some(i => i.isNew && i.es === 'cuatro'));

  console.log('Ejercicios');
  const gram = adminDecks.find(d => d.title.startsWith('Semana 1 - Gramática A'));
  r = await friend.req('GET', '/api/decks/' + gram.id + '/queue?today=' + T + '&new=0');
  check('ejercicios: 8 preguntas', r.json.kind === 'exercises' && r.json.items.length === 8);
  r = await friend.req('POST', '/api/answer', { itemId: r.json.items[0].id, answer: 'is', today: T });
  check('ejercicio evaluado en el servidor y con explicación', typeof r.json.correct === 'boolean' && typeof r.json.why === 'string');

  console.log('Estadísticas, nota e informe');
  r = await friend.req('GET', '/api/stats?today=' + T);
  check('racha y respuestas de hoy', r.json.streak >= 1 && r.json.today >= 4, r.json);
  r = await friend.req('PUT', '/api/note', { day: T, text: 'Hoy me confundí con el pasado.' });
  r = await friend.req('GET', '/api/note?day=' + T);
  check('nota guardada', r.json.text.startsWith('Hoy me confundí'));
  r = await friend.req('GET', '/api/report?period=day&date=' + T);
  check('informe diario .md descargable', r.status === 200 && /attachment; filename="informe-amiga-dia-2026-11-04\.md"/.test(r.headers.get('content-disposition')));
  check('el informe incluye instrucciones, formato de importación y errores', r.text.includes('Instrucciones para la IA') && r.text.includes('@exercises') && r.text.includes('Errores'), r.text.slice(0, 400));
  check('el informe incluye la nota', r.text.includes('Hoy me confundí'));
  check('el informe lista el error con lo que escribió', r.text.includes('"zzz"'));
  r = await friend.req('GET', '/api/report?period=week&date=2026-11-06&format=json');
  check('informe semanal JSON válido', r.status === 200 && r.json && r.json.period === 'week' && r.json.summary.attempts >= 4, r.json && r.json.summary);
  r = await friend.req('GET', '/api/report?period=day&date=no-es-fecha');
  check('fecha inválida rechazada', r.status === 400);
  r = await admin.req('GET', '/api/report?period=week&date=' + T);
  check('el informe de otro usuario no mezcla datos', r.text.includes('Sin intentos registrados'));

  console.log('Borrado');
  r = await admin.req('DELETE', '/api/decks/' + art.id);
  check('el admin borra su mazo', r.status === 200);
  r = await friend.req('DELETE', '/api/decks/' + srs.id);
  check('la amiga borra su propio mazo', r.status === 200);
  r = await friend.req('GET', '/api/report?period=week&date=2026-11-08');
  check('los resultados siguen en el informe tras borrar el mazo', r.text.includes('Prueba SRS'));
  r = await admin.req('POST', '/api/logout');
  r = await admin.req('GET', '/api/me');
  check('logout invalida la sesión', r.status === 401);

  srv.kill();
  console.log('\n' + passed + ' correctas, ' + failed + ' fallidas');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
