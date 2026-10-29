'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createService, atomicJSON } = require('../lib/feishu-service.cjs');
const { FeishuError } = require('../lib/feishu-api.cjs');
const md = require('../lib/feishu-markdown.cjs');

const PROJECT = '50_Tasks/example.md';
const DAILY = '20_Review/Daily/2026-10-04.md';
const APP_ID = 'cli_test';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clone = value => structuredClone(value);
const project = body => '---\ntags: [project]\nstatus: doing\n---\n# 下一步行动\n' + body;

// Only YAML boundaries and the small schema used by the fixtures are mocked.
// Identity parsing, task scans, file queues, and synchronization are production code.
const obsidian = {
  getFrontMatterInfo(content) {
    const match = /^(?:\uFEFF)?---(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)---(?:(?:\r\n|\n|\r)|$)/.exec(content);
    return match ? { exists: true, frontmatter: match[1], contentStart: match[0].length }
      : { exists: false, frontmatter: '', contentStart: 0 };
  },
  parseYaml(content) {
    const value = {};
    for (const line of content.split(/\r\n|\n|\r/)) {
      const pair = /^([\w-]+):\s*(.*)$/.exec(line);
      if (pair) value[pair[1]] = pair[2].startsWith('[')
        ? pair[2].slice(1, -1).split(',').map(part => part.trim()) : pair[2];
    }
    return value;
  },
};

function remoteFixture() {
  const tasks = new Map(), lists = new Map(), calls = [];
  const missing = () => { throw new FeishuError('NOT_FOUND', '测试远端对象不存在'); };
  const implementations = {
    check: async () => ({ ok: true }),
    listTasklists: async () => [...lists.values()].map(clone),
    getTasklist: async guid => lists.has(guid) ? clone(lists.get(guid)) : missing(),
    createTasklist: async payload => {
      const list = { ...clone(payload), guid: crypto.randomUUID() };
      lists.set(list.guid, list); return clone(list);
    },
    updateTasklist: async (guid, patch) => {
      const list = lists.get(guid) || missing();
      Object.assign(list, clone(patch)); return clone(list);
    },
    listTasks: async guid => [...tasks.values()]
      .filter(task => task.tasklists?.some(list => list.tasklist_guid === guid)).map(clone),
    getTask: async guid => tasks.has(guid) ? clone(tasks.get(guid)) : missing(),
    createTask: async payload => {
      const task = { ...clone(payload), guid: crypto.randomUUID() };
      tasks.set(task.guid, task); return clone(task);
    },
    updateTask: async (guid, patch) => {
      const task = tasks.get(guid) || missing();
      Object.assign(task, clone(patch)); return clone(task);
    },
  };
  const api = Object.fromEntries(Object.entries(implementations).map(([name, fn]) => [name, async (...args) => {
    calls.push([name, ...clone(args)]); return fn(...args);
  }]));
  const addList = name => {
    const guid = crypto.randomUUID(); lists.set(guid, { guid, name }); return guid;
  };
  const count = name => calls.filter(call => call[0] === name).length;
  return { tasks, lists, calls, api, addList, count };
}

