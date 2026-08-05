import { defineStore } from 'pinia';
import { request } from '@/api/http';

const TOKEN_KEY = 'charcoal.token';
export const useUserStore = defineStore('user', {
  state: () => ({ token: localStorage.getItem(TOKEN_KEY) || '', profile: null, ready: false }),
  getters: { permissions: (state) => state.profile?.permissions || [], isLoggedIn: (state) => Boolean(state.token) },
  actions: {
    async login(payload) { const data = (await request({ method: 'post', url: '/auth/login', data: payload })).data; this.token = data.token; localStorage.setItem(TOKEN_KEY, data.token); this.profile = data.user; this.ready = true; return data; },
    async fetchProfile() { this.profile = (await request({ url: '/auth/profile' })).data; this.ready = true; return this.profile; },
    async updateProfile(payload) { this.profile = (await request({ method: 'put', url: '/auth/profile', data: payload })).data; return this.profile; },
    async changePassword(payload) { return request({ method: 'put', url: '/auth/password', data: payload }); },
    async logout(remote = true) { try { if (remote && this.token) await request({ method: 'post', url: '/auth/logout' }); } finally { this.token = ''; this.profile = null; this.ready = false; localStorage.removeItem(TOKEN_KEY); } }
  }
});
