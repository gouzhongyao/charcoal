const fs = require('node:fs');
const path = require('node:path');

// 项目根目录用于统一解析说明书、规则和入口文件。
const PROJECT_ROOT = path.resolve(__dirname, '..');
// 正式使用说明书目录用于限制文档扫描范围。
const MANUAL_ROOT = path.join(PROJECT_ROOT, 'docs', '使用说明书');
// 正式使用说明书总入口用于校验章节目录。
const MANUAL_INDEX_PATH = path.join(MANUAL_ROOT, 'README.md');
// 功能覆盖矩阵用于校验动态页面和特殊页面覆盖情况。
const COVERAGE_MATRIX_PATH = path.join(MANUAL_ROOT, '维护附录', '功能覆盖矩阵.md');
// 路由文件用于动态读取当前 componentMap 标识，避免脚本维护静态页面清单。
const ROUTER_PATH = path.join(PROJECT_ROOT, 'client', 'src', 'router', 'index.js');
// code-helper 受控区块标识用于确认长期规则索引写在区块外。
const CODE_HELPER_BLOCK_PATTERN = /<!-- code-helper:start -->[\s\S]*?<!-- code-helper:end -->/g;
// 校验失败列表用于一次性汇总全部可修复问题。
const validationFailures = [];
// 必需说明书文件列表用于约束正式目录的最低结构。
const requiredManualFiles = [
  'README.md',
  '01-本地安装启动与首次管理员.md',
  '02-登录注册与个人中心.md',
  '03-导航权限与通用操作.md',
  '04-工作台.md',
  '05-通用导入与批次审计.md',
  '06-能耗统计与历史台账回填.md',
  '07-用能预算.md',
  '08-基础台账.md',
  '09-碳核算.md',
  '10-预测管理.md',
  '11-用户角色与菜单管理.md',
  '12-备份恢复与维护态.md',
  '13-临时外网访问.md',
  '14-限制风险与故障排查.md',
  '维护附录/功能覆盖矩阵.md',
  '维护附录/变更记录.md'
];
// 特殊页面标识用于确保固定入口、占位和兜底页面进入覆盖矩阵。
const specialPageMarkers = [
  { label: '登录页', markers: ['/login', 'Login.vue', 'Login'] },
  { label: '注册页', markers: ['/register', 'Register.vue', 'Register'] },
  { label: '个人中心', markers: ['/profile', 'Profile.vue', 'Profile'] },
  { label: '迁移占位页', markers: ['MigrationPlaceholder.vue', 'MigrationPlaceholder', '迁移占位'] },
  { label: '404 页面', markers: ['NotFound.vue', 'NotFound', '404'] }
];
// 关键主题标识用于保证高风险操作和运行边界至少在说明书中有明确说明。
const criticalTopicMarkers = [
  { label: '首次管理员密码', markers: ['CHARCOAL_ADMIN_PASSWORD', '首次管理员'] },
  { label: 'SQLite 本地数据', markers: ['SQLite'] },
  { label: '维护态', markers: ['维护态'] },
  { label: '导入限制', markers: ['导入限制', '导入文件限制', '导入约束'] },
  { label: '历史台账回填', markers: ['台账回填', '历史台账回填'] },
  { label: '自动备份', markers: ['自动备份'] },
  { label: '备份恢复', markers: ['备份恢复'] },
  { label: '迁移占位页', markers: ['占位页', '迁移占位'] }
];
// 中央维护规范标识用于校验用户可见变更、同步范围和占位边界已经明确。
const maintenanceRuleMarkerGroups = [
  ['用户可见变更'],
  ['同一任务'],
  ['功能覆盖矩阵'],
  ['变更记录'],
  ['无需更新理由'],
  ['最低内容'],
  ['占位']
];
// 任务闭环规则要求用于校验六份既有规则已经承担对应说明书责任。
const ruleReferenceRequirements = [
  {
    file: 'code-helper-docs/user-rules/Agent协作规范.md',
    groups: [
      ['使用说明书影响'],
      ['说明书同步结论'],
      ['汇总责任人'],
      ['代码、说明书和实施记录', '代码、使用说明书和实施记录']
    ]
  },
  {
    file: 'code-helper-docs/user-rules/项目计划管理规范.md',
    groups: [['使用说明书影响'], ['目标章节'], ['覆盖矩阵'], ['同步状态']]
  },
  {
    file: 'code-helper-docs/user-rules/执行结果总结规范.md',
    groups: [['使用说明书同步'], ['更新章节'], ['矩阵项'], ['无需更新理由']]
  },
  {
    file: 'code-helper-docs/user-rules/功能完成检查规范.md',
    groups: [['使用说明书'], ['不得判定整体完成'], ['切换任务'], ['归档']]
  },
  {
    file: 'code-helper-docs/user-rules/文档归档规范.md',
    groups: [['长期产品文档'], ['不随任务归档'], ['覆盖矩阵'], ['实施记录']]
  },
  {
    file: 'code-helper-docs/user-rules/测试策略规范.md',
    groups: [['手工测试与使用说明书', '手工测试和使用说明书'], ['职责分离'], ['说明书章节'], ['真实流程']]
  }
];

