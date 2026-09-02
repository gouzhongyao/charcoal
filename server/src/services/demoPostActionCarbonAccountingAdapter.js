'use strict';

// Carbon adapter 在加载任何依赖前固定 CommonJS 导出壳，避免初始化期替换 production exports。
const carbonAccountingAdapterExports = {};
const carbonAccountingAdapterExportsProxy = new Proxy(carbonAccountingAdapterExports, {});
Object.defineProperty(module, 'exports', {
  value: carbonAccountingAdapterExportsProxy,
  enumerable: true,
  writable: false,
  configurable: false
});

const { AppError } = require('../utils/errors');
const {
  normalizeCarbonEmissionUnit
} = require('./carbonEmissionUnitContract');
const {
  STRICT_UTC_INPUT_PATTERN,
  normalizeUserVisibleStrictUtcInput
} = require('../utils/userVisibleDateTime');
const { requireDemoDatasetRun } = require('./demoRunService');
const carbonAccountingExactProtocol = require('./carbonAccountingExactProtocol');
const {
  carbonAccountingOwnershipProtocol
} = require('./carbonAccountingOwnershipProtocol');

// 初始化期一次捕获正式 exact 与 ownership wrapper，后续 cache 替换不能接管既有 adapter。
const capturedCarbonHandlers = Object.freeze({
  previewExact: carbonAccountingExactProtocol.inspectRegistrationContextInCallerTransaction,
  buildExact: carbonAccountingExactProtocol.buildExactScopeInCallerTransaction,
  executeExact: carbonAccountingExactProtocol.executeExactInCallerTransaction,
  issueRegistration: carbonAccountingOwnershipProtocol.issueRegistrationScopeInCallerTransaction,
  registerDerived: carbonAccountingOwnershipProtocol.registerDerivedOwnershipInCallerTransaction,
  verifyReceipt: carbonAccountingOwnershipProtocol.verifyRegistrationReceiptInCallerTransaction,
  abortRegistration: carbonAccountingOwnershipProtocol.abortRegistrationScopeInCallerTransaction
});

// Carbon action 只允许消费 artifact 11/27 固定来源，不接受 registry 或客户端动态扩展。
const CARBON_ACTION_SOURCES = Object.freeze([
  '11-carbon-factors',
  '27-carbon-activities'
]);
// Carbon public input 的依赖编码只接受正式 exact 计算已定义的稳定集合。
const CARBON_PUBLIC_DEPENDENCY_CODES = Object.freeze(new Set([
  'NO_ACTIVE_EXACT_UNIT_FACTOR'
]));
// calculation run 只持久化 completed 事实，公开历史不得接受其它状态文本。
const CARBON_CALCULATION_RUN_COMPLETED_STATUS = 'completed';
// accounting result 只允许正式计算生成的两种状态和唯一缺因子原因。
const CARBON_ACCOUNTING_RESULT_CALCULATED_STATUS = 'calculated';
const CARBON_ACCOUNTING_RESULT_FACTOR_MISSING_STATUS = 'factor_missing';
const CARBON_ACCOUNTING_MISSING_FACTOR_CODE = 'NO_ACTIVE_EXACT_UNIT_FACTOR';
// runCode 复用正式 CAR-紧凑UTC秒-UUIDv4 生成结构，不接受宽松前缀匹配。
const CARBON_CALCULATION_RUN_CODE_PATTERN = /^CAR-(\d{14})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/** 构造 Carbon adapter 的稳定阻断错误。 */
function createCarbonAdapterError(code, message, statusCode = 409) {
  return new AppError(code, message, { statusCode });
}

/** 从服务端用户表构造 ownership 协议要求的冻结 actor 原对象。 */
function readCarbonActionActor(db, actorUserId, actorIp = null) {
  if (!Number.isSafeInteger(actorUserId) || actorUserId < 1) {
    throw createCarbonAdapterError(
      'DEMO_CARBON_ACTOR_INVALID',
      'Carbon 后置动作操作者无效。',
      400
    );
  }
  const row = db.prepare(`SELECT id AS userId, username, display_name AS displayName, status
    FROM sys_users WHERE id = ?`).get(actorUserId) || null;
  if (!row || row.status !== 'active') {
    throw createCarbonAdapterError(
      'DEMO_CARBON_ACTOR_UNAVAILABLE',
      'Carbon 后置动作操作者不存在或不可用。'
    );
  }
  return Object.freeze({
    userId: Number(row.userId),
    username: row.username,
    displayName: row.displayName,
    ip: actorIp || null
  });
}

