import { defineStore } from 'pinia';
import { resolveApiBase, toTrustedApiBase, STORAGE_KEY } from '@/utils/apiBase';

/** 应用级界面与可信 API 配置状态。 */
export const useAppStore = defineStore('app', {
  state: () => ({
    /** 当前可信 API Base。 */
    apiBase: resolveApiBase(),
    /** 侧栏折叠状态，与驾驶舱沉浸模式相互独立。 */
    sidebarCollapsed: false,
    /** 驾驶舱非持久化沉浸模式，刷新页面后自动恢复关闭。 */
    immersiveMode: false
  }),
  actions: {
    /** 更新并持久化可信 API Base。 */
    setApiBase(value) {
      const apiBase = toTrustedApiBase(value);
      if (!apiBase) return false;
      this.apiBase = apiBase;
      localStorage.setItem(STORAGE_KEY, apiBase);
      return true;
    },
    /** 显式设置侧栏折叠状态，供响应式布局复用。 */
    setSidebarCollapsed(value) {
      this.sidebarCollapsed = value === true;
    },
    /** 切换侧栏折叠状态。 */
    toggleSidebar() {
      this.sidebarCollapsed = !this.sidebarCollapsed;
    },
    /** 显式设置驾驶舱沉浸模式，不写入本地存储。 */
    setImmersiveMode(value) {
      this.immersiveMode = value === true;
    },
    /** 切换驾驶舱沉浸模式。 */
    toggleImmersiveMode() {
      this.immersiveMode = !this.immersiveMode;
    }
  }
});
