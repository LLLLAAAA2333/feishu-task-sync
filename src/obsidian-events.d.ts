import 'obsidian';
import { EventRef } from 'obsidian';
import type { AutoStatus, Selection } from './contracts';

declare module 'obsidian' {
  interface Workspace {
    on(name: 'feishu-sync:change', callback: () => void): EventRef;
    on(name: 'feishu-sync:selection', callback: (selection: Selection | null) => void): EventRef;
    on(name: 'feishu-sync:auto-status', callback: (status: AutoStatus) => void): EventRef;
  }
}