/** 已存在 active derived Carbon 闭包时阻断创建第二套运行。 */
function assertNoActiveCarbonDerivedClosure(db, demoRun) {
  const row = db.prepare(`SELECT COUNT(*) AS total
    FROM demo_data_registry
    WHERE run_id = ? AND artifact_key = '27-carbon-activities'
      AND ownership_kind = 'derived' AND cleaned_at IS NULL
      AND entity_type IN ('carbon_calculation_run', 'carbon_accounting_result')`).get(
    demoRun.runId
  );
  if (Number(row?.total || 0) > 0) {
    throw createCarbonAdapterError(
      'DEMO_CARBON_ACTIVE_DERIVED_CLOSURE_EXISTS',
      '当前 demo run 已存在 active derived Carbon 闭包，禁止创建第二套运行。'
    );
  }
}

/** 将 exact 只读摘要映射为 adapter 持久化所需的安全服务端输入。 */
function buildCarbonDomainInput(preview) {
  const summary = preview.summary;
  return {
    sources: [...CARBON_ACTION_SOURCES],
    scope: {
      startUtc: summary.scope.startUtc,
      endUtc: summary.scope.endUtc
    },
    activityCount: Number(summary.scope.activityCount),
    factorCount: Number(summary.scope.factorCount),
    expectedRunCount: Number(summary.expectedRunCount),
    expectedResultCount: Number(summary.expectedResultCount),
    expectedOutputCount: Number(summary.expectedOutputCount),
    calculatedCount: Number(summary.calculatedCount),
    factorMissingCount: Number(summary.factorMissingCount),
    dependencies: summary.dependencies.map((dependency) => ({
      code: dependency.code,
      blocking: dependency.blocking === true,
      count: Number(dependency.count)
    }))
  };
}

/** 从当前持久化事实重建 ownership 协议要求的严格 demo run 原对象。 */
function readCarbonActionDemoRun(db, requestedRun) {
  const persisted = requireDemoDatasetRun(db, requestedRun?.runId);
  const bindingFields = ['runId', 'datasetId', 'manifestVersion', 'manifestDigest', 'status'];
  if (!requestedRun || bindingFields.some((fieldName) => requestedRun[fieldName] !== persisted[fieldName])) {
    throw createCarbonAdapterError(
      'DEMO_CARBON_RUN_STALE',
      'Carbon 后置动作 demo run 与当前持久化事实不一致。'
    );
  }
  return Object.freeze({
    runId: persisted.runId,
    datasetId: persisted.datasetId,
    manifestVersion: persisted.manifestVersion,
    manifestDigest: persisted.manifestDigest,
    status: persisted.status,
    createdBy: persisted.createdBy,
    createdAt: persisted.createdAt
  });
}

/** 从当前 run 的 artifact 11/27 正式闭包解析 Carbon 私有输入。 */
function resolveCarbonActionInput(db, requestedRun, actorUserId, actorIp = null) {
  const demoRun = readCarbonActionDemoRun(db, requestedRun);
  assertNoActiveCarbonDerivedClosure(db, demoRun);
  const actor = readCarbonActionActor(db, actorUserId, actorIp);
  const preview = capturedCarbonHandlers.previewExact({ db, demoRun, actor });
  return {
    domainInput: buildCarbonDomainInput(preview),
    evidence: null,
    privateContext: Object.freeze({ demoRun, actor, preview }),
    privateDigest: preview.privateDigest
  };
}

/** 生成 Carbon production adapter 的服务端输入，全部 ID、批次、context 和窗口均由当前 run 推导。 */
function resolve(db, demoRun, _runtime, actorUserId, actorIp = null) {
  return resolveCarbonActionInput(db, demoRun, actorUserId, actorIp);
}

/** 在只读预演中再次执行正式 exact 计算判定，顶层输出保持零写入合同。 */
function previewProbe(context) {
  const actor = context.privateContext?.actor;
  const preview = capturedCarbonHandlers.previewExact({
    db: context.db,
    demoRun: context.privateContext?.demoRun,
    actor
  });
  if (preview.privateScopeDigest !== context.privateContext?.preview?.privateScopeDigest
    || preview.privateDigest !== context.privateContext?.preview?.privateDigest) {
    throw createCarbonAdapterError(
      'DEMO_CARBON_INPUT_STALE',
      'Carbon exact 输入在预演过程中发生变化。'
    );
  }
  return {
    result: buildCarbonDomainInput(preview),
    outputCount: 0,
    outputs: []
  };
}

