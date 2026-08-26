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
  CARBON_EMISSION_REPORT_FIELD_LIMITS,
  CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
  CARBON_EMISSION_REPORT_RESOURCE_LIMITS,
  CARBON_EMISSION_REPORT_SHEETS,
  CARBON_EMISSION_REPORT_TEMPLATE_TYPE,
  CARBON_EMISSION_REPORT_TEMPLATE_VERSION,
  buildCarbonEmissionReportCodeKey,
  buildCarbonEmissionReportNormalizationKey,
  normalizeCarbonEmissionReportBoundaryType,
  normalizeCarbonEmissionReportDate,
  normalizeCarbonEmissionReportNonNegativeNumber,
  normalizeCarbonEmissionReportPositiveNumber,
  normalizeCarbonEmissionReportScope,
  normalizeCarbonEmissionReportSummaryDimension,
  normalizeCarbonEmissionReportText
} = require('./carbonEmissionReportContracts');

// 汇总比较采用相对与绝对容差，避免 Excel 十进制转 SQLite REAL 的无意义尾差。
const CARBON_EMISSION_REPORT_SUMMARY_TOLERANCE = 1e-9;
// 固定数值列索引：仅这些业务数值读取原始 cell.v，其余文本和日期继续使用显示文本。
const CARBON_EMISSION_REPORT_NUMERIC_COLUMNS = Object.freeze({
  items: Object.freeze(new Set([4, 6, 8])),
  summaries: Object.freeze(new Set([3]))
});

/** 将底层 XLSX ZIP 安全错误映射为碳排放报告稳定领域错误。 */
function remapCarbonEmissionReportArchiveError(error) {
  const sourceCode = String(error?.details?.code || error?.code || '');
  const suffix = sourceCode.startsWith('CARBON_ACTIVITY_IMPORT_')
    ? sourceCode.slice('CARBON_ACTIVITY_IMPORT_'.length)
    : 'ZIP_PAYLOAD_INVALID';
  const code = `CARBON_EMISSION_REPORT_IMPORT_${suffix}`;
  const message = suffix === 'FORMULA_CELL_REJECTED'
    ? '碳排放报告固定模板不允许公式单元格。'
    : '碳排放报告 Excel 安全校验失败。';
  return new AppError(code, message, {
    statusCode: Number(error?.statusCode || 400),
    details: { ...(error?.details || {}), code }
  });
}

/** 使用已复审 N5 ZIP/XLSX 容器检查并投影为 N6 领域错误。 */
function validateCarbonEmissionReportXlsxArchive(buffer) {
  try {
    return validateCarbonActivityXlsxArchive(buffer);
  } catch (error) {
    throw remapCarbonEmissionReportArchiveError(error);
  }
}

/** 扫描有效工作表区域，拒绝任意 SheetJS 公式属性。 */
function assertCarbonEmissionReportWorksheetHasNoFormulas(worksheet, range) {
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
      if (cell && Object.prototype.hasOwnProperty.call(cell, 'f')) {
        throw new AppError('CARBON_EMISSION_REPORT_IMPORT_FORMULA_CELL_REJECTED', '碳排放报告固定模板不允许公式单元格。', {
          statusCode: 400,
          details: { code: 'CARBON_EMISSION_REPORT_IMPORT_FORMULA_CELL_REJECTED' }
        });
      }
    }
  }
}

/** 读取固定业务数值列；真实数值保留原始 cell.v，文本等非数值类型继续采用显示文本。 */
function readCarbonEmissionReportCellValue(worksheet, matrix, sheetKey, rowIndex, columnIndex) {
  const displayValue = normalizeCarbonEmissionReportText(matrix[rowIndex]?.[columnIndex]);
  const numericColumns = CARBON_EMISSION_REPORT_NUMERIC_COLUMNS[sheetKey];
  if (!numericColumns?.has(columnIndex)) return displayValue;
  const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return '';
  return cell.t === 'n' ? cell.v : displayValue;
}

