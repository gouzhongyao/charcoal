<template>
  <el-time-picker
    class="time-of-day-input"
    editable
    :model-value="pickerValue"
    format="HH:mm"
    value-format="HH:mm"
    :disabled="disabled"
    :clearable="clearable"
    :placeholder="placeholder"
    @update:model-value="handlePickerModelUpdate"
    @change="handlePickerChange"
    @blur="handlePickerBlur"
  />
</template>

<script setup>
import { ref, watch } from 'vue';
import { formatMinutesAsTimeOfDay, parseTimeOfDayToMinutes } from '@/utils/dateTimeFields';

// 组件属性：外部模型使用 0 至 1439 的整数分钟，null 表示清空。
const props = defineProps({
  modelValue: { type: Number, default: null },
  disabled: { type: Boolean, default: false },
  clearable: { type: Boolean, default: true },
  placeholder: { type: String, default: 'HH:mm' }
});

// 组件事件：更新与 change 发送整数分钟或明确的清空值 null，blur 原样透传。
const emit = defineEmits(['update:modelValue', 'change', 'blur']);

// 选择器模型：Element Plus 仅负责可编辑 HH:mm 展示，业务模型继续使用分钟数。
const pickerValue = ref(null);

// 方法模块：模型同步与事件透传。

/**
 * 将外部分钟模型同步为 HH:mm 选择器字符串。
 * @param {number|null} value 外部分钟模型。
 * @returns {void}
 */
function synchronizePickerValue(value) {
  // 格式化结果：空模型映射为空选择器，非法范围不进行取整或环绕修正。
  const formattedValue = formatMinutesAsTimeOfDay(value);
  pickerValue.value = formattedValue === '' || formattedValue === null ? null : formattedValue;
}

/**
 * 暂存选择器输入，等待 change 时校验并转换为分钟模型。
 * @param {string|null} value 选择器值。
 * @returns {void}
 */
function handlePickerModelUpdate(value) {
  pickerValue.value = value || null;
}

/**
 * 将选择器变更转换为分钟模型；清空统一发出 null，不使用 0 代替空值。
 * @param {string|null} value 选择器值。
 * @returns {void}
 */
function handlePickerChange(value) {
  // 解析结果：严格区分 00:00 对应的 0 与清空对应的 null。
  const result = parseTimeOfDayToMinutes(value);
  if (!result.valid) {
    synchronizePickerValue(props.modelValue);
    return;
  }

  pickerValue.value = result.cleared ? null : value;
  emit('update:modelValue', result.value);
  emit('change', result.value);
}

/**
 * 原样透传 Element Plus 的 blur 事件。
 * @param {FocusEvent} event 焦点事件。
 * @returns {void}
 */
function handlePickerBlur(event) {
  emit('blur', event);
}

// 模型监听：立即同步父组件初值，并响应后续受控更新。
watch(() => props.modelValue, synchronizePickerValue, { immediate: true });
</script>

<style scoped>
.time-of-day-input {
  width: 100%;
  max-width: 100%;
}
</style>
