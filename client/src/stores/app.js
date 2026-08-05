import { defineStore } from 'pinia';
import { resolveApiBase, toTrustedApiBase, STORAGE_KEY } from '@/utils/apiBase';

export const useAppStore = defineStore('app', {
  state: () => ({ apiBase: resolveApiBase(), sidebarCollapsed: false }),
  actions: {
    setApiBase(value) { const apiBase = toTrustedApiBase(value); if (!apiBase) return false; this.apiBase = apiBase; localStorage.setItem(STORAGE_KEY, apiBase); return true; },
    toggleSidebar() { this.sidebarCollapsed = !this.sidebarCollapsed; }
  }
});
