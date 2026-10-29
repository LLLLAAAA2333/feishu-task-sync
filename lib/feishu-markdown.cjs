'use strict';

const crypto = require('node:crypto');
const helpers = require('./task-helpers.cjs');
const scope = require('./feishu-scope.cjs');
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TASK = new RegExp('<!-- feishu-task: (?:(' + UUID + ')/)?(' + UUID + ') -->', 'g');
const PROJECT = new RegExp('^<!-- feishu-project: (?:(' + UUID + ')/)?(' + UUID + ') -->[ \\t]*$');
const PROJECT_PROPERTY = 'feishu-project';
const PROJECT_VALUE = new RegExp('^(?:(' + UUID + ')/)?(' + UUID + ')$');

function taskMarker(raw) {
  const matches = [...raw.matchAll(TASK)];
  if (matches.length > 1) throw new Error('同一行动包含多个飞书标识，请先检查该行。');
  if (!matches.length) return null;
  // A marker is metadata only at the end of the action, before an optional block ID.
  const tail = raw.slice(matches[0].index + matches[0][0].length);
  if (!/^[ \t]*(?:\^[a-zA-Z0-9-]+)?[ \t]*$/.test(tail)) return null;
  const prefix = raw.slice(0, matches[0].index);
  if ((prefix.match(/`/g) || []).length % 2) return null;
  return { vaultId: matches[0][1] || null, id: matches[0][2] };
}
function idFor(raw) { return taskMarker(raw)?.id || null; }

// Conservative index only: examples and malformed lines remain candidates.
// findTask still parses each candidate strictly before any synchronization.
function candidateTaskIds(content) {
  return [...new Set([...content.matchAll(TASK)].map(match => match[2]))];
}

function legacyProjectMarkers(content) {
  const matches = [];
  const lines = [...content.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)];
  let frontmatter = /^\uFEFF?---\s*$/.test(lines[0][1]);
  let fence = null;
  let comment = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i][1];
    if (frontmatter) {
      if (i > 0 && /^(?:---|\.\.\.)\s*$/.test(raw)) frontmatter = false;
      continue;
    }
    if (fence) {
      const close = raw.match(/^\s*(`+|~+)\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      continue;
    }
    const marker = !comment && raw.match(PROJECT);
    if (marker) {
      matches.push({ vaultId: marker[1] || null, id: marker[2], start: lines[i].index, end: lines[i].index + lines[i][0].length });
      continue;
    }
    let visible = '', ticks = 0;
    for (let j = 0; j < raw.length;) {
      if (comment) {
        const end = raw.indexOf('-->', j);
        if (end < 0) break;
        comment = false; j = end + 3;
      } else if (!ticks && raw.startsWith('<!--', j)) { comment = true; j += 4; }
      else if (raw[j] === '`') {
        const run = raw.slice(j).match(/^`+/)[0];
        if (!ticks) ticks = run.length; else if (ticks === run.length) ticks = 0;
        visible += run; j += run.length;
      } else { visible += raw[j++]; }
    }
    const opening = visible.match(/^\s*(`{3,}|~{3,})/);
    if (opening) fence = opening[1];
  }
  return matches;
}

function projectFrontmatter(content, obsidian) {
  const info = obsidian.getFrontMatterInfo(content);
  if (info.exists) return info;
  // Obsidian's boundary helper does not recognize BOM or CR-only documents.
  const lines = [...content.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)];
  if (!/^\uFEFF?---[ \t]*$/.test(lines[0][1])) return info;
  const closing = lines.slice(1).find(line => /^(?:---|\.\.\.)[ \t]*$/.test(line[1]));
  if (!closing) throw new Error('项目 frontmatter 未闭合，已停止写入。');
  return { exists: true, frontmatter: content.slice(lines[0][0].length, closing.index), contentStart: closing.index + closing[0].length };
}

