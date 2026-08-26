'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

// 供应商测试只使用系统临时目录和隔离 SQLite，不接触正式 data。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'charcoal-supplier-service-'));
process.env.DATA_DIR = path.join(tempDir, 'data');
process.env.SQLITE_PATH = path.join(process.env.DATA_DIR, 'supplier-service.sqlite');
process.env.UPLOADS_DIR = path.join(tempDir, 'uploads');
process.env.BACKUPS_DIR = path.join(tempDir, 'backups');
process.env.CHARCOAL_ADMIN_PASSWORD = 'SupplierService123!';
process.env.ENERGY_ANALYSIS_IMPORT_HMAC_SECRET = 'supplier-service-test-hmac-secret';

const { initDatabase, openDatabase } = require('../db/database');
const { isSuperAdmin } = require('../services/authService');
const {
  createEnergyAnalysisSingleBatchPreview,
  executeEnergyAnalysisSingleBatchImport
} = require('../services/energyAnalysisSingleBatchImportService');
const { getImportAuditBatchDetail, isGenericDeleteAllowedForImportType } = require('../services/importAuditService');
const {
  SUPPLIER_FIELD_LIMITS,
  SUPPLIER_IMPORT_CONFIRM_TEXT,
  SUPPLIER_IMPORT_DESCRIPTOR,
  SUPPLIER_IMPORT_HEADERS,
  SUPPLIER_IMPORT_RESOURCE_LIMITS,
  createSupplier,
  executeSupplierImport,
  exportSuppliers,
  getSupplierByCode,
  listSuppliers,
  parseSupplierWorkbook,
  previewSupplierImport,
  setSupplierStatus,
  updateSupplier,
  validateSupplierXlsxArchive
} = require('../services/supplierService');
const { getTemplateCsv, getTemplateXlsx } = require('../services/templateService');

/** 将固定表头和数据行写成供应商 XLSX。 */
function writeSupplierWorkbook(storedFilename, rows, mutateWorksheet, extraSheetName = null) {
  const worksheet = XLSX.utils.aoa_to_sheet([SUPPLIER_IMPORT_HEADERS, ...rows]);
  if (typeof mutateWorksheet === 'function') mutateWorksheet(worksheet);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, '供应商');
  if (extraSheetName) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['额外']]), extraSheetName);
  const filePath = path.join(process.env.UPLOADS_DIR, storedFilename);
  XLSX.writeFile(workbook, filePath);
  return {
    originalname: storedFilename,
    filename: storedFilename,
    path: filePath,
    size: fs.statSync(filePath).size
  };
}

/** 复制小型 XLSX 并修改首个中央目录条目或 EOCD 元数据。 */
function mutateSupplierArchive(file, storedFilename, mutateMetadata) {
  const buffer = fs.readFileSync(file.path);
  const mutated = Buffer.from(buffer);
  let endOffset = mutated.length - 22;
  while (endOffset >= 0 && mutated.readUInt32LE(endOffset) !== 0x06054b50) endOffset -= 1;
  assert(endOffset >= 0, '测试 XLSX 必须包含 EOCD。');
  const centralDirectoryOffset = mutated.readUInt32LE(endOffset + 16);
  mutateMetadata(mutated, { endOffset, centralDirectoryOffset });
  const filePath = path.join(process.env.UPLOADS_DIR, storedFilename);
  fs.writeFileSync(filePath, mutated);
  return {
    originalname: storedFilename,
    filename: storedFilename,
    path: filePath,
    size: mutated.length
  };
}

/** 构造共享安全服务所需的最小执行正文。 */
function createExecuteBody(preview, overrides = {}) {
  return {
    batchId: preview.batchId,
    confirmText: SUPPLIER_IMPORT_CONFIRM_TEXT,
    requireBackup: true,
    acknowledgeSkippedRisks: true,
    ...overrides
  };
}

/** 返回不写正式备份文件的安全备份桩。 */
async function createBackupStub({ reason }) {
  return {
    backupName: 'supplier-test-backup.sqlite',
    reason,
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    method: 'test',
    createdAt: new Date().toISOString()
  };
}

