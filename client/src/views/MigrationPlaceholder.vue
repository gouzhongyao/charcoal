<template><section class="page-card"><h1 class="page-title">{{ title || '业务模块迁移中' }}</h1><p class="muted">该业务模块尚未迁移到 Vue3 前端壳。当前仅提供受权限控制的过渡路由，不代表业务页面已完成迁移。</p><el-alert type="info" :closable="false" title="需要回退参考旧版时，可访问 legacy.html。" show-icon /><p class="migration-note">旧版入口仅用于迁移期回退与功能参考；新功能请继续在 Vue3 壳内逐模块实现和验收。</p></section></template>
<script setup>defineProps({ title:String });</script>
