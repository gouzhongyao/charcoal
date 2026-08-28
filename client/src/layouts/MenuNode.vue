<template>
  <el-sub-menu
    v-if="menu.children?.length"
    :index="String(menu.id)"
    :data-menu-id="String(menu.id)"
    :data-menu-parent-id="normalizedParentId"
  >
    <template #title>
      <el-icon v-if="icon"><component :is="icon" /></el-icon>
      <span>{{ menu.menuName }}</span>
    </template>
    <MenuNode
      v-for="child in menu.children"
      :key="child.id"
      :menu="child"
      :parent-id="menu.id"
    />
  </el-sub-menu>
  <el-menu-item
    v-else
    :index="menu.routePath"
    :data-menu-id="String(menu.id)"
    :data-menu-parent-id="normalizedParentId"
  >
    <el-icon v-if="icon"><component :is="icon" /></el-icon>
    <template #title>{{ menu.menuName }}</template>
  </el-menu-item>
</template>

<script setup>
import { computed } from 'vue';

/** 当前服务端授权菜单节点和父目录标识。 */
const props = defineProps({
  menu: { type: Object, required: true },
  parentId: { type: [Number, String], default: '' }
});
/** 菜单图标组件名称，未配置时沿用默认菜单图标。 */
const icon = computed(() => props.menu.icon || 'Menu');
/** 标准化父目录标识，供折叠态 teleported 子菜单键盘定位。 */
const normalizedParentId = computed(() => String(props.parentId ?? ''));
</script>
