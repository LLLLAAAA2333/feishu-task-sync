'use strict';

const syncScope = require('./feishu-scope.cjs');

// Pure scheduling: service owns all note mutations, identity and network calls.
// Obsidian emits identical events for our writes and a person's edits. One
// bounded follow-up preserves edits during a run without an endless echo loop;
// changes during that follow-up are reconciled on the next normal poll.
const DEBOUNCE_MS = 3000;
const BUSY_RETRY_MS = 3000;
const MAX_BACKOFF_MS = 30 * 60 * 1000;

function normalizedConfig(value = {}) {
  const minutes = Number(value.pollMinutes);
  return {
    autoEnabled: value.autoEnabled === true,
    pollMinutes: Number.isFinite(minutes) ? Math.max(1, Math.min(60, minutes)) : 2,
    vaultLabel: String(value.vaultLabel || ''),
    projectFolder: String(value.projectFolder || '50_Tasks').replace(/\/+$/, ''),
    dailyFolder: String(value.dailyFolder || '20_Review/Daily').replace(/\/+$/, ''),
    syncDaily: value.syncDaily === true,
    ...syncScope.normalize(value),
    appId: String(value.appId || ''),
    hasSecret: value.hasSecret === true,
    assigneeId: String(value.assigneeId || ''),
    defaultTasklistGuid: String(value.defaultTasklistGuid || ''),
    configRevision: String(value.configRevision || ''),
  };
}

function configured(config) {
  return !!(config && config.appId && config.hasSecret && config.assigneeId);
}

function markdownIn(filePath, root) {
  return typeof filePath === 'string' && filePath.endsWith('.md') && filePath.startsWith(root + '/')
    && !filePath.includes('\\') && !filePath.split('/').some(part => !part || part === '.' || part === '..');
}

function errorMessage(error, fallback = '飞书同步失败，请检查配置和任务状态。') {
  return error && typeof error.message === 'string' && error.message.trim()
    ? error.message.replace(/\s+/g, ' ').slice(0, 240) : fallback;
}

class FeishuScheduler {
  constructor({ service, onStatus = () => {}, clock = {} }) {
    this.service = service;
    this.onStatus = onStatus;
    this.now = clock.now || (() => Date.now());
    this.setTimer = clock.setTimeout || ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = clock.clearTimeout || (timer => clearTimeout(timer));
    this.started = false;
    this.active = false;
    this.running = false;
    this.timer = null;
    this.timerKind = null;
    this.config = null;
    this.configSignature = '';
    this.configPending = false;
    this.duringRunChanges = false;
    this.failureCount = 0;
    this.cooldownUntil = 0;
    this.pollDueAt = Infinity;
    this.manualRequest = null;
    this.manualInFlight = null;
    this.status = { running: false, lastRunAt: null, lastError: '', summary: null, failures: [] };
  }

  getStatus() {
    return { ...this.status, summary: this.status.summary ? { ...this.status.summary } : null,
      failures: (this.status.failures || []).map(item => ({ ...item })) };
  }

  publish() {
    if (!this.active) return;
    try { this.onStatus(this.getStatus()); } catch (_) { /* A view cannot break scheduling. */ }
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.active = true;
    this.configChanged();
    this.publish();
  }

  automaticAllowed() {
    return this.active && this.config && this.config.autoEnabled && configured(this.config);
  }