function vaultFixture(t, remote, label = 'study', initial = { [PROJECT]: project('- [ ] 行动 A\n') }, obsidianApi = obsidian) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-vault-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = new Map(), writes = [], events = [];
  const addFile = (notePath, content) => {
    const file = { path: notePath, basename: path.basename(notePath, '.md'), extension: 'md', content };
    files.set(notePath, file); return file;
  };
  for (const [notePath, content] of Object.entries(initial)) addFile(notePath, content);
  const app = {
    vault: {
      adapter: { getBasePath: () => '/unit-test/' + label },
      getAbstractFileByPath: notePath => files.get(notePath) || null,
      getMarkdownFiles: () => [...files.values()],
      read: async file => file.content,
      cachedRead: async file => file.content,
      process: async (file, updater) => { writes.push(['markdown', file.path]); file.content = updater(file.content); },
    },
    workspace: { trigger: (...args) => events.push(args) },
  };
  const dependencies = {
    directory, now: () => Date.UTC(2026, 9, 4),
    safeStorage: () => ({ encryptString: value => Buffer.from(value.split('').reverse().join('')),
      decryptString: value => value.toString().split('').reverse().join('') }),
    createFeishuClient: options => { assert.equal(options.appId, APP_ID); return remote.api; },
    atomicJSON: (filename, value) => { writes.push(['json', path.basename(filename)]); atomicJSON(filename, value); },
  };
  const service = createService(app, obsidianApi, dependencies);
  const defaultList = remote.addList('[' + label + '] 日记行动');
  const configure = (options = {}) => service.saveConfig({ appId: APP_ID, secret: 'test-secret', assigneeId: 'ou_test',
    defaultTasklistGuid: defaultList, ...options });
  const records = () => JSON.parse(fs.readFileSync(path.join(directory, 'records.json'), 'utf8'));
  const taskRecords = () => Object.values(records().accounts[APP_ID].tasks);
  const snapshot = async (notePath = PROJECT, index = 0) => (await service.readNote(notePath)).tasks[index];
  const rename = (before, after) => {
    const file = files.get(before); files.delete(before);
    Object.assign(file, { path: after, basename: path.basename(after, '.md') }); files.set(after, file);
  };
  const contents = () => [...files].map(([name, file]) => [name, file.content]);
  return { service, app, files, writes, events, directory, dependencies, defaultList, configure,
    records, taskRecords, snapshot, rename, addFile, contents };
}

async function cycle(vault, options = { automatic: false }) {
  const result = await vault.service.syncVault(options);
  assert.equal(result?.failed || 0, 0, JSON.stringify(result));
  return result;
}

async function refused(operation) {
  let result;
  try { result = await operation(); }
  catch (error) { assert.ok(error instanceof Error); return; }
  assert.ok(result?.failed > 0 || result?.results?.some(item => item.ok === false), JSON.stringify(result));
}

test('each vault receives a stable independent UUID and partial configuration retains saved fields', t => {
  const remote = remoteFixture();
  const study = vaultFixture(t, remote, 'study'), lab = vaultFixture(t, remote, 'lab');
  study.configure({ autoEnabled: true, pollMinutes: 3, syncDaily: true }); lab.configure();
  const before = study.service.getConfig(), other = lab.service.getConfig();
  assert.match(before.vaultId, UUID); assert.match(other.vaultId, UUID);
  assert.notEqual(before.vaultId, other.vaultId);
  assert.equal(before.vaultLabel, 'study'); assert.equal(other.vaultLabel, 'lab');
  study.service.saveConfig({ pollMinutes: 7 });
  const after = study.service.getConfig();
  assert.equal(after.vaultId, before.vaultId); assert.equal(after.appId, APP_ID);
  assert.equal(after.defaultTasklistGuid, study.defaultList);
  assert.equal(after.assigneeId, 'ou_test'); assert.equal(after.hasSecret, true);
  assert.equal(after.autoEnabled, true); assert.equal(after.syncDaily, true); assert.equal(after.pollMinutes, 7);
  assert.notEqual(after.configRevision, before.configRevision);
  assert.equal(createService(study.app, obsidian, study.dependencies).getConfig().vaultId, before.vaultId);
});

