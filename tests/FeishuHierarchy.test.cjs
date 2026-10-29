'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createService, atomicJSON } = require('../lib/feishu-service.cjs');
const { FeishuError } = require('../lib/feishu-api.cjs');

const APP = 'cli_hierarchy';
const PROJECT = '50_Tasks/example.md';
const EMPTY = '50_Tasks/empty.md';
const clone = value => structuredClone(value);
const statusNames = { todo: '待办', doing: '进行中', done: '已完成', canceled: '已取消' };
const projectText = (body = '- [ ] 行动 A\n', status = 'doing', area = 'program') =>
  '---\ntags:\n  - project\nstatus: ' + status + '\narea:\n  - "[[' + area + ']]"\ncustom: keep\n---\n## 下一步行动\n' + body;

test('extra folders sync ordinary notes into the vault list while retaining project parents and GUIDs', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  const original = f.readRecords().accounts[APP];
  const parent = Object.values(original.projects)[0].parentTaskGuid;
  const existing = Object.values(original.tasks)[0].guid;
  const meeting = f.addFile('Meetings/weekly.md', '# Weekly\n- [ ] Follow up\n');
  f.addFile('Meetings/Archive/old.md', '- [ ] Excluded\n');
  f.addFile('Meetings2/private.md', '- [ ] Unselected\n');
  const projectFolderNote = f.addFile('50_Tasks/inbox.md', '---\ntags: [action]\nstatus: idea\narea: [one, two]\n---\n- [ ] Capture\n');
  f.service.saveConfig({ taskFolders: ['Meetings'], taskTags: '#action', excludedFolders: ['Meetings/Archive'] });
  const preview = await f.service.previewVault();
  assert.equal(preview.projects, 1); assert.equal(preview.taskNotes, 2); assert.equal(preview.tasks, 3);
  await ok(f.service.syncVault());
  const records = f.readRecords().accounts[APP];
  assert.equal(Object.values(records.projects)[0].parentTaskGuid, parent);
  assert.ok(Object.values(records.tasks).some(r => r.guid === existing));
  assert.equal(Object.keys(records.projects).length, 1);
  assert.equal(Object.keys(records.tasks).length, 3);
  const extra = Object.values(records.tasks).find(r => r.path === meeting.path);
  assert.equal(extra.tasklistGuid, records.hierarchy.vaultList.guid);
  assert.equal(f.remote.tasks.get(extra.guid).parent_task_guid, '');
  assert.ok(!meeting.content.includes('feishu-project'));
  assert.ok(!meeting.content.includes('status:'));
  assert.match(projectFolderNote.content, /status: idea\narea: \[one, two\]/);
  assert.equal((await f.service.readNote(projectFolderNote.path)).kind, 'task');
  f.remote.tasks.get(extra.guid).completed_at = '12345';
  await ok(f.service.syncVault()); assert.match(meeting.content, /- \[x\] Follow up/);
  meeting.content = meeting.content.replace('[x]', '[ ]');
  await ok(f.service.syncVault()); assert.equal(f.remote.tasks.get(extra.guid).completed_at, '0');
});

test('removing an extra tag stops synchronization and readding it resumes the same task', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  const file = f.addFile('Notes/action.md', '---\ntags: [action/next]\n---\n- [ ] Next\n');
  f.service.saveConfig({ taskTags: ['action'] }); await ok(f.service.syncVault());
  const record = Object.values(f.readRecords().accounts[APP].tasks).find(r => r.path === file.path);
  file.content = file.content.replace('action/next', 'reference').replace('[ ]', '[x]');
  await ok(f.service.syncVault());
  assert.equal(f.remote.tasks.get(record.guid).completed_at, '0');
  await assert.rejects(f.service.syncTask(record.id), /同步范围/);
  file.content = file.content.replace('reference', 'action/next');
  await ok(f.service.syncVault());
  assert.notEqual(f.remote.tasks.get(record.guid).completed_at, '0');
  assert.equal(Object.values(f.readRecords().accounts[APP].tasks).filter(r => r.path === file.path).length, 1);
  const created = f.remote.count('createTask');
  f.service.saveConfig({ taskTags: [] }); await ok(f.service.syncVault());
  f.service.saveConfig({ taskTags: ['action'] }); await ok(f.service.syncVault());
  assert.equal(f.remote.count('createTask'), created);
});

test('a first sync of an inline-tag note succeeds before Obsidian refreshes offsets after ID insertion', async t => {
  const f = fixture(t); f.configure({ taskTags: ['action'] });
  const file = f.addFile('Notes/inline.md', '- [ ] Inline action\n\n#action\n');
  const start = file.content.indexOf('#action');
  const tags = [{ tag: '#action', position: { start: { offset: start }, end: { offset: start + 7 } } }];
  const previous = f.app.metadataCache.getFileCache;
  f.app.metadataCache.getFileCache = target => ({ ...previous(target), ...(target === file ? { tags } : {}) });
  await ok(f.service.migrateVault());
  const record = Object.values(f.readRecords().accounts[APP].tasks).find(r => r.path === file.path);
  assert.ok(record.guid); assert.equal(record.state, 'linked');
  assert.equal(f.remote.tasks.get(record.guid).parent_task_guid, '');
});

test('transfer carries expanded scope and restores extra task associations on a second device', async t => {
  const source = fixture(t); source.configure({ taskFolders: ['Meetings'], taskTags: ['action'], excludedFolders: ['Archive'] });
  source.addFile('Meetings/weekly.md', '- [ ] Discuss\n');
  source.addFile('Notes/capture.md', '---\ntags: [action]\n---\n- [ ] Read\n');
  await ok(source.service.migrateVault());
  const bundle = source.service.exportTransfer();
  const target = fixture(t, source.remote, Object.fromEntries([...source.files].map(([p, f]) => [p, f.content])), 'second-device');
  target.configure();
  const preview = await target.service.previewTransfer(bundle);
  assert.equal(preview.missing, 0);
  await target.service.importTransfer(preview.token);
  assert.deepEqual(target.service.getConfig().taskFolders, ['Meetings']);
  assert.deepEqual(target.service.getConfig().taskTags, ['action']);
  assert.deepEqual(target.service.getConfig().excludedFolders, ['Archive']);
  const before = source.remote.count('createTask');
  await ok(target.service.syncVault());
  assert.equal(source.remote.count('createTask'), before);
  assert.equal((await target.service.previewVault()).taskNotes, 2);
});

test('extra tag rules keep daily opt-in and project priority, exclusions apply to every source', async t => {
  const f = fixture(t); f.configure({ taskTags: ['project', 'action'], excludedFolders: ['50_Tasks/private'] });
  f.addFile('50_Tasks/private/hidden.md', projectText());
  f.addFile('20_Review/Daily/2026-10-29.md', '---\ntags: [action]\n---\n- [ ] Daily\n');
  f.addFile('Notes/action.md', '---\ntags: [action]\n---\n- [ ] Task\n');
  assert.deepEqual((await f.service.listNotes()).sort(), [PROJECT, 'Notes/action.md'].sort());
  await ok(f.service.migrateVault());
  assert.equal(Object.keys(f.readRecords().accounts[APP].projects).length, 1);
  assert.equal((await f.service.previewVault()).dailyTasks, 0);
});

