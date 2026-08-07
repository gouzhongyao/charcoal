'use strict';

// 统一验收日按 Asia/Shanghai 的 2026-07-15 自然日构造。
const ACCEPTANCE_DAY_START_UTC_MS = Date.parse('2026-07-14T16:00:00.000Z');

// 每个 15 分钟区间的毫秒数。
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * 将毫秒时间戳转换为严格 UTC ISO 字符串。
 * @param {number} timestamp 时间戳。
 * @returns {string} UTC ISO 字符串。
 */
function toUtcIso(timestamp) {
  return new Date(timestamp).toISOString();
}

/**
 * 构造单个能源的 96 条连续 15 分钟时序记录。
 * @param {string} energyTypeCode 能源类型编码。
 * @param {string} unit 原始单位。
 * @param {number} baseValue 基础值。
 * @returns {object[]} 时序记录。
 */
function createTimeSeriesRecords(energyTypeCode, unit, baseValue) {
  return Array.from({ length: 96 }, (_unused, index) => {
    const startTime = ACCEPTANCE_DAY_START_UTC_MS + index * FIFTEEN_MINUTES_MS;
    const endTime = startTime + FIFTEEN_MINUTES_MS;
    return {
      id: `${energyTypeCode}-interval-${String(index + 1).padStart(2, '0')}`,
      energyTypeCode,
      unit,
      value: baseValue + (index % 8),
      startUtc: toUtcIso(startTime),
      endUtc: toUtcIso(endTime),
      granularityMinutes: 15,
      sourceTimeZone: 'Asia/Shanghai',
      sourceReference: `acceptance-upload:${energyTypeCode}:2026-07-15`
    };
  });
}

/**
 * 构造三班次本地时间配置。
 * @returns {object[]} 班次配置。
 */
function createShiftSchedules() {
  return [
    {
      code: 'day-shift',
      name: '白班',
      startLocal: '06:00',
      endLocal: '14:00',
      startMinute: 360,
      endMinute: 840,
      crossesMidnight: false,
      sourceTimeZone: 'Asia/Shanghai'
    },
    {
      code: 'evening-shift',
      name: '中班',
      startLocal: '14:00',
      endLocal: '22:00',
      startMinute: 840,
      endMinute: 1320,
      crossesMidnight: false,
      sourceTimeZone: 'Asia/Shanghai'
    },
    {
      code: 'night-shift',
      name: '夜班',
      startLocal: '22:00',
      endLocal: '06:00',
      startMinute: 1320,
      endMinute: 360,
      crossesMidnight: true,
      sourceTimeZone: 'Asia/Shanghai'
    }
  ];
}

/**
 * 构造含显式 unknown 与一小时覆盖缺口的设备状态记录。
 * @returns {object} 设备状态样例。
 */
function createDeviceStateFixture() {
  return {
    deviceId: 'meter-main-01',
    sourceTimeZone: 'Asia/Shanghai',
    records: [
      {
        status: 'running',
        startUtc: '2026-07-14T16:00:00.000Z',
        endUtc: '2026-07-14T19:00:00.000Z'
      },
      {
        status: 'idle',
        startUtc: '2026-07-14T19:00:00.000Z',
        endUtc: '2026-07-14T21:00:00.000Z'
      },
      {
        status: 'stopped',
        startUtc: '2026-07-14T21:00:00.000Z',
        endUtc: '2026-07-14T22:00:00.000Z'
      },
      {
        status: 'offline',
        startUtc: '2026-07-14T22:00:00.000Z',
        endUtc: '2026-07-15T00:00:00.000Z'
      },
      {
        status: 'unknown',
        startUtc: '2026-07-15T00:00:00.000Z',
        endUtc: '2026-07-15T01:00:00.000Z'
      },
      {
        status: 'running',
        startUtc: '2026-07-15T02:00:00.000Z',
        endUtc: '2026-07-15T16:00:00.000Z'
      }
    ],
    expectedGap: {
      startUtc: '2026-07-15T01:00:00.000Z',
      endUtc: '2026-07-15T02:00:00.000Z',
      semanticStatus: 'unknown',
      materializedAsStateRecord: false,
      reasonCode: 'DEVICE_STATE_GAP',
      mustNotAutoClassifyAs: ['idle', 'stopped']
    }
  };
}