function projectMarker(content, obsidian) {
  const info = projectFrontmatter(content, obsidian);
  const fm = info.exists ? obsidian.parseYaml(info.frontmatter.replace(/\r\n|\r/g, '\n')) || {} : {};
  const value = fm[PROJECT_PROPERTY];
  let property = null;
  if (value != null && value !== '') {
    const match = typeof value === 'string' && value.match(PROJECT_VALUE);
    if (!match) throw new Error('feishu-project 属性须为项目 UUID 或仓库 UUID/项目 UUID，请先检查笔记。');
    property = { vaultId: match[1] || null, id: match[2] };
  }
  const legacy = legacyProjectMarkers(content);
  if (legacy.length > 1) throw new Error('项目笔记包含多个飞书项目标识，请先检查笔记。');
  const old = legacy[0];
  if (property && old && (property.id !== old.id || (property.vaultId && old.vaultId && property.vaultId !== old.vaultId))) {
    throw new Error('feishu-project 属性与正文标识不一致，请先检查笔记。');
  }
  const marker = property || old;
  return marker ? { vaultId: property?.vaultId || old?.vaultId || null, id: marker.id } : null;
}
function projectId(content, obsidian) { return projectMarker(content, obsidian)?.id || null; }

// Change only the identity field and actual legacy marker lines. Other YAML and
// Markdown bytes (including examples, comments, BOM, and line endings) stay intact.
function writeProjectMarker(content, marker, obsidian) {
  const value = marker.vaultId ? marker.vaultId + '/' + marker.id : marker.id;
  if (!PROJECT_VALUE.test(value)) throw new Error('无法写入无效的飞书项目标识。');
  const current = projectMarker(content, obsidian);
  if (current && (current.id !== marker.id || (current.vaultId && current.vaultId !== marker.vaultId))) {
    throw new Error('飞书项目标识发生变化，已保留原文。');
  }
  for (const old of legacyProjectMarkers(content).reverse()) content = content.slice(0, old.start) + content.slice(old.end);
  const info = projectFrontmatter(content, obsidian);
  const newline = content.match(/\r\n|\n|\r/)?.[0] || '\n';
  const field = PROJECT_PROPERTY + ': ' + value;
  if (!info.exists) {
    if (/^\uFEFF?---[ \t]*(?:\r\n|\n|\r|$)/.test(content)) throw new Error('项目 frontmatter 未闭合，已停止写入。');
    const bom = content.startsWith('\uFEFF') ? 1 : 0;
    return content.slice(0, bom) + '---' + newline + field + newline + '---' + newline + content.slice(bom);
  }
  const fm = obsidian.parseYaml(info.frontmatter.replace(/\r\n|\r/g, '\n')) || {};
  if (fm[PROJECT_PROPERTY] === value) return content;
  const header = content.slice(0, info.contentStart);
  const opening = header.match(/^\uFEFF?---[ \t]*(?:\r\n|\n|\r)/);
  const closing = [...header.matchAll(/^(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/gm)].at(-1);
  if (!opening || !closing || closing.index < opening[0].length) throw new Error('项目 frontmatter 格式异常，已停止写入。');
  const start = opening[0].length;
  const yaml = content.slice(start, closing.index);
  if (!Object.prototype.hasOwnProperty.call(fm, PROJECT_PROPERTY)) return content.slice(0, closing.index) + field + newline + content.slice(closing.index);
  const fields = [...yaml.matchAll(/^(?:feishu-project|"feishu-project"|'feishu-project')[ \t]*:[^\r\n]*/gm)];
  if (fields.length > 1) throw new Error('项目包含重复的 feishu-project 属性，已停止写入。');
  if (!fields.length) return content.slice(0, closing.index) + field + newline + content.slice(closing.index);
  const existing = fields[0];
  const tail = yaml.slice(existing.index + existing[0].length).replace(/^(?:\r\n|\n|\r)/, '');
  if (/:[ \t]*[>|]/.test(existing[0]) || /^[ \t]+\S/.test(tail)) throw new Error('feishu-project 使用多行 YAML，请改为单行后重试。');
  const offset = start + existing.index;
  return content.slice(0, offset) + field + content.slice(offset + existing[0].length);
}

function allowedPath(path, config = {}) { return scope.candidate(path, config); }

function summary(task) {
  const text = task.text.replace(/[ \t]+\^[a-zA-Z0-9-]+[ \t]*$/, '')
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, alias) => alias || target.split('/').pop())
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim();
  if (!text || [...text].length > 3000) throw new Error('任务标题需为 1–3000 个字符。');
  return text;
}

