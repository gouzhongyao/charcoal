<template>
  <el-drawer v-model="open" :title="title" size="520px" destroy-on-close>
    <slot />
    <template #footer><div class="action-row"><el-button @click="open=false">取消</el-button><el-button type="primary" :disabled="confirmDisabled" :loading="loading" @click="$emit('save')">{{ confirmLabel }}</el-button></div></template>
  </el-drawer>
</template>

<script setup>
import { computed } from 'vue';
const props = defineProps({ modelValue: Boolean, title: String, loading: Boolean, confirmLabel: { type: String, default: '保存' }, confirmDisabled: Boolean });
const emit = defineEmits(['update:modelValue', 'save']);
const open = computed({ get: () => props.modelValue, set: (value) => emit('update:modelValue', value) });
</script>
