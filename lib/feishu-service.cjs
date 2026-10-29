'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createFeishuClient, taskUrl, tasklistUrl } = require('./feishu-api.cjs');
const md = require('./feishu-markdown.cjs');
const time = require('./feishu-time.cjs');
const { createHierarchy, STATUS } = require('./feishu-hierarchy.cjs');
const transfer = require('./feishu-transfer.cjs');
const syncScope = require('./feishu-scope.cjs');
const SERVICE = Symbol.for('study.feishuSync.service.v1');
const IMPLEMENTATION = Symbol('feishu-sync implementation');
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function atomicJSON(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = filename + '.' + crypto.randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temp, filename);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

function readJSON(filename, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw new Error('飞书本机配置或关联记录损坏，已停止同步；请保留文件并恢复备份。');
  }
}

function safeStorage() {
  let storage;
  try { storage = require('electron').remote?.safeStorage; } catch (_) {}
  if (!storage) { try { storage = require('@electron/remote').safeStorage; } catch (_) {} }
  if (!storage?.isEncryptionAvailable() || storage.getSelectedStorageBackend?.() === 'basic_text') {
    throw new Error('此设备没有可用的系统加密存储，请在桌面版 Obsidian 配置。');
  }
  return storage;
}

function completedAt(task) {
  if (!task || !/^\d+$/.test(String(task.completed_at ?? ''))) throw new Error('飞书没有返回明确的完成状态，已停止回写。');
  return String(task.completed_at);
}

