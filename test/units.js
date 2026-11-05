'use strict';
// Prueba de unidades, audiencias y práctica oral. Usar SOLO con una base de datos de pruebas.
// Uso: DATABASE_URL=postgres://... node test/units.js
const { spawn } = require('child_process');

const PORT = 3996;
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

const CONTENT = `
@deck Suelto sin unidad
only | solo | I am only here.

@unit A1.1 Saludos y presentaciones
desc: Saludar y presentarte.
@lesson Lección: saludos
## Hola
Hello es "hola".
@deck Palabras de saludo
hello | hola | Hello, my name is Ana.
goodbye | adiós | Goodbye, see you soon.
@exercises Completa el saludo
Hello, I ___ Ana. => am | Con I se usa am.

@unit A1.2 En el café
@lesson Lección: pedir un café
## Pedir
Can I have a coffee, please?
@deck Palabras del café
coffee | café | I want a coffee.

@unit A2.1 Rutinas
@lesson Lección: rutinas
## Rutinas
I wake up at seven.

@unit A1.1 Semana 1 personalizada
audience: personal
desc: Tu plan: arte, programación e Italia.
@lesson Lección personal: arte
## Arte
I paint with watercolor.
@deck Palabras de arte
brush | pincel | I use a brush.
`;

(async () => {
  const srv = spawn('node', ['server.js'], {
    env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'test', ADMIN_USERNAME: 'jefe', ADMIN_PASSWORD: 'admin-clave-123' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + '/health'); if (r.ok) break; } catch (e) { await sleep(150); } }

  const T = '2026-11-04';
  const admin = new Client(), amigo = new Client(), carlos = new Client(), anon = new Client();
  const anonReq = (m, u, b) => anon.req(m, u, b);
  let r = await admin.req('POST', '/api/login', { username: 'jefe', password: 'admin-clave-123' });
  check('el administrador entra', r.status === 200 && r.json.user.is_admin);
  await admin.req('POST', '/api/admin/users', { username: 'amigo', password: 'password-amigo' });
  r = await admin.req('POST', '/api/admin/users', { username: 'carlos', password: 'password-carlos', profile: 'personal' });
  check('se puede crear un usuario con plan personalizado', r.status === 200 && r.json.user.profile === 'personal', r.json);
  await amigo.req('POST', '/api/login', { username: 'amigo', password: 'password-amigo' });
  await carlos.req('POST', '/api/login', { username: 'carlos', password: 'password-carlos' });
  r = await amigo.req('GET', '/api/me');
  check('el usuario general tiene plan "general"', r.json.user.profile === 'general');

  console.log('Importar unidades');
  r = await admin.req('POST', '/api/admin/import', { text: '@unit A9.1 Mal\n@deck X\na | b | a c' });
  check('un nivel inválido se rechaza con la línea', r.status === 400 && r.json.errors[0].line === 1);
  r = await admin.req('POST', '/api/admin/import', { text: CONTENT, dryRun: true });
  check('revisión previa: 4 unidades, ninguna existe todavía', r.status === 200 && r.json.units.length === 4 && r.json.units.every(u => u.exists === false), r.json.units);
  check('la revisión indica a qué unidad va cada mazo', r.json.preview.find(d => d.title === 'Palabras de arte').unit === 'A1.1' && r.json.preview.find(d => d.title === 'Suelto sin unidad').unit === null);
  r = await admin.req('GET', '/api/admin/units');
  check('la revisión previa no guardó nada', r.json.units.length === 0);
  r = await admin.req('POST', '/api/admin/import', { text: CONTENT, published: false });
  check('importación completa guardada como borrador', r.status === 200 && r.json.units.length === 4 && r.json.published === false, r.json);
  r = await admin.req('GET', '/api/admin/units');
  const units = r.json.units;
  const byKey = k => units.find(u => u.level + '.' + u.number + '/' + u.audience === k);
  const U11 = byKey('A1.1/general'), U12 = byKey('A1.2/general'), U21 = byKey('A2.1/general'), UP = byKey('A1.1/personal');
  check('existen A1.1 general y A1.1 personal a la vez (misma numeración)', U11 && UP && U11.id !== UP.id);
  check('las unidades nuevas quedan sin publicar y con su descripción', units.every(u => u.published === false) && U11.description === 'Saludar y presentarte.' && U11.decks === 3 && UP.decks === 2, units);
  check('las unidades salen ordenadas por nivel y número', units.map(u => u.level + '.' + u.number).join(',') === 'A1.1,A1.1,A1.2,A2.1', units.map(u => u.level + '.' + u.number));
  r = await admin.req('GET', '/api/admin/decks');
  const decks = r.json.decks;
  const dk = t => decks.find(d => d.title === t);
  check('los mazos de una unidad quedan publicados (manda la unidad) y el suelto sigue el borrador', dk('Palabras de saludo').published === true && dk('Suelto sin unidad').published === false);

  console.log('Visibilidad por audiencia');
  r = await amigo.req('GET', '/api/decks?today=' + T);
  check('con las unidades en borrador, el usuario no ve ningún mazo de unidad', r.json.decks.length === 0, r.json.decks.map(d => d.title));
  for (const u of units) await admin.req('PATCH', '/api/admin/units/' + u.id, { published: true });
  await admin.req('PATCH', '/api/admin/decks/' + dk('Suelto sin unidad').id, { published: true });
  r = await amigo.req('GET', '/api/decks?today=' + T);
  const titlesA = r.json.decks.map(d => d.title);
  check('el usuario general ve las unidades generales y el mazo suelto', titlesA.includes('Palabras de saludo') && titlesA.includes('Palabras del café') && titlesA.includes('Suelto sin unidad'), titlesA);
  check('el usuario general NO ve el contenido personal', !titlesA.includes('Palabras de arte') && !titlesA.includes('Lección personal: arte'), titlesA);
  r = await carlos.req('GET', '/api/decks?today=' + T);
  const titlesC = r.json.decks.map(d => d.title);
  check('el usuario personalizado ve lo general y lo personal', titlesC.includes('Palabras de saludo') && titlesC.includes('Palabras de arte') && titlesC.includes('Lección personal: arte'), titlesC);
  r = await amigo.req('GET', '/api/decks/' + dk('Palabras de arte').id + '/queue?today=' + T + '&new=5');
  check('acceso directo por id a un mazo personal => 404 para el usuario general', r.status === 404);
  r = await amigo.req('POST', '/api/complete', { deckId: dk('Lección personal: arte').id, kind: 'lesson', today: T });
  check('tampoco puede marcar como leída una lección personal', r.status === 404);
  r = await carlos.req('GET', '/api/decks/' + dk('Palabras de arte').id + '/queue?today=' + T + '&new=5');
  check('el usuario personalizado sí la abre', r.status === 200 && r.json.items.length === 1);

  console.log('Ruta por niveles y recomendación');
  r = await amigo.req('GET', '/api/path');
  check('ruta general: A1 con 2 unidades y A2 con 1; sin sección personal', r.json.levels.length === 2 && r.json.levels[0].level === 'A1' && r.json.levels[0].units.length === 2 && r.json.levels[1].units.length === 1 && r.json.personal.length === 0, r.json);
  check('la primera unidad recomendada es A1.1', r.json.recommendedUnitId === U11.id);
  r = await carlos.req('GET', '/api/path');
  check('el usuario personalizado ve su plan personal aparte', r.json.personal.length === 1 && r.json.personal[0].id === UP.id && r.json.levels[0].units.length === 2, r.json);
  check('y su recomendación es primero su unidad personal', r.json.recommendedUnitId === UP.id);
  r = await amigo.req('PUT', '/api/level', { level: 'Z9' });
  check('un nivel inválido se rechaza', r.status === 400);
  r = await amigo.req('PUT', '/api/level', { level: 'A2' });
  r = await amigo.req('GET', '/api/path');
  check('al elegir nivel A2, se recomienda la unidad de A2', r.json.level === 'A2' && r.json.recommendedUnitId === U21.id, r.json.recommendedUnitId);
  await amigo.req('PUT', '/api/level', { level: 'A1' });

  console.log('Avance de unidad y plan del día por unidad');
  r = await amigo.req('GET', '/api/today?today=' + T + '&new=5&unit=' + U11.id);
  check('plan del día con unidad A1.1: la lección y las palabras nuevas salen de ahí', r.json.lesson.next && r.json.lesson.next.title === 'Lección: saludos' && r.json.cards.newAvail === 2, r.json);
  r = await amigo.req('GET', '/api/today?today=' + T + '&new=5&unit=' + U12.id);
  check('con unidad A1.2: la lección y las palabras son las de esa unidad', r.json.lesson.next.title === 'Lección: pedir un café' && r.json.cards.newAvail === 1, r.json);
  // hablar NO cuenta como leer la lección
  r = await amigo.req('POST', '/api/speech', { today: T, deckId: dk('Lección: saludos').id, target: 'Hello, my name is Ana.', heard: 'hello my name is anna', score: 88 });
  check('guardar una práctica oral', r.status === 200);
  r = await amigo.req('POST', '/api/speech', { today: T, target: 'x', heard: 'x', score: 101 });
  check('una nota fuera de 0-100 se rechaza', r.status === 400);
  r = await amigo.req('POST', '/api/speech', { today: T, target: '', heard: 'x', score: 50 });
  check('sin frase objetivo se rechaza', r.status === 400);
  r = await amigo.req('GET', '/api/today?today=' + T + '&new=5&unit=' + U11.id);
  check('hablar no cuenta como leer la lección, pero se cuenta en el plan del día', r.json.lesson.next.title === 'Lección: saludos' && r.json.speakingToday === 1, r.json);
  r = await amigo.req('GET', '/api/path');
  check('ni la práctica oral cuenta como avance de la unidad', r.json.levels[0].units[0].done === 0 && r.json.levels[0].units[0].total === 3, r.json.levels[0].units[0]);

  // completar A1.1
  await amigo.req('POST', '/api/complete', { deckId: dk('Lección: saludos').id, kind: 'lesson', today: T });
  r = await amigo.req('GET', '/api/decks/' + dk('Palabras de saludo').id + '/queue?today=' + T + '&new=5');
  const q1 = r.json.items;
  const english = { hola: 'hello', 'adiós': 'goodbye' };
  for (const it of q1) await amigo.req('POST', '/api/answer', { itemId: it.id, answer: english[it.es], today: T });
  r = await amigo.req('GET', '/api/path');
  check('con la lección y todas las tarjetas empezadas: 2 de 3 mazos hechos', r.json.levels[0].units[0].done === 2, r.json.levels[0].units[0]);
  r = await amigo.req('GET', '/api/decks/' + dk('Completa el saludo').id + '/queue?today=' + T + '&new=5');
  await amigo.req('POST', '/api/answer', { itemId: r.json.items[0].id, answer: 'am', today: T });
  r = await amigo.req('GET', '/api/path');
  check('unidad A1.1 completa (3 de 3)', r.json.levels[0].units[0].done === 3 && r.json.levels[0].units[0].total === 3, r.json.levels[0].units[0]);
  check('al completarla, la recomendación pasa a A1.2', r.json.recommendedUnitId === U12.id, r.json.recommendedUnitId);

  console.log('Frases para practicar la pronunciación');
  r = await amigo.req('GET', '/api/phrases?n=5&unit=' + U11.id);
  check('devuelve frases con su texto y traducción', r.status === 200 && r.json.phrases.length >= 3 && r.json.phrases.every(p => p.text.split(' ').length >= 3 && p.deckId), r.json);
  check('con la unidad A1.1 pedida, salen primero frases de esa unidad', r.json.phrases[0].text === 'Hello, my name is Ana.' || r.json.phrases[0].text === 'Goodbye, see you soon.', r.json.phrases.map(p => p.text));
  r = await amigo.req('GET', '/api/phrases?n=10');
  check('un usuario general nunca recibe frases del contenido personal', !r.json.phrases.some(p => /brush|watercolor/i.test(p.text)), r.json.phrases.map(p => p.text));
  r = await carlos.req('GET', '/api/phrases?n=10');
  check('un usuario personalizado sí puede recibirlas', r.json.phrases.some(p => /brush/i.test(p.text)), r.json.phrases.map(p => p.text));
  r = await anonReq('GET', '/api/phrases');
  check('sin sesión no hay frases', r.status === 401);

  console.log('Administración de unidades');
  r = await amigo.req('GET', '/api/admin/units');
  check('un usuario normal no ve el panel de unidades', r.status === 403);
  r = await amigo.req('PATCH', '/api/admin/units/' + U11.id, { published: false });
  check('ni puede despublicar', r.status === 403);
  r = await admin.req('PATCH', '/api/admin/units/' + U12.id, { published: false });
  r = await amigo.req('GET', '/api/path');
  check('al despublicar una unidad desaparece de la ruta', r.json.levels[0].units.length === 1 && r.json.levels[0].units[0].id === U11.id);
  r = await amigo.req('GET', '/api/decks?today=' + T);
  check('y también sus mazos', !r.json.decks.some(d => d.title === 'Palabras del café'));
  await admin.req('PATCH', '/api/admin/units/' + U12.id, { published: true });
  r = await admin.req('PATCH', '/api/admin/units/' + UP.id, { audience: 'general' });
  check('no se puede pasar a general si ya existe esa misma unidad general (409)', r.status === 409, r.json);
  r = await admin.req('PATCH', '/api/admin/units/' + U12.id, { title: 'En la cafetería', description: 'Pedir bebidas.' });
  check('cambiar título y descripción', r.status === 200);
  r = await admin.req('GET', '/api/admin/units/' + U11.id);
  check('exportar una unidad a texto', r.json.text.startsWith('@unit A1.1 Saludos y presentaciones\naudience: general\ndesc: Saludar y presentarte.') && r.json.text.includes('@lesson Lección: saludos') && r.json.text.includes('hello | hola'), r.json.text.slice(0, 200));
  r = await admin.req('POST', '/api/admin/import', { text: r.json.text, dryRun: true });
  check('ese texto se puede volver a importar y reconoce que la unidad ya existe', r.status === 200 && r.json.units[0].exists === true && r.json.preview.length === 3);

  console.log('Importar de nuevo: agregar o reemplazar');
  const REIMPORT = '@unit A1.2 En la cafetería\n@deck Bebidas\ntea | té | I drink tea.\n';
  r = await admin.req('POST', '/api/admin/import', { text: REIMPORT });
  r = await admin.req('GET', '/api/admin/units');
  check('modo "agregar": la unidad existente recibe el mazo nuevo (sin duplicar la unidad)', r.json.units.filter(u => u.level === 'A1' && u.number === 2).length === 1 && r.json.units.find(u => u.id === U12.id).decks === 3, r.json.units.find(u => u.id === U12.id));
  r = await admin.req('POST', '/api/admin/import', { text: REIMPORT, mode: 'replace' });
  r = await admin.req('GET', '/api/admin/units');
  check('modo "reemplazar": la unidad queda solo con lo importado', r.json.units.find(u => u.id === U12.id).decks === 1, r.json.units.find(u => u.id === U12.id));
  check('y conserva su publicación', r.json.units.find(u => u.id === U12.id).published === true);
  r = await admin.req('DELETE', '/api/admin/units/' + U21.id);
  check('borrar una unidad', r.status === 200);
  r = await admin.req('GET', '/api/admin/decks');
  check('al borrar la unidad se borran sus mazos', !r.json.decks.some(d => d.title === 'Lección: rutinas'));

  console.log('Usuarios: plan general o personalizado');
  r = await admin.req('GET', '/api/admin/users?today=' + T);
  const uAmigo = r.json.users.find(u => u.username === 'amigo');
  check('la lista de usuarios muestra el plan', uAmigo.profile === 'general' && r.json.users.find(u => u.username === 'carlos').profile === 'personal');
  r = await admin.req('PATCH', '/api/admin/users/' + uAmigo.id, { profile: 'raro' });
  check('un plan inválido se rechaza', r.status === 400);
  r = await amigo.req('PATCH', '/api/admin/users/' + uAmigo.id, { profile: 'personal' });
  check('un usuario normal no puede cambiarse el plan', r.status === 403);
  await admin.req('PATCH', '/api/admin/users/' + uAmigo.id, { profile: 'personal' });
  r = await amigo.req('GET', '/api/decks?today=' + T);
  check('al activar el plan personalizado, ve el contenido personal', r.json.decks.some(d => d.title === 'Palabras de arte'));
  await admin.req('PATCH', '/api/admin/users/' + uAmigo.id, { profile: 'general' });
  r = await amigo.req('GET', '/api/decks?today=' + T);
  check('y al quitarlo, deja de verlo', !r.json.decks.some(d => d.title === 'Palabras de arte'));

  console.log('Informe con práctica oral');
  r = await amigo.req('GET', '/api/report?period=day&date=' + T);
  check('el informe incluye la sección de pronunciación con lo dicho y lo entendido', ['Práctica de pronunciación', 'Hello, my name is Ana.', 'hello my name is anna', 'Prácticas de pronunciación: 1', 'aproximada'].every(k => r.text.includes(k)), r.text.slice(r.text.indexOf('## Resumen'), r.text.indexOf('## Resumen') + 400));
  check('el informe incluye el formato de unidades para la IA', r.text.includes('@unit A1.1'));
  r = await amigo.req('GET', '/api/report?period=day&date=' + T + '&format=json');
  check('el JSON del informe trae la práctica oral', r.json.speaking.length === 1 && r.json.speaking[0].score === 88);

  srv.kill();
  console.log('\n' + passed + ' correctas, ' + failed + ' fallidas');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
