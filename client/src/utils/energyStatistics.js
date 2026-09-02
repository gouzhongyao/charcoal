export const ENERGY_TYPE_ORDER = Object.freeze([
  'electricity', 'natural_gas', 'coal', 'oil', 'heat', 'photovoltaic', 'steam', 'water'
]);

export const ENERGY_TYPE_COLORS = Object.freeze({
  electricity: '#2a78d6',
  natural_gas: '#eb6834',
  coal: '#1baf7a',
  oil: '#eda100',
  heat: '#e87ba4',
  photovoltaic: '#008300',
  steam: '#4a3aa7',
  water: '#e34948',
  other: '#52514e'
});

export function buildEnergyFilters(filters = {}) {
  return Object.fromEntries(Object.entries({
    normalizedMonthStart: filters.normalizedMonthStart,
    normalizedMonthEnd: filters.normalizedMonthEnd,
    energyTypeCode: filters.energyTypeCode,
    organizationUnitCode: filters.organizationUnitCode,
    keyword: filters.keyword,
    search: filters.search
  }).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}

export function numberValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function aggregateMonthlyTrend(rows = []) {
  const byMonth = new Map();
  rows.forEach((row) => {
    const month = String(row?.month || '').trim();
    if (!month) return;
    const current = byMonth.get(month) || { month, totalNormalizedValue: 0, recordCount: 0 };
    current.totalNormalizedValue += numberValue(row.totalNormalizedValue);
    current.recordCount += numberValue(row.recordCount);
    byMonth.set(month, current);
  });
  return [...byMonth.values()].sort((left, right) => left.month.localeCompare(right.month));
}

export function fixedEnergyTypeBreakdown(rows = []) {
  const known = new Map();
  const unknown = [];
  rows.forEach((row) => {
    const code = String(row?.energyTypeCode || '').trim();
    if (ENERGY_TYPE_ORDER.includes(code)) known.set(code, row);
    else if (code) unknown.push(row);
  });
  const ordered = ENERGY_TYPE_ORDER.map((code) => known.get(code)).filter(Boolean);
  if (unknown.length > 0) {
    ordered.push({
      energyTypeCode: 'other',
      energyTypeName: '其他能源类型',
      normalizedUnit: '混合单位',
      recordCount: unknown.reduce((total, row) => total + numberValue(row.recordCount), 0),
      totalNormalizedValue: unknown.reduce((total, row) => total + numberValue(row.totalNormalizedValue), 0),
      monthStart: unknown.map((row) => row.monthStart).filter(Boolean).sort()[0] || null,
      monthEnd: unknown.map((row) => row.monthEnd).filter(Boolean).sort().at(-1) || null
    });
  }
  return ordered;
}

export function isSuperAdminProfile(profile = {}) {
  if (profile?.roleCode === 'super_admin') return true;
  return Array.isArray(profile?.roles) && profile.roles.some((role) => role?.roleCode === 'super_admin');
}

export function ledgerAssociationLabel(row = {}) {
  if (row.ledgerAssociationStatus === 'meter-linked') return `仪表：${row.meterDeviceName || row.ledgerMeterCode || row.meterCode || '已关联'}`;
  if (row.ledgerAssociationStatus === 'organization-linked') return `用能单元：${row.organizationUnitPath || row.organizationUnitName || row.organizationUnitCode || '已关联'}`;
  return '未关联台账';
}
