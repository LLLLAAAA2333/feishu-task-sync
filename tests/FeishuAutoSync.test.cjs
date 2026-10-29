'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { FeishuScheduler, normalizedConfig, markdownIn } = require('../lib/feishu-scheduler.cjs');
const project = '50_Tasks/项目.md';
const daily = '20_Review/Daily/2026-10-04.md';
const success = () => ({ synced: 1, failed: 0, skipped: 0, results: [] });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('extra scope edits schedule a debounced run while excluded folders and disabled daily notes stay idle', async () => {
  const s = harness({ taskFolders: ['Meetings'], excludedFolders: ['Meetings/Archive'] });
  s.engine.start(); await s.clock.advance(0);
  const initial = s.calls.length;
  s.engine.vaultChanged('Meetings/Archive/a.md'); s.engine.vaultChanged('Notes/a.md');
  await s.clock.advance(3000); assert.equal(s.calls.length, initial);
  s.engine.vaultChanged('Meetings/a.md'); await s.clock.advance(3000);
  assert.equal(s.calls.length, initial + 1);
  s.config.taskTags = ['action']; s.engine.configChanged(); await s.clock.advance(0);
  const afterConfig = s.calls.length;
  s.engine.vaultChanged('Notes/a.md'); await s.clock.advance(3000);
  assert.equal(s.calls.length, afterConfig + 1);
  s.engine.vaultChanged(daily); await s.clock.advance(3000);
  assert.equal(s.calls.length, afterConfig + 1);
  s.engine.stop();
});

class Clock {
  constructor() { this.time = 1000; this.next = 0; this.timers = new Map(); }
  now = () => this.time;
  setTimeout = (callback, delay) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  };
  clearTimeout = id => this.timers.delete(id);
  async advance(ms = 0) {
    const end = this.time + ms;
    let count = 0;
    while (true) {
      const next = [...this.timers.entries()].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      if (++count > 100) throw new Error('unbounded scheduler timer loop');
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await flush();
    }
    this.time = end;
    await flush();
  }
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(config = {}) {
  const state = {
    config: { autoEnabled: true, appId: 'cli_fixture', hasSecret: true, assigneeId: 'ou_fixture', pollMinutes: 2, ...config },
    externalBusy: false, calls: [], statuses: [], onSync: async () => success(), clock: new Clock(),
  };
  state.service = {
    getConfig: () => ({ ...state.config }),
    isBusy: () => state.externalBusy,
    syncVault: async options => { state.calls.push({ at: state.clock.now(), ...options }); return state.onSync(options); },
  };
  state.engine = new FeishuScheduler({ service: state.service, clock: state.clock, onStatus: value => state.statuses.push(value) });
  return state;
}

test('normalizes safe defaults and filters only Markdown beneath configured roots', () => {
  assert.equal(normalizedConfig().pollMinutes, 2);
  assert.equal(normalizedConfig({ pollMinutes: NaN }).pollMinutes, 2);
  assert.equal(normalizedConfig({ pollMinutes: 0 }).pollMinutes, 1);
  assert.equal(normalizedConfig({ pollMinutes: 100 }).pollMinutes, 60);
  assert.equal(markdownIn(project, '50_Tasks'), true);
  for (const invalid of ['50_Tasks2/a.md', '50_Tasks/../a.md', '/50_Tasks/a.md', '50_Tasks/a.png', '50_Tasks/a\\b.md']) {
    assert.equal(markdownIn(invalid, '50_Tasks'), false);
  }
});

test('startup is opt-in, requires complete config, and duplicate start is idempotent', async () => {
  const state = harness({ autoEnabled: false });
  state.engine.start(); state.engine.start();
  await state.clock.advance(300000);
  assert.equal(state.calls.length, 0);
  state.config.autoEnabled = true; state.config.hasSecret = false;
  state.engine.configChanged(); await state.clock.advance(0);
  assert.equal(state.calls.length, 0);
  state.config.hasSecret = true;
  state.engine.configChanged(); await state.clock.advance(0);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].automatic, true);
  state.engine.start(); await state.clock.advance(0);
  assert.equal(state.calls.length, 1);
  state.engine.stop();
});