// This fixture parses scalars, flow arrays, and block arrays used by actual
// project frontmatter. Production Markdown parsing and surgical writes remain real.
const scalar = value => {
  value = value.trim();
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('[') && value.endsWith(']')) return value.slice(1, -1).split(',').filter(Boolean).map(scalar);
  return value;
};
const obsidian = {
  getFrontMatterInfo(content) {
    const match = /^(?:\uFEFF)?---(?:\r\n|\n|\r)([\s\S]*?)(?:\r\n|\n|\r)---(?:(?:\r\n|\n|\r)|$)/.exec(content);
    return match ? { exists: true, frontmatter: match[1], contentStart: match[0].length }
      : { exists: false, frontmatter: '', contentStart: 0 };
  },
  parseYaml(content) {
    const value = {}; let key;
    for (const line of content.split(/\r\n|\n|\r/)) {
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item && key && Array.isArray(value[key])) { value[key].push(scalar(item[1])); continue; }
      const pair = /^([\w-]+):\s*(.*)$/.exec(line);
      if (pair) { key = pair[1]; value[key] = pair[2] ? scalar(pair[2]) : []; }
    }
    return value;
  },
};

function remoteFixture() {
  const tasks = new Map(), lists = new Map(), sections = new Map(), fields = new Map(), calls = [], hooks = {};
  const missing = () => { throw new FeishuError('NOT_FOUND', '测试远端对象不存在'); };
  const task = guid => tasks.get(guid) || missing();
  const addList = name => { const guid = crypto.randomUUID(); lists.set(guid, { guid, name }); return guid; };
  const checkFields = values => {
    for (const value of values || []) {
      const field = fields.get(value.guid);
      assert.ok(field, 'Custom field must use the existing field GUID');
      assert.ok(field.single_select_setting.options.some(option => option.guid === value.single_select_value),
        'Single-select values must use an option GUID, not its name');
    }
  };
  const operations = {
    check: async () => ({ ok: true }),
    listTasklists: async () => [...lists.values()].map(clone),
    getTasklist: async guid => clone(lists.get(guid) || missing()),
    createTasklist: async payload => { const guid = addList(payload.name); Object.assign(lists.get(guid), clone(payload)); return clone(lists.get(guid)); },
    updateTasklist: async (guid, patch) => { Object.assign(lists.get(guid) || missing(), clone(patch)); return clone(lists.get(guid)); },
    listTasks: async guid => [...tasks.values()].filter(value => value.tasklists?.some(list => list.tasklist_guid === guid)).map(clone),
    getTask: async guid => clone(task(guid)),
    createTask: async payload => {
      checkFields(payload.custom_fields);
      const value = { completed_at: '0', mode: 2, parent_task_guid: '', tasklists: [], ...clone(payload), guid: crypto.randomUUID() };
      tasks.set(value.guid, value); return clone(value);
    },
    updateTask: async (guid, patch) => {
      checkFields(patch.custom_fields);
      const value = task(guid), { custom_fields, ...other } = clone(patch);
      Object.assign(value, other);
      if (custom_fields) {
        value.custom_fields ||= [];
        for (const field of custom_fields) {
          const existing = value.custom_fields.find(item => item.guid === field.guid);
          if (existing) Object.assign(existing, field); else value.custom_fields.push(field);
        }
      }
      return clone(value);
    },
    setTaskParent: async (guid, parentGuid = null) => { if (parentGuid) task(parentGuid); task(guid).parent_task_guid = parentGuid || ''; return {}; },
    addTasklist: async (guid, listGuid, sectionGuid) => {
      assert.ok(lists.has(listGuid)); if (sectionGuid) assert.ok(sections.has(sectionGuid));
      const value = task(guid); value.tasklists ||= [];
      const relation = value.tasklists.find(list => list.tasklist_guid === listGuid);
      const next = { tasklist_guid: listGuid, ...(sectionGuid ? { section_guid: sectionGuid } : {}) };
      if (relation) Object.assign(relation, next); else value.tasklists.push(next);
      return clone(value);
    },
    removeTasklist: async (guid, listGuid) => { const value = task(guid); value.tasklists = value.tasklists.filter(list => list.tasklist_guid !== listGuid); return clone(value); },
    listTasklistsForTask: async guid => clone(task(guid).tasklists || []),
    listSections: async listGuid => [...sections.values()].filter(section => section.resource_id === listGuid).map(clone),
    getSection: async guid => {
      const { resource_id, ...section } = clone(sections.get(guid) || missing());
      return section;
    },
    createSection: async payload => {
      const value = { ...clone(payload), guid: crypto.randomUUID(), is_default: false,
        tasklist: clone(lists.get(payload.resource_id) || missing()) };
      sections.set(value.guid, value); return clone(value);
    },
    updateSection: async (guid, patch) => { Object.assign(sections.get(guid) || missing(), clone(patch)); return clone(sections.get(guid)); },
    listCustomFields: async listGuid => [...fields.values()].filter(field => field.resource_id === listGuid).map(clone),
    getCustomField: async guid => clone(fields.get(guid) || missing()),
    createCustomField: async payload => {
      const value = { ...clone(payload), guid: crypto.randomUUID(), single_select_setting: { ...clone(payload.single_select_setting),
        options: payload.single_select_setting.options.map(option => ({ is_hidden: false, color_index: 0, ...clone(option), guid: crypto.randomUUID() })) } };
      fields.set(value.guid, value); return clone(value);
    },
    updateCustomField: async (guid, patch) => { Object.assign(fields.get(guid) || missing(), clone(patch)); return clone(fields.get(guid)); },
  };
  const api = Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name, async (...args) => {
    calls.push([name, ...clone(args)]); return hooks[name] ? hooks[name](...args, operation) : operation(...args);
  }]));
  const count = name => calls.filter(call => call[0] === name).length;
  const fieldValue = taskGuid => {
    const values = task(taskGuid).custom_fields || [];
    for (const value of values) {
      const option = fields.get(value.guid)?.single_select_setting.options.find(item => item.guid === value.single_select_value);
      if (option && Object.values(statusNames).includes(option.name)) return option.name;
    }
    return undefined;
  };
  return { tasks, lists, sections, fields, calls, hooks, api, addList, count, fieldValue };
}

