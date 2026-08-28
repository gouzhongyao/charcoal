<template>
  <article class="source-facet" :aria-label="`${sourceLabel}核算结果分面`">
    <header class="facet-heading">
      <div><h3>{{ sourceLabel }}</h3><p>{{ sourceDescription }}</p></div>
      <span v-if="facet?.run">运行：{{ facet.run.runCode }}</span>
    </header>

    <section class="stat-grid" :aria-label="`${sourceLabel}统计`">
      <div class="stat-item"><span>结果数</span><strong>{{ summary.totalRecords }}</strong></div>
      <div class="stat-item"><span>已计算 / 因子缺失</span><strong>{{ summary.calculatedCount }} / {{ summary.factorMissingCount }}</strong></div>
      <div class="stat-item"><span>无效 / 已替代</span><strong>{{ summary.invalidRecordCount }} / {{ summary.supersededCount }}</strong></div>
      <div class="stat-item"><span>按排放单位总量</span><strong class="totals-text">{{ formatCarbonTotalsByUnit(statistics?.totalsByEmissionUnit || []) }}</strong></div>
    </section>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="facet-alert" />
    <PageState v-if="loading && !(facet?.rows || []).length" loading />
    <PageState v-else-if="error && !(facet?.rows || []).length" :error="error" @retry="$emit('retry')" />
    <PageState v-else-if="!(facet?.rows || []).length" :description="emptyDescription" />
    <template v-else>
      <el-table v-loading="loading" :data="facet.rows" row-key="id" border empty-text="暂无核算结果">
        <template v-if="sourceType === 'independent_activity'">
          <el-table-column prop="activityCode" label="活动记录编码" min-width="160" fixed="left" />
          <el-table-column prop="emissionScope" label="排放范围" min-width="105" />
          <el-table-column prop="activityCategory" label="活动类别" min-width="150" />
          <el-table-column label="组织 / 能源" min-width="210"><template #default="scope">{{ scope.row.organizationUnitName }}（{{ scope.row.organizationUnitCode }}）<br />{{ scope.row.energyTypeName }}（{{ scope.row.energyTypeCode }}）</template></el-table-column>
          <el-table-column label="来源墙钟" min-width="225"><template #default="scope">{{ formatSourceWallClockDisplay(scope.row.activityStartWallClock) }}<br />至 {{ formatSourceWallClockDisplay(scope.row.activityEndWallClock) }}</template></el-table-column>
          <el-table-column label="活动值" min-width="135"><template #default="scope">{{ formatNullableCarbonValue(scope.row.activityValue) }} {{ scope.row.activityUnit || '' }}</template></el-table-column>
          <el-table-column label="因子" min-width="180"><template #default="scope"><span v-if="scope.row.status === 'factor_missing'">—（factor_missing）</span><span v-else>{{ formatNullableCarbonValue(scope.row.factorValue) }} {{ scope.row.factorUnit || '' }}</span></template></el-table-column>
          <el-table-column label="排放量" min-width="185"><template #default="scope"><span v-if="scope.row.emissionValue === null">—（factor_missing）</span><span v-else>{{ formatNullableCarbonValue(scope.row.emissionValue) }} {{ scope.row.emissionUnit || '' }}</span></template></el-table-column>
          <el-table-column prop="missingReason" label="缺因子原因" min-width="240" show-overflow-tooltip />
          <el-table-column prop="runCode" label="运行编码" min-width="220" show-overflow-tooltip />
        </template>
        <template v-else>
          <el-table-column prop="normalizedMonth" label="月份" width="100" fixed="left" />
          <el-table-column label="能源类型" min-width="150"><template #default="scope">{{ scope.row.energyTypeName }}（{{ scope.row.energyTypeCode }}）</template></el-table-column>
          <el-table-column prop="organization" label="组织" min-width="150" show-overflow-tooltip />
          <el-table-column label="活动值" min-width="135"><template #default="scope">{{ formatNullableCarbonValue(scope.row.activityValue) }} {{ scope.row.activityUnit || '' }}</template></el-table-column>
          <el-table-column label="因子" min-width="180"><template #default="scope"><span v-if="scope.row.status === 'factor_missing'">—（factor_missing）</span><span v-else>{{ formatNullableCarbonValue(scope.row.factorValue) }}</span></template></el-table-column>
          <el-table-column label="排放量" min-width="185"><template #default="scope"><span v-if="scope.row.emissionValue === null">—（factor_missing）</span><span v-else>{{ formatNullableCarbonValue(scope.row.emissionValue) }} {{ scope.row.emissionUnit || '' }}</span></template></el-table-column>
          <el-table-column label="计算时间（UTC）" min-width="190"><template #default="scope">{{ formatStrictUtcDateTimeDisplay(scope.row.calculatedAt) }}</template></el-table-column>
        </template>
        <el-table-column label="状态" width="120" fixed="right"><template #default="scope"><el-tag :type="carbonAccountingStatusType(scope.row.status)">{{ carbonAccountingStatusLabel(scope.row.status) }}</el-tag></template></el-table-column>
      </el-table>
      <div class="pagination-wrap">
        <el-pagination
          :current-page="facet.pagination?.page || 1"
          :page-size="facet.pagination?.pageSize || 20"
          :total="facet.pagination?.total || 0"
          :page-sizes="[10,20,50,100]"
          layout="total, sizes, prev, pager, next, jumper"
          @current-change="handlePageChange"
          @size-change="handlePageSizeChange"
        />
      </div>
    </template>
  </article>
