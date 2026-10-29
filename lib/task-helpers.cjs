'use strict';

// Shared queue key keeps optional vault dashboards serialized with plugin writes.
const sharedStateKey = Symbol.for('study.components.actionService.state.v1');

function dateParts(date) {
    const value = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(value.getTime())) throw new Error('日期无效。');
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(value);
    return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function formatTimestamp(date = new Date()) {
    const p = dateParts(date);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

function sharedState(app) {
    if (!app[sharedStateKey]) Object.defineProperty(app, sharedStateKey, {
        value: { queues: new Map(), checkboxReceipts: new WeakMap() }, enumerable: false,
    });
    return app[sharedStateKey];
}

function queued(app, path, operation) {
    const queues = sharedState(app).queues;
    const prior = queues.get(path) || Promise.resolve();
    const current = prior.catch(() => {}).then(operation);
    queues.set(path, current);
    const release = () => { if (queues.get(path) === current) queues.delete(path); };
    current.then(release, release);
    return current;
}

function splitLines(content) {
    const lines = [];
    const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
    let match;
    while ((match = pattern.exec(content))) {
        lines.push({ raw: match[1], newline: match[2], start: match.index });
        if (!match[2]) break;
    }
    return lines;
}

function withoutHtmlComments(raw, state) {
    let result = '';
    let index = 0;
    let codeTicks = 0;
    while (index < raw.length) {
        if (state.comment) {
            const end = raw.indexOf('-->', index);
            const next = end < 0 ? raw.length : end + 3;
            result += ' '.repeat(next - index);
            index = next;
            if (end >= 0) state.comment = false;
        } else if (!codeTicks && raw.startsWith('<!--', index)) {
            state.comment = true;
        } else if (raw[index] === '`') {
            const ticks = raw.slice(index).match(/^`+/)[0].length;
            if (!codeTicks) codeTicks = ticks;
            else if (ticks === codeTicks) codeTicks = 0;
            result += raw.slice(index, index + ticks);
            index += ticks;
        } else {
            result += raw[index++];
        }
    }
    return result;
}

function scanMarkdown(content) {
    const lines = splitLines(content);
    const headings = [];
    const tasks = [];
    let frontmatter = /^\uFEFF?---\s*$/.test(lines[0].raw);
    let fence = null;
    let heading = '';
    const html = { comment: false };
    lines.forEach((line, index) => {
        if (frontmatter) {
            if (index > 0 && /^(?:---|\.\.\.)\s*$/.test(line.raw)) frontmatter = false;
            return;
        }
        if (fence) {
            const close = line.raw.match(/^\s*(`+|~+)\s*$/);
            if (close && close[1][0] === fence.character && close[1].length >= fence.length) fence = null;
            return;
        }
        const visible = withoutHtmlComments(line.raw, html);
        const opening = visible.match(/^\s*(`{3,}|~{3,})/);
        if (opening) {
            fence = { character: opening[1][0], length: opening[1].length };
            return;
        }
        const title = visible.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/);
        if (title) {
            heading = (title[2] || '').replace(/[ \t]+#+[ \t]*$/, '').trim();
            headings.push({ line: index, level: title[1].length, text: heading });
            return;
        }
        const taskPattern = /^(\s*(?:[-*+]|\d+[.)])[ \t]+\[)([^\]])(\](?:[ \t]+|$))(.*)$/;
        const checkbox = visible.match(taskPattern);
        if (checkbox && taskPattern.test(line.raw)) tasks.push({
            path: '', line: index, raw: line.raw, text: checkbox[4].trimEnd(),
            status: checkbox[2], done: /^[xX]$/.test(checkbox[2]), heading,
        });
    });
    return { lines, headings, tasks };
}

function parseTasks(content, path, { heading } = {}) {
    const parsed = scanMarkdown(content);
    let selected = parsed.tasks;
    if (heading !== undefined) {
        const ranges = parsed.headings.filter(title => title.text === heading).map(title => ({
            start: title.line,
            end: (parsed.headings.find(next => next.line > title.line && next.level <= title.level) || {}).line
                ?? parsed.lines.length,
        }));
        selected = selected.filter(task => ranges.some(range => task.line > range.start && task.line < range.end));
    }
    const fingerprint = contentFingerprint(content);
    return selected.map(task => ({ ...task, path, fingerprint }));
}

function contentFingerprint(content) {
    let hash = 2166136261;
    for (let i = 0; i < content.length; i++) hash = Math.imul(hash ^ content.charCodeAt(i), 16777619);
    return `${content.length}:${hash >>> 0}`;
}


module.exports = { parseTasks, formatTimestamp, withFileQueue: queued };
