'use strict';

/*
  FORMATO DE TEXTO (también se explica dentro del panel de administración)

  // comentario (se ignora)

  @unit A1.1 Título de la unidad     -> agrupa los mazos que vienen después (nivel A1, unidad 1)
  audience: general                  (o "personal"; opcional, por defecto general)
  desc: Descripción corta            (opcional)

  @deck Título                       -> tarjetas
  inglés | español | frase de ejemplo que contenga la palabra | alternativa1; alternativa2

  @exercises Título                  -> ejercicios con hueco
  Frase con ___ hueco => respuesta1 / respuesta2 | explicación breve

  @lesson Título                     -> lección para leer
  ## Subtítulo
  Un párrafo de explicación.
  - elemento de lista
  > English example | traducción
  ! Nota o consejo destacado

  @reading Título                    -> lectura con preguntas
  Párrafo del texto (cada línea es un párrafo).
  ? Pregunta | opción A; opción B*; opción C | explicación (opcional)     (la correcta lleva *)

  @writing Título                    -> tarea de escritura
  Instrucción de la tarea (una o varias líneas).
  min: 25                            (palabras mínimas, opcional)
  tip: Un consejo (opcional, puede repetirse)
*/

const MAX_LINES = 3000;
const MAX_ITEMS_PER_DECK = 1000;
const MAX_FIELD = 300;
const MAX_LINE = 800;
const MAX_BLOCKS = 300;
const HEADER_RE = /^@(deck|exercises|lesson|reading|writing)\s+(.+)$/i;
const UNIT_RE = /^@unit\s+(A1|A2|B1|B2|C1|C2)\.(\d{1,3})\s+(.+)$/i;
const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const KIND_OF = { deck: 'cards', exercises: 'exercises', lesson: 'lesson', reading: 'reading', writing: 'writing' };

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

  // 1) reparte las líneas entre unidades y mazos
  const units = [];
  let cur = null;
  let curUnit = null;
  lines.forEach((raw, idx) => {
    const n = idx + 1;
    const line = raw.trim();
    if (!line || line.startsWith('//')) return;
    if (line.startsWith('@')) {
      let m = line.match(UNIT_RE);
      if (m) {
        curUnit = { level: m[1].toUpperCase(), number: parseInt(m[2], 10), title: m[3].trim().slice(0, 100), description: '', audience: null, line: n };
        units.push(curUnit);
        cur = null;
        return;
      }
      if (/^@unit\b/i.test(line)) {
        errors.push({ line: n, msg: 'Unidad no válida. Usa: @unit A1.1 Título (nivel A1, A2, B1, B2, C1 o C2, un punto y el número de unidad).' });
        curUnit = null; cur = null;
        return;
      }
      m = line.match(HEADER_RE);
      if (!m) {
        errors.push({ line: n, msg: 'Encabezado no válido. Usa @unit, @deck, @exercises, @lesson, @reading o @writing seguido de un título.' });
        cur = null;
        return;
      }
      cur = { kind: KIND_OF[m[1].toLowerCase()], title: m[2].trim().slice(0, 80), items: [], line: n, raw: [], unit: curUnit ? units.indexOf(curUnit) : null };
      decks.push(cur);
      return;
    }
    if (!cur) {
      if (curUnit) {
        let pm;
        if ((pm = line.match(/^audience:\s*(general|personal)\s*$/i))) curUnit.audience = pm[1].toLowerCase();
        else if ((pm = line.match(/^desc:\s*(.+)$/i))) curUnit.description = pm[1].trim().slice(0, 300);
        else errors.push({ line: n, msg: 'Dentro de una unidad, antes de sus mazos, solo puedes usar "audience: general|personal" y "desc: texto".' });
        return;
      }
      errors.push({ line: n, msg: 'Esta línea está antes de un encabezado (@unit, @deck, @exercises, @lesson, @reading o @writing).' });
      return;
    }
    cur.raw.push({ n, line });
  });

  // 2) interpreta cada mazo según su tipo
  decks.forEach(d => {
    const err = (n, msg) => errors.push({ line: n, msg });
    const tooLong = (n, s, max) => { if (s.length > (max || MAX_FIELD)) { err(n, 'Esta línea es demasiado larga.'); return true; } return false; };

    if (d.kind === 'cards') {
      d.raw.forEach(({ n, line }) => {
        if (d.items.length >= MAX_ITEMS_PER_DECK) return err(n, 'El mazo "' + d.title + '" supera ' + MAX_ITEMS_PER_DECK + ' elementos.');
        const p = line.split('|').map(s => s.trim());
        if (p.length < 3 || !p[0] || !p[1] || !p[2]) return err(n, 'Tarjeta incompleta. Formato: inglés | español | frase de ejemplo | alternativas (opcional).');
        if (p.some(x => x.length > MAX_FIELD)) return err(n, 'Un campo supera ' + MAX_FIELD + ' caracteres.');
        if (p[2].toLowerCase().indexOf(p[0].toLowerCase()) === -1) return err(n, 'La frase de ejemplo debe contener "' + p[0] + '" (así la app puede ocultarla).');
        d.items.push({ en: p[0], es: p[1], ex: p[2], alt: (p[3] || '').split(';').map(s => s.trim()).filter(Boolean) });
      });

    } else if (d.kind === 'exercises') {
      d.raw.forEach(({ n, line }) => {
        if (d.items.length >= MAX_ITEMS_PER_DECK) return err(n, 'El mazo "' + d.title + '" supera ' + MAX_ITEMS_PER_DECK + ' elementos.');
        const arrow = line.indexOf('=>');
        if (arrow === -1) return err(n, 'Ejercicio sin "=>". Formato: Frase con ___ => respuesta | explicación (opcional).');
        const qText = line.slice(0, arrow).trim();
        const rest = line.slice(arrow + 2);
        const bar = rest.indexOf('|');
        const ansPart = (bar === -1 ? rest : rest.slice(0, bar)).trim();
        const why = (bar === -1 ? '' : rest.slice(bar + 1)).trim();
        const answers = ansPart.split('/').map(s => s.trim()).filter(Boolean);
        if (!qText || !answers.length) return err(n, 'Falta la frase o la respuesta antes/después de "=>".');
        if (qText.length > MAX_FIELD || why.length > 500 || answers.some(a => a.length > MAX_FIELD)) return err(n, 'Un campo es demasiado largo.');
        d.items.push({ q: qText, a: answers, why });
      });

    } else if (d.kind === 'lesson') {
      const blocks = [];
      let ul = null;
      d.raw.forEach(({ n, line }) => {
        if (blocks.length >= MAX_BLOCKS) return;
        if (tooLong(n, line, MAX_LINE)) return;
        if (line.startsWith('## ')) { ul = null; blocks.push({ t: 'h', text: line.slice(3).trim() }); }
        else if (line.startsWith('- ')) { if (!ul) { ul = { t: 'ul', items: [] }; blocks.push(ul); } ul.items.push(line.slice(2).trim()); }
        else if (line.startsWith('> ')) {
          ul = null;
          const parts = line.slice(2).split('|').map(s => s.trim());
          if (!parts[0]) return err(n, 'Ejemplo vacío. Formato: > English sentence | traducción');
          blocks.push({ t: 'ex', en: parts[0], es: parts[1] || '' });
        }
        else if (line.startsWith('! ')) { ul = null; blocks.push({ t: 'note', text: line.slice(2).trim() }); }
        else { ul = null; blocks.push({ t: 'p', text: line }); }
      });
      if (!blocks.length) err(d.line, 'La lección "' + d.title + '" no tiene contenido.');
      else d.items.push({ blocks });

    } else if (d.kind === 'reading') {
      const paragraphs = [];
      const questions = [];
      d.raw.forEach(({ n, line }) => {
        if (tooLong(n, line, MAX_LINE)) return;
        if (line.startsWith('?')) {
          const p = line.slice(1).split('|').map(s => s.trim());
          const q = p[0];
          const opts = (p[1] || '').split(';').map(s => s.trim()).filter(Boolean);
          if (!q || opts.length < 2) return err(n, 'Pregunta incompleta. Formato: ? Pregunta | opción A; opción B*; opción C | explicación (opcional).');
          if (opts.length > 6) return err(n, 'Máximo 6 opciones por pregunta.');
          const marked = opts.map((o, i) => (o.endsWith('*') ? i : -1)).filter(i => i >= 0);
          if (marked.length !== 1) return err(n, 'Marca exactamente una opción correcta con * al final (por ejemplo: In a school*).');
          const options = opts.map(o => o.replace(/\*+$/, '').trim());
          if (options.some(o => !o) || new Set(options.map(o => o.toLowerCase())).size !== options.length) return err(n, 'Las opciones no pueden estar vacías ni repetidas.');
          questions.push({ q, options, correct: marked[0], why: p[2] || '' });
        } else {
          paragraphs.push(line);
        }
      });
      if (!paragraphs.length) err(d.line, 'La lectura "' + d.title + '" no tiene texto.');
      else if (!questions.length) err(d.line, 'La lectura "' + d.title + '" necesita al menos una pregunta (línea que empieza con ?).');
      else if (questions.length > 50) err(d.line, 'Máximo 50 preguntas por lectura.');
      else { d.items.push({ text: paragraphs }); questions.forEach(q => d.items.push(q)); }

    } else if (d.kind === 'writing') {
      const prompt = [];
      const tips = [];
      let min = 0;
      d.raw.forEach(({ n, line }) => {
        if (tooLong(n, line, MAX_LINE)) return;
        let m;
        if ((m = line.match(/^min:\s*(\d+)\s*$/i))) {
          min = parseInt(m[1], 10);
          if (min > 500) err(n, 'El mínimo de palabras no puede pasar de 500.');
        } else if ((m = line.match(/^tip:\s*(.+)$/i))) tips.push(m[1].trim());
        else prompt.push(line);
      });
      if (!prompt.length) err(d.line, 'La tarea "' + d.title + '" necesita una instrucción.');
      else d.items.push({ prompt, min, tips });
    }

    if (!d.items.length && !errors.some(e => e.line >= d.line)) err(d.line, 'El mazo "' + d.title + '" no tiene elementos.');
  });

  // 3) validaciones de unidades
  const seen = new Map();
  units.forEach((u, i) => {
    const key = u.level + '.' + u.number + '/' + (u.audience || 'general');
    if (seen.has(key)) errors.push({ line: u.line, msg: 'La unidad ' + u.level + '.' + u.number + ' aparece repetida en este texto.' });
    seen.set(key, i);
    if (!decks.some(d => d.unit === i)) errors.push({ line: u.line, msg: 'La unidad ' + u.level + '.' + u.number + ' no tiene mazos.' });
  });

  decks.forEach(d => { delete d.raw; });
  return { decks, units, errors };
}

