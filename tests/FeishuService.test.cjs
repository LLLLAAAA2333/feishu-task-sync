'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createService, atomicJSON } = require('../lib/feishu-service.cjs');
const md = require('../lib/feishu-markdown.cjs');
const { FeishuError, taskUrl, tasklistUrl } = require('../lib/feishu-api.cjs');

const DAILY = '20_Review/Daily/2026-10-04.md';
const PROJECT = '50_Tasks/example.md';
const LIST = 'cc371766-6584-cf50-a222-c22cd9055004';
const LOCAL_ID = 'c9660acf-510f-4316-9280-50ca2cb353c7';
const initialProject = body => '---\ntags: [project]\nstatus: doing\n---\n# 下一步行动\n' + body;
const clone = value => structuredClone(value);

test('atomic JSON flushes a writable handle and preserves old files on write, flush or replace failure', t => {
  const vm = require('node:vm');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-atomic-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'config.json');
  for (const phase of [null, 'writeFileSync', 'fsyncSync', 'renameSync']) {
    fs.writeFileSync(filename, '{"old":true}');
    const handles = new Map(); let flushes = 0;
    const wrapped = new Proxy(fs, { get(target, key) {
      if (key === 'openSync') return (name, flags, ...args) => {
        const fd = target.openSync(name, flags, ...args); handles.set(fd, flags); return fd;
      };
      if (key === 'closeSync') return fd => { handles.delete(fd); return target.closeSync(fd); };
      if (key === 'fsyncSync') return fd => {
        assert.match(handles.get(fd), /[wa+]/, 'Windows requires write access for flushing'); flushes++;
        if (phase === key) throw Object.assign(new Error('simulated EPERM'), { code: 'EPERM' });
        return target.fsyncSync(fd);
      };
      if (key === phase) return () => { throw new Error('simulated save failure'); };
      return target[key];
    } });
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve('../lib/feishu-service.cjs'), 'utf8'), {
      module, __dirname: path.join(__dirname, '../lib'), Buffer,
      require: id => id === 'node:fs' ? wrapped : require(id.startsWith('./') ? '../lib/' + id.slice(2) : id),
    });
    if (phase) {
      assert.throws(() => module.exports.atomicJSON(filename, { updated: true }), /simulated/);
      assert.equal(fs.readFileSync(filename, 'utf8'), '{"old":true}');
    } else {
      module.exports.atomicJSON(filename, { updated: true });
      assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { updated: true });
      assert.equal(flushes, 1);
    }
    assert.equal(handles.size, 0);
    assert.deepEqual(fs.readdirSync(directory), ['config.json']);
  }
});

// Only the frontmatter fields needed by these fixtures are mocked. Task parsing,
// fingerprints, per-file queues, and Markdown writes use the production helpers.
const obsidian = {
  getFrontMatterInfo(content) {
    const match = /^(?:\uFEFF)?---(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)---(?:(?:\r\n|\n|\r)|$)/.exec(content);
    return match ? { exists: true, frontmatter: match[1], contentStart: match[0].length }
      : { exists: false, frontmatter: '', contentStart: 0 };
  },
  parseYaml(content) {
    const result = {};
    for (const line of content.split(/\r\n|\n|\r/)) {
      const pair = /^([\w-]+|"feishu-project"|'feishu-project'):[ \t]*(.*)$/.exec(line);
      if (!pair) continue;
      const key = pair[1].replace(/^["']|["']$/g, '');
      const value = pair[2].replace(/[ \t]+#.*$/, '').trim();
      result[key] = value.startsWith('[') ? value.slice(1, -1).split(',').map(value => value.trim())
        : value.startsWith('"') && value.endsWith('"') ? JSON.parse(value)
        : value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
    }
    return result;
  },
};

function fixture(t, initial = { [DAILY]: '# 今日行动\n- [ ] 行动 A\n' }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-service-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = new Map();
  const calls = [];
  const events = [];
  const tasks = new Map();
  const lists = new Map([[LIST, { guid: LIST, name: '[study] 默认清单' }]]);
  const control = { clock: Date.UTC(2026, 9, 4), failRecordWrite: null, beforeProcess: null };
  function addFile(notePath, content) {
    const file = { path: notePath, basename: path.basename(notePath, '.md'), extension: 'md', content };
    files.set(notePath, file);
    return file;
  }
  for (const [notePath, content] of Object.entries(initial)) addFile(notePath, content);
  const app = {
    vault: {
      adapter: { getBasePath: () => '/unit-test/obsidian-vault' },
      getAbstractFileByPath: notePath => files.get(notePath) || null,
      getMarkdownFiles: () => [...files.values()],
      read: async file => file.content,
      process: async (file, updater) => {
        if (control.beforeProcess) await control.beforeProcess(file);
        file.content = updater(file.content);
      },
    },
    workspace: { trigger: (...args) => events.push(args) },
  };
  const implementations = {
    check: async () => ({ ok: true }),
    listTasklists: async () => [...lists.values()].map(clone),
    getTasklist: async guid => {
      if (!lists.has(guid)) throw new FeishuError('NOT_FOUND', '清单不存在');
      return clone(lists.get(guid));
    },
    createTasklist: async payload => {
      const list = { ...clone(payload), guid: crypto.randomUUID() };
      lists.set(list.guid, list);
      return clone(list);
    },
    updateTasklist: async (guid, patch) => {
      const list = lists.get(guid);
      if (!list) throw new FeishuError('NOT_FOUND', '清单不存在');
      Object.assign(list, clone(patch));
      return clone(list);
    },
    listTasks: async guid => [...tasks.values()].filter(task => task.tasklists.some(list => list.tasklist_guid === guid)).map(clone),
    getTask: async guid => {
      if (!tasks.has(guid)) throw new FeishuError('NOT_FOUND', '任务不存在');
      return clone(tasks.get(guid));
    },
    createTask: async payload => {
      const task = { ...clone(payload), guid: crypto.randomUUID() };
      tasks.set(task.guid, task);
      return clone(task);
    },
    updateTask: async (guid, patch) => {
      const task = tasks.get(guid);
      if (!task) throw new FeishuError('NOT_FOUND', '任务不存在');
      Object.assign(task, clone(patch));
      return clone(task);
    },
  };
  const hooks = {};
  const api = Object.fromEntries(Object.entries(implementations).map(([name, operation]) => [name, async (...args) => {
    calls.push([name, ...clone(args)]);
    return hooks[name] ? hooks[name](...args, operation) : operation(...args);
  }]));
  const dependencies = { directory, now: () => control.clock,
    safeStorage: () => ({
      encryptString: secret => Buffer.from(secret.split('').reverse().join('')),
      decryptString: buffer => buffer.toString().split('').reverse().join(''),
    }),
    createFeishuClient: options => { calls.push(['client', options.appId]); assert.equal(options.appSecret, 'unit-test-secret'); return api; },
    atomicJSON: (filename, value) => {
      if (filename.endsWith('records.json') && control.failRecordWrite?.(value)) throw new Error('disk full');
      atomicJSON(filename, value);
    },
  };
  const service = createService(app, obsidian, dependencies);
  const configure = () => service.saveConfig({ appId: 'cli_test', secret: 'unit-test-secret', assigneeId: 'ou_test', defaultTasklistGuid: LIST, vaultLabel: 'study' });
  const readRecordFile = () => JSON.parse(fs.readFileSync(path.join(directory, 'records.json'), 'utf8'));
  const savedRecord = id => readRecordFile().accounts.cli_test.tasks[id];
  const snapshot = async (notePath = DAILY, position = 0) => (await service.readNote(notePath)).tasks[position];
  const rename = (oldPath, newPath) => {
    const file = files.get(oldPath);
    files.delete(oldPath);
    Object.assign(file, { path: newPath, basename: path.basename(newPath, '.md') });
    files.set(newPath, file);
  };
  const count = name => calls.filter(call => call[0] === name).length;
  return { service, app, dependencies, files, calls, tasks, lists, hooks, directory, control, configure,
    snapshot, count, savedRecord, readRecordFile, rename, addFile };
}

test('an empty local setup can adopt a UUID and Windows-style relative folders', t => {
  const f = fixture(t); f.configure();
  const id = crypto.randomUUID();
  f.service.saveConfig({ vaultId: id.toUpperCase(), projectFolder: '004_Tasks\\Research' });
  assert.equal(f.service.getConfig().vaultId, id);
  assert.equal(f.service.getConfig().projectFolder, '004_Tasks/Research');
  const before = fs.readFileSync(path.join(f.directory, 'config.json'), 'utf8');
  assert.throws(() => f.service.saveConfig({ vaultId: 'invalid' }), /UUID/);
  assert.throws(() => f.service.saveConfig({ projectFolder: 'C:\\Research' }), /相对路径/);
  assert.equal(fs.readFileSync(path.join(f.directory, 'config.json'), 'utf8'), before);
  f.service.saveConfig({ autoEnabled: true });
  assert.throws(() => f.service.exportTransfer(), /关闭自动同步/);
  assert.throws(() => f.service.previewTransfer({}), /关闭自动同步/);
});

// Model a same-vault v2 action whose local history was lost. Legacy markers
// without an owner are tested separately by FeishuVaultSync.test.cjs.
function useCurrentVaultMarker(f, notePath = DAILY, id = LOCAL_ID) {
  const file = f.files.get(notePath);
  const marker = '<!-- feishu-task: ' + id + ' -->';
  assert.ok(file.content.includes(marker));
  file.content = file.content.replace(marker, '<!-- feishu-task: ' + f.service.getConfig().vaultId + '/' + id + ' -->');
}

test('issue report reads current-account task titles and project paths without network, secret decryption, or writes', async t => {
  const f = fixture(t, { [DAILY]: '# 今日行动\n- [ ] 阅读 [[资料|可读标题]] <!-- feishu-task: ' + LOCAL_ID + ' -->\n',
    [PROJECT]: initialProject('- [ ] 正常待发送行动\n') });
  f.configure();
  const projectId = crypto.randomUUID();
  const taskGuid = crypto.randomUUID(), parentGuid = crypto.randomUUID();
  const recordFile = path.join(f.directory, 'records.json');
  atomicJSON(recordFile, { version: 1, accounts: {
    cli_test: { tasks: {
      [LOCAL_ID]: { id: LOCAL_ID, path: DAILY, state: 'error', message: '任务权限不足', guid: taskGuid, url: 'https://untrusted.invalid/' },
      normal: { id: 'normal', path: DAILY, state: 'linked', message: '' },
      draft: { id: 'draft', path: DAILY, state: 'draft' },
      pending: { id: 'pending', path: DAILY, state: 'pending' },
    }, projects: { [projectId]: { id: projectId, path: PROJECT, state: 'linked', parentState: 'conflict', parentTaskGuid: parentGuid } } },
    cli_other: { tasks: { hidden: { id: 'hidden', state: 'error', message: '其他账户错误', path: DAILY } }, projects: {} },
  } });
  const before = fs.readFileSync(recordFile, 'utf8');
  const contents = [...f.files.values()].map(file => file.content);
  const forbidden = () => { throw new Error('report attempted a write, API call, or secret decryption'); };
  f.app.vault.process = forbidden;
  const service = createService(f.app, obsidian, { ...f.dependencies, safeStorage: forbidden, atomicJSON: forbidden, createFeishuClient: forbidden });
  const issues = await service.getSyncIssues();
  assert.equal(issues.length, 2);
  assert.deepEqual(issues[0], { key: 'task:' + LOCAL_ID, kind: 'task', id: LOCAL_ID, path: DAILY,
    state: 'error', message: '任务权限不足', title: '阅读 可读标题', line: 1, url: taskUrl(taskGuid) });
  assert.equal(issues[1].title, 'example');
  assert.equal(issues[1].path, PROJECT);
  assert.equal(issues[1].state, 'conflict');
  assert.equal(issues[1].url, taskUrl(parentGuid));
  assert.equal(fs.readFileSync(recordFile, 'utf8'), before);
  assert.deepEqual([...f.files.values()].map(file => file.content), contents);
  assert.equal(f.calls.length, 0);
  issues[0].message = 'external mutation';
  assert.equal((await service.getSyncIssues())[0].message, '任务权限不足');
});

test('issue titles fall back to baselines, payloads, and filenames for unreadable or deleted notes', async t => {
  const f = fixture(t); f.configure();
  f.app.vault.read = async () => { throw new Error('read failed'); };
  atomicJSON(path.join(f.directory, 'records.json'), { version: 1, accounts: { cli_test: { tasks: {
    baseline: { id: 'baseline', path: DAILY, state: 'local_missing', baseline: { summary: '原行动标题' } },
    payload: { id: 'payload', path: '50_Tasks/deleted.md', state: 'uncertain', payload: { summary: '待确认行动' }, guid: 'invalid-guid' },
    filename: { id: 'filename', path: '60_Archive/已移走项目.md', state: 'remote_missing' },
  }, projects: { legacy: { id: 'legacy', path: PROJECT, guid: LIST, state: 'retryable', name: '原项目清单' } } } } });
  const issues = await f.service.getSyncIssues();
  assert.deepEqual(issues.map(item => item.title), ['原行动标题', '待确认行动', '已移走项目', '原项目清单']);
  assert.ok(issues.every(item => item.message));
  assert.equal(issues[1].url, undefined);
  assert.equal(issues[3].url, tasklistUrl(LIST));
});

test('last-run failures deduplicate records, retain local validation errors, and do not revive resolved tasks', async t => {
  const f = fixture(t, { [PROJECT]: initialProject('- [ ] 未发送行动\n'), [DAILY]: '# 今日行动\n' }); f.configure();
  atomicJSON(path.join(f.directory, 'records.json'), { version: 1, accounts: { cli_test: { tasks: {
    failed: { id: 'failed', path: DAILY, state: 'error', message: '当前错误', baseline: { summary: '关联行动' } },
    resolved: { id: 'resolved', path: DAILY, state: 'linked', message: '' },
  }, projects: { project: { id: 'project', path: PROJECT, parentState: 'linked', message: '' } } } } });
  const failures = [
    { id: 'failed', path: DAILY, message: '旧错误' },
    { id: 'failed', path: DAILY, message: '重复旧错误' },
    { id: 'resolved', path: DAILY, message: '已解决错误' },
    { kind: 'project', path: PROJECT, message: '项目 area 必须唯一' },
    { kind: 'project', path: PROJECT, message: '项目 area 必须唯一' },
    { kind: 'task', path: PROJECT, line: 5, message: '截止时间无效' },
    { id: 'other', path: DAILY, message: '其他账号失败', appId: 'cli_other' },
  ];
  const issues = await f.service.getSyncIssues(failures);
  assert.equal(issues.length, 3);
  assert.equal(issues[0].message, '当前错误');
  assert.equal(issues[1].title, 'example');
  assert.equal(issues[1].message, '项目 area 必须唯一');
  assert.equal(issues[2].title, '未发送行动');
  assert.equal(issues[2].line, 5);
  assert.equal((await f.service.getSyncIssues(null)).length, 1);
});

test('reporting pending unsaved records never retries persistence', async t => {
  const f = fixture(t); f.configure();
  let attempts = 0;
  f.control.failRecordWrite = () => { attempts++; return true; };
  await assert.rejects(f.service.sendTask(await f.snapshot()), /记录未能保存/);
  const before = attempts;
  assert.deepEqual(await f.service.getSyncIssues(), []);
  assert.equal(attempts, before);
  assert.equal(fs.existsSync(path.join(f.directory, 'records.json')), false);
});

test('a newly identified action appears once when its failed result still has no ID', async t => {
  const f = fixture(t); f.configure();
  f.service.saveConfig({ syncDaily: true });
  f.hooks.createTask = async () => { throw new FeishuError('FORBIDDEN', '任务写入权限不足', { uncertain: false }); };
  const result = await f.service.syncVault();
  assert.ok(result.failed >= 1);
  assert.equal(result.results[0].id, null);
  const issues = await f.service.getSyncIssues(result.results);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].title, '行动 A');
  assert.equal(issues[0].id, (await f.snapshot()).id);
  assert.equal(issues[0].message, '任务写入权限不足');
});

test('a successful selected-project retry clears older path-only failures without hiding a new failure', async t => {
  const f = fixture(t, { [PROJECT]: initialProject('- [ ] 行动 A\n') }); f.configure();
  await f.service.syncVault();
  f.hooks.getTasklist = async () => { throw new Error('项目清单读取失败'); };
  const failed = await f.service.syncVault();
  assert.equal(failed.results[0].kind, 'project');
  assert.ok(Number.isInteger(failed.results[0].revision));
  assert.equal((await f.service.getSyncIssues(failed.results)).filter(issue => issue.kind === 'project').length, 1);
  delete f.hooks.getTasklist;
  await f.service.syncVault({ paths: [PROJECT] });
  assert.deepEqual(await f.service.getSyncIssues(failed.results), []);
  f.hooks.getTasklist = async () => { throw new Error('新项目清单读取失败'); };
  const latest = await f.service.syncVault();
  const issues = await f.service.getSyncIssues(latest.results);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].message, '新项目清单读取失败');
});