test('rapid project edits debounce for 3 seconds and unrelated events do not schedule work', async () => {
  const state = harness(); state.engine.start(); await state.clock.advance(0);
  state.engine.vaultChanged(project);
  await state.clock.advance(1000); state.engine.vaultChanged(project);
  await state.clock.advance(1000); state.engine.vaultChanged(project);
  await state.clock.advance(2999); assert.equal(state.calls.length, 1);
  await state.clock.advance(1); assert.equal(state.calls.length, 2);
  for (const file of [daily, '10_Inbox/a.md', '99_Meta/a.md', '50_Tasks/image.png']) state.engine.vaultChanged(file);
  await state.clock.advance(5000); assert.equal(state.calls.length, 2);
  state.engine.vaultChanged('60_Archive/moved.md', project);
  await state.clock.advance(3000); assert.equal(state.calls.length, 3);
  state.engine.stop();
});

test('daily events are included only when syncDaily is configured', async () => {
  const state = harness({ syncDaily: true }); state.engine.start(); await state.clock.advance(0);
  state.engine.vaultChanged(daily); await state.clock.advance(3000);
  assert.equal(state.calls.length, 2);
  state.engine.stop();
});

test('remote polling runs at configured interval; record change events do not restart it', async () => {
  const state = harness({ pollMinutes: 1 }); state.engine.start(); await state.clock.advance(0);
  await state.clock.advance(30000);
  for (let i = 0; i < 20; i++) state.engine.configChanged();
  await state.clock.advance(29999); assert.equal(state.calls.length, 1);
  await state.clock.advance(1); assert.equal(state.calls.length, 2);
  state.engine.stop();
});

test('external service operation is respected and automatic calls never overlap', async () => {
  const state = harness(); state.externalBusy = true;
  state.engine.start(); await state.clock.advance(0); assert.equal(state.calls.length, 0);
  await state.clock.advance(2999); assert.equal(state.calls.length, 0);
  state.externalBusy = false;
  const gate = deferred(); state.onSync = () => gate.promise;
  await state.clock.advance(1); assert.equal(state.calls.length, 1);
  assert.equal(state.engine.getStatus().running, true);
  state.engine.vaultChanged(project); state.engine.configChanged();
  await state.clock.advance(300000); assert.equal(state.calls.length, 1);
  gate.resolve(success()); await flush(); state.engine.stop();
});

test('manual request queues behind automatic run and repeated manual clicks coalesce', async () => {
  const state = harness(); const gate = deferred();
  state.onSync = () => state.calls.length === 1 ? gate.promise : Promise.resolve(success());
  state.engine.start(); await state.clock.advance(0);
  const first = state.engine.manual(), second = state.engine.manual();
  assert.equal(first, second);
  await state.clock.advance(10000); assert.equal(state.calls.length, 1);
  gate.resolve(success()); await flush(); await state.clock.advance(0);
  await first;
  assert.equal(state.calls.length, 2);
  assert.deepEqual(state.calls.map(call => call.automatic), [true, false]);
  state.engine.stop();
});

test('manual command works while automatic synchronization is disabled', async () => {
  const state = harness({ autoEnabled: false }); state.engine.start();
  const pending = state.engine.manual(); await state.clock.advance(0); const result = await pending;
  assert.equal(result.synced, 1);
  assert.equal(state.calls.length, 1);
  assert.equal(state.calls[0].automatic, false);
  assert.equal(state.clock.timers.size, 0);
  state.engine.stop();
});

test('write echoes cause at most one follow-up and user edits during it survive to next poll', async () => {
  const state = harness();
  state.onSync = async () => { state.engine.vaultChanged(project); return success(); };
  state.engine.start(); await state.clock.advance(0); assert.equal(state.calls.length, 1);
  await state.clock.advance(3000); assert.equal(state.calls.length, 2);
  await state.clock.advance(10000); assert.equal(state.calls.length, 2);
  await state.clock.advance(110000); assert.equal(state.calls.length, 3);
  state.engine.stop();
});

test('a user edit while the initial run is pending receives the bounded follow-up', async () => {
  const state = harness(); const gate = deferred();
  state.onSync = () => state.calls.length === 1 ? gate.promise : Promise.resolve(success());
  state.engine.start(); await state.clock.advance(0);
  state.engine.vaultChanged(project); gate.resolve(success()); await flush();
  await state.clock.advance(2999); assert.equal(state.calls.length, 1);
  await state.clock.advance(1); assert.equal(state.calls.length, 2);
  state.engine.stop();
});