function fixture(t, remote = remoteFixture(), initial = { [PROJECT]: projectText() }, label = 'study') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-hierarchy-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = new Map(), writes = [];
  const addFile = (notePath, content) => { const file = { path: notePath, basename: path.basename(notePath, '.md'), extension: 'md', content }; files.set(notePath, file); return file; };
  for (const [notePath, content] of Object.entries(initial)) addFile(notePath, content);
  for (const area of ['program', 'neuroscience']) addFile('00_Area/' + area + '.md', '# ' + area + '\n');
  const app = {
    vault: {
      adapter: { getBasePath: () => '/unit-test/' + label },
      getAbstractFileByPath: notePath => files.get(notePath) || null,
      getFileByPath: notePath => files.get(notePath) || null,
      getMarkdownFiles: () => [...files.values()],
      read: async file => file.content,
      cachedRead: async file => file.content,
      process: async (file, updater) => { writes.push(file.path); file.content = updater(file.content); },
    },
    metadataCache: {
      getFirstLinkpathDest: target => [...files.values()].find(file => file.path === target || file.path === target + '.md' || file.basename === target) || null,
      getFileCache: file => ({ frontmatter: obsidian.parseYaml(obsidian.getFrontMatterInfo(file.content).frontmatter) }),
    },
    workspace: { trigger() {} },
  };
  const dependencies = { directory, now: () => Date.UTC(2026, 9, 4),
    safeStorage: () => ({ encryptString: value => Buffer.from(value.split('').reverse().join('')), decryptString: value => value.toString().split('').reverse().join('') }),
    createFeishuClient: () => remote.api };
  const service = createService(app, obsidian, dependencies);
  const configure = options => service.saveConfig({ appId: APP, secret: 'test-secret', assigneeId: 'ou_test', autoEnabled: false, ...options });
  const readRecords = () => JSON.parse(fs.readFileSync(path.join(directory, 'records.json'), 'utf8'));
  const status = notePath => obsidian.parseYaml(obsidian.getFrontMatterInfo(files.get(notePath).content).frontmatter).status;
  const setStatus = (notePath, value) => { files.get(notePath).content = files.get(notePath).content.replace(/^status:.*$/m, 'status: ' + value); };
  const seedLegacy = (notePath = PROJECT) => {
    const vaultId = service.getConfig().vaultId, projectId = crypto.randomUUID();
    const file = files.get(notePath), listGuid = remote.addList('[' + label + '] ' + file.basename);
    const state = fs.existsSync(path.join(directory, 'records.json')) ? readRecords() : { version: 1, accounts: {} };
    const account = state.accounts[APP] ||= { tasks: {}, projects: {} };
    file.content = file.content.replace('## 下一步行动', '<!-- feishu-project: ' + vaultId + '/' + projectId + ' -->\n## 下一步行动');
    const actionGuids = [];
    file.content = file.content.replace(/^(- \[([ xX])\] .+)$/gm, (raw, _, checkbox) => {
      const id = crypto.randomUUID(), guid = crypto.randomUUID(), done = /^[xX]$/.test(checkbox);
      const payload = { summary: raw.replace(/^- \[[ xX]\] /, ''), description: 'Obsidian 来源：' + file.basename,
        completed_at: done ? String(Date.UTC(2026, 9, 4)) : '0', mode: 2, parent_task_guid: '',
        extra: JSON.stringify({ source: 'obsidian-feishu-sync', version: 2, vaultId, id }), tasklists: [{ tasklist_guid: listGuid }] };
      remote.tasks.set(guid, { ...clone(payload), guid }); actionGuids.push(guid);
      account.tasks[id] = { id, path: notePath, guid, tasklistGuid: listGuid, payload, state: 'linked',
        baseline: { done, summary: payload.summary, completedAt: payload.completed_at } };
      return raw + ' <!-- feishu-task: ' + vaultId + '/' + id + ' -->';
    });
    account.projects[projectId] = { id: projectId, path: notePath, guid: listGuid, name: remote.lists.get(listGuid).name, state: 'linked' };
    atomicJSON(path.join(directory, 'records.json'), state);
    return { projectId, listGuid, actionGuids };
  };
  return { service, remote, app, dependencies, files, writes, directory, configure, addFile, readRecords, status, setStatus, seedLegacy };
}

async function ok(operation) {
  const result = await operation;
  assert.equal(result?.failed || 0, 0, JSON.stringify(result)); return result;
}
async function failure(operation) {
  let result;
  try { result = await operation(); } catch (error) { assert.ok(error instanceof Error); return error; }
  assert.ok(result?.failed > 0 || result?.state === 'conflict' || result?.results?.some(item => item.ok === false), JSON.stringify(result));
  return result;
}
const parent = async (f, notePath = PROJECT) => {
  const note = await f.service.readNote(notePath);
  assert.ok(note.projectRecord?.guid, 'Project must expose its parent task GUID');
  return f.remote.tasks.get(note.projectRecord.guid);
};

test('hierarchy display names are editable without renaming notes or changing remote GUIDs', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  const before = f.readRecords().accounts[APP], project = Object.values(before.projects)[0];
  const section = before.hierarchy.sections['00_Area/program.md'];
  const content = f.files.get(PROJECT).content;
  f.service.saveConfig({ vaultLabel: 'phd study', vaultTasklistName: '博士研究清单',
    areaNames: { '00_Area/program.md': '计算与实验' }, projectNames: { [project.id]: '实验进展' } });
  await ok(f.service.syncVault());
  assert.equal(f.remote.lists.get(before.hierarchy.vaultList.guid).name, '博士研究清单');
  assert.equal(f.remote.sections.get(section.guid).name, '计算与实验');
  assert.equal(f.remote.tasks.get(project.parentTaskGuid).summary, '实验进展');
  assert.equal(f.files.get(PROJECT).content, content);
  assert.equal(f.remote.count('createTasklist'), 1); assert.equal(f.remote.count('createSection'), 1);
  assert.equal(f.remote.count('createTask'), 2);
  f.service.saveConfig({ areaNames: {}, projectNames: {} }); await ok(f.service.syncVault());
  assert.equal(f.remote.sections.get(section.guid).name, 'program');
  assert.equal(f.remote.tasks.get(project.parentTaskGuid).summary, 'example');
});

test('cross-device transfer retains identities and hierarchy GUIDs across changed folders', async t => {
  const source = fixture(t); source.configure(); await ok(source.service.migrateVault());
  const bundle = source.service.exportTransfer();
  assert.equal('encryptedSecret' in bundle.config, false);
  assert.equal('hasSecret' in bundle.config, false);
  assert.equal(JSON.stringify(bundle).includes('test-secret'), false);
  const destinationPath = '004_Tasks/renamed-project.md';
  const target = fixture(t, source.remote, { [destinationPath]: source.files.get(PROJECT).content }, 'windows-phd');
  target.configure({ projectFolder: '004_Tasks', dailyFolder: '001_diary' });
  const createCount = source.remote.count('createTask'), listCount = source.remote.count('createTasklist');
  const writes = target.writes.length, calls = source.remote.calls.length;
  const preview = await target.service.previewTransfer(JSON.stringify(bundle), { projectFolder: '004_Tasks', dailyFolder: '001_diary' });
  assert.equal(preview.remapped, 2); assert.equal(preview.missing, 0);
  assert.equal(source.remote.calls.length, calls); assert.equal(target.writes.length, writes);
  assert.equal(fs.existsSync(path.join(target.directory, 'records.json')), false);
  const imported = await target.service.importTransfer(preview.token);
  assert.equal(imported.config.vaultId, source.service.getConfig().vaultId);
  assert.equal(imported.config.autoEnabled, false);
  assert.equal(fs.existsSync(path.join(imported.backupPath, 'config.json')), true);
  assert.equal(source.remote.calls.length, calls);
  const beforeCheck = fs.readFileSync(path.join(target.directory, 'records.json'), 'utf8');
  assert.equal((await target.service.checkAssociations()).failed, 0);
  assert.equal(fs.readFileSync(path.join(target.directory, 'records.json'), 'utf8'), beforeCheck);
  assert.equal(target.writes.length, writes);
  await ok(target.service.syncVault());
  assert.equal(source.remote.count('createTask'), createCount);
  assert.equal(source.remote.count('createTasklist'), listCount);
  const records = target.readRecords().accounts[APP];
  assert.equal(Object.values(records.projects)[0].path, destinationPath);
  assert.equal(Object.values(records.tasks)[0].path, destinationPath);
});

test('transfer without local credentials imports identity but requires a new device secret', async t => {
  const source = fixture(t); source.configure(); await ok(source.service.migrateVault());
  const target = fixture(t, source.remote, { [PROJECT]: source.files.get(PROJECT).content }, 'new-device');
  const preview = await target.service.previewTransfer(source.service.exportTransfer());
  await target.service.importTransfer(preview.token);
  assert.equal(target.service.getConfig().hasSecret, false);
  await assert.rejects(target.service.check(), /先配置/);
  target.service.saveConfig({ secret: 'new-device-secret' });
  assert.equal(target.service.getConfig().vaultId, source.service.getConfig().vaultId);
  assert.equal((await target.service.checkAssociations()).failed, 0);
});

