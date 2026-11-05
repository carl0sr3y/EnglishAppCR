'use strict';
// Prueba de la calificación aproximada de pronunciación (no necesita base de datos).
// Uso: node test/speech.js
const S = require('../public/speech.js');
let pass = 0, fail = 0;
function t(name, got, ok) {
  if (ok) { pass++; console.log('  ok  ' + name + '  [' + got + ']'); }
  else { fail++; console.log('  FALLA ' + name + '  [' + got + ']'); }
}
const sc = (a, b) => S.scorePronunciation(a, b).score;

t('frase idéntica = 100', sc('Hello, my name is Ana.', 'hello my name is ana'), sc('Hello, my name is Ana.', 'hello my name is ana') === 100);
t('mayúsculas y puntuación no importan', sc('Nice to meet you, Tom!', 'Nice To Meet You Tom'), sc('Nice to meet you, Tom!', 'Nice To Meet You Tom') === 100);
t("contracción I'm = I am", sc("I'm a student.", 'I am a student'), sc("I'm a student.", 'I am a student') === 100);
t("isn't = is not", sc("He isn't at home.", 'he is not at home'), sc("He isn't at home.", 'he is not at home') === 100);
t('número en dígitos = en palabras', sc('I am twenty-eight years old.', 'I am 28 years old'), sc('I am twenty-eight years old.', 'I am 28 years old') === 100);
const near = S.scorePronunciation('She has a big family.', 'she has a big famili');
t('palabra casi igual (famili/family) es "close" y baja poco', near.score + ' ' + near.words.map(w => w.state).join(','), near.words[4].state === 'close' && near.score >= 85 && near.score < 100);
const miss = S.scorePronunciation('Goodbye, see you tomorrow.', 'goodbye see tomorrow');
t('palabra omitida baja la nota y se marca', miss.score + ' ' + miss.words.map(w => w.state).join(','), miss.words[2].state === 'miss' && miss.score >= 60 && miss.score <= 85);
const extra = S.scorePronunciation('Open the window, please.', 'open the big window please');
t('palabra de más penaliza un poco y se reporta', extra.score + ' extra=' + extra.extra, extra.extra.join() === 'big' && extra.score < 100 && extra.score >= 75);
t('algo totalmente distinto = nota baja', sc('Open the window, please.', 'banana table purple'), sc('Open the window, please.', 'banana table purple') < 20);
t('no oír nada = 0', sc('Hello there', ''), sc('Hello there', '') === 0);
t('el orden importa (palabras invertidas bajan)', sc('Tom is a doctor', 'doctor a is Tom'), sc('Tom is a doctor', 'doctor a is Tom') < 60);
t('repetir la frase dos veces no la regala', sc('Hello Ana', 'hello ana hello ana'), sc('Hello Ana', 'hello ana hello ana') < 100);
t('decir solo la mitad ronda el 50-70', sc('Hello my name is Ana', 'hello my name'), sc('Hello my name is Ana', 'hello my name') >= 50 && sc('Hello my name is Ana', 'hello my name') <= 70);
t('niveles: 90 Muy bien, 70 Casi, 30 Repítelo', [90, 70, 30].map(x => S.grade(x).text).join('/'), S.grade(90).text === 'Muy bien' && S.grade(70).text === 'Casi' && S.grade(30).text === 'Repítelo');
const w = S.words("Tom's house is big");
t('el posesivo de un nombre no se rompe', w.join(' '), w[0] === "tom's");
console.log('\n' + pass + ' correctas, ' + fail + ' fallidas');
process.exit(fail ? 1 : 0);
