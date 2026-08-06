<template><div class="shell"><Sidebar /><section class="shell-main"><Navbar /><main><router-view v-slot="{ Component }"><RouteErrorBoundary :route-key="route.fullPath"><component :is="Component" /></RouteErrorBoundary></router-view></main></section></div></template>
<script setup>
import { defineComponent, h, onErrorCaptured, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PageState from '@/components/PageState.vue';
import Sidebar from './Sidebar.vue';
import Navbar from './Navbar.vue';

const route = useRoute();
// 二级页面渲染异常时保留布局并显示可读错误，路由切换后自动重置错误状态。
const RouteErrorBoundary = defineComponent({
  name: 'RouteErrorBoundary',
  props: { routeKey: { type: String, default: '' } },
  setup(props, { slots }) {
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
<style scoped>.shell{display:flex;min-height:100vh;background:linear-gradient(135deg,#eff6ff,#f7fbff)}.shell-main{min-width:0;flex:1}main{padding:22px;}</style>
