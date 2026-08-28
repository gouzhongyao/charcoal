<template>
  <main class="auth-page">
    <section class="auth-card">
      <div>
        <p class="eyebrow">ENERGY & MONITORING</p>
        <h1>天坤集团能源监测系统</h1>
        <!-- <p>使用本地账号登录后按角色加载菜单与操作权限。</p> -->
      </div><el-form ref="formRef" :model="form" :rules="rules" @submit.prevent="submit"><el-form-item
          prop="username"><el-input v-model="form.username" placeholder="用户名"
            prefix-icon="User" /></el-form-item><el-form-item prop="password"><el-input v-model="form.password"
            placeholder="密码" type="password" show-password prefix-icon="Lock"
            @keyup.enter="submit" /></el-form-item><el-button type="primary" class="login-button" :loading="loading"
          @click="submit">登录</el-button></el-form>
      <div class="auth-links"><router-link to="/register">注册账号</router-link>
      </div>
    </section>
  </main>
</template>
<script setup>
import { reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { resolveLoginRedirect } from '@/utils/navigationRoutes';

// 路由实例负责在登录成功后恢复原站内目标或进入统一根入口。
const router = useRouter();
// 用户状态仓库负责登录凭证与用户资料。
const user = useUserStore();
// 登录表单实例用于执行 Element Plus 字段校验。
const formRef = ref();
// 提交加载状态用于防止重复登录。
const loading = ref(false);
// 登录表单保存当前输入的本地账号凭证。
const form = reactive({ username: '', password: '' });
// 表单规则约束用户名和密码均为必填项。
const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }]
};

// 提交登录并跳转到合法 redirect；无 redirect 时交由根路由选择首个授权业务页。
async function submit() {
  if (!(await formRef.value.validate().catch(() => false))) return;
  loading.value = true;
  try {
    await user.login(form);
    ElMessage.success('登录成功。');
    const redirectTarget = resolveLoginRedirect(router.currentRoute.value.query.redirect);
    router.replace(redirectTarget);
  } catch (error) {
    ElMessage.error(error.message);
  } finally {
    loading.value = false;
  }
}
</script>
<style scoped>
.auth-page {
  display: grid;
  min-height: 100vh;
  place-items: center;
  padding: 24px;
  background: radial-gradient(circle at 12% 12%, #78adff, transparent 32%), linear-gradient(135deg, #0e2b6d, #1769df)
}

.auth-card {
  width: min(440px, 100%);
  padding: 38px;
  background: rgba(255, 255, 255, .97);
  border-radius: 20px;
  box-shadow: 0 24px 55px rgba(2, 22, 69, .28)
}

.eyebrow {
  color: #1769e0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .12em
}

.auth-card h1 {
  color: #143b7a;
  font-size: 26px
}

.auth-card p:not(.eyebrow) {
  color: #6b7f9d;
  line-height: 1.7
}

.auth-card .el-form {
  margin-top: 28px
}

.login-button {
  width: 100%
}

.auth-links {
  display: flex;
  justify-content: space-between;
  margin-top: 18px;
  font-size: 13px
}

.auth-links a {
  color: #3374cf;
  text-decoration: none
}
</style>
