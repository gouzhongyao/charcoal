import { defineStore } from 'pinia';
import { request } from '@/api/http';

export const usePermissionStore = defineStore('permission', {
  state: () => ({ menus: [], routesReady: false }),
  actions: {
    async fetchMenus() { this.menus = (await request({ url: '/auth/menus' })).data || []; return this.menus; },
    reset() { this.menus = []; this.routesReady = false; }
  }
});
