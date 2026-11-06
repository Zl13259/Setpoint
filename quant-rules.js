/* Quant v15.0 · 规则与参数中心（quant-rules.js）
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
   ⑦ v14.4（死代码清理，不改任何信号行为）：删除 ui.js 死函数 actionHTML、intradayHTML 的
      未使用参数 detail、state.intradayCapturing 死字段；观察态详情不再渲染无意义的
      “信号 —”占位文本；内核导出收敛（移除外部无人引用的 INTRADAY_MODEL/sessionElapsedMinutes
      导出项，内部仍在用）；state.sessionKey 补入声明。策略版本维持 OPENING_DAILY_V6。
   ⑧ v14.5（超跌通道放宽＋通道级赔率门槛，行为级）：① 新增 RSI 恢复触发器（事件日 RSI≤30 →
      回升≥40 且收复事件日收盘，不要求收复 MA5）；② 事件窗口 10→15 完成日；③ 新低缓冲
      0.2→0.3 ATR、企稳量 1.1→1.25、下影 1.5→1.2、ATR 分级 2.0/1.0→2.5/1.2；④ 净赔率门槛按
      通道分级（超跌 1.2、突破/回踩 1.5），预筛/开盘判定/盘中七门/回放统一走 channelMinRR。
      STRATEGY_VERSION 升 OPENING_DAILY_V7、盘中模型升 INTRADAY_V4，旧档案按指纹自动隔离。
   ⑨ v14.5 增补（外部评审采纳，行为级，同属 V7/V4 批次）：企稳分级阈值校准为 4.0/2.0；突破量能 1.2→1.1
      参数化 breakoutMinVolRatio；突破入场区上沿 0.35→0.5 ATR 参数化 breakoutZoneHiAtr（评审建议
      +0.8~1.0，但上沿过宽会系统性压垮净赔率门槛，取折中）；三通道开盘窗口 2→3 次（maxAge 3→4）；
      盘中确认间隔 45→30 秒、确认窗口 1800→3600 秒。
   ⑩ v14.6（工程加固，不改信号行为，策略维持 V7）：① 研究池指数标志位硬化（只认数字1/布尔true，
      修历史版本字符串标志导致整池被误判为指数、研究池静默归零 0/0 的故障类）；② 研究池空池自愈
      （过滤后为空→自动恢复默认池+显式日志/提示，杜绝静默 0/0）；③ 渲染层与台账层调用逐个容错；
      ④ 加载中状态在覆盖指示器上显式显示。全部 DEFAULTS 与判定逻辑未动，参数指纹不变、
      前向档案延续 V7 簇。
   ⑪ v14.7（渲染层热修复，纯展示，不改任何信号行为，策略维持 V7）：v14.4 清理死代码时删除了
      intradayHTML 的未使用参数 detail，但漏删函数体内的引用（checks = detail && ...）；
      严格模式下渲染第一行即抛 ReferenceError，被 v14.6 的渲染容错吞为日志——后台数据其实
      加载完成，但信号台 DOM 写不进去，外部表现为"数据获取不到"。本版删除该残留引用；
      DEFAULTS、判定逻辑、策略版本均未动，参数指纹不变、前向档案延续 V7 簇。
   ⑫ v14.8（超跌通道灵敏度修复，行为级，用户裁决 2026-11-06）：① 企稳分级从触发硬门降级为
      评分/警示项——v13.3 硬门实测在 V 型 regime 系统性延迟（触发根不计入企稳数，事件期 ATR≥4%
      时大跌后最早第 4 个交易日才触发），入场抬高后撞 2.5 ATR 上限＋目标压缩，整批灭绝（11-05
      张江/有研/宁德案例）。触发恢复为"无新低＋≥1 根企稳证据"；requiredStable 保留于 metrics
      供 Q 评分（达标 +10）与"建议 N 根"提示。超跌定位：系统负责筛出，人工评估买不买。
      ② 止损上限按通道分级 channelMaxStopAtr（超跌 3.5、突破/回踩 2.5）——超跌锚定事件低点，
      天然宽于突破，2.5 一刀切会重演"触发即被毙"（v12.8 大族激光 2.54 ATR 实证）。
      STRATEGY_VERSION 升 OPENING_DAILY_V8、盘中模型升 INTRADAY_V5（盘中触发探测同用 detectImpl）；
      旧档案按指纹自动隔离不删除。2026-11-05"等 v12.8 前向到期再裁决"的约定由 2026-11-06
      用户指令覆盖；11-18 对照实验继续（legacy 簇隔离，成为改前/改后 A/B）。
   ⑬ v14.9（事件锚定修复，行为级）：锚点从"窗口内 Z 值最深日"改为"窗口内满足超跌门槛
      （RSI≤30／Z≤-2／5日跌≥12%）的日子中低点最低的那天"——旧逻辑下新低点出现后旧锚点
      赖在 16 根K线窗口内，"结构未修复"门最长滞后约 15 个交易日才重新锚定（10-15 Z 最深
      vs 11-03 低点更低的活锁案例，五只票卡阶段①）；低点锚定让新低当日即重锚，滞后压到
      1~2 天。Z 值仍由 metrics.eventZ 供 Q 评分。连锁：止损锚随实际最低点下移（更宽），
      仓位自动缩小。STRATEGY_VERSION 升 OPENING_DAILY_V9、盘中模型升 INTRADAY_V6；
      旧档案按指纹自动隔离不删除。
   ⑭ v15.0（删除盘中连续确认门，行为级，用户裁决 2026-11-06）：盘中七门减为六门——
      删除"盘中连续确认"门（原要求 ≥2 次间隔 ≥30 秒的区内连续报价）。用户不常刷新页面
      且人工复核，确认样本机制（盘中采样/本地存储/确认证据列）随门一并清理；其余五门
      与执行口径不变。STRATEGY_VERSION 升 OPENING_DAILY_V10、盘中模型升 INTRADAY_V7；
      旧档案按执行模型与参数指纹自动分列。行为后果：区内单次有效报价即达可执行状态，
      触发密度上升，人工复核责任同步加重；V6（有确认门）与 V7（无）档案天然构成 A/B。
   ───────────────────────────────────────────────── */