/**
 * 记录一条校验失败信息，最终统一输出。
 * @param {string} message 校验失败说明。
 */
function addFailure(message) {
  validationFailures.push(message);
}

/**
 * 读取 UTF-8 文本；文件不存在时返回空字符串，由具体规则生成可理解错误。
 * @param {string} absolutePath 文件绝对路径。
 * @returns {string} 文件文本。
 */
function readText(absolutePath) {
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) return '';
  return fs.readFileSync(absolutePath, 'utf8');
}

/**
 * 校验文件存在且包含非空内容。
 * @param {string} absolutePath 文件绝对路径。
 * @param {string} displayPath 面向输出的项目相对路径。
 * @returns {boolean} 文件是否有效。
 */
function verifyNonEmptyFile(absolutePath, displayPath) {
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    addFailure(`缺少必需文件：${displayPath}`);
    return false;
  }

  // 文件内容用于排除只有空白字符的占位文件。
  const fileContent = fs.readFileSync(absolutePath, 'utf8');
  if (!fileContent.trim()) {
    addFailure(`必需文件为空：${displayPath}`);
    return false;
  }
  return true;
}

/**
 * 递归收集目录中的 Markdown 文件。
 * @param {string} directoryPath 目录绝对路径。
 * @returns {string[]} Markdown 文件绝对路径列表。
 */
function collectMarkdownFiles(directoryPath) {
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) return [];

  // 当前目录条目用于逐层收集 Markdown 文件。
  const directoryEntries = fs.readdirSync(directoryPath, { withFileTypes: true });
  // 当前目录结果用于合并子目录文件。
  const markdownFiles = [];
  for (const directoryEntry of directoryEntries) {
    // 当前条目绝对路径用于判断文件类型和递归位置。
    const entryPath = path.join(directoryPath, directoryEntry.name);
    if (directoryEntry.isDirectory()) {
      markdownFiles.push(...collectMarkdownFiles(entryPath));
    } else if (directoryEntry.isFile() && directoryEntry.name.toLowerCase().endsWith('.md')) {
      markdownFiles.push(entryPath);
    }
  }
  return markdownFiles;
}

/**
 * 从 Markdown 文本提取行内链接和图片链接目标。
 * @param {string} markdownContent Markdown 文本。
 * @returns {string[]} 原始链接目标列表。
 */
function extractMarkdownTargets(markdownContent) {
  // 行内链接表达式用于识别常见 Markdown 链接格式。
  const inlineLinkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
  // 链接目标结果用于后续路径标准化。
  const linkTargets = [];
  // 当前正则匹配结果用于遍历全部行内链接。
  let linkMatch;
  while ((linkMatch = inlineLinkPattern.exec(markdownContent)) !== null) {
    linkTargets.push(linkMatch[1]);
  }
  return linkTargets;
}

/**
 * 标准化 Markdown 链接目标并过滤网络地址、锚点和非文件协议。
 * @param {string} rawTarget Markdown 中的原始目标。
 * @returns {string|null} 可解析的本地相对目标。
 */
