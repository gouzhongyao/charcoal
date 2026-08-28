<template>
  <section class="module-section" aria-labelledby="carbon-factors-title">
    <header class="module-heading">
      <div class="heading-with-help"><h2 id="carbon-factors-title">碳因子管理</h2><HelpIcon label="查看碳因子维护说明" content="因子以能源类型、地区、年份、活动单位和来源为依据维护。停用只阻止后续匹配，不会删除或改写已有排放历史快照。" /></div>
    </header>
    <ManagementToolbar :loading="factorLoading" @search="applyFactorFilters" @reset="resetFactorFilters">
      <el-form-item label="能源类型"><el-select v-model="factorDraftFilters.energyTypeCode" clearable placeholder="全部能源类型"><el-option v-for="item in props.energyTypes" :key="item.code" :label="`${item.name}（${item.code}）`" :value="item.code" /></el-select></el-form-item>
      <el-form-item label="地区"><el-input v-model.trim="factorDraftFilters.region" clearable placeholder="如：default" /></el-form-item>
      <el-form-item label="年份"><el-date-picker v-model="factorDraftFilters.factorYear" type="year" value-format="YYYY" format="YYYY" clearable :editable="true" placeholder="如：2026" /></el-form-item>
      <el-form-item label="状态"><el-select v-model="factorDraftFilters.status" clearable placeholder="全部状态"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item>
      <el-form-item label="字符搜索"><el-input v-model.trim="factorDraftFilters.keyword" clearable placeholder="能源、地区、来源或单位" /></el-form-item>
      <template #actions>
        <el-button v-if="canFactorTemplate" :loading="factorTemplateLoading" @click="downloadFactorTemplate">下载模板</el-button>
        <el-button v-if="canFactorImport" @click="openFactorImport">导入因子</el-button>
        <el-button v-if="canFactorExport" :loading="factorExportLoading" @click="exportFactors">导出当前筛选</el-button>
        <el-button v-if="canFactorCreate" type="primary" @click="openFactorCreate">新增因子</el-button>
      </template>
    </ManagementToolbar>
    <el-alert v-if="props.energyTypesError" type="warning" :closable="false" show-icon :title="`能源类型字典读取失败：${props.energyTypesError}`" />
    <el-alert v-if="factorError" type="error" :closable="false" show-icon :title="factorError" />
    <section class="stat-grid" aria-label="当前筛选下的碳因子概览">
      <StatCard label="因子总数" :value="formatInteger(factorPagination.total)" note="当前筛选命中记录" />
      <StatCard label="启用因子" :value="formatInteger(activeFactorCount)" note="仅启用因子可参与后续计算" />
      <StatCard label="停用因子" :value="formatInteger(inactiveFactorCount)" note="停用保留历史追溯" />
      <StatCard label="当前页记录" :value="formatInteger(factors.length)" note="当前分页显示记录" />
    </section>
    <article class="page-card">
      <header class="table-heading"><span>共 {{ formatInteger(factorPagination.total) }} 条</span><small>没有删除操作；启停由服务端保留历史边界。</small></header>
      <PageState v-if="factorError && !factors.length" :error="factorError" @retry="loadFactors" />
      <PageState v-else-if="!factors.length && !factorLoading" description="暂无碳因子；可下载模板、导入或新增首条因子。" />
      <template v-else>
        <el-table :data="factors" v-loading="factorLoading" stripe>
          <el-table-column prop="energyTypeName" label="能源类型" min-width="130" />
          <el-table-column prop="region" label="地区" min-width="100" />
          <el-table-column prop="factorYear" label="年份" width="85" />
          <el-table-column prop="unit" label="活动单位" width="100" />
          <el-table-column label="因子值" min-width="145"><template #default="{ row }">{{ formatNumber(row.factorValue, 6) }} {{ row.factorUnit }}/{{ row.unit }}</template></el-table-column>
          <el-table-column prop="source" label="来源" min-width="140" show-overflow-tooltip />
          <el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column>
          <el-table-column label="操作" width="145" fixed="right"><template #default="{ row }"><el-button v-if="canFactorUpdate" link type="primary" @click="openFactorEdit(row)">编辑</el-button><el-button v-if="canFactorStatus" link :type="row.status === 'active' ? 'warning' : 'success'" :loading="factorStatusLoadingId === row.id" @click="confirmFactorStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column>
        </el-table>
        <div class="pagination"><el-pagination v-model:current-page="factorPage" v-model:page-size="factorPageSize" layout="total, sizes, prev, pager, next" :page-sizes="[20,50,100]" :total="factorPagination.total || 0" @current-change="loadFactors" @size-change="changeFactorPageSize" /></div>
      </template>
    </article>

    <ManagementDrawer v-model="factorDrawerOpen" :title="factorEditingId ? '编辑碳因子' : '新增碳因子'" :loading="factorSaving" :confirm-disabled="factorFormBlocked" @save="saveFactor">
      <el-alert v-if="factorFormError" type="error" :closable="false" show-icon :title="factorFormError" class="drawer-alert" />
      <el-form ref="factorFormRef" :model="factorForm" :rules="factorRules" label-position="top">
        <el-form-item label="能源类型" prop="energyTypeCode"><HelpIcon label="查看能源类型说明" content="只能选择 active 能源类型；服务端会再次校验，停用能源类型不能维护因子。" /><el-select v-model="factorForm.energyTypeCode" class="drawer-control" placeholder="选择能源类型"><el-option v-for="item in activeEnergyTypes" :key="item.code" :label="`${item.name}（${item.code}）`" :value="item.code" /></el-select></el-form-item>
        <el-form-item label="地区" prop="region"><HelpIcon label="查看地区说明" content="地区用于因子匹配，留空时服务端使用 default。" /><el-input v-model.trim="factorForm.region" maxlength="100" /></el-form-item>
        <el-form-item label="因子年份"><HelpIcon label="查看因子年份说明" content="年份为空表示通用年份；匹配优先使用记录年份对应因子。" /><el-date-picker v-model="factorForm.factorYear" type="year" value-format="YYYY" format="YYYY" clearable :editable="true" placeholder="留空表示通用年份" class="drawer-control" /></el-form-item>
        <el-form-item label="活动单位" prop="unit"><HelpIcon label="查看活动单位说明" content="活动单位必须与能耗标准化单位一致，例如 kWh、MJ 或 t。" /><el-input v-model.trim="factorForm.unit" maxlength="40" /></el-form-item>
        <el-form-item label="因子值" prop="factorValue"><HelpIcon label="查看因子值说明" content="排放量由服务端以活动值乘因子值计算；页面不计算也不写入排放结果。" /><el-input-number v-model="factorForm.factorValue" :min="0.000001" :precision="6" class="drawer-control" /></el-form-item>
        <el-form-item label="排放单位" prop="factorUnit"><el-input v-model.trim="factorForm.factorUnit" maxlength="40" placeholder="kgCO2e" /></el-form-item>
        <el-form-item label="来源" prop="source"><el-input v-model.trim="factorForm.source" maxlength="255" /></el-form-item>
        <el-form-item label="来源链接"><el-input v-model.trim="factorForm.sourceUrl" maxlength="1000" /></el-form-item>
        <el-form-item label="有效开始日期"><el-date-picker v-model="factorForm.effectiveFrom" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" :editable="true" class="drawer-control" /></el-form-item>
        <el-form-item label="有效结束日期"><el-date-picker v-model="factorForm.effectiveTo" type="date" value-format="YYYY-MM-DD" format="YYYY-MM-DD" :editable="true" class="drawer-control" /></el-form-item>
        <el-form-item label="状态"><el-select v-model="factorForm.status"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item>
      </el-form>
    </ManagementDrawer>

    <ManagementDrawer v-model="factorImportDrawerOpen" title="导入碳因子：上传预演" confirm-label="开始预演" :loading="factorPreviewLoading" :confirm-disabled="!factorImportFile" @save="previewFactorImport">
      <p class="drawer-notice">预演仅校验并保存导入审计，不写碳因子或排放。重复行按 skip 策略保留 warning，不覆盖现有因子。</p>
      <el-upload :auto-upload="false" :limit="1" accept=".xlsx,.xls,.csv" :on-change="selectFactorImportFile" :on-remove="clearFactorImportFile"><el-button>选择碳因子表格</el-button><template #tip><div class="el-upload__tip">支持 .xlsx、.xls、.csv；可先下载模板核对字段。</div></template></el-upload>
      <el-alert v-if="factorImportError" type="error" :closable="false" show-icon :title="factorImportError" class="drawer-alert" />
      <template v-if="factorImportPreview">
        <div class="preview-summary"><span>候选 {{ formatInteger(factorImportPreview.summary?.wouldImport) }}</span><span>跳过 {{ formatInteger(factorImportPreview.summary?.skipped) }}</span><span>阻断 {{ formatInteger(factorImportPreview.summary?.blocked) }}</span><span>warning {{ formatInteger(factorImportPreview.summary?.warnings) }}</span></div>
        <el-table :data="factorImportPreview.items || []" size="small" max-height="240"><el-table-column prop="rowNumber" label="行" width="60" /><el-table-column prop="status" label="结果" width="95" /><el-table-column prop="energyTypeCode" label="能源" min-width="100" /><el-table-column prop="reasonText" label="行错误 / warning" min-width="220" show-overflow-tooltip /></el-table>
        <el-button type="danger" class="execute-import-button" :disabled="!canExecuteFactorImport" @click="openFactorImportExecute">进入执行确认</el-button>
      </template>
    </ManagementDrawer>
    <ManagementDrawer v-model="factorImportExecuteDrawerOpen" title="确认执行碳因子导入" confirm-label="确认导入" :loading="factorExecuteLoading" :confirm-disabled="factorImportConfirmText !== factorImportPreview?.confirmText || !canExecuteFactorImport" @save="executeFactorImport">
      <p class="drawer-notice">执行会以签名的当前预演候选写入碳因子并创建自动备份；不会覆盖、物理删除既有因子，也不会写入 carbon_emissions。</p>
      <el-form label-position="top"><el-form-item :label="`请输入固定确认文本：${factorImportPreview?.confirmText || ''}`"><el-input v-model="factorImportConfirmText" /></el-form-item></el-form>
      <el-alert v-if="factorExecuteError" type="error" :closable="false" show-icon :title="factorExecuteError" />
    </ManagementDrawer>
  </section>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ManagementToolbar from '@/components/ManagementToolbar.vue';
