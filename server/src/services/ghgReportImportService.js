'use strict';

const XLSX = require('xlsx');
const { AppError, badRequest } = require('../utils/errors');
const { createImportIssue, buildImportSummary } = require('./energyAnalysisImportCore');
const {
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport
} = require('./energyAnalysisSingleBatchImportService');
const { validateCarbonActivityXlsxArchive } = require('./carbonActivityImportService');
const {
  GHG_REPORT_FIELD_LIMITS,
  GHG_REPORT_IMPORT_CONFIRM_TEXT,
  GHG_REPORT_RESOURCE_LIMITS,
  GHG_REPORT_SHEETS,
  GHG_REPORT_TEMPLATE_TYPE,
  GHG_REPORT_TEMPLATE_VERSION,
  buildGhgReportCodeKey,
  buildGhgReportNormalizationKey,
  normalizeGhgReportDate,
  normalizeGhgReportNonNegativeNumber,
  normalizeGhgReportPositiveNumber,
  normalizeGhgReportRecordType,
  normalizeGhgReportScope,
  normalizeGhgReportSignedNumber,
  normalizeGhgReportSummaryDimension,
  normalizeGhgReportText
} = require('./ghgReportContracts');

// N7 数值一致性统一按小数点后九位定点量化，禁止容差随业务数量级线性放大。
const GHG_REPORT_DECIMAL_PLACES = 9;
const GHG_REPORT_DECIMAL_SCALE = 10n ** BigInt(GHG_REPORT_DECIMAL_PLACES);
// 仅固定业务数值列读取原始 cell.v；百分比由底层数值解释，例如 12.50% 读取为 0.125。
const GHG_REPORT_NUMERIC_COLUMNS = Object.freeze({
  items: Object.freeze(new Set([6, 8, 9, 10])),
  summaries: Object.freeze(new Set([3, 4, 5]))
});

/** 将共享 ZIP/XLSX 安全错误映射为温室气体报告稳定领域错误。 */
function remapGhgReportArchiveError(error) {
  const sourceCode = String(error?.details?.code || error?.code || '');
  const suffix = sourceCode.startsWith('CARBON_ACTIVITY_IMPORT_')
    ? sourceCode.slice('CARBON_ACTIVITY_IMPORT_'.length)
    : 'ZIP_PAYLOAD_INVALID';
  const code = `GHG_REPORT_IMPORT_${suffix}`;
  const message = suffix === 'FORMULA_CELL_REJECTED'
    ? '温室气体报告固定模板不允许公式单元格。'
    : '温室气体报告 Excel 安全校验失败。';
  return new AppError(code, message, {
    statusCode: Number(error?.statusCode || 400),
    details: { ...(error?.details || {}), code }
  });
}

/** 使用已复审共享 ZIP/XLSX 容器检查并投影为 N7 领域错误。 */
function validateGhgReportXlsxArchive(buffer) {
  try {
    return validateCarbonActivityXlsxArchive(buffer);
  } catch (error) {
    throw remapGhgReportArchiveError(error);
  }
}

/** 扫描有效工作表区域，拒绝任意 SheetJS 公式属性。 */
function assertGhgReportWorksheetHasNoFormulas(worksheet, range) {
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      if (cell && Object.prototype.hasOwnProperty.call(cell, 'f')) {
        throw new AppError('GHG_REPORT_IMPORT_FORMULA_CELL_REJECTED', '温室气体报告固定模板不允许公式单元格。', {
          statusCode: 400,
          details: { code: 'GHG_REPORT_IMPORT_FORMULA_CELL_REJECTED' }
        });
      }
    }
  }
}

/** 读取固定业务数值列；真实数值保留原始 cell.v，文本等非数值类型继续采用显示文本。 */
function readGhgReportCellValue(worksheet, matrix, sheetKey, rowIndex, columnIndex) {
  const displayValue = normalizeGhgReportText(matrix[rowIndex]?.[columnIndex]);
  const numericColumns = GHG_REPORT_NUMERIC_COLUMNS[sheetKey];
  if (!numericColumns?.has(columnIndex)) return displayValue;
  const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return '';
  return cell.t === 'n' ? cell.v : displayValue;
}

