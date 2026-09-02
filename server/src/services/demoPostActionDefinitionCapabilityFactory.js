'use strict';

const crypto = require('crypto');
const { types: utilTypes } = require('util');
const databaseModule = require('../db/database');

// 初始化期从数据库模块非枚举 Symbol surface 捕获原始连接 verifier，不新增全局 Symbol key。
const databaseRawConnectionProtocol = Object.getOwnPropertySymbols(databaseModule)
  .map((protocolSymbol) => (
    Object.getOwnPropertyDescriptor(databaseModule, protocolSymbol)?.value
  ))
  .find((candidate) => (
    candidate
    && typeof candidate === 'object'
    && Object.isFrozen(candidate)
    && Reflect.ownKeys(candidate).length === 2
    && typeof candidate.bindTransactionAuthority === 'function'
    && typeof candidate.isOpenRawDatabaseConnection === 'function'
  ));
if (!databaseRawConnectionProtocol) {
  const initializationError = new Error('后置动作 definition capability 原始连接协议不可用。');
  initializationError.code = 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_DATABASE_PROTOCOL_UNAVAILABLE';
  throw initializationError;
}
const isOpenRawDatabaseConnection =
  databaseRawConnectionProtocol.isOpenRawDatabaseConnection;

/** 创建一套彼此隔离的 definition capability provenance；只有持有返回闭包的构造根可协作。 */
function createDefinitionCapabilityAuthority() {
  // capability、连接身份与派生状态只存在于本次工厂调用的私有闭包。
  const CAPABILITY_STATES = new WeakMap();
  const CONNECTION_IDENTITIES = new WeakMap();
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PREDICTION_REQUIRED_BINDINGS = Object.freeze([
  '07-monthly-energy',
  '12-prediction-configs'
]);
const STAGE_RULES = Object.freeze({
  'preview-resolve': Object.freeze({
    actionStatus: null,
    parentStage: null,
    childStage: 'preview-probe',
    requiresP4: false
  }),
  'preview-probe': Object.freeze({
    actionStatus: null,
    parentStage: 'preview-resolve',
    childStage: null,
    requiresP4: false
  }),
  'previewed-revalidate': Object.freeze({
    actionStatus: 'previewed',
    parentStage: null,
    childStage: 'executing-revalidate',
    requiresP4: false
  }),
  'executing-revalidate': Object.freeze({
    actionStatus: 'executing',
    parentStage: 'previewed-revalidate',
    childStage: 'execute',
    requiresP4: false
  }),
  execute: Object.freeze({
    actionStatus: 'executing',
    parentStage: 'executing-revalidate',
    childStage: null,
    requiresP4: true
  })
});
const ISSUE_FIELDS = Object.freeze([
  'db',
  'stage',
  'actionRunId',
  'actionStatus',
  'run',
  'runtime',
  'actor',
  'definition',
  'registryIdentity',
  'parentCapability'
]);
const ADAPTER_VERIFY_FIELDS = Object.freeze([
  'capability',
  'db',
  'stage',
  'actionRunId',
  'actionStatus',
  'run',
  'runtime',
  'actor',
  'parentCapability'
]);
const P4_VERIFY_FIELDS = Object.freeze([
  'capability',
  'db',
  'demoRun',
  'actionRun',
  'actor'
]);
// P4 只接收 adapter 重建的七字段 demo run 投影，仍逐字段绑定 issuer 捕获的原 run 快照。
const P4_DEMO_RUN_FIELDS = Object.freeze([
  'runId',
  'datasetId',
  'manifestVersion',
  'manifestDigest',
  'status',
  'createdBy',
  'createdAt'
]);

/** 构造不携带 capability、路径、SQL 或身份内容的固定错误。 */
function createDefinitionCapabilityError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** 严格读取普通对象数据字段；Proxy、访问器、Symbol 或附加字段统一拒绝。 */
function assertExactProtocolObject(value, expectedFields, code) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.getOwnPropertySymbols(value).length !== 0) {
      throw createDefinitionCapabilityError(code, '后置动作 definition capability 输入无效。');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualFields = Object.keys(descriptors).sort();
    const normalizedExpected = [...expectedFields].sort();
    if (actualFields.length !== normalizedExpected.length
      || actualFields.some((fieldName, index) => fieldName !== normalizedExpected[index])
      || actualFields.some((fieldName) => (
        typeof descriptors[fieldName].get === 'function'
        || typeof descriptors[fieldName].set === 'function'
        || descriptors[fieldName].enumerable !== true
      ))) {
      throw createDefinitionCapabilityError(code, '后置动作 definition capability 字段无效。');
    }
    return value;
  } catch (error) {
    if (error?.code === code) throw error;
    throw createDefinitionCapabilityError(code, '后置动作 definition capability 反射校验失败。');
  }
}

