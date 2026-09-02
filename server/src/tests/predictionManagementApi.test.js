const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-prediction-api-'));
process.env.DATA_DIR = path.join(tmpDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'prediction.sqlite');
process.env.UPLOADS_DIR = path.join(tmpDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tmpDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'AdminPassword123!';
process.env.CHARCOAL_ALLOW_REGISTER = 'true';

const { initDatabase, openDatabase } = require('../db/database');
const { register } = require('../services/authService');
const { getImportAuditBatchDetail } = require('../services/importAuditService');

function request(server, method, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: pathname, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) }), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const buffer = Buffer.concat(chunks); const isJson = String(res.headers['content-type'] || '').includes('application/json'); resolve({ status: res.statusCode, headers: res.headers, body: isJson && buffer.length ? JSON.parse(buffer.toString('utf8')) : buffer }); });
    });
    req.on('error', reject); req.end(raw);
  });
}

function grantViewRole(username, permissionCode) {
  const db = openDatabase();
  try {
    const now = new Date().toISOString();
    const user = db.prepare('SELECT id FROM sys_users WHERE username = ?').get(username);
    const roleId = db.prepare(`INSERT INTO sys_roles (role_code, role_name, status, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?)`).run(`${username}-${permissionCode.replaceAll(':', '-')}`, `${username} 查看角色`, now, now).lastInsertRowid;
    const menu = db.prepare('SELECT id FROM sys_menus WHERE permission_code = ?').get(permissionCode);
    assert(menu, `缺少 ${permissionCode} 菜单权限种子`);
    db.prepare('INSERT INTO sys_role_menus (role_id, menu_id, created_at) VALUES (?, ?, ?)').run(roleId, menu.id, now);
    db.prepare('INSERT INTO sys_user_roles (user_id, role_id, created_at) VALUES (?, ?, ?)').run(user.id, roleId, now);
  } finally {
    db.close();
  }
}

