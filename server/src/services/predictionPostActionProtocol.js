'use strict';

const service = require('./demoPostActionService');

// P4 wrapper 只使用模块本地 Symbol 暴露只读 canonical 实例，不建立全局可领取角色名。
const PREDICTION_POST_ACTION_REGISTRATION_INTERNAL_PROTOCOL_SYMBOL = Symbol(
  'charcoal.prediction.postActionRegistrationInternal.v1'
);
const canonicalPredictionInstances = Object.getOwnPropertySymbols(service)
  .map((protocolSymbol) => Object.getOwnPropertyDescriptor(service, protocolSymbol)?.value)
  .find((candidate) => (
    candidate
    && typeof candidate === 'object'
    && Object.isFrozen(candidate)
    && Reflect.ownKeys(candidate).length === 2
    && candidate.adapter
    && candidate.p4
  ));
const predictionPostActionProtocol = canonicalPredictionInstances?.p4;
const expectedFields = Object.freeze([
  'issueRegistrationScopeInCallerTransaction',
  'registerDerivedOwnershipInCallerTransaction',
  'verifyRegistrationReceiptInCallerTransaction',
  'abortRegistrationScopeInCallerTransaction'
]);
if (!predictionPostActionProtocol
  || !Object.isFrozen(predictionPostActionProtocol)
  || Object.getOwnPropertySymbols(predictionPostActionProtocol).length !== 0
  || Object.keys(predictionPostActionProtocol).length !== expectedFields.length
  || Object.keys(predictionPostActionProtocol).some(
    (fieldName, index) => fieldName !== expectedFields[index]
      || typeof predictionPostActionProtocol[fieldName] !== 'function'
  )) {
  const initializationError = new Error('Canonical Prediction P4 protocol 不可用。');
  initializationError.code = 'PREDICTION_CANONICAL_P4_PROTOCOL_UNAVAILABLE';
  throw initializationError;
}

const protocolExports = {};
Object.defineProperty(
  protocolExports,
  PREDICTION_POST_ACTION_REGISTRATION_INTERNAL_PROTOCOL_SYMBOL,
  {
    value: predictionPostActionProtocol,
    enumerable: false,
    writable: false,
    configurable: false
  }
);
Object.freeze(protocolExports);

Object.defineProperty(module, 'exports', {
  value: protocolExports,
  enumerable: true,
  writable: false,
  configurable: false
});
