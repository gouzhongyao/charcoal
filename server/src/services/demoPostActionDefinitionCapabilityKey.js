'use strict';

// 兼容保留的无 authority 结构常量；不用于领取 canonical issuer 或 verifier。
const DEPRECATED_DEFINITION_CAPABILITY_PROTOCOL_SYMBOL = Symbol(
  'charcoal.demoPostAction.definitionCapability.deprecated.v1'
);

Object.defineProperty(module, 'exports', {
  value: DEPRECATED_DEFINITION_CAPABILITY_PROTOCOL_SYMBOL,
  enumerable: false,
  writable: false,
  configurable: false
});
