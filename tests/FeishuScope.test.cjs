'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const scope = require('../lib/feishu-scope.cjs');
const obsidian = { getFrontMatterInfo: () => ({ exists: false }) };

test('scope accepts normalized folder and tag lists and rejects malformed values', () => {
  assert.deepEqual(scope.normalize({ taskFolders: ' Work/Meetings/\nWork/Meetings', taskTags: '#action,行动/稍后', excludedFolders: 'Archive' }),
    { taskFolders: ['Work/Meetings'], taskTags: ['action', '行动/稍后'], excludedFolders: ['Archive'] });
  for (const taskFolders of [['../Notes'], ['/Notes'], ['.obsidian'], ['C:/Notes'], [null]]) assert.throws(() => scope.normalize({ taskFolders }));
  for (const taskTags of [['a b'], ['a//b'], ['123'], [false]]) assert.throws(() => scope.normalize({ taskTags }));
});

test('inline tags use Obsidian cache positions and do not reuse removed tags from stale metadata', () => {
  const config = { taskTags: ['action'] };
  const content = '#action/next\n- [ ] Read\n';
  const cache = { tags: [{ tag: '#action/next', position: { start: { offset: 0 }, end: { offset: 12 } } }] };
  assert.equal(scope.classify('Notes/a.md', content, config, obsidian, cache), 'task');
  assert.equal(scope.classify('Notes/a.md', content.replace('#action/next', '#other/tagxx'), config, obsidian, cache), null);
  assert.equal(scope.classify('Notes/a.md', '`#action`\n- [ ] Read', config, obsidian, { tags: [] }), null);
  assert.equal(scope.classify('Notes/a.md', content, { ...config, excludedFolders: ['Notes'] }, obsidian, cache), null);
});

test('default scope is unchanged and folder prefixes do not include sibling folders', () => {
  assert.equal(scope.candidate('Notes/a.md'), false);
  assert.equal(scope.candidate('50_Tasks/a.md'), true);
  assert.equal(scope.candidate('Work2/a.md', { taskFolders: ['Work'] }), false);
  for (const p of ['.obsidian/a.md', 'Notes/../a.md', '/Notes/a.md', 'Notes/a.png']) assert.equal(scope.candidate(p, { taskTags: ['action'] }), false);
});

test('task marker writes retain inline scope while unrelated edits wait for fresh native metadata', () => {
  const content = '- [ ] Read\n#action\n';
  const start = content.indexOf('#');
  const cache = { tags: [{ tag: '#action', position: { start: { offset: start }, end: { offset: start + 7 } } }] };
  const config = { taskTags: ['action'] };
  assert.equal(scope.classify('Notes/a.md', content, config, obsidian, cache), 'task');
  const marked = content.replace('Read', 'Read <!-- feishu-task: 489548bb-5955-41de-83cf-0e246a2e1c92/bc29a18f-c173-4ec4-9ca1-252e23b216c1 -->');
  assert.equal(scope.classify('Notes/a.md', marked, config, obsidian, cache), 'task');
  assert.equal(scope.classify('Notes/a.md', '```\n' + content + '```\n', config, obsidian, cache), null);
});