import ManagementDrawer from '@/components/ManagementDrawer.vue';
import HelpIcon from '@/components/HelpIcon.vue';
import PageState from '@/components/PageState.vue';
import StatCard from '@/components/StatCard.vue';
import StatusTag from '@/components/StatusTag.vue';
import {
  createCarbonFactor,
  downloadCarbonFactorTemplate,
  executeCarbonFactorImport,
  exportCarbonFactors,
  getCarbonFactor,
  getCarbonFactors,
  previewCarbonFactorImport,
  updateCarbonFactor,
  updateCarbonFactorStatus
} from '@/api/carbon';
import {
  buildCarbonFactorFilters,
  buildCarbonFactorImportExecutePayload,
  nextCarbonFactorStatus,
  numberValue
} from '@/utils/carbonManagement';
import { hasPermi } from '@/utils/permission';

// 组件属性模块：页面壳统一读取能源字典并提供只读副本。
const props = defineProps({ energyTypes: { type: Array, default: () => [] }, energyTypesError: { type: String, default: '' } });
// 空筛选工厂：年份保留 YYYY 原字符串并同时支持键盘输入。
const emptyFactorFilters = () => ({ energyTypeCode: '', region: '', factorYear: '', status: '', keyword: '' });
// 空表单工厂：日期字段保留 YYYY-MM-DD 原字符串。
const emptyFactorForm = () => ({ energyTypeCode: '', region: 'default', factorYear: '', unit: '', factorValue: undefined, factorUnit: 'kgCO2e', source: '', sourceUrl: '', effectiveFrom: '', effectiveTo: '', status: 'active' });
// 权限模块：仅控制前端可见性，服务端仍是最终鉴权边界。
const canFactorCreate = computed(() => hasPermi('carbon:factors:create'));
const canFactorUpdate = computed(() => hasPermi('carbon:factors:update'));
const canFactorStatus = computed(() => hasPermi('carbon:factors:status'));
const canFactorExport = computed(() => hasPermi('carbon:factors:export'));
const canFactorTemplate = computed(() => hasPermi('carbon:factor:template'));
const canFactorImport = computed(() => hasPermi('carbon:factor:import'));
// 列表和分页状态模块。
const factorDraftFilters = ref(emptyFactorFilters());
const factorAppliedFilters = ref(emptyFactorFilters());
const factorPage = ref(1);
const factorPageSize = ref(20);
const factorPagination = ref({ total: 0 });
const factors = ref([]);
const factorLoading = ref(false);
const factorError = ref('');
const factorExportLoading = ref(false);
const factorTemplateLoading = ref(false);
const factorStatusLoadingId = ref(null);
// 新增编辑抽屉状态模块。
const factorDrawerOpen = ref(false);
const factorEditingId = ref(null);
const factorForm = ref(emptyFactorForm());
const factorFormRef = ref();
const factorSaving = ref(false);
const factorFormError = ref('');
// 受控导入状态模块。
const factorImportDrawerOpen = ref(false);
const factorImportExecuteDrawerOpen = ref(false);
const factorImportFile = ref(null);
const factorImportPreview = ref(null);
const factorPreviewLoading = ref(false);
const factorExecuteLoading = ref(false);
const factorImportError = ref('');
const factorExecuteError = ref('');
const factorImportConfirmText = ref('');
// 表单规则模块：所有字段继续由服务端二次校验。
const factorRules = { energyTypeCode: [{ required: true, message: '请选择能源类型。', trigger: 'change' }], unit: [{ required: true, message: '请填写活动单位。', trigger: 'blur' }], factorValue: [{ required: true, type: 'number', message: '请填写大于 0 的因子值。', trigger: 'change' }], source: [{ required: true, message: '请填写因子来源。', trigger: 'blur' }] };
// 派生状态模块。
const activeEnergyTypes = computed(() => props.energyTypes.filter((item) => Number(item.isActive) === 1 || item.isActive === true));
const activeFactorCount = computed(() => factors.value.filter((row) => row.status === 'active').length);
const inactiveFactorCount = computed(() => factors.value.filter((row) => row.status === 'inactive').length);
const factorFormBlocked = computed(() => factorSaving.value || !activeEnergyTypes.value.length);
const canExecuteFactorImport = computed(() => Boolean(factorImportPreview.value?.batchId && factorImportPreview.value?.previewSignature && numberValue(factorImportPreview.value?.summary?.wouldImport) > 0 && Array.isArray(factorImportPreview.value?.candidateRows) && factorImportPreview.value.candidateRows.length === numberValue(factorImportPreview.value.summary?.wouldImport)));

