const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const XLSX = require('xlsx');
const { backupsDir, databasePath, openDatabase } = require('../db/database');
const { AppError, badRequest, notFound } = require('../utils/errors');
const { decodeUploadOriginalName } = require('../utils/filenameEncoding');
const { createBackup } = require('./backupService');
const { assertSupportedImportFile, parseImportFile } = require('./import/parser');
const { normalizeMonth, normalizeUnitAndValue } = require('./import/normalization');
const { normalizePagination } = require('./ledgerService');
const { insertOperationLogWithDb } = require('./energyStrategyEvaluationService');

const READING_STATUSES = Object.freeze(['active', 'void']);
const READING_DATA_SOURCES = Object.freeze(['manual', 'upload', 'calculation']);
const METER_READING_IMPORT_TYPE = 'meter_reading';
const UTF8_BOM = '﻿';
const MAX_METER_READING_EXPORT_ROWS = 5000;
const METER_READING_GENERATION_CONFIRM_TEXT = '确认由抄表生成能耗记录';
const METER_READING_GENERATION_SIGNATURE_VERSION = 'meter-reading-energy-record-generation-preview:v1';
const METER_READING_GENERATION_BACKUP_REASON = 'meter-reading-energy-record-generation';
const METER_READING_GENERATION_EXPORT_FIELDS = Object.freeze([
  { key: 'readingId', header: '抄表记录ID' },
  { key: 'meterCode', header: '仪表编码' },
  { key: 'meterName', header: '仪表名称' },
  { key: 'organizationUnitPath', header: '用能单元' },
  { key: 'energyTypeCode', header: '能源类型编码' },
  { key: 'energyTypeName', header: '能源类型名称' },
  { key: 'readingDate', header: '抄表日期' },
  { key: 'normalizedMonth', header: '月份' },
  { key: 'usageValue', header: '原始用量' },
  { key: 'originalUnit', header: '原始单位' },
  { key: 'normalizedUsageValue', header: '标准化用量' },
  { key: 'normalizedUnit', header: '标准单位' },
  { key: 'status', header: '预演状态' },
  { key: 'wouldGenerate', header: '是否可生成' },
  { key: 'reasonCodes', header: '原因编码' },
  { key: 'reasons', header: '原因说明' },
  { key: 'existingGeneratedEnergyRecordId', header: '已有生成能耗记录ID' },
  { key: 'conflictEnergyRecordId', header: '冲突能耗记录ID' },
  { key: 'duplicateKey', header: '拟生成重复键' }
]);
const EXPORT_FIELDS = Object.freeze([
  { key: 'meterCode', header: '仪表编码' },
  { key: 'meterName', header: '仪表名称' },
  { key: 'organizationUnitPath', header: '用能单元' },
  { key: 'energyTypeCode', header: '能源类型编码' },
  { key: 'energyTypeName', header: '能源类型' },
  { key: 'readingDate', header: '抄表日期' },
  { key: 'previousValue', header: '上期表码' },
  { key: 'currentValue', header: '本期表码' },
  { key: 'multiplier', header: '倍率' },
  { key: 'usageValue', header: '用量' },
  { key: 'originalUnit', header: '单位' },
  { key: 'normalizedUsageValue', header: '标准化用量' },
  { key: 'normalizedUnit', header: '标准单位' },
  { key: 'recordStatus', header: '状态' },
  { key: 'remark', header: '备注' },
  { key: 'sourceBatchId', header: '导入批次' }
]);
const IMPORT_ALIASES = {
  readingDate: ['reading_date', 'readingDate', '抄表日期', '读数日期', '日期', 'date'],
  meterCode: ['meter_code', 'meterCode', '仪表编码', '表计编号', '计量器具编码'],
  meterName: ['meter_name', 'meterName', '仪表名称', '表计名称', '计量器具名称', '仪表', '表计'],
  previousValue: ['previous_value', 'previousValue', '上期表码', '上次表码', '起始表码', '期初表码'],
  currentValue: ['current_value', 'currentValue', '本期表码', '本次表码', '当前表码', '期末表码'],
  multiplier: ['multiplier', '倍率', '倍乘率', '变比'],
  usageValue: ['usage_value', 'usageValue', '能耗用量', '用量', 'usage'],
  unit: ['unit', '单位', '计量单位'],
  organizationUnit: ['organization_unit', 'organizationUnit', '用能单元', '组织单元', '组织', '部门', '车间'],
  remark: ['remark', '备注', '说明', 'note']
};

function getNow() {
  return new Date().toISOString();
}

function normalizeText(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const text = String(value).trim();
  return text === '' ? null : text;
}

function firstDefined(source, keys) {
  for (const key of keys) {
    if (source && source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }
  return undefined;
}

function assertWhitelist(value, fieldName, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw badRequest(`${fieldName} 不在允许范围内。`, {
      code: 'UNSUPPORTED_METER_READING_VALUE',
      fieldName,
      rawValue: value,
      allowedValues
    });
  }
}

function parsePositiveInteger(value, fieldName, options = {}) {
  const text = normalizeText(value);
  if (!text) {
    return options.required ? null : undefined;
  }
  if (!/^\d+$/.test(text)) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_POSITIVE_INTEGER', fieldName, rawValue: text });
  }
  const numberValue = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw badRequest(`${fieldName} 必须是正整数。`, { code: 'INVALID_POSITIVE_INTEGER', fieldName, rawValue: text });
  }
  return numberValue;
}

function parseNumber(value, fieldName, options = {}) {
  const text = normalizeText(value);
  if (!text) {
    if (options.required) {
      throw badRequest(`${fieldName} 为必填项。`, { code: 'REQUIRED_FIELD_MISSING', fieldName });
    }
    return null;
  }
  const numberValue = Number(text.replace ? text.replace(/,/g, '') : text);
  if (!Number.isFinite(numberValue)) {
    throw badRequest(`${fieldName} 必须是数字。`, { code: 'INVALID_NUMBER', fieldName, rawValue: text });
  }
  if (options.positive && numberValue <= 0) {
    throw badRequest(`${fieldName} 必须是大于 0 的数字。`, { code: 'INVALID_POSITIVE_NUMBER', fieldName, rawValue: text });
  }
  if (options.nonNegative && numberValue < 0) {
    throw badRequest(`${fieldName} 必须是大于等于 0 的数字。`, { code: 'INVALID_NON_NEGATIVE_NUMBER', fieldName, rawValue: text });
  }
  return numberValue;
}