/**
 * 构造覆盖全天且包含峰平谷三类的本地规则。
 * @returns {object} 峰平谷规则。
 */
function createTimeOfUseRule() {
  return {
    id: 'tou-shanghai-2026',
    version: 'time-of-use:v1',
    sourceTimeZone: 'Asia/Shanghai',
    effectiveStartDate: '2026-01-01',
    effectiveEndDateExclusive: '2027-01-01',
    daysOfWeek: [1, 2, 3, 4, 5, 6, 7],
    periods: [
      { type: 'valley', startMinute: 0, endMinute: 360 },
      { type: 'flat', startMinute: 360, endMinute: 600 },
      { type: 'peak', startMinute: 600, endMinute: 720 },
      { type: 'flat', startMinute: 720, endMinute: 1080 },
      { type: 'peak', startMinute: 1080, endMinute: 1320 },
      { type: 'valley', startMinute: 1320, endMinute: 1440 }
    ],
    crossBoundaryWindow: {
      startUtc: '2026-07-14T21:45:00.000Z',
      endUtc: '2026-07-14T22:15:00.000Z',
      localStart: '05:45',
      localEnd: '06:15',
      expectedPeriodTypes: ['valley', 'flat']
    }
  };
}

/**
 * 构造具备来源、文号、版本和有效期的折标系数。
 * @returns {object[]} 折标系数列表。
 */
function createConversionFactors() {
  return [
    {
      id: 'factor-electricity-2026',
      code: 'electricity-standard-coal-2026',
      energyTypeCode: 'electricity',
      sourceUnit: 'kWh',
      factorValue: 0.1229,
      targetUnit: 'kgce',
      displayUnit: 'tce',
      displayDivisor: 1000,
      source: '综合能耗计算通则示例来源',
      documentNo: 'GB/T-ACCEPTANCE-2026-E',
      version: 'electricity-factor:v1',
      effectiveStartDate: '2026-01-01',
      effectiveEndDateExclusive: '2027-01-01',
      status: 'active'
    },
    {
      id: 'factor-natural-gas-2026',
      code: 'natural-gas-standard-coal-2026',
      energyTypeCode: 'natural_gas',
      sourceUnit: 'm3',
      factorValue: 1.33,
      targetUnit: 'kgce',
      displayUnit: 'tce',
      displayDivisor: 1000,
      source: '综合能耗计算通则示例来源',
      documentNo: 'GB/T-ACCEPTANCE-2026-G',
      version: 'natural-gas-factor:v1',
      effectiveStartDate: '2026-01-01',
      effectiveEndDateExclusive: '2027-01-01',
      status: 'active'
    }
  ];
}

/**
 * 构造外部标准、人工标杆和内部固化历史基准。
 * @returns {object} 对标样例。
 */
function createBenchmarkFixture() {
  return {
    externalStandard: {
      id: 'external-standard-01',
      type: 'external_standard',
      metricCode: 'unit_product_energy',
      unit: 'kgce/t',
      periodType: 'month',
      scope: 'production-unit-a',
      direction: 'lower_better',
      targetValue: 120,
      source: '行业能效标准示例',
      documentNo: 'INDUSTRY-STD-2026-01',
      version: 'external-standard:v1',
      effectiveStartDate: '2026-01-01',
      effectiveEndDateExclusive: '2027-01-01'
    },
    manualBenchmark: {
      id: 'manual-benchmark-01',
      type: 'manual_benchmark',
      metricCode: 'energy_recovery_rate',
      unit: '%',
      periodType: 'month',
      scope: 'production-unit-a',
      direction: 'higher_better',
      targetValue: 85,
      source: '企业年度目标',
      documentNo: 'MANUAL-TARGET-2026-01',
      version: 'manual-benchmark:v1',
      effectiveStartDate: '2026-01-01',
      effectiveEndDateExclusive: '2027-01-01'
    },
    rangeBenchmark: {
      id: 'range-benchmark-01',
      type: 'manual_benchmark',
      metricCode: 'load_rate',
      unit: '%',
      periodType: 'day',
      scope: 'production-unit-a',
      direction: 'range',
      lowerBound: 65,
      upperBound: 85,
      source: '企业运行目标区间',
      documentNo: 'LOAD-RANGE-2026-01',
      version: 'range-benchmark:v1',
      effectiveStartDate: '2026-01-01',
      effectiveEndDateExclusive: '2027-01-01'
    },
    internalFrozenBaseline: {
      id: 'internal-baseline-2025',
      type: 'internal_history_baseline',
      metricCode: 'unit_product_energy',
      unit: 'kgce/t',
      periodType: 'year',
      scope: 'production-unit-a',
      direction: 'lower_better',
      targetValue: 128.4,
      referencePeriodStart: '2025-01-01',
      referencePeriodEndExclusive: '2026-01-01',
      frozenValue: 128.4,
      frozenAt: '2026-01-05T08:00:00.000Z',
      sampleMonthCount: 12,
      productionSummary: {
        outputValue: 5800,
        monthCount: 12
      },
      sourceDataDigest: 'sha256:acceptance-baseline-2025-fixed',
      frozen: true,
      autoRefresh: false,
      version: 'internal-baseline:v1'
    }
  };
}

