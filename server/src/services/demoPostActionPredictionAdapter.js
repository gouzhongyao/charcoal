'use strict';

const service = require('./demoPostActionService');

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
const predictionAdapter = canonicalPredictionInstances?.adapter;
const expectedFields = Object.freeze([
  'resolve',
  'previewProbe',
  'revalidate',
  'execute',
  'projectPublicInput',
  'projectPublicResult',
  'mapPreviewBlocker'
]);
if (!predictionAdapter
  || !Object.isFrozen(predictionAdapter)
  || Object.getOwnPropertySymbols(predictionAdapter).length !== 0
  || Object.keys(predictionAdapter).length !== expectedFields.length
  || Object.keys(predictionAdapter).some(
    (fieldName, index) => fieldName !== expectedFields[index]
      || typeof predictionAdapter[fieldName] !== 'function'
  )) {
  const initializationError = new Error('Canonical Prediction adapter 不可用。');
  initializationError.code = 'DEMO_PREDICTION_CANONICAL_ADAPTER_UNAVAILABLE';
  throw initializationError;
}

Object.defineProperty(module, 'exports', {
  value: predictionAdapter,
  enumerable: true,
  writable: false,
  configurable: false
});