test('same application and project filename remain isolated across study and lab', async t => {
  const remote = remoteFixture();
  const study = vaultFixture(t, remote, 'study'), lab = vaultFixture(t, remote, 'lab');
  study.configure(); lab.configure();
  await cycle(study); await cycle(lab);
  const [studyRecord] = study.taskRecords(), [labRecord] = lab.taskRecords();
  assert.notEqual(studyRecord.guid, labRecord.guid);
  assert.notEqual(studyRecord.tasklistGuid, labRecord.tasklistGuid);
  for (const [vault, record, label] of [[study, studyRecord, 'study'], [lab, labRecord, 'lab']]) {
    const extra = JSON.parse(remote.tasks.get(record.guid).extra);
    assert.deepEqual(extra, { source: 'obsidian-feishu-sync', version: 2, vaultId: vault.service.getConfig().vaultId, id: record.id });
    assert.equal(remote.lists.get(record.tasklistGuid).name, '[' + label + '] example');
    assert.ok(vault.files.get(PROJECT).content.includes('<!-- feishu-task: ' + extra.vaultId + '/' + record.id + ' -->'));
    assert.match(vault.files.get(PROJECT).content, /^feishu-project: [a-f0-9-]+\/[a-f0-9-]+$/m);
    assert.doesNotMatch(vault.files.get(PROJECT).content, /<!-- feishu-project:/);
  }
  remote.tasks.get(studyRecord.guid).completed_at = String(Date.UTC(2026, 9, 4));
  await cycle(study); await cycle(lab);
  assert.equal((await study.snapshot()).done, true); assert.equal((await lab.snapshot()).done, false);
  assert.equal(remote.count('createTask'), 2); assert.equal(remote.count('createTasklist'), 2);
});

test('per-vault scopes discover only configured project folders and opted-in daily actions', async t => {
  const remote = remoteFixture();
  const f = vaultFixture(t, remote, 'lab', {
    'Projects/experiment.md': project('- [ ] 实验任务\n'),
    'ProjectsArchive/outside.md': project('- [ ] 前缀相似但不在范围\n'),
    [PROJECT]: project('- [ ] 范围外项目\n'),
    'Projects/unclassified.md': '# 没有 project 标签\n- [ ] 普通笔记\n',
    'Journal/2026-10-04.md': '# 今日行动\n- [ ] 实验日记\n',
    [DAILY]: '# 今日行动\n- [ ] 范围外日记\n',
  });
  const beforeOutside = f.files.get(PROJECT).content;
  f.configure({ projectFolder: 'Projects', dailyFolder: 'Journal', syncDaily: false });
  await cycle(f);
  assert.deepEqual([...remote.tasks.values()].map(task => task.summary), ['实验任务']);
  assert.equal(f.files.get(PROJECT).content, beforeOutside);
  assert.doesNotMatch(f.files.get('Journal/2026-10-04.md').content, /feishu-task/);
  f.service.saveConfig({ syncDaily: true });
  await cycle(f);
  assert.deepEqual([...remote.tasks.values()].map(task => task.summary).sort(), ['实验任务', '实验日记'].sort());
  assert.doesNotMatch(f.files.get(DAILY).content, /feishu-task/);
  assert.doesNotMatch(f.files.get('Projects/unclassified.md').content, /feishu-task/);
});

test('copying a synchronized project to another vault cannot claim or recreate its remote objects', async t => {
  const remote = remoteFixture();
  const study = vaultFixture(t, remote, 'study'); study.configure(); await cycle(study);
  const copied = study.files.get(PROJECT).content;
  const lab = vaultFixture(t, remote, 'lab', { [PROJECT]: copied }); lab.configure();
  const beforeRemote = clone([...remote.tasks]); const beforeLists = clone([...remote.lists]);
  await refused(() => lab.service.syncVault({ automatic: false }));
  assert.equal(lab.files.get(PROJECT).content, copied);
  assert.deepEqual([...remote.tasks], beforeRemote); assert.deepEqual([...remote.lists], beforeLists);
  assert.equal(remote.count('createTask'), 1); assert.equal(remote.count('createTasklist'), 1);
});

test('a foreign action marker is rejected even inside a new local project', async t => {
  const remote = remoteFixture();
  const study = vaultFixture(t, remote, 'study'); study.configure(); await cycle(study);
  const copiedAction = study.files.get(PROJECT).content.split('\n').find(line => line.includes('feishu-task:'));
  const copied = project(copiedAction + '\n');
  const lab = vaultFixture(t, remote, 'lab', { [PROJECT]: copied }); lab.configure();
  await refused(async () => lab.service.sendTask(await lab.snapshot()));
  assert.equal(lab.files.get(PROJECT).content, copied);
  assert.equal(remote.count('createTask'), 1); assert.equal(remote.count('createTasklist'), 1);
});

