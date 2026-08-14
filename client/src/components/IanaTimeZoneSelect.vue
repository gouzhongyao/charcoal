<template>
  <el-select
    class="iana-time-zone-select"
    :model-value="modelValue"
    filterable
    :clearable="clearable"
    :disabled="disabled"
    :placeholder="placeholder"
    @update:model-value="handleModelUpdate"
    @change="handleChange"
    @blur="handleBlur"
  >
    <el-option
      v-for="option in timeZoneOptions"
      :key="option.value"
      :label="option.label"
      :value="option.value"
      :disabled="option.disabled"
    />
  </el-select>
</template>

<script setup>
import { computed } from 'vue';
import { buildIanaTimeZoneOptions } from '@/utils/ianaTimeZones';

// 组件属性：模型值始终使用完整 IANA 标识；历史未知值只回显，不自动清空。
const props = defineProps({
  modelValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  clearable: { type: Boolean, default: true },
  placeholder: { type: String, default: '请选择或搜索 IANA 时区' }
});

// 组件事件：保持 Element Plus 选择器的受控模型、change 与 blur 契约。
const emit = defineEmits(['update:modelValue', 'change', 'blur']);

// 时区选项：静态稳定候选与运行时补充合并，当前历史值不存在时增加禁用回显项。
const timeZoneOptions = computed(() => buildIanaTimeZoneOptions(props.modelValue));

// 方法模块：模型更新与事件透传。

/**
 * 透传完整 IANA 标识或清空值，不允许创建候选外的新值。
 * @param {string|null|undefined} value 选择器模型值。
 * @returns {void}
 */
function handleModelUpdate(value) {
  emit('update:modelValue', value || '');
}

/**
 * 透传选择器 change 事件。
 * @param {string|null|undefined} value 选择器模型值。
 * @returns {void}
 */
function handleChange(value) {
  emit('change', value || '');
}

/**
 * 原样透传 Element Plus 的 blur 事件。
 * @param {FocusEvent} event 焦点事件。
 * @returns {void}
 */
function handleBlur(event) {
  emit('blur', event);
}
</script>

<style scoped>
.iana-time-zone-select {
  width: 100%;
  max-width: 100%;
}
</style>