function normalizeDatePart(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeReadingDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return normalizeDatePart(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }
  const text = normalizeText(value);
  if (!text) {
    throw badRequest('readingDate 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'readingDate' });
  }
  const matched = text.match(/^(\d{4})\s*[年\-/.]\s*(\d{1,2})(?:\s*月)?\s*[\-/.]?\s*(\d{1,2})(?:\s*日)?(?:[ T].*)?$/);
  if (matched) {
    const normalized = normalizeDatePart(Number(matched[1]), Number(matched[2]), Number(matched[3]));
    if (normalized) return normalized;
    throw badRequest('readingDate 必须是有效日期。', { code: 'INVALID_READING_DATE', fieldName: 'readingDate', rawValue: text });
  }
  const parsedDate = new Date(text);
  if (!Number.isNaN(parsedDate.getTime())) {
    const normalized = normalizeDatePart(parsedDate.getFullYear(), parsedDate.getMonth() + 1, parsedDate.getDate());
    if (normalized) return normalized;
  }
  throw badRequest('readingDate 必须是可识别的日期。', { code: 'INVALID_READING_DATE', fieldName: 'readingDate', rawValue: text });
}

function calculateUsageValue(previousValue, currentValue, multiplier, usageValue) {
  if (currentValue < previousValue) {
    throw badRequest('currentValue 必须大于等于 previousValue。', { code: 'INVALID_READING_RANGE', fieldName: 'currentValue', previousValue, currentValue });
  }
  if (multiplier <= 0) {
    throw badRequest('multiplier 必须是大于 0 的数字。', { code: 'INVALID_POSITIVE_NUMBER', fieldName: 'multiplier', rawValue: multiplier });
  }
  if (usageValue !== null && usageValue !== undefined) {
    if (usageValue < 0) {
      throw badRequest('usageValue 必须是大于等于 0 的数字。', { code: 'INVALID_NON_NEGATIVE_NUMBER', fieldName: 'usageValue', rawValue: usageValue });
    }
    return usageValue;
  }
  return Number(((currentValue - previousValue) * multiplier).toFixed(6));
}

function normalizeReadingUnit(energyTypeCode, originalUnit, usageValue) {
  const unit = normalizeText(originalUnit);
  if (!unit) {
    throw badRequest('originalUnit 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'originalUnit' });
  }
  const normalized = normalizeUnitAndValue(energyTypeCode, unit, usageValue);
  if (!normalized) {
    throw badRequest('单位不合法或不能换算为该仪表能源类型的标准单位。', { code: 'UNSUPPORTED_METER_READING_UNIT', fieldName: 'originalUnit', energyTypeCode, rawValue: unit });
  }
  return { originalUnit: unit, normalizedUnit: normalized.normalizedUnit, normalizedUsageValue: normalized.normalizedValue };
}

function buildMeterReadingPayload(input = {}, meter = null) {
  const meterDeviceId = parsePositiveInteger(firstDefined(input, ['meterDeviceId', 'meter_device_id', 'meterId', 'meter_id']), 'meterDeviceId', { required: true });
  if (!meterDeviceId) {
    throw badRequest('meterDeviceId 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'meterDeviceId' });
  }
  const readingDate = normalizeReadingDate(firstDefined(input, ['readingDate', 'reading_date']));
  const normalizedMonth = normalizeMonth(readingDate);
  const previousValue = parseNumber(firstDefined(input, ['previousValue', 'previous_value']), 'previousValue', { required: true, nonNegative: true });
  const currentValue = parseNumber(firstDefined(input, ['currentValue', 'current_value']), 'currentValue', { required: true, nonNegative: true });
  const multiplier = parseNumber(firstDefined(input, ['multiplier']), 'multiplier', { positive: true }) || Number(meter?.multiplier || 1);
  const providedUsageValue = parseNumber(firstDefined(input, ['usageValue', 'usage_value']), 'usageValue', { nonNegative: true });
  const usageValue = calculateUsageValue(previousValue, currentValue, multiplier, providedUsageValue);
  const energyTypeCode = meter?.energyTypeCode || normalizeText(firstDefined(input, ['energyTypeCode', 'energy_type_code']));
  const unitInfo = normalizeReadingUnit(energyTypeCode, firstDefined(input, ['originalUnit', 'original_unit', 'unit']), usageValue);
  const dataSource = normalizeText(firstDefined(input, ['dataSource', 'data_source'])) || 'manual';
  const recordStatus = normalizeText(firstDefined(input, ['recordStatus', 'record_status'])) || 'active';
  assertWhitelist(dataSource, 'dataSource', READING_DATA_SOURCES);
  assertWhitelist(recordStatus, 'recordStatus', READING_STATUSES);
  const organizationUnitId = parsePositiveInteger(firstDefined(input, ['organizationUnitId', 'organization_unit_id']), 'organizationUnitId') || Number(meter?.organizationUnitId || 0);
  return {
    meterDeviceId,
    organizationUnitId,
    energyTypeId: Number(meter?.energyTypeId || 0),
    readingDate,
    normalizedMonth,
    previousValue,
    currentValue,
    multiplier,
    usageValue,
    ...unitInfo,
    dataSource,
    recordStatus,
    remark: normalizeText(input.remark),
    sourceBatchId: parsePositiveInteger(firstDefined(input, ['sourceBatchId', 'source_batch_id']), 'sourceBatchId') || null,
    generatedEnergyRecordId: parsePositiveInteger(firstDefined(input, ['generatedEnergyRecordId', 'generated_energy_record_id']), 'generatedEnergyRecordId') || null
  };
}

function getActiveMeterForReading(db, meterDeviceId) {
  const row = db.prepare(
    `SELECT md.id, md.meter_code AS meterCode, md.meter_name AS meterName, md.energy_type_id AS energyTypeId,
            et.code AS energyTypeCode, et.name AS energyTypeName, md.organization_unit_id AS organizationUnitId,
            ou.unit_name AS organizationUnitName, ou.unit_path AS organizationUnitPath, md.multiplier,
            md.allow_manual_reading AS allowManualReading, md.status
     FROM meter_devices md
     JOIN energy_types et ON et.id = md.energy_type_id AND et.is_active = 1
     LEFT JOIN organization_units ou ON ou.id = md.organization_unit_id
     WHERE md.id = ?`
  ).get(meterDeviceId);
  if (!row) throw badRequest('计量器具不存在或能源类型未启用。', { code: 'UNKNOWN_METER_DEVICE', meterDeviceId });
  if (row.status !== 'active') throw badRequest('计量器具必须为 active 状态才允许抄表。', { code: 'INACTIVE_METER_DEVICE', meterDeviceId });
  if (Number(row.allowManualReading) !== 1) throw badRequest('该计量器具不允许手工抄表。', { code: 'METER_MANUAL_READING_DISABLED', meterDeviceId });
  return row;
}

function ensureOrganizationMatchesMeter(db, organizationUnitId, meter) {
  if (!organizationUnitId) {
    throw badRequest('organizationUnitId 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'organizationUnitId' });
  }
  if (Number(organizationUnitId) !== Number(meter.organizationUnitId)) {
    throw badRequest('抄表记录所属用能单元必须与计量器具归属一致。', { code: 'METER_READING_ORG_MISMATCH', organizationUnitId, meterOrganizationUnitId: meter.organizationUnitId });
  }
  const unit = db.prepare('SELECT id, status FROM organization_units WHERE id = ?').get(organizationUnitId);
  if (!unit || unit.status !== 'active') {
    throw badRequest('所属用能单元不存在或未启用。', { code: 'INACTIVE_ORGANIZATION_UNIT', organizationUnitId });
  }
}

function buildEmptyEnergyTrace() {
  return {
    strategy: 'none',
    label: '未关联',
    relatedEnergyRecordCount: 0,
    latestEnergyRecord: null,
    note: '未找到同仪表、同月份、同能源类型的 active 能耗记录；抄表记录不会自动生成 energy_records。'
  };
}

function buildMeterReadingEnergyTrace(relatedCount = 0, directCount = 0, latestEnergyRecord = null) {
  const count = Number(relatedCount || 0);
  const directMatches = Number(directCount || 0);
  if (count <= 0) {
    return buildEmptyEnergyTrace();
  }
  if (directMatches > 0) {
    return {
      strategy: 'direct-generated-record',
      label: '已直接关联',
      relatedEnergyRecordCount: count,
      latestEnergyRecord,
      note: '通过 generated_energy_record_id 找到已存在能耗记录；本接口仅展示追溯关系，不生成或回填 energy_records。'
    };
  }
  return {
    strategy: 'suspected-same-meter-month',
    label: '疑似关联（同仪表同月）',
    relatedEnergyRecordCount: count,
    latestEnergyRecord,
    note: '按同一计量器具、同一归属月份、同一能源类型匹配到已存在 active 能耗记录；这是只读疑似追溯，不代表由抄表生成。'
  };
}

function mapLatestEnergyRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    normalizedMonth: row.normalizedMonth,
    energyTypeCode: row.energyTypeCode,
    energyTypeName: row.energyTypeName,
    normalizedValue: row.normalizedValue,
    normalizedUnit: row.normalizedUnit,
    originalValue: row.originalValue,
    originalUnit: row.originalUnit,
    sourceBatchId: row.sourceBatchId,
    createdAt: row.createdAt
  };
}

function loadMeterReadingEnergyTrace(db, reading) {
  if (!reading || !reading.meterDeviceId || !reading.normalizedMonth || !reading.energyTypeId) {
    return buildEmptyEnergyTrace();
  }
  const params = {
    generatedEnergyRecordId: reading.generatedEnergyRecordId || null,
    meterDeviceId: reading.meterDeviceId,
    normalizedMonth: reading.normalizedMonth,
    energyTypeId: reading.energyTypeId
  };
  const whereSql = `er.record_status = 'active' AND (
    er.id = @generatedEnergyRecordId
    OR (er.meter_device_id = @meterDeviceId AND er.normalized_month = @normalizedMonth AND er.energy_type_id = @energyTypeId)
  )`;
  const summary = db.prepare(
    `SELECT COUNT(*) AS relatedCount,
            COALESCE(SUM(CASE WHEN er.id = @generatedEnergyRecordId THEN 1 ELSE 0 END), 0) AS directCount
     FROM energy_records er
     WHERE ${whereSql}`
  ).get(params);
  if (!summary || Number(summary.relatedCount || 0) <= 0) {
    return buildEmptyEnergyTrace();
  }
  const latest = db.prepare(
    `SELECT er.id, er.source_batch_id AS sourceBatchId, et.code AS energyTypeCode, et.name AS energyTypeName,
            er.normalized_month AS normalizedMonth, er.normalized_value AS normalizedValue, er.normalized_unit AS normalizedUnit,
            er.original_value AS originalValue, er.original_unit AS originalUnit, er.created_at AS createdAt
     FROM energy_records er
     JOIN energy_types et ON et.id = er.energy_type_id
     WHERE ${whereSql}
     ORDER BY CASE WHEN er.id = @generatedEnergyRecordId THEN 0 ELSE 1 END, er.created_at DESC, er.id DESC
     LIMIT 1`
  ).get(params);
  return buildMeterReadingEnergyTrace(summary.relatedCount, summary.directCount, mapLatestEnergyRecord(latest));
}

function attachEnergyTraceToMeterReadings(db, rows = []) {
  return rows.map((row) => ({ ...row, energyTrace: loadMeterReadingEnergyTrace(db, row) }));
}

function mapMeterReadingRow(row) {
  if (!row) return row;
  return {
    id: row.id,
    meterDeviceId: row.meterDeviceId,
    meterCode: row.meterCode,
    meterName: row.meterName,
    organizationUnitId: row.organizationUnitId,
    organizationUnitName: row.organizationUnitName,
    organizationUnitPath: row.organizationUnitPath,
    energyTypeId: row.energyTypeId,
    energyTypeCode: row.energyTypeCode,
    energyTypeName: row.energyTypeName,
    readingDate: row.readingDate,
    normalizedMonth: row.normalizedMonth,
    previousValue: row.previousValue,
    currentValue: row.currentValue,
    multiplier: row.multiplier,
    usageValue: row.usageValue,
    originalUnit: row.originalUnit,
    normalizedUnit: row.normalizedUnit,
    normalizedUsageValue: row.normalizedUsageValue,
    dataSource: row.dataSource,
    recordStatus: row.recordStatus,
    remark: row.remark,
    sourceBatchId: row.sourceBatchId,
    generatedEnergyRecordId: row.generatedEnergyRecordId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function buildReadingWhere(query = {}) {
  const where = [];
  const params = {};
  const meterId = parsePositiveInteger(firstDefined(query, ['meterId', 'meterDeviceId', 'meter_device_id']), 'meterId');
  if (meterId) {
    where.push('mrr.meter_device_id = @meterId');
    params.meterId = meterId;
  }
  const organizationUnitId = parsePositiveInteger(firstDefined(query, ['organizationUnitId', 'organization_unit_id']), 'organizationUnitId');
  if (organizationUnitId) {
    where.push('mrr.organization_unit_id = @organizationUnitId');
    params.organizationUnitId = organizationUnitId;
  }
  const energyTypeCode = normalizeText(firstDefined(query, ['energyTypeCode', 'energy_type_code']));
  if (energyTypeCode) {
    where.push('et.code = @energyTypeCode');
    params.energyTypeCode = energyTypeCode;
  }
  const keyword = normalizeText(query.keyword || query.search);
  if (keyword) {
    where.push('(md.meter_code LIKE @keyword OR md.meter_name LIKE @keyword OR ou.unit_path LIKE @keyword OR et.code LIKE @keyword OR et.name LIKE @keyword OR mrr.remark LIKE @keyword)');
    params.keyword = `%${keyword}%`;
  }
  const status = normalizeText(query.status || query.recordStatus);
  if (status) {
    assertWhitelist(status, 'status', READING_STATUSES);
    where.push('mrr.record_status = @status');
    params.status = status;
  }
  const startDate = normalizeText(query.startDate);
  if (startDate) {
    where.push('mrr.reading_date >= @startDate');
    params.startDate = normalizeReadingDate(startDate);
  }
  const endDate = normalizeText(query.endDate);
  if (endDate) {
    where.push('mrr.reading_date <= @endDate');
    params.endDate = normalizeReadingDate(endDate);
  }
  const monthStart = normalizeText(query.monthStart);
  if (monthStart) {
    const normalized = normalizeMonth(monthStart);
    if (!normalized) throw badRequest('monthStart 必须可标准化为 YYYY-MM。', { code: 'INVALID_MONTH', fieldName: 'monthStart', rawValue: monthStart });
    where.push('mrr.normalized_month >= @monthStart');
    params.monthStart = normalized;
  }
  const monthEnd = normalizeText(query.monthEnd);
  if (monthEnd) {
    const normalized = normalizeMonth(monthEnd);
    if (!normalized) throw badRequest('monthEnd 必须可标准化为 YYYY-MM。', { code: 'INVALID_MONTH', fieldName: 'monthEnd', rawValue: monthEnd });
    where.push('mrr.normalized_month <= @monthEnd');
    params.monthEnd = normalized;
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function selectMeterReadingRows(db, query = {}, limit = 500, offset = 0) {
  const { whereSql, params } = buildReadingWhere(query);
  const rows = db.prepare(
    `SELECT mrr.id, mrr.meter_device_id AS meterDeviceId, md.meter_code AS meterCode, md.meter_name AS meterName,
            mrr.organization_unit_id AS organizationUnitId, ou.unit_name AS organizationUnitName, ou.unit_path AS organizationUnitPath,
            mrr.energy_type_id AS energyTypeId, et.code AS energyTypeCode, et.name AS energyTypeName,
            mrr.reading_date AS readingDate, mrr.normalized_month AS normalizedMonth, mrr.previous_value AS previousValue,
            mrr.current_value AS currentValue, mrr.multiplier, mrr.usage_value AS usageValue, mrr.original_unit AS originalUnit,
            mrr.normalized_unit AS normalizedUnit, mrr.normalized_usage_value AS normalizedUsageValue, mrr.data_source AS dataSource,
            mrr.record_status AS recordStatus, mrr.remark, mrr.source_batch_id AS sourceBatchId,
            mrr.generated_energy_record_id AS generatedEnergyRecordId, mrr.created_at AS createdAt, mrr.updated_at AS updatedAt
     FROM meter_reading_records mrr
     JOIN meter_devices md ON md.id = mrr.meter_device_id
     JOIN energy_types et ON et.id = mrr.energy_type_id
     LEFT JOIN organization_units ou ON ou.id = mrr.organization_unit_id
     ${whereSql}
     ORDER BY mrr.reading_date DESC, mrr.id DESC
     LIMIT @limit OFFSET @offset`
  ).all({ ...params, limit, offset }).map(mapMeterReadingRow);
  return attachEnergyTraceToMeterReadings(db, rows);
}

function selectMeterReadingById(db, id) {
  const row = db.prepare(
    `SELECT mrr.id, mrr.meter_device_id AS meterDeviceId, md.meter_code AS meterCode, md.meter_name AS meterName,
            mrr.organization_unit_id AS organizationUnitId, ou.unit_name AS organizationUnitName, ou.unit_path AS organizationUnitPath,
            mrr.energy_type_id AS energyTypeId, et.code AS energyTypeCode, et.name AS energyTypeName,
            mrr.reading_date AS readingDate, mrr.normalized_month AS normalizedMonth, mrr.previous_value AS previousValue,
            mrr.current_value AS currentValue, mrr.multiplier, mrr.usage_value AS usageValue, mrr.original_unit AS originalUnit,
            mrr.normalized_unit AS normalizedUnit, mrr.normalized_usage_value AS normalizedUsageValue, mrr.data_source AS dataSource,
            mrr.record_status AS recordStatus, mrr.remark, mrr.source_batch_id AS sourceBatchId,
            mrr.generated_energy_record_id AS generatedEnergyRecordId, mrr.created_at AS createdAt, mrr.updated_at AS updatedAt
     FROM meter_reading_records mrr
     JOIN meter_devices md ON md.id = mrr.meter_device_id
     JOIN energy_types et ON et.id = mrr.energy_type_id
     LEFT JOIN organization_units ou ON ou.id = mrr.organization_unit_id
     WHERE mrr.id = ?`
  ).get(id);
  if (!row) throw notFound('抄表记录不存在。', { id });
  const mapped = mapMeterReadingRow(row);
  return { ...mapped, energyTrace: loadMeterReadingEnergyTrace(db, mapped) };
}

function listMeterReadings(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { pageSize: 50, maxPageSize: 500 });
  const { whereSql, params } = buildReadingWhere(query);
  const db = openDatabase();
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS total
       FROM meter_reading_records mrr
       JOIN meter_devices md ON md.id = mrr.meter_device_id
       JOIN energy_types et ON et.id = mrr.energy_type_id
       LEFT JOIN organization_units ou ON ou.id = mrr.organization_unit_id
       ${whereSql}`
    ).get(params).total;
    const rows = selectMeterReadingRows(db, query, pageSize, offset);
    return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
  }
}

function insertMeterReadingRecord(db, payload, now = getNow()) {
  return db.prepare(
    `INSERT INTO meter_reading_records (
       meter_device_id, organization_unit_id, energy_type_id, reading_date, normalized_month,
       previous_value, current_value, multiplier, usage_value, original_unit, normalized_unit, normalized_usage_value,
       data_source, record_status, remark, source_batch_id, generated_energy_record_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    payload.meterDeviceId,
    payload.organizationUnitId,
    payload.energyTypeId,
    payload.readingDate,
    payload.normalizedMonth,
    payload.previousValue,
    payload.currentValue,
    payload.multiplier,
    payload.usageValue,
    payload.originalUnit,
    payload.normalizedUnit,
    payload.normalizedUsageValue,
    payload.dataSource,
    payload.recordStatus,
    payload.remark,
    payload.sourceBatchId,
    payload.generatedEnergyRecordId,
    now,
    now
  );
}

function createMeterReading(input = {}) {
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const meterDeviceId = parsePositiveInteger(firstDefined(input, ['meterDeviceId', 'meter_device_id', 'meterId', 'meter_id']), 'meterDeviceId', { required: true });
      const meter = getActiveMeterForReading(db, meterDeviceId);
      const payload = buildMeterReadingPayload(input, meter);
      ensureOrganizationMatchesMeter(db, payload.organizationUnitId, meter);
      const result = insertMeterReadingRecord(db, payload, getNow());
      return selectMeterReadingById(db, result.lastInsertRowid);
    });
    return transaction();
  } finally {
    db.close();
  }
}

function updateMeterReading(readingId, input = {}) {
  const id = parsePositiveInteger(readingId, 'id', { required: true });
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = selectMeterReadingById(db, id);
      const meterDeviceId = parsePositiveInteger(firstDefined(input, ['meterDeviceId', 'meter_device_id', 'meterId', 'meter_id']), 'meterDeviceId', { required: true });
      const meter = getActiveMeterForReading(db, meterDeviceId);
      const payload = buildMeterReadingPayload(input, meter);
      const providedGeneratedEnergyRecordId = normalizeText(firstDefined(input, ['generatedEnergyRecordId', 'generated_energy_record_id']));
      if (!providedGeneratedEnergyRecordId) {
        payload.generatedEnergyRecordId = existing.generatedEnergyRecordId || null;
      }
      ensureOrganizationMatchesMeter(db, payload.organizationUnitId, meter);
      db.prepare(
        `UPDATE meter_reading_records
         SET meter_device_id = ?, organization_unit_id = ?, energy_type_id = ?, reading_date = ?, normalized_month = ?,
             previous_value = ?, current_value = ?, multiplier = ?, usage_value = ?, original_unit = ?, normalized_unit = ?, normalized_usage_value = ?,
             data_source = ?, record_status = ?, remark = ?, source_batch_id = ?, generated_energy_record_id = ?, updated_at = ?
         WHERE id = ?`
      ).run(
        payload.meterDeviceId, payload.organizationUnitId, payload.energyTypeId, payload.readingDate, payload.normalizedMonth,
        payload.previousValue, payload.currentValue, payload.multiplier, payload.usageValue, payload.originalUnit, payload.normalizedUnit,
        payload.normalizedUsageValue, payload.dataSource, payload.recordStatus, payload.remark, payload.sourceBatchId,
        payload.generatedEnergyRecordId, getNow(), id
      );
      return selectMeterReadingById(db, id);
    });
    return transaction();
  } finally {
    db.close();
  }
}

