<template>
  <div class="management-toolbar">
    <div class="toolbar-filters"><slot /></div>
    <div class="action-row">
      <el-button @click="$emit('reset')">重置</el-button>
      <el-button type="primary" :loading="loading" @click="$emit('search')">查询</el-button>
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup>
defineProps({ loading: Boolean });
defineEmits(['search', 'reset']);
</script>

<style scoped>
.management-toolbar{display:flex;align-items:flex-end;justify-content:space-between;flex-wrap:wrap;gap:12px;padding:16px;background:#fff;border:1px solid #dce9fb;border-radius:12px;box-shadow:0 8px 20px rgba(28,83,158,.05)}.toolbar-filters{display:flex;align-items:flex-end;flex-wrap:wrap;gap:12px}.action-row{flex:0 0 auto}@media (max-width:900px){.management-toolbar{align-items:stretch}.action-row{width:100%;justify-content:flex-end}}
</style>
