const crypto = require('crypto');

const FIELD_ALIASES = {
  month: ['月份', '月度', '统计月份', '账期', '日期', '时间', 'month', 'period', 'date', 'billingmonth', 'statmonth'],
  energyType: ['能源类型', '能源类型编码', '能源类型名称', '能源种类', '能源编码', '能源名称', '能源', '名称', '类型', 'energytype', 'energy_type', 'energyname', 'energy_name', 'energy', 'fueltype', 'fuel', 'type', 'name'],
  value: ['用量', '能耗值', '消耗量', '消费量', '数值', '数据值', 'value', 'usage', 'amount', 'consumption', 'quantity'],
  unit: ['单位', '计量单位', 'unit', 'uom'],
  organizationUnitCode: ['用能单元编码', '组织单元编码', '组织编码', 'organizationUnitCode', 'organization_unit_code', 'unitCode', 'unit_code'],
  meterCode: ['计量器具编码', '仪表编码', '表计编号', 'meterCode', 'meter_code', 'meterDeviceCode', 'meter_device_code'],
  remark: ['备注', '说明', 'remark']
};

const REQUIRED_FIELDS = ['month', 'energyType', 'value', 'unit', 'organizationUnitCode'];
const ENERGY_IMPORT_TEMPLATE_KEY_FIELDS = ['month', 'value', 'organizationUnitCode'];
const TEMPLATE_TYPE_MISMATCH_CODE = 'TEMPLATE_TYPE_MISMATCH';
const TEMPLATE_TYPE_MISMATCH_REASON = '模板类型不匹配：当前入口只支持能耗数据导入，请使用能耗数据导入模板；碳因子模板仅用于维护参考/字段整理，不支持批量上传。';
const CARBON_FACTOR_HEADER_FEATURES = {
  region: ['地区', '区域', '适用地区', 'region'],
  factorYear: ['年份', '因子年份', '年度', 'year', 'factorYear', 'factor_year'],
  factorValue: ['因子值', '排放因子', '碳因子', 'factorValue', 'factor_value', 'emissionFactor', 'carbonFactor'],
  factorUnit: ['因子单位', '排放因子单位', '排放单位', 'factorUnit', 'factor_unit', 'emissionUnit'],
  sourceUrl: ['来源链接', 'sourceUrl', 'source_url', 'url'],
  effectiveFrom: ['有效开始日期', '有效开始', '生效日期', 'effectiveFrom', 'effective_from', 'startDate'],
  effectiveTo: ['有效结束日期', '有效结束', '失效日期', 'effectiveTo', 'effective_to', 'endDate'],
  isActive: ['是否启用', '启用状态', 'isActive', 'is_active', 'active']
};

const ENERGY_TYPE_ALIASES = {
  electricity: ['electricity', 'power', '电力', '用电', '电', '电能'],
  photovoltaic: ['photovoltaic', 'pv', 'solar', 'solarenergy', '光伏', '光伏发电', '太阳能', '太阳能发电'],
  natural_gas: ['naturalgas', 'natural_gas', 'gas', '天然气', '燃气', '天然气用量'],
  gasoline: ['gasoline', 'petrol', '汽油'],
  diesel: ['diesel', '柴油'],
  oil: ['oil', '油', '燃油', '油品', '通用油'],
  coal: ['coal', '煤', '煤炭', '原煤'],
  heat: ['heat', '热力', '热量'],
  steam: ['steam', '蒸汽'],
  water: ['water', '水', '用水', '自来水']
};