/**
 * 构造包含六类节点和四类来源映射的正常能流模型。
 * @returns {object} 正常能流模型。
 */
function createNormalEnergyFlowModel() {
  return {
    modelCode: 'energy-flow-model-normal',
    version: 'energy-flow:v1',
    nodes: [
      { code: 'grid-source', name: '外购电源', type: 'source', x: 40, y: 80 },
      { code: 'gas-source', name: '天然气源', type: 'source', x: 40, y: 220 },
      { code: 'pv-source', name: '光伏电源', type: 'source', x: 40, y: 340 },
      { code: 'site-boundary', name: '厂区边界', type: 'boundary', x: 220, y: 120 },
      { code: 'main-process', name: '生产过程', type: 'process', x: 420, y: 160 },
      { code: 'battery-storage', name: '储能', type: 'storage', x: 420, y: 300 },
      { code: 'facility-sink', name: '辅助设施', type: 'sink', x: 650, y: 100 },
      { code: 'known-loss', name: '已确认损耗', type: 'loss', x: 650, y: 260 }
    ],
    edges: [
      {
        code: 'edge-grid-boundary',
        fromNodeCode: 'grid-source',
        toNodeCode: 'site-boundary',
        energyTypeCode: 'electricity',
        unit: 'kWh',
        sourceType: 'timeseries',
        sourceMapping: { reference: 'electricity:2026-07-15' }
      },
      {
        code: 'edge-boundary-process',
        fromNodeCode: 'site-boundary',
        toNodeCode: 'main-process',
        energyTypeCode: 'electricity',
        unit: 'kWh',
        sourceType: 'monthly_energy',
        sourceMapping: { reference: 'energy-record:electricity:2026-07' }
      },
      {
        code: 'edge-pv-boundary',
        fromNodeCode: 'pv-source',
        toNodeCode: 'site-boundary',
        energyTypeCode: 'electricity',
        unit: 'kWh',
        sourceType: 'generation',
        sourceMapping: { reference: 'generation:production-unit-a:2026-07' }
      },
      {
        code: 'edge-process-storage',
        fromNodeCode: 'main-process',
        toNodeCode: 'battery-storage',
        energyTypeCode: 'electricity',
        unit: 'kWh',
        sourceType: 'explicit_edge_value',
        sourceMapping: { reference: 'edge-value:process-storage:2026-07' }
      },
      {
        code: 'edge-storage-sink',
        fromNodeCode: 'battery-storage',
        toNodeCode: 'facility-sink',
        energyTypeCode: 'electricity',
        unit: 'kWh',
        sourceType: 'explicit_edge_value',
        sourceMapping: { reference: 'edge-value:storage-sink:2026-07' }
      },
      {
        code: 'edge-process-loss',
        fromNodeCode: 'main-process',
        toNodeCode: 'known-loss',
        energyTypeCode: 'electricity',
        unit: 'kWh',
        sourceType: 'explicit_edge_value',
        sourceMapping: { reference: 'edge-value:known-loss:2026-07' }
      },
      {
        code: 'edge-gas-process',
        fromNodeCode: 'gas-source',
        toNodeCode: 'main-process',
        energyTypeCode: 'natural_gas',
        unit: 'm3',
        sourceType: 'monthly_energy',
        sourceMapping: { reference: 'energy-record:natural-gas:2026-07' }
      }
    ]
  };
}

