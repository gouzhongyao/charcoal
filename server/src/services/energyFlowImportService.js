'use strict';

const crypto = require('crypto');
const { openDatabase: defaultOpenDatabase, uploadsDir: defaultUploadsDir } = require('../db/database');
const { badRequest } = require('../utils/errors');
const backupService = require('./backupService');
const { parseImportBuffer } = require('./import/parser');
const { normalizeUnitAndValue } = require('./import/normalization');
const {
  createPreviewAuditBatch,
  getImportAuditBatchDetail,
  getImportAuditSummary,
  replaceImportAuditIssues,
  updateExecuteAuditResult
} = require('./importAuditService');
const {
  ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
  ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
  authorizeEnergyAnalysisImportExecute,
  buildImportSummary,
  createImportIssue,
  getEnergyAnalysisImportTemplate,
  readSafeUploadFile,
  resolveEnergyAnalysisImportHmacSecret,
  stableSerialize
} = require('./energyAnalysisImportCore');
const {
  ENERGY_ANALYSIS_VERSIONS,
  ENERGY_FLOW_NODE_TYPES,
  ENERGY_FLOW_SOURCE_TYPES,
  isIanaTimeZone,
  isStrictUtcIso
} = require('./energyAnalysisContracts');
const {
  getEnergyAnalysisTemplateDefinition,
  parseEnergyAnalysisTemplateWorkbook,
  resolveTemplateRow
} = require('./energyAnalysisTemplateService');
const {
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport,
  normalizeBatchId,
  securePreviewResult
} = require('./energyAnalysisSingleBatchImportService');

// 能流节点单批次固定模板。
const ENERGY_FLOW_NODE_TEMPLATE_TYPE = 'energy-flow-nodes';
// 能流边与显式边值双批次固定模板。
const ENERGY_FLOW_BUNDLE_TEMPLATE_TYPE = 'energy-flow-edges';
// 双批次服务协议版本，用于持久化审计上下文。
const ENERGY_FLOW_BUNDLE_SERVICE_VERSION = 'energy-flow-bundle-import:v1';
// 双批次中能流边审计角色的固定元数据。
const ENERGY_FLOW_EDGE_BATCH_CONTRACT = Object.freeze({
  importType: 'energy_flow_edge',
  operation: 'energy-flow-edge-import',
  recordKind: 'energy_flow_edge',
  sheetName: '能流边'
});
// 双批次中显式边值审计角色的固定元数据。
const ENERGY_FLOW_RECORD_BATCH_CONTRACT = Object.freeze({
  importType: 'energy_flow_record',
  operation: 'energy-flow-record-import',
  recordKind: 'energy_flow_record',
  sheetName: '显式边值'
});
// 节点和边状态严格沿用 schema 冻结枚举。
const CONFIG_STATUSES = Object.freeze(['active', 'inactive']);
// 显式边值首期只允许写入 active 事实，避免缺少作废原因和时间时生成非法记录。
const IMPORTABLE_RECORD_STATUS = 'active';
// 能流模型和公式版本使用阶段契约冻结值。
const ENERGY_FLOW_VERSION = ENERGY_ANALYSIS_VERSIONS.energyFlow;

/**
 * 判断导入单元格是否为空白。
 * @param {*} value 原始值。
 * @returns {boolean} 是否为空白。
 */
function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

/**
 * 将单元格规范化为去除首尾空白的文本。
 * @param {*} value 原始值。
 * @returns {string} 规范化文本。
 */
function normalizeText(value) {
  return isBlank(value) ? '' : String(value).trim();
}

/**
 * 将可空文本规范化为 null 或非空文本。
 * @param {*} value 原始值。
 * @returns {string|null} 可空文本。
 */
function normalizeNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

/**
 * 打开可注入数据库，并标记连接是否由本服务关闭。
 * @param {object} options 依赖注入选项。
 * @returns {{db:object,shouldClose:boolean}} 数据库上下文。
 */
function openServiceDatabase(options = {}) {
  if (options.db) return { db: options.db, shouldClose: false };
  const openDatabase = typeof options.openDatabase === 'function' ? options.openDatabase : defaultOpenDatabase;
  return { db: openDatabase(), shouldClose: true };
}

/**
 * 使用当前 SQLite 连接读取或幂等创建安装级 HMAC 密钥。
 * @param {object} db SQLite 连接。
 * @param {object} options 依赖注入选项。
 * @returns {string} 安装级密钥。
 */
function resolveImportSecret(db, options = {}) {
  const readAppMeta = typeof options.readAppMeta === 'function'
    ? options.readAppMeta
    : (key) => db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value;
  const persistAppMeta = typeof options.persistAppMeta === 'function'
    ? options.persistAppMeta
    : (key, value) => {
      db.prepare(
        `INSERT INTO app_meta (key, value, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(key) DO NOTHING`
      ).run(key, value);
      return db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key)?.value;
    };
  return resolveEnergyAnalysisImportHmacSecret({
    env: options.env || process.env,
    readAppMeta,
    persistAppMeta,
    randomBytes: options.randomBytes
  });
}

/**
 * 创建能流导入行级问题。
 * @param {number} rowNumber 物理来源行号。
 * @param {string|null} fieldName 字段名。
 * @param {*} rawValue 原始值。
 * @param {string} code 稳定错误码。
 * @param {string} message 中文说明。
 * @param {'error'|'warning'} severity 严重级别。
 * @returns {object} 标准问题。
 */
function createFlowIssue(rowNumber, fieldName, rawValue, code, message, severity = 'error') {
  return createImportIssue({ rowNumber, fieldName, rawValue, code, message, severity });
}

/**
 * 将模板结构问题转换为统一导入问题。
 * @param {object} issue 模板问题。
 * @param {number} fallbackRowNumber 缺省行号。
 * @returns {object} 标准问题。
 */
function mapTemplateIssue(issue, fallbackRowNumber) {
  const rowNumber = Number.isSafeInteger(issue.sourceRowNumber) && issue.sourceRowNumber > 0
    ? issue.sourceRowNumber
    : fallbackRowNumber;
  return createFlowIssue(
    rowNumber,
    issue.expectedKey || issue.key || issue.header || null,
    issue.values || issue.header || issue.sheetName || null,
    issue.code || 'ENERGY_FLOW_TEMPLATE_STRUCTURE_INVALID',
    issue.message || '能流导入模板结构不符合冻结契约。',
    issue.severity === 'warning' ? 'warning' : 'error'
  );
}

/**
 * 合并字段映射并保留命中的全部原始标题。
 * @param {object} target 汇总对象。
 * @param {object} source 当前字段映射。
 */
function mergeFieldMapping(target, source) {
  Object.entries(source || {}).forEach(([key, headers]) => {
    const currentHeaders = target[key] || [];
    const incomingHeaders = Array.isArray(headers) ? headers : [headers];
    target[key] = [...new Set([...currentHeaders, ...incomingHeaders].filter(Boolean).map(String))];
  });
}

/**
 * 扫描中央解析器已验证的 CSV 并保留非空记录物理起始行号。
 * @param {Buffer} buffer CSV Buffer。
 * @returns {number[]} 数据记录物理行号。
 */
function getCsvPhysicalDataRowNumbers(buffer) {
  const text = buffer.toString('utf8').replace(/^﻿/, '');
  const recordStartLines = [];
  let recordStartIndex = 0;
  let recordStartLine = 1;
  let currentLine = 1;
  let inQuotes = false;
  const appendRecord = (endIndex) => {
    if (text.slice(recordStartIndex, endIndex).trim() !== '') recordStartLines.push(recordStartLine);
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (inQuotes && text[index + 1] === '"') index += 1;
      else inQuotes = !inQuotes;
      continue;
    }
    const isLineFeed = character === '\n';
    const isBareCarriageReturn = character === '\r' && text[index + 1] !== '\n';
    if (!isLineFeed && !isBareCarriageReturn) continue;
    if (!inQuotes) {
      const endIndex = isLineFeed && index > 0 && text[index - 1] === '\r' ? index - 1 : index;
      appendRecord(endIndex);
      recordStartIndex = index + 1;
      recordStartLine = currentLine + 1;
    }
    currentLine += 1;
  }
  if (recordStartIndex < text.length) appendRecord(text.length);
  return recordStartLines.slice(1);
}

/**
 * 安全调用模板工作簿解析器并转换为统一 BAD_REQUEST。
 * @param {string} templateType 模板类型。
 * @param {Buffer} buffer XLSX Buffer。
 * @returns {object} 模板解析结果。
 */
function parseTemplateWorkbookSafely(templateType, buffer) {
  try {
    return parseEnergyAnalysisTemplateWorkbook(templateType, buffer);
  } catch (error) {
    if (error?.code === 'BAD_REQUEST') throw error;
    throw badRequest(error?.message || '能流导入工作簿解析失败。', {
      code: error?.code || 'ENERGY_FLOW_WORKBOOK_INVALID',
      ...(error?.details || {})
    });
  }
}

/**
 * 解析节点模板并保留 XLSX/CSV 真实物理来源行号。
 * @param {Buffer} buffer 安全文件 Buffer。
 * @param {string} originalFilename 原始文件名。
 * @returns {object} 节点模板解析结果。
 */
function parseEnergyFlowNodeRows(buffer, originalFilename) {
  const parsed = parseImportBuffer(buffer, originalFilename);
  const definition = getEnergyAnalysisTemplateDefinition(ENERGY_FLOW_NODE_TEMPLATE_TYPE);
  if (!definition.formats.includes(parsed.fileType)) {
    throw badRequest('能流节点模板仅支持 .xlsx 或 .csv 文件。', {
      code: 'ENERGY_FLOW_NODE_FILE_TYPE_UNSUPPORTED',
      fileType: parsed.fileType
    });
  }
  const fieldMapping = {};
  if (parsed.fileType === 'xlsx') {
    const workbookResult = parseTemplateWorkbookSafely(ENERGY_FLOW_NODE_TEMPLATE_TYPE, buffer);
    const sheet = workbookResult.sheetsByName?.['能流节点'] || null;
    const rows = (sheet?.resolvedRows || []).map((resolvedRow) => {
      mergeFieldMapping(fieldMapping, resolvedRow.fieldMapping);
      return {
        sourceRowNumber: resolvedRow.sourceRowNumber,
        mapped: resolvedRow.record,
        issues: (resolvedRow.issues || []).map((issue) => mapTemplateIssue(issue, resolvedRow.sourceRowNumber || 2))
      };
    });
    const globalIssues = [
      ...(workbookResult.sheetCollection?.issues || []),
      ...(sheet?.headerIssues || [])
    ].map((issue) => mapTemplateIssue(issue, 1));
    return { fileType: parsed.fileType, rows, globalIssues, fieldMapping };
  }

  const physicalRowNumbers = getCsvPhysicalDataRowNumbers(buffer);
  const rows = parsed.rows.map((row, index) => {
    const sourceRowNumber = physicalRowNumbers.length === parsed.rows.length ? physicalRowNumbers[index] : index + 2;
    const resolvedRow = resolveTemplateRow(ENERGY_FLOW_NODE_TEMPLATE_TYPE, row, { sourceRowNumber });
    mergeFieldMapping(fieldMapping, resolvedRow.fieldMapping);
    return {
      sourceRowNumber,
      mapped: resolvedRow.record,
      issues: (resolvedRow.issues || []).map((issue) => mapTemplateIssue(issue, sourceRowNumber))
    };
  });
  return { fileType: parsed.fileType, rows, globalIssues: [], fieldMapping };
}

/**
 * 解析双工作表能流模板；CSV、XLS、损坏、缺失或额外工作表均由服务端拒绝或阻断。
 * @param {Buffer} buffer 安全 XLSX Buffer。
 * @param {string} originalFilename 原始文件名。
 * @returns {object} 双工作表模板解析结果。
 */
