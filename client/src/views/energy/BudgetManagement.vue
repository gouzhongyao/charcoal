<template>
  <ManagementPage title="用能预算">
    <template #title-extra>
      <HelpIcon label="查看用能预算管理说明" content="预算按月份、能源类型和组织范围唯一维护。预算合计只显示原始预算值并按单位拆分，不做跨能源或跨单位换算；停用不物理删除，且不参与预算执行对比。" />
    </template>

    <PageState v-if="!canView" description="当前账号没有查看用能预算的权限。请联系管理员授予 energy:budget:view 权限。" />
    <template v-else>
      <ManagementToolbar :loading="loading" @search="applyFilters" @reset="resetFilters">
        <el-form-item label="开始月份"><el-date-picker v-model="draftFilters.monthStart" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" placeholder="开始月份" /></el-form-item>
        <el-form-item label="结束月份"><el-date-picker v-model="draftFilters.monthEnd" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" placeholder="结束月份" /></el-form-item>
        <el-form-item label="能源类型"><el-select v-model="draftFilters.energyTypeCode" clearable placeholder="全部能源类型"><el-option v-for="item in energyTypes" :key="item.code" :label="`${item.name}（${item.code}）`" :value="item.code" /></el-select></el-form-item>
        <el-form-item label="组织范围"><el-input v-model.trim="draftFilters.organizationScope" clearable placeholder="如：整体、生产部" /></el-form-item>
        <el-form-item label="状态"><el-select v-model="draftFilters.status" clearable placeholder="全部状态"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item>
        <el-form-item label="字符搜索"><el-input v-model.trim="draftFilters.keyword" clearable placeholder="组织、备注或能源类型" /></el-form-item>
        <template #actions>
          <el-button v-if="canTemplate" :loading="templateLoading" @click="downloadTemplate">下载模板</el-button>
          <el-button v-if="canImport" @click="openImport">导入预算</el-button>
          <el-button v-if="canExport" :loading="exportLoading" @click="exportCurrent">导出当前筛选</el-button>
          <el-button v-if="canCreate" type="primary" @click="openCreate">新增预算</el-button>
        </template>
      </ManagementToolbar>

      <el-alert v-if="energyTypesError" type="warning" :closable="false" show-icon :title="`能源类型字典读取失败：${energyTypesError}`" />
      <el-alert v-if="pageError" type="error" :closable="false" show-icon :title="pageError" />
      <PageState v-if="allRequestsFailed" :error="pageError" @retry="loadData" />
      <template v-else>
        <section class="stat-grid" aria-label="当前筛选下的预算汇总">
          <StatCard label="预算总数" :value="formatInteger(stats.totalBudgets)" note="当前筛选命中记录" />
          <StatCard label="启用 / 停用" :value="`${formatInteger(stats.activeCount)} / ${formatInteger(stats.inactiveCount)}`" note="停用记录保留追溯，不参与对比" />
          <StatCard label="原始预算值合计" :value="totalsByUnitLabel(stats.totalsByUnit)" note="按单位分别汇总，不能跨单位相加" />
          <StatCard label="月份覆盖" :value="monthCoverage" note="来自当前筛选预算" />
        </section>

        <section class="chart-grid">
          <article class="page-card chart-panel">
            <header class="chart-heading"><div class="heading-with-help"><h2>月度预算趋势</h2><HelpIcon label="查看月度预算趋势口径" content="趋势只显示所选单位的原始预算值，避免将不同单位直接相加。切换单位后，图表和表格同步更新。" /></div><el-select v-model="visualUnit" size="small" class="unit-select" placeholder="选择单位"><el-option v-for="unit in statUnits" :key="unit" :label="unit" :value="unit" /></el-select></header>
            <PageState v-if="statsError" :error="statsError" @retry="loadData" />
            <PageState v-else-if="!monthlyRows.length" description="当前筛选下暂无月度预算趋势" />
            <template v-else>
              <svg class="trend-chart" viewBox="0 0 640 270" role="img" :aria-label="`${visualUnit} 月度预算趋势折线图`" @mouseleave="trendTooltip = null">
                <line v-for="tick in 5" :key="tick" x1="52" :y1="44 + (tick - 1) * 38" x2="616" :y2="44 + (tick - 1) * 38" class="grid-line" />
                <text v-for="tick in 5" :key="`label-${tick}`" x="44" :y="48 + (tick - 1) * 38" text-anchor="end" class="axis-text">{{ formatNumber(trendMax * (1 - (tick - 1) / 4), 0) }}</text>
                <polyline :points="linePoints" class="trend-line" />
                <g v-for="(row, index) in monthlyRows" :key="row.periodMonth" class="trend-point" tabindex="0" role="button" :aria-label="trendLabel(row)" @mouseenter="trendTooltip = row" @focus="trendTooltip = row"><circle :cx="xFor(index, monthlyRows.length)" :cy="yFor(row.budgetValue)" r="12" class="point-hit" /><circle :cx="xFor(index, monthlyRows.length)" :cy="yFor(row.budgetValue)" r="4" class="point-dot" /></g>
                <text v-for="(row, index) in monthlyRows" :key="`month-${row.periodMonth}`" :x="xFor(index, monthlyRows.length)" y="244" text-anchor="middle" class="axis-text">{{ row.periodMonth }}</text>
              </svg>
              <p v-if="trendTooltip" class="chart-tooltip" role="status">{{ trendLabel(trendTooltip) }}</p>
              <el-table :data="monthlyRows" size="small" class="chart-table"><el-table-column prop="periodMonth" label="月份" min-width="100" /><el-table-column label="预算值" min-width="130"><template #default="{ row }">{{ formatNumber(row.budgetValue) }} {{ row.unit }}</template></el-table-column><el-table-column label="预算数" min-width="90"><template #default="{ row }">{{ formatInteger(row.budgetCount) }}</template></el-table-column></el-table>
            </template>
          </article>

          <article class="page-card chart-panel">
            <header class="chart-heading"><div class="heading-with-help"><h2>预算结构</h2><HelpIcon label="查看预算结构说明" content="能源类型和组织范围均按固定实体色展示；结构图只展示所选单位的原始预算值，并提供可读表格回退。" /></div><el-radio-group v-model="structureDimension" size="small"><el-radio-button label="energy">能源类型</el-radio-button><el-radio-button label="organization">组织范围</el-radio-button></el-radio-group></header>
            <PageState v-if="statsError" :error="statsError" @retry="loadData" />
            <PageState v-else-if="!structureRows.length" description="当前筛选下暂无结构数据" />
            <template v-else>
              <div class="bar-legend" aria-label="分类图例"><span v-for="row in structureRows" :key="structureKey(row)"><i :style="{ backgroundColor: categoryColor(structureKey(row)) }" />{{ structureName(row) }}</span></div>
              <div class="bar-chart" @mouseleave="structureTooltip = null"><button v-for="row in structureRows" :key="structureKey(row)" class="bar-row" type="button" :aria-label="structureLabel(row)" @mouseenter="structureTooltip = row" @focus="structureTooltip = row"><span class="bar-name"><i :style="{ backgroundColor: categoryColor(structureKey(row)) }" />{{ structureName(row) }}</span><span class="bar-track"><span class="bar-fill" :style="{ width: `${percentage(row.budgetValue, structureMax)}%`, backgroundColor: categoryColor(structureKey(row)) }" /></span><span class="bar-value">{{ formatNumber(row.budgetValue) }} {{ row.unit }}</span></button></div>
              <p v-if="structureTooltip" class="chart-tooltip" role="status">{{ structureLabel(structureTooltip) }}</p>
              <el-table :data="structureRows" size="small" class="chart-table"><el-table-column :label="structureDimension === 'energy' ? '能源类型' : '组织范围'" min-width="130"><template #default="{ row }">{{ structureName(row) }}</template></el-table-column><el-table-column label="预算值" min-width="140"><template #default="{ row }">{{ formatNumber(row.budgetValue) }} {{ row.unit }}</template></el-table-column><el-table-column label="预算数" min-width="90"><template #default="{ row }">{{ formatInteger(row.budgetCount) }}</template></el-table-column></el-table>
            </template>
          </article>
        </section>

        <article class="page-card chart-panel">
          <header class="chart-heading"><div class="heading-with-help"><h2>预算与实际执行对比</h2><HelpIcon label="查看预算执行对比边界" content="仅将服务端明确标记 isComparable 且预算单位与实际单位一致的行绘入图表。单位不一致、缺少预算及其他不可比较行继续保留在明细中，不计算差额或使用率，也不做跨单位换算。" /></div><el-select v-if="comparisonUnits.length" v-model="comparisonUnit" size="small" class="unit-select" placeholder="选择可比单位"><el-option v-for="unit in comparisonUnits" :key="unit" :label="unit" :value="unit" /></el-select></header>
          <PageState v-if="comparisonError" :error="comparisonError" @retry="loadData" />
          <PageState v-else-if="!comparisonTableRows.length" description="当前筛选下暂无预算执行数据" />
          <template v-else>
            <p class="comparison-summary" role="status">执行汇总：{{ budgetComparisonSummaryLabel(comparisonSummary) }}；可比较 {{ formatInteger(comparisonSummary.comparableRowCount) }} 行</p>
            <el-alert v-if="numberValue(comparisonSummary.unitMismatchCount) > 0" type="warning" :closable="false" show-icon :title="`存在 ${formatInteger(comparisonSummary.unitMismatchCount)} 行单位不一致，已保留在明细中并标记为不可比较，不参与图表、差额或使用率计算。`" />
            <template v-if="comparisonChartRows.length">
              <div class="comparison-legend" aria-label="预算与实际图例"><span><i class="legend-budget" />预算</span><span><i class="legend-actual" />实际</span><small>共同单位：{{ comparisonUnit }}</small></div>
              <div class="comparison-chart" @mouseleave="comparisonTooltip = null"><button v-for="row in comparisonChartRows" :key="comparisonKey(row)" class="comparison-row" type="button" :aria-label="comparisonLabel(row)" @mouseenter="comparisonTooltip = row" @focus="comparisonTooltip = row"><span class="comparison-name">{{ row.periodMonth }} · {{ row.energyTypeName || row.energyTypeCode }} · {{ row.organizationScope }}</span><span class="comparison-bars"><i class="comparison-budget" :style="{ width: `${percentage(row.budgetValue, comparisonMax)}%` }" /><i class="comparison-actual" :style="{ width: `${percentage(row.actualValue, comparisonMax)}%` }" /></span><StatusTag :status="comparisonStatus(row)" :label="budgetComparisonStatusLabel(row)" /></button></div>
              <p v-if="comparisonTooltip" class="chart-tooltip" role="status">{{ comparisonLabel(comparisonTooltip) }}</p>
            </template>
            <PageState v-else description="当前筛选下没有同单位且明确可比较的数据；请查看下方完整状态明细。" />
            <el-table :data="comparisonTableRows" size="small" class="chart-table"><el-table-column prop="periodMonth" label="月份" width="100" /><el-table-column prop="energyTypeName" label="能源类型" min-width="120" /><el-table-column prop="organizationScope" label="组织范围" min-width="130" /><el-table-column label="预算" min-width="145"><template #default="{ row }">{{ comparisonAmount(row.budgetValue, budgetComparisonBudgetUnit(row)) }}</template></el-table-column><el-table-column label="实际" min-width="145"><template #default="{ row }">{{ comparisonAmount(row.actualValue, budgetComparisonActualUnit(row)) }}</template></el-table-column><el-table-column label="差异" min-width="110"><template #default="{ row }">{{ comparisonVariance(row) }}</template></el-table-column><el-table-column label="使用率" min-width="100"><template #default="{ row }">{{ comparisonUsageRate(row) }}</template></el-table-column><el-table-column label="状态" min-width="180"><template #default="{ row }"><StatusTag :status="comparisonStatus(row)" :label="budgetComparisonStatusLabel(row)" /></template></el-table-column></el-table>
          </template>
        </article>

        <article class="page-card">
          <header class="chart-heading"><div class="heading-with-help"><h2>预算列表</h2><HelpIcon label="查看预算列表说明" content="列表、统计和对比均使用上方已应用的月份、能源类型、组织范围、状态和字符搜索条件；分页参数也会传给列表 API。" /></div><span>共 {{ formatInteger(pagination.total) }} 条</span></header>
          <PageState v-if="listError" :error="listError" @retry="loadData" />
          <PageState v-else-if="!budgets.length && !loading" description="暂无用能预算；可使用“新增预算”维护首条记录。" />
          <template v-else><el-table :data="budgets" v-loading="loading" stripe><el-table-column prop="periodMonth" label="月份" width="105" /><el-table-column prop="energyTypeName" label="能源类型" min-width="130" /><el-table-column prop="organizationScope" label="组织范围" min-width="135" show-overflow-tooltip /><el-table-column label="预算值" min-width="125"><template #default="{ row }">{{ formatNumber(row.budgetValue) }}</template></el-table-column><el-table-column prop="unit" label="单位" width="90" /><el-table-column label="状态" width="90"><template #default="{ row }"><StatusTag :status="row.status" /></template></el-table-column><el-table-column prop="remark" label="备注" min-width="150" show-overflow-tooltip /><el-table-column label="更新时间" min-width="165"><template #default="{ row }">{{ formatDateTime(row.updatedAt) }}</template></el-table-column><el-table-column label="操作" min-width="150" fixed="right"><template #default="{ row }"><el-button v-if="canUpdate" link type="primary" @click="openEdit(row)">编辑</el-button><el-button v-if="canStatus" link :type="row.status === 'active' ? 'warning' : 'success'" :loading="statusLoadingId === row.id" @click="confirmStatus(row)">{{ row.status === 'active' ? '停用' : '启用' }}</el-button></template></el-table-column></el-table><div class="pagination"><el-pagination v-model:current-page="page" v-model:page-size="pageSize" layout="total, sizes, prev, pager, next" :page-sizes="[20, 50, 100]" :total="pagination.total || 0" @current-change="loadData" @size-change="changePageSize" /></div></template>
        </article>
      </template>

      <ManagementDrawer v-model="editDrawerOpen" :title="editingId ? '编辑用能预算' : '新增用能预算'" :loading="saving" :confirm-disabled="formBlocked" @save="saveBudget">
        <el-alert v-if="formError" type="error" :closable="false" show-icon :title="formError" class="drawer-alert" />
        <el-alert v-if="editingId" type="info" :closable="false" show-icon title="编辑时能源类型已锁定，避免无提示改变能源类型；如需变更类型，请新建对应预算或先确认后端唯一性规则。" class="drawer-alert" />
        <el-alert v-if="!activeEnergyTypes.length" type="warning" :closable="false" show-icon title="暂无可选的 active 能源类型，请先维护能源类型后再保存预算。" class="drawer-alert" />
        <el-form ref="budgetFormRef" :model="budgetForm" :rules="budgetRules" label-position="top"><el-form-item label="预算月份" prop="periodMonth"><HelpIcon label="查看预算月份说明" content="使用 YYYY-MM 月份口径，同一月份、能源类型和组织范围只能有一条预算。" /><el-date-picker v-model="budgetForm.periodMonth" type="month" value-format="YYYY-MM" format="YYYY-MM" :editable="true" class="drawer-control" /></el-form-item><el-form-item label="能源类型" prop="energyTypeCode"><HelpIcon label="查看能源类型说明" content="仅能选择 active 状态的能源类型；编辑已有预算时锁定原能源类型，防止无提示更改。" /><el-input v-if="editingId" :model-value="selectedEditingEnergyLabel" disabled class="drawer-control" /><el-select v-else v-model="budgetForm.energyTypeCode" class="drawer-control" placeholder="选择 active 能源类型"><el-option v-for="item in activeEnergyTypes" :key="item.code" :label="`${item.name}（${item.code}）`" :value="item.code" /></el-select></el-form-item><el-form-item label="组织范围" prop="organizationScope"><HelpIcon label="查看组织范围说明" content="填写整体或实际组织、站点、部门、用能单元编码/名称/路径。整体表示实际能耗对比时不限制组织范围。" /><el-input v-model.trim="budgetForm.organizationScope" maxlength="255" show-word-limit /></el-form-item><el-form-item label="预算值" prop="budgetValue"><HelpIcon label="查看预算值说明" content="预算值为大于等于 0 的原始数值；不要在此处填写跨能源换算值。" /><el-input-number v-model="budgetForm.budgetValue" :min="0" :precision="2" class="drawer-control" /></el-form-item><el-form-item label="单位" prop="unit"><HelpIcon label="查看单位说明" content="留空时后端使用能源类型的标准单位。单位不同的预算只按单位分组展示，不会相加。" /><el-input v-model.trim="budgetForm.unit" maxlength="40" /></el-form-item><el-form-item label="状态" prop="status"><el-select v-model="budgetForm.status"><el-option label="启用" value="active" /><el-option label="停用" value="inactive" /></el-select></el-form-item><el-form-item label="备注"><el-input v-model.trim="budgetForm.remark" type="textarea" :rows="3" maxlength="1000" show-word-limit /></el-form-item></el-form>
      </ManagementDrawer>

      <ManagementDrawer v-model="importDrawerOpen" title="导入用能预算：上传预演" confirm-label="开始预演" :loading="previewLoading" :confirm-disabled="!importFile" @save="previewImport">
        <p class="drawer-notice">预演只校验并记录导入审计，不写入预算。重复的月份、能源类型、组织范围记录会按 skip 策略跳过并展示 warning。</p>
        <el-upload :auto-upload="false" :limit="1" accept=".xlsx,.xls,.csv" :on-change="selectImportFile" :on-remove="clearImportFile"><el-button>选择预算表格</el-button><template #tip><div class="el-upload__tip">支持 .xlsx、.xls、.csv，字段可先下载模板核对。</div></template></el-upload>
        <el-alert v-if="importError" type="error" :closable="false" show-icon :title="importError" class="drawer-alert" />
        <template v-if="importPreview"><div class="preview-summary"><span>成功候选 {{ formatInteger(importPreview.summary?.wouldImport) }}</span><span>跳过 {{ formatInteger(importPreview.summary?.skipped) }}</span><span>阻断 {{ formatInteger(importPreview.summary?.blocked) }}</span><span>warning {{ formatInteger(importPreview.summary?.warnings) }}</span></div><el-table :data="importPreview.items || []" size="small" max-height="250"><el-table-column prop="rowNumber" label="行" width="64" /><el-table-column prop="status" label="结果" min-width="95" /><el-table-column prop="energyTypeCode" label="能源" min-width="100" /><el-table-column prop="reasonText" label="行错误 / warning" min-width="220" show-overflow-tooltip /></el-table><el-button class="execute-import-button" type="danger" :disabled="!canExecuteImport" @click="openExecuteImport">进入执行确认</el-button></template>
      </ManagementDrawer>

      <ManagementDrawer v-model="executeDrawerOpen" title="确认执行预算导入" confirm-label="确认导入" :loading="executeLoading" :confirm-disabled="confirmText !== importPreview?.confirmText || !canExecuteImport" @save="executeImport">
        <p class="drawer-notice">此操作会按当前预演候选写入预算，并由后端创建自动备份。重复、冲突和无效记录维持 skip，不覆盖、不物理删除现有预算。</p>
        <el-form label-position="top"><el-form-item :label="`请输入固定确认文本：${importPreview?.confirmText || ''}`"><el-input v-model="confirmText" /></el-form-item></el-form>
        <el-alert v-if="executeError" type="error" :closable="false" show-icon :title="executeError" />
      </ManagementDrawer>
    </template>
  </ManagementPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import ManagementPage from '@/components/ManagementPage.vue';
