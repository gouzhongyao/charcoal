<template>
  <div class="strict-utc-date-time-field">
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
      :aria-invalid="isInvalid ? 'true' : 'false'"
      :aria-describedby="isInvalid ? errorMessageId : undefined"
      @update:model-value="handlePickerModelUpdate"
      @change="handlePickerChange"
      @blur="handlePickerBlur"
    />
    <p
      v-if="isInvalid"
      :id="errorMessageId"
      class="strict-utc-date-time-error"
      role="alert"
    >{{ validationError }}</p>
  </div>
</template>

<script setup>
import { computed, getCurrentInstance, ref, watch } from 'vue';
import { parseStrictUtcDateTime } from '@/utils/dateTimeFields';

// 组件属性模块：外部模型只接受严格 UTC 字符串；null 或空字符串表示未填写。
const props = defineProps({
  modelValue: { type: String, default: null },
  disabled: { type: Boolean, default: false },
  clearable: { type: Boolean, default: true },
  placeholder: { type: String, default: 'YYYY-MM-DDTHH:mm:ssZ' }
});

// 组件事件模块：非法输入显式通知父级，父级据此阻止查询或写入旧模型。
const emit = defineEmits(['update:modelValue', 'change', 'blur', 'validity-change', 'invalid']);

// 选择器模型：使用带字面量 Z 的字符串，禁止 Date 或本地时区转换。
const pickerValue = ref(null);
// 校验错误：非法格式、真实日历或精度错误均显示中文原因。
const validationError = ref('');
// 组件实例标识：构造稳定的 ARIA 错误说明关联 ID。
const componentUid = getCurrentInstance()?.uid ?? 'unknown';
// 错误说明 ID：同页多个 UTC 输入各自关联自己的错误文本。
const errorMessageId = `strict-utc-date-time-error-${componentUid}`;
// 非法状态：模板同步设置 aria-invalid 和错误区域。
const isInvalid = computed(() => Boolean(validationError.value));

// 方法模块：模型同步、显式校验状态与事件透传。

/**
 * 发布当前合法性；非法时同时发送包含中文原因和原输入的 invalid 事件。
 * @param {boolean} valid 是否合法。
 * @param {string|null} message 中文错误。
 * @param {unknown} value 原始输入。
 * @returns {void}
 */
function publishValidity(valid, message = null, value = null) {
  validationError.value = valid ? '' : (message || 'UTC 日期时间输入无效。');
  emit('validity-change', valid);
  if (!valid) emit('invalid', { message: validationError.value, value });
}

/**
 * 将外部模型同步到选择器并同步合法性，禁止把非法父模型静默隐藏成旧值。
 * @param {string|null} value 外部模型。
 * @returns {void}
 */
function synchronizePickerValue(value) {
  if (value === null || value === '') {
    pickerValue.value = null;
    publishValidity(true);
    return;
  }

  // 解析结果：零毫秒可无损规范为秒精度，非零毫秒与其他非法值保持错误状态。
  const result = parseStrictUtcDateTime(value);
  pickerValue.value = result.valid ? result.value : value;
  publishValidity(result.valid, result.message, value);
}

/**
 * 暂存并立即校验键盘或选择器输入；合法值同步父模型，非法值绝不提交旧模型。
 * @param {string|null} value 选择器值。
 * @returns {void}
 */
function handlePickerModelUpdate(value) {
  if (value === null || value === '') {
    pickerValue.value = null;
    publishValidity(true);
    emit('update:modelValue', null);
    return;
  }

  // 解析结果：输入阶段即通知父级非法状态，避免查询按钮提交仍保留的旧值。
  const result = parseStrictUtcDateTime(value);
  pickerValue.value = value;
  if (!result.valid) {
    publishValidity(false, result.message, value);
    return;
  }
  pickerValue.value = result.value;
  publishValidity(true);
  emit('update:modelValue', result.value);
}

/**
 * 处理选择器 change，仅发送严格 UTC 秒精度值；非法输入保持可见错误且不恢复旧模型。
 * @param {string|null} value 选择器值。
 * @returns {void}
 */
function handlePickerChange(value) {
  if (value === null || value === '') {
    pickerValue.value = null;
    publishValidity(true);
    emit('update:modelValue', null);
    emit('change', null);
    return;
  }

  // 解析结果：拒绝所有不能无损表示为秒精度的值。
  const result = parseStrictUtcDateTime(value);
  if (!result.valid) {
    pickerValue.value = value;
    publishValidity(false, result.message, value);
    return;
  }

  pickerValue.value = result.value;
  publishValidity(true);
  emit('update:modelValue', result.value);
  emit('change', result.value);
}

/** 原样透传 Element Plus 的 blur 事件。 */
function handlePickerBlur(event) {
  emit('blur', event);
}

// 模型监听：立即同步父组件初值，并响应后续受控更新。
watch(() => props.modelValue, synchronizePickerValue, { immediate: true });
</script>

<style scoped>
.strict-utc-date-time-field {
  width: 100%;
  max-width: 100%;
}
.strict-utc-date-time-input {
  width: 100%;
  max-width: 100%;
}
.strict-utc-date-time-error {
  margin: 4px 0 0;
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.4;
}
</style>