/** 从固定多表 Excel v1 读取文本和原始数值行，并冻结工作表、表头和资源边界。 */
function parseGhgReportWorkbook(buffer, originalFilename) {
  if (!/\.xlsx$/i.test(String(originalFilename || ''))) {
    throw badRequest('温室气体报告导入仅支持固定 Excel v1 的 .xlsx 文件。', {
      code: 'GHG_REPORT_IMPORT_XLSX_REQUIRED'
    });
  }
  validateGhgReportXlsxArchive(buffer);
  let workbook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellText: true,
      cellDates: false,
      sheetRows: Math.max(...GHG_REPORT_SHEETS.map((sheet) => sheet.maxDataRows)) + 2
    });
  } catch (_error) {
    throw badRequest('温室气体报告 Excel 文件无法解析。', {
      code: 'GHG_REPORT_IMPORT_WORKBOOK_INVALID'
    });
  }

  const expectedSheetNames = GHG_REPORT_SHEETS.map((sheet) => sheet.name);
  const hiddenSheetExists = (workbook.Workbook?.Sheets || []).some((sheet) => Number(sheet.Hidden || 0) !== 0);
  if (hiddenSheetExists
    || workbook.SheetNames.length !== expectedSheetNames.length
    || workbook.SheetNames.some((sheetName, index) => sheetName !== expectedSheetNames[index])) {
    throw badRequest('温室气体报告 Excel 的工作表名称、顺序和可见性必须与固定 v1 模板完全一致。', {
      code: 'GHG_REPORT_IMPORT_SHEET_CONTRACT_INVALID',
      expectedSheetNames,
      actualSheetNames: workbook.SheetNames
    });
  }

  let totalNonEmptyCells = 0;
  let totalTextCharacters = 0;
  const result = {};
  GHG_REPORT_SHEETS.forEach((sheetContract) => {
    const worksheet = workbook.Sheets[sheetContract.name];
    const fullReference = worksheet?.['!fullref'] || worksheet?.['!ref'];
    if (!worksheet || !fullReference) {
      throw badRequest(`温室气体报告 Excel 缺少有效的“${sheetContract.name}”工作表。`, {
        code: 'GHG_REPORT_IMPORT_SHEET_REQUIRED', sheetName: sheetContract.name
      });
    }
    if (Array.isArray(worksheet['!merges']) && worksheet['!merges'].length > 0) {
      throw badRequest('温室气体报告 Excel 不允许合并单元格。', {
        code: 'GHG_REPORT_IMPORT_MERGED_CELLS_REJECTED', sheetName: sheetContract.name
      });
    }
    let range;
    try {
      range = XLSX.utils.decode_range(fullReference);
    } catch (_error) {
      throw badRequest('温室气体报告 Excel 工作表范围无效。', {
        code: 'GHG_REPORT_IMPORT_SHEET_RANGE_INVALID', sheetName: sheetContract.name
      });
    }
    if (range.e.c >= sheetContract.headers.length) {
      throw new AppError('GHG_REPORT_IMPORT_COLUMN_LIMIT_EXCEEDED', '温室气体报告 Excel 列数超过固定模板限制。', {
        statusCode: 413,
        details: { code: 'GHG_REPORT_IMPORT_COLUMN_LIMIT_EXCEEDED', sheetName: sheetContract.name }
      });
    }
    if (range.e.r > sheetContract.maxDataRows) {
      throw new AppError('GHG_REPORT_IMPORT_ROW_LIMIT_EXCEEDED', '温室气体报告 Excel 数据行数超过固定工作表限制。', {
        statusCode: 413,
        details: { code: 'GHG_REPORT_IMPORT_ROW_LIMIT_EXCEEDED', sheetName: sheetContract.name, maxDataRows: sheetContract.maxDataRows }
      });
    }
    assertGhgReportWorksheetHasNoFormulas(worksheet, range);
    totalNonEmptyCells += Object.entries(worksheet).filter(([address, cell]) => (
      !address.startsWith('!') && cell
      && (Boolean(cell.f) || (cell.v !== undefined && cell.v !== null && String(cell.v) !== ''))
    )).length;
    if (totalNonEmptyCells > GHG_REPORT_RESOURCE_LIMITS.maxNonEmptyCells) {
      throw new AppError('GHG_REPORT_IMPORT_CELL_LIMIT_EXCEEDED', '温室气体报告 Excel 非空单元格总数超过限制。', {
        statusCode: 413,
        details: { code: 'GHG_REPORT_IMPORT_CELL_LIMIT_EXCEEDED', maxNonEmptyCells: GHG_REPORT_RESOURCE_LIMITS.maxNonEmptyCells }
      });
    }
    const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: '', blankrows: true });
    const headers = (matrix[0] || []).map(normalizeGhgReportText);
    if (headers.length !== sheetContract.headers.length
      || headers.some((header, index) => header !== sheetContract.headers[index])) {
      throw badRequest(`“${sheetContract.name}”表头必须与固定 v1 模板完全一致。`, {
        code: 'GHG_REPORT_IMPORT_HEADERS_MISMATCH',
        sheetName: sheetContract.name,
        expectedHeaders: sheetContract.headers,
        actualHeaders: headers
      });
    }
    totalTextCharacters += headers.reduce((total, value) => total + value.length, 0);
    const rows = [];
    for (let matrixIndex = 1; matrixIndex < matrix.length; matrixIndex += 1) {
      const values = sheetContract.headers.map((_header, columnIndex) => (
        readGhgReportCellValue(worksheet, matrix, sheetContract.key, matrixIndex, columnIndex)
      ));
      totalTextCharacters += values.reduce((total, value) => total + String(value ?? '').length, 0);
      if (totalTextCharacters > GHG_REPORT_RESOURCE_LIMITS.maxWorkbookTextCharacters) {
        throw new AppError('GHG_REPORT_IMPORT_TEXT_BUDGET_EXCEEDED', '温室气体报告 Excel 业务文本总字符数超过限制。', {
          statusCode: 413,
          details: { code: 'GHG_REPORT_IMPORT_TEXT_BUDGET_EXCEEDED', maxTextCharacters: GHG_REPORT_RESOURCE_LIMITS.maxWorkbookTextCharacters }
        });
      }
      if (values.some((value) => value !== '')) rows.push({ rowNumber: matrixIndex + 1, values });
    }
    if (rows.length < sheetContract.minDataRows || rows.length > sheetContract.maxDataRows) {
      throw badRequest(`“${sheetContract.name}”数据行数不符合固定 v1 合同。`, {
        code: 'GHG_REPORT_IMPORT_SHEET_ROW_COUNT_INVALID',
        sheetName: sheetContract.name,
        minDataRows: sheetContract.minDataRows,
        maxDataRows: sheetContract.maxDataRows,
        actualDataRows: rows.length
      });
    }
    result[sheetContract.key] = rows;
  });
  return result;
}

/** 向统一导入问题列表添加带工作表边界的稳定问题。 */
function pushGhgReportIssue(issues, sheetName, rowNumber, fieldName, rawValue, code, message) {
  issues.push(createImportIssue({
    rowNumber,
    fieldName: `${sheetName}.${fieldName}`,
    rawValue,
    code,
    message,
    severity: 'error'
  }));
}

/** 校验字段必填和长度，并将问题绑定到原始工作表行。 */
function validateGhgReportTextField(issues, sheetName, rowNumber, fieldName, value, limitName, required = true) {
  const maxLength = GHG_REPORT_FIELD_LIMITS[limitName];
  if (required && !value) {
    pushGhgReportIssue(issues, sheetName, rowNumber, fieldName, value,
      'GHG_REPORT_REQUIRED_FIELD_MISSING', `${fieldName} 为必填项。`);
  }
  if (value && value.length > maxLength) {
    pushGhgReportIssue(issues, sheetName, rowNumber, fieldName, value,
      'GHG_REPORT_FIELD_TOO_LONG', `${fieldName} 超过 ${maxLength} 个字符。`);
  }
}

/** 校验编码经 trim、NFKC 和大写后的规范键非空且未超过字段上限。 */
function buildValidatedGhgReportCodeKey(issues, sheetName, rowNumber, fieldName, value, limitName) {
  const normalizedKey = buildGhgReportCodeKey(value);
  const maxLength = GHG_REPORT_FIELD_LIMITS[limitName];
  if (!normalizedKey) {
    pushGhgReportIssue(issues, sheetName, rowNumber, fieldName, value,
      'GHG_REPORT_NORMALIZED_KEY_EMPTY', `${fieldName} 规范化后不能为空。`);
  } else if (normalizedKey.length > maxLength) {
    pushGhgReportIssue(issues, sheetName, rowNumber, fieldName, value,
      'GHG_REPORT_NORMALIZED_KEY_TOO_LONG', `${fieldName} 规范化后超过 ${maxLength} 个字符。`);
  }
  return normalizedKey || null;
}