import ManagementToolbar from '@/components/ManagementToolbar.vue';
import ManagementDrawer from '@/components/ManagementDrawer.vue';
import HelpIcon from '@/components/HelpIcon.vue';
import PageState from '@/components/PageState.vue';
import StatCard from '@/components/StatCard.vue';
import StatusTag from '@/components/StatusTag.vue';
import { getEnergyTypes } from '@/api/energy';
import { createEnergyBudget, downloadEnergyBudgetTemplate, executeEnergyBudgetImport, exportEnergyBudgets, getEnergyBudgetExecutionComparison, getEnergyBudgetStats, getEnergyBudgets, previewEnergyBudgetImport, updateEnergyBudget, updateEnergyBudgetStatus } from '@/api/budgets';
import { buildBudgetFilters, buildBudgetImportExecutePayload, categoryColor, nextBudgetStatus, numberValue, totalsByUnitLabel } from '@/utils/budgetManagement';
import { budgetComparisonActualUnit, budgetComparisonBudgetUnit, budgetComparisonChartRows, budgetComparisonMetricValue, budgetComparisonStatusLabel, budgetComparisonSummaryLabel, budgetComparisonUnits, isBudgetUnitMismatch, isComparableBudgetRow } from '@/utils/energyBudgetManagement';
import { hasPermi } from '@/utils/permission';
import { formatStrictUtcDateTimeDisplay } from '@/utils/dateTimeDisplay';

