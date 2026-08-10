<template>
  <div class="shell" :class="{ 'shell--immersive': appStore.immersiveMode }">
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
import { defineComponent, h, onErrorCaptured, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PageState from '@/components/PageState.vue';
import { useAppStore } from '@/stores/app';
import Sidebar from './Sidebar.vue';
import Navbar from './Navbar.vue';

/** 当前路由用于隔离二级页面渲染错误。 */
const route = useRoute();
/** 应用布局状态，沉浸模式不改变侧栏折叠状态。 */
const appStore = useAppStore();

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
.shell{display:flex;min-height:100vh;background:linear-gradient(135deg,#eff6ff,#f7fbff)}.shell-main{min-width:0;flex:1}.shell main{padding:22px}.shell--immersive{display:block;background:#020b18}.shell-content--immersive{min-height:100vh;padding:0!important}@media (max-width:720px){.shell main{padding:14px}.shell-content--immersive{padding:0!important}}
</style>