const UNIT_RULES = {
  electricity: [
    { aliases: ['kwh', 'kw·h', 'kw h', 'kw.h', '千瓦时', '度'], standardUnit: 'kWh', factor: 1 },
    { aliases: ['mwh', '兆瓦时'], standardUnit: 'kWh', factor: 1000 }
  ],
  photovoltaic: [
    { aliases: ['kwh', 'kw·h', 'kw h', 'kw.h', '千瓦时', '度'], standardUnit: 'kWh', factor: 1 },
    { aliases: ['mwh', '兆瓦时'], standardUnit: 'kWh', factor: 1000 }
  ],
  natural_gas: [
    { aliases: ['m3', 'm³', 'nm3', '立方米', '标方', '方'], standardUnit: 'm3', factor: 1 },
    { aliases: ['万m3', '万m³', '万nm3', '万立方米', '万标方', '万方'], standardUnit: 'm3', factor: 10000 }
  ],
  water: [
    { aliases: ['m3', 'm³', '立方米', '方'], standardUnit: 'm3', factor: 1 },
    { aliases: ['万m3', '万m³', '万立方米', '万方'], standardUnit: 'm3', factor: 10000 },
    { aliases: ['t', 'ton', 'tons', '吨'], standardUnit: 'm3', factor: 1 }
  ],
  gasoline: [
    { aliases: ['l', 'liter', 'litre', 'liters', 'litres', '升'], standardUnit: 'L', factor: 1 }
  ],
  diesel: [
    { aliases: ['l', 'liter', 'litre', 'liters', 'litres', '升'], standardUnit: 'L', factor: 1 }
  ],
  oil: [
    { aliases: ['kg', '公斤', '千克'], standardUnit: 't', factor: 0.001 },
    { aliases: ['t', 'ton', 'tons', '吨'], standardUnit: 't', factor: 1 }
  ],
  coal: [
    { aliases: ['kg', '公斤', '千克'], standardUnit: 't', factor: 0.001 },
    { aliases: ['t', 'ton', 'tons', '吨'], standardUnit: 't', factor: 1 }
  ],
  heat: [
    { aliases: ['gj', '吉焦'], standardUnit: 'MJ', factor: 1000 },
    { aliases: ['mj', '兆焦'], standardUnit: 'MJ', factor: 1 }
  ],
  steam: [
    { aliases: ['t', 'ton', 'tons', '吨'], standardUnit: 't', factor: 1 },
    { aliases: ['kg', '公斤', '千克'], standardUnit: 't', factor: 0.001 }
  ]
};

function normalizeHeaderName(value) {
  return String(value || '')
    .trim()
    .replace(/[\s_\-\/\\:：()（）]/g, '')
    .toLowerCase();
}

function canonicalFieldName(header) {
  const normalized = normalizeHeaderName(header);
  if (!normalized) {
    return null;
  }

  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (aliases.map(normalizeHeaderName).includes(normalized)) {
      return field;
    }
  }

  return null;
}

function mapRowFields(row) {
  const mapped = {};
  const fieldMapping = {};

  Object.entries(row || {}).forEach(([rawHeader, value]) => {
    const field = canonicalFieldName(rawHeader);
    if (!field) {
      return;
    }
    if (Object.prototype.hasOwnProperty.call(mapped, field) && !isBlank(mapped[field])) {
      return;
    }
    mapped[field] = value;
    fieldMapping[field] = rawHeader;
  });

  return { mapped, fieldMapping };
}

function collectImportHeaders(rows) {
  const headers = new Set();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    Object.keys(row || {}).forEach((header) => {
      if (String(header || '').trim()) {
        headers.add(header);
      }
    });
  });
  return Array.from(headers);
}

function countCarbonFactorHeaderFeatures(headers) {
  const normalizedHeaders = new Set(headers.map(normalizeHeaderName).filter(Boolean));
  return Object.entries(CARBON_FACTOR_HEADER_FEATURES)
    .filter(([, aliases]) => aliases.map(normalizeHeaderName).some((alias) => normalizedHeaders.has(alias)))
    .map(([feature]) => feature);
}

function getMappedEnergyFields(headers, providedMapping = {}) {
  const headerSet = new Set(headers);
  const fields = new Set(headers.map(canonicalFieldName).filter(Boolean));
  if (providedMapping && typeof providedMapping === 'object') {
    Object.entries(providedMapping).forEach(([field, sourceHeader]) => {
      if (typeof sourceHeader === 'string' && headerSet.has(sourceHeader) && REQUIRED_FIELDS.includes(field)) {
        fields.add(field);
      }
    });
  }
  return fields;
}

