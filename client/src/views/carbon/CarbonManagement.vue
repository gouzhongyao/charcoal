<template>
  <ManagementPage title="碳核算">
    <template #title-extra>
      <HelpIcon
        label="查看碳核算管理说明"
        content="碳核算现分为碳因子、独立碳活动、独立核算运行、统一结果、旧能耗来源、碳排放报告和温室气体报告七个职责板块。统一结果默认读取 independent_activity；energy_record 和 all 都必须显式选择；N6 五部分报告与 N7 六部分报告独立维护事实。"
      />
    </template>

    <PageState
      v-if="!canManageCarbon"
      description="当前账号没有任一碳核算板块查看权限。N6 碳排放报告和 N7 温室气体报告必须分别授予 carbon:emission-reports:view、carbon:ghg-reports:view；旧 carbon:view 和两类报告权限均不会互相扩张。前端仅控制可见性，服务端仍会再次鉴权。"
    />
    <template v-else>
      <el-alert
        v-if="canAccountingView"
        title="统一结果默认来源为独立碳活动。旧能耗来源只能显式查看；两来源不可直接合计，避免双计。"
        type="warning"
        show-icon
        :closable="false"
        class="page-alert"
      />
      <el-alert
        v-if="energyTypesError"
        :title="`能源类型字典读取失败：${energyTypesError}`"
        type="warning"
        show-icon
        :closable="false"
        class="page-alert"
      />

      <el-tabs v-model="activeTab" class="carbon-tabs">
        <el-tab-pane v-if="canFactorView" label="碳因子" name="factors" lazy>
          <CarbonFactorsSection :energy-types="energyTypes" :energy-types-error="energyTypesError" />
        </el-tab-pane>
        <el-tab-pane v-if="canActivityView" label="独立碳活动" name="activities" lazy>
          <CarbonActivitiesSection :energy-types="energyTypes" />
        </el-tab-pane>
        <el-tab-pane v-if="canActivityView" label="独立核算运行" name="runs" lazy>
          <CarbonCalculationRunsSection :can-calculate="canActivityCalculate" @run-selected="handleRunSelected" />
        </el-tab-pane>
        <el-tab-pane v-if="canAccountingView" label="统一结果" name="results" lazy>
          <CarbonEmissionResultsSection
            :energy-types="energyTypes"
            :permission-state="accountingPermissionState"
            :selected-run-code="selectedRunCode"
            :selected-run-intent="selectedRunIntent"
          />
        </el-tab-pane>
        <el-tab-pane v-if="canLegacyEnergyView" label="旧能耗来源" name="legacy-energy" lazy>
          <LegacyEnergyCalculationPanel :energy-types="energyTypes" />
        </el-tab-pane>
        <el-tab-pane v-if="canEmissionReportView" label="碳排放报告" name="emission-reports" lazy>
          <CarbonEmissionReportsSection :active="activeTab === 'emission-reports'" />
        </el-tab-pane>
        <el-tab-pane v-if="canGhgReportView" label="温室气体报告" name="ghg-reports" lazy>
          <GhgReportsSection :active="activeTab === 'ghg-reports'" />
        </el-tab-pane>
      </el-tabs>
    </template>
  </ManagementPage>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import ManagementPage from '@/components/ManagementPage.vue';
import HelpIcon from '@/components/HelpIcon.vue';
import PageState from '@/components/PageState.vue';
import { getEnergyTypes } from '@/api/energy';
import { hasPermi } from '@/utils/permission';
import {
  createCarbonRunSelectionIntent,
  projectCarbonPagePermissions
} from '@/utils/carbonSourceManagement';
import { projectCarbonEmissionReportPermissions } from '@/utils/carbonEmissionReportManagement';
import { projectGhgReportPermissions } from '@/utils/ghgReportManagement';
import CarbonActivitiesSection from './components/CarbonActivitiesSection.vue';
import CarbonCalculationRunsSection from './components/CarbonCalculationRunsSection.vue';
import CarbonEmissionResultsSection from './components/CarbonEmissionResultsSection.vue';
import CarbonEmissionReportsSection from './components/CarbonEmissionReportsSection.vue';
import GhgReportsSection from './components/GhgReportsSection.vue';
import CarbonFactorsSection from './components/CarbonFactorsSection.vue';
import LegacyEnergyCalculationPanel from './components/LegacyEnergyCalculationPanel.vue';

