'use strict';

const productionService = require('../../services/demoOwnershipService');

// copy fixture 故意复用相同字段和正式 protocol 值，但保持不同 CommonJS record 与 exports identity。
const canonicalProtocolSymbol = Symbol.for('charcoal.demoOwnership.canonicalInternal.v1');
const copiedExports = { ...productionService };
Object.defineProperty(copiedExports, canonicalProtocolSymbol, {
  value: productionService[canonicalProtocolSymbol],
  enumerable: false,
  writable: false,
  configurable: false
});

module.exports = Object.freeze(copiedExports);
