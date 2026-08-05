import { createRouter, createWebHistory } from 'vue-router';
import DefaultLayout from '@/layouts/DefaultLayout.vue';
import Login from '@/views/auth/Login.vue';
import Register from '@/views/auth/Register.vue';
import Profile from '@/views/Profile.vue';
import Users from '@/views/system/Users.vue';
import Roles from '@/views/system/Roles.vue';
import Menus from '@/views/system/Menus.vue';
import MigrationPlaceholder from '@/views/MigrationPlaceholder.vue';
import EnergyStatistics from '@/views/energy/EnergyStatistics.vue';
import BudgetManagement from '@/views/energy/BudgetManagement.vue';
import OrganizationUnits from '@/views/ledger/OrganizationUnits.vue';
import Meters from '@/views/ledger/Meters.vue';
import MeterReadings from '@/views/ledger/MeterReadings.vue';
import Generation from '@/views/ledger/Generation.vue';
import ProductionUnits from '@/views/ledger/ProductionUnits.vue';
import ProductionOutputs from '@/views/ledger/ProductionOutputs.vue';
import CarbonManagement from '@/views/carbon/CarbonManagement.vue';
import PredictionManagement from '@/views/predictions/PredictionManagement.vue';
import Dashboard from '@/views/dashboard/Dashboard.vue';
import ImportCenter from '@/views/imports/ImportCenter.vue';
import Backups from '@/views/system/Backups.vue';
import NotFound from '@/views/NotFound.vue';
import { useUserStore } from '@/stores/user';
import { usePermissionStore } from '@/stores/permission';

const componentMap = Object.freeze({
  'profile/index': Profile,
  'system/users/index': Users,
  'system/roles/index': Roles,
  'system/menus/index': Menus,
  'dashboard/index': Dashboard,
  'imports/index': ImportCenter,
  'energy/statistics/index': EnergyStatistics,
  'energy/budgets/index': BudgetManagement,
  'ledger/organization/index': OrganizationUnits,
  'ledger/meters/index': Meters,
  'ledger/meter-readings/index': MeterReadings,
  'ledger/generation/index': Generation,
  'ledger/production-units/index': ProductionUnits,
  'ledger/production-output/index': ProductionOutputs,
  'carbon/index': CarbonManagement,
  'predictions/index': PredictionManagement,
  'system/backups/index': Backups
});
const dynamicRouteNames = new Set();
function flattenMenus(menus = []) { return menus.flatMap((menu) => [menu, ...flattenMenus(menu.children || [])]); }
function safeRoute(menu) {
  if (!menu.routePath || menu.menuType === 'button') return null;
  const component = componentMap[menu.component] || MigrationPlaceholder;
  return { path: menu.routePath, name: `menu-${menu.id}`, component, meta: { title: menu.menuName, permission: menu.permissionCode, migration: component === MigrationPlaceholder } };
}
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'Login', component: Login, meta: { public: true, title: '登录' } },
    { path: '/register', name: 'Register', component: Register, meta: { public: true, title: '注册' } },
    { path: '/', name: 'Shell', component: DefaultLayout, children: [] },
    { path: '/:pathMatch(.*)*', name: 'NotFound', component: NotFound, meta: { public: true, title: '页面不存在' } }
  ]
});
export function resetDynamicRoutes() { dynamicRouteNames.forEach((name) => router.hasRoute(name) && router.removeRoute(name)); dynamicRouteNames.clear(); usePermissionStore().reset(); }
function addMenuRoutes(menus) { flattenMenus(menus).map(safeRoute).filter(Boolean).forEach((record) => { if (!router.hasRoute(record.name)) { router.addRoute('Shell', record); dynamicRouteNames.add(record.name); } }); }
router.beforeEach(async (to) => {
  const user = useUserStore(); const permissions = usePermissionStore();
  if (to.meta.public) return user.isLoggedIn && to.name !== 'NotFound' ? '/dashboard' : true;
  if (!user.isLoggedIn) return { name: 'Login', query: { redirect: to.fullPath } };
  try {
    if (!user.profile) await user.fetchProfile();
    if (!permissions.routesReady) { await permissions.fetchMenus(); addMenuRoutes(permissions.menus); permissions.routesReady = true; const resolved = router.resolve(to.fullPath); if (resolved.name === 'NotFound') { const fallback = flattenMenus(permissions.menus).find((menu) => safeRoute(menu)); return { path: fallback?.routePath || '/profile', replace: true }; } return { path: to.fullPath, replace: true }; }
    return true;
  } catch { await user.logout(false); resetDynamicRoutes(); return { name: 'Login', query: { redirect: to.fullPath } }; }
});
window.addEventListener('charcoal:unauthenticated', () => { resetDynamicRoutes(); if (router.currentRoute.value.name !== 'Login') router.replace('/login'); });
export default router;