function voidMeterReading(readingId) {
  const id = parsePositiveInteger(readingId, 'id', { required: true });
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = selectMeterReadingById(db, id);
      db.prepare("UPDATE meter_reading_records SET record_status = 'void', updated_at = ? WHERE id = ?").run(getNow(), id);
      return { id: existing.id, recordStatus: 'void', voided: true, deactivated: true, generatedEnergyRecordId: existing.generatedEnergyRecordId || null, note: '抄表记录已作废；本节点不会物理删除，也不会自动同步能耗统计。' };
    });
    return transaction();
  } finally {
    db.close();
  }
}

function normalizeHeaderName(value) {
  return String(value || '').trim().replace(/[\s_\-\/\\:：()（）]/g, '').toLowerCase();
}

function canonicalImportFieldName(header) {
  const normalized = normalizeHeaderName(header);
  for (const [field, aliases] of Object.entries(IMPORT_ALIASES)) {
    if (aliases.map(normalizeHeaderName).includes(normalized)) return field;
  }
  return null;
}

function mapMeterReadingImportFields(row = {}) {
  const mapped = {};
  const fieldMapping = {};
  Object.entries(row || {}).forEach(([header, value]) => {
    const field = canonicalImportFieldName(header);
    if (!field) return;
    if (Object.prototype.hasOwnProperty.call(mapped, field) && normalizeText(mapped[field])) return;
    mapped[field] = value;
    fieldMapping[field] = header;
  });
  return { mapped, fieldMapping };
}

function createImportError(rowNumber, fieldName, rawValue, errorCode, errorReason, severity = 'error') {
  return { rowNumber, fieldName, rawValue: rawValue === undefined || rawValue === null ? null : String(rawValue), errorCode, errorReason, severity };
}

function formatMeterReadingImportRawValues(mapped = {}) {
  const parts = [
    ['previous_value', mapped.previousValue],
    ['current_value', mapped.currentValue],
    ['multiplier', mapped.multiplier],
    ['usage_value', mapped.usageValue]
  ]
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([field, value]) => `${field}=${String(value).trim()}`);
  return parts.length > 0 ? parts.join('; ') : null;
}

function resolveMeterReadingImportErrorRawValue(error, mapped = {}) {
  const explicitRawValue = error?.details?.rawValue;
  if (explicitRawValue !== undefined && explicitRawValue !== null) {
    return explicitRawValue;
  }
  const code = error?.details?.code || '';
  const fieldName = error?.details?.fieldName || '';
  if (code === 'INVALID_READING_RANGE' || ['previousValue', 'currentValue', 'multiplier', 'usageValue'].includes(fieldName)) {
    return formatMeterReadingImportRawValues(mapped);
  }
  return null;
}

function buildMeterReadingImportIndexes(input = {}) {
  const orgByPath = new Map();
  const orgByCode = new Map();
  const orgByName = new Map();
  (input.organizationUnits || []).forEach((unit) => {
    if (unit.status !== 'active') return;
    if (unit.unitPath) orgByPath.set(String(unit.unitPath), unit);
    if (unit.unitCode) orgByCode.set(String(unit.unitCode), unit);
    if (unit.unitName) orgByName.set(String(unit.unitName), unit);
  });
  const metersByCode = new Map();
  const metersByOrgAndName = new Map();
  (input.meterDevices || []).forEach((meter) => {
    if (meter.meterCode) metersByCode.set(String(meter.meterCode), meter);
    if (meter.organizationUnitId && meter.meterName) metersByOrgAndName.set(`${meter.organizationUnitId} ${meter.meterName}`, meter);
  });
  return { orgByPath, orgByCode, orgByName, metersByCode, metersByOrgAndName };
}

function loadMeterReadingImportIndexes(db) {
  return buildMeterReadingImportIndexes({
    organizationUnits: db.prepare('SELECT id, unit_code AS unitCode, unit_name AS unitName, unit_path AS unitPath, status FROM organization_units').all(),
    meterDevices: db.prepare(
      `SELECT md.id, md.meter_code AS meterCode, md.meter_name AS meterName, md.energy_type_id AS energyTypeId,
              et.code AS energyTypeCode, md.organization_unit_id AS organizationUnitId, md.multiplier,
              md.allow_manual_reading AS allowManualReading, md.status
       FROM meter_devices md
       JOIN energy_types et ON et.id = md.energy_type_id AND et.is_active = 1`
    ).all()
  });
}

function findImportUnit(mapped, indexes) {
  const text = normalizeText(mapped.organizationUnit);
  if (!text) return null;
  return indexes.orgByPath.get(text) || indexes.orgByCode.get(text) || indexes.orgByName.get(text) || null;
}