function parseEnergyFlowBundleRows(buffer, originalFilename) {
  const extension = String(originalFilename || '').split('.').pop().toLowerCase();
  if (extension !== 'xlsx') {
    throw badRequest('能流边及显式边值导入必须使用包含两个工作表的 .xlsx 文件。', {
      code: 'ENERGY_FLOW_BUNDLE_XLSX_REQUIRED',
      fileType: extension || null
    });
  }
  const workbookResult = parseTemplateWorkbookSafely(ENERGY_FLOW_BUNDLE_TEMPLATE_TYPE, buffer);
  const parseSheet = (sheetName) => {
    const sheet = workbookResult.sheetsByName?.[sheetName] || null;
    const fieldMapping = {};
    const rows = (sheet?.resolvedRows || []).map((resolvedRow) => {
      mergeFieldMapping(fieldMapping, resolvedRow.fieldMapping);
      return {
        sourceRowNumber: resolvedRow.sourceRowNumber,
        mapped: resolvedRow.record,
        issues: (resolvedRow.issues || []).map((issue) => mapTemplateIssue(issue, resolvedRow.sourceRowNumber || 2))
      };
    });
    // 工作表集合错误会破坏双批次整体契约，必须同时阻断两张工作表的候选，不能只阻断缺失工作表。
    const sheetIssues = [
      ...(workbookResult.sheetCollection?.issues || []),
      ...(sheet?.headerIssues || [])
    ].map((issue) => mapTemplateIssue(issue, 1));
    return { sheetName, rows, globalIssues: sheetIssues, fieldMapping };
  };
  return {
    fileType: 'xlsx',
    workbookResult,
    edgeSheet: parseSheet('能流边'),
    recordSheet: parseSheet('显式边值')
  };
}

/**
 * 根据模板定义补齐必填字段问题。
 * @param {string} templateType 模板类型。
 * @param {string} sheetName 工作表名称。
 * @param {object} mapped 映射记录。
 * @param {number} rowNumber 物理行号。
 * @returns {object[]} 必填问题。
 */
function validateRequiredFields(templateType, sheetName, mapped, rowNumber) {
  const definition = getEnergyAnalysisTemplateDefinition(templateType);
  const sheet = definition.sheets.find((item) => item.name === sheetName);
  return sheet.columns
    .filter((column) => column.required && isBlank(mapped[column.key]))
    .map((column) => createFlowIssue(
      rowNumber,
      column.key,
      mapped[column.key],
      'REQUIRED_FIELD_MISSING',
      `必填字段“${column.name}”不能为空。`
    ));
}

/**
 * 把全局结构问题附加到真实行，空工作表则创建仅用于审计的结构行。
 * @param {object[]} rows 行结果。
 * @param {object[]} globalIssues 全局问题。
 * @returns {object[]} 完整行结果。
 */
function attachGlobalIssues(rows, globalIssues) {
  if (!globalIssues || globalIssues.length === 0) return rows;
  if (rows.length === 0) {
    rows.push({ rowNumber: 1, mapped: {}, issues: [...globalIssues], record: null, structuralOnly: true });
    return rows;
  }
  const errors = globalIssues.filter((issue) => issue.severity === 'error');
  const warnings = globalIssues.filter((issue) => issue.severity === 'warning');
  rows.forEach((row) => row.issues.push(...errors));
  rows[0].issues.push(...warnings);
  return rows;
}

/**
 * 加载节点导入所需的模型、组织和表计现状；表计仅用于明确风险说明，节点 schema 不含表计外键。
 * @param {object} db SQLite 连接。
 * @returns {object} 主数据索引。
 */
function loadNodeMasterData(db) {
  const modelsByIdentity = new Map(db.prepare(
    `SELECT id, model_code AS modelCode, model_name AS modelName, source, document_no AS documentNo,
            version, effective_start_utc AS effectiveStartUtc, effective_end_utc AS effectiveEndUtc,
            source_timezone AS sourceTimeZone, status
     FROM energy_flow_models`
  ).all().map((row) => [`${row.modelCode}\0${row.version}`, row]));
  const organizations = new Map(db.prepare(
    `SELECT id, unit_code AS code, unit_name AS name, status FROM organization_units`
  ).all().map((row) => [String(row.code), row]));
  return { modelsByIdentity, organizations };
}

/**
 * 校验模板中的模型快照与数据库 active 模型完全绑定。
 * @param {object} mapped 模板行。
 * @param {number} rowNumber 物理行号。
 * @param {Map<string,object>} modelsByIdentity 模型索引。
 * @returns {{model:object|null,issues:object[]}} 模型解析结果。
 */
function resolveActiveFlowModel(mapped, rowNumber, modelsByIdentity) {
  const modelCode = normalizeText(mapped.modelCode);
  const modelVersion = normalizeText(mapped.modelVersion);
  const model = modelsByIdentity.get(`${modelCode}\0${modelVersion}`) || null;
  const issues = [];
  if (!model) {
    issues.push(createFlowIssue(rowNumber, 'modelCode', { modelCode, modelVersion }, 'ENERGY_FLOW_MODEL_NOT_FOUND', '指定编码和版本的能流模型不存在，不会自动创建模型。'));
    return { model: null, issues };
  }
  if (model.status !== 'active') {
    issues.push(createFlowIssue(rowNumber, 'modelCode', modelCode, 'ENERGY_FLOW_MODEL_INACTIVE', '能流模型已停用。'));
  }
  const snapshotFields = [
    ['modelName', 'modelName', '模型名称'],
    ['modelSource', 'source', '模型来源'],
    ['modelDocumentNo', 'documentNo', '模型文号'],
    ['modelEffectiveStartUtc', 'effectiveStartUtc', '模型生效开始时间'],
    ['modelEffectiveEndUtc', 'effectiveEndUtc', '模型生效结束时间'],
    ['sourceTimeZone', 'sourceTimeZone', '来源时区']
  ];
  snapshotFields.forEach(([templateField, modelField, label]) => {
    const actual = normalizeNullableText(mapped[templateField]);
    const expected = normalizeNullableText(model[modelField]);
    if (actual !== expected) {
      issues.push(createFlowIssue(rowNumber, templateField, mapped[templateField], 'ENERGY_FLOW_MODEL_SNAPSHOT_MISMATCH', `${label}与已维护模型不一致。`));
    }
  });
  return { model, issues };
}

/**
 * 校验单条能流节点并生成可比较事实。
 * @param {object} row 模板映射行。
 * @param {object} masterData 主数据。
 * @returns {object} 行结果。
 */
function validateEnergyFlowNodeRow(row, masterData) {
  const mapped = row.mapped || {};
  const rowNumber = row.sourceRowNumber;
  const issues = [...(row.issues || []), ...validateRequiredFields(ENERGY_FLOW_NODE_TEMPLATE_TYPE, '能流节点', mapped, rowNumber)];
  const modelResolution = resolveActiveFlowModel(mapped, rowNumber, masterData.modelsByIdentity);
  issues.push(...modelResolution.issues);
  const nodeCode = normalizeText(mapped.nodeCode);
  const nodeName = normalizeText(mapped.nodeName);
  const nodeType = normalizeText(mapped.nodeType);
  const organizationCode = normalizeText(mapped.organizationUnitCode);
  const status = normalizeText(mapped.status) || 'active';
  const organization = organizationCode ? masterData.organizations.get(organizationCode) : null;
  const x = isBlank(mapped.x) ? null : Number(mapped.x);
  const y = isBlank(mapped.y) ? null : Number(mapped.y);

  if (!ENERGY_FLOW_NODE_TYPES.includes(nodeType)) {
    issues.push(createFlowIssue(rowNumber, 'nodeType', mapped.nodeType, 'INVALID_ENERGY_FLOW_NODE_TYPE', `节点类型仅支持 ${ENERGY_FLOW_NODE_TYPES.join('、')}。`));
  }
  if (organizationCode && !organization) {
    issues.push(createFlowIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'ORGANIZATION_UNIT_NOT_FOUND', '用能单元编码不存在，不会自动创建主数据。'));
  } else if (organization && organization.status !== 'active') {
    issues.push(createFlowIssue(rowNumber, 'organizationUnitCode', mapped.organizationUnitCode, 'ORGANIZATION_UNIT_INACTIVE', '用能单元已停用。'));
  }
  if (!Number.isFinite(x)) {
    issues.push(createFlowIssue(rowNumber, 'x', mapped.x, 'INVALID_ENERGY_FLOW_NODE_COORDINATE', '横坐标必须是有限数值。'));
  }
  if (!Number.isFinite(y)) {
    issues.push(createFlowIssue(rowNumber, 'y', mapped.y, 'INVALID_ENERGY_FLOW_NODE_COORDINATE', '纵坐标必须是有限数值。'));
  }
  if (!CONFIG_STATUSES.includes(status)) {
    issues.push(createFlowIssue(rowNumber, 'status', mapped.status, 'INVALID_ENERGY_FLOW_NODE_STATUS', '节点状态仅支持 active 或 inactive。'));
  }

  const record = modelResolution.model && nodeCode && nodeName && ENERGY_FLOW_NODE_TYPES.includes(nodeType)
    && (!organizationCode || organization) && Number.isFinite(x) && Number.isFinite(y) && CONFIG_STATUSES.includes(status)
    ? {
      sourceRowNumber: rowNumber,
      energyFlowModelId: modelResolution.model.id,
      modelCode: modelResolution.model.modelCode,
      modelVersion: modelResolution.model.version,
      nodeCode,
      nodeName,
      nodeType,
      organizationUnitId: organization ? organization.id : null,
      organizationUnitCode: organizationCode || null,
      x,
      y,
      status
    }
    : null;
  return { rowNumber, mapped, issues, record };
}

/**
 * 判断数据库节点与候选节点是否为完全相同事实。
 * @param {object} existing 数据库节点。
 * @param {object} candidate 候选节点。
 * @returns {boolean} 是否完全相同。
 */
function isExactNodeFact(existing, candidate) {
  return Number(existing.energyFlowModelId) === Number(candidate.energyFlowModelId)
    && existing.nodeCode === candidate.nodeCode
    && existing.nodeName === candidate.nodeName
    && existing.nodeType === candidate.nodeType
    && Number(existing.organizationUnitId ?? 0) === Number(candidate.organizationUnitId ?? 0)
    && Number(existing.x) === Number(candidate.x)
    && Number(existing.y) === Number(candidate.y)
    && existing.status === candidate.status;
}

/**
 * 为行追加去重后的错误或警告。
 * @param {object} row 行结果。
 * @param {object} issue 标准问题。
 */
function appendUniqueIssue(row, issue) {
  const identity = stableSerialize(issue);
  if (!(row.issues || []).some((item) => stableSerialize(item) === identity)) row.issues.push(issue);
}

/**
 * 标记文件内同业务键的完全重复和冲突节点。
 * @param {object[]} rows 节点行。
 */