test('automatic failures back off despite local edits; manual retry resets delay', async () => {
  const state = harness({ pollMinutes: 1 });
  state.onSync = async () => { throw new Error('缺少任务权限'); };
  state.engine.start(); await state.clock.advance(0);
  assert.equal(state.engine.getStatus().lastError, '缺少任务权限');
  state.engine.vaultChanged(project); await state.clock.advance(59999); assert.equal(state.calls.length, 1);
  await state.clock.advance(1); assert.equal(state.calls.length, 2);
  state.engine.vaultChanged(project); await state.clock.advance(119999); assert.equal(state.calls.length, 2);
  await state.clock.advance(1); assert.equal(state.calls.length, 3);
  state.onSync = async () => success();
  const pending = state.engine.manual(); await state.clock.advance(0); await pending;
  assert.equal(state.calls.length, 4);
  assert.equal(state.engine.getStatus().lastError, '');
  await state.clock.advance(60000); assert.equal(state.calls.length, 5);
  state.engine.stop();
});

test('partial failures publish compact error status and cause backoff', async () => {
  const state = harness({ pollMinutes: 1 });
  state.onSync = async () => ({ synced: 2, failed: 1, skipped: 4, results: [{ id: 'missing', ok: false, message: '找不到本地行动' }] });
  state.engine.start(); await state.clock.advance(0);
  assert.deepEqual(state.engine.getStatus().summary, { synced: 2, failed: 1, skipped: 4 });
  assert.equal(state.engine.getStatus().lastError, '找不到本地行动');
  await state.clock.advance(60000);
  state.engine.vaultChanged(project); await state.clock.advance(60000);
  assert.equal(state.calls.length, 2);
  state.engine.stop();
});

test('failure details are copied, limited to public fields, and cleared by a successful round', async () => {
  const state = harness({ autoEnabled: false });
  const failure = { id: 'failed', path: project, kind: 'task', line: 7, revision: 3, ok: false, message: '缺少权限', payload: { secret: 'private' } };
  state.onSync = async () => ({ synced: 0, failed: 1, results: [failure] });
  state.engine.start();
  const first = state.engine.manual(); await state.clock.advance(0); await first;
  const status = state.engine.getStatus();
  assert.deepEqual(status.failures, [{ id: 'failed', path: project, kind: 'task', line: 7, revision: 3, appId: 'cli_fixture', message: '缺少权限' }]);
  failure.message = 'result was mutated';
  status.failures[0].message = 'consumer changed message';
  status.failures.push({ message: 'injected' });
  state.statuses.at(-1).failures[0].path = 'changed.md';
  assert.equal(state.engine.getStatus().failures.length, 1);
  assert.equal(state.engine.getStatus().failures[0].message, '缺少权限');
  assert.equal(state.engine.getStatus().failures[0].path, project);
  state.onSync = async () => success();
  const second = state.engine.manual(); await state.clock.advance(0); await second;
  assert.deepEqual(state.engine.getStatus().failures, []);
  assert.equal(state.engine.getStatus().lastError, '');
  state.engine.stop();
});

test('a whole-round error clears old item failures and keeps its own error', async () => {
  const state = harness({ autoEnabled: false });
  state.onSync = async () => ({ synced: 0, failed: 1, results: [{ id: 'failed', ok: false, message: '旧条目失败' }] });
  state.engine.start();
  const first = state.engine.manual(); await state.clock.advance(0); await first;
  state.onSync = async () => { throw new Error('读取关联记录失败'); };
  const second = state.engine.manual(); const rejected = assert.rejects(second, /读取关联记录失败/);
  await state.clock.advance(0); await rejected;
  assert.deepEqual(state.engine.getStatus().failures, []);
  assert.equal(state.engine.getStatus().summary, null);
  assert.equal(state.engine.getStatus().lastError, '读取关联记录失败');
  state.engine.stop();
});

test('account changes clear old failures and ignore a prior account round that finishes later', async () => {
  const state = harness({ autoEnabled: false });
  const failed = () => ({ synced: 0, failed: 1, results: [{ id: 'old', path: project, ok: false, message: '前账号失败' }] });
  state.onSync = async () => failed(); state.engine.start();
  const first = state.engine.manual(); await state.clock.advance(0); await first;
  assert.equal(state.engine.getStatus().failures.length, 1);
  const gate = deferred(); state.onSync = () => gate.promise;
  const pending = state.engine.manual(); await state.clock.advance(0);
  state.config.appId = 'cli_next'; state.engine.configChanged();
  assert.deepEqual(state.engine.getStatus().failures, []);
  assert.equal(state.engine.getStatus().summary, null);
  gate.resolve(failed()); await pending; await flush();
  assert.deepEqual(state.engine.getStatus().failures, []);
  assert.equal(state.engine.getStatus().lastError, '');
  assert.equal(state.engine.getStatus().summary, null);
  state.engine.stop();
});