/** execute 领取前后均从当前 SQLite 事实重建 actor 与 artifact 11/27 exact 闭包。 */
function revalidate(context) {
  return resolveCarbonActionInput(
    context.db,
    context.run,
    context.actorUserId,
    context.actorIp || null
  );
}

/** 重读并冻结 ownership 协议要求的 executing action run 严格投影。 */
function readExecutingCarbonActionRun(db, actionRunId) {
  const row = db.prepare(`SELECT action_run_id AS actionRunId, run_id AS runId,
      dataset_id AS datasetId, action_key AS actionKey, requested_by AS requestedBy, status
    FROM demo_post_action_runs WHERE action_run_id = ?`).get(actionRunId) || null;
  if (!row || row.actionKey !== 'carbon-accounting-run' || row.status !== 'executing') {
    throw createCarbonAdapterError(
      'DEMO_CARBON_ACTION_RUN_INVALID',
      'Carbon 后置动作未绑定当前 executing action run。'
    );
  }
  return Object.freeze({
    actionRunId: row.actionRunId,
    runId: row.runId,
    datasetId: row.datasetId,
    actionKey: row.actionKey,
    requestedBy: Number(row.requestedBy),
    status: row.status
  });
}

/** receipt 验证后重读本次 run/results，并构造不含内部 provenance 的稳定输出引用。 */
function readCarbonActionOutputs(db, calculationRunId) {
  const run = db.prepare(`SELECT id, run_code AS runCode, start_utc AS startUtc, end_utc AS endUtc,
      activity_count AS activityCount, result_count AS resultCount,
      calculated_count AS calculatedCount, factor_missing_count AS factorMissingCount,
      emission_totals_json AS emissionTotalsJson, status
    FROM carbon_calculation_runs WHERE id = ?`).get(calculationRunId) || null;
  const results = db.prepare(`SELECT id, status, emission_value AS emissionValue,
      emission_unit AS emissionUnit, missing_reason AS missingReason
    FROM carbon_accounting_results WHERE calculation_run_id = ? ORDER BY id`).all(
    calculationRunId
  );
  if (!run || run.status !== 'completed' || results.length !== Number(run.resultCount)) {
    throw createCarbonAdapterError(
      'DEMO_CARBON_OUTPUT_FACTS_INVALID',
      'Carbon 后置动作完成事实与输出数量不一致。'
    );
  }
  const emissionTotals = JSON.parse(run.emissionTotalsJson);
  const outputs = [
    {
      outputEntityType: 'carbon_calculation_run',
      outputEntityId: String(run.id),
      outputRef: {
        runCode: run.runCode,
        status: run.status,
        startUtc: run.startUtc,
        endUtc: run.endUtc,
        activityCount: Number(run.activityCount),
        resultCount: Number(run.resultCount),
        calculatedCount: Number(run.calculatedCount),
        factorMissingCount: Number(run.factorMissingCount)
      }
    },
    ...results.map((result) => ({
      outputEntityType: 'carbon_accounting_result',
      outputEntityId: String(result.id),
      outputRef: {
        status: result.status,
        emissionValue: result.emissionValue === null ? null : Number(result.emissionValue),
        emissionUnit: result.emissionUnit || null,
        missingReason: result.missingReason || null
      }
    }))
  ];
  return {
    result: {
      sources: [...CARBON_ACTION_SOURCES],
      scope: { startUtc: run.startUtc, endUtc: run.endUtc },
      runCount: 1,
      resultCount: Number(run.resultCount),
      outputCount: outputs.length,
      calculatedCount: Number(run.calculatedCount),
      factorMissingCount: Number(run.factorMissingCount),
      emissionTotals
    },
    outputCount: outputs.length,
    outputs
  };
}