test('an account switch during note reads discards the prior account report', async t => {
  const f = fixture(t); f.configure();
  atomicJSON(path.join(f.directory, 'records.json'), { version: 1, accounts: { cli_test: { tasks: {
    old: { id: 'old', path: DAILY, state: 'error', message: '前账号异常' },
  }, projects: {} } } });
  f.app.vault.read = async file => {
    f.service.saveConfig({ appId: 'cli_next', secret: 'unit-test-secret' });
    return file.content;
  };
  assert.deepEqual(await f.service.getSyncIssues(), []);
});

test('configuration encrypts secrets outside vault and excludes them from public configuration', t => {
  const f = fixture(t);
  assert.equal(f.service.getConfig().hasSecret, false);
  f.configure();
  const stored = fs.readFileSync(path.join(f.directory, 'config.json'), 'utf8');
  assert.doesNotMatch(stored, /unit-test-secret/);
  const publicConfig = f.service.getConfig();
  assert.equal(publicConfig.hasSecret, true);
  assert.equal(publicConfig.secret, undefined);
  assert.equal(publicConfig.encryptedSecret, undefined);
  assert.equal(publicConfig.storagePath, f.directory);
  assert.equal(fs.statSync(path.join(f.directory, 'config.json')).mode & 0o777, 0o600);
  f.service.saveConfig({ appId: 'cli_test', secret: '', assigneeId: 'ou_test', defaultTasklistGuid: LIST });
  assert.equal(f.service.getConfig().hasSecret, true);
  assert.equal(f.files.size, 1);
  assert.equal(f.count('createTask'), 0);
});

test('single and batch send reject missing credentials before changing any Markdown', async t => {
  const content = initialProject('- [ ] 行动 A\n- [ ] 行动 B\n');
  const f = fixture(t, { [PROJECT]: content });
  await assert.rejects(f.service.sendTask(await f.snapshot(PROJECT)), /配置/);
  assert.equal(f.files.get(PROJECT).content, content);
  await assert.rejects(f.service.sendProject(PROJECT), /配置/);
  assert.equal(f.files.get(PROJECT).content, content);
  assert.equal(f.count('createTask'), 0);
  assert.equal(f.count('createTasklist'), 0);
});

test('sending the same action twice creates only one remote task and retains its stable ID', async t => {
  const f = fixture(t);
  f.configure();
  const first = await f.service.sendTask(await f.snapshot());
  assert.equal(first.state, 'linked');
  const second = await f.service.sendTask(await f.snapshot());
  assert.equal(second.id, first.id);
  assert.equal(second.guid, first.guid);
  assert.equal(f.count('createTask'), 1);
  assert.equal(f.tasks.get(first.guid).mode, 2);
  assert.deepEqual(f.tasks.get(first.guid).members, [{ id: 'ou_test', type: 'user', role: 'assignee' }]);
});

test('title edits, task reordering, and note renames keep the same remote task', async t => {
  const f = fixture(t, { [DAILY]: '# 今日行动\n- [ ] 行动 A\n- [ ] 行动 B\n' });
  f.configure();
  const first = await f.service.sendTask(await f.snapshot());
  const file = f.files.get(DAILY);
  const line = file.content.split('\n').find(value => value.includes(first.id));
  file.content = '# 今日行动\n- [ ] 行动 B\n' + line.replace('行动 A', '改名后行动') + '\n';
  const newPath = '20_Review/Daily/renamed.md';
  f.rename(DAILY, newPath);
  await f.service.syncAll(newPath);
  assert.equal(f.tasks.get(first.guid).summary, '改名后行动');
  assert.equal(f.tasks.get(first.guid).description, 'Obsidian 来源：renamed');
  assert.equal(f.savedRecord(first.id).path, newPath);
  assert.equal(f.count('createTask'), 1);
});

