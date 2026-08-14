import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// 待执行生产模块源码路径。
const httpSourceUrl = new URL('../api/http.js', import.meta.url);
const demoDataSourceUrl = new URL('../api/demoData.js', import.meta.url);
const userSourceUrl = new URL('../stores/user.js', import.meta.url);

// 将生产模块依赖替换为可控 adapter，并保留被测函数与 action 的真实实现。
function replaceRequired(source, target, replacement, label) {
  assert(source.includes(target), `${label} 的生产 import 契约已变化，测试 adapter 需要同步。`);
  return source.replace(target, replacement);
}

// 从源码构造隔离的 data URL ESM 模块。
function moduleDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}

// 提供与 Web Storage 行为一致的内存实现，供纯逻辑生命周期测试使用。
class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  get length() {
    return this.values.size;
  }

  getItem(key) {
    return this.values.has(String(key)) ? this.values.get(String(key)) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  clear() {
    this.values.clear();
  }
}

// 写入两个演示 context 和一个无关的 sessionStorage 值。
function seedDemoContexts(storage) {
  storage.setItem('charcoal.demoContext.v1:artifact-a:handler-a', '{"token":"a"}');
  storage.setItem('charcoal.demoContext.v1:artifact-b:handler-b', '{"token":"b"}');
  storage.setItem('unrelated.session.key', 'preserve');
}

// 断言所有演示 context 已清理且无关 sessionStorage 保留。
function assertDemoContextsCleared(storage, messagePrefix) {
  assert.strictEqual(
    [...storage.values.keys()].some((key) => key.startsWith('charcoal.demoContext.v1:')),
    false,
    `${messagePrefix}必须清理全部演示 context。`
  );
  assert.strictEqual(storage.getItem('unrelated.session.key'), 'preserve', `${messagePrefix}不得清理无关 sessionStorage。`);
}

// 断言登录态和全部演示 context 均保持不变。
function assertSessionPreserved(localStorage, sessionStorage, messagePrefix) {
  assert.strictEqual(localStorage.getItem('charcoal.token'), 'login-token', `${messagePrefix}不得清理登录 token。`);
  assert.strictEqual(sessionStorage.getItem('charcoal.demoContext.v1:artifact-a:handler-a'), '{"token":"a"}', `${messagePrefix}不得清理第一个演示 context。`);
  assert.strictEqual(sessionStorage.getItem('charcoal.demoContext.v1:artifact-b:handler-b'), '{"token":"b"}', `${messagePrefix}不得清理第二个演示 context。`);
  assert.strictEqual(sessionStorage.getItem('unrelated.session.key'), 'preserve', `${messagePrefix}不得清理无关 sessionStorage。`);
}

// 保存 Node 全局对象，测试完成后恢复，避免污染同进程其他脚本。
const originalGlobals = {
  localStorage: globalThis.localStorage,
  sessionStorage: globalThis.sessionStorage,
  window: globalThis.window,
  CustomEvent: globalThis.CustomEvent,
  URL: globalThis.URL,
  document: globalThis.document,
  httpAdapter: globalThis.__CHARCOAL_HTTP_TEST_ADAPTER__,
  userRequest: globalThis.__CHARCOAL_USER_REQUEST__,
  clearDemoContexts: globalThis.__CHARCOAL_CLEAR_DEMO_CONTEXTS__,
  userStoreDefinition: globalThis.__CHARCOAL_USER_STORE_DEFINITION__
};

