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
  isExpectedNamedRoute,
  normalizeTrustedInternalRoutePath,
  projectDynamicRouteContract,
  resolveLoginRedirect,
  resolveTrustedRegisteredRoute
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

// 演示 manifest 目标只接受站内无查询页面路径，解析结果必须来自当前账号已注册真实组件路由。
for (const invalidTarget of [
  '', '//example.com/path', '/api/energy-records', 'https://example.com/page', '/energy/analysis?tab=trend', '/carbon#summary', '/energy\\analysis', 'javascript:alert(1)'
]) {
  assert.equal(normalizeTrustedInternalRoutePath(invalidTarget), '', `应拒绝不可信目标 ${invalidTarget}`);
}
assert.equal(normalizeTrustedInternalRoutePath(' /energy/analysis '), '/energy/analysis');
const trustedRouteRecords = [
  { path: '/energy/analysis', name: 'menu-analysis', meta: { trustedInternalRoute: true, unavailable: false } },
  { path: '/energy/benchmarks', name: 'menu-placeholder', meta: { trustedInternalRoute: false, unavailable: true } },
  { path: '/energy/budgets', name: 'menu-budget', meta: { trustedInternalRoute: true, unavailable: false, permission: 'energy:budget:view' } }
];
assert.deepEqual(resolveTrustedRegisteredRoute('/energy/analysis', trustedRouteRecords), {
  ok: true, code: 'trusted-target-route', path: '/energy/analysis', location: { name: 'menu-analysis' }
});
assert.deepEqual(resolveTrustedRegisteredRoute('/energy/budgets', trustedRouteRecords).location, { name: 'menu-budget' });
assert.equal(resolveTrustedRegisteredRoute('/energy/production', trustedRouteRecords).code, 'unregistered-target-route');
assert.equal(resolveTrustedRegisteredRoute('/energy/benchmarks', trustedRouteRecords).code, 'unregistered-target-route');
assert.equal(resolveTrustedRegisteredRoute('/api/energy-records', trustedRouteRecords).code, 'invalid-target-route');
assert.equal(isExpectedNamedRoute({ name: 'menu-analysis' }, { name: 'menu-analysis' }), true);
assert.equal(isExpectedNamedRoute({ name: 'Login' }, { name: 'menu-analysis' }), false, '守卫重定向到登录页必须识别为导航失败。');
assert.equal(isExpectedNamedRoute({ name: 'menu-analysis' }, { name: 'menu-budget' }), false);

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
const layoutSource = readFileSync(new URL('../layouts/DefaultLayout.vue', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../layouts/Sidebar.vue', import.meta.url), 'utf8');
const menuNodeSource = readFileSync(new URL('../layouts/MenuNode.vue', import.meta.url), 'utf8');
const navbarSource = readFileSync(new URL('../layouts/Navbar.vue', import.meta.url), 'utf8');
const appStoreSource = readFileSync(new URL('../stores/app.js', import.meta.url), 'utf8');
const themeSource = readFileSync(new URL('../theme.css', import.meta.url), 'utf8');
const managementPageSource = readFileSync(new URL('../components/ManagementPage.vue', import.meta.url), 'utf8');
const demoDataPageSource = readFileSync(new URL('../views/system/DemoData.vue', import.meta.url), 'utf8');

// NotFound 不再公开，未登录守卫只放行 Login/Register。
assert.match(routerSource, /const publicRouteNames = new Set\(\['Login', 'Register'\]\)/);
assert.match(routerSource, /name: 'NotFound', component: NotFound, meta: \{ title: '页面不存在' \}/);
assert.doesNotMatch(routerSource, /name: 'NotFound'[^\n]*public: true/);
// 系统演示数据管理页必须接入动态组件白名单并保持服务端目录驱动。
assert.match(routerSource, /import DemoData from '@\/views\/system\/DemoData\.vue';/);
assert.match(routerSource, /'system\/demo-data\/index': DemoData/);
assert.match(demoDataPageSource, /系统演示数据管理/);
assert.match(demoDataPageSource, /服务端演示 catalog/);
assert.doesNotMatch(demoDataPageSource, /迁移中|Vue3|legacy|开发中|临时入口|占位页/i);
assert.match(routerSource, /trustedInternalRoute: component !== MigrationPlaceholder/);
assert.match(routerSource, /unavailable: component === MigrationPlaceholder/);
assert.doesNotMatch(routerSource, /legacy\.html/);

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
// 侧栏固定在视口内，菜单超长时保留滚动能力但隐藏滚动条。
assert.match(sidebarSource, /position:fixed/);
assert.match(sidebarSource, /inset:0 auto 0 0/);
assert.match(sidebarSource, /height:100dvh/);
assert.match(sidebarSource, /overflow:hidden/);
assert.match(sidebarSource, /\.sidebar\.collapsed\{[^}]*width:64px[^}]*padding-left:0[^}]*padding-right:0/);
assert.match(sidebarSource, /\.sidebar\.collapsed \.brand\{[^}]*padding:0 10px/);
assert.match(sidebarSource, /\.sidebar\.collapsed \.menu-scroll-region\{[^}]*width:64px[^}]*max-width:64px/);
assert.match(sidebarSource, /\.menu-scroll-region\{[^}]*overflow-x:hidden[^}]*overflow-y:auto[^}]*scrollbar-width:none/);
assert.match(sidebarSource, /\.menu-scroll-region::\-webkit-scrollbar\{[^}]*display:none/);
assert.match(sidebarSource, /class=\"menu-scroll-region\"/);
assert.match(sidebarSource, /role=\"region\"/);
assert.match(sidebarSource, /aria-label=\"侧栏菜单键盘导航区域\"/);
assert.doesNotMatch(sidebarSource, /tabindex=\"0\"/);
assert.match(sidebarSource, /@keydown=\"handleMenuKeydown\"/);
assert.match(sidebarSource, /\['PageUp', 'PageDown', 'Home', 'End'\]/);
assert.match(sidebarSource, /event\.preventDefault\(\);/);
assert.match(sidebarSource, /menuElement\.scrollTop = targetScrollTop/);
assert.match(sidebarSource, /\.menu-scroll-region :deep\(\.el-menu-item:focus-visible\)/);
assert.match(sidebarSource, /\.menu-scroll-region :deep\(\.el-sub-menu:focus-visible\)/);
assert.match(sidebarSource, /function syncMenuKeyboardEntries\(/);
assert.match(sidebarSource, /entry\.tabIndex = entry === focusEntry \? 0 : -1/);
assert.match(sidebarSource, /candidate\.tabIndex = candidate === entry \? 0 : -1/);
assert.match(sidebarSource, /function isSidebarMenuPopup\(/);
assert.match(sidebarSource, /expanded !== 'true' && expanded !== 'false'/);
assert.match(sidebarSource, /event\.key === 'ArrowDown' \|\| event\.key === 'ArrowUp'/);
assert.match(sidebarSource, /event\.key === 'ArrowRight'/);
assert.match(sidebarSource, /event\.key === 'ArrowLeft'/);
assert.match(sidebarSource, /event\.key === 'Enter' \|\| event\.key === ' ' \|\| event\.key === 'Spacebar'/);
assert.match(sidebarSource, /entry\.click\(\)/);
assert.match(sidebarSource, /title\.click\(\)/);
assert.match(sidebarSource, /'mouseleave' : 'mouseenter'/);
assert.match(sidebarSource, /focusMenuEntry\(getMenuParentRoot\(menuRoot, currentEntry\), parentEntry\)/);
assert.match(sidebarSource, /setAttribute\('aria-current', 'page'\)/);
assert.match(sidebarSource, /getAttribute\('aria-expanded'\)/);
assert.match(sidebarSource, /document\.addEventListener\('keydown', handleDocumentMenuKeydown\)/);
assert.match(sidebarSource, /document\.addEventListener\('focusin', handleDocumentMenuFocusin\)/);
assert.match(menuNodeSource, /data-menu-id/);
assert.match(menuNodeSource, /data-menu-parent-id/);
assert.doesNotMatch(sidebarSource, /position:sticky/);
// 顶部栏固定在右侧视口顶部，只有其下方主内容区滚动。
assert.match(navbarSource, /position: sticky/);
assert.match(navbarSource, /top: 0/);
assert.match(navbarSource, /flex: 0 0 64px/);
assert.match(navbarSource, /overflow-x: hidden/);
assert.match(navbarSource, /\.navbar :deep\(\.el-breadcrumb\) \{[\s\S]*?min-width: 0;[\s\S]*?overflow: hidden/);
// 主内容使用零基准剩余高度并拥有独立双向溢出边界，长页面在小视口内也不会撑破滚动轨道。
assert.match(layoutSource, /\.shell\{[^}]*height:100dvh[^}]*overflow:hidden/);
assert.match(layoutSource, /\.shell-main\{[^}]*flex-direction:column[^}]*min-width:0[^}]*height:100dvh[^}]*overflow:hidden/);
assert.match(layoutSource, /\.shell main\{[^}]*flex:1 1 0[^}]*height:0[^}]*min-width:0[^}]*min-height:0[^}]*overflow-x:scroll[^}]*overflow-y:auto[^}]*overscroll-behavior-x:contain[^}]*scrollbar-gutter:stable/);
assert.match(layoutSource, /\.shell main\{[^}]*scrollbar-color:#5b7394 #dce9f8[^}]*scrollbar-width:auto/);
assert.match(layoutSource, /\.shell main::-webkit-scrollbar\{[^}]*width:12px[^}]*height:14px/);
assert.match(layoutSource, /\.shell main::-webkit-scrollbar-track\{[^}]*background:#dce9f8/);
assert.match(layoutSource, /\.shell main::-webkit-scrollbar-thumb\{[^}]*background:#5b7394[^}]*border:3px solid #dce9f8/);
assert.match(layoutSource, /\.shell main::-webkit-scrollbar-thumb:hover\{[^}]*background:#1769e0/);
assert.match(layoutSource, /\.shell main::-webkit-scrollbar-corner\{[^}]*background:#dce9f8/);
assert.match(layoutSource, /\.shell--immersive main\.shell-content--immersive\{[^}]*overflow:hidden[^}]*padding:0!important/);
assert.match(layoutSource, /\.shell--sidebar-collapsed \.shell-main\{margin-left:64px\}/);
assert.match(layoutSource, /matchMedia\('\(max-width: 900px\)'\)/);
assert.match(layoutSource, /onBeforeUnmount/);
assert.match(appStoreSource, /setSidebarCollapsed\(value\)/);
assert.match(themeSource, /html, body, #app \{[^}]*min-width: 0[^}]*overflow-x: hidden/);
// 管理页根节点不得沿用 Grid 的内容最小宽度撑大主内容；演示页宽表格必须使用 Element Plus 自身可见、可聚焦的横向滚动条。
assert.match(managementPageSource, /\.management-page\{[^}]*width:100%[^}]*min-width:0[^}]*max-width:100%/);
assert.match(demoDataPageSource, /<ManagementPage class="demo-data-page"/);
assert.equal((demoDataPageSource.match(/<el-table[^>]*flexible[^>]*scrollbar-always-on[^>]*:scrollbar-tabindex="0"/g) || []).length, 2);
assert.equal((demoDataPageSource.match(/class="table-scroll" role="region" aria-label="[^"]+横向滚动区域"/g) || []).length, 2);
assert.match(demoDataPageSource, /\.demo-data-page\{[^}]*width:100%[^}]*min-width:0[^}]*max-width:100%/);
assert.match(demoDataPageSource, /\.table-scroll\{[^}]*width:100%[^}]*min-width:0[^}]*max-width:100%[^}]*overflow-x:auto[^}]*overscroll-behavior-x:contain/);
assert.match(demoDataPageSource, /\.table-scroll :deep\(\.el-scrollbar__bar\.is-horizontal\)\{[^}]*height:8px/);
assert.match(demoDataPageSource, /\.table-scroll :deep\(\.el-scrollbar__wrap:focus-visible\)\{[^}]*outline:2px solid #1769e0/);

console.log('navigationShell.test.mjs passed');
