<template><section class="page-card"><h1 class="page-title">{{ title || '当前功能不可用' }}</h1><p class="muted">当前功能暂不可用，请联系管理员检查菜单配置和访问权限。</p><el-alert type="warning" :closable="false" title="菜单配置异常或功能尚未开放。" description="请返回上一级菜单，或联系管理员确认当前账号的授权配置。" show-icon /></section></template>
<script setup>defineProps({ title:String });</script>