function markInputNodeDuplicates(rows) {
  const groups = new Map();
  rows.filter((row) => row.record && !row.issues.some((issue) => issue.severity === 'error')).forEach((row) => {
    const key = `${row.record.energyFlowModelId}\0${row.record.nodeCode}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  });
  groups.forEach((group) => {
    if (group.length < 2) return;
    const first = group[0];
    const allExact = group.every((row) => isExactNodeFact(first.record, row.record));
    if (allExact) {
      group.slice(1).forEach((row) => {
        row.skipDuplicate = true;
        appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'nodeCode', row.record.nodeCode, 'DUPLICATE_ENERGY_FLOW_NODE_SKIPPED', '文件内已存在完全相同节点，本行按 skip 策略跳过。', 'warning'));
      });
      return;
    }
    group.forEach((row) => appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'nodeCode', row.record.nodeCode, 'CONFLICTING_ENERGY_FLOW_NODE', '文件内同模型节点编码存在冲突定义。')));
  });
}

/**
 * 标记数据库中完全相同节点为 skip，冲突定义为阻断。
 * @param {object} db SQLite 连接。
 * @param {object[]} rows 节点行。
 */
function markDatabaseNodeDuplicates(db, rows) {
  const selectNode = db.prepare(
    `SELECT id, energy_flow_model_id AS energyFlowModelId, node_code AS nodeCode,
            node_name AS nodeName, node_type AS nodeType, organization_unit_id AS organizationUnitId,
            x, y, status
     FROM energy_flow_nodes
     WHERE energy_flow_model_id = ? AND node_code = ?`
  );
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const existing = selectNode.get(row.record.energyFlowModelId, row.record.nodeCode);
    if (!existing) return;
    if (isExactNodeFact(existing, row.record)) {
      row.skipDuplicate = true;
      row.existingId = existing.id;
      appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'nodeCode', row.record.nodeCode, 'DUPLICATE_ENERGY_FLOW_NODE_SKIPPED', '数据库已存在完全相同节点，本行按 skip 策略跳过。', 'warning'));
      return;
    }
    appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'nodeCode', row.record.nodeCode, 'CONFLICTING_ENERGY_FLOW_NODE', '数据库同模型节点编码已存在冲突定义。'));
  });
}

/**
 * 为节点候选生成稳定 ID。
 * @param {object} record 节点事实。
 * @returns {string} 稳定候选 ID。
 */
function buildNodeCandidateRowId(record) {
  const digest = crypto.createHash('sha256').update(stableSerialize(record)).digest('hex').slice(0, 20);
  return `energy-flow-node:${record.sourceRowNumber}:${digest}`;
}

/**
 * 构建能流节点单批次 preview。
 * @param {object} input 数据库、Buffer 与文件上下文。
 * @returns {object} 领域 preview。
 */
function buildEnergyFlowNodeImportPreview(input) {
  const parsedRows = parseEnergyFlowNodeRows(input.buffer, input.originalFilename);
  const masterData = loadNodeMasterData(input.db);
  const rows = parsedRows.rows.map((row) => validateEnergyFlowNodeRow(row, masterData));
  attachGlobalIssues(rows, parsedRows.globalIssues);
  markInputNodeDuplicates(rows);
  markDatabaseNodeDuplicates(input.db, rows);
  const items = rows.map((row) => {
    const hasError = row.issues.some((issue) => issue.severity === 'error');
    return {
      rowNumber: row.rowNumber,
      sourceRowNumber: row.rowNumber,
      status: hasError ? 'blocked' : (row.skipDuplicate ? 'skipped' : 'wouldImport'),
      issues: row.issues,
      normalizedRecord: row.record,
      structuralOnly: row.structuralOnly === true
    };
  });
  const candidateRows = rows
    .filter((row) => row.record && !row.skipDuplicate && !row.issues.some((issue) => issue.severity === 'error'))
    .map((row) => ({ candidateRowId: buildNodeCandidateRowId(row.record), ...row.record }));
  return {
    fileType: parsedRows.fileType,
    fieldMapping: parsedRows.fieldMapping,
    items,
    candidateRows,
    summary: buildImportSummary(items),
    auditIssues: items.flatMap((item) => item.issues || []),
    notices: [
      'preview 不写 energy_flow_nodes；execute 将从持久化批次找回原文件并重新解析。',
      '节点不会自动创建能流模型、组织或表计；当前 energy_flow_nodes schema 与模板均不含表计外键。'
    ]
  };
}

/**
 * 在调用方事务内插入已复核的节点候选。
 * @param {object} input 数据库、批次和候选上下文。
 * @returns {object} 插入结果。
 */
function insertEnergyFlowNodeCandidates(input) {
  const insertNode = input.db.prepare(
    `INSERT INTO energy_flow_nodes (
       source_batch_id, source_row_number, energy_flow_model_id, node_code, node_name,
       node_type, organization_unit_id, x, y, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const importedIds = [];
  const importedItems = [];
  input.candidateRows.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertCandidate === 'function') input.options.beforeInsertCandidate({ candidate, index, db: input.db });
    const result = insertNode.run(
      input.batchId,
      candidate.sourceRowNumber,
      candidate.energyFlowModelId,
      candidate.nodeCode,
      candidate.nodeName,
      candidate.nodeType,
      candidate.organizationUnitId,
      candidate.x,
      candidate.y,
      candidate.status
    );
    const importedId = Number(result.lastInsertRowid);
    importedIds.push(importedId);
    importedItems.push({ id: importedId, candidateRowId: candidate.candidateRowId, sourceRowNumber: candidate.sourceRowNumber });
    if (typeof input.options.afterInsertCandidate === 'function') input.options.afterInsertCandidate({ candidate, index, importedId, db: input.db });
  });
  return { imported: importedIds.length, importedIds, importedItems };
}

// 节点导入复用单批次底座的固定描述器。
const ENERGY_FLOW_NODE_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: ENERGY_FLOW_NODE_TEMPLATE_TYPE,
  buildPreview: buildEnergyFlowNodeImportPreview,
  insertCandidates: insertEnergyFlowNodeCandidates
});

/**
 * 创建能流节点 preview 审计批次。
 * @param {object} file Multer 已落盘文件对象。
 * @param {object} options 依赖注入选项。
 * @returns {object} 安全 preview。
 */
function previewEnergyFlowNodeImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, ENERGY_FLOW_NODE_IMPORT_DESCRIPTOR, options);
}

/**
 * 执行能流节点单批次导入。
 * @param {object} body execute 请求体。
 * @param {object} options 依赖注入选项。
 * @returns {Promise<object>} execute 结果。
 */
async function executeEnergyFlowNodeImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, ENERGY_FLOW_NODE_IMPORT_DESCRIPTOR, options);
}

/**
 * 加载双工作表导入需要的模型、节点、能源类型和既有边索引。
 * @param {object} db SQLite 连接。
 * @returns {object} 主数据索引。
 */
function loadBundleMasterData(db) {
  const modelsByIdentity = new Map(db.prepare(
    `SELECT id, model_code AS modelCode, version, status FROM energy_flow_models`
  ).all().map((row) => [`${row.modelCode}\0${row.version}`, row]));
  const nodeRows = db.prepare(
    `SELECT id, energy_flow_model_id AS energyFlowModelId, node_code AS nodeCode, status
     FROM energy_flow_nodes`
  ).all();
  const nodesByIdentity = new Map(nodeRows.map((row) => [`${row.energyFlowModelId}\0${row.nodeCode}`, row]));
  const nodesByCode = new Map();
  nodeRows.forEach((row) => nodesByCode.set(row.nodeCode, [...(nodesByCode.get(row.nodeCode) || []), row]));
  const energyTypes = new Map(db.prepare(
    `SELECT id, code, name, standard_unit AS standardUnit, is_active AS isActive FROM energy_types`
  ).all().map((row) => [String(row.code), row]));
  const edgesByIdentity = new Map(db.prepare(
    `SELECT id, energy_flow_model_id AS energyFlowModelId, edge_code AS edgeCode,
            from_node_id AS fromNodeId, to_node_id AS toNodeId, energy_type_id AS energyTypeId,
            unit, source_type AS sourceType, source_mapping_json AS sourceMappingJson, status
     FROM energy_flow_edges`
  ).all().map((row) => [`${row.energyFlowModelId}\0${row.edgeCode}`, row]));
  return { modelsByIdentity, nodesByIdentity, nodesByCode, energyTypes, edgesByIdentity };
}

/**
 * 解析 active 模型编码与版本。
 * @param {object} mapped 模板记录。
 * @param {number} rowNumber 物理行号。
 * @param {object} masterData 主数据。
 * @returns {{model:object|null,issues:object[]}} 模型结果。
 */
function resolveBundleModel(mapped, rowNumber, masterData) {
  const modelCode = normalizeText(mapped.modelCode);
  const modelVersion = normalizeText(mapped.modelVersion);
  const model = masterData.modelsByIdentity.get(`${modelCode}\0${modelVersion}`) || null;
  const issues = [];
  if (!model) {
    issues.push(createFlowIssue(rowNumber, 'modelCode', { modelCode, modelVersion }, 'ENERGY_FLOW_MODEL_NOT_FOUND', '指定编码和版本的能流模型不存在。'));
  } else if (model.status !== 'active') {
    issues.push(createFlowIssue(rowNumber, 'modelCode', modelCode, 'ENERGY_FLOW_MODEL_INACTIVE', '能流模型已停用。'));
  }
  return { model, issues };
}

/**
 * 将来源标识解析为 schema 要求的非空 JSON 对象。
 * @param {*} rawValue 来源标识或 JSON 文本。
 * @param {number} rowNumber 物理行号。
 * @param {string} fieldName 字段名。
 * @returns {{mapping:object|null,mappingJson:string|null,issues:object[]}} 来源映射结果。
 */
function parseSourceMapping(rawValue, rowNumber, fieldName = 'sourceReference') {
  const text = normalizeText(rawValue);
  const issues = [];
  if (!text) {
    issues.push(createFlowIssue(rowNumber, fieldName, rawValue, 'TOPOLOGY_SOURCE_UNMAPPED', '来源映射不能为空。'));
    return { mapping: null, mappingJson: null, issues };
  }
  let mapping;
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      mapping = JSON.parse(text);
    } catch (_error) {
      issues.push(createFlowIssue(rowNumber, fieldName, rawValue, 'INVALID_SOURCE_MAPPING_JSON', '来源映射 JSON 格式错误。'));
      return { mapping: null, mappingJson: null, issues };
    }
  } else {
    mapping = { reference: text };
  }
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || !normalizeText(mapping.reference)) {
    issues.push(createFlowIssue(rowNumber, fieldName, rawValue, 'TOPOLOGY_SOURCE_UNMAPPED', '来源映射必须是包含非空 reference 的 JSON 对象。'));
    return { mapping: null, mappingJson: null, issues };
  }
  const normalizedMapping = { ...mapping, reference: normalizeText(mapping.reference) };
  return { mapping: normalizedMapping, mappingJson: stableSerialize(normalizedMapping), issues };
}

/**
 * 判断单位是否与能源类型标准化规则兼容。
 * @param {object|null} energyType 能源类型。
 * @param {string} unit 单位。
 * @returns {boolean} 是否兼容。
 */
function isEnergyUnitCompatible(energyType, unit) {
  if (!energyType || !unit) return false;
  const normalized = normalizeUnitAndValue(energyType.code, unit, 1);
  return Boolean(normalized && normalized.normalizedUnit === energyType.standardUnit);
}

/**
 * 校验能流边模板行并生成事实记录。
 * @param {object} row 模板行。
 * @param {object} masterData 主数据。
 * @returns {object} 行结果。
 */
function validateEnergyFlowEdgeRow(row, masterData) {
  const mapped = row.mapped || {};
  const rowNumber = row.sourceRowNumber;
  const issues = [...(row.issues || []), ...validateRequiredFields(ENERGY_FLOW_BUNDLE_TEMPLATE_TYPE, '能流边', mapped, rowNumber)];
  const modelResolution = resolveBundleModel(mapped, rowNumber, masterData);
  issues.push(...modelResolution.issues);
  const edgeCode = normalizeText(mapped.edgeCode);
  const fromNodeCode = normalizeText(mapped.fromNodeCode);
  const toNodeCode = normalizeText(mapped.toNodeCode);
  const energyTypeCode = normalizeText(mapped.energyTypeCode);
  const unit = normalizeText(mapped.unit);
  const sourceType = normalizeText(mapped.sourceType);
  const status = normalizeText(mapped.status) || 'active';
  const modelId = modelResolution.model?.id || null;
  const fromNode = modelId ? masterData.nodesByIdentity.get(`${modelId}\0${fromNodeCode}`) : null;
  const toNode = modelId ? masterData.nodesByIdentity.get(`${modelId}\0${toNodeCode}`) : null;
  const energyType = masterData.energyTypes.get(energyTypeCode) || null;
  const sourceMapping = parseSourceMapping(mapped.sourceReference, rowNumber);
  issues.push(...sourceMapping.issues);

  if (fromNodeCode && !fromNode) {
    const existsInOtherModel = (masterData.nodesByCode.get(fromNodeCode) || []).some((node) => Number(node.energyFlowModelId) !== Number(modelId));
    issues.push(createFlowIssue(
      rowNumber,
      'fromNodeCode',
      mapped.fromNodeCode,
      existsInOtherModel ? 'ENERGY_FLOW_CROSS_MODEL_ENDPOINT' : 'ENERGY_FLOW_FROM_NODE_NOT_FOUND',
      existsInOtherModel ? '起点节点存在于其他模型，禁止跨模型端点。' : '起点节点不存在于指定模型。'
    ));
  } else if (fromNode && fromNode.status !== 'active') issues.push(createFlowIssue(rowNumber, 'fromNodeCode', mapped.fromNodeCode, 'ENERGY_FLOW_FROM_NODE_INACTIVE', '起点节点已停用。'));
  if (toNodeCode && !toNode) {
    const existsInOtherModel = (masterData.nodesByCode.get(toNodeCode) || []).some((node) => Number(node.energyFlowModelId) !== Number(modelId));
    issues.push(createFlowIssue(
      rowNumber,
      'toNodeCode',
      mapped.toNodeCode,
      existsInOtherModel ? 'ENERGY_FLOW_CROSS_MODEL_ENDPOINT' : 'ENERGY_FLOW_TO_NODE_NOT_FOUND',
      existsInOtherModel ? '终点节点存在于其他模型，禁止跨模型端点。' : '终点节点不存在于指定模型。'
    ));
  } else if (toNode && toNode.status !== 'active') issues.push(createFlowIssue(rowNumber, 'toNodeCode', mapped.toNodeCode, 'ENERGY_FLOW_TO_NODE_INACTIVE', '终点节点已停用。'));
  if (fromNode && toNode && Number(fromNode.id) === Number(toNode.id)) issues.push(createFlowIssue(rowNumber, 'toNodeCode', mapped.toNodeCode, 'ENERGY_FLOW_SELF_LOOP_UNSUPPORTED', '能流边禁止自环。'));
  if (!energyType) issues.push(createFlowIssue(rowNumber, 'energyTypeCode', mapped.energyTypeCode, 'ENERGY_TYPE_NOT_FOUND', '能源类型编码不存在。'));
  else if (Number(energyType.isActive) !== 1) issues.push(createFlowIssue(rowNumber, 'energyTypeCode', mapped.energyTypeCode, 'ENERGY_TYPE_INACTIVE', '能源类型已停用。'));
  if (energyType && unit && !isEnergyUnitCompatible(energyType, unit)) issues.push(createFlowIssue(rowNumber, 'unit', mapped.unit, 'ENERGY_FLOW_UNIT_INCOMPATIBLE', '单位与能源类型不兼容。'));
  if (!ENERGY_FLOW_SOURCE_TYPES.includes(sourceType)) issues.push(createFlowIssue(rowNumber, 'sourceType', mapped.sourceType, 'INVALID_ENERGY_FLOW_SOURCE_TYPE', `来源类型仅支持 ${ENERGY_FLOW_SOURCE_TYPES.join('、')}。`));
  if (!CONFIG_STATUSES.includes(status)) issues.push(createFlowIssue(rowNumber, 'status', mapped.status, 'INVALID_ENERGY_FLOW_EDGE_STATUS', '边状态仅支持 active 或 inactive。'));

  const record = modelResolution.model && edgeCode && fromNode && toNode && Number(fromNode.id) !== Number(toNode.id)
    && energyType && isEnergyUnitCompatible(energyType, unit) && ENERGY_FLOW_SOURCE_TYPES.includes(sourceType)
    && sourceMapping.mappingJson && CONFIG_STATUSES.includes(status)
    ? {
      sourceRowNumber: rowNumber,
      energyFlowModelId: modelResolution.model.id,
      modelCode: modelResolution.model.modelCode,
      modelVersion: modelResolution.model.version,
      edgeCode,
      fromNodeId: fromNode.id,
      fromNodeCode,
      toNodeId: toNode.id,
      toNodeCode,
      energyTypeId: energyType.id,
      energyTypeCode: energyType.code,
      unit,
      sourceType,
      sourceMappingJson: sourceMapping.mappingJson,
      status
    }
    : null;
  return { rowNumber, mapped, issues, record };
}

