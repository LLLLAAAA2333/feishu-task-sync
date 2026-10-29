'use strict';

const inside = (notePath, folder) => !!folder && notePath.startsWith(folder + '/');
const validPath = value => typeof value === 'string' && !!value && !/^[A-Za-z]:/.test(value)
  && !/[\\\r\n]/.test(value) && !value.startsWith('/')
  && !value.split('/').some(part => !part || part.startsWith('.'));
const inlineSources = new WeakMap();
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const taskMarker = new RegExp('[ \\t]+<!-- feishu-task: (?:' + UUID + '/)?' + UUID + ' -->', 'g');
const withoutTaskMarkers = content => content.replace(taskMarker, '').replace(/[ \t]+(?=\r?$)/gm, '');

function list(value, transform) {
  if (value == null || value === '') return [];
  const values = typeof value === 'string' ? value.split(/[,，\n]/) : value;
  if (!Array.isArray(values) || values.some(item => typeof item !== 'string')) throw new Error('同步范围请填写标签或文件夹列表。');
  return [...new Set(values.map(item => item.trim()).filter(Boolean).map(transform))];
}

function normalize(value = {}) {
  const folders = input => list(input, item => {
    const folder = item.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!validPath(folder)) throw new Error('文件夹请填写仓库内的相对路径，例如 Work/Meetings。');
    return folder;
  });
  return {
    taskFolders: folders(value.taskFolders),
    taskTags: list(value.taskTags, item => {
      const tag = item.replace(/^#/, '');
      if (!/^[\p{L}\p{M}\p{N}_/-]+$/u.test(tag) || !/[\p{L}\p{M}_/-]/u.test(tag)
        || tag.split('/').some(part => !part)) throw new Error('标签请填写名称，例如 action 或 work/meeting。');
      return tag;
    }),
    excludedFolders: folders(value.excludedFolders),
  };
}

function candidate(notePath, config = {}) {
  if (!validPath(notePath) || !notePath.endsWith('.md')) return false;
  if ((config.excludedFolders || []).some(folder => inside(notePath, folder))) return false;
  return inside(notePath, config.projectFolder || '50_Tasks')
    || inside(notePath, config.dailyFolder || '20_Review/Daily')
    || (config.taskFolders || []).some(folder => inside(notePath, folder))
    || !!config.taskTags?.length;
}

function classify(notePath, content, config, obsidian, cache) {
  if (!candidate(notePath, config)) return null;
  const info = obsidian.getFrontMatterInfo(content);
  const fm = info.exists ? obsidian.parseYaml(info.frontmatter) || {} : {};
  const propertyTags = (Array.isArray(fm.tags) ? fm.tags : [fm.tags]).filter(tag => typeof tag === 'string');
  const tags = propertyTags
    .flatMap(tag => tag.split(/[,\s]+/)).filter(Boolean).map(tag => tag.replace(/^#/, ''));
  if (inside(notePath, config.projectFolder || '50_Tasks') && propertyTags.some(tag => tag === 'project' || tag === '#project')) return 'project';
  if (inside(notePath, config.dailyFolder || '20_Review/Daily')) return 'daily';
  if ((config.taskFolders || []).some(folder => inside(notePath, folder))) return 'task';
  // Keep the source for each native tag index. Adding our invisible task IDs
  // shifts offsets without changing tags; any other edit waits for a new index.
  const entries = cache?.tags || [];
  let source = content;
  if (entries.length) {
    const previous = inlineSources.get(entries);
    if (previous === undefined) inlineSources.set(entries, content);
    else source = withoutTaskMarkers(previous) === withoutTaskMarkers(content) ? previous : '';
  }
  for (const entry of entries) {
    const start = entry.position?.start?.offset, end = entry.position?.end?.offset;
    if (Number.isInteger(start) && Number.isInteger(end) && source.slice(start, end) === entry.tag) tags.push(entry.tag.replace(/^#/, ''));
  }
  return (config.taskTags || []).some(wanted => tags.some(tag => tag === wanted || tag.startsWith(wanted + '/'))) ? 'task' : null;
}

function label(config) {
  return [config.projectFolder || '50_Tasks', ...(config.taskFolders || []),
    ...(config.taskTags || []).map(tag => '#' + tag), ...(config.syncDaily ? [config.dailyFolder] : [])].join(' + ');
}

module.exports = { normalize, candidate, classify, label, inside, validPath };