// 方法模块：列表、编辑、启停、模板、导入和导出。
/** 将请求错误投影为用户可读消息。 */
function requestError(result) { return result?.error?.apiError?.message || result?.error?.message || '接口请求失败。'; }
/** 捕获请求错误并保留区域级展示。 */
async function safe(task) { try { return { ok: true, value: await task() }; } catch (error) { return { ok: false, error }; } }
/** 格式化有限数值。 */
function formatNumber(value, digits = 2) { return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(numberValue(value)); }
/** 格式化整数。 */
function formatInteger(value) { return formatNumber(value, 0); }
/** 加载碳因子列表。 */
async function loadFactors() { factorLoading.value = true; const result = await safe(() => getCarbonFactors(buildCarbonFactorFilters(factorAppliedFilters.value, { page: factorPage.value, pageSize: factorPageSize.value }))); factorLoading.value = false; if (result.ok) { factors.value = result.value.data || []; factorPagination.value = result.value.meta?.pagination || {}; factorError.value = ''; } else { factors.value = []; factorError.value = requestError(result); } }
/** 应用筛选并回到第一页。 */
function applyFactorFilters() { factorAppliedFilters.value = { ...factorDraftFilters.value }; factorPage.value = 1; loadFactors(); }
/** 清空筛选并回到第一页。 */
function resetFactorFilters() { factorDraftFilters.value = emptyFactorFilters(); factorAppliedFilters.value = emptyFactorFilters(); factorPage.value = 1; loadFactors(); }
/** 修改页大小后回到第一页。 */
function changeFactorPageSize() { factorPage.value = 1; loadFactors(); }
/** 打开新增因子抽屉。 */
function openFactorCreate() { factorEditingId.value = null; factorForm.value = emptyFactorForm(); factorFormError.value = ''; factorDrawerOpen.value = true; }
/** 读取详情并打开编辑抽屉。 */
async function openFactorEdit(row) { factorFormError.value = ''; const result = await safe(() => getCarbonFactor(row.id)); if (!result.ok) { ElMessage.error(`读取碳因子详情失败：${requestError(result)}`); return; } const factor = result.value.data || {}; factorEditingId.value = factor.id; factorForm.value = { energyTypeCode: factor.energyTypeCode || '', region: factor.region || 'default', factorYear: factor.factorYear ?? '', unit: factor.unit || '', factorValue: numberValue(factor.factorValue), factorUnit: factor.factorUnit || 'kgCO2e', source: factor.source || '', sourceUrl: factor.sourceUrl || '', effectiveFrom: factor.effectiveFrom || '', effectiveTo: factor.effectiveTo || '', status: factor.status || 'active' }; factorDrawerOpen.value = true; }
/** 保存新增或编辑因子。 */
async function saveFactor() { if (factorFormBlocked.value) return; const valid = await factorFormRef.value?.validate().catch(() => false); if (!valid) return; factorSaving.value = true; factorFormError.value = ''; const payload = { ...factorForm.value, factorYear: factorForm.value.factorYear || null }; const result = await safe(() => factorEditingId.value ? updateCarbonFactor(factorEditingId.value, payload) : createCarbonFactor(payload)); factorSaving.value = false; if (!result.ok) { factorFormError.value = requestError(result); return; } factorDrawerOpen.value = false; ElMessage.success(factorEditingId.value ? '碳因子已更新。' : '碳因子已新增。'); await loadFactors(); }
/** 二次确认后启停因子，绝不物理删除。 */
async function confirmFactorStatus(row) { const status = nextCarbonFactorStatus(row.status); const action = status === 'inactive' ? '停用' : '启用'; try { await ElMessageBox.confirm(`${action}“${row.energyTypeName || row.energyTypeCode} / ${row.region} / ${row.factorYear || '通用年份'}”碳因子？${status === 'inactive' ? '停用不是物理删除，已有排放历史及因子快照会保留。' : '启用后可重新参与后续服务端匹配。'}`, `确认${action}`, { type: status === 'inactive' ? 'warning' : 'info', confirmButtonText: `确认${action}`, cancelButtonText: '取消' }); } catch { return; } factorStatusLoadingId.value = row.id; const result = await safe(() => updateCarbonFactorStatus(row.id, status)); factorStatusLoadingId.value = null; if (!result.ok) { ElMessage.error(`碳因子${action}失败：${requestError(result)}`); return; } ElMessage.success(`碳因子已${action}。`); await loadFactors(); }
/** 下载受权限保护的因子模板。 */
async function downloadFactorTemplate() { factorTemplateLoading.value = true; const result = await safe(() => downloadCarbonFactorTemplate()); factorTemplateLoading.value = false; if (!result.ok) ElMessage.error(`碳因子模板下载失败：${requestError(result)}`); }
/** 导出已应用筛选。 */
async function exportFactors() { factorExportLoading.value = true; const result = await safe(() => exportCarbonFactors(buildCarbonFactorFilters(factorAppliedFilters.value))); factorExportLoading.value = false; if (!result.ok) ElMessage.error(`碳因子导出失败：${requestError(result)}`); }
/** 初始化导入预演抽屉。 */
function openFactorImport() { factorImportDrawerOpen.value = true; factorImportFile.value = null; factorImportPreview.value = null; factorImportError.value = ''; factorExecuteError.value = ''; factorImportConfirmText.value = ''; }
/** 选择原始文件并废弃旧预演。 */
function selectFactorImportFile(file) { factorImportFile.value = file.raw || null; factorImportPreview.value = null; factorImportError.value = ''; }
/** 清除导入文件和旧预演。 */
function clearFactorImportFile() { factorImportFile.value = null; factorImportPreview.value = null; }
/** 上传文件创建只读预演。 */
async function previewFactorImport() { if (!factorImportFile.value) return; factorPreviewLoading.value = true; factorImportError.value = ''; const result = await safe(() => previewCarbonFactorImport(factorImportFile.value)); factorPreviewLoading.value = false; if (!result.ok) { factorImportPreview.value = null; factorImportError.value = `碳因子导入预演失败：${requestError(result)}`; return; } factorImportPreview.value = result.value.data || {}; ElMessage.success('碳因子导入预演已完成，请核对候选、跳过和阻断行。'); }
/** 打开固定确认文本执行抽屉。 */
function openFactorImportExecute() { factorExecuteError.value = ''; factorImportConfirmText.value = ''; factorImportExecuteDrawerOpen.value = true; }
/** 原样提交服务器签名候选执行因子导入。 */
async function executeFactorImport() { if (!canExecuteFactorImport.value || factorImportConfirmText.value !== factorImportPreview.value?.confirmText) return; factorExecuteLoading.value = true; factorExecuteError.value = ''; const payload = { ...buildCarbonFactorImportExecutePayload(factorImportPreview.value), confirmText: factorImportConfirmText.value }; const result = await safe(() => executeCarbonFactorImport(payload)); factorExecuteLoading.value = false; if (!result.ok) { factorExecuteError.value = `碳因子导入执行失败：${requestError(result)}`; return; } factorImportExecuteDrawerOpen.value = false; factorImportDrawerOpen.value = false; factorImportPreview.value = null; ElMessage.success(`碳因子导入完成：成功 ${formatInteger(result.value.data?.imported)} 条，跳过 ${formatInteger(result.value.data?.skipped)} 条。`); await loadFactors(); }

onMounted(loadFactors);
</script>

<style scoped>
.module-section{display:grid;gap:14px}.module-heading{display:flex;align-items:center;justify-content:space-between}.module-heading h2{margin:0;color:#123b79;font-size:17px}.heading-with-help{display:flex;align-items:center}.stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.table-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.table-heading small,.table-heading span{color:#7385a2;font-size:12px}.pagination{display:flex;justify-content:flex-end;margin-top:16px;overflow-x:auto}.drawer-alert{margin-bottom:12px}.drawer-notice{margin:0 0 16px;color:#516170;line-height:1.7}.drawer-control{width:100%}.preview-summary{display:flex;flex-wrap:wrap;gap:14px;margin:16px 0;color:#516170;font-size:13px}.execute-import-button{margin-top:14px}@media (max-width:900px){.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:640px){.stat-grid{grid-template-columns:1fr}}
</style>