/** 递归捕获无 Proxy、访问器、Symbol、循环和自定义原型的冻结事实快照。 */
function capturePlainSnapshot(value, seen = new Set()) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || seen.has(value)) {
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_FACTS_INVALID',
      '后置动作 definition capability 事实对象无效。'
    );
  }
  const isArray = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (isArray ? Array.prototype : Object.prototype)
    || Object.getOwnPropertySymbols(value).length !== 0) {
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_FACTS_INVALID',
      '后置动作 definition capability 事实原型无效。'
    );
  }
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fieldNames = Object.keys(descriptors);
  if (fieldNames.some((fieldName) => (
    typeof descriptors[fieldName].get === 'function'
    || typeof descriptors[fieldName].set === 'function'
    || (fieldName !== 'length' && descriptors[fieldName].enumerable !== true)
  ))) {
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_FACTS_INVALID',
      '后置动作 definition capability 事实字段无效。'
    );
  }
  if (isArray) {
    const expectedFields = [
      ...Array.from({ length: value.length }, (_item, index) => String(index)),
      'length'
    ].sort();
    if (fieldNames.sort().some((fieldName, index) => fieldName !== expectedFields[index])
      || fieldNames.length !== expectedFields.length) {
      throw createDefinitionCapabilityError(
        'DEMO_POST_ACTION_DEFINITION_CAPABILITY_FACTS_INVALID',
        '后置动作 definition capability 数组事实无效。'
      );
    }
    const snapshot = Object.freeze(value.map((item) => capturePlainSnapshot(item, seen)));
    seen.delete(value);
    return snapshot;
  }
  const snapshot = Object.freeze(Object.fromEntries(fieldNames.map((fieldName) => (
    [fieldName, capturePlainSnapshot(descriptors[fieldName].value, seen)]
  ))));
  seen.delete(value);
  return snapshot;
}

/** 比较当前普通事实与签发快照，反射异常统一视为漂移。 */
function matchesPlainSnapshot(value, snapshot, seen = new Set()) {
  try {
    if (snapshot === null || ['string', 'number', 'boolean'].includes(typeof snapshot)) {
      return value === snapshot;
    }
    if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || seen.has(value)
      || Array.isArray(value) !== Array.isArray(snapshot)
      || Object.getPrototypeOf(value) !== (Array.isArray(snapshot)
        ? Array.prototype
        : Object.prototype)
      || Object.getOwnPropertySymbols(value).length !== 0) return false;
    seen.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const snapshotFields = Reflect.ownKeys(snapshot).filter((fieldName) => fieldName !== 'length');
    const valueFields = Object.keys(descriptors).filter((fieldName) => fieldName !== 'length');
    const valid = valueFields.length === snapshotFields.length
      && valueFields.every((fieldName, index) => fieldName === snapshotFields[index])
      && valueFields.every((fieldName) => {
        const descriptor = descriptors[fieldName];
        return descriptor.enumerable === true
          && typeof descriptor.get !== 'function'
          && typeof descriptor.set !== 'function'
          && matchesPlainSnapshot(descriptor.value, snapshot[fieldName], seen);
      });
    seen.delete(value);
    return valid;
  } catch (_error) {
    return false;
  }
}

/** 严格比较冻结普通对象投影与 issuer 捕获快照中的指定字段。 */
function matchesPlainSnapshotProjection(value, snapshot, fields) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || utilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype
      || !Object.isFrozen(value) || Object.getOwnPropertySymbols(value).length !== 0) {
      return false;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actualFields = Object.keys(descriptors);
    return actualFields.length === fields.length
      && actualFields.every((fieldName, index) => fieldName === fields[index])
      && actualFields.every((fieldName) => {
        const descriptor = descriptors[fieldName];
        return descriptor.enumerable === true
          && typeof descriptor.get !== 'function'
          && typeof descriptor.set !== 'function'
          && matchesPlainSnapshot(descriptor.value, snapshot[fieldName]);
      });
  } catch (_error) {
    return false;
  }
}

