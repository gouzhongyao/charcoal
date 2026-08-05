import './styles.css';

const DEFAULT_API_BASE = 'http://127.0.0.1:3002/api';
const API_BASE_STORAGE_KEY = 'charcoal.apiBase';
const ENV_API_BASE = import.meta.env?.VITE_API_BASE_URL || import.meta.env?.VITE_API_BASE || '';

const NAV_ITEMS = [
  { id: 'dashboard', label: '工作台', eyebrow: 'Local workspace', title: '工作台总览' },
  { id: 'imports', label: '数据导入', eyebrow: 'Spreadsheet import', title: '数据导入与批次追溯' },
  { id: 'energy', label: '能耗统计', eyebrow: 'Energy analytics', title: '能耗统计与明细' },
  { id: 'ledger', label: '基础台账', eyebrow: 'Basic ledger', title: '基础台账' },
  { id: 'carbon', label: '碳核算', eyebrow: 'Carbon accounting', title: '碳因子与排放核算' },
  { id: 'predictions', label: '预测管理', eyebrow: 'Lightweight forecast', title: '预测管理' },
  { id: 'system', label: '系统/备份恢复', eyebrow: 'Local backup', title: '系统与备份恢复' }
];

function getUrlApiBase() {
  const params = new URLSearchParams(window.location.search);
  return (params.get('apiBase') || params.get('api_base') || '').trim();
}

function resolveInitialApiBase() {
  const urlApiBase = getUrlApiBase();
  if (urlApiBase) {
    localStorage.setItem(API_BASE_STORAGE_KEY, urlApiBase);
    return urlApiBase;
  }

  const storedApiBase = String(localStorage.getItem(API_BASE_STORAGE_KEY) || '').trim();
  if (storedApiBase) {
    return storedApiBase;
  }

  const envApiBase = String(ENV_API_BASE || '').trim();
  return envApiBase || DEFAULT_API_BASE;
}

const state = {
  apiBase: resolveInitialApiBase(),
  activeView: 'dashboard',
  lastApiState: 'unknown',
  deletingImportBatchId: null,
  importBatchFilters: {},
  backupActionName: null,
  backupActionType: null,
  energyFilters: {},
  energyLedgerBackfillPreview: null,
  energyLedgerBackfillPreviewLoading: false,
  energyLedgerBackfillPreviewError: null,
  energyLedgerBackfillExecuteLoading: false,
  energyLedgerBackfillExecuteResult: null,
  energyLedgerBackfillExecuteError: null,
  ledgerTab: 'units',
  ledgerUnitFilters: {},
  ledgerMeterFilters: {},
  ledgerReadingFilters: {},
  ledgerGenerationFilters: {},
  generationRecordImportPreview: null,
  generationRecordImportPreviewLoading: false,
  generationRecordImportPreviewError: null,
  generationRecordImportExecuteLoading: false,
  generationRecordImportExecuteResult: null,
  generationRecordImportExecuteError: null,
  ledgerProductionUnitFilters: {},
  ledgerProductionOutputFilters: {},
  ledgerProductionIntensityFilters: {},
  productionOutputImportPreview: null,
  productionOutputImportPreviewLoading: false,
  productionOutputImportPreviewError: null,
  productionOutputImportExecuteLoading: false,
  productionOutputImportExecuteResult: null,
  productionOutputImportExecuteError: null,
  meterReadingGenerationPreview: null,
  meterReadingGenerationPreviewLoading: false,
  meterReadingGenerationPreviewError: null,
  meterReadingGenerationExecuteLoading: false,
  meterReadingGenerationExecuteResult: null,
  meterReadingGenerationExecuteError: null,
  ledgerImportResults: {
    units: null,
    meters: null
  },
  carbonFilters: {},
  predictionFilters: {}
};

const app = document.querySelector('#app');

function formatNumber(value, digits = 2) {
  const numericValue = Number(value || 0);
  if (!Number.isFinite(numericValue)) {
    return '-';
  }
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: digits
  }).format(numericValue);
}

function formatText(value, fallback = '-') {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value);
}

function countCjkCharacters(value) {
  return (String(value || '').match(/[㐀-䶿一-鿿豈-﫿]/g) || []).length;
}

function countTextMatches(value, pattern) {
  return (String(value || '').match(pattern) || []).length;
}

function countControlCharacters(value) {
  let count = 0;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31) || (code >= 127 && code <= 159)) {
      count += 1;
    }
  }
  return count;
}

const CP1252_UNICODE_TO_BYTE = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f]
]);

function filenameScore(value) {
  const text = String(value || '');
  return {
    cjk: countCjkCharacters(text),
    replacements: countTextMatches(text, /�/g),
    controls: countControlCharacters(text),
    mojibakeSignals: countTextMatches(text, /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßãâäåæçèéêëìíîïðñòóôõöøùúûüýþÿƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ€]/g)
  };
}

function filenameToBytes(value, mode) {
  const bytes = [];
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index);
    if (code > 0xffff) {
      index += 1;
    }
    if (mode === 'cp1252' && CP1252_UNICODE_TO_BYTE.has(code)) {
      bytes.push(CP1252_UNICODE_TO_BYTE.get(code));
    } else if (code <= 0xff) {
      bytes.push(code);
    } else {
      return null;
    }
  }
  return bytes;
}

function decodeFilenameBytes(value, mode) {
  const bytes = filenameToBytes(value, mode);
  if (!bytes || bytes.length === 0 || typeof TextDecoder === 'undefined') {
    return '';
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch (error) {
    return '';
  }
}

function shouldUseDecodedFilename(original, decoded) {
  if (!decoded || decoded === original) {
    return false;
  }
  const originalScore = filenameScore(original);
  const decodedScore = filenameScore(decoded);
  if (decodedScore.replacements > originalScore.replacements || decodedScore.controls > 0) {
    return false;
  }
  const cjkGain = decodedScore.cjk - originalScore.cjk;
  const mojibakeReduction = originalScore.mojibakeSignals - decodedScore.mojibakeSignals;
  return cjkGain > 0 && (cjkGain >= 2 || mojibakeReduction > 0 || originalScore.controls > decodedScore.controls);
}

function decodePossiblyMojibakeFilename(value) {
  if (value === undefined || value === null || value === '') {
    return value;
  }
  const text = String(value);
  if (/^[\x20-\x7E]*$/.test(text)) {
    return text;
  }
  const originalScore = filenameScore(text);
  if (originalScore.cjk > 0 && originalScore.mojibakeSignals === 0 && originalScore.controls === 0) {
    return text;
  }
  const candidates = [decodeFilenameBytes(text, 'latin1'), decodeFilenameBytes(text, 'cp1252')].filter(Boolean);
  return candidates.reduce((best, candidate) => {
    if (!shouldUseDecodedFilename(text, candidate)) {
      return best;
    }
    const candidateScore = filenameScore(candidate);
    const bestScore = filenameScore(best);
    return candidateScore.cjk > bestScore.cjk || (candidateScore.cjk === bestScore.cjk && candidateScore.mojibakeSignals < bestScore.mojibakeSignals)
      ? candidate
      : best;
  }, text);
}

function getImportDisplayFilename(row = {}) {
  return decodePossiblyMojibakeFilename(row.displayFilename || row.originalFilename || '');
}

function formatMonthRange(range = {}) {
  const start = range.start || range.monthStart;
  const end = range.end || range.monthEnd;
  if (!start && !end) {
    return '暂无月份';
  }
  if (start === end) {
    return start || end;
  }
  return `${start || '未知'} 至 ${end || '未知'}`;
}

function getApiBase() {
  return String(state.apiBase || DEFAULT_API_BASE).trim().replace(/\/+$/, '');
}

function buildApiUrl(path) {
  const normalizedPath = `/${String(path || '').replace(/^\/+/, '')}`;
  const base = getApiBase();
  const apiPath = normalizedPath.startsWith('/api/') || normalizedPath === '/api'
    ? normalizedPath.replace(/^\/api(?=\/|$)/, '') || '/'
    : normalizedPath;

  if (!base) {
    return `/api${apiPath}`;
  }
  if (base.endsWith('/api')) {
    return `${base}${apiPath}`;
  }
  return `${base}/api${apiPath}`;
}

function setApiStatus(kind, text) {
  state.lastApiState = kind;
  const status = document.querySelector('#api-status');
  if (!status) {
    return;
  }
  status.className = `api-status ${kind}`;
  status.textContent = text;
}

function createElement(tagName, options = {}, children = []) {
  const element = document.createElement(tagName);
  Object.entries(options).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }
    if (key === 'className') {
      element.className = value;
      return;
    }
    if (key === 'text') {
      element.textContent = value;
      return;
    }
    if (key === 'html') {
      element.innerHTML = value;
      return;
    }
    if (key === 'dataset') {
      Object.entries(value).forEach(([dataKey, dataValue]) => {
        element.dataset[dataKey] = dataValue;
      });
      return;
    }
    element.setAttribute(key, value);
  });
  children.filter(Boolean).forEach((child) => {
    element.append(child);
  });
  return element;
}

function createSvgElement(tagName, options = {}, children = []) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tagName);
  Object.entries(options).forEach(([key, value]) => {
    if (value === undefined || value === null) {
      return;
    }
    if (key === 'className') {
      element.setAttribute('class', value);
      return;
    }
    if (key === 'text') {
      element.textContent = value;
      return;
    }
    element.setAttribute(key, value);
  });
  children.filter(Boolean).forEach((child) => {
    element.append(child);
  });
  return element;
}

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function getViewRoot() {
  return document.querySelector('#view-root');
}

function renderMessage(type, title, message, actions = []) {
  return createElement('section', { className: `message ${type}` }, [
    createElement('div', { className: 'message-icon', text: type === 'error' ? '!' : type === 'empty' ? 'i' : '✓' }),
    createElement('div', { className: 'message-body' }, [
      createElement('h3', { text: title }),
      createElement('p', { text: message }),
      actions.length > 0 ? createElement('div', { className: 'message-actions' }, actions) : null
    ])
  ]);
}

function renderBackendHint(error) {
  const detail = error ? `接口返回：${error.message || error}` : '无法连接本地 API。';
  return renderMessage(
    'error',
    '本地后端不可用',
    `${detail} 请先安装依赖并启动本地后端，再刷新页面。默认后端地址为 ${DEFAULT_API_BASE}。`,
    [createElement('button', { className: 'btn btn-primary', type: 'button', text: '重新检测', dataset: { action: 'refresh-view' } })]
  );
}

function renderLoading(text = '正在加载本地接口数据...') {
  return createElement('section', { className: 'loading-card' }, [
    createElement('div', { className: 'spinner' }),
    createElement('span', { text })
  ]);
}

function renderCard(title, children = [], className = '') {
  return createElement('article', { className: `card ${className}`.trim() }, [
    createElement('div', { className: 'card-header' }, [
      createElement('h3', { text: title })
    ]),
    ...children
  ]);
}

function renderStat(label, value, note = '', tone = 'blue') {
  return createElement('article', { className: `stat-card ${tone}` }, [
    createElement('span', { className: 'stat-label', text: label }),
    createElement('strong', { className: 'stat-value', text: value }),
    createElement('span', { className: 'stat-note', text: note || '来自本地接口' })
  ]);
}

function renderEmpty(title, message) {
  return renderMessage('empty', title, message);
}

function renderTable(columns, rows, emptyMessage) {
  const wrapper = createElement('div', { className: 'table-wrap' });
  const table = createElement('table');
  const thead = createElement('thead');
  const headRow = createElement('tr');
  columns.forEach((column) => headRow.append(createElement('th', { text: column.label })));
  thead.append(headRow);
  const tbody = createElement('tbody');

  if (!rows || rows.length === 0) {
    const row = createElement('tr');
    row.append(createElement('td', { colspan: String(columns.length), text: emptyMessage || '暂无数据' }));
    tbody.append(row);
  } else {
    rows.forEach((item) => {
      const row = createElement('tr');
      columns.forEach((column) => {
        if (column.render) {
          row.append(createElement('td', {}, [column.render(item)]));
        } else {
          row.append(createElement('td', { text: formatText(item[column.key]) }));
        }
      });
      tbody.append(row);
    });
  }

  table.append(thead, tbody);
  wrapper.append(table);
  return wrapper;
}

async function apiRequest(path, options = {}) {
  const requestOptions = { ...options };
  requestOptions.headers = { ...(options.headers || {}) };

  if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string') {
    requestOptions.body = JSON.stringify(options.body);
    requestOptions.headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(buildApiUrl(path), requestOptions);
  let payload = null;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`接口未返回 JSON：HTTP ${response.status}`);
  }

  if (!response.ok || payload.success === false) {
    const message = payload?.error?.message || `接口请求失败：HTTP ${response.status}`;
    const apiError = new Error(message);
    apiError.details = payload?.error?.details;
    apiError.code = payload?.error?.code;
    throw apiError;
  }

  return payload;
}

function toQuery(params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      search.set(key, String(value).trim());
    }
  });
  const query = search.toString();
  return query ? `?${query}` : '';
}

async function safeApi(path, options = {}) {
  try {
    return { ok: true, value: await apiRequest(path, options) };
  } catch (error) {
    return { ok: false, error };
  }
}

function formatApiError(error) {
  if (!error) {
    return '请求失败，请稍后重试。';
  }
  if (error.code === 'MAINTENANCE_IN_PROGRESS') {
    return '系统正在恢复中，请稍后重试。';
  }
  if (error.code === 'INVALID_BACKUP_FILE') {
    return '备份文件无效/损坏，请重新选择可用备份。';
  }
  return error.message || String(error);
}

function setViewTitle() {
  const item = NAV_ITEMS.find((navItem) => navItem.id === state.activeView) || NAV_ITEMS[0];
  document.querySelector('#page-eyebrow').textContent = item.eyebrow;
  document.querySelector('#page-title').textContent = item.title;
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === state.activeView);
  });
}

function renderShell() {
  clearNode(app);
  app.append(
    createElement('div', { className: 'shell' }, [
      createElement('aside', { className: 'sidebar' }, [
        createElement('div', { className: 'brand' }, [
          createElement('div', { className: 'brand-mark', text: 'C' }),
          createElement('div', {}, [
            createElement('strong', { text: '能碳管理' }),
            createElement('span', { text: '本地轻量化平台' })
          ])
        ]),
        createElement('nav', { className: 'side-nav', 'aria-label': '主导航' }, NAV_ITEMS.map((item) => (
          createElement('button', {
            type: 'button',
            className: item.id === state.activeView ? 'active' : '',
            text: item.label,
            dataset: { view: item.id }
          })
        ))),
        createElement('section', { className: 'sidebar-note' }, [
          createElement('strong', { text: '本地单机边界' }),
          createElement('p', { text: '前端本地运行，接口指向 Node.js + Express，本地 SQLite 文件保存业务数据。' })
        ])
      ]),
      createElement('main', { className: 'main' }, [
        createElement('header', { className: 'topbar' }, [
          createElement('div', {}, [
            createElement('p', { id: 'page-eyebrow', className: 'eyebrow', text: 'Local workspace' }),
            createElement('h1', { id: 'page-title', text: '工作台总览' })
          ]),
          createElement('div', { className: 'api-control' }, [
            createElement('label', { for: 'api-base', text: 'API Base' }),
            createElement('input', { id: 'api-base', value: state.apiBase, spellcheck: 'false' }),
            createElement('button', { type: 'button', className: 'btn btn-ghost', text: '应用', dataset: { action: 'apply-api-base' } }),
            createElement('span', { id: 'api-status', className: 'api-status unknown', text: '后端未检测' })
          ])
        ]),
        createElement('section', { className: 'notice-strip' }, [
          createElement('span', { text: '数据来源：本页只读取当前本地 API 与 SQLite 已导入数据；后端未启动或数据库为空时显示错误/空态，不展示伪数据。' })
        ]),
        createElement('div', { id: 'view-root', className: 'view-root' })
      ])
    ])
  );
  setViewTitle();
}

async function detectApi() {
  setApiStatus('loading', '检测中');
  try {
    const result = await apiRequest('/health');
    setApiStatus(result.data?.status === 'ok' ? 'online' : 'warning', result.data?.status === 'ok' ? '后端可用' : '后端异常');
    return true;
  } catch (error) {
    setApiStatus('offline', '后端未启动');
    return false;
  }
}

function renderKeyValueList(items) {
  return createElement('dl', { className: 'kv-list' }, items.flatMap((item) => [
    createElement('dt', { text: item.label }),
    createElement('dd', { text: item.value })
  ]));
}

const TEMPLATE_FILE_NAMES = {
  'energy-records': '能耗数据导入模板.xlsx',
  'organization-units': '用能单元导入模板.xlsx',
  meters: '计量器具导入模板.xlsx',
  'meter-readings': '计量抄表导入模板.xlsx',
  'generation-records': '发电自用记录导入模板.xlsx',
  'production-outputs': '月度产量导入模板.xlsx',
  'carbon-factors': '碳因子维护模板.xlsx',
  'prediction-history': '预测历史数据模板.xlsx'
};
const IMPORT_ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];
const IMPORT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

function decodeRfc5987Value(value) {
  const encodedValue = String(value || '').replace(/^UTF-8''/i, '');
  try {
    return decodeURIComponent(encodedValue);
  } catch (error) {
    return '';
  }
}

function getFileNameFromContentDisposition(contentDisposition) {
  if (!contentDisposition) {
    return '';
  }
  const encodedMatch = contentDisposition.match(/filename\*\s*=\s*([^;]+)/i);
  if (encodedMatch) {
    const decoded = decodeRfc5987Value(encodedMatch[1].trim().replace(/^"|"$/g, ''));
    if (decoded) {
      return decoded;
    }
  }
  const fallbackMatch = contentDisposition.match(/filename\s*=\s*"?([^";]+)"?/i);
  return fallbackMatch ? fallbackMatch[1].trim() : '';
}

async function downloadTemplateFile(templateType, extension = 'xlsx', fileName) {
  let objectUrl = null;
  const normalizedExtension = String(extension || 'xlsx').replace(/^\./, '') || 'xlsx';
  try {
    const response = await fetch(buildApiUrl(`/templates/${encodeURIComponent(templateType)}.${normalizedExtension}`));
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${errorText ? `：${errorText.slice(0, 120)}` : ''}`);
    }
    const blob = await response.blob();
    if (!blob || blob.size === 0) {
      throw new Error('模板文件为空');
    }

    const headerFileName = getFileNameFromContentDisposition(response.headers.get('content-disposition'));
    const defaultFileName = TEMPLATE_FILE_NAMES[templateType] || `${templateType}.xlsx`;
    const downloadName = headerFileName || fileName || defaultFileName.replace(/\.xlsx$/i, `.${normalizedExtension}`);
    objectUrl = URL.createObjectURL(blob);
    const link = createElement('a', {
      href: objectUrl,
      download: downloadName,
      style: 'display: none;'
    });
    document.body.append(link);
    link.click();
    link.remove();
    setApiStatus('online', '模板下载已触发');
  } catch (error) {
    setApiStatus('offline', '模板下载失败');
    window.alert(`模板下载失败：${error.message || error}\n请确认本地后端已启动，且 API Base 地址正确。当前 API Base：${getApiBase() || DEFAULT_API_BASE}`);
  } finally {
    if (objectUrl) {
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  }
}

async function downloadTemplate(templateType, fileName) {
  await downloadTemplateFile(templateType, 'xlsx', fileName);
}

async function downloadTemplateCsv(templateType, fileName) {
  await downloadTemplateFile(templateType, 'csv', fileName);
}

function createTemplateDownloadButton(templateType, label, fileName) {
  return createElement('button', {
    type: 'button',
    className: 'btn btn-ghost',
    text: label,
    dataset: {
      action: 'download-template',
      templateType,
      fileName: fileName || TEMPLATE_FILE_NAMES[templateType] || `${templateType}.xlsx`
    }
  });
}

function renderTemplateActions(links = []) {
  return createElement('div', { className: 'template-actions' }, links.map((link) => createTemplateDownloadButton(link.type, link.label, link.fileName)));
}

async function downloadBackupFile(backupName) {
  let objectUrl = null;
  try {
    const response = await fetch(buildApiUrl(`/system/backups/${encodeURIComponent(backupName)}/download`));
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${errorText ? `：${errorText.slice(0, 120)}` : ''}`);
    }
    const blob = await response.blob();
    if (!blob || blob.size === 0) {
      throw new Error('备份文件为空');
    }
    objectUrl = URL.createObjectURL(blob);
    const link = createElement('a', {
      href: objectUrl,
      download: backupName,
      style: 'display: none;'
    });
    document.body.append(link);
    link.click();
    link.remove();
    setApiStatus('online', '备份下载已触发');
  } catch (error) {
    setApiStatus('offline', '备份下载失败');
    window.alert(`备份下载失败：${error.message || error}\n请确认本地后端已启动，且 API Base 地址正确。当前 API Base：${getApiBase() || DEFAULT_API_BASE}`);
  } finally {
    if (objectUrl) {
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  }
}

function showBackupOperationResult(type, title, message) {
  const resultBox = getInlineResultBox('#backup-result');
  if (!resultBox) {
    return;
  }
  clearNode(resultBox);
  resultBox.append(renderMessage(type, title, message));
}

function renderBackupActions(row) {
  const isBusy = state.backupActionName === row.backupName;
  const isRestoring = isBusy && state.backupActionType === 'restore';
  const isDeleting = isBusy && state.backupActionType === 'delete';
  return createElement('div', { className: 'table-actions' }, [
    createElement('button', {
      type: 'button',
      className: 'btn btn-small',
      text: '下载',
      disabled: isBusy ? 'disabled' : undefined,
      dataset: { action: 'download-backup', backupName: row.backupName }
    }),
    createElement('button', {
      type: 'button',
      className: 'btn btn-small btn-danger',
      text: isRestoring ? '恢复中...' : '恢复',
      disabled: isBusy ? 'disabled' : undefined,
      dataset: { action: 'restore-backup', backupName: row.backupName }
    }),
    createElement('button', {
      type: 'button',
      className: 'btn btn-small btn-danger',
      text: isDeleting ? '删除中...' : '删除',
      disabled: isBusy ? 'disabled' : undefined,
      dataset: { action: 'delete-backup', backupName: row.backupName }
    })
  ]);
}

function renderBackupsCard(backups) {
  const rows = backups.ok ? backups.value.data : [];
  return renderCard('备份列表', [
    backups.ok ? renderTable([
      { key: 'backupName', label: '备份文件' },
      { key: 'sizeBytes', label: '大小', render: (row) => createElement('span', { text: `${formatNumber(row.sizeBytes / 1024, 1)} KB` }) },
      { key: 'updatedAt', label: '更新时间' },
      { key: 'sha256', label: 'SHA-256', render: (row) => createElement('span', { className: 'filename-text', text: String(row.sha256 || '').slice(0, 16) }) },
      { key: 'actions', label: '操作', render: (row) => renderBackupActions(row) }
    ], rows, '暂无备份。请点击“创建当前数据库备份”。') : renderMessage('error', '备份列表读取失败', backups.error.message),
    createElement('div', { id: 'backup-result', className: 'sub-panel', 'aria-live': 'polite' }, [
      renderMessage('info', '恢复风险提示', '恢复会用所选备份替换当前本地 SQLite 数据库；系统会在恢复前自动创建 pre-restore 备份。请恢复后刷新页面并复核导入批次、能耗记录、碳核算和预测结果。')
    ])
  ]);
}

async function refreshBackups() {
  const section = document.querySelector('#backups-section');
  if (!section) {
    return;
  }
  clearNode(section);
  section.append(renderLoading('正在刷新备份列表...'));
  const backups = await safeApi('/system/backups');
  clearNode(section);
  section.append(renderBackupsCard(backups));
}

async function createSystemBackup() {
  showBackupOperationResult('info', '正在创建备份', '正在对当前本地 SQLite 执行 checkpoint 并创建备份文件...');
  const response = await safeApi('/system/backups', { method: 'POST' });
  if (!response.ok) {
    showBackupOperationResult('error', '备份创建失败', formatApiError(response.error));
    return;
  }
  const backup = response.value.data || {};
  await refreshBackups();
  showBackupOperationResult('success', '备份已创建', `已创建备份 ${backup.backupName}，大小 ${formatNumber(Number(backup.sizeBytes || 0) / 1024, 1)} KB。`);
}

async function restoreSystemBackup(backupName) {
  const confirmed = window.confirm(`确认从备份 ${backupName} 恢复当前本地数据库？\n\n恢复会替换当前 SQLite 数据库内容，恢复前系统会自动创建 pre-restore 备份用于回滚。恢复完成后建议刷新页面并重新检查数据。`);
  if (!confirmed) {
    return;
  }

  state.backupActionName = backupName;
  state.backupActionType = 'restore';
  showBackupOperationResult('info', '正在恢复备份', `正在恢复 ${backupName}；恢复前会自动创建 pre-restore 备份...`);
  await refreshBackups();
  const response = await safeApi(`/system/backups/${encodeURIComponent(backupName)}/restore`, { method: 'POST' });
  state.backupActionName = null;
  state.backupActionType = null;
  if (!response.ok) {
    showBackupOperationResult('error', '备份恢复失败', formatApiError(response.error));
    await refreshBackups();
    return;
  }
  const data = response.value.data || {};
  await refreshBackups();
  showBackupOperationResult('success', '备份恢复完成', `已从 ${data.restoredFrom?.backupName || backupName} 恢复；恢复前自动备份为 ${data.preRestoreBackup?.backupName || 'pre-restore 备份'}。请刷新页面并复核数据。`);
}

async function deleteSystemBackup(backupName) {
  const confirmed = window.confirm(`确认删除备份 ${backupName}？\n\n只删除该备份文件，不影响当前数据库；删除后不能再从该备份恢复。`);
  if (!confirmed) {
    return;
  }

  state.backupActionName = backupName;
  state.backupActionType = 'delete';
  showBackupOperationResult('info', '正在删除备份', `正在删除备份文件 ${backupName}；当前 SQLite 数据库不会受影响...`);
  await refreshBackups();
  const response = await safeApi(`/system/backups/${encodeURIComponent(backupName)}`, { method: 'DELETE' });
  state.backupActionName = null;
  state.backupActionType = null;
  if (!response.ok) {
    showBackupOperationResult('error', '备份删除失败', formatApiError(response.error));
    await refreshBackups();
    return;
  }
  const data = response.value.data || {};
  await refreshBackups();
  showBackupOperationResult('success', '备份已删除', `已删除备份 ${data.deletedBackupName || backupName}，释放 ${formatNumber(Number(data.deletedBytes || 0) / 1024, 1)} KB；当前数据库未受影响。`);
}

async function renderSystem() {
  const root = getViewRoot();
  clearNode(root);
  root.append(renderLoading('正在读取系统信息与备份列表...'));
  const [bootstrap, backups] = await Promise.all([
    safeApi('/bootstrap'),
    safeApi('/system/backups')
  ]);
  clearNode(root);

  root.append(createElement('section', { className: 'grid two' }, [
    renderCard('本地单机边界', [
      renderKeyValueList([
        { label: 'API 地址', value: getApiBase() },
        { label: '数据库文件', value: bootstrap.ok ? bootstrap.value.data?.database?.databasePath : '未读取' },
        { label: '备份目录', value: bootstrap.ok ? bootstrap.value.data?.database?.backupsDir : '未读取' },
        { label: '存储模式', value: bootstrap.ok ? bootstrap.value.data?.database?.storage : 'local-file' }
      ]),
      createElement('p', { className: 'muted', text: '当前备份恢复只针对本机 SQLite 文件，不引入远程存储、云备份或外部服务。' })
    ]),
    renderCard('备份恢复操作', [
      createElement('div', { className: 'template-actions' }, [
        createElement('button', { type: 'button', className: 'btn btn-primary', text: '创建当前数据库备份', dataset: { action: 'create-backup' } })
      ]),
      renderMessage('info', '恢复前确认', '点击“恢复”前请确认目标备份。恢复会替换当前本地数据库；系统会自动创建 pre-restore 备份，但仍建议在重要数据恢复前先下载一份备份文件。')
    ])
  ]));

  if (!bootstrap.ok && !backups.ok) {
    root.append(renderBackendHint(bootstrap.error || backups.error));
    return;
  }

  root.append(createElement('div', { id: 'backups-section' }, [renderBackupsCard(backups)]));
}

