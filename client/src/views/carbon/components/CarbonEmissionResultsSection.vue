<template>
  <section class="module-section" aria-labelledby="accounting-results-title">
    <header class="module-heading">
      <div>
        <h2 id="accounting-results-title">统一碳核算结果</h2>
        <p>默认读取独立碳活动运行结果；旧能耗结果必须显式选择。所有总量按排放单位分列，不跨单位合计。</p>
      </div>
      <el-dropdown v-if="canExportCurrentSource" @command="handleExport">
        <el-button :loading="exportLoading">导出当前来源<el-icon class="el-icon--right"><ArrowDown /></el-icon></el-button>
        <template #dropdown><el-dropdown-menu><el-dropdown-item command="xlsx">导出 XLSX</el-dropdown-item><el-dropdown-item command="csv">导出 CSV</el-dropdown-item></el-dropdown-menu></template>
      </el-dropdown>
    </header>

    <el-alert
      v-if="sourceType === 'all'"
      :title="doubleCountWarning"
      description="all 只做双来源分面查询：不持久化、不合并分页、不无提示合计；crossSourceTotal 固定为 null。两个分面及各 emissionUnit 必须分别理解和导出。"
      type="error"
      show-icon
      :closable="false"
      class="section-alert double-count-alert"
    />
    <el-alert v-if="sectionError" :title="sectionError" type="error" show-icon :closable="false" class="section-alert" />
    <el-alert v-if="filterValidationError" :title="filterValidationError" type="error" show-icon :closable="false" class="section-alert" />

    <el-form :inline="true" :model="draftFilters" class="filter-form" aria-label="统一碳核算结果筛选">
      <el-form-item label="结果来源">
        <el-select v-model="sourceType" placeholder="请显式选择结果来源" style="width:235px" @change="handleSourceChange">
          <el-option v-for="option in sourceOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="draftFilters.status" clearable placeholder="全部状态" style="width:145px">
          <el-option v-for="option in statusOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="能源类型">
        <el-select v-model="draftFilters.energyTypeCode" clearable filterable placeholder="全部能源类型" style="width:190px">
          <el-option v-for="item in props.energyTypes" :key="item.code" :label="`${item.name}（${item.code}）`" :value="item.code" />
        </el-select>
      </el-form-item>
      <el-form-item label="排放单位"><el-input v-model="draftFilters.emissionUnit" clearable placeholder="如 kgCO2e" /></el-form-item>
      <el-form-item label="关键词"><el-input v-model="draftFilters.keyword" clearable placeholder="活动、能源或组织" @keyup.enter="applyFilters" /></el-form-item>

      <template v-if="sourceType === 'independent_activity'">
        <el-form-item label="运行编码"><el-input v-model="draftFilters.runCode" clearable placeholder="留空使用最新 completed 运行" class="run-code-input" /></el-form-item>
        <el-form-item label="排放范围"><el-select v-model="draftFilters.scope" clearable placeholder="全部范围" style="width:140px"><el-option label="范围一" value="scope_1" /><el-option label="范围二" value="scope_2" /><el-option label="范围三" value="scope_3" /></el-select></el-form-item>
        <el-form-item label="活动 UTC 开始"><StrictUtcDateTimeInput :key="`result-start-${filterInputGeneration}`" v-model="draftFilters.startUtc" @validity-change="(valid) => handleFilterValidityChange('startUtc', valid)" /></el-form-item>
        <el-form-item label="活动 UTC 结束"><StrictUtcDateTimeInput :key="`result-end-${filterInputGeneration}`" v-model="draftFilters.endUtc" @validity-change="(valid) => handleFilterValidityChange('endUtc', valid)" /></el-form-item>
      </template>
      <template v-else-if="sourceType === 'energy_record'">
        <el-form-item label="开始月份"><el-date-picker v-model="draftFilters.monthStart" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" clearable /></el-form-item>
        <el-form-item label="结束月份"><el-date-picker v-model="draftFilters.monthEnd" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" clearable /></el-form-item>
        <el-form-item label="核算方法"><el-input v-model="draftFilters.calculationMethod" clearable placeholder="如 standard-factor" /></el-form-item>
        <el-form-item><el-checkbox v-model="draftFilters.includeSuperseded">包含已替代</el-checkbox></el-form-item>
      </template>
      <template v-else-if="sourceType === 'all'">
        <el-form-item><span class="all-filter-hint">双来源模式只开放共同筛选，避免某一来源不支持的区间字段把另一个分面静默筛空。</span></el-form-item>
      </template>
      <el-form-item><el-button type="primary" :loading="loading" :disabled="!sourceType || !areResultFiltersValid" @click="applyFilters">查询</el-button><el-button @click="resetFilters">重置</el-button></el-form-item>
    </el-form>

    <PageState
      v-if="!sourceType"
      description="当前没有默认结果来源。请在“结果来源”中显式选择可用来源；只有旧能耗查看权限时不会自动加载 energy_record。"
    />
    <template v-else-if="sourceType === 'all'">
      <section class="all-facets" aria-label="双来源独立分面">
        <CarbonSourceResultFacet
          source-type="independent_activity"
          :facet="independentFacet"
          :statistics="independentStatistics"
          :loading="loading"
          :error="independentError"
          @page-change="handleFacetPageChange"
          @page-size-change="handleFacetPageSizeChange"
          @retry="loadResults"
        />
        <CarbonSourceResultFacet
          source-type="energy_record"
          :facet="energyFacet"
          :statistics="energyStatistics"
          :loading="loading"
          :error="energyError"
          @page-change="handleFacetPageChange"
          @page-size-change="handleFacetPageSizeChange"
          @retry="loadResults"
        />
      </section>
      <p class="aggregation-policy">服务端聚合策略：{{ aggregationPolicy }}；页面确认 crossSourceTotal = {{ crossSourceTotal === null ? 'null' : '合同异常' }}。</p>
    </template>
    <CarbonSourceResultFacet
      v-else
      :source-type="sourceType"
      :facet="singleFacet"
      :statistics="singleStatistics"
      :loading="loading"
      :error="sectionError"
      @page-change="handleFacetPageChange"
      @page-size-change="handleFacetPageSizeChange"
      @retry="loadResults"
    />
  </section>
