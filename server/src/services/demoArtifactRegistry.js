'use strict';

const { AppError } = require('../utils/errors');

// 阶段 2 静态注册表只描述真实链路和后续 ownership 元数据，不执行阶段 3 所有权登记。
const OWNERSHIP_STAGE_BLOCKER = 'ownership-stage-3-not-connected';
// 旧式 retained upload 链路在完成服务端重放绑定前不得声明 context execute 可用。
const RETAINED_UPLOAD_CONTEXT_BLOCKER = 'retained-upload-context-replay-not-connected';
// 保留旧式上传链路的真实 blocker；生命周期改由每个 definition 显式声明。
const LEGACY_RETAINED_ARTIFACT_ORDERS = new Set([5, 6, 9, 10]);
// 下载生命周期只允许两种受控策略，模板路由不得再按单个 artifact key 散落特例。
const DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES = Object.freeze({
  STATELESS_FORMAL_IMPORT: 'stateless-formal-import',
  MANAGED_CONTEXT_AUTO_RUNTIME: 'managed-context-auto-runtime'
});
const DEMO_ARTIFACT_DOWNLOAD_LIFECYCLE_SET = new Set(Object.values(DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES));

/** 冻结单个 artifact 注册项及其所有嵌套对象，避免运行期改写治理契约。 */
function defineArtifact(definition) {
  const artifactOrder = Number.parseInt(String(definition.artifactKey).slice(0, 2), 10);
  const ownershipTargets = Object.freeze([...definition.ownershipTargets]);
  const batchRoles = Object.freeze(definition.batchRoles.map((role, index) => Object.freeze({
    role,
    entityType: ownershipTargets[index] || ownershipTargets[0]
  })));
  return Object.freeze({
    artifactKey: definition.artifactKey,
    handlerKey: definition.handler,
    mode: definition.mode,
    downloadLifecycle: definition.downloadLifecycle,
    templateType: definition.template,
    permissions: Object.freeze({
      download: definition.downloadPermission,
      preview: definition.previewPermission,
      execute: definition.executePermission
    }),
    routes: Object.freeze(Object.fromEntries(Object.entries(definition.routes).map(([key, values]) => [
      key,
      Object.freeze([...(values || [])])
    ]))),
    batchRoles,
    actor: Object.freeze({ ...definition.actor }),
    guards: Object.freeze([...definition.guards]),
    ownershipTargets,
    blocker: Object.freeze({
      ownershipRegistration: OWNERSHIP_STAGE_BLOCKER,
      previewExecuteContext: LEGACY_RETAINED_ARTIFACT_ORDERS.has(artifactOrder)
        ? RETAINED_UPLOAD_CONTEXT_BLOCKER
        : (definition.downloadLifecycle === DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.MANAGED_CONTEXT_AUTO_RUNTIME
            ? null
            : 'direct-upload-context-not-connected')
    })
  });
}

/** 显式声明无状态正式导入生命周期，不注册 ownership 或自动清理能力。 */
function defineStatelessArtifact(definition) {
  return defineArtifact({
    ...definition,
    downloadLifecycle: DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.STATELESS_FORMAL_IMPORT
  });
}

/** 显式声明已接入中央演示 context 的托管运行时生命周期。 */
function defineManagedArtifact(definition) {
  return defineArtifact({
    ...definition,
    downloadLifecycle: DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.MANAGED_CONTEXT_AUTO_RUNTIME
  });
}