const emptyFilters = () => ({ monthStart: '', monthEnd: '', energyTypeCode: '', organizationScope: '', status: '', keyword: '' });
const emptyForm = () => ({ periodMonth: '', energyTypeCode: '', organizationScope: '整体', budgetValue: undefined, unit: '', remark: '', status: 'active' });
const safe = async (task) => { try { return { ok: true, value: await task() }; } catch (error) { return { ok: false, error }; } };
const requestError = (result) => result?.error?.message || '接口请求失败。';
const draftFilters = ref(emptyFilters()); const appliedFilters = ref(emptyFilters());
const page = ref(1); const pageSize = ref(20); const pagination = ref({ total: 0 }); const budgets = ref([]); const stats = ref({ totalsByUnit: [], monthlyTrend: [], byEnergyType: [], byOrganizationScope: [] }); const comparison = ref([]);
// 预算执行摘要保留服务端单位安全口径，不从明细前端重算。
const comparisonSummary = ref({ totalsByUnit: [], unitMismatchCount: 0, comparableRowCount: 0, summaryUnit: null });
const energyTypes = ref([]); const energyTypesError = ref(''); const loading = ref(false); const listError = ref(''); const statsError = ref(''); const comparisonError = ref('');
const visualUnit = ref(''); const structureDimension = ref('energy'); const comparisonUnit = ref(''); const trendTooltip = ref(null); const structureTooltip = ref(null); const comparisonTooltip = ref(null);
const exportLoading = ref(false); const templateLoading = ref(false); const statusLoadingId = ref(null);
const editDrawerOpen = ref(false); const editingId = ref(null); const budgetForm = ref(emptyForm()); const budgetFormRef = ref(); const saving = ref(false); const formError = ref('');
const importDrawerOpen = ref(false); const executeDrawerOpen = ref(false); const importFile = ref(null); const importPreview = ref(null); const previewLoading = ref(false); const executeLoading = ref(false); const importError = ref(''); const executeError = ref(''); const confirmText = ref('');
const budgetRules = { periodMonth: [{ required: true, message: '请选择预算月份。', trigger: 'change' }], energyTypeCode: [{ required: true, message: '请选择 active 能源类型。', trigger: 'change' }], organizationScope: [{ required: true, message: '请填写组织范围。', trigger: 'blur' }], budgetValue: [{ required: true, type: 'number', message: '请输入大于等于 0 的预算值。', trigger: 'change' }] };

