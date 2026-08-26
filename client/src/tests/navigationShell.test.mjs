import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  NAVIGATION_DECISION_TYPES,
  decideAuthorizedNavigation,
  dedupeMenuTree,
  findFirstAuthorizedBusinessPath,
  flattenMenus,
  getUnauthenticatedLoginLocation,
  isBusinessRouteMenu,
  projectDynamicRouteContract,
  resolveLoginRedirect
} from '../utils/navigationRoutes.js';

// 授权菜单样本覆盖目录、业务页、按钮、保留入口、空路径和外部地址。
const menuTree = [
  {
    id: 10,
    menuType: 'directory',
    menuName: '能耗管理',
    routePath: '/energy',
    component: null,
    children: [
      { id: 11, menuType: 'menu', menuName: '能耗统计', routePath: '/energy/statistics', component: 'energy/statistics/index' },
      { id: 12, menuType: 'button', menuName: '导出', routePath: '/energy/export' }
    ]
  },
  { id: 20, menuType: 'menu', menuName: '个人中心旧菜单', routePath: '/profile' },
  { id: 21, menuType: 'menu', menuName: '空路径', routePath: '  ' },
  { id: 22, menuType: 'menu', menuName: '外部地址', routePath: '//example.com' }
];
// 扁平菜单结果应保持服务端父子顺序。
const flattenedMenus = flattenMenus(menuTree);
assert.deepEqual(flattenedMenus.map((menu) => menu.id), [10, 11, 12, 20, 21, 22]);
assert.equal(isBusinessRouteMenu(flattenedMenus[0]), false, '目录只参与菜单结构，不能注册为占位业务页。');
assert.equal(isBusinessRouteMenu(flattenedMenus[1]), true);
assert.equal(isBusinessRouteMenu(flattenedMenus[2]), false);
assert.equal(isBusinessRouteMenu(flattenedMenus[3]), false);
assert.equal(isBusinessRouteMenu(flattenedMenus[4]), false);
assert.equal(isBusinessRouteMenu(flattenedMenus[5]), false);
assert.equal(isBusinessRouteMenu({ menuType: 'menu', routePath: '/' }), false);
assert.equal(isBusinessRouteMenu({ menuType: 'menu', routePath: '/login' }), false);
assert.equal(isBusinessRouteMenu({ menuType: 'menu', routePath: '/register' }), false);
assert.equal(findFirstAuthorizedBusinessPath(menuTree), '/energy/statistics', '父目录不能抢占首个真实授权业务页面。');

// N7 view-only 账号由服务端投影的 /carbon 页面必须形成可信动态路由合同。
const ghgViewOnlyMenu = {
  id: 60,
  menuType: 'menu',
  menuName: '碳核算',
  routePath: '/carbon',
  component: 'carbon/index',
  permissionCode: null,
  children: []
};
assert.deepEqual(projectDynamicRouteContract(ghgViewOnlyMenu), {
  path: '/carbon',
  name: 'menu-60',
  componentKey: 'carbon/index',
  meta: { title: '碳核算', permission: null }
});
assert.equal(projectDynamicRouteContract({ ...ghgViewOnlyMenu, menuType: 'button' }), null,
  '按钮本身不得被注册为动态页面。');

// 历史重复目录必须合并成一个有效节点，且不同子项不能在前端兜底时丢失。
const dedupedTree = dedupeMenuTree([
  { id: 10, menuType: 'directory', routePath: '/energy', children: [{ id: 11, menuType: 'menu', routePath: '/energy/statistics' }] },
  { id: 13, menuType: 'directory', routePath: '/energy', children: [{ id: 14, menuType: 'menu', routePath: '/energy/budgets' }] }
]);
assert.equal(dedupedTree.length, 1);
assert.deepEqual(dedupedTree[0].children.map((menu) => menu.routePath), ['/energy/statistics', '/energy/budgets']);

// 刷新动态业务 URL 后，本轮首次注册只允许按原 fullPath replace 重试一次。
const refreshedFullPath = '/energy/statistics?month=2026-01#summary';
const firstRefreshDecision = decideAuthorizedNavigation({
  targetName: 'NotFound',
  targetPath: '/energy/statistics',
  targetFullPath: refreshedFullPath,
  routesInitializedThisTurn: true,
  resolvedRouteName: 'menu-11',
  registeredRouteNames: new Set(['menu-11']),
  firstBusinessPath: '/energy/statistics'
});
assert.deepEqual(firstRefreshDecision, { type: NAVIGATION_DECISION_TYPES.RETRY, path: refreshedFullPath });
// replace 后下一轮守卫不再携带“本轮刚初始化”标记，因此必须直接放行而非再次重试。
const secondRefreshDecision = decideAuthorizedNavigation({
  targetName: 'menu-11',
  targetPath: '/energy/statistics',
  targetFullPath: refreshedFullPath,
  routesInitializedThisTurn: false,
  resolvedRouteName: 'menu-11',
  registeredRouteNames: new Set(['menu-11']),
  firstBusinessPath: '/energy/statistics'
});
assert.deepEqual(secondRefreshDecision, { type: NAVIGATION_DECISION_TYPES.ALLOW });

// 根入口、已登录访问登录注册页和注册后仍未知地址都应回到首个授权业务路径。
for (const target of [
  { targetName: 'Shell', targetPath: '/' },
  { targetName: 'Login', targetPath: '/login' },
  { targetName: 'Register', targetPath: '/register' },
  { targetName: 'NotFound', targetPath: '/unknown' }
]) {
  const decision = decideAuthorizedNavigation({ ...target, firstBusinessPath: '/energy/statistics' });
  assert.deepEqual(decision, { type: NAVIGATION_DECISION_TYPES.REDIRECT, path: '/energy/statistics' });
}