test('remote ownership changed to another vault stops updates and checkbox writes', async t => {
  const remote = remoteFixture();
  const f = vaultFixture(t, remote); f.configure(); await cycle(f);
  const [record] = f.taskRecords(); const task = remote.tasks.get(record.guid);
  task.extra = JSON.stringify({ ...JSON.parse(task.extra), vaultId: crypto.randomUUID() });
  task.completed_at = String(Date.UTC(2026, 9, 4));
  const before = f.files.get(PROJECT).content, updates = remote.count('updateTask');
  await assert.rejects(f.service.syncTask(record.id));
  assert.equal(f.files.get(PROJECT).content, before); assert.equal(remote.count('updateTask'), updates);
});

test('tasklist binding rejects another vault prefix and reuse by a second project', async t => {
  const remote = remoteFixture();
  const second = '50_Tasks/another.md';
  const f = vaultFixture(t, remote, 'study', { [PROJECT]: project('- [ ] A\n'), [second]: project('- [ ] B\n') });
  f.configure();
  const foreign = remote.addList('[lab] experiment'), own = remote.addList('[study] example');
  const before = f.contents();
  await assert.rejects(f.service.bindTasklist(PROJECT, foreign));
  assert.deepEqual(f.contents(), before);
  await f.service.bindTasklist(PROJECT, own);
  await assert.rejects(f.service.bindTasklist(second, own));
  assert.equal(remote.count('createTasklist'), 0); assert.equal(remote.count('createTask'), 0);
});

test('a project rename updates its existing tasklist instead of creating another one', async t => {
  const remote = remoteFixture();
  const f = vaultFixture(t, remote); f.configure(); await cycle(f);
  const [before] = f.taskRecords();
  const renamed = '50_Tasks/new project name.md'; f.rename(PROJECT, renamed);
  await cycle(f);
  assert.equal(remote.lists.get(before.tasklistGuid).name, '[study] new project name');
  assert.equal(f.taskRecords()[0].guid, before.guid);
  assert.equal(f.taskRecords()[0].path, renamed);
  assert.equal(remote.count('createTasklist'), 1); assert.equal(remote.count('createTask'), 1);
  assert.ok(remote.count('updateTasklist') >= 1);
});

test('vault synchronization discovers new actions in every project section and keeps completed actions consistent', async t => {
  const remote = remoteFixture();
  const f = vaultFixture(t, remote, 'study', { [PROJECT]: project('- [ ] 未完成\n## 背景里的行动\n- [x] 已完成\n- [?] 自定义状态\n') });
  f.configure(); await cycle(f);
  assert.equal(remote.count('createTask'), 2);
  const completed = [...remote.tasks.values()].find(task => task.summary === '已完成');
  assert.notEqual(completed.completed_at, '0');
  f.files.get(PROJECT).content += '\n## 新增章节\n- [ ] 新行动\n';
  completed.completed_at = '0';
  await cycle(f);
  assert.equal(remote.count('createTask'), 3);
  assert.ok([...remote.tasks.values()].some(task => task.summary === '新行动'));
  assert.match(f.files.get(PROJECT).content, /- \[ \] 已完成/);
  assert.match(f.files.get(PROJECT).content, /- \[\?\] 自定义状态\n/);
  assert.match(f.files.get(PROJECT).content, /status: doing/);
  await cycle(f);
  assert.equal(remote.count('createTask'), 3);
});

test('disabled automatic synchronization performs no remote call or local write while manual sync remains available', async t => {
  const remote = remoteFixture();
  const f = vaultFixture(t, remote); f.configure({ autoEnabled: false });
  const before = f.contents(), calls = remote.calls.length, writes = f.writes.length;
  await f.service.syncVault({ automatic: true });
  assert.deepEqual(f.contents(), before); assert.equal(remote.calls.length, calls); assert.equal(f.writes.length, writes);
  assert.equal(fs.existsSync(path.join(f.directory, 'records.json')), false);
  await cycle(f, { automatic: false });
  assert.equal(remote.count('createTask'), 1);
  f.service.saveConfig({ autoEnabled: true });
  f.files.get(PROJECT).content += '- [ ] 自动发现\n';
  await cycle(f, { automatic: true });
  assert.equal(remote.count('createTask'), 2);
});

