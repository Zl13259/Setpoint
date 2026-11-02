/* Quant v13.0 · 规则与参数中心（quant-rules.js）
   改规则只动这里（参数），或新建 rule-*.js 插件（否决门/评分修正），
   再到 quant-main.js 的 RULE_MANIFEST 加一行引用即可，内核不动。

   版本纪律：
   ① 改本文件任何数值 → VERSION 的小版本 +1，并同步 quant*.html 里的 ?v= 引用；
   ② 改变信号行为（而非纯展示）→ STRATEGY_VERSION 必须升级（前向记录按策略版本隔离）；
   ③ 当前数值与 v12.8 完全一致；策略仍为 OPENING_DAILY_V1（本次为纯重构，无行为变化）。
   ───────────────────────────────────────────────── */
"use strict";
globalThis.QRULES = {
  VERSION: "v13.3",
  STRATEGY_VERSION: "OPENING_DAILY_V3",
  DEFAULTS: {
    minBars: 80,
    minAmountA: 5e7,
    minAmountUS: 5e6,
    feeBps: 15,
    slippageBps: 10,
    minRR: 1.5,
    holdingDays: 10,
    intradayQuoteMaxAgeSec: 180,
    intradayConfirmSamples: 2,
    intradayMinSampleGapSec: 45,
    intradayConfirmWindowSec: 600,
    intradayMinVolumePace: 0.8,
    minStopAtr: 0.5,
    maxStopAtr: 2.5,
  },
  CHANNELS: {
    oversold: { name: "超跌反弹", maxAge: 3 },
    pullback: { name: "趋势回踩", maxAge: 3 },
    breakout: { name: "突破确认", maxAge: 2 },
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
