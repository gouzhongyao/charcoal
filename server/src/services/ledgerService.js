const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const { openDatabase } = require('../db/database');
const { badRequest, notFound } = require('../utils/errors');
const { decodeUploadOriginalName } = require('../utils/filenameEncoding');
const { assertSupportedImportFile, parseImportFile } = require('./import/parser');

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const UNIT_TYPES = Object.freeze(['enterprise', 'department', 'workshop', 'process', 'equipment']);
const LEDGER_STATUSES = Object.freeze(['active', 'inactive']);
const METER_TYPES = Object.freeze(['electricity', 'gas', 'heat', 'water', 'other']);
// 计量器具导入兼容能源类型常用编码，并归一为 meter_devices 受控类型。
const METER_TYPE_IMPORT_ALIASES = Object.freeze({ natural_gas: 'gas' });
const ONLINE_STATUSES = Object.freeze(['online', 'offline', 'unknown']);
const FLOW_DIRECTIONS = Object.freeze(['input', 'output', 'bidirectional', 'unknown']);
const ORGANIZATION_UNIT_IMPORT_TYPE = 'organization_unit';
const METER_DEVICE_IMPORT_TYPE = 'meter_device';
const UTF8_BOM = '﻿';
const MAX_LEDGER_EXPORT_ROWS = 5000;
const UNIT_EXPORT_FIELDS = Object.freeze([
  { key: 'unitCode', header: '用能单元编码' },
  { key: 'unitName', header: '用能单元名称' },
  { key: 'unitPath', header: '用能单元路径' },
  { key: 'parentCode', header: '父级编码' },
  { key: 'parentName', header: '父级名称' },
  { key: 'unitType', header: '类型' },
  { key: 'area', header: '面积' },
  { key: 'sortOrder', header: '排序' },
  { key: 'status', header: '状态' },
  { key: 'remark', header: '备注' }
]);
const METER_EXPORT_FIELDS = Object.freeze([
  { key: 'meterCode', header: '计量器具编码' },
  { key: 'meterName', header: '计量器具名称' },
  { key: 'meterType', header: '类型' },
  { key: 'energyTypeCode', header: '能源类型编码' },
  { key: 'energyTypeName', header: '能源类型' },
  { key: 'organizationUnitCode', header: '用能单元编码' },
  { key: 'organizationUnitPath', header: '用能单元' },
  { key: 'onlineStatus', header: '在线状态' },
  { key: 'gatewayId', header: '网关ID' },
  { key: 'multiplier', header: '倍率' },
  { key: 'allowManualReading', header: '允许手工抄表' },
  { key: 'flowDirection', header: '流向' },
  { key: 'installLocation', header: '安装位置' },
  { key: 'status', header: '状态' },
  { key: 'remark', header: '备注' }
]);
const UNIT_IMPORT_ALIASES = Object.freeze({
  unitCode: ['unit_code', 'unitCode', '用能单元编码', '组织编码', '编码'],
  unitName: ['unit_name', 'unitName', '用能单元名称', '组织名称', '名称'],
  parentCode: ['parent_code', 'parentCode', '父级编码', '上级编码'],
  parentName: ['parent_name', 'parentName', '父级名称', '上级名称'],
  parentPath: ['parent_path', 'parentPath', '父级路径', '上级路径'],
  unitType: ['unit_type', 'unitType', '类型', '用能单元类型'],
  area: ['area', '面积'],
  sortOrder: ['sort_order', 'sortOrder', '排序', '排序号'],
  status: ['status', '状态'],
  remark: ['remark', '备注', '说明']
});
const METER_IMPORT_ALIASES = Object.freeze({
  meterCode: ['meter_code', 'meterCode', '计量器具编码', '仪表编码', '表计编号', '编码'],
  meterName: ['meter_name', 'meterName', '计量器具名称', '仪表名称', '表计名称', '名称'],
  meterType: ['meter_type', 'meterType', '类型', '计量器具类型'],
  energyTypeCode: ['energy_type_code', 'energyTypeCode', 'energy_type', '能源类型编码', '能源编码'],
  energyTypeName: ['energy_type_name', 'energyTypeName', 'energy_name', '能源类型', '能源名称', '能源'],
  organizationUnitCode: ['organization_unit_code', 'organizationUnitCode', '用能单元编码', '组织编码'],
  organizationUnit: ['organization_unit', 'organizationUnit', '用能单元', '组织单元', '组织', '部门', '车间'],
  onlineStatus: ['online_status', 'onlineStatus', '在线状态'],
  gatewayId: ['gateway_id', 'gatewayId', '网关ID', '网关id'],
  multiplier: ['multiplier', '倍率', '倍乘率', '变比'],
  allowManualReading: ['allow_manual_reading', 'allowManualReading', '允许手工抄表', '允许手抄'],
  flowDirection: ['flow_direction', 'flowDirection', '流向'],
  installLocation: ['install_location', 'installLocation', '安装位置'],
  status: ['status', '状态'],
  remark: ['remark', '备注', '说明']
});

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

function parseNonNegativeNumber(value, fieldName) {
  const text = normalizeText(value);
  if (!text) {
    return null;
  }
  const numberValue = Number(text);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    throw badRequest(`${fieldName} 必须是大于等于 0 的数字。`, { code: 'INVALID_NON_NEGATIVE_NUMBER', fieldName, rawValue: text });
  }
  return numberValue;
}

function parsePositiveNumber(value, fieldName, fallback) {
  const text = normalizeText(value);
  if (!text) {
    return fallback;
  }
  const numberValue = Number(text);
  if (!Number.isFinite(numberValue) || numberValue <= 0) {
    throw badRequest(`${fieldName} 必须是大于 0 的数字。`, { code: 'INVALID_POSITIVE_NUMBER', fieldName, rawValue: text });
  }
  return numberValue;
}

function parseInteger(value, fieldName, fallback = 0) {
  const text = normalizeText(value);
  if (!text) {
    return fallback;
  }
  if (!/^-?\d+$/.test(text)) {
    throw badRequest(`${fieldName} 必须是整数。`, { code: 'INVALID_INTEGER', fieldName, rawValue: text });
  }
  const numberValue = Number.parseInt(text, 10);
  if (!Number.isSafeInteger(numberValue)) {
    throw badRequest(`${fieldName} 必须是安全范围内的整数。`, { code: 'INVALID_INTEGER', fieldName, rawValue: text });
  }
  return numberValue;
}

function parseBooleanFlag(value, fieldName, fallback = 1) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true' || value === '是') {
    return 1;
  }
  if (value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false' || value === '否') {
    return 0;
  }
  throw badRequest(`${fieldName} 只能是 true/false 或 1/0。`, { code: 'INVALID_BOOLEAN_FLAG', fieldName, rawValue: String(value) });
}

function assertWhitelist(value, fieldName, allowedValues) {
  if (!allowedValues.includes(value)) {
    throw badRequest(`${fieldName} 不在允许范围内。`, {
      code: 'UNSUPPORTED_LEDGER_VALUE',
      fieldName,
      rawValue: value,
      allowedValues
    });
  }
}

