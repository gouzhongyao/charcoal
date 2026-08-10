<template>
  <article class="cockpit-panel" :class="[`cockpit-panel--${status}`, { 'cockpit-panel--wide': wide }]" :aria-labelledby="headingId" :aria-busy="status === 'loading'">
    <header class="cockpit-panel__header">
      <div>
        <span class="cockpit-panel__eyebrow">{{ eyebrow }}</span>
        <h2 :id="headingId">{{ title }}</h2>
        <p v-if="description">{{ description }}</p>
      </div>
      <div class="cockpit-panel__actions"><slot name="actions" /></div>
    </header>

    <div v-if="status === 'loading'" class="cockpit-panel__state" role="status">
      <el-skeleton :rows="4" animated />
      <span>{{ loadingText }}</span>
    </div>
    <div v-else-if="status === 'forbidden'" class="cockpit-panel__state cockpit-panel__state--muted">
      <strong>无权限</strong>
      <span>{{ forbiddenText }}</span>
    </div>
    <div v-else-if="status === 'error'" class="cockpit-panel__state cockpit-panel__state--error" role="alert">
      <strong>读取失败</strong>
      <span>{{ error || '接口请求失败。' }}</span>
      <el-button type="primary" plain @click="$emit('retry')">重试此面板</el-button>
    </div>
    <div v-else-if="status === 'empty'" class="cockpit-panel__state cockpit-panel__state--empty">
      <slot name="empty">
        <strong class="cockpit-panel__zero">0</strong>
        <span>{{ emptyText }}</span>
      </slot>
    </div>
    <div v-else-if="status === 'success'" class="cockpit-panel__body">
      <slot />
    </div>
    <div v-else class="cockpit-panel__state cockpit-panel__state--muted">
      <span>等待加载。</span>
    </div>
  </article>
</template>

<script setup>
import { computed } from 'vue';

/** 驾驶舱面板输入属性。 */
const props = defineProps({
  title: { type: String, required: true },
  eyebrow: { type: String, default: 'DATA PANEL' },
  description: { type: String, default: '' },
  status: { type: String, default: 'idle' },
  error: { type: String, default: '' },
  loadingText: { type: String, default: '正在读取真实数据…' },
  forbiddenText: { type: String, default: '当前账号没有读取此领域数据的权限。' },
  emptyText: { type: String, default: '当前筛选范围暂无数据。' },
  wide: { type: Boolean, default: false }
});

/** 面板局部重试事件。 */
defineEmits(['retry']);

/** 面板标题的稳定可访问标识。 */
const headingId = computed(() => `cockpit-panel-${props.title.replace(/[^a-zA-Z0-9一-龥]+/g, '-')}`);
</script>

<style scoped>
.cockpit-panel{position:relative;min-width:0;padding:var(--cockpit-panel-padding,20px);border:1px solid var(--cockpit-border,#dce9fb);border-radius:var(--cockpit-panel-radius,14px);background:var(--cockpit-surface,#fff);box-shadow:var(--cockpit-panel-shadow,0 10px 28px rgba(30,91,180,.07));overflow:hidden}.cockpit-panel::before{content:"";position:absolute;inset:0 auto auto 0;width:var(--cockpit-panel-highlight-width,100%);height:var(--cockpit-panel-highlight-height,3px);background:var(--cockpit-panel-highlight,#1769e0)}.cockpit-panel--wide{grid-column:span 2}.cockpit-panel__header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}.cockpit-panel__eyebrow{display:block;margin-bottom:5px;color:var(--cockpit-accent,#1769e0);font-size:10px;font-weight:700;letter-spacing:.16em}.cockpit-panel h2{margin:0;color:var(--cockpit-heading,#123b79);font-size:18px}.cockpit-panel__header p{margin:7px 0 0;color:var(--cockpit-muted,#6d809e);font-size:12px;line-height:1.6}.cockpit-panel__actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.cockpit-panel__body{min-width:0}.cockpit-panel__state{min-height:180px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--cockpit-muted,#6d809e);text-align:center}.cockpit-panel__state strong{color:var(--cockpit-heading,#123b79);font-size:18px}.cockpit-panel__state--error strong{color:var(--cockpit-danger,#c24156)}.cockpit-panel__state--error span{max-width:520px;color:var(--cockpit-danger-text,#9f3348);line-height:1.6}.cockpit-panel__state--empty{min-height:160px}.cockpit-panel__zero{font-size:40px!important;color:var(--cockpit-accent,#1769e0)!important;font-variant-numeric:tabular-nums}.cockpit-panel__state--muted{opacity:.82}@media (max-width:960px){.cockpit-panel--wide{grid-column:span 1}}@media (max-width:640px){.cockpit-panel{padding:16px}.cockpit-panel__header{flex-direction:column}.cockpit-panel__actions{justify-content:flex-start}}
</style>