"use strict";
globalThis.QRULES = {
  VERSION: "v15.0",
  STRATEGY_VERSION: "OPENING_DAILY_V10",
  INTRADAY_MODEL: "INTRADAY_V7",
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
    // v14.3：0.8→0.65。均匀成交下分时曲线 dayFrac+0.13·sin(π·dayFrac) 全天仅 0.71~0.73，
    // 旧门槛几乎只在尾盘放行；新门槛仍高于均匀基准，属"偏积极"而非放任。
    intradayMinVolumePace: 0.65,
    minStopAtr: 0.5,
    maxStopAtr: 2.5,
    // v14.5 超跌通道放宽（Monte Carlo 40万评估点定位的杀信号闸门：62% 的②阶段候选死于
    // “未收复MA5”、38% 死于“K线强度不足”）——全部参数化，随参数指纹自动隔离旧档案：
    oversoldLowBufferAtr: 0.3,          // 新低判定缓冲 0.2→0.3 ATR：允许更深的回抽而不破坏结构
    oversoldStableVolMult: 1.25,        // 企稳 bar 量条件 1.1→1.25 倍20日均量
    oversoldStableShadowMult: 1.2,      // 企稳 bar 下影条件 1.5→1.2 倍实体
    oversoldStableBarsAtrPct: [4.0, 2.0], // ATR% 分级阈值（评审校准 2.0/1.0→4.0/2.0）：v14.8 起仅作评分/建议，不作触发硬门
    oversoldRecoverRsi: 40,             // RSI 恢复触发器：事件日 RSI≤30 后回升至≥40 且收复事件日收盘
    // 通道级净赔率门槛：超跌反弹目标天然偏近（prevHigh20/MA20 封顶），与突破共用 1.5 会被
    // 预筛系统性误杀；按通道分级后仍高于 1.0，属“放宽但有界”。
    channelMinRR: { oversold: 1.2, pullback: 1.5, breakout: 1.5 },
    breakoutMinVolRatio: 1.1,           // 突破量能门槛 1.2→1.1（评审：原硬编码杀掉 45.7% 价格突破）
    breakoutZoneHiAtr: 0.5,             // 突破入场区上沿 0.35→0.5 ATR（评审建议 0.8~1.0 会压垮净赔率，取折中）
    // v14.8：止损上限按通道分级——超跌锚定事件低点，天然宽于突破；2.5 一刀切会错杀
    // （v12.8 大族激光止损 2.54 ATR 实证）。仓位=风险预算÷止损幅度，宽止损自动缩仓，R 口径不变。
    channelMaxStopAtr: { oversold: 3.5, pullback: 2.5, breakout: 2.5 },
  },
  CHANNELS: {
    oversold: { name: "超跌反弹", maxAge: 4 },
    pullback: { name: "趋势回踩", maxAge: 4 },
    breakout: { name: "突破确认", maxAge: 4 },
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