// Cantidad de "unidades" de un mazo, para mostrar en listas (tarjetas, ejercicios o preguntas).
function deckCount(d) {
  if (d.kind === 'reading') return Math.max(0, d.items.length - 1);
  if (d.kind === 'lesson' || d.kind === 'writing') return 1;
  return d.items.length;
}

// Convierte un mazo guardado de vuelta al formato de texto (para editarlo y volver a importarlo).
function deckToText(deck, items) {
  const head = { cards: '@deck ', exercises: '@exercises ', lesson: '@lesson ', reading: '@reading ', writing: '@writing ' }[deck.kind];
  const lines = [head + deck.title];
  if (deck.kind === 'cards') {
    items.forEach(it => lines.push([it.en, it.es, it.ex].concat(it.alt && it.alt.length ? [it.alt.join('; ')] : []).join(' | ')));
  } else if (deck.kind === 'exercises') {
    items.forEach(it => lines.push(it.q + ' => ' + it.a.join(' / ') + (it.why ? ' | ' + it.why : '')));
  } else if (deck.kind === 'lesson') {
    (items[0] ? items[0].blocks : []).forEach(b => {
      if (b.t === 'h') lines.push('## ' + b.text);
      else if (b.t === 'p') lines.push(b.text);
      else if (b.t === 'ul') b.items.forEach(x => lines.push('- ' + x));
      else if (b.t === 'ex') lines.push('> ' + b.en + (b.es ? ' | ' + b.es : ''));
      else if (b.t === 'note') lines.push('! ' + b.text);
    });
  } else if (deck.kind === 'reading') {
    items.forEach(it => {
      if (it.text) it.text.forEach(p => lines.push(p));
      else lines.push('? ' + it.q + ' | ' + it.options.map((o, i) => o + (i === it.correct ? '*' : '')).join('; ') + (it.why ? ' | ' + it.why : ''));
    });
  } else if (deck.kind === 'writing') {
    const it = items[0] || { prompt: [], tips: [] };
    it.prompt.forEach(p => lines.push(p));
    if (it.min) lines.push('min: ' + it.min);
    (it.tips || []).forEach(t => lines.push('tip: ' + t));
  }
  return lines.join('\n') + '\n';
}

// Convierte una unidad con todos sus mazos al formato de texto.
function unitToText(unit, decksWithItems) {
  const out = ['@unit ' + unit.level + '.' + unit.number + ' ' + unit.title, 'audience: ' + (unit.audience || 'general')];
  if (unit.description) out.push('desc: ' + unit.description);
  decksWithItems.forEach(d => { out.push(''); out.push(deckToText(d, d.items).trimEnd()); });
  return out.join('\n') + '\n';
}

module.exports = { parseDeckText, deckToText, unitToText, deckCount, normalize, LEVELS, MAX_ITEMS_PER_DECK };