test('transfer rejects stale previews, foreign markers, missing records, unsafe data and GUID conflicts', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  const original = f.service.exportTransfer();
  const preview = await f.service.previewTransfer(original);
  f.files.get(PROJECT).content += '\nChanged after preview\n';
  await assert.rejects(f.service.importTransfer(preview.token), /重新预览/);
  const damaged = clone(original); damaged.config.encryptedSecret = 'secret';
  await assert.rejects(f.service.previewTransfer(damaged), /密钥/);
  const account = clone(original); account.config.appId = 'cli_other';
  await assert.rejects(f.service.previewTransfer(account), /账号|App ID/);
  const id = Object.keys(original.records.accounts[APP].tasks)[0];
  const wrongGuid = clone(original); wrongGuid.records.accounts[APP].tasks[id].guid = crypto.randomUUID();
  await assert.rejects(f.service.previewTransfer(wrongGuid), /GUID 冲突/);
  const lost = clone(original); delete lost.records.accounts[APP].tasks[id];
  // Existing local records remain trusted; a fresh device must reject missing history.
  const fresh = fixture(t, f.remote, { [PROJECT]: f.files.get(PROJECT).content }, 'fresh');
  await assert.rejects(fresh.service.previewTransfer(lost), /缺少.*可信关联/);
  fresh.files.get(PROJECT).content = fresh.files.get(PROJECT).content.replaceAll(original.config.vaultId, crypto.randomUUID());
  await assert.rejects(fresh.service.previewTransfer(original), /其他仓库/);
  assert.throws(() => f.service.saveConfig({ vaultId: crypto.randomUUID() }), /已有飞书关联/);
});

test('interrupted transfer blocks all use and resumes both files on reopening', async t => {
  const source = fixture(t); source.configure(); await ok(source.service.migrateVault());
  const target = fixture(t, source.remote, { [PROJECT]: source.files.get(PROJECT).content }, 'interrupted');
  target.configure();
  const bundle = source.service.exportTransfer();
  const failConfig = (filename, value) => {
    if (filename === path.join(target.directory, 'config.json') && value.vaultId === bundle.config.vaultId) throw new Error('disk full');
    atomicJSON(filename, value);
  };
  const service = createService(target.app, obsidian, { ...target.dependencies, atomicJSON: failConfig });
  const preview = await service.previewTransfer(bundle);
  await assert.rejects(service.importTransfer(preview.token), /尚未完整保存/);
  assert.throws(() => service.getConfig(), /尚未完整保存/);
  assert.throws(() => service.exportTransfer(), /尚未完整保存/);
  assert.equal(fs.existsSync(path.join(target.directory, 'restore-pending.json')), true);
  const reopened = createService(target.app, obsidian, target.dependencies);
  assert.equal(reopened.getConfig().vaultId, source.service.getConfig().vaultId);
  assert.equal(fs.existsSync(path.join(target.directory, 'restore-pending.json')), false);
  assert.equal((await reopened.checkAssociations()).failed, 0);
});

