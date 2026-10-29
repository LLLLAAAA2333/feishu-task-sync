'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

function pluginHarness(t, { config, records, savedUi, loadData, deferViews = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-plugin-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const base = path.join(directory, 'clean-vault');
  fs.mkdirSync(base);
  const hash = crypto.createHash('sha256').update(base).digest('hex').slice(0, 24);
  const storage = path.join(directory, '.config/obsidian-feishu-sync', hash);
  fs.mkdirSync(storage, { recursive: true });
  if (config) fs.writeFileSync(path.join(storage, 'config.json'), JSON.stringify(config));
  if (records) fs.writeFileSync(path.join(storage, 'records.json'), JSON.stringify(records));
  const state = { commands: [], registrations: [], settings: [], views: new Map(), leaves: [], notices: [], layout: [], required: [], saved: [], directory, base, storage, detached: [] };
  const events = new Map();
  const emitter = kind => ({
    on(name, callback) { const ref = { kind, name, callback }; events.set(ref, ref); return ref; },
    offref(ref) { events.delete(ref); },
    trigger(name, ...args) { for (const ref of events.values()) if (ref.kind === kind && ref.name === name) ref.callback(...args); },
  });
  class Plugin {
    constructor(app) { this.app = app; }
    registerEvent(ref) { state.registrations.push(ref); }
    addCommand(command) { state.commands.push(command); }
    registerView(type, factory) { state.views.set(type, factory); }
    addSettingTab(tab) { state.settings.push(tab); }
    addRibbonIcon(icon, label) { state.ribbon = { icon, label }; }
    async loadData() { return loadData ? loadData() : savedUi; }
    async saveData(value) { state.saved.push(structuredClone(value)); }
  }
  class FileSystemAdapter { getBasePath() { return base; } }
  class ItemView {
    constructor(leaf) { this.leaf = leaf; this.contentEl = { addClass() {}, empty() {} }; }
  }
  class PluginSettingTab {
    constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = { empty() {} }; }
  }
  const native = { Plugin, ItemView, PluginSettingTab, FileSystemAdapter,
    Notice: class { constructor(message) { state.notices.push(message); } } };
  const project = { path: '50_Tasks/project.md', basename: 'project', extension: 'md' };
  const workspace = {
    ...emitter('workspace'),
    onLayoutReady(callback) { state.layout.push(callback); },
    getActiveFile: () => project,
    getLeavesOfType: type => state.leaves.filter(leaf => leaf.view.getViewType() === type),
    getLeaf() {
      const leaf = {
        async setViewState({ type }) {
          this.view = deferViews ? { getViewType: () => type } : state.views.get(type)(this);
          if (deferViews) this.loadIfDeferred = async () => { this.view = state.views.get(type)(this); delete this.loadIfDeferred; };
          state.leaves.push(this);
        },
      };
      return leaf;
    },
    async revealLeaf(leaf) { state.revealed = leaf; },
    detachLeavesOfType(type) { state.detached.push(type); state.leaves = []; },
  };
  const app = { vault: { ...emitter('vault'), adapter: new FileSystemAdapter(),
    getAbstractFileByPath: name => name === project.path ? project : null,
    getMarkdownFiles: () => [project] }, workspace };
  const sandbox = {
    module: { exports: {} }, exports: {}, console, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder,
    process: { env: { NODE_ENV: 'production' } }, setTimeout, clearTimeout, setInterval, clearInterval,
    require(id) {
      state.required.push(id);
      if (id === 'obsidian') return native;
      if (id === 'node:os') return { ...os, homedir: () => directory };
      if (id.startsWith('node:') || ['fs', 'path', 'os', 'crypto'].includes(id)) return require(id);
      throw new Error('Unexpected external dependency: ' + id);
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/feishu-task-sync/main.js'), 'utf8'), sandbox);
  state.plugin = new sandbox.module.exports(app);
  state.app = app;
  state.events = events;
  state.unload = () => {
    state.plugin.onunload();
    for (const ref of state.registrations) events.delete(ref);
  };
  t.after(() => { if (state.plugin.loaded) state.unload(); });
  return state;
}

module.exports = { pluginHarness };
