const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function clearGenerationServiceModule() {
  const modulePath = require.resolve('../services/generationService');
  delete require.cache[modulePath];
}

function clearDatabaseModule() {
  const modulePath = require.resolve('../db/database');
  delete require.cache[modulePath];
}

function loadIsolatedInstance(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.DATA_DIR = path.join(tmpDir, 'data');
  process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'generation-import-signature.sqlite');
  process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
  process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
  process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
  delete process.env.GENERATION_RECORD_IMPORT_HMAC_SECRET;
  delete process.env.CHARCOAL_HMAC_SECRET;
  delete process.env.APP_SECRET;
  clearDatabaseModule();
  clearGenerationServiceModule();
  const database = require('../db/database');
  const service = require('../services/generationService');
  database.initDatabase();
  return { tmpDir, database, service };
}

function seedUnit(database, code, name) {
  const db = database.openDatabase();
  try {
    db.prepare('INSERT INTO organization_units (unit_code, unit_name, unit_path, unit_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))')
      .run(code, name, name, 'workshop', 'active');
  } finally {
    db.close();
  }
}

function buildRows(code, name) {
  return [{
    '用能单元编码': code,
    '用能单元名称': name,
    '月份': '2026-01',
    '发电量 kWh': '100',
    '自发自用 kWh': '80',
    '上网电量 kWh': '20',
    '数据来源': 'upload',
    '备注': 'secret 测试'
  }];
}

const publicDefaultSecret = 'charcoal-local-development-generation-record-import-hmac-secret';
const first = loadIsolatedInstance('charcoal-generation-signature-a-');
const second = loadIsolatedInstance('charcoal-generation-signature-b-');

try {
  seedUnit(first.database, 'GEN-SECRET', '签名密钥单元');
  const firstSecret = first.service.getGenerationRecordImportHmacSecret();
  assert.match(firstSecret, /^[0-9a-f]{64}$/, '未配置环境变量时应生成 32 字节 hex 安装级 HMAC secret。');
  assert.notStrictEqual(firstSecret, publicDefaultSecret, '未配置环境变量时不得使用源码公开默认 HMAC secret。');
  assert.strictEqual(first.service.getGenerationRecordImportHmacSecret(), firstSecret, '同一隔离实例应稳定复用 app_meta 中的 HMAC secret。');
  const firstPreview = first.service.buildGenerationRecordImportPreviewFromRows(buildRows('GEN-SECRET', '签名密钥单元'));
  assert(!JSON.stringify(firstPreview).includes(firstSecret), 'preview 响应不得泄露安装级 HMAC secret。');
  assert(!JSON.stringify(firstPreview).includes(publicDefaultSecret), 'preview 响应不得泄露或依赖公开默认 HMAC secret。');

  seedUnit(second.database, 'GEN-SECRET', '签名密钥单元');
  const secondSecret = second.service.getGenerationRecordImportHmacSecret();
  assert.match(secondSecret, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(secondSecret, firstSecret, '不同隔离实例未配置环境变量时应生成不同安装级 HMAC secret。');
  const secondPreview = second.service.buildGenerationRecordImportPreviewFromRows(buildRows('GEN-SECRET', '签名密钥单元'));
  assert.notStrictEqual(secondPreview.previewSignature, firstPreview.previewSignature, '不同安装级 HMAC secret 应产生不同 previewSignature。');

  process.env.GENERATION_RECORD_IMPORT_HMAC_SECRET = 'explicit-generation-import-secret';
  clearGenerationServiceModule();
  const envService = require('../services/generationService');
  assert.strictEqual(envService.getGenerationRecordImportHmacSecret(), 'explicit-generation-import-secret', '显式 GENERATION_RECORD_IMPORT_HMAC_SECRET 应优先于安装级 secret。');
  const envPreview = envService.buildGenerationRecordImportPreviewFromRows(buildRows('GEN-SECRET', '签名密钥单元'));
  assert.notStrictEqual(envPreview.previewSignature, firstPreview.previewSignature, '显式环境 secret 应改变签名。');
  assert(!JSON.stringify(envPreview).includes(process.env.GENERATION_RECORD_IMPORT_HMAC_SECRET), 'preview 响应不得泄露环境 HMAC secret。');

  console.log('generation import signature secret tests passed');
} finally {
  fs.rmSync(first.tmpDir, { recursive: true, force: true });
  fs.rmSync(second.tmpDir, { recursive: true, force: true });
}