/** 校验文本经 trim、NFKC 和大写后的匹配键非空且未超过对应业务字段上限。 */
function buildValidatedGhgReportNormalizationKey(issues, sheetName, rowNumber, fieldName, value, limitName) {
  const normalizedKey = buildGhgReportNormalizationKey(value);
  const maxLength = GHG_REPORT_FIELD_LIMITS[limitName];
  if (!normalizedKey) {
    pushGhgReportIssue(issues, sheetName, rowNumber, fieldName, value,
      'GHG_REPORT_NORMALIZED_KEY_EMPTY', `${fieldName} 规范化后不能为空。`);
  } else if (normalizedKey.length > maxLength) {
    pushGhgReportIssue(issues, sheetName, rowNumber, fieldName, value,
      'GHG_REPORT_NORMALIZED_KEY_TOO_LONG', `${fieldName} 规范化后超过 ${maxLength} 个字符。`);
  }
  return normalizedKey || null;
}

/** 数值列必须是 XLSX number 单元格，文本数字和日期单元格均拒绝。 */
function normalizeGhgReportNumericCell(value, normalizer) {
  return typeof value === 'number' ? normalizer(value) : null;
}

/** 将有限业务数值按冻结九位小数转换为 BigInt 定点单位，避免高数量级浮点容差膨胀。 */
function buildGhgReportDecimalUnits(value) {
  if (typeof value === 'bigint') return value;
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return null;
  const fixedText = numericValue.toFixed(GHG_REPORT_DECIMAL_PLACES);
  const negative = fixedText.startsWith('-');
  const unsignedText = negative ? fixedText.slice(1) : fixedText;
  const [integerPart, fractionPart = ''] = unsignedText.split('.');
  const units = (BigInt(integerPart) * GHG_REPORT_DECIMAL_SCALE)
    + BigInt(fractionPart.padEnd(GHG_REPORT_DECIMAL_PLACES, '0'));
  return negative ? -units : units;
}

/** 判断两个数值按冻结九位小数定点量化后是否完全一致。 */
function ghgReportNumbersEqual(actual, expected) {
  const actualUnits = buildGhgReportDecimalUnits(actual);
  const expectedUnits = buildGhgReportDecimalUnits(expected);
  return actualUnits !== null && expectedUnits !== null && actualUnits === expectedUnits;
}

/** 解析和校验报告信息唯一行。 */
function normalizeGhgReportInfo(row, issues) {
  const [reportCode, reportName, reportOrganization, rawPeriodStart, rawPeriodEnd, templateId, templateVersion, note] = row.values;
  validateGhgReportTextField(issues, '报告信息', row.rowNumber, '报告编码', reportCode, 'reportCode');
  validateGhgReportTextField(issues, '报告信息', row.rowNumber, '报告名称', reportName, 'reportName');
  validateGhgReportTextField(issues, '报告信息', row.rowNumber, '报告组织', reportOrganization, 'reportOrganization');
  validateGhgReportTextField(issues, '报告信息', row.rowNumber, '备注', note, 'note', false);
  const periodStart = normalizeGhgReportDate(rawPeriodStart);
  const periodEnd = normalizeGhgReportDate(rawPeriodEnd);
  if (!periodStart) pushGhgReportIssue(issues, '报告信息', row.rowNumber, '报告开始日期', rawPeriodStart, 'GHG_REPORT_PERIOD_START_INVALID', '报告开始日期必须是有效的 YYYY-MM-DD 日历日期。');
  if (!periodEnd) pushGhgReportIssue(issues, '报告信息', row.rowNumber, '报告结束日期', rawPeriodEnd, 'GHG_REPORT_PERIOD_END_INVALID', '报告结束日期必须是有效的 YYYY-MM-DD 日历日期。');
  if (periodStart && periodEnd && periodStart > periodEnd) {
    pushGhgReportIssue(issues, '报告信息', row.rowNumber, '报告开始日期,报告结束日期', `${periodStart}|${periodEnd}`, 'GHG_REPORT_PERIOD_RANGE_INVALID', '报告期间必须满足开始日期不晚于结束日期。');
  }
  if (templateId !== GHG_REPORT_TEMPLATE_TYPE || templateVersion !== GHG_REPORT_TEMPLATE_VERSION) {
    pushGhgReportIssue(issues, '报告信息', row.rowNumber, '模板标识,模板版本', `${templateId}|${templateVersion}`, 'GHG_REPORT_TEMPLATE_IDENTITY_INVALID', '模板标识和模板版本必须与固定温室气体报告 Excel v1 完全一致。');
  }
  const reportCodeKey = buildValidatedGhgReportCodeKey(issues, '报告信息', row.rowNumber, '报告编码', reportCode, 'reportCode');
  return {
    rowNumber: row.rowNumber,
    reportCode: reportCode || null,
    reportCodeKey,
    reportName: reportName || null,
    reportOrganization: reportOrganization || null,
    periodStart,
    periodEnd,
    templateId: templateId || null,
    templateVersion: templateVersion || null,
    note: note || null
  };
}

/** 解析组织边界并阻断规范键重复。 */
function normalizeGhgReportOrganizationBoundaries(rows, issues) {
  const codeCounts = new Map();
  const result = rows.map((row) => {
    const [boundaryCode, organizationUnit, inclusionMethod, boundaryDescription] = row.values;
    validateGhgReportTextField(issues, '组织边界', row.rowNumber, '边界编码', boundaryCode, 'boundaryCode');
    validateGhgReportTextField(issues, '组织边界', row.rowNumber, '组织单元', organizationUnit, 'organizationUnit');
    validateGhgReportTextField(issues, '组织边界', row.rowNumber, '纳入方式', inclusionMethod, 'inclusionMethod');
    validateGhgReportTextField(issues, '组织边界', row.rowNumber, '边界说明', boundaryDescription, 'boundaryDescription');
    const boundaryCodeKey = buildValidatedGhgReportCodeKey(issues, '组织边界', row.rowNumber, '边界编码', boundaryCode, 'boundaryCode');
    if (boundaryCodeKey) codeCounts.set(boundaryCodeKey, (codeCounts.get(boundaryCodeKey) || 0) + 1);
    return { rowNumber: row.rowNumber, boundaryCode: boundaryCode || null, boundaryCodeKey, organizationUnit: organizationUnit || null, inclusionMethod: inclusionMethod || null, boundaryDescription: boundaryDescription || null };
  });
  result.forEach((row) => {
    if (row.boundaryCodeKey && codeCounts.get(row.boundaryCodeKey) > 1) {
      pushGhgReportIssue(issues, '组织边界', row.rowNumber, '边界编码', row.boundaryCode, 'GHG_REPORT_ORGANIZATION_BOUNDARY_CODE_DUPLICATED', '同一报告内组织边界编码规范化后重复。');
    }
  });
  return result;
}