test('identification preserves CRLF, comments, block IDs, fenced code, and frontmatter exactly', async t => {
  const content = [
    '---', 'tags: [review]', 'status: doing', '---', '# 今日行动',
    '```markdown', '- [ ] 代码示例', '```', '<!--', '- [ ] 隐藏示例', '-->',
    '  2) [ ] 阅读 [[资料|材料]] <!-- 保留备注 --> ^existing-block', '',
  ].join('\r\n');
  const f = fixture(t, { [DAILY]: content });
  f.configure();
  const before = await f.snapshot();
  assert.match(before.text, /^阅读 \[\[资料\|材料\]\][ \t]+\^existing-block$/);
  const record = await f.service.sendTask(before);
  const changed = f.files.get(DAILY).content;
  assert.match(changed, /<!-- 保留备注 --> <!-- feishu-task: [a-f0-9-]+\/[a-f0-9-]+ --> \^existing-block\r\n/);
  assert.equal(changed.replace(/ <!-- feishu-task: [a-f0-9-]+\/[a-f0-9-]+ -->/, ''), content);
  assert.equal(f.tasks.get(record.guid).summary, '阅读 材料');
  f.tasks.get(record.guid).completed_at = String(f.control.clock);
  await f.service.syncTask(record.id);
  assert.equal(f.files.get(DAILY).content.replace(/ <!-- feishu-task: [a-f0-9-]+\/[a-f0-9-]+ -->/, ''), content.replace('2) [ ]', '2) [x]'));
});

test('remote completion and reopening update only the original checkbox', async t => {
  const f = fixture(t, { [DAILY]: '# 今日行动\n- [ ] 行动 A\n- [ ] 保持不变\n' });
  f.configure();
  const record = await f.service.sendTask(await f.snapshot());
  f.tasks.get(record.guid).completed_at = String(f.control.clock);
  await f.service.syncTask(record.id);
  assert.equal((await f.snapshot()).done, true);
  assert.equal((await f.snapshot(DAILY, 1)).done, false);
  f.tasks.get(record.guid).completed_at = '0';
  await f.service.syncTask(record.id);
  assert.equal((await f.snapshot()).done, false);
  assert.equal(f.count('updateTask'), 0);
});

test('local completion and reopening patch the same remote task without changing project lifecycle', async t => {
  const f = fixture(t, { [PROJECT]: initialProject('- [ ] 行动 A\n') });
  f.configure();
  const record = await f.service.sendTask(await f.snapshot(PROJECT));
  f.files.get(PROJECT).content = f.files.get(PROJECT).content.replace('- [ ] 行动 A', '- [x] 行动 A');
  await f.service.syncTask(record.id);
  assert.notEqual(f.tasks.get(record.guid).completed_at, '0');
  f.files.get(PROJECT).content = f.files.get(PROJECT).content.replace('- [x] 行动 A', '- [ ] 行动 A');
  await f.service.syncTask(record.id);
  assert.equal(f.tasks.get(record.guid).completed_at, '0');
  assert.match(f.files.get(PROJECT).content, /status: doing/);
  assert.equal(f.count('createTask'), 1);
  assert.equal(f.count('createTasklist'), 1);
});

test('both sides changing completion state produce a conflict until explicitly resolved', async t => {
  const f = fixture(t, { [DAILY]: '# 今日行动\n- [x] 已完成行动\n' });
  f.configure();
  const record = await f.service.sendTask(await f.snapshot());
  f.files.get(DAILY).content = f.files.get(DAILY).content.replace('- [x]', '- [ ]');
  f.tasks.get(record.guid).completed_at = String(f.control.clock + 1000);
  await assert.rejects(f.service.syncTask(record.id), /两边|冲突/);
  assert.equal(f.savedRecord(record.id).state, 'conflict');
  assert.equal((await f.snapshot()).done, false);
  assert.equal(f.count('updateTask'), 0);
  await f.service.syncTask(record.id, { resolution: 'local' });
  assert.equal(f.tasks.get(record.guid).completed_at, '0');
  assert.equal(f.savedRecord(record.id).state, 'linked');
});

test('local edit while a detail request is in flight is preserved without remote overwrite', async t => {
  const f = fixture(t);
  f.configure();
  const record = await f.service.sendTask(await f.snapshot());
  f.tasks.get(record.guid).completed_at = String(f.control.clock);
  f.hooks.getTask = async (guid, operation) => {
    f.files.get(DAILY).content = f.files.get(DAILY).content.replace('行动 A', '用户刚刚改的标题');
    delete f.hooks.getTask;
    return operation(guid);
  };
  await assert.rejects(f.service.syncTask(record.id), /修改|变化/);
  assert.match(f.files.get(DAILY).content, /- \[ \] 用户刚刚改的标题/);
  assert.equal(f.count('updateTask'), 0);
});

test('local edit during remote patch prevents stale checkbox writes', async t => {
  const f = fixture(t);
  f.configure();
  const record = await f.service.sendTask(await f.snapshot());
  f.tasks.get(record.guid).summary = '远端旧标题';
  f.tasks.get(record.guid).completed_at = String(f.control.clock);
  f.hooks.updateTask = async (guid, patch, operation) => {
    const result = await operation(guid, patch);
    f.files.get(DAILY).content = f.files.get(DAILY).content.replace('行动 A', '用户在请求中修改');
    return result;
  };
  await assert.rejects(f.service.syncTask(record.id), /修改|变化/);
  assert.match(f.files.get(DAILY).content, /- \[ \] 用户在请求中修改/);
});

test('missing remote task, permission failure, and absent completion state never mark a task complete', async t => {
  const f = fixture(t);
  f.configure();
  const record = await f.service.sendTask(await f.snapshot());
  for (const failure of [
    new FeishuError('NOT_FOUND', '任务不存在'),
    new FeishuError('PERMISSION_DENIED', '无权访问'),
    { ...clone(f.tasks.get(record.guid)), completed_at: undefined },
  ]) {
    f.hooks.getTask = async () => { if (failure instanceof Error) throw failure; return clone(failure); };
    await assert.rejects(f.service.syncTask(record.id));
    assert.equal((await f.snapshot()).done, false);
  }
  assert.equal(f.count('updateTask'), 0);
});

test('uncertain create recovers by stable extra instead of issuing a second create', async t => {
  const f = fixture(t);
  f.configure();
  f.hooks.createTask = async (payload, operation) => {
    await operation(payload);
    throw new FeishuError('NETWORK_ERROR', '网络断开', { uncertain: true });
  };
  await assert.rejects(f.service.sendTask(await f.snapshot()), /网络断开/);
  const id = (await f.snapshot()).id;
  assert.equal(f.savedRecord(id).state, 'uncertain');
  f.control.clock += 6 * 60 * 1000;
  delete f.hooks.createTask;
  await f.service.syncTask(id);
  assert.equal(f.savedRecord(id).state, 'linked');
  assert.equal(f.count('createTask'), 1);
  assert.equal(f.tasks.size, 1);
});

test('uncertain create with no match is never recreated after five minutes and can recover by GUID', async t => {
  const f = fixture(t);
  f.configure();
  f.hooks.createTask = async () => { throw new FeishuError('TIMEOUT', '超时', { uncertain: true }); };
  await assert.rejects(f.service.sendTask(await f.snapshot()), /超时/);
  const id = (await f.snapshot()).id;
  const pending = f.savedRecord(id);
  f.control.clock += 6 * 60 * 1000;
  delete f.hooks.createTask;
  await assert.rejects(f.service.sendTask(await f.snapshot()), /待确认|尚未|恢复/);
  assert.equal(f.count('createTask'), 1);
  const guid = crypto.randomUUID();
  f.tasks.set(guid, { ...clone(pending.payload), guid });
  f.hooks.listTasks = async () => [];
  await f.service.recoverTask(id, guid);
  assert.equal(f.savedRecord(id).guid, guid);
  assert.equal(f.savedRecord(id).state, 'linked');
  assert.equal(f.count('createTask'), 1);
});

test('task recovery rejects a GUID whose stable extra belongs to a different action', async t => {
  const f = fixture(t);
  f.configure();
  f.hooks.createTask = async () => { throw new FeishuError('TIMEOUT', '超时', { uncertain: true }); };
  await assert.rejects(f.service.sendTask(await f.snapshot()));
  const id = (await f.snapshot()).id;
  const guid = crypto.randomUUID();
  f.tasks.set(guid, { ...clone(f.savedRecord(id).payload), guid, extra: JSON.stringify({ source: 'obsidian-feishu-sync', version: 2, vaultId: f.service.getConfig().vaultId, id: LOCAL_ID }) });
  await assert.rejects(f.service.recoverTask(id, guid), /不匹配/);
  assert.equal(f.savedRecord(id).guid, undefined);
});

test('uncertain project list creation requires binding, and draft action can then be sent once', async t => {
  const f = fixture(t, { [PROJECT]: initialProject('- [ ] 行动 A\n') });
  f.configure();
  let createdGuid;
  f.hooks.createTasklist = async (payload, operation) => {
    createdGuid = (await operation(payload)).guid;
    throw new FeishuError('TIMEOUT', '清单创建超时', { uncertain: true });
  };
  await assert.rejects(f.service.sendTask(await f.snapshot(PROJECT)), /超时/);
  assert.equal(f.count('createTask'), 0);
  f.control.clock += 6 * 60 * 1000;
  await assert.rejects(f.service.sendTask(await f.snapshot(PROJECT)), /绑定|恢复/);
  assert.equal(f.count('createTasklist'), 1);
  await f.service.bindTasklist(PROJECT, createdGuid);
  const record = await f.service.sendTask(await f.snapshot(PROJECT));
  assert.equal(record.state, 'linked');
  assert.equal(f.count('createTask'), 1);
  assert.equal(f.count('createTasklist'), 1);
});