/** 验证 issuer 只为最终 Prediction v1 connected definition 签发。 */
function assertPredictionDefinitionFacts(definition, registryIdentity) {
  const definitionSnapshot = capturePlainSnapshot(definition);
  const registrySnapshot = capturePlainSnapshot(registryIdentity);
  const requiredBindings = definitionSnapshot.requiredArtifactBindings;
  if (!Object.isFrozen(definition) || definitionSnapshot.actionKey !== 'prediction-run'
    || definitionSnapshot.resolverVersion !== 'prediction-resolver:v1'
    || definitionSnapshot.executorVersion !== 'prediction-executor:v1'
    || definitionSnapshot.implementationStatus !== 'connected'
    || !Array.isArray(requiredBindings)
    || requiredBindings.length !== PREDICTION_REQUIRED_BINDINGS.length
    || requiredBindings.some((binding, index) => binding !== PREDICTION_REQUIRED_BINDINGS[index])
    || typeof registrySnapshot.version !== 'string' || registrySnapshot.version.length === 0
    || !DIGEST_PATTERN.test(registrySnapshot.digest)
    || registrySnapshot.algorithm !== 'sha256'
    || registrySnapshot.canonicalization !== 'json-sorted-keys-v1') {
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_DEFINITION_INVALID',
      'Prediction definition capability 只能绑定当前 connected v1 定义。'
    );
  }
  return { definitionSnapshot, registrySnapshot };
}

/** 为数据库模块确认的原始连接读取或创建模块私有物理连接身份。 */
function requireDefinitionCapabilityConnectionIdentity(db) {
  if (!isOpenRawDatabaseConnection(db)) {
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_DATABASE_INVALID',
      '后置动作 definition capability 只能绑定打开的原始数据库连接。'
    );
  }
  if (!CONNECTION_IDENTITIES.has(db)) {
    CONNECTION_IDENTITIES.set(db, Object.freeze({}));
  }
  return CONNECTION_IDENTITIES.get(db);
}

/** 验证 capability 使用阶段的原连接、原对象和全部签发事实仍稳定。 */
function assertCapabilityBinding(state, input, expectedStage) {
  const stageRule = STAGE_RULES[expectedStage];
  const currentActionRunId = input.actionRunId === null ? null : input.actionRunId;
  const currentActionStatus = input.actionStatus === null ? null : input.actionStatus;
  if (!stageRule || state.stage !== expectedStage || state.db !== input.db
    || state.connectionIdentity !== requireDefinitionCapabilityConnectionIdentity(input.db)
    || input.db?.open !== true || input.db?.inTransaction !== true
    || state.actionRunId !== currentActionRunId
    || state.actionStatus !== currentActionStatus
    || state.runIdentity !== input.run || state.runtimeIdentity !== input.runtime
    || state.actorIdentity !== input.actor || state.parentCapability !== input.parentCapability
    || !matchesPlainSnapshot(input.run, state.runSnapshot)
    || !matchesPlainSnapshot(input.runtime, state.runtimeSnapshot)
    || !matchesPlainSnapshot(input.actor, state.actorSnapshot)
    || !matchesPlainSnapshot(state.definitionIdentity, state.definitionSnapshot)
    || !matchesPlainSnapshot(state.registryIdentity, state.registrySnapshot)) {
    state.verificationStatus = 'failed';
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_BINDING_MISMATCH',
      '后置动作 definition capability 与当前阶段绑定不一致。'
    );
  }
}

/** 递归终结当前 capability 及其尚可继续使用的后代，阻止失败链上的旧 child 继续验证。 */
function terminalizeCapabilityBranch(state, visited = new Set()) {
  if (!state || visited.has(state)) return;
  visited.add(state);
  const childState = state.childCapability
    ? CAPABILITY_STATES.get(state.childCapability)
    : null;
  if (childState) terminalizeCapabilityBranch(childState, visited);
  state.verificationStatus = 'failed';
  state.derivationStatus = 'failed';
  if (state.p4Status !== 'not-applicable') state.p4Status = 'failed';
}

