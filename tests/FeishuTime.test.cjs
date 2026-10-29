'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const time = require('../lib/feishu-time.cjs');

test('project creation times use Shanghai unless an explicit timezone is present', () => {
  const expected = { timestamp: String(Date.UTC(2026, 9, 4, 13, 18)), is_all_day: false };
  for (const value of ['2026-10-04 21:18', '2026-10-04T21:18:00', '2026-10-04T21:18:00+08:00', '2026-10-04T13:18:00Z']) {
    assert.deepEqual(time.parseStart(value), expected);
  }
  assert.deepEqual(time.parseStart('2026-10-04T21:18:53.123'), {
    timestamp: String(Date.UTC(2026, 9, 4, 13, 18, 53)), is_all_day: false,
  });
});

test('date-only starts use UTC midnight and reject invalid calendar dates and times', () => {
  assert.deepEqual(time.parseStart('2026-10-04'), { timestamp: String(Date.UTC(2026, 9, 4)), is_all_day: true });
  assert.deepEqual(time.parseStart('2024-02-29'), { timestamp: String(Date.UTC(2024, 1, 29)), is_all_day: true });
  for (const value of ['2026-02-29', '2026-02-30', '2026-13-04', '2026-10-04T24:00', '2026-10-04T21:60',
    '2026-10-04T21:18:60', '2026-10-04T21:18+99:00', 1791119880000, false, ['2026-10-04']]) {
    assert.throws(() => time.parseStart(value), /createTime/);
  }
  for (const value of [undefined, null, '']) assert.equal(time.parseStart(value), undefined);
});

test('note scope maps project createTime and daily filename dates without inventing a missing date', () => {
  const obsidian = { getFrontMatterInfo: () => ({ exists: true, frontmatter: '' }), parseYaml: () => ({ createTime: '2026-10-04 21:18' }) };
  const scope = { projectFolder: 'Projects', dailyFolder: 'Journal' };
  assert.deepEqual(time.noteStart('', 'Projects/example.md', obsidian, scope), time.parseStart('2026-10-04 21:18'));
  assert.deepEqual(time.noteStart('', 'Journal/2026-10-04.md', obsidian, scope), time.parseStart('2026-10-04'));
  assert.equal(time.noteStart('', 'Journal/example.md', obsidian, scope), undefined);
  assert.equal(time.noteStart('', '50_Tasks/example.md', obsidian, scope), undefined);
  obsidian.parseYaml = () => ({ created: '2026-10-04' });
  assert.equal(time.noteStart('', 'Projects/example.md', obsidian, scope), undefined);
});

test('start adopts the deadline date/time mode without shifting the Shanghai calendar day', () => {
  const late = time.parseStart('2026-10-04T23:30');
  assert.deepEqual(time.withDue(late, time.parseStart('2026-10-05')), time.parseStart('2026-10-04'));
  const date = time.parseStart('2026-10-04');
  assert.deepEqual(time.withDue(date, time.parseStart('2026-10-04T10:00')), time.parseStart('2026-10-04T00:00'));
  assert.deepEqual(time.withDue(late, time.parseStart('2026-10-05T10:00')), late);
  assert.deepEqual(time.withDue(late, { timestamp: '0', is_all_day: false }), late);
  assert.throws(() => time.withDue(late, time.parseStart('2026-10-04T22:00')), /开始时间不能晚于截止时间/);
});