// 空菜单账号访问根入口时进入稳定 NotFound，已经位于 NotFound 时则放行，避免空 Shell 和循环。
const emptyRootDecision = decideAuthorizedNavigation({ targetName: 'Shell', targetPath: '/', firstBusinessPath: '' });
assert.deepEqual(emptyRootDecision, { type: NAVIGATION_DECISION_TYPES.NOT_FOUND });
const emptyNotFoundDecision = decideAuthorizedNavigation({ targetName: 'NotFound', targetPath: '/404', firstBusinessPath: '' });
assert.deepEqual(emptyNotFoundDecision, { type: NAVIGATION_DECISION_TYPES.ALLOW });
const missingRegisteredRouteDecision = decideAuthorizedNavigation({ targetName: 'NotFound', targetPath: '/energy/statistics', firstBusinessPath: '/energy/statistics' });
assert.deepEqual(missingRegisteredRouteDecision, { type: NAVIGATION_DECISION_TYPES.ALLOW }, '异常缺失动态路由时不能重定向到相同地址形成循环。');

// 登录 redirect 仅接受站内路径，并完整保留 query/hash；无合法 redirect 时统一进入根入口。
assert.equal(resolveLoginRedirect(refreshedFullPath), refreshedFullPath);
assert.equal(resolveLoginRedirect(undefined), '/');
assert.equal(resolveLoginRedirect(['/dashboard']), '/');
assert.equal(resolveLoginRedirect('//example.com/path'), '/');

// bootstrap 中的 401 由当前守卫保留原目标；稳定业务页失效时携带当前 fullPath 返回登录页。
assert.equal(getUnauthenticatedLoginLocation({
  bootstrapActive: true,
  currentRouteName: 'NotFound',
  currentFullPath: refreshedFullPath
}), null);
assert.deepEqual(getUnauthenticatedLoginLocation({
  bootstrapActive: false,
  currentRouteName: 'menu-11',
  currentFullPath: refreshedFullPath
}), { name: 'Login', query: { redirect: refreshedFullPath } });
assert.equal(getUnauthenticatedLoginLocation({
  bootstrapActive: false,
  currentRouteName: 'Login',
  currentFullPath: '/login'
}), null);

// 静态契约源文件用于验证路由清理、页面跳转和侧栏滚动样式没有被模板编译隐藏。
const routerSource = readFileSync(new URL('../router/index.js', import.meta.url), 'utf8');
const loginSource = readFileSync(new URL('../views/auth/Login.vue', import.meta.url), 'utf8');
const notFoundSource = readFileSync(new URL('../views/NotFound.vue', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../layouts/Sidebar.vue', import.meta.url), 'utf8');

// NotFound 不再公开，未登录守卫只放行 Login/Register。
assert.match(routerSource, /const publicRouteNames = new Set\(\['Login', 'Register'\]\)/);
assert.match(routerSource, /name: 'NotFound', component: NotFound, meta: \{ title: '页面不存在' \}/);
assert.doesNotMatch(routerSource, /name: 'NotFound'[^\n]*public: true/);
// 动态路由注册继续保持 routesReady、hasRoute、名称集合幂等，并在失败或退出后清理。
assert.match(routerSource, /if \(!permissions\.routesReady\)/);
assert.match(routerSource, /if \(!router\.hasRoute\(record\.name\)\)/);
assert.match(routerSource, /dynamicRouteNames\.add\(record\.name\)/);
assert.match(routerSource, /dynamicRouteNames\.clear\(\)/);
assert.match(routerSource, /usePermissionStore\(\)\.reset\(\)/);
assert.match(routerSource, /const routeContract = projectDynamicRouteContract\(menu\)/);
assert.match(routerSource, /componentMap\[routeContract\.componentKey\]/);
assert.match(routerSource, /catch \{\s*resetDynamicRoutes\(\);\s*await user\.logout\(false\)/);
// bootstrap 期间事件只清理状态，由守卫保留原 to.fullPath；稳定页面失效时携带当前地址跳登录。
assert.match(routerSource, /let activeBootstrapCount = 0/);
assert.match(routerSource, /if \(bootstrapActiveForNavigation\) activeBootstrapCount \+= 1/);
assert.match(routerSource, /activeBootstrapCount = Math\.max\(0, activeBootstrapCount - 1\)/);
assert.match(routerSource, /window\.addEventListener\('charcoal:unauthenticated', async \(\) =>/);
assert.match(routerSource, /await useUserStore\(\)\.logout\(false\)/);
assert.match(routerSource, /if \(loginLocation\) await router\.replace\(loginLocation\)/);
// 登录页和 NotFound 组件不再硬编码 dashboard，统一交给根入口选择授权落点。
assert.doesNotMatch(loginSource, /router\.replace\([^\n]*dashboard/);
assert.match(loginSource, /resolveLoginRedirect\(router\.currentRoute\.value\.query\.redirect\)/);
assert.doesNotMatch(notFoundSource, /dashboard/);
assert.match(notFoundSource, /\$router\.replace\('\/'\)/);
// 侧栏使用 sticky 固定在视口并独立纵向滚动，不改变主内容文档滚动模型。
assert.match(sidebarSource, /position:sticky/);
assert.match(sidebarSource, /top:0/);
assert.match(sidebarSource, /align-self:flex-start/);
assert.match(sidebarSource, /height:100vh/);
assert.match(sidebarSource, /overflow-y:auto/);
assert.doesNotMatch(sidebarSource, /position:fixed/);

console.log('navigationShell.test.mjs passed');