/** 校验当前 capability 仍位于全部 ancestor 未失败且唯一父子相连的 provenance 链上。 */
function assertCapabilityAncestorChain(state) {
  let currentState = state;
  const visited = new Set();
  while (currentState.parentState) {
    if (visited.has(currentState)) {
      terminalizeCapabilityBranch(state);
      throw createDefinitionCapabilityError(
        'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID',
        '后置动作 definition capability ancestor 链无效。'
      );
    }
    visited.add(currentState);
    const parentState = currentState.parentState;
    const parentIsActive = parentState.verificationStatus === 'adapter-consumed'
      && parentState.derivationStatus === 'child-issued'
      && parentState.childCapability === currentState.capabilityIdentity
      && currentState.parentCapability === parentState.capabilityIdentity
      && parentState.childStage === currentState.stage
      && parentState.db === currentState.db
      && parentState.connectionIdentity === currentState.connectionIdentity
      && parentState.runIdentity === currentState.runIdentity
      && parentState.runtimeIdentity === currentState.runtimeIdentity
      && parentState.actorIdentity === currentState.actorIdentity
      && parentState.definitionIdentity === currentState.definitionIdentity
      && parentState.registryIdentity === currentState.registryIdentity
      && matchesPlainSnapshot(currentState.runIdentity, parentState.runSnapshot)
      && matchesPlainSnapshot(currentState.runtimeIdentity, parentState.runtimeSnapshot)
      && matchesPlainSnapshot(currentState.actorIdentity, parentState.actorSnapshot)
      && matchesPlainSnapshot(currentState.definitionIdentity, parentState.definitionSnapshot)
      && matchesPlainSnapshot(currentState.registryIdentity, parentState.registrySnapshot);
    if (!parentIsActive) {
      terminalizeCapabilityBranch(state);
      throw createDefinitionCapabilityError(
        'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID',
        '后置动作 definition capability ancestor 已失败或父子链不唯一。'
      );
    }
    currentState = parentState;
  }
  if (currentState.parentCapability !== null || currentState.parentState !== null) {
    terminalizeCapabilityBranch(state);
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID',
      '后置动作 definition capability 根节点无效。'
    );
  }
}

/** 原子保留父 capability 的唯一派生权；任何后续失败都不会恢复父 capability。 */
function reserveParentCapabilityDerivation(input, stageRule) {
  if (stageRule.parentStage === null) {
    if (input.parentCapability !== null) {
      throw createDefinitionCapabilityError(
        'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID',
        '后置动作 definition capability 不接受该父阶段。'
      );
    }
    return null;
  }
  const parentState = input.parentCapability
    && typeof input.parentCapability === 'object'
    && !utilTypes.isProxy(input.parentCapability)
    ? CAPABILITY_STATES.get(input.parentCapability)
    : null;
  const validParent = parentState
    && parentState.stage === stageRule.parentStage
    && parentState.childStage === input.stage
    && parentState.verificationStatus === 'adapter-consumed'
    && parentState.derivationStatus === 'pending'
    && parentState.db === input.db
    && parentState.connectionIdentity === requireDefinitionCapabilityConnectionIdentity(input.db)
    && parentState.actionRunId === input.actionRunId
    && parentState.runIdentity === input.run
    && parentState.runtimeIdentity === input.runtime
    && parentState.actorIdentity === input.actor
    && parentState.definitionIdentity === input.definition
    && parentState.registryIdentity === input.registryIdentity
    && matchesPlainSnapshot(input.run, parentState.runSnapshot)
    && matchesPlainSnapshot(input.runtime, parentState.runtimeSnapshot)
    && matchesPlainSnapshot(input.actor, parentState.actorSnapshot)
    && matchesPlainSnapshot(input.definition, parentState.definitionSnapshot)
    && matchesPlainSnapshot(input.registryIdentity, parentState.registrySnapshot);
  if (!validParent) {
    const parentWasAlreadyDerived = parentState?.derivationStatus === 'child-issued'
      || parentState?.derivationStatus === 'p4-consumed';
    if (parentState) terminalizeCapabilityBranch(parentState);
    throw createDefinitionCapabilityError(
      parentWasAlreadyDerived
        ? 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_REPLAY'
        : 'DEMO_POST_ACTION_DEFINITION_CAPABILITY_PARENT_INVALID',
      '后置动作 definition capability 父阶段无效、已派生或已失效。'
    );
  }
  parentState.derivationStatus = 'child-issuing';
  return parentState;
}

