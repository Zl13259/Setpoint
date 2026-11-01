/* Quant v13.0 · 规则插件模板（rule-template.js）
   用法：复制为 rule-<你的名字>.js → 修改 id 与逻辑 →
        到 quant-main.js 的 RULE_MANIFEST 加一行 { file: "rule-<名字>.js", v: "1.0" }。
   生效范围：日线触发判定与回放共用此规则；实时、回放口径一致。
   版本纪律：改插件 → v +1；改变信号行为 → quant-rules.js 的 STRATEGY_VERSION 升级。 */
"use strict";
(globalThis.QuantRules = globalThis.QuantRules || []).push({
  id: "rule-template",              // 必须唯一，加载时校验，重复即停止启动
  version: "1.0",
  appliesTo: ["oversold", "pullback", "breakout"],  // 缺省 = 全部通道
  // gates: (ctx) => true,          // 返回 true 通过；返回字符串 = 否决该信号（记入拒绝原因）
  // scoreAdjust: (q, ctx) => 0,    // 对 Q 做有界加减（结果夹在 0~100）
  // params: {},                    // 预留：运行期参数请改 quant-rules.js 的 DEFAULTS
  selfTest: () => true,             // 可选；返回 true 或失败原因字符串，进自测池
});
