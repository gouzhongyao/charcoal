<template>
  <figure class="park-scene" :class="`park-scene--${status}`" :aria-labelledby="captionId">
    <figcaption :id="captionId">
      <div><span>INDUSTRIAL PARK OVERVIEW</span><strong>{{ currentYear }} 年园区业务总览</strong></div>
      <small>最后更新 {{ formatDateTime(lastUpdated) }}</small>
    </figcaption>
    <div class="park-scene__canvas">
      <svg viewBox="0 0 1000 600" role="img" :aria-labelledby="`${titleId} ${descriptionId}`">
        <title :id="titleId">{{ currentYear }} 年抽象工业园区业务示意</title>
        <desc :id="descriptionId">抽象厂房、道路、绿地、屋顶光伏与储能柜构成的装饰性业务示意，不表示真实建筑位置、设备连接、能源管线或流量方向。</desc>
        <rect width="1000" height="600" class="scene-sky" />
        <path d="M0 410 L230 278 L470 388 L710 238 L1000 392 L1000 600 L0 600 Z" class="scene-ground" />
        <path d="M50 520 L330 360 L525 455 L760 320 L950 430" class="scene-road" />
        <path d="M105 570 L370 418 M450 514 L695 365 M628 552 L835 430" class="scene-road scene-road--minor" />

        <g class="scene-building scene-building--left">
          <path d="M125 324 L260 248 L388 315 L249 394 Z" class="building-roof" />
          <path d="M125 324 L249 394 L249 505 L125 432 Z" class="building-side" />
          <path d="M249 394 L388 315 L388 426 L249 505 Z" class="building-front" />
          <path d="M172 310 L263 259 L344 302 L252 354 Z" class="solar-array" />
          <path d="M187 301 L268 344 M218 283 L298 326 M250 266 L329 309" class="solar-grid" />
          <rect x="284" y="394" width="50" height="72" class="building-door" />
          <rect x="145" y="358" width="39" height="34" class="building-window" />
          <rect x="194" y="387" width="39" height="34" class="building-window" />
        </g>

        <g class="scene-building scene-building--center">
          <path d="M402 287 L548 208 L696 284 L548 369 Z" class="building-roof building-roof--main" />
          <path d="M402 287 L548 369 L548 512 L402 429 Z" class="building-side" />
          <path d="M548 369 L696 284 L696 428 L548 512 Z" class="building-front building-front--main" />
          <path d="M451 275 L549 222 L646 272 L548 328 Z" class="solar-array" />
          <path d="M470 264 L567 316 M503 246 L600 298 M535 229 L632 281" class="solar-grid" />
          <rect x="589" y="365" width="58" height="89" class="building-door" />
          <rect x="425" y="330" width="43" height="37" class="building-window" />
          <rect x="482" y="362" width="43" height="37" class="building-window" />
          <rect x="425" y="387" width="43" height="37" class="building-window" />
        </g>

        <g class="scene-building scene-building--right">
          <path d="M705 333 L801 281 L902 332 L803 389 Z" class="building-roof" />
          <path d="M705 333 L803 389 L803 487 L705 431 Z" class="building-side" />
          <path d="M803 389 L902 332 L902 430 L803 487 Z" class="building-front" />
          <rect x="832" y="382" width="38" height="60" class="building-door" />
          <rect x="727" y="365" width="31" height="27" class="building-window" />
        </g>

        <g class="scene-storage" aria-hidden="true">
          <rect x="735" y="455" width="48" height="70" rx="4" />
          <rect x="790" y="438" width="48" height="78" rx="4" />
          <path d="M749 475 H769 M749 487 H769 M804 458 H824 M804 470 H824" />
        </g>
        <g class="scene-greenery" aria-hidden="true">
          <circle cx="97" cy="459" r="22" /><rect x="92" y="473" width="10" height="32" />
          <circle cx="354" cy="528" r="20" /><rect x="349" y="540" width="10" height="29" />
          <circle cx="918" cy="497" r="24" /><rect x="913" y="512" width="10" height="32" />
          <circle cx="661" cy="541" r="18" /><rect x="657" y="553" width="8" height="25" />
        </g>
        <g class="scene-decoration" aria-hidden="true">
          <circle cx="500" cy="118" r="54" class="scene-orbit" />
          <circle cx="500" cy="118" r="6" class="scene-beacon" />
          <path d="M500 172 V207 M446 118 H395 M554 118 H605" />
          <path d="M70 182 H260 M740 152 H925" class="scene-horizon" />
        </g>
        <g class="scene-label" transform="translate(424 66)">
          <rect width="152" height="44" rx="8" />
          <text x="76" y="19" text-anchor="middle">LOCAL DATA VIEW</text>
          <text x="76" y="34" text-anchor="middle">业务状态聚合</text>
        </g>
      </svg>
      <div class="park-scene__status" :role="status === 'error' ? 'alert' : 'status'">
        <span :class="`status-indicator status-indicator--${status}`" aria-hidden="true" />
        <div><strong>{{ statusLabel }}</strong><p>{{ statusDescription }}</p></div>
      </div>
    </div>
    <p class="park-scene__disclaimer"><strong>业务示意，非实景、非物理拓扑、非实时。</strong><span>图形不表示真实建筑位置、设备连接、能源管线或流量方向，也不绑定组织树、设备坐标或实时遥测。</span></p>
  </figure>