test('legacy task and project ownership upgrades in place only with trusted local GUID records', async t => {
  const remote = remoteFixture();
  const taskId = crypto.randomUUID(), projectId = crypto.randomUUID();
  const listGuid = remote.addList('example'), taskGuid = crypto.randomUUID();
  const content = project('- [ ] 旧行动 <!-- feishu-task: ' + taskId + ' -->\n')
    .replace('# 下一步行动', '<!-- feishu-project: ' + projectId + ' -->\n# 下一步行动');
  const f = vaultFixture(t, remote, 'study', { [PROJECT]: content }); f.configure();
  const oldExtra = JSON.stringify({ source: 'obsidian-feishu-sync', version: 1, id: taskId });
  const payload = { summary: '旧行动', description: 'Obsidian 来源：example', completed_at: '0', mode: 2,
    extra: oldExtra, tasklists: [{ tasklist_guid: listGuid }] };
  remote.tasks.set(taskGuid, { ...clone(payload), guid: taskGuid });
  atomicJSON(path.join(f.directory, 'records.json'), { version: 1, accounts: { [APP_ID]: {
    tasks: { [taskId]: { id: taskId, path: PROJECT, guid: taskGuid, tasklistGuid: listGuid, state: 'linked', payload,
      baseline: { done: false, summary: '旧行动', completedAt: '0' } } },
    projects: { [projectId]: { id: projectId, path: PROJECT, guid: listGuid, state: 'linked' } },
  } } });
  await cycle(f);
  const vaultId = f.service.getConfig().vaultId;
  assert.equal(remote.count('createTask'), 0); assert.equal(remote.count('createTasklist'), 0);
  assert.equal(f.taskRecords()[0].guid, taskGuid);
  assert.deepEqual(JSON.parse(remote.tasks.get(taskGuid).extra), { source: 'obsidian-feishu-sync', version: 2, vaultId, id: taskId });
  assert.ok(f.files.get(PROJECT).content.includes('<!-- feishu-task: ' + vaultId + '/' + taskId + ' -->'));
  assert.deepEqual(md.projectMarker(f.files.get(PROJECT).content, obsidian), { vaultId, id: projectId });
  assert.ok(f.files.get(PROJECT).content.includes('feishu-project: ' + vaultId + '/' + projectId));
  assert.doesNotMatch(f.files.get(PROJECT).content, /<!-- feishu-project:/);
  assert.equal(remote.lists.get(listGuid).name, '[study] example');
});

test('legacy markers without local records never auto-claim a matching remote task', async t => {
  const remote = remoteFixture();
  const taskId = crypto.randomUUID(), taskGuid = crypto.randomUUID();
  const content = '# 今日行动\n- [ ] 来源不明 <!-- feishu-task: ' + taskId + ' -->\n';
  const f = vaultFixture(t, remote, 'study', { [DAILY]: content }); f.configure({ syncDaily: true });
  remote.tasks.set(taskGuid, { guid: taskGuid, summary: '来源不明', completed_at: '0', mode: 2,
    extra: JSON.stringify({ source: 'obsidian-feishu-sync', version: 1, id: taskId }),
    tasklists: [{ tasklist_guid: f.defaultList }] });
  const before = clone([...remote.tasks]);
  await refused(() => f.service.syncVault({ automatic: false }));
  assert.equal(f.files.get(DAILY).content, content); assert.deepEqual([...remote.tasks], before);
  assert.equal(remote.count('createTask'), 0); assert.equal(remote.count('updateTask'), 0);
});