/** 断言异步任务失败且没有吞掉异常。 */
async function assertRejects(task, message) {
  let error = null;
  try {
    await task();
  } catch (caught) {
    error = caught;
  }
  assert(error, message);
  return error;
}

(async () => {
  let db = null;
  try {
    initDatabase();
    fs.mkdirSync(process.env.UPLOADS_DIR, { recursive: true });

    // 新库结构、外键策略、RBAC 种子和普通角色最小权限必须同时成立。
    db = openDatabase();
    const supplierColumns = db.prepare("SELECT name, type, [notnull] AS isNotNull FROM pragma_table_info('suppliers')").all();
    assert.strictEqual(supplierColumns.find((column) => column.name === 'contact_phone').type, 'TEXT');
    assert.strictEqual(supplierColumns.find((column) => column.name === 'supplier_code').isNotNull, 1);
    const supplierForeignKey = db.prepare("SELECT * FROM pragma_foreign_key_list('suppliers') WHERE [from] = 'source_batch_id'").get();
    assert.strictEqual(String(supplierForeignKey.on_delete).toUpperCase(), 'SET NULL');
    const supplierPermissions = db.prepare("SELECT permission_code AS permissionCode FROM sys_menus WHERE permission_code LIKE 'ledger:suppliers:%' ORDER BY permission_code").all();
    assert.deepStrictEqual(supplierPermissions.map((row) => row.permissionCode), [
      'ledger:suppliers:create',
      'ledger:suppliers:export',
      'ledger:suppliers:import:execute',
      'ledger:suppliers:import:preview',
      'ledger:suppliers:status',
      'ledger:suppliers:update',
      'ledger:suppliers:view'
    ]);
    const ordinaryGrantCount = db.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus rm
      JOIN sys_roles r ON r.id = rm.role_id JOIN sys_menus m ON m.id = rm.menu_id
      WHERE r.role_code = 'user' AND m.permission_code LIKE 'ledger:suppliers:%'`).get().total;
    assert.strictEqual(ordinaryGrantCount, 0, '普通用户角色不得自动获得供应商权限。');
    const admin = db.prepare("SELECT id FROM sys_users WHERE username = 'admin'").get();
    assert.strictEqual(isSuperAdmin(admin.id), true, '内置管理员必须保留后端超级管理员兜底。');
    const adminSupplierMenuCount = db.prepare(`SELECT COUNT(*) AS total FROM sys_role_menus rm
      JOIN sys_roles r ON r.id = rm.role_id JOIN sys_menus m ON m.id = rm.menu_id
      WHERE r.role_code = 'super_admin' AND m.permission_code LIKE 'ledger:suppliers:%'`).get().total;
    assert.strictEqual(adminSupplierMenuCount, 7, '超级管理员动态菜单关联必须包含七个供应商节点。');
    db.close();

    // 固定模板仅提供 XLSX，联系电话完整支持范围必须预格式为文本且空格式行不产生业务记录。
    const template = getTemplateXlsx('suppliers');
    assert(template?.buffer?.length > 0);
    assert.strictEqual(getTemplateCsv('suppliers'), null);
    const templateWorkbook = XLSX.read(template.buffer, { type: 'buffer', cellNF: true });
    assert.deepStrictEqual(templateWorkbook.SheetNames, ['供应商']);
    const templateSheet = templateWorkbook.Sheets['供应商'];
    assert.deepStrictEqual(
      ['E2', 'E4', 'E2501', `E${SUPPLIER_IMPORT_RESOURCE_LIMITS.maxDataRows + 1}`]
        .map((address) => [templateSheet[address]?.t, templateSheet[address]?.z]),
      [['s', '@'], ['s', '@'], ['s', '@'], ['s', '@']]
    );
    assert.strictEqual(templateSheet.E2.v, '010-01234567');
    assert.strictEqual(templateSheet.E3.v, '+86 138-0000-0000 转 801');
    const templateFilePath = path.join(process.env.UPLOADS_DIR, 'supplier-template.xlsx');
    fs.writeFileSync(templateFilePath, template.buffer);
    const templatePreview = previewSupplierImport({
      originalname: '供应商导入模板.xlsx',
      filename: 'supplier-template.xlsx',
      path: templateFilePath,
      size: template.buffer.length
    }, { uploadsDir: process.env.UPLOADS_DIR, actor: { userId: admin.id } });
    assert.strictEqual(templatePreview.summary.totalRows, 2, '空白文本格式单元格不得解析为业务记录。');

    // CRUD 保留电话文本，普通编辑拒绝 status，状态仅经专用方法流转。
    const created = createSupplier({
      supplierCode: 'SUP-CRUD-001',
      supplierName: '=公式风险供应商',
      contactPhone: '+86 010-0012-0034 转 009',
      status: 'active'
    }, { userId: admin.id, ip: '127.0.0.1' });
    assert.strictEqual(created.contactPhone, '+86 010-0012-0034 转 009');
    assert.throws(
      () => updateSupplier(created.id, { status: 'inactive' }, { userId: admin.id }),
      (error) => error.details?.code === 'SUPPLIER_STATUS_UPDATE_REQUIRES_DEDICATED_ENDPOINT'
    );
    const edited = updateSupplier(created.id, { supplierName: '=公式风险供应商已更新' }, { userId: admin.id });
    assert.strictEqual(edited.status, 'active');
    const inactive = setSupplierStatus(created.id, 'inactive', { userId: admin.id });
    assert.strictEqual(inactive.status, 'inactive');
    const restored = setSupplierStatus(created.id, 'active', { userId: admin.id });
    assert.strictEqual(restored.status, 'active');

    // 显示编码保留清理后的文本，大小写和 NFKC 等价编码必须稳定返回 409，内部空白不折叠。
    const canonicalSupplier = createSupplier({
      supplierCode: '  Sup-Case  ',
      supplierName: '规范编码供应商'
    }, { userId: admin.id });
    assert.strictEqual(canonicalSupplier.supplierCode, 'Sup-Case');
    assert.strictEqual(getSupplierByCode('ＳＵＰ-CASE').id, canonicalSupplier.id, '按编码查询必须复用 NFKC 规范键。');
    ['Sup-Case', 'sup-case', 'ＳＵＰ-CASE'].forEach((supplierCode) => {
      assert.throws(
        () => createSupplier({ supplierCode, supplierName: '冲突供应商' }, { userId: admin.id }),
        (error) => error.statusCode === 409 && error.code === 'SUPPLIER_CODE_CONFLICT'
      );
    });
    const internalWhitespaceSupplier = createSupplier({
      supplierCode: 'Sup -Case',
      supplierName: '内部空白独立供应商'
    }, { userId: admin.id });
    assert.strictEqual(internalWhitespaceSupplier.supplierCode, 'Sup -Case');
    assert.throws(
      () => updateSupplier(internalWhitespaceSupplier.id, { supplierCode: 'ｓｕｐ-case' }, { userId: admin.id }),
      (error) => error.statusCode === 409 && error.code === 'SUPPLIER_CODE_CONFLICT'
    );
    assert.throws(
      () => createSupplier({ supplierCode: 'CLIENT-KEY', supplierCodeKey: 'ATTACKER', supplierName: '客户端键' }, { userId: admin.id }),
      (error) => error.details?.code === 'SUPPLIER_UNKNOWN_FIELDS_REJECTED'
    );

    // 列表和导出关键词必须复用规范键，并把 LIKE 元字符当作普通业务文本。
    ['Sup-Case', 'sup-case', 'ＳＵＰ-CASE'].forEach((keyword) => {
      const result = listSuppliers({ keyword, pageSize: 20 });
      assert.deepStrictEqual(result.rows.map((row) => row.id), [canonicalSupplier.id]);
    });
    assert.deepStrictEqual(
      listSuppliers({ keyword: 'Sup -Case', pageSize: 20 }).rows.map((row) => row.id),
      [internalWhitespaceSupplier.id],
      '内部空白不同的编码必须继续区分。'
    );
    const literalLikeSuppliers = [
      createSupplier({ supplierCode: 'SUP%LITERAL', supplierName: '百分号编码' }, { userId: admin.id }),
      createSupplier({ supplierCode: 'SUP_LI!TERAL', supplierName: '下划线与转义符编码' }, { userId: admin.id })
    ];
    createSupplier({ supplierCode: 'SUPXLITERAL', supplierName: '百分号通配对照' }, { userId: admin.id });
    createSupplier({ supplierCode: 'SUPALI!TERAL', supplierName: '下划线通配对照' }, { userId: admin.id });
    assert.deepStrictEqual(
      listSuppliers({ keyword: 'SUP%LITERAL', pageSize: 20 }).rows.map((row) => row.id),
      [literalLikeSuppliers[0].id]
    );
    assert.deepStrictEqual(
      listSuppliers({ keyword: 'SUP_LI!TERAL', pageSize: 20 }).rows.map((row) => row.id),
      [literalLikeSuppliers[1].id]
    );

    // 导出必须复用相同规范键筛选，并把公式前缀转换为普通文本、保持电话列字符串格式。
    const canonicalExport = exportSuppliers({ keyword: 'ＳＵＰ-CASE' });
    assert.strictEqual(canonicalExport.rowCount, 1);
    const canonicalExportSheet = XLSX.read(canonicalExport.body, { type: 'buffer' }).Sheets['供应商'];
    assert.strictEqual(canonicalExportSheet.A2.v, 'Sup-Case');
    const exported = exportSuppliers({ keyword: 'SUP-CRUD-001' });
    const exportWorkbook = XLSX.read(exported.body, { type: 'buffer' });
    const exportSheet = exportWorkbook.Sheets['供应商'];
    assert.strictEqual(exportSheet.B2.v, "'=公式风险供应商已更新");
    assert.strictEqual(exportSheet.E2.t, 's');
    assert.strictEqual(exportSheet.E2.v, "'+86 010-0012-0034 转 009");

    // 未知状态阻断、公式单元格阻断、同文件重复编码整组阻断、库内已有编码 skip warning。
    db = openDatabase();
    const mixedFile = writeSupplierWorkbook('supplier-mixed.xlsx', [
      ['sup-crud-001', '库内已有', '', '', '001', '', '在库'],
      ['SUP-DUP', '重复一', '', '', '', '', '是'],
      ['ｓｕｐ-dup', '重复二', '', '', '', '', '否'],
      ['SUP-BAD-STATUS', '未知状态', '', '', '', '', '暂停'],
      ['SUP-FORMULA', '公式行', '', '', '', '', '合作中']
    ], (worksheet) => {
      worksheet.B6 = { t: 'n', f: '1+1', v: 2 };
    });
    const mixedPreview = previewSupplierImport(mixedFile, { db, uploadsDir: process.env.UPLOADS_DIR, actor: { userId: admin.id } });
    assert.deepStrictEqual(mixedPreview.summary, { totalRows: 5, wouldImport: 0, skipped: 1, blocked: 4, warnings: 1, errors: 4 });
    assert(mixedPreview.items.filter((item) => [3, 4].includes(item.rowNumber)).every((item) => item.status === 'blocked'));
    assert(mixedPreview.auditIssues.some((issue) => issue.code === 'SUPPLIER_IMPORT_STATUS_UNKNOWN'));
    assert(mixedPreview.auditIssues.some((issue) => issue.code === 'SUPPLIER_IMPORT_FORMULA_CELL_REJECTED'));
    assert.strictEqual(
      db.prepare('SELECT COUNT(*) AS total FROM import_errors WHERE batch_id = ?').get(mixedPreview.batchId).total,
      mixedPreview.auditIssues.length,
      '成功 preview 的批次和问题明细必须一致提交。'
    );
    assert.strictEqual(
      db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE operation = 'supplier.import.preview' AND target_id = ?").get(String(mixedPreview.batchId)).total,
      1,
      '成功 preview 的领域操作审计必须与批次一致提交。'
    );
    const blankStatusFile = writeSupplierWorkbook('supplier-blank-status.xlsx', [
      ['SUP-BLANK-STATUS', '空白状态', '', '', '', '', '']
    ]);
    const blankStatusPreview = previewSupplierImport(blankStatusFile, { db, uploadsDir: process.env.UPLOADS_DIR, actor: { userId: admin.id } });
    assert.strictEqual(blankStatusPreview.summary.blocked, 1);
    assert(blankStatusPreview.auditIssues.some((issue) => issue.code === 'SUPPLIER_IMPORT_STATUS_UNKNOWN' && issue.rawValue === ''));

    // preview 操作审计故障必须回滚批次、问题明细和钩子内已写审计。
    const auditFailureFile = writeSupplierWorkbook('supplier-preview-audit-failure.xlsx', [
      ['SUP-AUDIT-FAIL', '审计故障', '', '', '', '', '未知状态']
    ]);
    const batchCountBeforeAuditFailure = db.prepare('SELECT COUNT(*) AS total FROM import_batches').get().total;
    const issueCountBeforeAuditFailure = db.prepare('SELECT COUNT(*) AS total FROM import_errors').get().total;
    const operationCountBeforeAuditFailure = db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total;
    const auditFailureDescriptor = {
      ...SUPPLIER_IMPORT_DESCRIPTOR,
      persistPreviewAudit(context) {
        SUPPLIER_IMPORT_DESCRIPTOR.persistPreviewAudit(context);
        throw new Error('private supplier preview audit failure');
      }
    };
    assert.throws(
      () => createEnergyAnalysisSingleBatchPreview(auditFailureFile, auditFailureDescriptor, {
        db,
        uploadsDir: process.env.UPLOADS_DIR,
        actor: { userId: admin.id }
      }),
      /private supplier preview audit failure/
    );
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM import_batches').get().total, batchCountBeforeAuditFailure);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM import_errors').get().total, issueCountBeforeAuditFailure);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM sys_operation_logs').get().total, operationCountBeforeAuditFailure);

    // 资源阈值覆盖 5000 行字段合同，同时保持单条 64 MiB、总量 128 MiB 的 ZIP bomb 防线。
    assert.strictEqual(SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes, 64 * 1024 * 1024);
    assert.strictEqual(SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes, 128 * 1024 * 1024);
    assert.strictEqual(SUPPLIER_IMPORT_RESOURCE_LIMITS.maxWorkbookTextCharacters, 10_000_000);
    assert.deepStrictEqual(SUPPLIER_FIELD_LIMITS, {
      supplierCode: 64,
      supplierName: 200,
      address: 500,
      contactPerson: 100,
      contactPhone: 100,
      remarks: 1000
    });

    // 3000 行乘 1000 字中文备注的合法压缩文件必须通过归档校验并成功 preview。
    const largeRemarkRows = Array.from({ length: 3000 }, (_value, index) => {
      const suffix = String(index + 1).padStart(6, '0');
      return [
        `SUP-LARGE-${suffix}`,
        `合法大备注供应商-${suffix}`,
        '',
        '',
        '',
        `${'备'.repeat(SUPPLIER_FIELD_LIMITS.remarks - suffix.length)}${suffix}`,
        '合作中'
      ];
    });
    const largeRemarkFile = writeSupplierWorkbook('supplier-large-remarks.xlsx', largeRemarkRows);
    const largeArchiveSummary = validateSupplierXlsxArchive(fs.readFileSync(largeRemarkFile.path));
    assert(largeArchiveSummary.totalUncompressedBytes > 8 * 1024 * 1024, '探针应证明旧 8 MiB 单条/总量边界不足。');
    const largeRemarkPreview = previewSupplierImport(largeRemarkFile, {
      db,
      uploadsDir: process.env.UPLOADS_DIR,
      actor: { userId: admin.id }
    });
    assert.deepStrictEqual(largeRemarkPreview.summary, {
      totalRows: 3000,
      wouldImport: 3000,
      skipped: 0,
      blocked: 0,
      warnings: 0,
      errors: 0
    });

    // 5000 行代表文件至少通过 ZIP 预检、固定行列和业务文本预算解析。
    const maximumRowFile = writeSupplierWorkbook(
      'supplier-maximum-rows.xlsx',
      Array.from({ length: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxDataRows }, (_value, index) => [
        `SUP-MAX-${String(index + 1).padStart(5, '0')}`,
        `五千行供应商-${index + 1}`,
        '地址',
        '联系人',
        '+001',
        '备注',
        '合作中'
      ])
    );
    const maximumRowBuffer = fs.readFileSync(maximumRowFile.path);
    validateSupplierXlsxArchive(maximumRowBuffer);
    assert.strictEqual(
      parseSupplierWorkbook(maximumRowBuffer, maximumRowFile.originalname).length,
      SUPPLIER_IMPORT_RESOURCE_LIMITS.maxDataRows
    );

    // ZIP 元数据、总文本和工作簿资源超限必须在持久化海量 issue 前以稳定 4xx 错误拒绝。
    const resourceBaseFile = writeSupplierWorkbook('supplier-resource-base.xlsx', [
      ['SUP-RESOURCE', '资源边界', '', '', '+001', '', '合作中']
    ]);
    const overTextBudgetFile = writeSupplierWorkbook(
      'supplier-text-budget.xlsx',
      Array.from({ length: SUPPLIER_IMPORT_RESOURCE_LIMITS.maxDataRows }, (_value, index) => [
        `SUP-TEXT-${index + 1}`,
        '文本预算',
        '',
        '',
        '',
        '超'.repeat(SUPPLIER_FIELD_LIMITS.remarks * 2),
        '合作中'
      ])
    );
    const resourceBatchCount = db.prepare('SELECT COUNT(*) AS total FROM import_batches').get().total;
    const resourceIssueCount = db.prepare('SELECT COUNT(*) AS total FROM import_errors').get().total;
    const resourceCases = [
      [
        mutateSupplierArchive(resourceBaseFile, 'supplier-entry-limit.xlsx', (buffer, { endOffset }) => {
          const exceededCount = SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipEntries + 1;
          buffer.writeUInt16LE(exceededCount, endOffset + 8);
          buffer.writeUInt16LE(exceededCount, endOffset + 10);
        }),
        'SUPPLIER_IMPORT_ZIP_ENTRY_LIMIT_EXCEEDED'
      ],
      [
        mutateSupplierArchive(resourceBaseFile, 'supplier-entry-size.xlsx', (buffer, { centralDirectoryOffset }) => {
          buffer.writeUInt32LE(SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipEntryUncompressedBytes + 1, centralDirectoryOffset + 24);
        }),
        'SUPPLIER_IMPORT_ZIP_ENTRY_SIZE_EXCEEDED'
      ],
      [
        mutateSupplierArchive(resourceBaseFile, 'supplier-total-size.xlsx', (buffer, { centralDirectoryOffset }) => {
          let cursor = centralDirectoryOffset;
          const declaredEntryBytes = Math.floor(
            SUPPLIER_IMPORT_RESOURCE_LIMITS.maxZipTotalUncompressedBytes / 5
          ) + 1;
          for (let index = 0; index < 5; index += 1) {
            buffer.writeUInt32LE(declaredEntryBytes, cursor + 24);
            cursor += 46
              + buffer.readUInt16LE(cursor + 28)
              + buffer.readUInt16LE(cursor + 30)
              + buffer.readUInt16LE(cursor + 32);
          }
        }),
        'SUPPLIER_IMPORT_ZIP_TOTAL_SIZE_EXCEEDED'
      ],
      [
        mutateSupplierArchive(resourceBaseFile, 'supplier-encrypted.xlsx', (buffer, { centralDirectoryOffset }) => {
          buffer.writeUInt16LE(buffer.readUInt16LE(centralDirectoryOffset + 8) | 1, centralDirectoryOffset + 8);
        }),
        'SUPPLIER_IMPORT_ZIP_ENCRYPTED_REJECTED'
      ],
      [
        mutateSupplierArchive(resourceBaseFile, 'supplier-path.xlsx', (buffer, { centralDirectoryOffset }) => {
          buffer.write('../', centralDirectoryOffset + 46, 3, 'ascii');
        }),
        'SUPPLIER_IMPORT_ZIP_ENTRY_PATH_INVALID'
      ],
      [
        mutateSupplierArchive(resourceBaseFile, 'supplier-zip64.xlsx', (buffer, { centralDirectoryOffset }) => {
          buffer.writeUInt32LE(0xffffffff, centralDirectoryOffset + 24);
        }),
        'SUPPLIER_IMPORT_ZIP64_REJECTED'
      ],
      [
        overTextBudgetFile,
        'SUPPLIER_IMPORT_TEXT_BUDGET_EXCEEDED'
      ],
      [
        writeSupplierWorkbook('supplier-extra-sheet.xlsx', [['SUP-SHEET', '额外工作表', '', '', '', '', '合作中']], null, '额外表'),
        'SUPPLIER_IMPORT_SHEET_CONTRACT_INVALID'
      ],
      [
        writeSupplierWorkbook('supplier-row-limit.xlsx', [], (worksheet) => {
          worksheet.A5002 = { t: 's', v: 'SUP-ROW-LIMIT' };
          worksheet['!ref'] = 'A1:G5002';
        }),
        'SUPPLIER_IMPORT_ROW_LIMIT_EXCEEDED'
      ],
      [
        writeSupplierWorkbook('supplier-column-limit.xlsx', [], (worksheet) => {
          worksheet.H1 = { t: 's', v: '越界列' };
          worksheet['!ref'] = 'A1:H1';
        }),
        'SUPPLIER_IMPORT_COLUMN_LIMIT_EXCEEDED'
      ]
    ];
    resourceCases.forEach(([resourceFile, expectedCode]) => {
      assert.throws(
        () => previewSupplierImport(resourceFile, { db, uploadsDir: process.env.UPLOADS_DIR, actor: { userId: admin.id } }),
        (error) => {
          assert.strictEqual(Object.prototype.hasOwnProperty.call(error.details || {}, 'entryName'), false);
          assert.strictEqual(JSON.stringify(error.details || {}).includes(tempDir), false);
          return error instanceof Error
            && error.code === expectedCode
            && error.statusCode >= 400
            && error.statusCode < 500;
        }
      );
    });
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM import_batches').get().total, resourceBatchCount);
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS total FROM import_errors').get().total, resourceIssueCount);

    // 客户端候选、摘要和签名篡改不得通过统一授权，原 preview 仍可用服务端见证正常执行。
    const validFile = writeSupplierWorkbook('supplier-valid.xlsx', [
      ['SUP-IMPORT-001', '安全导入供应商', '', '联系人', '0010 +86-22 转 7', '', '合作中']
    ]);
    const validPreview = previewSupplierImport(validFile, { db, uploadsDir: process.env.UPLOADS_DIR, actor: { userId: admin.id } });
    await assertRejects(() => executeSupplierImport(createExecuteBody(validPreview, {
      candidateRows: [{ candidateRowId: 'attacker', supplierCode: 'ATTACKER' }]
    }), { db, uploadsDir: process.env.UPLOADS_DIR, createBackup: createBackupStub, actor: { userId: admin.id } }), '客户端候选篡改必须失败。');
    const validExecute = await executeSupplierImport(createExecuteBody(validPreview), {
      db,
      uploadsDir: process.env.UPLOADS_DIR,
      createBackup: createBackupStub,
      actor: { userId: admin.id }
    });
    assert.strictEqual(validExecute.imported, 1);
    const imported = db.prepare("SELECT contact_phone AS phone, source_batch_id AS batchId, source_row_number AS rowNumber FROM suppliers WHERE supplier_code = 'SUP-IMPORT-001'").get();
    assert.deepStrictEqual(imported, { phone: '0010 +86-22 转 7', batchId: validPreview.batchId, rowNumber: 2 });

    // 服务端原文件变化和数据库 stale 都必须在写入前拒绝。
    const changedFile = writeSupplierWorkbook('supplier-changed.xlsx', [['SUP-CHANGED', '变化前', '', '', '', '', '合作中']]);
    const changedPreview = previewSupplierImport(changedFile, { db, uploadsDir: process.env.UPLOADS_DIR, actor: { userId: admin.id } });
    fs.appendFileSync(changedFile.path, Buffer.from('changed'));
    await assertRejects(() => executeSupplierImport(createExecuteBody(changedPreview), {
      db, uploadsDir: process.env.UPLOADS_DIR, createBackup: createBackupStub, actor: { userId: admin.id }
    }), '原文件变化必须失败。');
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM suppliers WHERE supplier_code = 'SUP-CHANGED'").get().total, 0);

    const staleFile = writeSupplierWorkbook('supplier-stale.xlsx', [['SUP-STALE', 'stale 候选', '', '', '', '', '合作中']]);
    const stalePreview = previewSupplierImport(staleFile, { db, uploadsDir: process.env.UPLOADS_DIR, actor: { userId: admin.id } });
    db.prepare("INSERT INTO suppliers (supplier_code, supplier_code_key, supplier_name, status) VALUES ('sup-stale', 'SUP-STALE', '并发新增', 'active')").run();
    await assertRejects(() => executeSupplierImport(createExecuteBody(stalePreview), {
      db, uploadsDir: process.env.UPLOADS_DIR, createBackup: createBackupStub, actor: { userId: admin.id }
    }), '数据库 stale 必须失败。');
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM suppliers WHERE supplier_code_key = 'SUP-STALE'").get().total, 1);

    // 备份失败不得写入业务数据，写入阶段异常必须整体回滚。
    const backupFile = writeSupplierWorkbook('supplier-backup-fail.xlsx', [['SUP-BACKUP-FAIL', '备份失败', '', '', '', '', '合作中']]);
    const backupPreview = previewSupplierImport(backupFile, { db, uploadsDir: process.env.UPLOADS_DIR, actor: { userId: admin.id } });
    await assertRejects(() => executeSupplierImport(createExecuteBody(backupPreview), {
      db,
      uploadsDir: process.env.UPLOADS_DIR,
      createBackup: async () => { throw new Error('private backup failure'); },
      actor: { userId: admin.id }
    }), '备份失败必须拒绝。');
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM suppliers WHERE supplier_code = 'SUP-BACKUP-FAIL'").get().total, 0);
    assert.strictEqual(getImportAuditBatchDetail(backupPreview.batchId, { db, includeIssues: false }).status, 'failed');

    const rollbackFile = writeSupplierWorkbook('supplier-rollback.xlsx', [['SUP-ROLLBACK', '事务回滚', '', '', '', '', '合作中']]);
    const rollbackPreview = previewSupplierImport(rollbackFile, { db, uploadsDir: process.env.UPLOADS_DIR, actor: { userId: admin.id } });
    const rollbackDescriptor = {
      ...SUPPLIER_IMPORT_DESCRIPTOR,
      insertCandidates({ db: transactionDb, candidateRows }) {
        const row = candidateRows[0];
        transactionDb.prepare(`INSERT INTO suppliers (supplier_code, supplier_code_key, supplier_name, status) VALUES (?, ?, ?, ?)`)
          .run(row.supplierCode, String(row.supplierCode).toUpperCase(), row.supplierName, row.status);
        throw new Error('private write failure');
      }
    };
    await assertRejects(() => executeEnergyAnalysisSingleBatchImport(createExecuteBody(rollbackPreview), rollbackDescriptor, {
      db, uploadsDir: process.env.UPLOADS_DIR, createBackup: createBackupStub, actor: { userId: admin.id }
    }), '写入异常必须拒绝。');
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS total FROM suppliers WHERE supplier_code = 'SUP-ROLLBACK'").get().total, 0);

    // 通用批次删除必须继续严格拒绝 supplier，业务写入均有操作审计。
    assert.strictEqual(isGenericDeleteAllowedForImportType('supplier'), false);
    assert(db.prepare("SELECT COUNT(*) AS total FROM sys_operation_logs WHERE target_type = 'supplier'").get().total >= 8);
    db.close();

    console.log('供应商服务、迁移、模板和安全导入测试通过。');
  } finally {
    if (db?.open) db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