function normalizeLocalTarget(rawTarget) {
  // 去除标题前的原始目标用于兼容 `<路径>` 和 `路径 "标题"` 格式。
  const trimmedTarget = rawTarget.trim();
  if (!trimmedTarget) return null;

  // 不参与本地文件校验的协议表达式用于排除网络、邮件和电话链接。
  const externalProtocolPattern = /^(?:[a-z][a-z\d+.-]*:|\/\/)/i;
  if (trimmedTarget.startsWith('#') || externalProtocolPattern.test(trimmedTarget)) return null;

  // 提取后的路径目标用于去除可选标题。
  const pathTarget = trimmedTarget.startsWith('<')
    ? trimmedTarget.slice(1, trimmedTarget.indexOf('>'))
    : trimmedTarget.split(/\s+/)[0];
  // 去除查询参数和锚点后的路径用于文件系统解析。
  const targetWithoutSuffix = pathTarget.split('#')[0].split('?')[0];
  if (!targetWithoutSuffix) return null;

  try {
    return decodeURIComponent(targetWithoutSuffix);
  } catch {
    return targetWithoutSuffix;
  }
}

/**
 * 判断文本是否包含一组候选标识中的任意一个。
 * @param {string} content 待检查文本。
 * @param {string[]} markers 候选标识。
 * @returns {boolean} 是否至少命中一个标识。
 */
function includesAny(content, markers) {
  return markers.some((marker) => content.includes(marker));
}

/**
 * 校验说明书必需章节、维护附录和中央维护规范存在且非空。
 */
function verifyRequiredFiles() {
  for (const relativeManualPath of requiredManualFiles) {
    // 当前说明书文件绝对路径用于存在性和内容校验。
    const absoluteManualPath = path.join(MANUAL_ROOT, relativeManualPath);
    verifyNonEmptyFile(absoluteManualPath, path.posix.join('docs/使用说明书', relativeManualPath));
  }

  // 中央维护规范路径用于确认长期规则文件结构完整。
  const maintenanceRulePath = path.join(PROJECT_ROOT, 'code-helper-docs', 'user-rules', '项目使用说明书维护规范.md');
  if (verifyNonEmptyFile(maintenanceRulePath, 'code-helper-docs/user-rules/项目使用说明书维护规范.md')) {
    // 中央维护规范文本用于检查四个标准章节。
    const maintenanceRuleContent = readText(maintenanceRulePath);
    // 专题规则标准章节用于避免新增规范缺失项目约定结构。
    const requiredRuleHeadings = ['## 功能描述', '## 调用时机', '## 调用入口文件', '## 规则'];
    for (const requiredRuleHeading of requiredRuleHeadings) {
      if (!maintenanceRuleContent.includes(requiredRuleHeading)) {
        addFailure(`项目使用说明书维护规范缺少章节：${requiredRuleHeading}`);
      }
    }
    for (const maintenanceMarkerGroup of maintenanceRuleMarkerGroups) {
      if (!includesAny(maintenanceRuleContent, maintenanceMarkerGroup)) {
        addFailure(`项目使用说明书维护规范缺少要求：${maintenanceMarkerGroup.join(' / ')}`);
      }
    }
  }
}

/**
 * 校验根 README 存在正式使用说明书入口。
 */
function verifyRootReadmeEntry() {
  // 根 README 路径用于读取项目公开入口。
  const rootReadmePath = path.join(PROJECT_ROOT, 'README.md');
  // 根 README 文本用于检查入口标题和链接。
  const rootReadmeContent = readText(rootReadmePath);
  if (!rootReadmeContent.includes('完整使用说明书')) {
    addFailure('README.md 缺少“完整使用说明书”正式入口说明。');
  }

  // 根 README 链接目标用于确认入口实际指向说明书总目录。
  const rootReadmeTargets = extractMarkdownTargets(rootReadmeContent)
    .map(normalizeLocalTarget)
    .filter(Boolean);
  // 说明书总入口绝对路径用于与 README 链接解析结果比较。
  const expectedManualIndexPath = path.normalize(MANUAL_INDEX_PATH);
  // 是否存在有效说明书入口用于输出单一明确结论。
  const hasManualIndexLink = rootReadmeTargets.some((target) => {
    // 当前 README 链接绝对路径用于目标比对。
    const resolvedTarget = path.resolve(PROJECT_ROOT, target);
    return path.normalize(resolvedTarget) === expectedManualIndexPath;
  });
  if (!hasManualIndexLink) {
    addFailure('README.md 必须通过相对链接指向 docs/使用说明书/README.md。');
  }
}

