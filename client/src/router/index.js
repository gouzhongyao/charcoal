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
import {
  NAVIGATION_DECISION_TYPES,
  decideAuthorizedNavigation,
  findFirstAuthorizedBusinessPath,
  flattenMenus,
  getMenuRoutePath,
  getUnauthenticatedLoginLocation,
  isBusinessRouteMenu
} from '@/utils/navigationRoutes';

// 动态菜单组件映射只允许加载前端已登记的可信页面组件。
const componentMap = Object.freeze({
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
// 动态路由名称集合用于幂等注册、刷新重试识别和退出后的完整清理。
const dynamicRouteNames = new Set();
// 未登录状态真正允许直接访问的路由仅限登录和注册。
const publicRouteNames = new Set(['Login', 'Register']);
// 活跃 bootstrap 计数用于让 401 事件把原始 fullPath 交回当前守卫处理，避免竞争跳转。
let activeBootstrapCount = 0;
// 会话失效事件处理标记用于合并同一批并发 401，避免重复清理和跳转。
let unauthenticatedEventHandling = false;

// 将后端菜单转换为安全的前端动态路由记录，未知组件继续落到迁移占位页。
function safeRoute(menu) {
  if (!isBusinessRouteMenu(menu)) return null;
  const component = componentMap[menu.component] || MigrationPlaceholder;
  return {
    path: getMenuRoutePath(menu),
    name: `menu-${menu.id}`,
    component,
    meta: {
      title: menu.menuName,
      permission: menu.permissionCode,
      migration: component === MigrationPlaceholder
    }
  };
}

// 应用路由实例承载固定入口、受保护布局及最终兜底页面。
const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'Login', component: Login, meta: { public: true, title: '登录' } },
    { path: '/register', name: 'Register', component: Register, meta: { public: true, title: '注册' } },
    { path: '/', name: 'Shell', component: DefaultLayout, children: [
      // 个人中心不依赖后端可见菜单注册，已登录用户可由右上角入口稳定访问。
      { path: '/profile', name: 'Profile', component: Profile, meta: { title: '用户中心' } }
    ] },
    { path: '/:pathMatch(.*)*', name: 'NotFound', component: NotFound, meta: { title: '页面不存在' } }
  ]
});

// 清理当前账号注册的动态路由与菜单状态，后续登录可重新完整初始化。
export function resetDynamicRoutes() {
  dynamicRouteNames.forEach((name) => router.hasRoute(name) && router.removeRoute(name));
  dynamicRouteNames.clear();
  usePermissionStore().reset();
}

// 按服务端菜单顺序幂等注册动态路由，并记录本次真正添加的路由名称。
function addMenuRoutes(menus) {
  flattenMenus(menus).map(safeRoute).filter(Boolean).forEach((record) => {
    if (!router.hasRoute(record.name)) {
      router.addRoute('Shell', record);
      dynamicRouteNames.add(record.name);
    }
  });
}

// 把纯导航决策转换为 Vue Router 守卫返回值。
function applyNavigationDecision(decision) {
  if (decision.type === NAVIGATION_DECISION_TYPES.ALLOW) return true;
  if (decision.type === NAVIGATION_DECISION_TYPES.NOT_FOUND) {
    return { name: 'NotFound', params: { pathMatch: ['404'] }, replace: true };
  }
  return { path: decision.path, replace: true };
}

// 全局守卫先恢复登录资料和授权菜单，再决定刷新重试、默认落点或无权限兜底。
router.beforeEach(async (to) => {
  const user = useUserStore();
  const permissions = usePermissionStore();
  if (!user.isLoggedIn) {
    return publicRouteNames.has(to.name)
      ? true
      : { name: 'Login', query: { redirect: to.fullPath } };
  }

  let routesInitializedThisTurn = false;
  const bootstrapActiveForNavigation = !user.profile || !permissions.routesReady;
  if (bootstrapActiveForNavigation) activeBootstrapCount += 1;
  try {
    if (!user.profile) await user.fetchProfile();
    if (!permissions.routesReady) {
      await permissions.fetchMenus();
      addMenuRoutes(permissions.menus);
      permissions.routesReady = true;
      routesInitializedThisTurn = true;
    }

    const resolvedRoute = router.resolve(to.fullPath);
    const firstBusinessPath = findFirstAuthorizedBusinessPath(permissions.menus);
    const decision = decideAuthorizedNavigation({
      targetName: to.name,
      targetPath: to.path,
      targetFullPath: to.fullPath,
      routesInitializedThisTurn,
      resolvedRouteName: resolvedRoute.name,
      registeredRouteNames: dynamicRouteNames,
      firstBusinessPath
    });
    return applyNavigationDecision(decision);
  } catch {
    resetDynamicRoutes();
    await user.logout(false);
    return { name: 'Login', query: { redirect: to.fullPath } };
  } finally {
    if (bootstrapActiveForNavigation) activeBootstrapCount = Math.max(0, activeBootstrapCount - 1);
  }
});

// 会话失效事件同步清理 Pinia 会话和动态路由；bootstrap 期间不抢占当前守卫的原地址跳转。
window.addEventListener('charcoal:unauthenticated', async () => {
  if (unauthenticatedEventHandling) return;
  unauthenticatedEventHandling = true;
  const currentRoute = router.currentRoute.value;
  const loginLocation = getUnauthenticatedLoginLocation({
    bootstrapActive: activeBootstrapCount > 0,
    currentRouteName: currentRoute.name,
    currentFullPath: currentRoute.fullPath
  });
  try {
    resetDynamicRoutes();
    await useUserStore().logout(false);
    if (loginLocation) await router.replace(loginLocation);
  } finally {
    unauthenticatedEventHandling = false;
  }
});

export default router;