try {
  // 浏览器全局对象均为可控纯逻辑 stub；本测试不启动或声称使用真实浏览器。
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const dispatchedEvents = [];
  globalThis.localStorage = localStorage;
  globalThis.sessionStorage = sessionStorage;
  globalThis.CustomEvent = class TestCustomEvent {
    constructor(type) {
      this.type = type;
    }
  };
  globalThis.window = {
    dispatchEvent(event) {
      dispatchedEvents.push(event);
      return true;
    }
  };

  // Axios adapter 捕获生产 http.js 注册的拦截器，并让测试直接执行真实 error callback。
  const httpAdapter = {
    requestInterceptor: null,
    responseSuccessInterceptor: null,
    responseErrorInterceptor: null,
    async handle() {
      throw new Error('HTTP adapter 尚未配置响应。');
    }
  };
  globalThis.__CHARCOAL_HTTP_TEST_ADAPTER__ = httpAdapter;

  const httpAxiosStub = `
const axios = {
  create() {
    const instance = async (config) => globalThis.__CHARCOAL_HTTP_TEST_ADAPTER__.handle(config);
    instance.interceptors = {
      request: {
        use(callback) { globalThis.__CHARCOAL_HTTP_TEST_ADAPTER__.requestInterceptor = callback; }
      },
      response: {
        use(successCallback, errorCallback) {
          globalThis.__CHARCOAL_HTTP_TEST_ADAPTER__.responseSuccessInterceptor = successCallback;
          globalThis.__CHARCOAL_HTTP_TEST_ADAPTER__.responseErrorInterceptor = errorCallback;
        }
      }
    };
    return instance;
  }
};`;
  const httpElementPlusStub = 'const ElMessage = { warning(message) { globalThis.__CHARCOAL_HTTP_TEST_ADAPTER__.warnings.push(message); } };';
  const httpApiBaseStub = `
const applyTrustedAuthorization = () => {};
const applyTrustedDemoContext = () => {};
const normalizeApiBase = (value) => value;
const resolveApiBase = () => '/api';`;
  const httpAppStoreStub = "const useAppStore = () => ({ apiBase: '/api' });";
  let httpSource = await readFile(httpSourceUrl, 'utf8');
  httpSource = replaceRequired(httpSource, "import axios from 'axios';", httpAxiosStub, 'http.js');
  httpSource = replaceRequired(httpSource, "import { ElMessage } from 'element-plus';", httpElementPlusStub, 'http.js');
  httpSource = replaceRequired(
    httpSource,
    "import { applyTrustedAuthorization, applyTrustedDemoContext, normalizeApiBase, resolveApiBase } from '@/utils/apiBase';",
    httpApiBaseStub,
    'http.js'
  );
  httpSource = replaceRequired(httpSource, "import { useAppStore } from '@/stores/app';", httpAppStoreStub, 'http.js');
  httpAdapter.warnings = [];
  const httpModule = await import(moduleDataUrl(httpSource));
  assert.strictEqual(typeof httpAdapter.responseErrorInterceptor, 'function', '生产 http.js 必须向 Axios 注册响应错误拦截器。');

  // 真正认证 401 必须清登录 token、全部演示 context，并派发未认证事件。
  localStorage.setItem('charcoal.token', 'login-token');
  seedDemoContexts(sessionStorage);
  const unauthorizedError = {
    message: 'axios fallback',
    response: { status: 401, data: { error: { message: '登录已失效。' } } }
  };
  await assert.rejects(
    httpAdapter.responseErrorInterceptor(unauthorizedError),
    (error) => error === unauthorizedError && error.message === '登录已失效。',
    '401 必须继续向调用方 reject 原始错误并采用 API 错误文案。'
  );
  assert.strictEqual(localStorage.getItem('charcoal.token'), null, '401 必须清理 localStorage 登录 token。');
  assertDemoContextsCleared(sessionStorage, '401 ');
  assert.deepStrictEqual(dispatchedEvents.map((event) => event.type), ['charcoal:unauthenticated'], '401 必须派发一次未认证事件。');

  // demo 409/410 只是业务上下文错误，不得误清理登录态或当前标签页 context。
  for (const status of [409, 410]) {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('charcoal.token', 'login-token');
    seedDemoContexts(sessionStorage);
    const eventCountBefore = dispatchedEvents.length;
    const demoError = {
      message: 'axios fallback',
      response: { status, data: { error: { message: `演示 context ${status}` } } }
    };
    await assert.rejects(
      httpAdapter.responseErrorInterceptor(demoError),
      (error) => error === demoError && error.message === `演示 context ${status}`,
      `demo ${status} 必须继续向调用方 reject。`
    );
    assertSessionPreserved(localStorage, sessionStorage, `demo ${status} `);
    assert.strictEqual(dispatchedEvents.length, eventCountBefore, `demo ${status} 不得派发未认证事件。`);
  }

  // 以下只用最小纯逻辑 DOM stub 验证共享 download 的副作用，不代表真实浏览器下载验收。
  const downloadEffects = [];
  const testBlob = new Blob(['demo-content'], { type: 'application/octet-stream' });
  const testLink = {
    href: '',
    download: '',
    click() {
      downloadEffects.push(['click', this.href, this.download]);
    },
    remove() {
      downloadEffects.push(['remove']);
    }
  };
  globalThis.URL = {
    createObjectURL(blob) {
      downloadEffects.push(['createObjectURL', blob]);
      return 'blob:pure-logic-stub';
    },
    revokeObjectURL(url) {
      downloadEffects.push(['revokeObjectURL', url]);
    }
  };
  globalThis.document = {
    createElement(tagName) {
      downloadEffects.push(['createElement', tagName]);
      return testLink;
    },
    body: {
      appendChild(link) {
        downloadEffects.push(['appendChild', link]);
      }
    }
  };
  httpAdapter.handle = async (config) => {
    assert.deepStrictEqual(config, { url: '/test-download', method: 'get', responseType: 'blob' }, 'download 必须附加 blob 响应类型。');
    return {
      data: testBlob,
      headers: {
        'content-disposition': "attachment; filename*=UTF-8''%E9%9D%92%E5%B2%9A%E7%A4%BA%E4%BE%8B.xlsx",
        'x-demo-context': 'c'.repeat(43),
        'x-demo-dataset-id': 'qinglan-park-v1',
        'x-demo-artifact-key': 'demo-artifact'
      }
    };
  };
  const downloadResult = await httpModule.download({ url: '/test-download', method: 'get' }, 'fallback.xlsx');
  assert.strictEqual(downloadResult.fileName, '青岚示例.xlsx', 'download 必须使用响应头文件名。');
  assert.strictEqual(downloadResult.demo.contextToken, 'c'.repeat(43), 'download 必须返回响应头中的演示 context。');
  assert.strictEqual(testLink.href, 'blob:pure-logic-stub');
  assert.strictEqual(testLink.download, '青岚示例.xlsx');
  assert.deepStrictEqual(
    downloadEffects.map(([effect]) => effect),
    ['createObjectURL', 'createElement', 'appendChild', 'click', 'remove', 'revokeObjectURL'],
    '纯逻辑 DOM stub 必须观察到 Blob URL、链接点击、移除和 URL 回收副作用。'
  );

  // 加载生产 demoData.js 的真实 clearDemoContexts，供 user action 生命周期调用。
  let demoDataSource = await readFile(demoDataSourceUrl, 'utf8');
  demoDataSource = replaceRequired(
    demoDataSource,
    "import { request, requestWithHeaders } from '@/api/http';",
    'const request = async () => null; const requestWithHeaders = async () => null;',
    'demoData.js'
  );
  const demoDataModule = await import(moduleDataUrl(demoDataSource));
  globalThis.__CHARCOAL_CLEAR_DEMO_CONTEXTS__ = demoDataModule.clearDemoContexts;

  // Pinia 和请求 adapter 只负责构造 store/控制远程结果，logout action 本身来自生产 user.js。
  const userPiniaStub = `
const defineStore = (id, options) => {
  globalThis.__CHARCOAL_USER_STORE_DEFINITION__ = { id, options };
  return () => {
    const store = { ...options.state() };
    for (const [name, action] of Object.entries(options.actions || {})) store[name] = action.bind(store);
    return store;
  };
};`;
  const userRequestStub = 'const request = (config) => globalThis.__CHARCOAL_USER_REQUEST__(config);';
  const userDemoDataStub = 'const clearDemoContexts = (...args) => globalThis.__CHARCOAL_CLEAR_DEMO_CONTEXTS__(...args);';
  let userSource = await readFile(userSourceUrl, 'utf8');
  userSource = replaceRequired(userSource, "import { defineStore } from 'pinia';", userPiniaStub, 'user.js');
  userSource = replaceRequired(userSource, "import { request } from '@/api/http';", userRequestStub, 'user.js');
  userSource = replaceRequired(userSource, "import { clearDemoContexts } from '@/api/demoData';", userDemoDataStub, 'user.js');
  const userModule = await import(moduleDataUrl(userSource));
  assert.strictEqual(globalThis.__CHARCOAL_USER_STORE_DEFINITION__.id, 'user', '必须加载生产 user store 定义。');

  // 创建已登录 store，并把 profile/ready 设置为真实退出前状态。
  function createLoggedInStore() {
    localStorage.clear();
    sessionStorage.clear();
    localStorage.setItem('charcoal.token', 'login-token');
    seedDemoContexts(sessionStorage);
    const store = userModule.useUserStore();
    store.profile = { id: 1, username: 'tester' };
    store.ready = true;
    return store;
  }

  // 断言生产 logout action 的统一 finally 清理结果。
  function assertLoggedOut(store, messagePrefix) {
    assert.strictEqual(store.token, '', `${messagePrefix}必须清空 store token。`);
    assert.strictEqual(store.profile, null, `${messagePrefix}必须清空 profile。`);
    assert.strictEqual(store.ready, false, `${messagePrefix}必须复位 ready。`);
    assert.strictEqual(localStorage.getItem('charcoal.token'), null, `${messagePrefix}必须清理 localStorage token。`);
    assertDemoContextsCleared(sessionStorage, messagePrefix);
  }

  // 本地退出不发远程请求，但仍完整清理状态。
  let remoteRequests = [];
  globalThis.__CHARCOAL_USER_REQUEST__ = async (config) => {
    remoteRequests.push(config);
    return {};
  };
  const localLogoutStore = createLoggedInStore();
  await localLogoutStore.logout(false);
  assert.deepStrictEqual(remoteRequests, [], 'logout(false) 不得发送远程退出请求。');
  assertLoggedOut(localLogoutStore, 'logout(false) ');

  // 远程退出成功时发送生产 action 声明的请求，并在 finally 清理状态。
  remoteRequests = [];
  const remoteSuccessStore = createLoggedInStore();
  await remoteSuccessStore.logout(true);
  assert.deepStrictEqual(remoteRequests, [{ method: 'post', url: '/auth/logout' }], 'logout(true) 必须发送一次远程退出请求。');
  assertLoggedOut(remoteSuccessStore, 'logout(true) 成功 ');

  // 远程退出失败仍执行 finally 清理，同时必须把同一错误 reject 给调用方。
  const remoteFailure = new Error('远程退出失败');
  remoteRequests = [];
  globalThis.__CHARCOAL_USER_REQUEST__ = async (config) => {
    remoteRequests.push(config);
    throw remoteFailure;
  };
  const remoteFailureStore = createLoggedInStore();
  await assert.rejects(
    remoteFailureStore.logout(true),
    (error) => error === remoteFailure,
    'logout(true) 远程失败必须向调用方 reject 原始错误。'
  );
  assert.deepStrictEqual(remoteRequests, [{ method: 'post', url: '/auth/logout' }]);
  assertLoggedOut(remoteFailureStore, 'logout(true) 失败 finally ');

  console.log('demo context client lifecycle tests passed (pure logic adapters and DOM stub; no real browser)');
} finally {
  // 恢复测试覆盖过的全局对象。
  for (const [name, value] of Object.entries(originalGlobals)) {
    const globalName = {
      httpAdapter: '__CHARCOAL_HTTP_TEST_ADAPTER__',
      userRequest: '__CHARCOAL_USER_REQUEST__',
      clearDemoContexts: '__CHARCOAL_CLEAR_DEMO_CONTEXTS__',
      userStoreDefinition: '__CHARCOAL_USER_STORE_DEFINITION__'
    }[name] || name;
    if (value === undefined) delete globalThis[globalName];
    else globalThis[globalName] = value;
  }
}