test('old scheduler status without failures remains readable and config errors clear stale details', async () => {
  const state = harness({ autoEnabled: false });
  delete state.engine.status.failures;
  assert.deepEqual(state.engine.getStatus().failures, []);
  state.engine.start();
  state.engine.status.failures = [{ id: 'old', message: '旧错误' }];
  state.service.getConfig = () => { throw new Error('配置不可读'); };
  state.engine.configChanged();
  assert.deepEqual(state.engine.getStatus().failures, []);
  assert.equal(state.engine.getStatus().lastError, '配置不可读');
  state.engine.stop();
});

test('key config changes clear backoff while identical record events do not', async () => {
  const state = harness({ pollMinutes: 1 });
  state.onSync = async () => { throw new Error('权限失败'); };
  state.engine.start(); await state.clock.advance(0);
  state.engine.configChanged(); await state.clock.advance(0); assert.equal(state.calls.length, 1);
  state.config.configRevision = 'new-secret'; state.engine.configChanged();
  await state.clock.advance(0); assert.equal(state.calls.length, 2);
  state.config.autoEnabled = false; state.engine.configChanged();
  assert.equal(state.clock.timers.size, 0);
  await state.clock.advance(300000); assert.equal(state.calls.length, 2);
  state.engine.stop();
});

test('disabling during a run suppresses echoes and leaves no timer', async () => {
  const state = harness(); const gate = deferred(); state.onSync = () => gate.promise;
  state.engine.start(); await state.clock.advance(0);
  state.engine.vaultChanged(project);
  state.config.autoEnabled = false; state.engine.configChanged();
  gate.resolve(success()); await flush();
  assert.equal(state.clock.timers.size, 0);
  await state.clock.advance(300000); assert.equal(state.calls.length, 1);
  state.engine.stop();
});

test('unload clears pending timers and ignores late layout/start and config/vault events', async () => {
  const state = harness(); state.engine.start(); state.engine.stop();
  state.engine.start(); state.engine.configChanged(); state.engine.vaultChanged(project);
  await state.clock.advance(300000);
  assert.equal(state.calls.length, 0);
  assert.equal(state.clock.timers.size, 0);
  await assert.rejects(state.engine.manual(), /停用/);
});

test('unload during active transaction cannot schedule follow-up or publish stale status', async () => {
  const state = harness(); const gate = deferred(); state.onSync = () => gate.promise;
  state.engine.start(); await state.clock.advance(0); state.engine.vaultChanged(project);
  assert.equal(typeof state.calls[0].shouldStop, 'function');
  assert.equal(state.calls[0].shouldStop(), false);
  state.engine.stop();
  assert.equal(state.calls[0].shouldStop(), true);
  const published = state.statuses.length;
  gate.resolve(success()); await flush(); await state.clock.advance(300000);
  assert.equal(state.calls.length, 1);
  assert.equal(state.clock.timers.size, 0);
  assert.equal(state.statuses.length, published);
});

test('unload rejects queued manual work; an already active manual transaction can settle', async () => {
  const state = harness(); state.externalBusy = true; state.engine.start();
  const queued = state.engine.manual(); const rejected = assert.rejects(queued, /取消/);
  state.engine.stop(); await rejected;
  const next = harness({ autoEnabled: false }); const gate = deferred(); next.onSync = () => gate.promise;
  next.engine.start(); const active = next.engine.manual(); await next.clock.advance(0); next.engine.stop();
  gate.resolve(success()); assert.equal((await active).synced, 1);
  assert.equal(next.clock.timers.size, 0);
});


test('continuous typing cannot postpone scheduled remote polling indefinitely', async () => {
  const state = harness({ pollMinutes: 1 }); state.engine.start(); await state.clock.advance(0);
  for (let i = 0; i < 59; i++) {
    state.engine.vaultChanged(project);
    await state.clock.advance(1000);
  }
  assert.equal(state.calls.length, 1);
  state.engine.vaultChanged(project); await state.clock.advance(1000);
  assert.equal(state.calls.length, 2);
  state.engine.stop();
});

test('a config read failure settles queued manual work rather than leaving its promise pending', async () => {
  const state = harness({ autoEnabled: false }); state.engine.start();
  state.externalBusy = true;
  const pending = state.engine.manual();
  const rejected = assert.rejects(pending, /配置不可读/);
  await state.clock.advance(0);
  state.service.getConfig = () => { throw new Error('配置不可读'); };
  state.engine.configChanged(); await rejected;
  assert.equal(state.engine.getStatus().lastError, '配置不可读');
  assert.equal(state.clock.timers.size, 0);
  state.engine.stop();
});
