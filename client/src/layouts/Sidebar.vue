<template>
  <aside :class="['sidebar', { collapsed: app.sidebarCollapsed }]" aria-label="主菜单">
    <div class="brand"><el-icon><Lightning /></el-icon><span v-show="!app.sidebarCollapsed">能源监测平台</span></div>
    <div
      ref="menuScrollRegionRef"
      class="menu-scroll-region"
      role="region"
      aria-label="侧栏菜单键盘导航区域"
      @keydown="handleMenuKeydown"
    >
      <el-menu
        :collapse="app.sidebarCollapsed"
        :default-active="route.path"
        :router="true"
        background-color="transparent"
        text-color="#c9dcff"
        active-text-color="#fff"
      >
        <MenuNode v-for="menu in visibleMenus" :key="menu.id" :menu="menu" />
      </el-menu>
    </div>
  </aside>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { usePermissionStore } from '@/stores/permission';
import MenuNode from './MenuNode.vue';

/** 当前路由用于同步菜单激活项。 */
const route = useRoute();
/** 应用侧栏状态，继续复用既有折叠和路由菜单行为。 */
const app = useAppStore();
/** 当前用户授权菜单，用于过滤个人中心固定入口。 */
const permissions = usePermissionStore();
/** 侧栏菜单滚动区域引用，用于键盘滚动访问隐藏滚动条后的菜单。 */
const menuScrollRegionRef = ref(null);
/** 侧栏中实际展示的业务菜单。 */
const visibleMenus = computed(() => permissions.menus.filter((menu) => menu.routePath !== '/profile'));
/** 菜单 DOM 变化监听器，用于在授权菜单或展开状态变化后恢复 roving tabindex。 */
let menuKeyboardObserver = null;
/** 菜单键盘状态同步排队标记，避免一次 DOM 更新触发多次扫描。 */
let menuKeyboardSyncQueued = false;
/** 折叠态目录展开后的子项聚焦定时器。 */
let submenuFocusTimer = null;

/** 判断菜单入口是否实际可用，过滤折叠子菜单中的隐藏、禁用或未渲染入口。 */
function isVisibleMenuEntry(entry) {
  if (!(entry instanceof HTMLElement) || entry.classList.contains('is-disabled')) return false;
  const style = window.getComputedStyle(entry);
  return entry.getClientRects().length > 0 && style.display !== 'none' && style.visibility !== 'hidden';
}

/** 读取指定菜单树中的叶子项和目录项，顺序与实际渲染顺序一致。 */
function getMenuEntries(menuRoot) {
  if (!menuRoot) return [];
  return Array.from(menuRoot.querySelectorAll('.el-menu-item, .el-sub-menu')).filter(isVisibleMenuEntry);
}

/** 判断弹层是否属于当前侧栏菜单，避免接管页面内其他 Element Plus 菜单。 */
function isSidebarMenuPopup(popup) {
  return popup instanceof Element && Boolean(popup.querySelector('[data-menu-id]'));
}

/** 返回折叠菜单弹层根节点，支持 Element Plus teleported 菜单的键盘事件。 */
function getPopupRoot(target) {
  if (!(target instanceof Element)) return null;
  const popup = target.closest('.el-menu--popup');
  return isSidebarMenuPopup(popup) ? popup : null;
}

/** 将菜单入口和辅助功能状态同步到 Element Plus 生成的真实 DOM。 */
function syncMenuAccessibility(entries) {
  entries.forEach((entry) => {
    if (entry.classList.contains('el-menu-item')) {
      if (entry.classList.contains('is-active')) entry.setAttribute('aria-current', 'page');
      else entry.removeAttribute('aria-current');
    }
    if (entry.classList.contains('el-sub-menu')) {
      const expanded = entry.getAttribute('aria-expanded');
      if (expanded !== 'true' && expanded !== 'false') entry.setAttribute('aria-expanded', 'false');
    }
  });
}

/** 为可见菜单入口设置 roving tabindex，让 Tab 进入菜单后由方向键继续导航。 */
function syncMenuKeyboardEntries(menuRoot = menuScrollRegionRef.value) {
  const entries = getMenuEntries(menuRoot);
  if (!entries.length) return entries;

  const activeElement = document.activeElement;
  const focusEntry = entries.includes(activeElement)
    ? activeElement
    : entries.find((entry) => entry.tabIndex === 0)
      || entries.find((entry) => entry.classList.contains('el-menu-item') && entry.classList.contains('is-active'))
      || entries.find((entry) => entry.classList.contains('is-active'))
      || entries[0];

  entries.forEach((entry) => {
    entry.tabIndex = entry === focusEntry ? 0 : -1;
  });
  syncMenuAccessibility(entries);
  return entries;
}

/** 同步主菜单和已经打开的侧栏 teleported 弹层。 */
function syncAllMenuKeyboardEntries() {
  syncMenuKeyboardEntries();
  document.querySelectorAll('.el-menu--popup').forEach((popup) => {
    if (isSidebarMenuPopup(popup)) syncMenuKeyboardEntries(popup);
  });
}