</template>

<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { ArrowDown } from '@element-plus/icons-vue';
import PageState from '@/components/PageState.vue';
import StrictUtcDateTimeInput from '@/components/StrictUtcDateTimeInput.vue';
import {
  exportCarbonAccountingResults,
  getCarbonAccountingResults,
  getCarbonAccountingStatistics
} from '@/api/carbonAccounting';
import {
  CARBON_ACCOUNTING_ALL_AGGREGATION_POLICY,
  CARBON_ACCOUNTING_DOUBLE_COUNT_WARNING,
  CARBON_ACCOUNTING_STATUS_OPTIONS,
  availableCarbonAccountingSources,
  buildCarbonAccountingFilters,
  canExportCarbonAccountingSource,
  createEmptyCarbonAccountingFacet,
  createEmptyCarbonAccountingFilters,
  createEmptyCarbonAccountingSourceState,
  createEmptyCarbonAccountingStatistics,
  normalizeAllCarbonAccountingResponse,
  normalizeAllCarbonAccountingStatisticsResponse,
  normalizeCarbonAccountingResultFacet,
  normalizeCarbonAccountingStatisticsFacet,
  projectCarbonRunSelectionState,
  resolveInitialCarbonAccountingSource
} from '@/utils/carbonSourceManagement';
import { areStrictUtcInputsValid } from '@/utils/dateTimeFields';
import { isLatestRequestGeneration, nextRequestGeneration } from '@/utils/requestGeneration';
import CarbonSourceResultFacet from './CarbonSourceResultFacet.vue';

