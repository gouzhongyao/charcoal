const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadRuntimeEnvironment, parseBackendPort } = require('../../../config/runtimeEnvironment');

// 项目根目录模块：envDir 始终指向根目录，不随测试环境文件位置变化。
const projectRoot = path.resolve(__dirname, '../../..');
// 隔离目录模块：所有环境文件均写入系统临时目录，不读取开发者真实 .env。
const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-runtime-environment-'));
// 环境文件路径模块：分别覆盖缺失、正常加载和进程环境优先场景。
const missingEnvPath = path.join(temporaryDirectory, 'missing.env');
const loadedEnvPath = path.join(temporaryDirectory, 'loaded.env');
const priorityEnvPath = path.join(temporaryDirectory, 'priority.env');

try {
  // 缺失环境文件模块：文件不存在时仍应使用安全默认配置。
  const missingEnvironment = {};
  const missingConfiguration = loadRuntimeEnvironment({ envPath: missingEnvPath, processEnv: missingEnvironment });
  assert.strictEqual(missingConfiguration.backendPort, 3002);
  assert.strictEqual(missingConfiguration.envDir, projectRoot);

  // 正常加载模块：dotenv 应将根配置写入注入对象，但返回值只暴露非敏感运行地址。
  fs.writeFileSync(loadedEnvPath, [
    'PORT=4102',
    'CORS_ALLOWED_ORIGINS=https://demo.example.com',
    'CHARCOAL_ADMIN_PASSWORD=EnvironmentSecret123!'
  ].join('\n'));
  const loadedEnvironment = {};
  const loadedConfiguration = loadRuntimeEnvironment({ envPath: loadedEnvPath, processEnv: loadedEnvironment });
  assert.strictEqual(loadedEnvironment.PORT, '4102');
  assert.strictEqual(loadedEnvironment.CORS_ALLOWED_ORIGINS, 'https://demo.example.com');
  assert.strictEqual(loadedConfiguration.backendPort, 4102);
  assert.strictEqual(loadedConfiguration.backendHost, '127.0.0.1');
  assert.strictEqual(loadedConfiguration.frontendHost, '127.0.0.1');
  assert.strictEqual(loadedConfiguration.frontendPort, 7777);
  assert.strictEqual(loadedConfiguration.backendOrigin, 'http://127.0.0.1:4102');
  assert.strictEqual(loadedConfiguration.apiProxyTarget, 'http://127.0.0.1:4102');
  assert.strictEqual(loadedConfiguration.developmentOrigin, 'http://127.0.0.1:7777');
  assert.strictEqual(loadedConfiguration.envDir, projectRoot);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(loadedConfiguration, 'CHARCOAL_ADMIN_PASSWORD'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(loadedConfiguration, 'adminPassword'), false);
  assert.strictEqual(JSON.stringify(loadedConfiguration).includes('EnvironmentSecret123!'), false);

  // 进程环境优先模块：override:false 必须阻止 .env 覆盖已存在的端口。
  fs.writeFileSync(priorityEnvPath, 'PORT=4202\n');
  const priorityEnvironment = { PORT: '4302' };
  const priorityConfiguration = loadRuntimeEnvironment({ envPath: priorityEnvPath, processEnv: priorityEnvironment });
  assert.strictEqual(priorityEnvironment.PORT, '4302');
  assert.strictEqual(priorityConfiguration.backendPort, 4302);

  // 合法端口模块：边界值、普通值和外部空白均按十进制整数处理。
  assert.strictEqual(parseBackendPort('1'), 1);
  assert.strictEqual(parseBackendPort('65535'), 65535);
  assert.strictEqual(parseBackendPort(' 3002 '), 3002);
  assert.strictEqual(parseBackendPort(''), 3002);
  assert.strictEqual(parseBackendPort('   '), 3002);
  assert.strictEqual(parseBackendPort(undefined), 3002);

  // 非法端口模块：拒绝越界、符号、小数、指数、其他进制和非数字值。
  for (const invalidPort of ['0', '65536', '-1', '+3002', '1.5', '1e3', '0x10', 'abc']) {
    assert.throws(() => parseBackendPort(invalidPort), /PORT 必须是 1—65535 的十进制整数。/);
  }

  console.log('runtime environment tests passed');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