/**
 * 校验说明书总入口链接到全部业务章节和维护附录。
 */
function verifyManualIndexLinks() {
  // 说明书总入口文本用于提取章节目录链接。
  const manualIndexContent = readText(MANUAL_INDEX_PATH);
  if (!manualIndexContent) return;

  // 总入口中的本地目标用于与必需章节逐一比对。
  const manualIndexTargets = extractMarkdownTargets(manualIndexContent)
    .map(normalizeLocalTarget)
    .filter(Boolean)
    .map((target) => path.normalize(path.resolve(MANUAL_ROOT, target)));
  for (const requiredManualFile of requiredManualFiles.filter((file) => file !== 'README.md')) {
    // 当前必需章节绝对路径用于确认总入口是否可达。
    const requiredAbsolutePath = path.normalize(path.join(MANUAL_ROOT, requiredManualFile));
    if (!manualIndexTargets.includes(requiredAbsolutePath)) {
      addFailure(`说明书总入口缺少章节链接：${requiredManualFile}`);
    }
  }
}

/**
 * 校验根 README 和说明书内全部本地 Markdown 相对链接有效且未逃逸项目目录。
 */
function verifyLocalMarkdownLinks() {
  // 参与链接校验的文件包含根入口和说明书全部 Markdown 文件。
  const markdownFiles = [path.join(PROJECT_ROOT, 'README.md'), ...collectMarkdownFiles(MANUAL_ROOT)];
  for (const markdownFile of markdownFiles) {
    // 当前 Markdown 文本用于提取本地链接。
    const markdownContent = readText(markdownFile);
    // 当前文件相对路径用于生成可定位的失败信息。
    const markdownDisplayPath = path.relative(PROJECT_ROOT, markdownFile).split(path.sep).join('/');
    // 当前文件已检查目标用于避免重复目录链接产生相同失败信息。
    const checkedLocalTargets = new Set();
    for (const rawTarget of extractMarkdownTargets(markdownContent)) {
      // 标准化本地目标用于过滤外部链接和解析文件路径。
      const localTarget = normalizeLocalTarget(rawTarget);
      if (!localTarget || checkedLocalTargets.has(localTarget)) continue;
      checkedLocalTargets.add(localTarget);
      if (path.isAbsolute(localTarget)) {
        addFailure(`${markdownDisplayPath} 使用了非相对本地链接：${localTarget}`);
        continue;
      }

      // 当前链接绝对路径用于检查项目边界和文件存在性。
      const resolvedTarget = path.resolve(path.dirname(markdownFile), localTarget);
      // 项目相对结果用于识别向上逃逸到项目外的路径。
      const projectRelativeTarget = path.relative(PROJECT_ROOT, resolvedTarget);
      if (projectRelativeTarget.startsWith('..') || path.isAbsolute(projectRelativeTarget)) {
        addFailure(`${markdownDisplayPath} 的链接逃逸项目目录：${localTarget}`);
      } else if (!fs.existsSync(resolvedTarget)) {
        addFailure(`${markdownDisplayPath} 包含无效本地链接：${localTarget}`);
      }
    }
  }
}

/**
 * 从路由源码读取 componentMap 中的组件标识和组件变量。
 * @returns {{ identifier: string, component: string }[]} 动态组件映射。
 */
function parseComponentMap() {
  // 路由源码用于定位当前真实动态页面映射。
  const routerContent = readText(ROUTER_PATH);
  // componentMap 对象正文匹配用于限制解析范围。
  const componentMapMatch = routerContent.match(/const\s+componentMap\s*=\s*Object\.freeze\(\{([\s\S]*?)\}\);/);
  if (!componentMapMatch) {
    addFailure('无法从 client/src/router/index.js 解析 componentMap。');
    return [];
  }

  // 单项映射表达式用于读取字符串标识和组件变量名。
  const componentEntryPattern = /['"]([^'"]+)['"]\s*:\s*([A-Za-z_$][\w$]*)/g;
  // 动态组件结果用于覆盖矩阵校验。
  const componentEntries = [];
  // 当前映射匹配用于遍历 componentMap 全部成员。
  let componentEntryMatch;
  while ((componentEntryMatch = componentEntryPattern.exec(componentMapMatch[1])) !== null) {
    componentEntries.push({ identifier: componentEntryMatch[1], component: componentEntryMatch[2] });
  }
  if (!componentEntries.length) {
    addFailure('componentMap 中未解析到任何动态页面标识。');
  }
  return componentEntries;
}

