'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { unzipSync } = require('fflate');
const root = path.resolve(__dirname, '..');

test('release ZIP contains exactly the three installable files from the independent build', () => {
  execFileSync(process.execPath, ['scripts/package.mjs'], { cwd: root });
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const files = unzipSync(fs.readFileSync(path.join(root, `dist/Feishu-Task-Sync-${version}-Desktop.zip`)));
  assert.deepEqual(Object.keys(files).sort(), ['main.js', 'manifest.json', 'styles.css']);
  for (const [name, content] of Object.entries(files)) {
    assert.deepEqual(Buffer.from(content), fs.readFileSync(path.join(root, 'dist/feishu-task-sync', name)));
  }
});

test('install updates plugin files, preserves data and enabled list, and backs up an earlier version', t => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-install-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const target = path.join(vault, '.custom/plugins/feishu-task-sync');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'main.js'), 'old-plugin');
  fs.writeFileSync(path.join(target, 'data.json'), '{"activeSection":"notes"}');
  fs.writeFileSync(path.join(vault, '.custom/community-plugins.json'), '["feishu-task-sync"]');
  execFileSync(process.execPath, ['scripts/install.mjs', vault, '.custom'], { cwd: root });
  assert.deepEqual(fs.readFileSync(path.join(target, 'main.js')), fs.readFileSync(path.join(root, 'dist/feishu-task-sync/main.js')));
  assert.equal(fs.readFileSync(path.join(target, 'data.json'), 'utf8'), '{"activeSection":"notes"}');
  assert.equal(fs.readFileSync(path.join(vault, '.custom/community-plugins.json'), 'utf8'), '["feishu-task-sync"]');
  const backups = path.join(vault, '.custom/plugin-backups/feishu-task-sync');
  assert.equal(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], 'feishu-task-sync/main.js'), 'utf8'), 'old-plugin');
});

function migrationFixture(t, { enabled = ['other-plugin', 'feishu-sync'], author = 'JH Wang', name = '飞书任务联动' } = {}) {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-rename-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const config = path.join(vault, '.obsidian');
  const legacy = path.join(config, 'plugins/feishu-sync');
  const target = path.join(config, 'plugins/feishu-task-sync');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'main.js'), 'legacy-bundle');
  fs.writeFileSync(path.join(legacy, 'manifest.json'), JSON.stringify({ id: 'feishu-sync', name, author, version: '1.4.2' }));
  fs.writeFileSync(path.join(legacy, 'data.json'), '{"activeSection":"notes"}');
  if (enabled !== null) fs.writeFileSync(path.join(config, 'community-plugins.json'), JSON.stringify(enabled));
  const read = filename => JSON.parse(fs.readFileSync(path.join(config, filename), 'utf8'));
  const install = () => JSON.parse(execFileSync(process.execPath, ['scripts/install.mjs', vault], { cwd: root, encoding: 'utf8', stdio: 'pipe' }));
  return { vault, config, legacy, target, read, install };
}

test('rename migrates enabled state, UI preferences and command shortcuts and archives the old plugin', t => {
  const f = migrationFixture(t);
  const shortcut = [{ modifiers: ['Mod', 'Shift'], key: 'F' }];
  const hotkeys = { 'feishu-sync:open-panel': shortcut, 'unrelated:command': [] };
  fs.writeFileSync(path.join(f.config, 'hotkeys.json'), JSON.stringify(hotkeys));
  const note = '- [x] Existing task <!-- feishu-task: vault/task -->\n';
  fs.writeFileSync(path.join(f.vault, 'task.md'), note);
  const result = f.install();
  assert.equal(result.migrated, true);
  assert.deepEqual(f.read('community-plugins.json'), ['other-plugin', 'feishu-task-sync']);
  assert.deepEqual(f.read('hotkeys.json'), { 'feishu-task-sync:open-panel': shortcut, 'unrelated:command': [] });
  assert.equal(fs.readFileSync(path.join(f.target, 'data.json'), 'utf8'), '{"activeSection":"notes"}');
  assert.equal(fs.existsSync(f.legacy), false);
  const backup = path.join(f.vault, result.backup);
  assert.equal(fs.readFileSync(path.join(backup, 'feishu-sync/main.js'), 'utf8'), 'legacy-bundle');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backup, 'hotkeys.json'), 'utf8')), hotkeys);
  assert.equal(fs.readFileSync(path.join(f.vault, 'task.md'), 'utf8'), note);
  assert.equal(f.install().migrated, false);
  assert.deepEqual(f.read('community-plugins.json'), ['other-plugin', 'feishu-task-sync']);
  assert.deepEqual(f.read('plugins/feishu-task-sync/data.json'), { activeSection: 'notes' });
});