function validateAndNormalizeMeterReadingImportRow(row, rowNumber, indexes) {
  const { mapped, fieldMapping } = mapMeterReadingImportFields(row);
  const errors = [];
  ['readingDate', 'previousValue', 'currentValue', 'unit'].forEach((field) => {
    if (!normalizeText(mapped[field])) errors.push(createImportError(rowNumber, field, mapped[field], 'REQUIRED_FIELD_MISSING', `必填字段 ${field} 为空或未映射。`));
  });
  if (!normalizeText(mapped.meterCode) && !normalizeText(mapped.meterName)) {
    errors.push(createImportError(rowNumber, 'meter_code', null, 'REQUIRED_FIELD_MISSING', 'meter_code 或 meter_name 至少填写一个。'));
  }
  const unit = findImportUnit(mapped, indexes);
  if (normalizeText(mapped.organizationUnit) && !unit) {
    errors.push(createImportError(rowNumber, 'organization_unit', mapped.organizationUnit, 'UNKNOWN_ORGANIZATION_UNIT', '用能单元不存在或未启用。'));
  }
  let meter = null;
  if (normalizeText(mapped.meterCode)) meter = indexes.metersByCode.get(normalizeText(mapped.meterCode)) || null;
  if (!meter && unit && normalizeText(mapped.meterName)) meter = indexes.metersByOrgAndName.get(`${unit.id} ${normalizeText(mapped.meterName)}`) || null;
  if (!meter) {
    errors.push(createImportError(rowNumber, normalizeText(mapped.meterCode) ? 'meter_code' : 'meter_name', normalizeText(mapped.meterCode) || normalizeText(mapped.meterName), 'UNKNOWN_METER_DEVICE', '未找到匹配计量器具；meter_code 精确匹配，或 organization_unit + meter_name 匹配。'));
  } else {
    if (meter.status !== 'active') errors.push(createImportError(rowNumber, 'meter_code', mapped.meterCode || mapped.meterName, 'INACTIVE_METER_DEVICE', '计量器具必须为 active 状态。'));
    if (Number(meter.allowManualReading) !== 1) errors.push(createImportError(rowNumber, 'meter_code', mapped.meterCode || mapped.meterName, 'METER_MANUAL_READING_DISABLED', '计量器具未开启允许手工抄表。'));
    if (unit && Number(unit.id) !== Number(meter.organizationUnitId)) errors.push(createImportError(rowNumber, 'organization_unit', mapped.organizationUnit, 'METER_READING_ORG_MISMATCH', '用能单元与计量器具归属不一致。'));
  }
  if (errors.length > 0 || !meter) return { errors, fieldMapping, record: null };
  try {
    const record = buildMeterReadingPayload({
      meterDeviceId: meter.id,
      organizationUnitId: meter.organizationUnitId,
      readingDate: mapped.readingDate,
      previousValue: mapped.previousValue,
      currentValue: mapped.currentValue,
      multiplier: mapped.multiplier,
      usageValue: mapped.usageValue,
      unit: mapped.unit,
      dataSource: 'upload',
      recordStatus: 'active',
      remark: mapped.remark
    }, meter);
    return { errors: [], fieldMapping, record };
  } catch (error) {
    return { errors: [createImportError(rowNumber, error?.details?.fieldName || 'meter_reading', resolveMeterReadingImportErrorRawValue(error, mapped), error?.details?.code || 'INVALID_METER_READING_ROW', error.message || '抄表导入行校验失败。')], fieldMapping, record: null };
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function getBatchDetail(db, batchId, extra = {}) {
  const row = db.prepare(
    `SELECT id, import_type AS importType, original_filename AS originalFilename, file_type AS fileType, status,
            total_rows AS totalRows, success_count AS successCount, failure_count AS failureCount, skipped_count AS skippedCount,
            duplicate_strategy AS duplicateStrategy, field_mapping_json AS fieldMappingJson, error_summary AS errorSummary,
            created_at AS createdAt, updated_at AS updatedAt, finished_at AS finishedAt
     FROM import_batches WHERE id = ?`
  ).get(batchId);
  if (!row) throw notFound('导入批次不存在。', { batchId });
  return { ...row, originalFilename: decodeUploadOriginalName(row.originalFilename), displayFilename: decodeUploadOriginalName(row.originalFilename), fieldMapping: row.fieldMappingJson ? JSON.parse(row.fieldMappingJson) : null, fieldMappingJson: undefined, ...extra };
}

function listBatchErrors(db, batchId) {
  return db.prepare(
    `SELECT id, batch_id AS batchId, row_number AS rowNumber, field_name AS fieldName, raw_value AS rawValue,
            error_code AS errorCode, error_reason AS errorReason, severity, created_at AS createdAt
     FROM import_errors WHERE batch_id = ? ORDER BY row_number ASC, id ASC LIMIT 50`
  ).all(batchId);
}

function createMeterReadingImportBatchFromUpload(file, options = {}) {
  if (!file) throw badRequest('请使用 multipart/form-data 上传字段名为 file 的抄表表格文件。', { code: 'IMPORT_FILE_REQUIRED', fieldName: 'file' });
  if ((options.duplicateStrategy || 'skip') !== 'skip') {
    throw badRequest('抄表导入当前仅支持默认 skip 重复策略。', { code: 'UNSUPPORTED_DUPLICATE_STRATEGY', enabledDuplicateStrategies: ['skip'] });
  }
  const fileType = assertSupportedImportFile(file.originalname);
  const db = openDatabase();
  let batchId = null;
  try {
    batchId = db.prepare(
      `INSERT INTO import_batches (import_type, original_filename, stored_filename, file_type, file_size_bytes, file_sha256, status, duplicate_strategy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'skip', ?, ?)`
    ).run(METER_READING_IMPORT_TYPE, decodeUploadOriginalName(file.originalname), file.filename, fileType, file.size, sha256File(file.path), getNow(), getNow()).lastInsertRowid;
    const parsed = parseImportFile(file.path, file.originalname);
    const summary = db.transaction(() => persistMeterReadingImport(db, batchId, parsed.rows))();
    return getBatchDetail(db, batchId, { summary, errors: listBatchErrors(db, batchId), note: '抄表导入只写入 meter_reading_records，不会自动写入 energy_records 或进入能耗统计。' });
  } catch (error) {
    if (batchId) {
      db.prepare("UPDATE import_batches SET status = 'failed', finished_at = ?, updated_at = ?, error_summary = ? WHERE id = ?").run(getNow(), getNow(), error.message || '抄表导入失败。', batchId);
      db.prepare("INSERT INTO import_errors (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity) VALUES (?, 1, NULL, NULL, ?, ?, 'error')").run(batchId, error?.details?.code || error.code || 'METER_READING_IMPORT_FAILED', error.message || '抄表导入失败。');
      return getBatchDetail(db, batchId, { summary: { batchId, status: 'failed', totalRows: 0, successCount: 0, failureCount: 0, skippedCount: 0 }, errors: listBatchErrors(db, batchId) });
    }
    throw error;
  } finally {
    db.close();
  }
}

function persistMeterReadingImport(db, batchId, rows) {
  const indexes = loadMeterReadingImportIndexes(db);
  const insertError = db.prepare('INSERT INTO import_errors (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const duplicateExists = db.prepare("SELECT id FROM meter_reading_records WHERE meter_device_id = ? AND reading_date = ? AND data_source = 'upload' AND record_status = 'active' LIMIT 1");
  db.prepare("UPDATE import_batches SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ?").run(getNow(), getNow(), batchId);
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  let validationErrorCount = 0;
  const fieldMapping = {};
  if (!rows.length) {
    insertError.run(batchId, 1, null, null, 'EMPTY_IMPORT_FILE', '导入文件没有可解析的数据行。', 'error');
    db.prepare("UPDATE import_batches SET status = 'failed', total_rows = 0, error_summary = ?, finished_at = ?, updated_at = ? WHERE id = ?").run('导入文件没有可解析的数据行。', getNow(), getNow(), batchId);
    return { batchId, status: 'failed', totalRows: 0, successCount, failureCount, skippedCount, validationErrorCount: 1 };
  }
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const { errors, fieldMapping: rowMapping, record } = validateAndNormalizeMeterReadingImportRow(row, rowNumber, indexes);
    Object.assign(fieldMapping, rowMapping);
    if (errors.length > 0) {
      failureCount += 1;
      validationErrorCount += errors.length;
      errors.forEach((error) => insertError.run(batchId, error.rowNumber, error.fieldName, error.rawValue, error.errorCode, error.errorReason, error.severity));
      return;
    }
    if (duplicateExists.get(record.meterDeviceId, record.readingDate)) {
      skippedCount += 1;
      insertError.run(batchId, rowNumber, 'meter_device_id+reading_date+data_source', `${record.meterDeviceId}|${record.readingDate}|upload`, 'DUPLICATE_METER_READING_SKIPPED', '默认 skip 策略已跳过同一计量器具、抄表日期和 upload 来源的 active 抄表记录。', 'warning');
      return;
    }
    insertMeterReadingRecord(db, { ...record, sourceBatchId: batchId, dataSource: 'upload', generatedEnergyRecordId: null }, getNow());
    successCount += 1;
  });
  const status = failureCount > 0 || skippedCount > 0 ? 'completed_with_errors' : 'completed';
  const summaryParts = [];
  if (failureCount > 0) summaryParts.push(`存在 ${failureCount} 行校验失败，共 ${validationErrorCount} 条错误。`);
  if (skippedCount > 0) summaryParts.push(`默认 skip 策略跳过 ${skippedCount} 行重复抄表。`);
  db.prepare(
    `UPDATE import_batches SET status = ?, total_rows = ?, success_count = ?, failure_count = ?, skipped_count = ?, field_mapping_json = ?, error_summary = ?, finished_at = ?, updated_at = ? WHERE id = ?`
  ).run(status, rows.length, successCount, failureCount, skippedCount, JSON.stringify(fieldMapping), summaryParts.join(' ') || null, getNow(), getNow(), batchId);
  return { batchId, status, totalRows: rows.length, successCount, failureCount, skippedCount, validationErrorCount };
}

function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function buildMeterReadingExportRows(rows = []) {
  return rows.map((row) => {
    const output = {};
    EXPORT_FIELDS.forEach((field) => {
      output[field.header] = row[field.key] ?? '';
    });
    return output;
  });
}

function exportMeterReadings(query = {}) {
  const format = String(query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const db = openDatabase();
  try {
    const rows = selectMeterReadingRows(db, query, MAX_METER_READING_EXPORT_ROWS, 0);
    const exportRows = buildMeterReadingExportRows(rows);
    const headers = EXPORT_FIELDS.map((field) => field.header);
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fileName = `计量抄表导出-${date}.${format}`;
    if (format === 'csv') {
      const csvLines = [headers, ...exportRows.map((row) => headers.map((header) => row[header]))].map((row) => row.map(escapeCsvCell).join(','));
      return { fileName, format, contentType: 'text/csv; charset=utf-8', body: Buffer.from(`${UTF8_BOM}${csvLines.join('\n')}\n`, 'utf8'), rowCount: rows.length, fields: headers };
    }
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.json_to_sheet(exportRows, { header: headers });
    worksheet['!cols'] = headers.map((header) => ({ wch: Math.min(Math.max(String(header).length + 8, 12), 28) }));
    XLSX.utils.book_append_sheet(workbook, worksheet, '计量抄表');
    return { fileName, format, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), rowCount: rows.length, fields: headers };
  } finally {
    db.close();
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function normalizeGenerationDetailLimit(query = {}) {
  const requestedLimit = parsePositiveInteger(firstDefined(query, ['detailLimit', 'limit']), 'detailLimit') || 500;
  return Math.min(requestedLimit, 500);
}

function normalizeGenerationFilters(input = {}) {
  const filters = {};
  const organizationUnitId = parsePositiveInteger(firstDefined(input, ['organizationUnitId', 'organization_unit_id']), 'organizationUnitId');
  if (organizationUnitId) filters.organizationUnitId = organizationUnitId;
  const meterId = parsePositiveInteger(firstDefined(input, ['meterId', 'meterDeviceId', 'meter_device_id']), 'meterId');
  if (meterId) filters.meterId = meterId;
  const energyTypeCode = normalizeText(firstDefined(input, ['energyTypeCode', 'energy_type_code']));
  if (energyTypeCode) filters.energyTypeCode = energyTypeCode;
  const monthStart = normalizeText(input.monthStart);
  if (monthStart) {
    const normalized = normalizeMonth(monthStart);
    if (!normalized) throw badRequest('monthStart 必须可标准化为 YYYY-MM。', { code: 'INVALID_MONTH', fieldName: 'monthStart', rawValue: monthStart });
    filters.monthStart = normalized;
  }
  const monthEnd = normalizeText(input.monthEnd);
  if (monthEnd) {
    const normalized = normalizeMonth(monthEnd);
    if (!normalized) throw badRequest('monthEnd 必须可标准化为 YYYY-MM。', { code: 'INVALID_MONTH', fieldName: 'monthEnd', rawValue: monthEnd });
    filters.monthEnd = normalized;
  }
  if (filters.monthStart && filters.monthEnd && filters.monthStart > filters.monthEnd) {
    throw badRequest('monthStart 不能晚于 monthEnd。', { code: 'INVALID_MONTH_RANGE', monthStart: filters.monthStart, monthEnd: filters.monthEnd });
  }
  const status = normalizeText(firstDefined(input, ['status', 'recordStatus', 'record_status']));
  if (status) {
    assertWhitelist(status, 'status', READING_STATUSES);
    filters.status = status;
  }
  return filters;
}

function buildGenerationPreviewWhere(filters = {}) {
  const where = [];
  const params = {};
  if (filters.organizationUnitId) {
    where.push('mrr.organization_unit_id = @organizationUnitId');
    params.organizationUnitId = filters.organizationUnitId;
  }
  if (filters.meterId) {
    where.push('mrr.meter_device_id = @meterId');
    params.meterId = filters.meterId;
  }
  if (filters.energyTypeCode) {
    where.push('et.code = @energyTypeCode');
    params.energyTypeCode = filters.energyTypeCode;
  }
  if (filters.monthStart) {
    where.push('mrr.normalized_month >= @monthStart');
    params.monthStart = filters.monthStart;
  }
  if (filters.monthEnd) {
    where.push('mrr.normalized_month <= @monthEnd');
    params.monthEnd = filters.monthEnd;
  }
  if (filters.status) {
    where.push('mrr.record_status = @status');
    params.status = filters.status;
  }
  return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

function buildMeterReadingGenerationDuplicateKey(row = {}) {
  return `meter-reading-month:${row.meterDeviceId}:${row.normalizedMonth}:${row.energyTypeId}`;
}

function summarizeGenerationItems(items = []) {
  const summary = {
    totalScanned: items.length,
    wouldGenerate: 0,
    conflict: 0,
    void: 0,
    alreadyGenerated: 0,
    missingLedger: 0,
    invalidUnit: 0,
    blocked: 0,
    skipped: 0
  };
  items.forEach((item) => {
    if (item.wouldGenerate) {
      summary.wouldGenerate += 1;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(summary, item.status)) {
      summary[item.status] += 1;
    }
    summary.skipped += 1;
  });
  return summary;
}

function buildGenerationPreviewSignature(preview) {
  return sha256Json({
    version: METER_READING_GENERATION_SIGNATURE_VERSION,
    filters: preview.filters,
    summary: preview.summary,
    candidateReadingIds: preview.candidateReadingIds
  });
}

function mapGenerationPreviewRow(row, conflictRow) {
  const duplicateKey = row.meterDeviceId && row.normalizedMonth && row.energyTypeId
    ? buildMeterReadingGenerationDuplicateKey(row)
    : null;
  const item = {
    readingId: row.id,
    meterDeviceId: row.meterDeviceId,
    meterCode: row.meterCode,
    meterName: row.meterName,
    organizationUnitId: row.organizationUnitId,
    organizationUnitPath: row.organizationUnitPath,
    meterOrganizationUnitId: row.meterOrganizationUnitId,
    energyTypeId: row.energyTypeId,
    energyTypeCode: row.energyTypeCode,
    energyTypeName: row.energyTypeName,
    readingDate: row.readingDate,
    normalizedMonth: row.normalizedMonth,
    usageValue: row.usageValue,
    originalUnit: row.originalUnit,
    normalizedUsageValue: row.normalizedUsageValue,
    normalizedUnit: row.normalizedUnit,
    recordStatus: row.recordStatus,
    existingGeneratedEnergyRecordId: row.generatedEnergyRecordId || null,
    conflictEnergyRecordId: conflictRow?.id || null,
    duplicateKey,
    wouldGenerate: false,
    status: 'blocked',
    reasons: []
  };
  if (row.recordStatus === 'void') {
    item.status = 'void';
    item.reasons.push({ code: 'METER_READING_VOID', message: '抄表记录已作废，跳过生成。' });
  } else if (row.generatedEnergyRecordId) {
    item.status = 'alreadyGenerated';
    item.reasons.push({ code: 'METER_READING_ALREADY_GENERATED', message: '抄表记录已有 generated_energy_record_id，跳过生成。' });
  } else if (!row.meterDeviceId || !row.organizationUnitId || !row.energyTypeId || !row.meterCode || !row.energyTypeCode) {
    item.status = 'missingLedger';
    item.reasons.push({ code: 'MISSING_LEDGER_FIELDS', message: '抄表记录缺少计量器具、用能单元或能源类型台账字段。' });
  } else if (row.meterOrganizationUnitId && Number(row.organizationUnitId) !== Number(row.meterOrganizationUnitId)) {
    item.status = 'blocked';
    item.reasons.push({ code: 'METER_READING_ORG_MISMATCH', message: '抄表记录所属用能单元与计量器具当前归属不一致，跳过生成以避免矛盾台账关联。' });
  } else if (row.meterStatus !== 'active' || row.organizationUnitStatus !== 'active' || Number(row.energyTypeActive) !== 1) {
    item.status = 'blocked';
    item.reasons.push({ code: 'INACTIVE_LEDGER', message: '计量器具、用能单元或能源类型未启用，跳过生成。' });
  } else if (!row.normalizedMonth || !row.normalizedUnit || row.normalizedUsageValue === null || row.normalizedUsageValue === undefined || Number(row.normalizedUsageValue) < 0) {
    item.status = 'invalidUnit';
    item.reasons.push({ code: 'INVALID_USAGE_OR_UNIT', message: '抄表记录标准化月份、单位或用量不完整，跳过生成。' });
  } else if (conflictRow) {
    item.status = 'conflict';
    item.reasons.push({ code: 'MONTHLY_ACTIVE_ENERGY_RECORD_EXISTS', message: '同仪表、同月份、同能源类型已有 active 能耗记录，按策略跳过且不覆盖。' });
  } else {
    item.status = 'wouldGenerate';
    item.wouldGenerate = true;
    item.reasons.push({ code: 'READY_TO_GENERATE', message: '满足 active、未生成、字段完整且无月度 active 冲突，可受控生成 energy_records。' });
  }
  item.reasonCodes = item.reasons.map((reason) => reason.code).join('|');
  item.reasonText = item.reasons.map((reason) => reason.message).join('；');
  return item;
}

/** 校验服务端显式传入的抄表主键集合，禁止重复、非 canonical 或空范围。 */
function normalizeExactGenerationReadingIds(readingIds) {
  if (!Array.isArray(readingIds) || readingIds.length === 0) {
    throw new AppError('METER_READING_GENERATION_SCOPE_EMPTY', '抄表生成范围必须是服务端解析出的非空精确主键集合。', { statusCode: 409 });
  }
  const normalized = readingIds.map((readingId) => {
    if (!Number.isSafeInteger(readingId) || readingId <= 0) {
      throw new AppError('METER_READING_GENERATION_SCOPE_INVALID', '抄表生成范围包含无效主键。', { statusCode: 409 });
    }
    return readingId;
  }).sort((left, right) => left - right);
  if (new Set(normalized).size !== normalized.length) {
    throw new AppError('METER_READING_GENERATION_SCOPE_DUPLICATE', '抄表生成范围包含重复主键。', { statusCode: 409 });
  }
  return normalized;
}

/** 读取正式生成预演所需字段；筛选入口与服务端精确主键入口共用同一字段合同。 */
function selectGenerationPreviewRows(db, options = {}) {
  const baseSql = `SELECT mrr.id, mrr.meter_device_id AS meterDeviceId, md.meter_code AS meterCode, md.meter_name AS meterName,
      md.status AS meterStatus, md.organization_unit_id AS meterOrganizationUnitId,
      mrr.organization_unit_id AS organizationUnitId, ou.unit_path AS organizationUnitPath,
      ou.status AS organizationUnitStatus, mrr.energy_type_id AS energyTypeId, et.code AS energyTypeCode,
      et.name AS energyTypeName, et.is_active AS energyTypeActive, mrr.reading_date AS readingDate,
      mrr.normalized_month AS normalizedMonth, mrr.usage_value AS usageValue, mrr.original_unit AS originalUnit,
      mrr.normalized_unit AS normalizedUnit, mrr.normalized_usage_value AS normalizedUsageValue,
      mrr.record_status AS recordStatus, mrr.generated_energy_record_id AS generatedEnergyRecordId
    FROM meter_reading_records mrr
    LEFT JOIN meter_devices md ON md.id = mrr.meter_device_id
    LEFT JOIN organization_units ou ON ou.id = mrr.organization_unit_id
    LEFT JOIN energy_types et ON et.id = mrr.energy_type_id`;
  if (Array.isArray(options.readingIds)) {
    const readingIds = normalizeExactGenerationReadingIds(options.readingIds);
    const placeholders = readingIds.map(() => '?').join(', ');
    const rows = db.prepare(`${baseSql} WHERE mrr.id IN (${placeholders})
      ORDER BY mrr.normalized_month ASC, mrr.id ASC`).all(...readingIds);
    const actualIds = rows.map((row) => Number(row.id)).sort((left, right) => left - right);
    assertSameArray(actualIds, readingIds, 'METER_READING_GENERATION_SCOPE_MISMATCH', '服务端精确抄表范围与当前业务行集合不一致。');
    return rows;
  }
  const filters = options.filters || {};
  const detailLimit = options.detailLimit;
  const { whereSql, params } = buildGenerationPreviewWhere(filters);
  return db.prepare(`${baseSql} ${whereSql}
    ORDER BY mrr.normalized_month ASC, mrr.id ASC
    LIMIT @detailLimit`).all({ ...params, detailLimit });
}

/** 对已精确读取的业务行复用正式冲突、重复和跳过分类算法。 */
function buildGenerationPreviewFromRows(db, rows, options = {}) {
  const conflictStatement = db.prepare(
    `SELECT id, duplicate_key AS duplicateKey
     FROM energy_records
     WHERE record_status = 'active'
       AND meter_device_id = ?
       AND normalized_month = ?
       AND energy_type_id = ?
     ORDER BY id ASC
     LIMIT 1`
  );
  const seenGenerationKeys = new Set();
  const items = rows.map((row) => {
    const conflict = row.meterDeviceId && row.normalizedMonth && row.energyTypeId
      ? conflictStatement.get(row.meterDeviceId, row.normalizedMonth, row.energyTypeId)
      : null;
    const item = mapGenerationPreviewRow(row, conflict);
    if (item.wouldGenerate && seenGenerationKeys.has(item.duplicateKey)) {
      item.wouldGenerate = false;
      item.status = 'conflict';
      item.reasons = [{ code: 'MONTHLY_CANDIDATE_CONFLICT', message: '同一预演范围内已有同仪表、同月份、同能源类型 wouldGenerate 候选，本条跳过以保持月度唯一。' }];
      item.reasonCodes = item.reasons.map((reason) => reason.code).join('|');
      item.reasonText = item.reasons.map((reason) => reason.message).join('；');
    }
    if (item.wouldGenerate) seenGenerationKeys.add(item.duplicateKey);
    return item;
  });
  const summary = summarizeGenerationItems(items);
  const candidateReadingIds = items.filter((item) => item.wouldGenerate).map((item) => item.readingId).sort((a, b) => a - b);
  const preview = {
    dryRun: true,
    previewOnly: true,
    writesEnergyRecords: false,
    carbonAccountingDeferred: true,
    confirmText: METER_READING_GENERATION_CONFIRM_TEXT,
    backupReason: METER_READING_GENERATION_BACKUP_REASON,
    filters: options.filters || {},
    detailLimit: options.detailLimit === undefined ? items.length : options.detailLimit,
    summary,
    candidateReadingIds,
    items,
    notices: [
      '预演不写库；只有 POST execute 且固定确认文本匹配后才会生成 active energy_records。',
      '同仪表 + 同月份 + 同能源类型已有 active energy_records 时跳过冲突，不覆盖、不新增、不自动关联。',
      '生成后的 active energy_records 会立即纳入能耗统计；碳核算联动后置，本轮不自动计算碳排放。'
    ]
  };
  preview.previewSignature = buildGenerationPreviewSignature(preview);
  return preview;
}

/** 使用旧正式筛选合同构建生成预演，保持既有路由兼容。 */
function buildMeterReadingEnergyRecordGenerationPreviewWithDb(db, query = {}) {
  const filters = normalizeGenerationFilters(query);
  const detailLimit = normalizeGenerationDetailLimit(query);
  return buildGenerationPreviewFromRows(
    db,
    selectGenerationPreviewRows(db, { filters, detailLimit }),
    { filters, detailLimit }
  );
}

/** 使用服务端精确 readingIds 构建预演，并冻结所有分类字段作为防陈旧证据。 */
function buildMeterReadingEnergyRecordGenerationExactPreviewWithDb(db, readingIds) {
  const normalizedReadingIds = normalizeExactGenerationReadingIds(readingIds);
  const preview = buildGenerationPreviewFromRows(
    db,
    selectGenerationPreviewRows(db, { readingIds: normalizedReadingIds }),
    { filters: {}, detailLimit: normalizedReadingIds.length }
  );
  return {
    ...preview,
    exactScopeDigest: sha256Json({
      version: 'meter-reading-energy-record-generation-exact-scope:v1',
      readingIds: normalizedReadingIds,
      items: preview.items
    })
  };
}

function getMeterReadingEnergyRecordGenerationPreview(query = {}) {
  const db = openDatabase();
  try {
    return buildMeterReadingEnergyRecordGenerationPreviewWithDb(db, query);
  } finally {
    db.close();
  }
}

// 将内部筛选对象转换为审计文件中的中文展示文本，API JSON 字段保持不变。
function formatGenerationExportFilters(filters = {}) {
  const labels = {
    organizationUnitId: '用能单元ID',
    meterId: '计量器具ID',
    energyTypeCode: '能源类型编码',
    monthStart: '开始月份',
    monthEnd: '结束月份',
    status: '记录状态'
  };
  const entries = Object.entries(filters).map(([key, value]) => `${labels[key] || '其他筛选条件'}=${value}`);
  return entries.length ? entries.join('；') : '无筛选条件';
}

// 清理审计文件说明中的内部表名与字段名，仅影响文件展示层。
function formatGenerationExportReason(value) {
  return String(value || '')
    .replaceAll('generated_energy_record_id', '已生成能耗记录标识')
    .replaceAll('active energy_records', '启用状态能耗记录')
    .replaceAll('energy_records', '能耗记录')
    .replaceAll('wouldGenerate', '可生成');
}

function buildGenerationExportRows(items = []) {
  return items.map((item) => {
    const output = {};
    METER_READING_GENERATION_EXPORT_FIELDS.forEach((field) => {
      if (field.key === 'reasons') output[field.header] = formatGenerationExportReason(item.reasonText);
      else output[field.header] = item[field.key] ?? '';
    });
    return output;
  });
}

function exportMeterReadingEnergyRecordGenerationPreview(query = {}) {
  const format = String(query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const preview = getMeterReadingEnergyRecordGenerationPreview({ ...query, detailLimit: normalizeGenerationDetailLimit({ ...query, detailLimit: query.detailLimit || query.limit || 500 }) });
  const headers = METER_READING_GENERATION_EXPORT_FIELDS.map((field) => field.header);
  const exportRows = buildGenerationExportRows(preview.items);
  const metaRows = [
    ['预案类型', '抄表生成能耗记录预演审计预案'],
    ['执行性质', '仅预演、不写入，确认后受控生成'],
    ['是否写入能耗记录', '否'],
    ['碳核算是否后置', '是'],
    ['固定确认文本', METER_READING_GENERATION_CONFIRM_TEXT],
    ['备份原因', '抄表生成能耗记录'],
    ['预演签名', preview.previewSignature],
    ['可生成数量', preview.summary.wouldGenerate],
    ['冲突跳过数量', preview.summary.conflict],
    ['筛选条件', formatGenerationExportFilters(preview.filters)]
  ];
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = `抄表生成能耗记录预演审计预案-${date}.${format}`;
  if (format === 'csv') {
    const lines = [
      ['抄表生成能耗记录预演审计预案'],
      ...metaRows,
      [],
      headers,
      ...exportRows.map((row) => headers.map((header) => row[header]))
    ].map((row) => row.map(escapeCsvCell).join(','));
    return { fileName, format, contentType: 'text/csv; charset=utf-8', body: Buffer.from(`${UTF8_BOM}${lines.join('\n')}\n`, 'utf8'), rowCount: preview.items.length, fields: headers, previewSignature: preview.previewSignature };
  }
  const workbook = XLSX.utils.book_new();
  const metaSheet = XLSX.utils.aoa_to_sheet([
    ['抄表生成能耗记录预演审计预案'],
    ['字段', '值'],
    ...metaRows
  ]);
  metaSheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
  XLSX.utils.book_append_sheet(workbook, metaSheet, '预案元信息');
  const detailSheet = XLSX.utils.json_to_sheet(exportRows, { header: headers });
  detailSheet['!cols'] = headers.map((header) => ({ wch: Math.min(Math.max(String(header).length + 8, 12), 32) }));
  XLSX.utils.book_append_sheet(workbook, detailSheet, '预演明细');
  return { fileName, format, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), rowCount: preview.items.length, fields: headers, previewSignature: preview.previewSignature };
}

function normalizeCandidateReadingIds(value) {
  if (!Array.isArray(value)) {
    throw badRequest('candidateReadingIds 必须是数组。', { code: 'METER_READING_GENERATION_CANDIDATE_IDS_REQUIRED' });
  }
  return value.map((id) => parsePositiveInteger(id, 'candidateReadingIds', { required: true })).sort((a, b) => a - b);
}

function assertSameArray(actual, expected, code, message) {
  if (actual.length !== expected.length || actual.some((value, index) => Number(value) !== Number(expected[index]))) {
    throw badRequest(message, { code, actual, expected });
  }
}

function buildEnergyRecordInsertPayloadFromGenerationItem(item, now = getNow(), options = {}) {
  const actionTrace = options.actionRunId ? `；action_run_id=${options.actionRunId}` : '';
  return {
    sourceBatchId: null,
    sourceRowNumber: null,
    energyTypeId: item.energyTypeId,
    organizationUnitId: item.organizationUnitId,
    meterDeviceId: item.meterDeviceId,
    originalMonth: item.readingDate || item.normalizedMonth,
    normalizedMonth: item.normalizedMonth,
    originalUnit: item.originalUnit,
    originalValue: item.usageValue,
    normalizedUnit: item.normalizedUnit,
    normalizedValue: item.normalizedUsageValue,
    remark: `由抄表记录生成；meter_reading_record_id=${item.readingId}${actionTrace}；碳核算联动后置。`,
    duplicateKey: item.duplicateKey,
    now
  };
}

/** 规范化不同平台的物理路径比较值，避免 Windows 大小写差异影响目录边界。 */
function normalizeMeterReadingPhysicalPath(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** 判断物理路径是否严格位于真实备份目录内，使用目录边界而不是字符串前缀。 */
function isMeterReadingPhysicalPathInside(basePath, targetPath) {
  const relative = path.relative(
    normalizeMeterReadingPhysicalPath(basePath),
    normalizeMeterReadingPhysicalPath(targetPath)
  );
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

/** 构造不含本机路径的备份证据路径错误。 */
function createMeterReadingBackupEvidenceError(code, message) {
  return new AppError(code, message, { statusCode: 409 });
}

/** 判断文件系统异常是否表示证据路径已经不存在。 */
function isMissingMeterReadingBackupPathError(error) {
  return error && ['ENOENT', 'ENOTDIR'].includes(error.code);
}

/** 将目录身份字段规范为可稳定比较的字符串。 */
function normalizeMeterReadingStatIdentityValue(value) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** 读取文件系统状态中的有效设备号；部分 Windows 文件系统会返回 0。 */
function getMeterReadingEffectiveDevice(stat) {
  if (!stat || stat.dev === 0 || stat.dev === 0n) return null;
  return normalizeMeterReadingStatIdentityValue(stat.dev);
}

/** 生成不依赖路径字符串的备份目录身份快照。 */
function buildMeterReadingBackupDirectoryIdentity(stat) {
  return Object.freeze({
    symbolicLink: stat.isSymbolicLink(),
    directory: stat.isDirectory(),
    ino: normalizeMeterReadingStatIdentityValue(stat.ino),
    effectiveDev: getMeterReadingEffectiveDevice(stat),
    birthtimeMs: normalizeMeterReadingStatIdentityValue(stat.birthtimeMs)
  });
}

/** 比较两份备份目录身份，覆盖链接状态、目录类型、inode、有效设备号和创建时间。 */
function isSameMeterReadingBackupDirectoryIdentity(leftIdentity, rightIdentity) {
  return leftIdentity.symbolicLink === rightIdentity.symbolicLink
    && leftIdentity.directory === rightIdentity.directory
    && leftIdentity.ino !== null
    && leftIdentity.ino === rightIdentity.ino
    && leftIdentity.effectiveDev === rightIdentity.effectiveDev
    && leftIdentity.birthtimeMs !== null
    && leftIdentity.birthtimeMs === rightIdentity.birthtimeMs;
}

/** 构造备份目录在校验期间发生替换时的稳定 fail-closed 错误。 */
function createMeterReadingBackupDirectoryChangedError() {
  return createMeterReadingBackupEvidenceError(
    'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE',
    '抄表生成备份目录身份已发生变化。'
  );
}

/**
 * 对配置备份目录执行 lstat → realpath → lstat 身份快照。
 * Node/Windows 无法锁定祖先目录，本快照用于缩小并检测可观察到的替换窗口。
 */
function captureMeterReadingBackupDirectoryIdentity(configuredBase, options = {}) {
  const expectedSnapshot = options.expectedSnapshot || null;
  try {
    const beforeStat = fs.lstatSync(configuredBase);
    if (!beforeStat.isDirectory() || beforeStat.isSymbolicLink()) {
      if (expectedSnapshot) throw createMeterReadingBackupDirectoryChangedError();
      throw createMeterReadingBackupEvidenceError(
        'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
        '抄表生成备份目录无效。'
      );
    }
    const beforeIdentity = buildMeterReadingBackupDirectoryIdentity(beforeStat);
    const realBase = fs.realpathSync(configuredBase);
    const afterStat = fs.lstatSync(configuredBase);
    const afterIdentity = buildMeterReadingBackupDirectoryIdentity(afterStat);
    if (!afterStat.isDirectory() || afterStat.isSymbolicLink()
      || !isSameMeterReadingBackupDirectoryIdentity(beforeIdentity, afterIdentity)) {
      throw createMeterReadingBackupDirectoryChangedError();
    }
    const realBaseStat = fs.lstatSync(realBase);
    const realBaseIdentity = buildMeterReadingBackupDirectoryIdentity(realBaseStat);
    if (!realBaseStat.isDirectory() || realBaseStat.isSymbolicLink()
      || !isSameMeterReadingBackupDirectoryIdentity(afterIdentity, realBaseIdentity)) {
      throw createMeterReadingBackupDirectoryChangedError();
    }
    const snapshot = Object.freeze({
      configuredBase,
      realBase,
      identity: afterIdentity
    });
    if (expectedSnapshot
      && (normalizeMeterReadingPhysicalPath(snapshot.realBase)
        !== normalizeMeterReadingPhysicalPath(expectedSnapshot.realBase)
        || !isSameMeterReadingBackupDirectoryIdentity(snapshot.identity, expectedSnapshot.identity))) {
      throw createMeterReadingBackupDirectoryChangedError();
    }
    return snapshot;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw createMeterReadingBackupEvidenceError(
      isMissingMeterReadingBackupPathError(error)
        ? 'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE'
        : 'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
      isMissingMeterReadingBackupPathError(error)
        ? '抄表生成备份已不存在或路径发生变化。'
        : '抄表生成备份目录校验失败。'
    );
  }
}

/** 在关键读取节点重新执行目录身份快照并与首次身份比较。 */
function assertMeterReadingBackupDirectoryIdentity(snapshot) {
  return captureMeterReadingBackupDirectoryIdentity(snapshot.configuredBase, {
    expectedSnapshot: snapshot
  });
}

/** 校验配置备份目录和证据路径的物理边界，并拒绝所有可检测的符号链接段。 */
function assertMeterReadingBackupPath(backupPath) {
  if (typeof backupPath !== 'string' || backupPath.trim() === '') {
    throw createMeterReadingBackupEvidenceError(
      'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
      '抄表生成备份证据路径不完整。'
    );
  }
  const configuredBase = path.resolve(backupsDir);
  const target = path.resolve(backupPath);
  const relative = path.relative(configuredBase, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw createMeterReadingBackupEvidenceError(
      'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
      '抄表生成备份证据不属于当前备份目录。'
    );
  }
  const directorySnapshot = captureMeterReadingBackupDirectoryIdentity(configuredBase);

  let currentPath = configuredBase;
  for (const segment of relative.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    let segmentStat;
    try {
      segmentStat = fs.lstatSync(currentPath);
    } catch (error) {
      throw createMeterReadingBackupEvidenceError(
        isMissingMeterReadingBackupPathError(error)
          ? 'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE'
          : 'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
        isMissingMeterReadingBackupPathError(error)
          ? '抄表生成备份已不存在或路径发生变化。'
          : '抄表生成备份路径校验失败。'
      );
    }
    if (segmentStat.isSymbolicLink()) {
      throw createMeterReadingBackupEvidenceError(
        'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
        '抄表生成备份证据路径禁止经过符号链接。'
      );
    }
  }

  let targetStat;
  let realTarget;
  try {
    targetStat = fs.lstatSync(target);
    if (targetStat.isSymbolicLink()) {
      throw createMeterReadingBackupEvidenceError(
        'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
        '抄表生成备份证据文件禁止为符号链接。'
      );
    }
    if (!targetStat.isFile()) {
      throw createMeterReadingBackupEvidenceError(
        'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
        '抄表生成备份证据文件必须是普通文件。'
      );
    }
    realTarget = fs.realpathSync(target);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw createMeterReadingBackupEvidenceError(
      isMissingMeterReadingBackupPathError(error)
        ? 'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE'
        : 'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
      isMissingMeterReadingBackupPathError(error)
        ? '抄表生成备份已不存在或路径发生变化。'
        : '抄表生成备份文件路径校验失败。'
    );
  }
  if (!isMeterReadingPhysicalPathInside(directorySnapshot.realBase, realTarget)) {
    throw createMeterReadingBackupEvidenceError(
      'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
      '抄表生成备份证据不属于当前备份目录。'
    );
  }
  assertMeterReadingBackupDirectoryIdentity(directorySnapshot);
  return { target, targetStat, realTarget, directorySnapshot };
}

/** 比较路径 lstat 与已打开句柄 fstat 的稳定文件身份。 */
function isSameMeterReadingFileIdentity(pathStat, openedStat) {
  if (pathStat.ino !== openedStat.ino) return false;
  if (pathStat.dev && openedStat.dev && pathStat.dev !== openedStat.dev) return false;
  return pathStat.birthtimeMs === openedStat.birthtimeMs;
}

/** 比较同一只读句柄读取前后的身份、大小和时间状态。 */
function isSameMeterReadingOpenedFileState(beforeStat, afterStat) {
  return isSameMeterReadingFileIdentity(beforeStat, afterStat)
    && beforeStat.size === afterStat.size
    && beforeStat.mtimeMs === afterStat.mtimeMs
    && beforeStat.ctimeMs === afterStat.ctimeMs;
}

/** 在写事务外通过正式备份服务子进程同步准备证据，保持现有同步 post-action 路由合同。 */
function prepareMeterReadingGenerationBackupEvidence() {
  const backupServicePath = require.resolve('./backupService');
  const childSource = `'use strict';\nconst { createBackup } = require(${JSON.stringify(backupServicePath)});\ncreateBackup({ reason: ${JSON.stringify(METER_READING_GENERATION_BACKUP_REASON)} })\n  .then((backup) => process.stdout.write(JSON.stringify(backup)))\n  .catch((error) => { process.stderr.write(JSON.stringify({ code: error && error.code ? error.code : 'BACKUP_FAILED' })); process.exitCode = 1; });`;
  const child = spawnSync(process.execPath, ['-e', childSource], {
    env: { ...process.env },
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true
  });
  if (child.error || child.status !== 0) {
    throw new AppError('METER_READING_GENERATION_BACKUP_PREPARE_FAILED', '抄表生成写入前备份失败。', { statusCode: 409 });
  }
  let evidence;
  try {
    evidence = JSON.parse(String(child.stdout || ''));
  } catch (_error) {
    evidence = null;
  }
  return revalidateMeterReadingGenerationBackupEvidence(evidence);
}

/** 在 outer transaction 内重验事务外备份的物理路径、句柄状态、大小和 SHA。 */
function revalidateMeterReadingGenerationBackupEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.reason !== METER_READING_GENERATION_BACKUP_REASON
    || typeof evidence.backupName !== 'string'
    || path.basename(evidence.backupName) !== evidence.backupName
    || !evidence.backupName.includes(METER_READING_GENERATION_BACKUP_REASON)
    || typeof evidence.path !== 'string'
    || typeof evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.sha256)
    || !Number.isSafeInteger(evidence.sizeBytes) || evidence.sizeBytes <= 0
    || path.resolve(String(evidence.databasePath || '')) !== path.resolve(databasePath)) {
    throw createMeterReadingBackupEvidenceError(
      'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
      '抄表生成备份证据不完整或与当前数据库不一致。'
    );
  }

  const pathContext = assertMeterReadingBackupPath(evidence.path);
  if (path.basename(pathContext.target) !== evidence.backupName) {
    throw createMeterReadingBackupEvidenceError(
      'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
      '抄表生成备份证据文件名校验失败。'
    );
  }

  let fileDescriptor = null;
  let validationError = null;
  try {
    const noFollowFlag = Number.isInteger(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
    assertMeterReadingBackupDirectoryIdentity(pathContext.directorySnapshot);
    fileDescriptor = fs.openSync(pathContext.target, fs.constants.O_RDONLY | noFollowFlag);
    assertMeterReadingBackupDirectoryIdentity(pathContext.directorySnapshot);
    const beforeStat = fs.fstatSync(fileDescriptor);
    if (!beforeStat.isFile()
      || !isSameMeterReadingFileIdentity(pathContext.targetStat, beforeStat)
      || beforeStat.size !== evidence.sizeBytes) {
      throw createMeterReadingBackupEvidenceError(
        'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE',
        '抄表生成备份内容已发生变化。'
      );
    }
    assertMeterReadingBackupDirectoryIdentity(pathContext.directorySnapshot);
    const buffer = fs.readFileSync(fileDescriptor);
    const afterStat = fs.fstatSync(fileDescriptor);
    assertMeterReadingBackupDirectoryIdentity(pathContext.directorySnapshot);
    if (!isSameMeterReadingOpenedFileState(beforeStat, afterStat)
      || buffer.length !== beforeStat.size) {
      throw createMeterReadingBackupEvidenceError(
        'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE',
        '抄表生成备份内容已发生变化。'
      );
    }
    const currentSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    if (currentSha256 !== evidence.sha256) {
      throw createMeterReadingBackupEvidenceError(
        'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE',
        '抄表生成备份内容已发生变化。'
      );
    }
    assertMeterReadingBackupDirectoryIdentity(pathContext.directorySnapshot);
  } catch (error) {
    validationError = error instanceof AppError
      ? error
      : createMeterReadingBackupEvidenceError(
        isMissingMeterReadingBackupPathError(error)
          ? 'METER_READING_GENERATION_BACKUP_EVIDENCE_STALE'
          : 'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
        isMissingMeterReadingBackupPathError(error)
          ? '抄表生成备份已不存在或路径发生变化。'
          : '抄表生成备份文件不可读取。'
      );
  } finally {
    if (fileDescriptor !== null) {
      try {
        fs.closeSync(fileDescriptor);
      } catch (_error) {
        if (!validationError) {
          validationError = createMeterReadingBackupEvidenceError(
            'METER_READING_GENERATION_BACKUP_EVIDENCE_INVALID',
            '抄表生成备份文件关闭失败。'
          );
        }
      }
    }
  }
  if (validationError) throw validationError;
  assertMeterReadingBackupDirectoryIdentity(pathContext.directorySnapshot);

  return Object.freeze({
    backupName: evidence.backupName,
    path: pathContext.target,
    sizeBytes: evidence.sizeBytes,
    sha256: evidence.sha256,
    reason: evidence.reason,
    method: String(evidence.method || ''),
    databasePath: path.resolve(databasePath)
  });
}

/** 复用正式生成写入算法；事务生命周期、备份和范围校验均由调用入口负责。 */
function applyMeterReadingEnergyRecordGenerationWithDb(db, preview, options = {}) {
  const insertEnergyRecord = db.prepare(
    `INSERT INTO energy_records (
       source_batch_id, source_row_number, energy_type_id, organization_unit_id, meter_device_id,
       original_month, normalized_month, original_unit, original_value, normalized_unit, normalized_value,
       remark, duplicate_key, record_status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  );
  const updateReading = db.prepare(`UPDATE meter_reading_records
    SET generated_energy_record_id = ?, updated_at = ?
    WHERE id = ? AND record_status = 'active' AND generated_energy_record_id IS NULL`);
  const readReadingAuditState = db.prepare(`SELECT updated_at AS updatedAt
    FROM meter_reading_records WHERE id = ?`);
  const generatedPairs = [];
  const skippedItems = [];
  preview.items.forEach((item) => {
    if (!item.wouldGenerate) {
      skippedItems.push({
        readingId: item.readingId,
        status: item.status,
        reasonCodes: item.reasonCodes,
        reason: item.reasonText,
        conflictEnergyRecordId: item.conflictEnergyRecordId || null
      });
      return;
    }
    const readingBefore = readReadingAuditState.get(item.readingId);
    if (!readingBefore || typeof readingBefore.updatedAt !== 'string') {
      throw new AppError('METER_READING_GENERATION_SOURCE_MISSING', '抄表生成来源在写入前已不可读取。', { statusCode: 409 });
    }
    const payload = buildEnergyRecordInsertPayloadFromGenerationItem(item, getNow(), {
      actionRunId: options.actionRunId
    });
    const insertResult = insertEnergyRecord.run(
      payload.sourceBatchId, payload.sourceRowNumber, payload.energyTypeId,
      payload.organizationUnitId, payload.meterDeviceId, payload.originalMonth,
      payload.normalizedMonth, payload.originalUnit, payload.originalValue,
      payload.normalizedUnit, payload.normalizedValue, payload.remark,
      payload.duplicateKey, payload.now, payload.now
    );
    const energyRecordId = Number(insertResult.lastInsertRowid);
    const updatedAt = getNow();
    const updateResult = updateReading.run(energyRecordId, updatedAt, item.readingId);
    if (updateResult.changes !== 1) {
      throw new AppError('METER_READING_GENERATION_BACK_REFERENCE_FAILED', '抄表记录回写生成能耗记录失败。', { statusCode: 409 });
    }
    if (Number.isSafeInteger(options.actorUserId) && options.actorUserId > 0 && options.actionRunId) {
      insertOperationLogWithDb(db, {
        userId: options.actorUserId,
        operation: 'ledger.meter-reading.generate-energy-record',
        targetType: 'energy_record',
        targetId: energyRecordId,
        detail: {
          actionRunId: options.actionRunId,
          meterReadingRecordId: item.readingId,
          sourceUpdatedAt: readingBefore.updatedAt,
          updatedAt
        },
        ip: options.actorIp || null,
        createdAt: updatedAt
      });
    }
    generatedPairs.push({
      readingId: item.readingId,
      energyRecordId,
      normalizedMonth: item.normalizedMonth,
      normalizedUnit: item.normalizedUnit,
      normalizedValue: item.normalizedUsageValue,
      duplicateKey: item.duplicateKey,
      previousUpdatedAt: readingBefore.updatedAt,
      updatedAt
    });
  });
  return { generatedPairs, skippedItems };
}

/** 在调用方 outer transaction 中按精确 reading scope 写入，并返回内部可追溯生成对。 */
function executeMeterReadingEnergyRecordGenerationExact(options = {}) {
  const db = options.db;
  if (!db || db.inTransaction !== true) {
    throw new AppError('METER_READING_GENERATION_OUTER_TRANSACTION_REQUIRED', '抄表生成必须复用调用方 outer SQLite transaction。', { statusCode: 409 });
  }
  if (!Number.isSafeInteger(options.actorUserId) || options.actorUserId <= 0
    || typeof options.actionRunId !== 'string' || options.actionRunId.trim() === '') {
    throw new AppError('METER_READING_GENERATION_AUDIT_CONTEXT_REQUIRED', '抄表生成必须绑定有效操作者和后置动作运行。', { statusCode: 409 });
  }
  const readingIds = normalizeExactGenerationReadingIds(options.readingIds);
  const preview = buildMeterReadingEnergyRecordGenerationExactPreviewWithDb(db, readingIds);
  if (typeof options.expectedExactScopeDigest !== 'string'
    || preview.exactScopeDigest !== options.expectedExactScopeDigest) {
    throw new AppError('METER_READING_GENERATION_INPUT_STALE', '抄表生成精确范围或领域状态已发生变化。', { statusCode: 409 });
  }
  if (preview.summary.wouldGenerate > 0) {
    revalidateMeterReadingGenerationBackupEvidence(options.backupEvidence);
  }
  const applied = applyMeterReadingEnergyRecordGenerationWithDb(db, preview, options);
  return {
    generated: applied.generatedPairs.length,
    updatedReadings: applied.generatedPairs.length,
    skipped: applied.skippedItems.length,
    summary: preview.summary,
    exactScopeDigest: preview.exactScopeDigest,
    generatedPairs: applied.generatedPairs,
    skippedItems: applied.skippedItems
  };
}

async function executeMeterReadingEnergyRecordGeneration(body = {}) {
  const confirmText = normalizeText(body.confirmText);
  if (confirmText !== METER_READING_GENERATION_CONFIRM_TEXT) {
    throw badRequest('确认文本不匹配，已拒绝由抄表生成能耗记录。', { code: 'METER_READING_GENERATION_CONFIRM_TEXT_MISMATCH', requiredConfirmText: METER_READING_GENERATION_CONFIRM_TEXT });
  }
  if (body.acknowledgeSkippedRisks !== true) {
    throw badRequest('必须确认已知晓冲突、作废、已生成、缺失和阻断记录会被跳过。', { code: 'METER_READING_GENERATION_SKIPPED_RISKS_ACK_REQUIRED' });
  }
  if (body.requireBackup !== true) {
    throw badRequest('执行前必须要求自动备份，requireBackup 必须显式为 true。', { code: 'METER_READING_GENERATION_BACKUP_REQUIRED' });
  }
  const previewSignature = normalizeText(body.previewSignature);
  if (!previewSignature) {
    throw badRequest('previewSignature 为必填项。', { code: 'METER_READING_GENERATION_PREVIEW_SIGNATURE_REQUIRED' });
  }
  const expectedWouldGenerate = parsePositiveInteger(body.expectedWouldGenerate, 'expectedWouldGenerate', { required: true });
  const candidateReadingIds = normalizeCandidateReadingIds(body.candidateReadingIds);
  const filters = normalizeGenerationFilters(body.filters || {});
  const backup = await createBackup({ reason: METER_READING_GENERATION_BACKUP_REASON });
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const preview = buildMeterReadingEnergyRecordGenerationPreviewWithDb(db, filters);
      if (preview.previewSignature !== previewSignature) {
        throw badRequest('当前 previewSignature 与执行前重新计算结果不一致，已拒绝执行。', { code: 'METER_READING_GENERATION_PREVIEW_SIGNATURE_MISMATCH', expected: preview.previewSignature, actual: previewSignature });
      }
      if (Number(preview.summary.wouldGenerate || 0) !== Number(expectedWouldGenerate || 0)) {
        throw badRequest('expectedWouldGenerate 与执行前重新计算结果不一致，已拒绝执行。', { code: 'METER_READING_GENERATION_WOULD_GENERATE_MISMATCH', expected: preview.summary.wouldGenerate, actual: expectedWouldGenerate });
      }
      assertSameArray(preview.candidateReadingIds, candidateReadingIds, 'METER_READING_GENERATION_CANDIDATE_READING_IDS_MISMATCH', 'candidateReadingIds 与执行前重新计算结果不一致，已拒绝执行。');
      const applied = applyMeterReadingEnergyRecordGenerationWithDb(db, preview);
      const items = [
        ...applied.generatedPairs.map((pair) => ({
          readingId: pair.readingId,
          energyRecordId: pair.energyRecordId,
          status: 'generated',
          previewStatus: 'wouldGenerate',
          duplicateKey: pair.duplicateKey,
          reason: '已生成 active energy_records 并回写 generated_energy_record_id。'
        })),
        ...applied.skippedItems.map((item) => ({
          readingId: item.readingId,
          status: 'skipped',
          previewStatus: item.status,
          reason: item.reason,
          conflictEnergyRecordId: item.conflictEnergyRecordId
        }))
      ].sort((left, right) => left.readingId - right.readingId);
      return {
        executed: true,
        dryRun: false,
        writesEnergyRecords: true,
        carbonAccountingDeferred: true,
        generated: applied.generatedPairs.length,
        updatedReadings: applied.generatedPairs.length,
        skipped: applied.skippedItems.length,
        skippedConflict: preview.summary.conflict,
        skippedVoid: preview.summary.void,
        skippedAlreadyGenerated: preview.summary.alreadyGenerated,
        skippedMissingLedger: preview.summary.missingLedger,
        skippedInvalidUnit: preview.summary.invalidUnit,
        skippedBlocked: preview.summary.blocked,
        previewSignature: preview.previewSignature,
        expectedWouldGenerate,
        candidateReadingIds: preview.candidateReadingIds,
        filters: preview.filters,
        backup,
        summary: preview.summary,
        items,
        note: '已按预演 wouldGenerate 候选受控生成 active energy_records；冲突和风险状态均跳过。生成后立即纳入能耗统计，碳核算联动后置。'
      };
    });
    return transaction();
  } finally {
    db.close();
  }
}

function getMeterReadingStats(query = {}) {
  const db = openDatabase();
  try {
    const { whereSql, params } = buildReadingWhere(query);
    const fromSql = `FROM meter_reading_records mrr
      JOIN meter_devices md ON md.id = mrr.meter_device_id
      JOIN energy_types et ON et.id = mrr.energy_type_id
      LEFT JOIN organization_units ou ON ou.id = mrr.organization_unit_id`;
    const totals = db.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN mrr.record_status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN mrr.record_status = 'void' THEN 1 ELSE 0 END), 0) AS void
      ${fromSql} ${whereSql}`).get(params);
    const byMonthEnergyType = db.prepare(`SELECT mrr.normalized_month AS normalizedMonth,
      et.code AS energyTypeCode, et.name AS energyTypeName, mrr.normalized_unit AS normalizedUnit,
      mrr.record_status AS recordStatus, COUNT(*) AS recordCount,
      COALESCE(SUM(mrr.normalized_usage_value), 0) AS normalizedUsageValue
      ${fromSql} ${whereSql}
      GROUP BY mrr.normalized_month, et.code, et.name, mrr.normalized_unit, mrr.record_status
      ORDER BY mrr.normalized_month DESC, et.code ASC, mrr.normalized_unit ASC, mrr.record_status ASC`).all();
    return { total: Number(totals.total || 0), active: Number(totals.active || 0), void: Number(totals.void || 0), byMonthEnergyType };
  } finally {
    db.close();
  }
}

module.exports = {
  EXPORT_FIELDS,
  METER_READING_GENERATION_BACKUP_REASON,
  METER_READING_GENERATION_CONFIRM_TEXT,
  METER_READING_IMPORT_TYPE,
  READING_DATA_SOURCES,
  READING_STATUSES,
  buildMeterReadingEnergyTrace,
  buildMeterReadingExportRows,
  buildMeterReadingImportIndexes,
  buildMeterReadingPayload,
  buildMeterReadingEnergyRecordGenerationExactPreviewWithDb,
  calculateUsageValue,
  createMeterReading,
  createMeterReadingImportBatchFromUpload,
  executeMeterReadingEnergyRecordGeneration,
  executeMeterReadingEnergyRecordGenerationExact,
  exportMeterReadingEnergyRecordGenerationPreview,
  exportMeterReadings,
  formatGenerationExportFilters,
  getMeterReadingEnergyRecordGenerationPreview,
  getMeterReadingStats,
  listMeterReadings,
  mapMeterReadingImportFields,
  normalizeReadingDate,
  normalizeReadingUnit,
  prepareMeterReadingGenerationBackupEvidence,
  revalidateMeterReadingGenerationBackupEvidence,
  updateMeterReading,
  validateAndNormalizeMeterReadingImportRow,
  voidMeterReading
};