/** 由构造根私有 issuer 签发阶段绑定、不可序列化的 opaque capability。 */
function issueDefinitionCapability(input = {}) {
  assertExactProtocolObject(
    input,
    ISSUE_FIELDS,
    'DEMO_POST_ACTION_DEFINITION_CAPABILITY_ISSUE_INPUT_INVALID'
  );
  const stageRule = STAGE_RULES[input.stage];
  const validActionRunId = stageRule?.actionStatus === null
    ? input.actionRunId === null
    : typeof input.actionRunId === 'string' && input.actionRunId.length > 0;
  if (!stageRule || input.actionStatus !== stageRule.actionStatus || !validActionRunId
    || !input.db || typeof input.db !== 'object' || utilTypes.isProxy(input.db)
    || input.db.open !== true || input.db.inTransaction !== true) {
    const suppliedParentState = input.parentCapability
      && typeof input.parentCapability === 'object'
      && !utilTypes.isProxy(input.parentCapability)
      ? CAPABILITY_STATES.get(input.parentCapability)
      : null;
    if (suppliedParentState) terminalizeCapabilityBranch(suppliedParentState);
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_STAGE_INVALID',
      '后置动作 definition capability 签发阶段无效。'
    );
  }
  const parentState = reserveParentCapabilityDerivation(input, stageRule);
  try {
    const { definitionSnapshot, registrySnapshot } = assertPredictionDefinitionFacts(
      input.definition,
      input.registryIdentity
    );
    const runSnapshot = capturePlainSnapshot(input.run);
    const runtimeSnapshot = capturePlainSnapshot(input.runtime);
    const actorSnapshot = capturePlainSnapshot(input.actor);
    if (runSnapshot.runId === undefined || runSnapshot.datasetId === undefined
      || runtimeSnapshot.enabled !== 1
      || !Number.isSafeInteger(Number(runtimeSnapshot.runtimeEpoch))
      || !Number.isSafeInteger(Number(runtimeSnapshot.revision))
      || !Number.isSafeInteger(Number(actorSnapshot.userId))
      || Number(actorSnapshot.userId) < 1) {
      throw createDefinitionCapabilityError(
        'DEMO_POST_ACTION_DEFINITION_CAPABILITY_FACTS_INVALID',
        '后置动作 definition capability 运行事实无效。'
      );
    }
    const transactionMarker = `demo_prediction_definition_${crypto.randomBytes(12).toString('hex')}`;
    const connectionIdentity = requireDefinitionCapabilityConnectionIdentity(input.db);
    input.db.exec(`SAVEPOINT ${transactionMarker}`);
    const capability = Object.freeze({});
    const capabilityState = {
      capabilityIdentity: capability,
      db: input.db,
      connectionIdentity,
      stage: input.stage,
      childStage: stageRule.childStage,
      actionRunId: input.actionRunId,
      actionStatus: input.actionStatus,
      runIdentity: input.run,
      runSnapshot,
      runtimeIdentity: input.runtime,
      runtimeSnapshot,
      actorIdentity: input.actor,
      actorSnapshot,
      definitionIdentity: input.definition,
      definitionSnapshot,
      registryIdentity: input.registryIdentity,
      registrySnapshot,
      parentCapability: input.parentCapability,
      parentState,
      childCapability: null,
      transactionMarker,
      requiresP4: stageRule.requiresP4,
      p4Status: stageRule.requiresP4 ? 'pending' : 'not-applicable',
      verificationStatus: 'issued',
      derivationStatus: stageRule.childStage === null && !stageRule.requiresP4
        ? 'not-applicable'
        : 'locked'
    };
    CAPABILITY_STATES.set(capability, capabilityState);
    if (parentState) {
      parentState.childCapability = capability;
      parentState.derivationStatus = 'child-issued';
    }
    return capability;
  } catch (error) {
    if (parentState) terminalizeCapabilityBranch(parentState);
    throw error;
  }
}

