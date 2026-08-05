<template>
  <el-tag :type="type" effect="light" size="small">{{ label }}</el-tag>
</template>

<script setup>
import { computed } from 'vue';
const props = defineProps({ status: { type: String, default: 'unknown' }, label: String });
const definitions = {
  active: ['success', '启用'], inactive: ['info', '停用'],
  'meter-linked': ['success', '仪表已关联'], 'organization-linked': ['primary', '组织已关联'], unlinked: ['info', '未关联台账'],
  'candidate-by-meter': ['warning', '仪表候选'], 'candidate-by-organization': ['warning', '组织候选'],
  'already-linked': ['success', '已完整关联'], 'already-partial': ['info', '已有部分关联'], ambiguous: ['warning', '候选不唯一'], missing: ['info', '未匹配'], blocked: ['danger', '规则阻断']
};
const type = computed(() => definitions[props.status]?.[0] || 'info');
const label = computed(() => props.label || definitions[props.status]?.[1] || props.status || '未知');
</script>