</template>

<script setup>
import { computed } from 'vue';
import PageState from '@/components/PageState.vue';
import { formatSourceWallClockDisplay, formatStrictUtcDateTimeDisplay } from '@/utils/dateTimeDisplay';
import {
  carbonAccountingStatusLabel,
  carbonAccountingStatusType,
  formatCarbonTotalsByUnit,
  formatNullableCarbonValue
} from '@/utils/carbonSourceManagement';

// 组件属性模块：单来源 facet、对应统计和独立 loading/error 由父组件提供。
const props = defineProps({
  sourceType: { type: String, required: true },
  facet: { type: Object, default: () => ({ rows: [], pagination: { total: 0 } }) },
  statistics: { type: Object, default: () => ({ summary: {}, totalsByEmissionUnit: [] }) },
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' }
});
// 组件事件模块：两个 all 分面分别回传自己的分页变化。
const emit = defineEmits(['page-change', 'page-size-change', 'retry']);

// 来源标签：明确区分独立活动与旧能耗来源。
const sourceLabel = computed(() => props.sourceType === 'independent_activity' ? '独立碳活动结果' : '旧能耗来源结果');
// 来源说明：旧来源必须被标记为显式兼容查看。
const sourceDescription = computed(() => props.sourceType === 'independent_activity'
  ? '读取独立核算运行冻结结果，默认选择此来源。'
  : '兼容查看旧 /api/carbon/emissions* 结果，不与独立活动结果直接合计。');
// 空态说明：分别说明如何产生对应来源结果。
const emptyDescription = computed(() => props.sourceType === 'independent_activity'
  ? '当前筛选或运行下暂无独立活动核算结果；请先创建独立核算运行。'
  : '当前筛选下暂无旧能耗核算结果；可在“旧能耗核算”页签显式执行旧计算。');
// 统计汇总：缺省字段稳定显示真实零，不影响结果字段的 null 展示。
const summary = computed(() => ({
  totalRecords: Number(props.statistics?.summary?.totalRecords || 0),
  calculatedCount: Number(props.statistics?.summary?.calculatedCount || 0),
  factorMissingCount: Number(props.statistics?.summary?.factorMissingCount || 0),
  invalidRecordCount: Number(props.statistics?.summary?.invalidRecordCount || 0),
  supersededCount: Number(props.statistics?.summary?.supersededCount || 0)
}));

// 方法模块：单个分面的分页事件投影。

/** 回传当前来源的新页码。 */
function handlePageChange(page) {
  emit('page-change', { sourceType: props.sourceType, page });
}

/** 回传当前来源的新页大小并由父组件重置该来源页码。 */
function handlePageSizeChange(pageSize) {
  emit('page-size-change', { sourceType: props.sourceType, pageSize });
}
</script>

<style scoped>
.source-facet{display:grid;gap:14px;padding:16px;background:#fff;border:1px solid #dce9fb;border-radius:12px;box-shadow:0 8px 20px rgba(28,83,158,.05);min-width:0}.facet-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap}.facet-heading h3{margin:0 0 5px;color:#123b79;font-size:17px}.facet-heading p{margin:0;color:var(--el-text-color-secondary);line-height:1.5}.facet-heading span{color:var(--el-text-color-secondary);font-size:12px}.stat-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.stat-item{display:grid;gap:6px;padding:11px;background:var(--el-fill-color-light);border:1px solid var(--el-border-color);border-radius:8px}.stat-item span{color:var(--el-text-color-secondary);font-size:12px}.stat-item strong{font-size:17px}.totals-text{font-size:13px!important;line-height:1.5}.facet-alert{margin-bottom:0}.pagination-wrap{display:flex;justify-content:flex-end;overflow-x:auto}@media (max-width:980px){.stat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media (max-width:620px){.stat-grid{grid-template-columns:1fr}}
</style>