const canView = computed(() => hasPermi('energy:budget:view')); const canCreate = computed(() => hasPermi('energy:budget:create')); const canUpdate = computed(() => hasPermi('energy:budget:update')); const canStatus = computed(() => hasPermi('energy:budget:status')); const canImport = computed(() => hasPermi('energy:budget:import')); const canExport = computed(() => hasPermi('energy:budget:export')); const canTemplate = computed(() => hasPermi('energy:budget:template'));
const activeEnergyTypes = computed(() => energyTypes.value.filter((item) => Number(item.isActive) === 1 || item.isActive === true));
const pageError = computed(() => listError.value || statsError.value || comparisonError.value); const allRequestsFailed = computed(() => Boolean(listError.value && statsError.value && comparisonError.value));
const statUnits = computed(() => [...new Set((stats.value.totalsByUnit || []).map((row) => row.unit).filter(Boolean))]);
const monthlyRows = computed(() => (stats.value.monthlyTrend || []).filter((row) => row.unit === visualUnit.value).sort((left, right) => left.periodMonth.localeCompare(right.periodMonth)));
const structureRows = computed(() => (structureDimension.value === 'energy' ? stats.value.byEnergyType : stats.value.byOrganizationScope || []).filter((row) => row.unit === visualUnit.value));
// 图表单位和数据严格来自服务端明确标记的同单位可比较行。
const comparisonUnits = computed(() => budgetComparisonUnits(comparison.value));
const comparisonChartRows = computed(() => budgetComparisonChartRows(comparison.value, comparisonUnit.value));
// 表格保留单位不一致、缺少预算及其他不可比较状态，避免静默过滤。
const comparisonTableRows = computed(() => comparison.value);
const trendMax = computed(() => Math.max(...monthlyRows.value.map((row) => numberValue(row.budgetValue)), 1)); const structureMax = computed(() => Math.max(...structureRows.value.map((row) => numberValue(row.budgetValue)), 1)); const comparisonMax = computed(() => Math.max(...comparisonChartRows.value.flatMap((row) => [numberValue(row.budgetValue), numberValue(row.actualValue)]), 1));
const linePoints = computed(() => monthlyRows.value.map((row, index) => `${xFor(index, monthlyRows.value.length)},${yFor(row.budgetValue)}`).join(' '));
const monthCoverage = computed(() => { const rows = stats.value.monthlyTrend || []; const months = [...new Set(rows.map((row) => row.periodMonth).filter(Boolean))].sort(); return months.length ? `${months[0]} 至 ${months.at(-1)}（${months.length} 月）` : '暂无'; });
const selectedEditingEnergyLabel = computed(() => { const row = energyTypes.value.find((item) => item.code === budgetForm.value.energyTypeCode); return row ? `${row.name}（${row.code}）` : budgetForm.value.energyTypeCode || '—'; });
const formBlocked = computed(() => saving.value || !activeEnergyTypes.value.length || (editingId.value && !activeEnergyTypes.value.some((item) => item.code === budgetForm.value.energyTypeCode)));
const canExecuteImport = computed(() => Boolean(importPreview.value?.batchId && importPreview.value?.previewSignature && numberValue(importPreview.value?.summary?.wouldImport) > 0 && Array.isArray(importPreview.value?.candidateRows) && importPreview.value.candidateRows.length === numberValue(importPreview.value.summary?.wouldImport)));

