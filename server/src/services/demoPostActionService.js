'use strict';

// 公共入口只转发 CommonJS canonical core；删除本 wrapper cache 不会重建 service graph。
const canonicalService = require('./demoPostActionCanonicalService');

Object.defineProperty(module, 'exports', {
  value: canonicalService,
  enumerable: true,
  writable: false,
  configurable: false
});
