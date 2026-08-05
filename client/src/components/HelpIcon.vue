<template>
  <el-tooltip :content="content" placement="top" :show-after="120">
    <el-button text circle class="help-icon" :aria-label="label"><el-icon><QuestionFilled /></el-icon></el-button>
  </el-tooltip>
</template>

<script setup>
defineProps({ content: { type: String, required: true }, label: { type: String, default: '查看说明' } });
</script>

<style scoped>.help-icon{color:#4c78b6}.help-icon:focus-visible{outline:2px solid #1769e0;outline-offset:2px}</style>