// 组件属性模块：页面壳提供能源字典、精确权限和运行板块选择的 runCode。
const props = defineProps({
  energyTypes: { type: Array, default: () => [] },
  permissionState: { type: Object, required: true },
  selectedRunCode: { type: String, default: '' },
  selectedRunIntent: { type: Number, default: 0 }
});

// 来源和状态选项：来源按当前精确权限过滤，状态与服务端并集白名单一致。
const sourceOptions = computed(() => availableCarbonAccountingSources(props.permissionState));
const statusOptions = CARBON_ACCOUNTING_STATUS_OPTIONS;
// 双计警示：固定文案用于 UI 和静态契约检查。
const doubleCountWarning = CARBON_ACCOUNTING_DOUBLE_COUNT_WARNING;
// 空筛选工厂：来源专用字段都保留字符串模型，不做时区猜测。
const emptyFilters = createEmptyCarbonAccountingFilters;
// 当前来源：有独立查看权限时默认 independent_activity；只有旧权限时保持未选择。
const sourceType = ref(resolveInitialCarbonAccountingSource(props.permissionState));
// 草稿筛选：点击查询后才应用。
const draftFilters = reactive(emptyFilters());
// 已应用筛选：查询、统计和导出共用。
const appliedFilters = ref(emptyFilters());
// 单来源分页：切换来源时各自保留独立页状态。
const sourcePagination = reactive({
  independent_activity: { page: 1, pageSize: 20 },
  energy_record: { page: 1, pageSize: 20 }
});
// 单来源或 all 独立活动分面结果。
const independentFacet = ref(createEmptyCarbonAccountingFacet('independent_activity', sourcePagination.independent_activity));
// 单来源或 all 旧能耗分面结果。
const energyFacet = ref(createEmptyCarbonAccountingFacet('energy_record', sourcePagination.energy_record));
// 独立活动来源统计。
const independentStatistics = ref(createEmptyCarbonAccountingStatistics('independent_activity'));
// 旧能耗来源统计。
const energyStatistics = ref(createEmptyCarbonAccountingStatistics('energy_record'));
// 结果和统计联合加载状态。
const loading = ref(false);
// 页面级错误：单来源请求或 all 合同异常。
const sectionError = ref('');
// all 独立活动分面错误：另一分面可显示当前请求成功数据，但绝不残留旧数据。
const independentError = ref('');
// all 旧能耗分面错误：另一分面可显示当前请求成功数据，但绝不残留旧数据。
const energyError = ref('');
// 导出加载状态。
const exportLoading = ref(false);
// all 响应跨来源总计：必须始终保持 null。
const crossSourceTotal = ref(null);
// all 响应聚合策略：合同失败时恢复本地冻结说明。
const aggregationPolicy = ref(CARBON_ACCOUNTING_ALL_AGGREGATION_POLICY);
// 结果筛选 UTC 合法性：非法键盘输入不得提交父模型旧值。
const filterValidity = reactive({ startUtc: true, endUtc: true });
// 结果筛选 UTC 错误：持续显示中文阻断说明。
const filterValidationError = ref('');
// 结果 UTC 输入重置世代：切换来源和重置时清除组件内部非法文本。
const filterInputGeneration = ref(0);
// 结果请求世代：筛选、来源、运行和分页逆序响应只允许最新请求提交。
let resultsRequestGeneration = 0;
// 初次选中运行处理标记：避免 immediate watch 与额外挂载请求形成双请求。
let initialRunSelectionHandled = false;