/**
 * 构造来源未映射的独立异常能流变体。
 * @returns {object} 异常能流模型。
 */
function createUnmappedEnergyFlowModel() {
  const model = createNormalEnergyFlowModel();
  model.modelCode = 'energy-flow-model-unmapped';
  model.edges[1].sourceMapping = null;
  model.expectedReasonCodes = ['TOPOLOGY_SOURCE_UNMAPPED'];
  return model;
}

/**
 * 构造指定能源的九类平衡项目。
 * @param {string} energyTypeCode 能源类型编码。
 * @param {string} unit 原始单位。
 * @param {object} values 各角色值。
 * @returns {object[]} 平衡项目。
 */
function createBalanceItems(energyTypeCode, unit, values) {
  return [
    'input',
    'self_generation',
    'inventory_decrease',
    'adjustment_increase',
    'output',
    'useful_utilization',
    'known_loss',
    'inventory_increase',
    'adjustment_decrease'
  ].map((role) => ({
    id: `${energyTypeCode}-${role}`,
    role,
    energyTypeCode,
    unit,
    value: values[role],
    sourceMapping: {
      type: role === 'self_generation' ? 'generation' : 'explicit_balance_value',
      reference: `balance-source:${energyTypeCode}:${role}:2026-07`
    }
  }));
}

/**
 * 构造电力零差额与天然气 200 m3 不可解释差额样例。
 * @returns {object} 平衡样例。
 */
function createBalanceFixture() {
  return {
    electricity: {
      energyTypeCode: 'electricity',
      unit: 'kWh',
      items: createBalanceItems('electricity', 'kWh', {
        input: 1000,
        self_generation: 200,
        inventory_decrease: 0,
        adjustment_increase: 0,
        output: 100,
        useful_utilization: 1000,
        known_loss: 50,
        inventory_increase: 50,
        adjustment_decrease: 0
      }),
      expectedUnexplainedValue: 0,
      expectedClassification: 'balanced'
    },
    naturalGas: {
      energyTypeCode: 'natural_gas',
      unit: 'm3',
      items: createBalanceItems('natural_gas', 'm3', {
        input: 1000,
        self_generation: 0,
        inventory_decrease: 0,
        adjustment_increase: 0,
        output: 100,
        useful_utilization: 650,
        known_loss: 50,
        inventory_increase: 0,
        adjustment_decrease: 0
      }),
      expectedUnexplainedValue: 200,
      expectedClassification: 'unexplained',
      mustNotAutoClassifyAs: ['known_loss', 'stopped', 'idle']
    }
  };
}

/**
 * 构造阈值语义一致的规则输出及人工处理状态样例。
 * @returns {object[]} 规则输出样例。
 */