/** 解析运行边界并阻断范围与类别组合重复。 */
function normalizeGhgReportOperationalBoundaries(rows, issues) {
  const semanticCounts = new Map();
  const result = rows.map((row) => {
    const [rawScope, category, boundaryDescription] = row.values;
    validateGhgReportTextField(issues, '运行边界', row.rowNumber, '类别', category, 'category');
    validateGhgReportTextField(issues, '运行边界', row.rowNumber, '边界说明', boundaryDescription, 'boundaryDescription');
    const emissionScope = normalizeGhgReportScope(rawScope);
    if (!emissionScope) pushGhgReportIssue(issues, '运行边界', row.rowNumber, '排放范围', rawScope, 'GHG_REPORT_OPERATIONAL_SCOPE_INVALID', '排放范围仅支持范围一、范围二、范围三或 scope_1、scope_2、scope_3。');
    const categoryKey = buildValidatedGhgReportNormalizationKey(
      issues, '运行边界', row.rowNumber, '类别', category, 'category'
    );
    const semanticKey = emissionScope && categoryKey ? `${emissionScope}\0${categoryKey}` : '';
    if (semanticKey) semanticCounts.set(semanticKey, (semanticCounts.get(semanticKey) || 0) + 1);
    return { rowNumber: row.rowNumber, emissionScope, category: category || null, categoryKey: categoryKey || null, boundaryDescription: boundaryDescription || null, semanticKey };
  });
  result.forEach((row) => {
    if (row.semanticKey && semanticCounts.get(row.semanticKey) > 1) {
      pushGhgReportIssue(issues, '运行边界', row.rowNumber, '排放范围,类别', `${row.emissionScope}|${row.category}`, 'GHG_REPORT_OPERATIONAL_BOUNDARY_DUPLICATED', '同一报告内运行边界的排放范围与类别组合不得重复。');
    }
  });
  return result;
}

/** 解析证据说明并阻断规范键重复。 */
function normalizeGhgReportEvidence(rows, issues) {
  const codeCounts = new Map();
  const result = rows.map((row) => {
    const [evidenceCode, evidenceName, evidenceType, evidenceDescription, note] = row.values;
    validateGhgReportTextField(issues, '证据说明', row.rowNumber, '证据编号', evidenceCode, 'evidenceCode');
    validateGhgReportTextField(issues, '证据说明', row.rowNumber, '证据名称', evidenceName, 'evidenceName');
    validateGhgReportTextField(issues, '证据说明', row.rowNumber, '证据类型', evidenceType, 'evidenceType');
    validateGhgReportTextField(issues, '证据说明', row.rowNumber, '证据说明', evidenceDescription, 'evidenceDescription');
    validateGhgReportTextField(issues, '证据说明', row.rowNumber, '备注', note, 'note', false);
    const evidenceCodeKey = buildValidatedGhgReportCodeKey(issues, '证据说明', row.rowNumber, '证据编号', evidenceCode, 'evidenceCode');
    if (evidenceCodeKey) codeCounts.set(evidenceCodeKey, (codeCounts.get(evidenceCodeKey) || 0) + 1);
    return { rowNumber: row.rowNumber, evidenceCode: evidenceCode || null, evidenceCodeKey, evidenceName: evidenceName || null, evidenceType: evidenceType || null, evidenceDescription: evidenceDescription || null, note: note || null };
  });
  result.forEach((row) => {
    if (row.evidenceCodeKey && codeCounts.get(row.evidenceCodeKey) > 1) {
      pushGhgReportIssue(issues, '证据说明', row.rowNumber, '证据编号', row.evidenceCode, 'GHG_REPORT_EVIDENCE_CODE_DUPLICATED', '同一报告内证据编号规范化后重复。');
    }
  });
  return result;
}

