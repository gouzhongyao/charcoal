const { getImportParseLimits } = require('./import/parser');
const { getGenerationImportExportContract } = require('./generationService');

const importRequiredFields = [
  { key: 'period', internalKey: 'month', label: '月份', normalizedTo: 'YYYY-MM', required: true, examples: ['2026-01', '2026/01', '2026.01', '2026-01-01 00:00:00', 'Excel 日期单元格'] },
  { key: 'energy_type', internalKey: 'energyType', label: '能源类型/编码', required: true, examples: ['electricity', '电力', 'photovoltaic', '光伏', 'natural_gas', 'oil', '油'] },
  { key: 'value', label: '能耗值', required: true, type: 'number', min: 0 },
  { key: 'unit', label: '单位', required: true, examples: ['kWh', 'MWh', 'm³', '万m³', 'kg', 't', 'MJ', 'GJ'] }
];

const importOptionalFields = [
  { key: 'energy_name', internalKey: 'energyType', label: '能源中文名称；energy_type 为空时可作为能源类型识别来源' },
  { key: 'organization_unit', internalKey: 'organization', label: '组织/部门/工序/用能单元' },
  { key: 'meter_name', internalKey: 'meterCode', label: '仪表或计量点名称' },
  { key: 'data_time', internalKey: 'dataTime', label: '数据时间；period 为空时可用于月份标准化' },
  { key: 'site', label: '厂区/站点' },
  { key: 'department', label: '部门' },
  { key: 'production_line', internalKey: 'productionLine', label: '产线' },
  { key: 'business_dimension', internalKey: 'businessDimension', label: '业务维度' },
  { key: 'remark', label: '备注' }
];

function getImportContract() {
  const parseLimits = getImportParseLimits();
  return {
    status: 'implemented-minimal',
    supportedFileTypes: ['.xlsx', '.xls', '.csv'],
    maxUploadFileSize: '10MB',
    uploadFieldName: 'file',
    maxJsonPayload: '2mb',
    parseLimits,
    uploadSecurity: {
      filenamePolicy: '仅接受普通文件名；拒绝路径、控制字符、系统保留字符和过长文件名。',
      mimePolicy: '按扩展名校验常见 MIME 类型；MIME 仅作补充，解析前仍检查文件头。',
      excelPolicy: 'Excel 解析仅读取第一个工作表，并限制最大行数和列数。',
      csvPolicy: 'CSV 必须为文本内容，限制单记录大小、最大行数和列数。'
    },
    duplicateStrategyStatus: 'only skip is enabled; overwrite and append are reserved for future work and must not be sent by clients yet',
    enabledDuplicateStrategies: ['skip'],
    pendingDuplicateStrategies: ['overwrite', 'append'],
    duplicateStrategies: [
      { value: 'skip', label: '跳过重复数据', isDefault: true, status: 'enabled' },
      { value: 'overwrite', label: '覆盖已有重复数据', isDefault: false, status: 'future', notEnabled: true },
      { value: 'append', label: '追加保留重复数据', isDefault: false, status: 'future', notEnabled: true }
    ],
    batchStatuses: ['pending', 'processing', 'completed', 'completed_with_errors', 'failed', 'cancelled'],
    requiredFields: importRequiredFields,
    optionalFields: importOptionalFields,
    normalization: {
      month: 'period/data_time 统一转为 YYYY-MM，并保留 original_month；支持 YYYY-MM、YYYY/MM、YYYY.MM、日期/时间和 Excel 日期单元格。',
      energyTypes: '首期字典覆盖 electricity、photovoltaic、natural_gas、gasoline、diesel、oil、coal、heat、steam、water；光伏/photovoltaic 与通用油/oil 均可通过中文或英文识别，通用 oil 不替代 gasoline/diesel。',
      unitAndValue: '保留 original_unit/original_value，同时写入 normalized_unit/normalized_value；首期覆盖电力/光伏 MWh→kWh、kWh，天然气 万m³→m³、m³，通用油/煤 kg→t、t，热力 GJ→MJ、MJ；汽油/柴油首期保持 L。',
      duplicateKey: '默认由能源类型、标准月份、组织、站点、部门、产线、表计编号、业务维度等生成稳定 SHA-256；重复数据仅启用 skip 并在批次统计/错误明细中以 warning 追溯。'
    },
    fieldMappingExamples: {
      period: ['period', '月份', '统计月份', '日期', '时间'],
      energy_type: ['energy_type', '能源类型', '能源编码'],
      energy_name: ['energy_name', '能源名称', '能源'],
      value: ['value', '用量', '消费量', '数值'],
      unit: ['unit', '单位', '计量单位'],
      organization_unit: ['organization_unit', '用能单元', '部门', '车间', '工序'],
      site: ['site', '地点', '厂区/站点'],
      department: ['department', '部门', '车间'],
      production_line: ['production_line', 'productionLine', '产线', '生产线'],
      meter_name: ['meter_name', '仪表', '表计', '计量点'],
      data_time: ['data_time', '数据时间', '采集时间'],
      business_dimension: ['business_dimension', 'businessDimension', '业务维度'],
      remark: ['remark', '备注']
    },
    deletion: {
      route: 'DELETE /api/imports/batches/:batchId',
      scope: '删除指定批次、该批次错误明细、该批次导入的能耗记录，以及这些能耗记录关联的碳排放结果；上传原件暂不物理删除。',
      predictionPolicy: '既有预测运行和结果不自动删除；删除历史数据后如需反映最新口径，请重新创建预测运行。'
    },
    persistence: {
      batchTable: 'import_batches',
      errorTable: 'import_errors',
      targetTable: 'energy_records'
    },
    templates: {
      list: 'GET /api/templates',
      recommendedFormat: 'xlsx',
      energyRecords: 'GET /api/templates/energy-records.xlsx',
      predictionHistory: 'GET /api/templates/prediction-history.xlsx',
      csvCompatibility: ['GET /api/templates/energy-records.csv', 'GET /api/templates/prediction-history.csv', 'GET /api/templates/organization-units.csv', 'GET /api/templates/meters.csv'],
      ledgerTemplates: ['GET /api/templates/organization-units.xlsx', 'GET /api/templates/meters.xlsx'],
      csvEncoding: 'UTF-8 with BOM'
    }
  };
}

