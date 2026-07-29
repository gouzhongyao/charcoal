const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const packageJsonPath = path.join(rootDir, 'package.json');
const packageLockPath = path.join(rootDir, 'package-lock.json');
const packageOnly = process.argv.includes('--package-only') || process.env.npm_config_package_only === 'true';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function getLockedVersion(lock, packageName) {
  const packages = lock.packages || {};
  const item = packages[`node_modules/${packageName}`];
  return item ? item.version : '';
}

function getDirectDependencies() {
  const packageJson = readJson(packageJsonPath);
  const lock = fs.existsSync(packageLockPath) ? readJson(packageLockPath) : { packages: {} };
  const sections = [
    ['dependencies', packageJson.dependencies || {}],
    ['devDependencies', packageJson.devDependencies || {}]
  ];
  return sections.flatMap(([section, deps]) => Object.entries(deps).map(([name, range]) => ({
    section,
    name,
    range,
    lockedVersion: getLockedVersion(lock, name) || '未在 package-lock 中找到'
  })));
}

function formatFixAvailable(fixAvailable) {
  if (!fixAvailable) {
    return '无自动修复版本';
  }
  if (fixAvailable === true) {
    return '存在兼容修复建议';
  }
  const name = fixAvailable.name || '未知包';
  const version = fixAvailable.version || '未知版本';
  const isMajor = fixAvailable.isSemVerMajor ? '，需要 semver major' : '';
  return `${name}@${version}${isMajor}`;
}

function summarizeAudit(audit) {
  const vulnerabilities = audit.vulnerabilities || {};
  const rows = Object.entries(vulnerabilities)
    .map(([name, item]) => ({
      name,
      severity: item.severity || 'unknown',
      isDirect: Boolean(item.isDirect),
      via: Array.isArray(item.via) ? item.via.map((via) => (typeof via === 'string' ? via : `${via.title || via.name || 'advisory'} (${via.severity || 'unknown'})`)) : [],
      effects: item.effects || [],
      range: item.range || '',
      fixAvailable: formatFixAvailable(item.fixAvailable)
    }))
    .sort((a, b) => {
      const rank = { critical: 4, high: 3, moderate: 2, low: 1, info: 0, unknown: -1 };
      return (rank[b.severity] || 0) - (rank[a.severity] || 0) || a.name.localeCompare(b.name);
    });

  return {
    metadata: audit.metadata || {},
    vulnerabilities: rows
  };
}

function printPackageSummary() {
  console.log('依赖清单（来自 package.json / package-lock.json，不联网）：');
  getDirectDependencies().forEach((dep) => {
    console.log(`- ${dep.section}: ${dep.name} ${dep.range}，锁定版本 ${dep.lockedVersion}`);
  });
}

function printStrategy() {
  console.log('');
  console.log('处理策略：');
  console.log('- 本脚本只读执行 npm audit --json --audit-level=moderate，不执行 npm audit fix，不安装/升级依赖，不修改 package-lock。');
  console.log('- fixAvailable=false 或需要 semver major 的项，仅记录并进入单独升级/替换评估。');
  console.log('- 涉及上传解析链路的依赖需结合文件大小、文件类型、行列上限、首个工作表解析和上传目录不公开等本地缓解一起判断。');
}

function runAudit() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npmCommand, ['audit', '--json', '--audit-level=moderate'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  let audit;
  try {
    audit = JSON.parse(output);
  } catch (error) {
    console.error('npm audit 输出无法解析为 JSON。');
    if (output) {
      console.error(output.slice(0, 4000));
    }
    process.exitCode = result.status || 1;
    return;
  }

  const summary = summarizeAudit(audit);
  const counts = summary.metadata.vulnerabilities || {};
  console.log('npm audit 摘要（audit-level=moderate）：');
  console.log(`- total=${counts.total || 0}, critical=${counts.critical || 0}, high=${counts.high || 0}, moderate=${counts.moderate || 0}, low=${counts.low || 0}`);
  if (summary.vulnerabilities.length === 0) {
    console.log('- 未发现 moderate 及以上漏洞。');
  } else {
    summary.vulnerabilities.forEach((item) => {
      console.log(`- ${item.name}: ${item.severity}${item.isDirect ? '，直接依赖' : '，间接依赖'}，范围 ${item.range || '未提供'}，修复建议：${item.fixAvailable}`);
      if (item.via.length > 0) {
        console.log(`  via: ${item.via.slice(0, 4).join('；')}`);
      }
      if (item.effects.length > 0) {
        console.log(`  effects: ${item.effects.join(', ')}`);
      }
    });
  }
  if (result.status && result.status > 1) {
    console.log(`npm audit 命令返回非预期状态码 ${result.status}，请检查网络或 npm registry 配置。`);
    process.exitCode = result.status;
    return;
  }
  printStrategy();
  process.exitCode = 0;
}

printPackageSummary();
if (packageOnly) {
  console.log('');
  console.log('已使用 --package-only，仅输出本地依赖清单，不调用 npm audit。');
  printStrategy();
} else {
  runAudit();
}
