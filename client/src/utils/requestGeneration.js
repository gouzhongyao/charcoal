// 请求世代仲裁模块：多个异步请求逆序返回时，只允许当前最新世代提交状态。

/**
 * 生成下一个安全请求世代编号。
 * @param {number} currentGeneration 当前世代。
 * @returns {number} 下一世代。
 */
export function nextRequestGeneration(currentGeneration = 0) {
  const normalizedGeneration = Number.isSafeInteger(currentGeneration) && currentGeneration >= 0
    ? currentGeneration
    : 0;
  return normalizedGeneration >= Number.MAX_SAFE_INTEGER ? 1 : normalizedGeneration + 1;
}

/**
 * 判断异步结果是否仍属于当前最新请求世代。
 * @param {number} requestGeneration 请求发起时捕获的世代。
 * @param {number} currentGeneration 当前最新世代。
 * @returns {boolean} 是否允许提交结果、错误和 loading。
 */
export function isLatestRequestGeneration(requestGeneration, currentGeneration) {
  return Number.isSafeInteger(requestGeneration)
    && requestGeneration > 0
    && requestGeneration === currentGeneration;
}