/** 解析报告项目，显式保存 emission/removal，禁止使用负排放表达清除。 */
function normalizeGhgReportItems(rows, operationalBoundaries, evidenceRows, issues) {
  const operationalKeys = new Set(operationalBoundaries.map((row) => row.semanticKey).filter(Boolean));
  const evidenceKeys = new Set(evidenceRows.map((row) => row.evidenceCodeKey).filter(Boolean));
  const codeCounts = new Map();
  const result = rows.map((row) => {
    const [itemCode, rawRecordType, rawScope, category, greenhouseGas, sourceOrSink,
      rawActivityValue, activityUnit, rawGasAmount, rawGwp, rawCo2eValue, co2eUnit,
      accountingMethod, evidenceCode, note] = row.values;
    validateGhgReportTextField(issues, '报告项目', row.rowNumber, '项目编码', itemCode, 'itemCode');
    validateGhgReportTextField(issues, '报告项目', row.rowNumber, '类别', category, 'category');
    validateGhgReportTextField(issues, '报告项目', row.rowNumber, '温室气体种类', greenhouseGas, 'greenhouseGas');
    validateGhgReportTextField(issues, '报告项目', row.rowNumber, '排放源或汇', sourceOrSink, 'sourceOrSink');
    validateGhgReportTextField(issues, '报告项目', row.rowNumber, '活动数据单位', activityUnit, 'activityUnit');
    validateGhgReportTextField(issues, '报告项目', row.rowNumber, 'CO2e单位', co2eUnit, 'co2eUnit');
    validateGhgReportTextField(issues, '报告项目', row.rowNumber, '核算方法', accountingMethod, 'accountingMethod');
    validateGhgReportTextField(issues, '报告项目', row.rowNumber, '证据编号', evidenceCode, 'evidenceCode');
    validateGhgReportTextField(issues, '报告项目', row.rowNumber, '备注', note, 'note', false);
    const itemCodeKey = buildValidatedGhgReportCodeKey(issues, '报告项目', row.rowNumber, '项目编码', itemCode, 'itemCode');
    if (itemCodeKey) codeCounts.set(itemCodeKey, (codeCounts.get(itemCodeKey) || 0) + 1);
    const recordType = normalizeGhgReportRecordType(rawRecordType);
    if (!recordType) pushGhgReportIssue(issues, '报告项目', row.rowNumber, '记录类型', rawRecordType, 'GHG_REPORT_RECORD_TYPE_INVALID', '记录类型仅支持排放/emission 或清除/removal。');
    const emissionScope = normalizeGhgReportScope(rawScope);
    if (!emissionScope) pushGhgReportIssue(issues, '报告项目', row.rowNumber, '排放范围', rawScope, 'GHG_REPORT_SCOPE_INVALID', '排放范围仅支持范围一、范围二、范围三或 scope_1、scope_2、scope_3。');
    const categoryKey = buildValidatedGhgReportNormalizationKey(
      issues, '报告项目', row.rowNumber, '类别', category, 'category'
    );
    const greenhouseGasKey = buildValidatedGhgReportNormalizationKey(
      issues, '报告项目', row.rowNumber, '温室气体种类', greenhouseGas, 'greenhouseGas'
    );
    const co2eUnitKey = buildValidatedGhgReportNormalizationKey(
      issues, '报告项目', row.rowNumber, 'CO2e单位', co2eUnit, 'co2eUnit'
    );
    const operationalKey = emissionScope && categoryKey ? `${emissionScope}\0${categoryKey}` : '';
    if (operationalKey && !operationalKeys.has(operationalKey)) pushGhgReportIssue(issues, '报告项目', row.rowNumber, '排放范围,类别', `${rawScope}|${category}`, 'GHG_REPORT_OPERATIONAL_BOUNDARY_NOT_FOUND', '报告项目的排放范围与类别必须存在于运行边界工作表。');
    const activityValue = normalizeGhgReportNumericCell(rawActivityValue, normalizeGhgReportNonNegativeNumber);
    if (activityValue === null) pushGhgReportIssue(issues, '报告项目', row.rowNumber, '活动数据', rawActivityValue, 'GHG_REPORT_ACTIVITY_VALUE_INVALID', '活动数据必须使用 Excel 数值单元格，且有限、非负并不超过 1e15。');
    const gasAmount = normalizeGhgReportNumericCell(rawGasAmount, normalizeGhgReportNonNegativeNumber);
    if (gasAmount === null) pushGhgReportIssue(issues, '报告项目', row.rowNumber, '排放量或清除量', rawGasAmount, 'GHG_REPORT_GAS_AMOUNT_INVALID', '排放量或清除量必须使用 Excel 数值单元格，且有限、非负并不超过 1e15；清除不得写为负排放。');
    const gwp = normalizeGhgReportNumericCell(rawGwp, normalizeGhgReportPositiveNumber);
    if (gwp === null) pushGhgReportIssue(issues, '报告项目', row.rowNumber, 'GWP', rawGwp, 'GHG_REPORT_GWP_INVALID', 'GWP 必须使用 Excel 数值单元格，且有限、大于零并不超过 1e15。');
    const co2eValue = normalizeGhgReportNumericCell(rawCo2eValue, normalizeGhgReportNonNegativeNumber);
    if (co2eValue === null) pushGhgReportIssue(issues, '报告项目', row.rowNumber, 'CO2e', rawCo2eValue, 'GHG_REPORT_CO2E_VALUE_INVALID', 'CO2e 必须使用 Excel 数值单元格，且有限、非负并不超过 1e15。');
    const evidenceCodeKey = buildValidatedGhgReportCodeKey(issues, '报告项目', row.rowNumber, '证据编号', evidenceCode, 'evidenceCode');
    if (evidenceCodeKey && !evidenceKeys.has(evidenceCodeKey)) pushGhgReportIssue(issues, '报告项目', row.rowNumber, '证据编号', evidenceCode, 'GHG_REPORT_EVIDENCE_NOT_FOUND', '报告项目引用的证据编号必须存在于证据说明工作表。');
    return {
      rowNumber: row.rowNumber,
      itemCode: itemCode || null,
      itemCodeKey,
      recordType,
      emissionScope,
      category: category || null,
      categoryKey,
      greenhouseGas: greenhouseGas || null,
      greenhouseGasKey,
      sourceOrSink: sourceOrSink || null,
      activityValue,
      activityUnit: activityUnit || null,
      gasAmount,
      gwp,
      co2eValue,
      co2eUnit: co2eUnit || null,
      co2eUnitKey,
      accountingMethod: accountingMethod || null,
      evidenceCode: evidenceCode || null,
      evidenceCodeKey,
      note: note || null
    };
  });
  result.forEach((row) => {
    if (row.itemCodeKey && codeCounts.get(row.itemCodeKey) > 1) {
      pushGhgReportIssue(issues, '报告项目', row.rowNumber, '项目编码', row.itemCode, 'GHG_REPORT_ITEM_CODE_DUPLICATED', '同一报告内项目编码规范化后重复。');
    }
  });
  return result;
}

/** 将项目按固定维度和九位小数定点单位归集排放、清除及净 CO2e。 */
function buildGhgReportExpectedSummaries(items) {
  const expected = new Map();
  const add = (key, row) => {
    const current = expected.get(key) || {
      emissionCo2eUnits: 0n,
      removalCo2eUnits: 0n,
      netCo2eUnits: 0n
    };
    const co2eUnits = buildGhgReportDecimalUnits(row.co2eValue) || 0n;
    if (row.recordType === 'emission') current.emissionCo2eUnits += co2eUnits;
    if (row.recordType === 'removal') current.removalCo2eUnits += co2eUnits;
    current.netCo2eUnits = current.emissionCo2eUnits - current.removalCo2eUnits;
    expected.set(key, current);
  };
  items.forEach((row) => {
    add('total\0全部', row);
    add(`scope\0${row.emissionScope}`, row);
    add(`category\0${row.categoryKey}`, row);
    add(`gas\0${row.greenhouseGasKey}`, row);
    add(`record_type\0${row.recordType}`, row);
  });
  return expected;
}

