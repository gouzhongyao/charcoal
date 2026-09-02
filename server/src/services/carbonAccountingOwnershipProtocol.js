'use strict';

// 协议导出壳在初始化首段固定，后续 require.cache 替换不能改变已捕获 registrar 闭包。
const carbonAccountingOwnershipProtocolExports = {};
const carbonAccountingOwnershipProtocolExportsProxy = new Proxy(
  carbonAccountingOwnershipProtocolExports,
  {}
);
Object.defineProperty(module, 'exports', {
  value: carbonAccountingOwnershipProtocolExportsProxy,
  enumerable: true,
  writable: false,
  configurable: false
});

const { types: utilTypes } = require('util');

const CARBON_OWNERSHIP_INTERNAL_PROTOCOL_SYMBOL =
  Symbol.for('charcoal.carbonAccounting.ownershipInternal.v1');

const ownershipService = require('./carbonAccountingOwnershipService');
const ownershipInternal = ownershipService[CARBON_OWNERSHIP_INTERNAL_PROTOCOL_SYMBOL];

if (!ownershipInternal
  || typeof ownershipInternal.issueRegistrationScopeInCallerTransaction !== 'function'
  || typeof ownershipInternal.registerDerivedOwnershipInCallerTransaction !== 'function'
  || typeof ownershipInternal.verifyRegistrationReceiptInCallerTransaction !== 'function'
  || typeof ownershipInternal.abortRegistrationScopeInCallerTransaction !== 'function') {
  const error = new Error('碳核算 ownership 内部协议未完成初始化。');
  error.code = 'CARBON_ACCOUNTING_OWNERSHIP_PROTOCOL_UNAVAILABLE';
  throw error;
}

const capturedHandlers = Object.freeze({
  issue: ownershipInternal.issueRegistrationScopeInCallerTransaction,
  register: ownershipInternal.registerDerivedOwnershipInCallerTransaction,
  verifyReceipt: ownershipInternal.verifyRegistrationReceiptInCallerTransaction,
  abort: ownershipInternal.abortRegistrationScopeInCallerTransaction
});

/** 校验协议 wrapper 输入，service 内部闭包负责注入不可替换的 registrar authority。 */
function normalizeProtocolInput(input, expectedFields) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || utilTypes.isProxy(input)
    || Object.getPrototypeOf(input) !== Object.prototype) {
    const error = new TypeError('碳核算 ownership 协议输入必须是严格普通对象。');
    error.code = 'CARBON_ACCOUNTING_OWNERSHIP_PROTOCOL_INPUT_INVALID';
    throw error;
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const actualFields = Object.keys(descriptors).sort();
  const normalizedExpectedFields = [...expectedFields].sort();
  const hasAccessor = actualFields.some((fieldName) => (
    typeof descriptors[fieldName].get === 'function'
    || typeof descriptors[fieldName].set === 'function'
  ));
  if (hasAccessor || Object.getOwnPropertySymbols(input).length > 0
    || actualFields.length !== normalizedExpectedFields.length
    || actualFields.some((fieldName, index) => fieldName !== normalizedExpectedFields[index])) {
    const error = new TypeError('碳核算 ownership 协议输入字段无效。');
    error.code = 'CARBON_ACCOUNTING_OWNERSHIP_PROTOCOL_INPUT_INVALID';
    throw error;
  }
  return Object.fromEntries(actualFields.map((fieldName) => (
    [fieldName, descriptors[fieldName].value]
  )));
}

const CARBON_REGISTRATION_BINDING_FIELDS = Object.freeze([
  'db', 'demoRun', 'actionRun', 'actor', 'exactScope', 'calculationWitness'
]);
const CARBON_REGISTRATION_SCOPE_FIELDS = Object.freeze([
  ...CARBON_REGISTRATION_BINDING_FIELDS,
  'registrationScope'
]);
const CARBON_REGISTRATION_RECEIPT_FIELDS = Object.freeze([
  ...CARBON_REGISTRATION_SCOPE_FIELDS,
  'registrationReceipt'
]);

const carbonAccountingOwnershipProtocol = Object.freeze({
  issueRegistrationScopeInCallerTransaction: (input) => (
    capturedHandlers.issue(normalizeProtocolInput(input, CARBON_REGISTRATION_BINDING_FIELDS))
  ),
  registerDerivedOwnershipInCallerTransaction: (input) => (
    capturedHandlers.register(normalizeProtocolInput(input, CARBON_REGISTRATION_SCOPE_FIELDS))
  ),
  verifyRegistrationReceiptInCallerTransaction: (input) => (
    capturedHandlers.verifyReceipt(normalizeProtocolInput(input, CARBON_REGISTRATION_RECEIPT_FIELDS))
  ),
  abortRegistrationScopeInCallerTransaction: (input) => (
    capturedHandlers.abort(normalizeProtocolInput(input, CARBON_REGISTRATION_SCOPE_FIELDS))
  )
});

Object.defineProperty(
  carbonAccountingOwnershipProtocolExports,
  'carbonAccountingOwnershipProtocol',
  {
    value: carbonAccountingOwnershipProtocol,
    enumerable: true,
    writable: false,
    configurable: false
  }
);

Object.freeze(carbonAccountingOwnershipProtocolExports);