test('a failed pre-import backup preserves local files and creates no restore transaction', async t => {
  const source = fixture(t); source.configure(); await ok(source.service.migrateVault());
  const target = fixture(t, source.remote, { [PROJECT]: source.files.get(PROJECT).content }, 'backup-failure'); target.configure();
  const before = fs.readFileSync(path.join(target.directory, 'config.json'), 'utf8');
  const service = createService(target.app, obsidian, { ...target.dependencies, atomicJSON: (filename, value) => {
    if (filename.includes(path.sep + 'backups' + path.sep)) throw new Error('backup failed');
    atomicJSON(filename, value);
  } });
  const preview = await service.previewTransfer(source.service.exportTransfer());
  await assert.rejects(service.importTransfer(preview.token), /backup failed/);
  assert.equal(fs.readFileSync(path.join(target.directory, 'config.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(target.directory, 'records.json')), false);
  assert.equal(fs.existsSync(path.join(target.directory, 'restore-pending.json')), false);
});

test('association checks report changed ownership and parent relationships without writing', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  const records = f.readRecords(), action = Object.values(records.accounts[APP].tasks)[0];
  const remote = f.remote.tasks.get(action.guid);
  const before = fs.readFileSync(path.join(f.directory, 'records.json'), 'utf8'), writes = f.writes.length;
  remote.parent_task_guid = crypto.randomUUID();
  let result = await f.service.checkAssociations();
  assert.equal(result.failed, 1); assert.match(result.results.find(r => !r.ok).message, /父任务关系/);
  remote.parent_task_guid = action.parentTaskGuid;
  remote.extra = JSON.stringify({ ...JSON.parse(remote.extra), vaultId: crypto.randomUUID() });
  result = await f.service.checkAssociations();
  assert.equal(result.failed, 1); assert.match(result.results.find(r => !r.ok).message, /标识不匹配/);
  assert.equal(fs.readFileSync(path.join(f.directory, 'records.json'), 'utf8'), before);
  assert.equal(f.writes.length, writes);
});

test('migration requires paused automation and does not start remote work when autoEnabled is true', async t => {
  const f = fixture(t); f.configure({ autoEnabled: true });
  const before = f.files.get(PROJECT).content;
  await failure(() => f.service.migrateVault());
  assert.equal(f.files.get(PROJECT).content, before);
  assert.equal(f.remote.calls.length, 0);
  assert.notEqual(f.service.getConfig().hierarchyEnabled, true);
});

test('migration preserves action GUIDs and old list memberships while creating parents for empty projects', async t => {
  const f = fixture(t, undefined, { [PROJECT]: projectText(), [EMPTY]: projectText('', 'todo') }); f.configure();
  const legacy = f.seedLegacy(PROJECT), emptyLegacy = f.seedLegacy(EMPTY);
  const initial = await f.service.getHierarchyStatus();
  assert.equal(initial.enabled, false); assert.equal(initial.migration.state, 'legacy');
  assert.equal(initial.migration.legacyProjects, 2); assert.equal(initial.migration.legacyTasks, 1);
  await ok(f.service.migrateVault());
  const status = await f.service.getHierarchyStatus();
  assert.equal(status.enabled, true); assert.equal(status.migration.state, 'ready');
  assert.ok(status.vaultList?.guid); assert.equal(f.service.getConfig().autoEnabled, false);
  const root = await parent(f), emptyRoot = await parent(f, EMPTY);
  assert.notEqual(root.guid, emptyRoot.guid);
  assert.equal(f.remote.tasks.get(legacy.actionGuids[0]).parent_task_guid, root.guid);
  assert.ok(f.remote.tasks.get(legacy.actionGuids[0]).tasklists.some(list => list.tasklist_guid === legacy.listGuid));
  assert.ok(f.remote.lists.has(legacy.listGuid)); assert.ok(f.remote.lists.has(emptyLegacy.listGuid));
  assert.equal(f.remote.count('removeTasklist'), 0);
  const note = await f.service.readNote(PROJECT);
  assert.equal(note.projectRecord.legacyTasklistGuid, legacy.listGuid);
  assert.equal(note.areaName, 'program'); assert.equal(note.projectStatus, 'doing');
  assert.equal(f.remote.tasks.size, 3);
  const guids = [...f.remote.tasks.keys()].sort();
  await ok(f.service.migrateVault()); await ok(f.service.syncProject(PROJECT));
  assert.deepEqual([...f.remote.tasks.keys()].sort(), guids);
  assert.equal(f.readRecords().accounts[APP].projects[legacy.projectId].guid, legacy.listGuid);
});

test('selected migration does not convert an unselected legacy project', async t => {
  const f = fixture(t, undefined, { [PROJECT]: projectText(), [EMPTY]: projectText('- [ ] 稍后迁移\n', 'todo') }); f.configure();
  const first = f.seedLegacy(PROJECT), later = f.seedLegacy(EMPTY), untouched = f.files.get(EMPTY).content;
  await ok(f.service.migrateVault({ paths: [PROJECT] }));
  assert.equal(f.remote.tasks.get(first.actionGuids[0]).parent_task_guid, (await parent(f)).guid);
  assert.equal(f.remote.tasks.get(later.actionGuids[0]).parent_task_guid, '');
  assert.equal(f.files.get(EMPTY).content, untouched);
  assert.equal((await f.service.getHierarchyStatus()).migration.state, 'migrating');
});

test('syncProject includes every ordinary checkbox and parent completion never cascades to children', async t => {
  const f = fixture(t, undefined, { [PROJECT]: projectText('- [ ] 未完成\n## 其他章节\n- [x] 已完成\n- [?] 自定义\n') });
  f.configure(); await ok(f.service.migrateVault());
  const root = await parent(f), children = [...f.remote.tasks.values()].filter(task => task.parent_task_guid === root.guid);
  assert.equal(children.length, 2); assert.equal(children.find(task => task.summary === '未完成').completed_at, '0');
  assert.notEqual(children.find(task => task.summary === '已完成').completed_at, '0');
  root.completed_at = String(Date.UTC(2026, 9, 4) + 5000);
  await ok(f.service.syncProject(PROJECT));
  assert.equal(f.status(PROJECT), 'done');
  assert.match(f.files.get(PROJECT).content, /^doneTime:/m);
  assert.match(f.files.get(PROJECT).content, /- \[ \] 未完成/);
  assert.match(f.files.get(PROJECT).content, /- \[x\] 已完成/);
  assert.match(f.files.get(PROJECT).content, /- \[\?\] 自定义\n/);
  root.completed_at = '0';
  await ok(f.service.syncProject(PROJECT));
  assert.equal(f.status(PROJECT), 'doing'); assert.doesNotMatch(f.files.get(PROJECT).content, /^doneTime:/m);
  assert.match(f.files.get(PROJECT).content, /^custom: keep$/m);
});

test('project parents and children inherit createTime and backfill existing GUIDs only once', async t => {
  const content = projectText().replace('custom: keep\n', 'createTime: "2026-10-04 21:18"\ncustom: keep\n');
  const f = fixture(t, remoteFixture(), { [PROJECT]: content }); f.configure();
  await ok(f.service.migrateVault());
  const root = await parent(f);
  const child = [...f.remote.tasks.values()].find(task => task.parent_task_guid === root.guid);
  const start = { timestamp: String(Date.UTC(2026, 9, 4, 13, 18)), is_all_day: false };
  assert.deepEqual(root.start, start); assert.deepEqual(child.start, start);
  const creations = f.remote.count('createTask');
  delete root.start; delete child.start;
  const updates = f.remote.count('updateTask');
  await ok(f.service.syncProject(PROJECT));
  assert.deepEqual(root.start, start); assert.deepEqual(child.start, start);
  assert.equal(f.remote.count('createTask'), creations);
  assert.equal(f.remote.count('updateTask'), updates + 2);
  await ok(f.service.syncProject(PROJECT));
  assert.equal(f.remote.count('updateTask'), updates + 2);
  const manual = { timestamp: String(Date.UTC(2026, 9, 5)), is_all_day: true };
  root.start = clone(manual); child.start = clone(manual);
  await ok(f.service.syncProject(PROJECT));
  assert.deepEqual(root.start, manual); assert.deepEqual(child.start, manual);
  assert.equal(f.remote.count('updateTask'), updates + 2);
  assert.match(f.files.get(PROJECT).content, /createTime: "2026-10-04 21:18"/);
});

test('local project states use the four option GUIDs and canceled stays distinct from done', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  const root = await parent(f);
  for (const state of ['todo', 'doing', 'done', 'canceled']) {
    f.setStatus(PROJECT, state); await ok(f.service.syncProject(PROJECT));
    assert.equal(f.remote.fieldValue(root.guid), statusNames[state]);
    assert.equal(root.completed_at !== '0', state === 'done' || state === 'canceled');
    assert.match(f.files.get(PROJECT).content, /- \[ \] 行动 A/);
  }
  root.completed_at = String(Date.UTC(2026, 9, 4) + 9000);
  await ok(f.service.syncProject(PROJECT));
  assert.equal(f.status(PROJECT), 'canceled'); assert.equal(f.remote.fieldValue(root.guid), '已取消');
  root.completed_at = '0';
  await failure(() => f.service.syncProject(PROJECT));
  assert.equal(f.status(PROJECT), 'canceled');
  f.setStatus(PROJECT, 'todo'); await ok(f.service.syncProject(PROJECT));
  assert.equal(root.completed_at, '0'); assert.equal(f.remote.fieldValue(root.guid), '待办');
});

test('a timed-out parent creation recovers by identity after restart without a second parent', async t => {
  const f = fixture(t); f.configure(); const legacy = f.seedLegacy();
  f.remote.hooks.createTask = async (payload, operation) => {
    delete f.remote.hooks.createTask;
    await operation(payload);
    throw new FeishuError('TIMEOUT', '父任务创建结果待确认', { uncertain: true });
  };
  await failure(() => f.service.migrateVault());
  const existing = new Set(f.remote.tasks.keys());
  const restarted = createService(f.app, obsidian, f.dependencies);
  await ok(restarted.migrateVault());
  const note = await restarted.readNote(PROJECT);
  assert.ok(existing.has(note.projectRecord.guid));
  assert.equal(f.remote.tasks.get(legacy.actionGuids[0]).parent_task_guid, note.projectRecord.guid);
  assert.equal(f.remote.count('createTask'), 1); assert.equal(f.remote.tasks.size, 2);
});

test('parent recovery uses the saved creation baseline when the remote project was completed meanwhile', async t => {
  const f = fixture(t); f.configure(); const legacy = f.seedLegacy();
  f.remote.hooks.createTask = async (payload, operation) => {
    delete f.remote.hooks.createTask;
    const created = await operation(payload);
    f.remote.tasks.get(created.guid).completed_at = String(Date.UTC(2026, 9, 4) + 5000);
    throw new FeishuError('TIMEOUT', '父任务创建结果待确认', { uncertain: true });
  };
  await failure(() => f.service.migrateVault());
  const restarted = createService(f.app, obsidian, f.dependencies);
  await ok(restarted.migrateVault());
  const note = await restarted.readNote(PROJECT);
  assert.equal(f.status(PROJECT), 'done'); assert.equal(f.remote.fieldValue(note.projectRecord.guid), '已完成');
  assert.equal(f.remote.tasks.get(legacy.actionGuids[0]).parent_task_guid, note.projectRecord.guid);
  assert.equal(f.remote.tasks.get(legacy.actionGuids[0]).completed_at, '0');
  assert.equal(f.remote.count('createTask'), 1); assert.equal(f.remote.tasks.size, 2);
});

test('unknown section creation never causes an automatic duplicate section', async t => {
  const f = fixture(t); f.configure(); f.seedLegacy();
  f.remote.hooks.createSection = async (payload, operation) => {
    delete f.remote.hooks.createSection;
    await operation(payload);
    throw new FeishuError('TIMEOUT', '分组创建结果待确认', { uncertain: true });
  };
  await failure(() => f.service.migrateVault());
  try { await f.service.migrateVault(); } catch (_) { /* Remaining uncertain is safe when a section lacks recoverable identity. */ }
  assert.equal(f.remote.count('createSection'), 1); assert.equal(f.remote.sections.size, 1);
});

test('an uncertain section is exposed for recovery and the verified GUID resumes migration without a duplicate', async t => {
  const f = fixture(t); f.configure(); const legacy = f.seedLegacy();
  f.remote.hooks.createSection = async (payload, operation) => {
    delete f.remote.hooks.createSection;
    await operation(payload);
    throw new FeishuError('TIMEOUT', '分组创建结果待确认', { uncertain: true });
  };
  await failure(() => f.service.migrateVault());
  const recovery = f.service.getHierarchyStatus().recoveries.find(item => item.kind === 'section');
  assert.ok(recovery?.key); assert.equal(recovery.name, 'program'); assert.equal(recovery.state, 'uncertain');
  const section = [...f.remote.sections.values()][0];
  const recovered = await f.service.recoverHierarchyResource({ kind: 'section', key: recovery.key, guid: section.guid });
  assert.equal(recovered.recoveries.some(item => item.kind === 'section' && item.key === recovery.key), false);
  await ok(f.service.migrateVault());
  const root = await parent(f), listGuid = f.service.getHierarchyStatus().vaultList.guid;
  assert.equal(f.service.getHierarchyStatus().migration.state, 'ready');
  assert.equal(root.tasklists.find(item => item.tasklist_guid === listGuid).section_guid, section.guid);
  assert.equal(f.remote.tasks.get(legacy.actionGuids[0]).parent_task_guid, root.guid);
  assert.equal(f.remote.count('createSection'), 1); assert.equal(f.remote.sections.size, 1);
  assert.equal(f.remote.tasks.size, 2);
});

test('section recovery rejects a different name or vault list and retains the uncertain record', async t => {
  const f = fixture(t); f.configure(); f.seedLegacy();
  f.remote.hooks.createSection = async (payload, operation) => {
    delete f.remote.hooks.createSection;
    await operation(payload);
    throw new FeishuError('TIMEOUT', '分组创建结果待确认', { uncertain: true });
  };
  await failure(() => f.service.migrateVault());
  const recovery = f.service.getHierarchyStatus().recoveries.find(item => item.kind === 'section');
  const section = [...f.remote.sections.values()][0];
  const foreignList = f.remote.addList('[lab] 项目');
  for (const patch of [{ name: 'wrong area' }, { tasklist: clone(f.remote.lists.get(foreignList)) }]) {
    const candidate = { ...clone(section), ...patch, guid: crypto.randomUUID() };
    f.remote.sections.set(candidate.guid, candidate);
    await assert.rejects(f.service.recoverHierarchyResource({ kind: 'section', key: recovery.key, guid: candidate.guid }), /名称或所属仓库清单/);
    assert.deepEqual(f.service.getHierarchyStatus().recoveries.find(item => item.kind === 'section' && item.key === recovery.key), recovery);
  }
  assert.notEqual(f.service.getHierarchyStatus().migration.state, 'ready');
  assert.equal(f.remote.count('createSection'), 1); assert.equal(f.remote.count('createTask'), 0);
});

test('resource recovery refuses to run while automation is enabled and preserves its uncertain section', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  f.service.saveConfig({ autoEnabled: true });
  f.files.get(PROJECT).content = f.files.get(PROJECT).content.replace('[[program]]', '[[neuroscience]]');
  f.remote.hooks.createSection = async (payload, operation) => {
    delete f.remote.hooks.createSection;
    await operation(payload);
    throw new FeishuError('TIMEOUT', '分组创建结果待确认', { uncertain: true });
  };
  await failure(() => f.service.syncProject(PROJECT));
  const recovery = f.service.getHierarchyStatus().recoveries.find(item => item.kind === 'section');
  assert.ok(recovery); assert.equal(recovery.state, 'uncertain');
  const section = [...f.remote.sections.values()].find(item => item.name === recovery.name), calls = f.remote.calls.length;
  assert.throws(() => f.service.recoverHierarchyResource({ kind: 'section', key: recovery.key, guid: section.guid }), /关闭自动同步/);
  assert.equal(f.remote.calls.length, calls);
  assert.deepEqual(f.service.getHierarchyStatus().recoveries.find(item => item.kind === 'section' && item.key === recovery.key), recovery);
});