/** 在当前 outer transaction 内编排 exact、ownership、relations 与 receipt 完整链路。 */
function execute(context) {
  const db = context.db;
  const demoRun = context.privateContext?.demoRun;
  const actor = context.privateContext?.actor;
  const runBindingFields = ['runId', 'datasetId', 'manifestVersion', 'manifestDigest', 'status'];
  if (!demoRun || !context.run
    || runBindingFields.some((fieldName) => demoRun[fieldName] !== context.run[fieldName])
    || !actor || actor.userId !== context.actorUserId) {
    throw createCarbonAdapterError(
      'DEMO_CARBON_EXECUTION_BINDING_INVALID',
      'Carbon 后置动作执行对象身份与复核结果不一致。'
    );
  }
  const actionRun = readExecutingCarbonActionRun(db, context.actionRunId);
  if (actionRun.runId !== demoRun.runId || actionRun.datasetId !== demoRun.datasetId
    || actionRun.requestedBy !== actor.userId) {
    throw createCarbonAdapterError(
      'DEMO_CARBON_ACTION_RUN_INVALID',
      'Carbon 后置动作 action run、demo run 与 actor 绑定不一致。'
    );
  }
  const built = capturedCarbonHandlers.buildExact({ db, demoRun, actor });
  const exactScope = built.exactScope;
  const exactCapability = built.exactCapability;
  const exactExecution = capturedCarbonHandlers.executeExact({
    db,
    demoRun,
    actor,
    exactScope,
    exactCapability
  });
  const calculationWitness = exactExecution.calculationWitness;
  const registrationBinding = {
    db,
    demoRun,
    actionRun,
    actor,
    exactScope,
    calculationWitness
  };
  const registrationScope = capturedCarbonHandlers.issueRegistration(registrationBinding);
  let registrationReceipt = null;
  try {
    registrationReceipt = capturedCarbonHandlers.registerDerived({
      ...registrationBinding,
      registrationScope
    });
  } catch (error) {
    if (db.open === true && db.inTransaction === true) {
      try {
        capturedCarbonHandlers.abortRegistration({
          ...registrationBinding,
          registrationScope
        });
      } catch (_abortError) {
        throw createCarbonAdapterError(
          'DEMO_CARBON_REGISTRATION_ABORT_FAILED',
          'Carbon registration 未能完成安全终止。',
          500
        );
      }
    }
    throw error;
  }
  if (!registrationReceipt || typeof registrationReceipt !== 'object'
    || Array.isArray(registrationReceipt)) {
    if (db.open === true && db.inTransaction === true) {
      try {
        capturedCarbonHandlers.abortRegistration({
          ...registrationBinding,
          registrationScope
        });
      } catch (_abortError) {
        throw createCarbonAdapterError(
          'DEMO_CARBON_REGISTRATION_ABORT_FAILED',
          'Carbon registration 未能完成安全终止。',
          500
        );
      }
    }
    throw createCarbonAdapterError(
      'DEMO_CARBON_REGISTRATION_RECEIPT_INVALID',
      'Carbon registration 未返回可验证 receipt。',
      500
    );
  }
  // receipt 已返回后禁止 abort，只允许 verifier 完成或执行其私有恢复。
  capturedCarbonHandlers.verifyReceipt({
    ...registrationBinding,
    registrationScope,
    registrationReceipt
  });
  return readCarbonActionOutputs(db, exactExecution.calculationRun.id);
}

/**
 * 对 Carbon public scope 复用项目严格 UTC 输入合同并形成完整左闭右开区间。
 * 无效历史值统一返回 null，不向只读 status 或 terminal replay 抛内部日期错误。
 */
const projectCarbonPublicUtcScope = Object.freeze(function projectCarbonPublicUtcScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || typeof scope.startUtc !== 'string' || typeof scope.endUtc !== 'string'
    || !STRICT_UTC_INPUT_PATTERN.test(scope.startUtc)
    || !STRICT_UTC_INPUT_PATTERN.test(scope.endUtc)) {
    return null;
  }
  try {
    const startUtc = normalizeUserVisibleStrictUtcInput(scope.startUtc);
    const endUtc = normalizeUserVisibleStrictUtcInput(scope.endUtc);
    return startUtc && endUtc && startUtc < endUtc
      ? Object.freeze({ startUtc, endUtc })
      : null;
  } catch (_error) {
    return null;
  }
});

/** 将允许公开的计数规范化为非负安全整数，不对字符串、布尔值或对象执行隐式转换。 */
function projectCarbonPublicCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

