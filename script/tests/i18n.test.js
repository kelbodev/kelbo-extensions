// Traduzioni dell'estensione: cataloghi validi, chiavi usate presenti, nessun testo nel codice
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { i18nProblems } = require('kelbo/testkit');

test('traduzioni complete e coerenti', () => {
  assert.deepEqual(i18nProblems(path.join(__dirname, '..')), []);
});