/** Adapter verifier 一次性消费相应阶段并通过 SAVEPOINT 证明仍在原 caller transaction。 */
function verifyAdapterDefinitionCapability(input = {}) {
  assertExactProtocolObject(
    input,
    ADAPTER_VERIFY_FIELDS,
    'DEMO_POST_ACTION_DEFINITION_CAPABILITY_ADAPTER_INPUT_INVALID'
  );
  const capability = input.capability;
  const state = capability && typeof capability === 'object' && !utilTypes.isProxy(capability)
    ? CAPABILITY_STATES.get(capability)
    : null;
  if (!state) {
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_REQUIRED',
      'Prediction adapter 必须使用通用 lifecycle 正式签发的 capability。'
    );
  }
  if (state.verificationStatus !== 'issued') {
    terminalizeCapabilityBranch(state);
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_REPLAY',
      'Prediction adapter definition capability 已消费或失效。'
    );
  }
  state.verificationStatus = 'adapter-verifying';
  try {
    assertCapabilityAncestorChain(state);
    assertCapabilityBinding(state, input, input.stage);
    input.db.exec(`RELEASE SAVEPOINT ${state.transactionMarker}`);
    state.verificationStatus = state.requiresP4 ? 'adapter-verified' : 'adapter-consumed';
    if (state.childStage !== null || state.requiresP4) {
      state.derivationStatus = 'pending';
    }
    return Object.freeze({
      stage: state.stage,
      actionRunId: state.actionRunId,
      actionStatus: state.actionStatus,
      definition: state.definitionSnapshot,
      registryIdentity: state.registrySnapshot
    });
  } catch (error) {
    terminalizeCapabilityBranch(state);
    if (error?.code) throw error;
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_TRANSACTION_MISMATCH',
      'Prediction adapter definition capability 不属于当前 transaction。'
    );
  }
}

/** P4 verifier 一次性消费已由 adapter 验证的 execute capability。 */
function verifyP4DefinitionCapability(input = {}) {
  assertExactProtocolObject(
    input,
    P4_VERIFY_FIELDS,
    'DEMO_POST_ACTION_DEFINITION_CAPABILITY_P4_INPUT_INVALID'
  );
  const capability = input.capability;
  const state = capability && typeof capability === 'object' && !utilTypes.isProxy(capability)
    ? CAPABILITY_STATES.get(capability)
    : null;
  if (!state) {
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_REQUIRED',
      'Prediction P4 必须使用通用 lifecycle 正式签发的 execute capability。'
    );
  }
  if (state.stage !== 'execute' || state.verificationStatus !== 'adapter-verified'
    || state.p4Status !== 'pending' || state.derivationStatus !== 'pending') {
    terminalizeCapabilityBranch(state);
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_P4_REPLAY',
      'Prediction P4 definition capability 阶段错误、已消费或失效。'
    );
  }
  state.derivationStatus = 'p4-consuming';
  try {
    assertCapabilityAncestorChain(state);
    const actionRun = input.actionRun;
    const demoRun = input.demoRun;
    const actor = input.actor;
    if (state.db !== input.db
      || state.connectionIdentity !== requireDefinitionCapabilityConnectionIdentity(input.db)
      || input.db?.open !== true || input.db?.inTransaction !== true
      || state.actionRunId !== actionRun?.actionRunId || actionRun?.status !== 'executing'
      || state.runSnapshot.runId !== demoRun?.runId
      || state.runSnapshot.datasetId !== demoRun?.datasetId
      || state.actorIdentity !== actor
      || state.actorSnapshot.userId !== actor?.userId
      || !(
        (demoRun === state.runIdentity
          && matchesPlainSnapshot(demoRun, state.runSnapshot))
        || matchesPlainSnapshotProjection(
          demoRun,
          state.runSnapshot,
          P4_DEMO_RUN_FIELDS
        )
      )
      || !matchesPlainSnapshot(actor, state.actorSnapshot)
      || !matchesPlainSnapshot(state.definitionIdentity, state.definitionSnapshot)
      || !matchesPlainSnapshot(state.registryIdentity, state.registrySnapshot)) {
      throw createDefinitionCapabilityError(
        'DEMO_POST_ACTION_DEFINITION_CAPABILITY_P4_BINDING_MISMATCH',
        'Prediction P4 definition capability 与 DB、run、action 或 actor 不一致。'
      );
    }
    state.p4Status = 'consumed';
    state.derivationStatus = 'p4-consumed';
    state.verificationStatus = 'consumed';
    return Object.freeze({
      definition: state.definitionSnapshot,
      registryIdentity: state.registrySnapshot
    });
  } catch (error) {
    terminalizeCapabilityBranch(state);
    if (error?.code) throw error;
    throw createDefinitionCapabilityError(
      'DEMO_POST_ACTION_DEFINITION_CAPABILITY_P4_BINDING_MISMATCH',
      'Prediction P4 definition capability 与 DB、run、action 或 actor 不一致。'
    );
  }
}

  return Object.freeze({
    issueForService: issueDefinitionCapability,
    verifyForAdapter: verifyAdapterDefinitionCapability,
    verifyForP4: verifyP4DefinitionCapability
  });
}

Object.defineProperty(module, 'exports', {
  value: createDefinitionCapabilityAuthority,
  enumerable: false,
  writable: false,
  configurable: false
});
