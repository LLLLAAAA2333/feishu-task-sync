'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const md = require('./feishu-markdown.cjs');
const time = require('./feishu-time.cjs');
const { taskUrl, tasklistUrl } = require('./feishu-api.cjs');
const STATUS = { todo: '待办', doing: '进行中', done: '已完成', canceled: '已取消' };
const terminal = status => status === 'done' || status === 'canceled';

// Called by the service's exclusive transaction. Resource intents live alongside
// the old associations; a lost create response never causes a second create.
function createHierarchy(ctx) {
  const { app, obsidian, api, scope, account, put, saveHierarchy, projectIdentity, now } = ctx;
  let basicsCache, projectCache = new Map(), sectionCache = new Map();
  const state = () => account().value.hierarchy || { version: 1, sections: {}, state: 'migrating' };
  const save = patch => saveHierarchy({ ...state(), ...patch });
  const projectRecord = id => account().value.projects[id];
  function begin() { basicsCache = null; projectCache = new Map(); sectionCache = new Map(); }
  function metadata(notePath, content) {
    const info = obsidian.getFrontMatterInfo(content);
    const fm = info.exists ? obsidian.parseYaml(info.frontmatter) || {} : {};
    const tags = Array.isArray(fm.tags) ? fm.tags : [fm.tags];
    if (!tags.some(t => t === 'project' || t === '#project')) throw new Error('该笔记已不是项目。');
    if (!Object.hasOwn(STATUS, fm.status)) throw new Error('项目 status 须为 todo、doing、done 或 canceled，请先在笔记中确认。');
    const values = Array.isArray(fm.area) ? fm.area.filter(Boolean) : fm.area ? [fm.area] : [];
    if (values.length > 1) throw new Error('项目包含多个 Area，请明确一个主领域后再同步。');
    let target = String(values[0] || '').trim();
    target = target.replace(/^\[\[/, '').replace(/\]\]$/, '').split('|')[0].split('#')[0];
    const resolved = target ? app.metadataCache?.getFirstLinkpathDest?.(target, notePath) : null;
    const areaKey = resolved?.path || (target ? path.posix.normalize(target.startsWith('.')
      ? path.posix.join(path.posix.dirname(notePath), target) : target) : '__unclassified__');
    const id = md.projectMarker(content, obsidian)?.id;
    return { status: fm.status, areaKey, areaName: scope().areaNames?.[areaKey] || (target ? path.posix.basename(resolved?.path || target, '.md') : '未分类'),
      summary: scope().projectNames?.[id] || path.posix.basename(notePath, '.md'), start: time.parseStart(fm.createTime),
      empty: !md.tasks(content, notePath).some(t => /^[ xX]$/.test(t.status)) };
  }
  async function readMeta(notePath) {
    const file = app.vault.getAbstractFileByPath(notePath);
    if (!file || !notePath.startsWith(scope().projectFolder + '/')) throw new Error('项目不在配置的目录中。');
    return { file, ...metadata(notePath, await app.vault.read(file)) };
  }
  async function resource(key, create, get, payload) {
    let record = state()[key];
    if (record?.guid) return get(record.guid);
    if (record && record.state !== 'retryable') throw new Error('新层级资源创建结果待确认，请核实并恢复关联；不会重复创建。');
    record = { state: 'creating', payload, createdAt: now() };
    save({ [key]: record });
    try {
      const remote = await create(payload);
      save({ [key]: { ...record, ...remote, state: 'linked' } });
      return remote;
    } catch (error) {
      if (!state()[key]?.guid) save({ [key]: { ...record, state: error.uncertain === false ? 'retryable' : 'uncertain', message: error.message } });
      throw error;
    }
  }
  async function basics() {
    if (basicsCache) return basicsCache;
    const name = scope().vaultTasklistName || scope().vaultLabel;
    const list = await resource('vaultList', p => api().createTasklist(p), g => api().getTasklist(g),
      { name, members: [{ id: scope().assigneeId, type: 'user', role: 'editor' }] });
    if (list.name !== name) {
      await api().updateTasklist(list.guid, { name });
      save({ vaultList: { ...state().vaultList, name } });
    }
    // Read the permission-gated resources before adding any project parent.
    await api().listSections(list.guid);
    const fields = await api().listCustomFields(list.guid);
    if (state().statusField?.guid && !fields.some(f => f.guid === state().statusField.guid)) throw new Error('项目状态字段已移出仓库清单，请恢复字段关联。');
    const field = await resource('statusField', p => api().createCustomField(p), g => api().getCustomField(g), {
      name: '项目状态', type: 'single_select', resource_type: 'tasklist', resource_id: list.guid,
      single_select_setting: { options: Object.values(STATUS).map(name => ({ name })) },
    });
    const options = {};
    for (const [key, label] of Object.entries(STATUS)) {
      const matches = (field.single_select_setting?.options || []).filter(o => o.name === label && !o.is_hidden);
      if (matches.length !== 1 || !matches[0].guid) throw new Error('项目状态字段的四个选项不完整或重复，请恢复字段后再同步。');
      options[key] = matches[0].guid;
    }
    basicsCache = { listGuid: list.guid, fieldGuid: field.guid, options };
    return basicsCache;
  }
  async function section(meta, listGuid) {
    if (sectionCache.has(meta.areaKey)) return sectionCache.get(meta.areaKey);
    const records = state().sections || {};
    let record = records[meta.areaKey];
    const set = value => { save({ sections: { ...state().sections, [meta.areaKey]: value } }); record = value; };
    if (record?.guid) {
      const remote = await api().getSection(record.guid);
      if (remote.resource_type !== 'tasklist' || remote.tasklist?.guid !== listGuid) throw new Error('Area 分组属于其他清单或缺少所属信息，已停止同步。');
      if (remote.name !== meta.areaName) await api().updateSection(record.guid, { name: meta.areaName });
      if (record.name !== meta.areaName) set({ ...record, name: meta.areaName });
      sectionCache.set(meta.areaKey, record.guid);
      return record.guid;
    }
    if (record && record.state !== 'retryable') throw new Error('Area 分组创建结果待确认；不会重复创建。');
    set({ name: meta.areaName, state: 'creating', createdAt: now() });
    try {
      const remote = await api().createSection({ name: meta.areaName, resource_type: 'tasklist', resource_id: listGuid });
      set({ ...record, guid: remote.guid, state: 'linked' });
      sectionCache.set(meta.areaKey, remote.guid);
      return remote.guid;
    } catch (error) {
      if (!state().sections?.[meta.areaKey]?.guid) set({ ...record, state: error.uncertain === false ? 'retryable' : 'uncertain', message: error.message });
      throw error;
    }
  }
  function extra(id) { return JSON.stringify({ source: 'obsidian-feishu-sync', version: 3, kind: 'project', vaultId: scope().vaultId, id }); }
  function owns(remote, id) {
    try { const x = JSON.parse(remote.extra); return x.source === 'obsidian-feishu-sync' && x.version === 3 && x.kind === 'project' && x.vaultId === scope().vaultId && x.id === id; }
    catch (_) { return false; }
  }
  function verify(remote, record) {
    if (!remote || remote.guid !== record.parentTaskGuid || !owns(remote, record.id) || !/^\d+$/.test(remote.completed_at || '') || remote.mode === 1) {
      throw new Error('项目父任务的身份或完成模式不匹配，已停止同步。');
    }
    return remote;
  }
  function remoteStatus(remote, basic) {
    const value = remote.custom_fields?.find(f => f.guid === basic.fieldGuid)?.single_select_value;
    const status = Object.keys(STATUS).find(s => basic.options[s] === value);
    if (!status) throw new Error('飞书项目状态字段缺失或无效，已停止回写。');
    return status;
  }
  async function relation(remote, listGuid, sectionGuid, parentGuid) {
    let task = remote;
    let lists = task.tasklists || await api().listTasklistsForTask(task.guid);
    if (!lists.some(x => x.tasklist_guid === listGuid && x.section_guid === sectionGuid)) {
      await api().addTasklist(task.guid, listGuid, sectionGuid);
      task = await api().getTask(task.guid);
      lists = task.tasklists || await api().listTasklistsForTask(task.guid);
      if (!lists.some(x => x.tasklist_guid === listGuid && x.section_guid === sectionGuid)) throw new Error('清单和分组归属未能验证，请稍后重试。');
    }
    if (parentGuid !== undefined && (task.parent_task_guid || '') !== (parentGuid || '')) {
      await api().setTaskParent(task.guid, parentGuid || null);
      task = await api().getTask(task.guid);
      if ((task.parent_task_guid || '') !== (parentGuid || '')) throw new Error('父任务关系未能验证，请稍后重试。');
    }
    return task;
  }
  function description(meta) {
    return 'Obsidian 项目：' + meta.summary + '\n领域：' + meta.areaName
      + (meta.empty && !terminal(meta.status) ? '\n尚未拆分下一步行动。' : '')
      + '\n项目状态独立于子任务；结束项目不会批量结束行动。';
  }
  async function writeStatus(notePath, id, before, status) {
    if (before === status) return;
    const file = app.vault.getAbstractFileByPath(notePath);
    await md.helpers.withFileQueue(app, notePath, () => app.vault.process(file, content => {
      const marker = md.projectMarker(content, obsidian);
      const current = metadata(notePath, content);
      if (marker?.id !== id || marker.vaultId !== scope().vaultId || current.status !== before) throw new Error('同步期间项目状态变化，已保留本地编辑。');
      const info = obsidian.getFrontMatterInfo(content);
      const newline = content.match(/\r\n|\n|\r/)?.[0] || '\n';
      const lines = info.frontmatter.split(/\r\n|\n|\r/);
      const statusIndex = lines.findIndex(line => /^status\s*:/.test(line));
      if (statusIndex < 0 || lines.filter(line => /^status\s*:/.test(line)).length !== 1) throw new Error('项目 status 字段格式异常，已停止回写。');
      for (const key of ['status', 'doneTime']) {
        const i = lines.findIndex(line => line.startsWith(key + ':'));
        if (i >= 0 && (/^\s*[>|]/.test(lines[i].split(':').slice(1).join(':')) || /^\s+\S/.test(lines[i + 1] || ''))) throw new Error('项目状态或完成时间使用多行 YAML，已保留原文，请改为单行后重试。');
      }
      lines[statusIndex] = 'status: ' + status;
      const doneIndex = lines.findIndex(line => /^doneTime\s*:/.test(line));
      if (terminal(status)) {
        const line = 'doneTime: "' + md.helpers.formatTimestamp(new Date(now())).slice(0, 16).replace('T', ' ') + '"';
        if (doneIndex >= 0) lines[doneIndex] = line;
        else { const at = lines.at(-1) === '' ? lines.length - 1 : lines.length; lines.splice(at, 0, line); }
      } else if (doneIndex >= 0) lines.splice(doneIndex, 1);
      const fm = lines.join(newline);
      const offset = content.indexOf(info.frontmatter);
      return content.slice(0, offset) + fm + content.slice(offset + info.frontmatter.length);
    }));
  }

  async function ensureProject(notePath) {
    if (projectCache.has(notePath)) return projectCache.get(notePath);
    const meta = await readMeta(notePath);
    const identity = await projectIdentity(notePath);
    const id = identity.id;
    let record = projectRecord(id);
    if (!record && !identity.fresh) throw new Error('项目标识缺少可信本机关联记录，请先恢复记录。');
    if (!record) record = put('projects', id, { id, path: notePath, parentState: 'retryable', createdAt: now() });
    const basic = await basics();
    const sectionGuid = await section(meta, basic.listGuid);
    record = { ...record, id, path: notePath,
      legacyTasklistGuid: record?.legacyTasklistGuid || record?.guid || null };
    const set = patch => { record = put('projects', id, { ...record, ...patch }); return record; };
    let remote;
    try {
      if (!record.parentTaskGuid) {
        if (record.parentState && record.parentState !== 'retryable') {
          const matches = [];
          for (const item of await api().listTasks(basic.listGuid)) {
            const task = item.extra === undefined ? await api().getTask(item.guid) : item;
            if (owns(task, id)) matches.push(task);
          }
          if (matches.length !== 1) throw new Error('项目父任务创建结果待确认，请核实关联；不会重复创建。');
          set({ parentTaskGuid: matches[0].guid });
          remote = await api().getTask(record.parentTaskGuid);
        } else {
          const payload = { summary: meta.summary, description: description(meta), mode: 2,
            ...(meta.start ? { start: meta.start } : {}),
            completed_at: terminal(meta.status) ? String(now()) : '0',
            client_token: crypto.randomUUID(), extra: extra(id),
            members: [{ id: scope().assigneeId, type: 'user', role: 'assignee' }],
            tasklists: [{ tasklist_guid: basic.listGuid, section_guid: sectionGuid }],
            custom_fields: [{ guid: basic.fieldGuid, single_select_value: basic.options[meta.status] }] };
          set({ parentState: 'creating', parentPayload: payload, parentInitialStatus: meta.status,
            tasklistGuid: basic.listGuid, sectionGuid });
          try {
            const created = await api().createTask(payload);
            set({ parentTaskGuid: created.guid });
            remote = await api().getTask(created.guid);
          } catch (error) {
            if (!record.parentTaskGuid) set({ parentState: error.uncertain === false ? 'retryable' : 'uncertain', message: error.message });
            throw error;
          }
        }
      } else remote = await api().getTask(record.parentTaskGuid);
      verify(remote, record);
      if (!record.parentBaseline) {
        const initialStatus = record.parentInitialStatus;
        if (!Object.hasOwn(STATUS, initialStatus) || !record.parentPayload) throw new Error('项目缺少可信创建基线，请恢复本机关联记录。');
        set({ parentBaseline: { status: initialStatus, completedAt: record.parentPayload.completed_at,
          lastOpenStatus: terminal(initialStatus) ? 'todo' : initialStatus } });
      }
      remote = await relation(remote, basic.listGuid, sectionGuid, null);
      const baseline = record.parentBaseline;
      const fieldStatus = remoteStatus(remote, basic);
      const remoteDone = remote.completed_at !== '0';
      let pending = record.parentPending;
      if (!pending) {
        const localChanged = meta.status !== baseline.status;
        const fieldChanged = fieldStatus !== baseline.status;
        const doneChanged = remoteDone !== terminal(baseline.status);
        let remoteDesired = fieldStatus;
        if (doneChanged) {
          if (baseline.status === 'canceled' && !remoteDone && !localChanged) throw new Error('已取消项目在飞书被重新打开；请先在 Obsidian 明确设为 todo 或 doing。');
          const fromCheckbox = remoteDone ? 'done' : baseline.lastOpenStatus || 'todo';
          if (fieldChanged && terminal(fieldStatus) !== remoteDone) throw new Error('飞书项目状态字段与完成勾选同时变化且不一致，请先确认。');
          if (!fieldChanged) remoteDesired = baseline.status === 'canceled' && localChanged && !terminal(meta.status) && !remoteDone
            ? meta.status : fromCheckbox;
        }
        const remoteChanged = fieldChanged || doneChanged;
        if (localChanged && remoteChanged && meta.status !== remoteDesired) throw new Error('项目两端状态都已变化，请先统一项目状态。');
        const desired = localChanged ? meta.status : remoteChanged ? remoteDesired : meta.status;
        const desc = description({ ...meta, status: desired });
        if (desired === meta.status && fieldStatus === desired && remoteDone === terminal(desired)
          && remote.summary === meta.summary && remote.description === desc && (time.hasStart(remote.start) || !meta.start)) {
          set({ parentState: 'linked', message: '', tasklistGuid: basic.listGuid, sectionGuid, areaKey: meta.areaKey, areaName: meta.areaName,
            parentBaseline: { status: desired, completedAt: remote.completed_at,
              lastOpenStatus: terminal(desired) ? baseline.lastOpenStatus : desired } });
          projectCache.set(notePath, record);
          return record;
        }
        pending = { localStatus: meta.status, desired, beforeCompletedAt: remote.completed_at, beforeFieldStatus: fieldStatus,
          summary: meta.summary, description: desc, start: !time.hasStart(remote.start) ? time.withDue(meta.start, remote.due) : undefined };
        set({ parentPending: pending, parentState: 'syncing' });
      }
      const fresh = await readMeta(notePath);
      if (![pending.localStatus, pending.desired].includes(fresh.status)) throw new Error('同步期间项目状态变化，已保留本地编辑。');
      const targetDone = terminal(pending.desired);
      const reached = fieldStatus === pending.desired && remoteDone === targetDone;
      if (!reached && (remote.completed_at !== pending.beforeCompletedAt || fieldStatus !== pending.beforeFieldStatus)) {
        throw new Error('飞书项目状态在同步期间再次变化，已停止回写。');
      }
      const patch = {};
      if (remote.summary !== pending.summary) patch.summary = pending.summary;
      if (remote.description !== pending.description) patch.description = pending.description;
      if (pending.start && !time.hasStart(remote.start)) patch.start = time.withDue(pending.start, remote.due);
      if (remoteDone !== targetDone) patch.completed_at = targetDone ? String(now()) : '0';
      if (fieldStatus !== pending.desired) patch.custom_fields = [{ guid: basic.fieldGuid, single_select_value: basic.options[pending.desired] }];
      if (Object.keys(patch).length) { await api().updateTask(record.parentTaskGuid, patch); remote = verify(await api().getTask(record.parentTaskGuid), record); }
      if (remoteStatus(remote, basic) !== pending.desired || (remote.completed_at !== '0') !== targetDone
        || (pending.start && !time.hasStart(remote.start))) throw new Error('项目状态或开始时间写入尚未确认，请稍后重试。');
      await writeStatus(notePath, id, fresh.status, pending.desired);
      set({ parentPending: null, parentState: 'linked', message: '', tasklistGuid: basic.listGuid, sectionGuid,
        areaKey: meta.areaKey, areaName: meta.areaName, parentBaseline: { status: pending.desired, completedAt: remote.completed_at,
          lastOpenStatus: terminal(pending.desired) ? baseline.lastOpenStatus : pending.desired } });
      projectCache.set(notePath, record);
      return record;
    } catch (error) {
      const latest = projectRecord(id) || record;
      put('projects', id, { ...latest, parentState: latest.parentTaskGuid ? 'error' : latest.parentState || 'error', message: error.message });
      throw error;
    }
  }
  async function placeAction(record, local, remote) {
    const project = await ensureProject(local.path);
    const prior = record.tasklistGuid;
    const linked = await relation(remote, project.tasklistGuid, project.sectionGuid, project.parentTaskGuid);
    ctx.verifyTask(linked, record);
    const updated = put('tasks', record.id, { ...record, path: local.path, tasklistGuid: project.tasklistGuid,
      sectionGuid: project.sectionGuid, parentTaskGuid: project.parentTaskGuid,
      legacyTasklistGuid: record.legacyTasklistGuid || (prior !== project.tasklistGuid ? prior : null), hierarchyVerified: true });
    return { record: updated, remote: linked };
  }
  function status() {
    const h = state(), a = account().value;
    const projects = Object.values(a.projects), tasks = Object.values(a.tasks).filter(t => !t.suppressed);
    const recoveries = [];
    for (const kind of ['vaultList', 'statusField']) {
      const r = h[kind];
      if (r && !r.guid && ['creating', 'uncertain'].includes(r.state)) recoveries.push({ kind, name: r.payload?.name || kind, state: r.state, message: r.message || '' });
    }
    for (const [key, r] of Object.entries(h.sections || {})) {
      if (!r.guid && ['creating', 'uncertain'].includes(r.state)) recoveries.push({ kind: 'section', key, name: r.name, state: r.state, message: r.message || '' });
    }
    return { enabled: scope().hierarchyEnabled, recoveries,
      areas: Object.entries(h.sections || {}).map(([key, r]) => ({ key, name: r.name || key, guid: r.guid || '' })),
      projects: projects.map(p => ({ id: p.id, path: p.path, name: path.posix.basename(p.path || '', '.md'), guid: p.parentTaskGuid || '' })),
      vaultList: h.vaultList?.guid
      ? { ...h.vaultList, url: tasklistUrl(h.vaultList.guid) } : h.vaultList || null,
      migration: { state: scope().hierarchyEnabled ? h.state || 'migrating' : 'legacy', message: h.message || '',
        legacyProjects: projects.filter(p => p.legacyTasklistGuid || p.guid).length,
        legacyTasks: tasks.filter(t => t.legacyTasklistGuid || (!t.hierarchyVerified && t.tasklistGuid)).length,
        archivePending: projects.filter(p => (p.legacyTasklistGuid || p.guid) && !p.legacyArchived).length } };
  }
  async function recoverResource({ kind, key, guid } = {}) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(guid || '')) throw new Error('请填写完整的远端资源 GUID。');
    const h = state(), record = kind === 'section' ? h.sections?.[key] : h[kind];
    if (!['vaultList', 'statusField', 'section'].includes(kind) || !record || record.guid || !['creating', 'uncertain'].includes(record.state)) throw new Error('该资源没有待恢复的创建记录。');
    let remote;
    if (kind === 'vaultList') {
      remote = await api().getTasklist(guid);
      if (remote.name !== record.payload?.name || Object.values(account().value.projects).some(p => (p.legacyTasklistGuid || p.guid) === guid)) throw new Error('这不是待恢复的仓库清单，请核对名称和 GUID。');
    } else if (kind === 'section') {
      remote = await api().getSection(guid);
      if (remote.name !== record.name || remote.resource_type !== 'tasklist' || remote.tasklist?.guid !== h.vaultList?.guid
        || Object.entries(h.sections || {}).some(([k, r]) => k !== key && r.guid === guid)) throw new Error('分组名称或所属仓库清单不匹配。');
    } else {
      const fields = await api().listCustomFields(h.vaultList.guid);
      if (!fields.some(f => f.guid === guid)) throw new Error('该字段不属于仓库清单。');
      remote = await api().getCustomField(guid);
      if (remote.name !== record.payload?.name || remote.type !== 'single_select'
        || !Object.values(STATUS).every(label => remote.single_select_setting?.options?.filter(o => !o.is_hidden && o.name === label).length === 1)) throw new Error('项目状态字段的名称、类型或选项不匹配。');
    }
    const next = { ...record, ...remote, state: 'linked', message: '' };
    if (kind === 'section') save({ sections: { ...h.sections, [key]: next } }); else save({ [kind]: next });
    begin();
    return status();
  }
  return { begin, metadata, readMeta, basics, section, state, save, owns, verify, remoteStatus, relation, description, writeStatus, extra, projectRecord,
    ensureProject, placeAction, status, recoverResource,
    get cache() { return projectCache; } };
}

module.exports = { createHierarchy, STATUS, terminal };
