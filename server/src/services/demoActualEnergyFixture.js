'use strict';

// 实际月度能耗样例使用独立企业级用能单元，与天坤集团既有联动事实隔离。
const DEMO_ACTUAL_ENERGY_ORGANIZATION = Object.freeze({
  code: 'QL-ACTUAL-PARK',
  name: '实际能耗样例企业'
});
// 来源工作表名称进入每条备注，便于下载后追溯本次只读提取口径。
const DEMO_ACTUAL_ENERGY_SOURCE_WORKSHEET = '1公司消耗情况表';
// 柴油换算固定采用用户确认的 0.85 kg/L 密度，不扩展普通导入单位规则。
const DEMO_ACTUAL_ENERGY_DIESEL_DENSITY_KG_PER_LITER = 0.85;
// 柴油输出统一保留两位小数。
const DEMO_ACTUAL_ENERGY_DIESEL_DECIMAL_PLACES = 2;
// 四类来源能源的源名称和单位仅服务于静态 fixture 备注及换算。
const DEMO_ACTUAL_ENERGY_SOURCE_DEFINITIONS = Object.freeze({
  electricity: Object.freeze({ sourceName: '电', sourceUnit: 'kWh', outputUnit: 'kWh' }),
  water: Object.freeze({ sourceName: '水', sourceUnit: 't', outputUnit: 'm3' }),
  diesel: Object.freeze({ sourceName: '柴油', sourceUnit: 't', outputUnit: 'L' }),
  natural_gas: Object.freeze({ sourceName: '天然气', sourceUnit: '立方米', outputUnit: 'm3' })
});

/** 深度冻结单个来源期间，防止调用方改写已对账月值。 */
function freezeActualEnergyPeriod(period) {
  // 各能源月值仅保留源表中的非空实际月，不包含合计、公式零或其他指标。
  const frozenMonthlyValues = Object.freeze(Object.fromEntries(
    Object.entries(period.monthlyValues).map(([energyTypeCode, monthlyValues]) => [
      energyTypeCode,
      Object.freeze({ ...monthlyValues })
    ])
  ));
  return Object.freeze({
    label: period.label,
    startMonth: period.startMonth,
    endMonth: period.endMonth,
    monthlyValues: frozenMonthlyValues
  });
}

// 第一工作表三段跨年期间只保留电、水、天然气和柴油的非空实际月值。
const DEMO_ACTUAL_ENERGY_PERIODS = Object.freeze([
  freezeActualEnergyPeriod({
    label: '2024年3月至2025年2月',
    startMonth: '2024-03',
    endMonth: '2025-02',
    monthlyValues: {
      electricity: {
        '2024-03': 742169,
        '2024-04': 678749,
        '2024-05': 610530,
        '2024-06': 679261,
        '2024-07': 740771,
        '2024-08': 682580,
        '2024-09': 776232,
        '2024-10': 720078,
        '2024-11': 692543,
        '2024-12': 751185,
        '2025-01': 601512,
        '2025-02': 630514
      },
      water: {
        '2024-03': 1444,
        '2024-04': 2177,
        '2024-05': 2288,
        '2024-06': 2800,
        '2024-07': 1989,
        '2024-08': 2194,
        '2024-09': 2208,
        '2024-10': 1982,
        '2024-11': 1780,
        '2024-12': 1329,
        '2025-01': 1477,
        '2025-02': 1433
      },
      diesel: {
        '2024-03': 143.07
      },
      natural_gas: {
        '2024-03': 3631.96,
        '2024-05': 4076.08,
        '2024-09': 4076.08,
        '2025-02': 1302.08
      }
    }
  }),
  freezeActualEnergyPeriod({
    label: '2025年3月至2026年2月',
    startMonth: '2025-03',
    endMonth: '2026-02',
    monthlyValues: {
      electricity: {
        '2025-03': 841845,
        '2025-04': 729326,
        '2025-05': 657176,
        '2025-06': 546243,
        '2025-07': 693206,
        '2025-08': 609258,
        '2025-09': 597909,
        '2025-10': 375627,
        '2025-11': 542671,
        '2025-12': 689996,
        '2026-01': 751221,
        '2026-02': 273046
      },
      water: {
        '2025-03': 1456,
        '2025-04': 1983,
        '2025-05': 1805,
        '2025-06': 1942,
        '2025-07': 1989,
        '2025-08': 2067,
        '2025-09': 2445,
        '2025-10': 1711,
        '2025-11': 1763,
        '2025-12': 1895,
        '2026-01': 2054,
        '2026-02': 1456
      },
      diesel: {
        '2025-03': 119.8
      },
      natural_gas: {
        '2025-04': 7812.5,
        '2025-09': 3797.46,
        '2026-01': 6329.11
      }
    }
  }),
  freezeActualEnergyPeriod({
    label: '2026年3月至2027年2月',
    startMonth: '2026-03',
    endMonth: '2027-02',
    monthlyValues: {
      electricity: {
        '2026-03': 652105
      },
      water: {
        '2026-03': 1386
      }
    }
  })
]);