test('explicit list rejection is retryable because no remote list was created', async t => {
  const f = fixture(t, { [PROJECT]: initialProject('- [ ] 行动 A\n') });
  f.configure();
  f.hooks.createTasklist = async () => { throw new FeishuError('PERMISSION_DENIED', '无清单写入权限'); };
  await assert.rejects(f.service.sendTask(await f.snapshot(PROJECT)), /权限/);
  const projectId = md.projectId(f.files.get(PROJECT).content, obsidian);
  assert.equal(f.readRecordFile().accounts.cli_test.projects[projectId].state, 'retryable');
  delete f.hooks.createTasklist;
  const record = await f.service.sendTask(await f.snapshot(PROJECT));
  assert.equal(record.state, 'linked');
  assert.equal(f.count('createTasklist'), 2);
  assert.equal(f.count('createTask'), 1);
});

test('failed local preflight leaves a draft that can retry without losing its identity', async t => {
  const f = fixture(t);
  f.configure();
  f.hooks.getTasklist = async () => { throw new FeishuError('PERMISSION_DENIED', '没有清单权限'); };
  await assert.rejects(f.service.sendTask(await f.snapshot()), /权限/);
  const id = (await f.snapshot()).id;
  assert.ok(id);
  assert.equal(f.count('createTask'), 0);
  delete f.hooks.getTasklist;
  const record = await f.service.sendTask(await f.snapshot());
  assert.equal(record.id, id);
  assert.equal(record.state, 'linked');
  assert.equal(f.count('createTask'), 1);
});

test('disk failure after creation preserves the returned remote GUID and avoids a duplicate', async t => {
  const f = fixture(t);
  f.configure();
  f.control.failRecordWrite = value => Object.values(value.accounts.cli_test?.tasks || {}).some(record => record.guid);
  const error = await f.service.sendTask(await f.snapshot()).then(() => assert.fail('disk error expected'), value => value);
  assert.equal(f.tasks.size, 1);
  const id = md.tasks(f.files.get(DAILY).content, DAILY)[0].id;
  f.control.failRecordWrite = null;
  await f.service.syncTask(id);
  assert.equal(f.savedRecord(id).guid, [...f.tasks.keys()][0]);
  assert.equal(f.count('createTask'), 1);
  assert.match(error.message, /保存|存储/);
});

test('existing marker without local records never creates a new remote task', async t => {
  const f = fixture(t, { [DAILY]: '# 今日行动\n- [ ] 行动 A <!-- feishu-task: ' + LOCAL_ID + ' -->\n' });
  f.configure();
  useCurrentVaultMarker(f);
  await assert.rejects(f.service.sendTask(await f.snapshot()), /恢复|未找到|待确认/);
  assert.equal(f.count('createTask'), 0);
  assert.equal((await f.snapshot()).id, LOCAL_ID);
});

test('copied action markers fail before any write, including copies in archive notes', async t => {
  const f = fixture(t);
  f.configure();
  const record = await f.service.sendTask(await f.snapshot());
  f.addFile('60_Archive/copied.md', f.files.get(DAILY).content);
  const before = f.count('updateTask');
  await assert.rejects(f.service.syncTask(record.id), /重复/);
  assert.equal(f.count('updateTask'), before);
  assert.equal(f.count('createTask'), 1);
});

