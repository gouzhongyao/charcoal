'use strict';

const crypto = require('crypto');
const { badRequest } = require('../utils/errors');

/**
 * 递归规范化 JSON 值的对象键顺序。
 * @param {*} value 待规范化 JSON 值。
 * @returns {*} 稳定键顺序值。
 */
function normalizeStableDigestValue(value) {
  if (Array.isArray(value)) return value.map(normalizeStableDigestValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, normalizeStableDigestValue(value[key])])
    );
  }
  return value;
}

/**
 * 对 JSON 值按键排序并计算服务端稳定 SHA-256 摘要。
 * @param {*} value 待摘要 JSON 值。
 * @returns {string} 小写十六进制 SHA-256。
 */
function stableDigest(value) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(normalizeStableDigestValue(value)), 'utf8')
    .digest('hex');
}

/**
 * 校验请求正文是 JSON object 且只含服务端固定允许字段。
 * @param {object} body 请求正文。
 * @param {string[]} allowedFields 允许字段白名单。
 * @param {string} operation 操作名称。
 * @returns {void}
 */
function assertStrictBody(body, allowedFields, operation) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest(`${operation} 请求正文必须是 JSON object。`, {
      code: 'DEMO_POST_ACTION_BODY_INVALID'
    });
  }
  const unknownFields = Object.keys(body)
    .filter((field) => !allowedFields.includes(field));
  if (unknownFields.length > 0) {
    throw badRequest(`${operation} 请求正文包含未知字段。`, {
      code: 'DEMO_POST_ACTION_BODY_FIELD_UNKNOWN',
      fields: unknownFields.sort()
    });
  }
}

module.exports = Object.freeze({
  assertStrictBody,
  stableDigest
});