// 当前单来源分面：避免模板复制两套表格。
const singleFacet = computed(() => sourceType.value === 'energy_record' ? energyFacet.value : independentFacet.value);
// 当前单来源统计：与单来源分面保持一致。
const singleStatistics = computed(() => sourceType.value === 'energy_record' ? energyStatistics.value : independentStatistics.value);
// 当前来源导出权限：all 必须同时拥有两套精确导出权限。
const canExportCurrentSource = computed(() => canExportCarbonAccountingSource(sourceType.value, props.permissionState));
// 结果筛选整体合法性：只有独立来源使用严格 UTC 字段。
const areResultFiltersValid = computed(() => sourceType.value !== 'independent_activity' || areStrictUtcInputsValid(filterValidity));

// 方法模块：错误投影、状态清空、来源切换、单/双来源查询、独立分页和导出。

/** 提取共享 HTTP 客户端投影的真实服务端错误。 */
function errorMessage(error, fallback = '请求失败，请稍后重试。') {
  return error?.apiError?.message || error?.response?.data?.error?.message || error?.message || fallback;
}

/** 将 Promise 投影为不抛出的结果，支持 all 两分面局部失败展示。 */
async function safeRequest(task) {
  try {
    return { ok: true, value: await task() };
  } catch (error) {
    return { ok: false, error };
  }
}

/** 返回指定来源当前独立分页。 */
function paginationFor(targetSourceType) {
  return sourcePagination[targetSourceType];
}

/** 清空指定来源的结果和统计，失败时不得继续展示上一筛选或上一运行数据。 */
function clearSourceState(targetSourceType) {
  const emptySourceState = createEmptyCarbonAccountingSourceState(
    targetSourceType,
    paginationFor(targetSourceType)
  );
  if (targetSourceType === 'independent_activity') {
    independentFacet.value = emptySourceState.facet;
    independentStatistics.value = emptySourceState.statistics;
    return;
  }
  energyFacet.value = emptySourceState.facet;
  energyStatistics.value = emptySourceState.statistics;
}

/** 清空双来源全部结果和统计，all 合同漂移时统一 fail-closed。 */
function clearAllSourceState() {
  clearSourceState('independent_activity');
  clearSourceState('energy_record');
  crossSourceTotal.value = null;
  aggregationPolicy.value = CARBON_ACCOUNTING_ALL_AGGREGATION_POLICY;
}

/** 返回当前已应用筛选；all 只提交共同筛选，避免跨来源不兼容区间。 */
function filtersForSource(targetSourceType, filters = appliedFilters.value) {
  if (targetSourceType === 'all') {
    return {
      status: filters.status,
      energyTypeCode: filters.energyTypeCode,
      emissionUnit: filters.emissionUnit,
      keyword: filters.keyword
    };
  }
  return filters;
}

/** 更新严格 UTC 筛选字段合法性并投影中文阻断提示。 */
function handleFilterValidityChange(fieldName, valid) {
  filterValidity[fieldName] = valid === true;
  filterValidationError.value = areStrictUtcInputsValid(filterValidity)
    ? ''
    : '统一结果 UTC 筛选无效，请按 YYYY-MM-DDTHH:mm:ssZ 修正后再查询。';
}

/** 重置严格 UTC 输入状态，避免内部非法文本随来源切换残留。 */
function resetFilterValidity() {
  Object.assign(filterValidity, { startUtc: true, endUtc: true });
  filterValidationError.value = '';
  filterInputGeneration.value += 1;
}

/** 来源切换时清理不兼容草稿字段、重置目标分页并立即加载。 */
function handleSourceChange() {
  resultsRequestGeneration = nextRequestGeneration(resultsRequestGeneration);
  const keepCommon = { status: draftFilters.status, energyTypeCode: draftFilters.energyTypeCode, emissionUnit: draftFilters.emissionUnit, keyword: draftFilters.keyword };
  Object.assign(draftFilters, emptyFilters(), keepCommon);
  resetFilterValidity();
  appliedFilters.value = { ...draftFilters };
  sectionError.value = '';
  independentError.value = '';
  energyError.value = '';
  if (sourceType.value === 'all') {
    sourcePagination.independent_activity.page = 1;
    sourcePagination.energy_record.page = 1;
    clearAllSourceState();
  } else if (sourceType.value) {
    paginationFor(sourceType.value).page = 1;
    clearSourceState(sourceType.value);
  } else {
    clearAllSourceState();
  }
  loadResults();
}