/**
 * 判断已有边与候选边是否完全相同。
 * @param {object} existing 已有边。
 * @param {object} candidate 候选边。
 * @returns {boolean} 是否完全相同。
 */
function isExactEdgeFact(existing, candidate) {
  return Number(existing.energyFlowModelId) === Number(candidate.energyFlowModelId)
    && existing.edgeCode === candidate.edgeCode
    && Number(existing.fromNodeId) === Number(candidate.fromNodeId)
    && Number(existing.toNodeId) === Number(candidate.toNodeId)
    && Number(existing.energyTypeId) === Number(candidate.energyTypeId)
    && normalizeText(existing.unit).toLocaleLowerCase('en-US') === candidate.unit.toLocaleLowerCase('en-US')
    && existing.sourceType === candidate.sourceType
    && stableSerialize(JSON.parse(existing.sourceMappingJson)) === candidate.sourceMappingJson
    && existing.status === candidate.status;
}

/**
 * 为边候选生成稳定 ID。
 * @param {object} record 边事实。
 * @returns {string} 稳定候选 ID。
 */
function buildEdgeCandidateRowId(record) {
  const digest = crypto.createHash('sha256').update(stableSerialize(record)).digest('hex').slice(0, 20);
  return `energy-flow-edge:${record.sourceRowNumber}:${digest}`;
}

/**
 * 标记文件内边编码完全重复与冲突。
 * @param {object[]} rows 边行。
 */
