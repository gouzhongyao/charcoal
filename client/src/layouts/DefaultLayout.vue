<template><div class="shell"><Sidebar /><section class="shell-main"><Navbar /><main><router-view /></main></section></div></template>
<script setup>import Sidebar from './Sidebar.vue'; import Navbar from './Navbar.vue';</script>
<style scoped>.shell{display:flex;min-height:100vh;background:linear-gradient(135deg,#eff6ff,#f7fbff)}.shell-main{min-width:0;flex:1}main{padding:22px;}</style>