/** 应用筛选并重置当前来源或两个来源的独立页码。 */
function applyFilters() {
  if (!sourceType.value) {
    sectionError.value = '请先显式选择结果来源。';
    return;
  }
  if (!areResultFiltersValid.value) {
    filterValidationError.value = '统一结果 UTC 筛选无效，请按 YYYY-MM-DDTHH:mm:ssZ 修正后再查询。';
    return;
  }
  appliedFilters.value = {
    ...draftFilters,
    runCode: draftFilters.runCode.trim(),
    energyTypeCode: draftFilters.energyTypeCode.trim(),
    emissionUnit: draftFilters.emissionUnit.trim(),
    calculationMethod: draftFilters.calculationMethod.trim(),
    keyword: draftFilters.keyword.trim()
  };
  if (sourceType.value === 'all') {
    sourcePagination.independent_activity.page = 1;
    sourcePagination.energy_record.page = 1;
  } else {
    paginationFor(sourceType.value).page = 1;
  }
  loadResults();
}

/** 清空当前筛选并重新加载，同时清除严格 UTC 非法状态。 */
function resetFilters() {
  Object.assign(draftFilters, emptyFilters());
  resetFilterValidity();
  appliedFilters.value = emptyFilters();
  if (sourceType.value === 'all') {
    sourcePagination.independent_activity.page = 1;
    sourcePagination.energy_record.page = 1;
  } else if (sourceType.value) {
    paginationFor(sourceType.value).page = 1;
  }
  loadResults();
}

/** 查询并严格验证单来源结果和统计，不直接修改页面状态。 */
async function fetchSingleSourceSnapshot(targetSourceType, filters, pagination) {
  const [resultResponse, statisticsResponse] = await Promise.all([
    getCarbonAccountingResults(buildCarbonAccountingFilters(filters, targetSourceType, pagination)),
    getCarbonAccountingStatistics(buildCarbonAccountingFilters(filters, targetSourceType))
  ]);
  return {
    facet: normalizeCarbonAccountingResultFacet(resultResponse.data, targetSourceType),
    statistics: normalizeCarbonAccountingStatisticsFacet(statisticsResponse.data, targetSourceType)
  };
}

/** 提交已经严格验证的单来源快照。 */
function commitSingleSourceSnapshot(targetSourceType, snapshot) {
  if (targetSourceType === 'independent_activity') {
    independentFacet.value = snapshot.facet;
    independentStatistics.value = snapshot.statistics;
    return;
  }
  energyFacet.value = snapshot.facet;
  energyStatistics.value = snapshot.statistics;
}

