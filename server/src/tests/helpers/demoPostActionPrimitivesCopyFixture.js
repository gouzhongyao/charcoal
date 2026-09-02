'use strict';

const productionPrimitives = require('../../services/demoPostActionServicePrimitives');

// copy fixture 复用相同函数值但保持不同 CommonJS record 与 exports identity。
module.exports = Object.freeze({
  assertStrictBody: productionPrimitives.assertStrictBody,
  stableDigest: productionPrimitives.stableDigest
});