/** 从固定多表 Excel v1 读取文本和原始数值行，并冻结工作表、表头和资源边界。 */
function parseCarbonEmissionReportWorkbook(buffer, originalFilename) {
  if (!/\.xlsx$/i.test(String(originalFilename || ''))) {
    throw badRequest('碳排放报告导入仅支持固定 Excel v1 的 .xlsx 文件。', {
      code: 'CARBON_EMISSION_REPORT_IMPORT_XLSX_REQUIRED'
    });
  }
  validateCarbonEmissionReportXlsxArchive(buffer);
  let workbook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'buffer',
      cellText: true,
      cellDates: false,
      sheetRows: Math.max(...CARBON_EMISSION_REPORT_SHEETS.map((sheet) => sheet.maxDataRows)) + 2
    });
  } catch (_error) {
    throw badRequest('碳排放报告 Excel 文件无法解析。', {
      code: 'CARBON_EMISSION_REPORT_IMPORT_WORKBOOK_INVALID'
    });
  }

  const expectedSheetNames = CARBON_EMISSION_REPORT_SHEETS.map((sheet) => sheet.name);
  const hiddenSheetExists = (workbook.Workbook?.Sheets || []).some((sheet) => Number(sheet.Hidden || 0) !== 0);
  if (hiddenSheetExists
    || workbook.SheetNames.length !== expectedSheetNames.length
    || workbook.SheetNames.some((sheetName, index) => sheetName !== expectedSheetNames[index])) {
    throw badRequest('碳排放报告 Excel 的工作表名称、顺序和可见性必须与固定 v1 模板完全一致。', {
      code: 'CARBON_EMISSION_REPORT_IMPORT_SHEET_CONTRACT_INVALID',
      expectedSheetNames,
      actualSheetNames: workbook.SheetNames
    });
  }

  let totalNonEmptyCells = 0;
  let totalTextCharacters = 0;
  const result = {};
  CARBON_EMISSION_REPORT_SHEETS.forEach((sheetContract) => {
    const worksheet = workbook.Sheets[sheetContract.name];
    const fullReference = worksheet?.['!fullref'] || worksheet?.['!ref'];
    if (!worksheet || !fullReference) {
      throw badRequest(`碳排放报告 Excel 缺少有效的“${sheetContract.name}”工作表。`, {
        code: 'CARBON_EMISSION_REPORT_IMPORT_SHEET_REQUIRED',
        sheetName: sheetContract.name
      });
    }
    if (Array.isArray(worksheet['!merges']) && worksheet['!merges'].length > 0) {
      throw badRequest('碳排放报告 Excel 不允许合并单元格。', {
        code: 'CARBON_EMISSION_REPORT_IMPORT_MERGED_CELLS_REJECTED',
        sheetName: sheetContract.name
      });
    }
    let range;
    try {
      range = XLSX.utils.decode_range(fullReference);
    } catch (_error) {
      throw badRequest('碳排放报告 Excel 工作表范围无效。', {
        code: 'CARBON_EMISSION_REPORT_IMPORT_SHEET_RANGE_INVALID',
        sheetName: sheetContract.name
      });
    }
    if (range.e.c >= sheetContract.headers.length) {
      throw new AppError('CARBON_EMISSION_REPORT_IMPORT_COLUMN_LIMIT_EXCEEDED', '碳排放报告 Excel 列数超过固定模板限制。', {
        statusCode: 413,
        details: { code: 'CARBON_EMISSION_REPORT_IMPORT_COLUMN_LIMIT_EXCEEDED', sheetName: sheetContract.name }
      });
    }
    if (range.e.r > sheetContract.maxDataRows) {
      throw new AppError('CARBON_EMISSION_REPORT_IMPORT_ROW_LIMIT_EXCEEDED', '碳排放报告 Excel 数据行数超过固定工作表限制。', {
        statusCode: 413,
        details: { code: 'CARBON_EMISSION_REPORT_IMPORT_ROW_LIMIT_EXCEEDED', sheetName: sheetContract.name, maxDataRows: sheetContract.maxDataRows }
      });
    }
    assertCarbonEmissionReportWorksheetHasNoFormulas(worksheet, range);
    const sheetNonEmptyCells = Object.entries(worksheet).filter(([address, cell]) => (
      !address.startsWith('!') && cell
      && (Boolean(cell.f) || (cell.v !== undefined && cell.v !== null && String(cell.v) !== ''))
    )).length;
    totalNonEmptyCells += sheetNonEmptyCells;
    if (totalNonEmptyCells > CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxNonEmptyCells) {
      throw new AppError('CARBON_EMISSION_REPORT_IMPORT_CELL_LIMIT_EXCEEDED', '碳排放报告 Excel 非空单元格总数超过限制。', {
        statusCode: 413,
        details: { code: 'CARBON_EMISSION_REPORT_IMPORT_CELL_LIMIT_EXCEEDED', maxNonEmptyCells: CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxNonEmptyCells }
      });
    }
    const matrix = XLSX.utils.sheet_to_json(worksheet, { header: 1, raw: false, defval: '', blankrows: true });
    const headers = (matrix[0] || []).map(normalizeCarbonEmissionReportText);
    if (headers.length !== sheetContract.headers.length
      || headers.some((header, index) => header !== sheetContract.headers[index])) {
      throw badRequest(`“${sheetContract.name}”表头必须与固定 v1 模板完全一致。`, {
        code: 'CARBON_EMISSION_REPORT_IMPORT_HEADERS_MISMATCH',
        sheetName: sheetContract.name,
        expectedHeaders: sheetContract.headers,
        actualHeaders: headers
      });
    }
    totalTextCharacters += headers.reduce((total, value) => total + value.length, 0);
    const rows = [];
    for (let matrixIndex = 1; matrixIndex < matrix.length; matrixIndex += 1) {
      const values = sheetContract.headers.map((_header, columnIndex) => (
        readCarbonEmissionReportCellValue(
          worksheet,
          matrix,
          sheetContract.key,
          matrixIndex,
          columnIndex
        )
      ));
      totalTextCharacters += values.reduce((total, value) => total + String(value ?? '').length, 0);
      if (totalTextCharacters > CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxWorkbookTextCharacters) {
        throw new AppError('CARBON_EMISSION_REPORT_IMPORT_TEXT_BUDGET_EXCEEDED', '碳排放报告 Excel 业务文本总字符数超过限制。', {
          statusCode: 413,
          details: { code: 'CARBON_EMISSION_REPORT_IMPORT_TEXT_BUDGET_EXCEEDED', maxTextCharacters: CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxWorkbookTextCharacters }
        });
      }
      if (values.some(Boolean)) rows.push({ rowNumber: matrixIndex + 1, values });
    }
    if (rows.length < sheetContract.minDataRows || rows.length > sheetContract.maxDataRows) {
      throw badRequest(`“${sheetContract.name}”数据行数不符合固定 v1 合同。`, {
        code: 'CARBON_EMISSION_REPORT_IMPORT_SHEET_ROW_COUNT_INVALID',
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
function pushCarbonEmissionReportIssue(issues, sheetName, rowNumber, fieldName, rawValue, code, message) {
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
function validateCarbonEmissionReportTextField(issues, sheetName, rowNumber, fieldName, value, limitName, required = true) {
  const maxLength = CARBON_EMISSION_REPORT_FIELD_LIMITS[limitName];
  if (required && !value) {
    pushCarbonEmissionReportIssue(issues, sheetName, rowNumber, fieldName, value,
      'CARBON_EMISSION_REPORT_REQUIRED_FIELD_MISSING', `${fieldName} 为必填项。`);
  }
  if (value && value.length > maxLength) {
    pushCarbonEmissionReportIssue(issues, sheetName, rowNumber, fieldName, value,
      'CARBON_EMISSION_REPORT_FIELD_TOO_LONG', `${fieldName} 超过 ${maxLength} 个字符。`);
  }
}

/** 校验编码经 trim、NFKC 和大写后的规范键非空且未超过字段上限。 */
function buildValidatedCarbonEmissionReportCodeKey(issues, sheetName, rowNumber, fieldName, value, limitName) {
  const normalizedKey = buildCarbonEmissionReportCodeKey(value);
  const maxLength = CARBON_EMISSION_REPORT_FIELD_LIMITS[limitName];
  if (!normalizedKey) {
    pushCarbonEmissionReportIssue(issues, sheetName, rowNumber, fieldName, value,
      'CARBON_EMISSION_REPORT_NORMALIZED_KEY_EMPTY', `${fieldName} 规范化后不能为空。`);
  } else if (normalizedKey.length > maxLength) {
    pushCarbonEmissionReportIssue(issues, sheetName, rowNumber, fieldName, value,
      'CARBON_EMISSION_REPORT_NORMALIZED_KEY_TOO_LONG', `${fieldName} 规范化后超过 ${maxLength} 个字符。`);
  }
  return normalizedKey || null;
}

/** 判断两个非负排放值是否在冻结汇总容差内一致。 */
function carbonEmissionReportNumbersEqual(actual, expected) {
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= CARBON_EMISSION_REPORT_SUMMARY_TOLERANCE * scale;
}

/** 解析和校验报告信息唯一行。 */
function normalizeCarbonEmissionReportInfo(row, issues) {
  const [reportCode, reportName, reportOrganization, rawPeriodStart, rawPeriodEnd, templateId, templateVersion, note] = row.values;
  validateCarbonEmissionReportTextField(issues, '报告信息', row.rowNumber, '报告编码', reportCode, 'reportCode');
  validateCarbonEmissionReportTextField(issues, '报告信息', row.rowNumber, '报告名称', reportName, 'reportName');
  validateCarbonEmissionReportTextField(issues, '报告信息', row.rowNumber, '报告组织', reportOrganization, 'reportOrganization');
  validateCarbonEmissionReportTextField(issues, '报告信息', row.rowNumber, '备注', note, 'note', false);
  const periodStart = normalizeCarbonEmissionReportDate(rawPeriodStart);
  const periodEnd = normalizeCarbonEmissionReportDate(rawPeriodEnd);
  if (!periodStart) pushCarbonEmissionReportIssue(issues, '报告信息', row.rowNumber, '报告开始日期', rawPeriodStart, 'CARBON_EMISSION_REPORT_PERIOD_START_INVALID', '报告开始日期必须是有效的 YYYY-MM-DD 日历日期。');
  if (!periodEnd) pushCarbonEmissionReportIssue(issues, '报告信息', row.rowNumber, '报告结束日期', rawPeriodEnd, 'CARBON_EMISSION_REPORT_PERIOD_END_INVALID', '报告结束日期必须是有效的 YYYY-MM-DD 日历日期。');
  if (periodStart && periodEnd && periodStart > periodEnd) {
    pushCarbonEmissionReportIssue(issues, '报告信息', row.rowNumber, '报告开始日期,报告结束日期', `${periodStart}|${periodEnd}`, 'CARBON_EMISSION_REPORT_PERIOD_RANGE_INVALID', '报告期间必须满足开始日期不晚于结束日期。');
  }
  if (templateId !== CARBON_EMISSION_REPORT_TEMPLATE_TYPE || templateVersion !== CARBON_EMISSION_REPORT_TEMPLATE_VERSION) {
    pushCarbonEmissionReportIssue(issues, '报告信息', row.rowNumber, '模板标识,模板版本', `${templateId}|${templateVersion}`, 'CARBON_EMISSION_REPORT_TEMPLATE_IDENTITY_INVALID', '模板标识和模板版本必须与固定碳排放报告 Excel v1 完全一致。');
  }
  const reportCodeKey = buildValidatedCarbonEmissionReportCodeKey(
    issues, '报告信息', row.rowNumber, '报告编码', reportCode, 'reportCode'
  );
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

/** 解析和校验组织与核算边界两行。 */
function normalizeCarbonEmissionReportBoundaries(rows, issues) {
  const result = rows.map((row) => {
    const [rawBoundaryType, boundaryName, boundaryDescription] = row.values;
    validateCarbonEmissionReportTextField(issues, '组织与核算边界', row.rowNumber, '边界名称', boundaryName, 'boundaryName');
    validateCarbonEmissionReportTextField(issues, '组织与核算边界', row.rowNumber, '边界说明', boundaryDescription, 'boundaryDescription');
    const boundaryType = normalizeCarbonEmissionReportBoundaryType(rawBoundaryType);
    if (!boundaryType) pushCarbonEmissionReportIssue(issues, '组织与核算边界', row.rowNumber, '边界类型', rawBoundaryType, 'CARBON_EMISSION_REPORT_BOUNDARY_TYPE_INVALID', '边界类型仅支持组织边界或核算边界。');
    return { rowNumber: row.rowNumber, boundaryType, boundaryName: boundaryName || null, boundaryDescription: boundaryDescription || null };
  });
  ['organization', 'accounting'].forEach((boundaryType) => {
    const matches = result.filter((row) => row.boundaryType === boundaryType);
    if (matches.length !== 1) {
      pushCarbonEmissionReportIssue(issues, '组织与核算边界', 2, '边界类型', boundaryType,
        'CARBON_EMISSION_REPORT_BOUNDARY_UNIQUE_REQUIRED', '组织边界和核算边界必须各有且仅有一行。');
    }
  });
  return result;
}

/** 解析和校验证据说明，并阻断规范键重复。 */
function normalizeCarbonEmissionReportEvidence(rows, issues) {
  const codeCounts = new Map();
  const result = rows.map((row) => {
    const [evidenceCode, evidenceName, evidenceType, evidenceDescription, note] = row.values;
    validateCarbonEmissionReportTextField(issues, '证据说明', row.rowNumber, '证据编号', evidenceCode, 'evidenceCode');
    validateCarbonEmissionReportTextField(issues, '证据说明', row.rowNumber, '证据名称', evidenceName, 'evidenceName');
    validateCarbonEmissionReportTextField(issues, '证据说明', row.rowNumber, '证据类型', evidenceType, 'evidenceType');
    validateCarbonEmissionReportTextField(issues, '证据说明', row.rowNumber, '证据说明', evidenceDescription, 'evidenceDescription');
    validateCarbonEmissionReportTextField(issues, '证据说明', row.rowNumber, '备注', note, 'note', false);
    const evidenceCodeKey = buildValidatedCarbonEmissionReportCodeKey(
      issues, '证据说明', row.rowNumber, '证据编号', evidenceCode, 'evidenceCode'
    );
    if (evidenceCodeKey) codeCounts.set(evidenceCodeKey, (codeCounts.get(evidenceCodeKey) || 0) + 1);
    return { rowNumber: row.rowNumber, evidenceCode: evidenceCode || null, evidenceCodeKey: evidenceCodeKey || null, evidenceName: evidenceName || null, evidenceType: evidenceType || null, evidenceDescription: evidenceDescription || null, note: note || null };
  });
  result.forEach((row) => {
    if (row.evidenceCodeKey && codeCounts.get(row.evidenceCodeKey) > 1) {
      pushCarbonEmissionReportIssue(issues, '证据说明', row.rowNumber, '证据编号', row.evidenceCode,
        'CARBON_EMISSION_REPORT_EVIDENCE_CODE_DUPLICATED', '同一报告内证据编号规范化后重复。');
    }
  });
  return result;
}

/** 解析和校验报告项目，并冻结范围、活动、因子、排放和证据引用。 */
function normalizeCarbonEmissionReportItems(rows, evidenceRows, issues) {
  const evidenceKeys = new Set(evidenceRows.map((row) => row.evidenceCodeKey).filter(Boolean));
  const codeCounts = new Map();
  const result = rows.map((row) => {
    const [itemCode, rawScope, category, emissionSource, rawActivityValue, activityUnit,
      rawFactorValue, factorUnit, rawEmissionValue, co2eUnit, evidenceCode, note] = row.values;
    validateCarbonEmissionReportTextField(issues, '报告项目', row.rowNumber, '项目编码', itemCode, 'itemCode');
    validateCarbonEmissionReportTextField(issues, '报告项目', row.rowNumber, '类别', category, 'category');
    validateCarbonEmissionReportTextField(issues, '报告项目', row.rowNumber, '排放源或能源类型', emissionSource, 'emissionSource');
    validateCarbonEmissionReportTextField(issues, '报告项目', row.rowNumber, '活动量单位', activityUnit, 'activityUnit');
    validateCarbonEmissionReportTextField(issues, '报告项目', row.rowNumber, '因子单位', factorUnit, 'factorUnit');
    validateCarbonEmissionReportTextField(issues, '报告项目', row.rowNumber, 'CO2e单位', co2eUnit, 'co2eUnit');
    validateCarbonEmissionReportTextField(issues, '报告项目', row.rowNumber, '证据编号', evidenceCode, 'evidenceCode');
    validateCarbonEmissionReportTextField(issues, '报告项目', row.rowNumber, '备注', note, 'note', false);
    const itemCodeKey = buildValidatedCarbonEmissionReportCodeKey(
      issues, '报告项目', row.rowNumber, '项目编码', itemCode, 'itemCode'
    );
    if (itemCodeKey) codeCounts.set(itemCodeKey, (codeCounts.get(itemCodeKey) || 0) + 1);
    const emissionScope = normalizeCarbonEmissionReportScope(rawScope);
    if (!emissionScope) pushCarbonEmissionReportIssue(issues, '报告项目', row.rowNumber, '排放范围', rawScope, 'CARBON_EMISSION_REPORT_SCOPE_INVALID', '排放范围仅支持范围一、范围二、范围三或 scope_1、scope_2、scope_3。');
    const activityValue = normalizeCarbonEmissionReportNonNegativeNumber(rawActivityValue);
    if (activityValue === null) pushCarbonEmissionReportIssue(issues, '报告项目', row.rowNumber, '活动量', rawActivityValue, 'CARBON_EMISSION_REPORT_ACTIVITY_VALUE_INVALID', '活动量必须有限、非负且不超过 1e15。');
    const factorValue = normalizeCarbonEmissionReportPositiveNumber(rawFactorValue);
    if (factorValue === null) pushCarbonEmissionReportIssue(issues, '报告项目', row.rowNumber, '排放因子', rawFactorValue, 'CARBON_EMISSION_REPORT_FACTOR_VALUE_INVALID', '排放因子必须有限、大于零且不超过 1e15。');
    const emissionValue = normalizeCarbonEmissionReportNonNegativeNumber(rawEmissionValue);
    if (emissionValue === null) pushCarbonEmissionReportIssue(issues, '报告项目', row.rowNumber, '排放量', rawEmissionValue, 'CARBON_EMISSION_REPORT_EMISSION_VALUE_INVALID', '排放量必须有限、非负且不超过 1e15。');
    const evidenceCodeKey = buildValidatedCarbonEmissionReportCodeKey(
      issues, '报告项目', row.rowNumber, '证据编号', evidenceCode, 'evidenceCode'
    );
    if (evidenceCodeKey && !evidenceKeys.has(evidenceCodeKey)) {
      pushCarbonEmissionReportIssue(issues, '报告项目', row.rowNumber, '证据编号', evidenceCode, 'CARBON_EMISSION_REPORT_EVIDENCE_NOT_FOUND', '报告项目引用的证据编号必须存在于证据说明工作表。');
    }
    return {
      rowNumber: row.rowNumber,
      itemCode: itemCode || null,
      itemCodeKey: itemCodeKey || null,
      emissionScope,
      category: category || null,
      emissionSource: emissionSource || null,
      activityValue,
      activityUnit: activityUnit || null,
      factorValue,
      factorUnit: factorUnit || null,
      emissionValue,
      co2eUnit: co2eUnit || null,
      evidenceCode: evidenceCode || null,
      evidenceCodeKey: evidenceCodeKey || null,
      note: note || null
    };
  });
  result.forEach((row) => {
    if (row.itemCodeKey && codeCounts.get(row.itemCodeKey) > 1) {
      pushCarbonEmissionReportIssue(issues, '报告项目', row.rowNumber, '项目编码', row.itemCode,
        'CARBON_EMISSION_REPORT_ITEM_CODE_DUPLICATED', '同一报告内项目编码规范化后重复。');
    }
  });
  return result;
}

/** 按报告项目计算总计、范围和类别汇总，供文件汇总一致性校验。 */
function buildCarbonEmissionReportExpectedSummaries(items) {
  const expected = new Map();
  const total = items.reduce((sum, row) => sum + Number(row.emissionValue || 0), 0);
  expected.set('total\0全部', total);
  items.forEach((row) => {
    const scopeKey = `scope\0${row.emissionScope}`;
    expected.set(scopeKey, (expected.get(scopeKey) || 0) + Number(row.emissionValue || 0));
    const categoryKey = `category\0${buildCarbonEmissionReportNormalizationKey(row.category)}`;
    expected.set(categoryKey, (expected.get(categoryKey) || 0) + Number(row.emissionValue || 0));
  });
  return expected;
}

/** 解析和校验汇总工作表，要求唯一总计且所有提交汇总与项目事实一致。 */
function normalizeCarbonEmissionReportSummaries(rows, items, issues) {
  const expected = buildCarbonEmissionReportExpectedSummaries(items);
  const codeCounts = new Map();
  const semanticCounts = new Map();
  const result = rows.map((row) => {
    const [summaryCode, rawDimension, summaryValue, rawEmissionValue, co2eUnit, note] = row.values;
    validateCarbonEmissionReportTextField(issues, '汇总', row.rowNumber, '汇总编码', summaryCode, 'summaryCode');
    validateCarbonEmissionReportTextField(issues, '汇总', row.rowNumber, '汇总值', summaryValue, 'summaryValue');
    validateCarbonEmissionReportTextField(issues, '汇总', row.rowNumber, 'CO2e单位', co2eUnit, 'co2eUnit');
    validateCarbonEmissionReportTextField(issues, '汇总', row.rowNumber, '备注', note, 'note', false);
    const summaryCodeKey = buildValidatedCarbonEmissionReportCodeKey(
      issues, '汇总', row.rowNumber, '汇总编码', summaryCode, 'summaryCode'
    );
    if (summaryCodeKey) codeCounts.set(summaryCodeKey, (codeCounts.get(summaryCodeKey) || 0) + 1);
    const summaryDimension = normalizeCarbonEmissionReportSummaryDimension(rawDimension);
    if (!summaryDimension) pushCarbonEmissionReportIssue(issues, '汇总', row.rowNumber, '汇总维度', rawDimension, 'CARBON_EMISSION_REPORT_SUMMARY_DIMENSION_INVALID', '汇总维度仅支持总计、排放范围或类别。');
    let normalizedSummaryValue = summaryValue;
    if (summaryDimension === 'total') normalizedSummaryValue = summaryValue === '全部' ? '全部' : summaryValue;
    if (summaryDimension === 'scope') normalizedSummaryValue = normalizeCarbonEmissionReportScope(summaryValue);
    if (summaryDimension === 'scope' && !normalizedSummaryValue) pushCarbonEmissionReportIssue(issues, '汇总', row.rowNumber, '汇总值', summaryValue, 'CARBON_EMISSION_REPORT_SUMMARY_SCOPE_INVALID', '排放范围汇总值必须是有效范围。');
    const semanticValue = summaryDimension === 'category'
      ? buildCarbonEmissionReportNormalizationKey(normalizedSummaryValue)
      : normalizedSummaryValue;
    const semanticKey = summaryDimension ? `${summaryDimension}\0${semanticValue}` : '';
    if (semanticKey) semanticCounts.set(semanticKey, (semanticCounts.get(semanticKey) || 0) + 1);
    const emissionValue = normalizeCarbonEmissionReportNonNegativeNumber(rawEmissionValue);
    if (emissionValue === null) pushCarbonEmissionReportIssue(issues, '汇总', row.rowNumber, '排放量', rawEmissionValue, 'CARBON_EMISSION_REPORT_SUMMARY_VALUE_INVALID', '汇总排放量必须有限、非负且不超过 1e15。');
    if (summaryDimension === 'total' && summaryValue !== '全部') {
      pushCarbonEmissionReportIssue(issues, '汇总', row.rowNumber, '汇总值', summaryValue, 'CARBON_EMISSION_REPORT_TOTAL_VALUE_INVALID', '总计汇总值必须固定为“全部”。');
    }
    if (semanticKey && emissionValue !== null) {
      if (!expected.has(semanticKey)) {
        pushCarbonEmissionReportIssue(issues, '汇总', row.rowNumber, '汇总值', summaryValue, 'CARBON_EMISSION_REPORT_SUMMARY_ORPHANED', '汇总值在报告项目中没有对应事实。');
      } else if (!carbonEmissionReportNumbersEqual(emissionValue, expected.get(semanticKey))) {
        pushCarbonEmissionReportIssue(issues, '汇总', row.rowNumber, '排放量', rawEmissionValue, 'CARBON_EMISSION_REPORT_SUMMARY_MISMATCH', '汇总排放量与报告项目排放量之和不一致。');
      }
    }
    return { rowNumber: row.rowNumber, summaryCode: summaryCode || null, summaryCodeKey: summaryCodeKey || null, summaryDimension, summaryValue: normalizedSummaryValue || null, emissionValue, co2eUnit: co2eUnit || null, note: note || null };
  });
  result.forEach((row) => {
    if (row.summaryCodeKey && codeCounts.get(row.summaryCodeKey) > 1) pushCarbonEmissionReportIssue(issues, '汇总', row.rowNumber, '汇总编码', row.summaryCode, 'CARBON_EMISSION_REPORT_SUMMARY_CODE_DUPLICATED', '同一报告内汇总编码规范化后重复。');
    const semanticValue = row.summaryDimension === 'category' ? buildCarbonEmissionReportNormalizationKey(row.summaryValue) : row.summaryValue;
    const semanticKey = row.summaryDimension ? `${row.summaryDimension}\0${semanticValue}` : '';
    if (semanticKey && semanticCounts.get(semanticKey) > 1) pushCarbonEmissionReportIssue(issues, '汇总', row.rowNumber, '汇总维度,汇总值', `${row.summaryDimension}|${row.summaryValue}`, 'CARBON_EMISSION_REPORT_SUMMARY_DUPLICATED', '同一汇总维度和值只能出现一次。');
  });
  if (result.filter((row) => row.summaryDimension === 'total' && row.summaryValue === '全部').length !== 1) {
    pushCarbonEmissionReportIssue(issues, '汇总', 2, '汇总维度,汇总值', '总计|全部', 'CARBON_EMISSION_REPORT_TOTAL_SUMMARY_REQUIRED', '每份报告必须有且仅有一行“总计/全部”汇总。');
  }
  return result;
}

/** 校验报告项目和汇总的 CO2e 单位全报告一致。 */
function validateCarbonEmissionReportUnits(items, summaries, issues) {
  const unitKeys = new Set([...items, ...summaries]
    .map((row) => buildCarbonEmissionReportNormalizationKey(row.co2eUnit))
    .filter(Boolean));
  if (unitKeys.size > 1) {
    pushCarbonEmissionReportIssue(issues, '报告项目', 2, 'CO2e单位', [...unitKeys].join('|'),
      'CARBON_EMISSION_REPORT_CO2E_UNIT_MISMATCH', '报告项目和汇总必须使用同一个 CO2e 单位。');
  }
}

/** 使用当前数据库状态重算整份碳排放报告原子候选。 */
function buildCarbonEmissionReportImportPreview({ db, buffer, originalFilename }) {
  const workbook = parseCarbonEmissionReportWorkbook(buffer, originalFilename);
  const issues = [];
  const report = normalizeCarbonEmissionReportInfo(workbook.report[0], issues);
  const boundaries = normalizeCarbonEmissionReportBoundaries(workbook.boundaries, issues);
  const evidence = normalizeCarbonEmissionReportEvidence(workbook.evidence, issues);
  const items = normalizeCarbonEmissionReportItems(workbook.items, evidence, issues);
  const summaries = normalizeCarbonEmissionReportSummaries(workbook.summaries, items, issues);
  validateCarbonEmissionReportUnits(items, summaries, issues);
  if (report.reportCodeKey) {
    const existing = db.prepare('SELECT id FROM carbon_emission_reports WHERE report_code_key = ?').get(report.reportCodeKey);
    if (existing) pushCarbonEmissionReportIssue(issues, '报告信息', report.rowNumber, '报告编码', report.reportCode, 'CARBON_EMISSION_REPORT_CODE_EXISTS', '报告编码已存在，禁止跳过、覆盖或复用。');
  }
  if (issues.length > CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxIssues) {
    throw new AppError('CARBON_EMISSION_REPORT_IMPORT_ISSUE_LIMIT_EXCEEDED', '碳排放报告预演问题数量超过限制。', {
      statusCode: 413,
      details: { code: 'CARBON_EMISSION_REPORT_IMPORT_ISSUE_LIMIT_EXCEEDED', maxIssues: CARBON_EMISSION_REPORT_RESOURCE_LIMITS.maxIssues }
    });
  }
  const status = issues.length > 0 ? 'blocked' : 'wouldImport';
  const previewItem = {
    candidateRowId: `carbon-emission-report:${report.reportCodeKey || report.rowNumber}`,
    rowNumber: report.rowNumber,
    reportCode: report.reportCode,
    reportName: report.reportName,
    status,
    counts: { boundaries: boundaries.length, items: items.length, summaries: summaries.length, evidence: evidence.length },
    issues
  };
  const candidateRows = status === 'wouldImport' ? [{
    candidateRowId: previewItem.candidateRowId,
    rowNumber: report.rowNumber,
    report,
    boundaries,
    items,
    summaries,
    evidence
  }] : [];
  return {
    fieldMapping: Object.fromEntries(CARBON_EMISSION_REPORT_SHEETS.flatMap((sheet) => (
      sheet.headers.map((header) => [`${sheet.name}.${header}`, `${sheet.name}.${header}`])
    ))),
    summary: buildImportSummary([previewItem]),
    candidateRows,
    items: [previewItem],
    auditIssues: issues,
    notices: [
      '预演只持久化统一导入审计、原文件摘要、签名和服务端候选见证，不写碳排放报告事实。',
      'execute 由服务端重读原文件、重算候选并在 BEGIN IMMEDIATE 锁内再次校验，随后锁内备份和原子写入五张报告表。',
      '导入不创建、修改或回填碳活动、核算运行、核算结果、旧 carbon_emissions 或任何碳因子；重复报告编码确定性阻断。'
    ]
  };
}

/** 在报告导入 preview/execute 事务中写入稳定操作审计。 */
function insertCarbonEmissionReportOperationLog(db, actor = {}, operation, targetId, detail = {}) {
  db.prepare(`INSERT INTO sys_operation_logs
    (user_id, operation, target_type, target_id, detail_json, ip, created_at)
    VALUES (?, ?, 'carbon_emission_report', ?, ?, ?, ?)`).run(
    actor.userId || null,
    operation,
    targetId === null ? null : String(targetId),
    JSON.stringify(detail || {}),
    actor.ip || null,
    new Date().toISOString()
  );
}

/** 在同一业务事务中原子写入报告主表、边界、证据、项目和汇总。 */
function insertCarbonEmissionReportImportCandidates({ db, batchId, candidateRows, options = {} }) {
  if (!Array.isArray(candidateRows) || candidateRows.length !== 1) {
    throw badRequest('碳排放报告导入每个批次必须且只能包含一份原子报告候选。', {
      code: 'CARBON_EMISSION_REPORT_CANDIDATE_COUNT_INVALID'
    });
  }
  const candidate = candidateRows[0];
  const now = new Date().toISOString();
  const report = candidate.report;
  if (db.prepare('SELECT id FROM carbon_emission_reports WHERE report_code_key = ?').get(report.reportCodeKey)) {
    throw badRequest('报告编码已被其他导入写入，请重新预演。', {
      code: 'CARBON_EMISSION_REPORT_CODE_STALE'
    });
  }
  const reportResult = db.prepare(`INSERT INTO carbon_emission_reports
    (report_code, report_code_key, report_name, report_organization, period_start, period_end,
     template_id, template_version, note, source_batch_id, source_row_number, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    report.reportCode, report.reportCodeKey, report.reportName, report.reportOrganization,
    report.periodStart, report.periodEnd, report.templateId, report.templateVersion, report.note,
    batchId, report.rowNumber, options.actor?.userId || null, now
  );
  const reportId = Number(reportResult.lastInsertRowid);
  const evidenceIdByKey = new Map();
  const insertEvidence = db.prepare(`INSERT INTO carbon_emission_report_evidence
    (report_id, evidence_code, evidence_code_key, evidence_name, evidence_type,
     evidence_description, note, source_row_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  candidate.evidence.forEach((row) => {
    const result = insertEvidence.run(reportId, row.evidenceCode, row.evidenceCodeKey, row.evidenceName,
      row.evidenceType, row.evidenceDescription, row.note, row.rowNumber);
    evidenceIdByKey.set(row.evidenceCodeKey, Number(result.lastInsertRowid));
  });
  const insertBoundary = db.prepare(`INSERT INTO carbon_emission_report_boundaries
    (report_id, boundary_type, boundary_name, boundary_description, source_row_number)
    VALUES (?, ?, ?, ?, ?)`);
  candidate.boundaries.forEach((row) => insertBoundary.run(reportId, row.boundaryType, row.boundaryName, row.boundaryDescription, row.rowNumber));
  const insertItem = db.prepare(`INSERT INTO carbon_emission_report_items
    (report_id, item_code, item_code_key, emission_scope, category, emission_source,
     activity_value, activity_unit, factor_value, factor_unit, emission_value, co2e_unit,
     evidence_id, note, source_row_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  candidate.items.forEach((row) => insertItem.run(
    reportId, row.itemCode, row.itemCodeKey, row.emissionScope, row.category, row.emissionSource,
    row.activityValue, row.activityUnit, row.factorValue, row.factorUnit, row.emissionValue,
    row.co2eUnit, evidenceIdByKey.get(row.evidenceCodeKey), row.note, row.rowNumber
  ));
  const insertSummary = db.prepare(`INSERT INTO carbon_emission_report_summaries
    (report_id, summary_code, summary_code_key, summary_dimension, summary_value,
     emission_value, co2e_unit, note, source_row_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  candidate.summaries.forEach((row) => insertSummary.run(
    reportId, row.summaryCode, row.summaryCodeKey, row.summaryDimension, row.summaryValue,
    row.emissionValue, row.co2eUnit, row.note, row.rowNumber
  ));
  insertCarbonEmissionReportOperationLog(db, options.actor || {}, 'carbon.emission-report.import.execute', reportId, {
    reportId,
    reportCode: report.reportCode,
    batchId,
    counts: { boundaries: candidate.boundaries.length, items: candidate.items.length, summaries: candidate.summaries.length, evidence: candidate.evidence.length }
  });
  return {
    imported: 1,
    importedIds: [reportId],
    importedItems: [{ reportId, reportCode: report.reportCode, rowNumber: report.rowNumber }]
  };
}

/** 将取得服务端 SHA 后的解析或安全失败投影为稳定脱敏的 failed preview 审计。 */
function buildCarbonEmissionReportPreviewFailure({ error }) {
  const sourceCode = String(error?.details?.code || error?.code || '');
  const code = /^CARBON_EMISSION_REPORT_[A-Z0-9_]+$/.test(sourceCode)
    ? sourceCode
    : 'CARBON_EMISSION_REPORT_IMPORT_PREVIEW_FAILED';
  const message = Number(error?.statusCode || 400) === 413
    ? '碳排放报告文件超过固定模板安全资源限制。'
    : (code === 'CARBON_EMISSION_REPORT_IMPORT_FORMULA_CELL_REJECTED'
      ? '碳排放报告固定模板不允许公式单元格。'
      : '碳排放报告文件未通过固定模板或安全校验。');
  const issue = createImportIssue({
    rowNumber: 1,
    fieldName: '工作簿.文件',
    rawValue: null,
    code,
    message,
    severity: 'error'
  });
  const item = {
    candidateRowId: 'carbon-emission-report:failed-preview',
    rowNumber: 1,
    status: 'blocked',
    issues: [issue]
  };
  return {
    fieldMapping: {},
    summary: buildImportSummary([item]),
    candidateRows: [],
    items: [item],
    auditIssues: [issue],
    notices: [
      '服务端取得原文件 SHA-256 后发生的解析或安全失败会原子保存 failed 批次、脱敏问题和预演操作审计。',
      '失败批次已引用的原文件保留用于受控追溯；若审计事务失败，批次和问题回滚且路由仅清理未被批次引用的文件。',
      '解析失败不写碳排放报告五表，也不写碳活动、核算运行、核算结果、旧 carbon_emissions 或任何碳因子。'
    ]
  };
}

/** 在共享 preview 事务中持久化报告领域操作审计。 */
function persistCarbonEmissionReportPreviewAudit({ db, batch, preview, safeFile, options = {} }) {
  insertCarbonEmissionReportOperationLog(db, options.actor || {}, 'carbon.emission-report.import.preview', batch.id, {
    batchId: batch.id,
    fileSha256: safeFile.fileSha256,
    summary: preview.summary
  });
}

// 描述器将五表解析、preview 审计和锁内原子写入接入共享受控导入安全链。
const CARBON_EMISSION_REPORT_IMPORT_DESCRIPTOR = Object.freeze({
  templateType: CARBON_EMISSION_REPORT_TEMPLATE_TYPE,
  domainName: '碳排放报告',
  buildPreview: buildCarbonEmissionReportImportPreview,
  persistBuildPreviewFailures: true,
  buildPreviewFailure: buildCarbonEmissionReportPreviewFailure,
  persistPreviewAudit: persistCarbonEmissionReportPreviewAudit,
  insertCandidates: insertCarbonEmissionReportImportCandidates
});

/** 创建碳排放报告受控预演。 */
function previewCarbonEmissionReportImport(file, options = {}) {
  return createEnergyAnalysisSingleBatchPreview(file, CARBON_EMISSION_REPORT_IMPORT_DESCRIPTOR, options);
}

/** 执行碳排放报告受控导入。 */
async function executeCarbonEmissionReportImport(body = {}, options = {}) {
  return executeEnergyAnalysisSingleBatchImport(body, CARBON_EMISSION_REPORT_IMPORT_DESCRIPTOR, options);
}

module.exports = {
  CARBON_EMISSION_REPORT_IMPORT_CONFIRM_TEXT,
  CARBON_EMISSION_REPORT_IMPORT_DESCRIPTOR,
  buildCarbonEmissionReportImportPreview,
  buildCarbonEmissionReportPreviewFailure,
  carbonEmissionReportNumbersEqual,
  executeCarbonEmissionReportImport,
  insertCarbonEmissionReportImportCandidates,
  parseCarbonEmissionReportWorkbook,
  previewCarbonEmissionReportImport,
  validateCarbonEmissionReportXlsxArchive
};
