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
  const files = unzipSync(fs.readFileSync(path.join(root, `dist/Feishu-Sync-${version}-Desktop.zip`)));
  assert.deepEqual(Object.keys(files).sort(), ['main.js', 'manifest.json', 'styles.css']);
  for (const [name, content] of Object.entries(files)) {
    assert.deepEqual(Buffer.from(content), fs.readFileSync(path.join(root, 'dist/feishu-sync', name)));
  }
});

test('install updates plugin files, preserves data and enabled list, and backs up an earlier version', t => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-install-'));
  t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
  const target = path.join(vault, '.custom/plugins/feishu-sync');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'main.js'), 'old-plugin');
  fs.writeFileSync(path.join(target, 'data.json'), '{"activeSection":"notes"}');
  fs.writeFileSync(path.join(vault, '.custom/community-plugins.json'), '["feishu-sync"]');
  execFileSync(process.execPath, ['scripts/install.mjs', vault, '.custom'], { cwd: root });
  assert.deepEqual(fs.readFileSync(path.join(target, 'main.js')), fs.readFileSync(path.join(root, 'dist/feishu-sync/main.js')));
  assert.equal(fs.readFileSync(path.join(target, 'data.json'), 'utf8'), '{"activeSection":"notes"}');
  assert.equal(fs.readFileSync(path.join(vault, '.custom/community-plugins.json'), 'utf8'), '["feishu-sync"]');
  const backups = path.join(vault, '.custom/plugin-backups/feishu-sync');
  assert.equal(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], 'main.js'), 'utf8'), 'old-plugin');
});