/** 查询 all 双来源并构造局部失败快照；合同异常由调用方统一 fail-closed。 */
async function fetchAllSourcesSnapshot(filters, independentPage, energyPage) {
  // 相同分页时只请求一次；分页不同后分别请求 all，并各取对应 facet。
  const samePagination = independentPage.page === energyPage.page && independentPage.pageSize === energyPage.pageSize;
  // 两次 all 请求分别承载两个分面的独立分页，响应绝不合并分页。
  const independentRequest = safeRequest(() => getCarbonAccountingResults(buildCarbonAccountingFilters(filters, 'all', independentPage)));
  const energyRequest = samePagination
    ? independentRequest
    : safeRequest(() => getCarbonAccountingResults(buildCarbonAccountingFilters(filters, 'all', energyPage)));
  const statisticsRequest = safeRequest(() => getCarbonAccountingStatistics(buildCarbonAccountingFilters(filters, 'all')));
  const [independentResult, energyResult, statisticsResult] = await Promise.all([independentRequest, energyRequest, statisticsRequest]);

  // 下一状态：先固定为空，网络失败只允许当前请求成功的分面恢复，绝不沿用旧状态。
  const snapshot = {
    independentFacet: createEmptyCarbonAccountingFacet('independent_activity', independentPage),
    energyFacet: createEmptyCarbonAccountingFacet('energy_record', energyPage),
    independentStatistics: createEmptyCarbonAccountingStatistics('independent_activity'),
    energyStatistics: createEmptyCarbonAccountingStatistics('energy_record'),
    independentError: '',
    energyError: '',
    sectionError: '',
    crossSourceTotal: null,
    aggregationPolicy: CARBON_ACCOUNTING_ALL_AGGREGATION_POLICY
  };

  if (independentResult.ok) {
    const normalized = normalizeAllCarbonAccountingResponse(independentResult.value.data);
    snapshot.independentFacet = normalized.independentActivity;
    snapshot.aggregationPolicy = normalized.aggregationPolicy;
  } else {
    snapshot.independentError = errorMessage(independentResult.error, '独立碳活动结果分面加载失败。');
  }
  if (energyResult.ok) {
    const normalized = normalizeAllCarbonAccountingResponse(energyResult.value.data);
    snapshot.energyFacet = normalized.energyRecord;
    snapshot.aggregationPolicy = normalized.aggregationPolicy;
  } else {
    snapshot.energyError = errorMessage(energyResult.error, '旧能耗结果分面加载失败。');
  }
  if (statisticsResult.ok) {
    const normalizedStatistics = normalizeAllCarbonAccountingStatisticsResponse(statisticsResult.value.data);
    snapshot.independentStatistics = normalizedStatistics.independentActivity;
    snapshot.energyStatistics = normalizedStatistics.energyRecord;
    snapshot.aggregationPolicy = normalizedStatistics.aggregationPolicy;
  } else {
    snapshot.sectionError = errorMessage(statisticsResult.error, '双来源统计加载失败。');
  }
  return snapshot;
}

/** 提交已经严格验证的 all 快照。 */
function commitAllSourcesSnapshot(snapshot) {
  independentFacet.value = snapshot.independentFacet;
  energyFacet.value = snapshot.energyFacet;
  independentStatistics.value = snapshot.independentStatistics;
  energyStatistics.value = snapshot.energyStatistics;
  independentError.value = snapshot.independentError;
  energyError.value = snapshot.energyError;
  sectionError.value = snapshot.sectionError;
  crossSourceTotal.value = snapshot.crossSourceTotal;
  aggregationPolicy.value = snapshot.aggregationPolicy;
}

/** 按当前来源加载结果和统计；只有最新请求世代可提交数据、错误和 loading。 */
async function loadResults() {
  resultsRequestGeneration = nextRequestGeneration(resultsRequestGeneration);
  const requestGeneration = resultsRequestGeneration;
  const targetSourceType = sourceType.value;
  if (!targetSourceType) {
    loading.value = false;
    clearAllSourceState();
    return;
  }

  const filtersSnapshot = { ...filtersForSource(targetSourceType) };
  loading.value = true;
  sectionError.value = '';
  independentError.value = '';
  energyError.value = '';
  if (targetSourceType === 'all') clearAllSourceState();
  else clearSourceState(targetSourceType);

  try {
    if (targetSourceType === 'all') {
      const allSnapshot = await fetchAllSourcesSnapshot(
        filtersSnapshot,
        { ...paginationFor('independent_activity') },
        { ...paginationFor('energy_record') }
      );
      if (!isLatestRequestGeneration(requestGeneration, resultsRequestGeneration)) return;
      commitAllSourcesSnapshot(allSnapshot);
    } else {
      const singleSnapshot = await fetchSingleSourceSnapshot(
        targetSourceType,
        filtersSnapshot,
        { ...paginationFor(targetSourceType) }
      );
      if (!isLatestRequestGeneration(requestGeneration, resultsRequestGeneration)) return;
      commitSingleSourceSnapshot(targetSourceType, singleSnapshot);
    }
  } catch (error) {
    if (!isLatestRequestGeneration(requestGeneration, resultsRequestGeneration)) return;
    if (targetSourceType === 'all') clearAllSourceState();
    else clearSourceState(targetSourceType);
    sectionError.value = errorMessage(error, '统一碳核算结果加载失败，旧结果和统计已清空。');
    independentError.value = '';
    energyError.value = '';
  } finally {
    if (isLatestRequestGeneration(requestGeneration, resultsRequestGeneration)) loading.value = false;
  }
}