test('changing area moves the same parent to another section without replacing its children', async t => {
  const f = fixture(t); f.configure(); const legacy = f.seedLegacy(); await ok(f.service.migrateVault());
  const root = await parent(f), guids = [...f.remote.tasks.keys()].sort();
  const listGuid = (await f.service.getHierarchyStatus()).vaultList.guid;
  const before = root.tasklists.find(list => list.tasklist_guid === listGuid)?.section_guid;
  assert.ok(before);
  f.files.get(PROJECT).content = f.files.get(PROJECT).content.replace('[[program]]', '[[neuroscience]]');
  await ok(f.service.syncProject(PROJECT));
  const after = root.tasklists.find(list => list.tasklist_guid === listGuid)?.section_guid;
  assert.notEqual(after, before); assert.equal(f.remote.sections.get(after).name, 'neuroscience');
  assert.deepEqual([...f.remote.tasks.keys()].sort(), guids);
  assert.equal(f.remote.tasks.get(legacy.actionGuids[0]).parent_task_guid, root.guid);
  assert.equal((await f.service.readNote(PROJECT)).areaName, 'neuroscience');
});

test('losing and restoring an Area note retains its group, custom name, parent and child GUIDs', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  f.service.saveConfig({ areaNames: { '00_Area/program.md': '计算与实验' } });
  const before = f.readRecords().accounts[APP], guids = [...f.remote.tasks.keys()].sort();
  const section = before.hierarchy.sections['00_Area/program.md'];
  f.files.delete('00_Area/program.md');
  await ok(f.service.syncProject(PROJECT));
  assert.deepEqual(Object.keys(f.readRecords().accounts[APP].hierarchy.sections), ['00_Area/program.md']);
  assert.equal(f.remote.sections.get(section.guid).name, '计算与实验');
  f.addFile('00_Area/program.md', '# program\n');
  await ok(f.service.syncProject(PROJECT));
  assert.equal(f.remote.count('createSection'), 1);
  assert.deepEqual([...f.remote.tasks.keys()].sort(), guids);
  for (const record of Object.values(before.projects)) {
    const next = f.readRecords().accounts[APP].projects[record.id];
    assert.equal(next.parentTaskGuid, record.parentTaskGuid);
    assert.equal(next.sectionGuid, section.guid);
    assert.equal(next.areaKey, '00_Area/program.md');
  }
  for (const record of Object.values(before.tasks)) {
    assert.equal(f.readRecords().accounts[APP].tasks[record.id].guid, record.guid);
    assert.equal(f.remote.tasks.get(record.guid).parent_task_guid, record.parentTaskGuid);
  }
});

test('an initially unresolved Area keeps its existing group when its note is created', async t => {
  const f = fixture(t); f.files.delete('00_Area/program.md'); f.configure();
  await ok(f.service.migrateVault());
  const section = f.readRecords().accounts[APP].hierarchy.sections.program;
  f.addFile('00_Area/program.md', '# program\n');
  await ok(f.service.syncProject(PROJECT));
  assert.deepEqual(Object.keys(f.readRecords().accounts[APP].hierarchy.sections), ['program']);
  assert.equal(Object.values(f.readRecords().accounts[APP].projects)[0].sectionGuid, section.guid);
  assert.equal(f.remote.count('createSection'), 1);
});

