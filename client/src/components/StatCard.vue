<template>
  <article class="stat-card">
    <span class="label">{{ label }}</span>
    <strong>{{ value }}</strong>
    <small>{{ note || '—' }}</small>
  </article>
</template>

<script setup>
defineProps({ label: { type: String, required: true }, value: { type: [String, Number], required: true }, note: String });
</script>

<style scoped>
.stat-card{min-height:116px;padding:18px;background:linear-gradient(145deg,#fff,#f8fbff);border:1px solid #dce9fb;border-top:3px solid #1769e0;border-radius:12px;box-shadow:0 8px 22px rgba(28,83,158,.06)}.label,small{display:block;color:#7385a2}.label{font-size:13px;font-weight:600}.stat-card strong{display:block;margin:8px 0;color:#155bc2;font-size:27px;line-height:1.15;font-weight:750}.stat-card small{line-height:1.45}
</style>
