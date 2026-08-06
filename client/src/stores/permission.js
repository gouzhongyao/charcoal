import { defineStore } from 'pinia';
import { request } from '@/api/http';
import { dedupeMenuTree } from '@/utils/navigationRoutes';

export const usePermissionStore = defineStore('permission', {
  state: () => ({ menus: [], routesReady: false }),
  actions: {
    // 菜单服务已迁移历史重复目录；前端再合并一次，避免旧会话或异常响应重复渲染和注册路由。
    async fetchMenus() {
      const response = await request({ url: '/auth/menus' });
      this.menus = dedupeMenuTree(response.data || []);
      return this.menus;
    },
    reset() { this.menus = []; this.routesReady = false; }
  }
});