test('a disabled legacy installation stays disabled after migration', t => {
  const f = migrationFixture(t, { enabled: ['other-plugin'] });
  assert.equal(f.install().migrated, true);
  assert.deepEqual(f.read('community-plugins.json'), ['other-plugin']);
});

test('migration does not invent an enabled list for a vault without one', t => {
  const f = migrationFixture(t, { enabled: null });
  assert.equal(f.install().migrated, true);
  assert.equal(fs.existsSync(path.join(f.config, 'community-plugins.json')), false);
});

test('another author using feishu-sync is left installed with its data, shortcuts and enabled state', t => {
  const f = migrationFixture(t, { author: 'another-author', name: 'Feishu Sync' });
  fs.writeFileSync(path.join(f.config, 'hotkeys.json'), '{"feishu-sync:open-panel":[]}');
  assert.equal(f.install().migrated, false);
  assert.equal(fs.readFileSync(path.join(f.legacy, 'main.js'), 'utf8'), 'legacy-bundle');
  assert.deepEqual(f.read('plugins/feishu-sync/data.json'), { activeSection: 'notes' });
  assert.equal(fs.existsSync(path.join(f.target, 'data.json')), false);
  assert.deepEqual(f.read('community-plugins.json'), ['other-plugin', 'feishu-sync']);
  assert.deepEqual(f.read('hotkeys.json'), { 'feishu-sync:open-panel': [] });
});

test('coexisting installations retain the new preferences and merge shortcut assignments once', t => {
  const f = migrationFixture(t, { enabled: ['feishu-sync', 'other-plugin', 'feishu-task-sync'] });
  fs.mkdirSync(f.target);
  fs.writeFileSync(path.join(f.target, 'data.json'), '{"activeSection":"transfer"}');
  const oldShortcut = { modifiers: ['Mod'], key: 'F' };
  const newShortcut = { modifiers: ['Mod'], key: 'T' };
  fs.writeFileSync(path.join(f.config, 'hotkeys.json'), JSON.stringify({
    'feishu-sync:sync-vault': [oldShortcut], 'feishu-task-sync:sync-vault': [newShortcut, oldShortcut],
  }));
  const result = f.install();
  assert.deepEqual(f.read('plugins/feishu-task-sync/data.json'), { activeSection: 'transfer' });
  assert.deepEqual(f.read('community-plugins.json'), ['feishu-task-sync', 'other-plugin']);
  assert.deepEqual(f.read('hotkeys.json'), { 'feishu-task-sync:sync-vault': [newShortcut, oldShortcut] });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.vault, result.backup, 'feishu-sync/data.json'), 'utf8')), { activeSection: 'notes' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.vault, result.backup, 'feishu-task-sync/data.json'), 'utf8')), { activeSection: 'transfer' });
});

test('an invalid enabled list aborts migration before changing either installation', t => {
  const f = migrationFixture(t, { enabled: { 'feishu-sync': true } });
  assert.throws(f.install, /community-plugins.json must contain an array/);
  assert.equal(fs.existsSync(f.target), false);
  assert.equal(fs.readFileSync(path.join(f.legacy, 'main.js'), 'utf8'), 'legacy-bundle');
});