function tasks(content, path) {
  const next = new Set(helpers.parseTasks(content, path, { heading: '下一步行动' }).map(t => t.line));
  return helpers.parseTasks(content, path).map(t => ({ ...t, id: idFor(t.raw), vaultId: taskMarker(t.raw)?.vaultId || null, inNextActions: next.has(t.line) }));
}

function replaceLine(content, line, raw) {
  let index = 0;
  return content.replace(/[^\r\n]*(?:\r\n|\n|\r|$)/g, value => {
    if (index++ !== line) return value;
    const ending = value.match(/(?:\r\n|\n|\r)$/)?.[0] || '';
    return raw + ending;
  });
}

async function identifyTask(app, snapshot, options = {}) {
  if (!snapshot || !allowedPath(snapshot.path, options) || !Number.isInteger(snapshot.line)) throw new Error('请选择日记或项目中的明确行动。');
  return helpers.withFileQueue(app, snapshot.path, async () => {
    const file = app.vault.getAbstractFileByPath(snapshot.path);
    if (!file || file.extension !== 'md') throw new Error('行动所在笔记不存在。');
    let result;
    await app.vault.process(file, content => {
      const all = tasks(content, file.path);
      const target = all.find(t => t.line === snapshot.line && t.raw === snapshot.raw);
      if (!target || target.fingerprint !== snapshot.fingerprint) throw new Error('行动已变化，请刷新列表后再发送。');
      if (!/^[ xX]$/.test(target.status)) throw new Error('只支持普通待办的完成与重新打开。');
      summary(target);
      if (target.vaultId && options.vaultId && target.vaultId !== options.vaultId) throw new Error('该行动来自其他仓库，已停止认领。');
      if (target.id) {
        if (options.vaultId && !target.vaultId && options.allowLegacy) {
          const updated = replaceLine(content, target.line, target.raw.replace('<!-- feishu-task: ' + target.id + ' -->', '<!-- feishu-task: ' + options.vaultId + '/' + target.id + ' -->'));
          result = tasks(updated, file.path).find(t => t.id === target.id);
          return updated;
        }
        result = target; return content;
      }
      const id = crypto.randomUUID();
      const markerId = options.vaultId ? options.vaultId + '/' + id : id;
      const block = target.raw.match(/([ \t]+\^[a-zA-Z0-9-]+[ \t]*)$/);
      const raw = block
        ? target.raw.slice(0, -block[1].length).trimEnd() + ' <!-- feishu-task: ' + markerId + ' -->' + block[1]
        : target.raw.trimEnd() + ' <!-- feishu-task: ' + markerId + ' -->';
      const updated = replaceLine(content, target.line, raw);
      result = tasks(updated, file.path).find(t => t.id === id);
      if (!result) throw new Error('无法安全添加行动标识。');
      return updated;
    });
    return result;
  });
}

async function writeDone(app, snapshot, done) {
  return writeStatus(app, snapshot, done ? 'x' : ' ');
}

async function writeStatus(app, snapshot, status) {
  if (![' ', 'x', '-'].includes(status)) throw new Error('不支持的行动状态。');
  return helpers.withFileQueue(app, snapshot.path, async () => {
    const file = app.vault.getAbstractFileByPath(snapshot.path);
    if (!file || file.extension !== 'md') throw new Error('行动所在笔记已移动，请重新同步。');
    await app.vault.process(file, content => {
      const matches = tasks(content, file.path).filter(t => t.id === snapshot.id);
      if (matches.length !== 1 || matches[0].raw !== snapshot.raw) throw new Error('同步期间行动发生变化，已保留本地编辑，请重试。');
      if (matches[0].status === status || (status === 'x' && matches[0].status === 'X')) return content;
      const raw = matches[0].raw.replace(/^(\s*(?:[-*+]|\d+[.)])[ \t]+\[)[^\]]/, '$1' + status);
      return replaceLine(content, matches[0].line, raw);
    });
  });
}

module.exports = { helpers, idFor, candidateTaskIds, taskMarker, projectId, projectMarker, writeProjectMarker, allowedPath, summary, tasks, identifyTask, writeDone, writeStatus };