function formatNumber(value, digits = 2) { return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(numberValue(value)); }
function formatInteger(value) { return formatNumber(value, 0); }
function formatPercent(value) { return value === null || value === undefined ? '—' : `${formatNumber(numberValue(value) * 100, 1)}%`; }
function formatDateTime(value) { return formatStrictUtcDateTimeDisplay(value); }
function xFor(index, total) { return total <= 1 ? 334 : 62 + (index * 544) / (total - 1); }
function yFor(value) { return 196 - (numberValue(value) / trendMax.value) * 152; }
function percentage(value, maximum) { return Math.max(2, Math.min(100, (numberValue(value) / maximum) * 100)); }
function trendLabel(row) { return `${row.periodMonth}：预算 ${formatNumber(row.budgetValue)} ${row.unit}，${formatInteger(row.budgetCount)} 条记录`; }
function structureKey(row) { return structureDimension.value === 'energy' ? row.energyTypeCode : row.organizationScope; }
function structureName(row) { return structureDimension.value === 'energy' ? (row.energyTypeName || row.energyTypeCode) : row.organizationScope; }
function structureLabel(row) { return `${structureName(row)}：原始预算值 ${formatNumber(row.budgetValue)} ${row.unit}，${formatInteger(row.budgetCount)} 条预算`; }
function comparisonKey(row) { return `${row.periodMonth}-${row.energyTypeCode}-${row.organizationScope}`; }
// 将预算执行状态映射为现有状态标签样式，单位不一致使用规则阻断语义。
function comparisonStatus(row) { if (isBudgetUnitMismatch(row)) return 'blocked'; if (row.comparisonStatus === 'missing_budget' || row.comparisonStatus === 'no_actual' || row.comparisonStatus === 'no_data') return 'missing'; return row.warningLevel === 'exceeded' ? 'inactive' : row.warningLevel === 'nearing' ? 'candidate-by-meter' : isComparableBudgetRow(row) ? 'active' : 'missing'; }
// 格式化预算或实际值；缺失值不转换为 0，并分别展示各自单位。
function comparisonAmount(value, unit) { return value === null || value === undefined ? '—' : `${formatNumber(value)} ${unit || '未标注单位'}`; }
// 不可比较行不展示差额，避免单位不一致仍出现计算结果。
function comparisonVariance(row) { const value = budgetComparisonMetricValue(row, 'variance'); return value === null ? '—' : formatNumber(value); }
// 不可比较行不展示使用率，避免单位不一致仍出现计算结果。
function comparisonUsageRate(row) { const value = budgetComparisonMetricValue(row, 'usageRate'); return value === null ? '—' : formatPercent(value); }
// 图表提示仅用于可比较行，完整状态仍由下方表格展示。
function comparisonLabel(row) { return `${row.periodMonth} ${row.energyTypeName || row.energyTypeCode} ${row.organizationScope}：预算 ${comparisonAmount(row.budgetValue, budgetComparisonBudgetUnit(row))}，实际 ${comparisonAmount(row.actualValue, budgetComparisonActualUnit(row))}，差异 ${comparisonVariance(row)}，使用率 ${comparisonUsageRate(row)}，${budgetComparisonStatusLabel(row)}`; }

