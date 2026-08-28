const fs = require('node:fs');
const path = require('node:path');

// 项目根目录用于统一解析说明书、规则和入口文件。
const PROJECT_ROOT = path.resolve(__dirname, '..');
// 正式使用说明书目录用于限制文档扫描范围。
const MANUAL_ROOT = path.join(PROJECT_ROOT, 'docs', '使用说明书');
// 正式使用说明书总入口用于校验章节目录。
const MANUAL_INDEX_PATH = path.join(MANUAL_ROOT, 'README.md');
// 天坤集团完整演示主步骤用于校验首次演示入口和 29 项清单完整性。
const PROJECT_STEPS_PATH = path.join(MANUAL_ROOT, '项目使用步骤.md');
// 通用操作正文用于独立校验用户可见日期时间与内部技术格式分层合同。
const COMMON_OPERATIONS_MANUAL_PATH = path.join(MANUAL_ROOT, '03-导航权限与通用操作.md');
// 功能覆盖矩阵用于校验动态页面和特殊页面覆盖情况。
const COVERAGE_MATRIX_PATH = path.join(MANUAL_ROOT, '维护附录', '功能覆盖矩阵.md');
// 路由文件用于动态读取当前 componentMap 标识，避免脚本维护静态页面清单。
const ROUTER_PATH = path.join(PROJECT_ROOT, 'client', 'src', 'router', 'index.js');
// 供应商正文路径用于校验新增台账的冻结用户契约。
const SUPPLIER_MANUAL_PATH = path.join(MANUAL_ROOT, '08-基础台账.md');
// 碳核算正文路径用于校验独立活动、运行、双来源防双计和 N6/N7 报告冻结契约。
const CARBON_MANUAL_PATH = path.join(MANUAL_ROOT, '09-碳核算.md');
// 通用导入正文路径用于校验独立活动与 N6/N7 报告受控 execute 安全边界。
const IMPORT_AUDIT_MANUAL_PATH = path.join(MANUAL_ROOT, '05-通用导入与批次审计.md');
// 说明书变更记录路径用于校验 N5 finding、N6 收尾和 N7-B 文档闭环状态。
const CHANGELOG_PATH = path.join(MANUAL_ROOT, '维护附录', '变更记录.md');
// code-helper 受控区块标识用于确认长期规则索引写在区块外。
const CODE_HELPER_BLOCK_PATTERN = /<!-- code-helper:start -->[\s\S]*?<!-- code-helper:end -->/g;
// 校验失败列表用于一次性汇总全部可修复问题。
const validationFailures = [];
// 必需说明书文件列表用于约束正式目录的最低结构。
const requiredManualFiles = [
  'README.md',
  '项目使用步骤.md',
  '00-侧边栏模块总览与数据链路.md',
  '01-本地安装启动与首次管理员.md',
  '02-登录注册与个人中心.md',
  '03-导航权限与通用操作.md',
  '04-中控.md',
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
  '15-能源消费分析与用能策略推荐.md',
  '16-能效对标.md',
  '17-能流分析.md',
  '18-能效平衡与优化.md',
  '维护附录/功能覆盖矩阵.md',
  '维护附录/变更记录.md'
];
// 天坤集团演示 artifact 标识用于约束主步骤与服务端 manifest 的固定 29 项覆盖。
const demoParkArtifactKeys = [
  '01-organization-root',
  '02-organization-departments',
  '03-organization-process-equipment',
  '04-meters',
  '05-production-units',
  '06-production-outputs',
  '07-monthly-energy',
  '08-meter-readings-2026-08',
  '09-generation-records',
  '10-energy-budgets',
  '11-carbon-factors',
  '12-prediction-configs',
  '13-shift-definitions',
  '14-shift-schedules',
  '15-energy-timeseries',
  '16-device-states',
  '17-tou-schemes',
  '18-strategy-rules',
  '19-conversion-factors',
  '20-benchmark-definitions',
  '21-benchmark-targets',
  '22-energy-flow-models',
  '23-energy-flow-nodes',
  '24-energy-flow-edges',
  '25-energy-balance-configs'
];
// 侧边栏模块总览章节路径用于限定新增总览的主题完整性校验。
const SIDEBAR_OVERVIEW_PATH = path.join(MANUAL_ROOT, '00-侧边栏模块总览与数据链路.md');
// 侧边栏正式模块标题用于按当前第 00 章结构逐模块定位说明内容。
const sidebarOverviewModuleTitles = [
  '中控',
  '能源数据导入（当前菜单：能耗数据导入）',
  '能耗统计',
  '月度预算（当前页面：用能预算）',
  '能源消费分析',
  '能效对标',
  '能源分析（当前实现为能流分析）',
  '能效平衡与优化',
  '组织管理（用能单元）',
  '计量器具',
  '计量抄表',
  '产能单元',
  '月度产量',
  '发电自用',
  '供应商管理',
  '碳核算',
  '预测管理',
  '用户管理',
  '角色管理',
  '菜单管理',
  '备份恢复'
];
// 侧边栏模块固定主题用于检查每个正式模块的数据链路、权限边界和验收口径。
const sidebarOverviewRequiredTopics = [
  { label: '用途', titles: ['用途'] },
  { label: '子功能', titles: ['子功能'] },
  { label: '数据从哪里来 / 数据来源', titles: ['数据从哪里来', '数据来源'] },
  { label: '如何产生或导入', titles: ['如何产生或导入'] },
  { label: '显示数据条件', titles: ['显示数据条件'] },
  { label: '空数据排查', titles: ['空数据排查'] },
  { label: '权限与菜单可见', titles: ['权限与菜单可见'] },
  { label: '副作用与非自动联动', titles: ['副作用与非自动联动'] },
  { label: '快速验收', titles: ['快速验收'] }
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
// 供应商正文冻结标识用于防止权限、状态、导入和删除边界在文档中回退。
const supplierManualMarkerGroups = [
  { label: '供应商页面入口', markers: ['/ledger/suppliers'] },
  { label: '供应商模板 ID', markers: ['模板 ID 为 `suppliers`'] },
  { label: '供应商导入类型', markers: ['`supplier` 导入批次'] },
  { label: '供应商查看权限', markers: ['`ledger:suppliers:view`'] },
  { label: '供应商创建权限', markers: ['`ledger:suppliers:create`'] },
  { label: '供应商编辑权限', markers: ['`ledger:suppliers:update`'] },
  { label: '供应商状态权限', markers: ['`ledger:suppliers:status`'] },
  { label: '供应商导入预演权限', markers: ['`ledger:suppliers:import:preview`'] },
  { label: '供应商导入执行权限', markers: ['`ledger:suppliers:import:execute`'] },
  { label: '供应商导出权限', markers: ['`ledger:suppliers:export`'] },
  { label: '供应商电话文本', markers: ['联系电话在数据库和前端载荷中都按 TEXT 处理'] },
  { label: '供应商合作状态', markers: ['合作中/已踢出', '“合作中”', '“已踢出”'] },
  { label: '供应商普通编辑状态拒绝', markers: ['普通编辑请求包含 `status` 时拒绝'] },
  { label: '供应商无物理删除', markers: ['不提供供应商物理删除或 `DELETE` 接口'] },
  { label: '供应商规范键重复策略', markers: ['同一文件内按规范键重复的供应商编码全部阻断'] },
  { label: '供应商规范键筛选', markers: ['列表和导出的关键词筛选同时查询现有显示字段与该规范键'] },
  { label: '供应商状态必填', markers: ['“合作状态”是导入必填列', '空白和未知值都明确阻断'] },
  { label: '供应商资源上限', markers: ['单个条目声明及实际解压上限为 64 MiB', '总量上限为 128 MiB', '最多 10000000 字符'] },
  { label: '供应商字段长度', markers: ['供应商编码 64 字符', '备注 1000 字符'] },
  { label: '供应商受控执行', markers: ['服务端会重读上传原文件'] },
  { label: '供应商通用删除拒绝', markers: ['通用批次删除必须拒绝供应商批次'] }
];
// 碳核算正文冻结标识用于防止默认来源、时间语义和防双计边界回退；必需并存项使用 allOf，近义替代表述才使用 anyOf。
const carbonManualMarkerGroups = [
  { label: '碳页面入口', allOf: ['路由 `/carbon`'] },
  { label: '独立活动模板', allOf: ['模板 ID 为 `carbon-activities`', '15 列精确中文表头'] },
  { label: '独立活动权限', allOf: ['`carbon:activities:view`', '`carbon:activities:import:preview`', '`carbon:activities:import:execute`', '`carbon:activities:calculate`', '`carbon:activities:export`'] },
  { label: '默认独立来源', allOf: ['初始来源固定为 `independent_activity`'] },
  { label: '旧来源初始未选择', allOf: ['没有独立活动查看权限时保持未选择'] },
  { label: '旧来源显式选择', anyOf: ['旧来源和 `all` 都必须由用户显式选择', '显式选择 `energy_record`'] },
  { label: 'legacy 权限隔离', allOf: ['`carbon:view`', '不能进入新 `/api/carbon/accounting`'] },
  { label: '双来源防双计', allOf: ['两来源不可直接合计，避免双计。', '`crossSourceTotal` 固定为 `null`'] },
  { label: '双来源独立分页', allOf: ['两个分面页码和页大小独立'] },
  { label: '严格 all 合同', allOf: ['合同漂移', 'fail-closed'] },
  { label: '异常状态清空', allOf: ['清空上一筛选或上一运行的结果和统计'] },
  { label: '缺因子空值', allOf: ['`factor_missing`', '不能显示为 0'] },
  { label: '来源墙钟合同', allOf: ['`YYYY-MM-DDTHH:mm`', '禁止把 `YYYY-MM-DDTHH:mm` 直接追加 `Z`'] },
  { label: '严格 UTC 合同', allOf: ['`YYYY-MM-DDTHH:mm:ssZ`', '`.000Z`'] },
  { label: 'UTC 非法状态', allOf: ['`aria-invalid`', '非法输入'] },
  { label: '活动 execute 最小载荷', allOf: ['客户端展示的候选、签名或摘要不是受信写入来源'] },
  { label: '活动作废乐观锁', allOf: ['`updatedAt` 作为乐观锁'] },
  { label: '独立运行追加冻结', allOf: ['运行不会覆盖历史'] },
  { label: '旧接口保留', allOf: ['旧 `/api/carbon/emissions*`'] },
  { label: '真实工具待验收', allOf: ['Chrome/Edge、视觉、键盘、ARIA、窄屏和 Excel/WPS 仍待用户执行'] }
];
// N5 五处正式文档最低合同：分别约束正文、总览、导入审计、覆盖矩阵和变更记录，避免只更新其中一处仍通过。
const n5ManualDocumentContracts = [
  {
    label: '09-碳核算.md',
    path: CARBON_MANUAL_PATH,
    groups: [
      { label: '来源权限与初始状态', allOf: ['没有独立活动查看权限时保持未选择', '`carbon:view`', '不能进入新 `/api/carbon/accounting`'] },
      { label: '请求和异常边界', allOf: ['请求世代', '清空上一筛选或上一运行的结果和统计', 'fail-closed'] }
    ]
  },
  {
    label: '00-侧边栏模块总览与数据链路.md',
    path: SIDEBAR_OVERVIEW_PATH,
    groups: [
      { label: '统一结果边界', allOf: ['旧来源保持未选择', '`carbon:view`', '请求世代', 'fail-closed'] }
    ]
  },
  {
    label: '05-通用导入与批次审计.md',
    path: IMPORT_AUDIT_MANUAL_PATH,
    groups: [
      { label: '独立活动 execute 安全边界', allOf: ['服务端重读原文件', '候选见证', 'stale', '写前备份', '同一事务', '回滚', 'skip'] }
    ]
  },
  {
    label: '功能覆盖矩阵.md',
    path: COVERAGE_MATRIX_PATH,
    groups: [
      { label: 'N5 前端防回归', allOf: ['请求世代', 'fail-closed', 'Blob JSON', '`aria-invalid`', '`carbon:view`'] }
    ]
  },
  {
    label: '变更记录.md',
    path: CHANGELOG_PATH,
    groups: [
      { label: 'N5 finding 状态', allOf: ['RF-P1-018', 'RF-P2-014', '确认关闭', '无新增 finding', 'RF-P1-021 → RF-P1-015', 'RF-P1-022 → RF-P1-014'] }
    ]
  }
];
// N6 碳核算正文冻结标识用于防止模板、公共 DTO、严格执行条件、失败清空、数值语义、导出和非联动合同回退。
const n6CarbonManualMarkerGroups = [
  { label: '报告模板身份', allOf: ['模板 ID 为 `carbon-emission-report`', '导入类型为 `carbon_emission_report`', '模板版本为 `1.0`', '只接受 `.xlsx`'] },
  { label: '报告五部分顺序', allOf: ['1. `报告信息`', '2. `组织与核算边界`', '3. `报告项目`', '4. `汇总`', '5. `证据说明`'] },
  { label: '合法边界工作表名称', allOf: ['合法名称只能是“组织与核算边界”', '不能改成带斜杠的旧名称'] },
  { label: '报告四项权限', allOf: ['`carbon:emission-reports:view`', '`carbon:emission-reports:import:preview`', '`carbon:emission-reports:import:execute`', '`carbon:emission-reports:export`'] },
  { label: '报告固定确认', allOf: ['确认导入碳排放报告'] },
  { label: '报告重复编码阻断', allOf: ['同一报告编码重复导入必须阻断', '不覆盖', '不按 `skip` 跳过'] },
  { label: '报告 stale 合同', allOf: ['HTTP 409', '`CARBON_EMISSION_REPORT_PREVIEW_STALE`', '`requiresNewPreview: true`', '页面会清空旧预演'] },
  { label: '报告公共 HTTP DTO', allOf: ['N6 自有 preview、execute、列表、详情和批次追溯 HTTP 响应都使用显式公共 DTO 白名单', 'execute 只返回 `batchId`、`imported`、`importedIds`', '不公开或提交'] },
  { label: '报告严格执行条件', allOf: ['六项都必须是非负安全整数', '恰有一个 item 且状态为 `wouldImport`', 'warning/error 问题数量必须与汇总完全一致'] },
  { label: '报告 execute 失败清空', allOf: ['任何非取消 execute HTTP 失败', '清空旧预演、已提交预演世代和可执行状态', '取消或关闭确认框'] },
  { label: '报告请求世代', allOf: ['列表、报告详情、批次追溯、模板、preview、execute 和导出均采用请求世代', '旧 response、旧 error 和旧 finally'] },
  { label: '报告格式化数值语义', allOf: ['百分比显示 `12.50%` 时业务值保持底层 `0.125`', '文本单元格 `"1,234.50"` 不等价于合法数值单元格', '真实 0 保持 number `0`'] },
  { label: '报告导出合同', allOf: ['`X-Exported-Row-Count`', 'Blob JSON', '数值字段保持 number 单元格'] },
  { label: '报告非联动边界', allOf: ['碳排放报告只维护独立报告事实', '`carbon_activity_records`', '`carbon_calculation_runs`', '`carbon_accounting_results`', '`carbon_emissions`', '`carbon_factors`'] }
];
// N6 五处正式文档最低合同用于防止只更新正文或附录中的单一文件。
const n6ManualDocumentContracts = [
  {
    label: '09-碳核算.md',
    path: CARBON_MANUAL_PATH,
    groups: [
      { label: '固定工作簿与执行安全链', allOf: ['`carbon-emission-report`', '`carbon_emission_report`', '组织与核算边界', '确认导入碳排放报告', '`CARBON_EMISSION_REPORT_PREVIEW_STALE`'] },
      { label: '公共 DTO 与严格执行条件', allOf: ['显式公共 DTO 白名单', '非负安全整数', '恰有一个 item', '任何非取消 execute HTTP 失败'] },
      { label: '详情导出与数值边界', allOf: ['五部分详情', '`X-Exported-Row-Count`', 'Blob JSON', '不公开本地路径', '`12.50%`', '`0.125`', '`"1,234.50"`'] }
    ]
  },
  {
    label: '00-侧边栏模块总览与数据链路.md',
    path: SIDEBAR_OVERVIEW_PATH,
    groups: [
      { label: '报告独立事实链', allOf: ['固定五工作表 XLSX', '五部分详情', '报告不反写活动、运行、核算结果、旧碳排或因子', '碳排放报告 -X->'] }
    ]
  },
  {
    label: '05-通用导入与批次审计.md',
    path: IMPORT_AUDIT_MANUAL_PATH,
    groups: [
      { label: '报告批次权限和执行边界', allOf: ['`carbon:emission-reports:view`', '`imports:download`', '`carbon:emission-reports:export`', '`carbon_emission_report`', '服务端重读原文件', '重复编码直接阻断'] }
    ]
  },
  {
    label: '功能覆盖矩阵.md',
    path: COVERAGE_MATRIX_PATH,
    groups: [
      { label: '报告权限与前端防回归', allOf: ['四项 `carbon:emission-reports:*` 权限', '请求世代', '`CARBON_EMISSION_REPORT_PREVIEW_STALE`', '公共 DTO 白名单', '非取消 execute HTTP 失败', '百分比 `12.50%` 保持 `0.125`', 'Blob JSON', '`X-Exported-Row-Count`'] }
    ]
  },
  {
    label: '变更记录.md',
    path: CHANGELOG_PATH,
    groups: [
      { label: 'N6 finding 修复状态与恢复入口', allOf: ['2026-08-25：碳排放报告前端与正式说明书', '`RF-P0-018`', '`RF-P1-029`', '`RF-P1-030`', '`RF-P1-031`', '`RF-P2-021`', '`RF-P2-022`', '`RF-P2-023`', '`RF-P2-024`', '已修复待复审', 'N6 最终逐项复审与收尾', '不宣布 N6 工程节点关闭', '不开始 N7/N8/N9'] }
    ]
  }
];
// N7 碳核算正文冻结标识用于防止六表、记录类型、数值、权限、stale、公共 DTO、请求世代和隔离合同回退。
const n7CarbonManualMarkerGroups = [
  { label: '温室气体报告模板身份', allOf: ['模板 ID 为 `ghg-report`', '导入类型为 `ghg_report`', '模板版本为 `1.0`', '只接受 `.xlsx`'] },
  { label: '温室气体报告六部分顺序', allOf: ['1. `报告信息`', '2. `组织边界`', '3. `运行边界`', '4. `报告项目`', '5. `汇总`', '6. `证据说明`'] },
  { label: '温室气体报告记录类型与数值', allOf: ['`emission` 表示排放', '`removal` 表示清除', '清除不能通过负 `emission`', '必须非负', 'GWP 必须大于 0', '净 CO2e', '可以为正、零或负'] },
  { label: '温室气体报告四项权限', allOf: ['`carbon:ghg-reports:view`', '`carbon:ghg-reports:import:preview`', '`carbon:ghg-reports:import:execute`', '`carbon:ghg-reports:export`'] },
  { label: '温室气体报告固定确认', allOf: ['确认导入温室气体报告'] },
  { label: '温室气体报告公共 DTO', allOf: ['显式公共 DTO 白名单', '页面不读取、信任、显示或回传', 'candidate witness'] },
  { label: '温室气体报告严格执行条件', allOf: ['非负安全整数 number', '预演恰有一个 item', '状态为 `wouldImport`', 'warning/error', '逐项一致'] },
  { label: '温室气体报告 stale 与失败清空', allOf: ['HTTP 409', '`GHG_REPORT_PREVIEW_STALE`', '`requiresNewPreview: true`', '任何其他非取消 execute HTTP 失败', '清空预演'] },
  { label: '温室气体报告请求意图', allOf: ['旧 response、旧 error、旧 finally', '连续两次查看同一报告或同一批次', '独立 intent'] },
  { label: '温室气体报告详情与导出', allOf: ['六部分详情', '`X-Exported-Row-Count`', 'Blob JSON', '底层 number', '公式注入防护'] },
  { label: '温室气体报告权限和领域隔离', allOf: ['report-only', '不会加载无关能源类型字典', 'N6 view/export 不能放行 N7', '`ghg_report` 和 `carbon_emission_report` 都禁止通用删除', '模板 ID、导入类型、页面组件、权限、预演批次、业务表、详情结构和导出工作簿完全独立'] }
];
// N7 五处正式文档最低合同用于防止正文、总览、导入审计、覆盖矩阵或变更记录漏同步。
const n7ManualDocumentContracts = [
  {
    label: '09-碳核算.md',
    path: CARBON_MANUAL_PATH,
    groups: [
      { label: '六表、记录类型与数值边界', allOf: ['`ghg-report`', '`ghg_report`', '`emission`', '`removal`', '清除不能通过负', 'GWP 必须大于 0', '净 CO2e'] },
      { label: '严格执行、stale 与请求世代', allOf: ['非负安全整数 number', '状态为 `wouldImport`', '`GHG_REPORT_PREVIEW_STALE`', '任何其他非取消 execute HTTP 失败', '旧 response、旧 error、旧 finally'] },
      { label: '六部分详情、导出与隔离', allOf: ['六部分详情', '`X-Exported-Row-Count`', 'Blob JSON', 'report-only', 'N6 view/export 不能放行 N7'] }
    ]
  },
  {
    label: '00-侧边栏模块总览与数据链路.md',
    path: SIDEBAR_OVERVIEW_PATH,
    groups: [
      { label: 'N7 独立报告事实链', allOf: ['N7 固定六表 XLSX', '`emission`/`removal`', 'report-only 账号不会加载能源类型字典', 'N7 温室气体报告 -X-> N6 模板', 'N6/N7 两类报告 -X->'] }
    ]
  },
  {
    label: '05-通用导入与批次审计.md',
    path: IMPORT_AUDIT_MANUAL_PATH,
    groups: [
      { label: 'N7 批次权限与删除保护', allOf: ['`carbon:ghg-reports:view`', '`ghg_report`', '`imports:download`', '`carbon:ghg-reports:export`', 'N6/N7 模板错传必须阻断', '净 CO2e 可以为负', '不得使用该删除入口'] }
    ]
  },
  {
    label: '功能覆盖矩阵.md',
    path: COVERAGE_MATRIX_PATH,
    groups: [
      { label: 'N7 权限、数值与前端防回归', allOf: ['N7 与 N6 完全独立且前端 fail-closed', '`GHG_REPORT_PREVIEW_STALE`', '唯一 `wouldImport`', '非负安全整数', '旧 response/error/finally', '公共 DTO 白名单', '`X-Exported-Row-Count`'] }
    ]
  },
  {
    label: '变更记录.md',
    path: CHANGELOG_PATH,
    groups: [
      { label: 'N7-B 文档闭环与后续入口', allOf: ['2026-08-25：温室气体报告前端与正式说明书', 'N7-01 至 N7-08', 'N7-B 实施节点完成', 'N7 整体仍待最终独立审查与 findings 闭环', '不开始 N8/N9', '不归档'] }
    ]
  }
];
// 模板与展示日期时间统一的三份正式文档最低合同；每份文件独立校验，禁止依靠跨文件合并文本通过。
const userVisibleDateTimeDocumentContracts = [
  {
    label: '03-导航权限与通用操作.md',
    path: COMMON_OPERATIONS_MANUAL_PATH,
    groups: [
      { label: '用户可见完整 UTC 格式', allOf: ['`YYYY-MM-DD HH:mm:ss`', '严格 UTC'] },
      { label: '内部严格 UTC 格式', allOf: ['`YYYY-MM-DDTHH:mm:ssZ`', 'API、SQLite、model'] },
      { label: '来源墙钟格式与时区', allOf: ['`YYYY-MM-DD HH:mm:00`', '`YYYY-MM-DDTHH:mm`', 'IANA', '不能直接追加 `Z`'] },
      { label: 'token 与其他字段', allOf: ['`MM` 表示月份', '`mm` 表示分钟', '`YYYY-MM`', '`YYYY-MM-DD`', '`HH:mm`'] },
      { label: '新旧模板和文件边界', allOf: ['新模板、新 CSV/XLSX', '历史 ISO/T/Z', '非零毫秒', '上传原文件', 'SQLite 备份'] },
      { label: '内部安全与精度边界', allOf: ['乐观锁', '签名载荷', '内部审计', '非零秒'] }
    ]
  },
  {
    label: '功能覆盖矩阵.md',
    path: COVERAGE_MATRIX_PATH,
    groups: [
      { label: '用户可见完整 UTC 格式', allOf: ['用户可见严格 UTC `YYYY-MM-DD HH:mm:ss`'] },
      { label: '内部严格 UTC 格式', allOf: ['内部/API/SQLite/model/乐观锁/签名/计算', '`YYYY-MM-DDTHH:mm:ssZ`'] },
      { label: '来源墙钟格式与时区', allOf: ['用户可见来源墙钟 `YYYY-MM-DD HH:mm:00`', '`YYYY-MM-DDTHH:mm`', 'IANA', '不直接追加 Z'] },
      { label: 'token 与其他字段', allOf: ['`MM` 表示月份', '`mm` 表示分钟', '`YYYY-MM`', '`YYYY-MM-DD`', '`HH:mm`'] },
      { label: '新旧模板和文件边界', allOf: ['新模板、新 CSV/XLSX', '历史 ISO/T/Z', '`.000Z`', '非零毫秒', '上传原文件', 'SQLite 备份'] },
      { label: '内部安全与精度边界', allOf: ['乐观锁', '签名', '审计安全链', '非零秒'] }
    ]
  },
  {
    label: '变更记录.md',
    path: CHANGELOG_PATH,
    groups: [
      { label: '用户可见完整 UTC 格式', allOf: ['`YYYY-MM-DD HH:mm:ss`', '严格 UTC'] },
      { label: '内部严格 UTC 格式', allOf: ['`YYYY-MM-DDTHH:mm:ssZ`', 'API、SQLite、model'] },
      { label: '来源墙钟格式与时区', allOf: ['`YYYY-MM-DD HH:mm:00`', '`YYYY-MM-DDTHH:mm`', 'IANA `sourceTimeZone`', '不追加 `Z`'] },
      { label: 'token 与其他字段', allOf: ['`MM`', '`mm`', '`YYYY-MM`', '`YYYY-MM-DD`', '`HH:mm`'] },
      { label: '新旧模板和文件边界', allOf: ['新模板、新 CSV/XLSX', '旧 ISO/T/Z', '`.000Z`', '非零毫秒', '上传原文件', 'SQLite 备份'] },
      { label: '内部安全与精度边界', allOf: ['乐观锁', '签名载荷', '审计安全链', '非零秒'] }
    ]
  }
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
 * 判断文本是否包含一组必需标识中的全部成员。
 * @param {string} content 待检查文本。
 * @param {string[]} markers 必须全部命中的标识。
 * @returns {boolean} 是否全部命中。
 */
function includesAll(content, markers) {
  return markers.every((marker) => content.includes(marker));
}

/**
 * 按 allOf/anyOf 语义校验一组文档标识；同时声明时两组都必须满足。
 * @param {string} content 待检查文本。
 * @param {{ allOf?: string[], anyOf?: string[] }} markerGroup 标识合同。
 * @returns {boolean} 是否满足合同。
 */
function satisfiesMarkerGroup(content, markerGroup) {
  const allOfSatisfied = !markerGroup.allOf || includesAll(content, markerGroup.allOf);
  const anyOfSatisfied = !markerGroup.anyOf || includesAny(content, markerGroup.anyOf);
  return allOfSatisfied && anyOfSatisfied;
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

  // 青岚主步骤绝对路径用于确认根入口提供完整演示流程。
  const expectedProjectStepsPath = path.normalize(PROJECT_STEPS_PATH);
  // 是否存在青岚主步骤链接用于避免根 README 继续维护重复且过期的长流程。
  const hasProjectStepsLink = rootReadmeTargets.some((target) => {
    // 当前 README 链接绝对路径用于主步骤目标比对。
    const resolvedTarget = path.resolve(PROJECT_ROOT, target);
    return path.normalize(resolvedTarget) === expectedProjectStepsPath;
  });
  if (!hasProjectStepsLink) {
    addFailure('README.md 必须通过相对链接指向 docs/使用说明书/项目使用步骤.md。');
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
 * 从第 00 章提取二级、三级标题及各自正文范围。
 * @param {string} markdownContent 第 00 章 Markdown 文本。
 * @returns {{ level: number, title: string, content: string }[]} 标题与正文范围列表。
 */
function extractSidebarOverviewSections(markdownContent) {
  // Markdown 标题表达式用于识别当前文档中的正式模块层级。
  const headingPattern = /^(#{2,3})\s+(.+?)\s*#*\s*$/gm;
  // 标题匹配结果用于计算每个模块正文的开始和结束位置。
  const headingMatches = [];
  // 当前标题匹配用于遍历第 00 章全部二级、三级标题。
  let headingMatch;
  while ((headingMatch = headingPattern.exec(markdownContent)) !== null) {
    // 标准化标题用于去除整数、层级小数及可选末尾点号的章节编号，同时保留正式模块名称。
    const normalizedTitle = headingMatch[2].trim().replace(/^\d+(?:\.\d+)*(?:\.)?\s+/, '');
    headingMatches.push({
      level: headingMatch[1].length,
      title: normalizedTitle,
      headingStart: headingMatch.index,
      contentStart: headingPattern.lastIndex
    });
  }

  return headingMatches.map((currentHeading, currentIndex) => {
    // 后续同级或更高层级标题用于限定当前模块正文，避免借用其他模块主题。
    const nextBoundaryHeading = headingMatches
      .slice(currentIndex + 1)
      .find((candidateHeading) => candidateHeading.level <= currentHeading.level);
    // 当前正文结束位置用于截取模块自身内容。
    const contentEnd = nextBoundaryHeading ? nextBoundaryHeading.headingStart : markdownContent.length;
    return {
      level: currentHeading.level,
      title: currentHeading.title,
      content: markdownContent.slice(currentHeading.contentStart, contentEnd)
    };
  });
}

/**
 * 判断模块正文是否声明指定的固定主题标题。
 * @param {string} moduleContent 模块正文。
 * @param {string[]} topicTitles 允许的主题标题。
 * @returns {boolean} 是否存在固定主题标题。
 */
function includesSidebarOverviewTopic(moduleContent, topicTitles) {
  return topicTitles.some((topicTitle) => {
    // 转义后的主题标题用于安全构造 Markdown 列表标题表达式。
    const escapedTopicTitle = topicTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 固定主题表达式用于匹配列表中的加粗主题标题，不依赖具体正文内容。
    const topicPattern = new RegExp(`^\\s*[-*+]\\s+\\*\\*${escapedTopicTitle}\\*\\*\\s*[：:]`, 'm');
    return topicPattern.test(moduleContent);
  });
}

/**
 * 校验侧边栏模块总览的二十个正式模块均包含九个固定主题。
 */
function verifyProjectSteps() {
  // 青岚主步骤文本用于检查稳定标题、常量、执行边界和完整 artifact 清单。
  const projectStepsContent = readText(PROJECT_STEPS_PATH);
  if (!projectStepsContent) return;

  // 主步骤稳定标识用于防止首次演示、安全、导入和主动计算关键段落被误删。
  const projectStepsMarkerGroups = [
    ['安全前提和完成判定'],
    ['安装、登录、权限和演示前备份'],
    ['29 个 artifact 的唯一导入顺序'],
    ['preview / execute', 'preview/execute'],
    ['全部导入完成后的主动操作'],
    ['最终页面验收'],
    ['非自动联动总表'],
    ['QL-'],
    ['Asia/Shanghai'],
    ['真实 `data/energy-carbon.sqlite`', 'data/energy-carbon.sqlite']
  ];
  for (const projectStepsMarkerGroup of projectStepsMarkerGroups) {
    if (!includesAny(projectStepsContent, projectStepsMarkerGroup)) {
      addFailure(`项目使用步骤缺少关键主题：${projectStepsMarkerGroup.join(' / ')}`);
    }
  }

  for (const artifactKey of demoParkArtifactKeys) {
    if (!projectStepsContent.includes(artifactKey)) {
      addFailure(`项目使用步骤缺少青岚 artifact：${artifactKey}`);
    }
  }
}

/**
 * 校验侧边栏模块总览的二十个正式模块均包含九个固定主题。
 */
function verifySidebarOverviewTopics() {
  // 侧边栏总览文本用于按模块边界检查主题，不约束具体段落或大段正文。
  const sidebarOverviewContent = readText(SIDEBAR_OVERVIEW_PATH);
  if (!sidebarOverviewContent) return;

  // 第 00 章标题与正文范围用于精确定位每个正式模块。
  const sidebarOverviewSections = extractSidebarOverviewSections(sidebarOverviewContent);
  for (const moduleTitle of sidebarOverviewModuleTitles) {
    // 当前正式模块用于确保标题存在且主题不能从相邻模块借用。
    const moduleSection = sidebarOverviewSections.find((section) => section.title === moduleTitle);
    if (!moduleSection) {
      addFailure(`侧边栏模块总览缺少正式模块：${moduleTitle}`);
      continue;
    }

    for (const requiredTopic of sidebarOverviewRequiredTopics) {
      if (!includesSidebarOverviewTopic(moduleSection.content, requiredTopic.titles)) {
        addFailure(`侧边栏模块“${moduleTitle}”缺少固定主题：${requiredTopic.label}`);
      }
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
 * 校验供应商正文保留冻结的页面、权限、状态、导入和删除边界。
 */
function verifySupplierManualContract() {
  // 供应商正文文本用于逐组检查用户可见冻结契约。
  const supplierManualContent = readText(SUPPLIER_MANUAL_PATH);
  if (!supplierManualContent) return;

  for (const supplierMarkerGroup of supplierManualMarkerGroups) {
    if (!includesAny(supplierManualContent, supplierMarkerGroup.markers)) {
      addFailure(`供应商使用说明缺少契约：${supplierMarkerGroup.label}`);
    }
  }
}

/**
 * 校验碳核算正文保留独立活动、严格时间和双来源防双计冻结契约。
 */
function verifyCarbonManualContract() {
  // 碳核算正文文本用于逐组检查 N5 用户可见冻结契约。
  const carbonManualContent = readText(CARBON_MANUAL_PATH);
  if (!carbonManualContent) return;

  for (const carbonMarkerGroup of carbonManualMarkerGroups) {
    if (!satisfiesMarkerGroup(carbonManualContent, carbonMarkerGroup)) {
      addFailure(`碳核算使用说明缺少契约：${carbonMarkerGroup.label}`);
    }
  }
}

/**
 * 校验 N5 同步的五处正式文档分别保留各自最低合同。
 */
function verifyN5ManualDocumentContracts() {
  for (const documentContract of n5ManualDocumentContracts) {
    // 当前文档文本：每份文档独立读取，禁止借用其他章节的标识通过。
    const documentContent = readText(documentContract.path);
    if (!documentContent) continue;
    for (const markerGroup of documentContract.groups) {
      if (!satisfiesMarkerGroup(documentContent, markerGroup)) {
        addFailure(`${documentContract.label} 缺少 N5 最低合同：${markerGroup.label}`);
      }
    }
  }
}

/**
 * 校验碳核算正文保留 N6 模板、权限、stale、导出和非联动冻结合同。
 */
function verifyN6CarbonManualContract() {
  // 碳核算正文文本用于逐组检查 N6 碳排放报告用户契约。
  const carbonManualContent = readText(CARBON_MANUAL_PATH);
  if (!carbonManualContent) return;

  for (const markerGroup of n6CarbonManualMarkerGroups) {
    if (!satisfiesMarkerGroup(carbonManualContent, markerGroup)) {
      addFailure(`碳核算使用说明缺少 N6 契约：${markerGroup.label}`);
    }
  }
}

/**
 * 校验 N6 同步的五处正式文档分别保留各自最低合同。
 */
function verifyN6ManualDocumentContracts() {
  for (const documentContract of n6ManualDocumentContracts) {
    // 当前文档文本用于保证 N6 每份正式文档独立满足自身合同。
    const documentContent = readText(documentContract.path);
    if (!documentContent) continue;
    for (const markerGroup of documentContract.groups) {
      if (!satisfiesMarkerGroup(documentContent, markerGroup)) {
        addFailure(`${documentContract.label} 缺少 N6 最低合同：${markerGroup.label}`);
      }
    }
  }
}

/**
 * 校验碳核算正文保留 N7 六表、权限、数值、stale、导出和领域隔离冻结合同。
 */
function verifyN7CarbonManualContract() {
  // 碳核算正文文本用于逐组检查 N7 温室气体报告用户契约。
  const carbonManualContent = readText(CARBON_MANUAL_PATH);
  if (!carbonManualContent) return;

  for (const markerGroup of n7CarbonManualMarkerGroups) {
    if (!satisfiesMarkerGroup(carbonManualContent, markerGroup)) {
      addFailure(`碳核算使用说明缺少 N7 契约：${markerGroup.label}`);
    }
  }
}

/**
 * 校验 N7 同步的五处正式文档分别保留各自最低合同。
 */
function verifyN7ManualDocumentContracts() {
  for (const documentContract of n7ManualDocumentContracts) {
    // 当前文档文本用于保证 N7 每份正式文档独立满足自身合同。
    const documentContent = readText(documentContract.path);
    if (!documentContent) continue;
    for (const markerGroup of documentContract.groups) {
      if (!satisfiesMarkerGroup(documentContent, markerGroup)) {
        addFailure(`${documentContract.label} 缺少 N7 最低合同：${markerGroup.label}`);
      }
    }
  }
}

/**
 * 校验三份正式文档分别保留用户可见日期时间、历史兼容和内部安全边界。
 */
function verifyUserVisibleDateTimeDocumentContracts() {
  for (const documentContract of userVisibleDateTimeDocumentContracts) {
    // 当前文档文本单独读取，避免其他说明书中的标识掩盖本文件缺项。
    const documentContent = readText(documentContract.path);
    if (!documentContent) continue;
    for (const markerGroup of documentContract.groups) {
      if (!satisfiesMarkerGroup(documentContent, markerGroup)) {
        addFailure(`${documentContract.label} 缺少用户可见日期时间最低合同：${markerGroup.label}`);
      }
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
  verifyProjectSteps();
  verifySidebarOverviewTopics();
  verifyLocalMarkdownLinks();
  verifyCoverageMatrix();
  verifySupplierManualContract();
  verifyCarbonManualContract();
  verifyN5ManualDocumentContracts();
  verifyN6CarbonManualContract();
  verifyN6ManualDocumentContracts();
  verifyN7CarbonManualContract();
  verifyN7ManualDocumentContracts();
  verifyUserVisibleDateTimeDocumentContracts();
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
