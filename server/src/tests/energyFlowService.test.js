'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 本测试始终使用系统临时目录和隔离 SQLite，禁止访问真实 data。
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-energy-flow-service-'));
// 隔离数据库路径。
const temporaryDatabasePath = path.join(temporaryRoot, 'energy-flow-service.sqlite');
process.env.DATA_DIR = temporaryRoot;
process.env.SQLITE_PATH = temporaryDatabasePath;
process.env.UPLOADS_DIR = path.join(temporaryRoot, 'uploads');
process.env.BACKUPS_DIR = path.join(temporaryRoot, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'EnergyFlowServiceTest123!';

const { initDatabase, openDatabase } = require('../db/database');
const {
  analyzeEnergyFlow,
  createEnergyFlowEdge: createEnergyFlowEdgeWithoutAudit,
  createEnergyFlowModel: createEnergyFlowModelWithoutAudit,
  createEnergyFlowNode: createEnergyFlowNodeWithoutAudit,
  getEnergyFlowTopology,
  listEnergyFlowEdges,
  listEnergyFlowModels,
  listEnergyFlowNodes,
  setEnergyFlowEdgeStatus: setEnergyFlowEdgeStatusWithoutAudit,
  setEnergyFlowModelStatus: setEnergyFlowModelStatusWithoutAudit,
  setEnergyFlowNodeStatus: setEnergyFlowNodeStatusWithoutAudit,
  updateEnergyFlowEdge: updateEnergyFlowEdgeWithoutAudit,
  updateEnergyFlowModel: updateEnergyFlowModelWithoutAudit,
  updateEnergyFlowNode: updateEnergyFlowNodeWithoutAudit
} = require('../services/energyFlowService');

// 测试模型有效期。
const MODEL_RANGE = Object.freeze({
  effectiveStartUtc: '2026-01-01T00:00:00Z',
  effectiveEndUtc: '2027-01-01T00:00:00Z',
  sourceTimeZone: 'Asia/Shanghai'
});
// 正常业务写统一使用隔离库内置管理员身份。
let auditActorUserId = null;

/**
 * 构造能流写操作审计选项。
 * @param {string} operation 操作编码。
 * @param {string} targetType 目标类型。
 * @returns {object} 服务写入选项。
 */
function createAuditOptions(operation, targetType) {
  return {
    audit: {
      userId: auditActorUserId,
      operation,
      targetType,
      ip: '127.0.0.1'
    }
  };
}

/** 模型创建测试包装器。 */
function createEnergyFlowModel(input) {
  return createEnergyFlowModelWithoutAudit(input, createAuditOptions('energy.flow.model.create', 'energy_flow_model'));
}

/** 模型更新测试包装器。 */
function updateEnergyFlowModel(modelId, input) {
  return updateEnergyFlowModelWithoutAudit(modelId, input, createAuditOptions('energy.flow.model.update', 'energy_flow_model'));
}

/** 模型状态测试包装器。 */
function setEnergyFlowModelStatus(modelId, status) {
  return setEnergyFlowModelStatusWithoutAudit(modelId, status, createAuditOptions('energy.flow.model.status', 'energy_flow_model'));
}

/** 节点创建测试包装器。 */
function createEnergyFlowNode(modelId, input) {
  return createEnergyFlowNodeWithoutAudit(modelId, input, createAuditOptions('energy.flow.node.create', 'energy_flow_node'));
}

/** 节点更新测试包装器。 */
function updateEnergyFlowNode(modelId, nodeId, input) {
  return updateEnergyFlowNodeWithoutAudit(modelId, nodeId, input, createAuditOptions('energy.flow.node.update', 'energy_flow_node'));
}

/** 节点状态测试包装器。 */
function setEnergyFlowNodeStatus(modelId, nodeId, status) {
  return setEnergyFlowNodeStatusWithoutAudit(modelId, nodeId, status, createAuditOptions('energy.flow.node.status', 'energy_flow_node'));
}

/** 边创建测试包装器。 */
function createEnergyFlowEdge(modelId, input) {
  return createEnergyFlowEdgeWithoutAudit(modelId, input, createAuditOptions('energy.flow.edge.create', 'energy_flow_edge'));
}

/** 边更新测试包装器。 */
function updateEnergyFlowEdge(modelId, edgeId, input) {
  return updateEnergyFlowEdgeWithoutAudit(modelId, edgeId, input, createAuditOptions('energy.flow.edge.update', 'energy_flow_edge'));
}

/** 边状态测试包装器。 */
function setEnergyFlowEdgeStatus(modelId, edgeId, status) {
  return setEnergyFlowEdgeStatusWithoutAudit(modelId, edgeId, status, createAuditOptions('energy.flow.edge.status', 'energy_flow_edge'));
}

/**
 * 断言同步动作抛出稳定详情错误码。
 * @param {Function} action 测试动作。
 * @param {string} expectedCode 预期错误码。
 * @returns {Error} 捕获错误。
 */
function assertThrowsCode(action, expectedCode) {
  let captured = null;
  try {
    action();
  } catch (error) {
    captured = error;
  }
  assert(captured, `预期抛出 ${expectedCode}`);
  assert.strictEqual(captured.details?.code || captured.code, expectedCode, captured.stack || captured.message);
  return captured;
}

/**
 * 新建模型版本。
 * @param {string} modelCode 模型编码。
 * @param {string} version 版本。
 * @returns {object} 模型。
 */
function createModel(modelCode, version = 'v1') {
  return createEnergyFlowModel({
    modelCode,
    modelName: `${modelCode} 测试模型`,
    source: '隔离测试',
    documentNo: `DOC-${modelCode}`,
    version,
    ...MODEL_RANGE,
    status: 'active'
  });
}

/**
 * 新建模型节点。
 * @param {number} modelId 模型 ID。
 * @param {string} code 节点编码。
 * @param {string} type 节点类型。
 * @param {number} x 横坐标。
 * @returns {object} 节点。
 */
function createNode(modelId, code, type, x) {
  return createEnergyFlowNode(modelId, {
    nodeCode: code,
    nodeName: `${code} 节点`,
    nodeType: type,
    x,
    y: 10,
    status: 'active'
  });
}

/**
 * 读取测试能源类型。
 * @returns {object} 电力能源类型。
 */
function getElectricityType() {
  const db = openDatabase();
  try {
    const row = db.prepare(
      `SELECT id, code, standard_unit AS standardUnit
       FROM energy_types WHERE code = 'electricity'`
    ).get();
    assert(row, '初始化数据库必须包含 electricity。');
    return { ...row, id: Number(row.id) };
  } finally {
    db.close();
  }
}

/**
 * 插入显式边值。
 * @param {number} modelId 模型 ID。
 * @param {number} edgeId 边 ID。
 * @param {number} value 数值。
 * @param {string} startUtc 开始 UTC。
 * @param {string} endUtc 结束 UTC。
 * @returns {number} 记录 ID。
 */
function insertExplicitValue(modelId, edgeId, value, startUtc = '2026-01-01T00:00:00Z', endUtc = '2026-02-01T00:00:00Z') {
  const db = openDatabase();
  try {
    return Number(db.prepare(
      `INSERT INTO energy_flow_records (
         energy_flow_model_id, energy_flow_edge_id, start_utc, end_utc, source_timezone,
         original_unit, original_value, source_type, source_mapping_json, formula_version, record_status
       ) VALUES (?, ?, ?, ?, 'Asia/Shanghai', 'kWh', ?, 'explicit_edge_value', ?, 'energy-flow:v1', 'active')`
    ).run(modelId, edgeId, startUtc, endUtc, value, JSON.stringify({ reference: `explicit:${edgeId}:${startUtc}` })).lastInsertRowid);
  } finally {
    db.close();
  }
}

/**
 * 测试模型、节点、边维护和拓扑保护。
 * @returns {object} 主模型测试数据。
 */
function testConfigurationCrudAndTopology() {
  const electricity = getElectricityType();
  const model = createModel('FLOW-SERVICE-CRUD');
  assert.strictEqual(model.version, 'v1');
  assert.strictEqual(model.nodeCount, 0);
  assertThrowsCode(() => createModel('FLOW-SERVICE-CRUD'), 'DUPLICATE_ENERGY_FLOW_MODEL_VERSION');
  assertThrowsCode(
    () => updateEnergyFlowModel(model.id, { version: 'v2' }),
    'ENERGY_FLOW_MODEL_IDENTITY_IMMUTABLE'
  );
  assertThrowsCode(
    () => updateEnergyFlowModel(model.id, { effectiveEndUtc: '2028-01-01T00:00:00Z' }),
    'ENERGY_FLOW_MODEL_PROVENANCE_IMMUTABLE'
  );
  const renamed = updateEnergyFlowModel(model.id, { modelName: '更新后的能流模型' });
  assert.strictEqual(renamed.modelName, '更新后的能流模型');

  const source = createNode(model.id, 'SOURCE', 'source', 0);
  const storage = createNode(model.id, 'STORAGE', 'storage', 100);
  const sink = createNode(model.id, 'SINK', 'sink', 200);
  const renamedStorage = updateEnergyFlowNode(model.id, storage.id, { nodeName: '储能节点更新', x: 110 });
  assert.strictEqual(renamedStorage.x, 110);
  assert.strictEqual(listEnergyFlowNodes(model.id, { pageSize: 999 }).pagination.pageSize, 200);

  const incoming = createEnergyFlowEdge(model.id, {
    edgeCode: 'EDGE-IN',
    fromNodeId: source.id,
    toNodeId: storage.id,
    energyTypeId: electricity.id,
    unit: electricity.standardUnit,
    sourceType: 'explicit_edge_value',
    sourceMapping: { reference: 'explicit:edge-in' }
  });
  const outgoing = createEnergyFlowEdge(model.id, {
    edgeCode: 'EDGE-OUT',
    fromNodeId: storage.id,
    toNodeId: sink.id,
    energyTypeCode: electricity.code,
    unit: electricity.standardUnit,
    sourceType: 'explicit_edge_value',
    sourceMapping: { reference: 'explicit:edge-out' }
  });
  assertThrowsCode(
    () => createEnergyFlowEdge(model.id, {
      edgeCode: 'EDGE-DUPLICATE',
      fromNodeId: source.id,
      toNodeId: storage.id,
      energyTypeId: electricity.id,
      unit: electricity.standardUnit,
      sourceType: 'explicit_edge_value',
      sourceMapping: { reference: 'explicit:edge-in' }
    }),
    'DUPLICATE_ENERGY_FLOW_EDGE'
  );
  assertThrowsCode(
    () => createEnergyFlowEdge(model.id, {
      edgeCode: 'EDGE-SELF',
      fromNodeId: source.id,
      toNodeId: source.id,
      energyTypeId: electricity.id,
      unit: electricity.standardUnit,
      sourceType: 'explicit_edge_value',
      sourceMapping: { reference: 'explicit:self' }
    }),
    'ENERGY_FLOW_SELF_LOOP_UNSUPPORTED'
  );
  assertThrowsCode(
    () => createEnergyFlowEdge(model.id, {
      edgeCode: 'EDGE-UNMAPPED',
      fromNodeId: source.id,
      toNodeId: sink.id,
      energyTypeId: electricity.id,
      unit: electricity.standardUnit,
      sourceType: 'timeseries',
      sourceMapping: { reference: 'timeseries:no-selector' }
    }),
    'TOPOLOGY_SOURCE_UNMAPPED'
  );
  assertThrowsCode(
    () => createEnergyFlowEdge(model.id, {
      edgeCode: 'EDGE-BAD-UNIT',
      fromNodeId: source.id,
      toNodeId: sink.id,
      energyTypeId: electricity.id,
      unit: 'GJ',
      sourceType: 'explicit_edge_value',
      sourceMapping: { reference: 'explicit:bad-unit' }
    }),
    'ENERGY_FLOW_UNIT_INCOMPATIBLE'
  );
  const otherModel = createModel('FLOW-SERVICE-OTHER');
  const foreignNode = createNode(otherModel.id, 'FOREIGN', 'sink', 20);
  const crossModelError = assertThrowsCode(
    () => createEnergyFlowEdge(model.id, {
      edgeCode: 'EDGE-CROSS',
      fromNodeId: source.id,
      toNodeId: foreignNode.id,
      energyTypeId: electricity.id,
      unit: electricity.standardUnit,
      sourceType: 'explicit_edge_value',
      sourceMapping: { reference: 'explicit:cross' }
    }),
    'NOT_FOUND'
  );
  assert.strictEqual(crossModelError.statusCode, 404);

  const topology = getEnergyFlowTopology(model.id);
  assert.strictEqual(topology.nodes.length, 3);
  assert.strictEqual(topology.edges.length, 2);
  assert.strictEqual(topology.contract.topologyMode, 'explicit_only');
  assert.strictEqual(topology.contract.infersOrganizationTree, false);
  assert.strictEqual(listEnergyFlowEdges(model.id, { pageSize: 999 }).pagination.pageSize, 200);
  assertThrowsCode(() => setEnergyFlowNodeStatus(model.id, source.id, 'inactive'), 'ENERGY_FLOW_NODE_HAS_ACTIVE_EDGES');
  assert.strictEqual(setEnergyFlowEdgeStatus(model.id, incoming.id, 'inactive').status, 'inactive');
  assert.strictEqual(setEnergyFlowEdgeStatus(model.id, incoming.id, 'active').status, 'active');
  assert.strictEqual(setEnergyFlowModelStatus(model.id, 'inactive').status, 'inactive');
  assert.strictEqual(setEnergyFlowModelStatus(model.id, 'active').status, 'active');

  const renamedIncoming = updateEnergyFlowEdge(model.id, incoming.id, { edgeCode: 'EDGE-IN-RENAMED' });
  assert.strictEqual(renamedIncoming.edgeCode, 'EDGE-IN-RENAMED');
  insertExplicitValue(model.id, incoming.id, 100);
  insertExplicitValue(model.id, outgoing.id, 90);
  assertThrowsCode(
    () => updateEnergyFlowEdge(model.id, incoming.id, { toNodeId: sink.id }),
    'ENERGY_FLOW_EDGE_BINDING_IMMUTABLE'
  );
  assertThrowsCode(
    () => updateEnergyFlowEdge(model.id, incoming.id, { edgeCode: 'EDGE-IN-RENAMED-AGAIN' }),
    'ENERGY_FLOW_EDGE_CODE_IMMUTABLE'
  );
  assertThrowsCode(
    () => updateEnergyFlowNode(model.id, source.id, { nodeCode: 'SOURCE-RENAMED' }),
    'ENERGY_FLOW_NODE_CODE_IMMUTABLE'
  );
  assertThrowsCode(
    () => updateEnergyFlowNode(model.id, source.id, { nodeType: 'process' }),
    'ENERGY_FLOW_NODE_BINDING_IMMUTABLE'
  );

  const models = listEnergyFlowModels({ pageSize: 999, keyword: 'FLOW-SERVICE' });
  assert.strictEqual(models.pagination.pageSize, 200);
  assert(models.rows.length >= 2);
  return { electricity, model, source, storage, sink, incoming: renamedIncoming, outgoing };
}

/**
 * 测试差额守恒、储能映射、真实零、缺失和折标歧义。
 * @param {object} master 主模型测试数据。
 */
function testAnalysisQualityAndConversion(master) {
  const db = openDatabase();
  try {
    db.prepare(
      `INSERT INTO energy_conversion_factors (
         factor_code, energy_type_id, source_unit, factor_value, source, document_no, version,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES ('FLOW-ELECTRICITY-FACTOR', ?, 'kWh', 0.1229, '隔离测试', 'TEST-FACTOR', 'v1',
         '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`
    ).run(master.electricity.id);
  } finally {
    db.close();
  }
  const analysis = analyzeEnergyFlow(master.model.id, {
    startMonth: '2026-01',
    endMonth: '2026-01',
    storageChanges: [{
      nodeId: master.storage.id,
      energyTypeCode: 'electricity',
      unit: 'kWh',
      value: 10,
      sourceMapping: { reference: 'inventory:storage:2026-01' }
    }]
  });
  assert.strictEqual(analysis.coverage.completeRate, 1);
  const storageBalance = analysis.nodeBalances.find((node) => node.nodeId === master.storage.id).facets[0];
  assert.strictEqual(storageBalance.inflow, 100);
  assert.strictEqual(storageBalance.outflow, 90);
  assert.strictEqual(storageBalance.storageChange, 10);
  assert.strictEqual(storageBalance.difference, 0);
  assert.strictEqual(storageBalance.imbalanceRate, 0);
  assert.strictEqual(storageBalance.autoClassifiedLoss, false);
  assert.strictEqual(storageBalance.standardCoal.kgce, 0);
  assert.strictEqual(analysis.edgeValues[0].standardCoal.kgce, 12.29);

  const missingStorage = analyzeEnergyFlow(master.model.id, { startMonth: '2026-01', endMonth: '2026-01' });
  const missingStorageBalance = missingStorage.nodeBalances.find((node) => node.nodeId === master.storage.id).facets[0];
  assert.strictEqual(missingStorageBalance.difference, null);
  assert(missingStorageBalance.reasonCodes.includes('BALANCE_ITEM_UNMAPPED'));

  const zeroEdge = createEnergyFlowEdge(master.model.id, {
    edgeCode: 'EDGE-ZERO',
    fromNodeId: master.source.id,
    toNodeId: master.sink.id,
    energyTypeId: master.electricity.id,
    unit: 'kWh',
    sourceType: 'explicit_edge_value',
    sourceMapping: { reference: 'explicit:zero' }
  });
  insertExplicitValue(master.model.id, zeroEdge.id, 0);
  const missingEdge = createEnergyFlowEdge(master.model.id, {
    edgeCode: 'EDGE-MISSING',
    fromNodeId: master.source.id,
    toNodeId: master.sink.id,
    energyTypeId: master.electricity.id,
    unit: 'kWh',
    sourceType: 'explicit_edge_value',
    sourceMapping: { reference: 'explicit:missing' }
  });
  const quality = analyzeEnergyFlow(master.model.id, {
    startMonth: '2026-01',
    endMonth: '2026-01',
    storageChanges: [{
      nodeId: master.storage.id,
      energyTypeCode: 'electricity',
      unit: 'kWh',
      value: 10,
      sourceMapping: { reference: 'inventory:storage:2026-01' }
    }]
  });
  const zeroResult = quality.edgeValues.find((edge) => edge.edgeId === zeroEdge.id);
  const missingResult = quality.edgeValues.find((edge) => edge.edgeId === missingEdge.id);
  assert.strictEqual(zeroResult.value, 0);
  assert.strictEqual(zeroResult.trueZero, true);
  assert.strictEqual(missingResult.value, null);
  assert.strictEqual(missingResult.status, 'missing');
  assert(missingResult.reasonCodes.includes('NO_TIMESERIES_DATA'));
  assert.strictEqual(quality.coverage.missingEdgeCount, 1);

  const partialEdge = createEnergyFlowEdge(master.model.id, {
    edgeCode: 'EDGE-PARTIAL',
    fromNodeId: master.source.id,
    toNodeId: master.sink.id,
    energyTypeId: master.electricity.id,
    unit: 'kWh',
    sourceType: 'explicit_edge_value',
    sourceMapping: { reference: 'explicit:partial' }
  });
  insertExplicitValue(master.model.id, partialEdge.id, 31, '2026-01-01T00:00:00Z', '2026-01-16T00:00:00Z');
  const partialAnalysis = analyzeEnergyFlow(master.model.id, { startMonth: '2026-01', endMonth: '2026-01' });
  const partialResult = partialAnalysis.edgeValues.find((edge) => edge.edgeId === partialEdge.id);
  assert.strictEqual(partialResult.value, null);
  assert.strictEqual(partialResult.observedValue, 31);
  assert.strictEqual(partialResult.status, 'partial');
  assert(partialResult.reasonCodes.includes('COVERAGE_BELOW_THRESHOLD'));

  const overlapEdge = createEnergyFlowEdge(master.model.id, {
    edgeCode: 'EDGE-OVERLAP',
    fromNodeId: master.source.id,
    toNodeId: master.sink.id,
    energyTypeId: master.electricity.id,
    unit: 'kWh',
    sourceType: 'explicit_edge_value',
    sourceMapping: { reference: 'explicit:overlap' }
  });
  insertExplicitValue(master.model.id, overlapEdge.id, 20, '2026-01-01T00:00:00Z', '2026-01-20T00:00:00Z');
  insertExplicitValue(master.model.id, overlapEdge.id, 25, '2026-01-10T00:00:00Z', '2026-02-01T00:00:00Z');
  const overlapAnalysis = analyzeEnergyFlow(master.model.id, { startMonth: '2026-01', endMonth: '2026-01' });
  const overlapResult = overlapAnalysis.edgeValues.find((edge) => edge.edgeId === overlapEdge.id);
  assert.strictEqual(overlapResult.value, null);
  assert.strictEqual(overlapResult.status, 'unavailable');
  assert(overlapResult.reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE'));

  const legacyDb = openDatabase();
  let legacyUnmappedId;
  try {
    legacyUnmappedId = Number(legacyDb.prepare(
      `INSERT INTO energy_flow_edges (
         energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id,
         unit, source_type, source_mapping_json, status
       ) VALUES (?, 'EDGE-LEGACY-UNMAPPED', ?, ?, ?, 'kWh', 'timeseries', ?, 'active')`
    ).run(master.model.id, master.source.id, master.sink.id, master.electricity.id, JSON.stringify({ reference: 'legacy:no-selector' })).lastInsertRowid);
    legacyDb.prepare(
      `INSERT INTO energy_flow_edges (
         energy_flow_model_id, edge_code, from_node_id, to_node_id, energy_type_id,
         unit, source_type, source_mapping_json, status
       ) VALUES (?, 'EDGE-LEGACY-BAD-UNIT', ?, ?, ?, 'GJ', 'explicit_edge_value', ?, 'active')`
    ).run(master.model.id, master.source.id, master.sink.id, master.electricity.id, JSON.stringify({ reference: 'legacy:bad-unit' }));
    legacyDb.prepare(
      `INSERT INTO energy_conversion_factors (
         factor_code, energy_type_id, source_unit, factor_value, source, document_no, version,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES ('FLOW-ELECTRICITY-FACTOR-OVERLAP', ?, 'kWh', 0.1230, '隔离测试', 'TEST-FACTOR-2', 'v1',
         '2026-01-01T00:00:00Z', '2026-06-01T00:00:00Z', 'Asia/Shanghai', 'active')`
    ).run(master.electricity.id);
  } finally {
    legacyDb.close();
  }
  const legacyAnalysis = analyzeEnergyFlow(master.model.id, { startMonth: '2026-01', endMonth: '2026-01' });
  const unmapped = legacyAnalysis.edgeValues.find((edge) => edge.edgeCode === 'EDGE-LEGACY-UNMAPPED');
  const incomparable = legacyAnalysis.edgeValues.find((edge) => edge.edgeCode === 'EDGE-LEGACY-BAD-UNIT');
  assert.strictEqual(unmapped.status, 'unmapped');
  assert(unmapped.reasonCodes.includes('TOPOLOGY_SOURCE_UNMAPPED'));
  assert.strictEqual(incomparable.status, 'unit_not_comparable');
  assert(incomparable.reasonCodes.includes('UNIT_NOT_COMPARABLE'));
  const validEdgeWithAmbiguousFactor = legacyAnalysis.edgeValues.find((edge) => edge.edgeCode === 'EDGE-IN-RENAMED');
  assert.strictEqual(validEdgeWithAmbiguousFactor.standardCoal.kgce, null);
  assert(validEdgeWithAmbiguousFactor.standardCoal.reasonCodes.includes('FACTOR_PERIOD_AMBIGUOUS'));
  assert.strictEqual(setEnergyFlowEdgeStatus(master.model.id, legacyUnmappedId, 'inactive').status, 'inactive');
  assertThrowsCode(
    () => setEnergyFlowEdgeStatus(master.model.id, legacyUnmappedId, 'active'),
    'TOPOLOGY_SOURCE_UNMAPPED'
  );
  assertThrowsCode(
    () => analyzeEnergyFlow(master.model.id, { startMonth: '2025-12', endMonth: '2026-01' }),
    'ENERGY_FLOW_MODEL_RANGE_OUTSIDE_EFFECTIVE_PERIOD'
  );
}

/**
 * 测试四类显式来源映射，尤其验证发电值字段必须明确选择。
 */
function testExplicitSourceResolvers() {
  const electricity = getElectricityType();
  const model = createModel('FLOW-SERVICE-SOURCES');
  const source = createNode(model.id, 'SOURCE', 'source', 0);
  const sink = createNode(model.id, 'SINK', 'sink', 100);
  const db = openDatabase();
  let organizationId;
  let timeseriesRecordId;
  let monthlyRecordId;
  try {
    organizationId = Number(db.prepare(
      `INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('FLOW-SOURCE-OU', '来源解析单元', '/FLOW-SOURCE-OU', 'workshop', 'active')`
    ).run().lastInsertRowid);
    timeseriesRecordId = Number(db.prepare(
      `INSERT INTO energy_timeseries_records (
         energy_type_id, start_utc, end_utc, source_timezone, granularity_minutes,
         original_unit, original_value, normalized_unit, normalized_value,
         source_reference, data_source, record_status
       ) VALUES (?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 'Asia/Shanghai', 60,
         'kWh', 5, 'kWh', 5, 'timeseries:test', 'manual', 'active')`
    ).run(electricity.id).lastInsertRowid);
    monthlyRecordId = Number(db.prepare(
      `INSERT INTO energy_records (
         energy_type_id, original_month, normalized_month, original_unit, original_value,
         normalized_unit, normalized_value, duplicate_key, record_status
       ) VALUES (?, '2026-01', '2026-01', 'kWh', 40, 'kWh', 40, 'flow-monthly-test', 'active')`
    ).run(electricity.id).lastInsertRowid);
    db.prepare(
      `INSERT INTO generation_records (
         organization_unit_id, energy_type_id, normalized_month, generation_value_kwh,
         self_use_value_kwh, grid_export_value_kwh, data_source, record_status
       ) VALUES (?, ?, '2026-01', 100, 30, 50, 'manual', 'active')`
    ).run(organizationId, electricity.id);
  } finally {
    db.close();
  }

  const timeseries = createEnergyFlowEdge(model.id, {
    edgeCode: 'EDGE-TIMESERIES',
    fromNodeId: source.id,
    toNodeId: sink.id,
    energyTypeId: electricity.id,
    unit: 'kWh',
    sourceType: 'timeseries',
    sourceMapping: { reference: 'timeseries:record-id', recordIds: [timeseriesRecordId] }
  });
  const monthly = createEnergyFlowEdge(model.id, {
    edgeCode: 'EDGE-MONTHLY',
    fromNodeId: source.id,
    toNodeId: sink.id,
    energyTypeId: electricity.id,
    unit: 'kWh',
    sourceType: 'monthly_energy',
    sourceMapping: { reference: 'monthly:record-id', recordIds: [monthlyRecordId] }
  });
  const generation = createEnergyFlowEdge(model.id, {
    edgeCode: 'EDGE-GENERATION-SELF-USE',
    fromNodeId: source.id,
    toNodeId: sink.id,
    energyTypeId: electricity.id,
    unit: 'kWh',
    sourceType: 'generation',
    sourceMapping: {
      reference: 'generation:self-use',
      organizationUnitId: organizationId,
      valueField: 'self_use'
    }
  });
  const originalUnitEdge = createEnergyFlowEdge(model.id, {
    edgeCode: 'EDGE-ORIGINAL-MWH',
    fromNodeId: source.id,
    toNodeId: sink.id,
    energyTypeId: electricity.id,
    unit: 'MWh',
    sourceType: 'explicit_edge_value',
    sourceMapping: { reference: 'explicit:original-mwh' }
  });
  insertExplicitValue(model.id, originalUnitEdge.id, 1000);
  assertThrowsCode(
    () => createEnergyFlowEdge(model.id, {
      edgeCode: 'EDGE-GENERATION-NO-ROLE',
      fromNodeId: source.id,
      toNodeId: sink.id,
      energyTypeId: electricity.id,
      unit: 'kWh',
      sourceType: 'generation',
      sourceMapping: { reference: 'generation:implicit', organizationUnitId: organizationId }
    }),
    'TOPOLOGY_SOURCE_UNMAPPED'
  );

  const monthlyAnalysis = analyzeEnergyFlow(model.id, { startMonth: '2026-01', endMonth: '2026-01' });
  const monthlyResult = monthlyAnalysis.edgeValues.find((edge) => edge.edgeId === monthly.id);
  const generationResult = monthlyAnalysis.edgeValues.find((edge) => edge.edgeId === generation.id);
  const originalUnitResult = monthlyAnalysis.edgeValues.find((edge) => edge.edgeId === originalUnitEdge.id);
  assert.strictEqual(monthlyResult.value, 40);
  assert.strictEqual(generationResult.value, 30, '发电边必须读取显式 self_use，不得默认读取总发电量或抵扣能耗。');
  assert.strictEqual(originalUnitResult.unit, 'MWh');
  assert.strictEqual(originalUnitResult.normalizedUnit, 'kWh');
  assert.strictEqual(originalUnitResult.value, 1, '原始 kWh 事实必须换算到边配置的 MWh 分面。');
  assert.strictEqual(monthlyAnalysis.contract.autoOffsetsGeneration, false);
  const timeseriesResultInMonth = monthlyAnalysis.edgeValues.find((edge) => edge.edgeId === timeseries.id);
  assert.strictEqual(timeseriesResultInMonth.status, 'partial');
  assert.strictEqual(timeseriesResultInMonth.observedValue, 5);

  const hourlyAnalysis = analyzeEnergyFlow(model.id, {
    startUtc: '2026-01-01T00:00:00Z',
    endUtc: '2026-01-01T01:00:00Z'
  });
  const hourlyTimeseries = hourlyAnalysis.edgeValues.find((edge) => edge.edgeId === timeseries.id);
  const hourlyMonthly = hourlyAnalysis.edgeValues.find((edge) => edge.edgeId === monthly.id);
  assert.strictEqual(hourlyTimeseries.value, 5);
  assert.strictEqual(hourlyTimeseries.trueZero, false);
  assert.strictEqual(hourlyMonthly.value, null);
  assert(hourlyMonthly.configurationErrors.includes('MONTHLY_SOURCE_REQUIRES_MONTH_ALIGNED_RANGE'));
}

/**
 * 测试时序事实跨相邻折标版本时按区间拆分，月度与发电总量保持不可拆分。
 */
function testConversionFactorPeriodSegmentation() {
  const db = openDatabase();
  let photovoltaic;
  let organizationId;
  let timeseriesRecordId;
  let monthlyRecordId;
  let generationRecordId;
  try {
    photovoltaic = db.prepare(
      `SELECT id, code, standard_unit AS standardUnit
       FROM energy_types WHERE code = 'photovoltaic'`
    ).get();
    assert(photovoltaic, '初始化数据库必须包含 photovoltaic。');
    photovoltaic.id = Number(photovoltaic.id);
    organizationId = Number(db.prepare(
      `INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('FLOW-FACTOR-OU', '折标分段单元', '/FLOW-FACTOR-OU', 'workshop', 'active')`
    ).run().lastInsertRowid);
    timeseriesRecordId = Number(db.prepare(
      `INSERT INTO energy_timeseries_records (
         energy_type_id, start_utc, end_utc, source_timezone, granularity_minutes,
         original_unit, original_value, normalized_unit, normalized_value,
         source_reference, data_source, record_status
       ) VALUES (?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 'Asia/Shanghai', 60,
         'kWh', 100, 'kWh', 100, 'factor-split:timeseries', 'manual', 'active')`
    ).run(photovoltaic.id).lastInsertRowid);
    monthlyRecordId = Number(db.prepare(
      `INSERT INTO energy_records (
         energy_type_id, original_month, normalized_month, original_unit, original_value,
         normalized_unit, normalized_value, duplicate_key, record_status
       ) VALUES (?, '2026-01', '2026-01', 'kWh', 100, 'kWh', 100, 'factor-split:monthly', 'active')`
    ).run(photovoltaic.id).lastInsertRowid);
    generationRecordId = Number(db.prepare(
      `INSERT INTO generation_records (
         organization_unit_id, energy_type_id, normalized_month, generation_value_kwh,
         self_use_value_kwh, grid_export_value_kwh, data_source, record_status
       ) VALUES (?, ?, '2026-01', 100, 30, 50, 'manual', 'active')`
    ).run(organizationId, photovoltaic.id).lastInsertRowid);
    db.prepare(
      `INSERT INTO energy_conversion_factors (
         factor_code, energy_type_id, source_unit, factor_value, source, document_no, version,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES ('FLOW-PHOTOVOLTAIC-SPLIT', ?, 'kWh', 1, '隔离测试', 'FACTOR-SPLIT-1', 'v1',
         '2026-01-01T00:00:00Z', '2026-01-01T00:30:00Z', 'Asia/Shanghai', 'active')`
    ).run(photovoltaic.id);
    db.prepare(
      `INSERT INTO energy_conversion_factors (
         factor_code, energy_type_id, source_unit, factor_value, source, document_no, version,
         effective_start_utc, effective_end_utc, source_timezone, status
       ) VALUES ('FLOW-PHOTOVOLTAIC-SPLIT', ?, 'kWh', 2, '隔离测试', 'FACTOR-SPLIT-2', 'v2',
         '2026-01-01T00:30:00Z', '2027-01-01T00:00:00Z', 'Asia/Shanghai', 'active')`
    ).run(photovoltaic.id);
  } finally {
    db.close();
  }

  const model = createModel('FLOW-SERVICE-FACTOR-SPLIT');
  const source = createNode(model.id, 'SOURCE', 'source', 0);
  const timeseriesSink = createNode(model.id, 'TIMESERIES-SINK', 'sink', 100);
  const monthlySink = createNode(model.id, 'MONTHLY-SINK', 'sink', 200);
  const generationSink = createNode(model.id, 'GENERATION-SINK', 'sink', 300);
  const timeseriesEdge = createEnergyFlowEdge(model.id, {
    edgeCode: 'EDGE-FACTOR-TIMESERIES',
    fromNodeId: source.id,
    toNodeId: timeseriesSink.id,
    energyTypeId: photovoltaic.id,
    unit: photovoltaic.standardUnit,
    sourceType: 'timeseries',
    sourceMapping: { reference: 'factor-split:timeseries', recordIds: [timeseriesRecordId] }
  });
  const monthlyEdge = createEnergyFlowEdge(model.id, {
    edgeCode: 'EDGE-FACTOR-MONTHLY',
    fromNodeId: source.id,
    toNodeId: monthlySink.id,
    energyTypeId: photovoltaic.id,
    unit: photovoltaic.standardUnit,
    sourceType: 'monthly_energy',
    sourceMapping: { reference: 'factor-split:monthly', recordIds: [monthlyRecordId] }
  });
  const generationEdge = createEnergyFlowEdge(model.id, {
    edgeCode: 'EDGE-FACTOR-GENERATION',
    fromNodeId: source.id,
    toNodeId: generationSink.id,
    energyTypeId: photovoltaic.id,
    unit: photovoltaic.standardUnit,
    sourceType: 'generation',
    sourceMapping: {
      reference: 'factor-split:generation',
      recordIds: [generationRecordId],
      valueField: 'generation'
    }
  });

  const hourlyAnalysis = analyzeEnergyFlow(model.id, {
    startUtc: '2026-01-01T00:00:00Z',
    endUtc: '2026-01-01T01:00:00Z'
  });
  const timeseriesResult = hourlyAnalysis.edgeValues.find((edge) => edge.edgeId === timeseriesEdge.id);
  assert.strictEqual(timeseriesResult.value, 100);
  assert.strictEqual(timeseriesResult.standardCoal.kgce, 150);
  assert.strictEqual(timeseriesResult.standardCoal.tce, 0.15);
  assert.strictEqual(timeseriesResult.standardCoal.factor, null);
  assert.deepStrictEqual(
    timeseriesResult.standardCoal.applications.map((application) => application.factor.version),
    ['v1', 'v2']
  );
  assert.deepStrictEqual(
    timeseriesResult.standardCoal.applications.map((application) => application.sourceValue),
    [50, 50]
  );
  assert.deepStrictEqual(
    timeseriesResult.standardCoal.applications.map((application) => application.segments[0].sourceRecordId),
    [timeseriesRecordId, timeseriesRecordId]
  );

  const monthlyAnalysis = analyzeEnergyFlow(model.id, { startMonth: '2026-01', endMonth: '2026-01' });
  const monthlyResult = monthlyAnalysis.edgeValues.find((edge) => edge.edgeId === monthlyEdge.id);
  const generationResult = monthlyAnalysis.edgeValues.find((edge) => edge.edgeId === generationEdge.id);
  assert.strictEqual(monthlyResult.value, 100);
  assert.strictEqual(monthlyResult.standardCoal.kgce, null);
  assert(monthlyResult.standardCoal.reasonCodes.includes('FACTOR_PERIOD_AMBIGUOUS'));
  assert.strictEqual(generationResult.value, 100);
  assert.strictEqual(generationResult.standardCoal.kgce, null);
  assert(generationResult.standardCoal.reasonCodes.includes('FACTOR_PERIOD_AMBIGUOUS'));
}

/**
 * 测试同一次分析中时序、月度和发电事实的规范来源键与跨边复用拒绝。
 */
function testCrossEdgeSourceReuseDetection() {
  const electricity = getElectricityType();
  const model = createModel('FLOW-SERVICE-SOURCE-REUSE');
  const source = createNode(model.id, 'SOURCE', 'source', 0);
  const sinks = Array.from({ length: 8 }, (_item, index) => createNode(
    model.id,
    `SINK-${index + 1}`,
    'sink',
    (index + 1) * 100
  ));
  const db = openDatabase();
  let organizationId;
  let timeseriesRecordId;
  let monthlyRecordId;
  let generationRecordId;
  try {
    organizationId = Number(db.prepare(
      `INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status)
       VALUES ('FLOW-REUSE-OU', '来源复用单元', '/FLOW-REUSE-OU', 'workshop', 'active')`
    ).run().lastInsertRowid);
    timeseriesRecordId = Number(db.prepare(
      `INSERT INTO energy_timeseries_records (
         energy_type_id, start_utc, end_utc, source_timezone, granularity_minutes,
         original_unit, original_value, normalized_unit, normalized_value,
         source_reference, data_source, record_status
       ) VALUES (?, '2026-01-01T00:00:00Z', '2026-01-01T01:00:00Z', 'Asia/Shanghai', 60,
         'kWh', 20, 'kWh', 20, 'source-reuse:timeseries', 'manual', 'active')`
    ).run(electricity.id).lastInsertRowid);
    monthlyRecordId = Number(db.prepare(
      `INSERT INTO energy_records (
         energy_type_id, original_month, normalized_month, original_unit, original_value,
         normalized_unit, normalized_value, duplicate_key, record_status
       ) VALUES (?, '2026-01', '2026-01', 'kWh', 40, 'kWh', 40, 'source-reuse:monthly', 'active')`
    ).run(electricity.id).lastInsertRowid);
    generationRecordId = Number(db.prepare(
      `INSERT INTO generation_records (
         organization_unit_id, energy_type_id, normalized_month, generation_value_kwh,
         self_use_value_kwh, grid_export_value_kwh, data_source, record_status
       ) VALUES (?, ?, '2026-01', 100, 30, 50, 'manual', 'active')`
    ).run(organizationId, electricity.id).lastInsertRowid);
  } finally {
    db.close();
  }

  const createMappedEdge = (edgeCode, sinkIndex, sourceType, sourceMapping) => createEnergyFlowEdge(model.id, {
    edgeCode,
    fromNodeId: source.id,
    toNodeId: sinks[sinkIndex].id,
    energyTypeId: electricity.id,
    unit: 'kWh',
    sourceType,
    sourceMapping
  });
  const timeseriesEdges = [0, 1].map((sinkIndex) => createMappedEdge(
    `EDGE-REUSE-TIMESERIES-${sinkIndex + 1}`,
    sinkIndex,
    'timeseries',
    { reference: `source-reuse:timeseries:${sinkIndex + 1}`, recordIds: [timeseriesRecordId] }
  ));
  const monthlyEdges = [2, 3].map((sinkIndex) => createMappedEdge(
    `EDGE-REUSE-MONTHLY-${sinkIndex + 1}`,
    sinkIndex,
    'monthly_energy',
    { reference: `source-reuse:monthly:${sinkIndex + 1}`, recordIds: [monthlyRecordId] }
  ));
  const selfUseEdges = [4, 5].map((sinkIndex) => createMappedEdge(
    `EDGE-REUSE-SELF-USE-${sinkIndex + 1}`,
    sinkIndex,
    'generation',
    {
      reference: `source-reuse:self-use:${sinkIndex + 1}`,
      recordIds: [generationRecordId],
      valueField: 'self_use'
    }
  ));
  const generationTotalEdge = createMappedEdge(
    'EDGE-REUSE-GENERATION-TOTAL',
    6,
    'generation',
    { reference: 'source-reuse:generation-total', recordIds: [generationRecordId], valueField: 'generation' }
  );
  const gridExportEdge = createMappedEdge(
    'EDGE-REUSE-GRID-EXPORT',
    7,
    'generation',
    { reference: 'source-reuse:grid-export', recordIds: [generationRecordId], valueField: 'grid_export' }
  );

  const hourlyAnalysis = analyzeEnergyFlow(model.id, {
    startUtc: '2026-01-01T00:00:00Z',
    endUtc: '2026-01-01T01:00:00Z'
  });
  assert.strictEqual(hourlyAnalysis.sourceUsage.duplicatedSourceCount, 1);
  timeseriesEdges.forEach((edge) => {
    const result = hourlyAnalysis.edgeValues.find((item) => item.edgeId === edge.id);
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(result.value, null);
    assert(result.reasonCodes.includes('SOURCE_OVERLAP_OR_DUPLICATE'));
    assert(result.configurationErrors.includes('SOURCE_RECORD_REUSED_ACROSS_EDGES'));
  });

  const monthlyAnalysis = analyzeEnergyFlow(model.id, { startMonth: '2026-01', endMonth: '2026-01' });
  assert.strictEqual(monthlyAnalysis.sourceUsage.duplicatedSourceCount, 3);
  assert(monthlyAnalysis.sourceUsage.duplicates.some((duplicate) => (
    duplicate.sourceType === 'monthly_energy'
    && duplicate.recordId === monthlyRecordId
    && duplicate.edgeIds.length === 2
  )));
  assert(monthlyAnalysis.sourceUsage.duplicates.some((duplicate) => (
    duplicate.sourceType === 'generation'
    && duplicate.valueField === 'self_use'
    && duplicate.recordId === generationRecordId
    && duplicate.edgeIds.length === 2
  )));
  [...monthlyEdges, ...selfUseEdges].forEach((edge) => {
    const result = monthlyAnalysis.edgeValues.find((item) => item.edgeId === edge.id);
    assert.strictEqual(result.status, 'unavailable');
    assert.strictEqual(result.value, null);
    assert(result.configurationErrors.includes('SOURCE_RECORD_REUSED_ACROSS_EDGES'));
  });
  const generationTotalResult = monthlyAnalysis.edgeValues.find((edge) => edge.edgeId === generationTotalEdge.id);
  const gridExportResult = monthlyAnalysis.edgeValues.find((edge) => edge.edgeId === gridExportEdge.id);
  assert.strictEqual(generationTotalResult.value, 100, '同一发电记录的不同 valueField 不得误判为同一规范来源。');
  assert.strictEqual(gridExportResult.value, 50, '同一发电记录的不同 valueField 必须可分别使用。');
}

/**
 * 测试模型、拓扑、事实和折标读取固定在同一个 WAL 只读快照中。
 */
function testAnalysisUsesSingleReadSnapshot() {
  const electricity = getElectricityType();
  const model = createModel('FLOW-SERVICE-SNAPSHOT');
  const source = createNode(model.id, 'SOURCE', 'source', 0);
  const sink = createNode(model.id, 'SINK', 'sink', 100);
  const edge = createEnergyFlowEdge(model.id, {
    edgeCode: 'EDGE-SNAPSHOT',
    fromNodeId: source.id,
    toNodeId: sink.id,
    energyTypeId: electricity.id,
    unit: 'kWh',
    sourceType: 'explicit_edge_value',
    sourceMapping: { reference: 'snapshot:explicit' }
  });
  const recordId = insertExplicitValue(model.id, edge.id, 10);
  const analysisDb = openDatabase();
  try {
    assert.strictEqual(String(analysisDb.pragma('journal_mode', { simple: true })).toLowerCase(), 'wal');
    const analysis = analyzeEnergyFlow(
      model.id,
      { startMonth: '2026-01', endMonth: '2026-01' },
      {
        db: analysisDb,
        onAfterTopologyRead({ db: snapshotDb }) {
          assert.strictEqual(snapshotDb, analysisDb);
          assert.strictEqual(snapshotDb.inTransaction, true, '事实读取前必须已建立只读快照事务。');
          const writerDb = openDatabase();
          try {
            writerDb.prepare(
              `UPDATE energy_flow_records
               SET original_value = 99, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
               WHERE id = ?`
            ).run(recordId);
          } finally {
            writerDb.close();
          }
        }
      }
    );
    const edgeResult = analysis.edgeValues.find((item) => item.edgeId === edge.id);
    assert.strictEqual(edgeResult.value, 10, '同次分析必须继续读取拓扑快照建立时的旧事实。');
    assert.strictEqual(analysisDb.inTransaction, false, '分析完成后服务必须结束自有只读事务。');
  } finally {
    analysisDb.close();
  }
  const verificationDb = openDatabase();
  try {
    assert.strictEqual(
      Number(verificationDb.prepare('SELECT original_value FROM energy_flow_records WHERE id = ?').pluck().get(recordId)),
      99,
      '快照结束后的新查询必须看到并发连接已提交的新事实。'
    );
  } finally {
    verificationDb.close();
  }
}

/**
 * 验证能流业务写入口拒绝缺失或非法操作者。
 */
function testAuditActorRequired() {
  const input = {
    modelCode: 'FLOW-AUDIT-ACTOR',
    modelName: '能流审计操作者测试',
    source: '隔离测试',
    documentNo: 'DOC-FLOW-AUDIT-ACTOR',
    version: 'v1',
    ...MODEL_RANGE,
    status: 'active'
  };
  [undefined, null, 0, -1, 1.5, '1'].forEach((userId) => {
    const options = userId === undefined
      ? {}
      : { audit: { userId, operation: 'energy.flow.model.create', targetType: 'energy_flow_model' } };
    assertThrowsCode(
      () => createEnergyFlowModelWithoutAudit(input, options),
      'ENERGY_FLOW_AUDIT_CONTEXT_INVALID'
    );
  });
  const db = openDatabase();
  try {
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS total FROM energy_flow_models WHERE model_code = 'FLOW-AUDIT-ACTOR'").get().total,
      0,
      '非法操作者不得产生能流业务数据。'
    );
  } finally {
    db.close();
  }
}

/**
 * 执行隔离测试。
 */
function run() {
  initDatabase();
  const actorDb = openDatabase();
  try {
    auditActorUserId = Number(actorDb.prepare("SELECT id FROM sys_users WHERE username = 'admin'").get().id);
  } finally {
    actorDb.close();
  }
  testAuditActorRequired();
  const master = testConfigurationCrudAndTopology();
  testAnalysisQualityAndConversion(master);
  testExplicitSourceResolvers();
  testConversionFactorPeriodSegmentation();
  testCrossEdgeSourceReuseDetection();
  testAnalysisUsesSingleReadSnapshot();
  const db = openDatabase();
  try {
    assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
  console.log('energyFlowService tests passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  } catch (_error) {
    // Windows 下异常句柄由系统临时目录后续清理。
  }
}