function createRuleEvaluations() {
  return [
    {
      ruleCode: 'PEAK_LOAD_REVIEW',
      ruleVersion: 'peak-load-rule:v1',
      formulaVersion: 'load-analysis:v1',
      matchStatus: 'matched',
      reviewStatus: 'unconfirmed',
      threshold: { operator: 'gt', value: 140, unit: 'kWh/15min' },
      actualValue: 148,
      evidence: ['electricity-interval-43', 'electricity-interval-44'],
      dataRange: {
        startUtc: '2026-07-14T16:00:00.000Z',
        endUtc: '2026-07-15T16:00:00.000Z',
        sourceTimeZone: 'Asia/Shanghai'
      },
      coverageRate: 1,
      priority: 'high',
      recommendation: '请人工复核峰值时段并决定是否调整用能安排。',
      estimatedSaving: null,
      estimatedSavingUnit: null,
      automationBoundary: {
        usesAI: false,
        issuesControlCommand: false,
        changesDeviceState: false,
        requiresManualReview: true
      },
      usesAI: false,
      issuesControlCommand: false,
      changesDeviceState: false,
      requiresManualReview: true
    },
    {
      ruleCode: 'LOAD_RATE_TARGET',
      ruleVersion: 'load-rate-rule:v1',
      formulaVersion: 'load-analysis:v1',
      matchStatus: 'matched',
      reviewStatus: 'accepted',
      threshold: { operator: 'between', min: 65, max: 85, unit: '%' },
      actualValue: 72,
      evidence: ['load-rate-summary:2026-07-15'],
      dataRange: {
        startUtc: '2026-07-14T16:00:00.000Z',
        endUtc: '2026-07-15T16:00:00.000Z',
        sourceTimeZone: 'Asia/Shanghai'
      },
      coverageRate: 1,
      priority: 'medium',
      recommendation: '请人工确认当前负荷率是否继续保持。',
      estimatedSaving: null,
      estimatedSavingUnit: null,
      automationBoundary: {
        usesAI: false,
        issuesControlCommand: false,
        changesDeviceState: false,
        requiresManualReview: true
      },
      usesAI: false,
      issuesControlCommand: false,
      changesDeviceState: false,
      requiresManualReview: true
    },
    {
      ruleCode: 'IDLE_ENERGY_REVIEW',
      ruleVersion: 'idle-energy-rule:v1',
      formulaVersion: 'load-analysis:v1',
      matchStatus: 'not_evaluable',
      reviewStatus: 'resolved',
      threshold: { operator: 'gt', value: 0, unit: 'kWh' },
      actualValue: null,
      evidence: ['device-state-gap:2026-07-15T01:00:00.000Z'],
      dataRange: {
        startUtc: '2026-07-14T16:00:00.000Z',
        endUtc: '2026-07-15T16:00:00.000Z',
        sourceTimeZone: 'Asia/Shanghai'
      },
      coverageRate: 23 / 24,
      priority: 'low',
      recommendation: '请人工补齐设备状态记录后重新评估空载能耗。',
      reasonCodes: ['DEVICE_STATE_GAP'],
      estimatedSaving: null,
      estimatedSavingUnit: null,
      automationBoundary: {
        usesAI: false,
        issuesControlCommand: false,
        changesDeviceState: false,
        requiresManualReview: true
      },
      usesAI: false,
      issuesControlCommand: false,
      changesDeviceState: false,
      requiresManualReview: true
    }
  ];
}

/**
 * 构造每次调用均全新的阶段 1 统一验收数据。
 * @returns {object} 统一验收 fixture。
 */
function createEnergyAnalysisAcceptanceFixture() {
  return {
    acceptanceDay: {
      localDate: '2026-07-15',
      sourceTimeZone: 'Asia/Shanghai',
      startUtc: '2026-07-14T16:00:00.000Z',
      endUtc: '2026-07-15T16:00:00.000Z',
      boundary: '[startUtc,endUtc)',
      granularityMinutes: 15
    },
    timeSeries: {
      electricity: createTimeSeriesRecords('electricity', 'kWh', 100),
      naturalGas: createTimeSeriesRecords('natural_gas', 'm3', 10)
    },
    crossEnergyAggregation: {
      allowed: false,
      reasonCode: 'UNIT_NOT_COMPARABLE',
      separateFacets: [
        { energyTypeCode: 'electricity', unit: 'kWh' },
        { energyTypeCode: 'natural_gas', unit: 'm3' }
      ]
    },
    shifts: createShiftSchedules(),
    deviceStates: createDeviceStateFixture(),
    timeOfUseRule: createTimeOfUseRule(),
    conversionFactors: createConversionFactors(),
    monthlyProduction: {
      month: '2026-07',
      productionUnitId: 'production-unit-a',
      outputValue: 500,
      outputUnit: 't',
      sourceReference: 'production-record:production-unit-a:2026-07'
    },
    generation: {
      month: '2026-07',
      productionUnitId: 'production-unit-a',
      energyTypeCode: 'electricity',
      unit: 'kWh',
      totalValue: 12000,
      selfConsumptionValue: 9000,
      gridExportValue: 3000,
      sourceRecordId: 'generation-record:production-unit-a:2026-07',
      antiDoubleCountingKey: 'generation-boundary:production-unit-a:2026-07:electricity',
      boundaryConfirmed: true,
      permittedRoles: ['self_generation', 'output']
    },
    benchmarks: createBenchmarkFixture(),
    energyFlowModels: {
      normal: createNormalEnergyFlowModel(),
      unmappedVariant: createUnmappedEnergyFlowModel()
    },
    balances: createBalanceFixture(),
    ruleEvaluations: createRuleEvaluations(),
    expectedReasonCodes: ['DEVICE_STATE_GAP', 'TOPOLOGY_SOURCE_UNMAPPED', 'UNIT_NOT_COMPARABLE']
  };
}

module.exports = {
  createEnergyAnalysisAcceptanceFixture
};
