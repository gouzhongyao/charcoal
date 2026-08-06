import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import zhCn from 'element-plus/es/locale/lang/zh-cn';
import 'element-plus/dist/index.css';
import * as ElementPlusIconsVue from '@element-plus/icons-vue';
import App from './App.vue';
import router from './router';
import { createPinia } from 'pinia';
import hasPermi from './directives/hasPermi';
import './theme.css';

const app = createApp(App);
const pinia = createPinia();
Object.entries(ElementPlusIconsVue).forEach(([name, component]) => app.component(name, component));
app.use(pinia).use(router).use(ElementPlus, { locale: zhCn }).directive('has-permi', hasPermi);
app.mount('#app');