function getMeterReadingContract() {
  return {
    status: 'implemented-import-export-minimal',
    table: 'meter_reading_records',
    routes: {
      list: 'GET /api/meter-readings',
      create: 'POST /api/meter-readings',
      update: 'PUT /api/meter-readings/:id',
      void: 'DELETE /api/meter-readings/:id',
      import: 'POST /api/meter-readings/import',
      export: 'GET /api/meter-readings/export?format=xlsx|csv',
      template: 'GET /api/templates/meter-readings.xlsx'
    },
    importFields: ['reading_date', 'meter_code', 'meter_name', 'previous_value', 'current_value', 'multiplier', 'usage_value', 'unit', 'organization_unit', 'remark'],
    importPolicy: '支持 .xlsx/.xls/.csv；计量器具按 meter_code 精确匹配，或 organization_unit + meter_name 匹配；必须 active 且 allow_manual_reading=1；重复按 meter_device_id + reading_date + upload 来源 active 记录默认 skip 并写 warning。',
    exportFields: ['仪表编码', '仪表名称', '用能单元', '能源类型编码', '能源类型', '抄表日期', '上期表码', '本期表码', '倍率', '用量', '单位', '标准化用量', '标准单位', '状态', '备注', '导入批次'],
    statisticsPolicy: '抄表导入只写入 meter_reading_records，不自动写入 energy_records，也不自动进入能耗统计。'
  };
}

function getGenerationContract() {
  return getGenerationImportExportContract();
}

function getEnergyRecordContract() {
  return {
    status: 'implemented-statistics-basic',
    table: 'energy_records',
    filters: ['normalizedMonthStart', 'normalizedMonthEnd', 'monthStart', 'monthEnd', 'energyTypeCode', 'organization', 'site', 'department', 'organizationUnitId', 'meterDeviceId', 'sourceBatchId'],
    pagination: { page: 1, pageSize: 20, maxPageSize: 200 },
    sort: {
      fields: ['normalizedMonth', 'energyTypeCode', 'normalizedValue', 'organization', 'site', 'department', 'sourceBatchId', 'createdAt'],
      orders: ['asc', 'desc'],
      default: { sortBy: 'normalizedMonth', sortOrder: 'desc' }
    },
    statisticsRoutes: {
      summary: 'GET /api/energy-records/statistics/summary',
      monthlyTrend: 'GET /api/energy-records/statistics/monthly-trend',
      energyTypeBreakdown: 'GET /api/energy-records/statistics/energy-type-breakdown',
      dimensionBreakdown: 'GET /api/energy-records/statistics/dimension-breakdown?dimension=organization|site|department'
    },
    dashboardRoute: 'GET /api/dashboard/summary',
    note: '当前提供能耗明细分页、基础筛选和统计聚合；工作台摘要仅基于能耗记录、导入批次和导入错误，不包含碳核算或预测结果。'
  };
}

