import 'obsidian';
import { EventRef } from 'obsidian';

declare module 'obsidian' {
  interface Workspace {
    on(name: 'feishu-sync:change', callback: () => void): EventRef;
  }
}