function multipart(server, pathname, filename, content, token) {
  return new Promise((resolve, reject) => {
    const boundary = `----prediction-${Date.now()}`;
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n`), Buffer.from(content), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: pathname, headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (res) => { const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })); });
    req.on('error', reject); req.end(body);
  });
}

(async () => {
  let server;
  // canonicalBatchId 是训练数据批次，otherBatchId 仅用于 provenance/filter 分离回归。
  let canonicalBatchId;
  let otherBatchId;
  try {
    initDatabase();
    register({ username: 'prediction-reader', password: 'Password123!' });
    register({ username: 'prediction-config-reader', password: 'Password123!' });
    register({ username: 'prediction-run-reader', password: 'Password123!' });
    register({ username: 'prediction-result-reader', password: 'Password123!' });
    grantViewRole('prediction-config-reader', 'prediction:config:view');
    grantViewRole('prediction-run-reader', 'prediction:run:view');
    grantViewRole('prediction-result-reader', 'prediction:result:view');
    const { app } = require('../index');
    server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const adminToken = (await request(server, 'POST', '/api/login', { username: 'admin', password: 'AdminPassword123!' })).body.data.token;
    const readerToken = (await request(server, 'POST', '/api/login', { username: 'prediction-reader', password: 'Password123!' })).body.data.token;
    const configToken = (await request(server, 'POST', '/api/login', { username: 'prediction-config-reader', password: 'Password123!' })).body.data.token;
    const runToken = (await request(server, 'POST', '/api/login', { username: 'prediction-run-reader', password: 'Password123!' })).body.data.token;
    const resultToken = (await request(server, 'POST', '/api/login', { username: 'prediction-result-reader', password: 'Password123!' })).body.data.token;

    assert.strictEqual((await request(server, 'GET', '/api/predictions/configs')).status, 401);
    assert.strictEqual((await request(server, 'GET', '/api/predictions/configs', undefined, readerToken)).status, 403);
    assert.strictEqual((await request(server, 'GET', '/api/predictions/configs', undefined, configToken)).status, 200, '仅配置查看角色必须能读取配置列表。');
    for (const pathname of ['/api/predictions/runs', '/api/predictions/runs/stats', '/api/predictions/results']) {
      assert.strictEqual((await request(server, 'GET', pathname, undefined, configToken)).status, 403, `仅配置查看角色不得读取 ${pathname}。`);
    }
    assert.strictEqual((await request(server, 'GET', '/api/predictions/configs', undefined, runToken)).status, 403, '仅运行查看角色不得读取配置列表。');
    assert.strictEqual((await request(server, 'GET', '/api/predictions/runs', undefined, runToken)).status, 200, '仅运行查看角色必须能读取运行列表。');
    assert.strictEqual((await request(server, 'GET', '/api/predictions/runs/stats', undefined, runToken)).status, 200, '仅运行查看角色必须能读取运行统计。');
    assert.strictEqual((await request(server, 'GET', '/api/predictions/results', undefined, runToken)).status, 403, '仅运行查看角色不得读取预测结果。');
    assert.strictEqual((await request(server, 'GET', '/api/predictions/configs', undefined, resultToken)).status, 403, '仅结果查看角色不得读取配置列表。');
    assert.strictEqual((await request(server, 'GET', '/api/predictions/runs', undefined, resultToken)).status, 403, '仅结果查看角色不得读取运行列表。');
    assert.strictEqual((await request(server, 'GET', '/api/predictions/results', undefined, resultToken)).status, 200, '仅结果查看角色必须能读取预测结果。');
    for (const token of [configToken, runToken, resultToken]) {
      assert.strictEqual((await request(server, 'GET', '/api/predictions/contract', undefined, token)).status, 200, '任一预测查看角色必须能读取通用契约。');
    }
    assert.strictEqual((await request(server, 'GET', '/api/predictions/configs', undefined, adminToken)).status, 200);
    assert.strictEqual((await request(server, 'GET', '/api/templates/prediction-configs.csv')).status, 401);
    assert.strictEqual((await request(server, 'GET', '/api/templates/prediction-configs.csv', undefined, readerToken)).status, 403);
    const predictionTemplate = await request(server, 'GET', '/api/templates/prediction-configs.csv', undefined, adminToken);
    assert.strictEqual(predictionTemplate.status, 200);
    assert(predictionTemplate.body.toString('utf8').startsWith('﻿"配置名称","备注","能源类型编码","用能单元编码","计量器具编码","能耗批次ID","训练开始月份","训练结束月份","预测开始月份","预测结束月份","算法","窗口大小","状态"'), '预测配置模板必须输出 canonical 中文表头。');

    const db = openDatabase();
    try {
      const energyTypeId = db.prepare("SELECT id FROM energy_types WHERE code = 'electricity'").get().id;
      const insertBatch = db.prepare(`INSERT INTO import_batches
        (import_type, original_filename, file_type, status, total_rows, success_count)
        VALUES ('energy_record', ?, 'csv', 'completed', 3, 3)`);
      canonicalBatchId = Number(
        insertBatch.run('prediction-api-training.csv').lastInsertRowid
      );
      otherBatchId = Number(
        insertBatch.run('prediction-api-provenance.csv').lastInsertRowid
      );
      const organizationUnitId = db.prepare(`INSERT INTO organization_units
        (unit_code, unit_name, unit_path, unit_type, status)
        VALUES ('PRED-UNIT', '预测用能单元', '/PRED-UNIT', 'enterprise', 'active')`).run().lastInsertRowid;
      const meterDeviceId = db.prepare(`INSERT INTO meter_devices
        (meter_code, meter_name, meter_type, energy_type_id, organization_unit_id, status)
        VALUES ('PRED-METER', '预测计量器具', 'electricity', ?, ?, 'active')`).run(
        energyTypeId,
        organizationUnitId
      ).lastInsertRowid;
      const insert = db.prepare(`INSERT INTO energy_records
        (source_batch_id, source_row_number, energy_type_id,
          organization_unit_id, meter_device_id, original_month,
          normalized_month, original_unit, original_value, normalized_unit,
          normalized_value, duplicate_key, record_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'kWh', ?, 'kWh', ?, ?, 'active')`);
      [100, 120, 140].forEach((value, index) => insert.run(
        canonicalBatchId,
        index + 2,
        energyTypeId,
        organizationUnitId,
        meterDeviceId,
        `2026-0${index + 1}`,
        `2026-0${index + 1}`,
        value,
        value,
        `prediction-history-${index}`
      ));
    } finally { db.close(); }

    const payload = { name: '关键字预测草稿', note: '可编辑', energyTypeCode: 'electricity', organizationUnitCode: 'PRED-UNIT', meterCode: 'PRED-METER', trainStartMonth: '2026-01', trainEndMonth: '2026-03', predictStartMonth: '2026-04', predictEndMonth: '2026-05', algorithm: 'linear_trend', status: 'draft' };

    // 配置 API 使用 canonical 训练批次字段，旧 sourceBatchId 只作为普通写请求兼容别名。
    for (const invalidCanonicalFilter of [
      { sourceBatchFilterId: 0 },
      { source_batch_filter_id: 0 }
    ]) {
      assert.strictEqual((await request(
        server,
        'POST',
        '/api/predictions/configs',
        { ...payload, ...invalidCanonicalFilter },
        adminToken
      )).status, 400);
    }
    const canonicalCreated = await request(
      server,
      'POST',
      '/api/predictions/configs',
      {
        ...payload,
        name: 'Canonical 批次筛选配置',
        sourceBatchFilterId: canonicalBatchId
      },
      adminToken
    );
    assert.strictEqual(canonicalCreated.status, 201);
    assert.strictEqual(canonicalCreated.body.data.sourceBatchId, null);
    assert.strictEqual(
      canonicalCreated.body.data.sourceBatchFilterId,
      canonicalBatchId
    );
    const canonicalConfigId = canonicalCreated.body.data.id;
    const snakeUpdated = await request(
      server,
      'PUT',
      `/api/predictions/configs/${canonicalConfigId}`,
      { source_batch_filter_id: otherBatchId },
      adminToken
    );
    assert.strictEqual(snakeUpdated.status, 200);
    assert.strictEqual(
      snakeUpdated.body.data.sourceBatchFilterId,
      otherBatchId
    );
    const canonicalRestored = await request(
      server,
      'PUT',
      `/api/predictions/configs/${canonicalConfigId}`,
      { sourceBatchFilterId: canonicalBatchId },
      adminToken
    );
    assert.strictEqual(canonicalRestored.status, 200);
    const canonicalSnakeCreated = await request(
      server,
      'POST',
      '/api/predictions/configs',
      {
        ...payload,
        name: 'Canonical snake 批次筛选配置',
        source_batch_filter_id: canonicalBatchId
      },
      adminToken
    );
    assert.strictEqual(canonicalSnakeCreated.status, 201);
    assert.strictEqual(
      canonicalSnakeCreated.body.data.sourceBatchFilterId,
      canonicalBatchId
    );
    const synonymousAliases = await request(
      server,
      'POST',
      '/api/predictions/configs',
      {
        ...payload,
        name: 'Canonical 同义批次配置',
        sourceBatchFilterId: canonicalBatchId,
        sourceBatchId: canonicalBatchId
      },
      adminToken
    );
    assert.strictEqual(synonymousAliases.status, 201);
    assert.strictEqual(
      synonymousAliases.body.data.sourceBatchFilterId,
      canonicalBatchId
    );
    assert.strictEqual((await request(
      server,
      'POST',
      '/api/predictions/configs',
      {
        ...payload,
        name: 'Canonical 冲突批次配置',
        sourceBatchFilterId: canonicalBatchId,
        sourceBatchId: otherBatchId
      },
      adminToken
    )).status, 400);

    // 完整 GET DTO 中 sourceBatchId 是 provenance，不得覆盖或冲突训练 filter。
    const provenanceDb = openDatabase();
    try {
      provenanceDb.prepare(`UPDATE prediction_configs
        SET source_batch_id = ?, source_row_number = ?
        WHERE id = ?`).run(
        otherBatchId,
        2,
        canonicalConfigId
      );
    } finally {
      provenanceDb.close();
    }
    const canonicalDto = await request(
      server,
      'GET',
      `/api/predictions/configs/${canonicalConfigId}`,
      undefined,
      adminToken
    );
    assert.strictEqual(canonicalDto.status, 200);
    assert.strictEqual(canonicalDto.body.data.sourceBatchId, otherBatchId);
    assert.strictEqual(
      canonicalDto.body.data.sourceBatchFilterId,
      canonicalBatchId
    );
    const canonicalRoundTrip = await request(
      server,
      'PUT',
      `/api/predictions/configs/${canonicalConfigId}`,
      {
        ...canonicalDto.body.data,
        name: 'Canonical DTO 往返配置'
      },
      adminToken
    );
    assert.strictEqual(canonicalRoundTrip.status, 200);
    assert.strictEqual(
      canonicalRoundTrip.body.data.sourceBatchId,
      otherBatchId
    );
    assert.strictEqual(
      canonicalRoundTrip.body.data.sourceBatchFilterId,
      canonicalBatchId
    );
    const canonicalRun = await request(
      server,
      'POST',
      `/api/predictions/configs/${canonicalConfigId}/runs`,
      {},
      adminToken
    );
    assert.strictEqual(canonicalRun.status, 201);
    assert.strictEqual(canonicalRun.body.data.run.status, 'completed');
    assert.strictEqual(
      canonicalRun.body.data.run.parameters.filters.sourceBatchId,
      canonicalBatchId
    );

    assert.strictEqual((await request(server, 'POST', '/api/predictions/configs', {
      ...payload,
      sourceBatchId: 0
    }, adminToken)).status, 400, '配置 API 的 sourceBatchId=0 必须显式拒绝。');
    for (const invalidFilter of [
      { sourceBatchId: 0 },
      { source_batch_id: 0 },
      { organizationUnitId: 0 },
      { meterDeviceId: 0 }
    ]) {
      assert.strictEqual((await request(server, 'POST', '/api/predictions/runs', {
        ...payload,
        ...invalidFilter
      }, adminToken)).status, 400, `运行 API 必须拒绝 0 过滤值：${Object.keys(invalidFilter)[0]}`);
    }
    assert.strictEqual((await request(server, 'POST', '/api/predictions/runs', {
      ...payload,
      sourceBatchId: 1,
      source_batch_id: 2
    }, adminToken)).status, 400, '冲突 source batch 别名必须 fail-closed。');
    assert.strictEqual((await request(server, 'POST', '/api/predictions/runs', {
      ...payload,
      algorithm: 'moving_average',
      windowSize: 0
    }, adminToken)).status, 400, 'windowSize=0 不能套用默认窗口。');
    const created = await request(server, 'POST', '/api/predictions/configs', payload, adminToken);
    assert.strictEqual(created.status, 201);
    const configId = created.body.data.id;
    assert.strictEqual(created.body.data.status, 'draft');
    assert.strictEqual((await request(server, 'GET', `/api/predictions/configs/${configId}`, undefined, configToken)).status, 200, '仅配置查看角色必须能读取配置详情。');
    assert.strictEqual((await request(server, 'GET', `/api/predictions/configs/${configId}`, undefined, runToken)).status, 403, '仅运行查看角色不得读取配置详情。');
    assert.strictEqual((await request(server, 'GET', `/api/predictions/configs/${configId}`, undefined, resultToken)).status, 403, '仅结果查看角色不得读取配置详情。');
    assert.strictEqual((await request(server, 'GET', '/api/predictions/configs?keyword=%E5%85%B3%E9%94%AE%E5%AD%97', undefined, adminToken)).body.meta.pagination.total, 1);
    const run = await request(server, 'POST', `/api/predictions/configs/${configId}/runs`, {}, adminToken);
    assert.strictEqual(run.status, 201);
    assert.strictEqual(run.body.data.run.status, 'completed');
    const runId = run.body.data.run.id;
    assert.strictEqual(run.body.data.summary.resultCount, 2);
    assert.strictEqual((await request(server, 'GET', `/api/predictions/runs/${runId}`, undefined, runToken)).status, 200, '仅运行查看角色必须能读取运行详情。');
    assert.strictEqual((await request(server, 'GET', `/api/predictions/runs/${runId}`, undefined, resultToken)).status, 403, '仅结果查看角色不得读取运行详情。');
    assert.strictEqual((await request(server, 'GET', `/api/predictions/runs/${runId}/results`, undefined, resultToken)).status, 200, '仅结果查看角色必须能读取运行结果。');
    for (const token of [configToken, runToken]) {
      assert.strictEqual((await request(server, 'GET', `/api/predictions/runs/${runId}/results`, undefined, token)).status, 403, '非结果查看角色不得读取运行结果。');
    }
    assert.strictEqual(run.body.data.run.parameters.configSnapshot.configId, configId, '运行必须保存配置快照。');
    const unchanged = await request(server, 'PUT', `/api/predictions/configs/${configId}`, { ...payload, name: '已编辑草稿' }, adminToken);
    assert.strictEqual(unchanged.status, 200);
    assert.strictEqual((await request(server, 'GET', `/api/predictions/runs/${runId}`, undefined, adminToken)).body.data.parameters.configSnapshot.config.name, '关键字预测草稿', '编辑草稿不得篡改已运行快照。');
    const stats = await request(server, 'GET', '/api/predictions/runs/stats?keyword=%E5%85%B3%E9%94%AE%E5%AD%97', undefined, adminToken);
    assert.strictEqual(stats.status, 200);
    assert.strictEqual(stats.body.data.completedCount, 1);
    const exported = await request(server, 'GET', `/api/predictions/results/export?format=csv&runId=${runId}`, undefined, adminToken);
    assert.strictEqual(exported.status, 200);
    assert(exported.body.toString('utf8').startsWith('﻿"预测运行ID","预测运行名称","算法","运行状态","能源类型编码","预测月份","预测值","预测单位","置信区间下限","置信区间上限","方法说明"'), '预测结果导出必须输出中文表头。');
    const configExport = await request(server, 'GET', '/api/predictions/configs/export?format=csv', undefined, adminToken);
    assert.strictEqual(configExport.status, 200);
    assert(configExport.body.toString('utf8').startsWith('﻿"配置名称","备注","能源类型编码","用能单元编码","用能单元名称","计量器具编码","计量器具名称"'), '预测配置导出必须输出 canonical 中文表头。');
    assert.strictEqual((await request(server, 'PATCH', `/api/predictions/runs/${runId}/status`, { status: 'cancelled' }, adminToken)).status, 400, '已完成运行不允许取消或改写结果。');
    assert.strictEqual((await request(server, 'PATCH', `/api/predictions/runs/${runId}/status`, { status: 'archived' }, adminToken)).status, 200);

    const englishCsv = 'name,note,energyTypeCode,organizationUnitCode,meterCode,sourceBatchId,trainStartMonth,trainEndMonth,predictStartMonth,predictEndMonth,algorithm,windowSize,status\n英文表头兼容草稿,兼容性预演,electricity,PRED-UNIT,PRED-METER,,2026-01,2026-03,2026-04,2026-05,moving_average,3,draft\n';
    const englishPreviewResponse = await multipart(server, '/api/predictions/configs/import/preview', 'prediction-configs-english.csv', englishCsv, adminToken);
    assert.strictEqual(englishPreviewResponse.status, 200);
    assert.strictEqual(englishPreviewResponse.body.data.summary.wouldImport, 1, '预测配置导入必须继续兼容旧英文表头。');

    const csv = '配置名称,备注,能源类型编码,用能单元编码,计量器具编码,能耗批次ID,训练开始月份,训练结束月份,预测开始月份,预测结束月份,算法,窗口大小,状态\n导入预测草稿,不能直接产生结果,electricity,PRED-UNIT,PRED-METER,,2026-01,2026-03,2026-04,2026-05,moving_average,3,active\n导入预测草稿,同文件重复应跳过,electricity,PRED-UNIT,PRED-METER,,2026-01,2026-03,2026-04,2026-05,moving_average,3,active\n';
    const previewResponse = await multipart(server, '/api/predictions/configs/import/preview', 'prediction-configs.csv', csv, adminToken);
    assert.strictEqual(previewResponse.status, 200);
    const preview = previewResponse.body.data;
    assert.strictEqual(preview.writesPredictionConfigs, false);
    assert.strictEqual(preview.writesPredictionRuns, false);
    assert.strictEqual(preview.writesPredictionResults, false);
    assert.strictEqual(preview.summary.skipped, 1, '同文件同名配置必须以 skip 警告保留审计。');
    assert.strictEqual(getImportAuditBatchDetail(preview.batchId).importType, 'prediction_config');
    const beforeResults = (await request(server, 'GET', '/api/predictions/results', undefined, adminToken)).body.meta.pagination.total;
    const executed = await request(server, 'POST', '/api/predictions/configs/import/execute', { batchId: preview.batchId, confirmText: preview.confirmText, previewSignature: preview.previewSignature, candidateRowIds: preview.candidateRowIds, candidateRows: preview.candidateRows, requireBackup: true, acknowledgeSkippedRisks: true }, adminToken);
    assert.strictEqual(executed.status, 200);
    assert.strictEqual(executed.body.data.writesPredictionRuns, false);
    assert.strictEqual(executed.body.data.writesPredictionResults, false);
    assert.strictEqual((await request(server, 'GET', '/api/predictions/results', undefined, adminToken)).body.meta.pagination.total, beforeResults, '配置导入不得写结果。');
    const audit = getImportAuditBatchDetail(preview.batchId);
    assert.strictEqual(audit.auditPhase, 'execute');
    assert.strictEqual(audit.status, 'completed_with_errors');
    assert.strictEqual((await request(server, 'POST', '/api/predictions/configs/import/execute', { batchId: preview.batchId, confirmText: '错误', previewSignature: preview.previewSignature, candidateRowIds: preview.candidateRowIds, candidateRows: preview.candidateRows, requireBackup: true, acknowledgeSkippedRisks: true }, adminToken)).status, 400);
    console.log('prediction management API tests passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
