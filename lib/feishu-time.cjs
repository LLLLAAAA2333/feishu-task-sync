'use strict';

const path = require('node:path');
const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;

function parseStart(value, label = 'createTime') {
  if (value == null || value === '') return undefined;
  const match = typeof value === 'string' && value.trim().match(
    /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!match) throw new Error(label + ' 须为有效日期或时间，例如 2026-10-04 21:18。');
  const [year, month, day] = match[1].split('-').map(Number);
  const midnight = Date.UTC(year, month - 1, day);
  if (new Date(midnight).toISOString().slice(0, 10) !== match[1]) throw new Error(label + ' 日期无效。');
  const allDay = !match[2];
  const timestamp = allDay ? midnight : Date.parse(match[1] + 'T' + match[2] + ':' + (match[3] || '00') + (match[4] || '+08:00'));
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || (!allDay && (Number(match[2].slice(0, 2)) > 23
    || Number(match[2].slice(3)) > 59 || Number(match[3] || 0) > 59))) throw new Error(label + ' 时间无效。');
  return { timestamp: String(timestamp), is_all_day: allDay };
}

function noteStart(content, notePath, obsidian, { projectFolder = '50_Tasks', dailyFolder = '20_Review/Daily' } = {}) {
  if (notePath.startsWith(projectFolder + '/')) {
    const info = obsidian.getFrontMatterInfo(content);
    const fm = info.exists ? obsidian.parseYaml(info.frontmatter) || {} : {};
    return parseStart(fm.createTime);
  }
  if (notePath.startsWith(dailyFolder + '/')) {
    const date = path.posix.basename(notePath, '.md');
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? parseStart(date, '日记日期') : undefined;
  }
  return undefined;
}

function hasStart(start) {
  return !!start && typeof start.timestamp === 'string' && /^\d+$/.test(start.timestamp) && BigInt(start.timestamp) > 0n;
}

// Feishu requires start and due to use the same date/time mode. Date-only
// values use UTC midnight; timed values without an offset use Shanghai time.
function withDue(start, due) {
  if (!start || !hasStart(due)) return start;
  let adjusted = start;
  if (start.is_all_day !== due.is_all_day) {
    const date = new Date(Number(start.timestamp) + (start.is_all_day ? 0 : SHANGHAI_OFFSET)).toISOString().slice(0, 10);
    adjusted = due.is_all_day ? parseStart(date) : parseStart(date + 'T00:00');
  }
  if (BigInt(adjusted.timestamp) > BigInt(due.timestamp)) throw new Error('开始时间不能晚于截止时间，请检查项目 createTime、日记日期或飞书截止时间。');
  return adjusted;
}

module.exports = { parseStart, noteStart, hasStart, withDue };