test('batch sends ordinary unfinished actions under nested next-action headings only', async t => {
  const body = '- [ ] 行动 A\n### 细分\n  - [ ] 行动 B\n- [x] 已完成\n- [-] 已取消\n'
    + '```markdown\n- [ ] 代码示例\n```\n# 完成标准\n- [ ] 不发送的标准\n';
  const f = fixture(t, { [PROJECT]: initialProject(body) });
  f.configure();
  const result = await f.service.sendProject(PROJECT);
  assert.equal(result.synced, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual([...f.tasks.values()].map(task => task.summary), ['行动 A', '行动 B']);
  assert.match(f.files.get(PROJECT).content, /status: doing/);
  assert.equal(f.count('createTasklist'), 1);
  const second = await f.service.sendProject(PROJECT);
  assert.equal(second.synced, 2);
  assert.equal(f.count('createTask'), 2);
});

test('project identity survives CRLF and note rename without creating a second list', async t => {
  const f = fixture(t, { [PROJECT]: initialProject('- [ ] 行动 A\n- [ ] 行动 B\n').replace(/\n/g, '\r\n') });
  f.configure();
  await f.service.sendTask(await f.snapshot(PROJECT));
  const newPath = '50_Tasks/renamed-project.md';
  f.rename(PROJECT, newPath);
  await f.service.sendTask(await f.snapshot(newPath, 1));
  assert.equal(f.count('createTasklist'), 1);
  assert.equal(f.count('createTask'), 2);
  assert.match(f.files.get(newPath).content, /^---\r\n/);
  assert.doesNotMatch(f.files.get(newPath).content, /(?<!\r)\n/);
});

test('a copied project ID rejects new action delivery instead of linking a second note', async t => {
  const f = fixture(t, { [PROJECT]: initialProject('- [ ] 行动 A\n- [ ] 行动 B\n') });
  f.configure();
  await f.service.sendTask(await f.snapshot(PROJECT));
  const copy = f.files.get(PROJECT).content.replace(/^.*feishu-task.*\n/m, '');
  f.addFile('50_Tasks/copy.md', copy);
  await assert.rejects(f.service.sendTask(await f.snapshot(PROJECT, 1)), /重复/);
  assert.equal(f.count('createTasklist'), 1);
  assert.equal(f.count('createTask'), 1);
});

test('incomplete recovery listings never justify creating another task', async t => {
  const f = fixture(t);
  f.configure();
  f.hooks.createTask = async () => { throw new FeishuError('TIMEOUT', '创建超时', { uncertain: true }); };
  await assert.rejects(f.service.sendTask(await f.snapshot()));
  const id = (await f.snapshot()).id;
  f.hooks.listTasks = async () => { throw new FeishuError('INVALID_PAGINATION', '分页不完整'); };
  await assert.rejects(f.service.syncTask(id), /分页/);
  assert.equal(f.count('createTask'), 1);
  assert.equal((await f.snapshot()).done, false);
});

test('uncertain patch is reconciled before retrying so completion is not submitted twice', async t => {
  const f = fixture(t);
  f.configure();
  const record = await f.service.sendTask(await f.snapshot());
  f.files.get(DAILY).content = f.files.get(DAILY).content.replace('- [ ]', '- [x]');
  f.hooks.updateTask = async (guid, patch, operation) => {
    await operation(guid, patch);
    throw new FeishuError('NETWORK_ERROR', '更新结果未知', { uncertain: true });
  };
  await assert.rejects(f.service.syncTask(record.id), /未知/);
  assert.ok(f.savedRecord(record.id).pending);
  delete f.hooks.updateTask;
  await f.service.syncTask(record.id);
  assert.equal(f.count('updateTask'), 1);
  assert.equal(f.savedRecord(record.id).state, 'linked');
  assert.equal(f.savedRecord(record.id).pending, null);
});

test('restart after failed ID persistence recovers the created task through its saved intent', async t => {
  const f = fixture(t);
  f.configure();
  f.control.failRecordWrite = value => Object.values(value.accounts.cli_test?.tasks || {}).some(record => record.guid);
  await assert.rejects(f.service.sendTask(await f.snapshot()));
  const id = md.tasks(f.files.get(DAILY).content, DAILY)[0].id;
  assert.equal(f.savedRecord(id).state, 'creating');
  f.control.failRecordWrite = null;
  const restarted = createService(f.app, obsidian, f.dependencies);
  await restarted.syncTask(id);
  assert.equal(f.savedRecord(id).guid, [...f.tasks.keys()][0]);
  assert.equal(f.count('createTask'), 1);
});

test('definitively rejected task creation can retry its draft after permissions are fixed', async t => {
  const f = fixture(t);
  f.configure();
  f.hooks.createTask = async () => { throw new FeishuError('PERMISSION_DENIED', '任务写入权限不足'); };
  await assert.rejects(f.service.sendTask(await f.snapshot()), /权限/);
  const id = (await f.snapshot()).id;
  assert.equal(f.savedRecord(id).state, 'draft');
  delete f.hooks.createTask;
  await f.service.sendTask(await f.snapshot());
  assert.equal(f.savedRecord(id).state, 'linked');
  assert.equal(f.tasks.size, 1);
  assert.equal(f.count('createTask'), 2);
});

test('new actions inherit project createTime and daily dates, with deadline mode preserved', async t => {
  const content = initialProject('- [ ] 项目行动\n').replace('status: doing\n', 'status: doing\ncreateTime: "2026-10-04 21:18"\n');
  const f = fixture(t, { [PROJECT]: content, [DAILY]: '# 今日行动\n- [ ] 日记行动\n- [ ] 有截止时间的行动\n' }); f.configure();
  const project = await f.service.sendTask(await f.snapshot(PROJECT));
  assert.deepEqual(f.tasks.get(project.guid).start, { timestamp: String(Date.UTC(2026, 9, 4, 13, 18)), is_all_day: false });
  assert.match(f.files.get(PROJECT).content, /createTime: "2026-10-04 21:18"/);
  const daily = await f.service.sendTask(await f.snapshot());
  assert.deepEqual(f.tasks.get(daily.guid).start, { timestamp: String(Date.UTC(2026, 9, 4)), is_all_day: true });
  const timed = await f.service.sendTask(await f.snapshot(DAILY, 1), { due: f.control.clock + 3600000 });
  assert.deepEqual(f.tasks.get(timed.guid).start, { timestamp: String(Date.UTC(2026, 9, 3, 16)), is_all_day: false });
});

test('existing actions backfill missing starts once and preserve a manually set remote start', async t => {
  const f = fixture(t); f.configure();
  const record = await f.service.sendTask(await f.snapshot());
  const remote = f.tasks.get(record.guid); delete remote.start;
  await f.service.syncTask(record.id);
  assert.equal(f.count('createTask'), 1);
  assert.equal(f.count('updateTask'), 1);
  assert.deepEqual(f.calls.find(call => call[0] === 'updateTask')[2], {
    start: { timestamp: String(Date.UTC(2026, 9, 4)), is_all_day: true },
  });
  await f.service.syncTask(record.id);
  assert.equal(f.count('updateTask'), 1);
  remote.start = { timestamp: String(Date.UTC(2026, 9, 5, 10)), is_all_day: false };
  await f.service.syncTask(record.id);
  assert.equal(f.count('updateTask'), 1);
  assert.deepEqual(remote.start, { timestamp: String(Date.UTC(2026, 9, 5, 10)), is_all_day: false });
});

test('an uncertain backfill recovers after restart without repeating a successful update', async t => {
  const f = fixture(t); f.configure();
  const record = await f.service.sendTask(await f.snapshot()); delete f.tasks.get(record.guid).start;
  f.hooks.updateTask = async (guid, patch, operation) => {
    await operation(guid, patch); throw new FeishuError('TIMEOUT', '测试超时', { uncertain: true });
  };
  await assert.rejects(f.service.syncTask(record.id), /超时/);
  delete f.hooks.updateTask;
  const restarted = createService(f.app, obsidian, f.dependencies);
  assert.equal((await restarted.syncTask(record.id)).state, 'linked');
  assert.equal(f.count('updateTask'), 1);
  assert.equal(f.count('createTask'), 1);
});

test('invalid project creation time or start after due causes no note or remote writes', async t => {
  const content = initialProject('- [ ] 行动\n').replace('status: doing\n', 'status: doing\ncreateTime: "2026-02-30 21:18"\n');
  const f = fixture(t, { [PROJECT]: content }); f.configure();
  await assert.rejects(f.service.sendTask(await f.snapshot(PROJECT)), /createTime/);
  await assert.rejects(f.service.sendProject(PROJECT), /createTime/);
  assert.equal(f.files.get(PROJECT).content, content);
  assert.equal(f.count('createTasklist'), 0); assert.equal(f.count('createTask'), 0);
  f.files.get(PROJECT).content = content.replace('2026-02-30 21:18', '2026-10-05 21:18');
  const validContent = f.files.get(PROJECT).content;
  await assert.rejects(f.service.sendTask(await f.snapshot(PROJECT), { due: f.control.clock + 3600000 }), /开始时间不能晚于截止时间/);
  assert.equal(f.files.get(PROJECT).content, validContent);
  assert.equal(f.count('createTasklist'), 0); assert.equal(f.count('createTask'), 0);
});

test('invalid due time or reminder is rejected before adding an action marker or making requests', async t => {
  const f = fixture(t);
  f.configure();
  const original = f.files.get(DAILY).content;
  for (const options of [{ due: f.control.clock - 1 }, { reminderMinutes: 5 }, { due: f.control.clock + 3600000, reminderMinutes: -1 }]) {
    await assert.rejects(f.service.sendTask(await f.snapshot(), options), /截止时间|提醒/);
    assert.equal(f.files.get(DAILY).content, original);
  }
  assert.equal(f.count('getTasklist'), 0);
  assert.equal(f.count('createTask'), 0);
  const due = f.control.clock + 3600000;
  const record = await f.service.sendTask(await f.snapshot(), { due, reminderMinutes: 30 });
  assert.deepEqual(f.tasks.get(record.guid).due, { timestamp: String(due), is_all_day: false });
  assert.deepEqual(f.tasks.get(record.guid).reminders, [{ relative_fire_minute: 30 }]);
});

test('corrupt records block sending before mutating the note or writing remotely', async t => {
  const f = fixture(t);
  f.configure();
  const snapshot = await f.snapshot();
  const original = f.files.get(DAILY).content;
  for (const content of ['{broken', 'null', '[]', '{"version":2,"accounts":{}}']) {
    fs.writeFileSync(path.join(f.directory, 'records.json'), content);
    await assert.rejects(f.service.sendTask(snapshot), /损坏|格式/);
    assert.equal(f.files.get(DAILY).content, original);
    assert.equal(f.count('createTask'), 0);
  }
});

test('changing a remote task to joint completion stops automatic synchronization', async t => {
  const f = fixture(t);
  f.configure();
  const record = await f.service.sendTask(await f.snapshot());
  f.tasks.get(record.guid).mode = 1;
  f.files.get(DAILY).content = f.files.get(DAILY).content.replace('- [ ]', '- [x]');
  await assert.rejects(f.service.syncTask(record.id), /会签/);
  assert.equal(f.tasks.get(record.guid).completed_at, '0');
  assert.equal(f.count('updateTask'), 0);
});

test('a project marker example inside fenced code cannot claim the real project identity', async t => {
  const content = initialProject('- [ ] 行动 A\n# 示例\n```markdown\n<!-- feishu-project: ' + LOCAL_ID + ' -->\n```\n');
  const f = fixture(t, { [PROJECT]: content });
  f.configure();
  const record = await f.service.sendTask(await f.snapshot(PROJECT));
  assert.equal(record.state, 'linked');
  assert.notEqual(md.projectId(f.files.get(PROJECT).content, obsidian), LOCAL_ID);
  assert.match(f.files.get(PROJECT).content, new RegExp('```markdown\\n<!-- feishu-project: ' + LOCAL_ID + ' -->\\n```'));
  assert.equal(f.count('createTasklist'), 1);
});

test('lost history with different completion states requires explicit resolution and never silently reopens local work', async t => {
  for (const resolution of ['local', 'remote']) {
    const f = fixture(t, { [DAILY]: '# 今日行动\n- [x] 行动 A <!-- feishu-task: ' + LOCAL_ID + ' -->\n' });
    f.configure();
    useCurrentVaultMarker(f);
    const guid = crypto.randomUUID();
    f.tasks.set(guid, { guid, summary: '行动 A', description: 'Obsidian 来源：2026-10-04', completed_at: '0', mode: 2,
      extra: JSON.stringify({ source: 'obsidian-feishu-sync', version: 2, vaultId: f.service.getConfig().vaultId, id: LOCAL_ID }), tasklists: [{ tasklist_guid: LIST }] });
    await assert.rejects(f.service.sendTask(await f.snapshot()), /历史|选择/);
    let record = f.savedRecord(LOCAL_ID);
    assert.equal(record.guid, guid);
    assert.equal(record.state, 'conflict');
    assert.equal(record.needsChoice, true);
    await assert.rejects(f.service.syncTask(LOCAL_ID), /历史|选择/);
    await assert.rejects(f.service.sendTask(await f.snapshot()), /历史|选择/);
    assert.equal((await f.snapshot()).done, true);
    assert.equal(f.tasks.get(guid).completed_at, '0');
    assert.equal(f.count('updateTask'), 0);
    assert.equal(f.count('createTask'), 0);
    await f.service.syncTask(LOCAL_ID, { resolution });
    record = f.savedRecord(LOCAL_ID);
    assert.equal(record.state, 'linked');
    assert.equal(record.needsChoice, false);
    assert.equal((await f.snapshot()).done, resolution === 'local');
    assert.equal(f.tasks.get(guid).completed_at !== '0', resolution === 'local');
    await f.service.syncTask(LOCAL_ID);
    assert.equal(f.count('createTask'), 0);
  }
});

test('lost history with equal completion states establishes a remote baseline without forcing a choice', async t => {
  for (const done of [true, false]) {
    const f = fixture(t, { [DAILY]: '# 今日行动\n- [' + (done ? 'x' : ' ') + '] 行动 A <!-- feishu-task: ' + LOCAL_ID + ' -->\n' });
    f.configure();
    useCurrentVaultMarker(f);
    const guid = crypto.randomUUID();
    const completedAt = done ? String(f.control.clock - 86400000) : '0';
    f.tasks.set(guid, { guid, summary: '行动 A', description: 'Obsidian 来源：2026-10-04', completed_at: completedAt, mode: 2,
      extra: JSON.stringify({ source: 'obsidian-feishu-sync', version: 2, vaultId: f.service.getConfig().vaultId, id: LOCAL_ID }), tasklists: [{ tasklist_guid: LIST }] });
    const record = await f.service.sendTask(await f.snapshot());
    assert.equal(record.state, 'linked');
    assert.equal(record.needsChoice, false);
    assert.equal(record.baseline.done, done);
    assert.equal(record.baseline.completedAt, completedAt);
    await f.service.syncTask(LOCAL_ID);
    assert.equal((await f.snapshot()).done, done);
    assert.equal(f.tasks.get(guid).completed_at, completedAt);
    assert.deepEqual(f.calls.filter(call => call[0] === 'updateTask').map(call => call[2]), [
      { start: { timestamp: String(Date.UTC(2026, 9, 4)), is_all_day: true } },
    ]);
    assert.equal(f.count('createTask'), 0);
  }
});

test('GUID recovery with lost history also leaves differing states untouched until a choice is made', async t => {
  const f = fixture(t, { [DAILY]: '# 今日行动\n- [x] 行动 A <!-- feishu-task: ' + LOCAL_ID + ' -->\n' });
  f.configure();
  useCurrentVaultMarker(f);
  await assert.rejects(f.service.sendTask(await f.snapshot()), /未找到|待确认/);
  const guid = crypto.randomUUID();
  f.tasks.set(guid, { guid, summary: '行动 A', description: 'Obsidian 来源：2026-10-04', completed_at: '0', mode: 2,
    extra: JSON.stringify({ source: 'obsidian-feishu-sync', version: 2, vaultId: f.service.getConfig().vaultId, id: LOCAL_ID }), tasklists: [{ tasklist_guid: LIST }] });
  const recovered = await f.service.recoverTask(LOCAL_ID, guid);
  assert.equal(recovered.state, 'conflict');
  assert.equal(recovered.needsChoice, true);
  await assert.rejects(f.service.syncTask(LOCAL_ID), /历史|选择/);
  assert.equal((await f.snapshot()).done, true);
  assert.equal(f.count('updateTask'), 0);
  assert.equal(f.count('createTask'), 0);
});

test('an expired unsent draft can retry with a new due date or with its old reminder removed', async t => {
  for (const replaceWithDue of [true, false]) {
    const f = fixture(t);
    f.configure();
    f.hooks.createTask = async () => { throw new FeishuError('PERMISSION_DENIED', '权限不足'); };
    const oldDue = f.control.clock + 60000;
    await assert.rejects(f.service.sendTask(await f.snapshot(), { due: oldDue, reminderMinutes: 5 }), /权限/);
    const id = (await f.snapshot()).id;
    f.control.clock += 120000;
    delete f.hooks.createTask;
    await assert.rejects(f.service.syncTask(id), /截止时间/);
    assert.equal(f.savedRecord(id).state, 'draft');
    assert.equal(f.count('createTask'), 1);
    const newDue = f.control.clock + 3600000;
    const record = replaceWithDue
      ? await f.service.sendTask(await f.snapshot(), { due: newDue, reminderMinutes: 10 })
      : await f.service.sendTask(await f.snapshot());
    assert.equal(record.id, id);
    assert.equal(record.state, 'linked');
    const remote = f.tasks.get(record.guid);
    if (replaceWithDue) {
      assert.deepEqual(remote.due, { timestamp: String(newDue), is_all_day: false });
      assert.deepEqual(remote.reminders, [{ relative_fire_minute: 10 }]);
    } else {
      assert.equal(remote.due, undefined);
      assert.equal(remote.reminders, undefined);
    }
    assert.equal(f.count('createTask'), 2);
    assert.equal(f.tasks.size, 1);
  }
});

test('project markers inside code, an outer HTML comment, or YAML are examples rather than identities', () => {
  const marker = '<!-- feishu-project: ' + LOCAL_ID + ' -->';
  for (const content of [
    '# 示例\n```markdown\n' + marker + '\n```\n',
    '# 示例\n~~~~markdown\n' + marker + '\n~~~~\n',
    '# 示例\n<!-- 说明开始\n' + marker + '\n-->\n',
    '---\nexample: |\n  ' + marker + '\ntags: [project]\n---\n',
    '\uFEFF---\nexample: "first line\n' + marker + '\nlast line"\ntags: [project]\n---\n',
  ]) assert.equal(md.projectId(content, obsidian), null);
  const realId = crypto.randomUUID();
  const content = '<!-- feishu-project: ' + realId + ' -->\n```markdown\n' + marker + '\n```\n';
  assert.equal(md.projectId(content, obsidian), realId);
});

test('project identity reads plain and quoted frontmatter text properties', () => {
  const vaultId = crypto.randomUUID();
  for (const [key, value] of [
    ['feishu-project', vaultId + '/' + LOCAL_ID],
    ['"feishu-project"', '"' + vaultId + '/' + LOCAL_ID + '" # keep comment'],
    ["'feishu-project'", "'" + vaultId + '/' + LOCAL_ID + "'"],
  ]) {
    const content = '---\n' + key + ': ' + value + '\ntags: [project]\n---\n正文\n';
    assert.deepEqual(md.projectMarker(content, obsidian), { vaultId, id: LOCAL_ID });
  }
  assert.deepEqual(md.projectMarker('---\nfeishu-project: ' + LOCAL_ID + '\n---\n', obsidian), { vaultId: null, id: LOCAL_ID });
});

test('project property writes preserve existing YAML and body bytes across line endings and BOM', () => {
  const vaultId = crypto.randomUUID();
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const bom of ['', '\uFEFF']) {
      const content = bom + ['---', 'tags: [project]', 'area: "[[program]]"', 'custom: "keep: value"', '---', '', '# 正文', '原文与 [[双链]] ^block', ''].join(newline);
      const changed = md.writeProjectMarker(content, { vaultId, id: LOCAL_ID }, obsidian);
      const info = obsidian.getFrontMatterInfo(changed);
      assert.equal(changed.slice(info.contentStart), content.slice(obsidian.getFrontMatterInfo(content).contentStart));
      assert.equal(changed.replace('feishu-project: ' + vaultId + '/' + LOCAL_ID + newline, ''), content);
      assert.equal(md.writeProjectMarker(changed, { vaultId, id: LOCAL_ID }, obsidian), changed);
      assert.deepEqual(md.projectMarker(changed, obsidian), { vaultId, id: LOCAL_ID });
    }
  }
});