async function renderDashboard() {
  const root = getViewRoot();
  clearNode(root);
  root.append(renderLoading('正在读取 health、bootstrap 和 dashboard summary...'));
  const [health, bootstrap, summary] = await Promise.all([
    safeApi('/health'),
    safeApi('/bootstrap'),
    safeApi('/dashboard/summary')
  ]);
  clearNode(root);

  if (!health.ok && !bootstrap.ok && !summary.ok) {
    root.append(renderBackendHint(health.error));
    return;
  }

  if (!summary.ok) {
    root.append(renderMessage('error', '工作台摘要暂不可用', `无法读取 /dashboard/summary：${summary.error.message}。页面保留结构，待后端启动或数据库初始化后重试。`));
  }

  const dashboard = summary.ok ? summary.value.data : null;
  const bootstrapData = bootstrap.ok ? bootstrap.value.data : null;
  const energy = dashboard?.energy || {};
  const imports = dashboard?.imports || {};
  const errors = dashboard?.errors || {};

  root.append(
    createElement('section', { className: 'stat-grid' }, [
      renderStat('后端状态', health.ok ? '可用' : '未连接', health.ok ? 'GET /api/health 正常响应' : '请启动本地后端', health.ok ? 'green' : 'orange'),
      renderStat('能耗记录', formatNumber(energy.activeRecordCount, 0), formatMonthRange(energy.monthRange)),
      renderStat('导入批次', formatNumber(imports.batchCount, 0), `成功 ${formatNumber(imports.completedBatchCount, 0)}，异常 ${formatNumber(imports.failedBatchCount, 0)}`),
      renderStat('导入错误', formatNumber(errors.importErrorCount, 0), `阻断 ${formatNumber(errors.blockingErrorCount, 0)}，警告 ${formatNumber(errors.warningCount, 0)}`)
    ])
  );

  root.append(
    createElement('section', { className: 'grid two' }, [
      renderCard('本地接口与数据库状态', [
        renderKeyValueList([
          { label: 'API 地址', value: getApiBase() },
          { label: '应用名称', value: bootstrapData?.appName || '未读取' },
          { label: '技术栈', value: Array.isArray(bootstrapData?.stack) ? bootstrapData.stack.join(' / ') : '未读取' },
          { label: '数据库', value: bootstrapData?.database?.databasePath || bootstrapData?.database?.path || '待后端返回' }
        ]),
        createElement('p', { className: 'muted', text: '如后端不可用，请先安装依赖并启动本地 Node.js + Express 服务。' })
      ]),
      renderCard('数据范围与说明', [
        renderKeyValueList([
          { label: '摘要范围', value: dashboard?.scope || '未读取' },
          { label: '不包含', value: Array.isArray(dashboard?.excludes) ? dashboard.excludes.join(' / ') : '碳核算与预测不在工作台摘要内伪造' },
          { label: '导入行数', value: `成功 ${formatNumber(imports.importedRowCount, 0)} / 失败 ${formatNumber(imports.failedRowCount, 0)} / 跳过 ${formatNumber(imports.skippedRowCount, 0)}` }
        ]),
        createElement('ul', { className: 'compact-list' }, (dashboard?.notices || ['工作台摘要仅读取本地接口，不展示假数据。']).map((notice) => createElement('li', { text: notice })))
      ])
    ])
  );
}

async function renderImports() {
  const root = getViewRoot();
  clearNode(root);
  root.append(renderLoading('正在读取导入契约与批次列表...'));
  const importBatchQuery = toQuery({ ...state.importBatchFilters, page: 1, pageSize: 20 });
  const [contract, batches] = await Promise.all([
    safeApi('/imports/contract'),
    safeApi(`/imports/batches${importBatchQuery}`)
  ]);
  clearNode(root);

  if (!contract.ok && !batches.ok) {
    root.append(renderCard('Excel 模板下载', [
      renderTemplateActions([
        { type: 'energy-records', label: '下载能耗数据导入模板（Excel）' },
        { type: 'prediction-history', label: '下载预测历史模板（Excel）' }
      ]),
      createElement('p', { className: 'muted', text: '模板入口始终展示；点击后先通过 fetch 获取本地后端 .xlsx 文件，再触发浏览器 blob 下载。若失败，请确认后端已启动且 API Base 正确。' })
    ]));
    root.append(renderBackendHint(contract.error || batches.error));
    return;
  }

  const contractData = contract.ok ? contract.value.data : null;
  root.append(
    createElement('section', { className: 'grid two' }, [
      renderCard('上传表单', [
        renderTemplateActions([
          { type: 'energy-records', label: '下载能耗数据导入模板（Excel）' },
          { type: 'prediction-history', label: '下载预测历史模板（Excel）' }
        ]),
        createElement('p', { className: 'muted', text: '模板由本地后端生成，能耗导入首期字段覆盖 period、energy_type/energy_name、value、unit、organization_unit、site、department、production_line、meter_name、data_time、business_dimension、remark；上传支持 .xlsx / .xls / .csv，默认后端 API Base 保留为 http://127.0.0.1:3002/api。' }),
        createElement('form', { id: 'import-form', className: 'form-card' }, [
          createElement('label', { className: 'field' }, [
            createElement('span', { text: '表格文件（.xlsx / .xls / .csv，最大 10MB）' }),
            createElement('input', { type: 'file', name: 'file', accept: '.xlsx,.xls,.csv' })
          ]),
          createElement('label', { className: 'field' }, [
            createElement('span', { text: '重复策略' }),
            createElement('select', { name: 'duplicateStrategy' }, [
              createElement('option', { value: 'skip', selected: 'selected', text: 'skip：跳过重复数据（当前唯一启用）' })
            ]),
            createElement('small', { text: 'overwrite / append 仍是 future，不在前端启用。' })
          ]),
          createElement('label', { className: 'field' }, [
            createElement('span', { text: '字段映射 JSON（可选）' }),
            createElement('textarea', { name: 'fieldMapping', rows: '6', placeholder: '{\n  "month": "period",\n  "energyType": "energy_type",\n  "value": "value",\n  "unit": "unit",\n  "organization": "organization_unit",\n  "site": "site",\n  "department": "department",\n  "productionLine": "production_line",\n  "meterCode": "meter_name",\n  "businessDimension": "business_dimension"\n}' })
          ]),
          createElement('button', { className: 'btn btn-primary', type: 'submit', text: '提交导入' }),
          createElement('div', { id: 'import-result', className: 'inline-result', 'aria-live': 'polite' })
        ])
      ]),
      renderCard('导入契约', [
        contract.ok ? renderKeyValueList([
          { label: '上传字段', value: contractData.uploadFieldName || 'file' },
          { label: '支持格式', value: (contractData.supportedFileTypes || []).join(' / ') },
          { label: '文件上限', value: contractData.maxUploadFileSize || '10MB' },
          { label: '已启用重复策略', value: (contractData.enabledDuplicateStrategies || ['skip']).join(' / ') }
        ]) : renderMessage('error', '导入契约读取失败', contract.error.message),
        createElement('p', { className: 'muted', text: '错误明细可在批次列表中按批次查看，包含行号、字段、原始值和原因。' }),
        renderTemplateActions([
          { type: 'energy-records', label: '下载能耗模板（Excel）' }
        ])
      ])
    ])
  );

  root.append(createElement('div', { id: 'import-batches-section' }, [
    renderImportBatchesCard(batches)
  ]));
}

function formatImportType(importType) {
  const labels = {
    energy_record: '能耗导入',
    meter_reading: '抄表导入',
    organization_unit: '组织/用能单元导入',
    meter_device: '计量器具导入',
    production_output: '月度产量导入',
    generation_record: '发电记录导入'
  };
  return labels[importType] || labels.energy_record;
}

function isImportAuditBatchType(importType) {
  return importType === 'production_output' || importType === 'generation_record';
}

function renderImportBatchActions(row) {
  const isDeleting = String(state.deletingImportBatchId || '') === String(row.id);
  const filename = getImportDisplayFilename(row);
  const importType = row.importType || 'energy_record';
  const isMeterReadingBatch = importType === 'meter_reading';
  const isAuditBatch = isImportAuditBatchType(importType);
  const deleteDisabledReason = isMeterReadingBatch
    ? '抄表导入批次需保留 source_batch_id 追溯链路，不能通过通用导入批次删除。'
    : isAuditBatch
      ? '月度产量/发电记录审计批次需保留原文件、错误明细和业务记录追溯，当前禁用通用删除。'
      : undefined;
  return createElement('div', { className: 'table-actions' }, [
    createElement('button', { type: 'button', className: 'btn btn-small', text: '查看详情', dataset: { action: 'load-import-batch-detail', batchId: row.id } }),
    createElement('button', { type: 'button', className: 'btn btn-small', text: '查看错误', dataset: { action: 'load-import-errors', batchId: row.id } }),
    createElement('button', { type: 'button', className: 'btn btn-small', text: '下载原文件', dataset: { action: 'download-import-file', batchId: row.id, filename } }),
    createElement('button', {
      type: 'button',
      className: 'btn btn-small btn-danger',
      text: deleteDisabledReason ? '禁止通用删除' : isDeleting ? '删除中...' : '删除',
      title: deleteDisabledReason,
      disabled: isDeleting || Boolean(deleteDisabledReason) ? 'disabled' : undefined,
      dataset: { action: 'delete-import-batch', batchId: row.id, filename, importType }
    })
  ]);
}

function renderImportBatchFilters() {
  const importTypeOptions = [
    { value: '', label: '全部批次类型' },
    { value: 'energy_record', label: '能耗导入' },
    { value: 'meter_reading', label: '抄表导入' },
    { value: 'organization_unit', label: '组织/用能单元导入' },
    { value: 'meter_device', label: '计量器具导入' },
    { value: 'production_output', label: '月度产量导入' },
    { value: 'generation_record', label: '发电记录导入' }
  ];
  const statusOptions = [
    { value: '', label: '全部状态' },
    { value: 'pending', label: 'pending' },
    { value: 'processing', label: 'processing' },
    { value: 'completed', label: 'completed' },
    { value: 'completed_with_errors', label: 'completed_with_errors' },
    { value: 'failed', label: 'failed' },
    { value: 'cancelled', label: 'cancelled' }
  ];
  return createElement('form', { id: 'import-batches-filters', className: 'filter-row' }, [
    createElement('label', { className: 'field compact' }, [
      createElement('span', { text: '批次类型' }),
      createElement('select', { name: 'importType' }, importTypeOptions.map((option) => createElement('option', { value: option.value, selected: state.importBatchFilters.importType === option.value ? 'selected' : undefined, text: option.label })))
    ]),
    createElement('label', { className: 'field compact' }, [
      createElement('span', { text: '状态' }),
      createElement('select', { name: 'status' }, statusOptions.map((option) => createElement('option', { value: option.value, selected: state.importBatchFilters.status === option.value ? 'selected' : undefined, text: option.label })))
    ]),
    createElement('button', { type: 'submit', className: 'btn btn-primary', text: '筛选批次' }),
    createElement('button', { type: 'button', className: 'btn btn-ghost', text: '重置筛选', dataset: { action: 'reset-import-batches-filters' } })
  ]);
}

function renderImportBatchesCard(batches) {
  const rows = batches.ok ? batches.value.data : [];
  return renderCard('导入批次列表', [
    renderImportBatchFilters(),
    createElement('p', { className: 'muted', text: '批次列表支持能耗导入、抄表导入、组织/用能单元导入、计量器具导入、月度产量导入、发电记录导入；月度产量/发电记录批次仅提供追溯查看、错误明细和原文件下载，通用删除保持禁用。' }),
    batches.ok ? renderTable([
      { key: 'id', label: '批次' },
      { key: 'originalFilename', label: '文件名', render: (row) => createElement('span', { className: 'filename-text', text: formatText(getImportDisplayFilename(row)) }) },
      { key: 'importType', label: '批次类型', render: (row) => createElement('span', { text: formatImportType(row.importType) }) },
      { key: 'fileType', label: '文件类型' },
      { key: 'status', label: '状态', render: (row) => renderStatusPill(row.status) },
      { key: 'successCount', label: '成功', render: (row) => createElement('span', { text: formatNumber(row.successCount, 0) }) },
      { key: 'failureCount', label: '失败', render: (row) => createElement('span', { text: formatNumber(row.failureCount, 0) }) },
      { key: 'skippedCount', label: '跳过', render: (row) => createElement('span', { text: formatNumber(row.skippedCount, 0) }) },
      { key: 'createdAt', label: '创建时间' },
      { key: 'actions', label: '操作', render: (row) => renderImportBatchActions(row) }
    ], rows, '暂无导入批次。请先上传表格文件。') : renderMessage('error', '批次列表读取失败', batches.error.message),
    createElement('div', { id: 'import-batch-detail-panel', className: 'sub-panel' }, [
      renderEmpty('批次详情入口', '点击批次列表或领域导入面板中的“查看详情”后，将从 /imports/batches/:batchId 读取批次状态、审计上下文、执行结果、备份摘要、原文件和错误入口。')
    ]),
    createElement('div', { id: 'import-errors-panel', className: 'sub-panel' }, [
      renderEmpty('错误明细入口', '点击“查看错误”后，将从 /imports/batches/:batchId/errors 读取错误/警告行，可用于核对 skipped warning 和 blocked error。')
    ])
  ]);
}

function showImportOperationResult(type, title, message) {
  const resultBox = getInlineResultBox('#import-result');
  if (!resultBox) {
    return;
  }
  clearNode(resultBox);
  resultBox.append(renderMessage(type, title, message));
}

async function refreshDashboardAndEnergyAfterImportChange() {
  if (state.activeView === 'dashboard') {
    await renderDashboard();
  } else if (state.activeView === 'energy') {
    await renderEnergy();
  }
}

async function refreshImportBatches(focusBatchId) {
  const section = document.querySelector('#import-batches-section');
  if (!section) {
    return;
  }
  clearNode(section);
  section.append(renderLoading('正在刷新导入批次列表...'));
  const query = toQuery({ ...state.importBatchFilters, page: 1, pageSize: 20 });
  const batches = await safeApi(`/imports/batches${query}`);
  clearNode(section);
  section.append(renderImportBatchesCard(batches));
  if (focusBatchId) {
    await loadImportErrors(focusBatchId);
  }
}

function renderStatusPill(status) {
  return createElement('span', { className: `pill ${status || 'unknown'}`, text: formatText(status) });
}

function getSubmittedForm(eventOrForm, expectedId) {
  if (!eventOrForm) {
    return null;
  }
  if (typeof HTMLFormElement !== 'undefined' && eventOrForm instanceof HTMLFormElement) {
    return !expectedId || eventOrForm.id === expectedId ? eventOrForm : null;
  }

  const candidates = [eventOrForm.target, eventOrForm.currentTarget];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (typeof HTMLFormElement !== 'undefined' && candidate instanceof HTMLFormElement) {
      if (!expectedId || candidate.id === expectedId) {
        return candidate;
      }
      continue;
    }
    if (typeof candidate.closest === 'function') {
      const form = candidate.closest('form');
      if (form && (!expectedId || form.id === expectedId)) {
        return form;
      }
    }
  }
  return null;
}

function getFormControl(form, name) {
  if (!form || !form.elements || typeof form.elements.namedItem !== 'function') {
    return null;
  }
  return form.elements.namedItem(name);
}

function collectFormValues(form) {
  if (!form) {
    return {};
  }
  const data = new FormData(form);
  const result = {};
  data.forEach((value, key) => {
    if (value instanceof File) {
      return;
    }
    const normalizedValue = String(value).trim();
    if (normalizedValue !== '') {
      result[key] = normalizedValue;
    }
  });
  return result;
}

function getInlineResultBox(selector) {
  const resultBox = document.querySelector(selector);
  if (resultBox) {
    return resultBox;
  }
  const root = getViewRoot();
  if (!root) {
    return null;
  }
  const fallbackBox = createElement('div', {
    className: 'inline-result',
    'aria-live': 'polite'
  });
  root.prepend(fallbackBox);
  return fallbackBox;
}

function renderInlineError(selector, title, message) {
  const resultBox = getInlineResultBox(selector);
  if (!resultBox) {
    return;
  }
  clearNode(resultBox);
  resultBox.append(renderMessage('error', title, message));
}

