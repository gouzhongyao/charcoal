const crypto = require('crypto');
const { AppError } = require('../utils/errors');

let currentMaintenance = null;

function buildMaintenanceError(action = 'write') {
  return new AppError('MAINTENANCE_IN_PROGRESS', '系统正在执行备份恢复维护操作，请稍后重试。', {
    statusCode: 423,
    details: {
      action,
      maintenance: currentMaintenance,
      retry: '稍后重试'
    }
  });
}

function getMaintenanceState() {
  return currentMaintenance
    ? {
      active: true,
      ...currentMaintenance
    }
    : { active: false };
}

function isMaintenanceActive() {
  return Boolean(currentMaintenance);
}

function assertWritableAllowed(action = 'write') {
  if (currentMaintenance) {
    throw buildMaintenanceError(action);
  }
}

async function runWithMaintenance(operation, handler, details = {}) {
  assertWritableAllowed(operation || 'maintenance');
  currentMaintenance = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${process.pid}`,
    operation: operation || 'maintenance',
    startedAt: new Date().toISOString(),
    ...details
  };

  try {
    return await handler(getMaintenanceState());
  } finally {
    currentMaintenance = null;
  }
}

module.exports = {
  assertWritableAllowed,
  getMaintenanceState,
  isMaintenanceActive,
  runWithMaintenance
};
