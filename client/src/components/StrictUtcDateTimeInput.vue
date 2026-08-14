<template>
  <el-date-picker
    class="strict-utc-date-time-input"
    type="datetime"
    editable
    :model-value="pickerValue"
    format="YYYY-MM-DDTHH:mm:ss[Z]"
    value-format="YYYY-MM-DDTHH:mm:ss[Z]"
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
import { parseStrictUtcDateTime } from '@/utils/dateTimeFields';

// 组件属性：外部模型只接受严格 UTC 字符串；null 或空字符串表示未填写。
const props = defineProps({
  modelValue: { type: String, default: null },
  disabled: { type: Boolean, default: false },
  clearable: { type: Boolean, default: true },
  placeholder: { type: String, default: 'YYYY-MM-DDTHH:mm:ssZ' }
});

// 组件事件：更新与 change 只发送规范 UTC 或 null，blur 原样透传焦点事件。
const emit = defineEmits(['update:modelValue', 'change', 'blur']);

// 选择器模型：使用带字面量 Z 的墙上时间字符串，禁止 Date 或本地时区转换。
const pickerValue = ref(null);

// 方法模块：模型同步与事件透传。

/**
 * 将外部严格 UTC 模型同步到 Element Plus 选择器。
 * @param {string|null} value 外部模型。
 * @returns {void}
 */
function synchronizePickerValue(value) {
  if (value === null || value === '') {
    pickerValue.value = null;
    return;
  }

  // 解析结果：零毫秒可无损规范为秒精度，非零毫秒与其他非法值不会被截断。
  const result = parseStrictUtcDateTime(value);
  pickerValue.value = result.valid ? result.value : null;
}

/**
 * 暂存选择器输入，等待 change 时完成严格校验后再更新外部模型。
 * @param {string|null} value 选择器值。
 * @returns {void}
 */
function handlePickerModelUpdate(value) {
  pickerValue.value = value || null;
}

/**
 * 处理选择器变更，仅透传严格 UTC 秒精度值；清空统一发出 null。
 * @param {string|null} value 选择器值。
 * @returns {void}
 */
function handlePickerChange(value) {
  if (value === null || value === '') {
    pickerValue.value = null;
    emit('update:modelValue', null);
    emit('change', null);
    return;
  }

  // 解析结果：拒绝所有不能无损表示为秒精度的值。
  const result = parseStrictUtcDateTime(value);
  if (!result.valid) {
    synchronizePickerValue(props.modelValue);
    return;
  }

  pickerValue.value = result.value;
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
.strict-utc-date-time-input {
  width: 100%;
  max-width: 100%;
}
</style>
