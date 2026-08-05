<template>
  <div class="page-state">
    <template v-if="loading"><el-icon class="is-loading"><Loading /></el-icon><span>正在加载...</span></template>
    <el-result v-else-if="error" icon="error" title="读取失败" :sub-title="error"><template #extra><el-button @click="$emit('retry')">重试</el-button></template></el-result>
    <el-empty v-else :description="description || '暂无数据'" />
  </div>
</template>

<script setup>
defineProps({ loading: Boolean, error: String, description: String });
defineEmits(['retry']);
</script>

<style scoped>.page-state{display:grid;place-items:center;min-height:168px;color:#6d809e}.page-state :deep(.el-result){padding:8px}</style>