test('legacy project migration removes only the real marker and retains fenced and HTML examples', () => {
  const vaultId = crypto.randomUUID(), value = vaultId + '/' + LOCAL_ID;
  const marker = '<!-- feishu-project: ' + value + ' -->';
  const body = '\n# 正文\n```markdown\n' + marker + '\n```\n<!-- 外层注释\n' + marker + '\n-->\n保持原文';
  const content = '---\ntags: [project]\ncustom: keep\n---\n' + marker + '\n' + body;
  const changed = md.writeProjectMarker(content, { vaultId, id: LOCAL_ID }, obsidian);
  assert.equal(changed.slice(obsidian.getFrontMatterInfo(changed).contentStart), body);
  assert.deepEqual(md.projectMarker(changed, obsidian), { vaultId, id: LOCAL_ID });
  assert.equal(md.writeProjectMarker(changed, { vaultId, id: LOCAL_ID }, obsidian), changed);
});

test('matching property and legacy markers merge ownership while conflicting IDs and owners stop writes', () => {
  const vaultId = crypto.randomUUID();
  const property = '---\nfeishu-project: ' + vaultId + '/' + LOCAL_ID + '\n---\n';
  const matching = property + '<!-- feishu-project: ' + LOCAL_ID + ' -->\n正文';
  assert.deepEqual(md.projectMarker(matching, obsidian), { vaultId, id: LOCAL_ID });
  assert.equal(md.writeProjectMarker(matching, { vaultId, id: LOCAL_ID }, obsidian), property + '正文');
  for (const value of [crypto.randomUUID(), crypto.randomUUID() + '/' + LOCAL_ID]) {
    const conflicting = property + '<!-- feishu-project: ' + value + ' -->\n正文';
    assert.throws(() => md.projectMarker(conflicting, obsidian), /不一致/);
    assert.throws(() => md.writeProjectMarker(conflicting, { vaultId, id: LOCAL_ID }, obsidian), /不一致/);
  }
  assert.throws(() => md.writeProjectMarker(property, { vaultId: crypto.randomUUID(), id: LOCAL_ID }, obsidian), /变化/);
});

test('invalid project properties fail before delivery rather than creating another identity', async t => {
  for (const value of ['not-a-uuid', '[a,b]', 'true', '123']) {
    const content = initialProject('- [ ] 行动 A\n').replace('status: doing', 'status: doing\nfeishu-project: ' + value);
    const f = fixture(t, { [PROJECT]: content }); f.configure();
    await assert.rejects(f.service.readNote(PROJECT), /feishu-project/);
    assert.throws(() => md.writeProjectMarker(content, { vaultId: crypto.randomUUID(), id: LOCAL_ID }, obsidian), /feishu-project/);
    assert.equal(f.files.get(PROJECT).content, content);
    assert.equal(f.calls.length, 0);
  }
});

test('an empty property or missing frontmatter can acquire a project identity without altering body text', () => {
  const marker = { vaultId: crypto.randomUUID(), id: LOCAL_ID };
  for (const content of ['正文', '\uFEFF正文', '---\ntags: [project]\nfeishu-project:\n---\n正文', '---\ntags: [project]\n---']) {
    const changed = md.writeProjectMarker(content, marker, obsidian);
    assert.deepEqual(md.projectMarker(changed, obsidian), marker);
    assert.equal(changed.slice(obsidian.getFrontMatterInfo(changed).contentStart), content.includes('---') ? content.slice(obsidian.getFrontMatterInfo(content).contentStart) : content.replace(/^\uFEFF/, ''));
  }
});

test('project properties retain BOM and CR-only frontmatter when the Obsidian boundary helper cannot recognize it', () => {
  const strict = { ...obsidian, getFrontMatterInfo(content) {
    return content.startsWith('\uFEFF') || !content.includes('\n')
      ? { exists: false, frontmatter: '', contentStart: 0 } : obsidian.getFrontMatterInfo(content);
  } };
  const marker = { vaultId: crypto.randomUUID(), id: LOCAL_ID };
  for (const content of ['\uFEFF---\ntags: [project]\n---\n正文', '---\rtags: [project]\r---\r正文']) {
    const changed = md.writeProjectMarker(content, marker, strict);
    const newline = content.includes('\n') ? '\n' : '\r';
    assert.equal(changed.replace('feishu-project: ' + marker.vaultId + '/' + marker.id + newline, ''), content);
    assert.deepEqual(md.projectMarker(changed, strict), marker);
  }
  assert.throws(() => md.writeProjectMarker('---\ntags: [project]\n正文', marker, strict), /未闭合/);
});

test('legacy project delivery migrates its property while retaining remote task and list GUIDs', async t => {
  const f = fixture(t, { [PROJECT]: initialProject('- [ ] 行动 A\n') }); f.configure();
  const record = await f.service.sendTask(await f.snapshot(PROJECT));
  const file = f.files.get(PROJECT), marker = md.projectMarker(file.content, obsidian);
  file.content = file.content.replace(/^feishu-project: [^\n]+\n/m, '')
    .replace('# 下一步行动', '<!-- feishu-project: ' + marker.vaultId + '/' + marker.id + ' -->\n# 下一步行动');
  const body = file.content.slice(obsidian.getFrontMatterInfo(file.content).contentStart)
    .replace(/^<!-- feishu-project: [^\n]+\n/, '');
  const result = await f.service.syncVault();
  assert.equal(result.failed, 0);
  assert.deepEqual(md.projectMarker(file.content, obsidian), marker);
  assert.equal(file.content.slice(obsidian.getFrontMatterInfo(file.content).contentStart), body);
  assert.equal(f.savedRecord(record.id).guid, record.guid);
  assert.equal(f.count('createTask'), 1);
  assert.equal(f.count('createTasklist'), 1);
});

test('an explicit lost-history decision survives an uncertain patch and normal sync can finish it', async t => {
  const f = fixture(t, { [DAILY]: '# 今日行动\n- [x] 行动 A <!-- feishu-task: ' + LOCAL_ID + ' -->\n' });
  f.configure();
  useCurrentVaultMarker(f);
  const guid = crypto.randomUUID();
  f.tasks.set(guid, { guid, summary: '行动 A', description: 'Obsidian 来源：2026-10-04', completed_at: '0', mode: 2,
    extra: JSON.stringify({ source: 'obsidian-feishu-sync', version: 2, vaultId: f.service.getConfig().vaultId, id: LOCAL_ID }), tasklists: [{ tasklist_guid: LIST }] });
  await assert.rejects(f.service.sendTask(await f.snapshot()), /历史|选择/);
  assert.equal(f.savedRecord(LOCAL_ID).needsChoice, true);
  f.hooks.updateTask = async (taskGuid, patch, operation) => {
    await operation(taskGuid, patch);
    throw new FeishuError('TIMEOUT', '更新请求超时', { uncertain: true });
  };
  await assert.rejects(f.service.syncTask(LOCAL_ID, { resolution: 'local' }), /超时/);
  const pending = f.savedRecord(LOCAL_ID);
  assert.equal(pending.needsChoice, false);
  assert.ok(pending.pending);
  assert.equal(pending.pending.done, true);
  delete f.hooks.updateTask;
  await f.service.syncTask(LOCAL_ID);
  const finished = f.savedRecord(LOCAL_ID);
  assert.equal(finished.state, 'linked');
  assert.equal(finished.pending, null);
  assert.equal(finished.needsChoice, false);
  assert.equal((await f.snapshot()).done, true);
  assert.notEqual(f.tasks.get(guid).completed_at, '0');
  assert.equal(f.count('updateTask'), 1);
  assert.equal(f.count('createTask'), 0);
});