/** 延迟一次菜单 DOM 扫描，等待 Vue 和 Element Plus 完成展开、激活状态更新。 */
function queueMenuKeyboardSync() {
  if (menuKeyboardSyncQueued) return;
  menuKeyboardSyncQueued = true;
  nextTick(() => {
    menuKeyboardSyncQueued = false;
    syncAllMenuKeyboardEntries();
  });
}

/** 移动菜单焦点并同步 roving tabindex，确保后续 Tab 仍回到当前入口。 */
function focusMenuEntry(menuRoot, entry) {
  if (!entry) return;
  const entries = getMenuEntries(menuRoot);
  entries.forEach((candidate) => {
    candidate.tabIndex = candidate === entry ? 0 : -1;
  });
  syncMenuAccessibility(entries);
  entry.focus({ preventScroll: true });
  if (typeof entry.scrollIntoView === 'function') entry.scrollIntoView({ block: 'nearest' });
}

/** 返回目录入口的直接可见子项，兼容折叠态 teleported 菜单弹层。 */
function getDirectSubmenuEntries(entry) {
  const localEntries = Array.from(entry.querySelectorAll(':scope > .el-menu > .el-menu-item, :scope > .el-menu > .el-sub-menu'))
    .filter(isVisibleMenuEntry);
  if (localEntries.length) return localEntries;

  const menuId = entry.dataset.menuId;
  if (!menuId) return [];
  return Array.from(document.querySelectorAll('[data-menu-parent-id]'))
    .filter((childEntry) => childEntry.dataset.menuParentId === menuId && isVisibleMenuEntry(childEntry));
}

/** 返回叶子入口所属的上级目录入口，用于 ArrowLeft 返回目录层级。 */
function getParentSubmenuEntry(entry) {
  const localParentEntry = entry.parentElement?.closest('.el-sub-menu');
  if (localParentEntry && localParentEntry !== entry) return localParentEntry;

  const parentId = entry.dataset.menuParentId;
  if (!parentId) return null;
  return Array.from(document.querySelectorAll('.el-sub-menu[data-menu-id]'))
    .find((candidate) => candidate.dataset.menuId === parentId) || null;
}

/** 返回当前入口所在菜单的父级菜单根，用于跨 teleported 弹层回焦。 */
function getMenuParentRoot(menuRoot, entry) {
  const parentEntry = getParentSubmenuEntry(entry);
  if (!parentEntry) return menuRoot;
  return getPopupRoot(parentEntry) || menuScrollRegionRef.value;
}

/** 触发 Element Plus 目录原有展开入口，折叠态使用悬浮事件切换弹层。 */
function activateSubmenuEntry(entry) {
  const title = entry.querySelector(':scope > .el-sub-menu__title') || entry.querySelector('.el-sub-menu__title');
  if (!title) return;

  if (app.sidebarCollapsed) {
    const eventName = entry.getAttribute('aria-expanded') === 'true' ? 'mouseleave' : 'mouseenter';
    entry.dispatchEvent(new MouseEvent(eventName, { bubbles: false }));
  } else {
    title.click();
  }
  queueMenuKeyboardSync();
}

/** 触发叶子菜单原有 click，使 Element Plus 继续负责路由跳转和激活态。 */
function activateMenuEntry(entry) {
  if (entry.classList.contains('el-sub-menu')) activateSubmenuEntry(entry);
  else entry.click();
}

/** 根据当前焦点执行上下左右方向键的 roving tabindex 导航。 */
function handleMenuArrowKey(event, menuRoot, entries, currentEntry) {
  if (!currentEntry) return false;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const currentIndex = entries.indexOf(currentEntry);
    const offset = event.key === 'ArrowDown' ? 1 : -1;
    const targetEntry = entries[(currentIndex + offset + entries.length) % entries.length];
    focusMenuEntry(menuRoot, targetEntry);
    return true;
  }

  if (event.key === 'ArrowRight' && currentEntry.classList.contains('el-sub-menu')) {
    if (currentEntry.getAttribute('aria-expanded') !== 'true') activateSubmenuEntry(currentEntry);
    window.clearTimeout(submenuFocusTimer);
    submenuFocusTimer = window.setTimeout(() => {
      const childEntry = getDirectSubmenuEntries(currentEntry)[0];
      const childMenuRoot = getPopupRoot(childEntry) || menuRoot;
      if (childEntry) focusMenuEntry(childMenuRoot, childEntry);
    }, app.sidebarCollapsed ? 350 : 0);
    return true;
  }

  if (event.key === 'ArrowLeft') {
    const parentEntry = getParentSubmenuEntry(currentEntry);
    if (!parentEntry) {
      if (currentEntry.classList.contains('el-sub-menu')
        && currentEntry.getAttribute('aria-expanded') === 'true') activateSubmenuEntry(currentEntry);
      return currentEntry.classList.contains('el-sub-menu');
    }
    if (parentEntry.getAttribute('aria-expanded') === 'true') activateSubmenuEntry(parentEntry);
    focusMenuEntry(getMenuParentRoot(menuRoot, currentEntry), parentEntry);
    return true;
  }

  return false;
}

