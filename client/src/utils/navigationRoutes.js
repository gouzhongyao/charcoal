// 导航路由模块：集中处理菜单路由筛选、默认落点和守卫跳转决策，避免页面与路由守卫各自硬编码。

// 保留入口路径不能由后端菜单重复注册为动态业务路由。
const RESERVED_ROUTE_PATHS = new Set(['/', '/login', '/register', '/profile']);
// 已登录用户访问这些入口时，需要改走当前账号的首个授权业务路径。
const AUTH_ENTRY_ROUTE_NAMES = new Set(['Login', 'Register']);

// 导航决策类型用于路由守卫把纯逻辑结果转换为 Vue Router 返回值。
export const NAVIGATION_DECISION_TYPES = Object.freeze({
  ALLOW: 'allow',
  RETRY: 'retry',
  REDIRECT: 'redirect',
  NOT_FOUND: 'not-found'
});

// 按服务端原有顺序递归扁平化菜单树，父菜单始终排在其子菜单之前。
export function flattenMenus(menus = []) {
  if (!Array.isArray(menus)) return [];
  return menus.flatMap((menu) => [menu, ...flattenMenus(menu?.children || [])]);
}

// 合并后端历史数据中的重复菜单，同时保留首个菜单节点及各重复节点的子项。
export function dedupeMenuTree(menus = []) {
  if (!Array.isArray(menus)) return [];
  const menuById = new Map();
  const menuByRoute = new Map();
  const result = [];

  const append = (source, parent) => {
    if (!source || typeof source !== 'object') return;
    const numericId = Number(source.id);
    const menuId = Number.isSafeInteger(numericId) && numericId > 0 ? numericId : null;
    const routePath = getMenuRoutePath(source);
    const existing = (menuId && menuById.get(menuId)) || (routePath && menuByRoute.get(routePath));
    if (existing) {
      (source.children || []).forEach((child) => append(child, existing.children));
      return;
    }

    const menu = { ...source, children: [] };
    if (menuId) menuById.set(menuId, menu);
    if (routePath) menuByRoute.set(routePath, menu);
    parent.push(menu);
    (source.children || []).forEach((child) => append(child, menu.children));
  };

  menus.forEach((menu) => append(menu, result));
  return result;
}

// 读取并清理菜单路由路径，非法值统一返回空字符串。
export function getMenuRoutePath(menu = {}) {
  return typeof menu?.routePath === 'string' ? menu.routePath.trim() : '';
}

// 判断菜单是否为可导航业务页面，目录仅保留菜单结构，不注册为迁移占位路由。
export function isBusinessRouteMenu(menu = {}) {
  const routePath = getMenuRoutePath(menu);
  return menu?.menuType === 'menu'
    && routePath.startsWith('/')
    && !routePath.startsWith('//')
    && !RESERVED_ROUTE_PATHS.has(routePath);
}

// 将单个服务端页面菜单投影为动态路由公共合同，组件实例仍由可信 componentMap 注入。
export function projectDynamicRouteContract(menu = {}) {
  if (!isBusinessRouteMenu(menu)) return null;
  return {
    path: getMenuRoutePath(menu),
    name: `menu-${menu.id}`,
    componentKey: typeof menu.component === 'string' ? menu.component.trim() : '',
    meta: {
      title: typeof menu.menuName === 'string' ? menu.menuName : '',
      permission: menu.permissionCode || null
    }
  };
}

// 查找当前账号按菜单顺序获得的第一个授权业务路径，无可用菜单时返回空字符串。
export function findFirstAuthorizedBusinessPath(menus = []) {
  const firstMenu = flattenMenus(menus).find((menu) => isBusinessRouteMenu(menu));
  return getMenuRoutePath(firstMenu);
}

// 校验登录页 redirect 仅指向站内绝对路径，无合法目标时统一回到根入口。
export function resolveLoginRedirect(redirect) {
  if (typeof redirect !== 'string') return '/';
  const targetPath = redirect.trim();
  return targetPath.startsWith('/') && !targetPath.startsWith('//') ? targetPath : '/';
}

// 计算会话失效后的登录跳转；bootstrap 期间交由当前守卫保留原始目标，登录页不重复跳转。
export function getUnauthenticatedLoginLocation(options = {}) {
  if (options.bootstrapActive || options.currentRouteName === 'Login') return null;
  return {
    name: 'Login',
    query: { redirect: options.currentFullPath || '/' }
  };
}

// 判断重新解析得到的路由是否属于本轮已注册的动态业务路由。
function isRegisteredBusinessRoute(routeName, registeredRouteNames) {
  if (!routeName || !registeredRouteNames) return false;
  if (typeof registeredRouteNames.has === 'function') return registeredRouteNames.has(routeName);
  return Array.isArray(registeredRouteNames) && registeredRouteNames.includes(routeName);
}

// 根据授权路由初始化结果返回稳定决策，确保动态 URL 最多 replace 重试一次且空菜单不进入空壳。
export function decideAuthorizedNavigation(options = {}) {
  const targetName = options.targetName || '';
  const targetPath = options.targetPath || '';
  const targetFullPath = options.targetFullPath || targetPath || '/';
  const firstBusinessPath = options.firstBusinessPath || '';

  if (options.routesInitializedThisTurn
    && isRegisteredBusinessRoute(options.resolvedRouteName, options.registeredRouteNames)) {
    return { type: NAVIGATION_DECISION_TYPES.RETRY, path: targetFullPath };
  }

  const needsAuthorizedLanding = targetPath === '/'
    || AUTH_ENTRY_ROUTE_NAMES.has(targetName)
    || targetName === 'NotFound';
  if (!needsAuthorizedLanding) return { type: NAVIGATION_DECISION_TYPES.ALLOW };

  if (firstBusinessPath && firstBusinessPath !== targetPath) {
    return { type: NAVIGATION_DECISION_TYPES.REDIRECT, path: firstBusinessPath };
  }
  if (targetName === 'NotFound') return { type: NAVIGATION_DECISION_TYPES.ALLOW };
  return { type: NAVIGATION_DECISION_TYPES.NOT_FOUND };
}
