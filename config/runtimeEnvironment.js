const path = require('path');
const dotenv = require('dotenv');

// 项目根目录模块：统一定位根 .env，并供 Vite 复用 envDir。
const projectRoot = path.resolve(__dirname, '..');
// 默认环境文件模块：未注入路径时只读取项目根 .env。
const defaultEnvPath = path.join(projectRoot, '.env');
// 服务监听模块：后端与前端只绑定本机回环地址。
const loopbackHost = '127.0.0.1';
// 端口默认值模块：后端空白配置回退 3002，前端固定使用 7777。
const defaultBackendPort = 3002;
const developmentPort = 7777;
// 端口格式模块：只接受十进制数字，不接受符号、小数或其他进制写法。
const decimalPortPattern = /^\d+$/;

// 环境文件加载模块：保持已有进程环境优先，并允许测试注入独立路径和环境对象。
function loadEnvironmentFile(envPath, processEnv) {
  const loadResult = dotenv.config({
    path: envPath,
    processEnv,
    override: false,
    quiet: true
  });
  if (loadResult.error && loadResult.error.code !== 'ENOENT') {
    throw loadResult.error;
  }
}

// 后端端口解析模块：空白值使用默认端口，其余值必须是 1—65535 的十进制整数。
function parseBackendPort(rawPort) {
  const normalizedPort = String(rawPort ?? '').trim();
  if (!normalizedPort) {
    return defaultBackendPort;
  }
  if (!decimalPortPattern.test(normalizedPort)) {
    throw new RangeError('PORT 必须是 1—65535 的十进制整数。');
  }
  const parsedPort = Number(normalizedPort);
  if (!Number.isSafeInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new RangeError('PORT 必须是 1—65535 的十进制整数。');
  }
  return parsedPort;
}

// 运行环境配置模块：先加载根环境文件，再返回不包含密码等敏感值的地址与端口配置。
function loadRuntimeEnvironment(options = {}) {
  const resolvedEnvPath = path.resolve(options.envPath || defaultEnvPath);
  const targetProcessEnv = options.processEnv || process.env;
  loadEnvironmentFile(resolvedEnvPath, targetProcessEnv);

  const backendPort = parseBackendPort(targetProcessEnv.PORT);
  const backendOrigin = `http://${loopbackHost}:${backendPort}`;
  const developmentOrigin = `http://${loopbackHost}:${developmentPort}`;

  return Object.freeze({
    backendHost: loopbackHost,
    backendPort,
    frontendHost: loopbackHost,
    frontendPort: developmentPort,
    backendOrigin,
    apiProxyTarget: backendOrigin,
    developmentOrigin,
    envDir: projectRoot
  });
}

module.exports = {
  loadRuntimeEnvironment,
  parseBackendPort
};
