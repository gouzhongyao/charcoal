<template>
  <figure class="park-scene" :class="`park-scene--${status}`" :aria-labelledby="captionId">
    <figcaption :id="captionId">
      <div><span>INDUSTRIAL PARK OVERVIEW</span><strong>{{ currentYear }} 年园区真实业务摘要</strong></div>
      <small>最后更新 {{ formatDateTime(lastUpdated) }}</small>
    </figcaption>
    <div class="park-scene__content">
      <div class="park-scene__canvas">
        <svg viewBox="0 0 1000 520" role="img" :aria-labelledby="`${titleId} ${descriptionId}`">
          <title :id="titleId">{{ currentYear }} 年抽象工业园区业务示意</title>
          <desc :id="descriptionId">抽象厂房、道路、绿地、屋顶光伏与储能柜构成的装饰性业务示意，不表示真实建筑位置、设备连接、能源管线或流量方向。</desc>
          <rect width="1000" height="520" class="scene-sky" />
          <path d="M0 348 L220 230 L455 337 L705 205 L1000 338 L1000 520 L0 520 Z" class="scene-ground" />
          <path d="M45 465 L322 320 L520 414 L760 282 L955 390" class="scene-road" />
          <g class="scene-building">
            <path d="M112 282 L250 208 L378 273 L238 350 Z" class="building-roof" />
            <path d="M112 282 L238 350 L238 446 L112 375 Z" class="building-side" />
            <path d="M238 350 L378 273 L378 370 L238 446 Z" class="building-front" />
            <path d="M160 269 L252 220 L335 261 L242 312 Z" class="solar-array" />
            <path d="M176 261 L258 303 M208 243 L289 285 M240 226 L320 268" class="solar-grid" />
          </g>
          <g class="scene-building scene-building--main">
            <path d="M392 245 L545 164 L700 241 L545 326 Z" class="building-roof building-roof--main" />
            <path d="M392 245 L545 326 L545 454 L392 371 Z" class="building-side" />
            <path d="M545 326 L700 241 L700 371 L545 454 Z" class="building-front building-front--main" />
            <path d="M445 232 L546 178 L647 228 L545 284 Z" class="solar-array" />
            <path d="M465 221 L566 273 M498 203 L599 255 M531 186 L632 238" class="solar-grid" />
          </g>
          <g class="scene-building">
            <path d="M712 289 L812 237 L913 288 L811 345 Z" class="building-roof" />
            <path d="M712 289 L811 345 L811 433 L712 377 Z" class="building-side" />
            <path d="M811 345 L913 288 L913 376 L811 433 Z" class="building-front" />
          </g>
          <g class="scene-storage" aria-hidden="true"><rect x="740" y="410" width="48" height="66" rx="4" /><rect x="798" y="395" width="48" height="74" rx="4" /><path d="M754 430 H774 M754 442 H774 M812 415 H832 M812 427 H832" /></g>
          <g class="scene-greenery" aria-hidden="true"><circle cx="90" cy="414" r="20" /><rect x="86" y="428" width="8" height="28" /><circle cx="920" cy="442" r="21" /><rect x="916" y="456" width="8" height="29" /></g>
          <g class="scene-decoration" aria-hidden="true"><circle cx="500" cy="85" r="44" class="scene-orbit" /><circle cx="500" cy="85" r="6" class="scene-beacon" /><path d="M500 129 V158 M456 85 H415 M544 85 H585" /></g>
        </svg>
        <div class="park-scene__status" :role="status === 'error' ? 'alert' : 'status'">
          <span :class="`status-indicator status-indicator--${status}`" aria-hidden="true" />
          <div><strong>{{ statusLabel }}</strong><p>{{ statusDescription }}</p></div>
        </div>
      </div>
      <div class="park-scene__signals" aria-label="园区真实业务信号">
        <article v-for="signal in signals" :key="signal.key">
          <span>{{ signal.label }}</span>
          <strong>{{ formatSignalValue(signal) }} <small>{{ signal.unit }}</small></strong>
          <p>{{ signal.detail }}</p>
        </article>
        <div v-if="!signals.length" class="park-scene__empty" role="status">
          <strong>{{ emptySignalTitle }}</strong>
          <span>{{ emptySignalDescription }}</span>
        </div>
      </div>
    </div>
    <p class="park-scene__disclaimer"><strong>业务示意，非实景、非物理拓扑、非实时。</strong><span>图形不表示真实建筑位置、设备连接、能源管线或流量方向，也不绑定组织树、设备坐标或实时遥测。</span></p>
  </figure>