test('unavailable link metadata does not duplicate a previously resolved Area', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  f.app.metadataCache.getFirstLinkpathDest = () => null;
  await ok(f.service.syncProject(PROJECT));
  assert.equal(f.remote.count('createSection'), 1);
  assert.equal(Object.values(f.readRecords().accounts[APP].projects)[0].areaKey, '00_Area/program.md');
});

test('a formerly unresolved group remembers its resolved note across different link contexts', async t => {
  const f = fixture(t); f.files.delete('00_Area/program.md'); f.configure(); await ok(f.service.migrateVault());
  f.addFile('00_Area/program.md', '# program\n'); await ok(f.service.syncProject(PROJECT));
  const original = f.readRecords().accounts[APP].hierarchy.sections.program;
  assert.equal(original.sourcePath, '00_Area/program.md');
  const other = '50_Tasks/other/example.md';
  f.addFile('Other/program.md', '# different program\n');
  f.addFile(other, projectText('', 'todo', 'Other/program'));
  const resolve = f.app.metadataCache.getFirstLinkpathDest;
  f.app.metadataCache.getFirstLinkpathDest = (target, source) => target === 'program' && source === other
    ? f.files.get('Other/program.md') : resolve(target, source);
  await ok(f.service.syncProject(other));
  const sections = f.readRecords().accounts[APP].hierarchy.sections;
  assert.equal(sections.program.guid, original.guid);
  assert.notEqual(sections['Other/program.md'].guid, original.guid);
  assert.equal(f.remote.count('createSection'), 2);
  f.app.metadataCache.getFirstLinkpathDest = () => null;
  const failed = await failure(() => f.service.syncProject(PROJECT));
  assert.match(JSON.stringify(failed), /多个已有分组/);
  assert.equal(f.remote.count('createSection'), 2);
});

test('distinct explicit Area paths with the same basename keep separate groups', async t => {
  const f = fixture(t, undefined, { [PROJECT]: projectText(), [EMPTY]: projectText('', 'todo', 'Other/program') });
  f.addFile('Other/program.md', '# other program\n'); f.configure(); await ok(f.service.migrateVault());
  assert.equal(f.remote.count('createSection'), 2);
  const before = f.readRecords().accounts[APP];
  assert.notEqual(before.hierarchy.sections['00_Area/program.md'].guid, before.hierarchy.sections['Other/program.md'].guid);
  f.files.delete('Other/program.md');
  await ok(f.service.syncProject(EMPTY));
  assert.equal(f.remote.count('createSection'), 2);
  f.app.metadataCache.getFirstLinkpathDest = () => null;
  const failed = await failure(() => f.service.syncProject(PROJECT));
  assert.match(JSON.stringify(failed), /多个已有分组/);
  assert.equal(f.remote.count('createSection'), 2);
});

test('a different explicit unresolved Area path is not merged just because its title matches', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  f.files.get(PROJECT).content = f.files.get(PROJECT).content.replace('[[program]]', '[[Other/program]]');
  await ok(f.service.syncProject(PROJECT));
  assert.equal(f.remote.count('createSection'), 2);
  assert.equal(Object.values(f.readRecords().accounts[APP].projects)[0].areaKey, 'Other/program');
});

test('foreign and same-vault copied project markers cannot acquire hierarchy parents', async t => {
  const remote = remoteFixture();
  const study = fixture(t, remote); study.configure(); study.seedLegacy();
  const copied = study.files.get(PROJECT).content;
  const lab = fixture(t, remote, { [PROJECT]: copied }, 'lab'); lab.configure();
  await failure(() => lab.service.migrateVault());
  assert.equal(lab.files.get(PROJECT).content, copied); assert.equal(remote.count('createTask'), 0);
  const copyPath = '50_Tasks/copied.md'; study.addFile(copyPath, copied);
  await failure(() => study.service.migrateVault());
  assert.equal(remote.count('createTask'), 0); assert.equal(remote.count('setTaskParent'), 0);
});

test('finalizing migration only removes verified managed actions from old lists and never deletes remote objects', async t => {
  const f = fixture(t); f.configure(); const legacy = f.seedLegacy();
  const outsider = crypto.randomUUID();
  f.remote.tasks.set(outsider, { guid: outsider, summary: '人工任务', completed_at: '0', mode: 2, parent_task_guid: '',
    tasklists: [{ tasklist_guid: legacy.listGuid }] });
  await ok(f.service.migrateVault());
  assert.equal(f.remote.count('removeTasklist'), 0);
  const beforeTaskGuids = [...f.remote.tasks.keys()].sort(), beforeListGuids = [...f.remote.lists.keys()].sort();
  await ok(f.service.finalizeMigration());
  assert.deepEqual([...f.remote.tasks.keys()].sort(), beforeTaskGuids);
  assert.deepEqual([...f.remote.lists.keys()].sort(), beforeListGuids);
  assert.equal(f.remote.tasks.get(legacy.actionGuids[0]).tasklists.some(list => list.tasklist_guid === legacy.listGuid), false);
  assert.equal(f.remote.tasks.get(outsider).tasklists.some(list => list.tasklist_guid === legacy.listGuid), true);
  assert.equal(f.remote.tasks.get(legacy.actionGuids[0]).parent_task_guid, (await parent(f)).guid);
});

test('an uncertain project state update resumes its saved transaction without a false conflict', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  const root = await parent(f);
  f.setStatus(PROJECT, 'done');
  let parentPatchCount = 0;
  f.remote.hooks.updateTask = async (guid, patch, operation) => {
    if (guid === root.guid) {
      parentPatchCount++;
      await operation(guid, patch);
      delete f.remote.hooks.updateTask;
      throw new FeishuError('TIMEOUT', '项目状态写入结果待确认', { uncertain: true });
    }
    return operation(guid, patch);
  };
  await failure(() => f.service.syncProject(PROJECT));
  const restarted = createService(f.app, obsidian, f.dependencies);
  const updates = f.remote.count('updateTask');
  await ok(restarted.syncProject(PROJECT));
  assert.equal(f.status(PROJECT), 'done'); assert.equal(f.remote.fieldValue(root.guid), '已完成');
  assert.notEqual(root.completed_at, '0'); assert.equal(parentPatchCount, 1);
  assert.equal(f.remote.count('updateTask'), updates, 'Recovery should verify the applied patch rather than submit it twice');
});

test('a concurrent local project status edit is preserved while remote completion is being read', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  const root = await parent(f); root.completed_at = String(Date.UTC(2026, 9, 4) + 6000);
  f.remote.hooks.getTask = async (guid, operation) => {
    if (guid === root.guid) { f.setStatus(PROJECT, 'canceled'); delete f.remote.hooks.getTask; }
    return operation(guid);
  };
  const updates = f.remote.count('updateTask');
  await failure(() => f.service.syncProject(PROJECT));
  assert.equal(f.status(PROJECT), 'canceled'); assert.equal(f.remote.count('updateTask'), updates);
  assert.match(f.files.get(PROJECT).content, /- \[ \] 行动 A/);
});

test('remote completion and reopening preserve CRLF, YAML values, and the Markdown body', async t => {
  const text = projectText().replace('custom: keep', 'custom: "keep: value"').replace(/\n/g, '\r\n');
  const f = fixture(t, undefined, { [PROJECT]: text }); f.configure(); await ok(f.service.migrateVault());
  const root = await parent(f);
  const body = f.files.get(PROJECT).content.slice(obsidian.getFrontMatterInfo(f.files.get(PROJECT).content).contentStart);
  for (const [completed, expectedStatus] of [[String(Date.UTC(2026, 9, 4) + 6000), 'done'], ['0', 'doing']]) {
    root.completed_at = completed; await ok(f.service.syncProject(PROJECT));
    const content = f.files.get(PROJECT).content;
    assert.equal(f.status(PROJECT), expectedStatus);
    assert.equal(content.replace(/\r\n/g, '').includes('\n'), false, 'No lone LF may be introduced into the CRLF note');
    assert.match(content, /custom: "keep: value"\r\n/);
    assert.match(content, /area:\r\n  - "\[\[program\]\]"\r\n/);
    assert.equal(content.slice(obsidian.getFrontMatterInfo(content).contentStart), body);
  }
});

