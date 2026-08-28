<template>
  <header class="navbar">
    <el-button text @click="app.toggleSidebar"
      ><el-icon
        ><Fold v-if="!app.sidebarCollapsed" /><Expand v-else /></el-icon></el-button
    ><el-breadcrumb separator="/"
      ><el-breadcrumb-item v-for="item in route.matched" :key="item.path">{{
        item.meta.title || "首页"
      }}</el-breadcrumb-item></el-breadcrumb
    >
    <div class="nav-right">
      <!-- <el-tooltip content="点击配置 API Base"
        ><el-button text class="api-base" @click="configureApiBase">{{
          app.apiBase
        }}</el-button> </el-tooltip
      > -->
      
      <el-dropdown @command="onCommand"
        ><span class="account"
          ><el-avatar :size="30">{{
            user.profile?.displayName?.slice(0, 1) || "U"
          }}</el-avatar
          >{{ user.profile?.displayName || user.profile?.username }}</span
        ><template #dropdown
          ><el-dropdown-menu
            ><el-dropdown-item command="profile">用户中心</el-dropdown-item
            ><el-dropdown-item divided command="logout"
              >退出登录</el-dropdown-item
            ></el-dropdown-menu
          ></template
        ></el-dropdown
      >
    </div>
  </header>
</template>
<script setup>
import { useRouter, useRoute } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { useAppStore } from "@/stores/app";
import { useUserStore } from "@/stores/user";
import { resetDynamicRoutes } from "@/router";
const router = useRouter(),
  route = useRoute(),
  app = useAppStore(),
  user = useUserStore();
async function configureApiBase() {
  try {
    const {
      value,
    } = await ElMessageBox.prompt(
      "仅支持 /api 或 127.0.0.1、localhost、[::1] 上的 http(s) API 地址。",
      "配置 API Base",
      { inputValue: app.apiBase }
    );
    if (!app.setApiBase(value)) {
      ElMessage.error(
        "API Base 不受信任：仅允许同源 /api 或本机 loopback 地址，不能保存。"
      );
      return;
    }
    ElMessage.success("API Base 已保存。");
  } catch {}
}
async function onCommand(command) {
  if (command === "profile") router.push("/profile");
  else {
    await user.logout();
    resetDynamicRoutes();
    router.replace("/login");
  }
}
</script>
<style scoped>
.navbar {
  position: sticky;
  top: 0;
  z-index: 15;
  flex: 0 0 64px;
  width: 100%;
  min-width: 0;
  max-width: 100%;
  height: 64px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 22px;
  overflow-x: hidden;
  background: #fff;
  border-bottom: 1px solid #dce9fb;
}
.navbar :deep(.el-breadcrumb) {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
}
.nav-right {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 18px;
  min-width: 0;
  margin-left: auto;
}
.api-base {
  max-width: 260px;
  overflow: hidden;
  color: #6980a2;
  font: 12px ui-monospace, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  color: #25466e;
}
</style>
