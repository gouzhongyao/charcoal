<template>
  <div class="shell" :class="{ 'shell--immersive': appStore.immersiveMode, 'shell--sidebar-collapsed': appStore.sidebarCollapsed }">
    <Sidebar v-if="!appStore.immersiveMode" />
    <section class="shell-main">
      <Navbar v-if="!appStore.immersiveMode" />
      <main :class="{ 'shell-content--immersive': appStore.immersiveMode }">
        <router-view v-slot="{ Component }">
          <RouteErrorBoundary :route-key="route.fullPath"><component :is="Component" /></RouteErrorBoundary>
        </router-view>
      </main>
    </section>
  </div>
</template>

<script setup>
import { defineComponent, h, onBeforeUnmount, onErrorCaptured, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PageState from '@/components/PageState.vue';
import { useAppStore } from '@/stores/app';
import Sidebar from './Sidebar.vue';
import Navbar from './Navbar.vue';

/** 当前路由用于隔离二级页面渲染错误。 */
const route = useRoute();
/** 应用布局状态，沉浸模式不改变侧栏折叠状态。 */
const appStore = useAppStore();
/** 窄屏侧栏媒体查询，用于在视口变窄时复用现有折叠状态。 */
let sidebarCompactQuery = null;

/** 窄屏时自动收起侧栏，恢复宽屏后保留用户最后一次折叠选择。 */
function syncSidebarForViewport() {
  if (sidebarCompactQuery?.matches) appStore.setSidebarCollapsed(true);
}

/** 响应侧栏断点变化。 */
function handleSidebarViewportChange() {
  syncSidebarForViewport();
}

onMounted(() => {
  sidebarCompactQuery = window.matchMedia('(max-width: 900px)');
  syncSidebarForViewport();
  if (typeof sidebarCompactQuery.addEventListener === 'function') {
    sidebarCompactQuery.addEventListener('change', handleSidebarViewportChange);
  } else {
    sidebarCompactQuery.addListener(handleSidebarViewportChange);
  }
});

onBeforeUnmount(() => {
  if (!sidebarCompactQuery) return;
  if (typeof sidebarCompactQuery.removeEventListener === 'function') {
    sidebarCompactQuery.removeEventListener('change', handleSidebarViewportChange);
  } else {
    sidebarCompactQuery.removeListener(handleSidebarViewportChange);
  }
  sidebarCompactQuery = null;
});

/** 二级页面渲染异常时保留布局并显示可读错误，路由切换后自动重置。 */
const RouteErrorBoundary = defineComponent({
  name: 'RouteErrorBoundary',
  props: { routeKey: { type: String, default: '' } },
  setup(props, { slots }) {
    /** 当前路由页面渲染错误。 */
    const error = ref('');
    watch(() => props.routeKey, () => { error.value = ''; });
    onErrorCaptured((cause) => {
      error.value = cause instanceof Error ? cause.message : '页面运行异常，请返回后重试。';
      return false;
    });
    return () => (error.value ? h(PageState, { error: error.value }) : slots.default?.());
  }
});
</script>

<style scoped>
.shell{display:flex;width:100%;height:100dvh;min-width:0;max-width:100%;min-height:0;max-height:100dvh;overflow:hidden;background:linear-gradient(135deg,#eff6ff,#f7fbff)}.shell-main{display:flex;flex-direction:column;min-width:0;max-width:100%;height:100dvh;min-height:0;max-height:100dvh;flex:1 1 auto;margin-left:238px;overflow:hidden}.shell--sidebar-collapsed .shell-main{margin-left:64px}.shell main{flex:1 1 0;height:0;min-width:0;max-width:100%;min-height:0;padding:22px;overflow-x:scroll;overflow-y:auto;overscroll-behavior-x:contain;scrollbar-gutter:stable;scrollbar-color:#5b7394 #dce9f8;scrollbar-width:auto}.shell main::-webkit-scrollbar{width:12px;height:14px}.shell main::-webkit-scrollbar-track{background:#dce9f8;border-radius:7px}.shell main::-webkit-scrollbar-thumb{background:#5b7394;border:3px solid #dce9f8;border-radius:7px}.shell main::-webkit-scrollbar-thumb:hover{background:#1769e0}.shell main::-webkit-scrollbar-corner{background:#dce9f8}.shell--immersive{display:block;width:100%;height:100dvh;min-height:0;background:#020b18;overflow:hidden}.shell--immersive .shell-main{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;margin-left:0;overflow:hidden}.shell--immersive main.shell-content--immersive{flex:1 1 auto;width:100%;height:100%;min-height:0;overflow:hidden;padding:0!important}@media (max-width:900px){.shell main{padding:14px}}@media (max-width:720px){.shell main{padding:14px}.shell-content--immersive{padding:0!important}}
</style>