</template>

<script setup>
import { computed } from 'vue';
import { formatDashboardMeasurement } from '@/utils/dashboardCockpit';
import { formatStrictUtcDateTimeDisplay } from '@/utils/dateTimeDisplay';

/** 工业园区业务示意输入属性。 */
const props = defineProps({
  sceneId: { type: String, required: true },
  currentYear: { type: Number, required: true },
  status: { type: String, default: 'loading' },
  statusDescription: { type: String, default: '' },
  lastUpdated: { type: String, default: '' },
  signals: { type: Array, default: () => [] }
});
/** 园区图标题可访问标识。 */
const titleId = computed(() => `${props.sceneId}-title`);
/** 园区图说明可访问标识。 */
const descriptionId = computed(() => `${props.sceneId}-description`);
/** 园区图图注可访问标识。 */
const captionId = computed(() => `${props.sceneId}-caption`);
/** 园区聚合状态的中文标签。 */
const statusLabel = computed(() => ({
  loading: '数据汇总中',
  success: '业务面板已汇总',
  partial: '部分业务面板可用',
  empty: '当前范围暂无数据',
  forbidden: '领域数据无权限',
  error: '业务面板读取失败'
}[props.status] || '数据状态不可用'));
/** 园区无信号状态的标题，终态不使用等待返回文案。 */
const emptySignalTitle = computed(() => ({
  loading: '正在汇总业务信号',
  empty: '当前范围暂无业务信号',
  forbidden: '无权限展示业务信号',
  error: '业务信号读取失败',
  partial: '部分业务信号暂不可用',
  success: '暂无可展示业务信号'
}[props.status] || '业务信号状态不可用'));
/** 园区无信号状态的说明，明确对应下一步或终态。 */
const emptySignalDescription = computed(() => ({
  loading: '正在读取已授权领域的真实数据。',
  empty: '已完成读取，但当前范围内没有可展示的真实业务数据。',
  forbidden: '当前账号没有可用于园区摘要的领域数据权限。',
  error: '真实业务摘要读取失败，请返回各面板重试。',
  partial: '部分领域没有可展示数据或当前账号无权访问。',
  success: '已完成读取，但当前没有可展示的真实业务信号。'
}[props.status] || '当前没有可展示的真实业务信号。'));

/** 格式化园区摘要真实数值。 */
function formatNumber(value, kind = 'energy') {
  return formatDashboardMeasurement(value, { kind, maximumFractionDigits: 2 });
}

/** 按信号口径格式化园区数值，碳排使用安全小数精度。 */
function formatSignalValue(signal) {
  return formatNumber(signal?.value, signal?.tone === 'carbon' ? 'carbon' : 'energy');
}

/** 格式化园区示意最后更新时间。 */
function formatDateTime(value) {
  return formatStrictUtcDateTimeDisplay(value, '尚未成功更新');
}
</script>

