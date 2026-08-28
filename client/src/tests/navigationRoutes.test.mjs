import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const routerSource = readFileSync(new URL('../router/index.js', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../layouts/Sidebar.vue', import.meta.url), 'utf8');
const navbarSource = readFileSync(new URL('../layouts/Navbar.vue', import.meta.url), 'utf8');

// 个人中心应是经 Shell 和登录守卫保护的固定路由，而不是依赖动态菜单注册。
assert.match(routerSource, /path: '\/profile', name: 'Profile', component: Profile/);
assert.equal(routerSource.includes("'profile/index': Profile"), false);

// 导入中心仍由固定安全组件映射承载，后端只调整其菜单层级。
assert.match(routerSource, /'imports\/index': ImportCenter/);

// 即使收到旧会话缓存的个人中心菜单，侧栏也不能显示该入口。
assert.match(sidebarSource, /v-for="menu in visibleMenus"/);
assert.match(sidebarSource, /permissions\.menus\.filter\(\(menu\)=>menu\.routePath!=='\/profile'\)/);

// 用户下拉菜单保留个人中心路由动作和退出登录动作。
assert.match(navbarSource, /command="profile"/);
assert.match(
  navbarSource,
  /async function onCommand\s*\(\s*command\s*\)[\s\S]*?if\s*\(\s*command\s*===\s*["']profile["']\s*\)[\s\S]*?router\.push\(\s*["']\/profile["']\s*\)/
);
assert.match(navbarSource, /command="logout"/);

console.log('navigation route contracts passed');
