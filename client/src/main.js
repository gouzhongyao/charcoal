import { createApp } from 'vue';
import ElementPlus from 'element-plus';
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
app.use(pinia).use(router).use(ElementPlus).directive('has-permi', hasPermi);
app.mount('#app');