/** 使用 PageUp、PageDown、Home 和 End 滚动主菜单容器。 */
function handleMenuScrollKey(event) {
  const menuElement = menuScrollRegionRef.value;
  if (!menuElement) return false;

  const maxScrollTop = Math.max(menuElement.scrollHeight - menuElement.clientHeight, 0);
  const pageSize = Math.max(menuElement.clientHeight - 32, 1);
  let targetScrollTop = menuElement.scrollTop;

  if (event.key === 'Home') targetScrollTop = 0;
  if (event.key === 'End') targetScrollTop = maxScrollTop;
  if (event.key === 'PageUp') targetScrollTop = Math.max(menuElement.scrollTop - pageSize, 0);
  if (event.key === 'PageDown') targetScrollTop = Math.min(menuElement.scrollTop + pageSize, maxScrollTop);

  event.preventDefault();
  menuElement.scrollTop = targetScrollTop;
  return true;
}

/** 处理菜单区域及 teleported 弹层的焦点、方向键和激活按键。 */
function handleMenuKeydown(event, menuRoot = menuScrollRegionRef.value) {
  if (['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
    handleMenuScrollKey(event);
    return;
  }

  const entries = syncMenuKeyboardEntries(menuRoot);
  const currentEntry = event.target instanceof Element
    ? event.target.closest('.el-menu-item, .el-sub-menu')
    : null;
  if (!currentEntry || !entries.includes(currentEntry)) return;

  let handled = handleMenuArrowKey(event, menuRoot, entries, currentEntry);
  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    activateMenuEntry(currentEntry);
    handled = true;
  }
  if (!handled) return;

  event.preventDefault();
  event.stopPropagation();
}

/** 处理折叠态 Element Plus teleported 菜单弹层的键盘事件。 */
function handleDocumentMenuKeydown(event) {
  const popupRoot = getPopupRoot(event.target);
  if (popupRoot) handleMenuKeydown(event, popupRoot);
}

/** 让 Tab 首次进入或切换到弹层时恢复对应菜单的 roving tabindex。 */
function handleDocumentMenuFocusin(event) {
  const popupRoot = getPopupRoot(event.target);
  if (popupRoot) syncMenuKeyboardEntries(popupRoot);
  else if (menuScrollRegionRef.value?.contains(event.target)) syncMenuKeyboardEntries();
}

onMounted(() => {
  syncAllMenuKeyboardEntries();
  if (typeof MutationObserver === 'function' && menuScrollRegionRef.value) {
    menuKeyboardObserver = new MutationObserver(queueMenuKeyboardSync);
    menuKeyboardObserver.observe(menuScrollRegionRef.value, {
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-expanded'],
      childList: true,
      subtree: true
    });
  }
  document.addEventListener('keydown', handleDocumentMenuKeydown);
  document.addEventListener('focusin', handleDocumentMenuFocusin);
});

watch([visibleMenus, () => app.sidebarCollapsed, () => route.path], () => {
  nextTick(syncAllMenuKeyboardEntries);
}, { deep: true });

onBeforeUnmount(() => {
  menuKeyboardObserver?.disconnect();
  menuKeyboardObserver = null;
  window.clearTimeout(submenuFocusTimer);
  submenuFocusTimer = null;
  document.removeEventListener('keydown', handleDocumentMenuKeydown);
  document.removeEventListener('focusin', handleDocumentMenuFocusin);
});
</script>

<style scoped>
.sidebar{position:fixed;inset:0 auto 0 0;z-index:20;width:238px;height:100dvh;max-height:100dvh;overflow:hidden;padding:18px 12px;background:linear-gradient(180deg,#102768,#1769df);transition:width .2s}.sidebar.collapsed{width:64px;padding-left:0;padding-right:0}.brand{display:flex;align-items:center;gap:10px;min-width:0;height:48px;padding:0 10px;color:#fff;font-weight:700;font-size:18px;white-space:nowrap;overflow:hidden}.brand .el-icon{flex:0 0 auto;font-size:24px}.sidebar.collapsed .brand{padding:0 10px}.menu-scroll-region{width:100%;max-width:100%;height:calc(100dvh - 84px);min-height:0;overflow-x:hidden;overflow-y:auto;scrollbar-width:none;-ms-overflow-style:none}.menu-scroll-region::-webkit-scrollbar{display:none;width:0;height:0}.sidebar.collapsed .menu-scroll-region{width:64px;max-width:64px}.el-menu{width:100%;max-width:100%;height:auto;border-right:0;overflow:visible}.menu-scroll-region :deep(.el-menu-item:focus-visible),.menu-scroll-region :deep(.el-sub-menu:focus-visible),.menu-scroll-region :deep(.el-sub-menu__title:focus-visible),:global(.el-menu--popup .el-menu-item:focus-visible),:global(.el-menu--popup .el-sub-menu:focus-visible){outline:2px solid #fbbf24;outline-offset:-2px;border-radius:8px}.el-menu :deep(.el-menu-item),.el-menu :deep(.el-sub-menu__title){border-radius:8px;margin:4px 0}.el-menu :deep(.el-menu-item.is-active){background:rgba(255,255,255,.16)}
</style>
