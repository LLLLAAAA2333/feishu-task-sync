'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const source = transformSync(fs.readFileSync(require.resolve('../src/ui/errors.ts'), 'utf8'), { loader: 'ts', format: 'cjs' }).code;
const moduleValue = { exports: {} };
vm.runInNewContext(source, { module: moduleValue, exports: moduleValue.exports });
const { errorMessage, errorCode, transferFolders } = moduleValue.exports;

test('a malformed transfer file cannot supply non-string folder defaults to the settings form', () => {
  for (const input of [null, false, 'text', [], { config: 2 }, { config: { projectFolder: {}, dailyFolder: [] } }]) {
    assert.equal(transferFolders(input).projectFolder, '');
    assert.equal(transferFolders(input).dailyFolder, '');
  }
  const imported = transferFolders(JSON.parse('{"config":{"projectFolder":"Projects","dailyFolder":"Journal"}}'));
  assert.equal(imported.projectFolder, 'Projects');
  assert.equal(imported.dailyFolder, 'Journal');
});

test('UI error feedback preserves sync error details and accepts unexpected rejection values', () => {
  const error = Object.assign(new Error('Refresh the conflict preview'), { code: 'CONFLICT_STALE' });
  assert.equal(errorMessage(error), 'Refresh the conflict preview');
  assert.equal(errorCode(error), 'CONFLICT_STALE');
  for (const input of [null, undefined, false, 'failure', { message: {}, code: 42 }]) {
    assert.equal(errorMessage(input), '');
    assert.equal(errorCode(input), '');
  }
});