test('a legacy GUID record with mismatching remote extra is not trusted for migration', async t => {
  const remote = remoteFixture();
  const taskId = crypto.randomUUID(), taskGuid = crypto.randomUUID();
  const content = '# 今日行动\n- [ ] 旧行动 <!-- feishu-task: ' + taskId + ' -->\n';
  const f = vaultFixture(t, remote, 'study', { [DAILY]: content }); f.configure({ syncDaily: true });
  const payload = { summary: '旧行动', description: 'Obsidian 来源：2026-10-04', completed_at: '0', mode: 2,
    extra: JSON.stringify({ source: 'obsidian-feishu-sync', version: 1, id: taskId }),
    tasklists: [{ tasklist_guid: f.defaultList }] };
  remote.tasks.set(taskGuid, { ...clone(payload), guid: taskGuid,
    extra: JSON.stringify({ source: 'obsidian-feishu-sync', version: 1, id: crypto.randomUUID() }) });
  atomicJSON(path.join(f.directory, 'records.json'), { version: 1, accounts: { [APP_ID]: {
    tasks: { [taskId]: { id: taskId, path: DAILY, guid: taskGuid, tasklistGuid: f.defaultList, state: 'linked', payload,
      baseline: { done: false, summary: '旧行动', completedAt: '0' } } }, projects: {},
  } } });
  const before = clone([...remote.tasks]);
  await refused(() => f.service.syncVault({ automatic: false }));
  assert.equal(f.files.get(DAILY).content, content); assert.deepEqual([...remote.tasks], before);
  assert.equal(remote.count('createTask'), 0); assert.equal(remote.count('updateTask'), 0);
});

test('duplicate namespaced action markers without records cannot be hidden by the per-round index', async t => {
  const remote = remoteFixture();
  const secondDaily = '20_Review/Daily/2026-10-05.md';
  const f = vaultFixture(t, remote, 'study', { [DAILY]: '', [secondDaily]: '' });
  f.configure({ syncDaily: true });
  const id = crypto.randomUUID(), guid = crypto.randomUUID(), vaultId = f.service.getConfig().vaultId;
  const content = '# 今日行动\n- [ ] 重复副本 <!-- feishu-task: ' + vaultId + '/' + id + ' -->\n';
  f.files.get(DAILY).content = content;
  f.files.get(secondDaily).content = content;
  remote.tasks.set(guid, { guid, summary: '重复副本', description: 'Obsidian 来源：2026-10-04', completed_at: '0', mode: 2,
    extra: JSON.stringify({ source: 'obsidian-feishu-sync', version: 2, vaultId, id }),
    tasklists: [{ tasklist_guid: f.defaultList }] });
  const before = clone([...remote.tasks]);
  await refused(() => f.service.syncVault({ automatic: false }));
  assert.equal(f.files.get(DAILY).content, content); assert.equal(f.files.get(secondDaily).content, content);
  assert.deepEqual([...remote.tasks], before);
  assert.equal(remote.count('createTask'), 0); assert.equal(remote.count('updateTask'), 0);
  if (fs.existsSync(path.join(f.directory, 'records.json'))) {
    assert.ok(f.taskRecords().every(record => !record.guid), 'Neither duplicate may recover the remote GUID');
  }
});

test('malformed archived markers isolate their own IDs without blocking unrelated projects', async t => {
  const remote = remoteFixture();
  const archived = '60_Archive/broken.md', secondProject = '50_Tasks/healthy.md';
  const malformed = (vaultId, first, second) => '- [ ] 归档坏行 <!-- feishu-task: ' + vaultId + '/' + first
    + ' --> <!-- feishu-task: ' + vaultId + '/' + second + ' -->\n';
  const f = vaultFixture(t, remote); f.configure();
  const vaultId = f.service.getConfig().vaultId;
  f.addFile(archived, malformed(vaultId, crypto.randomUUID(), crypto.randomUUID()));
  await cycle(f);
  assert.equal(remote.count('createTask'), 1);
  const [record] = f.taskRecords();
  f.files.get(PROJECT).content = f.files.get(PROJECT).content.replace('- [ ] 行动 A', '- [x] 行动 A');
  f.files.get(archived).content = malformed(vaultId, record.id, crypto.randomUUID());
  f.addFile(secondProject, project('- [ ] 不相关行动\n'));
  await refused(() => f.service.syncVault({ automatic: false }));
  assert.equal(remote.tasks.get(record.guid).completed_at, '0', 'A shared ID in the broken line must remain blocked');
  assert.match(f.files.get(PROJECT).content, /- \[x\] 行动 A/);
  assert.ok([...remote.tasks.values()].some(task => task.summary === '不相关行动'));
  assert.equal(remote.count('createTask'), 2); assert.equal(remote.count('updateTask'), 0);
});