<style scoped>
.park-scene{display:flex;flex-direction:column;margin:0;min-width:0;min-height:0;height:100%;padding:10px;border:1px solid rgba(56,189,248,.22);border-radius:15px;background:rgba(3,18,38,.72);box-shadow:inset 0 1px rgba(255,255,255,.04),0 18px 40px rgba(0,8,24,.3);overflow:hidden}.park-scene figcaption{display:flex;align-items:flex-start;justify-content:space-between;flex:0 0 auto;gap:10px;padding:1px 3px 7px}.park-scene figcaption div{display:grid;gap:2px}.park-scene figcaption span{color:#38bdf8;font-size:8px;font-weight:700;letter-spacing:.16em}.park-scene figcaption strong{color:#e6f4ff;font-size:14px}.park-scene figcaption small{color:#8eabc8;font-size:9px}.park-scene__content{display:grid;grid-template-columns:minmax(0,.92fr) minmax(190px,1.08fr);flex:1 1 auto;min-height:0;gap:8px}.park-scene__canvas{position:relative;min-width:0;min-height:0;border:1px solid rgba(56,189,248,.14);border-radius:11px;background:#031126;overflow:hidden}.park-scene svg{display:block;width:100%;height:100%;min-height:0}.scene-sky{fill:#031126}.scene-ground{fill:#08233b}.scene-road{fill:none;stroke:#1a4965;stroke-width:34;stroke-linecap:round;stroke-linejoin:round}.building-roof{fill:#1c5879;stroke:#55c7ec;stroke-width:2}.building-roof--main{fill:#216a8f}.building-side{fill:#0b3553;stroke:#2d7698;stroke-width:2}.building-front{fill:#0e4566;stroke:#2d7698;stroke-width:2}.building-front--main{fill:#105274}.solar-array{fill:#063f68;stroke:#4fc3f0;stroke-width:2}.solar-grid{fill:none;stroke:#1b83b4;stroke-width:2}.scene-storage rect{fill:#123f5b;stroke:#60d6f4;stroke-width:2}.scene-storage path{fill:none;stroke:#68d5f2;stroke-width:3}.scene-greenery circle{fill:#16835e;stroke:#52d89a;stroke-width:2}.scene-greenery rect{fill:#0d5d45}.scene-decoration{fill:none;stroke:#1f7ea5;stroke-width:2}.scene-orbit{stroke-dasharray:5 8}.scene-beacon{fill:#67e8f9;stroke:#d9fbff;stroke-width:2;animation:ambient-glow 3s ease-in-out infinite}.park-scene__status{position:absolute;left:8px;right:8px;bottom:8px;display:flex;align-items:flex-start;gap:7px;padding:7px 8px;border:1px solid rgba(56,189,248,.18);border-radius:8px;background:rgba(2,12,28,.9);box-sizing:border-box}.park-scene__status div{display:grid;gap:1px;min-width:0}.park-scene__status strong{color:#e6f4ff;font-size:9px}.park-scene__status p{margin:0;color:#9bb9d3;font-size:8px;line-height:1.35}.status-indicator{flex:0 0 auto;width:8px;height:8px;margin-top:2px;border-radius:50%;background:#60a5fa;box-shadow:0 0 8px rgba(96,165,250,.55)}.status-indicator--success{background:#34d399}.status-indicator--partial,.status-indicator--empty{background:#fbbf24}.status-indicator--forbidden{background:#94a3b8}.status-indicator--error{background:#fb7185}.park-scene__signals{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));align-content:start;gap:6px;min-width:0;min-height:0;overflow-x:hidden;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.park-scene__signals article{min-width:0;padding:7px 8px;border:1px solid rgba(56,189,248,.13);border-radius:8px;background:rgba(5,24,48,.72)}.park-scene__signals article>span{display:block;color:#8eabc8;font-size:8px}.park-scene__signals strong{display:block;margin-top:3px;color:#e6f4ff;font-size:14px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.park-scene__signals small{color:#38bdf8;font-size:8px}.park-scene__signals p{margin:3px 0 0;color:#8eabc8;font-size:8px;line-height:1.35}.park-scene__empty{grid-column:1/-1;display:grid;place-content:center;gap:4px;min-height:100px;padding:10px;border:1px dashed rgba(148,184,218,.24);border-radius:8px;text-align:center}.park-scene__empty strong{color:#ccecff;font-size:11px}.park-scene__empty span{color:#8eabc8;font-size:9px}.park-scene__disclaimer{display:flex;align-items:flex-start;gap:7px;flex:0 0 auto;margin:7px 2px 0;padding:6px 8px;border-left:2px solid #38bdf8;background:rgba(56,189,248,.06)}.park-scene__disclaimer strong{color:#dff6ff;font-size:9px;white-space:nowrap}.park-scene__disclaimer span{color:#8eabc8;font-size:8px;line-height:1.4}@keyframes ambient-glow{0%,100%{opacity:.55;transform:scale(.9);transform-origin:center}50%{opacity:1;transform:scale(1.15);transform-origin:center}}@media (max-width:1279px){.park-scene__content{grid-template-columns:minmax(240px,.8fr) minmax(0,1.2fr)}.park-scene__signals{grid-template-columns:repeat(3,minmax(0,1fr))}}@media (max-width:960px){.park-scene__signals{max-height:clamp(150px,32dvh,300px)}}@media (max-width:640px){.park-scene figcaption{flex-direction:column}.park-scene__content{grid-template-columns:1fr;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}.park-scene__canvas{min-height:190px}.park-scene__signals{grid-template-columns:1fr}.park-scene__disclaimer{flex-direction:column}.park-scene__disclaimer strong{white-space:normal}}@media (prefers-reduced-motion:reduce){.scene-beacon{animation:none}}
</style>
