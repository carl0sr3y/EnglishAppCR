'use strict';
// Prueba de humo: arranca el servidor y recorre los flujos principales.
// Uso (con una base de datos de PRUEBAS): DATABASE_URL=postgres://... node test/smoke.js
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3999;
const BASE = 'http://127.0.0.1:' + PORT;
let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ok  ' + name); }
  else { failed++; console.log('  FALLA ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
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
  const srv = spawn('node', ['server.js'], {
    env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'test', INVITE_CODE: 'amigos2026', ADMIN_USERNAME: 'jefe', ADMIN_PASSWORD: 'admin-clave-123' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + '/health'); if (r.ok) break; } catch (e) { await sleep(150); } }

  const T = '2026-11-04';
  const admin = new Client(), amiga = new Client(), carlos = new Client(), anon = new Client();

  console.log('Cuentas y roles');
  let r = await anon.req('GET', '/api/config');
  check('config: invitación requerida y registro abierto', r.json.inviteRequired === true && r.json.registrationClosed === false);
  r = await anon.req('GET', '/api/decks');
  check('sin sesión => 401', r.status === 401);
  r = await admin.req('POST', '/api/login', { username: 'JEFE', password: 'admin-clave-123' });
  check('el administrador (creado desde variables de entorno) puede entrar', r.status === 200 && r.json.user.is_admin === true, r.json);
  r = await anon.req('POST', '/api/register', { username: 'jefe', password: 'password123', invite: 'amigos2026' });
  check('no se puede registrar el nombre del administrador', r.status === 409);
  r = await anon.req('POST', '/api/register', { username: 'amiga', password: 'corta', invite: 'amigos2026' });
  check('contraseña corta rechazada', r.status === 400);
  r = await anon.req('POST', '/api/register', { username: 'amiga', password: 'password123', invite: 'mal' });
  check('invitación incorrecta rechazada', r.status === 403);
  r = await amiga.req('POST', '/api/register', { username: 'amiga', password: 'password123', invite: 'amigos2026' });
  check('registro público crea usuario normal', r.status === 200 && r.json.user.is_admin === false);
  check('cookie HttpOnly', /HttpOnly/i.test(r.headers.get('set-cookie') || ''));
  r = await anon.req('POST', '/api/login', { username: 'amiga', password: 'incorrecta1' });
  check('clave incorrecta => 401', r.status === 401);
  r = await anon.req('POST', '/api/login', { username: 'nadie', password: 'incorrecta1' });
  check('usuario inexistente => mismo mensaje', r.status === 401 && r.json.error === 'Usuario o contraseña incorrectos.');
  r = await admin.req('POST', '/api/admin/import', { text: 'x' }, { origin: 'https://sitio-malo.com' });
  check('origen ajeno bloqueado', r.status === 403);

  console.log('App instalable (PWA)');
  r = await anon.req('GET', '/manifest.webmanifest');
  check('manifiesto servido con tipo correcto y sin caché', r.status === 200 && /manifest\+json|application\/json/.test(r.headers.get('content-type')) && /no-cache/.test(r.headers.get('cache-control') || ''), r.headers.get('content-type'));
  check('manifiesto declara íconos 192, 512 y maskable', r.json && r.json.icons.length === 3 && r.json.icons.some(i => i.purpose === 'maskable') && r.json.display === 'standalone');
  r = await anon.req('GET', '/sw.js');
  check('servicio sin caché del navegador', r.status === 200 && /no-cache/.test(r.headers.get('cache-control') || ''));
  for (const f of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png', '/icons/apple-touch-icon.png', '/icons/icon.svg', '/offline.html', '/favicon.ico']) {
    r = await anon.req('GET', f);
    check('existe ' + f, r.status === 200, r.status);
  }

  console.log('Un usuario normal no puede administrar');
  const sample = fs.readFileSync(path.join(__dirname, '..', 'ejemplo-semana1.txt'), 'utf8').replace(/^@unit .*\n(audience:.*\n)?(desc:.*\n)?/m, '');
  r = await amiga.req('POST', '/api/admin/import', { text: sample });
  check('no puede importar mazos', r.status === 403);
  r = await amiga.req('GET', '/api/admin/users');
  check('no puede ver usuarios', r.status === 403);
  r = await amiga.req('GET', '/api/admin/decks');
  check('no puede ver el panel de mazos', r.status === 403);
  r = await amiga.req('POST', '/api/admin/users', { username: 'intruso', password: 'password123' });
  check('no puede crear usuarios', r.status === 403);
  r = await amiga.req('DELETE', '/api/admin/decks/1');
  check('no puede borrar mazos', r.status === 403);
  r = await anon.req('GET', '/admin');
  check('la página /admin se sirve (la protección está en la API)', r.status === 200 && r.text.includes('Administración'));

  console.log('Importación (solo administración)');
  r = await admin.req('POST', '/api/admin/import', { text: '@deck Roto\nbrush | pincel\nlinea suelta\n@exercises Vacío\n' });
  check('errores por línea', r.status === 400 && r.json.errors.length >= 3, r.json);
  r = await admin.req('POST', '/api/admin/import', { text: '@deck A\ncat | gato | The dog runs.' });
  check('error: la frase no contiene la palabra', r.json.errors[0].msg.includes('cat'));
  r = await admin.req('POST', '/api/admin/import', { text: sample, dryRun: true });
  check('revisión previa lista 11 mazos de 5 tipos', r.status === 200 && r.json.preview.length === 11 && new Set(r.json.preview.map(p => p.kind)).size === 5, r.json);
  r = await admin.req('GET', '/api/admin/decks');
  check('la revisión previa no guardó nada', r.json.decks.length === 0);
  r = await admin.req('POST', '/api/admin/import', { text: sample, published: false });
  check('importación guardada como borrador', r.status === 200 && r.json.created.length === 11 && r.json.published === false, r.json);
  r = await amiga.req('GET', '/api/decks?today=' + T);
  check('los borradores no los ve el usuario', r.json.decks.length === 0, r.json.decks.map(d => d.title));
  r = await admin.req('GET', '/api/admin/decks');
  const all = r.json.decks;
  check('el admin ve 11 mazos (todos borradores)', all.length === 11 && all.every(d => d.published === false));
  for (const d of all) await admin.req('PATCH', '/api/admin/decks/' + d.id, { published: true });
  r = await amiga.req('GET', '/api/decks?today=' + T);
  check('al publicar, el usuario ve los 11 mazos en orden de creación', r.json.decks.length === 11 && r.json.decks[0].title === 'Semana 1 - Lección: el verbo to be', r.json.decks.map(d => d.title));
  r = await admin.req('PATCH', '/api/admin/decks/' + all[4].id, { published: false });
  r = await amiga.req('GET', '/api/decks?today=' + T);
  check('despublicar oculta el mazo', r.json.decks.length === 10);
  r = await amiga.req('GET', '/api/decks/' + all[4].id + '/queue?today=' + T + '&new=3');
  check('un mazo oculto no se puede estudiar por id', r.status === 404);
  await admin.req('PATCH', '/api/admin/decks/' + all[4].id, { published: true });
  const arte = all.find(d => d.title === 'Semana 1 - Arte');
  r = await admin.req('GET', '/api/admin/decks/' + arte.id);
  check('vista previa del mazo y exportación a texto', r.json.items.length === 10 && r.json.text.startsWith('@deck Semana 1 - Arte') && r.json.text.includes('watercolor | acuarela'));
  let roundtrip = true;
  for (const d of all) {
    const g = await admin.req('GET', '/api/admin/decks/' + d.id);
    const back = await admin.req('POST', '/api/admin/import', { text: g.json.text, dryRun: true });
    if (back.status !== 200 || back.json.preview[0].count !== d.total || back.json.preview[0].kind !== d.kind) { roundtrip = false; console.log('   no coincide:', d.title, back.json); }
  }
  check('el texto exportado de CADA mazo (5 tipos) se puede volver a importar', roundtrip);

  console.log('Usuarios (panel de administración)');
  r = await admin.req('POST', '/api/admin/users', { username: 'carlos', password: 'password-carlos' });
  check('el admin crea un usuario normal sin código', r.status === 200 && r.json.user.is_admin === false);
  r = await admin.req('POST', '/api/admin/users', { username: 'CARLOS', password: 'password-carlos' });
  check('usuario duplicado rechazado', r.status === 409);
  r = await carlos.req('POST', '/api/login', { username: 'carlos', password: 'password-carlos' });
  check('el usuario creado entra', r.status === 200 && r.json.user.is_admin === false);
  r = await carlos.req('GET', '/api/admin/users');
  check('y no tiene permisos de admin', r.status === 403);

  console.log('Estudio y repetición espaciada (como usuario normal)');
  r = await admin.req('POST', '/api/admin/import', { text: '@deck Prueba SRS\nalpha | uno | The alpha is here.\nbeta | dos | The beta is here.\ngamma | tres | The gamma is here.\ndelta | cuatro | The delta is here.' });
  r = await carlos.req('GET', '/api/decks?today=' + T);
  const srs = r.json.decks.find(d => d.title === 'Prueba SRS');
  r = await carlos.req('GET', '/api/decks/' + srs.id + '/queue?today=' + T + '&new=3');
  check('cola con 3 tarjetas nuevas (límite diario)', r.status === 200 && r.json.items.length === 3 && r.json.items.every(i => i.isNew), r.json);
  check('la cola no filtra la respuesta', !/alpha|beta|gamma|delta/i.test(JSON.stringify(r.json)));
  const byEs = {}; r.json.items.forEach(i => { byEs[i.es] = i; });
  const A = byEs.uno, B = byEs.dos, C = byEs.tres;
  r = await carlos.req('POST', '/api/answer', { itemId: C.id, answer: 'GAMMA.', today: T });
  check('acierto a la primera (mayúsculas y punto tolerados)', r.json.correct === true && r.json.expected === 'gamma');
  r = await carlos.req('POST', '/api/answer', { itemId: B.id, answer: 'zzz', today: T });
  check('fallo revela la respuesta', r.json.correct === false && r.json.expected === 'beta');
  r = await carlos.req('POST', '/api/answer', { itemId: A.id, answer: '', skipped: true, today: T });
  check('"No lo sé" cuenta como fallo', r.json.correct === false && r.json.expected === 'alpha');
  r = await carlos.req('POST', '/api/answer', { itemId: A.id, answer: 'alpha', today: T, retry: true });
  check('reintento correcto', r.json.correct === true);
  r = await carlos.req('GET', '/api/decks/' + srs.id + '/queue?today=' + T + '&new=3');
  check('hoy: queda sólo la fallada B', r.json.items.length === 1 && r.json.items[0].id === B.id, r.json.items);
  r = await carlos.req('GET', '/api/decks/' + srs.id + '/queue?today=2026-11-05&new=0');
  check('mañana: A, B y C', [A.id, B.id, C.id].every(x => r.json.items.map(i => i.id).includes(x)) && r.json.items.length === 3);
  await carlos.req('POST', '/api/answer', { itemId: C.id, answer: 'gamma', today: '2026-11-05' });
  r = await carlos.req('GET', '/api/decks/' + srs.id + '/queue?today=2026-11-07&new=0');
  check('C (caja 2) no vuelve a los 2 días', !r.json.items.map(i => i.id).includes(C.id));
  r = await carlos.req('GET', '/api/decks/' + srs.id + '/queue?today=2026-11-08&new=0');
  check('C vuelve a los 3 días', r.json.items.map(i => i.id).includes(C.id));
  const gram = all.find(d => d.title.startsWith('Semana 1 - Gramática A'));
  r = await carlos.req('GET', '/api/decks/' + gram.id + '/queue?today=' + T + '&new=0');
  check('ejercicios: 8 preguntas', r.json.kind === 'exercises' && r.json.items.length === 8);
  r = await carlos.req('POST', '/api/answer', { itemId: r.json.items[0].id, answer: 'is', today: T });
  check('ejercicio evaluado en el servidor, con explicación', typeof r.json.correct === 'boolean' && typeof r.json.why === 'string');

  console.log('Lecciones, lecturas, escritura y plan del día');
  const L1 = all.find(d => d.title === 'Semana 1 - Lección: presente continuo');
  const RD = all.find(d => d.kind === 'reading');
  const W1 = all.find(d => d.title.startsWith('Semana 1 - Escritura 1'));
  r = await carlos.req('GET', '/api/today?today=' + T + '&new=5');
  check('plan del día: lección, lectura y escritura pendientes y sin nota', r.json.lesson.next && !r.json.lesson.doneToday && !r.json.reading.doneToday && !r.json.writing.doneToday && r.json.note === false, r.json);
  check('plan del día: cuenta tarjetas por repasar y nuevas', r.json.cards.decks >= 3 && r.json.cards.reviewedToday >= 1, r.json.cards);
  r = await carlos.req('GET', '/api/decks/' + L1.id + '/queue?today=' + T + '&new=0');
  check('lección: devuelve los bloques y aún no está leída', r.json.kind === 'lesson' && r.json.blocks.length > 5 && r.json.read === false);
  r = await carlos.req('POST', '/api/complete', { deckId: L1.id, kind: 'lesson', today: T });
  check('marcar lección como leída', r.status === 200);
  r = await carlos.req('POST', '/api/complete', { deckId: RD.id, kind: 'lesson', today: T });
  check('no se puede marcar una lectura como si fuera lección', r.status === 404);
  r = await carlos.req('GET', '/api/decks/' + L1.id + '/queue?today=' + T + '&new=0');
  check('la lección queda leída hoy', r.json.read === true && r.json.readToday === true);

  r = await carlos.req('GET', '/api/decks/' + RD.id + '/queue?today=' + T + '&new=0');
  check('lectura: 3 párrafos y 6 preguntas con opciones', r.json.paragraphs.length === 3 && r.json.questions.length === 6 && r.json.questions.every(x => x.options.length >= 2), r.json.questions && r.json.questions.length);
  check('la lectura no revela la opción correcta', !JSON.stringify(r.json).includes('"correct"'));
  const qs = r.json.questions;
  const meta = (await admin.req('GET', '/api/admin/decks/' + RD.id)).json.items.filter(i => i.q);
  let okCount = 0;
  for (let i = 0; i < qs.length; i++) {
    const m = meta.find(x => x.q === qs[i].q); const good = m.options[m.correct];
    const choice = i === 0 ? qs[i].options.find(o => o !== good) : good;
    const a = await carlos.req('POST', '/api/answer', { itemId: qs[i].id, choice, today: T });
    if (a.json.correct) okCount++;
    if (i === 0) check('un fallo en lectura revela la correcta y la explicación', a.json.correct === false && a.json.expected === good);
  }
  check('lectura calificada en el servidor: 5 de 6', okCount === 5);
  r = await carlos.req('POST', '/api/complete', { deckId: RD.id, kind: 'reading', ok: 9, total: 6, today: T });
  check('resultado de lectura imposible rechazado', r.status === 400);
  r = await carlos.req('POST', '/api/complete', { deckId: RD.id, kind: 'reading', ok: 5, total: 6, today: T });
  check('lectura completada con su resultado', r.status === 200);

  r = await carlos.req('GET', '/api/decks/' + W1.id + '/queue?today=' + T + '&new=0');
  check('escritura: consigna, mínimo y consejos', r.json.kind === 'writing' && r.json.min === 25 && r.json.tips.length === 2 && r.json.history.length === 0, r.json);
  r = await carlos.req('POST', '/api/writing', { deckId: W1.id, today: T, text: 'I am painting.' });
  check('texto demasiado corto rechazado, con el mínimo', r.status === 400 && /al menos 25/.test(r.json.error), r.json);
  r = await carlos.req('POST', '/api/writing', { deckId: W1.id, today: T, text: '   ' });
  check('texto vacío rechazado', r.status === 400);
  const essay = 'I am painting a portrait of my friend now. She is sitting near the window and she is smiling. I am also coding a small website for my gallery. My brother is helping me with the design this week.';
  r = await carlos.req('POST', '/api/writing', { deckId: W1.id, today: T, text: essay });
  check('texto guardado con su cantidad de palabras', r.status === 200 && r.json.words === essay.split(/\s+/).length, r.json);
  r = await carlos.req('GET', '/api/decks/' + W1.id + '/queue?today=' + T + '&new=0');
  check('el texto aparece en el historial de la tarea', r.json.history.length === 1 && r.json.history[0].text === essay);
  r = await carlos.req('POST', '/api/writing', { deckId: arte.id, today: T, text: essay });
  check('no se puede escribir en un mazo que no es de escritura', r.status === 404);
  r = await carlos.req('GET', '/api/decks?today=' + T);
  const dl = r.json.decks.find(d => d.id === L1.id), dr = r.json.decks.find(d => d.id === RD.id), dw = r.json.decks.find(d => d.id === W1.id);
  check('la lista de mazos marca lo hecho hoy (lección, lectura con 5/6, escritura)', dl.done_today && dr.done_today && dr.score_ok === 5 && dr.score_total === 6 && dr.total === 6 && dw.done_today && dw.times === 1, { dl, dr, dw });
  r = await carlos.req('GET', '/api/today?today=' + T + '&new=5');
  check('plan del día: lección, lectura y escritura hechas hoy', r.json.lesson.doneToday && r.json.reading.doneToday && r.json.writing.doneToday, r.json);
  check('plan del día: la siguiente lección es otra distinta', r.json.lesson.next && r.json.lesson.next.id !== L1.id, r.json.lesson);

  console.log('Estadísticas, nota e informes');
  r = await carlos.req('GET', '/api/stats?today=' + T);
  check('racha y respuestas de hoy', r.json.streak >= 1 && r.json.today >= 4, r.json);
  await carlos.req('PUT', '/api/note', { day: T, text: 'Hoy me confundí con el pasado.' });
  r = await carlos.req('GET', '/api/report?period=day&date=' + T);
  check('informe diario .md descargable', r.status === 200 && /attachment; filename="informe-carlos-dia-2026-11-04\.md"/.test(r.headers.get('content-disposition')));
  check('incluye instrucciones, formato (5 tipos), errores y nota', ['Instrucciones para la IA', '@exercises', '@lesson', '@reading', '@writing', 'Errores', 'Hoy me confundí', '"zzz"'].every(k => r.text.includes(k)));
  check('incluye lecciones, lecturas y el texto escrito para corregir', ['Lección leída', 'Lectura (', '5/6 preguntas bien', 'Textos que escribí', 'I am painting a portrait of my friend'].every(k => r.text.includes(k)), r.text.slice(r.text.indexOf('## Lecciones'), r.text.indexOf('## Lecciones') + 300));
  r = await carlos.req('GET', '/api/report?period=week&date=2026-11-06&format=json');
  check('informe semanal JSON válido con actividades', r.status === 200 && r.json.period === 'week' && r.json.summary.attempts >= 4 && r.json.writings.length === 1 && r.json.readings.length === 1 && r.json.lessons.length === 1, r.json && r.json.summary);
  r = await admin.req('GET', '/api/admin/users?today=' + T);
  const uCarlos = r.json.users.find(u => u.username === 'carlos');
  check('el admin ve la actividad de cada usuario', uCarlos && uCarlos.week_total >= 4 && uCarlos.last_activity, uCarlos);
  r = await admin.req('GET', '/api/admin/users/' + uCarlos.id + '/report?period=week&date=' + T);
  check('el admin descarga el informe de un usuario', r.status === 200 && r.text.includes('Estudiante: carlos'));
  r = await amiga.req('GET', '/api/admin/users/' + uCarlos.id + '/report?period=week&date=' + T);
  check('un usuario normal no puede', r.status === 403);

  console.log('Contraseñas y borrado');
  r = await carlos.req('POST', '/api/password', { current: 'mala', next: 'nueva-clave-123' });
  check('cambiar contraseña exige la actual', r.status === 403);
  r = await carlos.req('POST', '/api/password', { current: 'password-carlos', next: 'nueva-clave-123' });
  check('cambio de contraseña correcto', r.status === 200);
  r = await anon.req('POST', '/api/login', { username: 'carlos', password: 'password-carlos' });
  check('la clave vieja ya no sirve', r.status === 401);
  r = await admin.req('POST', '/api/admin/users/' + uCarlos.id + '/reset-password');
  check('el admin restablece la contraseña (devuelve una temporal)', r.status === 200 && /^[a-z2-9]{10}$/.test(r.json.password), r.json);
  const temp = r.json.password;
  r = await carlos.req('GET', '/api/me');
  check('al restablecer, sus sesiones se cierran', r.status === 401);
  r = await carlos.req('POST', '/api/login', { username: 'carlos', password: temp });
  check('entra con la contraseña temporal', r.status === 200);
  r = await admin.req('DELETE', '/api/admin/users/' + (await admin.req('GET', '/api/me')).json.user.id);
  check('el admin no puede borrarse a sí mismo', r.status === 400);
  r = await admin.req('DELETE', '/api/admin/decks/' + srs.id);
  check('el admin borra un mazo', r.status === 200);
  r = await admin.req('GET', '/api/admin/users/' + uCarlos.id + '/report?period=week&date=2026-11-08');
  check('los resultados siguen en el informe tras borrar el mazo', r.text.includes('Prueba SRS'));
  const uAmiga = (await admin.req('GET', '/api/admin/users?today=' + T)).json.users.find(u => u.username === 'amiga');
  r = await admin.req('DELETE', '/api/admin/users/' + uAmiga.id);
  check('el admin elimina un usuario', r.status === 200);
  r = await amiga.req('GET', '/api/me');
  check('y su sesión deja de valer', r.status === 401);
  r = await admin.req('POST', '/api/logout'); r = await admin.req('GET', '/api/me');
  check('logout invalida la sesión', r.status === 401);

  srv.kill();
  console.log('\n' + passed + ' correctas, ' + failed + ' fallidas');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
