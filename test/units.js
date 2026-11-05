'use strict';
// Prueba de unidades, destinatarios (todos / solo plan general / un usuario personalizado) y práctica oral.
// Usar SOLO con una base de datos de pruebas. Uso: DATABASE_URL=postgres://... node test/units.js
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

const T = '2026-11-04';
const CONTENT_ALL = `
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
`;
const GENERAL_ONLY = `
@unit B1.1 Solo para el plan general
@lesson Lección general
## General
Texto.
@deck Cartas generales
tea | té | I drink tea.
`;
const PERSONAL_CARLOS = `
@unit A1.1 Semana personalizada
desc: Tu plan: arte, programación e Italia.
@lesson Lección personal: arte
## Arte
I paint with watercolor.
@deck Palabras de arte
brush | pincel | I use a brush.
`;
const PERSONAL_LUCIA = `
@unit A1.1 Semana de Lucía
@deck Palabras de cocina
spoon | cuchara | I use a spoon.
`;

(async () => {
  const srv = spawn('node', ['server.js'], {
    env: Object.assign({}, process.env, { PORT: String(PORT), NODE_ENV: 'test', ADMIN_USERNAME: 'jefe', ADMIN_PASSWORD: 'admin-clave-123' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  srv.stderr.on('data', d => process.stderr.write(d));
  for (let i = 0; i < 40; i++) { try { const r = await fetch(BASE + '/health'); if (r.ok) break; } catch (e) { await sleep(150); } }

  const admin = new Client(), amigo = new Client(), pepe = new Client(), carlos = new Client(), lucia = new Client(), anon = new Client();
  let r = await admin.req('POST', '/api/login', { username: 'jefe', password: 'admin-clave-123' });
  check('el administrador entra', r.status === 200 && r.json.user.is_admin);
  const ids = {};
  for (const [name, plan] of [['amigo', 'general'], ['pepe', 'general'], ['carlos', 'personal'], ['lucia', 'personal']]) {
    r = await admin.req('POST', '/api/admin/users', { username: name, password: 'clave-' + name + '-1', profile: plan });
    ids[name] = r.json.user.id;
  }
  const clients = { amigo, pepe, carlos, lucia };
  for (const n of Object.keys(clients)) await clients[n].req('POST', '/api/login', { username: n, password: 'clave-' + n + '-1' });
  const titles = async c => (await c.req('GET', '/api/decks?today=' + T)).json.decks.map(d => d.title);

  console.log('Destino 3: todos');
  r = await admin.req('POST', '/api/admin/import', { text: CONTENT_ALL, audience: 'all', published: false, dryRun: true });
  check('la revisión previa indica el destino de cada unidad', r.status === 200 && r.json.units.length === 3 && r.json.units.every(u => u.audience === 'all' && u.exists === false), r.json.units);
  r = await admin.req('POST', '/api/admin/import', { text: CONTENT_ALL, audience: 'all', published: false });
  check('importación para todos, guardada como borrador', r.status === 200 && r.json.units.length === 3, r.json);
  let units = (await admin.req('GET', '/api/admin/units')).json.units;
  const U = t => units.find(u => u.title === t);
  const U11 = U('Saludos y presentaciones'), U12 = U('En el café'), U21 = U('Rutinas');
  check('las unidades quedan con destino "todos" y sin publicar', [U11, U12, U21].every(u => u.audience === 'all' && u.published === false && u.user_id === null), units);
  r = await amigo.req('GET', '/api/decks?today=' + T);
  check('en borrador, nadie las ve', r.json.decks.length === 0);
  for (const u of [U11, U12, U21]) await admin.req('PATCH', '/api/admin/units/' + u.id, { published: true });
  let looseId = (await admin.req('GET', '/api/admin/decks')).json.decks.find(d => d.title === 'Suelto sin unidad').id;
  await admin.req('PATCH', '/api/admin/decks/' + looseId, { published: true });

  console.log('Destino 1: solo usuarios generales');
  r = await admin.req('POST', '/api/admin/import', { text: GENERAL_ONLY, audience: 'general', published: true });
  check('importación solo para usuarios generales', r.status === 200 && r.json.units[0].audience === 'general' && r.json.units[0].username === null, r.json.units);

  console.log('Destino 2: solo un usuario personalizado');
  r = await admin.req('POST', '/api/admin/import', { text: PERSONAL_CARLOS, audience: 'personal', published: true });
  check('sin elegir usuario => se rechaza con un mensaje claro', r.status === 400 && /usuario/i.test(r.json.error), r.json);
  r = await admin.req('POST', '/api/admin/import', { text: PERSONAL_CARLOS, audience: 'personal', userId: ids.amigo, published: true });
  check('un usuario de plan general no puede recibir contenido personal', r.status === 400 && /plan personalizado/.test(r.json.error), r.json);
  r = await admin.req('POST', '/api/admin/import', { text: PERSONAL_CARLOS, audience: 'personal', userId: 1, published: true });
  check('tampoco la cuenta de administración', r.status === 400, r.json);
  r = await admin.req('POST', '/api/admin/import', { text: PERSONAL_CARLOS, audience: 'personal', userId: ids.carlos, dryRun: true });
  check('la revisión previa muestra a quién iría', r.status === 200 && r.json.units[0].username === 'carlos' && r.json.units[0].audience === 'personal', r.json.units);
  r = await admin.req('POST', '/api/admin/import', { text: PERSONAL_CARLOS, audience: 'personal', userId: ids.carlos, published: true });
  check('importación solo para carlos', r.status === 200 && r.json.units[0].username === 'carlos', r.json);
  r = await admin.req('POST', '/api/admin/import', { text: PERSONAL_LUCIA, audience: 'personal', userId: ids.lucia, published: true });
  check('importación solo para lucia (mismo nivel y número A1.1, no choca con la de carlos)', r.status === 200, r.json);
  units = (await admin.req('GET', '/api/admin/units')).json.units;
  const UC = U('Semana personalizada'), UL = U('Semana de Lucía'), UG = U('Solo para el plan general');
  check('el panel lista a quién pertenece cada unidad personal', UC.username === 'carlos' && UL.username === 'lucia' && UC.audience === 'personal' && UG.audience === 'general', { UC, UL });
  check('hay dos unidades A1.1 personales distintas', units.filter(u => u.level === 'A1' && u.number === 1 && u.audience === 'personal').length === 2);

  console.log('Quién ve qué');
  const tA = await titles(amigo), tP = await titles(pepe), tC = await titles(carlos), tL = await titles(lucia);
  check('usuario general: ve lo de todos y lo de solo-general', ['Palabras de saludo', 'Palabras del café', 'Suelto sin unidad', 'Cartas generales'].every(t => tA.includes(t)), tA);
  check('usuario general: NO ve nada personal', !tA.some(t => /arte|cocina/.test(t)), tA);
  check('otro usuario general ve lo mismo', tP.length === tA.length && tP.includes('Cartas generales'));
  check('carlos (personalizado): ve lo de todos y SU contenido', ['Palabras de saludo', 'Palabras de arte', 'Lección personal: arte'].every(t => tC.includes(t)), tC);
  check('carlos NO ve lo de solo-general ni lo de lucia', !tC.includes('Cartas generales') && !tC.includes('Palabras de cocina'), tC);
  check('lucia ve lo de todos y lo suyo, pero no lo de carlos ni lo de solo-general', tL.includes('Palabras de cocina') && tL.includes('Palabras de saludo') && !tL.includes('Palabras de arte') && !tL.includes('Cartas generales'), tL);
  const adminDecks = (await admin.req('GET', '/api/admin/decks')).json.decks;
  const dk = t => adminDecks.find(d => d.title === t);
  r = await amigo.req('GET', '/api/decks/' + dk('Palabras de arte').id + '/queue?today=' + T + '&new=5');
  check('acceso directo por id: el general no abre lo personal (404)', r.status === 404);
  r = await carlos.req('GET', '/api/decks/' + dk('Palabras de cocina').id + '/queue?today=' + T + '&new=5');
  check('carlos no abre lo de lucia (404)', r.status === 404);
  r = await carlos.req('GET', '/api/decks/' + dk('Cartas generales').id + '/queue?today=' + T + '&new=5');
  check('carlos no abre lo de solo-general (404)', r.status === 404);
  r = await amigo.req('GET', '/api/decks/' + dk('Cartas generales').id + '/queue?today=' + T + '&new=5');
  check('el usuario general sí abre lo de solo-general', r.status === 200);
  r = await carlos.req('POST', '/api/complete', { deckId: dk('Lección general').id, kind: 'lesson', today: T });
  check('ni puede marcar como leída una lección que no le corresponde', r.status === 404);

  console.log('Ruta por niveles y recomendación');
  r = await amigo.req('GET', '/api/path');
  check('usuario general: ruta A1, A2 y B1; sin sección personal', r.json.levels.map(l => l.level).join() === 'A1,A2,B1' && r.json.personal.length === 0, r.json.levels.map(l => l.level));
  check('su primera unidad recomendada es A1.1 de todos', r.json.recommendedUnitId === U11.id);
  r = await carlos.req('GET', '/api/path');
  check('carlos: la ruta no incluye B1 (solo-general) y su plan personal tiene 1 unidad', r.json.levels.map(l => l.level).join() === 'A1,A2' && r.json.personal.length === 1 && r.json.personal[0].id === UC.id, r.json);
  check('y se le recomienda primero su unidad personal', r.json.recommendedUnitId === UC.id);
  r = await lucia.req('GET', '/api/path');
  check('lucia tiene su propia unidad personal', r.json.personal.length === 1 && r.json.personal[0].id === UL.id);
  r = await amigo.req('PUT', '/api/level', { level: 'Z9' });
  check('un nivel inválido se rechaza', r.status === 400);
  await amigo.req('PUT', '/api/level', { level: 'A2' });
  r = await amigo.req('GET', '/api/path');
  check('al elegir nivel A2 se recomienda la unidad de A2', r.json.recommendedUnitId === U21.id);
  await amigo.req('PUT', '/api/level', { level: 'A1' });

  console.log('Cambiar el destino de una unidad');
  r = await admin.req('PATCH', '/api/admin/units/' + UG.id, { audience: 'all' });
  check('pasar "solo general" a "todos"', r.status === 200 && r.json.unit.audience === 'all');
  check('ahora carlos también la ve', (await titles(carlos)).includes('Cartas generales'));
  await admin.req('PATCH', '/api/admin/units/' + UG.id, { audience: 'general' });
  check('y al volver a "solo general", carlos deja de verla', !(await titles(carlos)).includes('Cartas generales'));
  r = await admin.req('PATCH', '/api/admin/units/' + UC.id, { audience: 'personal', userId: ids.lucia });
  check('reasignar a lucia choca con su A1.1 personal (409)', r.status === 409, r.json);
  r = await admin.req('PATCH', '/api/admin/units/' + UC.id, { audience: 'personal', userId: ids.pepe });
  check('reasignar a un usuario de plan general se rechaza', r.status === 400);
  r = await admin.req('PATCH', '/api/admin/units/' + UC.id, { audience: 'personal' });
  check('pasar a personal sin elegir usuario se rechaza', r.status === 400);
  r = await admin.req('PATCH', '/api/admin/units/' + UC.id, { audience: 'all' });
  check('pasarla a "todos" choca con la A1.1 que ya existe para todos (409)', r.status === 409, r.json);
  r = await admin.req('PATCH', '/api/admin/units/' + UC.id, { audience: 'general' });
  check('pasarla a "solo plan general" funciona (queda sin usuario) y la ven los generales', r.status === 200 && r.json.unit.user_id === null && (await titles(amigo)).includes('Palabras de arte'), r.json);
  check('y carlos, que es personalizado, deja de verla', !(await titles(carlos)).includes('Palabras de arte'));
  r = await admin.req('PATCH', '/api/admin/units/' + UC.id, { audience: 'personal', userId: ids.carlos });
  check('volver a ser solo de carlos', r.status === 200 && !(await titles(amigo)).includes('Palabras de arte') && (await titles(carlos)).includes('Palabras de arte'));

  console.log('Plan del usuario');
  await admin.req('PATCH', '/api/admin/users/' + ids.carlos, { profile: 'general' });
  const tC2 = await titles(carlos);
  check('si carlos pasa a plan general: pierde su contenido personal y gana lo de solo-general', !tC2.includes('Palabras de arte') && tC2.includes('Cartas generales'), tC2);
  await admin.req('PATCH', '/api/admin/users/' + ids.carlos, { profile: 'personal' });
  const tC3 = await titles(carlos);
  check('y al volver a personalizado, recupera lo suyo', tC3.includes('Palabras de arte') && !tC3.includes('Cartas generales'));
  r = await admin.req('GET', '/api/admin/users?today=' + T);
  check('la lista de usuarios cuenta sus unidades personales', r.json.users.find(u => u.username === 'carlos').personal_units === 1 && r.json.users.find(u => u.username === 'amigo').personal_units === 0);
  r = await amigo.req('PATCH', '/api/admin/users/' + ids.amigo, { profile: 'personal' });
  check('un usuario normal no puede cambiarse el plan', r.status === 403);

  console.log('Texto de una unidad y modos de importación');
  r = await admin.req('GET', '/api/admin/units/' + UC.id);
  check('el texto exportado no lleva línea de destinatario', r.json.text.startsWith('@unit A1.1 Semana personalizada\ndesc: Tu plan') && !/audience:/.test(r.json.text), r.json.text.slice(0, 120));
  const exported = r.json.text;
  r = await admin.req('POST', '/api/admin/import', { text: exported, audience: 'personal', userId: ids.carlos, dryRun: true });
  check('re-importarla para el mismo usuario reconoce que ya existe', r.json.units[0].exists === true);
  r = await admin.req('POST', '/api/admin/import', { text: exported, audience: 'general', dryRun: true });
  check('para otro destino (solo plan general) cuenta como unidad nueva', r.json.units[0].exists === false);
  r = await admin.req('POST', '/api/admin/import', { text: exported, audience: 'all', dryRun: true });
  check('la identidad es nivel + número + destinatario: a "todos" coincide con la A1.1 que ya existe', r.json.units[0].exists === true);
  const REIMPORT = '@unit A1.2 En el café\n@deck Bebidas\ntea | té | I drink tea.\n';
  await admin.req('POST', '/api/admin/import', { text: REIMPORT, audience: 'all' });
  units = (await admin.req('GET', '/api/admin/units')).json.units;
  check('modo "agregar": la unidad existente recibe el mazo nuevo', units.find(u => u.id === U12.id).decks === 3, units.find(u => u.id === U12.id));
  await admin.req('POST', '/api/admin/import', { text: REIMPORT, audience: 'all', mode: 'replace' });
  units = (await admin.req('GET', '/api/admin/units')).json.units;
  check('modo "reemplazar": queda solo con lo importado, y sigue publicada', units.find(u => u.id === U12.id).decks === 1 && units.find(u => u.id === U12.id).published === true);

  console.log('Compatibilidad con archivos antiguos');
  r = await admin.req('POST', '/api/admin/import', { text: '@unit A2.2 Antigua\naudience: personal\n@deck Vieja\nold | vieja | An old hat.', published: true });
  check('sin destino en la petición, manda la línea "audience:" del archivo', r.status === 200 && r.json.units[0].audience === 'personal', r.json.units);
  check('una personal sin usuario la ven todas las cuentas de plan personalizado (como antes)', (await titles(carlos)).includes('Vieja') && (await titles(lucia)).includes('Vieja') && !(await titles(amigo)).includes('Vieja'));

  console.log('Avance de unidad y plan del día por unidad');
  r = await amigo.req('GET', '/api/today?today=' + T + '&new=5&unit=' + U11.id);
  check('con la unidad A1.1: la lección y las palabras nuevas salen de ahí', r.json.lesson.next && r.json.lesson.next.title === 'Lección: saludos' && r.json.cards.newAvail === 2, r.json);
  r = await amigo.req('GET', '/api/today?today=' + T + '&new=5&unit=' + U12.id);
  check('con la unidad A1.2: son las de esa unidad', r.json.cards.newAvail === 1, r.json.cards);
  r = await amigo.req('POST', '/api/speech', { today: T, deckId: dk('Lección: saludos').id, target: 'Hello, my name is Ana.', heard: 'hello my name is anna', score: 88 });
  check('guardar una práctica oral', r.status === 200);
  r = await amigo.req('POST', '/api/speech', { today: T, target: 'x', heard: 'x', score: 101 });
  check('una nota fuera de 0-100 se rechaza', r.status === 400);
  r = await amigo.req('GET', '/api/today?today=' + T + '&new=5&unit=' + U11.id);
  check('hablar no cuenta como leer la lección, pero sí como práctica del día', r.json.lesson.next.title === 'Lección: saludos' && r.json.speakingToday === 1);
  r = await amigo.req('GET', '/api/path');
  check('ni la práctica oral cuenta como avance de la unidad', r.json.levels[0].units[0].done === 0 && r.json.levels[0].units[0].total === 3, r.json.levels[0].units[0]);
  await amigo.req('POST', '/api/complete', { deckId: dk('Lección: saludos').id, kind: 'lesson', today: T });
  r = await amigo.req('GET', '/api/decks/' + dk('Palabras de saludo').id + '/queue?today=' + T + '&new=5');
  const english = { hola: 'hello', 'adiós': 'goodbye' };
  for (const it of r.json.items) await amigo.req('POST', '/api/answer', { itemId: it.id, answer: english[it.es], today: T });
  r = await amigo.req('GET', '/api/decks/' + dk('Completa el saludo').id + '/queue?today=' + T + '&new=5');
  await amigo.req('POST', '/api/answer', { itemId: r.json.items[0].id, answer: 'am', today: T });
  r = await amigo.req('GET', '/api/path');
  check('unidad A1.1 completa y la recomendación pasa a A1.2', r.json.levels[0].units[0].done === 3 && r.json.recommendedUnitId === U12.id, r.json.recommendedUnitId);

  console.log('Frases para practicar la pronunciación');
  r = await amigo.req('GET', '/api/phrases?n=10');
  check('devuelve frases con su texto', r.status === 200 && r.json.phrases.length >= 3 && r.json.phrases.every(p => p.text.split(' ').length >= 3));
  check('un usuario general nunca recibe frases de contenido personal', !r.json.phrases.some(p => /brush|spoon/i.test(p.text)), r.json.phrases.map(p => p.text));
  r = await lucia.req('GET', '/api/phrases?n=20');
  check('lucia sí recibe las suyas y no las de carlos', r.json.phrases.some(p => /spoon/i.test(p.text)) && !r.json.phrases.some(p => /brush/i.test(p.text)), r.json.phrases.map(p => p.text));
  r = await anon.req('GET', '/api/phrases');
  check('sin sesión no hay frases', r.status === 401);

  console.log('Permisos y borrado');
  r = await amigo.req('GET', '/api/admin/units');
  check('un usuario normal no ve el panel de unidades', r.status === 403);
  r = await amigo.req('POST', '/api/admin/import', { text: PERSONAL_CARLOS, audience: 'all' });
  check('ni puede importar contenido', r.status === 403);
  r = await amigo.req('PATCH', '/api/admin/units/' + U11.id, { audience: 'personal', userId: ids.carlos });
  check('ni cambiar el destino de una unidad', r.status === 403);
  r = await admin.req('DELETE', '/api/admin/users/' + ids.lucia);
  check('el administrador elimina a lucia', r.status === 200);
  units = (await admin.req('GET', '/api/admin/units')).json.units;
  check('al eliminarla, también se elimina la unidad creada solo para ella', !units.some(u => u.title === 'Semana de Lucía') && units.some(u => u.title === 'Semana personalizada'));
  r = await admin.req('DELETE', '/api/admin/units/' + U21.id);
  check('borrar una unidad borra sus mazos', r.status === 200 && !(await admin.req('GET', '/api/admin/decks')).json.decks.some(d => d.title === 'Lección: rutinas'));

  console.log('Informe con práctica oral');
  r = await amigo.req('GET', '/api/report?period=day&date=' + T);
  check('el informe incluye la pronunciación con lo dicho y lo entendido', ['Práctica de pronunciación', 'Hello, my name is Ana.', 'hello my name is anna', 'aproximada'].every(k => r.text.includes(k)));
  check('el formato para la IA menciona las unidades y ya no el destinatario', r.text.includes('@unit A1.1') && !/audience:/.test(r.text.slice(r.text.indexOf('```'), r.text.indexOf('```', r.text.indexOf('```') + 3))));
  r = await amigo.req('GET', '/api/report?period=day&date=' + T + '&format=json');
  check('el JSON del informe trae la práctica oral', r.json.speaking.length === 1 && r.json.speaking[0].score === 88);

  srv.kill();
  console.log('\n' + passed + ' correctas, ' + failed + ' fallidas');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