async function loadEnergyTypes() { const result = await safe(getEnergyTypes); if (result.ok) { energyTypes.value = result.value.data || []; energyTypesError.value = ''; } else energyTypesError.value = requestError(result); }
async function loadData() {
  if (!canView.value) return;
  loading.value = true; const params = buildBudgetFilters(appliedFilters.value, { page: page.value, pageSize: pageSize.value });
  const [listResult, statsResult, comparisonResult] = await Promise.all([safe(() => getEnergyBudgets(params)), safe(() => getEnergyBudgetStats(params)), safe(() => getEnergyBudgetExecutionComparison(params))]); loading.value = false;
  if (listResult.ok) { budgets.value = listResult.value.data || []; pagination.value = listResult.value.meta?.pagination || {}; listError.value = ''; } else { budgets.value = []; listError.value = requestError(listResult); }
  if (statsResult.ok) { stats.value = statsResult.value.data || { totalsByUnit: [], monthlyTrend: [], byEnergyType: [], byOrganizationScope: [] }; statsError.value = ''; if (!statUnits.value.includes(visualUnit.value)) visualUnit.value = statUnits.value[0] || ''; } else { statsError.value = requestError(statsResult); }
  if (comparisonResult.ok) { comparison.value = comparisonResult.value.data || []; comparisonSummary.value = comparisonResult.value.meta?.summary || { totalsByUnit: [], unitMismatchCount: 0, comparableRowCount: 0, summaryUnit: null }; comparisonError.value = ''; if (!comparisonUnits.value.includes(comparisonUnit.value)) comparisonUnit.value = comparisonUnits.value[0] || ''; } else { comparison.value = []; comparisonSummary.value = { totalsByUnit: [], unitMismatchCount: 0, comparableRowCount: 0, summaryUnit: null }; comparisonError.value = requestError(comparisonResult); }
}
function applyFilters() { appliedFilters.value = { ...draftFilters.value }; page.value = 1; loadData(); }
function resetFilters() { draftFilters.value = emptyFilters(); appliedFilters.value = emptyFilters(); page.value = 1; loadData(); }
function changePageSize() { page.value = 1; loadData(); }
function openCreate() { editingId.value = null; budgetForm.value = emptyForm(); formError.value = ''; editDrawerOpen.value = true; }
function openEdit(row) { editingId.value = row.id; budgetForm.value = { periodMonth: row.periodMonth, energyTypeCode: row.energyTypeCode, organizationScope: row.organizationScope, budgetValue: numberValue(row.budgetValue), unit: row.unit || '', remark: row.remark || '', status: row.status }; formError.value = ''; editDrawerOpen.value = true; }
async function saveBudget() { if (formBlocked.value) return; const valid = await budgetFormRef.value?.validate().catch(() => false); if (!valid) return; saving.value = true; formError.value = ''; const payload = { ...budgetForm.value }; const result = await safe(() => editingId.value ? updateEnergyBudget(editingId.value, payload) : createEnergyBudget(payload)); saving.value = false; if (!result.ok) { formError.value = requestError(result); return; } editDrawerOpen.value = false; ElMessage.success(editingId.value ? '预算已更新。' : '预算已新增。'); await loadData(); }
async function confirmStatus(row) { const status = nextBudgetStatus(row.status); const action = status === 'inactive' ? '停用' : '启用'; try { await ElMessageBox.confirm(`${action}“${row.periodMonth} ${row.energyTypeName || row.energyTypeCode} / ${row.organizationScope}”预算？${status === 'inactive' ? '停用不是物理删除，记录会保留追溯且不参与执行对比。' : '启用后该预算可重新参与执行对比。'}`, `确认${action}`, { type: status === 'inactive' ? 'warning' : 'info', confirmButtonText: `确认${action}`, cancelButtonText: '取消' }); } catch { return; } statusLoadingId.value = row.id; const result = await safe(() => updateEnergyBudgetStatus(row.id, status)); statusLoadingId.value = null; if (!result.ok) { ElMessage.error(`预算${action}失败：${requestError(result)}`); return; } ElMessage.success(`预算已${action}。`); await loadData(); }
async function downloadTemplate() { templateLoading.value = true; const result = await safe(() => downloadEnergyBudgetTemplate()); templateLoading.value = false; if (!result.ok) ElMessage.error(`模板下载失败：${requestError(result)}`); }
async function exportCurrent() { exportLoading.value = true; const result = await safe(() => exportEnergyBudgets(buildBudgetFilters(appliedFilters.value, { page: page.value, pageSize: pageSize.value }))); exportLoading.value = false; if (!result.ok) ElMessage.error(`预算导出失败：${requestError(result)}`); }
function openImport() { importDrawerOpen.value = true; importFile.value = null; importPreview.value = null; importError.value = ''; executeError.value = ''; confirmText.value = ''; }
function selectImportFile(file) { importFile.value = file.raw || null; importPreview.value = null; importError.value = ''; }
function clearImportFile() { importFile.value = null; importPreview.value = null; }
async function previewImport() { if (!importFile.value) return; previewLoading.value = true; importError.value = ''; const result = await safe(() => previewEnergyBudgetImport(importFile.value)); previewLoading.value = false; if (!result.ok) { importPreview.value = null; importError.value = `预算导入预演失败：${requestError(result)}`; return; } importPreview.value = result.value.data || {}; ElMessage.success('预算导入预演已完成，请核对候选、跳过和错误行。'); }
function openExecuteImport() { executeError.value = ''; confirmText.value = ''; executeDrawerOpen.value = true; }
async function executeImport() { if (!canExecuteImport.value || confirmText.value !== importPreview.value?.confirmText) return; executeLoading.value = true; executeError.value = ''; const payload = { ...buildBudgetImportExecutePayload(importPreview.value), confirmText: confirmText.value }; const result = await safe(() => executeEnergyBudgetImport(payload)); executeLoading.value = false; if (!result.ok) { executeError.value = `预算导入执行失败：${requestError(result)}`; return; } executeDrawerOpen.value = false; importDrawerOpen.value = false; ElMessage.success(`预算导入完成：成功 ${formatInteger(result.value.data?.imported)} 条，跳过 ${formatInteger(result.value.data?.skipped)} 条。`); importPreview.value = null; await loadData(); }