// 29 项注册信息必须逐项对应真实模板、真实权限和真实路由；mode 仅描述链路形态，不能替代 guards。
const DEMO_ARTIFACT_REGISTRY = Object.freeze([
  defineStatelessArtifact({ artifactKey: '01-organization-root', handler: 'organization-units-import', mode: 'direct-upload', template: 'organization-units', downloadPermission: 'ledger:units:import', previewPermission: null, executePermission: 'ledger:units:import', routes: { download: ['/api/templates/demo-park/01-organization-root.xlsx', '/api/templates/demo-park/01-organization-root.csv'], preview: [], execute: ['/api/organization/units/import'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['organization_unit'] }),
  defineStatelessArtifact({ artifactKey: '02-organization-departments', handler: 'organization-units-import', mode: 'direct-upload', template: 'organization-units', downloadPermission: 'ledger:units:import', previewPermission: null, executePermission: 'ledger:units:import', routes: { download: ['/api/templates/demo-park/02-organization-departments.xlsx', '/api/templates/demo-park/02-organization-departments.csv'], preview: [], execute: ['/api/organization/units/import'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['organization_unit'] }),
  defineStatelessArtifact({ artifactKey: '03-organization-process-equipment', handler: 'organization-units-import', mode: 'direct-upload', template: 'organization-units', downloadPermission: 'ledger:units:import', previewPermission: null, executePermission: 'ledger:units:import', routes: { download: ['/api/templates/demo-park/03-organization-process-equipment.xlsx', '/api/templates/demo-park/03-organization-process-equipment.csv'], preview: [], execute: ['/api/organization/units/import'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['organization_unit'] }),
  defineStatelessArtifact({ artifactKey: '04-meters', handler: 'meters-import', mode: 'direct-upload', template: 'meters', downloadPermission: 'ledger:meters:import', previewPermission: null, executePermission: 'ledger:meters:import', routes: { download: ['/api/templates/demo-park/04-meters.xlsx', '/api/templates/demo-park/04-meters.csv'], preview: [], execute: ['/api/meters/import'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['meter_device'] }),
  defineStatelessArtifact({ artifactKey: '05-production-units', handler: 'production-units-import', mode: 'preview-execute', template: 'production-units', downloadPermission: 'ledger:production:import', previewPermission: 'ledger:production:import', executePermission: 'ledger:production:import', routes: { download: ['/api/templates/demo-park/05-production-units.xlsx', '/api/templates/demo-park/05-production-units.csv'], preview: ['/api/production/units/import/preview'], execute: ['/api/production/units/import/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['production_unit'] }),
  defineStatelessArtifact({ artifactKey: '06-production-outputs', handler: 'production-outputs-import', mode: 'preview-execute', template: 'production-outputs', downloadPermission: 'ledger:production:preview', previewPermission: 'ledger:production:preview', executePermission: 'ledger:production:execute', routes: { download: ['/api/templates/demo-park/06-production-outputs.xlsx', '/api/templates/demo-park/06-production-outputs.csv'], preview: ['/api/production/outputs/import/preview'], execute: ['/api/production/outputs/import/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['production_output'] }),
  defineManagedArtifact({ artifactKey: '07-monthly-energy', handler: 'monthly-energy-import', mode: 'direct-upload', template: 'energy-records', downloadPermission: 'imports:create', previewPermission: null, executePermission: 'imports:create', routes: { download: ['/api/templates/demo-park/07-monthly-energy.xlsx', '/api/templates/demo-park/07-monthly-energy.csv'], preview: [], execute: ['/api/imports/batches'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['energy_record'] }),
  defineStatelessArtifact({ artifactKey: '08-meter-readings-2026-08', handler: 'meter-readings-import', mode: 'direct-upload', template: 'meter-readings', downloadPermission: 'ledger:readings:import', previewPermission: null, executePermission: 'ledger:readings:import', routes: { download: ['/api/templates/demo-park/08-meter-readings-2026-08.xlsx', '/api/templates/demo-park/08-meter-readings-2026-08.csv'], preview: [], execute: ['/api/meter-readings/import'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['meter_reading'] }),
  defineStatelessArtifact({ artifactKey: '09-generation-records', handler: 'generation-records-import', mode: 'preview-execute', template: 'generation-records', downloadPermission: 'ledger:generation:preview', previewPermission: 'ledger:generation:preview', executePermission: 'ledger:generation:execute', routes: { download: ['/api/templates/demo-park/09-generation-records.xlsx', '/api/templates/demo-park/09-generation-records.csv'], preview: ['/api/generation/records/import/preview'], execute: ['/api/generation/records/import/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['generation_record'] }),
  defineStatelessArtifact({ artifactKey: '10-energy-budgets', handler: 'energy-budgets-import', mode: 'preview-execute', template: 'energy-budgets', downloadPermission: 'energy:budget:import', previewPermission: 'energy:budget:import', executePermission: 'energy:budget:import', routes: { download: ['/api/templates/demo-park/10-energy-budgets.xlsx', '/api/templates/demo-park/10-energy-budgets.csv'], preview: ['/api/energy-budgets/import/preview'], execute: ['/api/energy-budgets/import/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['energy_budget'] }),
  defineManagedArtifact({ artifactKey: '11-carbon-factors', handler: 'carbon-factors-import', mode: 'preview-execute', template: 'carbon-factors', downloadPermission: 'carbon:factor:import', previewPermission: 'carbon:factor:import', executePermission: 'carbon:factor:import', routes: { download: ['/api/templates/demo-park/11-carbon-factors.xlsx', '/api/templates/demo-park/11-carbon-factors.csv'], preview: ['/api/carbon/factors/import/preview'], execute: ['/api/carbon/factors/import/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['carbon_factor'] }),
  defineManagedArtifact({ artifactKey: '12-prediction-configs', handler: 'prediction-configs-import', mode: 'preview-execute', template: 'prediction-configs', downloadPermission: 'prediction:config:import', previewPermission: 'prediction:config:import', executePermission: 'prediction:config:import', routes: { download: ['/api/templates/demo-park/12-prediction-configs.xlsx', '/api/templates/demo-park/12-prediction-configs.csv'], preview: ['/api/predictions/configs/import/preview'], execute: ['/api/predictions/configs/import/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'route-audit' }, guards: [], ownershipTargets: ['prediction_config'] }),
  defineManagedArtifact({ artifactKey: '13-shift-definitions', handler: 'shift-definitions-import', mode: 'preview-execute', template: 'shift-definitions', downloadPermission: 'energy:analysis:config:import:preview', previewPermission: 'energy:analysis:config:import:preview', executePermission: 'energy:analysis:config:import:execute', routes: { download: ['/api/templates/demo-park/13-shift-definitions.xlsx', '/api/templates/demo-park/13-shift-definitions.csv'], preview: ['/api/energy-analysis/imports/shift-definitions/preview'], execute: ['/api/energy-analysis/imports/shift-definitions/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'actor-user-id-and-ip' }, guards: [], ownershipTargets: ['shift_definition'] }),
  defineManagedArtifact({ artifactKey: '14-shift-schedules', handler: 'shift-schedules-import', mode: 'preview-execute', template: 'shift-schedules', downloadPermission: 'energy:analysis:operations:preview', previewPermission: 'energy:analysis:operations:preview', executePermission: 'energy:analysis:operations:execute', routes: { download: ['/api/templates/demo-park/14-shift-schedules.xlsx', '/api/templates/demo-park/14-shift-schedules.csv'], preview: ['/api/energy-analysis/imports/shift-schedules/preview'], execute: ['/api/energy-analysis/imports/shift-schedules/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['shift_schedule'] }),
  defineManagedArtifact({ artifactKey: '15-energy-timeseries', handler: 'energy-timeseries-import', mode: 'preview-execute', template: 'energy-timeseries', downloadPermission: 'energy:analysis:timeseries:preview', previewPermission: 'energy:analysis:timeseries:preview', executePermission: 'energy:analysis:timeseries:execute', routes: { download: ['/api/templates/demo-park/15-energy-timeseries.xlsx', '/api/templates/demo-park/15-energy-timeseries.csv'], preview: ['/api/energy-analysis/imports/timeseries/preview'], execute: ['/api/energy-analysis/imports/timeseries/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['energy_timeseries'] }),
  defineManagedArtifact({ artifactKey: '16-device-states', handler: 'device-states-import', mode: 'preview-execute', template: 'device-states', downloadPermission: 'energy:analysis:operations:preview', previewPermission: 'energy:analysis:operations:preview', executePermission: 'energy:analysis:operations:execute', routes: { download: ['/api/templates/demo-park/16-device-states.xlsx', '/api/templates/demo-park/16-device-states.csv'], preview: ['/api/energy-analysis/imports/device-states/preview'], execute: ['/api/energy-analysis/imports/device-states/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: [], ownershipTargets: ['device_state'] }),
  defineManagedArtifact({ artifactKey: '17-tou-schemes', handler: 'tou-schemes-import', mode: 'preview-execute', template: 'tou-schemes', downloadPermission: 'energy:analysis:config:import:preview', previewPermission: 'energy:analysis:config:import:preview', executePermission: 'energy:analysis:config:import:execute', routes: { download: ['/api/templates/demo-park/17-tou-schemes.xlsx'], preview: ['/api/energy-analysis/imports/tou-schemes/preview'], execute: ['/api/energy-analysis/imports/tou-schemes/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'actor-user-id-and-ip' }, guards: [], ownershipTargets: ['tou_scheme'] }),
  defineManagedArtifact({ artifactKey: '18-strategy-rules', handler: 'strategy-rules-import', mode: 'preview-execute', template: 'strategy-rules', downloadPermission: 'energy:analysis:config:import:preview', previewPermission: 'energy:analysis:config:import:preview', executePermission: 'energy:analysis:config:import:execute', routes: { download: ['/api/templates/demo-park/18-strategy-rules.xlsx', '/api/templates/demo-park/18-strategy-rules.csv'], preview: ['/api/energy-analysis/imports/strategy-rules/preview'], execute: ['/api/energy-analysis/imports/strategy-rules/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'actor-user-id-and-ip' }, guards: [], ownershipTargets: ['strategy_rule'] }),
  defineManagedArtifact({ artifactKey: '19-conversion-factors', handler: 'energy-conversion-factors-import', mode: 'preview-execute', template: 'energy-conversion-factors', downloadPermission: 'energy:benchmarks:import:preview', previewPermission: 'energy:benchmarks:import:preview', executePermission: 'energy:benchmarks:import:execute', routes: { download: ['/api/templates/demo-park/19-conversion-factors.xlsx', '/api/templates/demo-park/19-conversion-factors.csv'], preview: ['/api/energy-benchmarks/imports/conversion-factors/preview'], execute: ['/api/energy-benchmarks/imports/conversion-factors/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: ['trusted-body-rebuild'], ownershipTargets: ['energy_conversion_factor'] }),
  defineManagedArtifact({ artifactKey: '20-benchmark-definitions', handler: 'energy-benchmark-definitions-import', mode: 'preview-execute', template: 'energy-benchmark-definitions', downloadPermission: 'energy:benchmarks:import:preview', previewPermission: 'energy:benchmarks:import:preview', executePermission: 'energy:benchmarks:import:execute', routes: { download: ['/api/templates/demo-park/20-benchmark-definitions.xlsx', '/api/templates/demo-park/20-benchmark-definitions.csv'], preview: ['/api/energy-benchmarks/imports/definitions/preview'], execute: ['/api/energy-benchmarks/imports/definitions/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: ['trusted-body-rebuild'], ownershipTargets: ['energy_benchmark_definition'] }),
  defineManagedArtifact({ artifactKey: '21-benchmark-targets', handler: 'energy-benchmark-targets-import', mode: 'preview-execute', template: 'energy-benchmark-targets', downloadPermission: 'energy:benchmarks:import:preview', previewPermission: 'energy:benchmarks:import:preview', executePermission: 'energy:benchmarks:import:execute', routes: { download: ['/api/templates/demo-park/21-benchmark-targets.xlsx', '/api/templates/demo-park/21-benchmark-targets.csv'], preview: ['/api/energy-benchmarks/imports/targets/preview'], execute: ['/api/energy-benchmarks/imports/targets/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: ['trusted-body-rebuild'], ownershipTargets: ['energy_benchmark_target'] }),
  defineManagedArtifact({ artifactKey: '22-energy-flow-models', handler: 'energy-flow-models-import', mode: 'preview-execute', template: 'energy-flow-models', downloadPermission: 'energy:flows:import:preview', previewPermission: 'energy:flows:import:preview', executePermission: 'energy:flows:import:execute', routes: { download: ['/api/templates/demo-park/22-energy-flow-models.xlsx', '/api/templates/demo-park/22-energy-flow-models.csv'], preview: ['/api/energy-flow-imports/models/preview'], execute: ['/api/energy-flow-imports/models/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'actor-user-id-and-ip' }, guards: ['preview-upload-preflight'], ownershipTargets: ['energy_flow_model'] }),
  defineManagedArtifact({ artifactKey: '23-energy-flow-nodes', handler: 'energy-flow-nodes-import', mode: 'preview-execute', template: 'energy-flow-nodes', downloadPermission: 'energy:flows:import:preview', previewPermission: 'energy:flows:import:preview', executePermission: 'energy:flows:import:execute', routes: { download: ['/api/templates/demo-park/23-energy-flow-nodes.xlsx', '/api/templates/demo-park/23-energy-flow-nodes.csv'], preview: ['/api/energy-flow-imports/nodes/preview'], execute: ['/api/energy-flow-imports/nodes/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: ['preview-upload-preflight'], ownershipTargets: ['energy_flow_node'] }),
  defineManagedArtifact({ artifactKey: '24-energy-flow-edges', handler: 'energy-flow-bundle-import', mode: 'bundle-preview-execute', template: 'energy-flow-edges', downloadPermission: 'energy:flows:import:preview', previewPermission: 'energy:flows:import:preview', executePermission: 'energy:flows:import:execute', routes: { download: ['/api/templates/demo-park/24-energy-flow-edges.xlsx'], preview: ['/api/energy-flow-imports/bundle/preview'], execute: ['/api/energy-flow-imports/bundle/execute'] }, batchRoles: ['edge', 'record'], actor: { source: 'authenticated-user', executeInjection: 'none' }, guards: ['preview-upload-preflight', 'trusted-body-rebuild', 'execute-stale-preflight'], ownershipTargets: ['energy_flow_edge', 'energy_flow_record'] }),
  defineManagedArtifact({ artifactKey: '25-energy-balance-configs', handler: 'energy-balance-bundle-import', mode: 'bundle-preview-execute', template: 'energy-balance-configs', downloadPermission: 'energy:balance:import:preview', previewPermission: 'energy:balance:import:preview', executePermission: 'energy:balance:import:execute', routes: { download: ['/api/templates/demo-park/25-energy-balance-configs.xlsx'], preview: ['/api/energy-balance-imports/bundle/preview'], execute: ['/api/energy-balance-imports/bundle/execute'] }, batchRoles: ['boundary', 'item'], actor: { source: 'authenticated-user', executeInjection: 'actor-object' }, guards: ['preview-upload-preflight', 'trusted-body-rebuild', 'execute-stale-preflight'], ownershipTargets: ['energy_balance_boundary', 'energy_balance_item'] }),
  defineStatelessArtifact({ artifactKey: '26-suppliers', handler: 'supplier-import', mode: 'preview-execute', template: 'suppliers', downloadPermission: 'ledger:suppliers:import:preview', previewPermission: 'ledger:suppliers:import:preview', executePermission: 'ledger:suppliers:import:execute', routes: { download: ['/api/templates/demo-park/26-suppliers.xlsx'], preview: ['/api/suppliers/imports/preview'], execute: ['/api/suppliers/imports/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'actor-user-id-and-ip' }, guards: ['demo-context-fail-closed'], ownershipTargets: ['supplier'] }),
  defineManagedArtifact({ artifactKey: '27-carbon-activities', handler: 'carbon-activity-import', mode: 'preview-execute', template: 'carbon-activities', downloadPermission: 'carbon:activities:import:preview', previewPermission: 'carbon:activities:import:preview', executePermission: 'carbon:activities:import:execute', routes: { download: ['/api/templates/demo-park/27-carbon-activities.xlsx'], preview: ['/api/carbon/activities/imports/preview'], execute: ['/api/carbon/activities/imports/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'actor-user-id-and-ip' }, guards: ['demo-context-fail-closed'], ownershipTargets: ['carbon_activity_record'] }),
  defineStatelessArtifact({ artifactKey: '28-carbon-emission-report', handler: 'carbon-emission-report-import', mode: 'preview-execute', template: 'carbon-emission-report', downloadPermission: 'carbon:emission-reports:import:preview', previewPermission: 'carbon:emission-reports:import:preview', executePermission: 'carbon:emission-reports:import:execute', routes: { download: ['/api/templates/demo-park/28-carbon-emission-report.xlsx'], preview: ['/api/carbon/emission-reports/imports/preview'], execute: ['/api/carbon/emission-reports/imports/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'actor-user-id-and-ip' }, guards: ['demo-context-fail-closed'], ownershipTargets: ['carbon_emission_report'] }),
  defineStatelessArtifact({ artifactKey: '29-ghg-report', handler: 'ghg-report-import', mode: 'preview-execute', template: 'ghg-report', downloadPermission: 'carbon:ghg-reports:import:preview', previewPermission: 'carbon:ghg-reports:import:preview', executePermission: 'carbon:ghg-reports:import:execute', routes: { download: ['/api/templates/demo-park/29-ghg-report.xlsx'], preview: ['/api/carbon/ghg-reports/imports/preview'], execute: ['/api/carbon/ghg-reports/imports/execute'] }, batchRoles: ['primary'], actor: { source: 'authenticated-user', executeInjection: 'actor-user-id-and-ip' }, guards: ['demo-context-fail-closed'], ownershipTargets: ['ghg_report'] })
]);

// 无原型索引避免 __proto__ 等特殊键被当作 artifact。
const DEMO_ARTIFACT_BY_KEY = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(
  DEMO_ARTIFACT_REGISTRY.map((artifact) => [artifact.artifactKey, artifact])
)));
const DEMO_HANDLER_KEYS = Object.freeze([...new Set(DEMO_ARTIFACT_REGISTRY.map((artifact) => artifact.handlerKey))]);
const DEMO_HANDLER_KEY_SET = new Set(DEMO_HANDLER_KEYS);

/** 校验静态注册表的数量、角色总数、关键特殊项和显式 guards。 */
function validateDemoArtifactRegistry() {
  if (DEMO_ARTIFACT_REGISTRY.length !== 29) throw new Error('演示 artifact 注册表必须恰好包含 29 项。');
  const keys = new Set();
  let batchRoleCount = 0;
  DEMO_ARTIFACT_REGISTRY.forEach((artifact) => {
    if (keys.has(artifact.artifactKey)) throw new Error(`演示 artifact key 重复：${artifact.artifactKey}`);
    keys.add(artifact.artifactKey);
    if (!Array.isArray(artifact.guards)) throw new Error(`演示 artifact guards 必须显式声明：${artifact.artifactKey}`);
    if (!artifact.handlerKey || !artifact.templateType || !artifact.permissions.download) throw new Error(`演示 artifact 基础元数据缺失：${artifact.artifactKey}`);
    if (!DEMO_ARTIFACT_DOWNLOAD_LIFECYCLE_SET.has(artifact.downloadLifecycle)) {
      throw new Error(`演示 artifact 下载生命周期无效：${artifact.artifactKey}`);
    }
    if (artifact.downloadLifecycle === DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.MANAGED_CONTEXT_AUTO_RUNTIME
      && artifact.blocker.previewExecuteContext !== null) {
      throw new Error(`托管 context artifact 仍存在 preview/execute blocker：${artifact.artifactKey}`);
    }
    if (artifact.downloadLifecycle === DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES.STATELESS_FORMAL_IMPORT
      && artifact.blocker.previewExecuteContext === null) {
      throw new Error(`无状态 artifact 不得声明中央 context 已接入：${artifact.artifactKey}`);
    }
    batchRoleCount += artifact.batchRoles.length;
  });
  if (batchRoleCount !== 31) throw new Error(`演示 artifact batch role 总数必须为 31，当前为 ${batchRoleCount}。`);
  if (getDemoArtifactRegistration('07-monthly-energy').permissions.execute !== 'imports:create') throw new Error('第 07 项写权限必须为 imports:create。');
  if (getDemoArtifactRegistration('17-tou-schemes').ownershipTargets.join(',') !== 'tou_scheme') throw new Error('第 17 项只允许声明 tou_scheme 根 ownership。');
  if (!getDemoArtifactRegistration('24-energy-flow-edges').batchRoles.some((item) => item.entityType === 'energy_flow_record')) throw new Error('第 24 项显式边值实体必须为 energy_flow_record。');
  return true;
}

/** 按严格 artifact key 读取注册项；未知 key 一律 fail-closed。 */
function getDemoArtifactRegistration(artifactKey) {
  const normalizedKey = String(artifactKey || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(DEMO_ARTIFACT_BY_KEY, normalizedKey)
    ? DEMO_ARTIFACT_BY_KEY[normalizedKey]
    : null;
}

/** 读取注册项，未知 key 时返回稳定 404，不允许调用方自行猜测 handler。 */
function requireDemoArtifactRegistration(artifactKey) {
  const artifact = getDemoArtifactRegistration(artifactKey);
  if (!artifact) {
    throw new AppError('DEMO_ARTIFACT_UNKNOWN', '演示数据 artifact 不在服务端白名单中。', {
      statusCode: 404,
      details: { artifactKey: String(artifactKey || '') }
    });
  }
  return artifact;
}

/** 严格校验 artifact 与 handler 绑定，未知或错配均 fail-closed。 */
function requireDemoArtifactHandler(artifactKey, handlerKey) {
  const artifact = requireDemoArtifactRegistration(artifactKey);
  const normalizedHandlerKey = String(handlerKey || '').trim();
  if (!DEMO_HANDLER_KEY_SET.has(normalizedHandlerKey) || artifact.handlerKey !== normalizedHandlerKey) {
    throw new AppError('DEMO_HANDLER_MISMATCH', '演示数据 handler 不存在或与 artifact 不匹配。', {
      statusCode: 400,
      details: { artifactKey: artifact.artifactKey }
    });
  }
  return artifact;
}

/** 返回可安全对外的注册表投影，不暴露未来静态 SQL handler。 */
function listDemoArtifactRegistrations() {
  return DEMO_ARTIFACT_REGISTRY.map((artifact) => ({
    artifactKey: artifact.artifactKey,
    handlerKey: artifact.handlerKey,
    mode: artifact.mode,
    downloadLifecycle: artifact.downloadLifecycle,
    templateType: artifact.templateType,
    permissions: { ...artifact.permissions },
    routes: Object.fromEntries(Object.entries(artifact.routes).map(([key, values]) => [key, [...values]])),
    batchRoles: artifact.batchRoles.map((item) => ({ ...item })),
    actor: { ...artifact.actor },
    guards: [...artifact.guards],
    ownershipTargets: [...artifact.ownershipTargets],
    blocker: { ...artifact.blocker }
  }));
}

validateDemoArtifactRegistry();

module.exports = {
  DEMO_ARTIFACT_DOWNLOAD_LIFECYCLES,
  DEMO_ARTIFACT_REGISTRY,
  DEMO_HANDLER_KEYS,
  getDemoArtifactRegistration,
  listDemoArtifactRegistrations,
  requireDemoArtifactHandler,
  requireDemoArtifactRegistration,
  validateDemoArtifactRegistry
};