async function handleImportSubmit(event) {
  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  const form = getSubmittedForm(event, 'import-form');
  const resultBox = getInlineResultBox('#import-result');
  if (!resultBox) {
    return;
  }
  clearNode(resultBox);

  if (!form) {
    resultBox.append(renderMessage('error', '导入表单不存在', '未找到数据导入表单，请刷新页面后重试。'));
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  const originalButtonText = submitButton ? submitButton.textContent : '提交导入';
  const setSubmitting = (submitting) => {
    if (!submitButton) {
      return;
    }
    submitButton.disabled = submitting;
    submitButton.textContent = submitting ? '导入中...' : originalButtonText;
  };

  const fileInput = getFormControl(form, 'file');
  if (!fileInput || !fileInput.files) {
    resultBox.append(renderMessage('error', '文件控件不存在', '未找到名称为 file 的文件上传控件，请刷新数据导入页后重试。'));
    return;
  }
  const file = fileInput.files[0] || null;
  if (!file) {
    resultBox.append(renderMessage('error', '缺少文件', '请选择 .xlsx、.xls 或 .csv 文件后再提交。'));
    return;
  }
  const lowerFileName = String(file.name || '').toLowerCase();
  const matchedExtension = IMPORT_ALLOWED_EXTENSIONS.find((extension) => lowerFileName.endsWith(extension));
  if (!matchedExtension) {
    resultBox.append(renderMessage('error', '文件类型不支持', `当前仅支持 ${IMPORT_ALLOWED_EXTENSIONS.join(' / ')}，请重新选择表格文件。`));
    return;
  }
  if (file.size > IMPORT_MAX_FILE_SIZE_BYTES) {
    resultBox.append(renderMessage('error', '文件过大', '导入文件最大 10MB，请压缩或拆分后重新上传。'));
    return;
  }

  const fieldMappingInput = getFormControl(form, 'fieldMapping');
  const fieldMappingText = String(fieldMappingInput?.value || '').trim();
  if (fieldMappingText) {
    try {
      JSON.parse(fieldMappingText);
    } catch (error) {
      resultBox.append(renderMessage('error', '字段映射 JSON 无效', '请修正字段映射 JSON，或清空后使用自动字段别名识别。'));
      return;
    }
  }

  const body = new FormData();
  body.append('file', file);
  body.append('duplicateStrategy', getFormControl(form, 'duplicateStrategy')?.value || 'skip');
  if (fieldMappingText) {
    body.append('fieldMapping', fieldMappingText);
  }

  setSubmitting(true);
  resultBox.append(renderLoading(`正在上传并导入 ${file.name}...`));
  try {
    const response = await safeApi('/imports/batches', { method: 'POST', body });
    clearNode(resultBox);
    if (!response.ok) {
      const detail = response.error.code ? `错误码：${response.error.code}；${formatApiError(response.error)}` : formatApiError(response.error);
      resultBox.append(renderMessage('error', '导入失败', detail));
      return;
    }

    const batch = response.value.data || {};
    const batchId = batch.id || batch.batchId;
    const status = batch.status || 'unknown';
    const failureCount = Number(batch.failureCount || 0);
    const skippedCount = Number(batch.skippedCount || 0);
    const successCount = Number(batch.successCount || 0);
    const title = status === 'failed'
      ? '导入处理失败'
      : status === 'completed_with_errors'
        ? '导入完成（含错误）'
        : '导入完成';
    const messageType = status === 'failed' ? 'error' : 'success';
    const errorHint = failureCount > 0 || status === 'failed'
      ? '下方已刷新批次列表和该批次错误明细，请按错误原因修正表格后重新导入。'
      : '下方批次列表已刷新，可继续查看批次追溯。';
    const errorSummary = batch.errorSummary ? `错误摘要：${batch.errorSummary}。` : '';
    resultBox.append(renderMessage(
      messageType,
      title,
      `批次 ${formatText(batchId, '未知')} 状态：${status}，成功 ${formatNumber(successCount, 0)}，失败 ${formatNumber(failureCount, 0)}，跳过 ${formatNumber(skippedCount, 0)}。${errorSummary}${errorHint}`
    ));
    if (batchId) {
      await refreshImportBatches(batchId);
    } else {
      await refreshImportBatches();
    }
  } catch (error) {
    clearNode(resultBox);
    resultBox.append(renderMessage('error', '导入异常', error.message || String(error)));
  } finally {
    setSubmitting(false);
  }
}

async function getDownloadFailureMessage(response) {
  const fallback = response.status === 404
    ? '导入批次原始文件不存在或已被移动。'
    : response.status === 400
      ? '导入批次原始文件路径无效，已被安全边界拦截。'
      : `下载请求失败（HTTP ${response.status}）。`;
  try {
    const payload = await response.clone().json();
    return payload?.error?.message || fallback;
  } catch (error) {
    return fallback;
  }
}

async function downloadImportFile(batchId, filename) {
  let objectUrl = null;
  try {
    const response = await fetch(buildApiUrl(`/imports/batches/${encodeURIComponent(batchId)}/download`));
    if (!response.ok) {
      throw new Error(await getDownloadFailureMessage(response));
    }
    const blob = await response.blob();
    if (!blob || blob.size === 0) {
      throw new Error('原始文件为空。');
    }
    const headerFileName = getFileNameFromContentDisposition(response.headers.get('content-disposition'));
    objectUrl = URL.createObjectURL(blob);
    const link = createElement('a', {
      href: objectUrl,
      download: headerFileName || filename || `import-batch-${batchId}`,
      style: 'display: none;'
    });
    document.body.append(link);
    link.click();
    link.remove();
    showImportOperationResult('success', '历史文件下载已触发', `批次 ${batchId} 原始文件下载已触发。`);
  } catch (error) {
    showImportOperationResult('error', '历史文件下载失败', `${error.message || error} 请确认后端已启动，且该批次原始文件仍在本地 uploads 目录；页面不会展示服务端本地路径。`);
  } finally {
    if (objectUrl) {
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
    }
  }
}

async function deleteImportBatch(batchId, filename, importType = 'energy_record') {
  if (importType === 'meter_reading') {
    showImportOperationResult('error', '抄表批次禁止通用删除', '抄表导入批次需保留 meter_reading_records.source_batch_id 追溯链路，请走抄表批次作废/追溯策略；当前通用删除入口不会删除该批次。');
    return;
  }
  if (isImportAuditBatchType(importType)) {
    showImportOperationResult('error', '审计批次禁止通用删除', '月度产量/发电记录审计批次需保留原文件、错误明细和业务记录追溯；当前页面禁用通用删除，不会物理删除业务记录或审计批次。');
    return;
  }
  const confirmed = window.confirm(`确认删除导入批次 ${batchId}${filename ? `（${filename}）` : ''}？\n\n将删除该批次、错误明细、该批次导入的能耗记录，以及这些能耗记录关联的碳排放结果。上传原件不会物理删除；既有预测运行不会自动删除，如需反映最新历史数据请重新创建预测运行。`);
  if (!confirmed) {
    return;
  }

  state.deletingImportBatchId = batchId;
  showImportOperationResult('info', '正在删除导入批次', `正在删除批次 ${batchId} 及其关联错误、能耗记录和碳排放结果...`);
  await refreshImportBatches();
  const response = await safeApi(`/imports/batches/${batchId}`, { method: 'DELETE' });
  state.deletingImportBatchId = null;
  if (!response.ok) {
    showImportOperationResult('error', '导入批次删除失败', formatApiError(response.error));
    await refreshImportBatches();
    return;
  }

  const data = response.value.data || {};
  showImportOperationResult(
    'success',
    '导入批次已删除',
    `批次 ${formatText(data.batchId, batchId)} 已删除；删除能耗记录 ${formatNumber(data.deletedEnergyRecords, 0)} 条、错误明细 ${formatNumber(data.deletedErrors, 0)} 条、碳排放结果 ${formatNumber(data.deletedCarbonEmissions, 0)} 条。上传原件未物理删除；历史数据变化后如需更新预测，请重新创建预测运行。`
  );
  await refreshImportBatches();
  await refreshDashboardAndEnergyAfterImportChange();
}

function formatAuditObjectSummary(value) {
  if (value === undefined || value === null || value === '') {
    return '-';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function getImportAuditPanel(selector, title, message) {
  const existingPanel = document.querySelector(selector);
  if (existingPanel) {
    return existingPanel;
  }
  const root = getViewRoot();
  if (!root) {
    return null;
  }
  const fallbackPanel = createElement('div', {
    id: selector.replace(/^#/, ''),
    className: 'sub-panel import-audit-fallback-panel',
    'aria-live': 'polite'
  }, [
    renderEmpty(title, message)
  ]);
  root.prepend(fallbackPanel);
  return fallbackPanel;
}

async function loadImportBatchDetail(batchId) {
  const panel = getImportAuditPanel(
    '#import-batch-detail-panel',
    '批次详情入口',
    '当前页面未预置数据导入页详情容器，已在本页创建临时批次详情面板；正在读取 /imports/batches/:batchId。'
  );
  if (!panel) {
    return;
  }
  clearNode(panel);
  panel.append(renderLoading(`正在读取批次 ${batchId} 详情...`));
  const response = await safeApi(`/imports/batches/${batchId}`);
  clearNode(panel);
  if (!response.ok) {
    panel.append(renderMessage('error', '批次详情读取失败', formatApiError(response.error)));
    return;
  }
  const detail = response.value.data || {};
  const counts = detail.counts || {};
  const download = detail.download || {};
  panel.append(renderCard(`批次 ${formatText(detail.id, batchId)} 详情`, [
    renderKeyValueList([
      { label: '批次类型', value: detail.importTypeLabel || formatImportType(detail.importType) },
      { label: '原文件', value: detail.displayFilename || detail.originalFilename || '-' },
      { label: '状态', value: detail.status || '-' },
      { label: '审计阶段', value: detail.auditPhase || '-' },
      { label: '持久化状态', value: detail.id ? '已持久化，可追溯批次详情、错误明细和原文件。' : '未返回持久批次。' },
      { label: '行数统计', value: `总行 ${formatNumber(counts.totalRows, 0)}，成功 ${formatNumber(counts.successCount, 0)}，失败 ${formatNumber(counts.failureCount, 0)}，跳过 ${formatNumber(counts.skippedCount, 0)}` },
      { label: '原文件 sha256', value: download.fileSha256 || detail.fileSha256 || '-' },
      { label: '原文件大小', value: download.fileSizeBytes || detail.fileSizeBytes || '-' },
      { label: '错误摘要', value: detail.errorSummary || '-' },
      { label: '备份信息', value: formatAuditObjectSummary(detail.backup) },
      { label: '审计上下文', value: formatAuditObjectSummary(detail.auditContext) },
      { label: '执行结果', value: formatAuditObjectSummary(detail.executeResult) }
    ]),
    createElement('div', { className: 'template-actions' }, [
      createElement('button', { type: 'button', className: 'btn btn-small', text: '查看错误明细', dataset: { action: 'load-import-errors', batchId: detail.id || batchId } }),
      createElement('button', { type: 'button', className: 'btn btn-small', text: '下载原文件', disabled: download.available === false ? 'disabled' : undefined, title: download.available === false ? '该批次没有可下载原文件。' : undefined, dataset: { action: 'download-import-file', batchId: detail.id || batchId, filename: detail.displayFilename || detail.originalFilename || '' } })
    ]),
    Array.isArray(detail.issueSummary) && detail.issueSummary.length > 0 ? renderTable([
      { key: 'severity', label: '级别' },
      { key: 'errorCode', label: '错误码' },
      { key: 'count', label: '数量' },
      { key: 'firstRowNumber', label: '首行' },
      { key: 'sampleMessage', label: '示例说明' }
    ], detail.issueSummary, '暂无错误摘要。') : renderEmpty('错误摘要', '该批次暂无错误/警告摘要。')
  ]));
}

async function loadImportErrors(batchId) {
  const panel = getImportAuditPanel(
    '#import-errors-panel',
    '错误明细入口',
    '当前页面未预置数据导入页错误容器，已在本页创建临时错误明细面板；正在读取 /imports/batches/:batchId/errors。'
  );
  if (!panel) {
    return;
  }
  clearNode(panel);
  panel.append(renderLoading(`正在读取批次 ${batchId} 错误明细...`));
  const response = await safeApi(`/imports/batches/${batchId}/errors?page=1&pageSize=50`);
  clearNode(panel);
  if (!response.ok) {
    panel.append(renderMessage('error', '错误明细读取失败', formatApiError(response.error)));
    return;
  }
  panel.append(renderTable([
    { key: 'rowNumber', label: '行号' },
    { key: 'fieldName', label: '字段' },
    { key: 'rawValue', label: '原始值' },
    { key: 'errorCode', label: '错误码' },
    { key: 'errorReason', label: '原因' },
    { key: 'severity', label: '级别' }
  ], response.value.data, '该批次暂无错误明细。'));
}

function renderFilterRow(kind, fields) {
  return createElement('form', { id: `${kind}-filters`, className: 'filter-row' }, [
    ...fields.map((field) => createElement('label', { className: 'filter-field' }, [
      createElement('span', { text: field.label }),
      field.type === 'select'
        ? createElement('select', { name: field.name }, field.options.map((option) => createElement('option', { value: option.value, text: option.label, selected: String(option.value) === String(field.value) ? 'selected' : undefined })))
        : createElement('input', { type: field.type || 'text', name: field.name, value: field.value || '', placeholder: field.placeholder || '' })
    ])),
    createElement('button', { type: 'submit', className: 'btn btn-primary', text: '应用筛选' }),
    createElement('button', { type: 'button', className: 'btn btn-ghost', text: '重置', dataset: { action: `reset-${kind}-filters` } })
  ]);
}

function aggregateMonthlyTrend(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const current = map.get(row.month) || { month: row.month, value: 0, recordCount: 0 };
    current.value += Number(row.totalNormalizedValue || 0);
    current.recordCount += Number(row.recordCount || 0);
    map.set(row.month, current);
  });
  return Array.from(map.values()).sort((a, b) => a.month.localeCompare(b.month));
}

function renderLineChart(rows, title) {
  if (!rows || rows.length === 0) {
    return renderEmpty('暂无趋势数据', '导入多月份能耗记录后，这里将展示单轴月份趋势。');
  }
  const data = rows.slice(-12);
  const width = 720;
  const height = 240;
  const padding = { top: 24, right: 28, bottom: 44, left: 56 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...data.map((item) => item.value), 1);
  const x = (index) => padding.left + (data.length === 1 ? plotWidth / 2 : (plotWidth * index) / (data.length - 1));
  const y = (value) => padding.top + plotHeight - (Number(value || 0) / maxValue) * plotHeight;
  const points = data.map((item, index) => `${x(index)},${y(item.value)}`).join(' ');
  const svg = createSvgElement('svg', { className: 'line-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title });
  [0, 0.5, 1].forEach((ratio) => {
    const gridY = padding.top + plotHeight * ratio;
    svg.append(createSvgElement('line', { className: 'chart-grid', x1: padding.left, y1: gridY, x2: width - padding.right, y2: gridY }));
    svg.append(createSvgElement('text', { className: 'axis-label', x: 8, y: gridY + 4, text: formatNumber(maxValue * (1 - ratio), 0) }));
  });
  svg.append(createSvgElement('polyline', { className: 'trend-line', points }));
  data.forEach((item, index) => {
    const group = createSvgElement('g', { tabindex: '0', className: 'chart-point' });
    group.append(createSvgElement('circle', { className: 'point-hit', cx: x(index), cy: y(item.value), r: 12 }));
    group.append(createSvgElement('circle', { className: 'point-dot', cx: x(index), cy: y(item.value), r: 4 }));
    group.append(createSvgElement('title', { text: `${item.month}：${formatNumber(item.value)}，记录 ${formatNumber(item.recordCount, 0)} 条` }));
    svg.append(group);
  });
  data.forEach((item, index) => {
    const label = createSvgElement('text', { className: 'axis-label month-label', x: x(index), y: height - 14, text: item.month });
    svg.append(label);
  });
  return createElement('div', { className: 'chart-card' }, [
    svg,
    renderTable([
      { key: 'month', label: '月份' },
      { key: 'value', label: '标准化值合计', render: (row) => createElement('span', { text: formatNumber(row.value) }) },
      { key: 'recordCount', label: '记录数', render: (row) => createElement('span', { text: formatNumber(row.recordCount, 0) }) }
    ], data, '暂无趋势表格数据。')
  ]);
}

function renderBreakdownBars(rows = []) {
  if (!rows || rows.length === 0) {
    return renderEmpty('暂无能源结构数据', '导入能耗记录后，这里将用单色横向条展示不同能源类型的标准化值。');
  }
  const maxValue = Math.max(...rows.map((row) => Number(row.totalNormalizedValue || 0)), 1);
  return createElement('div', { className: 'bar-list' }, rows.slice(0, 8).map((row) => createElement('div', { className: 'bar-row' }, [
    createElement('div', { className: 'bar-label' }, [
      createElement('strong', { text: row.energyTypeName || row.energyTypeCode }),
      createElement('span', { text: `${formatNumber(row.totalNormalizedValue)} ${formatText(row.normalizedUnit, '')}` })
    ]),
    createElement('div', { className: 'bar-track' }, [
      createElement('div', { className: 'bar-fill', style: `width: ${Math.max(4, (Number(row.totalNormalizedValue || 0) / maxValue) * 100)}%` })
    ]),
    createElement('small', { text: `记录 ${formatNumber(row.recordCount, 0)} 条，月份 ${row.monthStart || '-'} 至 ${row.monthEnd || '-'}` })
  ])));
}

async function renderEnergy() {
  const root = getViewRoot();
  clearNode(root);
  root.append(renderLoading('正在读取能耗统计、趋势和明细...'));
  const energyTypes = await safeApi('/energy-types');
  const typeOptions = [{ value: '', label: '全部能源类型' }].concat((energyTypes.ok ? energyTypes.value.data : []).map((item) => ({ value: item.code, label: `${item.name}（${item.code}）` })));
  const query = toQuery({ ...state.energyFilters, page: 1, pageSize: 20 });
  const statQuery = toQuery(state.energyFilters);
  const [summary, trend, breakdown, records] = await Promise.all([
    safeApi(`/energy-records/statistics/summary${statQuery}`),
    safeApi(`/energy-records/statistics/monthly-trend${statQuery}`),
    safeApi(`/energy-records/statistics/energy-type-breakdown${statQuery}`),
    safeApi(`/energy-records${query}`)
  ]);
  clearNode(root);

  const energyTemplateCard = renderCard('能耗数据模板', [
    renderTemplateActions([{ type: 'energy-records', label: '下载能耗数据导入模板（Excel）' }]),
    createElement('p', { className: 'muted', text: '能耗统计数据来自“数据导入”上传的能耗记录；请按 Excel 模板字段填写月份、能源类型、用量、单位和组织地点等维度。后端未启动时按钮仍保持可见；点击后会通过 fetch 获取模板并触发本地 blob 下载，失败时请确认后端已启动且 API Base 正确。' })
  ]);

  if (!summary.ok && !trend.ok && !breakdown.ok && !records.ok) {
    root.append(energyTemplateCard);
    root.append(renderBackendHint(summary.error || records.error));
    return;
  }

  root.append(energyTemplateCard);

  root.append(renderFilterRow('energy', [
    { name: 'normalizedMonthStart', label: '开始月份', type: 'month', value: state.energyFilters.normalizedMonthStart },
    { name: 'normalizedMonthEnd', label: '结束月份', type: 'month', value: state.energyFilters.normalizedMonthEnd },
    { name: 'energyTypeCode', label: '能源类型', type: 'select', value: state.energyFilters.energyTypeCode || '', options: typeOptions },
    { name: 'organization', label: '组织', value: state.energyFilters.organization, placeholder: '可选' }
  ]));
  root.append(renderEnergyLedgerBackfillPreviewCard());

  const summaryData = summary.ok ? summary.value.data : {};
  root.append(createElement('section', { className: 'stat-grid' }, [
    renderStat('记录数', formatNumber(summaryData.recordCount, 0), `批次 ${formatNumber(summaryData.sourceBatchCount, 0)}`),
    renderStat('标准化值合计', formatNumber(summaryData.totalNormalizedValue), '跨能源类型直接汇总仅作摘要'),
    renderStat('能源类型', formatNumber(summaryData.energyTypeCount, 0), `组织 ${formatNumber(summaryData.organizationCount, 0)}`),
    renderStat('月份范围', formatMonthRange(summaryData.monthRange), summaryData.mixedUnitNotice ? '存在跨能源类型口径提示' : '来自能耗明细')
  ]));
  if (summaryData.mixedUnitNotice) {
    root.append(renderMessage('info', '统计口径提示', summaryData.mixedUnitNotice));
  }

  root.append(createElement('section', { className: 'grid two' }, [
    renderCard('月份趋势（单轴、单色聚合）', [
      trend.ok ? renderLineChart(aggregateMonthlyTrend(trend.value.data), '能耗月份趋势') : renderMessage('error', '趋势读取失败', trend.error.message)
    ]),
    renderCard('能源类型结构（单色条形 + 表格）', [
      breakdown.ok ? renderBreakdownBars(breakdown.value.data) : renderMessage('error', '结构读取失败', breakdown.error.message)
    ])
  ]));

  root.append(renderCard('能耗明细表', [
    records.ok ? renderTable([
      { key: 'normalizedMonth', label: '月份' },
      { key: 'energyTypeName', label: '能源类型' },
      { key: 'normalizedValue', label: '标准化值', render: (row) => createElement('span', { text: `${formatNumber(row.normalizedValue)} ${formatText(row.normalizedUnit, '')}` }) },
      { key: 'originalValue', label: '原始值', render: (row) => createElement('span', { text: `${formatNumber(row.originalValue)} ${formatText(row.originalUnit, '')}` }) },
      { key: 'organization', label: '组织' },
      { key: 'site', label: '地点' },
      { key: 'department', label: '部门' },
      { key: 'ledgerAssociationStatus', label: '台账关联', render: renderEnergyLedgerAssociation },
      { key: 'sourceBatchId', label: '来源批次' }
    ], records.value.data, '暂无能耗明细。请先在“数据导入”上传表格。') : renderMessage('error', '明细读取失败', records.error.message)
  ]));
}

function optionList(items, selectedValue = '') {
  return items.map((option) => createElement('option', {
    value: option.value,
    text: option.label,
    selected: String(option.value) === String(selectedValue) ? 'selected' : undefined,
    disabled: option.disabled ? 'disabled' : undefined,
    dataset: option.dataset
  }));
}

function ledgerSelectField(name, label, options = [], value = '', attributes = {}) {
  return createElement('label', { className: 'field' }, [
    createElement('span', { text: label }),
    createElement('select', { ...attributes, name }, optionList(options, value))
  ]);
}

function ledgerInputField(name, label, value = '', type = 'text', placeholder = '', step) {
  return createElement('label', { className: 'field' }, [
    createElement('span', { text: label }),
    createElement('input', { name, type, value: value === null || value === undefined ? '' : String(value), placeholder, step })
  ]);
}

function ledgerTextareaField(name, label, value = '') {
  return createElement('label', { className: 'field' }, [
    createElement('span', { text: label }),
    createElement('textarea', { name, rows: '3' }, [document.createTextNode(value || '')])
  ]);
}

function getLedgerUnitOptions(units = [], includeEmpty = true, emptyLabel = '无父级/请选择') {
  const options = includeEmpty ? [{ value: '', label: emptyLabel }] : [];
  return options.concat(units.map((unit) => ({ value: unit.id, label: `${unit.unitPath || unit.unitName}（${unit.unitCode}）` })));
}

function getEnergyTypeOptions(energyTypes = []) {
  return energyTypes.map((type) => ({ value: type.id, label: `${type.name}（${type.code}）` }));
}

function getDefaultReadingUnitForEnergyType(energyTypeCode) {
  const code = String(energyTypeCode || '').trim();
  if (code === 'heat') return 'MJ';
  if (code === 'coal' || code === 'oil' || code === 'steam') return 't';
  if (code === 'natural_gas' || code === 'water') return 'm3';
  if (code === 'gasoline' || code === 'diesel') return 'L';
  return 'kWh';
}

function getMeterDefaultReadingUnit(meter) {
  return meter?.normalizedUnit || meter?.standardUnit || meter?.defaultUnit || getDefaultReadingUnitForEnergyType(meter?.energyTypeCode);
}

function getLedgerMeterOptions(meters = [], includeEmpty = false, options = {}) {
  const emptyLabel = options.emptyLabel || '全部计量器具';
  const result = includeEmpty ? [{ value: '', label: emptyLabel }] : [];
  return result.concat(meters.map((meter) => ({
    value: meter.id,
    label: `${meter.meterName || meter.meterCode}（${meter.meterCode} / ${meter.energyTypeName || meter.energyTypeCode} / 倍率 ${formatNumber(meter.multiplier, 6)}）`,
    dataset: options.includeReadingDefaults ? {
      multiplier: meter.multiplier ?? 1,
      defaultUnit: getMeterDefaultReadingUnit(meter)
    } : undefined
  })));
}

function renderEnergyLedgerAssociation(row = {}) {
  if (row.ledgerAssociationStatus === 'meter-linked') {
    return createElement('span', { text: `仪表：${formatText(row.meterDeviceName || row.ledgerMeterCode || row.meterCode)}${row.organizationUnitPath ? ` / ${row.organizationUnitPath}` : ''}` });
  }
  if (row.ledgerAssociationStatus === 'organization-linked') {
    return createElement('span', { text: `用能单元：${formatText(row.organizationUnitPath || row.organizationUnitName || row.organizationUnitCode)}` });
  }
  return createElement('span', { className: 'muted', text: '未关联台账' });
}

const LEDGER_BACKFILL_STATUS_LABELS = {
  'already-linked': 'alreadyLinked：已完整关联',
  'already-partial': 'alreadyPartial：已有部分关联',
  'candidate-by-meter': 'wouldUpdate：按计量器具候选',
  'candidate-by-organization': 'wouldUpdate：按用能单元候选',
  ambiguous: 'ambiguous：候选不唯一',
  missing: 'missing：未匹配到台账',
  blocked: 'blocked：规则阻断'
};

function formatLedgerBackfillPreviewStatus(row = {}) {
  if (row.wouldUpdate && !['candidate-by-meter', 'candidate-by-organization'].includes(row.status)) {
    return 'wouldUpdate：可回填候选';
  }
  return LEDGER_BACKFILL_STATUS_LABELS[row.status] || formatText(row.status, '未知状态');
}

function getLedgerBackfillPreviewRecordText(row = {}) {
  const record = row.energyRecord || row.record || row.source || {};
  const id = row.energyRecordId || row.recordId || row.energyRecordID || record.id || row.id;
  const month = row.normalizedMonth || row.month || record.normalizedMonth || record.month;
  const energyType = row.energyTypeName || row.energyTypeCode || record.energyTypeName || record.energyTypeCode;
  const organization = row.organization || record.organization || record.site || record.department;
  const meter = row.meterCode || row.meterName || record.meterCode || record.meterName;
  return [`#${formatText(id)}`, month, energyType, organization, meter].filter(Boolean).join(' / ');
}

function getLedgerBackfillPreviewCandidateText(row = {}) {
  const matched = row.matched || {};
  const meterCandidate = row.meterCandidate || row.candidateMeter || row.matchedMeter || matched.meterDevice || {};
  const organizationCandidate = row.organizationCandidate || row.candidateOrganization || row.matchedOrganization || matched.organizationUnit || {};
  const meterText = row.meterDeviceName || row.ledgerMeterCode || meterCandidate.meterName || meterCandidate.meterCode
    ? `仪表 ${formatText(row.meterDeviceName || meterCandidate.meterName || row.ledgerMeterCode || meterCandidate.meterCode)}`
    : '';
  const unitText = row.organizationUnitPath || row.organizationUnitName || organizationCandidate.unitPath || organizationCandidate.unitName || organizationCandidate.unitCode
    ? `用能单元 ${formatText(row.organizationUnitPath || row.organizationUnitName || organizationCandidate.unitPath || organizationCandidate.unitName || organizationCandidate.unitCode)}`
    : '';
  return [meterText, unitText].filter(Boolean).join('；') || formatText(row.candidateSummary || row.target, '-');
}

function getLedgerBackfillPreviewReasonText(row = {}) {
  const reason = row.reason || row.reasonCode || row.message || row.note || row.blockReason || row.missingReason;
  if (reason) return reason;
  if (Array.isArray(row.reasons) && row.reasons.length > 0) return row.reasons.map((item) => item?.message || item?.code || item).join('；');
  if (Array.isArray(row.candidates)) return `候选数量：${formatNumber(row.candidates.length, 0)}`;
  return row.wouldUpdate ? '预演判断存在可回填候选；当前仅展示，不写入。' : '-';
}

function renderEnergyLedgerBackfillPreviewCard() {
  const preview = state.energyLedgerBackfillPreview;
  const summary = preview?.summary || {};
  const items = Array.isArray(preview?.items) ? preview.items : [];
  const canExecuteBackfill = Boolean(preview?.previewSignature && Number(summary.wouldUpdate || 0) > 0 && Array.isArray(preview?.candidateRecordIds) && preview.candidateRecordIds.length === Number(summary.wouldUpdate || 0));
  const children = [
    renderMessage('info', '台账回填预演 / dry-run', '先调用 GET /api/energy-records/ledger-backfill/preview 做预演；受控执行仅使用最新 preview 的 wouldUpdate 候选，并要求固定确认文本、自动备份、事务执行和 NULL 防覆盖。'),
    renderMessage('warning', '受控执行边界', '执行前会重新计算 preview 并校验 signature、wouldUpdate 数量、candidateRecordIds 和 filters；ambiguous/missing/blocked/alreadyLinked/alreadyPartial 全部跳过；不会删除或新增 energy_records，不会覆盖已有非空台账 ID。'),
    createElement('div', { className: 'template-actions' }, [
      createElement('button', {
        type: 'button',
        className: 'btn btn-primary',
        text: state.energyLedgerBackfillPreviewLoading ? '预演读取中...' : '运行台账回填预演（只读）',
        disabled: state.energyLedgerBackfillPreviewLoading || state.energyLedgerBackfillExecuteLoading ? 'disabled' : undefined,
        dataset: { action: 'run-energy-ledger-backfill-preview' }
      }),
      createElement('button', {
        type: 'button',
        className: 'btn btn-ghost',
        text: '下载预演计划/审计预案',
        disabled: state.energyLedgerBackfillPreviewLoading || state.energyLedgerBackfillExecuteLoading ? 'disabled' : undefined,
        dataset: { action: 'export-energy-ledger-backfill-preview' }
      }),
      createElement('button', {
        type: 'button',
        className: 'btn btn-danger',
        text: state.energyLedgerBackfillExecuteLoading ? '受控执行中...' : '受控执行回填',
        disabled: canExecuteBackfill && !state.energyLedgerBackfillPreviewLoading && !state.energyLedgerBackfillExecuteLoading ? undefined : 'disabled',
        dataset: { action: 'execute-energy-ledger-backfill' }
      })
    ])
  ];

  if (state.energyLedgerBackfillPreviewLoading) {
    children.push(renderLoading('正在读取台账回填预演结果，只读 dry-run 不会写入 energy_records...'));
  }
  if (state.energyLedgerBackfillPreviewError) {
    children.push(renderMessage('error', '台账回填预演读取失败', state.energyLedgerBackfillPreviewError));
  }
  if (state.energyLedgerBackfillExecuteError) {
    children.push(renderMessage('error', '受控执行失败', state.energyLedgerBackfillExecuteError));
  }
  if (state.energyLedgerBackfillExecuteResult) {
    const audit = state.energyLedgerBackfillExecuteResult;
    children.push(renderMessage('success', '受控执行已返回审计摘要', `已更新记录 ${formatNumber(audit.updatedRecords, 0)} 条；写入用能单元 ID ${formatNumber(audit.updatedOrganizationUnitId, 0)} 项，写入计量器具 ID ${formatNumber(audit.updatedMeterDeviceId, 0)} 项；备份 ${formatText(audit.backup?.backupName)}。`));
    children.push(renderKeyValueList([
      { label: 'backupName', value: audit.backup?.backupName || '-' },
      { label: 'previewSignature', value: audit.previewSignature || '-' },
      { label: 'updatedRecords', value: formatNumber(audit.updatedRecords, 0) },
      { label: 'skippedDefensiveNoop', value: formatNumber(audit.skippedDefensiveNoop, 0) },
      { label: 'skippedAmbiguous/Missing/Blocked', value: `${formatNumber(audit.skippedAmbiguous, 0)} / ${formatNumber(audit.skippedMissing, 0)} / ${formatNumber(audit.skippedBlocked, 0)}` },
      { label: 'skippedAlreadyLinked/Partial', value: `${formatNumber(audit.skippedAlreadyLinked, 0)} / ${formatNumber(audit.skippedAlreadyPartial, 0)}` }
    ]));
    children.push(renderTable([
      { key: 'recordId', label: '能耗记录ID' },
      { key: 'status', label: '执行状态', render: (row) => renderStatusPill(row.status) },
      { key: 'before', label: '执行前', render: (row) => createElement('span', { text: `OU ${formatText(row.before?.organizationUnitId)} / Meter ${formatText(row.before?.meterDeviceId)}` }) },
      { key: 'after', label: '执行后', render: (row) => createElement('span', { text: `OU ${formatText(row.after?.organizationUnitId)} / Meter ${formatText(row.after?.meterDeviceId)}` }) },
      { key: 'reason', label: '原因' }
    ], Array.isArray(audit.items) ? audit.items : [], '本次执行未返回逐条审计明细。'));
  }
  if (!preview) {
    children.push(renderMessage('empty', '尚未运行预演', '点击“运行台账回填预演（只读）”后，将按当前能耗筛选条件加 limit/detailLimit 调用 preview 接口，并展示 summary 与明细状态。'));
    return renderCard('历史能耗台账回填预演（只读）', children);
  }

  children.push(renderKeyValueList([
    { label: 'dryRun', value: String(preview.dryRun === true) },
    { label: 'previewOnly', value: String(preview.previewOnly === true) },
    { label: 'writesEnergyRecords', value: String(preview.writesEnergyRecords === true) },
    { label: 'detailLimit', value: formatNumber(preview.detailLimit || items.length, 0) },
    { label: '只读边界', value: preview.writesEnergyRecords === false ? '确认不会写入 energy_records' : '接口未返回 writesEnergyRecords=false，请停止执行并检查后端。' }
  ]));
  if (Array.isArray(preview.notices) && preview.notices.length > 0) {
    children.push(createElement('ul', { className: 'compact-list' }, preview.notices.map((notice) => createElement('li', { text: notice }))));
  }
  children.push(createElement('section', { className: 'stat-grid' }, [
    renderStat('扫描记录', formatNumber(summary.totalScanned, 0), 'totalScanned'),
    renderStat('可回填候选', formatNumber(summary.wouldUpdate, 0), 'wouldUpdate，仅预演不写库', 'green'),
    renderStat('不唯一/缺失', `${formatNumber(summary.ambiguous, 0)} / ${formatNumber(summary.missing, 0)}`, 'ambiguous / missing', 'orange'),
    renderStat('规则阻断', formatNumber(summary.blocked, 0), `已完整 ${formatNumber(summary.alreadyLinked, 0)}，部分 ${formatNumber(summary.alreadyPartial, 0)}`)
  ]));
  children.push(renderTable([
    { key: 'name', label: '统计项' },
    { key: 'value', label: '数量', render: (row) => createElement('span', { text: formatNumber(row.value, 0) }) }
  ], [
    { name: 'totalScanned', value: summary.totalScanned },
    { name: 'alreadyLinked', value: summary.alreadyLinked },
    { name: 'alreadyPartial', value: summary.alreadyPartial },
    { name: 'wouldUpdate', value: summary.wouldUpdate },
    { name: 'candidateByMeter', value: summary.candidateByMeter },
    { name: 'candidateByOrganization', value: summary.candidateByOrganization },
    { name: 'ambiguous', value: summary.ambiguous },
    { name: 'missing', value: summary.missing },
    { name: 'blocked', value: summary.blocked }
  ], '暂无 summary。'));
  children.push(renderTable([
    { key: 'record', label: '能耗记录', render: getLedgerBackfillPreviewRecordText },
    { key: 'status', label: '预演状态', render: (row) => renderStatusPill(row.wouldUpdate ? 'wouldUpdate' : row.status) },
    { key: 'statusText', label: '状态说明', render: (row) => createElement('span', { text: formatLedgerBackfillPreviewStatus(row) }) },
    { key: 'candidate', label: '候选台账', render: (row) => createElement('span', { text: getLedgerBackfillPreviewCandidateText(row) }) },
    { key: 'reason', label: '原因', render: (row) => createElement('span', { text: getLedgerBackfillPreviewReasonText(row) }) }
  ], items, '暂无预演明细；请调整筛选或确认当前记录是否已全部关联。'));
  return renderCard('历史能耗台账回填预演（只读）', children);
}

function renderMeterReadingTrace(row = {}) {
  const trace = row.energyTrace || {};
  if (!trace.relatedEnergyRecordCount) {
    return createElement('span', { className: 'muted', title: trace.note || '', text: '无匹配能耗记录' });
  }
  const latest = trace.latestEnergyRecord || {};
  const latestText = latest.id
    ? `；最近 #${latest.id} ${formatNumber(latest.normalizedValue)} ${formatText(latest.normalizedUnit, '')}`
    : '';
  return createElement('span', {
    title: trace.note || '',
    text: `${trace.label || '疑似关联'}：${formatNumber(trace.relatedEnergyRecordCount, 0)} 条${latestText}`
  });
}

function getMeterReadingGenerationItemText(row = {}) {
  const energyType = row.energyTypeName || row.energyTypeCode;
  return [`#${formatText(row.readingId)}`, row.normalizedMonth, row.meterName || row.meterCode, energyType].filter(Boolean).join(' / ');
}

function getMeterReadingGenerationReasonText(row = {}) {
  if (row.reasonText) return row.reasonText;
  if (Array.isArray(row.reasons) && row.reasons.length > 0) return row.reasons.map((item) => item?.message || item?.code || item).join('；');
  return row.wouldGenerate ? '可受控生成。' : '-';
}

function renderMeterReadingGenerationCard() {
  const preview = state.meterReadingGenerationPreview;
  const summary = preview?.summary || {};
  const items = Array.isArray(preview?.items) ? preview.items : [];
  const canExecute = Boolean(preview?.previewSignature && Number(summary.wouldGenerate || 0) > 0 && Array.isArray(preview?.candidateReadingIds) && preview.candidateReadingIds.length === Number(summary.wouldGenerate || 0));
  const children = [
    renderMessage('info', '抄表生成 energy_records 预演', '先只读预演并下载审计预案；受控生成会写入 active energy_records 并立即纳入能耗统计，碳核算联动后置。'),
    renderMessage('warning', '生成与跳过策略', '固定确认文本：确认由抄表生成能耗记录。同仪表 + 同月份 + 同能源类型已有 active 能耗记录时跳过冲突，不覆盖、不新增、不自动关联；void、已 generated、台账/字段缺失和单位异常均跳过。'),
    createElement('div', { className: 'template-actions' }, [
      createElement('button', {
        type: 'button',
        className: 'btn btn-primary',
        text: state.meterReadingGenerationPreviewLoading ? '生成预演中...' : '生成预演（只读）',
        disabled: state.meterReadingGenerationPreviewLoading || state.meterReadingGenerationExecuteLoading ? 'disabled' : undefined,
        dataset: { action: 'run-meter-reading-generation-preview' }
      }),
      createElement('button', {
        type: 'button',
        className: 'btn btn-ghost',
        text: '下载审计预案',
        disabled: state.meterReadingGenerationPreviewLoading || state.meterReadingGenerationExecuteLoading ? 'disabled' : undefined,
        dataset: { action: 'export-meter-reading-generation-preview' }
      }),
      createElement('button', {
        type: 'button',
        className: 'btn btn-danger',
        text: state.meterReadingGenerationExecuteLoading ? '受控生成中...' : '受控生成能耗记录',
        disabled: canExecute && !state.meterReadingGenerationPreviewLoading && !state.meterReadingGenerationExecuteLoading ? undefined : 'disabled',
        dataset: { action: 'execute-meter-reading-generation' }
      })
    ])
  ];
  if (state.meterReadingGenerationPreviewLoading) {
    children.push(renderLoading('正在只读预演抄表生成 energy_records 候选...'));
  }
  if (state.meterReadingGenerationPreviewError) {
    children.push(renderMessage('error', '抄表生成预演失败', state.meterReadingGenerationPreviewError));
  }
  if (state.meterReadingGenerationExecuteError) {
    children.push(renderMessage('error', '受控生成失败', state.meterReadingGenerationExecuteError));
  }
  if (state.meterReadingGenerationExecuteResult) {
    const audit = state.meterReadingGenerationExecuteResult;
    children.push(renderMessage('success', '受控生成已返回审计摘要', `已生成 ${formatNumber(audit.generated, 0)} 条 active energy_records，回写抄表记录 ${formatNumber(audit.updatedReadings, 0)} 条，跳过 ${formatNumber(audit.skipped, 0)} 条；备份 ${formatText(audit.backup?.backupName)}。`));
    children.push(renderKeyValueList([
      { label: 'backupName', value: audit.backup?.backupName || '-' },
      { label: 'previewSignature', value: audit.previewSignature || '-' },
      { label: 'generated', value: formatNumber(audit.generated, 0) },
      { label: 'updatedReadings', value: formatNumber(audit.updatedReadings, 0) },
      { label: 'skippedConflict/Void/Already', value: `${formatNumber(audit.skippedConflict, 0)} / ${formatNumber(audit.skippedVoid, 0)} / ${formatNumber(audit.skippedAlreadyGenerated, 0)}` },
      { label: 'skippedMissing/Invalid/Blocked', value: `${formatNumber(audit.skippedMissingLedger, 0)} / ${formatNumber(audit.skippedInvalidUnit, 0)} / ${formatNumber(audit.skippedBlocked, 0)}` }
    ]));
    children.push(renderTable([
      { key: 'readingId', label: '抄表ID' },
      { key: 'energyRecordId', label: '能耗记录ID' },
      { key: 'status', label: '执行状态', render: (row) => renderStatusPill(row.status) },
      { key: 'previewStatus', label: '预演状态', render: (row) => renderStatusPill(row.previewStatus) },
      { key: 'reason', label: '原因' }
    ], Array.isArray(audit.items) ? audit.items : [], '本次执行未返回逐条审计明细。'));
  }
  if (!preview) {
    children.push(renderMessage('empty', '尚未运行生成预演', '点击“生成预演（只读）”后，将按当前计量抄表筛选调用 preview 接口，并展示 wouldGenerate、冲突和跳过明细。'));
    return renderCard('抄表生成能耗记录（预演 + 受控生成）', children);
  }
  children.push(renderKeyValueList([
    { label: 'dryRun', value: String(preview.dryRun === true) },
    { label: 'previewOnly', value: String(preview.previewOnly === true) },
    { label: 'writesEnergyRecords', value: String(preview.writesEnergyRecords === true) },
    { label: 'carbonAccountingDeferred', value: String(preview.carbonAccountingDeferred === true) },
    { label: 'fixedConfirmText', value: preview.confirmText || '确认由抄表生成能耗记录' },
    { label: 'previewSignature', value: preview.previewSignature || '-' }
  ]));
  if (Array.isArray(preview.notices) && preview.notices.length > 0) {
    children.push(createElement('ul', { className: 'compact-list' }, preview.notices.map((notice) => createElement('li', { text: notice }))));
  }
  children.push(createElement('section', { className: 'stat-grid' }, [
    renderStat('扫描抄表', formatNumber(summary.totalScanned, 0), 'totalScanned'),
    renderStat('可生成', formatNumber(summary.wouldGenerate, 0), 'wouldGenerate', 'green'),
    renderStat('冲突/已生成', `${formatNumber(summary.conflict, 0)} / ${formatNumber(summary.alreadyGenerated, 0)}`, 'conflict / alreadyGenerated', 'orange'),
    renderStat('作废/缺失/阻断', `${formatNumber(summary.void, 0)} / ${formatNumber(summary.missingLedger, 0)} / ${formatNumber(summary.blocked, 0)}`)
  ]));
  children.push(renderTable([
    { key: 'reading', label: '抄表记录', render: getMeterReadingGenerationItemText },
    { key: 'status', label: '预演状态', render: (row) => renderStatusPill(row.wouldGenerate ? 'wouldGenerate' : row.status) },
    { key: 'usage', label: '标准化用量', render: (row) => createElement('span', { text: `${formatNumber(row.normalizedUsageValue, 6)} ${formatText(row.normalizedUnit, '')}` }) },
    { key: 'conflictEnergyRecordId', label: '冲突能耗ID', render: (row) => createElement('span', { text: formatText(row.conflictEnergyRecordId) }) },
    { key: 'reason', label: '原因', render: (row) => createElement('span', { text: getMeterReadingGenerationReasonText(row) }) }
  ], items, '暂无预演明细；请调整计量抄表筛选。'));
  return renderCard('抄表生成能耗记录（预演 + 受控生成）', children);
}

function findById(rows = [], id) {
  return rows.find((row) => String(row.id) === String(id)) || null;
}

function renderLedgerTabs() {
  return createElement('div', { className: 'ledger-tabs' }, [
    createElement('button', { type: 'button', className: `btn ${state.ledgerTab === 'units' ? 'btn-primary' : 'btn-ghost'}`, text: '用能单元', dataset: { action: 'switch-ledger-tab', tab: 'units' } }),
    createElement('button', { type: 'button', className: `btn ${state.ledgerTab === 'meters' ? 'btn-primary' : 'btn-ghost'}`, text: '计量器具', dataset: { action: 'switch-ledger-tab', tab: 'meters' } }),
    createElement('button', { type: 'button', className: `btn ${state.ledgerTab === 'readings' ? 'btn-primary' : 'btn-ghost'}`, text: '计量抄表', dataset: { action: 'switch-ledger-tab', tab: 'readings' } }),
    createElement('button', { type: 'button', className: `btn ${state.ledgerTab === 'generation' ? 'btn-primary' : 'btn-ghost'}`, text: '发电自用', dataset: { action: 'switch-ledger-tab', tab: 'generation' } }),
    createElement('button', { type: 'button', className: `btn ${state.ledgerTab === 'production' ? 'btn-primary' : 'btn-ghost'}`, text: '产能单元', dataset: { action: 'switch-ledger-tab', tab: 'production' } })
  ]);
}

function renderUnitForm(units = [], editingUnit = null) {
  const unitTypeOptions = [
    { value: 'enterprise', label: 'enterprise：企业' },
    { value: 'department', label: 'department：部门' },
    { value: 'workshop', label: 'workshop：车间' },
    { value: 'process', label: 'process：工序' },
    { value: 'equipment', label: 'equipment：设备' }
  ];
  const statusOptions = [
    { value: 'active', label: 'active：启用' },
    { value: 'inactive', label: 'inactive：停用' }
  ];
  const candidateParents = units.filter((unit) => !editingUnit || String(unit.id) !== String(editingUnit.id));
  return renderCard(editingUnit ? '编辑用能单元' : '新增用能单元', [
    createElement('form', { id: 'ledger-unit-form', className: 'form-card' }, [
      editingUnit ? createElement('input', { type: 'hidden', name: 'id', value: editingUnit.id }) : null,
      createElement('div', { className: 'form-grid' }, [
        ledgerSelectField('parentId', '父级', getLedgerUnitOptions(candidateParents), editingUnit?.parentId || ''),
        ledgerInputField('unitCode', '编码', editingUnit?.unitCode || '', 'text', 'OU-001'),
        ledgerInputField('unitName', '名称', editingUnit?.unitName || '', 'text', '一车间'),
        ledgerSelectField('unitType', '类型', unitTypeOptions, editingUnit?.unitType || 'department'),
        ledgerInputField('area', '面积（可选）', editingUnit?.area || '', 'number', '1000', '0.01'),
        ledgerInputField('sortOrder', '排序', editingUnit?.sortOrder ?? '0', 'number', '0', '1'),
        ledgerSelectField('status', '状态', statusOptions, editingUnit?.status || 'active')
      ]),
      ledgerTextareaField('remark', '备注', editingUnit?.remark || ''),
      createElement('div', { className: 'template-actions' }, [
        createElement('button', { type: 'submit', className: 'btn btn-primary', text: editingUnit ? '保存用能单元' : '新增用能单元' }),
        editingUnit ? createElement('button', { type: 'button', className: 'btn btn-ghost', text: '取消编辑', dataset: { action: 'cancel-ledger-edit' } }) : null
      ]),
      createElement('div', { id: 'ledger-unit-result', className: 'inline-result', 'aria-live': 'polite' })
    ])
  ]);
}

function renderMeterForm(units = [], energyTypes = [], editingMeter = null) {
  const meterTypeOptions = [
    { value: 'electricity', label: 'electricity：电表' },
    { value: 'gas', label: 'gas：气表' },
    { value: 'heat', label: 'heat：热量表' },
    { value: 'water', label: 'water：水表' },
    { value: 'other', label: 'other：其他' }
  ];
  const onlineStatusOptions = [
    { value: 'unknown', label: 'unknown：未知' },
    { value: 'online', label: 'online：在线' },
    { value: 'offline', label: 'offline：离线' }
  ];
  const flowOptions = [
    { value: 'unknown', label: 'unknown：未指定' },
    { value: 'input', label: 'input：输入' },
    { value: 'output', label: 'output：输出' },
    { value: 'bidirectional', label: 'bidirectional：双向' }
  ];
  const statusOptions = [
    { value: 'active', label: 'active：启用' },
    { value: 'inactive', label: 'inactive：停用' }
  ];
  return renderCard(editingMeter ? '编辑计量器具' : '新增计量器具', [
    createElement('form', { id: 'ledger-meter-form', className: 'form-card' }, [
      editingMeter ? createElement('input', { type: 'hidden', name: 'id', value: editingMeter.id }) : null,
      createElement('div', { className: 'form-grid' }, [
        ledgerInputField('meterCode', '仪表编码', editingMeter?.meterCode || '', 'text', 'M-001'),
        ledgerInputField('meterName', '仪表名称', editingMeter?.meterName || '', 'text', '一车间电表'),
        ledgerSelectField('meterType', '仪表类型', meterTypeOptions, editingMeter?.meterType || 'other'),
        ledgerSelectField('energyTypeId', '能源类型', getEnergyTypeOptions(energyTypes), editingMeter?.energyTypeId || energyTypes[0]?.id || ''),
        ledgerSelectField('organizationUnitId', '所属用能单元', getLedgerUnitOptions(units.filter((unit) => unit.status === 'active'), false), editingMeter?.organizationUnitId || ''),
        ledgerSelectField('onlineStatus', '在线状态', onlineStatusOptions, editingMeter?.onlineStatus || 'unknown'),
        ledgerInputField('gatewayId', '网关 ID', editingMeter?.gatewayId || '', 'text', 'GW-001'),
        ledgerInputField('multiplier', '倍乘率', editingMeter?.multiplier ?? '1', 'number', '1', '0.000001'),
        ledgerSelectField('allowManualReading', '允许手工抄表', [{ value: '1', label: '是' }, { value: '0', label: '否' }], editingMeter?.allowManualReading ?? '1'),
        ledgerSelectField('flowDirection', '流向', flowOptions, editingMeter?.flowDirection || 'unknown'),
        ledgerInputField('installLocation', '安装位置', editingMeter?.installLocation || '', 'text', '配电室'),
        ledgerSelectField('status', '状态', statusOptions, editingMeter?.status || 'active')
      ]),
      ledgerTextareaField('remark', '备注', editingMeter?.remark || ''),
      createElement('p', { className: 'muted', text: '在线状态和网关 ID 仅为台账字段，不代表实时采集或实时在线判断。' }),
      createElement('div', { className: 'template-actions' }, [
        createElement('button', { type: 'submit', className: 'btn btn-primary', text: editingMeter ? '保存计量器具' : '新增计量器具' }),
        editingMeter ? createElement('button', { type: 'button', className: 'btn btn-ghost', text: '取消编辑', dataset: { action: 'cancel-ledger-edit' } }) : null
      ]),
      createElement('div', { id: 'ledger-meter-result', className: 'inline-result', 'aria-live': 'polite' })
    ])
  ]);
}

function renderMeterReadingForm(meters = [], editingReading = null) {
  const activeManualMeters = meters.filter((meter) => meter.status === 'active' && Number(meter.allowManualReading) === 1);
  const selectedMeter = editingReading
    ? findById(meters, editingReading.meterDeviceId)
    : activeManualMeters[0] || null;
  const unitValue = editingReading?.originalUnit || getMeterDefaultReadingUnit(selectedMeter);
  const dataSourceOptions = [
    { value: 'manual', label: 'manual：页面补录' },
    { value: 'upload', label: 'upload：导入来源' },
    { value: 'calculation', label: 'calculation：计算来源' }
  ];
  const statusOptions = [
    { value: 'active', label: 'active：有效' },
    { value: 'void', label: 'void：作废' }
  ];
  return renderCard(editingReading ? '编辑计量抄表' : '新增计量抄表', [
    createElement('form', { id: 'ledger-reading-form', className: 'form-card' }, [
      editingReading ? createElement('input', { type: 'hidden', name: 'id', value: editingReading.id }) : null,
      createElement('div', { className: 'form-grid' }, [
        ledgerSelectField(
          'meterDeviceId',
          '计量器具',
          getLedgerMeterOptions(activeManualMeters.length > 0 ? activeManualMeters : meters, false, { includeReadingDefaults: true }),
          editingReading?.meterDeviceId || selectedMeter?.id || '',
          { dataset: { role: 'ledger-reading-meter' } }
        ),
        ledgerInputField('readingDate', '抄表日期', editingReading?.readingDate || '', 'date'),
        ledgerInputField('previousValue', '上期表码', editingReading?.previousValue ?? '', 'number', '12000', '0.000001'),
        ledgerInputField('currentValue', '本期表码', editingReading?.currentValue ?? '', 'number', '12500', '0.000001'),
        ledgerInputField('multiplier', '倍率', editingReading?.multiplier ?? selectedMeter?.multiplier ?? '1', 'number', '1', '0.000001'),
        ledgerInputField('usageValue', '能耗用量（可选）', editingReading?.usageValue ?? '', 'number', '为空时后端按表码差×倍率计算', '0.000001'),
        ledgerInputField('originalUnit', '单位', unitValue, 'text', 'kWh / m3 / t / MJ'),
        ledgerSelectField('dataSource', '数据来源', dataSourceOptions, editingReading?.dataSource || 'manual'),
        ledgerSelectField('recordStatus', '记录状态', statusOptions, editingReading?.recordStatus || 'active')
      ]),
      ledgerTextareaField('remark', '备注', editingReading?.remark || ''),
      createElement('p', { className: 'muted', text: '保存后由后端校验计量器具 active、允许手工抄表、表码范围、倍率和单位，并计算标准化用量；当前抄表记录不自动进入能耗统计。' }),
      createElement('div', { className: 'template-actions' }, [
        createElement('button', { type: 'submit', className: 'btn btn-primary', text: editingReading ? '保存抄表记录' : '新增抄表记录' }),
        editingReading ? createElement('button', { type: 'button', className: 'btn btn-ghost', text: '取消编辑', dataset: { action: 'cancel-ledger-edit' } }) : null
      ]),
      createElement('div', { id: 'ledger-reading-result', className: 'inline-result', 'aria-live': 'polite' })
    ])
  ]);
}

function getProductionUnitOptions(productionUnits = [], includeEmpty = false, emptyLabel = '请选择产能单元') {
  const options = includeEmpty ? [{ value: '', label: emptyLabel }] : [];
  return options.concat(productionUnits.map((unit) => {
    const statusSuffix = unit.status === 'inactive' ? ' / 已停用' : '';
    return {
      value: unit.id,
      label: `${unit.unitName || unit.unitCode}（${unit.unitCode} / ${unit.productName || '-'} / ${unit.outputUnit || '-'}${statusSuffix}）`,
      dataset: { outputUnit: unit.outputUnit || '' }
    };
  }));
}

function renderLockedProductionOutputUnitField(editingOutput, selectedUnit) {
  const lockedUnitLabel = selectedUnit
    ? `${selectedUnit.unitName || selectedUnit.unitCode}（${selectedUnit.unitCode} / ${selectedUnit.productName || '-'} / ${selectedUnit.outputUnit || '-'}${selectedUnit.status === 'inactive' ? ' / 已停用' : ''}）`
    : `原产能单元 #${editingOutput?.productionUnitId || '-'}（已停用或不可见）`;
  return createElement('label', { className: 'field' }, [
    createElement('span', { text: '产能单元' }),
    createElement('input', { type: 'hidden', name: 'productionUnitId', value: editingOutput?.productionUnitId || selectedUnit?.id || '' }),
    createElement('select', { disabled: 'disabled', 'aria-label': '月度产量所属产能单元已锁定' }, [
      createElement('option', { value: editingOutput?.productionUnitId || selectedUnit?.id || '', selected: 'selected', text: lockedUnitLabel })
    ]),
    selectedUnit?.status === 'inactive' ? createElement('small', { text: '原产能单元已停用；编辑月度产量时锁定所属产能单元，不会静默改挂到其它 active 产能单元。' }) : createElement('small', { text: '编辑月度产量时锁定所属产能单元；如需调整归属，请新增或作废后重建记录。' })
  ]);
}

function renderLockedProductionUnitOrganizationField(editingProductionUnit, selectedOrganizationUnit) {
  const lockedUnitLabel = selectedOrganizationUnit
    ? `${selectedOrganizationUnit.unitPath || selectedOrganizationUnit.unitName}（${selectedOrganizationUnit.unitCode}${selectedOrganizationUnit.status === 'inactive' ? ' / 已停用' : ''}）`
    : `原用能单元 #${editingProductionUnit?.organizationUnitId || '-'}（已停用或不可见）`;
  return createElement('label', { className: 'field' }, [
    createElement('span', { text: '所属用能单元' }),
    createElement('input', { type: 'hidden', name: 'organizationUnitId', value: editingProductionUnit?.organizationUnitId || selectedOrganizationUnit?.id || '' }),
    createElement('select', { disabled: 'disabled', 'aria-label': '产能单元所属用能单元已锁定' }, [
      createElement('option', { value: editingProductionUnit?.organizationUnitId || selectedOrganizationUnit?.id || '', selected: 'selected', text: lockedUnitLabel })
    ]),
    selectedOrganizationUnit?.status === 'inactive' ? createElement('small', { text: '原用能单元已停用；编辑产能单元时锁定所属用能单元，不会静默改挂到其它 active 用能单元。' }) : createElement('small', { text: '编辑产能单元时锁定所属用能单元；如需调整归属，请新增或停用后重建产能单元。' })
  ]);
}

function renderProductionUnitForm(units = [], editingProductionUnit = null) {
  const statusOptions = [
    { value: 'active', label: 'active：启用' },
    { value: 'inactive', label: 'inactive：停用' }
  ];
  const activeUnits = units.filter((unit) => unit.status === 'active');
  const hasActiveUnits = activeUnits.length > 0;
  const selectedOrganizationUnit = editingProductionUnit ? findById(units, editingProductionUnit.organizationUnitId) : activeUnits[0] || null;
  const organizationUnitOptions = hasActiveUnits
    ? getLedgerUnitOptions(activeUnits, false)
    : [{ value: '', label: '请先新增或启用用能单元', disabled: true }];
  const disableCreate = !editingProductionUnit && !hasActiveUnits;
  return renderCard(editingProductionUnit ? '编辑产能单元' : '新增产能单元', [
    createElement('form', { id: 'ledger-production-unit-form', className: 'form-card' }, [
      editingProductionUnit ? createElement('input', { type: 'hidden', name: 'id', value: editingProductionUnit.id }) : null,
      createElement('div', { className: 'form-grid' }, [
        ledgerInputField('unitCode', '产能单元编码', editingProductionUnit?.unitCode || '', 'text', 'PU-001'),
        ledgerInputField('unitName', '产能单元名称', editingProductionUnit?.unitName || '', 'text', '一线产能单元'),
        editingProductionUnit
          ? renderLockedProductionUnitOrganizationField(editingProductionUnit, selectedOrganizationUnit)
          : ledgerSelectField('organizationUnitId', '所属用能单元', organizationUnitOptions, selectedOrganizationUnit?.id || '', disableCreate ? { disabled: 'disabled' } : {}),
        ledgerInputField('productName', '产品名称', editingProductionUnit?.productName || '', 'text', '产品A'),
        ledgerInputField('outputUnit', '产量单位', editingProductionUnit?.outputUnit || '', 'text', 't / 件 / MWh'),
        ledgerSelectField('status', '状态', statusOptions, editingProductionUnit?.status || 'active')
      ]),
      ledgerTextareaField('remark', '备注', editingProductionUnit?.remark || ''),
      createElement('p', { className: 'muted', text: editingProductionUnit ? '编辑产能单元时锁定所属用能单元，避免历史归属和单位产品能耗统计范围被静默改挂；新增产能单元必须归属于 active 用能单元。' : '产能单元必须归属于 active 用能单元；DELETE 为停用语义，不物理删除历史产量或统计追溯。' }),
      disableCreate ? createElement('p', { className: 'muted', text: '请先到“用能单元”页签新增或启用 active 用能单元，再新增产能单元。' }) : null,
      createElement('div', { className: 'template-actions' }, [
        createElement('button', { type: 'submit', className: 'btn btn-primary', disabled: disableCreate ? 'disabled' : undefined, text: editingProductionUnit ? '保存产能单元' : '新增产能单元' }),
        editingProductionUnit ? createElement('button', { type: 'button', className: 'btn btn-ghost', text: '取消编辑', dataset: { action: 'cancel-ledger-edit' } }) : null
      ]),
      createElement('div', { id: 'ledger-production-unit-result', className: 'inline-result', 'aria-live': 'polite' })
    ])
  ]);
}

function renderProductionOutputForm(productionUnits = [], editingOutput = null) {
  const activeProductionUnits = productionUnits.filter((unit) => unit.status === 'active');
  const hasActiveProductionUnits = activeProductionUnits.length > 0;
  const selectedUnit = editingOutput ? findById(productionUnits, editingOutput.productionUnitId) : activeProductionUnits[0] || null;
  const productionUnitOptions = hasActiveProductionUnits
    ? getProductionUnitOptions(activeProductionUnits, false)
    : [{ value: '', label: '请先新增或启用产能单元', disabled: true }];
  const disableCreate = !editingOutput && !hasActiveProductionUnits;
  const dataSourceOptions = [
    { value: 'manual', label: 'manual：页面维护' },
    { value: 'upload', label: 'upload：历史导入来源' },
    { value: 'calculation', label: 'calculation：计算来源' }
  ];
  const statusOptions = [
    { value: 'active', label: 'active：有效' },
    { value: 'void', label: 'void：作废' }
  ];
  return renderCard(editingOutput ? '编辑月度产量' : '新增月度产量', [
    createElement('form', { id: 'ledger-production-output-form', className: 'form-card' }, [
      editingOutput ? createElement('input', { type: 'hidden', name: 'id', value: editingOutput.id }) : null,
      createElement('div', { className: 'form-grid' }, [
        editingOutput
          ? renderLockedProductionOutputUnitField(editingOutput, selectedUnit)
          : ledgerSelectField('productionUnitId', '产能单元', productionUnitOptions, selectedUnit?.id || '', { dataset: { role: 'ledger-production-output-unit' }, disabled: disableCreate ? 'disabled' : undefined }),
        ledgerInputField('normalizedMonth', '月份', editingOutput?.normalizedMonth || '', 'month'),
        ledgerInputField('outputValue', '产量值', editingOutput?.outputValue ?? '', 'number', '1000', '0.000001'),
        ledgerInputField('outputUnit', '产量单位', editingOutput?.outputUnit || selectedUnit?.outputUnit || '', 'text', '默认取产能单元产量单位'),
        ledgerSelectField('dataSource', '数据来源', dataSourceOptions, editingOutput?.dataSource || 'manual'),
        ledgerSelectField('recordStatus', '记录状态', statusOptions, editingOutput?.recordStatus || 'active')
      ]),
      ledgerTextareaField('remark', '备注', editingOutput?.remark || ''),
      createElement('p', { className: 'muted', text: '新增月度产量只能选择 active 产能单元；同一产能单元同一月份只能存在一条 active 月度产量；DELETE 为作废语义，作废后不作为单位产品能耗分母。' }),
      disableCreate ? createElement('p', { className: 'muted', text: '请先新增或启用 active 产能单元，再新增月度产量。' }) : null,
      createElement('div', { className: 'template-actions' }, [
        createElement('button', { type: 'submit', className: 'btn btn-primary', disabled: disableCreate ? 'disabled' : undefined, text: editingOutput ? '保存月度产量' : '新增月度产量' }),
        editingOutput ? createElement('button', { type: 'button', className: 'btn btn-ghost', text: '取消编辑', dataset: { action: 'cancel-ledger-edit' } }) : null
      ]),
      createElement('div', { id: 'ledger-production-output-result', className: 'inline-result', 'aria-live': 'polite' })
    ])
  ]);
}

function formatProductionIntensityStatus(status) {
  const labels = {
    calculable: 'calculable：可计算',
    'no-output': 'no-output：无 active 产量',
    'no-energy': 'no-energy：无 active 能耗',
    'zero-output': 'zero-output：零产量'
  };
  return labels[status] || formatText(status);
}

function renderProductionEnergyByType(row = {}) {
  const details = Array.isArray(row.energyByType) ? row.energyByType : [];
  if (details.length === 0) {
    return createElement('span', { className: 'muted', text: '暂无 energyByType 明细' });
  }
  return createElement('div', { className: 'nested-detail' }, details.map((item) => createElement('div', { className: 'nested-detail-row' }, [
    createElement('strong', { text: `${formatText(item.energyTypeName || item.energyTypeCode)}（${formatText(item.energyTypeCode)}）` }),
    createElement('span', { text: `${formatNumber(item.totalNormalizedValue, 6)} ${formatText(item.normalizedUnit, '')}` }),
    createElement('small', { text: `记录 ${formatNumber(item.recordCount, 0)} 条` })
  ])));
}

function renderProductionUnitActions(row) {
  return createElement('div', { className: 'table-actions' }, [
    createElement('button', { type: 'button', className: 'btn btn-small', text: '编辑', dataset: { action: 'edit-production-unit', id: row.id } }),
    createElement('button', { type: 'button', className: 'btn btn-small btn-danger', text: '停用', dataset: { action: 'deactivate-production-unit', id: row.id, name: row.unitName } })
  ]);
}

function renderProductionOutputActions(row) {
  return createElement('div', { className: 'table-actions' }, [
    createElement('button', { type: 'button', className: 'btn btn-small', text: '编辑', dataset: { action: 'edit-production-output', id: row.id } }),
    createElement('button', { type: 'button', className: 'btn btn-small btn-danger', text: '作废', dataset: { action: 'void-production-output', id: row.id, name: `${row.productionUnitName || row.productionUnitCode} ${row.normalizedMonth || ''}` } })
  ]);
}

function renderProductionIntensityCard(intensityResponse, selectedProductionUnitId) {
  const rows = intensityResponse?.ok ? (intensityResponse.value.data || []) : [];
  const meta = intensityResponse?.ok ? (intensityResponse.value.meta || {}) : {};
  const calculableCount = rows.filter((row) => row.status === 'calculable').length;
  const noOutputCount = rows.filter((row) => row.status === 'no-output' || row.status === 'zero-output').length;
  const noEnergyCount = rows.filter((row) => row.status === 'no-energy').length;
  const children = [
    renderMessage('info', '单位产品能耗口径提示', '分子为产能单元所属用能单元当月 active energy_records.normalized_value 汇总；分母为该产能单元当月 active 月度产量。跨能源类型/单位直接汇总仅作管理参考，必须查看 energyByType 明细。'),
    renderMessage('warning', 'P2 首期边界', '发电自用已由基础台账“发电自用”页签独立维护；当前单位产品能耗仍不纳入发电、自发自用或碳核算结果写入。碳核算联动后置。')
  ];
  if (!selectedProductionUnitId) {
    children.push(renderMessage('empty', '请选择产能单元', '先新增或选择 active 产能单元后，再查看单位产品能耗。'));
    return renderCard('单位产品能耗', children);
  }
  if (!intensityResponse) {
    children.push(renderMessage('empty', '尚未读取统计', '设置产能单元和月份筛选后，页面会调用 /api/production/statistics/unit-energy-intensity 读取统计。'));
    return renderCard('单位产品能耗', children);
  }
  if (!intensityResponse.ok) {
    children.push(renderMessage('error', '单位产品能耗读取失败', formatApiError(intensityResponse.error)));
    return renderCard('单位产品能耗', children);
  }
  children.push(renderKeyValueList([
    { label: 'formula', value: meta.formula || '单位产品能耗 = 所属用能单元当月 active energy_records 汇总 / 当月 active 产量' },
    { label: 'generationIncluded', value: String(meta.generationIncluded === true) },
    { label: 'selfUseIncluded', value: String(meta.selfUseIncluded === true) },
    { label: 'carbonAccountingIncluded', value: String(meta.carbonAccountingIncluded === true) }
  ]));
  children.push(createElement('section', { className: 'stat-grid' }, [
    renderStat('月份数', formatNumber(rows.length, 0), '统计行数'),
    renderStat('可计算', formatNumber(calculableCount, 0), 'calculable', 'green'),
    renderStat('无产量/零产量', formatNumber(noOutputCount, 0), 'no-output / zero-output', 'orange'),
    renderStat('无能耗', formatNumber(noEnergyCount, 0), 'no-energy')
  ]));
  children.push(renderTable([
    { key: 'normalizedMonth', label: '月份' },
    { key: 'outputValue', label: '产量', render: (row) => createElement('span', { text: row.outputValue === null ? '-' : `${formatNumber(row.outputValue, 6)} ${formatText(row.outputUnit, '')}` }) },
    { key: 'energyTotal', label: '能耗合计', render: (row) => createElement('span', { text: `${formatNumber(row.energyTotal, 6)} ${formatText(row.energyUnit, '')}` }) },
    { key: 'energyIntensity', label: '单位产品能耗', render: (row) => createElement('span', { text: row.energyIntensity === null ? '-' : `${formatNumber(row.energyIntensity, 6)} ${formatText(row.energyUnit, '')}/${formatText(row.outputUnit, '')}` }) },
    { key: 'status', label: '状态', render: (row) => renderStatusPill(row.status) },
    { key: 'notice', label: '提示', render: (row) => createElement('span', { text: row.notice || formatProductionIntensityStatus(row.status) }) },
    { key: 'energyByType', label: 'energyByType 明细', render: renderProductionEnergyByType }
  ], rows, '暂无单位产品能耗数据。请先维护 active 月度产量，或调整月份范围。'));
  return renderCard('单位产品能耗', children);
}

function renderLedgerUnitActions(row) {
  return createElement('div', { className: 'table-actions' }, [
    createElement('button', { type: 'button', className: 'btn btn-small', text: '编辑', dataset: { action: 'edit-ledger-unit', id: row.id } }),
    createElement('button', { type: 'button', className: 'btn btn-small btn-danger', text: '停用', dataset: { action: 'deactivate-ledger-unit', id: row.id, name: row.unitName } })
  ]);
}

function renderLedgerMeterActions(row) {
  return createElement('div', { className: 'table-actions' }, [
    createElement('button', { type: 'button', className: 'btn btn-small', text: '编辑', dataset: { action: 'edit-ledger-meter', id: row.id } }),
    createElement('button', { type: 'button', className: 'btn btn-small btn-danger', text: '停用', dataset: { action: 'deactivate-ledger-meter', id: row.id, name: row.meterName } })
  ]);
}

function getLedgerBatchTotalRows(batch = {}) {
  return batch.totalRows ?? batch.totalRowCount ?? batch.summary?.totalRows ?? 0;
}

function getLedgerBatchSuccessCount(batch = {}) {
  return batch.successCount ?? batch.summary?.successCount ?? 0;
}

function getLedgerBatchFailureCount(batch = {}) {
  return batch.failureCount ?? batch.summary?.failureCount ?? 0;
}

function getLedgerBatchSkippedCount(batch = {}) {
  return batch.skippedCount ?? batch.warningCount ?? batch.summary?.skippedCount ?? 0;
}

function renderLedgerImportResult(batch = {}, noun = '台账') {
  const errors = Array.isArray(batch.errors)
    ? batch.errors
    : Array.isArray(batch.errorDetails)
      ? batch.errorDetails
      : [];
  const status = batch.status || batch.summary?.status || 'unknown';
  const totalRows = getLedgerBatchTotalRows(batch);
  const successCount = getLedgerBatchSuccessCount(batch);
  const failureCount = getLedgerBatchFailureCount(batch);
  const skippedCount = getLedgerBatchSkippedCount(batch);
  const messageType = status === 'failed' ? 'error' : 'success';
  const title = status === 'failed' ? `${noun}导入处理失败` : failureCount > 0 || skippedCount > 0 ? `${noun}导入完成（含错误/跳过）` : `${noun}导入完成`;
  const batchId = batch.id || batch.batchId || batch.summary?.batchId;
  const children = [
    renderMessage(
      messageType,
      title,
      `批次 ${formatText(batchId, '未知')}，状态 ${formatText(status)}，总行数 ${formatNumber(totalRows, 0)}，成功 ${formatNumber(successCount, 0)}，失败 ${formatNumber(failureCount, 0)}，跳过/警告 ${formatNumber(skippedCount, 0)}。${batch.errorSummary ? `错误摘要：${batch.errorSummary}` : '导入成功后列表已刷新。'}`
    )
  ];
  if (errors.length > 0) {
    children.push(renderTable([
      { key: 'rowNumber', label: '行号' },
      { key: 'fieldName', label: '字段' },
      { key: 'rawValue', label: '原始值' },
      { key: 'errorCode', label: '错误码' },
      { key: 'errorReason', label: '原因' },
      { key: 'severity', label: '级别', render: (row) => renderStatusPill(row.severity) }
    ], errors, '暂无错误明细。'));
  }
  return children;
}

function renderLedgerImportPanel(kind, result) {
  const noun = kind === 'units' ? '用能单元' : '计量器具';
  const selector = kind === 'units' ? 'ledger-unit-import-result' : 'ledger-meter-import-result';
  const content = result
    ? renderLedgerImportResult(result, noun)
    : [renderMessage('info', `${noun}导入结果`, '选择文件并提交后，这里会展示批次总行数、成功、失败、跳过/警告和错误明细。')];
  return createElement('div', { id: selector, className: 'inline-result', 'aria-live': 'polite' }, content);
}

function renderImportAuditBatchLinks(audit = {}, noun = '导入') {
  const batchId = audit.batchId || audit.auditBatch?.id;
  const auditBatch = audit.auditBatch || {};
  if (!batchId) {
    return renderMessage('warning', `${noun}批次未返回`, '本次响应未返回 batchId，无法从页面直接查看持久批次；请保留当前响应明细并检查后端返回。');
  }
  const persistentText = audit.persistsImportBatch === true || auditBatch.id
    ? '已持久化，可通过批次详情、错误明细和原文件下载追溯。'
    : '响应未明确 persistsImportBatch=true，请以批次详情接口为准。';
  return createElement('div', { className: 'sub-panel' }, [
    renderMessage('info', `${noun}审计批次`, `批次号 ${formatText(batchId)}；类型 ${formatImportType(auditBatch.importType)}；状态 ${formatText(auditBatch.status || audit.status)}；持久化状态：${persistentText}`),
    createElement('div', { className: 'template-actions' }, [
      createElement('button', { type: 'button', className: 'btn btn-small', text: '查看批次详情', dataset: { action: 'load-import-batch-detail', batchId } }),
      createElement('button', { type: 'button', className: 'btn btn-small', text: '查看错误明细', dataset: { action: 'load-import-errors', batchId } }),
      createElement('button', { type: 'button', className: 'btn btn-small', text: '下载原文件', dataset: { action: 'download-import-file', batchId, filename: auditBatch.originalFilename || audit.originalFilename || '' } })
    ])
  ]);
}

function renderProductionOutputImportAudit(audit = {}) {
  const summary = audit.summary || {};
  const items = Array.isArray(audit.items) ? audit.items : [];
  return [
    renderMessage(
      audit.executed ? 'success' : 'info',
      audit.executed ? '月度产量导入已执行' : '月度产量导入预演结果',
      `总行数 ${formatNumber(summary.totalRows, 0)}，可导入 ${formatNumber(summary.wouldImport, 0)}，已导入 ${formatNumber(audit.imported || summary.imported || 0, 0)}，跳过 ${formatNumber(summary.skipped || audit.skipped || 0, 0)}，阻断 ${formatNumber(summary.blocked || 0, 0)}，警告 ${formatNumber(summary.warnings || 0, 0)}，错误 ${formatNumber(summary.errors || 0, 0)}。批次号：${formatText(audit.batchId || audit.auditBatch?.id, '未返回')}；持久化状态：${audit.persistsImportBatch === true ? '已持久化' : '未确认'}。${audit.backup?.backupName ? `备份：${audit.backup.backupName}。` : ''}`
    ),
    renderImportAuditBatchLinks(audit, '月度产量导入'),
    renderTable([
      { key: 'rowNumber', label: '行号' },
      { key: 'status', label: '状态', render: (row) => renderStatusPill(row.status || row.previewStatus) },
      { key: 'productionUnitCode', label: '产能单元编码', render: (row) => createElement('span', { text: formatText(row.productionUnitCode || row.unitCode) }) },
      { key: 'productionUnitName', label: '产能单元名称', render: (row) => createElement('span', { text: formatText(row.productionUnitName || row.unitName) }) },
      { key: 'normalizedMonth', label: '月份' },
      { key: 'outputValue', label: '产量值', render: (row) => createElement('span', { text: `${formatText(row.outputValue)} ${formatText(row.outputUnit, '')}` }) },
      { key: 'reasonText', label: '错误/警告/说明', render: (row) => createElement('span', { text: row.reasonText || row.reason || row.reasonCodes || '-' }) }
    ], items, '暂无行级明细。')
  ];
}

function renderProductionOutputImportPanel() {
  const preview = state.productionOutputImportPreview;
  const executeResult = state.productionOutputImportExecuteResult;
  const canExecute = preview?.previewSignature && Number(preview?.summary?.wouldImport || 0) > 0 && Array.isArray(preview?.candidateRowIds) && preview.candidateRowIds.length > 0;
  const children = [
    createElement('p', { className: 'muted', text: '月度产量导入采用 preview + signature + candidate rows + 自动备份 + 固定确认文本受控 execute。产能单元编码必填并优先匹配；名称仅辅助校验/展示；同产能单元同月份已有 active 产量时 skip warning，不覆盖、不作废旧记录；preview/execute 响应会展示可追溯批次号、批次详情、错误明细和原文件下载入口。' }),
    renderTemplateActions([{ type: 'production-outputs', label: '下载产量导入模板（Excel）' }]),
    createElement('form', { id: 'production-output-import-preview-form', className: 'form-card' }, [
      createElement('label', { className: 'field' }, [
        createElement('span', { text: '导入月度产量文件（.xlsx / .xls / .csv）' }),
        createElement('input', { type: 'file', name: 'file', accept: '.xlsx,.xls,.csv' })
      ]),
      createElement('div', { className: 'template-actions' }, [
        createElement('button', { type: 'submit', className: 'btn btn-primary', text: state.productionOutputImportPreviewLoading ? '预演中...' : '运行导入预演', disabled: state.productionOutputImportPreviewLoading || state.productionOutputImportExecuteLoading ? 'disabled' : undefined }),
        createElement('button', { type: 'button', className: 'btn btn-ghost', text: '导出当前筛选', dataset: { action: 'export-production-outputs' } }),
        createElement('button', { type: 'button', className: 'btn btn-danger', text: '受控执行导入', disabled: canExecute && !state.productionOutputImportPreviewLoading && !state.productionOutputImportExecuteLoading ? undefined : 'disabled', dataset: { action: 'execute-production-output-import' } })
      ]),
      createElement('small', { className: 'muted', text: '受控执行固定确认文本：确认导入月度产量记录；请求体会携带 confirmText、previewSignature、expectedWouldImport、candidateRowIds、candidateRows、acknowledgeSkippedRisks=true、requireBackup=true。' })
    ])
  ];
  if (state.productionOutputImportPreviewLoading || state.productionOutputImportExecuteLoading) {
    children.push(renderLoading(state.productionOutputImportExecuteLoading ? '正在受控导入月度产量...' : '正在预演月度产量导入...'));
  }
  if (state.productionOutputImportPreviewError) {
    children.push(renderMessage('error', '月度产量导入预演失败', state.productionOutputImportPreviewError));
  }
  if (state.productionOutputImportExecuteError) {
    children.push(renderMessage('error', '月度产量受控导入失败', state.productionOutputImportExecuteError));
  }
  if (executeResult) {
    children.push(...renderProductionOutputImportAudit(executeResult));
  } else if (preview) {
    children.push(...renderProductionOutputImportAudit(preview));
  } else {
    children.push(renderMessage('info', '月度产量导入预演', '选择文件并运行预演后，这里会展示 summary、行级状态、错误/警告、skipped 和 wouldImport 明细。'));
  }
  return renderCard('月度产量导入/导出', children);
}

function renderMeterReadingActions(row) {
  return createElement('div', { className: 'table-actions' }, [
    createElement('button', { type: 'button', className: 'btn btn-small', text: '编辑', dataset: { action: 'edit-ledger-reading', id: row.id } }),
    createElement('button', { type: 'button', className: 'btn btn-small btn-danger', text: '作废', dataset: { action: 'void-ledger-reading', id: row.id, name: `${row.meterName || row.meterCode} ${row.readingDate || ''}` } })
  ]);
}

function formatPercent(value, digits = 2) {
  if (value === undefined || value === null || value === '') {
    return '-';
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return '-';
  }
  return `${formatNumber(numericValue * 100, digits)}%`;
}

function getGenerationRecordName(row = {}) {
  return `${row.organizationUnitPath || row.organizationUnitName || row.organizationUnitCode || `用能单元 #${row.organizationUnitId}`} ${row.normalizedMonth || ''}`.trim();
}

function renderGenerationForm(units = [], editingRecord = null) {
  const activeUnits = units.filter((unit) => unit.status === 'active');
  const selectedUnit = editingRecord ? findById(units, editingRecord.organizationUnitId) : activeUnits[0] || null;
  return renderCard(editingRecord ? '编辑发电自用记录' : '新增发电自用记录', [
    createElement('form', { id: 'ledger-generation-form', className: 'form-card' }, [
      editingRecord ? createElement('input', { type: 'hidden', name: 'id', value: editingRecord.id }) : null,
      createElement('input', { type: 'hidden', name: 'energyTypeCode', value: 'photovoltaic' }),
      createElement('div', { className: 'form-grid' }, [
        editingRecord
          ? createElement('label', { className: 'field' }, [
            createElement('span', { text: '用能单元' }),
            createElement('input', { type: 'hidden', name: 'organizationUnitId', value: editingRecord.organizationUnitId || '' }),
            createElement('select', { disabled: 'disabled', 'aria-label': '编辑发电记录时用能单元已锁定' }, [
              createElement('option', { value: editingRecord.organizationUnitId || '', selected: 'selected', text: selectedUnit ? `${selectedUnit.unitPath || selectedUnit.unitName}（${selectedUnit.unitCode}${selectedUnit.status === 'inactive' ? ' / 已停用' : ''}）` : `原用能单元 #${editingRecord.organizationUnitId || '-'}` })
            ]),
            createElement('small', { text: '编辑时锁定用能单元；如需调整归属，请作废后重建，避免追溯口径漂移。' })
          ])
          : ledgerSelectField('organizationUnitId', '用能单元', getLedgerUnitOptions(activeUnits, false), selectedUnit?.id || ''),
        ledgerInputField('normalizedMonth', '月份', editingRecord?.normalizedMonth || '', 'month'),
        ledgerInputField('generationValueKwh', '发电量 kWh', editingRecord?.generationValueKwh ?? '', 'number', '1000', '0.000001'),
        ledgerInputField('selfUseValueKwh', '自发自用 kWh', editingRecord?.selfUseValueKwh ?? '', 'number', '800', '0.000001'),
        ledgerInputField('gridExportValueKwh', '上网电量 kWh', editingRecord?.gridExportValueKwh ?? '', 'number', '200', '0.000001'),
        createElement('label', { className: 'field' }, [
          createElement('span', { text: '能源类型' }),
          createElement('input', { value: '光伏（photovoltaic，首期固定）', disabled: 'disabled' }),
          createElement('small', { text: '首期固定为 photovoltaic / 光伏，不要求用户选择。' })
        ])
      ]),
      ledgerTextareaField('remark', '备注', editingRecord?.remark || ''),
      createElement('p', { className: 'muted', text: '同一用能单元 + 同一月份 + photovoltaic 只允许一条 active 发电记录；发电量、自发自用和上网电量均为 kWh，且自发自用 + 上网电量不能大于发电量。' }),
      createElement('div', { className: 'template-actions' }, [
        createElement('button', { type: 'submit', className: 'btn btn-primary', text: editingRecord ? '保存发电记录' : '新增发电记录' }),
        editingRecord ? createElement('button', { type: 'button', className: 'btn btn-ghost', text: '取消编辑', dataset: { action: 'cancel-ledger-edit' } }) : null
      ]),
      createElement('div', { id: 'ledger-generation-result', className: 'inline-result', 'aria-live': 'polite' })
    ])
  ]);
}

function renderGenerationBoundaryCard(meta = {}) {
  return renderCard('发电自用边界说明', [
    renderMessage('info', '外购电参考口径', '外购电参考来自 active energy_records 中 electricity + 同用能单元 + 同月份汇总，仅供参考，不自动抵扣、不入账。'),
    renderKeyValueList([
      { label: '固定能源类型', value: 'photovoltaic / 光伏；标准单位 kWh。' },
      { label: '导入/导出目标表', value: '模板下载、当前筛选导出、上传 preview 和受控 execute 只维护 generation_records。' },
      { label: '不写 energy_records', value: meta.writesEnergyRecords === false ? '确认：不会自动写入或回填 energy_records。' : '页面固定边界：导入/导出不写 energy_records。' },
      { label: '不写 carbon_emissions', value: meta.writesCarbonEmissions === false ? '确认：不会自动写入 carbon_emissions。' : '页面固定边界：导入/导出不写 carbon_emissions。' },
      { label: '不影响单位产品能耗', value: meta.affectsProductionIntensity === false ? '确认：不影响单位产品能耗统计。' : '页面固定边界：不影响单位产品能耗统计。' },
      { label: '重复策略', value: '默认 skip：同用能单元、同月份、photovoltaic 已有 active 记录或同文件重复候选会跳过并显示 warning，不覆盖旧记录。' },
      { label: '不含实时采集/外部网关', value: meta.realtimeCollectionIncluded === false ? '确认：不引入实时采集、自动同步或外部网关。' : '当前页面不引入实时采集、自动同步或外部网关。' }
    ])
  ]);
}

function renderGenerationImportIssueList(row = {}) {
  const issues = [];
  if (Array.isArray(row.errors)) issues.push(...row.errors);
  if (Array.isArray(row.warnings)) issues.push(...row.warnings);
  if (Array.isArray(row.reasons)) issues.push(...row.reasons);
  if (issues.length === 0) {
    return createElement('span', { text: row.reasonText || row.reason || row.reasonCodes || '-' });
  }
  return createElement('ul', { className: 'compact-list' }, issues.map((issue) => createElement('li', {
    text: `${formatText(issue.severity, 'info')}：${formatText(issue.fieldName, 'row')}；原始值 ${formatText(issue.rawValue)}；${formatText(issue.message || issue.code)}`
  })));
}

function renderGenerationRecordImportAudit(audit = {}) {
  const summary = audit.summary || {};
  const items = Array.isArray(audit.items) && audit.items.length > 0
    ? audit.items
    : (Array.isArray(audit.previewAudit?.items) ? audit.previewAudit.items : []);
  return [
    renderMessage(
      audit.executed ? 'success' : 'info',
      audit.executed ? '发电自用记录导入已执行' : '发电自用记录导入预演结果',
      `总行数 ${formatNumber(summary.totalRows, 0)}，可导入 ${formatNumber(summary.wouldImport, 0)}，已导入 ${formatNumber(audit.imported || summary.imported || 0, 0)}，跳过 ${formatNumber(summary.skipped || audit.skipped || 0, 0)}，阻断 ${formatNumber(summary.blocked || audit.blocked || 0, 0)}，警告 ${formatNumber(summary.warnings || audit.warnings || 0, 0)}，错误 ${formatNumber(summary.errors || audit.errors || 0, 0)}。批次号：${formatText(audit.batchId || audit.auditBatch?.id, '未返回')}；持久化状态：${audit.persistsImportBatch === true ? '已持久化' : '未确认'}。${audit.backup?.backupName ? `备份：${audit.backup.backupName}。` : ''}导入/导出只维护 generation_records，不写 energy_records，不写 carbon_emissions，不影响单位产品能耗。`
    ),
    renderImportAuditBatchLinks(audit, '发电记录导入'),
    Array.isArray(audit.notices) && audit.notices.length > 0
      ? createElement('ul', { className: 'compact-list' }, audit.notices.map((notice) => createElement('li', { text: notice })))
      : null,
    renderTable([
      { key: 'rowNumber', label: '行号' },
      { key: 'status', label: '状态', render: (row) => renderStatusPill(row.status || row.previewStatus) },
      { key: 'organizationUnitCode', label: '用能单元编码', render: (row) => createElement('span', { text: formatText(row.organizationUnitCode || row.values?.organizationUnitCode) }) },
      { key: 'organizationUnitName', label: '用能单元名称', render: (row) => createElement('span', { text: formatText(row.organizationUnitName || row.values?.organizationUnitName) }) },
      { key: 'normalizedMonth', label: '月份', render: (row) => createElement('span', { text: formatText(row.normalizedMonth || row.values?.normalizedMonth) }) },
      { key: 'generationValueKwh', label: '发电量', render: (row) => createElement('span', { text: `${formatText(row.generationValueKwh ?? row.values?.generationValueKwh)} kWh` }) },
      { key: 'selfUseValueKwh', label: '自发自用', render: (row) => createElement('span', { text: `${formatText(row.selfUseValueKwh ?? row.values?.selfUseValueKwh)} kWh` }) },
      { key: 'gridExportValueKwh', label: '上网电量', render: (row) => createElement('span', { text: `${formatText(row.gridExportValueKwh ?? row.values?.gridExportValueKwh)} kWh` }) },
      { key: 'reasonText', label: '错误/警告/说明', render: renderGenerationImportIssueList }
    ], items, '暂无行级明细。')
  ];
}

function renderGenerationRecordImportResultRegion(preview, executeResult) {
  const content = [];
  if (state.generationRecordImportPreviewLoading || state.generationRecordImportExecuteLoading) {
    content.push(renderLoading(state.generationRecordImportExecuteLoading ? '正在受控导入发电自用记录...' : '正在预演发电自用记录导入...'));
  }
  if (state.generationRecordImportPreviewError) {
    content.push(renderMessage('error', '发电自用记录导入预演失败', state.generationRecordImportPreviewError));
  }
  if (state.generationRecordImportExecuteError) {
    content.push(renderMessage('error', '发电自用记录受控导入失败', state.generationRecordImportExecuteError));
  }
  if (executeResult) {
    content.push(...renderGenerationRecordImportAudit(executeResult));
  } else if (preview) {
    content.push(...renderGenerationRecordImportAudit(preview));
  } else {
    content.push(renderMessage('info', '发电自用记录导入预演', '选择文件并运行预演后，这里会展示 summary、wouldImport/skipped/blocked、行级错误/警告原因；预演前不会写入 generation_records。'));
  }
  return createElement('div', { id: 'ledger-generation-import-result', className: 'inline-result', 'aria-live': 'polite' }, content);
}

function renderGenerationRecordImportPanel() {
  const preview = state.generationRecordImportPreview;
  const executeResult = state.generationRecordImportExecuteResult;
  const canExecute = preview?.previewSignature && Number(preview?.summary?.wouldImport || 0) > 0 && Array.isArray(preview?.candidateRowIds) && preview.candidateRowIds.length > 0;
  const children = [
    createElement('p', { className: 'muted', text: '发电自用导入采用上传 preview + previewSignature + candidateRows + 自动备份 + 固定确认文本受控 execute；预演不写库，执行仅写 active generation_records。重复 active 记录和同文件重复候选默认 skip warning，不覆盖旧记录。' }),
    createElement('p', { className: 'muted', text: '非联动边界：导入/导出只维护 generation_records，不写 energy_records，不写 carbon_emissions，不影响单位产品能耗；外购电参考只读，不抵扣不入账。当前支持从 preview/execute 响应进入持久批次追溯：查看批次详情、错误明细和下载原文件。' }),
    createElement('div', { className: 'template-actions' }, [
      createTemplateDownloadButton('generation-records', '下载发电记录导入模板（Excel）'),
      createElement('button', { type: 'button', className: 'btn btn-ghost', text: '下载发电记录导入模板（CSV）', dataset: { action: 'download-template-csv', templateType: 'generation-records', fileName: '发电自用记录导入模板.csv' } })
    ]),
    createElement('form', { id: 'ledger-generation-import-preview-form', className: 'form-card' }, [
      createElement('label', { className: 'field' }, [
        createElement('span', { text: '导入发电自用记录文件（.xlsx / .xls / .csv）' }),
        createElement('input', { type: 'file', name: 'file', accept: '.xlsx,.xls,.csv' })
      ]),
      createElement('div', { className: 'template-actions' }, [
        createElement('button', { type: 'submit', className: 'btn btn-primary', text: state.generationRecordImportPreviewLoading ? '预演中...' : '上传并运行预演', disabled: state.generationRecordImportPreviewLoading || state.generationRecordImportExecuteLoading ? 'disabled' : undefined }),
        createElement('button', { type: 'button', className: 'btn btn-ghost', text: '导出当前筛选（Excel）', disabled: state.generationRecordImportPreviewLoading || state.generationRecordImportExecuteLoading ? 'disabled' : undefined, dataset: { action: 'export-ledger-generation' } }),
        createElement('button', { type: 'button', className: 'btn btn-ghost', text: '导出当前筛选（CSV）', disabled: state.generationRecordImportPreviewLoading || state.generationRecordImportExecuteLoading ? 'disabled' : undefined, dataset: { action: 'export-ledger-generation-csv' } }),
        createElement('button', { type: 'button', className: 'btn btn-danger', text: state.generationRecordImportExecuteLoading ? '导入中...' : '受控执行导入', disabled: canExecute && !state.generationRecordImportPreviewLoading && !state.generationRecordImportExecuteLoading ? undefined : 'disabled', dataset: { action: 'execute-generation-record-import' } })
      ]),
      createElement('small', { className: 'muted', text: '受控执行固定确认文本：确认导入发电自用记录；请求体会携带 confirmText、previewSignature、expectedWouldImport、candidateRowIds、candidateRows、acknowledgeSkippedRisks=true、requireBackup=true。' }),
      renderGenerationRecordImportResultRegion(preview, executeResult)
    ])
  ];
  return renderCard('发电自用导入/导出', children);
}

function renderGenerationActions(row) {
  if (row.recordStatus !== 'active') {
    return createElement('span', { className: 'muted', text: '已作废，仅追溯' });
  }
  return createElement('div', { className: 'table-actions' }, [
    createElement('button', { type: 'button', className: 'btn btn-small', text: '编辑', dataset: { action: 'edit-ledger-generation', id: row.id } }),
    createElement('button', { type: 'button', className: 'btn btn-small btn-danger', text: '作废', dataset: { action: 'void-ledger-generation', id: row.id, name: getGenerationRecordName(row) } })
  ]);
}

function renderGenerationSummaryCard(statisticsResponse) {
  if (!statisticsResponse?.ok) {
    return renderCard('月度汇总与外购电参考', [
      renderMessage('error', '发电汇总读取失败', formatApiError(statisticsResponse?.error))
    ]);
  }
  const rows = statisticsResponse.value.data || [];
  const meta = statisticsResponse.value.meta || {};
  const summary = meta.summary || {};
  return renderCard('月度汇总与外购电参考', [
    renderMessage('info', '参考值说明', '外购电参考来自能耗记录，仅供参考，不自动抵扣、不入账；汇总只统计 active 发电记录。'),
    createElement('section', { className: 'stat-grid' }, [
      renderStat('发电量合计', `${formatNumber(summary.generationValueKwh, 6)} kWh`, 'active generation_records'),
      renderStat('自发自用合计', `${formatNumber(summary.selfUseValueKwh, 6)} kWh`, `自用率 ${formatPercent(summary.selfUseRate)}`, 'green'),
      renderStat('上网电量合计', `${formatNumber(summary.gridExportValueKwh, 6)} kWh`, `上网率 ${formatPercent(summary.gridExportRate)}`, 'orange'),
      renderStat('外购电参考合计', `${formatNumber(summary.purchasedElectricityReferenceKwh, 6)} kWh`, '仅参考，不抵扣不入账')
    ]),
    renderTable([
      { key: 'normalizedMonth', label: '月份' },
      { key: 'organizationUnitPath', label: '用能单元', render: (row) => createElement('span', { text: formatText(row.organizationUnitPath || row.organizationUnitName || row.organizationUnitCode) }) },
      { key: 'generationValueKwh', label: '发电量', render: (row) => createElement('span', { text: `${formatNumber(row.generationValueKwh, 6)} kWh` }) },
      { key: 'selfUseValueKwh', label: '自发自用', render: (row) => createElement('span', { text: `${formatNumber(row.selfUseValueKwh, 6)} kWh / ${formatPercent(row.selfUseRate)}` }) },
      { key: 'gridExportValueKwh', label: '上网电量', render: (row) => createElement('span', { text: `${formatNumber(row.gridExportValueKwh, 6)} kWh / ${formatPercent(row.gridExportRate)}` }) },
      { key: 'purchasedElectricityReferenceKwh', label: '外购电参考值', render: (row) => createElement('span', { text: `${formatNumber(row.purchasedElectricityReferenceKwh, 6)} ${formatText(row.purchasedElectricityReferenceUnit, 'kWh')}（能耗记录 ${formatNumber(row.purchasedElectricityReferenceRecordCount, 0)} 条，仅参考）` }) }
    ], rows, '暂无 active 发电汇总。请先新增有效发电记录，或调整用能单元/月分筛选。')
  ]);
}

function validateGenerationFormPayload(payload = {}) {
  if (!payload.organizationUnitId) return '请选择用能单元。';
  if (!payload.normalizedMonth) return '请选择月份。';
  const generation = Number(payload.generationValueKwh);
  const selfUse = Number(payload.selfUseValueKwh || 0);
  const gridExport = Number(payload.gridExportValueKwh || 0);
  if (!Number.isFinite(generation) || generation < 0) return '发电量必须是大于等于 0 的数字。';
  if (!Number.isFinite(selfUse) || selfUse < 0) return '自发自用必须是大于等于 0 的数字。';
  if (!Number.isFinite(gridExport) || gridExport < 0) return '上网电量必须是大于等于 0 的数字。';
  if (selfUse + gridExport > generation + 0.000001) return '自发自用 + 上网电量不能大于发电量。';
  return '';
}

async function handleGenerationSubmit(event) {
  event.preventDefault();
  const form = getSubmittedForm(event, 'ledger-generation-form');
  const resultBox = getInlineResultBox('#ledger-generation-result');
  clearNode(resultBox);
  const payload = collectFormValues(form);
  const id = payload.id;
  delete payload.id;
  payload.energyTypeCode = 'photovoltaic';
  payload.dataSource = 'manual';
  const validationMessage = validateGenerationFormPayload(payload);
  if (validationMessage) {
    resultBox.append(renderMessage('error', '发电记录校验失败', validationMessage));
    return;
  }
  const response = await safeApi(id ? `/generation/records/${id}` : '/generation/records', { method: id ? 'PUT' : 'POST', body: payload });
  if (!response.ok) {
    const detail = response.error.code ? `错误码：${response.error.code}；${formatApiError(response.error)}` : formatApiError(response.error);
    resultBox.append(renderMessage('error', '发电记录保存失败', detail));
    return;
  }
  state.ledgerGenerationFilters.organizationUnitId = payload.organizationUnitId || state.ledgerGenerationFilters.organizationUnitId;
  state.ledgerGenerationFilters.monthStart = state.ledgerGenerationFilters.monthStart || payload.normalizedMonth;
  state.ledgerGenerationFilters.monthEnd = state.ledgerGenerationFilters.monthEnd || payload.normalizedMonth;
  state.ledgerTab = 'generation';
  await renderLedger();
}

async function voidGenerationRecord(id, name) {
  const confirmed = window.confirm(`确认作废发电记录 ${name || id}？\n\n作废不会物理删除记录；该记录不再计入 active 发电汇总，也不会写入 energy_records、carbon_emissions 或单位产品能耗。`);
  if (!confirmed) return;
  const response = await safeApi(`/generation/records/${id}`, {
    method: 'DELETE',
    body: { voidReason: '页面作废' }
  });
  if (!response.ok) {
    window.alert(`作废失败：${formatApiError(response.error)}`);
    return;
  }
  state.ledgerTab = 'generation';
  await renderLedger();
}

async function handleGenerationRecordImportPreviewSubmit(event) {
  event.preventDefault();
  const form = getSubmittedForm(event, 'ledger-generation-import-preview-form');
  const file = form?.querySelector('input[type="file"][name="file"]')?.files?.[0];
  state.generationRecordImportPreviewError = null;
  state.generationRecordImportExecuteError = null;
  state.generationRecordImportExecuteResult = null;
  state.generationRecordImportPreview = null;
  const validationMessage = validateLedgerImportFile(file, '发电自用记录');
  if (validationMessage) {
    state.generationRecordImportPreviewError = validationMessage;
    state.ledgerTab = 'generation';
    await renderLedger();
    return;
  }
  const body = new FormData();
  body.append('file', file);
  state.generationRecordImportPreviewLoading = true;
  state.ledgerTab = 'generation';
  await renderLedger();
  const response = await safeApi('/generation/records/import/preview', { method: 'POST', body });
  state.generationRecordImportPreviewLoading = false;
  if (!response.ok) {
    state.generationRecordImportPreviewError = formatApiError(response.error);
    await renderLedger();
    return;
  }
  state.generationRecordImportPreview = response.value.data || {};
  await renderLedger();
}

async function executeGenerationRecordImportFromPreview() {
  const preview = state.generationRecordImportPreview;
  const summary = preview?.summary || {};
  const candidateRowIds = Array.isArray(preview?.candidateRowIds) ? preview.candidateRowIds : [];
  if (!preview?.previewSignature || Number(summary.wouldImport || 0) <= 0 || candidateRowIds.length === 0) {
    window.alert('请先运行发电自用记录导入预演，并确认存在 wouldImport 候选后再执行。');
    return;
  }
  const confirmText = window.prompt(`受控导入会自动创建备份，并只写入最新 preview 中 wouldImport=true 的发电自用记录候选。\n\n冲突、重复、无效和阻断行会按 skip 风险处理，不覆盖、不作废旧 active 记录，不自动创建用能单元；导入只写 generation_records，不写 energy_records，不写 carbon_emissions，不影响单位产品能耗；外购电参考只读，不抵扣不入账。\n\n如确认执行，请输入固定确认文本：确认导入发电自用记录`);
  if (confirmText !== '确认导入发电自用记录') {
    window.alert('确认文本不匹配，已取消发电自用记录受控导入。');
    return;
  }
  state.generationRecordImportExecuteLoading = true;
  state.generationRecordImportExecuteError = null;
  state.generationRecordImportExecuteResult = null;
  state.ledgerTab = 'generation';
  await renderLedger();
  const response = await safeApi('/generation/records/import/execute', {
    method: 'POST',
    body: {
      confirmText,
      batchId: preview.batchId || preview.auditBatch?.id,
      previewSignature: preview.previewSignature,
      expectedWouldImport: Number(summary.wouldImport || 0),
      candidateRowIds,
      candidateRows: preview.candidateRows || [],
      previewAudit: preview.previewAudit || { summary: preview.summary || {}, items: preview.items || [] },
      previewAuditDigest: preview.previewAuditDigest,
      acknowledgeSkippedRisks: true,
      requireBackup: true
    }
  });
  state.generationRecordImportExecuteLoading = false;
  if (!response.ok) {
    state.generationRecordImportExecuteError = formatApiError(response.error);
    await renderLedger();
    return;
  }
  state.generationRecordImportExecuteResult = response.value.data || {};
  state.generationRecordImportPreview = null;
  await renderLedger();
}

async function renderLedger(edit = {}) {
  const root = getViewRoot();
  clearNode(root);
  root.append(renderLoading('正在读取基础台账...'));
  const unitQuery = toQuery({ ...state.ledgerUnitFilters, page: 1, pageSize: 500 });
  const meterQuery = toQuery({ ...state.ledgerMeterFilters, page: 1, pageSize: 500 });
  const readingQuery = toQuery({ ...state.ledgerReadingFilters, page: 1, pageSize: 100 });
  const generationQuery = toQuery({ ...state.ledgerGenerationFilters, page: 1, pageSize: 100 });
  const generationStatisticsQuery = toQuery({
    organizationUnitId: state.ledgerGenerationFilters.organizationUnitId || '',
    monthStart: state.ledgerGenerationFilters.monthStart || '',
    monthEnd: state.ledgerGenerationFilters.monthEnd || ''
  });
  const productionUnitQuery = toQuery({ ...state.ledgerProductionUnitFilters, page: 1, pageSize: 500 });
  const productionOutputQuery = toQuery({ ...state.ledgerProductionOutputFilters, page: 1, pageSize: 100 });
  const [unitsResponse, filteredUnitsResponse, metersResponse, filteredMetersResponse, readingsResponse, energyTypesResponse, generationRecordsResponse, generationStatisticsResponse, productionUnitsResponse, filteredProductionUnitsResponse, productionOutputsResponse] = await Promise.all([
    safeApi('/organization/units?page=1&pageSize=500'),
    safeApi(`/organization/units${unitQuery}`),
    safeApi('/meters?page=1&pageSize=500'),
    safeApi(`/meters${meterQuery}`),
    safeApi(`/meter-readings${readingQuery}`),
    safeApi('/energy-types'),
    safeApi(`/generation/records${generationQuery}`),
    safeApi(`/generation/statistics/monthly${generationStatisticsQuery}`),
    safeApi('/production/units?page=1&pageSize=500'),
    safeApi(`/production/units${productionUnitQuery}`),
    safeApi(`/production/outputs${productionOutputQuery}`)
  ]);
  clearNode(root);

  root.append(renderLedgerTabs());
  root.append(renderMessage('info', '本地台账边界', '本节点支持组织/用能单元、计量器具、计量抄表和产能单元基础维护；DELETE 按停用/作废处理。在线状态和网关 ID 仅为台账字段，不代表实时采集；抄表记录只有受控生成后才进入能耗统计。'));

  if (!unitsResponse.ok && !metersResponse.ok) {
    root.append(renderBackendHint(unitsResponse.error || metersResponse.error));
    return;
  }

  const units = unitsResponse.ok ? unitsResponse.value.data : [];
  const filteredUnits = filteredUnitsResponse.ok ? filteredUnitsResponse.value.data : units;
  const meters = metersResponse.ok ? metersResponse.value.data : [];
  const filteredMeters = filteredMetersResponse.ok ? filteredMetersResponse.value.data : meters;
  const readings = readingsResponse.ok ? readingsResponse.value.data : [];
  const energyTypes = energyTypesResponse.ok ? energyTypesResponse.value.data : [];
  const generationRecords = generationRecordsResponse.ok ? generationRecordsResponse.value.data : [];
  const generationMeta = generationStatisticsResponse.ok ? generationStatisticsResponse.value.meta || {} : generationRecordsResponse.value?.meta || {};
  const productionUnits = productionUnitsResponse.ok ? productionUnitsResponse.value.data : [];
  const filteredProductionUnits = filteredProductionUnitsResponse.ok ? filteredProductionUnitsResponse.value.data : productionUnits;
  const productionOutputs = productionOutputsResponse.ok ? productionOutputsResponse.value.data : [];

  if (state.ledgerTab === 'units') {
    const editingUnit = edit.type === 'unit' ? findById(units, edit.id) : null;
    root.append(createElement('section', { className: 'grid two' }, [
      unitsResponse.ok ? renderUnitForm(units, editingUnit) : renderMessage('error', '用能单元读取失败', formatApiError(unitsResponse.error)),
      renderCard('用能单元导入/导出', [
        createElement('p', { className: 'muted', text: 'unit_path 由服务端根据父级和名称自动生成，使用 / 连接；导入能耗数据时会按 unit_path、unit_code、unit_name 精确弱关联。批量导入默认 duplicateStrategy=skip，重复行会作为 warning 展示。' }),
        renderKeyValueList([
          { label: '删除策略', value: 'DELETE 默认停用，不物理删除历史引用。' },
          { label: '类型白名单', value: 'enterprise / department / workshop / process / equipment' }
        ]),
        renderTemplateActions([{ type: 'organization-units', label: '下载用能单元导入模板（Excel）' }]),
        createElement('form', { id: 'ledger-unit-import-form', className: 'form-card' }, [
          createElement('label', { className: 'field' }, [
            createElement('span', { text: '导入用能单元文件（.xlsx / .xls / .csv）' }),
            createElement('input', { type: 'file', name: 'file', accept: '.xlsx,.xls,.csv' })
          ]),
          createElement('div', { className: 'template-actions' }, [
            createElement('button', { type: 'submit', className: 'btn btn-primary', text: '导入用能单元' }),
            createElement('button', { type: 'button', className: 'btn btn-ghost', text: '导出当前筛选', dataset: { action: 'export-ledger-units' } })
          ]),
          renderLedgerImportPanel('units', state.ledgerImportResults.units)
        ])
      ])
    ]));
    const unitTypeFilterOptions = [
      { value: '', label: '全部类型' },
      { value: 'enterprise', label: 'enterprise：企业' },
      { value: 'department', label: 'department：部门' },
      { value: 'workshop', label: 'workshop：车间' },
      { value: 'process', label: 'process：工序' },
      { value: 'equipment', label: 'equipment：设备' }
    ];
    root.append(renderFilterRow('ledger-units', [
      { name: 'keyword', label: '关键词', value: state.ledgerUnitFilters.keyword || '', placeholder: '编码/名称/路径' },
      { name: 'unitType', label: '类型', type: 'select', value: state.ledgerUnitFilters.unitType || '', options: unitTypeFilterOptions },
      { name: 'status', label: '状态', type: 'select', value: state.ledgerUnitFilters.status || '', options: [{ value: '', label: '全部状态' }, { value: 'active', label: 'active：启用' }, { value: 'inactive', label: 'inactive：停用' }] },
      { name: 'parentId', label: '父级', type: 'select', value: state.ledgerUnitFilters.parentId || '', options: getLedgerUnitOptions(units, true, '全部父级') }
    ]));
    root.append(renderCard('用能单元列表', [
      filteredUnitsResponse.ok ? renderTable([
        { key: 'unitCode', label: '编码' },
        { key: 'unitName', label: '名称' },
        { key: 'unitPath', label: '路径' },
        { key: 'unitType', label: '类型' },
        { key: 'area', label: '面积', render: (row) => createElement('span', { text: row.area === null ? '-' : formatNumber(row.area) }) },
        { key: 'status', label: '状态', render: (row) => renderStatusPill(row.status) },
        { key: 'actions', label: '操作', render: renderLedgerUnitActions }
      ], filteredUnits, '暂无用能单元。请使用上方表单新增企业、部门、车间、工序或设备层级。') : renderMessage('error', '用能单元列表读取失败', formatApiError(filteredUnitsResponse.error))
    ]));
    return;
  }

  if (state.ledgerTab === 'meters') {
    const editingMeter = edit.type === 'meter' ? findById(meters, edit.id) : null;
    root.append(createElement('section', { className: 'grid two' }, [
      metersResponse.ok ? renderMeterForm(units, energyTypes, editingMeter) : renderMessage('error', '计量器具读取失败', formatApiError(metersResponse.error)),
      renderCard('计量器具导入/导出', [
      createElement('p', { className: 'muted', text: '计量器具必须关联 active 用能单元和 active 能源类型；被能耗记录引用后不能修改能源类型，停用不影响历史记录。批量导入默认 duplicateStrategy=skip，重复仪表编码会作为 warning 展示。' }),
      renderKeyValueList([
        { label: '弱关联规则', value: '能耗导入按 meter_code 或 用能单元 + meter_name 精确匹配；能源类型不一致不关联。' },
        { label: '本地版降级', value: 'online_status 与 gateway_id 仅记录台账信息。' }
        ]),
      renderTemplateActions([{ type: 'meters', label: '下载计量器具导入模板（Excel）' }]),
      createElement('form', { id: 'ledger-meter-import-form', className: 'form-card' }, [
        createElement('label', { className: 'field' }, [
          createElement('span', { text: '导入计量器具文件（.xlsx / .xls / .csv）' }),
          createElement('input', { type: 'file', name: 'file', accept: '.xlsx,.xls,.csv' })
        ]),
        createElement('div', { className: 'template-actions' }, [
          createElement('button', { type: 'submit', className: 'btn btn-primary', text: '导入计量器具' }),
          createElement('button', { type: 'button', className: 'btn btn-ghost', text: '导出当前筛选', dataset: { action: 'export-ledger-meters' } })
        ]),
        renderLedgerImportPanel('meters', state.ledgerImportResults.meters)
      ])
      ])
    ]));
    const meterTypeFilterOptions = [
      { value: '', label: '全部类型' },
      { value: 'electricity', label: 'electricity：电表' },
      { value: 'gas', label: 'gas：气表' },
      { value: 'heat', label: 'heat：热量表' },
      { value: 'water', label: 'water：水表' },
      { value: 'other', label: 'other：其他' }
    ];
    root.append(renderFilterRow('ledger-meters', [
      { name: 'keyword', label: '关键词', value: state.ledgerMeterFilters.keyword || '', placeholder: '编码/名称/用能单元' },
      { name: 'meterType', label: '仪表类型', type: 'select', value: state.ledgerMeterFilters.meterType || '', options: meterTypeFilterOptions },
      { name: 'energyTypeId', label: '能源类型', type: 'select', value: state.ledgerMeterFilters.energyTypeId || '', options: [{ value: '', label: '全部能源类型' }].concat(getEnergyTypeOptions(energyTypes)) },
      { name: 'organizationUnitId', label: '用能单元', type: 'select', value: state.ledgerMeterFilters.organizationUnitId || '', options: getLedgerUnitOptions(units.filter((unit) => unit.status === 'active'), true, '全部用能单元') },
      { name: 'onlineStatus', label: '在线状态', type: 'select', value: state.ledgerMeterFilters.onlineStatus || '', options: [{ value: '', label: '全部在线状态' }, { value: 'online', label: 'online：在线' }, { value: 'offline', label: 'offline：离线' }, { value: 'unknown', label: 'unknown：未知' }] },
      { name: 'status', label: '状态', type: 'select', value: state.ledgerMeterFilters.status || '', options: [{ value: '', label: '全部状态' }, { value: 'active', label: 'active：启用' }, { value: 'inactive', label: 'inactive：停用' }] }
    ]));
    root.append(renderCard('计量器具列表', [
      filteredMetersResponse.ok ? renderTable([
      { key: 'meterCode', label: '编码' },
      { key: 'meterName', label: '名称' },
      { key: 'meterType', label: '类型' },
      { key: 'energyTypeName', label: '能源类型' },
      { key: 'organizationUnitPath', label: '用能单元' },
      { key: 'onlineStatus', label: '在线状态' },
      { key: 'gatewayId', label: '网关 ID' },
      { key: 'multiplier', label: '倍率', render: (row) => createElement('span', { text: formatNumber(row.multiplier, 6) }) },
      { key: 'status', label: '状态', render: (row) => renderStatusPill(row.status) },
      { key: 'actions', label: '操作', render: renderLedgerMeterActions }
      ], filteredMeters, '暂无计量器具。请先创建用能单元，再新增电表、气表、热量表等台账。') : renderMessage('error', '计量器具列表读取失败', formatApiError(filteredMetersResponse.error))
    ]));
    return;
  }

  if (state.ledgerTab === 'generation') {
    const editingGenerationRecord = edit.type === 'generation' ? findById(generationRecords, edit.id) : null;
    root.append(createElement('section', { className: 'grid two' }, [
      unitsResponse.ok ? renderGenerationForm(units, editingGenerationRecord) : renderMessage('error', '用能单元读取失败', formatApiError(unitsResponse.error)),
      renderGenerationBoundaryCard(generationMeta)
    ]));
    root.append(renderMessage('info', '发电自发自用导入/导出口径', '本页支持 photovoltaic / 光伏发电记录页面录入、编辑、作废、查询、汇总，以及模板下载、当前筛选导出、上传 preview 和固定确认文本受控 execute；导入/导出只维护 generation_records，不写 energy_records，不写 carbon_emissions，不影响单位产品能耗；外购电参考只读，不抵扣不入账。'));
    root.append(renderGenerationRecordImportPanel());
    root.append(renderFilterRow('ledger-generation', [
      { name: 'organizationUnitId', label: '用能单元', type: 'select', value: state.ledgerGenerationFilters.organizationUnitId || '', options: getLedgerUnitOptions(units.filter((unit) => unit.status === 'active'), true, '全部用能单元') },
      { name: 'monthStart', label: '开始月份', type: 'month', value: state.ledgerGenerationFilters.monthStart || '' },
      { name: 'monthEnd', label: '结束月份', type: 'month', value: state.ledgerGenerationFilters.monthEnd || '' },
      { name: 'recordStatus', label: '状态', type: 'select', value: state.ledgerGenerationFilters.recordStatus || '', options: [{ value: '', label: '全部状态' }, { value: 'active', label: 'active：有效' }, { value: 'void', label: 'void：作废' }] }
    ]));
    root.append(renderGenerationSummaryCard(generationStatisticsResponse));
    root.append(renderCard('发电记录列表', [
      generationRecordsResponse.ok ? renderTable([
        { key: 'normalizedMonth', label: '月份' },
        { key: 'organizationUnitPath', label: '用能单元', render: (row) => createElement('span', { text: formatText(row.organizationUnitPath || row.organizationUnitName || row.organizationUnitCode) }) },
        { key: 'generationValueKwh', label: '发电量', render: (row) => createElement('span', { text: `${formatNumber(row.generationValueKwh, 6)} kWh` }) },
        { key: 'selfUseValueKwh', label: '自发自用', render: (row) => createElement('span', { text: `${formatNumber(row.selfUseValueKwh, 6)} kWh` }) },
        { key: 'gridExportValueKwh', label: '上网电量', render: (row) => createElement('span', { text: `${formatNumber(row.gridExportValueKwh, 6)} kWh` }) },
        { key: 'selfUseRate', label: '自用率', render: (row) => createElement('span', { text: formatPercent(row.selfUseRate) }) },
        { key: 'gridExportRate', label: '上网率', render: (row) => createElement('span', { text: formatPercent(row.gridExportRate) }) },
        { key: 'recordStatus', label: '状态', render: (row) => renderStatusPill(row.recordStatus) },
        { key: 'remark', label: '备注', render: (row) => createElement('span', { text: formatText(row.remark) }) },
        { key: 'actions', label: '操作', render: renderGenerationActions }
      ], generationRecords, '暂无发电记录。请先在上方新增光伏发电、自发自用和上网电量。') : renderMessage('error', '发电记录读取失败', formatApiError(generationRecordsResponse.error))
    ]));
    return;
  }

  if (state.ledgerTab === 'production') {
    const editingProductionUnit = edit.type === 'production-unit' ? findById(productionUnits, edit.id) : null;
    const editingProductionOutput = edit.type === 'production-output' ? findById(productionOutputs, edit.id) : null;
    const defaultProductionUnit = productionUnits.find((unit) => unit.status === 'active') || productionUnits[0] || null;
    const selectedProductionUnitId = state.ledgerProductionIntensityFilters.productionUnitId || defaultProductionUnit?.id || '';
    const intensityQuery = selectedProductionUnitId
      ? toQuery({ productionUnitId: selectedProductionUnitId, monthStart: state.ledgerProductionIntensityFilters.monthStart || '', monthEnd: state.ledgerProductionIntensityFilters.monthEnd || '' })
      : '';
    const intensityResponse = selectedProductionUnitId ? await safeApi(`/production/statistics/unit-energy-intensity${intensityQuery}`) : null;

    root.append(createElement('section', { className: 'grid two' }, [
      unitsResponse.ok ? renderProductionUnitForm(units, editingProductionUnit) : renderMessage('error', '用能单元读取失败', formatApiError(unitsResponse.error)),
      productionUnitsResponse.ok ? renderProductionOutputForm(productionUnits, editingProductionOutput) : renderMessage('error', '产能单元读取失败', formatApiError(productionUnitsResponse.error))
    ]));
    root.append(renderMessage('info', 'P2 产能单元首期口径', '本页首期维护产能单元 + 月度产量 + 单位产品能耗；本轮新增月度产量模板下载、当前筛选导出、导入 preview 和固定确认文本受控 execute。单位产品能耗分子为所属用能单元当月 active energy_records 汇总；发电自用已独立维护但不纳入单位产品能耗；碳核算联动后置。'));
    root.append(renderProductionOutputImportPanel());
    root.append(renderFilterRow('ledger-production-units', [
      { name: 'keyword', label: '产能单元关键词', value: state.ledgerProductionUnitFilters.keyword || '', placeholder: '编码/名称/产品/用能单元' },
      { name: 'organizationUnitId', label: '所属用能单元', type: 'select', value: state.ledgerProductionUnitFilters.organizationUnitId || '', options: getLedgerUnitOptions(units.filter((unit) => unit.status === 'active'), true, '全部用能单元') },
      { name: 'status', label: '状态', type: 'select', value: state.ledgerProductionUnitFilters.status || '', options: [{ value: '', label: '全部状态' }, { value: 'active', label: 'active：启用' }, { value: 'inactive', label: 'inactive：停用' }] }
    ]));
    root.append(renderCard('产能单元列表', [
      filteredProductionUnitsResponse.ok ? renderTable([
        { key: 'unitCode', label: '编码' },
        { key: 'unitName', label: '名称' },
        { key: 'organizationUnitPath', label: '所属用能单元' },
        { key: 'productName', label: '产品名称' },
        { key: 'outputUnit', label: '产量单位' },
        { key: 'status', label: '状态', render: (row) => renderStatusPill(row.status) },
        { key: 'remark', label: '备注' },
        { key: 'actions', label: '操作', render: renderProductionUnitActions }
      ], filteredProductionUnits, '暂无产能单元。请先在上方新增产能单元，并确保所属用能单元为 active。') : renderMessage('error', '产能单元列表读取失败', formatApiError(filteredProductionUnitsResponse.error))
    ]));
    root.append(renderFilterRow('ledger-production-outputs', [
      { name: 'productionUnitId', label: '产能单元', type: 'select', value: state.ledgerProductionOutputFilters.productionUnitId || '', options: getProductionUnitOptions(productionUnits, true, '全部产能单元') },
      { name: 'monthStart', label: '开始月份', type: 'month', value: state.ledgerProductionOutputFilters.monthStart || '' },
      { name: 'monthEnd', label: '结束月份', type: 'month', value: state.ledgerProductionOutputFilters.monthEnd || '' },
      { name: 'status', label: '记录状态', type: 'select', value: state.ledgerProductionOutputFilters.status || '', options: [{ value: '', label: '全部状态' }, { value: 'active', label: 'active：有效' }, { value: 'void', label: 'void：作废' }] }
    ]));
    root.append(renderCard('月度产量列表', [
      productionOutputsResponse.ok ? renderTable([
        { key: 'normalizedMonth', label: '月份' },
        { key: 'productionUnitName', label: '产能单元', render: (row) => createElement('span', { text: `${formatText(row.productionUnitName)}（${formatText(row.productionUnitCode)}）` }) },
        { key: 'outputValue', label: '产量值', render: (row) => createElement('span', { text: `${formatNumber(row.outputValue, 6)} ${formatText(row.outputUnit, '')}` }) },
        { key: 'dataSource', label: '数据来源' },
        { key: 'recordStatus', label: '状态', render: (row) => renderStatusPill(row.recordStatus) },
        { key: 'remark', label: '备注' },
        { key: 'actions', label: '操作', render: renderProductionOutputActions }
      ], productionOutputs, '暂无月度产量。请先选择产能单元并维护月份、产量值、产量单位和来源。') : renderMessage('error', '月度产量读取失败', formatApiError(productionOutputsResponse.error))
    ]));
    root.append(renderFilterRow('ledger-production-intensity', [
      { name: 'productionUnitId', label: '统计产能单元', type: 'select', value: selectedProductionUnitId || '', options: getProductionUnitOptions(productionUnits, true, '请选择产能单元') },
      { name: 'monthStart', label: '开始月份', type: 'month', value: state.ledgerProductionIntensityFilters.monthStart || '' },
      { name: 'monthEnd', label: '结束月份', type: 'month', value: state.ledgerProductionIntensityFilters.monthEnd || '' }
    ]));
    root.append(renderProductionIntensityCard(intensityResponse, selectedProductionUnitId));
    return;
  }

  const editingReading = edit.type === 'reading' ? findById(readings, edit.id) : null;
  const activeMeters = meters.filter((meter) => meter.status === 'active');
  const energyTypeFilterOptions = [{ value: '', label: '全部能源类型' }].concat((energyTypes || []).map((type) => ({ value: type.code, label: `${type.name}（${type.code}）` })));
  root.append(createElement('section', { className: 'grid two' }, [
    metersResponse.ok ? renderMeterReadingForm(activeMeters, editingReading) : renderMessage('error', '计量器具读取失败', formatApiError(metersResponse.error)),
    renderCard('计量抄表说明', [
      createElement('p', { className: 'muted', text: '抄表记录用于记录上期表码、本期表码、倍率、用量和单位。后端会按仪表能源类型标准化单位；本节点暂不自动生成或回填 energy_records。' }),
      renderKeyValueList([
        { label: '删除策略', value: 'DELETE 作废记录，record_status 改为 void，不物理删除。' },
        { label: '计算规则', value: 'usageValue 为空时按（本期表码 - 上期表码）× 倍率计算；手动填写时校验非负后保存。' },
        { label: '只读追溯', value: '列表仅展示同仪表、同月份、同能源类型的疑似能耗记录数量；不会自动生成、回填或纳入统计。' },
        { label: '导入导出', value: '模板下载、批量导入和导出当前筛选结果均不会让抄表记录自动进入能耗统计。' }
      ]),
      renderTemplateActions([{ type: 'meter-readings', label: '下载抄表导入模板（Excel）' }]),
      createElement('form', { id: 'ledger-reading-import-form', className: 'form-card' }, [
        createElement('label', { className: 'field' }, [
          createElement('span', { text: '导入抄表文件（.xlsx / .xls / .csv）' }),
          createElement('input', { type: 'file', name: 'file', accept: '.xlsx,.xls,.csv' })
        ]),
        createElement('div', { className: 'template-actions' }, [
          createElement('button', { type: 'submit', className: 'btn btn-primary', text: '导入抄表' }),
          createElement('button', { type: 'button', className: 'btn btn-ghost', text: '导出当前筛选', dataset: { action: 'export-ledger-readings' } })
        ]),
        createElement('div', { id: 'ledger-reading-import-result', className: 'inline-result', 'aria-live': 'polite' })
      ])
    ])
  ]));
  root.append(renderMeterReadingGenerationCard());
  root.append(renderFilterRow('ledger-readings', [
    { name: 'organizationUnitId', label: '用能单元', type: 'select', value: state.ledgerReadingFilters.organizationUnitId || '', options: getLedgerUnitOptions(units.filter((unit) => unit.status === 'active'), true, '全部用能单元') },
    { name: 'meterId', label: '计量器具', type: 'select', value: state.ledgerReadingFilters.meterId || '', options: getLedgerMeterOptions(activeMeters, true) },
    { name: 'energyTypeCode', label: '能源类型', type: 'select', value: state.ledgerReadingFilters.energyTypeCode || '', options: energyTypeFilterOptions },
    { name: 'monthStart', label: '开始月份', type: 'month', value: state.ledgerReadingFilters.monthStart || '' },
    { name: 'monthEnd', label: '结束月份', type: 'month', value: state.ledgerReadingFilters.monthEnd || '' }
  ]));
  root.append(renderCard('计量抄表列表', [
    readingsResponse.ok ? renderTable([
      { key: 'readingDate', label: '抄表日期' },
      { key: 'meterName', label: '计量器具', render: (row) => createElement('span', { text: `${formatText(row.meterName)}（${formatText(row.meterCode)}）` }) },
      { key: 'organizationUnitPath', label: '用能单元' },
      { key: 'energyTypeName', label: '能源类型' },
      { key: 'currentValue', label: '表码', render: (row) => createElement('span', { text: `${formatNumber(row.previousValue, 6)} → ${formatNumber(row.currentValue, 6)}` }) },
      { key: 'usageValue', label: '用量', render: (row) => createElement('span', { text: `${formatNumber(row.usageValue, 6)} ${formatText(row.originalUnit, '')}` }) },
      { key: 'normalizedUsageValue', label: '标准化用量', render: (row) => createElement('span', { text: `${formatNumber(row.normalizedUsageValue, 6)} ${formatText(row.normalizedUnit, '')}` }) },
      { key: 'energyTrace', label: '能耗追溯', render: renderMeterReadingTrace },
      { key: 'recordStatus', label: '状态', render: (row) => renderStatusPill(row.recordStatus) },
      { key: 'actions', label: '操作', render: renderMeterReadingActions }
    ], readings, '暂无计量抄表记录。请先确认计量器具允许手工抄表，再使用上方表单补录。') : renderMessage('error', '计量抄表读取失败', formatApiError(readingsResponse.error))
  ]));
}

async function runEnergyLedgerBackfillPreview() {
  state.energyLedgerBackfillPreviewLoading = true;
  state.energyLedgerBackfillPreviewError = null;
  state.energyLedgerBackfillExecuteError = null;
  state.energyLedgerBackfillExecuteResult = null;
  state.energyLedgerBackfillPreview = null;
  await renderEnergy();
  const query = toQuery({ ...state.energyFilters, limit: 100, detailLimit: 100 });
  const response = await safeApi(`/energy-records/ledger-backfill/preview${query}`);
  state.energyLedgerBackfillPreviewLoading = false;
  if (!response.ok) {
    state.energyLedgerBackfillPreviewError = formatApiError(response.error);
    await renderEnergy();
    return;
  }
  state.energyLedgerBackfillPreview = response.value.data || {};
  await renderEnergy();
}

async function runMeterReadingGenerationPreview() {
  state.meterReadingGenerationPreviewLoading = true;
  state.meterReadingGenerationPreviewError = null;
  state.meterReadingGenerationExecuteError = null;
  state.meterReadingGenerationExecuteResult = null;
  state.meterReadingGenerationPreview = null;
  state.ledgerTab = 'readings';
  await renderLedger();
  const query = toQuery({ ...state.ledgerReadingFilters, detailLimit: 500 });
  const response = await safeApi(`/meter-readings/energy-record-generation/preview${query}`);
  state.meterReadingGenerationPreviewLoading = false;
  if (!response.ok) {
    state.meterReadingGenerationPreviewError = formatApiError(response.error);
    await renderLedger();
    return;
  }
  state.meterReadingGenerationPreview = response.value.data || {};
  await renderLedger();
}

async function exportMeterReadingGenerationPreview() {
  const query = toQuery({ ...state.ledgerReadingFilters, format: 'xlsx', detailLimit: 500 });
  await downloadLedgerExport(`/meter-readings/energy-record-generation/preview/export${query}`, '抄表生成能耗记录预演审计预案.xlsx', '抄表生成能耗记录审计预案下载已触发', '抄表生成能耗记录审计预案下载');
}

async function executeMeterReadingGeneration() {
  const preview = state.meterReadingGenerationPreview;
  const summary = preview?.summary || {};
  const candidateReadingIds = Array.isArray(preview?.candidateReadingIds) ? preview.candidateReadingIds : [];
  if (!preview?.previewSignature || Number(summary.wouldGenerate || 0) <= 0 || candidateReadingIds.length === 0) {
    window.alert('请先运行抄表生成预演，并确认存在 wouldGenerate 候选后再执行。');
    return;
  }
  const confirmText = window.prompt(`受控生成会自动创建备份，并只将最新 preview 中 wouldGenerate=true 的抄表记录写入 active energy_records。\n\n生成后会立即纳入能耗统计；碳核算联动后置。本次会跳过冲突、作废、已 generated、台账/字段缺失和阻断记录，不覆盖、不删除既有 energy_records。\n\n如确认执行，请输入固定确认文本：确认由抄表生成能耗记录`);
  if (confirmText !== '确认由抄表生成能耗记录') {
    window.alert('确认文本不匹配，已取消受控生成。');
    return;
  }
  state.meterReadingGenerationExecuteLoading = true;
  state.meterReadingGenerationExecuteError = null;
  state.meterReadingGenerationExecuteResult = null;
  state.ledgerTab = 'readings';
  await renderLedger();
  const response = await safeApi('/meter-readings/energy-record-generation/execute', {
    method: 'POST',
    body: {
      confirmText,
      previewSignature: preview.previewSignature,
      expectedWouldGenerate: Number(summary.wouldGenerate || 0),
      candidateReadingIds,
      filters: preview.filters || state.ledgerReadingFilters || {},
      acknowledgeSkippedRisks: true,
      requireBackup: true
    }
  });
  state.meterReadingGenerationExecuteLoading = false;
  if (!response.ok) {
    state.meterReadingGenerationExecuteError = formatApiError(response.error);
    await renderLedger();
    return;
  }
  state.meterReadingGenerationExecuteResult = response.value.data || {};
  state.meterReadingGenerationPreview = null;
  await renderLedger();
}

async function handleLedgerUnitSubmit(event) {
  event.preventDefault();
  const form = getSubmittedForm(event, 'ledger-unit-form');
  const resultBox = getInlineResultBox('#ledger-unit-result');
  clearNode(resultBox);
  const payload = collectFormValues(form);
  const id = payload.id;
  delete payload.id;
  const response = await safeApi(id ? `/organization/units/${id}` : '/organization/units', { method: id ? 'PUT' : 'POST', body: payload });
  if (!response.ok) {
    resultBox.append(renderMessage('error', '用能单元保存失败', formatApiError(response.error)));
    return;
  }
  await renderLedger();
}

async function handleLedgerMeterSubmit(event) {
  event.preventDefault();
  const form = getSubmittedForm(event, 'ledger-meter-form');
  const resultBox = getInlineResultBox('#ledger-meter-result');
  clearNode(resultBox);
  const payload = collectFormValues(form);
  const id = payload.id;
  delete payload.id;
  const response = await safeApi(id ? `/meters/${id}` : '/meters', { method: id ? 'PUT' : 'POST', body: payload });
  if (!response.ok) {
    resultBox.append(renderMessage('error', '计量器具保存失败', formatApiError(response.error)));
    return;
  }
  await renderLedger();
}

async function handleMeterReadingSubmit(event) {
  event.preventDefault();
  const form = getSubmittedForm(event, 'ledger-reading-form');
  const resultBox = getInlineResultBox('#ledger-reading-result');
  clearNode(resultBox);
  const payload = collectFormValues(form);
  const id = payload.id;
  delete payload.id;
  const response = await safeApi(id ? `/meter-readings/${id}` : '/meter-readings', { method: id ? 'PUT' : 'POST', body: payload });
  if (!response.ok) {
    resultBox.append(renderMessage('error', '抄表记录保存失败', formatApiError(response.error)));
    return;
  }
  await renderLedger();
}

async function handleProductionUnitSubmit(event) {
  event.preventDefault();
  const form = getSubmittedForm(event, 'ledger-production-unit-form');
  const resultBox = getInlineResultBox('#ledger-production-unit-result');
  clearNode(resultBox);
  const payload = collectFormValues(form);
  const id = payload.id;
  delete payload.id;
  if (!payload.organizationUnitId) {
    resultBox.append(renderMessage('error', '缺少所属用能单元', '新增产能单元前，请先在“用能单元”页签新增或启用 active 用能单元，并选择所属用能单元。'));
    return;
  }
  const response = await safeApi(id ? `/production/units/${id}` : '/production/units', { method: id ? 'PUT' : 'POST', body: payload });
  if (!response.ok) {
    resultBox.append(renderMessage('error', '产能单元保存失败', formatApiError(response.error)));
    return;
  }
  state.ledgerProductionIntensityFilters.productionUnitId = payload.status === 'inactive' ? state.ledgerProductionIntensityFilters.productionUnitId : (id || response.value.data?.id || state.ledgerProductionIntensityFilters.productionUnitId);
  await renderLedger();
}

async function handleProductionOutputImportPreviewSubmit(event) {
  event.preventDefault();
  const form = getSubmittedForm(event, 'production-output-import-preview-form');
  const fileInput = form?.querySelector('input[type="file"][name="file"]');
  const file = fileInput?.files?.[0];
  state.productionOutputImportPreviewError = null;
  state.productionOutputImportExecuteError = null;
  state.productionOutputImportExecuteResult = null;
  state.productionOutputImportPreview = null;
  if (!file) {
    state.productionOutputImportPreviewError = '请先选择 .xlsx / .xls / .csv 月度产量导入文件。';
    state.ledgerTab = 'production';
    await renderLedger();
    return;
  }
  const body = new FormData();
  body.append('file', file);
  state.productionOutputImportPreviewLoading = true;
  state.ledgerTab = 'production';
  await renderLedger();
  const response = await safeApi('/production/outputs/import/preview', { method: 'POST', body });
  state.productionOutputImportPreviewLoading = false;
  if (!response.ok) {
    state.productionOutputImportPreviewError = formatApiError(response.error);
    await renderLedger();
    return;
  }
  state.productionOutputImportPreview = response.value.data || {};
  await renderLedger();
}

async function executeProductionOutputImport() {
  const preview = state.productionOutputImportPreview;
  const summary = preview?.summary || {};
  const candidateRowIds = Array.isArray(preview?.candidateRowIds) ? preview.candidateRowIds : [];
  if (!preview?.previewSignature || Number(summary.wouldImport || 0) <= 0 || candidateRowIds.length === 0) {
    window.alert('请先运行月度产量导入预演，并确认存在 wouldImport 候选后再执行。');
    return;
  }
  const confirmText = window.prompt(`受控导入会自动创建备份，并只写入最新 preview 中 wouldImport=true 的月度产量候选。\n\n已有 active 产量冲突、重复候选、无效行和阻断行均会 skipped，不覆盖、不作废旧记录，不自动创建产能单元。\n\n如确认执行，请输入固定确认文本：确认导入月度产量记录`);
  if (confirmText !== '确认导入月度产量记录') {
    window.alert('确认文本不匹配，已取消月度产量受控导入。');
    return;
  }
  state.productionOutputImportExecuteLoading = true;
  state.productionOutputImportExecuteError = null;
  state.productionOutputImportExecuteResult = null;
  state.ledgerTab = 'production';
  await renderLedger();
  const response = await safeApi('/production/outputs/import/execute', {
    method: 'POST',
    body: {
      confirmText,
      batchId: preview.batchId || preview.auditBatch?.id,
      previewSignature: preview.previewSignature,
      expectedWouldImport: Number(summary.wouldImport || 0),
      candidateRowIds,
      candidateRows: preview.candidateRows || [],
      acknowledgeSkippedRisks: true,
      requireBackup: true
    }
  });
  state.productionOutputImportExecuteLoading = false;
  if (!response.ok) {
    state.productionOutputImportExecuteError = formatApiError(response.error);
    await renderLedger();
    return;
  }
  state.productionOutputImportExecuteResult = response.value.data || {};
  state.productionOutputImportPreview = null;
  state.ledgerProductionOutputFilters.productionUnitId = state.ledgerProductionOutputFilters.productionUnitId || '';
  await renderLedger();
}

async function handleProductionOutputSubmit(event) {
  event.preventDefault();
  const form = getSubmittedForm(event, 'ledger-production-output-form');
  const resultBox = getInlineResultBox('#ledger-production-output-result');
  clearNode(resultBox);
  const payload = collectFormValues(form);
  const id = payload.id;
  delete payload.id;
  if (!payload.productionUnitId) {
    resultBox.append(renderMessage('error', '缺少产能单元', '新增月度产量前，请先新增或启用 active 产能单元，并选择产能单元。'));
    return;
  }
  const response = await safeApi(id ? `/production/outputs/${id}` : '/production/outputs', { method: id ? 'PUT' : 'POST', body: payload });
  if (!response.ok) {
    resultBox.append(renderMessage('error', '月度产量保存失败', formatApiError(response.error)));
    return;
  }
  state.ledgerProductionOutputFilters.productionUnitId = payload.productionUnitId || state.ledgerProductionOutputFilters.productionUnitId;
  state.ledgerProductionIntensityFilters.productionUnitId = payload.productionUnitId || state.ledgerProductionIntensityFilters.productionUnitId;
  await renderLedger();
}

async function deactivateProductionUnit(id, name) {
  const confirmed = window.confirm(`确认停用产能单元 ${name || id}？\n\n停用不会物理删除产能单元，也不会删除历史月度产量；后续 active 产量新增将受 active 产能单元校验限制。`);
  if (!confirmed) return;
  const response = await safeApi(`/production/units/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    window.alert(`停用失败：${formatApiError(response.error)}`);
    return;
  }
  await renderLedger();
}

async function voidProductionOutput(id, name) {
  const confirmed = window.confirm(`确认作废月度产量 ${name || id}？\n\n作废不会物理删除记录；该记录不再作为单位产品能耗分母。`);
  if (!confirmed) return;
  const response = await safeApi(`/production/outputs/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    window.alert(`作废失败：${formatApiError(response.error)}`);
    return;
  }
  await renderLedger();
}

function refreshProductionOutputUnitDefault(select) {
  const form = select.closest('#ledger-production-output-form');
  if (!form) return;
  const selectedOption = select.selectedOptions?.[0];
  const outputUnitInput = form.elements.outputUnit;
  if (selectedOption && outputUnitInput && !outputUnitInput.value.trim()) {
    outputUnitInput.value = selectedOption.dataset.outputUnit || '';
  }
}

async function deactivateLedgerUnit(id, name) {
  const confirmed = window.confirm(`确认停用用能单元 ${name || id}？\n\n停用不会物理删除历史能耗记录或计量器具引用。`);
  if (!confirmed) return;
  const response = await safeApi(`/organization/units/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    window.alert(`停用失败：${formatApiError(response.error)}`);
    return;
  }
  await renderLedger();
}

async function deactivateLedgerMeter(id, name) {
  const confirmed = window.confirm(`确认停用计量器具 ${name || id}？\n\n停用不会物理删除历史能耗记录引用。`);
  if (!confirmed) return;
  const response = await safeApi(`/meters/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    window.alert(`停用失败：${formatApiError(response.error)}`);
    return;
  }
  await renderLedger();
}

async function voidMeterReading(id, name) {
  const confirmed = window.confirm(`确认作废抄表记录 ${name || id}？\n\n作废不会物理删除记录，也不会影响当前能耗统计。`);
  if (!confirmed) return;
  const response = await safeApi(`/meter-readings/${id}`, { method: 'DELETE' });
  if (!response.ok) {
    window.alert(`作废失败：${formatApiError(response.error)}`);
    return;
  }
  await renderLedger();
}

function validateLedgerImportFile(file, noun) {
  if (!file) {
    return `请先选择 .xlsx / .xls / .csv ${noun}导入文件。`;
  }
  const lowerFileName = String(file.name || '').toLowerCase();
  const matchedExtension = IMPORT_ALLOWED_EXTENSIONS.find((extension) => lowerFileName.endsWith(extension));
  if (!matchedExtension) {
    return `当前仅支持 ${IMPORT_ALLOWED_EXTENSIONS.join(' / ')}，请重新选择${noun}表格文件。`;
  }
  if (file.size > IMPORT_MAX_FILE_SIZE_BYTES) {
    return '导入文件最大 10MB，请压缩或拆分后重新上传。';
  }
  return '';
}

async function handleLedgerImportSubmit(event, config) {
  event.preventDefault();
  const form = getSubmittedForm(event, config.formId);
  const resultBox = getInlineResultBox(config.resultSelector);
  clearNode(resultBox);
  const file = getFormControl(form, 'file')?.files?.[0];
  const validationMessage = validateLedgerImportFile(file, config.noun);
  if (validationMessage) {
    resultBox.append(renderMessage('error', '导入文件无效', validationMessage));
    return;
  }
  const submitButton = form?.querySelector('button[type="submit"]');
  const originalButtonText = submitButton ? submitButton.textContent : `导入${config.noun}`;
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = '导入中...';
  }
  const body = new FormData();
  body.append('file', file);
  body.append('duplicateStrategy', 'skip');
  resultBox.append(renderLoading(`正在导入${config.noun}文件 ${file.name}...`));
  const response = await safeApi(config.importPath, { method: 'POST', body });
  if (submitButton) {
    submitButton.disabled = false;
    submitButton.textContent = originalButtonText;
  }
  clearNode(resultBox);
  if (!response.ok) {
    resultBox.append(renderMessage('error', `${config.noun}导入失败`, formatApiError(response.error)));
    return;
  }
  const batch = response.value.data || {};
  state.ledgerImportResults[config.kind] = batch;
  await renderLedger();
}

async function handleLedgerUnitImportSubmit(event) {
  await handleLedgerImportSubmit(event, {
    kind: 'units',
    noun: '用能单元',
    formId: 'ledger-unit-import-form',
    resultSelector: '#ledger-unit-import-result',
    importPath: '/organization/units/import'
  });
}

async function handleLedgerMeterImportSubmit(event) {
  await handleLedgerImportSubmit(event, {
    kind: 'meters',
    noun: '计量器具',
    formId: 'ledger-meter-import-form',
    resultSelector: '#ledger-meter-import-result',
    importPath: '/meters/import'
  });
}

async function handleMeterReadingImportSubmit(event) {
  event.preventDefault();
  const form = getSubmittedForm(event, 'ledger-reading-import-form');
  const resultBox = getInlineResultBox('#ledger-reading-import-result');
  clearNode(resultBox);
  const file = getFormControl(form, 'file')?.files?.[0];
  if (!file) {
    resultBox.append(renderMessage('error', '请选择文件', '请先选择 .xlsx / .xls / .csv 抄表导入文件。'));
    return;
  }
  const body = new FormData();
  body.append('file', file);
  body.append('duplicateStrategy', 'skip');
  resultBox.append(renderLoading(`正在导入抄表文件 ${file.name}...`));
  const response = await safeApi('/meter-readings/import', { method: 'POST', body });
  clearNode(resultBox);
  if (!response.ok) {
    resultBox.append(renderMessage('error', '抄表导入失败', formatApiError(response.error)));
    return;
  }
  const batch = response.value.data || {};
  const errors = Array.isArray(batch.errors) ? batch.errors : [];
  resultBox.append(renderMessage(batch.status === 'failed' ? 'error' : 'success', '抄表导入完成', `批次 ${formatText(batch.id || batch.batchId)}，状态 ${formatText(batch.status)}，成功 ${formatNumber(batch.successCount, 0)}，失败 ${formatNumber(batch.failureCount, 0)}，跳过 ${formatNumber(batch.skippedCount, 0)}。抄表导入不会自动进入能耗统计。`));
  if (errors.length > 0) {
    resultBox.append(renderTable([
      { key: 'rowNumber', label: '行号' },
      { key: 'fieldName', label: '字段' },
      { key: 'rawValue', label: '原始值' },
      { key: 'errorReason', label: '原因' },
      { key: 'severity', label: '级别', render: (row) => renderStatusPill(row.severity) }
    ], errors, '暂无错误明细。'));
  }
}

async function downloadLedgerExport(path, fallbackFileName, statusText, failureTitle) {
  let objectUrl = null;
  try {
    const response = await fetch(buildApiUrl(path));
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${errorText ? `：${errorText.slice(0, 120)}` : ''}`);
    }
    const blob = await response.blob();
    if (!blob || blob.size === 0) {
      throw new Error('导出文件为空');
    }
    const headerFileName = getFileNameFromContentDisposition(response.headers.get('content-disposition'));
    objectUrl = URL.createObjectURL(blob);
    const link = createElement('a', { href: objectUrl, download: headerFileName || fallbackFileName, style: 'display: none;' });
    document.body.append(link);
    link.click();
    link.remove();
    setApiStatus('online', statusText);
  } catch (error) {
    setApiStatus('offline', `${failureTitle}失败`);
    window.alert(`${failureTitle}失败：${error.message || error}`);
  } finally {
    if (objectUrl) window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

async function exportLedgerUnits() {
  const query = toQuery({ ...state.ledgerUnitFilters, format: 'xlsx' });
  await downloadLedgerExport(`/organization/units/export${query}`, '用能单元导出.xlsx', '用能单元导出已触发', '用能单元导出');
}

async function exportLedgerMeters() {
  const query = toQuery({ ...state.ledgerMeterFilters, format: 'xlsx' });
  await downloadLedgerExport(`/meters/export${query}`, '计量器具导出.xlsx', '计量器具导出已触发', '计量器具导出');
}

async function exportLedgerReadings() {
  const query = toQuery({ ...state.ledgerReadingFilters, format: 'xlsx' });
  await downloadLedgerExport(`/meter-readings/export${query}`, '计量抄表导出.xlsx', '抄表导出已触发', '抄表导出');
}

async function exportProductionOutputs() {
  const query = toQuery({ ...state.ledgerProductionOutputFilters, format: 'xlsx' });
  await downloadLedgerExport(`/production/outputs/export${query}`, '月度产量导出.xlsx', '月度产量导出已触发', '月度产量导出');
}

async function exportGenerationRecords(format = 'xlsx') {
  const normalizedFormat = String(format || 'xlsx').toLowerCase() === 'csv' ? 'csv' : 'xlsx';
  const query = toQuery({ ...state.ledgerGenerationFilters, format: normalizedFormat });
  const fallbackFileName = normalizedFormat === 'csv' ? '发电自用记录导出.csv' : '发电自用记录导出.xlsx';
  await downloadLedgerExport(`/generation/records/export${query}`, fallbackFileName, '发电自用记录导出已触发', '发电自用记录导出');
}

async function exportEnergyLedgerBackfillPreview() {
  const query = toQuery({ ...state.energyFilters, format: 'xlsx', detailLimit: 500 });
  await downloadLedgerExport(`/energy-records/ledger-backfill/preview/export${query}`, 'energy-records-台账回填预演审计预案.xlsx', '台账回填预演审计预案下载已触发', '台账回填预演审计预案下载');
}

async function executeEnergyLedgerBackfill() {
  const preview = state.energyLedgerBackfillPreview;
  const summary = preview?.summary || {};
  const candidateRecordIds = Array.isArray(preview?.candidateRecordIds) ? preview.candidateRecordIds : [];
  if (!preview?.previewSignature || Number(summary.wouldUpdate || 0) <= 0 || candidateRecordIds.length === 0) {
    window.alert('请先运行台账回填预演，并确认存在 wouldUpdate 候选后再执行。');
    return;
  }
  const confirmText = window.prompt(`受控执行会自动创建备份，并只更新最新 preview 中 wouldUpdate=true 的候选记录。\n\n跳过 ambiguous/missing/blocked/alreadyLinked/alreadyPartial；不会删除或新增 energy_records；不会覆盖已有非空 organization_unit_id / meter_device_id。\n\n如确认执行，请输入固定确认文本：确认执行历史能耗台账回填`);
  if (confirmText !== '确认执行历史能耗台账回填') {
    window.alert('确认文本不匹配，已取消受控执行。');
    return;
  }
  state.energyLedgerBackfillExecuteLoading = true;
  state.energyLedgerBackfillExecuteError = null;
  state.energyLedgerBackfillExecuteResult = null;
  await renderEnergy();
  const response = await safeApi('/energy-records/ledger-backfill/execute', {
    method: 'POST',
    body: {
      confirmText,
      previewSignature: preview.previewSignature,
      expectedWouldUpdate: Number(summary.wouldUpdate || 0),
      candidateRecordIds,
      filters: preview.filters || state.energyFilters || {},
      acknowledgeSkippedRisks: true,
      requireBackup: true
    }
  });
  state.energyLedgerBackfillExecuteLoading = false;
  if (!response.ok) {
    state.energyLedgerBackfillExecuteError = formatApiError(response.error);
    await renderEnergy();
    return;
  }
  state.energyLedgerBackfillExecuteResult = response.value.data || {};
  await renderEnergy();
}

async function renderCarbon() {
  const root = getViewRoot();
  clearNode(root);
  root.append(renderLoading('正在读取碳因子、缺失因子和排放结果...'));
  const energyTypes = await safeApi('/energy-types');
  const typeOptions = (energyTypes.ok ? energyTypes.value.data : []).map((item) => ({ value: item.code, label: `${item.name}（${item.code}）` }));
  const [factors, missing, emissions] = await Promise.all([
    safeApi('/carbon/factors?page=1&pageSize=20'),
    safeApi('/carbon/emissions/missing-factors?limit=20'),
    safeApi('/carbon/emissions?page=1&pageSize=20')
  ]);
  clearNode(root);

  const carbonTemplateCard = renderCard('碳因子模板', [
    renderTemplateActions([{ type: 'carbon-factors', label: '下载碳因子维护模板（Excel）' }]),
    createElement('p', { className: 'muted', text: '碳因子模板默认下载 Excel .xlsx，用于维护参考和字段整理，字段按页面表单使用能源类型编码、有效开始日期、有效结束日期和 true/false 是否启用；当前页面按表单逐条保存，暂未提供碳因子批量上传接口。后端未启动时按钮仍保持可见；点击后会通过 fetch 获取模板并触发本地 blob 下载，失败时请确认后端已启动且 API Base 正确。' })
  ]);

  if (!factors.ok && !missing.ok && !emissions.ok) {
    root.append(carbonTemplateCard);
    root.append(renderBackendHint(factors.error || emissions.error));
    return;
  }

  root.append(carbonTemplateCard);

  root.append(createElement('section', { className: 'grid two' }, [
    renderCard('碳因子维护入口', [
      createElement('form', { id: 'factor-form', className: 'form-card' }, [
        createElement('div', { className: 'form-grid' }, [
          createSelectField('energyTypeCode', '能源类型', typeOptions),
          createInputField('region', '地区', 'default'),
          createInputField('factorYear', '年份', '2026'),
          createInputField('unit', '适用单位', 'kWh / m3 / t'),
          createInputField('factorValue', '因子值', '0.5703', 'number', '0.000001'),
          createInputField('factorUnit', '排放单位', 'kgCO2e'),
          createInputField('source', '来源', '业务维护'),
          createInputField('sourceUrl', '来源链接（可选）', ''),
          createInputField('effectiveFrom', '有效开始日期（可选）', '', 'date'),
          createInputField('effectiveTo', '有效结束日期（可选）', '', 'date'),
          createElement('label', { className: 'field' }, [
            createElement('span', { text: '是否启用' }),
            createElement('select', { name: 'isActive' }, [
              createElement('option', { value: 'true', text: '是' }),
              createElement('option', { value: 'false', text: '否' })
            ])
          ])
        ]),
        createElement('button', { type: 'submit', className: 'btn btn-primary', text: '保存碳因子' }),
        createElement('div', { id: 'factor-result', className: 'inline-result', 'aria-live': 'polite' })
      ])
    ]),
    renderCard('排放计算', [
      createElement('form', { id: 'emission-form', className: 'form-card' }, [
        createElement('div', { className: 'form-grid' }, [
          createInputField('normalizedMonthStart', '开始月份', '', 'month'),
          createInputField('normalizedMonthEnd', '结束月份', '', 'month'),
          createInputField('region', '核算地区', 'default'),
          createInputField('limit', '本次最多记录数', '500', 'number', '1')
        ]),
        createElement('button', { type: 'submit', className: 'btn btn-primary', text: '执行排放计算' }),
        createElement('p', { className: 'muted', text: '缺少匹配因子时写入 factor_missing，不伪造排放值；重复计算会 superseded 旧结果。' }),
        createElement('div', { id: 'emission-result', className: 'inline-result', 'aria-live': 'polite' })
      ])
    ])
  ]));

  root.append(renderCard('缺失因子提示', [
    missing.ok ? renderTable([
      { key: 'energyTypeCode', label: '能源类型编码' },
      { key: 'energyTypeName', label: '能源类型' },
      { key: 'unit', label: '单位' },
      { key: 'requestedRegion', label: '地区' },
      { key: 'factorYear', label: '年份' },
      { key: 'missingRecordCount', label: '影响记录', render: (row) => createElement('span', { text: formatNumber(row.missingRecordCount || row.recordCount, 0) }) }
    ], Array.isArray(missing.value.data) ? missing.value.data : [], '暂无缺失因子提示。若尚未执行碳核算，请先点击排放计算。') : renderMessage('error', '缺失因子读取失败', missing.error.message)
  ]));

  root.append(createElement('section', { className: 'grid two' }, [
    renderCard('碳因子列表', [
      factors.ok ? renderTable([
        { key: 'energyTypeName', label: '能源类型' },
        { key: 'region', label: '地区' },
        { key: 'factorYear', label: '年份' },
        { key: 'unit', label: '单位' },
        { key: 'factorValue', label: '因子值', render: (row) => createElement('span', { text: `${formatNumber(row.factorValue, 6)} ${formatText(row.factorUnit, '')}` }) },
        { key: 'source', label: '来源' },
        { key: 'status', label: '状态', render: (row) => renderStatusPill(row.status) }
      ], factors.value.data, '暂无碳因子。请先维护至少一个因子。') : renderMessage('error', '因子列表读取失败', factors.error.message)
    ]),
    renderCard('排放结果列表', [
      emissions.ok ? renderTable([
        { key: 'normalizedMonth', label: '月份' },
        { key: 'energyTypeName', label: '能源类型' },
        { key: 'activityValue', label: '活动值', render: (row) => createElement('span', { text: `${formatNumber(row.activityValue)} ${formatText(row.activityUnit, '')}` }) },
        { key: 'emissionValue', label: '排放量', render: (row) => createElement('span', { text: row.emissionValue === null ? '-' : `${formatNumber(row.emissionValue, 6)} ${formatText(row.emissionUnit, '')}` }) },
        { key: 'status', label: '状态', render: (row) => renderStatusPill(row.status) }
      ], emissions.value.data, '暂无排放结果。请先维护碳因子并执行计算。') : renderMessage('error', '排放结果读取失败', emissions.error.message)
    ])
  ]));
}

function createInputField(name, label, placeholder = '', type = 'text', step) {
  return createElement('label', { className: 'field' }, [
    createElement('span', { text: label }),
    createElement('input', { name, type, placeholder, step })
  ]);
}

function createSelectField(name, label, options = []) {
  return createElement('label', { className: 'field' }, [
    createElement('span', { text: label }),
    createElement('select', { name }, options.length > 0 ? options.map((option) => createElement('option', { value: option.value, text: option.label })) : [createElement('option', { value: '', text: '请先连接后端字典' })])
  ]);
}

async function handleFactorSubmit(event) {
  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  const form = getSubmittedForm(event, 'factor-form');
  const resultBox = getInlineResultBox('#factor-result');
  if (!resultBox) {
    return;
  }
  clearNode(resultBox);
  if (!form) {
    resultBox.append(renderMessage('error', '碳因子表单不存在', '未找到碳因子维护表单，请刷新页面后重试。'));
    return;
  }
  const payload = collectFormValues(form);
  if (!payload.energyTypeCode || !payload.unit || !payload.factorValue || !payload.source) {
    resultBox.append(renderMessage('error', '字段不完整', '能源类型、单位、因子值和来源为必填项。'));
    return;
  }
  const response = await safeApi('/carbon/factors', { method: 'POST', body: payload });
  if (!response.ok) {
    resultBox.append(renderMessage('error', '碳因子保存失败', formatApiError(response.error)));
    return;
  }
  resultBox.append(renderMessage('success', '碳因子已保存', `因子 ${response.value.data.id} 已${response.value.data.operation === 'created' ? '创建' : '更新'}。可点击当前页面刷新因子列表。`));
}

async function handleEmissionSubmit(event) {
  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  const form = getSubmittedForm(event, 'emission-form');
  const resultBox = getInlineResultBox('#emission-result');
  if (!resultBox) {
    return;
  }
  clearNode(resultBox);
  if (!form) {
    resultBox.append(renderMessage('error', '排放计算表单不存在', '未找到排放计算表单，请刷新页面后重试。'));
    return;
  }
  const payload = collectFormValues(form);
  const response = await safeApi('/carbon/emissions/calculate', { method: 'POST', body: payload });
  if (!response.ok) {
    resultBox.append(renderMessage('error', '排放计算失败', formatApiError(response.error)));
    return;
  }
  const data = response.value.data;
  resultBox.append(renderMessage('success', '排放计算完成', `处理 ${formatNumber(data.totalRecords, 0)} 条记录，已计算 ${formatNumber(data.calculatedCount, 0)} 条，缺失因子 ${formatNumber(data.missingFactorCount, 0)} 条。可点击当前页面刷新排放结果。`));
}

async function renderPredictions() {
  const root = getViewRoot();
  clearNode(root);
  root.append(renderLoading('正在读取预测运行与结果...'));
  const energyTypes = await safeApi('/energy-types');
  const typeOptions = [{ value: '', label: '全部能源类型' }].concat((energyTypes.ok ? energyTypes.value.data : []).map((item) => ({ value: item.code, label: `${item.name}（${item.code}）` })));
  const [runs, results] = await Promise.all([
    safeApi('/predictions/runs?page=1&pageSize=20'),
    safeApi('/predictions/results?page=1&pageSize=20')
  ]);
  clearNode(root);

  const predictionTemplateCard = renderCard('预测历史数据模板', [
    renderTemplateActions([
      { type: 'prediction-history', label: '下载预测历史模板（Excel）' },
      { type: 'energy-records', label: '复用能耗导入模板（Excel）' }
    ]),
    createElement('p', { className: 'muted', text: '预测运行不单独上传历史文件；请先按 Excel 预测历史模板或能耗模板导入至少 3 个历史月份，再创建预测运行。后端未启动时按钮仍保持可见；点击后会通过 fetch 获取模板并触发本地 blob 下载，失败时请确认后端已启动且 API Base 正确。' })
  ]);

  if (!runs.ok && !results.ok) {
    root.append(predictionTemplateCard);
    root.append(renderBackendHint(runs.error || results.error));
    return;
  }

  root.append(renderMessage('info', '轻量预测说明', 'moving_average 与 linear_trend 仅为本地轻量趋势参考；历史样本不足时运行会失败且不写入伪预测结果。'));
  root.append(predictionTemplateCard);
  root.append(renderCard('创建预测运行', [
    createElement('form', { id: 'prediction-form', className: 'form-card' }, [
      createElement('div', { className: 'form-grid' }, [
        createInputField('name', '运行名称（可选）', '轻量预测 2026Q3'),
        createElement('label', { className: 'field' }, [
          createElement('span', { text: '算法' }),
          createElement('select', { name: 'algorithm' }, [
            createElement('option', { value: 'moving_average', text: 'moving_average：移动平均' }),
            createElement('option', { value: 'linear_trend', text: 'linear_trend：线性趋势' })
          ])
        ]),
        createSelectField('energyTypeCode', '能源类型（可选）', typeOptions),
        createInputField('trainStartMonth', '训练开始月份', '', 'month'),
        createInputField('trainEndMonth', '训练结束月份', '', 'month'),
        createInputField('predictStartMonth', '预测开始月份', '', 'month'),
        createInputField('predictEndMonth', '预测结束月份', '', 'month'),
        createInputField('windowSize', '移动平均窗口', '3', 'number', '1')
      ]),
      createElement('button', { type: 'submit', className: 'btn btn-primary', text: '创建预测运行' }),
      createElement('div', { id: 'prediction-result', className: 'inline-result', 'aria-live': 'polite' })
    ])
  ]));

  root.append(createElement('section', { className: 'grid two' }, [
    renderCard('预测运行列表', [
      runs.ok ? renderTable([
        { key: 'id', label: '运行' },
        { key: 'name', label: '名称' },
        { key: 'algorithm', label: '算法' },
        { key: 'status', label: '状态', render: (row) => renderStatusPill(row.status) },
        { key: 'energyTypeName', label: '能源类型' },
        { key: 'trainStartMonth', label: '训练区间', render: (row) => createElement('span', { text: `${formatText(row.trainStartMonth)} 至 ${formatText(row.trainEndMonth)}` }) },
        { key: 'predictStartMonth', label: '预测区间', render: (row) => createElement('span', { text: `${formatText(row.predictStartMonth)} 至 ${formatText(row.predictEndMonth)}` }) },
        { key: 'resultCount', label: '结果数', render: (row) => createElement('span', { text: formatNumber(row.resultCount, 0) }) }
      ], runs.value.data, '暂无预测运行。请先导入足够历史月份数据后创建预测。') : renderMessage('error', '运行列表读取失败', runs.error.message)
    ]),
    renderCard('预测结果列表', [
      results.ok ? renderTable([
        { key: 'targetMonth', label: '目标月份' },
        { key: 'energyTypeName', label: '能源类型' },
        { key: 'predictedValue', label: '预测值', render: (row) => createElement('span', { text: `${formatNumber(row.predictedValue)} ${formatText(row.predictedUnit, '')}` }) },
        { key: 'confidenceLow', label: '低位', render: (row) => createElement('span', { text: formatNumber(row.confidenceLow) }) },
        { key: 'confidenceHigh', label: '高位', render: (row) => createElement('span', { text: formatNumber(row.confidenceHigh) }) },
        { key: 'methodNote', label: '说明' }
      ], results.value.data, '暂无预测结果。历史不足时不会生成伪结果。') : renderMessage('error', '结果列表读取失败', results.error.message)
    ])
  ]));
}

async function handlePredictionSubmit(event) {
  if (event && typeof event.preventDefault === 'function') {
    event.preventDefault();
  }
  const form = getSubmittedForm(event, 'prediction-form');
  const resultBox = getInlineResultBox('#prediction-result');
  if (!resultBox) {
    return;
  }
  clearNode(resultBox);
  if (!form) {
    resultBox.append(renderMessage('error', '预测表单不存在', '未找到预测运行表单，请刷新页面后重试。'));
    return;
  }
  const payload = collectFormValues(form);
  const required = ['algorithm', 'trainStartMonth', 'trainEndMonth', 'predictStartMonth', 'predictEndMonth'];
  const missing = required.filter((key) => !payload[key]);
  if (missing.length > 0) {
    resultBox.append(renderMessage('error', '预测参数不完整', `缺少字段：${missing.join('、')}。`));
    return;
  }
  const response = await safeApi('/predictions/runs', { method: 'POST', body: payload });
  if (!response.ok) {
    resultBox.append(renderMessage('error', '预测运行创建失败', formatApiError(response.error)));
    return;
  }
  const summary = response.value.data.summary || {};
  resultBox.append(renderMessage(summary.status === 'completed' ? 'success' : 'error', '预测运行已返回', `状态：${summary.status}，结果数：${formatNumber(summary.resultCount, 0)}。${(summary.warnings || []).join('；')} 可点击当前页面刷新运行和结果列表。`));
}

function refreshMeterReadingDefaultsFromSelectedMeter(select) {
  const form = select.closest('#ledger-reading-form');
  if (!form) return;
  const selectedOption = select.selectedOptions?.[0];
  if (!selectedOption) return;
  const multiplierInput = form.elements.multiplier;
  const unitInput = form.elements.originalUnit;
  if (multiplierInput) {
    multiplierInput.value = selectedOption.dataset.multiplier || '1';
  }
  if (unitInput) {
    unitInput.value = selectedOption.dataset.defaultUnit || 'kWh';
  }
}

async function renderActiveView() {
  setViewTitle();
  await detectApi();
  if (state.activeView === 'dashboard') {
    await renderDashboard();
  } else if (state.activeView === 'imports') {
    await renderImports();
  } else if (state.activeView === 'energy') {
    await renderEnergy();
  } else if (state.activeView === 'ledger') {
    await renderLedger();
  } else if (state.activeView === 'carbon') {
    await renderCarbon();
  } else if (state.activeView === 'predictions') {
    await renderPredictions();
  } else if (state.activeView === 'system') {
    await renderSystem();
  }
}

function bindEvents() {
  document.addEventListener('click', async (event) => {
    const viewButton = event.target.closest('[data-view]');
    if (viewButton) {
      state.activeView = viewButton.dataset.view;
      await renderActiveView();
      return;
    }

    const actionButton = event.target.closest('[data-action]');
    if (!actionButton) {
      return;
    }
    const { action } = actionButton.dataset;
    if (action === 'apply-api-base') {
      const input = document.querySelector('#api-base');
      state.apiBase = input.value.trim() || DEFAULT_API_BASE;
      localStorage.setItem(API_BASE_STORAGE_KEY, state.apiBase);
      await renderActiveView();
    } else if (action === 'refresh-view') {
      await renderActiveView();
    } else if (action === 'download-template') {
      const originalText = actionButton.textContent;
      actionButton.disabled = true;
      actionButton.textContent = '正在准备模板...';
      await downloadTemplate(actionButton.dataset.templateType, actionButton.dataset.fileName);
      actionButton.disabled = false;
      actionButton.textContent = originalText;
    } else if (action === 'download-template-csv') {
      const originalText = actionButton.textContent;
      actionButton.disabled = true;
      actionButton.textContent = '正在准备 CSV 模板...';
      await downloadTemplateCsv(actionButton.dataset.templateType, actionButton.dataset.fileName);
      actionButton.disabled = false;
      actionButton.textContent = originalText;
    } else if (action === 'load-import-batch-detail') {
      await loadImportBatchDetail(actionButton.dataset.batchId);
    } else if (action === 'load-import-errors') {
      await loadImportErrors(actionButton.dataset.batchId);
    } else if (action === 'download-import-file') {
      await downloadImportFile(actionButton.dataset.batchId, actionButton.dataset.filename);
    } else if (action === 'delete-import-batch') {
      await deleteImportBatch(actionButton.dataset.batchId, actionButton.dataset.filename, actionButton.dataset.importType);
    } else if (action === 'reset-import-batches-filters') {
      state.importBatchFilters = {};
      await refreshImportBatches();
    } else if (action === 'create-backup') {
      const originalText = actionButton.textContent;
      actionButton.disabled = true;
      actionButton.textContent = '正在创建备份...';
      try {
        await createSystemBackup();
      } finally {
        actionButton.disabled = false;
        actionButton.textContent = originalText;
      }
    } else if (action === 'download-backup') {
      await downloadBackupFile(actionButton.dataset.backupName);
    } else if (action === 'restore-backup') {
      await restoreSystemBackup(actionButton.dataset.backupName);
    } else if (action === 'delete-backup') {
      await deleteSystemBackup(actionButton.dataset.backupName);
    } else if (action === 'switch-ledger-tab') {
      state.ledgerTab = actionButton.dataset.tab || 'units';
      await renderLedger();
    } else if (action === 'edit-ledger-unit') {
      state.ledgerTab = 'units';
      await renderLedger({ type: 'unit', id: actionButton.dataset.id });
    } else if (action === 'edit-ledger-meter') {
      state.ledgerTab = 'meters';
      await renderLedger({ type: 'meter', id: actionButton.dataset.id });
    } else if (action === 'edit-ledger-reading') {
      state.ledgerTab = 'readings';
      await renderLedger({ type: 'reading', id: actionButton.dataset.id });
    } else if (action === 'edit-ledger-generation') {
      state.ledgerTab = 'generation';
      await renderLedger({ type: 'generation', id: actionButton.dataset.id });
    } else if (action === 'edit-production-unit') {
      state.ledgerTab = 'production';
      await renderLedger({ type: 'production-unit', id: actionButton.dataset.id });
    } else if (action === 'edit-production-output') {
      state.ledgerTab = 'production';
      await renderLedger({ type: 'production-output', id: actionButton.dataset.id });
    } else if (action === 'cancel-ledger-edit') {
      await renderLedger();
    } else if (action === 'deactivate-ledger-unit') {
      await deactivateLedgerUnit(actionButton.dataset.id, actionButton.dataset.name);
    } else if (action === 'deactivate-ledger-meter') {
      await deactivateLedgerMeter(actionButton.dataset.id, actionButton.dataset.name);
    } else if (action === 'void-ledger-reading') {
      await voidMeterReading(actionButton.dataset.id, actionButton.dataset.name);
    } else if (action === 'void-ledger-generation') {
      await voidGenerationRecord(actionButton.dataset.id, actionButton.dataset.name);
    } else if (action === 'deactivate-production-unit') {
      await deactivateProductionUnit(actionButton.dataset.id, actionButton.dataset.name);
    } else if (action === 'void-production-output') {
      await voidProductionOutput(actionButton.dataset.id, actionButton.dataset.name);
    } else if (action === 'export-ledger-units') {
      await exportLedgerUnits();
    } else if (action === 'export-ledger-meters') {
      await exportLedgerMeters();
    } else if (action === 'export-ledger-readings') {
      await exportLedgerReadings();
    } else if (action === 'export-ledger-generation') {
      await exportGenerationRecords('xlsx');
    } else if (action === 'export-ledger-generation-csv') {
      await exportGenerationRecords('csv');
    } else if (action === 'export-production-outputs') {
      await exportProductionOutputs();
    } else if (action === 'execute-generation-record-import') {
      await executeGenerationRecordImportFromPreview();
    } else if (action === 'execute-production-output-import') {
      await executeProductionOutputImport();
    } else if (action === 'run-meter-reading-generation-preview') {
      await runMeterReadingGenerationPreview();
    } else if (action === 'export-meter-reading-generation-preview') {
      await exportMeterReadingGenerationPreview();
    } else if (action === 'execute-meter-reading-generation') {
      await executeMeterReadingGeneration();
    } else if (action === 'run-energy-ledger-backfill-preview') {
      await runEnergyLedgerBackfillPreview();
    } else if (action === 'export-energy-ledger-backfill-preview') {
      await exportEnergyLedgerBackfillPreview();
    } else if (action === 'execute-energy-ledger-backfill') {
      await executeEnergyLedgerBackfill();
    } else if (action === 'reset-energy-filters') {
      state.energyFilters = {};
      state.energyLedgerBackfillPreview = null;
      state.energyLedgerBackfillPreviewError = null;
      state.energyLedgerBackfillExecuteError = null;
      state.energyLedgerBackfillExecuteResult = null;
      await renderEnergy();
    } else if (action === 'reset-ledger-units-filters') {
      state.ledgerUnitFilters = {};
      state.ledgerTab = 'units';
      await renderLedger();
    } else if (action === 'reset-ledger-meters-filters') {
      state.ledgerMeterFilters = {};
      state.ledgerTab = 'meters';
      await renderLedger();
    } else if (action === 'reset-ledger-readings-filters') {
      state.ledgerReadingFilters = {};
      state.meterReadingGenerationPreview = null;
      state.meterReadingGenerationPreviewError = null;
      state.meterReadingGenerationExecuteError = null;
      state.meterReadingGenerationExecuteResult = null;
      state.ledgerTab = 'readings';
      await renderLedger();
    } else if (action === 'reset-ledger-generation-filters') {
      state.ledgerGenerationFilters = {};
      state.generationRecordImportPreview = null;
      state.generationRecordImportPreviewError = null;
      state.generationRecordImportExecuteError = null;
      state.generationRecordImportExecuteResult = null;
      state.ledgerTab = 'generation';
      await renderLedger();
    } else if (action === 'reset-ledger-production-units-filters') {
      state.ledgerProductionUnitFilters = {};
      state.ledgerTab = 'production';
      await renderLedger();
    } else if (action === 'reset-ledger-production-outputs-filters') {
      state.ledgerProductionOutputFilters = {};
      state.ledgerTab = 'production';
      await renderLedger();
    } else if (action === 'reset-ledger-production-intensity-filters') {
      state.ledgerProductionIntensityFilters = {};
      state.ledgerTab = 'production';
      await renderLedger();
    }
  });

  document.addEventListener('change', (event) => {
    const readingMeterSelect = event.target.closest('select[data-role="ledger-reading-meter"]');
    if (readingMeterSelect) {
      refreshMeterReadingDefaultsFromSelectedMeter(readingMeterSelect);
    }
    const productionOutputUnitSelect = event.target.closest('select[data-role="ledger-production-output-unit"]');
    if (productionOutputUnitSelect) {
      refreshProductionOutputUnitDefault(productionOutputUnitSelect);
    }
  });

  document.addEventListener('submit', async (event) => {
    const form = getSubmittedForm(event);
    if (!form) {
      return;
    }

    try {
      if (form.id === 'import-form') {
        await handleImportSubmit(event);
      } else if (form.id === 'import-batches-filters') {
        event.preventDefault();
        state.importBatchFilters = collectFormValues(form);
        await refreshImportBatches();
      } else if (form.id === 'energy-filters') {
        event.preventDefault();
        state.energyFilters = collectFormValues(form);
        state.energyLedgerBackfillPreview = null;
        state.energyLedgerBackfillPreviewError = null;
        await renderEnergy();
      } else if (form.id === 'ledger-unit-form') {
        await handleLedgerUnitSubmit(event);
      } else if (form.id === 'ledger-meter-form') {
        await handleLedgerMeterSubmit(event);
      } else if (form.id === 'ledger-unit-import-form') {
        await handleLedgerUnitImportSubmit(event);
      } else if (form.id === 'ledger-meter-import-form') {
        await handleLedgerMeterImportSubmit(event);
      } else if (form.id === 'ledger-reading-form') {
        await handleMeterReadingSubmit(event);
      } else if (form.id === 'ledger-generation-form') {
        await handleGenerationSubmit(event);
      } else if (form.id === 'ledger-generation-import-preview-form') {
        await handleGenerationRecordImportPreviewSubmit(event);
      } else if (form.id === 'ledger-production-unit-form') {
        await handleProductionUnitSubmit(event);
      } else if (form.id === 'ledger-production-output-form') {
        await handleProductionOutputSubmit(event);
      } else if (form.id === 'production-output-import-preview-form') {
        await handleProductionOutputImportPreviewSubmit(event);
      } else if (form.id === 'ledger-reading-import-form') {
        await handleMeterReadingImportSubmit(event);
      } else if (form.id === 'ledger-units-filters') {
        event.preventDefault();
        state.ledgerUnitFilters = collectFormValues(form);
        state.ledgerTab = 'units';
        await renderLedger();
      } else if (form.id === 'ledger-meters-filters') {
        event.preventDefault();
        state.ledgerMeterFilters = collectFormValues(form);
        state.ledgerTab = 'meters';
        await renderLedger();
      } else if (form.id === 'ledger-readings-filters') {
        event.preventDefault();
        state.ledgerReadingFilters = collectFormValues(form);
        state.meterReadingGenerationPreview = null;
        state.meterReadingGenerationPreviewError = null;
        state.meterReadingGenerationExecuteError = null;
        state.meterReadingGenerationExecuteResult = null;
        state.ledgerTab = 'readings';
        await renderLedger();
      } else if (form.id === 'ledger-generation-filters') {
        event.preventDefault();
        state.ledgerGenerationFilters = collectFormValues(form);
        state.generationRecordImportPreview = null;
        state.generationRecordImportPreviewError = null;
        state.generationRecordImportExecuteError = null;
        state.generationRecordImportExecuteResult = null;
        state.ledgerTab = 'generation';
        await renderLedger();
      } else if (form.id === 'ledger-production-units-filters') {
        event.preventDefault();
        state.ledgerProductionUnitFilters = collectFormValues(form);
        state.ledgerTab = 'production';
        await renderLedger();
      } else if (form.id === 'ledger-production-outputs-filters') {
        event.preventDefault();
        state.ledgerProductionOutputFilters = collectFormValues(form);
        state.ledgerTab = 'production';
        await renderLedger();
      } else if (form.id === 'ledger-production-intensity-filters') {
        event.preventDefault();
        state.ledgerProductionIntensityFilters = collectFormValues(form);
        state.ledgerTab = 'production';
        await renderLedger();
      } else if (form.id === 'factor-form') {
        await handleFactorSubmit(event);
      } else if (form.id === 'emission-form') {
        await handleEmissionSubmit(event);
      } else if (form.id === 'prediction-form') {
        await handlePredictionSubmit(event);
      }
    } catch (error) {
      event.preventDefault();
      const resultSelectors = {
        'import-form': '#import-result',
        'ledger-unit-form': '#ledger-unit-result',
        'ledger-meter-form': '#ledger-meter-result',
        'ledger-unit-import-form': '#ledger-unit-import-result',
        'ledger-meter-import-form': '#ledger-meter-import-result',
        'ledger-reading-form': '#ledger-reading-result',
        'ledger-generation-import-preview-form': '#ledger-generation-import-result',
        'ledger-production-unit-form': '#ledger-production-unit-result',
        'ledger-production-output-form': '#ledger-production-output-result',
        'ledger-reading-import-form': '#ledger-reading-import-result',
        'ledger-units-filters': '#view-root',
        'ledger-meters-filters': '#view-root',
        'ledger-readings-filters': '#view-root',
        'ledger-production-units-filters': '#view-root',
        'ledger-production-outputs-filters': '#view-root',
        'ledger-production-intensity-filters': '#view-root',
        'factor-form': '#factor-result',
        'emission-form': '#emission-result',
        'prediction-form': '#prediction-result'
      };
      renderInlineError(
        resultSelectors[form.id] || '#view-root',
        '操作异常',
        error.message || String(error)
      );
    }
  });
}

renderShell();
bindEvents();
renderActiveView();