test('a deleted empty project or invalid project metadata prevents migration from being marked ready', async t => {
  for (const scenario of ['deleted empty project', 'missing status']) {
    await t.test(scenario, async sub => {
      const f = fixture(sub, undefined, { [PROJECT]: projectText('') }); f.configure(); f.seedLegacy();
      if (scenario === 'deleted empty project') f.files.delete(PROJECT);
      else f.files.get(PROJECT).content = f.files.get(PROJECT).content.replace(/^status:.*\n/m, '');
      await failure(() => f.service.migrateVault());
      assert.notEqual((await f.service.getHierarchyStatus()).migration.state, 'ready');
    });
  }
});

test('hierarchy resources remain separate for two vaults using the same application and project name', async t => {
  const remote = remoteFixture(), study = fixture(t, remote), lab = fixture(t, remote, { [PROJECT]: projectText() }, 'lab');
  study.configure(); lab.configure();
  await ok(study.service.migrateVault()); await ok(lab.service.migrateVault());
  const first = await parent(study), second = await parent(lab);
  const studyList = (await study.service.getHierarchyStatus()).vaultList.guid;
  const labList = (await lab.service.getHierarchyStatus()).vaultList.guid;
  assert.notEqual(first.guid, second.guid); assert.notEqual(studyList, labList);
  assert.notEqual(first.custom_fields[0].guid, second.custom_fields[0].guid);
  assert.equal(JSON.parse(first.extra).vaultId, study.service.getConfig().vaultId);
  assert.equal(JSON.parse(second.extra).vaultId, lab.service.getConfig().vaultId);
  first.completed_at = String(Date.UTC(2026, 9, 4) + 9000);
  await ok(study.service.syncProject(PROJECT)); await ok(lab.service.syncProject(PROJECT));
  assert.equal(study.status(PROJECT), 'done'); assert.equal(lab.status(PROJECT), 'doing');
  assert.equal(second.completed_at, '0'); assert.equal(remote.tasks.size, 4);
});

test('a new project can retry setup permission failures without becoming an untracked marker', async t => {
  for (const operation of ['listSections', 'createSection']) {
    await t.test(operation, async sub => {
      const f = fixture(sub); f.configure();
      f.remote.hooks[operation] = async () => {
        delete f.remote.hooks[operation];
        throw new FeishuError('PERMISSION_DENIED', '测试缺少分组权限', { uncertain: false });
      };
      await failure(() => f.service.migrateVault());
      await ok(f.service.migrateVault());
      const root = await parent(f);
      assert.equal(f.remote.tasks.size, 2);
      assert.equal([...f.remote.tasks.values()].filter(value => value.parent_task_guid === root.guid).length, 1);
    });
  }
});

test('an existing section belonging to another list is rejected using its actual tasklist identity', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  const root = await parent(f), list = (await f.service.getHierarchyStatus()).vaultList.guid;
  const sectionGuid = root.tasklists.find(item => item.tasklist_guid === list).section_guid;
  const foreignList = f.remote.addList('[lab] 项目');
  f.remote.sections.get(sectionGuid).tasklist = clone(f.remote.lists.get(foreignList));
  const updates = f.remote.count('updateTask'), parentMoves = f.remote.count('setTaskParent');
  await failure(() => f.service.syncProject(PROJECT));
  assert.equal(f.remote.count('updateTask'), updates); assert.equal(f.remote.count('setTaskParent'), parentMoves);
  assert.equal(f.remote.count('createSection'), 1);
});

test('an old action pending transaction is recovered and reparented before migration becomes ready', async t => {
  const f = fixture(t); f.configure(); const legacy = f.seedLegacy();
  const records = f.readRecords(), record = Object.values(records.accounts[APP].tasks)[0];
  const localRaw = f.files.get(PROJECT).content.split('\n').find(line => line.includes('feishu-task:'));
  record.state = 'error';
  record.pending = { localRaw, done: false, summary: record.payload.summary, description: record.payload.description,
    patch: { summary: record.payload.summary }, beforeCompletedAt: '0', createdAt: Date.UTC(2026, 9, 4) };
  atomicJSON(path.join(f.directory, 'records.json'), records);
  await ok(f.service.migrateVault());
  const root = await parent(f);
  assert.equal((await f.service.getHierarchyStatus()).migration.state, 'ready');
  assert.equal(f.remote.tasks.get(legacy.actionGuids[0]).parent_task_guid, root.guid);
  assert.equal(f.remote.tasks.size, 2);
});

test('updating the project state field preserves unrelated custom fields on its parent task', async t => {
  const f = fixture(t); f.configure(); await ok(f.service.migrateVault());
  const root = await parent(f), unrelatedGuid = crypto.randomUUID();
  const unrelated = { guid: unrelatedGuid, text_value: '人工填写的备注' };
  root.custom_fields.push(clone(unrelated));
  f.setStatus(PROJECT, 'done'); await ok(f.service.syncProject(PROJECT));
  assert.deepEqual(root.custom_fields.find(field => field.guid === unrelatedGuid), unrelated);
  assert.equal(f.remote.fieldValue(root.guid), '已完成');
});

test('missing parent does not classify its existing action as remote_missing or offer a destructive choice', async t => {
  const f = fixture(t); f.configure();
  await ok(f.service.migrateVault());
  const record = Object.values(f.readRecords().accounts[APP].tasks)[0];
  f.remote.tasks.delete(record.parentTaskGuid);
  await assert.rejects(f.service.syncTask(record.id), { code: 'NOT_FOUND' });
  assert.equal(f.readRecords().accounts[APP].tasks[record.id].state, 'error');
  await assert.rejects(f.service.getTaskConflict(record.id), /没有待选择/);
  assert.ok(f.remote.tasks.has(record.guid));
});

test('recreation restores the project parent and tombstones are excluded from migration and cleanup', async t => {
  const f = fixture(t); f.configure();
  const legacy = f.seedLegacy();
  await ok(f.service.migrateVault());
  let record = Object.values(f.readRecords().accounts[APP].tasks)[0];
  const parentGuid = record.parentTaskGuid, sectionGuid = record.sectionGuid;
  f.remote.tasks.delete(record.guid);
  let preview = await f.service.getTaskConflict(record.id);
  record = await f.service.resolveTaskConflict(record.id, 'local', preview.token);
  assert.equal(record.parentTaskGuid, parentGuid); assert.equal(record.sectionGuid, sectionGuid);
  assert.equal(f.remote.tasks.get(record.guid).parent_task_guid, parentGuid);
  assert.equal(record.hierarchyVerified, true);
  f.remote.tasks.delete(record.guid);
  preview = await f.service.getTaskConflict(record.id);
  await f.service.resolveTaskConflict(record.id, 'remote', preview.token);
  const before = f.remote.count('createTask');
  await ok(f.service.migrateVault());
  await ok(f.service.finalizeMigration());
  assert.equal(f.service.getHierarchyStatus().migration.legacyTasks, 0);
  assert.equal(f.remote.count('createTask'), before);
  assert.equal(f.remote.count('removeTasklist'), 0);
  assert.ok(f.remote.lists.has(legacy.listGuid));
});