function markInputEdgeDuplicates(rows) {
  const groups = new Map();
  rows.filter((row) => row.record && !row.issues.some((issue) => issue.severity === 'error')).forEach((row) => {
    const key = `${row.record.energyFlowModelId}\0${row.record.edgeCode}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  });
  groups.forEach((group) => {
    if (group.length < 2) return;
    const allExact = group.every((row) => isExactEdgeFact(group[0].record, row.record));
    if (allExact) {
      group.slice(1).forEach((row) => {
        row.skipDuplicate = true;
        appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'edgeCode', row.record.edgeCode, 'DUPLICATE_ENERGY_FLOW_EDGE_SKIPPED', '文件内已存在完全相同边，本行按 skip 策略跳过。', 'warning'));
      });
      return;
    }
    group.forEach((row) => appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'edgeCode', row.record.edgeCode, 'CONFLICTING_ENERGY_FLOW_EDGE', '文件内同模型边编码存在冲突定义。')));
  });
}

/**
 * 标记数据库完全相同边为 skip，冲突定义为阻断。
 * @param {object[]} rows 边行。
 * @param {object} masterData 主数据。
 */
function markDatabaseEdgeDuplicates(rows, masterData) {
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const existing = masterData.edgesByIdentity.get(`${row.record.energyFlowModelId}\0${row.record.edgeCode}`);
    if (!existing) return;
    if (isExactEdgeFact(existing, row.record)) {
      row.skipDuplicate = true;
      row.existingId = existing.id;
      appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'edgeCode', row.record.edgeCode, 'DUPLICATE_ENERGY_FLOW_EDGE_SKIPPED', '数据库已存在完全相同边，本行按 skip 策略跳过。', 'warning'));
      return;
    }
    appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'edgeCode', row.record.edgeCode, 'CONFLICTING_ENERGY_FLOW_EDGE', '数据库同模型边编码已存在冲突定义。'));
  });
}

/**
 * 建立既有边和本文件候选边的统一引用索引。
 * @param {object[]} edgeRows 边行。
 * @param {object} masterData 主数据。
 * @returns {Map<string,object>} 边引用索引。
 */
function buildPreviewEdgeReferenceIndex(edgeRows, masterData) {
  const index = new Map();
  masterData.edgesByIdentity.forEach((edge, key) => index.set(key, { kind: 'existing', edge }));
  edgeRows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const candidateRowId = buildEdgeCandidateRowId(row.record);
    row.candidateRowId = candidateRowId;
    index.set(`${row.record.energyFlowModelId}\0${row.record.edgeCode}`, { kind: 'candidate', candidateRowId, edge: row.record });
  });
  return index;
}

/**
 * 校验显式边值行并解析既有或同文件候选边依赖。
 * @param {object} row 模板行。
 * @param {object} masterData 主数据。
 * @param {Map<string,object>} edgeReferenceIndex 边引用索引。
 * @returns {object} 行结果。
 */
function validateEnergyFlowRecordRow(row, masterData, edgeReferenceIndex) {
  const mapped = row.mapped || {};
  const rowNumber = row.sourceRowNumber;
  const issues = [...(row.issues || []), ...validateRequiredFields(ENERGY_FLOW_BUNDLE_TEMPLATE_TYPE, '显式边值', mapped, rowNumber)];
  const modelResolution = resolveBundleModel(mapped, rowNumber, masterData);
  issues.push(...modelResolution.issues);
  const edgeCode = normalizeText(mapped.edgeCode);
  const modelId = modelResolution.model?.id || null;
  const edgeReference = modelId ? edgeReferenceIndex.get(`${modelId}\0${edgeCode}`) || null : null;
  const edge = edgeReference?.edge || null;
  const startUtc = normalizeText(mapped.startUtc);
  const endUtc = normalizeText(mapped.endUtc);
  const sourceTimeZone = normalizeText(mapped.sourceTimeZone);
  const originalUnit = normalizeText(mapped.originalUnit);
  const originalValue = isBlank(mapped.originalValue) ? null : Number(mapped.originalValue);
  const formulaVersion = normalizeText(mapped.formulaVersion);
  const recordStatus = normalizeText(mapped.recordStatus) || IMPORTABLE_RECORD_STATUS;
  const sourceMapping = parseSourceMapping(mapped.sourceReference, rowNumber);
  issues.push(...sourceMapping.issues);

  if (!edge) issues.push(createFlowIssue(rowNumber, 'edgeCode', mapped.edgeCode, 'ENERGY_FLOW_EDGE_NOT_FOUND', '指定模型下的边不存在，且文件内没有可导入候选边。'));
  else {
    if (edge.status !== 'active') issues.push(createFlowIssue(rowNumber, 'edgeCode', mapped.edgeCode, 'ENERGY_FLOW_EDGE_INACTIVE', '显式边值只能引用 active 边。'));
    if (edge.sourceType !== 'explicit_edge_value') issues.push(createFlowIssue(rowNumber, 'edgeCode', mapped.edgeCode, 'ENERGY_FLOW_RECORD_SOURCE_TYPE_MISMATCH', '显式边值只能引用来源类型为 explicit_edge_value 的边。'));
    if (Number(edge.energyFlowModelId) !== Number(modelId)) issues.push(createFlowIssue(rowNumber, 'edgeCode', mapped.edgeCode, 'ENERGY_FLOW_RECORD_MODEL_EDGE_MISMATCH', '显式边值模型与边不一致。'));
  }
  if (!isStrictUtcIso(startUtc)) issues.push(createFlowIssue(rowNumber, 'startUtc', mapped.startUtc, 'INVALID_START_UTC', '开始时间必须是严格 UTC Z 格式。'));
  if (!isStrictUtcIso(endUtc)) issues.push(createFlowIssue(rowNumber, 'endUtc', mapped.endUtc, 'INVALID_END_UTC', '结束时间必须是严格 UTC Z 格式。'));
  if (isStrictUtcIso(startUtc) && isStrictUtcIso(endUtc) && Date.parse(startUtc) >= Date.parse(endUtc)) issues.push(createFlowIssue(rowNumber, 'startUtc', { startUtc, endUtc }, 'INVALID_HALF_OPEN_RANGE', '时间区间必须满足左闭右开且开始时间早于结束时间。'));
  if (!isIanaTimeZone(sourceTimeZone)) issues.push(createFlowIssue(rowNumber, 'sourceTimeZone', mapped.sourceTimeZone, 'INVALID_SOURCE_TIME_ZONE', '来源时区必须是有效 IANA 时区。'));
  if (!Number.isFinite(originalValue) || originalValue < 0) issues.push(createFlowIssue(rowNumber, 'originalValue', mapped.originalValue, 'INVALID_ORIGINAL_VALUE', '原始值必须是有限且大于等于 0 的数字。'));
  const energyType = edge ? [...masterData.energyTypes.values()].find((item) => Number(item.id) === Number(edge.energyTypeId)) : null;
  if (energyType && originalUnit && !isEnergyUnitCompatible(energyType, originalUnit)) issues.push(createFlowIssue(rowNumber, 'originalUnit', mapped.originalUnit, 'ENERGY_FLOW_UNIT_INCOMPATIBLE', '显式边值单位与边的能源类型不兼容。'));
  if (edge && originalUnit && normalizeUnitAndValue(energyType?.code, originalUnit, 1)?.normalizedUnit !== normalizeUnitAndValue(energyType?.code, edge.unit, 1)?.normalizedUnit) issues.push(createFlowIssue(rowNumber, 'originalUnit', mapped.originalUnit, 'ENERGY_FLOW_EDGE_RECORD_UNIT_MISMATCH', '显式边值单位与边单位不可比较。'));
  if (formulaVersion !== ENERGY_FLOW_VERSION) issues.push(createFlowIssue(rowNumber, 'formulaVersion', mapped.formulaVersion, 'INVALID_ENERGY_FLOW_FORMULA_VERSION', `公式版本必须为 ${ENERGY_FLOW_VERSION}。`));
  if (recordStatus !== IMPORTABLE_RECORD_STATUS) issues.push(createFlowIssue(rowNumber, 'recordStatus', mapped.recordStatus, 'ENERGY_FLOW_RECORD_STATUS_UNSUPPORTED', '导入仅允许 active 显式边值；void 需要完整作废原因和作废时间。'));

  const record = modelResolution.model && edgeReference && edge && edge.status === 'active' && edge.sourceType === 'explicit_edge_value'
    && isStrictUtcIso(startUtc) && isStrictUtcIso(endUtc) && Date.parse(startUtc) < Date.parse(endUtc)
    && isIanaTimeZone(sourceTimeZone) && Number.isFinite(originalValue) && originalValue >= 0
    && energyType && isEnergyUnitCompatible(energyType, originalUnit) && sourceMapping.mappingJson
    && formulaVersion === ENERGY_FLOW_VERSION && recordStatus === IMPORTABLE_RECORD_STATUS
    ? {
      sourceRowNumber: rowNumber,
      energyFlowModelId: modelResolution.model.id,
      modelCode: modelResolution.model.modelCode,
      modelVersion: modelResolution.model.version,
      edgeCode,
      edgeReferenceKind: edgeReference.kind,
      existingEdgeId: edgeReference.kind === 'existing' ? edge.id : null,
      edgeCandidateRowId: edgeReference.kind === 'candidate' ? edgeReference.candidateRowId : null,
      startUtc,
      endUtc,
      sourceTimeZone,
      originalUnit,
      originalValue,
      sourceType: 'explicit_edge_value',
      sourceMappingJson: sourceMapping.mappingJson,
      formulaVersion,
      recordStatus
    }
    : null;
  return { rowNumber, mapped, issues, record };
}

/**
 * 为记录构造不依赖数据库自增 ID 的业务周期键。
 * @param {object} record 显式边值事实。
 * @returns {string} 周期键。
 */
function buildRecordPeriodKey(record) {
  return stableSerialize({
    energyFlowModelId: record.energyFlowModelId,
    edgeCode: record.edgeCode,
    startUtc: record.startUtc,
    endUtc: record.endUtc,
    recordStatus: record.recordStatus
  });
}

/**
 * 判断两条显式边值是否为完全相同事实。
 * @param {object} left 左事实。
 * @param {object} right 右事实。
 * @returns {boolean} 是否完全相同。
 */
function isExactRecordFact(left, right) {
  return Number(left.energyFlowModelId) === Number(right.energyFlowModelId)
    && left.edgeCode === right.edgeCode
    && Date.parse(left.startUtc) === Date.parse(right.startUtc)
    && Date.parse(left.endUtc) === Date.parse(right.endUtc)
    && left.sourceTimeZone === right.sourceTimeZone
    && normalizeText(left.originalUnit).toLocaleLowerCase('en-US') === normalizeText(right.originalUnit).toLocaleLowerCase('en-US')
    && Number(left.originalValue) === Number(right.originalValue)
    && left.sourceType === right.sourceType
    && stableSerialize(JSON.parse(left.sourceMappingJson)) === stableSerialize(JSON.parse(right.sourceMappingJson))
    && left.formulaVersion === right.formulaVersion
    && left.recordStatus === right.recordStatus;
}

/**
 * 为记录候选生成稳定 ID。
 * @param {object} record 显式边值事实。
 * @returns {string} 稳定候选 ID。
 */
function buildRecordCandidateRowId(record) {
  const digest = crypto.createHash('sha256').update(stableSerialize(record)).digest('hex').slice(0, 20);
  return `energy-flow-record:${record.sourceRowNumber}:${digest}`;
}

/**
 * 标记文件内同边同周期的完全重复或冲突。
 * @param {object[]} rows 记录行。
 */
function markInputRecordDuplicates(rows) {
  const groups = new Map();
  rows.filter((row) => row.record && !row.issues.some((issue) => issue.severity === 'error')).forEach((row) => {
    const key = buildRecordPeriodKey(row.record);
    groups.set(key, [...(groups.get(key) || []), row]);
  });
  groups.forEach((group) => {
    if (group.length < 2) return;
    const allExact = group.every((row) => isExactRecordFact(group[0].record, row.record));
    if (allExact) {
      group.slice(1).forEach((row) => {
        row.skipDuplicate = true;
        appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'startUtc', { startUtc: row.record.startUtc, endUtc: row.record.endUtc }, 'DUPLICATE_ENERGY_FLOW_RECORD_SKIPPED', '文件内已存在完全相同显式边值，本行按 skip 策略跳过。', 'warning'));
      });
      return;
    }
    group.forEach((row) => appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'startUtc', { startUtc: row.record.startUtc, endUtc: row.record.endUtc }, 'CONFLICTING_ENERGY_FLOW_RECORD_PERIOD', '文件内同模型、同边、同周期存在冲突事实。')));
  });
}

/**
 * 标记数据库 active 同边同周期完全重复或冲突。
 * @param {object} db SQLite 连接。
 * @param {object[]} rows 记录行。
 * @param {object} masterData 主数据。
 */
function markDatabaseRecordDuplicates(db, rows, masterData) {
  const selectRecords = db.prepare(
    `SELECT record.id, record.energy_flow_model_id AS energyFlowModelId,
            edge.edge_code AS edgeCode, record.start_utc AS startUtc, record.end_utc AS endUtc,
            record.source_timezone AS sourceTimeZone, record.original_unit AS originalUnit,
            record.original_value AS originalValue, record.source_type AS sourceType,
            record.source_mapping_json AS sourceMappingJson, record.formula_version AS formulaVersion,
            record.record_status AS recordStatus
     FROM energy_flow_records AS record
     JOIN energy_flow_edges AS edge ON edge.id = record.energy_flow_edge_id
     WHERE record.energy_flow_model_id = ?
       AND edge.edge_code = ?
       AND record.start_utc = ?
       AND record.end_utc = ?
       AND record.record_status = 'active'`
  );
  rows.forEach((row) => {
    if (!row.record || row.skipDuplicate || row.issues.some((issue) => issue.severity === 'error')) return;
    const edgeReference = masterData.edgesByIdentity.get(`${row.record.energyFlowModelId}\0${row.record.edgeCode}`);
    if (!edgeReference) return;
    const existingRows = selectRecords.all(row.record.energyFlowModelId, row.record.edgeCode, row.record.startUtc, row.record.endUtc);
    if (existingRows.length === 0) return;
    const exact = existingRows.find((existing) => isExactRecordFact(existing, row.record));
    if (exact && existingRows.every((existing) => isExactRecordFact(existing, row.record))) {
      row.skipDuplicate = true;
      row.existingId = exact.id;
      appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'startUtc', { startUtc: row.record.startUtc, endUtc: row.record.endUtc }, 'DUPLICATE_ENERGY_FLOW_RECORD_SKIPPED', '数据库已存在完全相同显式边值，本行按 skip 策略跳过。', 'warning'));
      return;
    }
    appendUniqueIssue(row, createFlowIssue(row.rowNumber, 'startUtc', { startUtc: row.record.startUtc, endUtc: row.record.endUtc }, 'CONFLICTING_ENERGY_FLOW_RECORD_PERIOD', '数据库同模型、同边、同周期已存在冲突事实。'));
  });
}

/**
 * 将领域行结果投影为统一 preview items 与候选。
 * @param {object[]} rows 行结果。
 * @param {Function} candidateIdBuilder 候选 ID 构建器。
 * @returns {object} preview 分片。
 */
function buildPreviewSlice(rows, candidateIdBuilder) {
  const items = rows.map((row) => {
    const hasError = row.issues.some((issue) => issue.severity === 'error');
    return {
      rowNumber: row.rowNumber,
      sourceRowNumber: row.rowNumber,
      status: hasError ? 'blocked' : (row.skipDuplicate ? 'skipped' : 'wouldImport'),
      issues: row.issues,
      normalizedRecord: row.record,
      structuralOnly: row.structuralOnly === true
    };
  });
  const candidateRows = rows
    .filter((row) => row.record && !row.skipDuplicate && !row.issues.some((issue) => issue.severity === 'error'))
    .map((row) => ({ candidateRowId: row.candidateRowId || candidateIdBuilder(row.record), ...row.record }));
  return {
    items,
    candidateRows,
    summary: buildImportSummary(items),
    auditIssues: items.flatMap((item) => item.issues || [])
  };
}

/**
 * 基于同一 Buffer 一次解析两个工作表并构建边与记录 preview。
 * @param {object} input 数据库、Buffer 与文件上下文。
 * @returns {object} 双分片领域 preview。
 */
function buildEnergyFlowBundleImportPreview(input) {
  const parsed = parseEnergyFlowBundleRows(input.buffer, input.originalFilename);
  const masterData = loadBundleMasterData(input.db);
  const edgeRows = parsed.edgeSheet.rows.map((row) => validateEnergyFlowEdgeRow(row, masterData));
  attachGlobalIssues(edgeRows, parsed.edgeSheet.globalIssues);
  markInputEdgeDuplicates(edgeRows);
  markDatabaseEdgeDuplicates(edgeRows, masterData);
  const edgeReferenceIndex = buildPreviewEdgeReferenceIndex(edgeRows, masterData);
  const recordRows = parsed.recordSheet.rows.map((row) => validateEnergyFlowRecordRow(row, masterData, edgeReferenceIndex));
  attachGlobalIssues(recordRows, parsed.recordSheet.globalIssues);
  markInputRecordDuplicates(recordRows);
  markDatabaseRecordDuplicates(input.db, recordRows, masterData);
  const edgePreview = buildPreviewSlice(edgeRows, buildEdgeCandidateRowId);
  const recordPreview = buildPreviewSlice(recordRows, buildRecordCandidateRowId);
  return {
    fileType: 'xlsx',
    edgePreview: { ...edgePreview, fieldMapping: parsed.edgeSheet.fieldMapping },
    recordPreview: { ...recordPreview, fieldMapping: parsed.recordSheet.fieldMapping },
    candidateRows: [...edgePreview.candidateRows, ...recordPreview.candidateRows],
    items: [...edgePreview.items, ...recordPreview.items],
    summary: buildImportSummary([...edgePreview.items, ...recordPreview.items]),
    auditIssues: [...edgePreview.auditIssues, ...recordPreview.auditIssues],
    fieldMapping: {
      能流边: parsed.edgeSheet.fieldMapping,
      显式边值: parsed.recordSheet.fieldMapping
    },
    notices: [
      'preview 从同一安全 Buffer 一次解析“能流边”和“显式边值”，不预写业务表。',
      '显式边值可以引用本文件内可导入候选边；execute 会先插入边并解析真实 ID，再插入记录。',
      '当前 schema/冻结模板未定义 allocationRatio、loss flag 或节点表计外键，服务不会虚构或持久化这些字段。'
    ]
  };
}

/**
 * 根据 preview 汇总计算审计状态。
 * @param {object} summary preview 汇总。
 * @returns {string} 审计状态。
 */
function resolvePreviewStatus(summary = {}) {
  if (Number(summary.totalRows || 0) === 0 && Number(summary.errors || 0) > 0) return 'failed';
  return Number(summary.blocked || 0) > 0 || Number(summary.skipped || 0) > 0 ? 'completed_with_errors' : 'completed';
}

/**
 * 构造 preview 中文错误摘要。
 * @param {object} summary preview 汇总。
 * @returns {string|null} 错误摘要。
 */
function buildPreviewErrorSummary(summary = {}) {
  const parts = [];
  if (Number(summary.blocked || 0) > 0) parts.push(`${summary.blocked} 行阻断`);
  if (Number(summary.skipped || 0) > 0) parts.push(`${summary.skipped} 行跳过`);
  if (Number(summary.warnings || 0) > 0) parts.push(`${summary.warnings} 条警告`);
  if (Number(summary.errors || 0) > 0) parts.push(`${summary.errors} 条错误`);
  return parts.length > 0 ? `能流导入存在 ${parts.join('、')}。` : null;
}

/**
 * 生成双批次共享上传组 ID。
 * @param {object} options 依赖注入选项。
 * @returns {string} 上传组 ID。
 */
function createUploadGroupId(options = {}) {
  if (typeof options.createUploadGroupId === 'function') {
    const provided = normalizeText(options.createUploadGroupId());
    if (!provided) throw badRequest('createUploadGroupId 必须返回非空文本。', { code: 'ENERGY_FLOW_UPLOAD_GROUP_ID_INVALID' });
    return provided;
  }
  return typeof crypto.randomUUID === 'function'
    ? `energy-flow:${crypto.randomUUID()}`
    : `energy-flow:${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * 投影不包含绝对路径的备份摘要。
 * @param {object|null} backup 备份结果。
 * @returns {object|null} 安全摘要。
 */
function projectSafeBackupSummary(backup) {
  if (!backup || typeof backup !== 'object') return null;
  return {
    backupName: backup.backupName || null,
    reason: backup.reason || null,
    sizeBytes: Number.isFinite(Number(backup.sizeBytes)) ? Number(backup.sizeBytes) : null,
    sha256: backup.sha256 || null,
    method: backup.method || null,
    createdAt: backup.createdAt || null,
    updatedAt: backup.updatedAt || null
  };
}

/**
 * 构造单个双批次审计上下文。
 * @param {object} contract 批次角色契约。
 * @param {object} context 共享上下文。
 * @param {object} preview 分片 preview。
 * @returns {object} 审计上下文。
 */
function buildBundleAuditContext(contract, context, preview) {
  return {
    version: ENERGY_FLOW_BUNDLE_SERVICE_VERSION,
    templateType: context.template.templateType,
    templateId: context.template.id,
    operation: contract.operation,
    recordKind: contract.recordKind,
    bundleOperation: context.template.operation,
    bundleRecordKind: context.template.recordKind,
    importTypes: [...context.template.importTypes],
    importType: contract.importType,
    batchRole: contract.importType === 'energy_flow_edge' ? 'edge' : 'record',
    sheetName: contract.sheetName,
    uploadGroupId: context.uploadGroupId,
    confirmText: context.template.confirmText,
    backupReason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
    duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
    requireBackup: true,
    summary: preview.summary,
    candidateRowIds: preview.candidateRows.map((row) => row.candidateRowId),
    candidateRows: preview.candidateRows,
    combinedCandidateRowIds: context.securedPreview.candidateRowIds,
    combinedCandidateRows: context.securedPreview.candidateRows,
    previewAudit: context.securedPreview.previewAudit,
    notices: context.domainPreview.notices || []
  };
}

/**
 * 创建能流边与显式边值双 preview 批次。
 * @param {object} file Multer 已落盘 XLSX 文件对象。
 * @param {object} options 依赖注入选项。
 * @returns {object} 双批次安全 preview。
 */
function previewEnergyFlowBundleImport(file, options = {}) {
  if (!file || !file.originalname || !file.filename) {
    throw badRequest('请上传已落盘且包含 originalname/filename 的 XLSX 文件。', { code: 'ENERGY_ANALYSIS_IMPORT_FILE_REQUIRED' });
  }
  if (String(file.originalname).split('.').pop().toLowerCase() !== 'xlsx') {
    throw badRequest('能流边及显式边值导入必须使用 XLSX 文件。', { code: 'ENERGY_FLOW_BUNDLE_XLSX_REQUIRED' });
  }
  const template = getEnergyAnalysisImportTemplate(ENERGY_FLOW_BUNDLE_TEMPLATE_TYPE);
  const uploadsDir = options.uploadsDir || defaultUploadsDir;
  const safeFile = readSafeUploadFile(uploadsDir, file.filename, {
    expectedSizeBytes: Number.isSafeInteger(file.size) ? file.size : undefined,
    maxSizeBytes: options.maxFileSizeBytes
  });
  const databaseContext = openServiceDatabase(options);
  try {
    const secret = resolveImportSecret(databaseContext.db, options);
    const domainPreview = buildEnergyFlowBundleImportPreview({
      db: databaseContext.db,
      buffer: safeFile.buffer,
      originalFilename: file.originalname,
      fileSha256: safeFile.fileSha256,
      fileSizeBytes: safeFile.sizeBytes,
      template,
      options
    });
    const securedPreview = securePreviewResult(domainPreview, { template, fileSha256: safeFile.fileSha256, secret });
    const uploadGroupId = createUploadGroupId(options);
    const context = { template, uploadGroupId, securedPreview, domainPreview };
    const persistBatches = databaseContext.db.transaction(() => {
      const createRoleBatch = (contract, rolePreview) => {
        const summary = rolePreview.summary;
        const batch = createPreviewAuditBatch({
          importType: contract.importType,
          originalFilename: file.originalname,
          storedFilename: file.filename,
          fileType: 'xlsx',
          fileSizeBytes: safeFile.sizeBytes,
          fileSha256: safeFile.fileSha256,
          status: resolvePreviewStatus(summary),
          auditPhase: 'preview',
          duplicateStrategy: ENERGY_ANALYSIS_IMPORT_DUPLICATE_STRATEGY,
          fieldMapping: rolePreview.fieldMapping || {},
          previewSignature: securedPreview.previewSignature,
          previewAuditDigest: securedPreview.previewAuditDigest,
          auditContext: buildBundleAuditContext(contract, context, rolePreview),
          statistics: {
            totalRows: Number(summary.totalRows || 0),
            successCount: Number(summary.wouldImport || 0),
            failureCount: Number(summary.blocked || 0),
            skippedCount: Number(summary.skipped || 0)
          },
          errorSummary: buildPreviewErrorSummary(summary)
        }, { db: databaseContext.db });
        replaceImportAuditIssues(batch.id, rolePreview.auditIssues || [], { db: databaseContext.db });
        return getImportAuditSummary(batch.id, { db: databaseContext.db });
      };
      const edgeBatch = createRoleBatch(ENERGY_FLOW_EDGE_BATCH_CONTRACT, domainPreview.edgePreview);
      const recordBatch = createRoleBatch(ENERGY_FLOW_RECORD_BATCH_CONTRACT, domainPreview.recordPreview);
      if (Number(edgeBatch.id) === Number(recordBatch.id)) {
        throw badRequest('能流双批次 ID 必须不同。', { code: 'ENERGY_FLOW_BUNDLE_BATCH_IDS_MUST_DIFFER' });
      }
      return { edgeBatch, recordBatch };
    });
    const batches = persistBatches();
    return {
      ...securedPreview,
      edgePreview: domainPreview.edgePreview,
      recordPreview: domainPreview.recordPreview,
      uploadGroupId,
      edgeBatchId: batches.edgeBatch.id,
      recordBatchId: batches.recordBatch.id,
      edgeBatch: batches.edgeBatch,
      recordBatch: batches.recordBatch,
      persistsImportBatch: true,
      persistsImportBatches: true
    };
  } finally {
    if (databaseContext.shouldClose) databaseContext.db.close();
  }
}

/**
 * 将持久化批次投影为 core 双批次绑定元数据。
 * @param {object} batch 审计批次详情。
 * @returns {object} 双批次绑定对象。
 */
function buildBundleBatchBinding(batch) {
  const auditContext = batch?.auditContext && typeof batch.auditContext === 'object' ? batch.auditContext : {};
  return {
    id: batch.id,
    status: batch.status,
    auditPhase: batch.auditPhase,
    importType: batch.importType,
    templateType: auditContext.templateType,
    templateId: auditContext.templateId,
    operation: auditContext.operation,
    recordKind: auditContext.recordKind,
    bundleOperation: auditContext.bundleOperation,
    bundleRecordKind: auditContext.bundleRecordKind,
    importTypes: auditContext.importTypes,
    uploadGroupId: auditContext.uploadGroupId,
    storedFilename: batch.storedFilename,
    originalFilename: batch.originalFilename,
    fileSizeBytes: batch.fileSizeBytes,
    fileSha256: batch.fileSha256,
    previewSignature: batch.previewSignature,
    previewAuditDigest: batch.previewAuditDigest
  };
}

/**
 * 抛出双批次持久化配对错误。
 * @param {object[]} failures 配对错误列表。
 * @returns {never} 始终抛错。
 */
function throwBundlePairFailure(failures) {
  throw badRequest(failures[0].message, {
    code: failures[0].code,
    authorizationErrors: failures
  });
}

/**
 * 完整校验两个持久化批次是否为同一可信 preview 配对。
 * 该函数不读取客户端 uploadGroupId；只有全部持久化元数据一致后才能生成失败审计凭据。
 * @param {object} edgeBatch 边批次详情。
 * @param {object} recordBatch 记录批次详情。
 * @param {object} template 冻结模板。
 * @returns {object} 可信双批次上下文。
 */
function createTrustedBundlePairContext(edgeBatch, recordBatch, template) {
  const edge = buildBundleBatchBinding(edgeBatch);
  const record = buildBundleBatchBinding(recordBatch);
  const failures = [];
  const append = (condition, code, message) => { if (!condition) failures.push({ code, message }); };
  const executableStatuses = ['completed', 'completed_with_errors'];
  const shaPattern = /^[a-f0-9]{64}$/;
  const signaturePattern = /^hmac-sha256:v1:[a-f0-9]{64}$/;
  const digestPattern = /^hmac-sha256:v1:audit:[a-f0-9]{64}$/;

  append(Number(edge.id) !== Number(record.id), 'ENERGY_FLOW_BUNDLE_BATCH_IDS_MUST_DIFFER', 'edgeBatchId 与 recordBatchId 必须不同。');
  append(executableStatuses.includes(edge.status) && executableStatuses.includes(record.status), 'ENERGY_ANALYSIS_IMPORT_BATCH_STATUS_INVALID', '两个批次状态均必须允许进入 execute。');
  append(edge.auditPhase === 'preview' && record.auditPhase === 'preview', 'ENERGY_ANALYSIS_IMPORT_BATCH_PHASE_MISMATCH', '两个批次必须仍处于 preview 阶段。');
  append(edge.storedFilename && edge.storedFilename === record.storedFilename, 'ENERGY_FLOW_BUNDLE_STORED_FILE_MISMATCH', '两个批次必须引用同一保存文件。');
  append(edge.originalFilename && edge.originalFilename === record.originalFilename, 'ENERGY_FLOW_BUNDLE_ORIGINAL_FILE_MISMATCH', '两个批次原始文件名必须一致。');
  append(Number.isSafeInteger(Number(edge.fileSizeBytes)) && Number(edge.fileSizeBytes) > 0
    && Number(edge.fileSizeBytes) === Number(record.fileSizeBytes), 'ENERGY_FLOW_BUNDLE_FILE_SIZE_MISMATCH', '两个批次文件大小必须一致。');
  append(shaPattern.test(String(edge.fileSha256 || '')) && edge.fileSha256 === record.fileSha256, 'ENERGY_FLOW_BUNDLE_FILE_SHA256_MISMATCH', '两个批次文件摘要必须相同且有效。');
  append(edge.templateType === template.templateType && record.templateType === template.templateType, 'ENERGY_FLOW_BUNDLE_TEMPLATE_MISMATCH', '两个批次 templateType 必须匹配冻结模板。');
  append(edge.templateId === template.id && record.templateId === template.id, 'ENERGY_FLOW_BUNDLE_TEMPLATE_ID_MISMATCH', '两个批次 templateId 必须一致。');
  append(edge.operation === ENERGY_FLOW_EDGE_BATCH_CONTRACT.operation, 'ENERGY_FLOW_BUNDLE_EDGE_OPERATION_MISMATCH', '边批次 operation 不匹配。');
  append(record.operation === ENERGY_FLOW_RECORD_BATCH_CONTRACT.operation, 'ENERGY_FLOW_BUNDLE_RECORD_OPERATION_MISMATCH', '记录批次 operation 不匹配。');
  append(edge.recordKind === ENERGY_FLOW_EDGE_BATCH_CONTRACT.recordKind, 'ENERGY_FLOW_BUNDLE_EDGE_RECORD_KIND_MISMATCH', '边批次 recordKind 不匹配。');
  append(record.recordKind === ENERGY_FLOW_RECORD_BATCH_CONTRACT.recordKind, 'ENERGY_FLOW_BUNDLE_RECORD_RECORD_KIND_MISMATCH', '记录批次 recordKind 不匹配。');
  append(edge.bundleOperation === template.operation && record.bundleOperation === template.operation, 'ENERGY_FLOW_BUNDLE_OPERATION_MISMATCH', '双批次 bundleOperation 不匹配。');
  append(edge.bundleRecordKind === template.recordKind && record.bundleRecordKind === template.recordKind, 'ENERGY_FLOW_BUNDLE_RECORD_KIND_MISMATCH', '双批次 bundleRecordKind 不匹配。');
  append(stableSerialize(edge.importTypes || []) === stableSerialize(template.importTypes)
    && stableSerialize(record.importTypes || []) === stableSerialize(template.importTypes), 'ENERGY_FLOW_BUNDLE_IMPORT_TYPES_MISMATCH', '双批次 importTypes 组合不匹配。');
  append(edge.importType === ENERGY_FLOW_EDGE_BATCH_CONTRACT.importType, 'ENERGY_FLOW_BUNDLE_EDGE_IMPORT_TYPE_MISMATCH', '边批次 importType 不匹配。');
  append(record.importType === ENERGY_FLOW_RECORD_BATCH_CONTRACT.importType, 'ENERGY_FLOW_BUNDLE_RECORD_IMPORT_TYPE_MISMATCH', '记录批次 importType 不匹配。');
  append(edge.uploadGroupId && edge.uploadGroupId === record.uploadGroupId, 'ENERGY_FLOW_BUNDLE_UPLOAD_GROUP_MISMATCH', '两个批次 uploadGroupId 必须相同。');
  append(signaturePattern.test(String(edge.previewSignature || ''))
    && edge.previewSignature === record.previewSignature, 'ENERGY_FLOW_BUNDLE_PREVIEW_SIGNATURE_MISMATCH', '两个批次 previewSignature 必须相同且有效。');
  append(digestPattern.test(String(edge.previewAuditDigest || ''))
    && edge.previewAuditDigest === record.previewAuditDigest, 'ENERGY_FLOW_BUNDLE_PREVIEW_AUDIT_DIGEST_MISMATCH', '两个批次 previewAuditDigest 必须相同且有效。');
  if (failures.length > 0) throwBundlePairFailure(failures);

  const binding = { edge, record };
  return {
    edgeBatchId: Number(edge.id),
    recordBatchId: Number(record.id),
    uploadGroupId: edge.uploadGroupId,
    storedFilename: edge.storedFilename,
    originalFilename: edge.originalFilename,
    fileSizeBytes: Number(edge.fileSizeBytes),
    fileSha256: edge.fileSha256,
    previewSignature: edge.previewSignature,
    previewAuditDigest: edge.previewAuditDigest,
    binding,
    fingerprint: crypto.createHash('sha256').update(stableSerialize(binding)).digest('hex')
  };
}

/**
 * 校验客户端请求是否指向已经完成服务端配对的上传组。
 * @param {object} trustedPairContext 可信双批次上下文。
 * @param {object} body execute 请求。
 */
function assertBundleRequestMetadata(trustedPairContext, body) {
  if (normalizeText(body.uploadGroupId) !== trustedPairContext.uploadGroupId) {
    throw badRequest('请求 uploadGroupId 与持久化批次不一致。', {
      code: 'ENERGY_FLOW_BUNDLE_REQUEST_UPLOAD_GROUP_MISMATCH'
    });
  }
}

/**
 * 校验双批次角色级元数据，并返回可供失败审计使用的可信配对上下文。
 * @param {object} edgeBatch 边批次详情。
 * @param {object} recordBatch 记录批次详情。
 * @param {object} body execute 请求。
 * @param {object} template 冻结模板。
 * @returns {object} 可信双批次上下文。
 */
function assertBundleRoleMetadata(edgeBatch, recordBatch, body, template) {
  const trustedPairContext = createTrustedBundlePairContext(edgeBatch, recordBatch, template);
  assertBundleRequestMetadata(trustedPairContext, body);
  return trustedPairContext;
}

/**
 * 将 core 授权失败转换为稳定 BAD_REQUEST。
 * @param {object} authorization 授权结果。
 * @returns {never} 始终抛错。
 */
function throwAuthorizationFailure(authorization) {
  const firstError = authorization.errors?.[0] || { code: 'ENERGY_ANALYSIS_IMPORT_EXECUTE_NOT_AUTHORIZED', message: '能源分析导入未获授权。' };
  throw badRequest(firstError.message, { code: firstError.code, authorizationErrors: authorization.errors || [] });
}

/**
 * 使用持久化双批次、当前 Buffer 和重算 preview 调用 core 唯一授权门槛。
 * @param {object} body execute 请求。
 * @param {object} edgeBatch 边批次。
 * @param {object} recordBatch 记录批次。
 * @param {object} securedPreview 当前重算安全 preview。
 * @param {Buffer} fileBuffer 同一安全 Buffer。
 * @param {string} secret HMAC 密钥。
 * @param {object|null} trustedPairContext 已完成持久化配对校验的可信上下文。
 * @returns {object} 授权结果。
 */
function authorizePersistedBundleExecute(body, edgeBatch, recordBatch, securedPreview, fileBuffer, secret, trustedPairContext = null) {
  const template = getEnergyAnalysisImportTemplate(ENERGY_FLOW_BUNDLE_TEMPLATE_TYPE);
  const trustedPair = trustedPairContext || assertBundleRoleMetadata(edgeBatch, recordBatch, body, template);
  assertBundleRequestMetadata(trustedPair, body);
  const edgeBinding = trustedPair.binding.edge;
  const recordBinding = trustedPair.binding.record;
  return authorizeEnergyAnalysisImportExecute({
    templateType: template.templateType,
    operation: template.operation,
    recordKind: template.recordKind,
    importTypes: [...template.importTypes],
    confirmText: body.confirmText,
    backupReason: body.backupReason,
    duplicateStrategy: body.duplicateStrategy,
    requireBackup: body.requireBackup,
    acknowledgeSkippedRisks: body.acknowledgeSkippedRisks,
    fileSha256: body.fileSha256,
    previewSignature: body.previewSignature,
    previewAuditDigest: body.previewAuditDigest,
    expectedWouldImport: body.expectedWouldImport,
    candidateRowIds: body.candidateRowIds,
    candidateRows: body.candidateRows,
    bundle: {
      edgeBatchId: Number(edgeBatch.id),
      recordBatchId: Number(recordBatch.id),
      uploadGroupId: normalizeText(body.uploadGroupId),
      edgeBatch: edgeBinding,
      recordBatch: recordBinding
    }
  }, {
    secret,
    fileBuffer,
    recomputedCandidateRows: securedPreview.candidateRows,
    previewAudit: securedPreview.previewAudit
  });
}

/**
 * 在同一事务内先插入边，再将候选临时引用解析为真实 ID 后插入显式边值。
 * @param {object} input 数据库、两个批次、重算 preview 和选项。
 * @returns {object} 双表插入结果。
 */
function insertEnergyFlowBundleCandidates(input) {
  const insertEdge = input.db.prepare(
    `INSERT INTO energy_flow_edges (
       source_batch_id, source_row_number, energy_flow_model_id, edge_code,
       from_node_id, to_node_id, energy_type_id, unit, source_type, source_mapping_json, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertRecord = input.db.prepare(
    `INSERT INTO energy_flow_records (
       source_batch_id, source_row_number, energy_flow_model_id, energy_flow_edge_id,
       start_utc, end_utc, source_timezone, original_unit, original_value,
       source_type, source_mapping_json, formula_version, record_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  );
  const edgeIdByCandidateRowId = new Map();
  const edgeImportedIds = [];
  const edgeImportedItems = [];
  input.edgeCandidates.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertEdge === 'function') input.options.beforeInsertEdge({ candidate, index, db: input.db });
    const result = insertEdge.run(
      input.edgeBatchId,
      candidate.sourceRowNumber,
      candidate.energyFlowModelId,
      candidate.edgeCode,
      candidate.fromNodeId,
      candidate.toNodeId,
      candidate.energyTypeId,
      candidate.unit,
      candidate.sourceType,
      candidate.sourceMappingJson,
      candidate.status
    );
    const importedId = Number(result.lastInsertRowid);
    edgeIdByCandidateRowId.set(candidate.candidateRowId, importedId);
    edgeImportedIds.push(importedId);
    edgeImportedItems.push({ id: importedId, candidateRowId: candidate.candidateRowId, sourceRowNumber: candidate.sourceRowNumber });
    if (typeof input.options.afterInsertEdge === 'function') input.options.afterInsertEdge({ candidate, index, importedId, db: input.db });
  });

  const recordImportedIds = [];
  const recordImportedItems = [];
  input.recordCandidates.forEach((candidate, index) => {
    if (typeof input.options.beforeInsertRecord === 'function') input.options.beforeInsertRecord({ candidate, index, db: input.db });
    const edgeId = candidate.edgeReferenceKind === 'candidate'
      ? edgeIdByCandidateRowId.get(candidate.edgeCandidateRowId)
      : candidate.existingEdgeId;
    if (!Number.isSafeInteger(Number(edgeId)) || Number(edgeId) <= 0) {
      throw badRequest('显式边值候选边临时引用无法解析。', {
        code: 'ENERGY_FLOW_RECORD_EDGE_REFERENCE_UNRESOLVED',
        candidateRowId: candidate.candidateRowId,
        edgeCandidateRowId: candidate.edgeCandidateRowId
      });
    }
    const result = insertRecord.run(
      input.recordBatchId,
      candidate.sourceRowNumber,
      candidate.energyFlowModelId,
      Number(edgeId),
      candidate.startUtc,
      candidate.endUtc,
      candidate.sourceTimeZone,
      candidate.originalUnit,
      candidate.originalValue,
      candidate.sourceType,
      candidate.sourceMappingJson,
      candidate.formulaVersion
    );
    const importedId = Number(result.lastInsertRowid);
    recordImportedIds.push(importedId);
    recordImportedItems.push({ id: importedId, candidateRowId: candidate.candidateRowId, sourceRowNumber: candidate.sourceRowNumber, energyFlowEdgeId: Number(edgeId) });
    if (typeof input.options.afterInsertRecord === 'function') input.options.afterInsertRecord({ candidate, index, importedId, edgeId: Number(edgeId), db: input.db });
  });
  return {
    edge: { imported: edgeImportedIds.length, importedIds: edgeImportedIds, importedItems: edgeImportedItems },
    record: { imported: recordImportedIds.length, importedIds: recordImportedIds, importedItems: recordImportedItems }
  };
}

/**
 * 判断错误码是否属于可向调用方和审计暴露的稳定能流领域码。
 * @param {*} value 原始错误码。
 * @returns {boolean} 是否为稳定领域错误码。
 */
function isSafeEnergyFlowExecuteErrorCode(value) {
  const code = String(value || '').trim();
  return /^[A-Z][A-Z0-9_]{2,127}$/.test(code)
    && (code.startsWith('ENERGY_ANALYSIS_') || code.startsWith('ENERGY_FLOW_'));
}

/**
 * 根据稳定错误码返回固定安全中文消息，不使用原始异常文本。
 * @param {string} code 稳定错误码。
 * @returns {string} 安全错误消息。
 */
function getSafeEnergyFlowExecuteErrorMessage(code) {
  if (code === 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED') return '能流导入备份失败，未写入业务数据。';
  if (code === 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED') return '能流导入事务失败，业务数据已回滚。';
  if (code === 'ENERGY_ANALYSIS_IMPORT_SOURCE_OR_BATCH_INVALID') return '能流导入原文件或批次校验失败，未写入业务数据。';
  if (code.startsWith('ENERGY_ANALYSIS_UPLOAD_')) return '能流导入原文件安全校验失败，未写入业务数据。';
  if (code.startsWith('ENERGY_FLOW_')) return '能流导入批次、模板或业务契约校验失败，未写入业务数据。';
  return '能流导入授权校验失败，未写入业务数据。';
}

/**
 * 将任意双批次 execute 异常包装为稳定且不含基础设施信息的领域错误。
 * @param {Error} error 原始错误。
 * @param {'preflight'|'lock'|'backup'|'write'} stage 失败阶段。
 * @returns {Error} 安全领域错误。
 */
function normalizeSafeEnergyFlowExecuteError(error, stage = 'preflight') {
  const detailCode = error?.details?.code;
  if (isSafeEnergyFlowExecuteErrorCode(detailCode)) {
    return badRequest(getSafeEnergyFlowExecuteErrorMessage(detailCode), { code: detailCode });
  }
  const stageCode = stage === 'backup'
    ? 'ENERGY_ANALYSIS_IMPORT_BACKUP_FAILED'
    : (stage === 'lock' || stage === 'write'
      ? 'ENERGY_ANALYSIS_IMPORT_TRANSACTION_FAILED'
      : 'ENERGY_ANALYSIS_IMPORT_SOURCE_OR_BATCH_INVALID');
  return badRequest(getSafeEnergyFlowExecuteErrorMessage(stageCode), { code: stageCode });
}

/**
 * 在独立原子事务内将可信双批次记录为同一失败语义；配对失真或更新失败时保持两者原状态。
 * @param {object|null} trustedPairContext 已完成完整持久化配对校验的可信上下文。
 * @param {Error} error 已安全包装的错误。
 * @param {object} options 依赖注入选项。
 * @param {object|null} backup 已创建备份。
 */
function markEnergyFlowBundleFailure(trustedPairContext, error, options = {}, backup = null) {
  if (!trustedPairContext) return;
  let databaseContext = null;
  try {
    const template = getEnergyAnalysisImportTemplate(ENERGY_FLOW_BUNDLE_TEMPLATE_TYPE);
    databaseContext = openServiceDatabase(options);
    const transaction = databaseContext.db.transaction(() => {
      const edgeBatch = getImportAuditBatchDetail(trustedPairContext.edgeBatchId, { db: databaseContext.db, includeIssues: false });
      const recordBatch = getImportAuditBatchDetail(trustedPairContext.recordBatchId, { db: databaseContext.db, includeIssues: false });
      const currentTrustedPair = createTrustedBundlePairContext(edgeBatch, recordBatch, template);
      if (currentTrustedPair.fingerprint !== trustedPairContext.fingerprint) return;
      const safeBackup = projectSafeBackupSummary(backup);
      const safeError = normalizeSafeEnergyFlowExecuteError(error, 'preflight');
      const safeErrorCode = safeError.details.code;
      const safeErrorMessage = getSafeEnergyFlowExecuteErrorMessage(safeErrorCode);
      const failureResult = {
        executed: false,
        writesBusinessRecords: false,
        uploadGroupId: currentTrustedPair.uploadGroupId,
        errorCode: safeErrorCode,
        errorMessage: safeErrorMessage,
        backup: safeBackup
      };
      const updateFailure = (batch) => updateExecuteAuditResult(batch.id, {
        status: 'failed',
        statistics: {
          totalRows: Number(batch.totalRows || 0),
          successCount: 0,
          failureCount: Number(batch.failureCount || 0),
          skippedCount: Number(batch.skippedCount || 0)
        },
        executeResult: failureResult,
        backup,
        errorSummary: safeErrorMessage
      }, { db: databaseContext.db });
      updateFailure(edgeBatch);
      updateFailure(recordBatch);
    });
    transaction();
  } catch (_auditError) {
    // 失败审计采用全有或全无事务；配对复核或任一更新失败时保留两个 preview/原状态。
  } finally {
    if (databaseContext?.shouldClose) databaseContext.db.close();
  }
}

/**
 * 执行能流边与显式边值双批次导入。
 * @param {object} body 固定确认、双批次 ID 和共享候选见证。
 * @param {object} options 依赖注入选项。
 * @returns {Promise<object>} 双批次 execute 结果。
 */
async function executeEnergyFlowBundleImport(body = {}, options = {}) {
  let backup = null;
  let trustedPairContext = null;
  let failureStage = 'preflight';
  try {
    const edgeBatchId = normalizeBatchId(body.edgeBatchId);
    const recordBatchId = normalizeBatchId(body.recordBatchId);
    if (edgeBatchId === recordBatchId) {
      throw badRequest('edgeBatchId 与 recordBatchId 必须不同。', { code: 'ENERGY_FLOW_BUNDLE_BATCH_IDS_MUST_DIFFER' });
    }
    const template = getEnergyAnalysisImportTemplate(ENERGY_FLOW_BUNDLE_TEMPLATE_TYPE);
    // 双批次 execute 始终使用专用连接持有 BEGIN IMMEDIATE；options.db 仅供 build/preview 测试注入，不参与 execute 锁事务。
    const openExecuteDatabase = typeof options.openDatabase === 'function' ? options.openDatabase : defaultOpenDatabase;
    const databaseContext = { db: openExecuteDatabase(), shouldClose: true };
    try {
      const edgeBatch = getImportAuditBatchDetail(edgeBatchId, { db: databaseContext.db, includeIssues: false });
      const recordBatch = getImportAuditBatchDetail(recordBatchId, { db: databaseContext.db, includeIssues: false });
      trustedPairContext = assertBundleRoleMetadata(edgeBatch, recordBatch, body, template);
      const uploadsDir = options.uploadsDir || defaultUploadsDir;
      const safeFile = readSafeUploadFile(uploadsDir, trustedPairContext.storedFilename, {
        expectedSizeBytes: trustedPairContext.fileSizeBytes,
        maxSizeBytes: options.maxFileSizeBytes
      });
      const secret = resolveImportSecret(databaseContext.db, options);
      const domainPreview = buildEnergyFlowBundleImportPreview({
        db: databaseContext.db,
        buffer: safeFile.buffer,
        originalFilename: trustedPairContext.originalFilename,
        fileSha256: safeFile.fileSha256,
        fileSizeBytes: safeFile.sizeBytes,
        template,
        options
      });
      const securedPreview = securePreviewResult(domainPreview, { template, fileSha256: safeFile.fileSha256, secret });
      const authorization = authorizePersistedBundleExecute(
        body,
        edgeBatch,
        recordBatch,
        securedPreview,
        safeFile.buffer,
        secret,
        trustedPairContext
      );
      if (!authorization.valid) throwAuthorizationFailure(authorization);
      if (Number(authorization.expectedWouldImport || 0) <= 0) throwAuthorizationFailure(authorization);

      const createBackup = typeof options.createBackup === 'function' ? options.createBackup : backupService.createBackup;
      if (typeof options.beforeBundleBeginImmediate === 'function') {
        await options.beforeBundleBeginImmediate({ edgeBatchId, recordBatchId });
      }
      let transactionActive = false;
      try {
        failureStage = 'lock';
        // RESERVED 写锁覆盖锁内重算、在线备份、业务写入和双审计提交，关闭备份后并发提交窗口。
        databaseContext.db.exec('BEGIN IMMEDIATE');
        transactionActive = true;

        const latestEdgeBatch = getImportAuditBatchDetail(edgeBatchId, { db: databaseContext.db, includeIssues: false });
        const latestRecordBatch = getImportAuditBatchDetail(recordBatchId, { db: databaseContext.db, includeIssues: false });
        const latestTrustedPair = createTrustedBundlePairContext(latestEdgeBatch, latestRecordBatch, template);
        if (latestTrustedPair.fingerprint !== trustedPairContext.fingerprint) {
          throw badRequest('锁内双批次配对与首次校验结果不一致。', { code: 'ENERGY_FLOW_BUNDLE_PAIR_CHANGED' });
        }
        assertBundleRequestMetadata(latestTrustedPair, body);
        const latestDomainPreview = buildEnergyFlowBundleImportPreview({
          db: databaseContext.db,
          buffer: safeFile.buffer,
          originalFilename: latestTrustedPair.originalFilename,
          fileSha256: safeFile.fileSha256,
          fileSizeBytes: safeFile.sizeBytes,
          template,
          options
        });
        const latestSecuredPreview = securePreviewResult(latestDomainPreview, { template, fileSha256: safeFile.fileSha256, secret });
        const latestAuthorization = authorizePersistedBundleExecute(
          body,
          latestEdgeBatch,
          latestRecordBatch,
          latestSecuredPreview,
          safeFile.buffer,
          secret,
          latestTrustedPair
        );
        if (!latestAuthorization.valid) throwAuthorizationFailure(latestAuthorization);
        if (Number(latestAuthorization.expectedWouldImport || 0) <= 0) throwAuthorizationFailure(latestAuthorization);
        trustedPairContext = latestTrustedPair;

        failureStage = 'backup';
        // 在线备份读取锁前已提交快照；跳过会与当前 RESERVED 锁冲突的 checkpoint。
        backup = await createBackup({
          reason: ENERGY_ANALYSIS_IMPORT_BACKUP_REASON,
          skipCheckpoint: true
        });

        failureStage = 'write';
        const insertion = insertEnergyFlowBundleCandidates({
          db: databaseContext.db,
          edgeBatchId,
          recordBatchId,
          edgeCandidates: latestDomainPreview.edgePreview.candidateRows,
          recordCandidates: latestDomainPreview.recordPreview.candidateRows,
          options
        });
        const safeBackup = projectSafeBackupSummary(backup);
        const buildRoleExecute = (contract, rolePreview, roleInsertion) => ({
          executed: true,
          writesBusinessRecords: roleInsertion.imported > 0,
          templateType: template.templateType,
          operation: contract.operation,
          recordKind: contract.recordKind,
          bundleOperation: template.operation,
          bundleRecordKind: template.recordKind,
          importTypes: [...template.importTypes],
          importType: contract.importType,
          uploadGroupId: latestTrustedPair.uploadGroupId,
          imported: roleInsertion.imported,
          skipped: Number(rolePreview.summary.skipped || 0),
          blocked: Number(rolePreview.summary.blocked || 0),
          warnings: Number(rolePreview.summary.warnings || 0),
          errors: Number(rolePreview.summary.errors || 0),
          expectedWouldImport: rolePreview.candidateRows.length,
          combinedExpectedWouldImport: latestSecuredPreview.candidateRows.length,
          candidateRowIds: rolePreview.candidateRows.map((row) => row.candidateRowId),
          candidateRows: rolePreview.candidateRows,
          combinedCandidateRowIds: latestSecuredPreview.candidateRowIds,
          previewSignature: latestSecuredPreview.previewSignature,
          previewAuditDigest: latestSecuredPreview.previewAuditDigest,
          previewAudit: latestSecuredPreview.previewAudit,
          importedIds: roleInsertion.importedIds,
          importedItems: roleInsertion.importedItems,
          backup: safeBackup
        });
        const edgeExecuteResult = buildRoleExecute(ENERGY_FLOW_EDGE_BATCH_CONTRACT, latestDomainPreview.edgePreview, insertion.edge);
        const recordExecuteResult = buildRoleExecute(ENERGY_FLOW_RECORD_BATCH_CONTRACT, latestDomainPreview.recordPreview, insertion.record);
        const updateRoleAudit = (batchId, rolePreview, roleInsertion, executeResult) => updateExecuteAuditResult(batchId, {
          status: Number(rolePreview.summary.blocked || 0) > 0 || Number(rolePreview.summary.skipped || 0) > 0 ? 'completed_with_errors' : 'completed',
          statistics: {
            totalRows: Number(rolePreview.summary.totalRows || 0),
            successCount: roleInsertion.imported,
            failureCount: Number(rolePreview.summary.blocked || 0),
            skippedCount: Number(rolePreview.summary.skipped || 0)
          },
          executeResult,
          backup,
          errorSummary: buildPreviewErrorSummary(rolePreview.summary)
        }, { db: databaseContext.db });
        updateRoleAudit(edgeBatchId, latestDomainPreview.edgePreview, insertion.edge, edgeExecuteResult);
        updateRoleAudit(recordBatchId, latestDomainPreview.recordPreview, insertion.record, recordExecuteResult);
        const result = {
          executed: true,
          writesBusinessRecords: insertion.edge.imported + insertion.record.imported > 0,
          uploadGroupId: latestTrustedPair.uploadGroupId,
          edgeBatchId,
          recordBatchId,
          imported: insertion.edge.imported + insertion.record.imported,
          edge: edgeExecuteResult,
          record: recordExecuteResult,
          backup: safeBackup,
          edgeBatch: getImportAuditSummary(edgeBatchId, { db: databaseContext.db }),
          recordBatch: getImportAuditSummary(recordBatchId, { db: databaseContext.db })
        };
        databaseContext.db.exec('COMMIT');
        transactionActive = false;
        return result;
      } catch (error) {
        if (transactionActive) {
          try {
            databaseContext.db.exec('ROLLBACK');
          } catch (_rollbackError) {
            // 回滚异常不得替代原始失败，外层统一转换为安全领域错误。
          }
          transactionActive = false;
        }
        throw error;
      }
    } finally {
      if (databaseContext.shouldClose) databaseContext.db.close();
    }
  } catch (error) {
    const safeError = normalizeSafeEnergyFlowExecuteError(error, failureStage);
    markEnergyFlowBundleFailure(trustedPairContext, safeError, options, backup);
    throw safeError;
  }
}

module.exports = {
  ENERGY_FLOW_BUNDLE_SERVICE_VERSION,
  ENERGY_FLOW_BUNDLE_TEMPLATE_TYPE,
  ENERGY_FLOW_EDGE_BATCH_CONTRACT,
  ENERGY_FLOW_NODE_IMPORT_DESCRIPTOR,
  ENERGY_FLOW_NODE_TEMPLATE_TYPE,
  ENERGY_FLOW_RECORD_BATCH_CONTRACT,
  buildEnergyFlowBundleImportPreview,
  buildEnergyFlowNodeImportPreview,
  executeEnergyFlowBundleImport,
  executeEnergyFlowNodeImport,
  insertEnergyFlowBundleCandidates,
  insertEnergyFlowNodeCandidates,
  markEnergyFlowBundleFailure,
  parseEnergyFlowBundleRows,
  parseEnergyFlowNodeRows,
  previewEnergyFlowBundleImport,
  previewEnergyFlowNodeImport
};
