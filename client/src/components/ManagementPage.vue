<template>
  <section class="management-page">
    <header class="page-header">
      <div class="page-heading">
        <h1 class="page-title">{{ title }}</h1>
        <slot name="title-extra" />
      </div>
      <div v-if="$slots.actions" class="action-row"><slot name="actions" /></div>
    </header>
    <slot />
  </section>
</template>

<script setup>
defineProps({ title: { type: String, required: true } });
</script>

<style scoped>
.management-page{display:grid;width:100%;min-width:0;max-width:100%;gap:16px}.page-header{margin:0}.page-heading{display:flex;align-items:center;gap:4px}.page-title{font-size:22px;letter-spacing:.01em}
</style>
