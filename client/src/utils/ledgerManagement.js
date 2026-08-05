export const LEDGER_COLORS = Object.freeze(['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948']);

export function numberValue(value) { const result = Number(value); return Number.isFinite(result) ? result : 0; }
export function buildLedgerFilters(filters = {}, pagination = {}) {
  return Object.fromEntries(Object.entries({ ...filters, page: pagination.page, pageSize: pagination.pageSize }).filter(([, value]) => value !== '' && value !== null && value !== undefined));
}
export function buildControlledExecutePayload(preview = {}, kind = 'import') {
  const isReadingGeneration = kind === 'reading-generation';
  return isReadingGeneration ? {
    confirmText: preview.confirmText, previewSignature: preview.previewSignature,
    expectedWouldGenerate: numberValue(preview.summary?.wouldGenerate), candidateReadingIds: preview.candidateReadingIds || [], filters: preview.filters || {}, acknowledgeSkippedRisks: true, requireBackup: true
  } : {
    confirmText: preview.confirmText, batchId: preview.batchId || preview.auditBatch?.id, previewSignature: preview.previewSignature,
    expectedWouldImport: numberValue(preview.summary?.wouldImport), candidateRowIds: preview.candidateRowIds || [], candidateRows: preview.candidateRows || [],
    ...(kind === 'generation' ? { previewAudit: preview.previewAudit || { summary: preview.summary || {}, items: preview.items || [] }, previewAuditDigest: preview.previewAuditDigest } : {}),
    acknowledgeSkippedRisks: true, requireBackup: true
  };
}
export function chartRows(rows = [], labelKey, valueKey, limit = 8) {
  return rows.slice(0, limit).map((row, index) => ({ label: String(row?.[labelKey] || '未标注'), value: numberValue(row?.[valueKey]), color: LEDGER_COLORS[index] }));
}
export function nextLedgerStatus(currentStatus, isRecord = false) { return isRecord ? 'void' : (currentStatus === 'active' ? 'inactive' : 'active'); }
export function canExecutePreview(preview = {}, kind = 'import') {
  return kind === 'reading-generation'
    ? Boolean(preview.previewSignature && numberValue(preview.summary?.wouldGenerate) > 0 && preview.candidateReadingIds?.length)
    : Boolean(preview.previewSignature && numberValue(preview.summary?.wouldImport) > 0 && preview.candidateRowIds?.length && preview.candidateRows?.length);
}
export function blankForm(kind) {
  const forms = {
    units: { parentId: '', unitCode: '', unitName: '', unitType: 'department', area: undefined, sortOrder: 0, status: 'active', remark: '' },
    meters: { meterCode: '', meterName: '', meterType: 'other', energyTypeId: '', organizationUnitId: '', onlineStatus: 'unknown', gatewayId: '', multiplier: 1, allowManualReading: true, flowDirection: 'unknown', installLocation: '', status: 'active', remark: '' },
    readings: { meterDeviceId: '', readingDate: '', previousValue: undefined, currentValue: undefined, multiplier: 1, usageValue: undefined, originalUnit: '', dataSource: 'manual', recordStatus: 'active', remark: '' },
    generation: { organizationUnitId: '', normalizedMonth: '', generationValueKwh: undefined, selfUseValueKwh: 0, gridExportValueKwh: 0, dataSource: 'manual', remark: '' },
    productionUnits: { unitCode: '', unitName: '', organizationUnitId: '', productName: '', outputUnit: '', status: 'active', remark: '' },
    productionOutputs: { productionUnitId: '', normalizedMonth: '', outputValue: undefined, outputUnit: '', dataSource: 'manual', recordStatus: 'active', remark: '' }
  };
  return { ...(forms[kind] || {}) };
}