/** 处理单来源或 all 中某一分面的独立页码变化。 */
function handleFacetPageChange({ sourceType: targetSourceType, page }) {
  paginationFor(targetSourceType).page = page;
  loadResults();
}

/** 处理某一分面的独立页大小变化并只重置该来源页码。 */
function handleFacetPageSizeChange({ sourceType: targetSourceType, pageSize }) {
  paginationFor(targetSourceType).pageSize = pageSize;
  paginationFor(targetSourceType).page = 1;
  loadResults();
}

/** 按当前已应用筛选和显式 sourceType 导出；all 保留双工作表或双 CSV 分段。 */
async function handleExport(format) {
  if (!sourceType.value) return;
  exportLoading.value = true;
  try {
    await exportCarbonAccountingResults(
      buildCarbonAccountingFilters(filtersForSource(sourceType.value), sourceType.value),
      format
    );
    ElMessage.success(`碳核算结果 ${String(format).toUpperCase()} 导出已触发。`);
  } catch (error) {
    ElMessage.error(errorMessage(error, '碳核算结果导出失败。'));
  } finally {
    exportLoading.value = false;
  }
}

/** 运行板块选择 runCode 后切换到默认独立来源并立即查询该运行结果。 */
function applySelectedRun(runCode) {
  const selectionState = projectCarbonRunSelectionState(
    { runCode, intent: props.selectedRunIntent },
    props.permissionState
  );
  if (!selectionState) return;
  sourceType.value = selectionState.sourceType;
  Object.assign(draftFilters, selectionState.filters);
  resetFilterValidity();
  appliedFilters.value = { ...selectionState.filters };
  sourcePagination.independent_activity.page = selectionState.page;
  loadResults();
}

// 运行联动监听：lazy 首次挂载处理已有 runCode；后续同 runCode 通过递增 intent 重新应用。
watch(
  () => [props.selectedRunCode, props.selectedRunIntent],
  ([runCode]) => {
    if (!initialRunSelectionHandled) {
      initialRunSelectionHandled = true;
      if (runCode) applySelectedRun(runCode);
      else loadResults();
      return;
    }
    if (runCode) applySelectedRun(runCode);
  },
  { immediate: true }
);
</script>

<style scoped>
.module-section{display:grid;gap:14px}.module-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}.module-heading h2{margin:0 0 6px;color:#123b79;font-size:18px}.module-heading p{margin:0;color:var(--el-text-color-secondary);line-height:1.6}.section-alert{margin-bottom:0}.double-count-alert{border-width:2px}.filter-form{padding:16px 16px 0;background:#fff;border:1px solid #dce9fb;border-radius:12px}.filter-form :deep(.strict-utc-date-time-field){width:230px}.run-code-input{width:290px}.all-filter-hint{display:inline-block;max-width:520px;color:var(--el-color-warning-dark-2);line-height:1.5}.all-facets{display:grid;gap:16px}.aggregation-policy{margin:0;padding:12px;color:var(--el-text-color-secondary);background:var(--el-fill-color-light);border-radius:8px;font-size:13px;line-height:1.6}@media (max-width:720px){.filter-form :deep(.strict-utc-date-time-field),.run-code-input{width:100%}}
</style>
