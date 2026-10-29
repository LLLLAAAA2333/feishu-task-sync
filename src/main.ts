import { ItemView, Notice, Plugin, PluginSettingTab, WorkspaceLeaf, TAbstractFile } from 'obsidian';
import * as Obsidian from 'obsidian';
import { createRoot, Root } from 'react-dom/client';
import { createElement } from 'react';
import { getService } from '../lib/feishu-service.cjs';
import { FeishuScheduler } from '../lib/feishu-scheduler.cjs';
import { FeishuPanel, FeishuSettings } from './ui/Panel';

export const VIEW_TYPE = 'feishu-sync-panel';
const SECTIONS = new Set(['overview', 'notes', 'connection', 'transfer', 'help']);
type Section = 'overview' | 'notes' | 'connection' | 'transfer' | 'help';

class FeishuView extends ItemView {
  root: Root | null = null;
  panelNavigation: { section: Section; request: number } | undefined;
  constructor(leaf: WorkspaceLeaf, readonly plugin: FeishuSyncPlugin) { super(leaf); }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return '飞书同步'; }
  getIcon() { return 'cloud'; }
  async onOpen() {
    this.contentEl.addClass('feishu-sync--view');
    this.root = createRoot(this.contentEl);
    this.renderPanel();
  }
  navigate(section: Section) {
    this.panelNavigation = { section, request: (this.panelNavigation?.request || 0) + 1 };
    this.renderPanel();
  }
  renderPanel() {
    this.root?.render(createElement(FeishuPanel, { runtime: this.plugin.runtime, navigation: this.panelNavigation }));
  }
  async onClose() {
    this.root?.unmount();
    this.root = null;
    this.contentEl.empty();
  }
}

class FeishuSettingTab extends PluginSettingTab {
  root: Root | null = null;
  constructor(readonly plugin: FeishuSyncPlugin) { super(plugin.app, plugin); }
  display() {
    this.root?.unmount();
    this.containerEl.empty();
    this.root = createRoot(this.containerEl);
    this.root.render(createElement(FeishuSettings, { runtime: this.plugin.runtime }));
  }
  hide() {
    this.root?.unmount();
    this.root = null;
    this.containerEl.empty();
  }
}

export default class FeishuSyncPlugin extends Plugin {
  readonly standalone = true;
  service: ReturnType<typeof getService> | undefined;
  scheduler: FeishuScheduler | undefined;
  disposed = false;
  loaded = false;
  manualCommandPending = false;
  uiData: { activeSection?: string } = {};
  uiSave: Promise<unknown> = Promise.resolve();
  settingsTab: FeishuSettingTab | undefined;
  runtime: { plugin: FeishuSyncPlugin; storage: { getData: () => object; saveData: (data: unknown) => Promise<unknown> } } = {
    plugin: this,
    storage: { getData: () => this.uiData, saveData: data => this.saveUiData(data) },
  };

  async onload() {
    if (this.loaded) return;
    this.loaded = true;
    this.disposed = false;
    try {
      if (!(this.app.vault.adapter instanceof Obsidian.FileSystemAdapter)) {
        throw new Error('飞书同步需要 Obsidian 桌面版。');
      }
      try {
        const saved = await this.loadData();
        if (SECTIONS.has(saved?.activeSection)) this.uiData = { activeSection: saved.activeSection };
      } catch { new Notice('飞书界面偏好读取失败，已使用默认页面；同步配置保持原样。'); }
      if (this.disposed) return;
      this.service = getService(this.app, Obsidian, { openPanel: () => this.openPanel() });
      this.scheduler = new FeishuScheduler({
        service: this.service,
        onStatus: (status?: unknown) => {
          if (!this.disposed) this.app.workspace.trigger('feishu-sync:auto-status', status);
        },
      });
      this.registerView(VIEW_TYPE, leaf => new FeishuView(leaf, this));
      this.settingsTab = new FeishuSettingTab(this);
      this.addSettingTab(this.settingsTab);
      this.addRibbonIcon('cloud', '打开飞书同步', () => { void this.openPanel().catch(error => this.report(error)); });
      this.addCommand({ id: 'open-panel', name: '打开飞书任务面板', callback: () => {
        void Promise.resolve().then(() => {
          const path = this.app.workspace.getActiveFile()?.path;
          const selected = path && this.service!.isCandidatePath(path) ? path : undefined;
          return this.openPanel(selected);
        }).catch(error => this.report(error));
      } });
      this.addCommand({ id: 'sync-vault', name: '立即同步任务到飞书', callback: () => this.runManualCommand() });
      this.registerEvent(this.app.workspace.on('feishu-sync:change', () => this.scheduler?.configChanged()));
      const changed = (file: TAbstractFile, oldPath?: string) => this.scheduler?.vaultChanged(file.path, oldPath);
      this.registerEvent(this.app.vault.on('create', changed));
      this.registerEvent(this.app.vault.on('modify', changed));
      this.registerEvent(this.app.vault.on('delete', changed));
      this.registerEvent(this.app.vault.on('rename', changed));
      if (this.app.metadataCache?.on) this.registerEvent(this.app.metadataCache.on('changed', file => {
        if (this.scheduler?.config?.taskTags.length) this.scheduler.vaultChanged(file.path);
      }));
      this.app.workspace.onLayoutReady(() => {
        if (!this.disposed) this.scheduler?.start();
      });
    } catch (error) {
      this.scheduler?.stop();
      this.report(error, '飞书同步服务加载失败，请重新启用插件。');
    }
  }

  saveUiData(value: unknown) {
    const section = (value as { activeSection?: string } | null)?.activeSection;
    this.uiData = SECTIONS.has(section || '') ? { activeSection: section } : {};
    const snapshot = { ...this.uiData };
    this.uiSave = this.uiSave.catch(() => {}).then(() => this.saveData(snapshot));
    return this.uiSave.catch(error => this.report(error, '界面偏好未能保存。'));
  }

  async openPanel(notePath?: string, task?: unknown, section?: Section) {
    if (this.disposed || !this.service) throw new Error('飞书同步服务尚未就绪，请重新启用插件。');
    if (notePath) this.service.select(notePath, task);
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf('tab');
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await this.app.workspace.revealLeaf(leaf);
    if (typeof leaf.loadIfDeferred === 'function') await leaf.loadIfDeferred();
    if (section && leaf.view instanceof FeishuView) leaf.view.navigate(section);
  }

  getAutoStatus() {
    return this.scheduler?.getStatus() || { running: false, lastRunAt: null, lastError: '飞书调度尚未就绪。', summary: null, failures: [] };
  }
  syncNow() {
    return this.scheduler?.manual() || Promise.reject(new Error('飞书调度尚未就绪。'));
  }
  report(error: unknown, fallback = '飞书操作失败，请检查配置后重试。') {
    if (!this.disposed) new Notice(error instanceof Error ? error.message : fallback);
  }
  async runManualCommand() {
    if (this.manualCommandPending) return;
    this.manualCommandPending = true;
    try {
      const result = await this.syncNow();
      if (!this.disposed) new Notice(`飞书同步：成功 ${Number(result?.synced || 0)} 条，失败 ${Number(result?.failed || 0)} 条，跳过 ${Number(result?.skipped || 0)} 条。`);
    } catch (error) { this.report(error); }
    finally { this.manualCommandPending = false; }
  }
  onunload() {
    this.disposed = true;
    this.loaded = false;
    this.scheduler?.stop();
    this.settingsTab?.hide();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }
}