function getCarbonContract() {
  return {
    status: 'implemented-basic',
    factorTable: 'carbon_factors',
    emissionTable: 'carbon_emissions',
    factorFields: ['energyTypeCode', 'region', 'factorYear', 'unit', 'factorValue', 'factorUnit', 'source', 'sourceUrl', 'effectiveFrom', 'effectiveTo', 'isActive'],
    factorRoutes: {
      list: 'GET /api/carbon/factors',
      upsert: 'POST /api/carbon/factors 或 POST /api/carbon/factors/upsert',
      toggleStatus: 'PATCH /api/carbon/factors/:factorId/status'
    },
    matchingKeys: ['energyTypeCode', 'normalizedUnit', 'region', 'factorYear', 'isActive'],
    matchingPriority: ['指定 region + 记录年份', 'default region + 记录年份', '指定 region + 通用年份', 'default region + 通用年份'],
    calculationBasis: 'energy_records.normalized_value * carbon_factors.factor_value',
    emissionRoutes: {
      calculate: 'POST /api/carbon/emissions/calculate',
      list: 'GET /api/carbon/emissions',
      statistics: 'GET /api/carbon/emissions/statistics?groupBy=month|energyType|organization|site',
      missingFactors: 'GET /api/carbon/emissions/missing-factors'
    },
    recalculationPolicy: '同一 energyRecordId + calculationMethod 重新计算前会将旧结果标记为 superseded，默认查询不返回 superseded，避免重复 active 结果。',
    missingFactorPolicy: '缺少匹配因子时写入 factor_missing 状态，emissionValue 保持 null，不伪造排放结果。',
    templates: {
      list: 'GET /api/templates',
      recommendedFormat: 'xlsx',
      carbonFactors: 'GET /api/templates/carbon-factors.xlsx',
      csvCompatibility: 'GET /api/templates/carbon-factors.csv',
      note: '当前碳因子模板用于维护参考和字段整理，默认下载 Excel .xlsx，CSV 仅保留兼容；字段使用能源类型编码、有效开始日期、有效结束日期和 true/false 是否启用；页面按表单逐条保存，未提供碳因子批量上传接口。'
    }
  };
}

function getBackupContract() {
  return {
    status: 'implemented-basic',
    storage: 'local-sqlite-file',
    directory: 'data/backups 或 BACKUPS_DIR 环境变量指定目录',
    routes: {
      list: 'GET /api/system/backups',
      create: 'POST /api/system/backups',
      download: 'GET /api/system/backups/:backupName/download',
      restore: 'POST /api/system/backups/:backupName/restore',
      delete: 'DELETE /api/system/backups/:backupName'
    },
    backupNamePolicy: 'backupName 必须严格匹配当前备份目录下的 .sqlite/.db 文件名，禁止路径穿越和任意文件读取。',
    createPolicy: '创建备份会对当前 SQLite 执行 WAL checkpoint，并优先使用 better-sqlite3 backup API；不可用时使用短时安全文件复制。',
    restorePolicy: '恢复进入进程内维护态后，先对源备份执行 SQLite quick_check 和关键 schema 预校验；校验通过才创建 pre-restore 备份并覆盖当前本地 SQLite；恢复后建议刷新页面并复核数据。',
    deletePolicy: '删除接口只删除当前备份目录白名单内的单个合法备份文件，不删除当前数据库、不清空目录；维护态期间拒绝删除。',
    maintenancePolicy: '恢复期间拒绝导入、批次删除、碳因子写入/启停、碳排放计算、预测创建、备份创建、备份删除和再次恢复等写操作，错误码为 MAINTENANCE_IN_PROGRESS。',
    invalidBackupPolicy: '源备份 quick_check 不通过或缺少关键表时返回 INVALID_BACKUP_FILE，文案为备份文件无效/损坏，不覆盖当前库。',
    safetyBoundary: '验证恢复时只能使用 data/integration-smoke 下的隔离 SQLite；正式业务库恢复需人工确认风险。'
  };
}

function getPredictionContract() {
  return {
    status: 'implemented-basic',
    runTable: 'prediction_runs',
    resultTable: 'prediction_results',
    implementedAlgorithms: ['moving_average', 'linear_trend'],
    reservedAlgorithms: ['year_over_year', 'manual_baseline'],
    runStatuses: ['pending', 'running', 'completed', 'failed'],
    routes: {
      createRun: 'POST /api/predictions/runs',
      listRuns: 'GET /api/predictions/runs',
      getRunDetail: 'GET /api/predictions/runs/:runId',
      listRunResults: 'GET /api/predictions/runs/:runId/results',
      listResults: 'GET /api/predictions/results'
    },
    createFields: ['name', 'algorithm', 'energyTypeCode', 'trainStartMonth', 'trainEndMonth', 'predictStartMonth', 'predictEndMonth', 'organization', 'site', 'department', 'sourceBatchId', 'windowSize'],
    historyPolicy: '至少需要 3 个历史样本月份；移动平均可通过 windowSize 设置 2-12 个月窗口，样本不足时预测运行标记 failed 且不写入预测结果。',
    warningPolicy: '预测说明会写入 parameters_json、note 和 method_note；结果仅作本地轻量趋势参考，不应表述为高精度 AI/机器学习预测。',
    templates: {
      list: 'GET /api/templates',
      recommendedFormat: 'xlsx',
      predictionHistory: 'GET /api/templates/prediction-history.xlsx',
      reusableTemplateType: 'energy-records',
      csvCompatibility: 'GET /api/templates/prediction-history.csv',
      note: '预测历史数据沿用能耗记录导入结构，可复用能耗数据导入模板或下载预测历史数据模板；前端默认下载 Excel .xlsx。'
    }
  };
}