function createService(app, obsidian, dependencies = {}) {
  const base = app.vault.adapter.getBasePath?.();
  if (!base) throw new Error('飞书联动目前需要桌面版 Obsidian。');
  const hash = crypto.createHash('sha256').update(base).digest('hex').slice(0, 24);
  // Keep the pre-1.5 storage path so renaming the plugin preserves credentials and GUIDs.
  const directory = dependencies.directory || path.join(os.homedir(), '.config', 'obsidian-feishu-sync', hash);
  const configFile = path.join(directory, 'config.json');
  const recordFile = path.join(directory, 'records.json');
  const restoreFile = path.join(directory, 'restore-pending.json');
  const writeJSON = dependencies.atomicJSON || atomicJSON;
  const encryption = dependencies.safeStorage || safeStorage;
  const factory = dependencies.createFeishuClient || createFeishuClient;
  const now = dependencies.now || Date.now;
  // A durable intent completes both files after a crash. No operation may use
  // partially imported associations with the previous identity or account.
  function completeRestore() {
    if (!fs.existsSync(restoreFile)) return;
    const pending = readJSON(restoreFile);
    if (pending?.version !== 1 || !pending.config || !pending.records) throw new Error('接入恢复记录损坏，请保留本机文件并恢复备份。');
    try {
      writeJSON(recordFile, pending.records);
      writeJSON(configFile, pending.config);
      fs.unlinkSync(restoreFile);
    } catch (_) { throw new Error('跨设备接入尚未完整保存，已停止同步。修复本机存储后重新打开仓库以继续恢复，请勿删除 restore-pending.json。'); }
  }
  completeRestore();
  let busy = false;
  let client;
  let selection = null;
  let unsaved = null;
  let roundIndex = null;
  let issueRevision = 0;
  const projectSuccess = new Map();
  const conflictPreviews = new Map();
  let transferPreview = null;
  const notify = () => app.workspace.trigger('feishu-sync:change');
  const settings = () => {
    if (fs.existsSync(restoreFile)) throw new Error('跨设备接入尚未完整保存，已停止同步。修复存储后重新打开仓库以继续恢复。');
    return readJSON(configFile, {});
  };
  const defaultFolder = (candidates, fallback) => candidates.find(folder => app.vault.getAbstractFileByPath(folder)
    || app.vault.getMarkdownFiles?.().some(file => file.path.startsWith(folder + '/'))) || fallback;
  const defaultProjectFolder = defaultFolder(['50_Tasks', '004_Tasks'], '50_Tasks');
  const defaultDailyFolder = defaultFolder(['20_Review/Daily', '001_diary'], '20_Review/Daily');
  function state(readOnly = false) {
    if (unsaved && !readOnly) {
      try { writeJSON(recordFile, unsaved); unsaved = null; }
      catch (_) { throw new Error('飞书关联记录未能保存，已停止后续操作。请修复本机存储后重试，勿删除记录。'); }
    }
    const value = readOnly && unsaved ? unsaved : readJSON(recordFile, { version: 1, accounts: {} });
    if (value.version !== 1 || !value.accounts || Array.isArray(value.accounts)) throw new Error('飞书关联记录格式无效，已停止同步。');
    return value;
  }
  function persist(value) {
    unsaved = value;
    try { writeJSON(recordFile, value); unsaved = null; }
    catch (_) { throw new Error('飞书关联记录未能保存，已停止后续操作。请修复本机存储后重试，勿删除记录。'); }
  }
  function account() {
    const all = state();
    const key = settings().appId || '';
    const value = all.accounts[key] || { tasks: {}, projects: {} };
    if (!value.tasks || !value.projects) throw new Error('飞书账号关联记录格式无效。');
    return { all, key, value };
  }
  function put(kind, id, record) {
    const { all, key, value } = account();
    if (JSON.stringify(value[kind][id]) === JSON.stringify(record)) return value[kind][id];
    value[kind][id] = record;
    all.accounts[key] = value;
    persist(all);
    notify();
    return record;
  }
  const recordFor = id => account().value.tasks[id] || null;
  const config = () => {
    const s = settings();
    return { appId: s.appId || '', hasSecret: !!s.encryptedSecret, assigneeId: s.assigneeId || '',
      defaultTasklistGuid: s.defaultTasklistGuid || '', storagePath: directory,
      vaultId: s.vaultId || '', vaultLabel: s.vaultLabel || path.basename(base),
      vaultTasklistName: s.vaultTasklistName || s.vaultLabel || path.basename(base),
      areaNames: s.areaNames || {}, projectNames: s.projectNames || {},
      projectFolder: s.projectFolder || defaultProjectFolder, dailyFolder: s.dailyFolder || defaultDailyFolder,
      ...syncScope.normalize(s),
      syncDaily: s.syncDaily === true, autoEnabled: s.autoEnabled === true, pollMinutes: s.pollMinutes || 2,
      configRevision: s.configRevision || '', hierarchyEnabled: s.hierarchyEnabled === true };
  };
  function scope() { return config(); }
  function inProjects(notePath) { return notePath.startsWith(scope().projectFolder + '/'); }
  function inDaily(notePath) { return notePath.startsWith(scope().dailyFolder + '/'); }
  function api() {
    if (client) return client;
    let s = settings();
    if (!s.appId || !s.encryptedSecret || !s.assigneeId) throw new Error('请先配置 App ID、App Secret 和接收任务的用户 Open ID。');
    if (!s.vaultId) {
      s = { ...s, version: 2, vaultId: crypto.randomUUID(), vaultLabel: path.basename(base), autoEnabled: false };
      writeJSON(configFile, s);
      notify();
    }
    let secret;
    try { secret = encryption().decryptString(Buffer.from(s.encryptedSecret, 'base64')); }
    catch (_) { throw new Error('此设备无法解密 App Secret，请在面板重新填写。'); }
    return client = factory({ request: obsidian.requestUrl, appId: s.appId, appSecret: secret });
  }
  async function exclusive(fn) {
    if (busy) throw new Error('飞书操作正在进行，请等待完成。');
    busy = true;
    hierarchy.begin();
    try { return await fn(); } finally { busy = false; notify(); }
  }
  function fileFor(notePath) {
    if (!md.allowedPath(notePath, scope())) throw new Error('该笔记不在同步范围内，请在设置中添加标签或文件夹。');
    const file = app.vault.getAbstractFileByPath(notePath);
    if (!file || file.extension !== 'md') throw new Error('目标笔记不存在，请重新选择。');
    return file;
  }
  function isProject(notePath, content) {
    if (!inProjects(notePath)) return false;
    const info = obsidian.getFrontMatterInfo(content);
    const fm = info.exists ? obsidian.parseYaml(info.frontmatter) || {} : {};
    const tags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
    return tags.some(t => t === 'project' || t === '#project');
  }
  function noteKind(notePath, content, current = scope()) {
    const file = app.vault.getAbstractFileByPath(notePath);
    return syncScope.classify(notePath, content, current, obsidian, app.metadataCache?.getFileCache?.(file));
  }
  async function isProjectPath(notePath) {
    return noteKind(notePath, await app.vault.read(fileFor(notePath))) === 'project';
  }
  async function startForPath(notePath, due) {
    return time.withDue(time.noteStart(await app.vault.read(fileFor(notePath)), notePath, obsidian, scope()), due);
  }
  async function readNote(notePath) {
    const file = fileFor(notePath);
    const content = await app.vault.read(file);
    const kind = noteKind(notePath, content);
    if (!kind) throw new Error('该笔记不在同步范围内，请在设置中添加标签或文件夹。');
    const project = kind === 'project';
    const a = account().value;
    const id = md.projectId(content, obsidian);
    const tasks = md.tasks(content, notePath).map(t => ({ ...t, record: t.vaultId && t.vaultId !== scope().vaultId
      ? { id: t.id, state: 'foreign', message: '此行动来自其他仓库，不会认领原任务。' } : t.id ? a.tasks[t.id] || null : null }));
    const storedProject = id ? a.projects[id] : null;
    const meta = project && scope().hierarchyEnabled ? hierarchy.metadata(notePath, content) : null;
    const projectRecord = storedProject?.parentTaskGuid ? { ...storedProject, guid: storedProject.parentTaskGuid,
      url: taskUrl(storedProject.parentTaskGuid), state: storedProject.parentState || 'linked' } : storedProject ? { ...storedProject, guid: null, state: storedProject.parentState || 'pending' } : null;
    return { path: notePath, kind, isProject: project, listRecord: storedProject || null, tasks,
      projectRecord, areaName: meta?.areaName || '', projectStatus: meta?.status || '',
      projectSendCount: project ? tasks.filter(t => t.inNextActions && t.status === ' ').length : 0 };
  }
  async function getSyncIssues(failures = []) {
    const current = config();
    if (!current.appId) return [];
    // Reporting must not retry an unsaved transaction or instantiate the API.
    const records = state(true).accounts[current.appId] || { tasks: {}, projects: {} };
    if (!records.tasks || !records.projects) throw new Error('飞书账号关联记录格式无效。');
    const candidates = new Map();
    const normal = new Set(['linked', 'draft', 'pending', 'syncing', 'suppressed']);
    const issueState = (kind, record) => kind === 'project' ? record.parentState || record.state : record.state;
    const hasIssue = (kind, record) => !!record.message || !!record.needsChoice
      || (!!issueState(kind, record) && !normal.has(issueState(kind, record)));
    const keyFor = (kind, id, notePath, line) => kind + ':' + (id || notePath + (Number.isInteger(line) ? ':' + line : ''));
    for (const [plural, kind] of [['tasks', 'task'], ['projects', 'project']]) {
      for (const [id, record] of Object.entries(records[plural])) {
        if (!record || (!hasIssue(kind, record) && !record.suppressed)) continue;
        const key = keyFor(kind, id, record.path);
        candidates.set(key, { key, kind, id, record, path: record.path || '', state: issueState(kind, record) || 'error', message: record.message || '' });
      }
    }
    for (const failure of Array.isArray(failures) ? failures : []) {
      if (!failure || failure.ok === true || !failure.message || (failure.appId && failure.appId !== current.appId)) continue;
      const kind = failure.kind === 'project' || (!failure.kind && !failure.id) ? 'project' : 'task';
      if (kind === 'project' && Number.isInteger(failure.revision)
        && projectSuccess.get(current.appId + ':' + failure.path) > failure.revision) continue;
      const collection = records[kind === 'project' ? 'projects' : 'tasks'];
      const record = (failure.id && collection[failure.id]) || (kind === 'project'
        ? Object.values(collection).find(value => value.path === failure.path) : null);
      // The latest association wins after a successful retry of an older failure.
      if (failure.id && record && issueState(kind, record) === 'linked' && !hasIssue(kind, record)) continue;
      const id = record?.id || failure.id || undefined;
      const notePath = record?.path || failure.path || '';
      if (!id && !notePath) continue;
      const key = keyFor(kind, id, notePath, failure.line);
      if (!candidates.has(key)) candidates.set(key, { key, kind, id, record: record || {}, path: notePath,
        state: record && hasIssue(kind, record) ? issueState(kind, record) || 'error' : 'error',
        message: failure.message, line: failure.line });
    }
    const notes = new Map();
    const defaults = {
      conflict: '两端状态存在冲突，请选择采用哪一边。', uncertain: '远端操作结果尚未确认，请检查并恢复关联。',
      creating: '创建结果尚未确认，请检查并恢复关联。', retryable: '上次操作未完成，可检查原因后重试。',
      remote_missing: '找不到对应飞书任务，请检查远端关联。', local_missing: '找不到原行动，请检查来源笔记。',
      untracked: '缺少可信的本机关联记录，请恢复关联。',
    };
    const issues = [];
    const reported = new Set();
    for (const item of candidates.values()) {
      const { record: savedRecord, ...issue } = item;
      let record = savedRecord;
      // Missing and out-of-scope notes still need a readable report. Validate
      // relative Markdown paths without imposing the current synchronization scope.
      if (!notes.has(issue.path)) {
        let note = null;
        if (typeof issue.path === 'string' && issue.path.endsWith('.md') && !issue.path.startsWith('/')
          && !issue.path.includes('\\') && !issue.path.split('/').some(part => !part || part === '.' || part === '..')) {
          const file = app.vault.getAbstractFileByPath(issue.path);
          if (file?.extension === 'md') {
            try { note = { file, tasks: md.tasks(await app.vault.read(file), issue.path) }; } catch (_) { /* Use saved title. */ }
          }
        }
        notes.set(issue.path, note);
      }
      const note = notes.get(issue.path);
      const local = issue.kind === 'task' && note?.tasks.find(task => (issue.id ? task.id === issue.id : task.line === issue.line)
        && (!task.vaultId || task.vaultId === current.vaultId));
      if (record.suppressed && !record.cancelPending) {
        if (!local || local.status === '-') continue;
        issue.state = 'remote_missing';
        issue.message = '此行动已采用飞书缺失状态，现已在本地重新打开；请明确选择是否重建飞书任务。';
      } else if (record.cancelPending) {
        issue.state = 'remote_missing';
        issue.message = record.message || '采用飞书状态的取消操作尚未完成，请重试以完成已保存的选择。';
      }
      // A previously unmarked action may have acquired its ID before failing.
      // Merge that round's path/line failure with the persisted association.
      if (!issue.id && local?.id) {
        const key = keyFor('task', local.id, issue.path);
        if (candidates.has(key)) continue;
        record = records.tasks[local.id] || record;
        if (record.state === 'linked' && !hasIssue('task', record)) continue;
        issue.id = local.id;
        issue.key = key;
      }
      if (reported.has(issue.key)) continue;
      reported.add(issue.key);
      let title;
      if (local) {
        try { title = md.summary(local); } catch (_) { /* Use saved title. */ }
        issue.line = local.line;
      }
      issue.title = title || (issue.kind === 'project' && note?.file.basename)
        || record.baseline?.summary || record.payload?.summary || record.parentBaseline?.summary
        || record.parentPayload?.summary || record.name || path.posix.basename(issue.path, '.md')
        || (issue.kind === 'project' ? '项目' : '行动');
      issue.message = issue.message || defaults[issue.state] || '同步未完成，请检查关联和来源笔记。';
      const guid = issue.kind === 'project' ? record.parentTaskGuid : record.guid;
      if (GUID.test(guid || '')) issue.url = taskUrl(guid);
      else if (issue.kind === 'project' && GUID.test(record.guid || '')) issue.url = tasklistUrl(record.guid);
      if (!Number.isInteger(issue.line)) delete issue.line;
      issues.push(issue);
    }
    // A config change while awaiting vault reads must not expose the prior account.
    return config().appId === current.appId ? issues : [];
  }
  async function findTask(id, { allowCanceled = false } = {}) {
    const matches = [];
    // Search the actual Markdown, including archived notes, so a copied ID never
    // silently selects one of two actions. No note content is sent by this scan.
    const files = roundIndex?.has(id) ? roundIndex.get(id).map(p => app.vault.getAbstractFileByPath(p)).filter(Boolean) : app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i += 24) {
      const group = await Promise.all(files.slice(i, i + 24).map(async file => {
        const content = await app.vault.read(file);
        if (!content.includes(id)) return [];
        return md.tasks(content, file.path).filter(t => t.id === id);
      }));
      matches.push(...group.flat());
    }
    if (matches.length !== 1) throw new Error(matches.length ? '检测到重复的行动标识，请处理复制的任务后再同步。' : '找不到原行动，可能已删除或移除标识；不会删除飞书任务。');
    const task = matches[0];
    const file = fileFor(task.path);
    if (task.vaultId && task.vaultId !== scope().vaultId) throw new Error('此行动属于其他仓库，不会认领或修改其飞书任务。');
    if (!noteKind(task.path, await app.vault.read(file))) throw new Error('行动所在笔记已移出同步范围。');
    if (!/^[ xX]$/.test(task.status) && !(allowCanceled && task.status === '-')) throw new Error('该行动使用自定义状态，已停止自动同步。');
    return task;
  }
  async function projectIdentity(notePath) {
    const file = fileFor(notePath);
    let id;
    let fresh = false;
    await md.helpers.withFileQueue(app, notePath, () => app.vault.process(file, content => {
      if (!isProject(notePath, content)) throw new Error('必须选择带 project 标签的项目。');
      const marker = md.projectMarker(content, obsidian);
      id = marker?.id;
      if (marker?.vaultId && marker.vaultId !== scope().vaultId) throw new Error('此项目来自其他仓库，不能共用原飞书清单。');
      if (id) {
        const vaultId = marker.vaultId || (account().value.projects[id]?.guid ? scope().vaultId : null);
        return md.writeProjectMarker(content, { id, vaultId }, obsidian);
      }
      id = crypto.randomUUID(); fresh = true;
      return md.writeProjectMarker(content, { id, vaultId: scope().vaultId }, obsidian);
    }));
    let copies = 0;
    for (const f of app.vault.getMarkdownFiles()) {
      // syncVault already read every file freshly for its task-ID index. Reuse
      // Obsidian's cache for this read-only duplicate scan, rather than doing
      // another full disk scan per project. Obsidian invalidates it on writes
      // and external change events; new/copied files remain in this full list.
      // Standalone sends keep their fresh scan. Actual writes use process().
      const content = roundIndex && typeof app.vault.cachedRead === 'function'
        ? await app.vault.cachedRead(f) : await app.vault.read(f);
      if (content.includes(id) && md.projectId(content, obsidian) === id) copies++;
    }
    if (copies !== 1) throw new Error('检测到重复的飞书项目标识，请先处理复制的项目笔记。');
    return { id, fresh, file };
  }
  async function tasklist(notePath) {
    const kind = noteKind(notePath, await app.vault.read(fileFor(notePath)));
    if (!kind) throw new Error('该笔记已移出同步范围。');
    const linkedProject = guid => {
      projectSuccess.set(scope().appId + ':' + notePath, ++issueRevision);
      return guid;
    };
    if (kind === 'task') {
      if (!scope().hierarchyEnabled) throw new Error('请先在概览建立仓库清单，再同步额外笔记。');
      return (await hierarchy.basics()).listGuid;
    }
    if (scope().hierarchyEnabled && kind === 'project') return linkedProject((await hierarchy.ensureProject(notePath)).tasklistGuid);
    if (kind === 'daily') {
      const guid = settings().defaultTasklistGuid;
      if (!guid) throw new Error('发送日记行动前，请配置一个应用有编辑权限的默认飞书清单。');
      const list = await api().getTasklist(guid);
      if (!list.name.startsWith('[' + scope().vaultLabel + '] ')) throw new Error('日记清单名称必须以 [' + scope().vaultLabel + '] 开头，避免跨库混用。');
      return guid;
    }
    const { id, fresh, file } = await projectIdentity(notePath);
    let record = account().value.projects[id];
    const name = '[' + scope().vaultLabel + '] ' + [...(file.basename || path.basename(notePath, '.md'))].slice(0, 95 - [...scope().vaultLabel].length).join('');
    if (record?.guid) {
      const list = await api().getTasklist(record.guid);
      if (list.name !== name) await api().updateTasklist(record.guid, { name });
      if (record.path !== notePath || record.name !== name) put('projects', id, { ...record, path: notePath, name });
      return linkedProject(record.guid);
    }
    if ((record && record.state !== 'retryable') || (!record && !fresh)) throw new Error('项目清单关联待恢复；请在面板绑定已有清单 GUID，不会重复新建。');
    record = { id, path: notePath, state: 'creating', createdAt: now() };
    put('projects', id, record);
    try {
      const list = await api().createTasklist({ name,
        members: [{ id: settings().assigneeId, type: 'user', role: 'editor' }] });
      record = { ...record, guid: list.guid, name, state: 'linked' };
      put('projects', id, record);
      return linkedProject(list.guid);
    } catch (error) {
      put('projects', id, { ...record, state: record.guid ? 'linked' : error.uncertain === false ? 'retryable' : 'uncertain', message: error.message });
      throw error;
    }
  }
  function expectedExtra(id) { return JSON.stringify({ source: 'obsidian-feishu-sync', version: 2, vaultId: scope().vaultId, id }); }
  function owns(remote, id) {
    try { const extra = JSON.parse(remote.extra); return extra.source === 'obsidian-feishu-sync' && extra.version === 2 && extra.vaultId === scope().vaultId && extra.id === id; }
    catch (_) { return false; }
  }
  function verifyRemote(remote, record) {
    let trustedLegacy = false;
    try { const extra = JSON.parse(remote.extra); trustedLegacy = !!record.guid && record.guid === remote.guid && extra.source === 'obsidian-feishu-sync' && extra.version === 1 && extra.id === record.id; } catch (_) {}
    if (!remote || !GUID.test(remote.guid) || (record.guid && remote.guid !== record.guid) || (!owns(remote, record.id) && !trustedLegacy)) {
      throw new Error('飞书任务的关联标识不匹配，已停止同步。');
    }
    completedAt(remote);
    if (remote.mode === 1) throw new Error('该飞书任务已改为会签，不能自动替所有成员完成。');
    if (typeof remote.summary !== 'string') throw new Error('飞书任务详情不完整，已停止同步。');
    return remote;
  }
  // Only an exact detail read of this action can establish that it is missing.
  // A missing parent, tasklist, or update endpoint never carries this marker.
  async function readRemoteTask(record) {
    try { return verifyRemote(await api().getTask(record.guid), record); }
    catch (error) {
      if (error.code === 'NOT_FOUND') error.missingTaskGuid = record.guid;
      throw error;
    }
  }
  function staleConflict() {
    const error = new Error('冲突预览已过期，行动、飞书状态或账号已变化；请刷新对比后重新选择。');
    error.code = 'CONFLICT_STALE';
    return error;
  }
  function conflictSignature(value) {
    const canonical = item => Array.isArray(item) ? item.map(canonical) : item && typeof item === 'object'
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])])) : item;
    return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  }
  function conflictContext(id) {
    const current = scope();
    if (!current.vaultId || !current.appId) throw new Error('请先完成当前仓库的飞书配置。');
    // A preview must never flush a previously failed disk transaction.
    const record = state(true).accounts[current.appId]?.tasks?.[id];
    if (!record || !GUID.test(record.guid || '')) throw new Error('此行动没有可比较的飞书关联，请先恢复关联。');
    return { config: current, record };
  }
  async function inspectTaskConflict(id, requireConflict = true) {
    const context = conflictContext(id);
    const local = await findTask(id, { allowCanceled: !!(context.record.suppressed || context.record.resumingSuppressed) });
    let remote = null;
    try { remote = await readRemoteTask(context.record); }
    catch (error) { if (error.missingTaskGuid !== context.record.guid) throw error; }
    const after = conflictContext(id), fresh = await findTask(id, { allowCanceled: !!(after.record.suppressed || after.record.resumingSuppressed) });
    if (conflictSignature(context) !== conflictSignature(after) || local.path !== fresh.path || local.raw !== fresh.raw) throw staleConflict();
    const { record } = context;
    const kind = remote ? 'status' : 'remote_missing';
    if (requireConflict && remote && !record.suppressed && (!['conflict', 'remote_missing'].includes(record.state) && !record.needsChoice
      && !(record.baseline && local.done !== record.baseline.done && completedAt(remote) !== record.baseline.completedAt
        && local.done !== (completedAt(remote) !== '0')))) throw new Error('此行动当前没有待选择的完成状态冲突，请刷新后同步。');
    const snapshot = { context, local, remote };
    const preview = { id, kind, local: { summary: md.summary(local), done: local.done, status: local.status },
      remote: remote ? { exists: true, summary: remote.summary, done: completedAt(remote) !== '0' } : { exists: false },
      choices: kind === 'remote_missing'
        ? { local: local.status === '-' ? '重新启用本地行动，并在飞书重建任务' : '保留本地行动，并在飞书重建任务', remote: '采用飞书缺失状态：将本地行动标为 [-] 已取消，并停止同步此行动' }
        : { local: '采用本地完成状态；标题仍以本地为准', remote: '采用飞书完成状态；标题仍以本地为准' } };
    if (remote && (record.suppressed || record.resumingSuppressed)) preview.choices = {
      local: '重新启用同步，并采用本地完成状态；标题仍以本地为准',
      remote: '重新启用同步，并采用飞书完成状态；标题仍以本地为准',
    };
    if (record.baseline) preview.baseline = { done: record.baseline.done, summary: record.baseline.summary };
    return { preview, snapshot, signature: conflictSignature(snapshot) };
  }
  async function getTaskConflict(id) {
    return exclusive(async () => {
      const inspected = await inspectTaskConflict(id), token = crypto.randomUUID();
      conflictPreviews.set(token, { id, signature: inspected.signature });
      if (conflictPreviews.size > 100) conflictPreviews.delete(conflictPreviews.keys().next().value);
      return { ...inspected.preview, token };
    });
  }
  async function finishCancellation(record) {
    const local = await findTask(record.id, { allowCanceled: true });
    if (!record.cancelPending) {
      if (local.status === '-') return record;
      if (record.state !== 'remote_missing') put('tasks', record.id, { ...record, state: 'remote_missing',
        message: '此行动已采用飞书缺失状态，现已在本地重新打开；请明确选择是否重建飞书任务。' });
      throw new Error('已取消的行动在本地重新打开，请先选择采用本地还是飞书状态。');
    }
    const expected = record.cancelPending.localRaw.replace(/^(\s*(?:[-*+]|\d+[.)])[ \t]+\[)[^\]]/, '$1-');
    if (local.raw !== record.cancelPending.localRaw && local.raw !== expected) {
      put('tasks', record.id, { ...record, state: 'remote_missing', cancelPending: null,
        message: '取消期间本地行动发生变化，已保留编辑；请刷新冲突并重新选择。' });
      throw staleConflict();
    }
    if (local.status !== '-') await md.writeStatus(app, local, '-');
    return put('tasks', record.id, { ...record, path: local.path, state: 'suppressed', message: '', cancelPending: null });
  }
  async function resolveTaskConflict(id, choice, token) {
    if (!['local', 'remote'].includes(choice)) throw new Error('请选择采用本地或飞书状态。');
    return exclusive(async () => {
      const previous = conflictPreviews.get(token);
      if (!previous || previous.id !== id) throw staleConflict();
      let inspected;
      try { inspected = await inspectTaskConflict(id, false); }
      catch (error) { if (!error.code) throw staleConflict(); throw error; }
      if (inspected.signature !== previous.signature) throw staleConflict();
      conflictPreviews.delete(token);
      const { local, remote, context: { record } } = inspected.snapshot;
      try {
        if (inspected.preview.kind === 'status') {
          let currentRecord = record, currentRemote = remote;
          if (scope().hierarchyEnabled && await isProjectPath(local.path)) {
            const placed = await hierarchy.placeAction(record, local, remote);
            currentRecord = placed.record; currentRemote = placed.remote;
            if (['summary', 'completed_at', 'extra', 'mode'].some(key => currentRemote[key] !== remote[key])) throw staleConflict();
          }
          return await updateFrom(currentRecord, local, currentRemote, choice === 'local' ? local.done : completedAt(remote) !== '0');
        }
        if (choice === 'remote') {
          const intent = put('tasks', id, { ...record, path: local.path, state: 'suppressed', suppressed: true,
            suppressedAt: now(), message: '', pending: null, needsChoice: false, cancelPending: { localRaw: local.raw } });
          return await finishCancellation(intent);
        }
        // Persist the new generation before any create call. Its old GUID is audit
        // data only; recovery must never attach it to this new creation intent.
        const previousGuids = [...new Set([...(record.previousGuids || []), record.guid])];
        const intent = put('tasks', id, { id, path: local.path, state: 'draft', createdAt: now(),
          options: { ...(record.payload?.due ? { due: Number(record.payload.due.timestamp) } : {}),
            ...(record.payload?.reminders?.length ? { reminderMinutes: record.payload.reminders[0].relative_fire_minute } : {}),
            ...record.options }, previousGuids, recreate: { token: crypto.randomUUID(), localRaw: local.raw,
            reopen: local.status === '-', authorizedAt: now() } });
        return await sendDraft(intent);
      } catch (error) { markTaskError(id, error, record); throw error; }
    });
  }
  function markTaskError(id, error, fallback) {
    const latest = recordFor(id) || fallback;
    put('tasks', id, { ...latest, state: latest.guid && error.missingTaskGuid === latest.guid ? 'remote_missing'
      : ['conflict', 'remote_missing', 'suppressed', 'draft', 'untracked'].includes(latest.state) ? latest.state : latest.guid ? 'error' : 'uncertain', message: error.message });
  }
  function attach(record, remote) {
    verifyRemote(remote, record);
    const baseline = record.baseline || { done: record.payload.completed_at !== '0', summary: record.payload.summary,
      completedAt: record.payload.completed_at };
    return put('tasks', record.id, { ...record, guid: remote.guid, url: taskUrl(remote.guid), state: record.needsChoice ? 'conflict' : 'linked',
      baseline, message: record.needsChoice ? '没有可信的历史同步记录，且两端完成状态不同，请选择采用哪一边。' : '', lastSyncedAt: now() });
  }
  async function recover(record, explicitGuid) {
    const bind = async remote => {
      if (record.previousGuids?.includes(remote.guid)) throw new Error('这是已失效的旧飞书任务，请恢复本次重建生成的新任务。');
      verifyRemote(remote, record);
      if (record.noBaseline || (!record.payload && !record.baseline)) {
        const local = await findTask(record.id);
        record = { ...record, needsChoice: local.done !== (completedAt(remote) !== '0'), noBaseline: false,
          baseline: { done: completedAt(remote) !== '0', summary: remote.summary, completedAt: completedAt(remote) } };
      }
      return attach(record, remote);
    };
    if (explicitGuid) return bind(await api().getTask(explicitGuid));
    const candidates = [];
    for (const item of await api().listTasks(record.tasklistGuid)) {
      const remote = item.extra === undefined ? await api().getTask(item.guid) : item;
      if (owns(remote, record.id) && !record.previousGuids?.includes(remote.guid)) candidates.push(remote);
    }
    if (candidates.length > 1) throw new Error('飞书清单中发现重复关联，请先处理重复任务。');
    if (candidates.length === 1) return bind(await api().getTask(candidates[0].guid));
    throw new Error('尚未找到对应飞书任务。创建结果仍待确认，请检查清单或填写任务 GUID 恢复；不会再次创建。');
  }
  function payloadFor(task, listGuid, options, start) {
    const payload = { summary: md.summary(task), description: 'Obsidian 来源：' + path.basename(task.path, '.md'),
      completed_at: task.done ? String(now()) : '0', mode: 2, client_token: crypto.randomUUID(),
      extra: expectedExtra(task.id), members: [{ id: settings().assigneeId, type: 'user', role: 'assignee' }],
      tasklists: [{ tasklist_guid: listGuid }] };
    if (options.due !== undefined) {
      if (!Number.isSafeInteger(options.due) || options.due <= now()) throw new Error('截止时间须晚于当前时间。');
      payload.due = { timestamp: String(options.due), is_all_day: false };
    }
    if (start) payload.start = time.withDue(start, payload.due);
    if (options.reminderMinutes !== undefined) {
      if (!payload.due || !Number.isInteger(options.reminderMinutes) || options.reminderMinutes < 0 || options.reminderMinutes > 40320) {
        throw new Error('提醒需要截止时间，提前分钟数应在 0–40320 之间。');
      }
      payload.reminders = [{ relative_fire_minute: options.reminderMinutes }];
    }
    return payload;
  }
  async function syncOne(id, { resolution } = {}) {
    if (resolution && !['local', 'remote'].includes(resolution)) throw new Error('同步处理方式无效。');
    let record = recordFor(id);
    if (!record) throw new Error('本机没有此行动的关联记录，请恢复原设备记录。');
    try {
      if (record.suppressed) return await finishCancellation(record);
      if (['conflict', 'remote_missing'].includes(record.state) && !resolution) throw new Error(record.message || '请先选择采用本地还是飞书状态。');
      if (['draft', 'untracked'].includes(record.state)) return await sendDraft(record);
      if (!record.guid) record = await recover(record);
      if (record.needsChoice && !resolution) throw new Error(record.message || '请先选择采用本地还是飞书状态。');
      // A failed update may have reached the server. Finish that transaction
      // before planning another one; do not reinterpret our own write as a conflict.
      if (record.pending && !resolution) {
        record = await finishUpdate(record);
        if (!scope().hierarchyEnabled || !await isProjectPath(record.path)) return record;
      }
      if (record.pending && resolution) record = put('tasks', id, { ...record, pending: null });
      let local = await findTask(id);
      let remote = await readRemoteTask(record);
      if (scope().hierarchyEnabled && await isProjectPath(local.path)) {
        const placed = await hierarchy.placeAction(record, local, remote);
        record = placed.record; remote = placed.remote;
      }
      if (!local.vaultId) {
        if (!record.guid) throw new Error('旧行动标识缺少仓库归属和可信关联记录，请恢复原设备记录。');
        local = await md.identifyTask(app, local, { ...scope(), allowLegacy: true });
      }
      const remoteDone = completedAt(remote) !== '0';
      const localChanged = local.done !== record.baseline.done;
      const remoteChanged = completedAt(remote) !== record.baseline.completedAt;
      if (!resolution && localChanged && remoteChanged && local.done !== remoteDone) {
        record = put('tasks', id, { ...record, state: 'conflict', message: '两边的完成状态均有变化，请选择采用哪一边。' });
        throw new Error(record.message);
      }
      const done = resolution === 'local' ? local.done : resolution === 'remote' ? remoteDone : localChanged ? local.done : remoteDone;
      return await updateFrom(record, local, remote, done);
    } catch (error) {
      markTaskError(id, error, record);
      throw error;
    }
  }
  async function updateFrom(record, local, remote, done) {
    const id = record.id;
    const resumingSuppressed = !!(record.suppressed || record.resumingSuppressed);
    const remoteDone = completedAt(remote) !== '0';
    const summary = md.summary(local);
    const description = 'Obsidian 来源：' + path.basename(local.path, '.md');
    const patch = {};
    if (!owns(remote, id)) patch.extra = expectedExtra(id);
    if (remote.summary !== summary) patch.summary = summary;
    if (remote.description !== description) patch.description = description;
    if (remoteDone !== done) patch.completed_at = done ? String(now()) : '0';
    if (!time.hasStart(remote.start)) {
      const start = await startForPath(local.path, remote.due);
      if (start) patch.start = start;
    }
    if (!Object.keys(patch).length && local.done === done && record.path === local.path && record.state === 'linked'
      && record.baseline.completedAt === completedAt(remote)) return record;
    record = put('tasks', id, { ...record, ...(resumingSuppressed ? { suppressed: false, resumingSuppressed: true, cancelPending: null } : {}),
      path: local.path, state: 'syncing', message: '', needsChoice: false, pending: {
      localRaw: local.raw, done, summary, description, patch, beforeCompletedAt: completedAt(remote), createdAt: now(), resumingSuppressed,
    } });
    return finishUpdate(record, remote);
  }
  async function finishUpdate(record, knownRemote) {
    const pending = record.pending;
    const local = await findTask(record.id, { allowCanceled: !!(record.resumingSuppressed || pending.resumingSuppressed) });
    let remote = knownRemote || await readRemoteTask(record);
    if (local.raw !== pending.localRaw) {
      // Preserve the transaction if the checkbox is our already-applied result.
      const expected = pending.localRaw.replace(/^(\s*(?:[-*+]|\d+[.)])[ \t]+\[)[^\]]/, '$1' + (pending.done ? 'x' : ' '));
      if (local.raw !== expected) {
        put('tasks', record.id, { ...record, pending: null, state: 'conflict', message: '同步期间本地行动被修改，请重新同步。' });
        throw new Error('同步期间本地行动被修改，已保留编辑，请重新同步。');
      }
    }
    const patch = {};
    for (const [key, value] of Object.entries(pending.patch)) {
      if (key === 'completed_at') {
        if ((completedAt(remote) !== '0') !== pending.done) {
          if (completedAt(remote) !== pending.beforeCompletedAt) {
            put('tasks', record.id, { ...record, state: 'conflict', message: '飞书状态在同步期间再次变化，请选择采用哪一边。' });
            throw new Error('飞书状态在同步期间再次变化，请先处理冲突。');
          }
          patch[key] = value;
        }
      } else if (key === 'start') {
        // A previous uncertain write may already have succeeded. Also retain a
        // start time entered in Feishu while this transaction was pending.
        if (!time.hasStart(remote.start)) patch[key] = time.withDue(value, remote.due);
      } else if (remote[key] !== value) patch[key] = value;
    }
    if (Object.keys(patch).length) {
      await api().updateTask(record.guid, patch);
      remote = await readRemoteTask(record);
    }
    if ((completedAt(remote) !== '0') !== pending.done || remote.summary !== pending.summary || remote.description !== pending.description
      || (pending.patch.start && !time.hasStart(remote.start))) {
      put('tasks', record.id, { ...record, pending: null, state: 'conflict', message: '飞书内容在同步期间变化，请重新同步。' });
      throw new Error('飞书内容在同步期间变化，已停止本地回写。');
    }
    if (local.done !== pending.done || (pending.resumingSuppressed && local.status === '-')) await md.writeDone(app, local, pending.done);
    return put('tasks', record.id, { ...record, path: local.path, state: 'linked', message: '', pending: null, needsChoice: false,
      ...(record.resumingSuppressed ? { resumingSuppressed: false } : {}),
      baseline: { done: pending.done, summary: pending.summary, completedAt: completedAt(remote) }, lastSyncedAt: now() });
  }
  async function sendOne(snapshot, options = {}) {
    api();
    const note = await readNote(snapshot.path);
    const current = note.tasks.find(t => t.line === snapshot.line && t.raw === snapshot.raw && t.fingerprint === snapshot.fingerprint);
    if (!current) throw new Error('行动已变化，请刷新后再发送。');
    if (current.vaultId && current.vaultId !== scope().vaultId) throw new Error('此行动属于其他仓库，不会接管原任务。');
    if (current.id && recordFor(current.id)) {
      const existing = recordFor(current.id);
      if (existing.state === 'draft') {
        payloadFor(current, existing.tasklistGuid || crypto.randomUUID(), options, await startForPath(current.path));
        put('tasks', current.id, { ...existing, options });
      }
      return syncOne(current.id);
    }
    // Validate title/time before making a remote list or changing the note.
    payloadFor({ ...current, id: current.id || crypto.randomUUID() }, crypto.randomUUID(), options, await startForPath(current.path));
    const hadId = !!current.id;
    if (hadId && !current.vaultId) throw new Error('旧行动标识没有仓库归属和可信本机记录，不能自动认领；请恢复原设备记录。');
    const identified = await md.identifyTask(app, current, scope());
    if (roundIndex) {
      const paths = roundIndex.get(identified.id) || [];
      if (!paths.includes(identified.path)) paths.push(identified.path);
      roundIndex.set(identified.id, paths);
    }
    const task = await findTask(identified.id);
    let record = { id: task.id, path: task.path, options, state: hadId ? 'untracked' : 'draft', createdAt: now() };
    put('tasks', task.id, record);
    return sendDraft(record);
  }
  async function sendDraft(record) {
    api();
    let task = await findTask(record.id, { allowCanceled: !!record.recreate?.reopen });
    if (record.recreate?.reopen) {
      const reopened = record.recreate.localRaw.replace(/^(\s*(?:[-*+]|\d+[.)])[ \t]+\[)[^\]]/, '$1 ');
      if (task.raw !== record.recreate.localRaw && task.raw !== reopened) throw staleConflict();
      if (task.status === '-') { await md.writeStatus(app, task, ' '); task = await findTask(record.id); }
      record = put('tasks', record.id, { ...record, recreate: { ...record.recreate, reopen: false } });
    }
    const start = await startForPath(task.path);
    payloadFor(task, crypto.randomUUID(), record.options || {}, start);
    const listGuid = await tasklist(task.path);
    const payload = payloadFor(task, listGuid, record.options || {}, start);
    if (record.recreate) payload.client_token = record.recreate.token;
    if (scope().hierarchyEnabled && await isProjectPath(task.path)) {
      const parent = await hierarchy.ensureProject(task.path);
      payload.tasklists[0].section_guid = parent.sectionGuid;
    }
    const untracked = record.state === 'untracked';
    record = put('tasks', task.id, { ...record, path: task.path, tasklistGuid: listGuid, payload, noBaseline: untracked || record.noBaseline,
      state: untracked ? 'uncertain' : 'creating' });
    if (untracked) {
      const result = await recover(record);
      if (result.needsChoice) throw new Error(result.message);
      return result;
    }
    try {
      const remote = await api().createTask(payload);
      record = attach(record, remote);
      if (scope().hierarchyEnabled && await isProjectPath(task.path)) record = (await hierarchy.placeAction(record, task, remote)).record;
      return record;
    } catch (error) {
      const latest = recordFor(task.id) || record;
      put('tasks', task.id, { ...latest, state: latest.guid ? 'error' : error.uncertain === false ? 'draft' : 'uncertain', message: error.message });
      throw error;
    }
  }
  async function batch(ids, operation) {
    const results = [];
    for (const id of ids) {
      try { const result = await operation(id); results.push({ id: result.id || id, ok: true }); }
      catch (error) { results.push({ id, ok: false, message: error.message }); }
    }
    return { synced: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
  }
  async function scopedNotes(errors, cached = false) {
    const notes = [];
    const current = scope();
    for (const file of app.vault.getMarkdownFiles()) {
      if (!md.allowedPath(file.path, current)) continue;
      try {
        const content = await (cached && app.vault.cachedRead ? app.vault.cachedRead(file) : app.vault.read(file));
        const kind = noteKind(file.path, content, current);
        if (kind && (kind !== 'daily' || current.syncDaily)) notes.push({ file, content, kind });
      } catch (error) {
        if (!errors) throw error;
        errors.push({ path: file.path, kind: 'project', revision: ++issueRevision, ok: false, message: error.message });
      }
    }
    return notes;
  }
  async function previewVault() {
    const notes = await scopedNotes();
    const c = scope(), records = state(true).accounts[c.appId] || { tasks: {}, projects: {} };
    const warnings = scopeWarnings(c);
    let projects = 0, taskNotes = 0, tasks = 0, dailyTasks = 0, foreign = 0, untracked = 0;
    for (const { file, content, kind } of notes) {
      if (kind === 'project') projects++;
      if (kind === 'task') taskNotes++;
      const marker = md.projectMarker(content, obsidian);
      if (marker?.vaultId && marker.vaultId !== c.vaultId) foreign++;
      else if (marker && !records.projects[marker.id]) untracked++;
      const actions = md.tasks(content, file.path);
      for (const t of actions) {
        if (t.vaultId && t.vaultId !== c.vaultId) foreign++;
        else if (t.id && !records.tasks[t.id]) untracked++;
      }
      const count = actions.filter(t => /^[ xX]$/.test(t.status)).length;
      tasks += count;
      if (inDaily(file.path)) dailyTasks += count;
    }
    if (foreign) warnings.push(foreign + ' 个标识属于其他仓库，请核对仓库标识；接入同一仓库请导入原设备接入包。');
    if (untracked) warnings.push(untracked + ' 个笔记标识缺少本机关联记录，请导入原设备接入包后再同步。');
    return { projects, taskNotes, tasks, dailyTasks, scopeLabel: syncScope.label(c), warnings };
  }
  function scopeWarnings(c) {
    const files = app.vault.getMarkdownFiles();
    return [...new Set([c.projectFolder, ...(c.taskFolders || []), ...(c.syncDaily ? [c.dailyFolder] : [])])].filter(folder =>
      !app.vault.getAbstractFileByPath(folder) && !files.some(file => file.path.startsWith(folder + '/')))
      .map(folder => '本机目录不存在或尚未同步：' + folder + '。请重新指定目录。');
  }
  async function syncVault({ automatic = false, shouldStop = () => false, paths } = {}) {
    if (paths && (!Array.isArray(paths) || paths.some(p => typeof p !== 'string'))) throw new Error('迁移范围应为项目笔记路径列表。');
    if (automatic && scope().hierarchyEnabled && hierarchy.state().state !== 'ready') throw new Error('新层级迁移尚未完成，请先完成迁移再开启自动同步。');
    if (automatic && !scope().autoEnabled) return { synced: 0, failed: 0, skipped: 0, results: [] };
    return exclusive(async () => {
      api();
      const results = [], seen = new Set();
      let skipped = 0;
      roundIndex = new Map();
      try {
        for (const f of app.vault.getMarkdownFiles()) {
          if (shouldStop()) break;
          for (const id of md.candidateTaskIds(await app.vault.read(f))) {
            const paths = roundIndex.get(id) || [];
            if (!paths.includes(f.path)) paths.push(f.path);
            roundIndex.set(id, paths);
          }
        }
        for (const { file, content, kind } of await scopedNotes(results)) {
          if (paths && !paths.includes(file.path)) continue;
          if (shouldStop()) break;
          try {
            const marker = md.projectMarker(content, obsidian);
            if (marker?.vaultId && marker.vaultId !== scope().vaultId) throw new Error('项目来自其他仓库，已跳过。');
            if (kind === 'project') {
              await tasklist(file.path);
              if (scope().hierarchyEnabled) results.push({ path: file.path, kind: 'project', ok: true });
            }
            const snapshots = (await readNote(file.path)).tasks;
            for (const original of snapshots) {
              if (shouldStop()) break;
              if (!/^[ xX]$/.test(original.status)) { skipped++; continue; }
              try {
                if (original.vaultId && original.vaultId !== scope().vaultId) throw new Error('行动来自其他仓库，已跳过。');
                if (original.id) seen.add(original.id);
                let result;
                if (original.id && recordFor(original.id)) {
                  const record = recordFor(original.id);
                  // Automatic runs cannot silently resolve a previously reported conflict.
                  if ((record.suppressed && !record.cancelPending) || ['conflict', 'remote_missing'].includes(record.state)) { skipped++; continue; }
                  result = await syncOne(original.id);
                } else {
                  const current = (await readNote(file.path)).tasks.find(t => t.line === original.line && t.raw === original.raw);
                  if (!current) throw new Error('行动在本轮同步中发生变化，留待下一轮。');
                  result = await sendOne(current, {});
                }
                seen.add(result.id);
                results.push({ id: result.id, path: file.path, ok: true });
              } catch (error) { results.push({ id: original.id, path: file.path, kind: 'task', line: original.line, ok: false, message: error.message }); }
            }
          } catch (error) { results.push({ path: file.path, kind: 'project', revision: ++issueRevision, ok: false, message: error.message }); }
        }
        // Include already linked completed/missing actions; never infer remote deletion
        // or local completion from a discovery filter or absent Markdown checkbox.
        for (const record of Object.values(account().value.tasks)) {
          if (paths && !paths.includes(record.path)) continue;
          if (shouldStop()) break;
          if (seen.has(record.id)) continue;
          if (!md.allowedPath(record.path, scope()) || (inDaily(record.path) && !scope().syncDaily)) { skipped++; continue; }
          const localFile = app.vault.getAbstractFileByPath(record.path);
          if (localFile && !noteKind(record.path, await app.vault.read(localFile))) { skipped++; continue; }
          if ((record.suppressed && !record.cancelPending) || ['conflict', 'remote_missing'].includes(record.state)) { skipped++; continue; }
          try { await syncOne(record.id); results.push({ id: record.id, path: record.path, ok: true }); }
          catch (error) { results.push({ id: record.id, path: record.path, ok: false, message: error.message }); }
        }
        return { synced: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, skipped, results };
      } finally { roundIndex = null; }
    });
  }
  function saveHierarchy(value) {
    const { all, key, value: current } = account();
    all.accounts[key] = { ...current, hierarchy: value };
    persist(all); notify(); return value;
  }
  const hierarchy = createHierarchy({ app, obsidian, api, scope, account, put, saveHierarchy, projectIdentity, now, verifyTask: verifyRemote });
  async function migrateVault(options = {}) {
    if (busy || scope().autoEnabled) throw new Error('请先关闭自动同步并等待当前操作结束，再迁移。');
    api();
    const old = settings();
    if (!old.hierarchyEnabled) writeJSON(configFile, { ...old, hierarchyEnabled: true, autoEnabled: false, configRevision: crypto.randomUUID() });
    hierarchy.save({ state: 'migrating', message: '' });
    const result = await syncVault({ paths: options.paths });
    if (!options.paths && result.failed === 0) {
      await exclusive(async () => {
        for (const project of Object.values(account().value.projects)) {
          try {
            const file = fileFor(project.path);
            const content = await app.vault.read(file), marker = md.projectMarker(content, obsidian);
            hierarchy.metadata(project.path, content);
            if (marker?.id !== project.id || marker.vaultId !== scope().vaultId || !project.parentTaskGuid
              || project.parentState !== 'linked' || project.parentPending || project.tasklistGuid !== hierarchy.state().vaultList?.guid) {
              throw new Error('项目的新层级尚未全部验证，保留迁移状态。');
            }
          } catch (error) { result.results.push({ path: project.path, ok: false, message: error.message }); }
        }
        for (const record of Object.values(account().value.tasks)) {
          if (record.suppressed) continue;
          try {
            const local = await findTask(record.id);
            if (!await isProjectPath(local.path)) continue;
            const note = await readNote(local.path);
            if (!record.hierarchyVerified || record.parentTaskGuid !== note.projectRecord?.guid || record.pending
              || record.state !== 'linked' || record.tasklistGuid !== hierarchy.state().vaultList?.guid || local.done !== record.baseline?.done) {
              throw new Error('行动的新层级尚未全部验证，保留迁移状态。');
            }
          } catch (error) { result.results.push({ id: record.id, path: record.path, ok: false, message: error.message }); }
        }
      });
      result.failed = result.results.filter(r => !r.ok).length;
    }
    if (!options.paths && result.failed === 0 && !result.results.some(r => !r.ok)) {
      hierarchy.save({ state: 'ready', message: '' });
    } else hierarchy.save({ state: 'migrating', message: result.failed ? '部分项目尚未迁移，请查看错误并继续迁移。' : '小范围验证完成，请继续迁移剩余项目。' });
    return result;
  }
  async function finalizeMigration() {
    if (scope().autoEnabled) throw new Error('请先关闭自动同步再收尾迁移。');
    if (!scope().hierarchyEnabled || hierarchy.state().state !== 'ready') throw new Error('请先完成全部项目迁移。');
    return exclusive(async () => {
      const results = [];
      for (const record of Object.values(account().value.tasks)) {
        if (record.suppressed) continue;
        if (!record.legacyTasklistGuid || record.legacyDetached) continue;
        try {
          const local = await findTask(record.id);
          const project = await hierarchy.ensureProject(local.path);
          const remote = verifyRemote(await api().getTask(record.guid), record);
          const lists = remote.tasklists || await api().listTasklistsForTask(record.guid);
          if (remote.parent_task_guid !== project.parentTaskGuid || !lists.some(l => l.tasklist_guid === project.tasklistGuid && l.section_guid === project.sectionGuid)
            || completedAt(remote) !== record.baseline.completedAt || (completedAt(remote) !== '0') !== local.done) throw new Error('行动的新层级或完成状态尚未核验，保留旧清单关联。');
          if (lists.some(l => l.tasklist_guid === record.legacyTasklistGuid)) await api().removeTasklist(record.guid, record.legacyTasklistGuid);
          const verified = verifyRemote(await api().getTask(record.guid), record);
          const after = verified.tasklists || await api().listTasklistsForTask(record.guid);
          if (after.some(l => l.tasklist_guid === record.legacyTasklistGuid) || !after.some(l => l.tasklist_guid === project.tasklistGuid)
            || verified.parent_task_guid !== project.parentTaskGuid || completedAt(verified) !== record.baseline.completedAt) throw new Error('移出旧清单的结果尚未确认。');
          put('tasks', record.id, { ...record, legacyDetached: true });
          results.push({ id: record.id, ok: true });
        } catch (error) { results.push({ id: record.id, ok: false, message: error.message }); }
      }
      return { synced: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
    });
  }
  function transferGuard() {
    if (busy) throw new Error('飞书操作正在进行，请等待完成。');
    if (scope().autoEnabled) throw new Error('请先关闭自动同步并保存，再导入或导出接入包。');
    if (unsaved) throw new Error('关联记录尚未保存，不能迁移；请先修复本机存储。');
  }
  function exportTransfer() {
    transferGuard();
    const c = config();
    const a = state(true).accounts[c.appId] || { tasks: {}, projects: {} };
    return transfer.validate({ source: 'obsidian-feishu-sync', version: 1, exportedAt: new Date(now()).toISOString(),
      config: transfer.publicConfig(c), records: { version: 1, accounts: { [c.appId]: a } } });
  }
  async function prepareTransfer(input, folders = {}) {
    const bundle = transfer.validate(input);
    const c = bundle.config;
    c.projectFolder = transfer.folder(folders.projectFolder ?? c.projectFolder);
    c.dailyFolder = transfer.folder(folders.dailyFolder ?? c.dailyFolder);
    transfer.validate(bundle);
    const old = settings(), all = state(true);
    if (old.appId && old.appId !== c.appId) throw new Error('接入包 App ID 与本机配置不同，请先核对应用并修改本机配置。');
    if (old.assigneeId && old.assigneeId !== c.assigneeId) throw new Error('接入包接收用户与本机配置不同，请核对同一应用下的 Open ID。');
    const hasRecords = Object.values(all.accounts).some(a => Object.keys(a.tasks || {}).length || Object.keys(a.projects || {}).length || a.hierarchy);
    if (hasRecords && old.vaultId !== c.vaultId) throw new Error('本机已有其他仓库的关联记录，不能覆盖其身份；请在对应仓库导入接入包。');
    const incoming = bundle.records.accounts[c.appId], local = all.accounts[c.appId] || { tasks: {}, projects: {} };
    let conflicts = 0;
    for (const kind of ['tasks', 'projects']) for (const [id, r] of Object.entries(incoming[kind])) {
      const previous = local[kind][id];
      if (!previous) continue;
      for (const key of ['guid', 'parentTaskGuid']) {
        if (previous[key] && previous[key] !== r[key]) throw new Error('同一标识的远端 GUID 冲突，不能覆盖关联记录。');
      }
      if (JSON.stringify(previous) !== JSON.stringify(r)) conflicts++;
    }
    for (const key of ['vaultList', 'statusField']) {
      if (local.hierarchy?.[key]?.guid && local.hierarchy[key].guid !== incoming.hierarchy?.[key]?.guid) throw new Error('仓库清单或状态字段 GUID 冲突，不能覆盖层级关联。');
    }
    for (const [key, r] of Object.entries(local.hierarchy?.sections || {})) {
      if (r.guid && incoming.hierarchy?.sections?.[key] && incoming.hierarchy.sections[key].guid !== r.guid) throw new Error('Area 分组 GUID 冲突，不能覆盖关联。');
    }
    const merged = { ...local, ...incoming, tasks: { ...local.tasks, ...incoming.tasks }, projects: { ...local.projects, ...incoming.projects } };
    if (incoming.hierarchy) merged.hierarchy = { ...local.hierarchy, ...incoming.hierarchy,
      sections: { ...local.hierarchy?.sections, ...incoming.hierarchy.sections } };
    const found = { tasks: new Map(), projects: new Map() }, noteHashes = [];
    for (const file of app.vault.getMarkdownFiles()) {
      // Daily markers are checked even when daily synchronization is disabled.
      if (!md.allowedPath(file.path, c)) continue;
      const content = await app.vault.read(file);
      if (!noteKind(file.path, content, c)) continue;
      noteHashes.push([file.path, crypto.createHash('sha256').update(content).digest('hex')]);
      const markers = { projects: [md.projectMarker(content, obsidian)].filter(Boolean), tasks: md.tasks(content, file.path).filter(t => t.id) };
      for (const kind of ['projects', 'tasks']) for (const marker of markers[kind]) {
        if (marker.vaultId && marker.vaultId !== c.vaultId) throw new Error('目标目录包含其他仓库的飞书标识：' + file.path + '。请核对目录与仓库标识。');
        if (!merged[kind][marker.id]) throw new Error('笔记标识缺少接入包中的可信关联记录：' + file.path + '。请重新导出完整记录。');
        if (found[kind].has(marker.id)) throw new Error('目标仓库有重复飞书标识：' + file.path + '。请先处理重复笔记或行动。');
        found[kind].set(marker.id, file.path);
      }
    }
    let remapped = 0, missing = 0;
    for (const kind of ['projects', 'tasks']) for (const r of Object.values(merged[kind])) {
      const target = found[kind].get(r.id);
      if (target) { if (r.path !== target) remapped++; r.path = target; }
      else missing++;
    }
    const records = { ...all, accounts: { ...all.accounts, [c.appId]: merged } };
    transfer.validate({ ...bundle, records: { version: 1, accounts: { [c.appId]: merged } } });
    const summary = { vaultId: c.vaultId, vaultLabel: c.vaultLabel, vaultTasklistName: c.vaultTasklistName || c.vaultLabel,
      projectFolder: c.projectFolder, dailyFolder: c.dailyFolder, appId: c.appId, assigneeId: c.assigneeId,
      projects: Object.keys(merged.projects).length, tasks: Object.keys(merged.tasks).length,
      remapped, missing, conflicts, warnings: scopeWarnings(c), vaultListGuid: merged.hierarchy?.vaultList?.guid || '', hasSecret: !!old.encryptedSecret };
    const signature = crypto.createHash('sha256').update(JSON.stringify({ old, all, c, incoming, noteHashes: noteHashes.sort() })).digest('hex');
    return { bundle, records, old, summary, signature };
  }
  function previewTransfer(input, folders) {
    transferGuard();
    return exclusive(async () => {
      const prepared = await prepareTransfer(input, folders);
      const token = crypto.randomUUID();
      transferPreview = { input: JSON.parse(JSON.stringify(input)), folders: { ...folders }, signature: prepared.signature, token };
      return { ...prepared.summary, token };
    });
  }
  function checkAssociations() {
    transferGuard();
    return exclusive(async () => {
      const a = state(true).accounts[scope().appId] || { tasks: {}, projects: {} }, h = a.hierarchy;
      const results = [];
      const check = async (name, read) => {
        try { await read(); results.push({ name, ok: true }); }
        catch (error) { results.push({ name, ok: false, message: error.message }); }
      };
      if (h?.vaultList?.guid) await check('仓库清单', async () => {
        if ((await api().getTasklist(h.vaultList.guid)).guid !== h.vaultList.guid) throw new Error('清单 GUID 不匹配。');
      });
      if (h?.statusField?.guid) await check('项目状态字段', async () => {
        const fields = await api().listCustomFields(h.vaultList.guid);
        if (!fields.some(f => f.guid === h.statusField.guid)) throw new Error('状态字段不属于原仓库清单。');
        const field = await api().getCustomField(h.statusField.guid);
        if (field.type !== 'single_select' || !Object.values(STATUS).every(label =>
          field.single_select_setting?.options?.filter(o => !o.is_hidden && o.name === label).length === 1)) throw new Error('原状态字段类型或四个选项不匹配。');
      });
      for (const r of Object.values(h?.sections || {})) if (r.guid) await check('Area：' + r.name, async () => {
        const section = await api().getSection(r.guid);
        if (section.resource_type !== 'tasklist' || section.tasklist?.guid !== h.vaultList?.guid) throw new Error('Area 分组不属于原仓库清单。');
      });
      for (const r of Object.values(a.projects)) {
        if (r.parentTaskGuid) await check('项目：' + r.path, () => api().getTask(r.parentTaskGuid).then(remote => hierarchy.verify(remote, r)));
        else if (r.guid) await check('旧项目清单：' + r.path, () => api().getTasklist(r.guid));
      }
      for (const r of Object.values(a.tasks)) if (r.guid) await check('行动：' + r.path, async () => {
        const remote = verifyRemote(await api().getTask(r.guid), r);
        if (r.hierarchyVerified) {
          const lists = remote.tasklists || await api().listTasklistsForTask(r.guid);
          if (remote.parent_task_guid !== r.parentTaskGuid || !lists.some(l => l.tasklist_guid === r.tasklistGuid && l.section_guid === r.sectionGuid)) throw new Error('行动的原清单、分组或父任务关系不匹配，请核对接入包是否为最新版本。');
        }
      });
      return { checked: results.length, failed: results.filter(r => !r.ok).length, results };
    });
  }
  function importTransfer(token) {
    transferGuard();
    return exclusive(async () => {
      const preview = transferPreview;
      if (!preview || token !== preview.token) throw new Error('请先预览接入包，再确认导入。');
      const prepared = await prepareTransfer(preview.input, preview.folders);
      if (prepared.signature !== preview.signature) throw new Error('预览后配置、记录或笔记发生变化，请重新预览接入包。');
      const { bundle, records, old } = prepared;
      const restored = { ...bundle.config, version: 2, autoEnabled: false, configRevision: crypto.randomUUID(),
        ...(old.appId === bundle.config.appId && old.encryptedSecret ? { encryptedSecret: old.encryptedSecret } : {}) };
      const backupPath = path.join(directory, 'backups', crypto.randomUUID());
      writeJSON(path.join(backupPath, 'config.json'), old);
      writeJSON(path.join(backupPath, 'records.json'), state(true));
      writeJSON(restoreFile, { version: 1, config: restored, records });
      completeRestore();
      client = null; selection = null; roundIndex = null;
      conflictPreviews.clear(); projectSuccess.clear(); transferPreview = null;
      return { ...prepared.summary, backupPath, config: config() };
    });
  }
  return {
    revision: '1.5.2',
    implementation: IMPLEMENTATION,
    hasUnsavedRecords: () => !!unsaved,
    getConfig: config,
    isCandidatePath: notePath => md.allowedPath(notePath, scope()),
    async listNotes() { return (await scopedNotes([], true)).map(({ file }) => file.path); },
    getSyncIssues,
    getTaskConflict,
    resolveTaskConflict,
    getHierarchyStatus: () => hierarchy.status(),
    exportTransfer,
    previewTransfer,
    importTransfer,
    checkAssociations,
    recoverHierarchyResource(value) {
      if (scope().autoEnabled) throw new Error('请先关闭自动同步再恢复资源。');
      return exclusive(() => hierarchy.recoverResource(value));
    },
    migrateVault,
    finalizeMigration,
    syncProject(notePath) {
      fileFor(notePath);
      if (!scope().hierarchyEnabled) throw new Error('请先启用新层级并迁移。');
      return syncVault({ paths: [notePath] });
    },
    markLegacyArchived(guids) {
      if (busy || !Array.isArray(guids)) throw new Error('请等待同步结束后记录归档结果。');
      for (const p of Object.values(account().value.projects)) if (guids.includes(p.legacyTasklistGuid || p.guid)) put('projects', p.id, { ...p, legacyArchived: true });
      return hierarchy.status();
    },
    isBusy: () => busy,
    previewVault,
    syncVault,
    saveConfig(value) {
      if (busy) throw new Error('同步中不能修改账号配置。');
      const old = settings();
      const appId = String(value.appId ?? old.appId ?? '').trim();
      const secret = String(value.secret || '').trim();
      const assigneeId = String(value.assigneeId ?? old.assigneeId ?? '').trim();
      const defaultTasklistGuid = String(value.defaultTasklistGuid ?? old.defaultTasklistGuid ?? '').trim();
      const vaultLabel = String(value.vaultLabel ?? old.vaultLabel ?? path.basename(base)).trim();
      if (!vaultLabel || [...vaultLabel].length > 30 || /[\[\]\r\n/\\]/.test(vaultLabel)) throw new Error('仓库显示名须为 1–30 个字符，不能含括号、斜线或换行。');
      const vaultId = String(value.vaultId ?? old.vaultId ?? '').trim().toLowerCase() || old.vaultId || crypto.randomUUID();
      if (!GUID.test(vaultId)) throw new Error('仓库标识须为完整的 UUID。');
      if (old.vaultId && vaultId !== old.vaultId) {
        const all = state();
        if (Object.values(all.accounts).some(a => Object.keys(a.tasks || {}).length || Object.keys(a.projects || {}).length || a.hierarchy)) {
          throw new Error('本机已有飞书关联，不能直接替换仓库标识。接入同一仓库请预览并导入原设备接入包。');
        }
        if (old.autoEnabled || value.autoEnabled === true) throw new Error('修改仓库标识前请关闭自动同步并保存。');
      }
      const vaultTasklistName = String(value.vaultTasklistName ?? old.vaultTasklistName ?? vaultLabel).trim();
      if (!vaultTasklistName || [...vaultTasklistName].length > 100 || /[\r\n]/.test(vaultTasklistName)) throw new Error('飞书清单名称须为 1–100 个字符，不能含换行。');
      const areaNames = transfer.names(value.areaNames ?? old.areaNames);
      const projectNames = transfer.names(value.projectNames ?? old.projectNames, true);
      const projectFolder = transfer.folder(value.projectFolder ?? old.projectFolder ?? defaultProjectFolder);
      const dailyFolder = transfer.folder(value.dailyFolder ?? old.dailyFolder ?? defaultDailyFolder);
      const extraScope = syncScope.normalize({ ...old, ...value });
      if (projectFolder === dailyFolder || projectFolder.startsWith(dailyFolder + '/') || dailyFolder.startsWith(projectFolder + '/')) throw new Error('项目与日记同步目录不能重叠。');
      const pollMinutes = Number(value.pollMinutes ?? old.pollMinutes ?? 2);
      if (!Number.isInteger(pollMinutes) || pollMinutes < 1 || pollMinutes > 60) throw new Error('同步间隔须为 1–60 分钟的整数。');
      if (!/^cli_[a-zA-Z0-9]+$/.test(appId)) throw new Error('App ID 应为 cli_ 开头的飞书自建应用 ID。');
      if (!/^ou_[a-zA-Z0-9]+$/.test(assigneeId)) throw new Error('请填写此应用下接收任务用户的 Open ID（ou_ 开头）。');
      if (defaultTasklistGuid && !GUID.test(defaultTasklistGuid)) throw new Error('默认清单 GUID 格式无效。');
      if (!secret && (appId !== old.appId || !old.encryptedSecret)) throw new Error('首次配置或切换应用时必须填写 App Secret。');
      if (appId === old.appId && assigneeId !== old.assigneeId && (Object.keys(account().value.tasks).length || Object.keys(account().value.projects).length)) {
        throw new Error('此应用已有同步任务，不能直接切换接收人；请先处理现有任务的负责人。');
      }
      if (value.autoEnabled === true && old.hierarchyEnabled && hierarchy.state().state !== 'ready') throw new Error('请完成新层级迁移后再开启自动同步。');
      const encryptedSecret = secret ? encryption().encryptString(secret).toString('base64') : old.encryptedSecret;
      writeJSON(configFile, { version: 2, hierarchyEnabled: old.hierarchyEnabled === true, appId, assigneeId, defaultTasklistGuid, encryptedSecret,
        vaultId, vaultLabel, vaultTasklistName, areaNames, projectNames, projectFolder, dailyFolder, pollMinutes, ...extraScope,
        autoEnabled: value.autoEnabled === undefined ? old.autoEnabled === true : value.autoEnabled === true,
        syncDaily: value.syncDaily === undefined ? old.syncDaily === true : value.syncDaily === true,
        configRevision: crypto.randomUUID() });
      client = null; notify(); return config();
    },
    check() { return exclusive(async () => { await api().check(); return { message: '已连接飞书应用，可读取任务清单。' }; }); },
    listTasklists() { return exclusive(() => api().listTasklists()); },
    getSelection() { return selection; },
    select(notePath, task) { fileFor(notePath); selection = { path: notePath, line: task?.line }; app.workspace.trigger('feishu-sync:selection', selection); },
    readNote,
    sendTask(snapshot, options) { return exclusive(() => sendOne(snapshot, options)); },
    syncTask(id, options) { return exclusive(() => syncOne(id, options)); },
    syncAll(notePath) { return exclusive(async () => {
      if (notePath) fileFor(notePath);
      const localIds = notePath ? new Set((await readNote(notePath)).tasks.map(t => t.id)) : null;
      const records = Object.values(account().value.tasks).filter(r => (!r.suppressed || r.cancelPending)
        && (!notePath || r.path === notePath || localIds.has(r.id)));
      return batch(records.map(r => r.id), id => syncOne(id));
    }); },
    sendProject(notePath) { return exclusive(async () => {
      api();
      const initial = await readNote(notePath);
      if (!initial.isProject) throw new Error('请选择一个项目。');
      const tasks = initial.tasks.filter(t => t.inNextActions && t.status === ' ' && !t.record?.suppressed);
      if (tasks.length > 100) throw new Error('一次最多发送 100 条行动，请分批逐条发送。');
      const start = await startForPath(notePath);
      for (const task of tasks) payloadFor({ ...task, id: task.id || crypto.randomUUID() }, crypto.randomUUID(), {}, start);
      // Mark the selected snapshots before sending; adding IDs changes file fingerprints.
      const ids = [];
      for (const original of tasks) {
        const fresh = await readNote(notePath);
        const task = fresh.tasks.find(t => t.line === original.line && t.raw === original.raw);
        if (!task) throw new Error('项目行动在准备期间变化，已停止发送，请刷新。');
        if (task.id && !task.vaultId && !recordFor(task.id)?.guid) throw new Error('旧行动标识缺少可信本机记录，已停止发送。');
        const identified = task.id && recordFor(task.id)?.guid ? task : await md.identifyTask(app, task, scope());
        ids.push(identified.id);
        if (!recordFor(identified.id)) put('tasks', identified.id, { id: identified.id, path: task.path,
          state: task.id ? 'untracked' : 'draft', createdAt: now(), options: {} });
      }
      if (!ids.length) return { synced: 0, failed: 0, results: [] };
      return batch(ids, id => syncOne(id));
    }); },
    bindTasklist(notePath, guid) { return exclusive(async () => {
      if (!GUID.test(guid)) throw new Error('请填写完整的清单 GUID。');
      const list = await api().getTasklist(guid);
      if (!list || list.guid !== guid) throw new Error('清单详情与指定 GUID 不一致。');
      if (!list.name.startsWith('[' + scope().vaultLabel + '] ')) throw new Error('请先将清单名称加上 [' + scope().vaultLabel + '] 前缀，不能绑定其他仓库的清单。');
      const { id } = await projectIdentity(notePath);
      if (Object.values(account().value.projects).some(p => p.id !== id && p.guid === guid)) throw new Error('此清单已绑定本仓库的其他项目。');
      const previous = account().value.projects[id];
      if (previous?.guid && previous.guid !== guid) throw new Error('此项目已有清单关联，不能直接改绑。');
      return put('projects', id, { id, path: notePath, guid, state: 'linked' });
    }); },
    recoverTask(id, guid) { return exclusive(async () => {
      if (!GUID.test(guid)) throw new Error('请填写完整任务 GUID。');
      const record = recordFor(id);
      if (!record) throw new Error('找不到本机创建记录，请先恢复原记录。');
      await findTask(id);
      return recover(record, guid);
    }); },
    async openPanel(notePath, task) {
      if (notePath) this.select(notePath, task);
      if (typeof dependencies.openPanel !== 'function') throw new Error('飞书插件面板尚未就绪，请重新打开插件。');
      return dependencies.openPanel();
    },
  };
}

/** @returns {import('../src/contracts').FeishuService} */
function getService(app, obsidian, dependencies = {}) {
  if (app[SERVICE]?.implementation !== IMPLEMENTATION) {
    if (app[SERVICE]?.isBusy()) throw new Error('飞书操作正在进行，请等待完成后重载插件。');
    if (app[SERVICE]?.hasUnsavedRecords?.()) throw new Error('飞书关联记录尚未保存，请修复本机存储后再重载插件。');
    app[SERVICE] = createService(app, obsidian, dependencies);
  }
  return app[SERVICE];
}

module.exports = { createService, getService, atomicJSON };
