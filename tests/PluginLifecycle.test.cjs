'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pluginHarness } = require('./plugin-harness.cjs');

test('installed bundle initializes in a clean vault with no Components or source files', async t => {
  const state = pluginHarness(t);
  await state.plugin.onload(); await state.plugin.onload();
  assert.equal(state.plugin.standalone, true);
  assert.ok(state.plugin.service);
  assert.equal(state.commands.length, 2);
  assert.equal(state.registrations.length, 5);
  assert.equal(state.settings.length, 1);
  assert.equal(state.ribbon.icon, 'cloud');
  assert.deepEqual([...state.views.keys()], ['feishu-sync-panel']);
  assert.ok(state.required.every(id => id === 'obsidian' || id.startsWith('node:')));
  assert.equal(state.notices.length, 0);
  assert.equal(state.plugin.scheduler.started, false);
  state.layout[0]();
  assert.equal(state.plugin.scheduler.started, true);
  assert.equal(state.plugin.scheduler.automaticAllowed(), false);
  assert.deepEqual(fs.readdirSync(state.base), []);
});

test('upgrade reads the existing path-hashed identity and associations without writing or decrypting', async t => {
  const config = { appId: 'cli_fixture', encryptedSecret: 'untouched-device-ciphertext', assigneeId: 'ou_fixture',
    vaultId: '354f02e8-d07b-4c27-b8e9-e4a7f1086297', vaultLabel: 'existing-vault', autoEnabled: false };
  const records = { version: 1, accounts: { cli_fixture: { tasks: { old: { guid: 'existing-task-guid' } }, projects: {} } } };
  const state = pluginHarness(t, { config, records });
  const before = ['config.json', 'records.json'].map(name => fs.readFileSync(path.join(state.storage, name), 'utf8'));
  await state.plugin.onload(); state.layout[0]();
  assert.equal(state.plugin.service.getConfig().vaultId, config.vaultId);
  assert.equal(state.plugin.service.getConfig().hasSecret, true);
  assert.equal(state.plugin.service.getConfig().storagePath, state.storage);
  assert.deepEqual(['config.json', 'records.json'].map(name => fs.readFileSync(path.join(state.storage, name), 'utf8')), before);
  assert.equal(state.required.includes('electron'), false);
  assert.equal(state.notices.length, 0);
});

test('open-panel command selects the current project and reuses one native view', async t => {
  const state = pluginHarness(t); await state.plugin.onload();
  state.commands.find(command => command.id === 'open-panel').callback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(state.plugin.service.getSelection().path, '50_Tasks/project.md');
  assert.equal(state.leaves.length, 1);
  await state.plugin.openPanel(undefined, undefined, 'transfer');
  assert.equal(state.leaves.length, 1);
  assert.equal(state.leaves[0].view.panelNavigation.section, 'transfer');
  await state.plugin.service.openPanel('50_Tasks/project.md');
  assert.equal(state.leaves.length, 1);
  assert.equal(state.notices.length, 0);
});

test('unload stops scheduling, removes views, and ignores a late layout callback', async t => {
  const state = pluginHarness(t); await state.plugin.onload();
  state.unload(); state.layout[0]();
  assert.equal(state.plugin.scheduler.active, false);
  assert.equal(state.plugin.disposed, true);
  assert.equal(state.events.size, 0);
  assert.deepEqual(state.detached, ['feishu-sync-panel']);
  await assert.rejects(state.plugin.openPanel(), /尚未就绪/);
});

test('first navigation waits for a deferred view before selecting the requested page', async t => {
  const state = pluginHarness(t, { deferViews: true, savedUi: { activeSection: 'notes' } });
  await state.plugin.onload();
  await state.plugin.openPanel(undefined, undefined, 'transfer');
  assert.equal(state.leaves.length, 1);
  assert.equal(state.leaves[0].view.panelNavigation.section, 'transfer');
  await state.plugin.openPanel(undefined, undefined, 'overview');
  assert.equal(state.leaves.length, 1);
  assert.equal(state.leaves[0].view.panelNavigation.section, 'overview');
});

test('unload while UI preferences load cannot register a late scheduler or view', async t => {
  let finish;
  const state = pluginHarness(t, { loadData: () => new Promise(resolve => { finish = resolve; }) });
  const loading = state.plugin.onload();
  state.unload(); finish({}); await loading;
  assert.equal(state.plugin.scheduler, undefined);
  assert.equal(state.views.size, 0);
  assert.equal(state.registrations.length, 0);
});

test('UI preferences save only navigation and cannot overwrite credentials or associations', async t => {
  const state = pluginHarness(t); await state.plugin.onload();
  await state.plugin.saveUiData({ activeSection: 'transfer', secret: 'must-not-persist', vaultId: 'must-not-persist' });
  assert.deepEqual(state.saved, [{ activeSection: 'transfer' }]);
  assert.deepEqual(fs.readdirSync(state.storage), []);
});

test('re-enabling the same plugin instance resets the disposed scheduler and opens its view', async t => {
  const state = pluginHarness(t); await state.plugin.onload();
  state.unload(); await state.plugin.onload();
  assert.equal(state.plugin.loaded, true);
  assert.equal(state.plugin.disposed, false);
  state.layout.at(-1)();
  assert.equal(state.plugin.scheduler.active, true);
  await state.plugin.openPanel();
  assert.equal(state.leaves.length, 1);
});
