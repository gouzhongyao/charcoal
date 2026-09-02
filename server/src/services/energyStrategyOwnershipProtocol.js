'use strict';

// 协议导出壳在初始化首段即绑定到当前 Module，禁止整体替换 require.cache exports。
const energyStrategyOwnershipProtocolExports = {};
// 使用稳定 Proxy 壳绕开 Node 23 循环加载器对普通 exports 原型的临时改写。
const energyStrategyOwnershipProtocolExportsProxy = new Proxy(energyStrategyOwnershipProtocolExports, {});
Object.defineProperty(module, 'exports', {
  value: energyStrategyOwnershipProtocolExportsProxy,
  enumerable: true,
  writable: false,
  configurable: false
});

// 协议 wrapper 先绑定到导出壳，确保 evaluator-first 与 ownership-first 循环加载均可取得同一对象。
let evaluatorHandlers = null;
let ownershipHandlers = null;

/** 将初始化期捕获的公开函数固定为不可重新赋值的服务导出。 */
function defineImmutableServiceExports(serviceExports, handlers) {
  Object.entries(handlers).forEach(([fieldName, handler]) => {
    Object.defineProperty(serviceExports, fieldName, {
      value: handler,
      enumerable: true,
      writable: false,
      configurable: false
    });
  });
}

/** 从真实服务模块已经固定的导出壳捕获不可变协议函数引用。 */
function captureServiceHandlers(protocolName, serviceExports, handlerExports) {
  if (!serviceExports || typeof serviceExports !== 'object') {
    throw new TypeError(`${protocolName} 内部协议服务导出无效。`);
  }
  const handlers = {};
  Object.entries(handlerExports).forEach(([protocolField, exportField]) => {
    const handler = serviceExports[exportField];
    if (typeof handler !== 'function') {
      throw new TypeError(`${protocolName} 内部协议函数未完成初始化。`);
    }
    handlers[protocolField] = handler;
  });
  return Object.freeze(handlers);
}

/** 取得已在服务模块初始化早期捕获的 evaluator 函数。 */
function requireEvaluatorHandler(fieldName) {
  const handler = evaluatorHandlers?.[fieldName];
  if (typeof handler !== 'function') {
    const error = new Error('策略评价 evaluator 内部协议尚未完成模块初始化。');
    error.code = 'ENERGY_STRATEGY_EVALUATOR_PROTOCOL_UNAVAILABLE';
    throw error;
  }
  return handler;
}

/** 取得已在服务模块初始化早期捕获的 ownership 函数。 */
function requireOwnershipHandler(fieldName) {
  const handler = ownershipHandlers?.[fieldName];
  if (typeof handler !== 'function') {
    const error = new Error('策略评价 ownership 内部协议尚未完成模块初始化。');
    error.code = 'ENERGY_STRATEGY_OWNERSHIP_PROTOCOL_UNAVAILABLE';
    throw error;
  }
  return handler;
}

// 服务模块只取得以下冻结 wrapper；协议没有公开登记入口，也不接受调用方提供 Module、栈或 handler。
const energyStrategyEvaluatorProtocol = Object.freeze({
  assertExactScope: (...args) => requireEvaluatorHandler('assertExactScope')(...args),
  bindRegistrationScope: (...args) => requireEvaluatorHandler('bindRegistrationScope')(...args),
  consumeWitness: (...args) => requireEvaluatorHandler('consumeWitness')(...args),
  getRuleHit: (...args) => requireEvaluatorHandler('getRuleHit')(...args),
  insertOperationAudit: (...args) => requireEvaluatorHandler('insertOperationAudit')(...args),
  parseEvidenceRequirements: (...args) => requireEvaluatorHandler('parseEvidenceRequirements')(...args)
});
const energyStrategyOwnershipProtocol = Object.freeze({
  abort: (...args) => requireOwnershipHandler('abort')(...args),
  activate: (...args) => requireOwnershipHandler('activate')(...args),
  register: (...args) => requireOwnershipHandler('register')(...args),
  verifyReceipt: (...args) => requireOwnershipHandler('verifyReceipt')(...args),
  calculateIdentityDigest: (...args) => requireOwnershipHandler('calculateIdentityDigest')(...args),
  calculateSnapshotDigest: (...args) => requireOwnershipHandler('calculateSnapshotDigest')(...args),
  refreshRuleHitOwnership: (...args) => requireOwnershipHandler('refreshRuleHitOwnership')(...args)
});

defineImmutableServiceExports(energyStrategyOwnershipProtocolExports, {
  energyStrategyEvaluatorProtocol,
  energyStrategyOwnershipProtocol
});

// 仅在协议模块初始化期间读取两侧已由服务首段固定的函数引用；业务调用不再读取 require.cache。
const evaluatorServiceExports = require('./energyStrategyEvaluationService');
evaluatorHandlers = captureServiceHandlers(
  '策略评价 evaluator',
  evaluatorServiceExports,
  {
    assertExactScope: 'assertEnergyStrategyExactScopeCapability',
    bindRegistrationScope: 'bindEnergyStrategyRegistrationScopeCapability',
    consumeWitness: Symbol.for('charcoal.energyStrategy.consumeWitness.v1'),
    getRuleHit: 'getStrategyRuleHitWithDb',
    insertOperationAudit: 'insertOperationLogWithDb',
    parseEvidenceRequirements: 'parseEvidenceRequirements'
  }
);
const ownershipServiceExports = require('./demoOwnershipService');
ownershipHandlers = captureServiceHandlers(
  '策略评价 ownership',
  ownershipServiceExports,
  {
    abort: 'abortStrategyEvaluationRegistrationScopeInTransaction',
    activate: 'activateStrategyEvaluationRegistrationScopeInTransaction',
    register: 'registerDerivedStrategyEvaluationInTransaction',
    verifyReceipt: 'verifyDerivedStrategyEvaluationReceiptInTransaction',
    calculateIdentityDigest: 'calculateDemoEntityIdentityDigest',
    calculateSnapshotDigest: 'calculateDemoEntitySnapshotDigest',
    refreshRuleHitOwnership: 'refreshDerivedStrategyRuleHitOwnershipInTransaction'
  }
);

// wrapper 与服务导出字段均已在初始化期固定，后续只能执行捕获的函数对象。
Object.freeze(energyStrategyOwnershipProtocolExports);