async function missingTaskFixture(t, initial) {
  const f = fixture(t, initial); f.configure();
  const record = await f.service.sendTask(await f.snapshot());
  f.tasks.delete(record.guid);
  return { f, record };
}

async function statusConflictFixture(t) {
  const f = fixture(t, { [DAILY]: '# 今日行动\n- [x] 本地标题\n' }); f.configure();
  const record = await f.service.sendTask(await f.snapshot());
  f.files.get(DAILY).content = f.files.get(DAILY).content.replace('- [x]', '- [ ]');
  Object.assign(f.tasks.get(record.guid), { completed_at: String(f.control.clock + 1000), summary: '飞书标题' });
  await assert.rejects(f.service.syncTask(record.id), /两边|冲突/);
  return { f, record };
}

test('conflict preview is read-only and only exact task-detail NOT_FOUND identifies a missing action', async t => {
  const { f, record } = await missingTaskFixture(t);
  const before = fs.readFileSync(path.join(f.directory, 'records.json'), 'utf8');
  const content = f.files.get(DAILY).content;
  const writes = () => { throw new Error('preview wrote'); };
  const service = createService(f.app, obsidian, { ...f.dependencies, atomicJSON: writes });
  f.app.vault.process = writes;
  const calls = f.calls.length;
  const preview = await service.getTaskConflict(record.id);
  assert.equal(preview.kind, 'remote_missing');
  assert.deepEqual(preview.remote, { exists: false });
  assert.deepEqual(preview.local, { summary: '行动 A', done: false, status: ' ' });
  assert.match(preview.choices.remote, /\[-\].*取消/);
  assert.deepEqual(f.calls.slice(calls).map(call => call[0]), ['client', 'getTask']);
  assert.equal(fs.readFileSync(path.join(f.directory, 'records.json'), 'utf8'), before);
  assert.equal(f.files.get(DAILY).content, content);
  for (const code of ['FORBIDDEN', 'NETWORK_ERROR', 'TIMEOUT']) {
    f.hooks.getTask = async () => { throw new FeishuError(code, code); };
    await assert.rejects(service.getTaskConflict(record.id), error => error.code === code);
  }
});

test('both explicit completion choices keep local title authority and generic sync leaves conflicts paused', async t => {
  for (const choice of ['local', 'remote']) {
    const { f, record } = await statusConflictFixture(t);
    const calls = f.calls.length;
    await assert.rejects(f.service.syncTask(record.id), /两边|选择/);
    assert.equal(f.calls.length, calls);
    const preview = await f.service.getTaskConflict(record.id);
    assert.equal(preview.kind, 'status');
    assert.equal(preview.remote.summary, '飞书标题');
    assert.match(preview.choices[choice], /标题仍以本地/);
    const result = await f.service.resolveTaskConflict(record.id, choice, preview.token);
    assert.equal(result.state, 'linked');
    assert.equal((await f.snapshot()).done, choice === 'remote');
    assert.equal(f.tasks.get(record.guid).completed_at !== '0', choice === 'remote');
    assert.equal(f.tasks.get(record.guid).summary, '本地标题');
    const creates = f.count('createTask'), updates = f.count('updateTask');
    await assert.rejects(f.service.resolveTaskConflict(record.id, choice, preview.token), { code: 'CONFLICT_STALE' });
    assert.equal(f.count('createTask'), creates); assert.equal(f.count('updateTask'), updates);
    assert.deepEqual(await f.service.getSyncIssues([{ id: record.id, kind: 'task', path: DAILY, message: '上次冲突' }]), []);
  }
});

test('missing local choice persists a fresh intent, preserves the ID and options, and creates exactly once', async t => {
  const f = fixture(t); f.configure();
  const options = { due: f.control.clock + 600000, reminderMinutes: 1 };
  const old = await f.service.sendTask(await f.snapshot(), options);
  f.tasks.delete(old.guid);
  const raw = f.files.get(DAILY).content;
  const preview = await f.service.getTaskConflict(old.id);
  f.hooks.createTask = async (payload, operation) => {
    const intent = f.savedRecord(old.id);
    assert.equal(intent.state, 'creating');
    assert.equal(intent.guid, undefined); assert.equal(intent.baseline, undefined); assert.equal(intent.pending, undefined);
    assert.equal(intent.parentTaskGuid, undefined); assert.equal(intent.hierarchyVerified, undefined);
    assert.deepEqual(intent.previousGuids, [old.guid]);
    assert.equal(intent.recreate.token, payload.client_token);
    assert.notEqual(payload.client_token, old.payload.client_token);
    assert.deepEqual(payload.due, old.payload.due); assert.deepEqual(payload.reminders, old.payload.reminders);
    return operation(payload);
  };
  const result = await f.service.resolveTaskConflict(old.id, 'local', preview.token);
  assert.equal(result.id, old.id); assert.notEqual(result.guid, old.guid); assert.equal(result.state, 'linked');
  assert.equal(f.files.get(DAILY).content, raw);
  await assert.rejects(f.service.resolveTaskConflict(old.id, 'local', preview.token), { code: 'CONFLICT_STALE' });
  await f.service.syncTask(old.id);
  assert.equal(f.count('createTask'), 2);
});

test('missing remote choice changes exactly the checkbox and tombstone suppresses historical errors and future polling', async t => {
  const { f, record } = await missingTaskFixture(t, { [DAILY]: '# 今日行动\r\n  1. [ ] 阅读 [[资料|标题]] <!-- 注释 --> ^keep\r\n' });
  const before = f.files.get(DAILY).content;
  await assert.rejects(f.service.syncTask(record.id));
  assert.equal(f.savedRecord(record.id).state, 'remote_missing');
  const preview = await f.service.getTaskConflict(record.id);
  const result = await f.service.resolveTaskConflict(record.id, 'remote', preview.token);
  assert.equal(result.state, 'suppressed'); assert.equal(result.suppressed, true);
  assert.equal(result.guid, record.guid);
  assert.equal(f.files.get(DAILY).content, before.replace('1. [ ]', '1. [-]'));
  const calls = f.calls.length;
  await f.service.syncTask(record.id);
  await f.service.syncAll();
  f.service.saveConfig({ autoEnabled: true, syncDaily: true });
  for (const automatic of [true, false]) {
    const round = await f.service.syncVault({ automatic });
    assert.equal(round.failed, 0);
  }
  assert.equal(f.calls.filter(call => call[0] !== 'client').length, f.calls.slice(0, calls).filter(call => call[0] !== 'client').length);
  assert.deepEqual(await f.service.getSyncIssues([{ id: record.id, kind: 'task', path: DAILY, message: '任务不存在' }]), []);
  f.files.get(DAILY).content = f.files.get(DAILY).content.replace('1. [-]', '1. [ ]');
  const issue = (await f.service.getSyncIssues())[0];
  assert.equal(issue.state, 'remote_missing'); assert.match(issue.message, /重新打开/);
  await f.service.syncVault({ automatic: true });
  assert.equal(f.count('createTask'), 1);
  const reopened = await f.service.getTaskConflict(record.id);
  await f.service.resolveTaskConflict(record.id, 'local', reopened.token);
  assert.equal(f.count('createTask'), 2); assert.equal(f.savedRecord(record.id).suppressed, undefined);
});

test('a canceled tombstone can be explicitly re-enabled with a new remote task', async t => {
  const { f, record } = await missingTaskFixture(t);
  let preview = await f.service.getTaskConflict(record.id);
  await f.service.resolveTaskConflict(record.id, 'remote', preview.token);
  preview = await f.service.getTaskConflict(record.id);
  assert.match(preview.choices.local, /重新启用/);
  await f.service.resolveTaskConflict(record.id, 'local', preview.token);
  assert.equal((await f.snapshot()).status, ' ');
  assert.equal(f.count('createTask'), 2);
});

test('preview token rejects changed local, remote, GUID, account, vault, and scope before any write', async t => {
  for (const change of ['local', 'remote', 'guid', 'account', 'vault', 'scope']) {
    const { f, record } = await missingTaskFixture(t);
    const preview = await f.service.getTaskConflict(record.id);
    if (change === 'local') f.files.get(DAILY).content = f.files.get(DAILY).content.replace('行动 A', '新编辑');
    if (change === 'remote') f.tasks.set(record.guid, { ...clone(record.payload), guid: record.guid });
    if (change === 'guid') {
      const all = f.readRecordFile(); all.accounts.cli_test.tasks[record.id].guid = crypto.randomUUID();
      atomicJSON(path.join(f.directory, 'records.json'), all);
    }
    if (change === 'account') f.service.saveConfig({ appId: 'cli_other', secret: 'unit-test-secret' });
    if (change === 'vault') {
      const filename = path.join(f.directory, 'config.json');
      atomicJSON(filename, { ...JSON.parse(fs.readFileSync(filename, 'utf8')), vaultId: crypto.randomUUID() });
    }
    if (change === 'scope') f.service.saveConfig({ dailyFolder: 'AnotherDaily' });
    const before = f.files.get(DAILY).content, all = f.readRecordFile(), creates = f.count('createTask');
    await assert.rejects(f.service.resolveTaskConflict(record.id, 'local', preview.token), { code: 'CONFLICT_STALE' }, change);
    assert.equal(f.files.get(DAILY).content, before); assert.deepEqual(f.readRecordFile(), all);
    assert.equal(f.count('createTask'), creates); assert.equal(f.count('updateTask'), 0);
  }
});

