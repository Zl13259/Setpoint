/* Quant v14.3 · 规则与参数中心（quant-rules.js）
   改规则只动这里（参数），或新建 rule-*.js 插件（否决门/评分修正），
   再到 quant-main.js 的 RULE_MANIFEST 加一行引用即可，内核不动。

   版本纪律：
   ① 改本文件任何数值 → VERSION 的小版本 +1，并同步 quant*.html 里的 ?v= 引用；
   ② 改变信号行为（而非纯展示）→ STRATEGY_VERSION 必须升级（前向记录按策略版本隔离）；
   ③ v14.0 起：新增盘中触发型超跌反弹（行为级，策略升级 OPENING_DAILY_V5）；突破通道有效期 2→3；
      盘中确认窗口 600→1800 秒、确认样本有效期 60 分钟；盘中执行模型仍为 INTRADAY_V2（触发来源分列），与 V1 档案不混算。
   ④ v14.1（数据修复，不改判定逻辑）：A股日K源顺序回退为 东财→腾讯→新浪（前复权确认源优先，
      新浪不复权口径仅作兜底），消除 v14.0 新浪优先造成的压力位/RSI/ATR 漂移与同票两版信号不一致
      （实证：伊利、亿纬锂能入场区与触发日双版对不上）；沿用 v14.0 对"源顺序调整"的口径处理，
      策略版本维持 OPENING_DAILY_V5。
   ⑤ v14.2（自测修复，不改信号行为）：突破通道 v14.0 有效期 2→3（2 次开盘窗口）后，5 项 v10 时代
      自测期望未同步（仍按 1 次窗口断言），浏览器面板自 v14.0 起显示 95/100。本版按 2 窗口语义重写
      该 5 项（窗口耗尽需连续两次区外开盘；余窗断言 1→2），并修正验证方法：Node 测试必须先加载
      真实 rules.js，否则内核回退内置 CHANNELS 会掩盖此类失配。策略版本维持 OPENING_DAILY_V5。
   ⑥ v14.3（执行层参数校准＋口径统一，行为级）：A股参考基准K线源与个股统一为 东财→腾讯→新浪；
      美股盘中报价独立阈值 intradayQuoteMaxAgeSecUS=1200 秒；量能节奏门槛 0.8→0.65；涨停可成交检查
      严格用 quote.prevClose（缺失跳过，不回退冻结 triggerPrice）；旧称“五门”更名“七门”（实际7项检查）；
      analyzeSymbol 与回放层统一增量特征。日线三通道判定未动，但盘中参数为行为级变更，
      STRATEGY_VERSION 升 OPENING_DAILY_V6、盘中模型升 INTRADAY_V3；参数指纹含全部 DEFAULTS 键，
      旧档案按指纹自动隔离、不删除、不混算。
   ───────────────────────────────────────────────── */
"use strict";
globalThis.QRULES = {
  VERSION: "v14.3",
  STRATEGY_VERSION: "OPENING_DAILY_V6",
  INTRADAY_MODEL: "INTRADAY_V3",
  DEFAULTS: {
    minBars: 80,
    minAmountA: 5e7,
    minAmountUS: 5e6,
    feeBps: 15,
    slippageBps: 10,
    minRR: 1.5,
    holdingDays: 10,
    intradayQuoteMaxAgeSec: 180,
    // v14.3：美股盘中报价独立新鲜度阈值（秒）。免费美股行情延迟普遍>180秒，
    // 共用 A股阈值会使美股盘中七门恒为 STALE、盘中执行名存实亡。
    intradayQuoteMaxAgeSecUS: 1200,
    intradayConfirmSamples: 2,
    intradayMinSampleGapSec: 45,
    intradayConfirmWindowSec: 1800,
    intradaySampleMaxAgeSec: 3600,
    // v14.3：0.8→0.65。均匀成交下分时曲线 dayFrac+0.13·sin(π·dayFrac) 全天仅 0.71~0.73，
    // 旧门槛几乎只在尾盘放行；新门槛仍高于均匀基准，属"偏积极"而非放任。
    intradayMinVolumePace: 0.65,
    minStopAtr: 0.5,
    maxStopAtr: 2.5,
  },
  CHANNELS: {
    oversold: { name: "超跌反弹", maxAge: 3 },
    pullback: { name: "趋势回踩", maxAge: 3 },
    breakout: { name: "突破确认", maxAge: 3 },
  },
  DAILY_EXCLUDED: [
    "usSOXS",
    "usSQQQ",
    "usTQQQ",
    "usSDS",
    "usSPXU",
    "usUVXY",
    "usSVXY",
  ],
};
/* 插件规则注册表：rule-*.js 向本数组 push 规则对象，由 quant-main.js 的 RULE_MANIFEST 登记加载。
   契约：{ id: 唯一字符串, appliesTo: ["oversold","pullback","breakout"]（缺省=全部通道）,
          gates: (ctx)=> true 通过 / 字符串=否决, scoreAdjust: (q, ctx)=> 有界加减分,
          params: 预留声明, selfTest: ()=> true（可选，进自测池） }
   ctx = { channel, code, market, config, metrics, geometry, features, Q } */
globalThis.QuantRules = globalThis.QuantRules || [];
