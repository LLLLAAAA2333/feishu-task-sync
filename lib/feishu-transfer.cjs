'use strict';

const syncScope = require('./feishu-scope.cjs');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIG_KEYS = ['appId', 'assigneeId', 'defaultTasklistGuid', 'vaultId', 'vaultLabel', 'vaultTasklistName',
  'projectFolder', 'dailyFolder', 'syncDaily', 'pollMinutes', 'hierarchyEnabled', 'areaNames', 'projectNames',
  'taskFolders', 'taskTags', 'excludedFolders'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);

function relativePath(value) {
  return typeof value === 'string' && !!value && !/^[A-Za-z]:/.test(value) && !/[\\\r\n]/.test(value)
    && !value.startsWith('/') && !value.split('/').some(p => !p || p === '.' || p === '..' || p.startsWith('.'));
}
function folder(value) {
  const result = String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!relativePath(result)) throw new Error('同步目录应是本仓库内的有效相对路径。');
  return result;
}
function names(value = {}, projects = false) {
  if (!object(value)) throw new Error('层级显示名称配置格式无效。');
  const result = {};
  for (const [key, input] of Object.entries(value)) {
    if ((projects ? !GUID.test(key) : !relativePath(key)) || typeof input !== 'string') throw new Error('层级显示名称的标识或名称无效。');
    const name = input.trim();
    if ([...name].length > 100 || /[\r\n]/.test(name)) throw new Error('层级显示名称最多 100 个字符，不能含换行。');
    if (name) result[key] = name;
  }
  return result;
}
function publicConfig(config) {
  return Object.fromEntries(CONFIG_KEYS.filter(key => config[key] !== undefined).map(key => [key, config[key]]));
}
function safeTree(value, depth = 0) {
  if (depth > 40) throw new Error('接入包嵌套过深。');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)
      || /^(?:secret|app_?secret|encryptedSecret|(?:tenant_|app_|user_)?access_?token|refresh_?token|authorization)$/i.test(key)) {
      throw new Error('接入包含密钥或不安全字段，不能导入或导出。');
    }
    safeTree(child, depth + 1);
  }
}
function validate(input) {
  let value;
  try { value = typeof input === 'string' ? JSON.parse(input) : JSON.parse(JSON.stringify(input)); }
  catch (_) { throw new Error('接入包不是有效的 JSON。'); }
  safeTree(value);
  if (!object(value) || value.source !== 'obsidian-feishu-sync' || value.version !== 1
    || !object(value.config) || !object(value.records) || value.records.version !== 1 || !object(value.records.accounts)) {
    throw new Error('接入包来源或版本无效。');
  }
  const c = value.config;
  if (Object.keys(c).some(key => !CONFIG_KEYS.includes(key))) throw new Error('接入包配置包含不支持的字段。');
  if (!GUID.test(c.vaultId || '') || !/^cli_[a-zA-Z0-9]+$/.test(c.appId || '') || !/^ou_[a-zA-Z0-9]+$/.test(c.assigneeId || '')) {
    throw new Error('接入包仓库标识、App ID 或接收人无效。');
  }
  if (typeof c.vaultLabel !== 'string' || !c.vaultLabel.trim() || [...c.vaultLabel].length > 30 || /[\[\]\r\n/\\]/.test(c.vaultLabel)) throw new Error('接入包仓库显示名称无效。');
  if (c.vaultTasklistName !== undefined && (typeof c.vaultTasklistName !== 'string' || !c.vaultTasklistName.trim()
    || [...c.vaultTasklistName].length > 100 || /[\r\n]/.test(c.vaultTasklistName))) throw new Error('接入包清单名称无效。');
  c.projectFolder = folder(c.projectFolder);
  c.dailyFolder = folder(c.dailyFolder);
  Object.assign(c, syncScope.normalize(c));
  if (c.projectFolder === c.dailyFolder || c.projectFolder.startsWith(c.dailyFolder + '/') || c.dailyFolder.startsWith(c.projectFolder + '/')) throw new Error('项目与日记同步目录不能重叠。');
  if (c.defaultTasklistGuid && !GUID.test(c.defaultTasklistGuid)) throw new Error('接入包日记清单 GUID 无效。');
  if (!Number.isInteger(c.pollMinutes) || c.pollMinutes < 1 || c.pollMinutes > 60
    || typeof c.hierarchyEnabled !== 'boolean' || typeof c.syncDaily !== 'boolean') throw new Error('接入包同步选项无效。');
  c.areaNames = names(c.areaNames);
  c.projectNames = names(c.projectNames, true);
  if (Object.keys(value.records.accounts).length !== 1 || !Object.hasOwn(value.records.accounts, c.appId)) throw new Error('接入包账号与关联记录不一致。');
  const a = value.records.accounts[c.appId];
  if (!object(a) || !object(a.tasks) || !object(a.projects)) throw new Error('接入包缺少任务或项目关联记录。');
  const remoteTasks = new Set();
  for (const kind of ['tasks', 'projects']) for (const [id, record] of Object.entries(a[kind])) {
    if (!GUID.test(id) || !object(record) || record.id !== id || !relativePath(record.path)) throw new Error('接入包关联标识或笔记路径无效。');
    for (const key of ['guid', 'tasklistGuid', 'sectionGuid', 'parentTaskGuid', 'legacyTasklistGuid']) {
      if (record[key] && !GUID.test(record[key])) throw new Error('接入包远端 GUID 无效。');
    }
    const guid = kind === 'tasks' ? record.guid : record.parentTaskGuid;
    if (guid && remoteTasks.has(guid)) throw new Error('接入包有多个标识共用同一飞书任务。');
    if (guid) remoteTasks.add(guid);
    for (const key of ['payload', 'parentPayload']) {
      if (!record[key]?.extra) continue;
      let extra;
      try { extra = JSON.parse(record[key].extra); } catch (_) { throw new Error('接入包任务归属信息损坏。'); }
      safeTree(extra);
      if (extra.source !== 'obsidian-feishu-sync' || extra.id !== id || (extra.vaultId && extra.vaultId !== c.vaultId)) throw new Error('接入包任务归属与仓库标识不一致。');
    }
  }
  if (c.hierarchyEnabled && !object(a.hierarchy)) throw new Error('接入包缺少仓库层级关联记录。');
  if (a.hierarchy) {
    const h = a.hierarchy;
    if (h.version !== 1 || !object(h.sections)) throw new Error('接入包层级记录版本或分组无效。');
    for (const r of [h.vaultList, h.statusField, ...Object.values(h.sections)].filter(Boolean)) {
      if (!object(r) || (r.guid && !GUID.test(r.guid))) throw new Error('接入包层级资源 GUID 无效。');
    }
  }
  return value;
}

module.exports = { publicConfig, validate, folder, names, relativePath };