test('remote state changing after preview or local edit during revalidation rejects the old choice', async t => {
  for (const change of ['remote', 'localInFlight']) {
    const { f, record } = await statusConflictFixture(t);
    const preview = await f.service.getTaskConflict(record.id);
    if (change === 'remote') f.tasks.get(record.guid).summary = '后来修改的标题';
    else f.hooks.getTask = async (guid, operation) => {
      delete f.hooks.getTask;
      f.files.get(DAILY).content = f.files.get(DAILY).content.replace('本地标题', '后来本地编辑');
      return operation(guid);
    };
    await assert.rejects(f.service.resolveTaskConflict(record.id, 'remote', preview.token), { code: 'CONFLICT_STALE' });
    assert.equal(f.count('updateTask'), 0); assert.equal((await f.snapshot()).done, false);
  }
});

test('unknown recreate response recovers the new task and never binds a resurfaced old GUID or repeats create', async t => {
  const { f, record } = await missingTaskFixture(t);
  const preview = await f.service.getTaskConflict(record.id);
  f.hooks.createTask = async (payload, operation) => {
    await operation(payload);
    f.tasks.set(record.guid, { ...clone(record.payload), guid: record.guid });
    throw new FeishuError('TIMEOUT', '重建结果未知', { uncertain: true });
  };
  await assert.rejects(f.service.resolveTaskConflict(record.id, 'local', preview.token), /未知/);
  assert.equal(f.savedRecord(record.id).state, 'uncertain');
  const restarted = createService(f.app, obsidian, f.dependencies);
  await assert.rejects(restarted.recoverTask(record.id, record.guid), /旧飞书任务/);
  const recovered = await restarted.syncTask(record.id);
  assert.notEqual(recovered.guid, record.guid); assert.equal(recovered.state, 'linked');
  assert.equal(f.count('createTask'), 2);
});

test('unknown recreation with no result stays uncertain rather than remote_missing or a second create', async t => {
  const { f, record } = await missingTaskFixture(t);
  const preview = await f.service.getTaskConflict(record.id);
  f.hooks.createTask = async () => { throw new FeishuError('TIMEOUT', '结果未知', { uncertain: true }); };
  await assert.rejects(f.service.resolveTaskConflict(record.id, 'local', preview.token));
  for (let i = 0; i < 2; i++) await assert.rejects(f.service.syncTask(record.id), /不会再次创建/);
  assert.equal(f.savedRecord(record.id).state, 'uncertain'); assert.equal(f.count('createTask'), 2);
});

test('recreation disk failures before and after the remote write cannot cause duplicate creation', async t => {
  for (const when of ['intent', 'attached']) {
    const { f, record } = await missingTaskFixture(t);
    const preview = await f.service.getTaskConflict(record.id);
    f.control.failRecordWrite = all => {
      const next = all.accounts.cli_test.tasks[record.id];
      return !!next.recreate && (when === 'intent' || !!next.guid);
    };
    await assert.rejects(f.service.resolveTaskConflict(record.id, 'local', preview.token), /未能保存/);
    assert.equal(f.count('createTask'), when === 'intent' ? 1 : 2);
    f.control.failRecordWrite = null;
    await f.service.syncTask(record.id);
    assert.equal(f.count('createTask'), 2); assert.notEqual(f.savedRecord(record.id).guid, record.guid);
  }
});

test('cancellation disk failure and interrupted local write recover the saved decision without remote writes', async t => {
  for (const when of ['intent', 'local', 'final']) {
    const { f, record } = await missingTaskFixture(t);
    const preview = await f.service.getTaskConflict(record.id);
    if (when === 'local') f.control.beforeProcess = () => { throw new Error('vault unavailable'); };
    else f.control.failRecordWrite = all => {
      const next = all.accounts.cli_test.tasks[record.id];
      return next.suppressed && (when === 'intent' || !next.cancelPending);
    };
    await assert.rejects(f.service.resolveTaskConflict(record.id, 'remote', preview.token));
    f.control.failRecordWrite = null; f.control.beforeProcess = null;
    const calls = f.calls.length;
    await f.service.syncTask(record.id);
    assert.equal((await f.snapshot()).status, '-'); assert.equal(f.savedRecord(record.id).state, 'suppressed');
    assert.equal(f.calls.length, calls); assert.equal(f.count('createTask'), 1);
  }
});

test('foreign action and out-of-scope conflict previews are rejected before API access', async t => {
  for (const change of ['foreign', 'scope']) {
    const { f, record } = await missingTaskFixture(t);
    if (change === 'foreign') f.files.get(DAILY).content = f.files.get(DAILY).content.replace(f.service.getConfig().vaultId, crypto.randomUUID());
    else f.rename(DAILY, '60_Archive/moved.md');
    const calls = f.calls.length;
    await assert.rejects(f.service.getTaskConflict(record.id));
    assert.equal(f.calls.length, calls);
  }
});

test('a failed explicit status choice stays reported and its durable pending update can recover', async t => {
  const { f, record } = await statusConflictFixture(t);
  const preview = await f.service.getTaskConflict(record.id);
  f.hooks.updateTask = async () => { throw new FeishuError('FORBIDDEN', '没有更新权限'); };
  await assert.rejects(f.service.resolveTaskConflict(record.id, 'local', preview.token), /权限/);
  assert.equal(f.savedRecord(record.id).state, 'error');
  assert.ok(f.savedRecord(record.id).pending);
  assert.match((await f.service.getSyncIssues())[0].message, /权限/);
  delete f.hooks.updateTask;
  await f.service.syncTask(record.id);
  assert.equal(f.savedRecord(record.id).state, 'linked'); assert.deepEqual(await f.service.getSyncIssues(), []);
});

test('a cancelled action whose old remote reappears can explicitly resume either completion state without recreation', async t => {
  for (const choice of ['local', 'remote']) {
    const { f, record } = await missingTaskFixture(t);
    const missing = await f.service.getTaskConflict(record.id);
    await f.service.resolveTaskConflict(record.id, 'remote', missing.token);
    f.tasks.set(record.guid, { ...clone(record.payload), guid: record.guid, completed_at: String(f.control.clock) });
    const preview = await f.service.getTaskConflict(record.id);
    assert.equal(preview.kind, 'status'); assert.match(preview.choices[choice], /重新启用同步/);
    await f.service.resolveTaskConflict(record.id, choice, preview.token);
    assert.equal((await f.snapshot()).status, choice === 'local' ? ' ' : 'x');
    assert.equal(f.savedRecord(record.id).suppressed, false); assert.equal(f.savedRecord(record.id).state, 'linked');
    assert.equal(f.count('createTask'), 1);
  }
});

test('reopening before a recreate preflight error leaves a draft that accepts later local title edits', async t => {
  const { f, record } = await missingTaskFixture(t);
  let preview = await f.service.getTaskConflict(record.id);
  await f.service.resolveTaskConflict(record.id, 'remote', preview.token);
  preview = await f.service.getTaskConflict(record.id);
  f.hooks.getTasklist = async () => { throw new FeishuError('FORBIDDEN', '清单权限不足'); };
  await assert.rejects(f.service.resolveTaskConflict(record.id, 'local', preview.token), /清单权限/);
  assert.equal((await f.snapshot()).status, ' ');
  assert.equal(f.savedRecord(record.id).state, 'draft');
  assert.equal(f.savedRecord(record.id).recreate.reopen, false);
  f.files.get(DAILY).content = f.files.get(DAILY).content.replace('行动 A', '编辑后的行动');
  delete f.hooks.getTasklist;
  const created = await f.service.syncTask(record.id);
  assert.equal(f.tasks.get(created.guid).summary, '编辑后的行动'); assert.equal(f.count('createTask'), 2);
});

test('bulk sync does not revive a tombstone failure after its local note is archived or removed', async t => {
  const { f, record } = await missingTaskFixture(t);
  const preview = await f.service.getTaskConflict(record.id);
  await f.service.resolveTaskConflict(record.id, 'remote', preview.token);
  f.rename(DAILY, '60_Archive/canceled.md');
  const calls = f.calls.length;
  assert.equal((await f.service.syncAll()).failed, 0);
  f.files.delete('60_Archive/canceled.md');
  assert.equal((await f.service.syncAll()).failed, 0);
  assert.equal(f.calls.length, calls);
  assert.deepEqual(await f.service.getSyncIssues([{ id: record.id, path: DAILY, kind: 'task', message: '历史失败' }]), []);
});

test('a concurrent edit while resuming a cancelled action retains an explicit choice until checkbox CAS succeeds', async t => {
  for (const change of ['local', 'remote']) {
    const { f, record } = await missingTaskFixture(t);
    let preview = await f.service.getTaskConflict(record.id);
    await f.service.resolveTaskConflict(record.id, 'remote', preview.token);
    f.tasks.set(record.guid, { ...clone(record.payload), guid: record.guid, summary: '远端标题', completed_at: String(f.control.clock) });
    preview = await f.service.getTaskConflict(record.id);
    if (change === 'local') f.control.failRecordWrite = all => {
      if (all.accounts.cli_test.tasks[record.id].pending?.resumingSuppressed) {
        f.control.failRecordWrite = null;
        f.files.get(DAILY).content = f.files.get(DAILY).content.replace('行动 A', '恢复期间本地编辑');
      }
      return false;
    };
    else f.hooks.updateTask = async (guid, patch, operation) => {
      const updated = await operation(guid, patch);
      f.tasks.get(guid).summary = '恢复期间飞书编辑';
      delete f.hooks.updateTask;
      return updated;
    };
    await assert.rejects(f.service.resolveTaskConflict(record.id, 'remote', preview.token), /修改|变化/);
    assert.equal((await f.snapshot()).status, '-');
    assert.equal(f.savedRecord(record.id).state, 'conflict');
    assert.equal(f.savedRecord(record.id).resumingSuppressed, true);
    preview = await f.service.getTaskConflict(record.id);
    assert.equal(preview.kind, 'status'); assert.match(preview.choices.remote, /重新启用/);
    await f.service.resolveTaskConflict(record.id, 'remote', preview.token);
    assert.equal((await f.snapshot()).status, 'x');
    assert.equal(f.savedRecord(record.id).resumingSuppressed, false);
    assert.equal(f.savedRecord(record.id).state, 'linked'); assert.equal(f.count('createTask'), 1);
  }
});