</template>

<script setup>
import { computed } from 'vue';

/** 工业园区业务示意输入属性。 */
const props = defineProps({
  sceneId: { type: String, required: true },
  currentYear: { type: Number, required: true },
  status: { type: String, default: 'loading' },
  statusDescription: { type: String, default: '' },
  lastUpdated: { type: String, default: '' }
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
}[props.status] || '等待业务状态'));

/** 格式化园区示意最后更新时间。 */
function formatDateTime(value) {
  if (!value) return '尚未成功更新';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(date);
}
</script>

<style scoped>
.park-scene{margin:0;min-width:0;height:100%;padding:14px;border:1px solid rgba(56,189,248,.22);border-radius:18px;background:rgba(3,18,38,.72);box-shadow:inset 0 1px rgba(255,255,255,.04),0 22px 50px rgba(0,8,24,.32)}.park-scene figcaption{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:2px 4px 12px}.park-scene figcaption div{display:grid;gap:3px}.park-scene figcaption span{color:#38bdf8;font-size:9px;font-weight:700;letter-spacing:.16em}.park-scene figcaption strong{color:#e6f4ff;font-size:17px}.park-scene figcaption small{color:#8eabc8;font-size:10px}.park-scene__canvas{position:relative;min-height:360px;border:1px solid rgba(56,189,248,.14);border-radius:14px;background:#031126;overflow:hidden}.park-scene svg{display:block;width:100%;height:auto;min-height:360px}.scene-sky{fill:#031126}.scene-ground{fill:#08233b}.scene-road{fill:none;stroke:#1a4965;stroke-width:38;stroke-linecap:round;stroke-linejoin:round}.scene-road--minor{stroke:#123a55;stroke-width:16}.building-roof{fill:#1c5879;stroke:#55c7ec;stroke-width:2}.building-roof--main{fill:#216a8f}.building-side{fill:#0b3553;stroke:#2d7698;stroke-width:2}.building-front{fill:#0e4566;stroke:#2d7698;stroke-width:2}.building-front--main{fill:#105274}.solar-array{fill:#063f68;stroke:#4fc3f0;stroke-width:2}.solar-grid{fill:none;stroke:#1b83b4;stroke-width:2}.building-door{fill:#061f36;stroke:#2b86ab;stroke-width:2}.building-window{fill:#68d5f2;stroke:#b8f3ff;stroke-width:2;opacity:.82}.scene-storage rect{fill:#123f5b;stroke:#60d6f4;stroke-width:2}.scene-storage path{fill:none;stroke:#68d5f2;stroke-width:3}.scene-greenery circle{fill:#16835e;stroke:#52d89a;stroke-width:2}.scene-greenery rect{fill:#0d5d45}.scene-decoration{fill:none;stroke:#1f7ea5;stroke-width:2}.scene-orbit{stroke-dasharray:5 8}.scene-beacon{fill:#67e8f9;stroke:#d9fbff;stroke-width:2;animation:ambient-glow 3s ease-in-out infinite}.scene-horizon{stroke-dasharray:3 10}.scene-label rect{fill:#061e37;stroke:#38bdf8;stroke-width:1.5}.scene-label text{fill:#bfefff;font-size:10px;letter-spacing:.09em}.park-scene__status{position:absolute;left:14px;bottom:14px;display:flex;align-items:flex-start;gap:9px;max-width:calc(100% - 28px);padding:9px 11px;border:1px solid rgba(56,189,248,.18);border-radius:10px;background:rgba(2,12,28,.88);box-sizing:border-box}.park-scene__status div{display:grid;gap:2px}.park-scene__status strong{color:#e6f4ff;font-size:11px}.park-scene__status p{margin:0;color:#9bb9d3;font-size:10px;line-height:1.5}.status-indicator{flex:0 0 auto;width:9px;height:9px;margin-top:3px;border-radius:50%;background:#60a5fa;box-shadow:0 0 10px rgba(96,165,250,.55)}.status-indicator--success{background:#34d399}.status-indicator--partial,.status-indicator--empty{background:#fbbf24}.status-indicator--forbidden{background:#94a3b8}.status-indicator--error{background:#fb7185}.park-scene__disclaimer{display:grid;gap:3px;margin:12px 3px 0;padding:9px 11px;border-left:3px solid #38bdf8;background:rgba(56,189,248,.06)}.park-scene__disclaimer strong{color:#dff6ff;font-size:11px}.park-scene__disclaimer span{color:#8eabc8;font-size:10px;line-height:1.55}@keyframes ambient-glow{0%,100%{opacity:.55;transform:scale(.9);transform-origin:center}50%{opacity:1;transform:scale(1.15);transform-origin:center}}@media (max-width:640px){.park-scene figcaption{flex-direction:column}.park-scene__canvas,.park-scene svg{min-height:290px}}@media (prefers-reduced-motion:reduce){.scene-beacon{animation:none}}
</style>