function detectEnergyImportTemplateMismatch(rows, providedMapping = {}) {
  const headers = collectImportHeaders(rows);
  if (headers.length === 0) {
    return null;
  }

  const mappedEnergyFields = getMappedEnergyFields(headers, providedMapping);
  const missingKeyFields = ENERGY_IMPORT_TEMPLATE_KEY_FIELDS.filter((field) => !mappedEnergyFields.has(field));
  if (missingKeyFields.length === 0) {
    return null;
  }

  const matchedCarbonFeatures = countCarbonFactorHeaderFeatures(headers);
  if (matchedCarbonFeatures.length < 3) {
    return null;
  }

  return {
    code: TEMPLATE_TYPE_MISMATCH_CODE,
    errorCode: TEMPLATE_TYPE_MISMATCH_CODE,
    errorReason: TEMPLATE_TYPE_MISMATCH_REASON,
    missingKeyFields,
    matchedCarbonFeatures,
    headers
  };
}

function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

function normalizeString(value) {
  if (isBlank(value)) {
    return null;
  }
  return String(value).trim();
}

function parseExcelSerialDate(serial) {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 60000) {
    return null;
  }
  const epoch = Date.UTC(1899, 11, 30);
  const date = new Date(epoch + serial * 24 * 60 * 60 * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeMonth(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}`;
  }

  if (typeof value === 'number') {
    const date = parseExcelSerialDate(value);
    if (date) {
      return normalizeMonth(date);
    }
  }

  const raw = String(value || '').trim();
  if (!raw) {
    return null;
  }

  const compact = raw.match(/^(\d{4})(\d{2})$/);
  if (compact) {
    const month = Number(compact[2]);
    return month >= 1 && month <= 12 ? `${compact[1]}-${compact[2]}` : null;
  }

  const matched = raw.match(/^(\d{4})\s*[年\-/.]\s*(\d{1,2})(?:\s*月)?(?:\s*[\-/.]\s*\d{1,2})?(?:\s*日)?(?:[ T]\d{1,2}:\d{1,2}(?::\d{1,2})?)?$/);
  if (!matched) {
    const parsedDate = new Date(raw);
    return Number.isNaN(parsedDate.getTime()) ? null : normalizeMonth(parsedDate);
  }

  const year = Number(matched[1]);
  const month = Number(matched[2]);
  if (year < 1900 || year > 2200 || month < 1 || month > 12) {
    return null;
  }

  return `${matched[1]}-${String(month).padStart(2, '0')}`;
}

function normalizeNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? value : null;
  }

  const raw = String(value || '').trim().replace(/,/g, '');
  if (!raw) {
    return null;
  }

  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) {
    return null;
  }

  return number;
}

function normalizeToken(value) {
  return String(value || '')
    .trim()
    .replace(/[\s_\-\/\\:：()（）]/g, '')
    .toLowerCase();
}

function buildEnergyTypeIndex(energyTypes) {
  const byCode = new Map();
  const byAlias = new Map();

  energyTypes.forEach((type) => {
    byCode.set(type.code, type);
    byAlias.set(normalizeToken(type.code), type);
    byAlias.set(normalizeToken(type.name), type);

    (ENERGY_TYPE_ALIASES[type.code] || []).forEach((alias) => {
      byAlias.set(normalizeToken(alias), type);
    });
  });

  return { byCode, byAlias };
}

function normalizeEnergyType(value, energyTypeIndex) {
  const token = normalizeToken(value);
  if (!token) {
    return null;
  }
  return energyTypeIndex.byAlias.get(token) || null;
}

function normalizeUnitAndValue(energyTypeCode, unitValue, numberValue) {
  const unitToken = normalizeToken(unitValue);
  const rules = UNIT_RULES[energyTypeCode] || [];
  const matchedRule = rules.find((rule) => rule.aliases.map(normalizeToken).includes(unitToken));

  if (!matchedRule) {
    return null;
  }

  return {
    normalizedUnit: matchedRule.standardUnit,
    normalizedValue: Number((numberValue * matchedRule.factor).toFixed(6))
  };
}

function createDuplicateKey(record) {
  const parts = {
    energyTypeCode: record.energyTypeCode,
    normalizedMonth: record.normalizedMonth,
    organizationUnitCode: normalizeString(record.organizationUnitCode) || '',
    meterCode: normalizeString(record.meterCode) || '',
    originalUnit: normalizeString(record.originalUnit) || ''
  };

  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function createValidationError(rowNumber, fieldName, rawValue, errorCode, errorReason) {
  return {
    rowNumber,
    fieldName,
    rawValue: rawValue === undefined || rawValue === null ? null : String(rawValue),
    errorCode,
    errorReason,
    severity: 'error'
  };
}

function validateAndNormalizeRow(row, rowNumber, energyTypeIndex) {
  const { mapped, fieldMapping } = mapRowFields(row);
  const errors = [];
  const monthSourceValue = mapped.month;

  REQUIRED_FIELDS.forEach((field) => {
    if (isBlank(mapped[field])) {
      errors.push(createValidationError(rowNumber, field, mapped[field], 'REQUIRED_FIELD_MISSING', `必填字段 ${field} 为空或未映射`));
    }
  });

  const normalizedMonth = normalizeMonth(monthSourceValue);
  if (!isBlank(monthSourceValue) && !normalizedMonth) {
    errors.push(createValidationError(rowNumber, 'month', monthSourceValue, 'INVALID_MONTH', '月份格式不合法，需可标准化为 YYYY-MM'));
  }

  const originalValue = normalizeNumber(mapped.value);
  if (!isBlank(mapped.value) && originalValue === null) {
    errors.push(createValidationError(rowNumber, 'value', mapped.value, 'INVALID_VALUE', '用量必须为大于等于 0 的数字'));
  }

  const energyType = normalizeEnergyType(mapped.energyType, energyTypeIndex);
  if (!isBlank(mapped.energyType) && !energyType) {
    errors.push(createValidationError(rowNumber, 'energyType', mapped.energyType, 'UNKNOWN_ENERGY_TYPE', '能源类型不存在或未启用'));
  }

  let normalizedUnitValue = null;
  if (!isBlank(mapped.unit) && originalValue !== null && energyType) {
    normalizedUnitValue = normalizeUnitAndValue(energyType.code, mapped.unit, originalValue);
    if (!normalizedUnitValue) {
      errors.push(createValidationError(rowNumber, 'unit', mapped.unit, 'UNSUPPORTED_UNIT', '单位不合法或不能换算为该能源类型标准单位'));
    }
  }

  if (errors.length > 0) {
    return { errors, fieldMapping, record: null };
  }

  const record = {
    sourceRowNumber: rowNumber,
    energyTypeId: energyType.id,
    energyTypeCode: energyType.code,
    originalMonth: String(monthSourceValue).trim(),
    normalizedMonth,
    originalUnit: String(mapped.unit).trim(),
    originalValue,
    normalizedUnit: normalizedUnitValue.normalizedUnit,
    normalizedValue: normalizedUnitValue.normalizedValue,
    organizationUnitCode: normalizeString(mapped.organizationUnitCode),
    meterCode: normalizeString(mapped.meterCode),
    remark: normalizeString(mapped.remark)
  };
  record.duplicateKey = createDuplicateKey(record);

  return { errors, fieldMapping, record };
}

module.exports = {
  CARBON_FACTOR_HEADER_FEATURES,
  FIELD_ALIASES,
  REQUIRED_FIELDS,
  TEMPLATE_TYPE_MISMATCH_CODE,
  TEMPLATE_TYPE_MISMATCH_REASON,
  UNIT_RULES,
  buildEnergyTypeIndex,
  canonicalFieldName,
  createDuplicateKey,
  detectEnergyImportTemplateMismatch,
  mapRowFields,
  normalizeEnergyType,
  normalizeMonth,
  normalizeNumber,
  normalizeUnitAndValue,
  validateAndNormalizeRow
};