/**
 * 校验功能覆盖矩阵覆盖全部动态组件和固定特殊页面。
 */
function verifyCoverageMatrix() {
  // 覆盖矩阵文本用于匹配组件和特殊页面标识。
  const coverageMatrixContent = readText(COVERAGE_MATRIX_PATH);
  if (!coverageMatrixContent) return;

  for (const componentEntry of parseComponentMap()) {
    if (!coverageMatrixContent.includes(componentEntry.identifier)) {
      addFailure(`功能覆盖矩阵缺少 componentMap 标识：${componentEntry.identifier}（${componentEntry.component}）`);
    }
  }

  for (const specialPageMarker of specialPageMarkers) {
    if (!includesAny(coverageMatrixContent, specialPageMarker.markers)) {
      addFailure(`功能覆盖矩阵缺少特殊页面：${specialPageMarker.label}`);
    }
  }
}

/**
 * 校验说明书整体包含首次启动、数据安全和高风险操作关键主题。
 */
function verifyCriticalTopics() {
  // 说明书全部文本用于跨章节检查关键主题。
  const combinedManualContent = collectMarkdownFiles(MANUAL_ROOT)
    .map((markdownFile) => readText(markdownFile))
    .join('\n');
  if (!combinedManualContent) return;

  for (const criticalTopicMarker of criticalTopicMarkers) {
    if (!includesAny(combinedManualContent, criticalTopicMarker.markers)) {
      addFailure(`使用说明书缺少关键主题：${criticalTopicMarker.label}`);
    }
  }
}

/**
 * 校验 CLAUDE.md 在 code-helper 受控区块外索引中央维护规范。
 */
function verifyClaudeIndex() {
  // CLAUDE 入口路径用于读取项目长期规则索引。
  const claudePath = path.join(PROJECT_ROOT, 'CLAUDE.md');
  // CLAUDE 完整文本用于剔除自动维护区块。
  const claudeContent = readText(claudePath);
  // 受控区块外文本用于确保本次索引不会被后续自动更新覆盖。
  const unmanagedClaudeContent = claudeContent.replace(CODE_HELPER_BLOCK_PATTERN, '');
  if (!unmanagedClaudeContent.includes('项目使用说明书维护规范.md')
    || !unmanagedClaudeContent.includes('项目使用说明书维护规范')) {
    addFailure('CLAUDE.md 必须在 code-helper 受控区块外索引项目使用说明书维护规范。');
  }
}

/**
 * 校验六份任务闭环规则已经包含各自承担的说明书同步要求。
 */
function verifyRuleReferences() {
  for (const ruleRequirement of ruleReferenceRequirements) {
    // 当前规则绝对路径用于读取专题规则。
    const rulePath = path.join(PROJECT_ROOT, ruleRequirement.file);
    // 当前规则文本用于逐组检查所需语义标识。
    const ruleContent = readText(rulePath);
    if (!ruleContent) {
      addFailure(`缺少任务闭环规则文件：${ruleRequirement.file}`);
      continue;
    }

    for (const markerGroup of ruleRequirement.groups) {
      if (!includesAny(ruleContent, markerGroup)) {
        addFailure(`${ruleRequirement.file} 缺少说明书同步要求：${markerGroup.join(' / ')}`);
      }
    }
  }
}

/**
 * 执行全部离线文档校验并设置进程退出码。
 */
function main() {
  verifyRequiredFiles();
  verifyRootReadmeEntry();
  verifyManualIndexLinks();
  verifyLocalMarkdownLinks();
  verifyCoverageMatrix();
  verifyCriticalTopics();
  verifyClaudeIndex();
  verifyRuleReferences();

  if (validationFailures.length) {
    console.error(`使用说明书校验失败，共 ${validationFailures.length} 项：`);
    validationFailures.forEach((failure, index) => console.error(`${index + 1}. ${failure}`));
    process.exitCode = 1;
    return;
  }

  console.log('使用说明书校验通过。');
}

main();
