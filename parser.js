'use strict';

/*
  FORMATO DE TEXTO (se explica también dentro de la app)

  @deck Título del mazo
  inglés | español | frase de ejemplo que contenga la palabra | alternativa1; alternativa2

  @exercises Título de los ejercicios
  Frase con ___ hueco => respuesta1 / respuesta2 | explicación breve

  - Las líneas vacías se ignoran.
  - Las líneas que empiezan con // son comentarios.
  - Un mismo texto puede traer varios mazos (cada uno con su @deck o @exercises).
*/

const MAX_LINES = 3000;
const MAX_ITEMS_PER_DECK = 1000;
const MAX_FIELD = 300;

function normalize(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[’‘`´]/g, "'")
    .replace(/[.!?¿¡,;:]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDeckText(text) {
  const errors = [];
  const decks = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');

  if (lines.length > MAX_LINES) {
    return { decks: [], errors: [{ line: 0, msg: 'El texto tiene demasiadas líneas (máximo ' + MAX_LINES + ').' }] };
  }

  let cur = null;

  lines.forEach((raw, idx) => {
    const n = idx + 1;
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;

    if (line.startsWith('@')) {
      const m = line.match(/^@(deck|exercises)\s+(.+)$/i);
      if (!m) {
        errors.push({ line: n, msg: 'Encabezado no válido. Usa "@deck Título" o "@exercises Título".' });
        cur = null;
        return;
      }
      cur = {
        kind: m[1].toLowerCase() === 'deck' ? 'cards' : 'exercises',
        title: m[2].trim().slice(0, 80),
        items: [],
        line: n
      };
      decks.push(cur);
      return;
    }

    if (!cur) {
      errors.push({ line: n, msg: 'Esta línea está antes de un encabezado @deck o @exercises.' });
      return;
    }
    if (cur.items.length >= MAX_ITEMS_PER_DECK) {
      errors.push({ line: n, msg: 'El mazo "' + cur.title + '" supera ' + MAX_ITEMS_PER_DECK + ' elementos.' });
      return;
    }

    if (cur.kind === 'cards') {
      const p = line.split('|').map(s => s.trim());
      if (p.length < 3 || !p[0] || !p[1] || !p[2]) {
        errors.push({ line: n, msg: 'Tarjeta incompleta. Formato: inglés | español | frase de ejemplo | alternativas (opcional).' });
        return;
      }
      if (p.some(x => x.length > MAX_FIELD)) {
        errors.push({ line: n, msg: 'Un campo supera ' + MAX_FIELD + ' caracteres.' });
        return;
      }
      if (p[2].toLowerCase().indexOf(p[0].toLowerCase()) === -1) {
        errors.push({ line: n, msg: 'La frase de ejemplo debe contener "' + p[0] + '" (así la app puede ocultarla).' });
        return;
      }
      const alt = (p[3] || '').split(';').map(s => s.trim()).filter(Boolean);
      cur.items.push({ en: p[0], es: p[1], ex: p[2], alt });
    } else {
      const arrow = line.indexOf('=>');
      if (arrow === -1) {
        errors.push({ line: n, msg: 'Ejercicio sin "=>". Formato: Frase con ___ => respuesta | explicación (opcional).' });
        return;
      }
      const qText = line.slice(0, arrow).trim();
      const rest = line.slice(arrow + 2);
      const bar = rest.indexOf('|');
      const ansPart = (bar === -1 ? rest : rest.slice(0, bar)).trim();
      const why = (bar === -1 ? '' : rest.slice(bar + 1)).trim();
      const answers = ansPart.split('/').map(s => s.trim()).filter(Boolean);
      if (!qText || !answers.length) {
        errors.push({ line: n, msg: 'Falta la frase o la respuesta antes/después de "=>".' });
        return;
      }
      if (qText.length > MAX_FIELD || why.length > 500 || answers.some(a => a.length > MAX_FIELD)) {
        errors.push({ line: n, msg: 'Un campo es demasiado largo.' });
        return;
      }
      cur.items.push({ q: qText, a: answers, why });
    }
  });

  decks.forEach(d => {
    if (!d.items.length) errors.push({ line: d.line, msg: 'El mazo "' + d.title + '" no tiene elementos.' });
  });

  return { decks, errors };
}

module.exports = { parseDeckText, normalize, MAX_ITEMS_PER_DECK };