/** 仅投影原始有限 number，禁止字符串、布尔值、空串、数组或对象隐式转换。 */
function projectCarbonPublicFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 按正式固定值投影 calculation run 状态。 */
function projectCarbonCalculationRunStatus(value) {
  return value === CARBON_CALCULATION_RUN_COMPLETED_STATUS
    ? CARBON_CALCULATION_RUN_COMPLETED_STATUS
    : null;
}

/** 按正式生成器结构和真实 UTC 日历时间投影 calculation run code。 */
function projectCarbonCalculationRunCode(value) {
  if (typeof value !== 'string') return null;
  const matched = CARBON_CALCULATION_RUN_CODE_PATTERN.exec(value);
  if (!matched) return null;
  const timestamp = matched[1];
  const timestampUtc = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}Z`;
  try {
    return normalizeUserVisibleStrictUtcInput(timestampUtc) === timestampUtc
      ? value
      : null;
  } catch (_error) {
    return null;
  }
}

/** 复用正式纯函数合同投影 Carbon 排放单位，合法别名统一输出 canonical 值。 */
function projectCarbonEmissionUnit(value) {
  const normalized = normalizeCarbonEmissionUnit(value);
  return normalized.ok ? normalized.value : null;
}

/** 联合投影 accounting result 状态、单位和缺因子原因，非法组合整体清空。 */
function projectCarbonAccountingResultStrings(value) {
  if (value?.status === CARBON_ACCOUNTING_RESULT_CALCULATED_STATUS
    && value.missingReason === null) {
    const emissionUnit = projectCarbonEmissionUnit(value.emissionUnit);
    if (emissionUnit !== null) {
      return {
        status: CARBON_ACCOUNTING_RESULT_CALCULATED_STATUS,
        emissionUnit,
        missingReason: null
      };
    }
  }
  if (value?.status === CARBON_ACCOUNTING_RESULT_FACTOR_MISSING_STATUS
    && value.emissionUnit === null
    && value.missingReason === CARBON_ACCOUNTING_MISSING_FACTOR_CODE) {
    return {
      status: CARBON_ACCOUNTING_RESULT_FACTOR_MISSING_STATUS,
      emissionUnit: null,
      missingReason: CARBON_ACCOUNTING_MISSING_FACTOR_CODE
    };
  }
  return { status: null, emissionUnit: null, missingReason: null };
}

/** Carbon 公开 input 的每个标量叶子均执行显式类型和范围白名单。 */
function projectPublicInput(input = {}) {
  return {
    sources: [...CARBON_ACTION_SOURCES],
    scope: projectCarbonPublicUtcScope(input?.scope),
    activityCount: projectCarbonPublicCount(input?.activityCount),
    factorCount: projectCarbonPublicCount(input?.factorCount),
    expectedRunCount: projectCarbonPublicCount(input?.expectedRunCount),
    expectedResultCount: projectCarbonPublicCount(input?.expectedResultCount),
    expectedOutputCount: projectCarbonPublicCount(input?.expectedOutputCount),
    calculatedCount: projectCarbonPublicCount(input?.calculatedCount),
    factorMissingCount: projectCarbonPublicCount(input?.factorMissingCount),
    dependencies: Array.isArray(input?.dependencies) ? input.dependencies.map((dependency) => ({
      code: typeof dependency?.code === 'string'
        && CARBON_PUBLIC_DEPENDENCY_CODES.has(dependency.code)
        ? dependency.code
        : null,
      blocking: typeof dependency?.blocking === 'boolean'
        ? dependency.blocking
        : false,
      count: projectCarbonPublicCount(dependency?.count)
    })) : []
  };
}

/** 对 emissionTotals 执行递归显式白名单，并合并规范化后相同单位的有限总计。 */
function projectCarbonEmissionTotals(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const totals = [];
  const totalIndexesByUnit = new Map();
  (Array.isArray(value.totals) ? value.totals : []).forEach((total) => {
    const emissionUnit = projectCarbonEmissionUnit(total?.emissionUnit);
    const totalEmissionValue = projectCarbonPublicFiniteNumber(total?.totalEmissionValue);
    const calculatedCount = projectCarbonPublicCount(total?.calculatedCount);
    if (emissionUnit === null) {
      totals.push({ emissionUnit: null, totalEmissionValue, calculatedCount });
      return;
    }
    const existingIndex = totalIndexesByUnit.get(emissionUnit);
    if (existingIndex === undefined) {
      totalIndexesByUnit.set(emissionUnit, totals.length);
      totals.push({ emissionUnit, totalEmissionValue, calculatedCount });
      return;
    }
    const existing = totals[existingIndex];
    const mergedValue = existing.totalEmissionValue === null || totalEmissionValue === null
      ? null
      : existing.totalEmissionValue + totalEmissionValue;
    const mergedCount = existing.calculatedCount + calculatedCount;
    existing.totalEmissionValue = Number.isFinite(mergedValue) ? mergedValue : null;
    existing.calculatedCount = Number.isSafeInteger(mergedCount) && mergedCount >= 0
      ? mergedCount
      : 0;
  });
  return {
    version: projectCarbonPublicCount(value.version),
    totals
  };
}

/** 对两类 Carbon outputRef 分别执行递归显式白名单。 */
function projectCarbonPublicOutputRef(outputRef, outputEntityType) {
  if (!outputRef || typeof outputRef !== 'object' || Array.isArray(outputRef)) return null;
  if (outputEntityType === 'carbon_calculation_run') {
    const scope = projectCarbonPublicUtcScope(outputRef);
    return {
      runCode: projectCarbonCalculationRunCode(outputRef.runCode),
      status: projectCarbonCalculationRunStatus(outputRef.status),
      startUtc: scope?.startUtc || null,
      endUtc: scope?.endUtc || null,
      activityCount: projectCarbonPublicCount(outputRef.activityCount),
      resultCount: projectCarbonPublicCount(outputRef.resultCount),
      calculatedCount: projectCarbonPublicCount(outputRef.calculatedCount),
      factorMissingCount: projectCarbonPublicCount(outputRef.factorMissingCount)
    };
  }
  if (outputEntityType === 'carbon_accounting_result') {
    const projectedStrings = projectCarbonAccountingResultStrings(outputRef);
    return {
      status: projectedStrings.status,
      emissionValue: projectCarbonPublicFiniteNumber(outputRef.emissionValue),
      emissionUnit: projectedStrings.emissionUnit,
      missingReason: projectedStrings.missingReason
    };
  }
  return null;
}

/** Carbon public result 与 outputRef 只使用递归显式白名单，不把 blacklist 作为领域授权。 */
function projectPublicResult(result, projection = null) {
  if (projection?.kind === 'outputRef') {
    return projectCarbonPublicOutputRef(result, projection.outputEntityType);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  return {
    sources: [...CARBON_ACTION_SOURCES],
    scope: projectCarbonPublicUtcScope(result.scope),
    runCount: projectCarbonPublicCount(result.runCount),
    resultCount: projectCarbonPublicCount(result.resultCount),
    outputCount: projectCarbonPublicCount(result.outputCount),
    calculatedCount: projectCarbonPublicCount(result.calculatedCount),
    factorMissingCount: projectCarbonPublicCount(result.factorMissingCount),
    emissionTotals: projectCarbonEmissionTotals(result.emissionTotals)
  };
}

/** 将 Carbon resolver/exact 异常映射为不泄露内部证据的稳定 blocker。 */
function mapPreviewBlocker(error) {
  const code = typeof error?.code === 'string' && /^(?:DEMO_CARBON|CARBON_ACCOUNTING)_[A-Z0-9_]{1,100}$/.test(error.code)
    ? error.code
    : 'DEMO_CARBON_INPUT_BLOCKED';
  return {
    code,
    message: '服务端无法证明 artifact 11/27 的 Carbon exact 输入闭包，已安全阻断。'
  };
}

Object.defineProperties(carbonAccountingAdapterExports, {
  resolve: { value: resolve, enumerable: true, writable: false, configurable: false },
  previewProbe: { value: previewProbe, enumerable: true, writable: false, configurable: false },
  revalidate: { value: revalidate, enumerable: true, writable: false, configurable: false },
  execute: { value: execute, enumerable: true, writable: false, configurable: false },
  projectPublicInput: { value: projectPublicInput, enumerable: true, writable: false, configurable: false },
  projectPublicResult: { value: projectPublicResult, enumerable: true, writable: false, configurable: false },
  mapPreviewBlocker: { value: mapPreviewBlocker, enumerable: true, writable: false, configurable: false }
});

Object.freeze(carbonAccountingAdapterExports);