function getApiContract() {
  return {
    status: 'contractOnly',
    responseShape: {
      success: 'boolean',
      data: 'object | array | null',
      error: '失败时包含 code/message/details',
      meta: '包含 timestamp，可追加 pagination/contractOnly 等元信息'
    },
    routes: {
      health: 'GET /api/health',
      bootstrap: 'GET /api/bootstrap',
      meta: 'GET /api/meta',
      energyTypes: 'GET /api/energy-types 或 GET /api/dictionaries/energy-types',
      importContract: 'GET /api/imports/contract 或 GET /api/dictionaries/import-contract',
      templates: 'GET /api/templates 查询可下载模板；GET /api/templates/:templateType.xlsx 下载推荐 Excel 模板；GET /api/templates/:templateType.csv 保留 UTF-8 BOM CSV 兼容模板',
      backups: 'GET /api/system/backups 列出备份；POST /api/system/backups 创建备份；GET /api/system/backups/:backupName/download 受控下载；POST /api/system/backups/:backupName/restore 恢复并自动创建 pre-restore 备份；DELETE /api/system/backups/:backupName 删除指定备份文件',
      importBatches: 'POST /api/imports/batches 创建导入批次并执行默认 skip 导入闭环；GET /api/imports/batches 查询批次；DELETE /api/imports/batches/:batchId 删除指定批次及其关联错误、能耗记录和碳排放结果',
      organizationUnits: 'GET/POST/PUT/DELETE /api/organization/units 基础台账用能单元 CRUD；POST /api/organization/units/import 导入；GET /api/organization/units/export?format=xlsx|csv 导出当前筛选结果；DELETE 返回停用结果',
      meters: 'GET/POST/PUT/DELETE /api/meters 计量器具 CRUD；POST /api/meters/import 导入；GET /api/meters/export?format=xlsx|csv 导出当前筛选结果；DELETE 返回停用结果；在线状态和网关 ID 仅为台账字段',
      meterReadings: 'GET/POST/PUT/DELETE /api/meter-readings；POST /api/meter-readings/import 导入抄表；GET /api/meter-readings/export 导出当前筛选结果；抄表不自动进入 energy_records',
      generation: 'GET/POST/PUT/DELETE /api/generation/records；GET /api/generation/contract 查看发电自用导入导出契约；GET /api/generation/records/export 导出当前筛选结果；POST /api/generation/records/import/preview 预演不写库；POST /api/generation/records/import/execute 受控导入只写 generation_records',
      energyRecords: 'GET /api/energy-records 查询已导入 active 能耗记录，兼容 organization/site/department 文本筛选并支持 organizationUnitId/meterDeviceId；GET /api/energy-records/contract 查看契约',
      energyStatistics: 'GET /api/energy-records/statistics/summary、monthly-trend、energy-type-breakdown、dimension-breakdown 查询基础统计聚合',
      dashboardSummary: 'GET /api/dashboard/summary 查询仅基于能耗记录、导入批次和错误数量的工作台摘要',
      carbonContract: 'GET /api/carbon/contract',
      carbonFactors: 'GET /api/carbon/factors 查询因子；POST /api/carbon/factors upsert 因子；PATCH /api/carbon/factors/:factorId/status 启用/停用因子',
      carbonEmissions: 'POST /api/carbon/emissions/calculate 批量计算；GET /api/carbon/emissions 查询结果；GET /api/carbon/emissions/statistics 汇总；GET /api/carbon/emissions/missing-factors 查询缺失因子',
      predictionContract: 'GET /api/predictions/contract',
      predictionRuns: 'POST /api/predictions/runs 创建轻量预测运行；GET /api/predictions/runs 查询运行；GET /api/predictions/runs/:runId 查询详情',
      predictionResults: 'GET /api/predictions/results 或 GET /api/predictions/runs/:runId/results 查询预测结果'
    }
  };
}

module.exports = {
  getApiContract,
  getBackupContract,
  getCarbonContract,
  getEnergyRecordContract,
  getGenerationContract,
  getImportContract,
  getMeterReadingContract,
  getPredictionContract
};