  clearWake() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.timerKind = null;
  }

  arm(delay, kind, followups = 1) {
    if (!this.active || (kind !== 'manual' && !this.automaticAllowed())) return;
    if (kind !== 'manual' && this.manualRequest) return;
    if (kind !== 'manual') delay = Math.max(delay, this.cooldownUntil - this.now());
    this.clearWake();
    this.timerKind = kind;
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.timerKind = null;
      // wake handles all failures; never leave an unhandled timer rejection.
      this.wake(kind, followups).catch(() => {});
    }, Math.max(0, delay));
  }

  configChanged() {
    if (!this.active) return;
    let next;
    try { next = normalizedConfig(this.service.getConfig()); }
    catch (error) {
      this.clearWake();
      this.config = null;
      this.configSignature = '';
      this.status.lastError = errorMessage(error, '无法读取飞书本机配置。');
      this.status.failures = [];
      this.status.summary = null;
      if (this.manualRequest) {
        const request = this.manualRequest;
        this.manualRequest = null;
        request.reject(error);
      }
      this.publish();
      return;
    }
    const signature = JSON.stringify(next);
    if (signature === this.configSignature) return;
    this.config = next;
    this.configSignature = signature;
    this.failureCount = 0;
    this.cooldownUntil = 0;
    this.status.lastError = '';
    this.status.failures = [];
    this.status.summary = null;
    this.clearWake();
    if (this.running) this.configPending = true;
    else if (this.manualRequest) this.arm(0, 'manual');
    else if (this.automaticAllowed()) this.arm(0, 'config');
    this.publish();
  }

  vaultChanged(filePath, oldPath) {
    if (!this.automaticAllowed()) return;
    const inScope = value => syncScope.candidate(value, this.config)
      && (this.config.syncDaily || !markdownIn(value, this.config.dailyFolder));
    if (!inScope(filePath) && !inScope(oldPath)) return;
    if (this.running) {
      this.duringRunChanges = true;
      return;
    }
    // Repeated typing must not postpone remote polling indefinitely.
    this.arm(Math.min(DEBOUNCE_MS, Math.max(0, this.pollDueAt - this.now())), 'edit');
  }

  manual() {
    if (!this.active) return Promise.reject(new Error('飞书同步未就绪或已停用，请重新打开插件。'));
    if (this.manualInFlight) return this.manualInFlight.promise;
    if (this.manualRequest) return this.manualRequest.promise;
    // Re-read settings so manual recovery never depends on a previous event.
    this.configChanged();
    if (!configured(this.config)) return Promise.reject(new Error('请先在飞书面板保存 App ID、App Secret 和接收用户 Open ID。'));
    this.failureCount = 0;
    this.cooldownUntil = 0;
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    this.manualRequest = { promise, resolve, reject };
    this.clearWake();
    if (!this.running) this.arm(0, 'manual');
    return promise;
  }

  async wake(kind, followups) {
    if (!this.active || this.running) return;
    const manual = kind === 'manual';
    if (manual && !this.manualRequest) return;
    if (!manual && !this.automaticAllowed()) return;
    try {
      if (this.service.isBusy()) { this.arm(BUSY_RETRY_MS, kind, followups); return; }
    } catch (error) {
      this.status.lastError = errorMessage(error);
      this.status.failures = [];
      this.status.summary = null;
      this.publish();
      if (manual) {
        const request = this.manualRequest;
        this.manualRequest = null;
        request.reject(error);
      }
      if (this.automaticAllowed()) this.arm(this.config.pollMinutes * 60000, 'poll');
      return;
    }
    const request = manual ? this.manualRequest : null;
    if (manual) {
      this.manualRequest = null;
      this.manualInFlight = request;
    }
    this.running = true;
    this.status.running = true;
    this.duringRunChanges = false;
    this.configPending = false;
    this.clearWake();
    this.publish();
    let failed = false;
    const runSignature = this.configSignature;
    const runAppId = this.config?.appId;
    try {
      if (!configured(this.config)) throw new Error('飞书配置不完整，请重新保存账号配置。');
      const result = await this.service.syncVault({ automatic: !manual, shouldStop: () => !this.active });
      const summary = {
        synced: Number(result && result.synced || 0),
        failed: Number(result && result.failed || 0),
        skipped: Number(result && result.skipped || 0),
      };
      failed = summary.failed > 0;
      const firstFailure = result && Array.isArray(result.results) && result.results.find(item => item && item.ok === false);
      if (this.configSignature === runSignature) {
        this.status.summary = summary;
        this.status.failures = failed && Array.isArray(result?.results) ? result.results.filter(item => item?.ok === false).map(item => ({
          ...(typeof item.id === 'string' && item.id ? { id: item.id } : {}),
          ...(typeof item.path === 'string' ? { path: item.path } : {}),
          ...(item.kind === 'task' || item.kind === 'project' ? { kind: item.kind } : {}),
          ...(Number.isInteger(item.line) ? { line: item.line } : {}),
          ...(Number.isInteger(item.revision) ? { revision: item.revision } : {}),
          appId: runAppId, message: errorMessage(item),
        })) : [];
        this.status.lastError = failed ? errorMessage(firstFailure, summary.failed + ' 条行动同步失败，请查看飞书面板。') : '';
      }
      if (request) request.resolve(result);
    } catch (error) {
      failed = true;
      if (this.configSignature === runSignature) {
        this.status.lastError = errorMessage(error);
        this.status.summary = null;
        this.status.failures = [];
      }
      if (request) request.reject(error);
    } finally {
      this.running = false;
      this.manualInFlight = null;
      this.status.running = false;
      this.status.lastRunAt = this.now();
      if (!this.active) return;
      if (failed && !this.configPending) {
        this.failureCount += 1;
        const interval = this.config ? this.config.pollMinutes * 60000 : 120000;
        this.cooldownUntil = this.now() + Math.min(MAX_BACKOFF_MS, Math.max(interval, 30000) * (2 ** Math.min(this.failureCount - 1, 10)));
      } else {
        this.failureCount = 0;
        this.cooldownUntil = 0;
      }
      this.publish();
      if (this.manualRequest) {
        this.failureCount = 0;
        this.cooldownUntil = 0;
        this.arm(0, 'manual');
      } else if (this.automaticAllowed()) {
        this.pollDueAt = this.now() + this.config.pollMinutes * 60000;
        if (this.configPending) this.arm(0, 'config');
        else if (!failed && this.duringRunChanges && followups > 0) this.arm(DEBOUNCE_MS, 'recheck', followups - 1);
        else this.arm(this.config.pollMinutes * 60000, 'poll');
      }
    }
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.clearWake();
    if (this.manualRequest) {
      const request = this.manualRequest;
      this.manualRequest = null;
      request.reject(new Error('飞书同步插件已停用，尚未开始的操作已取消。'));
    }
    // An existing service transaction owns its commit/rollback; never start
    // more work or emit stale status when it finishes after plugin unload.
  }
}

module.exports = { FeishuScheduler, normalizedConfig, markdownIn, DEBOUNCE_MS, BUSY_RETRY_MS };