/** 解析汇总工作表，要求唯一总计且每个提交汇总与项目事实一致。 */
function normalizeGhgReportSummaries(rows, items, issues) {
  const expected = buildGhgReportExpectedSummaries(items);
  const codeCounts = new Map();
  const semanticCounts = new Map();
  const result = rows.map((row) => {
    const [summaryCode, rawDimension, summaryValue, rawEmissionCo2e, rawRemovalCo2e, rawNetCo2e, co2eUnit, note] = row.values;
    validateGhgReportTextField(issues, '汇总', row.rowNumber, '汇总编码', summaryCode, 'summaryCode');
    validateGhgReportTextField(issues, '汇总', row.rowNumber, '汇总值', summaryValue, 'summaryValue');
    validateGhgReportTextField(issues, '汇总', row.rowNumber, 'CO2e单位', co2eUnit, 'co2eUnit');
    validateGhgReportTextField(issues, '汇总', row.rowNumber, '备注', note, 'note', false);
    const summaryCodeKey = buildValidatedGhgReportCodeKey(issues, '汇总', row.rowNumber, '汇总编码', summaryCode, 'summaryCode');
    if (summaryCodeKey) codeCounts.set(summaryCodeKey, (codeCounts.get(summaryCodeKey) || 0) + 1);
    const summaryDimension = normalizeGhgReportSummaryDimension(rawDimension);
    if (!summaryDimension) pushGhgReportIssue(issues, '汇总', row.rowNumber, '汇总维度', rawDimension, 'GHG_REPORT_SUMMARY_DIMENSION_INVALID', '汇总维度仅支持总计、排放范围、类别、温室气体或记录类型。');
    let normalizedSummaryValue = summaryValue;
    if (summaryDimension === 'scope') normalizedSummaryValue = normalizeGhgReportScope(summaryValue);
    if (summaryDimension === 'record_type') normalizedSummaryValue = normalizeGhgReportRecordType(summaryValue);
    if (summaryDimension === 'scope' && !normalizedSummaryValue) pushGhgReportIssue(issues, '汇总', row.rowNumber, '汇总值', summaryValue, 'GHG_REPORT_SUMMARY_SCOPE_INVALID', '排放范围汇总值必须是有效范围。');
    if (summaryDimension === 'record_type' && !normalizedSummaryValue) pushGhgReportIssue(issues, '汇总', row.rowNumber, '汇总值', summaryValue, 'GHG_REPORT_SUMMARY_RECORD_TYPE_INVALID', '记录类型汇总值必须是排放/emission 或清除/removal。');
    let semanticValue = normalizedSummaryValue;
    if (summaryDimension === 'category') {
      semanticValue = buildValidatedGhgReportNormalizationKey(
        issues, '汇总', row.rowNumber, '汇总值', normalizedSummaryValue, 'category'
      );
    }
    if (summaryDimension === 'gas') {
      semanticValue = buildValidatedGhgReportNormalizationKey(
        issues, '汇总', row.rowNumber, '汇总值', normalizedSummaryValue, 'greenhouseGas'
      );
    }
    const co2eUnitKey = buildValidatedGhgReportNormalizationKey(
      issues, '汇总', row.rowNumber, 'CO2e单位', co2eUnit, 'co2eUnit'
    );
    const semanticKey = summaryDimension && semanticValue ? `${summaryDimension}\0${semanticValue}` : '';
    if (semanticKey) semanticCounts.set(semanticKey, (semanticCounts.get(semanticKey) || 0) + 1);
    const emissionCo2e = normalizeGhgReportNumericCell(rawEmissionCo2e, normalizeGhgReportNonNegativeNumber);
    const removalCo2e = normalizeGhgReportNumericCell(rawRemovalCo2e, normalizeGhgReportNonNegativeNumber);
    const netCo2e = normalizeGhgReportNumericCell(rawNetCo2e, normalizeGhgReportSignedNumber);
    if (emissionCo2e === null) pushGhgReportIssue(issues, '汇总', row.rowNumber, '排放CO2e', rawEmissionCo2e, 'GHG_REPORT_SUMMARY_EMISSION_INVALID', '排放CO2e 必须使用 Excel 数值单元格，且有限、非负并不超过 1e15。');
    if (removalCo2e === null) pushGhgReportIssue(issues, '汇总', row.rowNumber, '清除CO2e', rawRemovalCo2e, 'GHG_REPORT_SUMMARY_REMOVAL_INVALID', '清除CO2e 必须使用 Excel 数值单元格，且有限、非负并不超过 1e15。');
    if (netCo2e === null) pushGhgReportIssue(issues, '汇总', row.rowNumber, '净CO2e', rawNetCo2e, 'GHG_REPORT_SUMMARY_NET_INVALID', '净CO2e 必须使用 Excel 数值单元格，且有限并在 ±1e15 范围内。');
    if (summaryDimension === 'total' && summaryValue !== '全部') pushGhgReportIssue(issues, '汇总', row.rowNumber, '汇总值', summaryValue, 'GHG_REPORT_TOTAL_VALUE_INVALID', '总计汇总值必须固定为“全部”。');
    const emissionCo2eUnits = buildGhgReportDecimalUnits(emissionCo2e);
    const removalCo2eUnits = buildGhgReportDecimalUnits(removalCo2e);
    if (emissionCo2eUnits !== null && removalCo2eUnits !== null && netCo2e !== null
      && !ghgReportNumbersEqual(netCo2e, emissionCo2eUnits - removalCo2eUnits)) {
      pushGhgReportIssue(issues, '汇总', row.rowNumber, '净CO2e', rawNetCo2e, 'GHG_REPORT_SUMMARY_NET_MISMATCH', '净CO2e 必须等于排放CO2e减去清除CO2e。');
    }
    if (semanticKey && emissionCo2e !== null && removalCo2e !== null && netCo2e !== null) {
      const expectedRow = expected.get(semanticKey);
      if (!expectedRow) {
        pushGhgReportIssue(issues, '汇总', row.rowNumber, '汇总值', summaryValue, 'GHG_REPORT_SUMMARY_ORPHANED', '汇总值在报告项目中没有对应事实。');
      } else if (![
        ['排放CO2e', emissionCo2e, expectedRow.emissionCo2eUnits],
        ['清除CO2e', removalCo2e, expectedRow.removalCo2eUnits],
        ['净CO2e', netCo2e, expectedRow.netCo2eUnits]
      ].every((entry) => ghgReportNumbersEqual(entry[1], entry[2]))) {
        pushGhgReportIssue(issues, '汇总', row.rowNumber, '排放CO2e,清除CO2e,净CO2e', `${rawEmissionCo2e}|${rawRemovalCo2e}|${rawNetCo2e}`, 'GHG_REPORT_SUMMARY_MISMATCH', '汇总排放、清除或净 CO2e 与报告项目事实不一致。');
      }
    }
    return {
      rowNumber: row.rowNumber,
      summaryCode: summaryCode || null,
      summaryCodeKey,
      summaryDimension,
      summaryValue: normalizedSummaryValue || null,
      semanticKey,
      emissionCo2e,
      removalCo2e,
      netCo2e,
      co2eUnit: co2eUnit || null,
      co2eUnitKey,
      note: note || null
    };
  });
  result.forEach((row) => {
    if (row.summaryCodeKey && codeCounts.get(row.summaryCodeKey) > 1) pushGhgReportIssue(issues, '汇总', row.rowNumber, '汇总编码', row.summaryCode, 'GHG_REPORT_SUMMARY_CODE_DUPLICATED', '同一报告内汇总编码规范化后重复。');
    if (row.semanticKey && semanticCounts.get(row.semanticKey) > 1) pushGhgReportIssue(issues, '汇总', row.rowNumber, '汇总维度,汇总值', `${row.summaryDimension}|${row.summaryValue}`, 'GHG_REPORT_SUMMARY_DUPLICATED', '同一汇总维度和值只能出现一次。');
  });
  if (result.filter((row) => row.summaryDimension === 'total' && row.summaryValue === '全部').length !== 1) {
    pushGhgReportIssue(issues, '汇总', 2, '汇总维度,汇总值', '总计|全部', 'GHG_REPORT_TOTAL_SUMMARY_REQUIRED', '每份报告必须有且仅有一行“总计/全部”汇总。');
  }
  return result;
}