function buildUnitPath(parentPath, unitName) {
  const cleanName = normalizeText(unitName);
  if (!cleanName) {
    throw badRequest('unitName 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'unitName' });
  }
  const cleanParentPath = normalizeText(parentPath);
  return cleanParentPath ? `${cleanParentPath}/${cleanName}` : cleanName;
}

function normalizeUnitPayload(input = {}, options = {}) {
  const unitCode = normalizeText(firstDefined(input, ['unitCode', 'unit_code']));
  const unitName = normalizeText(firstDefined(input, ['unitName', 'unit_name']));
  const unitType = normalizeText(firstDefined(input, ['unitType', 'unit_type'])) || 'department';
  const status = normalizeText(input.status) || 'active';
  const parentRaw = firstDefined(input, ['parentId', 'parent_id']);
  const parentId = parentRaw === null || parentRaw === '' ? null : parsePositiveInteger(parentRaw, 'parentId');

  if (!unitCode) {
    throw badRequest('unitCode 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'unitCode' });
  }
  if (!unitName) {
    throw badRequest('unitName 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'unitName' });
  }
  assertWhitelist(unitType, 'unitType', UNIT_TYPES);
  assertWhitelist(status, 'status', LEDGER_STATUSES);

  const payload = {
    parentId,
    unitCode,
    unitName,
    unitType,
    area: parseNonNegativeNumber(input.area, 'area'),
    sortOrder: parseInteger(firstDefined(input, ['sortOrder', 'sort_order']), 'sortOrder', 0),
    status,
    remark: normalizeText(input.remark)
  };

  if (options.partial) {
    return payload;
  }
  return payload;
}

/** 将计量器具导入中的能源编码别名归一为受控器具类型。 */
function normalizeMeterTypeImportValue(value) {
  const normalizedValue = normalizeText(value);
  return Object.prototype.hasOwnProperty.call(METER_TYPE_IMPORT_ALIASES, normalizedValue)
    ? METER_TYPE_IMPORT_ALIASES[normalizedValue]
    : normalizedValue;
}

function normalizeMeterPayload(input = {}) {
  const meterCode = normalizeText(firstDefined(input, ['meterCode', 'meter_code']));
  const meterName = normalizeText(firstDefined(input, ['meterName', 'meter_name']));
  const meterType = normalizeText(firstDefined(input, ['meterType', 'meter_type'])) || 'other';
  const energyTypeId = parsePositiveInteger(firstDefined(input, ['energyTypeId', 'energy_type_id']), 'energyTypeId', { required: true });
  const organizationUnitId = parsePositiveInteger(firstDefined(input, ['organizationUnitId', 'organization_unit_id']), 'organizationUnitId', { required: true });
  const onlineStatus = normalizeText(firstDefined(input, ['onlineStatus', 'online_status'])) || 'unknown';
  const flowDirection = normalizeText(firstDefined(input, ['flowDirection', 'flow_direction'])) || 'unknown';
  const status = normalizeText(input.status) || 'active';

  if (!meterCode) {
    throw badRequest('meterCode 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'meterCode' });
  }
  if (!meterName) {
    throw badRequest('meterName 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'meterName' });
  }
  if (!energyTypeId) {
    throw badRequest('energyTypeId 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'energyTypeId' });
  }
  if (!organizationUnitId) {
    throw badRequest('organizationUnitId 为必填项。', { code: 'REQUIRED_FIELD_MISSING', fieldName: 'organizationUnitId' });
  }
  assertWhitelist(meterType, 'meterType', METER_TYPES);
  assertWhitelist(onlineStatus, 'onlineStatus', ONLINE_STATUSES);
  assertWhitelist(flowDirection, 'flowDirection', FLOW_DIRECTIONS);
  assertWhitelist(status, 'status', LEDGER_STATUSES);

  return {
    meterCode,
    meterName,
    meterType,
    energyTypeId,
    organizationUnitId,
    onlineStatus,
    gatewayId: normalizeText(firstDefined(input, ['gatewayId', 'gateway_id'])),
    multiplier: parsePositiveNumber(input.multiplier, 'multiplier', 1),
    allowManualReading: parseBooleanFlag(firstDefined(input, ['allowManualReading', 'allow_manual_reading']), 'allowManualReading', 1),
    flowDirection,
    installLocation: normalizeText(firstDefined(input, ['installLocation', 'install_location'])),
    status,
    remark: normalizeText(input.remark)
  };
}

function normalizePagination(query = {}, defaults = {}) {
  const page = parsePositiveInteger(query.page, 'page') || 1;
  const requestedPageSize = parsePositiveInteger(query.pageSize, 'pageSize') || defaults.pageSize || DEFAULT_PAGE_SIZE;
  const pageSize = Math.min(requestedPageSize, defaults.maxPageSize || MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function createDeactivationResult(row, references = {}) {
  return {
    id: row.id,
    status: 'inactive',
    deactivated: true,
    referenceCounts: {
      energyRecords: Number(references.energyRecords || 0),
      meterDevices: Number(references.meterDevices || 0)
    }
  };
}

function mapUnitRow(row) {
  if (!row) {
    return row;
  }
  return {
    id: row.id,
    parentId: row.parentId,
    unitCode: row.unitCode,
    unitName: row.unitName,
    unitPath: row.unitPath,
    unitType: row.unitType,
    area: row.area,
    sortOrder: row.sortOrder,
    status: row.status,
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function mapMeterRow(row) {
  if (!row) {
    return row;
  }
  return {
    id: row.id,
    meterCode: row.meterCode,
    meterName: row.meterName,
    meterType: row.meterType,
    energyTypeId: row.energyTypeId,
    energyTypeCode: row.energyTypeCode,
    energyTypeName: row.energyTypeName,
    organizationUnitId: row.organizationUnitId,
    organizationUnitName: row.organizationUnitName,
    organizationUnitPath: row.organizationUnitPath,
    onlineStatus: row.onlineStatus,
    gatewayId: row.gatewayId,
    multiplier: row.multiplier,
    allowManualReading: row.allowManualReading,
    flowDirection: row.flowDirection,
    installLocation: row.installLocation,
    status: row.status,
    remark: row.remark,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function getUnitById(db, unitId, options = {}) {
  const row = db.prepare(
    `SELECT
       id,
       parent_id AS parentId,
       unit_code AS unitCode,
       unit_name AS unitName,
       unit_path AS unitPath,
       unit_type AS unitType,
       area,
       sort_order AS sortOrder,
       status,
       remark,
       created_at AS createdAt,
       updated_at AS updatedAt
     FROM organization_units
     WHERE id = ?`
  ).get(unitId);
  if (!row && !options.optional) {
    throw notFound('用能单元不存在。', { id: unitId });
  }
  return row;
}

function ensureUnitCodeUnique(db, unitCode, excludeId) {
  const existing = db.prepare('SELECT id FROM organization_units WHERE unit_code = ? AND (? IS NULL OR id <> ?) LIMIT 1').get(unitCode, excludeId || null, excludeId || null);
  if (existing) {
    throw badRequest('用能单元编码已存在。', { code: 'DUPLICATE_UNIT_CODE', fieldName: 'unitCode', unitCode });
  }
}

function ensureNoUnitCycle(db, unitId, parentId) {
  if (!parentId) {
    return;
  }
  if (unitId === parentId) {
    throw badRequest('父级用能单元不能选择自身。', { code: 'UNIT_PARENT_SELF_REFERENCE', unitId, parentId });
  }

  let current = getUnitById(db, parentId);
  const visited = new Set();
  while (current) {
    if (visited.has(current.id)) {
      throw badRequest('用能单元层级存在循环引用。', { code: 'UNIT_PARENT_CYCLE', unitId, parentId });
    }
    visited.add(current.id);
    if (current.id === unitId) {
      throw badRequest('父级用能单元不能选择自身或自身下级。', { code: 'UNIT_PARENT_DESCENDANT', unitId, parentId });
    }
    current = current.parentId ? getUnitById(db, current.parentId, { optional: true }) : null;
  }
}

function rebuildDescendantUnitPaths(db, parentUnit) {
  const children = db.prepare(
    `SELECT id, unit_name AS unitName, unit_path AS unitPath
     FROM organization_units
     WHERE parent_id = ?
     ORDER BY sort_order ASC, id ASC`
  ).all(parentUnit.id);

  children.forEach((child) => {
    const unitPath = buildUnitPath(parentUnit.unitPath, child.unitName);
    db.prepare("UPDATE organization_units SET unit_path = ?, updated_at = ? WHERE id = ?").run(unitPath, getNow(), child.id);
    rebuildDescendantUnitPaths(db, { ...child, unitPath });
  });
}

function listOrganizationUnits(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { pageSize: 100, maxPageSize: 500 });
  const where = [];
  const params = {};
  const status = normalizeText(query.status);
  if (status) {
    assertWhitelist(status, 'status', LEDGER_STATUSES);
    where.push('ou.status = @status');
    params.status = status;
  }
  const unitType = normalizeText(firstDefined(query, ['unitType', 'unit_type']));
  if (unitType) {
    assertWhitelist(unitType, 'unitType', UNIT_TYPES);
    where.push('ou.unit_type = @unitType');
    params.unitType = unitType;
  }
  const parentRaw = firstDefined(query, ['parentId', 'parent_id']);
  if (parentRaw !== undefined && parentRaw !== null && String(parentRaw).trim() !== '') {
    const parentId = parsePositiveInteger(parentRaw, 'parentId');
    where.push('ou.parent_id = @parentId');
    params.parentId = parentId;
  }
  const keyword = normalizeText(query.keyword || query.search);
  if (keyword) {
    where.push('(ou.unit_code LIKE @keyword OR ou.unit_name LIKE @keyword OR ou.unit_path LIKE @keyword)');
    params.keyword = `%${keyword}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = openDatabase();
  try {
    const total = db.prepare(`SELECT COUNT(*) AS total FROM organization_units ou ${whereSql}`).get(params).total;
    const rows = db.prepare(
      `SELECT
         ou.id,
         ou.parent_id AS parentId,
         ou.unit_code AS unitCode,
         ou.unit_name AS unitName,
         ou.unit_path AS unitPath,
         ou.unit_type AS unitType,
         ou.area,
         ou.sort_order AS sortOrder,
         ou.status,
         ou.remark,
         ou.created_at AS createdAt,
         ou.updated_at AS updatedAt
       FROM organization_units ou
       ${whereSql}
       ORDER BY ou.unit_path ASC, ou.sort_order ASC, ou.id ASC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize, offset }).map(mapUnitRow);
    return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
  }
}

function createOrganizationUnit(input = {}) {
  const payload = normalizeUnitPayload(input);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      ensureUnitCodeUnique(db, payload.unitCode);
      const parent = payload.parentId ? getUnitById(db, payload.parentId) : null;
      if (parent && parent.status !== 'active') {
        throw badRequest('父级用能单元必须为 active 状态。', { code: 'INACTIVE_PARENT_UNIT', parentId: payload.parentId });
      }
      const unitPath = buildUnitPath(parent ? parent.unitPath : null, payload.unitName);
      const now = getNow();
      const result = db.prepare(
        `INSERT INTO organization_units (
           parent_id, unit_code, unit_name, unit_path, unit_type, area, sort_order, status, remark, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(payload.parentId || null, payload.unitCode, payload.unitName, unitPath, payload.unitType, payload.area, payload.sortOrder, payload.status, payload.remark, now, now);
      return mapUnitRow(getUnitById(db, result.lastInsertRowid));
    });
    return transaction();
  } finally {
    db.close();
  }
}

function updateOrganizationUnit(unitId, input = {}) {
  const id = parsePositiveInteger(unitId, 'id');
  const payload = normalizeUnitPayload(input, { partial: true });
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = getUnitById(db, id);
      ensureUnitCodeUnique(db, payload.unitCode, id);
      ensureNoUnitCycle(db, id, payload.parentId);
      const parent = payload.parentId ? getUnitById(db, payload.parentId) : null;
      if (parent && parent.status !== 'active') {
        throw badRequest('父级用能单元必须为 active 状态。', { code: 'INACTIVE_PARENT_UNIT', parentId: payload.parentId });
      }
      const unitPath = buildUnitPath(parent ? parent.unitPath : null, payload.unitName);
      const now = getNow();
      db.prepare(
        `UPDATE organization_units
         SET parent_id = ?, unit_code = ?, unit_name = ?, unit_path = ?, unit_type = ?, area = ?, sort_order = ?, status = ?, remark = ?, updated_at = ?
         WHERE id = ?`
      ).run(payload.parentId || null, payload.unitCode, payload.unitName, unitPath, payload.unitType, payload.area, payload.sortOrder, payload.status, payload.remark, now, id);
      const updated = getUnitById(db, id);
      if (existing.unitPath !== updated.unitPath) {
        rebuildDescendantUnitPaths(db, updated);
      }
      return mapUnitRow(getUnitById(db, id));
    });
    return transaction();
  } finally {
    db.close();
  }
}

function deactivateOrganizationUnit(unitId) {
  const id = parsePositiveInteger(unitId, 'id');
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = getUnitById(db, id);
      const references = {
        energyRecords: db.prepare("SELECT COUNT(*) AS total FROM energy_records WHERE organization_unit_id = ? AND record_status = 'active'").get(id).total,
        meterDevices: db.prepare("SELECT COUNT(*) AS total FROM meter_devices WHERE organization_unit_id = ? AND status = 'active'").get(id).total
      };
      db.prepare("UPDATE organization_units SET status = 'inactive', updated_at = ? WHERE id = ?").run(getNow(), id);
      return createDeactivationResult(existing, references);
    });
    return transaction();
  } finally {
    db.close();
  }
}

function ensureEnergyTypeExists(db, energyTypeId) {
  const row = db.prepare('SELECT id, code, name FROM energy_types WHERE id = ? AND is_active = 1').get(energyTypeId);
  if (!row) {
    throw badRequest('能源类型不存在或未启用。', { code: 'UNKNOWN_ENERGY_TYPE_ID', energyTypeId });
  }
  return row;
}

function ensureMeterCodeUnique(db, meterCode, excludeId) {
  const existing = db.prepare('SELECT id FROM meter_devices WHERE meter_code = ? AND (? IS NULL OR id <> ?) LIMIT 1').get(meterCode, excludeId || null, excludeId || null);
  if (existing) {
    throw badRequest('计量器具编码已存在。', { code: 'DUPLICATE_METER_CODE', fieldName: 'meterCode', meterCode });
  }
}

function getMeterById(db, meterId, options = {}) {
  const row = db.prepare(
    `SELECT
       md.id,
       md.meter_code AS meterCode,
       md.meter_name AS meterName,
       md.meter_type AS meterType,
       md.energy_type_id AS energyTypeId,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       md.organization_unit_id AS organizationUnitId,
       ou.unit_name AS organizationUnitName,
       ou.unit_path AS organizationUnitPath,
       md.online_status AS onlineStatus,
       md.gateway_id AS gatewayId,
       md.multiplier,
       md.allow_manual_reading AS allowManualReading,
       md.flow_direction AS flowDirection,
       md.install_location AS installLocation,
       md.status,
       md.remark,
       md.created_at AS createdAt,
       md.updated_at AS updatedAt
     FROM meter_devices md
     JOIN energy_types et ON et.id = md.energy_type_id
     LEFT JOIN organization_units ou ON ou.id = md.organization_unit_id
     WHERE md.id = ?`
  ).get(meterId);
  if (!row && !options.optional) {
    throw notFound('计量器具不存在。', { id: meterId });
  }
  return row;
}

function listMeters(query = {}) {
  const { page, pageSize, offset } = normalizePagination(query, { pageSize: 50, maxPageSize: 500 });
  const where = [];
  const params = {};
  const status = normalizeText(query.status);
  if (status) {
    assertWhitelist(status, 'status', LEDGER_STATUSES);
    where.push('md.status = @status');
    params.status = status;
  }
  const meterType = normalizeText(firstDefined(query, ['meterType', 'meter_type']));
  if (meterType) {
    assertWhitelist(meterType, 'meterType', METER_TYPES);
    where.push('md.meter_type = @meterType');
    params.meterType = meterType;
  }
  const energyTypeId = parsePositiveInteger(firstDefined(query, ['energyTypeId', 'energy_type_id']), 'energyTypeId');
  if (energyTypeId) {
    where.push('md.energy_type_id = @energyTypeId');
    params.energyTypeId = energyTypeId;
  }
  const organizationUnitId = parsePositiveInteger(firstDefined(query, ['organizationUnitId', 'organization_unit_id']), 'organizationUnitId');
  if (organizationUnitId) {
    where.push('md.organization_unit_id = @organizationUnitId');
    params.organizationUnitId = organizationUnitId;
  }
  const onlineStatus = normalizeText(firstDefined(query, ['onlineStatus', 'online_status']));
  if (onlineStatus) {
    assertWhitelist(onlineStatus, 'onlineStatus', ONLINE_STATUSES);
    where.push('md.online_status = @onlineStatus');
    params.onlineStatus = onlineStatus;
  }
  const keyword = normalizeText(query.keyword || query.search);
  if (keyword) {
    where.push('(md.meter_code LIKE @keyword OR md.meter_name LIKE @keyword OR ou.unit_path LIKE @keyword)');
    params.keyword = `%${keyword}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const db = openDatabase();
  try {
    const total = db.prepare(
      `SELECT COUNT(*) AS total
       FROM meter_devices md
       JOIN energy_types et ON et.id = md.energy_type_id
       LEFT JOIN organization_units ou ON ou.id = md.organization_unit_id
       ${whereSql}`
    ).get(params).total;
    const rows = db.prepare(
      `SELECT
         md.id,
         md.meter_code AS meterCode,
         md.meter_name AS meterName,
         md.meter_type AS meterType,
         md.energy_type_id AS energyTypeId,
         et.code AS energyTypeCode,
         et.name AS energyTypeName,
         md.organization_unit_id AS organizationUnitId,
         ou.unit_name AS organizationUnitName,
         ou.unit_path AS organizationUnitPath,
         md.online_status AS onlineStatus,
         md.gateway_id AS gatewayId,
         md.multiplier,
         md.allow_manual_reading AS allowManualReading,
         md.flow_direction AS flowDirection,
         md.install_location AS installLocation,
         md.status,
         md.remark,
         md.created_at AS createdAt,
         md.updated_at AS updatedAt
       FROM meter_devices md
       JOIN energy_types et ON et.id = md.energy_type_id
       LEFT JOIN organization_units ou ON ou.id = md.organization_unit_id
       ${whereSql}
       ORDER BY md.status ASC, md.meter_code ASC, md.id ASC
       LIMIT @pageSize OFFSET @offset`
    ).all({ ...params, pageSize, offset }).map(mapMeterRow);
    return { rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } };
  } finally {
    db.close();
  }
}

function createMeter(input = {}) {
  const payload = normalizeMeterPayload(input);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      ensureMeterCodeUnique(db, payload.meterCode);
      ensureEnergyTypeExists(db, payload.energyTypeId);
      const unit = getUnitById(db, payload.organizationUnitId);
      if (unit.status !== 'active') {
        throw badRequest('所属用能单元必须为 active 状态。', { code: 'INACTIVE_ORGANIZATION_UNIT', organizationUnitId: payload.organizationUnitId });
      }
      const now = getNow();
      const result = db.prepare(
        `INSERT INTO meter_devices (
           meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, online_status, gateway_id, multiplier,
           allow_manual_reading, flow_direction, install_location, status, remark, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(payload.meterCode, payload.meterName, payload.meterType, payload.energyTypeId, payload.organizationUnitId, payload.onlineStatus, payload.gatewayId, payload.multiplier, payload.allowManualReading, payload.flowDirection, payload.installLocation, payload.status, payload.remark, now, now);
      return mapMeterRow(getMeterById(db, result.lastInsertRowid));
    });
    return transaction();
  } finally {
    db.close();
  }
}

function updateMeter(meterId, input = {}) {
  const id = parsePositiveInteger(meterId, 'id');
  const payload = normalizeMeterPayload(input);
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = getMeterById(db, id);
      ensureMeterCodeUnique(db, payload.meterCode, id);
      ensureEnergyTypeExists(db, payload.energyTypeId);
      const unit = getUnitById(db, payload.organizationUnitId);
      if (unit.status !== 'active') {
        throw badRequest('所属用能单元必须为 active 状态。', { code: 'INACTIVE_ORGANIZATION_UNIT', organizationUnitId: payload.organizationUnitId });
      }
      const referenceCount = db.prepare("SELECT COUNT(*) AS total FROM energy_records WHERE meter_device_id = ? AND record_status = 'active'").get(id).total;
      if (referenceCount > 0 && Number(existing.energyTypeId) !== Number(payload.energyTypeId)) {
        throw badRequest('已被能耗记录引用的计量器具不能修改能源类型。', { code: 'METER_ENERGY_TYPE_REFERENCED', meterId: id, referenceCount });
      }
      const now = getNow();
      db.prepare(
        `UPDATE meter_devices
         SET meter_code = ?, meter_name = ?, meter_type = ?, energy_type_id = ?, organization_unit_id = ?, online_status = ?, gateway_id = ?,
             multiplier = ?, allow_manual_reading = ?, flow_direction = ?, install_location = ?, status = ?, remark = ?, updated_at = ?
         WHERE id = ?`
      ).run(payload.meterCode, payload.meterName, payload.meterType, payload.energyTypeId, payload.organizationUnitId, payload.onlineStatus, payload.gatewayId, payload.multiplier, payload.allowManualReading, payload.flowDirection, payload.installLocation, payload.status, payload.remark, now, id);
      return mapMeterRow(getMeterById(db, id));
    });
    return transaction();
  } finally {
    db.close();
  }
}

function deactivateMeter(meterId) {
  const id = parsePositiveInteger(meterId, 'id');
  const db = openDatabase();
  try {
    const transaction = db.transaction(() => {
      const existing = getMeterById(db, id);
      const references = {
        energyRecords: db.prepare("SELECT COUNT(*) AS total FROM energy_records WHERE meter_device_id = ? AND record_status = 'active'").get(id).total,
        meterDevices: 0
      };
      db.prepare("UPDATE meter_devices SET status = 'inactive', updated_at = ? WHERE id = ?").run(getNow(), id);
      return createDeactivationResult(existing, references);
    });
    return transaction();
  } finally {
    db.close();
  }
}

function buildLedgerIndexes(input = {}) {
  const orgByPath = new Map();
  const orgByCode = new Map();
  const orgByName = new Map();
  (input.organizationUnits || []).forEach((unit) => {
    if (!unit || unit.status !== 'active') {
      return;
    }
    if (unit.unitPath) orgByPath.set(String(unit.unitPath), unit);
    if (unit.unitCode) orgByCode.set(String(unit.unitCode), unit);
    if (unit.unitName) orgByName.set(String(unit.unitName), unit);
  });

  const metersByCode = new Map();
  const metersByOrgAndName = new Map();
  (input.meterDevices || []).forEach((meter) => {
    if (!meter || meter.status !== 'active') {
      return;
    }
    if (meter.meterCode) metersByCode.set(String(meter.meterCode), meter);
    if (meter.organizationUnitId && meter.meterName) {
      metersByOrgAndName.set(`${meter.organizationUnitId} ${meter.meterName}`, meter);
    }
  });

  return { orgByPath, orgByCode, orgByName, metersByCode, metersByOrgAndName };
}

function findLedgerAssociationsForImportRecord(record, indexes) {
  if (!record || !indexes) {
    return { organizationUnitId: null, meterDeviceId: null };
  }
  const organizationText = normalizeText(record.organization);
  const meterText = normalizeText(record.meterCode);
  let matchedUnit = null;
  if (organizationText) {
    matchedUnit = indexes.orgByPath.get(organizationText) || indexes.orgByCode.get(organizationText) || indexes.orgByName.get(organizationText) || null;
  }

  let matchedMeter = null;
  if (meterText) {
    const byCode = indexes.metersByCode.get(meterText);
    if (
      byCode &&
      Number(byCode.energyTypeId) === Number(record.energyTypeId) &&
      (!matchedUnit || Number(byCode.organizationUnitId) === Number(matchedUnit.id))
    ) {
      matchedMeter = byCode;
    }
    if (!matchedMeter && matchedUnit) {
      const byOrgAndName = indexes.metersByOrgAndName.get(`${matchedUnit.id} ${meterText}`);
      if (byOrgAndName && Number(byOrgAndName.energyTypeId) === Number(record.energyTypeId)) {
        matchedMeter = byOrgAndName;
      }
    }
  }

  return {
    organizationUnitId: matchedUnit ? matchedUnit.id : null,
    meterDeviceId: matchedMeter ? matchedMeter.id : null
  };
}

function loadActiveLedgerIndexes(db) {
  const organizationUnits = db.prepare(
    `SELECT id, unit_code AS unitCode, unit_name AS unitName, unit_path AS unitPath, status
     FROM organization_units
     WHERE status = 'active'`
  ).all();
  const meterDevices = db.prepare(
    `SELECT id, meter_code AS meterCode, meter_name AS meterName, energy_type_id AS energyTypeId, organization_unit_id AS organizationUnitId, status
     FROM meter_devices
     WHERE status = 'active'`
  ).all();
  return buildLedgerIndexes({ organizationUnits, meterDevices });
}

function pushMatch(map, key, value) {
  const text = normalizeText(key);
  if (!text) return;
  const matches = map.get(text) || [];
  matches.push(value);
  map.set(text, matches);
}

function buildLedgerBackfillPreviewIndexes(input = {}) {
  const unitsByPath = new Map();
  const unitsByCode = new Map();
  const unitsByName = new Map();
  (input.organizationUnits || []).forEach((unit) => {
    if (!unit || unit.status !== 'active') return;
    pushMatch(unitsByPath, unit.unitPath, unit);
    pushMatch(unitsByCode, unit.unitCode, unit);
    pushMatch(unitsByName, unit.unitName, unit);
  });

  const metersByCode = new Map();
  const metersByName = new Map();
  const metersByOrgAndName = new Map();
  (input.meterDevices || []).forEach((meter) => {
    if (!meter || meter.status !== 'active') return;
    pushMatch(metersByCode, meter.meterCode, meter);
    pushMatch(metersByName, meter.meterName, meter);
    if (meter.organizationUnitId && meter.meterName) {
      pushMatch(metersByOrgAndName, `${meter.organizationUnitId} ${meter.meterName}`, meter);
    }
  });

  const metersById = new Map();
  (input.meterDevices || []).forEach((meter) => {
    if (meter && meter.id) metersById.set(Number(meter.id), meter);
  });

  const unitsById = new Map();
  (input.organizationUnits || []).forEach((unit) => {
    if (unit && unit.id) unitsById.set(Number(unit.id), unit);
  });

  return { unitsByPath, unitsByCode, unitsByName, unitsById, metersByCode, metersByName, metersByOrgAndName, metersById };
}

function loadLedgerBackfillPreviewIndexes(db) {
  const organizationUnits = db.prepare(
    `SELECT id, unit_code AS unitCode, unit_name AS unitName, unit_path AS unitPath, status
     FROM organization_units`
  ).all();
  const meterDevices = db.prepare(
    `SELECT
       md.id,
       md.meter_code AS meterCode,
       md.meter_name AS meterName,
       md.energy_type_id AS energyTypeId,
       et.code AS energyTypeCode,
       et.name AS energyTypeName,
       md.organization_unit_id AS organizationUnitId,
       ou.unit_code AS organizationUnitCode,
       ou.unit_name AS organizationUnitName,
       ou.unit_path AS organizationUnitPath,
       md.status
     FROM meter_devices md
     JOIN energy_types et ON et.id = md.energy_type_id
     LEFT JOIN organization_units ou ON ou.id = md.organization_unit_id`
  ).all();
  return buildLedgerBackfillPreviewIndexes({ organizationUnits, meterDevices });
}

function compactLedgerCandidate(row, type) {
  if (!row) return null;
  if (type === 'meter') {
    return {
      id: row.id,
      meterCode: row.meterCode,
      meterName: row.meterName,
      energyTypeId: row.energyTypeId,
      energyTypeCode: row.energyTypeCode,
      organizationUnitId: row.organizationUnitId,
      organizationUnitCode: row.organizationUnitCode,
      organizationUnitName: row.organizationUnitName,
      organizationUnitPath: row.organizationUnitPath
    };
  }
  return {
    id: row.id,
    unitCode: row.unitCode,
    unitName: row.unitName,
    unitPath: row.unitPath
  };
}

function chooseUniqueMatch(matches = [], context = {}) {
  const filtered = matches.filter((match) => {
    if (!match || match.status !== 'active') return false;
    if (context.energyTypeId && Number(match.energyTypeId) !== Number(context.energyTypeId)) return false;
    if (context.organizationUnitId && Number(match.organizationUnitId) !== Number(context.organizationUnitId)) return false;
    return true;
  });
  if (filtered.length === 0) return { status: 'missing', matches: [] };
  if (filtered.length > 1) return { status: 'ambiguous', matches: filtered };
  return { status: 'matched', match: filtered[0], matches: filtered };
}

function resolveOrganizationUnitBackfillCandidate(record, indexes) {
  const sources = [
    { field: 'organization', value: record.organization },
    { field: 'site', value: record.site },
    { field: 'department', value: record.department }
  ].filter((source) => normalizeText(source.value));

  if (record.organizationUnitId) {
    const existing = indexes.unitsById.get(Number(record.organizationUnitId));
    return existing && existing.status === 'active'
      ? { status: 'existing', match: existing, sources: [{ field: 'organization_unit_id', value: record.organizationUnitId }] }
      : { status: 'blocked', reasonCode: 'EXISTING_ORGANIZATION_UNIT_NOT_ACTIVE', reason: '已有关联的用能单元不存在或未启用。', sources: [{ field: 'organization_unit_id', value: record.organizationUnitId }] };
  }

  if (sources.length === 0) {
    return { status: 'missing', reasonCode: 'NO_ORGANIZATION_SOURCE', reason: 'energy_records 缺少可用于匹配用能单元的 organization/site/department 原始字段。', sources: [] };
  }

  const matched = [];
  const ambiguous = [];
  sources.forEach((source) => {
    const text = normalizeText(source.value);
    const pathMatch = chooseUniqueMatch(indexes.unitsByPath.get(text) || []);
    const codeMatch = pathMatch.status === 'matched' ? pathMatch : chooseUniqueMatch(indexes.unitsByCode.get(text) || []);
    const nameMatch = codeMatch.status === 'matched' ? codeMatch : chooseUniqueMatch(indexes.unitsByName.get(text) || []);
    const result = nameMatch;
    if (result.status === 'matched') matched.push({ source, match: result.match });
    if (result.status === 'ambiguous') ambiguous.push({ source, matches: result.matches });
  });

  if (ambiguous.length > 0) {
    return { status: 'ambiguous', reasonCode: 'AMBIGUOUS_ORGANIZATION_UNIT', reason: '用能单元名称匹配到多条 active 记录，请用唯一编码或完整路径导入后再回填。', sources, ambiguous };
  }
  if (matched.length === 0) {
    return { status: 'missing', reasonCode: 'ORGANIZATION_UNIT_NOT_FOUND', reason: '未能按 organization/site/department 匹配到 active 用能单元。', sources };
  }
  const uniqueIds = new Set(matched.map((item) => Number(item.match.id)));
  if (uniqueIds.size > 1) {
    return { status: 'ambiguous', reasonCode: 'ORGANIZATION_FIELDS_CONFLICT', reason: 'organization/site/department 字段匹配到不同用能单元，不能确定唯一回填目标。', sources, matches: matched };
  }
  return { status: 'matched', match: matched[0].match, sources: matched.map((item) => item.source) };
}

function resolveMeterBackfillCandidate(record, indexes, organizationUnitId) {
  const meterText = normalizeText(record.meterCode);

  if (record.meterDeviceId) {
    const existing = indexes.metersById.get(Number(record.meterDeviceId));
    if (!existing || existing.status !== 'active') {
      return { status: 'blocked', reasonCode: 'EXISTING_METER_NOT_ACTIVE', reason: '已有关联的计量器具不存在或未启用。' };
    }
    if (Number(existing.energyTypeId) !== Number(record.energyTypeId)) {
      return { status: 'blocked', reasonCode: 'EXISTING_METER_ENERGY_TYPE_MISMATCH', reason: '已有关联的计量器具能源类型与能耗记录不一致。', match: existing };
    }
    return { status: 'existing', match: existing };
  }

  if (!meterText) {
    return { status: 'missing', reasonCode: 'NO_METER_SOURCE', reason: 'energy_records 缺少可用于匹配计量器具的 meter_code 原始字段。' };
  }

  const byCode = chooseUniqueMatch(indexes.metersByCode.get(meterText) || [], { energyTypeId: record.energyTypeId });
  if (byCode.status === 'ambiguous') {
    return { status: 'ambiguous', reasonCode: 'AMBIGUOUS_METER_CODE', reason: 'meter_code 匹配到多条同能源类型 active 计量器具，不能确定唯一回填目标。', matches: byCode.matches };
  }
  if (byCode.status === 'matched') {
    if (organizationUnitId && Number(byCode.match.organizationUnitId) !== Number(organizationUnitId)) {
      return { status: 'blocked', reasonCode: 'METER_ORGANIZATION_CONFLICT', reason: '计量器具归属用能单元与能耗记录候选用能单元不一致。', match: byCode.match };
    }
    return { status: 'matched', match: byCode.match, sourceField: 'meter_code' };
  }

  const nameMatches = organizationUnitId
    ? indexes.metersByOrgAndName.get(`${organizationUnitId} ${meterText}`) || []
    : indexes.metersByName.get(meterText) || [];
  const byName = chooseUniqueMatch(nameMatches, { energyTypeId: record.energyTypeId, organizationUnitId });
  if (byName.status === 'ambiguous') {
    return { status: 'ambiguous', reasonCode: 'AMBIGUOUS_METER_NAME', reason: 'meter_code 原始值按计量器具名称匹配到多条同能源类型 active 记录，不能确定唯一回填目标。', matches: byName.matches };
  }
  if (byName.status === 'matched') {
    return { status: 'matched', match: byName.match, sourceField: organizationUnitId ? 'organization_unit_id+meter_code_as_name' : 'meter_code_as_name' };
  }

  return { status: 'missing', reasonCode: 'METER_NOT_FOUND', reason: '未能按 meter_code 编码或名称匹配到同能源类型 active 计量器具。' };
}

function buildEnergyRecordLedgerBackfillPreview(record, indexes) {
  const organization = resolveOrganizationUnitBackfillCandidate(record, indexes);
  const organizationUnitIdForMeter = organization.match ? organization.match.id : record.organizationUnitId;
  const meter = resolveMeterBackfillCandidate(record, indexes, organizationUnitIdForMeter);
  const reasons = [];
  const candidate = { organizationUnitId: null, meterDeviceId: null };
  let status = 'missing';

  if (organization.status === 'blocked' || meter.status === 'blocked') {
    status = 'blocked';
  } else if (organization.status === 'ambiguous' || meter.status === 'ambiguous') {
    status = 'ambiguous';
  } else {
    const matchedOrganization = organization.match || (meter.match && indexes.unitsById.get(Number(meter.match.organizationUnitId))) || null;
    const matchedMeter = meter.match || null;
    if (matchedMeter && matchedOrganization && Number(matchedMeter.organizationUnitId) !== Number(matchedOrganization.id)) {
      status = 'blocked';
      reasons.push({ code: 'METER_ORGANIZATION_CONFLICT', message: '计量器具归属用能单元与候选用能单元不一致。' });
    } else {
      if (!record.organizationUnitId && matchedOrganization) candidate.organizationUnitId = matchedOrganization.id;
      if (!record.meterDeviceId && matchedMeter) candidate.meterDeviceId = matchedMeter.id;
      if (candidate.meterDeviceId) status = 'candidate-by-meter';
      else if (candidate.organizationUnitId) status = 'candidate-by-organization';
      else if (record.organizationUnitId && record.meterDeviceId) status = 'already-linked';
      else if (record.organizationUnitId || record.meterDeviceId) status = 'already-partial';
    }
  }

  [organization, meter].forEach((result) => {
    if (result.reasonCode) reasons.push({ code: result.reasonCode, message: result.reason });
  });

  const wouldUpdate = Boolean(candidate.organizationUnitId || candidate.meterDeviceId) && !['blocked', 'ambiguous'].includes(status);
  return {
    recordId: record.id,
    status,
    wouldUpdate,
    candidate,
    existing: {
      organizationUnitId: record.organizationUnitId || null,
      meterDeviceId: record.meterDeviceId || null
    },
    source: {
      energyTypeId: record.energyTypeId,
      energyTypeCode: record.energyTypeCode,
      energyTypeName: record.energyTypeName || null,
      normalizedMonth: record.normalizedMonth || null,
      organization: record.organization || null,
      site: record.site || null,
      department: record.department || null,
      meterCode: record.meterCode || null
    },
    matched: {
      organizationUnit: compactLedgerCandidate(organization.match || (meter.match && indexes.unitsById.get(Number(meter.match.organizationUnitId))), 'organization'),
      meterDevice: compactLedgerCandidate(meter.match, 'meter')
    },
    reasons
  };
}

function normalizeHeaderName(value) {
  return String(value || '').trim().replace(/[\s_\-\/\\:：()（）]/g, '').toLowerCase();
}

function canonicalImportFieldName(header, aliases) {
  const normalized = normalizeHeaderName(header);
  for (const [field, fieldAliases] of Object.entries(aliases)) {
    if (fieldAliases.map(normalizeHeaderName).includes(normalized)) return field;
  }
  return null;
}

function mapLedgerImportFields(row = {}, aliases) {
  const mapped = {};
  const fieldMapping = {};
  Object.entries(row || {}).forEach(([header, value]) => {
    const field = canonicalImportFieldName(header, aliases);
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

function pushToMultiMap(map, key, value) {
  const normalizedKey = normalizeText(key);
  if (!normalizedKey) return;
  const list = map.get(normalizedKey) || [];
  list.push(value);
  map.set(normalizedKey, list);
}

function resolveUniqueName(map, rawValue, rowNumber, fieldName, errorCode, errorReason, errors) {
  const text = normalizeText(rawValue);
  if (!text) return null;
  const matches = map.get(text) || [];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    errors.push(createImportError(rowNumber, fieldName, rawValue, errorCode, errorReason));
    return null;
  }
  return matches[0];
}

function buildLedgerImportIndexes(input = {}) {
  const activeUnitsByCode = new Map();
  const activeUnitsByPath = new Map();
  const activeUnitsByName = new Map();
  const allUnitCodes = new Set();
  (input.organizationUnits || []).forEach((unit) => {
    if (unit.unitCode) allUnitCodes.add(String(unit.unitCode));
    if (unit.status !== 'active') return;
    if (unit.unitCode) activeUnitsByCode.set(String(unit.unitCode), unit);
    if (unit.unitPath) activeUnitsByPath.set(String(unit.unitPath), unit);
    pushToMultiMap(activeUnitsByName, unit.unitName, unit);
  });

  const allMeterCodes = new Set();
  (input.meterDevices || []).forEach((meter) => {
    if (meter.meterCode) allMeterCodes.add(String(meter.meterCode));
  });

  const energyTypesByCode = new Map();
  const energyTypesByName = new Map();
  (input.energyTypes || []).forEach((energyType) => {
    if (energyType.code) energyTypesByCode.set(String(energyType.code), energyType);
    pushToMultiMap(energyTypesByName, energyType.name, energyType);
  });

  return { activeUnitsByCode, activeUnitsByPath, activeUnitsByName, allUnitCodes, allMeterCodes, energyTypesByCode, energyTypesByName };
}

function loadLedgerImportIndexes(db) {
  return buildLedgerImportIndexes({
    organizationUnits: db.prepare('SELECT id, parent_id AS parentId, unit_code AS unitCode, unit_name AS unitName, unit_path AS unitPath, status FROM organization_units').all(),
    meterDevices: db.prepare('SELECT id, meter_code AS meterCode FROM meter_devices').all(),
    energyTypes: db.prepare('SELECT id, code, name FROM energy_types WHERE is_active = 1').all()
  });
}

function resolveImportUnit(mapped, indexes, rowNumber, errors, options = {}) {
  const codeText = normalizeText(mapped.organizationUnitCode || mapped.parentCode);
  const unitText = normalizeText(mapped.organizationUnit || mapped.parentPath || mapped.parentName);
  let matchedUnit = null;
  if (codeText) {
    matchedUnit = indexes.activeUnitsByCode.get(codeText) || null;
    if (!matchedUnit) {
      errors.push(createImportError(rowNumber, options.codeFieldName || 'organization_unit_code', codeText, options.unknownCode || 'UNKNOWN_ORGANIZATION_UNIT', options.unknownReason || '用能单元不存在或未启用。'));
    }
  }
  if (unitText) {
    let textMatch = indexes.activeUnitsByPath.get(unitText) || indexes.activeUnitsByCode.get(unitText) || null;
    if (!textMatch) {
      textMatch = resolveUniqueName(indexes.activeUnitsByName, unitText, rowNumber, options.textFieldName || 'organization_unit', options.ambiguousCode || 'AMBIGUOUS_ORGANIZATION_UNIT', options.ambiguousReason || '用能单元名称匹配到多条 active 记录，请改用唯一编码或完整路径。', errors);
    }
    if (!textMatch && !(indexes.activeUnitsByName.get(unitText) || []).length) {
      errors.push(createImportError(rowNumber, options.textFieldName || 'organization_unit', unitText, options.unknownText || 'UNKNOWN_ORGANIZATION_UNIT', options.unknownReason || '用能单元不存在或未启用。'));
    }
    if (matchedUnit && textMatch && Number(matchedUnit.id) !== Number(textMatch.id)) {
      errors.push(createImportError(rowNumber, options.textFieldName || 'organization_unit', unitText, options.mismatchCode || 'ORGANIZATION_UNIT_MATCH_MISMATCH', '用能单元编码与名称/路径匹配到不同记录。'));
    }
    matchedUnit = matchedUnit || textMatch;
  }
  return matchedUnit;
}

function validateAndNormalizeOrganizationUnitImportRow(row, rowNumber, indexes) {
  const { mapped, fieldMapping } = mapLedgerImportFields(row, UNIT_IMPORT_ALIASES);
  const errors = [];
  ['unitCode', 'unitName'].forEach((field) => {
    if (!normalizeText(mapped[field])) errors.push(createImportError(rowNumber, field, mapped[field], 'REQUIRED_FIELD_MISSING', `必填字段 ${field} 为空或未映射。`));
  });
  let parent = null;
  if (normalizeText(mapped.parentCode) || normalizeText(mapped.parentPath) || normalizeText(mapped.parentName)) {
    parent = resolveImportUnit({ parentCode: mapped.parentCode, parentPath: mapped.parentPath, parentName: mapped.parentName }, indexes, rowNumber, errors, {
      codeFieldName: 'parent_code',
      textFieldName: normalizeText(mapped.parentPath) ? 'parent_path' : 'parent_name',
      unknownCode: 'UNKNOWN_PARENT_UNIT',
      unknownText: 'UNKNOWN_PARENT_UNIT',
      ambiguousCode: 'AMBIGUOUS_PARENT_UNIT',
      unknownReason: '父级用能单元不存在或未启用；导入不会自动创建父级。',
      ambiguousReason: '父级名称匹配到多条 active 记录，请改用唯一父级编码或完整路径。',
      mismatchCode: 'PARENT_UNIT_MATCH_MISMATCH'
    });
  }
  if (errors.length > 0) return { errors, fieldMapping, record: null };
  try {
    const payload = normalizeUnitPayload({
      parentId: parent ? parent.id : null,
      unitCode: mapped.unitCode,
      unitName: mapped.unitName,
      unitType: mapped.unitType,
      area: mapped.area,
      sortOrder: mapped.sortOrder,
      status: mapped.status,
      remark: mapped.remark
    });
    return { errors: [], fieldMapping, record: payload };
  } catch (error) {
    return { errors: [createImportError(rowNumber, error?.details?.fieldName || 'organization_unit', error?.details?.rawValue ?? null, error?.details?.code || 'INVALID_ORGANIZATION_UNIT_ROW', error.message || '用能单元导入行校验失败。')], fieldMapping, record: null };
  }
}

function validateAndNormalizeMeterImportRow(row, rowNumber, indexes) {
  const { mapped, fieldMapping } = mapLedgerImportFields(row, METER_IMPORT_ALIASES);
  const errors = [];
  ['meterCode', 'meterName'].forEach((field) => {
    if (!normalizeText(mapped[field])) errors.push(createImportError(rowNumber, field, mapped[field], 'REQUIRED_FIELD_MISSING', `必填字段 ${field} 为空或未映射。`));
  });
  if (!normalizeText(mapped.energyTypeCode) && !normalizeText(mapped.energyTypeName)) {
    errors.push(createImportError(rowNumber, 'energy_type_code', null, 'REQUIRED_FIELD_MISSING', 'energy_type_code 或 energy_type_name 至少填写一个。'));
  }
  if (!normalizeText(mapped.organizationUnitCode) && !normalizeText(mapped.organizationUnit)) {
    errors.push(createImportError(rowNumber, 'organization_unit', null, 'REQUIRED_FIELD_MISSING', 'organization_unit_code 或 organization_unit 至少填写一个。'));
  }

  let energyType = null;
  const energyCode = normalizeText(mapped.energyTypeCode);
  const energyName = normalizeText(mapped.energyTypeName);
  if (energyCode) {
    energyType = indexes.energyTypesByCode.get(energyCode) || null;
    if (!energyType) errors.push(createImportError(rowNumber, 'energy_type_code', mapped.energyTypeCode, 'UNKNOWN_ENERGY_TYPE', '能源类型不存在或未启用。'));
  } else if (energyName) {
    energyType = resolveUniqueName(indexes.energyTypesByName, energyName, rowNumber, 'energy_type_name', 'AMBIGUOUS_ENERGY_TYPE', '能源类型名称匹配到多条 active 记录，请改用能源类型编码。', errors);
    if (!energyType && !(indexes.energyTypesByName.get(energyName) || []).length) errors.push(createImportError(rowNumber, 'energy_type_name', mapped.energyTypeName, 'UNKNOWN_ENERGY_TYPE', '能源类型不存在或未启用。'));
  }

  const unit = resolveImportUnit(mapped, indexes, rowNumber, errors);
  if (errors.length > 0) return { errors, fieldMapping, record: null };
  try {
    const payload = normalizeMeterPayload({
      meterCode: mapped.meterCode,
      meterName: mapped.meterName,
      meterType: normalizeMeterTypeImportValue(mapped.meterType),
      energyTypeId: energyType.id,
      organizationUnitId: unit.id,
      onlineStatus: mapped.onlineStatus,
      gatewayId: mapped.gatewayId,
      multiplier: mapped.multiplier,
      allowManualReading: mapped.allowManualReading,
      flowDirection: mapped.flowDirection,
      installLocation: mapped.installLocation,
      status: mapped.status,
      remark: mapped.remark
    });
    return { errors: [], fieldMapping, record: payload };
  } catch (error) {
    return { errors: [createImportError(rowNumber, error?.details?.fieldName || 'meter_device', error?.details?.rawValue ?? null, error?.details?.code || 'INVALID_METER_DEVICE_ROW', error.message || '计量器具导入行校验失败。')], fieldMapping, record: null };
  }
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function getLedgerBatchDetail(db, batchId, extra = {}) {
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

function listLedgerBatchErrors(db, batchId) {
  return db.prepare(
    `SELECT id, batch_id AS batchId, row_number AS rowNumber, field_name AS fieldName, raw_value AS rawValue,
            error_code AS errorCode, error_reason AS errorReason, severity, created_at AS createdAt
     FROM import_errors WHERE batch_id = ? ORDER BY row_number ASC, id ASC LIMIT 50`
  ).all(batchId);
}

function createLedgerImportBatchFromUpload(file, importType, persistFn, options = {}) {
  if (!file) throw badRequest('请使用 multipart/form-data 上传字段名为 file 的台账表格文件。', { code: 'IMPORT_FILE_REQUIRED', fieldName: 'file' });
  if ((options.duplicateStrategy || 'skip') !== 'skip') {
    throw badRequest('台账导入当前仅支持默认 skip 重复策略。', { code: 'UNSUPPORTED_DUPLICATE_STRATEGY', enabledDuplicateStrategies: ['skip'] });
  }
  const fileType = assertSupportedImportFile(file.originalname);
  const db = openDatabase();
  let batchId = null;
  try {
    batchId = db.prepare(
      `INSERT INTO import_batches (import_type, original_filename, stored_filename, file_type, file_size_bytes, file_sha256, status, duplicate_strategy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'skip', ?, ?)`
    ).run(importType, decodeUploadOriginalName(file.originalname), file.filename, fileType, file.size, sha256File(file.path), getNow(), getNow()).lastInsertRowid;
    const parsed = parseImportFile(file.path, file.originalname);
    const summary = db.transaction(() => persistFn(db, batchId, parsed.rows))();
    return getLedgerBatchDetail(db, batchId, { summary, errors: listLedgerBatchErrors(db, batchId) });
  } catch (error) {
    if (batchId) {
      db.prepare("UPDATE import_batches SET status = 'failed', finished_at = ?, updated_at = ?, error_summary = ? WHERE id = ?").run(getNow(), getNow(), error.message || '台账导入失败。', batchId);
      db.prepare("INSERT INTO import_errors (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity) VALUES (?, 1, NULL, NULL, ?, ?, 'error')").run(batchId, error?.details?.code || error.code || 'LEDGER_IMPORT_FAILED', error.message || '台账导入失败。');
      return getLedgerBatchDetail(db, batchId, { summary: { batchId, status: 'failed', totalRows: 0, successCount: 0, failureCount: 0, skippedCount: 0 }, errors: listLedgerBatchErrors(db, batchId) });
    }
    throw error;
  } finally {
    db.close();
  }
}

function persistOrganizationUnitImport(db, batchId, rows) {
  const indexes = loadLedgerImportIndexes(db);
  const insertError = db.prepare('INSERT INTO import_errors (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertUnit = db.prepare(
    `INSERT INTO organization_units (parent_id, unit_code, unit_name, unit_path, unit_type, area, sort_order, status, remark, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.prepare("UPDATE import_batches SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ?").run(getNow(), getNow(), batchId);
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  let validationErrorCount = 0;
  const fieldMapping = {};
  const seenCodes = new Set();
  if (!rows.length) {
    insertError.run(batchId, 1, null, null, 'EMPTY_IMPORT_FILE', '导入文件没有可解析的数据行。', 'error');
    db.prepare("UPDATE import_batches SET status = 'failed', total_rows = 0, error_summary = ?, finished_at = ?, updated_at = ? WHERE id = ?").run('导入文件没有可解析的数据行。', getNow(), getNow(), batchId);
    return { batchId, status: 'failed', totalRows: 0, successCount, failureCount, skippedCount, validationErrorCount: 1 };
  }
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const { errors, fieldMapping: rowMapping, record } = validateAndNormalizeOrganizationUnitImportRow(row, rowNumber, indexes);
    Object.assign(fieldMapping, rowMapping);
    if (errors.length > 0) {
      failureCount += 1;
      validationErrorCount += errors.length;
      errors.forEach((error) => insertError.run(batchId, error.rowNumber, error.fieldName, error.rawValue, error.errorCode, error.errorReason, error.severity));
      return;
    }
    if (seenCodes.has(record.unitCode)) {
      skippedCount += 1;
      insertError.run(batchId, rowNumber, 'unit_code', record.unitCode, 'DUPLICATE_UNIT_CODE_IN_FILE_SKIPPED', '默认 skip 策略已跳过同一文件内重复的用能单元编码。', 'warning');
      return;
    }
    seenCodes.add(record.unitCode);
    if (indexes.allUnitCodes.has(record.unitCode)) {
      skippedCount += 1;
      insertError.run(batchId, rowNumber, 'unit_code', record.unitCode, 'DUPLICATE_UNIT_CODE_SKIPPED', '默认 skip 策略已跳过数据库中已存在的用能单元编码。', 'warning');
      return;
    }
    const parent = record.parentId ? getUnitById(db, record.parentId) : null;
    const unitPath = buildUnitPath(parent ? parent.unitPath : null, record.unitName);
    const now = getNow();
    insertUnit.run(record.parentId || null, record.unitCode, record.unitName, unitPath, record.unitType, record.area, record.sortOrder, record.status, record.remark, now, now);
    successCount += 1;
  });
  const status = failureCount > 0 || skippedCount > 0 ? 'completed_with_errors' : 'completed';
  const summaryParts = [];
  if (failureCount > 0) summaryParts.push(`存在 ${failureCount} 行校验失败，共 ${validationErrorCount} 条错误。`);
  if (skippedCount > 0) summaryParts.push(`默认 skip 策略跳过 ${skippedCount} 行重复用能单元。`);
  db.prepare(
    `UPDATE import_batches SET status = ?, total_rows = ?, success_count = ?, failure_count = ?, skipped_count = ?, field_mapping_json = ?, error_summary = ?, finished_at = ?, updated_at = ? WHERE id = ?`
  ).run(status, rows.length, successCount, failureCount, skippedCount, JSON.stringify(fieldMapping), summaryParts.join(' ') || null, getNow(), getNow(), batchId);
  return { batchId, status, totalRows: rows.length, successCount, failureCount, skippedCount, validationErrorCount };
}

function persistMeterDeviceImport(db, batchId, rows) {
  const indexes = loadLedgerImportIndexes(db);
  const insertError = db.prepare('INSERT INTO import_errors (batch_id, row_number, field_name, raw_value, error_code, error_reason, severity) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertMeter = db.prepare(
    `INSERT INTO meter_devices (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, online_status, gateway_id, multiplier, allow_manual_reading, flow_direction, install_location, status, remark, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  db.prepare("UPDATE import_batches SET status = 'processing', started_at = ?, updated_at = ? WHERE id = ?").run(getNow(), getNow(), batchId);
  let successCount = 0;
  let failureCount = 0;
  let skippedCount = 0;
  let validationErrorCount = 0;
  const fieldMapping = {};
  const seenCodes = new Set();
  if (!rows.length) {
    insertError.run(batchId, 1, null, null, 'EMPTY_IMPORT_FILE', '导入文件没有可解析的数据行。', 'error');
    db.prepare("UPDATE import_batches SET status = 'failed', total_rows = 0, error_summary = ?, finished_at = ?, updated_at = ? WHERE id = ?").run('导入文件没有可解析的数据行。', getNow(), getNow(), batchId);
    return { batchId, status: 'failed', totalRows: 0, successCount, failureCount, skippedCount, validationErrorCount: 1 };
  }
  rows.forEach((row, index) => {
    const rowNumber = index + 2;
    const { errors, fieldMapping: rowMapping, record } = validateAndNormalizeMeterImportRow(row, rowNumber, indexes);
    Object.assign(fieldMapping, rowMapping);
    if (errors.length > 0) {
      failureCount += 1;
      validationErrorCount += errors.length;
      errors.forEach((error) => insertError.run(batchId, error.rowNumber, error.fieldName, error.rawValue, error.errorCode, error.errorReason, error.severity));
      return;
    }
    if (seenCodes.has(record.meterCode)) {
      skippedCount += 1;
      insertError.run(batchId, rowNumber, 'meter_code', record.meterCode, 'DUPLICATE_METER_CODE_IN_FILE_SKIPPED', '默认 skip 策略已跳过同一文件内重复的计量器具编码。', 'warning');
      return;
    }
    seenCodes.add(record.meterCode);
    if (indexes.allMeterCodes.has(record.meterCode)) {
      skippedCount += 1;
      insertError.run(batchId, rowNumber, 'meter_code', record.meterCode, 'DUPLICATE_METER_CODE_SKIPPED', '默认 skip 策略已跳过数据库中已存在的计量器具编码。', 'warning');
      return;
    }
    const now = getNow();
    insertMeter.run(record.meterCode, record.meterName, record.meterType, record.energyTypeId, record.organizationUnitId, record.onlineStatus, record.gatewayId, record.multiplier, record.allowManualReading, record.flowDirection, record.installLocation, record.status, record.remark, now, now);
    successCount += 1;
  });
  const status = failureCount > 0 || skippedCount > 0 ? 'completed_with_errors' : 'completed';
  const summaryParts = [];
  if (failureCount > 0) summaryParts.push(`存在 ${failureCount} 行校验失败，共 ${validationErrorCount} 条错误。`);
  if (skippedCount > 0) summaryParts.push(`默认 skip 策略跳过 ${skippedCount} 行重复计量器具。`);
  db.prepare(
    `UPDATE import_batches SET status = ?, total_rows = ?, success_count = ?, failure_count = ?, skipped_count = ?, field_mapping_json = ?, error_summary = ?, finished_at = ?, updated_at = ? WHERE id = ?`
  ).run(status, rows.length, successCount, failureCount, skippedCount, JSON.stringify(fieldMapping), summaryParts.join(' ') || null, getNow(), getNow(), batchId);
  return { batchId, status, totalRows: rows.length, successCount, failureCount, skippedCount, validationErrorCount };
}

function createOrganizationUnitImportBatchFromUpload(file, options = {}) {
  return createLedgerImportBatchFromUpload(file, ORGANIZATION_UNIT_IMPORT_TYPE, persistOrganizationUnitImport, options);
}

function createMeterImportBatchFromUpload(file, options = {}) {
  return createLedgerImportBatchFromUpload(file, METER_DEVICE_IMPORT_TYPE, persistMeterDeviceImport, options);
}

function escapeCsvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function buildExportRows(rows = [], fields = []) {
  return rows.map((row) => {
    const output = {};
    fields.forEach((field) => {
      output[field.header] = row[field.key] ?? '';
    });
    return output;
  });
}

function buildOrganizationUnitExportRows(rows = []) {
  return buildExportRows(rows, UNIT_EXPORT_FIELDS);
}

function buildMeterExportRows(rows = []) {
  return buildExportRows(rows, METER_EXPORT_FIELDS);
}

function renderLedgerExport(rows, fields, sheetName, baseFileName, format) {
  const headers = fields.map((field) => field.header);
  const exportRows = buildExportRows(rows, fields);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = `${baseFileName}-${date}.${format}`;
  if (format === 'csv') {
    const csvLines = [headers, ...exportRows.map((row) => headers.map((header) => row[header]))].map((row) => row.map(escapeCsvCell).join(','));
    return { fileName, format, contentType: 'text/csv; charset=utf-8', body: Buffer.from(`${UTF8_BOM}${csvLines.join('\n')}\n`, 'utf8'), rowCount: rows.length, fields: headers };
  }
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(exportRows, { header: headers });
  worksheet['!cols'] = headers.map((header) => ({ wch: Math.min(Math.max(String(header).length + 8, 12), 28) }));
  XLSX.utils.book_append_sheet(workbook, worksheet, sheetName);
  return { fileName, format, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), rowCount: rows.length, fields: headers };
}

function selectOrganizationUnitRowsForExport(db, query = {}) {
  const where = [];
  const params = {};
  const status = normalizeText(query.status);
  if (status) {
    assertWhitelist(status, 'status', LEDGER_STATUSES);
    where.push('ou.status = @status');
    params.status = status;
  }
  const unitType = normalizeText(firstDefined(query, ['unitType', 'unit_type']));
  if (unitType) {
    assertWhitelist(unitType, 'unitType', UNIT_TYPES);
    where.push('ou.unit_type = @unitType');
    params.unitType = unitType;
  }
  const parentRaw = firstDefined(query, ['parentId', 'parent_id']);
  if (parentRaw !== undefined && parentRaw !== null && String(parentRaw).trim() !== '') {
    const parentId = parsePositiveInteger(parentRaw, 'parentId');
    where.push('ou.parent_id = @parentId');
    params.parentId = parentId;
  }
  const keyword = normalizeText(query.keyword || query.search);
  if (keyword) {
    where.push('(ou.unit_code LIKE @keyword OR ou.unit_name LIKE @keyword OR ou.unit_path LIKE @keyword)');
    params.keyword = `%${keyword}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT ou.id, ou.parent_id AS parentId, ou.unit_code AS unitCode, ou.unit_name AS unitName, ou.unit_path AS unitPath,
            parent.unit_code AS parentCode, parent.unit_name AS parentName, ou.unit_type AS unitType, ou.area,
            ou.sort_order AS sortOrder, ou.status, ou.remark, ou.created_at AS createdAt, ou.updated_at AS updatedAt
     FROM organization_units ou
     LEFT JOIN organization_units parent ON parent.id = ou.parent_id
     ${whereSql}
     ORDER BY ou.unit_path ASC, ou.sort_order ASC, ou.id ASC
     LIMIT @limit`
  ).all({ ...params, limit: MAX_LEDGER_EXPORT_ROWS });
}

function selectMeterRowsForExport(db, query = {}) {
  const where = [];
  const params = {};
  const status = normalizeText(query.status);
  if (status) {
    assertWhitelist(status, 'status', LEDGER_STATUSES);
    where.push('md.status = @status');
    params.status = status;
  }
  const meterType = normalizeText(firstDefined(query, ['meterType', 'meter_type']));
  if (meterType) {
    assertWhitelist(meterType, 'meterType', METER_TYPES);
    where.push('md.meter_type = @meterType');
    params.meterType = meterType;
  }
  const energyTypeId = parsePositiveInteger(firstDefined(query, ['energyTypeId', 'energy_type_id']), 'energyTypeId');
  if (energyTypeId) {
    where.push('md.energy_type_id = @energyTypeId');
    params.energyTypeId = energyTypeId;
  }
  const organizationUnitId = parsePositiveInteger(firstDefined(query, ['organizationUnitId', 'organization_unit_id']), 'organizationUnitId');
  if (organizationUnitId) {
    where.push('md.organization_unit_id = @organizationUnitId');
    params.organizationUnitId = organizationUnitId;
  }
  const onlineStatus = normalizeText(firstDefined(query, ['onlineStatus', 'online_status']));
  if (onlineStatus) {
    assertWhitelist(onlineStatus, 'onlineStatus', ONLINE_STATUSES);
    where.push('md.online_status = @onlineStatus');
    params.onlineStatus = onlineStatus;
  }
  const keyword = normalizeText(query.keyword || query.search);
  if (keyword) {
    where.push('(md.meter_code LIKE @keyword OR md.meter_name LIKE @keyword OR ou.unit_path LIKE @keyword)');
    params.keyword = `%${keyword}%`;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT md.id, md.meter_code AS meterCode, md.meter_name AS meterName, md.meter_type AS meterType,
            et.code AS energyTypeCode, et.name AS energyTypeName, ou.unit_code AS organizationUnitCode,
            ou.unit_path AS organizationUnitPath, md.online_status AS onlineStatus, md.gateway_id AS gatewayId,
            md.multiplier, md.allow_manual_reading AS allowManualReading, md.flow_direction AS flowDirection,
            md.install_location AS installLocation, md.status, md.remark, md.created_at AS createdAt, md.updated_at AS updatedAt
     FROM meter_devices md
     JOIN energy_types et ON et.id = md.energy_type_id
     LEFT JOIN organization_units ou ON ou.id = md.organization_unit_id
     ${whereSql}
     ORDER BY md.status ASC, md.meter_code ASC, md.id ASC
     LIMIT @limit`
  ).all({ ...params, limit: MAX_LEDGER_EXPORT_ROWS });
}

function getOrganizationUnitStats() {
  const db = openDatabase();
  try {
    const totals = db.prepare(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END), 0) AS inactive
      FROM organization_units`).get();
    const byType = db.prepare(`SELECT unit_type AS unitType, COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END), 0) AS inactive
      FROM organization_units GROUP BY unit_type ORDER BY unit_type ASC`).all();
    const byPathDepth = db.prepare(`SELECT
      CASE WHEN unit_path IS NULL OR unit_path = '' THEN 0 ELSE LENGTH(unit_path) - LENGTH(REPLACE(unit_path, '/', '')) + 1 END AS pathDepth,
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END), 0) AS inactive
      FROM organization_units GROUP BY pathDepth ORDER BY pathDepth ASC`).all();
    return { total: Number(totals.total || 0), active: Number(totals.active || 0), inactive: Number(totals.inactive || 0), byType, byPathDepth };
  } finally {
    db.close();
  }
}

function getMeterStats() {
  const db = openDatabase();
  try {
    const totals = db.prepare(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN status = 'inactive' THEN 1 ELSE 0 END), 0) AS inactive
      FROM meter_devices`).get();
    const byEnergyType = db.prepare(`SELECT et.code AS energyTypeCode, et.name AS energyTypeName,
      COUNT(md.id) AS total,
      COALESCE(SUM(CASE WHEN md.status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN md.status = 'inactive' THEN 1 ELSE 0 END), 0) AS inactive
      FROM meter_devices md JOIN energy_types et ON et.id = md.energy_type_id
      GROUP BY et.id, et.code, et.name ORDER BY et.display_order ASC, et.code ASC`).all();
    const byOrganizationUnit = db.prepare(`SELECT ou.id AS organizationUnitId, ou.unit_code AS organizationUnitCode,
      ou.unit_name AS organizationUnitName, ou.unit_path AS organizationUnitPath, COUNT(md.id) AS total,
      COALESCE(SUM(CASE WHEN md.status = 'active' THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN md.status = 'inactive' THEN 1 ELSE 0 END), 0) AS inactive
      FROM meter_devices md JOIN organization_units ou ON ou.id = md.organization_unit_id
      GROUP BY ou.id, ou.unit_code, ou.unit_name, ou.unit_path ORDER BY ou.unit_path ASC`).all();
    return { total: Number(totals.total || 0), active: Number(totals.active || 0), inactive: Number(totals.inactive || 0), byEnergyType, byOrganizationUnit };
  } finally {
    db.close();
  }
}

function exportOrganizationUnits(query = {}) {
  const format = String(query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const db = openDatabase();
  try {
    const rows = selectOrganizationUnitRowsForExport(db, query);
    return renderLedgerExport(rows, UNIT_EXPORT_FIELDS, '用能单元', '用能单元导出', format);
  } finally {
    db.close();
  }
}

function exportMeters(query = {}) {
  const format = String(query.format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const db = openDatabase();
  try {
    const rows = selectMeterRowsForExport(db, query);
    return renderLedgerExport(rows, METER_EXPORT_FIELDS, '计量器具', '计量器具导出', format);
  } finally {
    db.close();
  }
}

module.exports = {
  FLOW_DIRECTIONS,
  LEDGER_STATUSES,
  METER_DEVICE_IMPORT_TYPE,
  METER_EXPORT_FIELDS,
  METER_TYPES,
  ONLINE_STATUSES,
  ORGANIZATION_UNIT_IMPORT_TYPE,
  UNIT_EXPORT_FIELDS,
  UNIT_TYPES,
  buildEnergyRecordLedgerBackfillPreview,
  buildLedgerBackfillPreviewIndexes,
  buildLedgerImportIndexes,
  buildLedgerIndexes,
  buildMeterExportRows,
  buildOrganizationUnitExportRows,
  buildUnitPath,
  createDeactivationResult,
  createMeter,
  createMeterImportBatchFromUpload,
  createOrganizationUnit,
  createOrganizationUnitImportBatchFromUpload,
  deactivateMeter,
  deactivateOrganizationUnit,
  exportMeters,
  exportOrganizationUnits,
  findLedgerAssociationsForImportRecord,
  getMeterStats,
  getOrganizationUnitStats,
  listMeters,
  listOrganizationUnits,
  loadActiveLedgerIndexes,
  loadLedgerBackfillPreviewIndexes,
  mapLedgerImportFields,
  normalizeMeterPayload,
  normalizePagination,
  normalizeUnitPayload,
  updateMeter,
  validateAndNormalizeMeterImportRow,
  validateAndNormalizeOrganizationUnitImportRow,
  updateOrganizationUnit
};