onMounted(async () => { if (!canView.value) return; await loadEnergyTypes(); await loadData(); });
</script>

<style scoped>
.stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.chart-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.chart-panel{min-width:0}.chart-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.chart-heading h2{margin:0;color:#123b79;font-size:16px}.chart-heading span,.chart-heading small{color:#7385a2;font-size:12px}.heading-with-help{display:flex;align-items:center}.unit-select{width:132px}.trend-chart{width:100%;min-height:270px;background:#fcfcfb;border:1px solid #e1e0d9;border-radius:10px}.grid-line{stroke:#e1e0d9;stroke-width:1}.axis-text{fill:#898781;font-size:11px}.trend-line{fill:none;stroke:#2a78d6;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.point-hit{fill:transparent}.point-dot{fill:#2a78d6;stroke:#fcfcfb;stroke-width:2}.trend-point{cursor:pointer}.trend-point:focus{outline:none}.trend-point:focus .point-dot,.trend-point:hover .point-dot{r:6;filter:drop-shadow(0 2px 5px rgba(42,120,214,.35))}.chart-tooltip{margin:8px 0;padding:8px 10px;color:#183153;background:#edf5ff;border:1px solid #c9dcf5;border-radius:8px;font-size:13px}.chart-table{margin-top:10px;width:100%}.bar-legend,.comparison-legend{display:flex;flex-wrap:wrap;gap:10px 14px;margin-bottom:10px;color:#516170;font-size:12px}.bar-legend span,.comparison-legend span{display:inline-flex;align-items:center;gap:5px}.bar-legend i,.comparison-legend i{width:10px;height:10px;border:1px solid rgba(11,11,11,.1);border-radius:2px}.bar-chart{display:grid;gap:10px}.bar-row{display:grid;grid-template-columns:minmax(96px,.8fr) minmax(130px,2fr) minmax(112px,.8fr);align-items:center;gap:10px;width:100%;padding:5px 0;color:#183153;text-align:left;background:transparent;border:0;border-radius:6px}.bar-row:focus-visible,.comparison-row:focus-visible{outline:2px solid #1769e0;outline-offset:2px}.bar-row:hover,.comparison-row:hover{background:#f7fbff}.bar-name{display:flex;align-items:center;gap:7px;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar-name i{width:10px;height:10px;flex:0 0 10px;border:1px solid rgba(11,11,11,.1);border-radius:2px}.bar-track{height:14px;padding-right:2px;background:#e7f1ff;border-radius:999px}.bar-fill{display:block;height:14px;border-right:2px solid #fcfcfb;border-radius:0 999px 999px 0}.bar-value{color:#516170;font-size:12px;text-align:right;white-space:nowrap}.comparison-summary{margin:0 0 12px;color:#516170;font-size:13px;line-height:1.7}.comparison-legend .legend-budget,.comparison-budget{background:#2a78d6}.comparison-legend .legend-actual,.comparison-actual{background:#eb6834}.comparison-chart{display:grid;gap:9px}.comparison-row{display:grid;grid-template-columns:minmax(130px,1fr) minmax(170px,2fr) 112px;align-items:center;gap:10px;padding:6px;color:#183153;text-align:left;background:transparent;border:0;border-radius:6px}.comparison-name{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.comparison-bars{display:grid;gap:3px;padding:3px 2px;background:#edf4fc;border-radius:8px}.comparison-bars i{display:block;height:8px;border-right:2px solid #fcfcfb;border-radius:0 999px 999px 0}.pagination{display:flex;justify-content:flex-end;margin-top:16px}.drawer-alert{margin-bottom:12px}.drawer-notice{margin:0 0 16px;color:#516170;line-height:1.7}.drawer-control{width:100%}.preview-summary{display:flex;flex-wrap:wrap;gap:14px;margin:16px 0;color:#516170;font-size:13px}.execute-import-button{margin-top:14px}@media (max-width:1120px){.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.chart-grid{grid-template-columns:1fr}}@media (max-width:720px){.stat-grid{grid-template-columns:1fr}.chart-heading{align-items:flex-start;flex-direction:column}.bar-row,.comparison-row{grid-template-columns:1fr}.bar-value{text-align:left}.trend-chart{min-width:620px}.chart-panel{overflow-x:auto}}
</style>