/** 校验项目和汇总的 CO2e 单位全报告一致。 */
function validateGhgReportUnits(items, summaries, issues) {
  const unitKeys = new Set([...items, ...summaries]
    .map((row) => row.co2eUnitKey)
    .filter(Boolean));
  if (unitKeys.size > 1) pushGhgReportIssue(issues, '报告项目', 2, 'CO2e单位', [...unitKeys].join('|'), 'GHG_REPORT_CO2E_UNIT_MISMATCH', '报告项目和汇总必须使用同一个 CO2e 单位。');
}

/** 使用当前数据库状态重算整份温室气体报告原子候选。 */
function buildGhgReportImportPreview({ db, buffer, originalFilename }) {
  const workbook = parseGhgReportWorkbook(buffer, originalFilename);
  const issues = [];
  const report = normalizeGhgReportInfo(workbook.report[0], issues);
  const organizationBoundaries = normalizeGhgReportOrganizationBoundaries(workbook.organizationBoundaries, issues);
  const operationalBoundaries = normalizeGhgReportOperationalBoundaries(workbook.operationalBoundaries, issues);
  const evidence = normalizeGhgReportEvidence(workbook.evidence, issues);
  const items = normalizeGhgReportItems(workbook.items, operationalBoundaries, evidence, issues);
  const summaries = normalizeGhgReportSummaries(workbook.summaries, items, issues);
  validateGhgReportUnits(items, summaries, issues);
  if (report.reportCodeKey && db.prepare('SELECT id FROM ghg_reports WHERE report_code_key = ?').get(report.reportCodeKey)) {
    pushGhgReportIssue(issues, '报告信息', report.rowNumber, '报告编码', report.reportCode, 'GHG_REPORT_CODE_EXISTS', '温室气体报告编码已存在，禁止跳过、覆盖或复用。');
  }
  if (issues.length > GHG_REPORT_RESOURCE_LIMITS.maxIssues) {
    throw new AppError('GHG_REPORT_IMPORT_ISSUE_LIMIT_EXCEEDED', '温室气体报告预演问题数量超过限制。', {
      statusCode: 413,
      details: { code: 'GHG_REPORT_IMPORT_ISSUE_LIMIT_EXCEEDED', maxIssues: GHG_REPORT_RESOURCE_LIMITS.maxIssues }
    });
  }
  const status = issues.length > 0 ? 'blocked' : 'wouldImport';
  const previewItem = {
    candidateRowId: `ghg-report:${report.reportCodeKey || report.rowNumber}`,
    rowNumber: report.rowNumber,
    reportCode: report.reportCode,
    reportName: report.reportName,
    status,
    counts: { organizationBoundaries: organizationBoundaries.length, operationalBoundaries: operationalBoundaries.length, items: items.length, summaries: summaries.length, evidence: evidence.length },
    issues
  };
  const candidateRows = status === 'wouldImport' ? [{
    candidateRowId: previewItem.candidateRowId,
    rowNumber: report.rowNumber,
    report,
    organizationBoundaries,
    operationalBoundaries,
    items,
    summaries,
    evidence
  }] : [];
  return {
    fieldMapping: Object.fromEntries(GHG_REPORT_SHEETS.flatMap((sheet) => sheet.headers.map((header) => [`${sheet.name}.${header}`, `${sheet.name}.${header}`]))),
    summary: buildImportSummary([previewItem]),
    candidateRows,
    items: [previewItem],
    auditIssues: issues,
    notices: [
      '预演只持久化统一导入审计、原文件摘要、签名和服务端候选见证，不写温室气体报告事实。',
      'execute 由服务端重读原文件、重算候选并在 BEGIN IMMEDIATE 锁内再次校验，随后锁内备份和原子写入六张温室气体报告表。',
      '导入不创建、修改或回填 N6 五张报告表、碳活动、核算运行、核算结果、旧 carbon_emissions 或任何碳因子；重复 N7 报告编码确定性阻断。'
    ]
  };
}

