'use strict';

// exact 协议在任何依赖加载前固定导出壳与对象身份；不承诺抵御 RF-P2-069 前置完整 cache 接管。
const carbonAccountingExactProtocolExports = {};
const carbonAccountingExactProtocolExportsProxy = new Proxy(
  carbonAccountingExactProtocolExports,
  {}
);
Object.defineProperty(module, 'exports', {
  value: carbonAccountingExactProtocolExportsProxy,
  enumerable: true,
  writable: false,
  configurable: false
});

const CARBON_EXACT_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.carbonAccounting.exactInternal.v1');
const calculationService = require('./carbonCalculationRunService');
const internalProtocol = calculationService[CARBON_EXACT_INTERNAL_PROTOCOL_SYMBOL];

if (!internalProtocol
  || typeof internalProtocol.buildExactScopeInCallerTransaction !== 'function'
  || typeof internalProtocol.executeExactInCallerTransaction !== 'function'
  || typeof internalProtocol.inspectRegistrationContextInCallerTransaction !== 'function'
  || typeof internalProtocol.consumeCalculationWitnessInCallerTransaction !== 'function') {
  const error = new Error('碳核算 exact 内部协议未完成初始化。');
  error.code = 'CARBON_ACCOUNTING_EXACT_PROTOCOL_UNAVAILABLE';
  throw error;
}

// 初始化完成后一次性捕获既有四个正式 handler，后续 require.cache 或依赖 exports 替换不能接管既有 consumer。
const capturedExactHandlers = Object.freeze({
  build: internalProtocol.buildExactScopeInCallerTransaction,
  execute: internalProtocol.executeExactInCallerTransaction,
  inspect: internalProtocol.inspectRegistrationContextInCallerTransaction,
  consume: internalProtocol.consumeCalculationWitnessInCallerTransaction
});

// 内部调用方只能取得固定 wrapper；协议不接受实体 ID、SQL、客户端期间或任意 handler 注入。
Object.defineProperties(carbonAccountingExactProtocolExports, {
  buildExactScopeInCallerTransaction: {
    value: (...args) => capturedExactHandlers.build(...args),
    enumerable: true,
    writable: false,
    configurable: false
  },
  executeExactInCallerTransaction: {
    value: (...args) => capturedExactHandlers.execute(...args),
    enumerable: true,
    writable: false,
    configurable: false
  },
  inspectRegistrationContextInCallerTransaction: {
    value: (...args) => capturedExactHandlers.inspect(...args),
    enumerable: true,
    writable: false,
    configurable: false
  },
  consumeCalculationWitnessInCallerTransaction: {
    value: (...args) => capturedExactHandlers.consume(...args),
    enumerable: true,
    writable: false,
    configurable: false
  }
});

Object.freeze(carbonAccountingExactProtocolExports);