test('stopping a vault run retains its first transaction and starts no further task or project', async t => {
  const remote = remoteFixture(), secondProject = '50_Tasks/second.md';
  const secondContent = project('- [ ] 后续项目行动\n');
  const f = vaultFixture(t, remote, 'study', {
    [PROJECT]: project('- [ ] 当前行动\n- [ ] 后续行动\n'), [secondProject]: secondContent,
  });
  f.configure();
  await f.service.syncVault({ automatic: false, shouldStop: () => remote.count('createTask') >= 1 });
  assert.equal(remote.count('createTask'), 1); assert.equal(remote.count('createTasklist'), 1);
  const records = f.taskRecords();
  assert.equal(records.length, 1); assert.equal(records[0].state, 'linked');
  assert.equal(remote.tasks.get(records[0].guid).summary, '当前行动');
  assert.match(f.files.get(PROJECT).content, /- \[ \] 后续行动\n/);
  assert.equal(f.files.get(secondProject).content, secondContent);
});

test('invalid YAML in one project is reported without blocking another project', async t => {
  const remote = remoteFixture();
  const brokenPath = '50_Tasks/broken.md', broken = '---\ntags: [unterminated\n---\n- [ ] 坏笔记\n';
  const strictYaml = { ...obsidian, parseYaml(content) {
    if (content.includes('tags: [unterminated')) throw new Error('测试 YAML 无法解析');
    return obsidian.parseYaml(content);
  } };
  const f = vaultFixture(t, remote, 'study', { [brokenPath]: broken, [PROJECT]: project('- [ ] 正常项目\n') }, strictYaml);
  f.configure();
  const result = await f.service.syncVault({ automatic: false });
  assert.ok(result.failed >= 1); assert.ok(result.results.some(item => item.path === brokenPath && item.ok === false));
  assert.equal(remote.count('createTask'), 1);
  assert.equal([...remote.tasks.values()][0].summary, '正常项目');
  assert.equal(f.files.get(brokenPath).content, broken);
});


test('round project checks reuse warmed reads and still reject copies outside the sync scope', async t => {
  const remote = remoteFixture();
  const second = '50_Tasks/second.md';
  const archive = '60_Archive/reference.md';
  const v = vaultFixture(t, remote, 'study', {
    [PROJECT]: project('- [ ] first action\n'),
    [second]: project('- [ ] second action\n'),
    [archive]: '# Unrelated reference\n',
  });
  v.configure();
  let diskReads = 0, cachedScans = 0;
  const read = v.app.vault.read;
  v.app.vault.read = async file => {
    if (file.path === archive) diskReads++;
    return read(file);
  };
  v.app.vault.cachedRead = async file => {
    if (file.path === archive) cachedScans++;
    return file.content;
  };
  await cycle(v);
  assert.equal(diskReads, 1, 'unrelated file is freshly read once, not once per project/action');
  assert.ok(cachedScans >= 2, 'all-vault duplicate checks remain enabled');
  const creates = remote.count('createTasklist');
  // A changed existing file outside the configured scope must still reject a
  // duplicate project; copying into a new file must be detected as well.
  v.files.get(archive).content = v.files.get(PROJECT).content.replace(/^- .*$/gm, '');
  v.addFile('60_Archive/new-copy.md', v.files.get(second).content.replace(/^- .*$/gm, ''));
  const result = await v.service.syncVault();
  assert.ok(result.results.some(row => row.path === PROJECT && /重复.*项目/.test(row.message || '')));
  assert.ok(result.results.some(row => row.path === second && /重复.*项目/.test(row.message || '')));
  assert.equal(remote.count('createTasklist'), creates);
  assert.equal(diskReads, 2, 'each subsequent round refreshes the initial disk scan');
});
