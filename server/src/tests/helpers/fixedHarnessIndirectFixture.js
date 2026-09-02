'use strict';

// 间接 fixture 只能转发两个 assertion-only/fixed-result helper 的冻结公开表面。
module.exports = Object.freeze({
  carbonHarness: require('./carbonAccountingFaultHarness'),
  demoHarness: require('./demoServiceTestHarness')
});