/** 在温室气体报告导入 preview/execute 事务中写入稳定操作审计。 */
function insertGhgReportOperationLog(db, actor = {}, operation, targetId, detail = {}) {
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip, created_at)
    VALUES (?, ?, 'ghg_report', ?, ?, ?, ?)`).run(
    actor.userId || null,
    operation,
    targetId === null ? null : String(targetId),
    JSON.stringify(detail || {}),
    actor.ip || null,
    new Date().toISOString()
  );
}

/** 在同一业务事务中原子写入温室气体报告六张领域表。 */
function insertGhgReportImportCandidates({ db, batchId, candidateRows, options = {} }) {
  if (!Array.isArray(candidateRows) || candidateRows.length !== 1) {
    throw badRequest('温室气体报告导入每个批次必须且只能包含一份原子报告候选。', {
      code: 'GHG_REPORT_CANDIDATE_COUNT_INVALID'
    });
  }
  const candidate = candidateRows[0];
  const report = candidate.report;
  if (db.prepare('SELECT id FROM ghg_reports WHERE report_code_key = ?').get(report.reportCodeKey)) {
    throw badRequest('温室气体报告编码已被其他导入写入，请重新预演。', { code: 'GHG_REPORT_CODE_STALE' });
  }
  const reportResult = db.prepare(`INSERT INTO ghg_reports
    (report_code, report_code_key, report_name, report_organization, period_start, period_end,
     template_id, template_version, note, source_batch_id, source_row_number, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    report.reportCode, report.reportCodeKey, report.reportName, report.reportOrganization,
    report.periodStart, report.periodEnd, report.templateId, report.templateVersion, report.note,
    batchId, report.rowNumber, options.actor?.userId || null, new Date().toISOString()
  );
  const reportId = Number(reportResult.lastInsertRowid);
  const evidenceIdByKey = new Map();
  const insertEvidence = db.prepare(`INSERT INTO ghg_report_evidence
    (report_id, evidence_code, evidence_code_key, evidence_name, evidence_type, evidence_description, note, source_row_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  candidate.evidence.forEach((row) => {
    const result = insertEvidence.run(reportId, row.evidenceCode, row.evidenceCodeKey, row.evidenceName, row.evidenceType, row.evidenceDescription, row.note, row.rowNumber);
    evidenceIdByKey.set(row.evidenceCodeKey, Number(result.lastInsertRowid));
  });
  const insertOrganizationBoundary = db.prepare(`INSERT INTO ghg_report_organization_boundaries
    (report_id, boundary_code, boundary_code_key, organization_unit, inclusion_method, boundary_description, source_row_number)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  candidate.organizationBoundaries.forEach((row) => insertOrganizationBoundary.run(reportId, row.boundaryCode, row.boundaryCodeKey, row.organizationUnit, row.inclusionMethod, row.boundaryDescription, row.rowNumber));
  const insertOperationalBoundary = db.prepare(`INSERT INTO ghg_report_operational_boundaries
    (report_id, emission_scope, category, category_key, boundary_description, source_row_number)
    VALUES (?, ?, ?, ?, ?, ?)`);
  candidate.operationalBoundaries.forEach((row) => insertOperationalBoundary.run(reportId, row.emissionScope, row.category, row.categoryKey, row.boundaryDescription, row.rowNumber));
  const insertItem = db.prepare(`INSERT INTO ghg_report_items
    (report_id, item_code, item_code_key, record_type, emission_scope, category, greenhouse_gas,
     source_or_sink, activity_value, activity_unit, gas_amount, gwp, co2e_value, co2e_unit,
     accounting_method, evidence_id, note, source_row_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  candidate.items.forEach((row) => insertItem.run(
    reportId, row.itemCode, row.itemCodeKey, row.recordType, row.emissionScope, row.category,
    row.greenhouseGas, row.sourceOrSink, row.activityValue, row.activityUnit, row.gasAmount,
    row.gwp, row.co2eValue, row.co2eUnit, row.accountingMethod,
    evidenceIdByKey.get(row.evidenceCodeKey), row.note, row.rowNumber
  ));
  const insertSummary = db.prepare(`INSERT INTO ghg_report_summaries
    (report_id, summary_code, summary_code_key, summary_dimension, summary_value,
     emission_co2e, removal_co2e, net_co2e, co2e_unit, note, source_row_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  candidate.summaries.forEach((row) => insertSummary.run(
    reportId, row.summaryCode, row.summaryCodeKey, row.summaryDimension, row.summaryValue,
    row.emissionCo2e, row.removalCo2e, row.netCo2e, row.co2eUnit, row.note, row.rowNumber
  ));
  insertGhgReportOperationLog(db, options.actor || {}, 'carbon.ghg-report.import.execute', reportId, {
    reportId,
    reportCode: report.reportCode,
    batchId,
    counts: { organizationBoundaries: candidate.organizationBoundaries.length, operationalBoundaries: candidate.operationalBoundaries.length, items: candidate.items.length, summaries: candidate.summaries.length, evidence: candidate.evidence.length }
  });
  return { imported: 1, importedIds: [reportId], importedItems: [{ reportId, reportCode: report.reportCode, rowNumber: report.rowNumber }] };
}

/** 将取得服务端 SHA 后的解析或安全失败投影为稳定脱敏的 failed preview 审计。 */
function buildGhgReportPreviewFailure({ error }) {
  const sourceCode = String(error?.details?.code || error?.code || '');
  const code = /^GHG_REPORT_[A-Z0-9_]+$/.test(sourceCode) ? sourceCode : 'GHG_REPORT_IMPORT_PREVIEW_FAILED';
  const message = Number(error?.statusCode || 400) === 413
    ? '温室气体报告文件超过固定模板安全资源限制。'
    : (code === 'GHG_REPORT_IMPORT_FORMULA_CELL_REJECTED'
      ? '温室气体报告固定模板不允许公式单元格。'
      : '温室气体报告文件未通过固定模板或安全校验。');
  const issue = createImportIssue({ rowNumber: 1, fieldName: '工作簿.文件', rawValue: null, code, message, severity: 'error' });
  const item = { candidateRowId: 'ghg-report:failed-preview', rowNumber: 1, status: 'blocked', issues: [issue] };
  return {
    fieldMapping: {},
    summary: buildImportSummary([item]),
    candidateRows: [],
    items: [item],
    auditIssues: [issue],
    notices: [
      '服务端取得原文件 SHA-256 后发生的解析或安全失败会原子保存 failed 批次、脱敏问题和预演操作审计。',
      '失败批次已引用的原文件保留用于受控追溯；若审计事务失败，批次和问题回滚且路由仅清理未被批次引用的文件。',
      '解析失败不写温室气体报告六表，也不写 N6 报告五表、碳活动、核算运行、核算结果、旧 carbon_emissions 或任何碳因子。'
    ]
  };
}

/** 在共享 preview 事务中持久化温室气体报告领域操作审计。 */
function persistGhgReportPreviewAudit({ db, batch, preview, safeFile, options = {} }) {
  insertGhgReportOperationLog(db, options.actor || {}, 'carbon.ghg-report.import.preview', batch.id, {
    batchId: batch.id,
    fileSha256: safeFile.fileSha256,
    summary: preview.summary
  });
}

// 描述器将六表解析、preview 审计和锁内原子写入接入共享受控导入安全链。
const GHG_REPORT_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: GHG_REPORT_TEMPLATE_TYPE,
  domainName: '温室气体报告',
  buildPreview: buildGhgReportImportPreview,
  persistBuildPreviewFailures: true,
  buildPreviewFailure: buildGhgReportPreviewFailure,
  persistPreviewAudit: persistGhgReportPreviewAudit,
  insertCandidates: insertGhgReportImportCandidates
});

/** 创建温室气体报告受控预演。 */
function previewGhgReportImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, GHG_REPORT_IMPORT_DESCRIPTOR, options);
}

/** 执行温室气体报告受控导入。 */
async function executeGhgReportImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, GHG_REPORT_IMPORT_DESCRIPTOR, options);
}

module.exports = {
  GHG_REPORT_IMPORT_CONFIRM_TEXT,
  GHG_REPORT_IMPORT_DESCRIPTOR,
  buildGhgReportImportPreview,
  buildGhgReportPreviewFailure,
  executeGhgReportImport,
  ghgReportNumbersEqual,
  insertGhgReportImportCandidates,
  parseGhgReportWorkbook,
  previewGhgReportImport,
  validateGhgReportXlsxArchive
};