// 权限投影模块：legacy carbon:view 只兼容旧因子和旧 emissions 板块，新 accounting 始终使用精确权限。
const carbonPermissions = computed(() => projectCarbonPagePermissions(hasPermi));
// N6 报告权限投影模块：旧 carbon:view、N7 和其他碳权限不得扩张。
const emissionReportPermissions = computed(() => projectCarbonEmissionReportPermissions(hasPermi));
// N7 报告权限投影模块：旧 carbon:view、N6 和其他碳权限不得扩张。
const ghgReportPermissions = computed(() => projectGhgReportPermissions(hasPermi));
// 旧因子读取权限：精确 carbon:factors:view 或 legacy carbon:view。
const canFactorView = computed(() => carbonPermissions.value.canFactorView);
// 独立活动精确读取权限：legacy 权限不得扩张此板块。
const canActivityView = computed(() => carbonPermissions.value.canActivityView);
// 独立活动运行创建权限：只使用精确权限。
const canActivityCalculate = computed(() => carbonPermissions.value.canActivityCalculate);
// 独立来源导出权限：只使用精确权限。
const canActivityExport = computed(() => carbonPermissions.value.canActivityExport);
// 新 accounting 旧来源精确权限：绝不能由 carbon:view 兜底。
const canEnergyView = computed(() => carbonPermissions.value.canAccountingEnergyView);
// 旧 emissions 板块读取权限：精确 carbon:emissions:view 或 legacy carbon:view。
const canLegacyEnergyView = computed(() => carbonPermissions.value.canLegacyEnergyView);
// 旧来源导出权限：只使用精确权限。
const canEnergyExport = computed(() => carbonPermissions.value.canEnergyExport);
// 统一结果可见性：至少拥有一套新 accounting 精确查看权限。
const canAccountingView = computed(() => canActivityView.value || canEnergyView.value);
// 碳排放报告可见性：只接受 N6 精确 view 权限。
const canEmissionReportView = computed(() => emissionReportPermissions.value.canView);
// 温室气体报告可见性：只接受 N7 精确 view 权限。
const canGhgReportView = computed(() => ghgReportPermissions.value.canView);
// 页面可见性：任一历史、新 accounting、N6 或 N7 报告板块可读即可进入。
const canManageCarbon = computed(() => canFactorView.value || canActivityView.value || canLegacyEnergyView.value || canEmissionReportView.value || canGhgReportView.value);
// 统一结果权限快照：all 查看和导出必须分别满足两套精确权限的 AND 条件。
const accountingPermissionState = computed(() => ({
  canActivityView: canActivityView.value,
  canActivityExport: canActivityExport.value,
  canEnergyView: canEnergyView.value,
  canEnergyExport: canEnergyExport.value
}));
// 能源类型字典需求：N6-only 或 N7-only 账号均不加载与独立报告事实无关的字典。
const requiresEnergyTypes = computed(() => canFactorView.value || canActivityView.value || canAccountingView.value || canLegacyEnergyView.value);
// 页面字典模块：依赖能源类型的历史和 accounting 板块共享一次请求；两类报告-only 账号均不发起无关请求。
const energyTypes = ref([]);
const energyTypesError = ref('');
// 当前页签：优先进入独立碳活动，其次因子、统一结果或旧来源。
const activeTab = ref('');
// 运行联动编码：运行板块选择后统一结果显式按该 runCode 查询。
const selectedRunCode = ref('');
// 运行选择意图：每次点击都递增，同一 runCode 连续选择也会重新应用。
const selectedRunIntent = ref(0);

// 方法模块：字典加载、初始页签和运行结果联动。
/** 选择当前账号第一个可见页签，避免绑定到无权限面板。 */
function resolveInitialTab() {
  if (canActivityView.value) return 'activities';
  if (canFactorView.value) return 'factors';
  if (canAccountingView.value) return 'results';
  if (canLegacyEnergyView.value) return 'legacy-energy';
  if (canEmissionReportView.value) return 'emission-reports';
  if (canGhgReportView.value) return 'ghg-reports';
  return '';
}

/** 加载共享能源类型字典，失败不阻断各板块的 error/empty 状态。 */
async function loadEnergyTypes() {
  try {
    const response = await getEnergyTypes();
    energyTypes.value = Array.isArray(response.data) ? response.data : [];
    energyTypesError.value = '';
  } catch (error) {
    energyTypes.value = [];
    energyTypesError.value = error?.apiError?.message || error?.message || '接口请求失败。';
  }
}

/** 选择运行后更新 runCode 和单调意图编号，同一运行重复点击也必须重新查询。 */
function handleRunSelected(runCode) {
  const selectionIntent = createCarbonRunSelectionIntent(
    runCode,
    selectedRunIntent.value
  );
  selectedRunCode.value = selectionIntent.runCode;
  selectedRunIntent.value = selectionIntent.intent;
  activeTab.value = 'results';
}

onMounted(async () => {
  if (!canManageCarbon.value) return;
  activeTab.value = resolveInitialTab();
  if (requiresEnergyTypes.value) await loadEnergyTypes();
});
</script>

<style scoped>
.page-alert{margin-bottom:14px}.carbon-tabs{min-width:0}.carbon-tabs :deep(.el-tabs__content){overflow:visible}.carbon-tabs :deep(.el-tab-pane){min-width:0}
</style>