/** 按固定小数位四舍五入，避免柴油换算输出无界浮点小数。 */
function roundActualEnergyValue(value, decimalPlaces) {
  return Number(Number(value).toFixed(decimalPlaces));
}

/** 将源表实际月值转换为正式能耗模板要求的标准值。 */
function convertActualEnergyValue(energyTypeCode, sourceValue) {
  if (energyTypeCode === 'diesel') {
    return roundActualEnergyValue(
      Number(sourceValue) * 1000 / DEMO_ACTUAL_ENERGY_DIESEL_DENSITY_KG_PER_LITER,
      DEMO_ACTUAL_ENERGY_DIESEL_DECIMAL_PLACES
    );
  }
  return Number(sourceValue);
}

/** 构造包含来源期间和单位换算信息的可追溯备注。 */
function buildActualEnergyRemark(periodLabel, energyTypeCode, sourceValue, outputValue) {
  const sourceDefinition = DEMO_ACTUAL_ENERGY_SOURCE_DEFINITIONS[energyTypeCode];
  const sourcePrefix = `来源工作表：${DEMO_ACTUAL_ENERGY_SOURCE_WORKSHEET}；期间：${periodLabel}；`;
  if (energyTypeCode === 'diesel') {
    return `${sourcePrefix}${sourceDefinition.sourceName}源值 ${sourceValue} ${sourceDefinition.sourceUnit}，按密度 ${DEMO_ACTUAL_ENERGY_DIESEL_DENSITY_KG_PER_LITER} kg/L 换算为 ${outputValue} ${sourceDefinition.outputUnit}，保留 ${DEMO_ACTUAL_ENERGY_DIESEL_DECIMAL_PLACES} 位小数。`;
  }
  if (energyTypeCode === 'water') {
    return `${sourcePrefix}${sourceDefinition.sourceName}源单位 ${sourceDefinition.sourceUnit}，按 1:1 换算为 ${sourceDefinition.outputUnit}。`;
  }
  if (energyTypeCode === 'natural_gas') {
    return `${sourcePrefix}${sourceDefinition.sourceName}源单位${sourceDefinition.sourceUnit}，输出单位 ${sourceDefinition.outputUnit}。`;
  }
  return `${sourcePrefix}${sourceDefinition.sourceName}源单位 ${sourceDefinition.sourceUnit}，输出单位 ${sourceDefinition.outputUnit}，无需换算。`;
}

/** 将三段静态来源月值生成正式 energy-records 七列表格行。 */
function buildDemoActualEnergyRows() {
  // 生成结果只包含非空实际月，组织统一归属独立企业且不虚构计量器具。
  const generatedRows = [];
  DEMO_ACTUAL_ENERGY_PERIODS.forEach((period) => {
    Object.entries(period.monthlyValues).forEach(([energyTypeCode, monthlyValues]) => {
      const sourceDefinition = DEMO_ACTUAL_ENERGY_SOURCE_DEFINITIONS[energyTypeCode];
      Object.entries(monthlyValues).forEach(([month, sourceValue]) => {
        const outputValue = convertActualEnergyValue(energyTypeCode, sourceValue);
        generatedRows.push([
          month,
          energyTypeCode,
          outputValue,
          sourceDefinition.outputUnit,
          DEMO_ACTUAL_ENERGY_ORGANIZATION.code,
          '',
          buildActualEnergyRemark(period.label, energyTypeCode, sourceValue, outputValue)
        ]);
      });
    });
  });
  return generatedRows;
}

// 运行时复用冻结后的 59 条正式模板行，不读取或依赖项目根目录原 Excel。
const DEMO_ACTUAL_ENERGY_ROWS = Object.freeze(
  buildDemoActualEnergyRows().map((row) => Object.freeze([...row]))
);

module.exports = {
  DEMO_ACTUAL_ENERGY_DIESEL_DECIMAL_PLACES,
  DEMO_ACTUAL_ENERGY_DIESEL_DENSITY_KG_PER_LITER,
  DEMO_ACTUAL_ENERGY_ORGANIZATION,
  DEMO_ACTUAL_ENERGY_PERIODS,
  DEMO_ACTUAL_ENERGY_ROWS,
  DEMO_ACTUAL_ENERGY_SOURCE_DEFINITIONS,
  DEMO_ACTUAL_ENERGY_SOURCE_WORKSHEET,
  buildActualEnergyRemark,
  buildDemoActualEnergyRows,
  convertActualEnergyValue,
  roundActualEnergyValue
};
