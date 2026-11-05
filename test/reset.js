'use strict';
// Vacía la base de datos de PRUEBAS (borra todas sus tablas). Para evitar accidentes, exige ALLOW_RESET=yes.
// Uso: ALLOW_RESET=yes DATABASE_URL=postgres://... node test/reset.js
const { Pool } = require('pg');

if (process.env.ALLOW_RESET !== 'yes') {
  console.error('Por seguridad, define ALLOW_RESET=yes para confirmar que esta es una base de datos de PRUEBAS.');
  process.exit(1);
}
if (!process.env.DATABASE_URL) { console.error('Falta DATABASE_URL.'); process.exit(1); }

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false });
  await pool.query('drop schema public cascade; create schema public;');
  await pool.end();
  console.log('Base de pruebas vaciada.');
})().catch(e => { console.error(e.message); process.exit(1); });
