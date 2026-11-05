/* Quant v14.7 objective signal and intraday execution core. No DOM, storage, network or account rules.
   纯内核：参数/通道/排除名单来自 globalThis.QRULES（quant-rules.js），插件规则来自 globalThis.QuantRules。 */
const QuantCore = (() => {
  "use strict";
  const QRULES = globalThis.QRULES || {},
      VERSION = QRULES.VERSION || "v13.0",
      STRATEGY_VERSION = QRULES.STRATEGY_VERSION || "OPENING_DAILY_V1",
      INTRADAY_MODEL = QRULES.INTRADAY_MODEL || "INTRADAY_V2";
  const BUILTIN_DEFAULTS = Object.freeze({
    minBars: 80,
    minAmountA: 5e7,
    minAmountUS: 5e6,
    feeBps: 15,
    slippageBps: 10,
    minRR: 1.5,
    holdingDays: 10,
    intradayQuoteMaxAgeSec: 180,
    intradayConfirmSamples: 2,
    intradayMinSampleGapSec: 30,
    intradayConfirmWindowSec: 3600,
    intradaySampleMaxAgeSec: 3600,
    intradayMinVolumePace: 0.8,
    minStopAtr: 0.5,
    maxStopAtr: 2.5,
    oversoldLowBufferAtr: 0.3,
    oversoldStableVolMult: 1.25,
    oversoldStableShadowMult: 1.2,
    oversoldStableBarsAtrPct: [4.0, 2.0],
    oversoldRecoverRsi: 40,
    channelMinRR: { oversold: 1.2, pullback: 1.5, breakout: 1.5 },
    breakoutMinVolRatio: 1.1,
    breakoutZoneHiAtr: 0.5,
    channelMaxStopAtr: { oversold: 3.5, pullback: 2.5, breakout: 2.5 },
  });
  const DEFAULTS = Object.freeze({ ...BUILTIN_DEFAULTS, ...(QRULES.DEFAULTS || {}) });
  const CHANNELS = QRULES.CHANNELS || {
    oversold: { name: "超跌反弹", maxAge: 3 },
    pullback: { name: "趋势回踩", maxAge: 3 },
    breakout: { name: "突破确认", maxAge: 2 },
  };
  const DAILY_EXCLUDED = new Set(QRULES.DAILY_EXCLUDED || [
    "usSOXS",
    "usSQQQ",
    "usTQQQ",
    "usSDS",
    "usSPXU",
    "usUVXY",
    "usSVXY",
  ]);
  const clamp = (x, a = 0, b = 100) => Math.max(a, Math.min(b, x));
  const finite = (x) => Number.isFinite(Number(x));
  const mean = (a) =>
    a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const median = (a) => {
    if (!a.length) return null;
    const b = a.slice().sort((x, y) => x - y),
      m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  const round = (x, d = 2) => (finite(x) ? Number(Number(x).toFixed(d)) : null);
  const sum = (a) => a.reduce((s, x) => s + x, 0);
  const last = (a) => a[a.length - 1];
  const max = (a) => (a.length ? Math.max(...a) : null);
  const min = (a) => (a.length ? Math.min(...a) : null);
  function rolling(a, p) {
    const out = Array(a.length).fill(null);
    let s = 0;
    for (let i = 0; i < a.length; i++) {
      s += a[i];
      if (i >= p) s -= a[i - p];
      if (i >= p - 1) out[i] = s / p;
    }
    return out;
  }
  function ema(a, p) {
    if (!a.length) return [];
    const k = 2 / (p + 1),
      out = [a[0]];
    for (let i = 1; i < a.length; i++)
      out.push(a[i] * k + out[i - 1] * (1 - k));
    return out;
  }
  function rsiSeries(c, p = 14) {
    const out = Array(c.length).fill(null);
    if (c.length <= p) return out;
    let g = 0,
      l = 0;
    for (let i = 1; i <= p; i++) {
      const d = c[i] - c[i - 1];
      g += Math.max(d, 0);
      l += Math.max(-d, 0);
    }
    g /= p;
    l /= p;
    out[p] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
    for (let i = p + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      g = (g * (p - 1) + Math.max(d, 0)) / p;
      l = (l * (p - 1) + Math.max(-d, 0)) / p;
      out[i] = l === 0 ? (g === 0 ? 50 : 100) : 100 - 100 / (1 + g / l);
    }
    return out;
  }
  function atrSeries(b, p = 14) {
    const out = Array(b.length).fill(null);
    if (b.length <= p) return out;
    const tr = Array(b.length).fill(null);
    for (let i = 1; i < b.length; i++) {
      const x = b[i],
        pc = b[i - 1].close;
      tr[i] = Math.max(
        x.high - x.low,
        Math.abs(x.high - pc),
        Math.abs(x.low - pc),
      );
    }
    let a = mean(tr.slice(1, p + 1));
    out[p] = a;
    for (let i = p + 1; i < b.length; i++) {
      a = (a * (p - 1) + tr[i]) / p;
      out[i] = a;
    }
    return out;
  }
  function macd(c) {
    const e12 = ema(c, 12),
      e26 = ema(c, 26),
      dif = c.map((_, i) => e12[i] - e26[i]),
      dea = ema(dif, 9);
    return { dif, dea, hist: dif.map((x, i) => (x - dea[i]) * 2) };
  }
  function normalizeBars(input) {
    if (!Array.isArray(input)) return [];
    const out = [];
    for (const x of input) {
      const b = Array.isArray(x)
        ? {
            date: x[5] || x[6],
            open: +x[0],
            close: +x[1],
            high: +x[2],
            low: +x[3],
            volume: +x[4],
            amount: finite(x[6]) ? +x[6] : null,
          }
        : {
            date: String(x.date || "").slice(0, 10),
            open: +x.open,
            high: +x.high,
            low: +x.low,
            close: +x.close,
            volume: +(x.volume || 0),
            amount: finite(x.amount) ? +x.amount : null,
          };
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(b.date) ||
        ![b.open, b.high, b.low, b.close].every(Number.isFinite)
      )
        continue;
      if (
        b.open <= 0 ||
        b.high <= 0 ||
        b.low <= 0 ||
        b.close <= 0 ||
        b.high < Math.max(b.open, b.close) ||
        b.low > Math.min(b.open, b.close) ||
        b.high < b.low ||
        b.volume < 0
      )
        continue;
      out.push(b);
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out.filter((b, i) => !i || b.date !== out[i - 1].date);
  }
  function klineSeriesQuality(input, minBars = 30) {
    let bars = normalizeBars(input);
    const errors = [];
    if (bars.length < minBars) errors.push(`有效日K不足${minBars}根`);
    let cut = 0;
    for (let i = 1; i < bars.length; i++) {
      const gap = (Date.parse(bars[i].date) - Date.parse(bars[i - 1].date)) / 864e5;
      if (!Number.isFinite(gap) || gap <= 0) errors.push("K线日期顺序异常");
      if (gap > 35) cut = i;
    }
    if (cut) bars = bars.slice(cut);
    if (bars.length < minBars) errors.push("最近连续K线段不足，疑似拼接或长期断档");
    for (let i = Math.max(1, bars.length - 30); i < bars.length; i++) {
      const r = bars[i].close / bars[i - 1].close - 1;
      if (!Number.isFinite(r) || Math.abs(r) > 1) errors.push("近30根K线存在异常跳变");
    }
    if (bars.length >= 20) {
      const r20 = last(bars).close / bars[bars.length - 20].close - 1;
      if (!Number.isFinite(r20) || Math.abs(r20) > 1.5) errors.push("20日收益异常，疑似跨段拼接");
    }
    return { bars, pass: !errors.length, errors: [...new Set(errors)] };
  }
  function featureShared(b) {
    const c = b.map((x) => x.close),
      v = b.map((x) => x.volume);
    return {
      c,
      v,
      ma5: rolling(c, 5),
      ma10: rolling(c, 10),
      ma20: rolling(c, 20),
      ma60: rolling(c, 60),
      rsi: rsiSeries(c),
      atr: atrSeries(b),
      macd: macd(c),
    };
  }
  function featureAt(b, shared, i) {
    const n = i + 1;
    if (n < 60) return null;
    const { c, v, ma5, ma10, ma20, ma60, rsi, atr, macd: m } = shared,
      a = atr[i];
    if (!a || !ma60[i]) return null;
    const prev20 = b.slice(i - 20, i),
      prev60 = b.slice(Math.max(0, i - 60), i),
      last20 = b.slice(i - 19, i + 1),
      vol20 = v.slice(i - 20, i),
      amount20 = b
        .slice(i - 20, i)
        .map((x) => x.amount)
        .filter(Number.isFinite);
    const swings = [];
    for (let j = Math.max(2, n - 42); j < n - 2; j++) {
      const w = b.slice(j - 2, j + 3);
      if (b[j].low === min(w.map((x) => x.low)))
        swings.push({ index: j, price: b[j].low, confirmedAt: j + 2 });
    }
    const base = b.slice(i - 20, i),
      baseHigh = max(base.map((x) => x.high)),
      baseLow = min(base.map((x) => x.low)),
      baseRange = baseHigh - baseLow,
      prior = b.slice(i - 40, i - 20),
      priorAtr = atr[Math.max(0, n - 22)];
    return {
      bars: b,
      n,
      c,
      ma5,
      ma10,
      ma20,
      ma60,
      rsi,
      atr,
      macd: m,
      close: c[i],
      open: b[i].open,
      high: b[i].high,
      low: b[i].low,
      volume: v[i],
      date: b[i].date,
      atr: a,
      atrPct: (a / c[i]) * 100,
      ma5Prev: ma5[i - 1],
      ma20Prev5: ma20[i - 5],
      ma60Prev5: ma60[i - 5],
      prevHigh20: max(prev20.map((x) => x.high)),
      prevLow20: min(prev20.map((x) => x.low)),
      prevHigh60: max(prev60.map((x) => x.high)),
      prevLow60: min(prev60.map((x) => x.low)),
      ret5: (c[i] / c[i - 5] - 1) * 100,
      ret20: (c[i] / c[i - 20] - 1) * 100,
      ret60: (c[i] / c[i - 60] - 1) * 100,
      volAvg5: mean(v.slice(i - 5, i)),
      volAvg20: mean(vol20),
      amountAvg20: mean(amount20),
      volRatio: mean(vol20) > 0 ? v[i] / mean(vol20) : null,
      closePos:
        b[i].high > b[i].low ? (c[i] - b[i].low) / (b[i].high - b[i].low) : 0.5,
      z20: (() => {
        const mu = mean(last20.map((x) => x.close)),
          sd = Math.sqrt(mean(last20.map((x) => (x.close - mu) ** 2)));
        return sd ? (c[i] - mu) / sd : 0;
      })(),
      atrRank: (() => {
        const w = atr.slice(Math.max(0, i - 59), i + 1).filter(Number.isFinite);
        return w.length ? w.filter((v) => v <= a).length / w.length : null;
      })(),
      atrArr: atr,
      atrPrior5: atr[i - 5],
      atrPrior20: priorAtr,
      baseHigh,
      baseLow,
      baseRange,
      baseRangePct: baseHigh ? (baseRange / baseHigh) * 100 : null,
      baseVol: mean(base.map((x) => x.volume)),
      priorVol: mean(prior.map((x) => x.volume)),
      swings,
    };
  }
  function features(input) {
    const b = normalizeBars(input);
    return b.length ? featureAt(b, featureShared(b), b.length - 1) : null;
  }
  function asNormalized(input) {
    if (input && input.__q10Normalized) return input;
    const out = normalizeBars(input);
    try {
      Object.defineProperty(out, "__q10Normalized", { value: true });
    } catch (e) {}
    return out;
  }
  function benchReturn(benchmark, date) {
    const b = asNormalized(benchmark).filter((x) => x.date <= date);
    return b.length >= 21
      ? (last(b).close / b[b.length - 21].close - 1) * 100
      : null;
  }
  function scoreQ(channel, m) {
    const sc = (x) => round(clamp(x), 1);
    if (channel === "oversold") {
      const exhaustion = sc(
        (30 - m.eventRsi) * 5 +
          Math.max(0, -m.eventZ - 1) * 25 +
          Math.max(0, -m.eventDrop5 - 5) * 2,
      );
      const stable = sc(
        (m.noNewLow ? 40 : 0) +
          Math.min(3, m.stableCount) * 10 +
          (m.volContraction ? 30 : 0) +
          // v14.8：企稳分级达标加分——分级从硬门降级为评分项后，信息保留在 Q 里。
          (m.stableCount >= m.requiredStable ? 10 : 0),
      );
      const confirm = sc(
        (m.breakPrevHigh ? 45 : 15) +
          m.closePos * 25 +
          clamp(((m.volRatio || 1) / 1.8) * 30, 0, 30),
      );
      const structure = sc(
        (m.aboveEventLow ? 45 : 0) +
          (m.close > m.ma5 ? 25 : 0) +
          (m.close > m.ma20 ? 20 : 0) +
          (m.atrPrior5 && m.atr <= m.atrPrior5 ? 10 : 0),
      );
      return {
        value: round(
          exhaustion * 0.2 + stable * 0.3 + confirm * 0.3 + structure * 0.2,
          1,
        ),
        dims: {
          下跌衰竭: exhaustion,
          企稳质量: stable,
          反弹确认: confirm,
          结构完整性: structure,
        },
      };
    }
    if (channel === "pullback") {
      const trend = sc(
        (m.ma20 > m.ma60 ? 35 : 0) +
          (m.ma60 > m.ma60Prev5 ? 30 : 0) +
          (m.close > m.ma60 ? 20 : 0) +
          clamp(m.ret60, 0, 15),
      );
      const support = sc(
        35 +
          Math.min(3, m.supportTouches) * 15 +
          (m.supportSource === "确认摆动低点" ? 15 : 0),
      );
      const health = sc(
        (m.orderly ? 40 : 10) +
          (m.volContraction ? 25 : 0) +
          (m.drawdown >= 2 && m.drawdown <= 12 ? 25 : 10) +
          (m.aboveSupport ? 10 : 0),
      );
      const restart = sc(
        (m.breakPrevHigh ? 45 : 20) +
          (m.close > m.ma5 ? 25 : 0) +
          m.closePos * 20 +
          (m.volRatio >= 1 ? 10 : 0),
      );
      return {
        value: round((trend + support + health + restart) / 4, 1),
        dims: {
          趋势质量: trend,
          支撑质量: support,
          回踩健康度: health,
          再启动确认: restart,
        },
      };
    }
    const base = sc(
      (m.baseRangePct <= 18 ? 40 : m.baseRangePct <= 28 ? 25 : 10) +
        (m.atrPrior20 && m.atr < m.atrPrior20 ? 30 : 10) +
        (m.priorVol && m.baseVol < m.priorVol ? 30 : 10),
    );
    const pressure = sc(
      40 + Math.min(3, m.pressureTouches) * 15 + (m.baseLength >= 15 ? 15 : 0),
    );
    const confirm = sc(
      (m.close > m.baseHigh ? 35 : 0) +
        m.closePos * 30 +
        clamp(((m.volRatio || 0) / 2) * 35, 0, 35),
    );
    const rs = m.rs20 === null ? null : sc(m.rs20 <= 0 ? 0 : 50 + m.rs20 * 4);
    return {
      value:
        rs === null
          ? null
          : round(base * 0.3 + pressure * 0.2 + confirm * 0.3 + rs * 0.2, 1),
      dims: {
        基底质量: base,
        压力位质量: pressure,
        突破确认: confirm,
        相对强弱: rs,
      },
    };
  }
  function detectImpl(channel, f, benchmark, conf) {
    const c = { ...DEFAULTS, ...(conf || {}) },
      b = f.bars,
      n = f.n,
      i = n - 1,
      x = b[i],
      p = b[i - 1],
      base = {
        channel,
        name: CHANNELS[channel].name,
        stage: 0,
        missing: [],
        evidence: [],
        metrics: {},
      };
    if (channel === "oversold") {
      let event = -1,
        eventZ = null;
      // v14.5：事件窗口 10→15 个完成日——崩盘后筑底常需一周以上，旧窗口在反弹触发前事件就过期。
      for (let j = Math.max(20, n - 16); j < n; j++) {
        const z = f.rsi[j],
          slice = b.slice(j - 19, j + 1),
          mu = mean(slice.map((y) => y.close)),
          sd = Math.sqrt(mean(slice.map((y) => (y.close - mu) ** 2))),
          zz = sd ? (b[j].close - mu) / sd : 0,
          drop = j >= 5 ? (b[j].close / b[j - 5].close - 1) * 100 : 0;
        if ((z <= 30 || zz <= -2 || drop <= -12) && (eventZ === null || zz < eventZ)) {
          event = j;
          eventZ = zz;
        }
      }
      if (event < 0) {
        base.missing = ["近15日无明确超跌事件"];
        return base;
      }
      const eb = b[event],
        after = b.slice(event + 1);
      const atrEvt = max(f.atrArr.slice(event, Math.min(n, event + 4)).filter(Number.isFinite)) || f.atr,
        atrPctEvt = eb.close > 0 ? (atrEvt / eb.close) * 100 : null,
        requiredStable = atrPctEvt === null ? 1 : atrPctEvt >= c.oversoldStableBarsAtrPct[0] ? 3 : atrPctEvt >= c.oversoldStableBarsAtrPct[1] ? 2 : 1;
      const stableBars = b.slice(event + 1, -1);
      let stableBeforeTrigger = 0;
      for (const y of stableBars) {
        const body = Math.abs(y.close - y.open),
          shadow = Math.min(y.open, y.close) - y.low,
          volOk = y.volume <= f.volAvg20 * c.oversoldStableVolMult;
        if (y.close >= y.open || shadow > body * c.oversoldStableShadowMult || volOk)
          stableBeforeTrigger++;
      }
      const eventLow = eb.low,
        lowBuffer = f.atr * c.oversoldLowBufferAtr,
        noNewLow = after.length
          ? min(after.map((y) => y.low)) >= eventLow - lowBuffer
          : true,
        breakPrevHigh = x.close > p.high && x.close > x.open,
        cross5 = x.close > f.ma5[i] && p.close <= f.ma5[i - 1],
        // v14.5 RSI 恢复触发器：事件日 RSI≤30 后回升至 ≥oversoldRecoverRsi 且收复事件日收盘。
        // Monte Carlo（40万评估点）显示 62% 的②阶段候选死于"未收复 MA5"、38% 死于"K线强度不足"——
        // 深 V 结构里 MA5 收复滞后于动能修复，原触发器覆盖不到这种形态。
        rsiRecover =
          f.rsi[event] !== null && f.rsi[event] !== undefined &&
          f.rsi[event] <= 30 && f.rsi[i] >= c.oversoldRecoverRsi &&
          x.close > eb.close,
        // v14.8：企稳分级从触发硬门降级为评分/警示项——v13.3 硬门实测在 V 型 regime 系统性延迟
        // （当前触发根不计入企稳数，事件期 ATR≥4% 时大跌后最早第 4 个交易日才触发），入场抬高后
        // 撞止损上限＋目标压缩、整批灭绝（11-05 张江/有研/宁德案例）。触发恢复为"无新低＋≥1 根
        // 企稳证据"；requiredStable 保留于 metrics 供 Q 评分（达标 +10）与"建议 N 根"提示。
        trigger =
          noNewLow &&
          stableBeforeTrigger >= 1 &&
          (breakPrevHigh || cross5 || rsiRecover) &&
          (x.close > f.ma5[i] || rsiRecover);
      Object.assign(base.metrics, {
        eventIndex: event,
        eventLow,
        eventRsi: f.rsi[event] || 50,
        eventDrop5: event >= 5 ? (eb.close / b[event - 5].close - 1) * 100 : 0,
        eventZ: (() => {
          const slice = b.slice(event - 19, event + 1),
            mu = mean(slice.map((y) => y.close)),
            sd = Math.sqrt(mean(slice.map((y) => (y.close - mu) ** 2)));
          return sd ? (eb.close - mu) / sd : 0;
        })(),
        stableCount: stableBeforeTrigger,
        requiredStable,
        noNewLow,
        rsiRecover,
        volContraction: f.volume < f.volAvg20,
        breakPrevHigh,
        closePos: f.closePos,
        volRatio: f.volRatio || 1,
        aboveEventLow: x.low >= eventLow - lowBuffer,
        close: f.close,
        ma5: f.ma5[i],
        ma20: f.ma20[i],
        atr: f.atr,
        atrPrior5: f.atrPrior5,
      });
      base.evidence = [
        `超跌日 ${eb.date}，RSI ${round(f.rsi[event], 1)}`,
        `其后企稳 bar ${stableBeforeTrigger} 根（事件期 ATR 峰值 ${atrPctEvt === null ? "—" : round(atrPctEvt, 1)}%；分级建议 ≥${requiredStable} 根，不足则 Q 企稳分扣分，抢跑风险由人工评估）`,
      ];
      // v14.8：企稳分级降级后，stage② = 无新低 且 已有 ≥1 根企稳证据（不要求分级达标）。
      base.stage = trigger ? 3 : noNewLow && stableBeforeTrigger >= 1 ? 2 : 1;
      if (!trigger)
        base.missing = [
          !noNewLow
            ? "结构未修复：仍在破坏超跌低点，等待重新筑底"
            : "尚未出现反弹触发（无新低且有企稳证据，等收复前高／收复 MA5／RSI 恢复）",
        ];
      if (base.stage === 3) {
        base.Q = scoreQ(channel, base.metrics);
        base.anchors = { eventLow };
      }
      return base;
    }
    if (channel === "pullback") {
      const trend =
        f.ma20[i] > f.ma60[i] && f.ma60[i] > f.ma60Prev5 && f.close > f.ma60[i];
      if (!trend) {
        base.missing = ["原趋势不成立或已失效"];
        return base;
      }
      const candidates = [
        { price: f.ma20[i], source: "MA20" },
        { price: f.ma10[i], source: "MA10" },
      ]
        .concat(
          f.swings
            .slice(-3)
            .map((s) => ({ price: s.price, source: "确认摆动低点" })),
        )
        .filter(
          (s) =>
            s.price < f.close + f.atr * 0.4 && s.price > f.close - f.atr * 2.5,
        );
      if (!candidates.length) {
        base.missing = ["附近无明确支撑"];
        return base;
      }
      candidates.sort(
        (a, b) => Math.abs(f.close - a.price) - Math.abs(f.close - b.price),
      );
      const sp = candidates[0],
        supportSeries =
          sp.source === "MA10" ? f.ma10 : sp.source === "MA20" ? f.ma20 : null,
        levelAt = (j) => (supportSeries ? supportSeries[j] : sp.price),
        recent = b.slice(-6),
        touched = recent.some((y, k) => {
          const level = levelAt(n - 6 + k);
          return (
            Math.abs(y.low - level) <= f.atr * 0.8 ||
            Math.abs(y.close - level) <= f.atr * 0.8
          );
        }),
        aboveSupport = f.close > sp.price,
        drawdown = (f.prevHigh20 / min(recent.map((y) => y.low)) - 1) * 100,
        volContraction =
          mean(recent.slice(0, -1).map((y) => y.volume)) < f.volAvg20 * 1.05,
        orderly = drawdown < 18 && min(recent.map((y) => y.close)) > f.ma60[i],
        breakPrevHigh = x.close > p.high && x.close > x.open,
        cross5 = x.close > f.ma5[i] && p.close <= f.ma5[i - 1],
        trigger =
          touched && aboveSupport && orderly && (breakPrevHigh || cross5);
      const touches = b
        .slice(-25, -1)
        .filter(
          (y, k) => Math.abs(y.low - levelAt(n - 25 + k)) <= f.atr * 0.55,
        ).length;
      Object.assign(base.metrics, {
        support: sp.price,
        ma20: f.ma20[i],
        ma60: f.ma60[i],
        ma60Prev5: f.ma60Prev5,
        close: f.close,
        ret60: f.ret60,
        supportTouches: touches,
        supportSource: sp.source,
        orderly,
        volContraction,
        drawdown,
        aboveSupport,
        breakPrevHigh,
        ma5: f.ma5[i],
        closePos: f.closePos,
        volRatio: f.volRatio || 0,
      });
      Object.assign(base, {
        evidence: [
          `${sp.source} 支撑 ${round(sp.price)}`,
          `20日高点回撤 ${round(drawdown, 1)}%`,
        ],
        stage: trigger ? 3 : touched && aboveSupport ? 2 : 1,
      });
      if (!trigger)
        base.missing = [
          !touched
            ? "尚未回踩支撑区"
            : !aboveSupport
              ? "价格仍在支撑下方"
              : !orderly
                ? "回踩过程破坏趋势结构"
                : "尚未重新转强",
        ];
      if (base.stage === 3) {
        base.Q = scoreQ(channel, base.metrics);
        base.anchors = { support: sp.price, supportSource: sp.source };
      }
      return base;
    }
    const rs20 = benchReturn(benchmark, f.date);
    if (rs20 === null) {
      base.missing = ["缺少同市场参考池"];
      return base;
    }
    const near =
        f.close >= f.baseHigh - f.atr * 0.6 &&
        f.close <= f.baseHigh + f.atr * 1.5,
      above = f.close > f.baseHigh + f.atr * 0.05,
      volOk = f.volRatio !== null && f.volRatio >= c.breakoutMinVolRatio,
      priceOk = f.closePos >= 0.55,
      trigger = above && volOk && priceOk,
      pressureTouches = f.bars
        .slice(-31, -1)
        .filter((y) => Math.abs(y.high - f.baseHigh) <= f.atr * 0.4).length,
      rs = f.ret20 - rs20;
    Object.assign(base.metrics, {
      baseRangePct: f.baseRangePct,
      atr: f.atr,
      atrPrior20: f.atrPrior20,
      priorVol: f.priorVol,
      baseVol: f.baseVol,
      baseLength: 20,
      pressureTouches,
      close: f.close,
      baseHigh: f.baseHigh,
      closePos: f.closePos,
      volRatio: f.volRatio || 0,
      rs20: rs,
    });
    base.evidence = [
      `前20日压力 ${round(f.baseHigh)}`,
      `20日相对强弱 ${round(rs, 1)} pct`,
    ];
    base.stage = trigger ? 3 : above || near ? 2 : 1;
    if (!trigger)
      base.missing = [
        above && !volOk
          ? "突破量能未确认"
          : above && !priceOk
            ? "收盘位置未确认"
            : "尚未有效脱离压力区",
      ];
    if (base.stage === 3) {
      base.Q = scoreQ(channel, base.metrics);
      base.anchors = {
        pressure: f.baseHigh,
        baseLow: f.baseLow,
        baseRange: f.baseRange,
      };
    }
    return base;
  }
  function detect(channel, f, benchmark, cfg, market = "A") {
    const conf = { ...DEFAULTS, ...(cfg || {}) },
      base = detectImpl(channel, f, benchmark, conf);
    if (!base || base.stage === 3 || !f) return base;
    try {
      const m = base.metrics || {},
        anchors = base.anchors ||
          (channel === "oversold" && Number.isFinite(m.eventLow)
            ? { eventLow: m.eventLow }
            : channel === "pullback" && Number.isFinite(m.support)
              ? { support: m.support, supportSource: m.supportSource }
              : channel === "breakout"
                ? { pressure: f.baseHigh, baseLow: f.baseLow, baseRange: f.baseRange }
                : null);
      if (!anchors) return base;
      const g = netGeometry(channel, f, { anchors }, f.close, conf, f.close);
      if (!g.valid) return base;
      g.entryPrice = f.close;
      base.previewGeometry = g;
      if (Object.keys(m).length) {
        const q = scoreQ(channel, m);
        if (q && Number.isFinite(q.value)) {
          base.previewQ = q;
          base.previewE = scoreE(g, 0, f, conf, market);
          base.previewS = round(q.value * 0.6 + base.previewE.value * 0.4, 1);
          base.previewZoneBestRR = zoneBestRR(g, conf);
        }
      }
    } catch (e) {}
    return base;
  }

  function applyRuleHooks(channel, s, f, cfg, market, code) {
    const rules = Array.isArray(globalThis.QuantRules)
      ? globalThis.QuantRules
      : [];
    s.appliedRules = [];
    for (const rule of rules) {
      if (!rule || typeof rule.id !== "string" || !rule.id) continue;
      const targets =
        Array.isArray(rule.appliesTo) && rule.appliesTo.length
          ? rule.appliesTo
          : Object.keys(CHANNELS);
      if (!targets.includes(channel)) continue;
      const ctx = {
        channel,
        code: code || null,
        market,
        config: cfg,
        metrics: s.metrics || {},
        geometry: s.geometry || null,
        features: f || null,
        Q: s.Q && Number.isFinite(s.Q.value) ? s.Q.value : null,
      };
      try {
        if (typeof rule.gates === "function") {
          const verdict = rule.gates(ctx);
          if (verdict !== true && verdict != null) {
            s.ruleGate =
              typeof verdict === "string" ? verdict : rule.id + " 否决";
            s.appliedRules.push(rule.id);
            return s;
          }
        }
        if (
          typeof rule.scoreAdjust === "function" &&
          s.Q &&
          Number.isFinite(s.Q.value)
        ) {
          const adj = Number(rule.scoreAdjust(s.Q.value, ctx));
          if (Number.isFinite(adj) && adj !== 0) {
            s.Q.value = round(clamp(s.Q.value + adj), 1);
            s.Q.ruleAdjust = round(adj, 1);
            s.appliedRules.push(rule.id);
          }
        }
      } catch (e) {
        s.ruleGate = rule.id + " 执行异常：" + e.message;
        s.appliedRules.push(rule.id);
        return s;
      }
    }
    return s;
  }
  function higherTimeframePressures(input, anchorPrice) {
    const bars = normalizeBars(input);
    if (bars.length < 45 || !(anchorPrice > 0)) return [];
    const weekKey = (date) => {
      const d = new Date(date + "T00:00:00Z"), shift = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - shift);
      return d.toISOString().slice(0, 10);
    };
    const aggregate = (keyFn, limit) => {
      const groups = [];
      for (const b of bars) {
        const key = keyFn(b.date);
        if (!groups.length || groups[groups.length - 1].key !== key)
          groups.push({ key, date: b.date, high: b.high });
        else {
          groups[groups.length - 1].date = b.date;
          groups[groups.length - 1].high = Math.max(groups[groups.length - 1].high, b.high);
        }
      }
      return groups.slice(0, -1).slice(-limit);
    };
    const out = [];
    for (const [period, groups] of [["周线", aggregate(weekKey, 52)], ["月线", aggregate((d) => d.slice(0, 7), 24)]]) {
      for (let i = 1; i < groups.length - 1; i++) {
        const g = groups[i];
        if (g.high >= groups[i - 1].high && g.high >= groups[i + 1].high && g.high > anchorPrice * 1.002)
          out.push({ price: g.high, period, date: g.key });
      }
    }
    out.sort((a, b) => a.price - b.price || (a.period === "月线" ? -1 : 1));
    return out.filter((x, i) => !i || Math.abs(x.price / out[i - 1].price - 1) > 0.001).slice(0, 5);
  }
  function netGeometry(channel, f, setup, price, cfg, triggerPrice = f.close) {
    const atr = f.atr,
      a = setup.anchors;
    let stop, target, zoneLo, zoneHi, anchorLabel;
    if (channel === "oversold") {
      stop = a.eventLow - atr * 0.8;
      zoneLo = triggerPrice - atr * 0.45;
      zoneHi = triggerPrice + atr * 0.25;
      target =
        f.prevHigh20 > triggerPrice
          ? f.prevHigh20
          : f.ma20[f.n - 1] > triggerPrice
            ? f.ma20[f.n - 1]
            : triggerPrice + 2 * atr;
      anchorLabel = "超跌低点";
    } else if (channel === "pullback") {
      stop = a.support - atr * 0.8;
      zoneLo = a.support - atr * 0.35;
      zoneHi = a.support + atr * 0.35;
      target =
        f.prevHigh20 > triggerPrice ? f.prevHigh20 : triggerPrice + 2 * atr;
      anchorLabel = a.supportSource;
    } else {
      stop = a.pressure - atr * 0.75;
      zoneLo = a.pressure;
      zoneHi = a.pressure + atr * cfg.breakoutZoneHiAtr;
      target = a.pressure + Math.max(a.baseRange, 2 * atr);
      anchorLabel = "突破压力";
    }
    const rawTarget = target,
      higherPressures = higherTimeframePressures(f.bars, triggerPrice),
      higherPressure = higherPressures.find((x) => x.price < target) || null;
    if (higherPressure) target = higherPressure.price;
    const slip = cfg.slippageBps / 10000,
      fee = cfg.feeBps / 20000,
      entry = price * (1 + slip + fee),
      targetExit = target * (1 - slip - fee),
      stopExit = stop * (1 - slip - fee),
      risk = entry - stopExit,
      reward = targetExit - entry,
      rr = risk > 0 ? reward / risk : null;
    return {
      stop,
      target,
      rawTarget,
      higherPressure,
      higherPressures,
      zoneLo,
      zoneHi,
      anchorLabel,
      netRR: rr,
      atrValue: atr,
      targetAtr: atr > 0 ? (target - price) / atr : null,
      stopAtr: atr > 0 ? (price - stop) / atr : null,
      grossUp: (target / price - 1) * 100,
      grossDown: (1 - stop / price) * 100,
      valid:
        stop > 0 &&
        stop < price &&
        target > price &&
        zoneHi >= zoneLo &&
        rr > 0,
    };
  }
  function zoneBestRR(g, cfg) {
    if (!g || !finite(g.zoneLo) || +g.zoneLo <= 0) return null;
    const z = repriceGeometry(g, +g.zoneLo, cfg);
    return z && Number.isFinite(z.netRR) ? z.netRR : null;
  }
  // v14.8：止损上限按通道分级（channelMaxStopAtr）——超跌锚定事件低点，天然宽于突破通道，
  // 2.5 ATR 一刀切会系统性错杀超跌信号；未传 channel 时回退全局 maxStopAtr。
  function executionRiskCheck(g, price, cfg, channel = null) {
    const c = { ...DEFAULTS, ...(cfg || {}) };
    if (!g || !finite(g.atrValue) || +g.atrValue <= 0)
      return { pass: true, unavailable: true, stopAtr: null, reason: null, maxAtr: c.maxStopAtr };
    const maxAtr =
        channel && c.channelMaxStopAtr && Number.isFinite(c.channelMaxStopAtr[channel])
          ? c.channelMaxStopAtr[channel]
          : c.maxStopAtr,
      stopAtr = (+price - +g.stop) / +g.atrValue;
    if (!Number.isFinite(stopAtr) || stopAtr <= 0)
      return { pass: false, stopAtr, reason: "止损不在入场价下方", maxAtr };
    if (stopAtr < c.minStopAtr)
      return { pass: false, stopAtr, reason: `止损过近：${round(stopAtr, 2)} ATR＜${round(c.minStopAtr, 1)} ATR，易被日常波动扫损`, maxAtr };
    if (stopAtr > maxAtr)
      return { pass: false, stopAtr, reason: `止损过宽：${round(stopAtr, 2)} ATR＞${round(maxAtr, 1)} ATR，不移动结构止损，放弃执行`, maxAtr };
    return { pass: true, stopAtr, reason: null, maxAtr };
  }
  function archiveReason(status, g, price) {
    if (status === "MODEL_ENTERED" || !g || !finite(price) || +price <= 0) return null;
    if (finite(g.stop) && +price <= +g.stop) return "止损已击穿";
    if (finite(g.target) && +price >= +g.target) return "目标已越过";
    return null;
  }
  function breakoutPreview(bars, cfg) {
    const c = { ...DEFAULTS, ...(cfg || {}) }, f = features(bars);
    if (!f || f.n < c.minBars) return null;
    const anchors = { pressure: f.baseHigh, baseLow: f.baseLow, baseRange: f.baseRange },
      requiredClose = f.baseHigh + f.atr * 0.05,
      geometry = netGeometry("breakout", f, { anchors }, requiredClose, c, requiredClose),
      bestRR = zoneBestRR(geometry, c),
      above = f.close > requiredClose,
      requiredVolume = f.volAvg20 * c.breakoutMinVolRatio,
      volumeOk = Number.isFinite(requiredVolume) && f.volume >= requiredVolume,
      priceOk = f.closePos >= 0.55,
      near = f.close >= f.baseHigh - f.atr * 0.6 && f.close <= f.baseHigh + f.atr * 1.5;
    return { pressure: f.baseHigh, atr: f.atr, requiredClose, requiredVolume,
      currentVolume: f.volume, closePos: f.closePos, above, volumeOk, priceOk, near,
      geometry, zoneBestRR: bestRR, prefiltered: !(Number.isFinite(bestRR) && bestRR >= channelMinRR("breakout", c)) || !executionRiskCheck(geometry, geometry.zoneLo, c).pass };
  }
  // v14.5：通道级净赔率门槛——优先级 channelMinRR[channel] > minRR。
  function channelMinRR(channel, cfg) {
    const override = (cfg.channelMinRR || {})[channel];
    if (!(Number.isFinite(override) && override > 0)) return cfg.minRR;
    // 语义：通道级下限是科学默认值；用户显式把全局 minRR 调得比出厂默认更高时，全局优先。
    return cfg.minRR > BUILTIN_DEFAULTS.minRR ? cfg.minRR : override;
  }
  function liquidity(f, market, cfg) {
    const threshold = market === "A" ? cfg.minAmountA : cfg.minAmountUS;
    if (f.amountAvg20 === null)
      return { pass: false, reason: "缺少成交额，无法验证流动性" };
    return f.amountAvg20 >= threshold
      ? { pass: true }
      : {
          pass: false,
          reason: `20日均成交额低于${market === "A" ? round(threshold / 1e4, 0) + "万" : round(threshold / 1e4, 0) + "万美元"}门槛`,
        };
  }
  function repriceGeometry(g, price, cfg) {
    const slip = cfg.slippageBps / 10000,
      fee = cfg.feeBps / 20000,
      entry = price * (1 + slip + fee),
      targetExit = g.target * (1 - slip - fee),
      stopExit = g.stop * (1 - slip - fee),
      risk = entry - stopExit,
      reward = targetExit - entry,
      rr = risk > 0 ? reward / risk : null;
    return {
      ...g,
      netRR: rr,
      targetAtr: g.atrValue > 0 ? (g.target - price) / g.atrValue : null,
      stopAtr: g.atrValue > 0 ? (price - g.stop) / g.atrValue : null,
      grossUp: (g.target / price - 1) * 100,
      grossDown: (1 - g.stop / price) * 100,
      entryPrice: price,
      valid:
        g.stop > 0 &&
        g.stop < price &&
        g.target > price &&
        g.zoneHi >= g.zoneLo &&
        rr > 0,
    };
  }
  function finalizeHistorical(channel, f, benchmark, cfg, market = "A", code = null) {
    if (!f || f.n < cfg.minBars) return null;
    const s = detect(channel, f, benchmark, cfg, market);
    if (s.stage !== 3) return s;
    s.geometry = netGeometry(channel, f, s, f.close, cfg);
    s.geometry.entryPrice = f.close;
    s.liquidity = liquidity(f, market, cfg);
    s.Q = s.Q || scoreQ(channel, s.metrics);
    applyRuleHooks(channel, s, f, cfg, market, code);
    if (s.Q) {
      s.E = scoreE(s.geometry, 0, f, cfg, market);
      s.S = round(s.Q.value * 0.6 + s.E.value * 0.4, 1);
    }
    return s;
  }
  function historicalSetup(channel, bars, benchmark, cfg, market = "A", code = null) {
    return finalizeHistorical(channel, features(bars), benchmark, cfg, market, code);
  }
  function tzInfo(date, tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", {
          timeZone: tz,
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false,
          weekday: "short",
        }).formatToParts(date),
        o = {};
      parts.forEach((x) => (o[x.type] = x.value));
      return {
        day: `${o.year}-${o.month}-${o.day}`,
        minute: (+o.hour % 24) * 60 + +o.minute,
        weekday: o.weekday,
      };
    } catch (e) {
      return {
        day: date.toISOString().slice(0, 10),
        minute: 0,
        weekday: "Sun",
      };
    }
  }
  function marketSession(market, now = new Date()) {
    const z = tzInfo(
      now,
      market === "A" ? "Asia/Shanghai" : "America/New_York",
    );
    if (["Sat", "Sun"].includes(z.weekday)) return { state: "CLOSED", ...z };
    const m = z.minute;
    if (market === "A") {
      if ((m >= 570 && m < 690) || (m >= 780 && m < 900))
        return { state: "REGULAR", ...z };
      if (m >= 690 && m < 780) return { state: "MIDDAY", ...z };
      if (m >= 900 && m < 960) return { state: "POST", ...z };
      return { state: m < 570 ? "PRE" : "CLOSED", ...z };
    }
    if (m >= 570 && m < 960) return { state: "REGULAR", ...z };
    return { state: m < 570 ? "PRE" : "POST", ...z };
  }
  function arbitrateBenchmarkDate(o) {
    const candidates = (o.candidates || []).filter((x) => x && x.date).slice().sort((a, b) => b.date.localeCompare(a.date)),
      chosen = candidates[0] || null, quoteDay = o.quoteDay || null,
      session = marketSession(o.market, o.now || new Date());
    if (!chosen) return { chosen: null, expectedDate: null, error: "无可用基准完成日", warning: null };
    const result = { chosen, expectedDate: chosen.date, error: null, warning: null },
      dates = new Set(candidates.map((x) => x.date));
    if (quoteDay && chosen.date > quoteDay)
      result.error = `基准完成日 ${chosen.date} 晚于报价交易日 ${quoteDay}，日期冲突无法裁决`;
    const needsSameDay = !["REGULAR", "MIDDAY", "PRE"].includes(session.state);
    if (!result.error && quoteDay && needsSameDay && chosen.date < quoteDay)
      result.error = `市场级日K陈旧：最新完成日 ${chosen.date}，报价交易日 ${quoteDay}`;
    if (!result.error && dates.size > 1 && !quoteDay)
      result.error = "多源基准日期不一致且缺少报价时间，无法独立裁决";
    if (!result.error && dates.size > 1)
      result.warning = `多源日期不一致，已按报价日 ${quoteDay} 选择 ${chosen.source} ${chosen.date}`;
    if (!quoteDay && !result.error)
      result.warning = "缺少基准报价时间佐证；仅因多源完成日一致而暂时采用";
    return result;
  }
  function sessionElapsedMinutes(market, z) {
    const m = z.minute;
    if (market === "A") {
      if (m < 570) return 0;
      if (m <= 690) return m - 570;
      if (m < 780) return 120;
      return Math.min(240, 120 + m - 780);
    }
    return Math.max(0, Math.min(390, m - 570));
  }
  function intradayPlanKey(o, quoteDay) {
    const p = o.primary || {};
    return [o.code || "unknown", p.channel || "none", p.triggerDate || "none", quoteDay || "none"].join("|");
  }

  function intradayAdvice(o) {
    const cfg = { ...DEFAULTS, ...(o.config || {}) },
      now = o.now || new Date(), market = o.market || "A",
      session = marketSession(market, now),
      zone = market === "A" ? "Asia/Shanghai" : "America/New_York",
      z = tzInfo(now, zone),
      validPositive = (x) => x !== null && x !== undefined && x !== "" && finite(x) && +x > 0;
    let quote = o.quote || {},
      price = validPositive(quote.price) ? +quote.price : null,
      quoteDay = quote.qtime ? tzInfo(new Date(quote.qtime), zone).day : null;
    const p = o.primary,
      planKey = intradayPlanKey(o, quoteDay),
      baseChecks = [];
    const gateProgress = () => {
      const list = baseChecks.slice(),
        passed = list.filter((x) => x.pass).length;
      return { passed, total: list.length, failed: list.filter((x) => !x.pass).map((x) => x.label) };
    },
    out = (state, title, detail, tone = "neutral", extra = {}) => ({
      state, title, detail, tone, live: session.state === "REGULAR", actionable: false,
      quoteDay, planKey, executionModel: INTRADAY_MODEL, checks: baseChecks.slice(),
      gateProgress: gateProgress(), ...extra,
    });
    const check = (key, label, pass, detail) => {
      const row = { key, label, pass: pass === true, detail };
      baseChecks.push(row);
      return row;
    };
    if (o.status === "DATA_ERROR")
      return out("DATA_ERROR", "不操作｜日线数据异常", o.statusText || "先修复数据，再评估盘中动作", "danger");
    if (o.status === "UNSUPPORTED")
      return out("UNSUPPORTED", "不适用｜无盘中模型指令", o.statusText || "该标的不生成隔夜或盘中候选", "neutral");
    if ((!price || price <= 0) && !(session.state !== "REGULAR" && validPositive(o.simPrice)))
      return out("DATA_ERROR", "不操作｜缺少有效报价", "报价为空或非法，不能用旧价推断盘中动作", "danger");
    if (!p || p.stage !== 3)
      return out("NO_PLAN", "无日线预案｜不因上涨追入", "盘中价格只执行已有预案，不会反向创造日线 Q 或通道触发", "neutral");
    const g = p.triggerGeometry || p.geometry;
    if (!g || !g.valid)
      return out("INVALID", "不操作｜冻结几何非法", "入场区、止损或目标缺失，盘中不得临时补造", "danger");
    if (o.status === "ARCHIVED")
      return out("ARCHIVED", "已归档｜不再执行", o.statusText || "目标或止损已越过，旧预案退出当前执行队列", "neutral");
    if (p.channel === "pullback")
      return out("RESEARCH_ONLY", "只研究｜趋势回踩仍是影子通道", "盘中执行升级不恢复该通道的操作资格", "neutral");
    const hardReasons = (p.reasons || []).filter((x) => !String(x).includes("净赔率"));
    if (["MANUAL_REVIEW", "UNTRADABLE"].includes(o.status) || (o.status === "REJECTED" && hardReasons.length))
      return out("BLOCKED", "不操作｜日线硬门槛优先", hardReasons[0] || o.statusText || "当前状态不允许盘中入场", "warn");
    if (o.status === "EXPIRED" && p.expiredReason === "结构失效")
      return out("INVALIDATED", "信号失效｜不复活旧预案", "结构锚点已经失效；开盘与盘中两个执行模型均不再入场", "danger");
    if (o.status === "RESEARCH_ONLY" && hardReasons.length)
      return out("BLOCKED", "只研究｜日线硬门槛未通过", hardReasons[0], "warn");
    const simulated = session.state !== "REGULAR";
    if (simulated && !validPositive(o.simPrice)) {
      const title = session.state === "PRE" ? "盘前仅预案｜不提前挂单" : session.state === "MIDDAY" ? "午间休市｜不生成实时指令" : "非盘中｜未触发预案当日作废";
      return out("NON_SESSION", title, `冻结入场区 ${round(g.zoneLo, 4)}～${round(g.zoneHi, 4)}；无最近收盘模拟数据，七门不计算；连续竞价后重新通过七门确认。`, "neutral", { stop: g.stop, target: g.target });
    }
    if (simulated) {
      quote = {
        price: +o.simPrice,
        qtime: now.getTime(),
        amount: validPositive(o.simAmount) ? +o.simAmount : null,
        high: validPositive(o.simHigh) ? +o.simHigh : +o.simPrice,
        low: validPositive(o.simLow) ? +o.simLow : +o.simPrice,
        open: validPositive(o.simOpen) ? +o.simOpen : null,
        prevClose: validPositive(o.simPrevClose) ? +o.simPrevClose : null,
        source: "收盘模拟",
      };
      price = +o.simPrice;
      quoteDay = /^\d{4}-\d{2}-\d{2}$/.test(o.simDate || "") ? o.simDate : z.day;
    }
    if (!quote.qtime)
      return out("DATA_ERROR", "不操作｜报价时间缺失", "盘中缺少可核验报价时间，禁止把延迟报价当实时行情", "danger");
    const age = now.getTime() - Number(quote.qtime);
    if ((!simulated && (quoteDay !== z.day || age < -5 * 60e3)) || quoteDay < p.triggerDate)
      return out("DATA_ERROR", "不操作｜报价日期异常",
        quoteDay < p.triggerDate
          ? `行情日 ${quoteDay || "—"} 早于触发日 ${p.triggerDate}，存在数据错位`
          : `行情日 ${quoteDay || "—"} 与本地交易日 ${z.day} 不一致`, "danger");
    // v14.3：报价新鲜度按市场分设阈值——美股免费行情延迟普遍>180秒，
    // 共用 A股阈值会使美股盘中七门恒为 STALE、盘中执行名存实亡。
    const quoteMaxAgeSec = market === "US"
      ? (cfg.intradayQuoteMaxAgeSecUS ?? cfg.intradayQuoteMaxAgeSec)
      : cfg.intradayQuoteMaxAgeSec;
    if (age > quoteMaxAgeSec * 1000)
      return out("STALE", "不操作｜可执行报价已陈旧", `报价已 ${Math.floor(age / 60e3)} 分钟未更新；超过 ${quoteMaxAgeSec} 秒执行阈值（美股独立阈值），只保留观察`, "danger");
    if (o.status === "MODEL_ENTERED") {
      const sameDayA = market === "A" && p.entryDate === quoteDay ? "；A股入场当日不可卖，仅记录风险，不假定可成交" : "";
      if (price <= g.stop)
        return out("RISK_STOP", "风险优先｜开盘模型触及止损", `现价 ${round(price, 4)} ≤ 冻结止损 ${round(g.stop, 4)}${sameDayA}；不代表你的实际持仓`, "danger");
      if (price >= g.target)
        return out("RISK_TARGET", "目标触及｜复核开盘模型退出", `现价 ${round(price, 4)} ≥ 冻结目标 ${round(g.target, 4)}${sameDayA}；不追加仓位`, "ok");
      return out("MODEL_MONITOR", "开盘模型监控中｜不追加、不新开", `现价 ${round(price, 4)}；止损 ${round(g.stop, 4)}，目标 ${round(g.target, 4)}。盘中执行模型不重复入场`, "neutral");
    }
    const maxAge = 2;
    if (!Number.isFinite(p.age) || p.age > maxAge)
      return out("EXPIRED", "盘中窗口结束｜不沿用旧价位", `盘中七门只在信号年龄 ≤${maxAge} 个交易日内开放；当前信号年龄 ${p.age ?? "—"}`, "neutral");
    if (p.liquidity && p.liquidity.pass === false)
      return out("BLOCKED", "不操作｜日线流动性门槛未通过", p.liquidity.reason || "成交额不足，不能由盘中报价抵消", "warn");

    const current = repriceGeometry(g, price, cfg), rr = current.netRR,
      rrFloor = channelMinRR(p.channel, cfg),
      zoneDrift = Number.isFinite(p.age) && p.age >= 1 ? 0.01 : 0,
      zoneLoEff = g.zoneLo * (1 - zoneDrift),
      zoneHiEff = g.zoneHi * (1 + zoneDrift),
      driftNote = zoneDrift ? `（信号${p.age}日，放宽至冻结区±1%：${round(zoneLoEff, 4)}～${round(zoneHiEff, 4)}）` : "",
      inZone = price >= zoneLoEff && price <= zoneHiEff,
      structurePass = price > g.stop && !(validPositive(quote.low) && +quote.low <= g.stop),
      rrPass = Number.isFinite(rr) && rr >= rrFloor,
      riskCheck = executionRiskCheck(g, price, cfg, p.channel),
      // v14.3：严格使用行情源昨收；缺失时跳过涨停可成交检查，不回退冻结 triggerPrice——
      // 冻结价可能陈旧数日，用它判断"接近涨停"会把正常价位误判为不可成交。
      prevClose = validPositive(quote.prevClose) ? +quote.prevClose : null,
      limitPct = market === "A" ? priceLimit(o.code || "", o.name || "") : null,
      nearLimitUp = market === "A" && limitPct && prevClose !== null &&
        price / prevClose - 1 >= (limitPct - 0.2) / 100 && validPositive(quote.high) && price >= +quote.high,
      tradablePass = !nearLimitUp && (quote.amount === null || quote.amount === undefined || (finite(quote.amount) && +quote.amount > 0)),
      quoteZ = quote.qtime ? tzInfo(new Date(quote.qtime), zone) : z,
      totalMinutes = market === "A" ? 240 : 390,
      elapsed = simulated ? totalMinutes : sessionElapsedMinutes(market, quoteZ),
      averageAmount20 = validPositive(o.averageAmount20) ? +o.averageAmount20 : null,
      dayFrac = Math.max(1, elapsed) / totalMinutes,
      volumePace = averageAmount20 && finite(quote.amount) && quote.amount !== null && quote.amount !== undefined && elapsed > 0
        ? +quote.amount / (averageAmount20 * Math.min(1, dayFrac + 0.13 * Math.sin(Math.PI * dayFrac))) : null,
      volumePass = Number.isFinite(volumePace) && volumePace >= cfg.intradayMinVolumePace;
    check("structure", "结构有效", structurePass, structurePass ? "现价与日内低点未触及冻结止损" : "日内已触及冻结失效锚点");
    check("zone", "价格在冻结入场区", inZone, `${round(price, 4)} / ${round(zoneLoEff, 4)}～${round(zoneHiEff, 4)}${driftNote}`);
    check("rr", "成本后净赔率", rrPass, `${Number.isFinite(rr) ? round(rr, 2) : "—"}∶1 / 门槛 ${round(rrFloor, 1)}∶1`);
    check("riskDistance", "止损距离", riskCheck.pass, riskCheck.reason || (riskCheck.unavailable ? "旧档案缺少ATR，沿用原几何" : `${round(riskCheck.stopAtr, 2)} ATR / 允许 ${round(cfg.minStopAtr, 1)}～${round(riskCheck.maxAtr ?? cfg.maxStopAtr, 1)} ATR`));
    check("tradable", "可成交性", tradablePass, nearLimitUp ? "接近涨停且位于日内高价，无法确认可成交" : "未发现当前报价级成交拦截");
    check("volume", "当日量能节奏", volumePass, Number.isFinite(volumePace) ? `${round(volumePace, 2)}× / 初始门槛 ${round(cfg.intradayMinVolumePace, 2)}×` : "缺少成交额、20日基准或有效交易时长");

    const rawSamples = Array.isArray(o.samples) ? o.samples.slice() : [],
      samples = rawSamples.filter((x) => x && finite(x.price) && +x.price > 0 && finite(x.qtime) &&
        tzInfo(new Date(+x.qtime), zone).day === quoteDay &&
        +x.qtime >= now.getTime() - (cfg.intradaySampleMaxAgeSec || 3600) * 1000 &&
        +x.qtime <= now.getTime() + 5 * 60e3)
        .sort((a, b) => +a.qtime - +b.qtime),
      required = Math.max(2, Math.round(cfg.intradayConfirmSamples)),
      tail = samples.slice(-required),
      spaced = tail.length === required && tail[tail.length - 1].qtime - tail[0].qtime >= cfg.intradayMinSampleGapSec * 1000 &&
        tail[tail.length - 1].qtime - tail[0].qtime <= cfg.intradayConfirmWindowSec * 1000,
      heldZone = tail.length === required && tail.every((x) => +x.price >= zoneLoEff && +x.price <= zoneHiEff && +x.price > g.stop),
      notWeakening = tail.length === required && +tail[tail.length - 1].price >= +tail[0].price,
      testedLow = p.channel !== "oversold" || (validPositive(quote.low) && +quote.low <= zoneLoEff) ||
        samples.some((x) => (validPositive(x.low) && +x.low <= zoneLoEff) || +x.price < zoneLoEff),
      confirmPass = spaced && heldZone && notWeakening && testedLow,
      confirmDetail = `${Math.min(tail.length, required)}/${required} 次连续区内报价｜间隔${spaced ? "✓" : "✗"} ${cfg.intradayMinSampleGapSec}～${cfg.intradayConfirmWindowSec}秒｜区内持有${heldZone ? "✓" : "✗"}｜未走弱${notWeakening ? "✓" : "✗"}${p.channel === "oversold" ? `｜测试下沿后收复${testedLow ? "✓" : "✗"}` : ""}`;
    check("confirmation", "盘中连续确认", confirmPass, confirmDetail);

    const common = { netRR: rr, stop: g.stop, target: g.target, zoneLo: g.zoneLo, zoneHi: g.zoneHi,
      volumePace, confirmation: { count: Math.min(tail.length, required), required, spaced, heldZone, notWeakening, testedLow },
      suggestedLimit: g.zoneHi, validOnlyToday: true, simulated };
    if (!structurePass)
      return out("INVALIDATED", "结构风险｜放弃盘中入场", `现价或日内低点已触及冻结失效锚点 ${round(g.stop, 4)}；今日不复活该预案`, "danger", common);
    if (price < zoneLoEff)
      return out("WAIT_ZONE", p.channel === "oversold" ? "等待收复｜暂不接刀" : "等待回到突破区｜不提前买", `现价 ${round(price, 4)}＜${round(zoneLoEff, 4)}${driftNote}；不向下移动入场区`, "warn", common);
    if (price > zoneHiEff)
      return out("WAIT_ZONE", "高于入场区｜不追价", `现价 ${round(price, 4)}＞${round(zoneHiEff, 4)}${driftNote}；冻结入场区不随盘中上涨上移`, "warn", common);
    if (!riskCheck.pass)
      return out("RISK_DISTANCE", "止损距离不合格｜不开仓", riskCheck.reason, "warn", common);
    if (!rrPass)
      return out("WAIT_RR", "净赔率不足｜不开仓", `按现价与冻结止损、目标重算为 ${Number.isFinite(rr) ? round(rr, 2) : "—"}∶1，低于 ${round(rrFloor, 1)}∶1`, "warn", common);
    if (!tradablePass)
      return out("UNTRADABLE", "可成交性不足｜不下单", nearLimitUp ? "现价接近涨停且处于日内高位，不能把可看见价格当作可成交价格" : "当日成交额无效，无法确认成交状态", "warn", common);
    if (!volumePass)
      return out("WAIT_VOLUME", "量能节奏未确认｜继续等待", Number.isFinite(volumePace) ? `当前量能节奏 ${round(volumePace, 2)}×，低于 ${round(cfg.intradayMinVolumePace, 2)}×；这是 Intraday v1 待验证参数` : "缺少可核验成交额或20日基准，禁止用价格上涨替代量能确认", "warn", common);
    if (!confirmPass)
      return out("CONFIRMING", "确认中｜等待连续有效报价", confirmDetail + "；手动重复刷新且报价时间未推进不算新样本", "neutral", common);
    if (simulated)
      return out("SIMULATED", "收盘模拟七门通过｜非盘中不下单", `按最近完成日K收盘 ${round(price, 4)} 模拟：净赔率 ${round(rr, 2)}∶1，止损 ${round(g.stop, 4)}，目标 ${round(g.target, 4)}。仅反映收盘时点的理论状态；实际执行须待连续竞价重新通过七门确认。`, "ok", { ...common, actionable: false });
    return out("ACTIONABLE", "七门通过｜人工限价评估", `现价 ${round(price, 4)}；限价不高于 ${round(g.zoneHi, 4)}，止损 ${round(g.stop, 4)}，目标 ${round(g.target, 4)}，净赔率 ${round(rr, 2)}∶1。仅当日有效；仓位=风险预算÷止损幅度，环境／事件与账户红线另核`, "ok", { ...common, actionable: true });
  }
  /* v14.0 盘中触发型超跌反弹：把当前报价合成当日虚拟K线，对阶段①/②的超跌结构实时探测；
     触发即冻结几何（当日有效），执行前仍走同一套七门；收盘后由 journal 层验票。 */
  function intradayOversoldPlan(bars, quote, cfg, market, now = new Date()) {
    const c = { ...DEFAULTS, ...(cfg || {}) };
    if (!Array.isArray(bars) || bars.length < c.minBars) return null;
    if (!quote || !finite(quote.price) || +quote.price <= 0 || !finite(quote.qtime)) return null;
    if (marketSession(market, now).state !== "REGULAR") return null;
    const zone = market === "A" ? "Asia/Shanghai" : "America/New_York",
      quoteDay = tzInfo(new Date(+quote.qtime), zone).day;
    if (quoteDay !== tzInfo(now, zone).day) return null;
    const completed = completedBars(bars, market, now);
    if (!completed.length || last(completed).date >= quoteDay) return null;
    const probe = detectImpl("oversold", features(completed), null, c);
    if (!probe || probe.stage < 1 || probe.stage === 3) return null;
    const price = +quote.price,
      vb = {
        date: quoteDay,
        open: finite(quote.open) && +quote.open > 0 ? +quote.open : price,
        high: Math.max(finite(quote.high) ? +quote.high : price, price),
        low: Math.min(finite(quote.low) && +quote.low > 0 ? +quote.low : price, price),
        close: price,
        // v14.1 修复：A股报价量为"手"、日K量为"股"，虚拟K线须×100——否则量能萎缩100倍，
        // volContraction 恒真（企稳质量分虚增+30）、volRatio 失真，污染盘中触发的 Q 评分。
        volume: finite(quote.volume) ? +quote.volume * (market === "A" ? 100 : 1) : 0,
        amount: finite(quote.amount) ? +quote.amount : null,
      },
      f = features(completed.concat([vb])),
      s = detectImpl("oversold", f, null, c);
    if (!s || s.stage !== 3 || !s.Q) return null;
    const geometry = netGeometry("oversold", f, s, price, c, price);
    geometry.entryPrice = price;
    if (!geometry.valid) return null;
    return {
      channel: "oversold",
      name: CHANNELS.oversold.name,
      triggerDate: quoteDay,
      geometry,
      Q: s.Q,
      metrics: s.metrics,
      evidence: s.evidence,
    };
  }
  function signalLifecycle(o) {
    const market = o.market,
      now = o.now || new Date(),
      session = marketSession(market, now),
      zone = market === "A" ? "Asia/Shanghai" : "America/New_York",
      z = tzInfo(now, zone),
      quote = o.quote || {},
      maxAttempts = Math.max(1, CHANNELS[o.channel].maxAge - 1),
      completed = normalizeBars(o.bars)
        .filter((b) => b.date > o.triggerDate)
        .slice(0, maxAttempts)
        .map((b) => ({ ...b, completed: true })),
      entryBars = completed.slice(),
      quoteDay = quote.qtime ? tzInfo(new Date(quote.qtime), zone).day : null,
      isFutureSession = z.day > o.triggerDate,
      liveExpected = isFutureSession && quoteDay === z.day && z.minute >= 570 && session.state !== "PRE",
      hasToday = entryBars.some((b) => b.date === z.day),
      activeNeedsOpen = isFutureSession && ["REGULAR", "MIDDAY"].includes(session.state) && !hasToday;
    if (isFutureSession && (liveExpected || activeNeedsOpen) && !hasToday) {
      if (!finite(quote.open) || +quote.open <= 0)
        return {
          status: "DATA_ERROR",
          statusText: "数据异常·开盘窗口待确认",
          note: "当日已经开盘，但缺少可核验的当日开盘价，无法判断剩余执行窗口。",
          attempts: [], usedAttempts: 0, remainingAttempts: null, maxAttempts,
          horizon: "UNKNOWN",
        };
      entryBars.push({
        date: z.day,
        open: +quote.open,
        high: finite(quote.high) ? +quote.high : +quote.open,
        low: finite(quote.low) ? +quote.low : +quote.open,
        close: null,
        completed: false,
      });
    }
    const attempts = [],
      signal = { geometry: o.geometry, signalClose: o.signalClose, limitPct: o.limitPct, channel: o.channel };
    for (let i = 0; i < Math.min(maxAttempts, entryBars.length); i++) {
      const bar = entryBars[i],
        barBroken = bar.completed
          ? Number.isFinite(bar.close) && bar.close <= o.geometry.stop
          : finite(quote.low) && +quote.low <= o.geometry.stop;
      if (barBroken) {
        attempts.push({
          date: bar.date,
          open: bar.open,
          status: "SKIP",
          reason: bar.completed ? "该完成日K收盘触及失效锚点" : "盘中低点触及失效锚点",
          completed: !!bar.completed,
        });
        return {
          status: "EXPIRED", statusText: "已失效·结构失效",
          note: bar.completed
            ? "该完成日K收盘已触及失效锚点：不在破位日开盘补入场，取消全部剩余窗口。"
            : "盘中低点已触及冻结失效锚点：开盘与盘中两个执行模型均不再入场。",
          attempts, usedAttempts: i + 1, remainingAttempts: Math.max(0, maxAttempts - i - 1), maxAttempts,
          horizon: "CLOSED", expiredReason: "结构失效",
        };
      }
      const decision = openingDecision(signal, entryBars[i], market, o.config);
      attempts.push({
        date: entryBars[i].date,
        open: entryBars[i].open,
        status: decision.status,
        reason: decision.reason || "开盘条件满足",
        completed: entryBars[i].completed,
      });
      if (decision.status === "ENTER")
        return {
          status: "MODEL_ENTERED", statusText: "开盘已触发·模型待结算",
          note: `模型在 ${entryBars[i].date} 以开盘价 ${round(entryBars[i].open)} 满足入场条件；不代表用户实际成交，后续由前向记录结算。`,
          attempts, usedAttempts: i + 1, remainingAttempts: 0, maxAttempts,
          horizon: "OPENED", entryDate: entryBars[i].date,
          entryPrice: entryBars[i].open, entryGeometry: decision.entryGeometry,
        };
    }
    const used = attempts.length,
      remaining = Math.max(0, maxAttempts - used),
      structureBroken = completed.some((b) => b.close <= o.geometry.stop) ||
        (finite(quote.price) && +quote.price <= o.geometry.stop) ||
        (session.state === "REGULAR" && finite(quote.low) && +quote.low <= o.geometry.stop);
    if (structureBroken)
      return {
        status: "EXPIRED", statusText: "已失效·结构失效",
        note: "等待期间触及失效锚点，取消后续开盘窗口。",
        attempts, usedAttempts: used, remainingAttempts: Math.max(0, maxAttempts - used), maxAttempts,
        horizon: "CLOSED", expiredReason: "结构失效",
      };
    if (used >= maxAttempts)
      return {
        status: "EXPIRED", statusText: "已失效·窗口耗尽",
        note: `${maxAttempts} 次开盘窗口均已检查且未满足入场条件；不再以盘中回区延续信号。`,
        attempts, usedAttempts: used, remainingAttempts: 0, maxAttempts,
        horizon: "CLOSED", expiredReason: "窗口耗尽",
      };
    const first = used === 0,
      todayOpen = first && session.state === "PRE",
      status = first ? "NEXT_SESSION_PLAN" : "WAIT_ENTRY",
      statusText = first
        ? `${todayOpen ? "今日开盘预案" : "下次开盘预案"}·余${remaining}次`
        : `等待下次开盘·余${remaining}次`,
      lastReason = attempts.length ? attempts[attempts.length - 1].reason : null;
    return {
      status, statusText,
      note: first
        ? `尚未进行首次开盘检查；共 ${maxAttempts} 次窗口，开盘须在入场区且净赔率、可成交性达标。盘中回区不替代开盘条件。`
        : `已检查 ${used} 次开盘，剩余 ${remaining} 次；最近未入场原因：${lastReason}。盘中回区不替代下一次开盘检查。`,
      attempts, usedAttempts: used, remainingAttempts: remaining, maxAttempts,
      horizon: todayOpen ? "TODAY_OPEN" : "NEXT_SESSION",
    };
  }

  function completedBars(input, market, now) {
    const b = normalizeBars(input),
      z = tzInfo(now, market === "A" ? "Asia/Shanghai" : "America/New_York");
    if (!b.length) return b;
    const session = marketSession(market, now);
    const incomplete =
      last(b).date === z.day &&
      (market === "A"
        ? ["PRE", "REGULAR", "MIDDAY"].includes(session.state)
        : session.state !== "POST");
    return incomplete ? b.slice(0, -1) : b;
  }
  function latestCompletedDate(input, market, now) {
    const b = completedBars(input, market, now);
    return b.length ? last(b).date : null;
  }
  function dataQuality(code, bars, quote, market, now, cfg, expectedDate = null) {
    const errors = [],
      warnings = [];
    if (bars.length < cfg.minBars) errors.push(`有效日K不足${cfg.minBars}根`);
    if (bars.length) {
      for (let i = Math.max(1, bars.length - 30); i < bars.length; i++) {
        const r = bars[i].close / bars[i - 1].close - 1;
        if (!Number.isFinite(r) || Math.abs(r) > 1)
          errors.push("近30根K线存在异常跳变");
        const gap =
          (Date.parse(bars[i].date) - Date.parse(bars[i - 1].date)) / 864e5;
        if (gap > 35) errors.push("近期K线存在超过35天的断档");
      }
      const actualDate = last(bars).date,
        age = (now - Date.parse(actualDate + "T12:00:00Z")) / 864e5;
      if (age > 14) errors.push("最新完成日K陈旧");
      if (expectedDate && actualDate !== expectedDate)
        errors.push(`K线交易日不一致：实际 ${actualDate}，市场基准 ${expectedDate}`);
    }
    if (!quote || !finite(quote.price) || quote.price <= 0)
      errors.push("缺少有效现价");
    else {
      if (quote.conflict) errors.push(quote.error || "双源报价冲突");
      if (bars.length && Math.abs(quote.price / last(bars).close - 1) > 0.3)
        errors.push("现价与最近完成日K偏离超过30%");
    }
    const session = marketSession(market, now);
    if (
      session.state === "REGULAR" &&
      quote &&
      quote.qtime &&
      now - quote.qtime > 20 * 60e3
    )
      errors.push("交易时段报价超过20分钟未更新");
    return { pass: !errors.length, errors: [...new Set(errors)], warnings };
  }
  function priceLimit(code, name) {
    if (code.startsWith("bj")) return 30;
    if (/^(sz300|sz301|sh688|sh689)/.test(code)) return 20;
    if (/ST/i.test(name || "")) return 5;
    return 10;
  }
  function scoreE(g, age, f, cfg, market) {
    const rr = clamp(((g.netRR - 1) / 2) * 100),
      mid = (g.zoneLo + g.zoneHi) / 2,
      half = Math.max((g.zoneHi - g.zoneLo) / 2, f.atr * 0.05),
      entry = clamp(100 - (Math.abs(g.entryPrice - mid) / half) * 45),
      threshold = market === "A" ? cfg.minAmountA : cfg.minAmountUS,
      liq =
        f.amountAvg20 === null
          ? 0
          : clamp(
              (Math.log10(Math.max(1, f.amountAvg20 / threshold)) /
                Math.log10(20)) *
                80 +
                20,
            ),
      fresh = age === 0 ? 100 : age === 1 ? 75 : 50;
    return {
      value: round(rr * 0.35 + entry * 0.25 + liq * 0.2 + fresh * 0.2, 1),
      dims: {
        交易赔率: round(rr, 1),
        入场质量: round(entry, 1),
        流动性与摩擦: round(liq, 1),
        触发新鲜度: fresh,
      },
    };
  }
  function analyzeSymbol(o) {
    const cfg = { ...DEFAULTS, ...(o.config || {}) },
      market = o.market || (o.code.startsWith("us") ? "US" : "A"),
      now = o.now || new Date(),
      bars = completedBars(o.bars, market, now),
      expectedBarsDate = latestCompletedDate(o.benchmarkBars, market, now),
      quality = dataQuality(o.code, bars, o.quote, market, now, cfg, expectedBarsDate),
      base = {
        code: o.code,
        name: o.name || o.code,
        market,
        price: o.quote && +o.quote.price,
        pct: o.quote && finite(o.quote.pct) ? +o.quote.pct : null,
        quoteTime: (o.quote && o.quote.qtime) || null,
        barsDate: bars.length ? last(bars).date : null,
        expectedBarsDate,
        averageAmount20: mean(bars.slice(-20).map((b) => b.amount).filter((x) => Number.isFinite(x) && x > 0)),
        source: (o.quote && o.quote.source) || "—",
        quality,
        session: marketSession(market, now),
        channels: [],
        primary: null,
      };
    if (o.isIndex) {
      base.status = "INDEX_ONLY";
      base.statusText = "指数仅作参考";
      return base;
    }
    if (DAILY_EXCLUDED.has(o.code)) {
      base.status = "UNSUPPORTED";
      base.statusText = "杠杆/反向ETF不生成隔夜日线候选";
      return base;
    }
    if (!quality.pass) {
      base.status = "DATA_ERROR";
      base.statusText = quality.errors[0];
      return base;
    }
    // v14.3：与回放层同口径——共享特征 + 增量 featureAt。此前每个通道×每个信号年龄
    // 都全量重算 features()（最多 9 次 O(n)），全A深扫时这是主要耗时点。
    const shared = featureShared(bars),
      f = featureAt(bars, shared, bars.length - 1),
      liq = liquidity(f, market, cfg);
    for (const channel of Object.keys(CHANNELS)) {
      const maxAge = CHANNELS[channel].maxAge,
        evals = [];
      for (let age = maxAge - 1; age >= 0; age--) {
        const end = bars.length - age,
          bb = benchmarkSlice(o.benchmarkBars, bars[end - 1].date),
          fa = age === 0 ? f : featureAt(bars.slice(0, end), shared, end - 1),
          s = finalizeHistorical(channel, fa, bb, cfg, market, o.code);
        if (s) evals.push({ age, s });
      }
      const triggered = evals.filter((x) => x.s.stage === 3);
      const observation = evals.length
        ? evals[evals.length - 1].s
        : detect(channel, f, benchmarkSlice(o.benchmarkBars, f.date), cfg, market);
      if (!triggered.length) {
        base.channels.push({ ...observation, status: "OBSERVING" });
        continue;
      }
      let pick = triggered[triggered.length - 1];
      for (let j = evals.indexOf(pick) - 1; j >= 0; j--) {
        if (evals[j].s.stage === 3) pick = evals[j];
        else break;
      }
      const age = pick.age,
        s = pick.s,
        triggerDate = bars[bars.length - 1 - age].date,
        triggerClose = bars[bars.length - 1 - age].close,
        triggerGeometry = s.geometry,
        g = repriceGeometry(triggerGeometry, base.price, cfg),
        bestZoneRR = zoneBestRR(triggerGeometry, cfg),
        zoneRiskCheck = channel === "pullback" ? { pass: true } : executionRiskCheck(triggerGeometry, triggerGeometry.zoneLo, cfg, channel),
        rrPrefail = !(Number.isFinite(bestZoneRR) && bestZoneRR >= channelMinRR(channel, cfg)),
        prefiltered = channel !== "pullback" && (rrPrefail || !zoneRiskCheck.pass),
        limitPct = market === "A" ? priceLimit(o.code, o.name) : null,
        reasons = [];
      g.triggerPrice = triggerClose;
      if (!liq.pass) reasons.push(liq.reason);
      if (!g.valid) reasons.push("当前止损、目标或入场几何非法");
      if (g.netRR < 1) reasons.push("当前成本后净赔率低于1");
      const lifecycle = signalLifecycle({
        channel, triggerDate, geometry: triggerGeometry, signalClose: triggerClose,
        limitPct, bars, quote: o.quote, market, now, config: cfg,
      });
      let status = lifecycle.status,
        statusText = lifecycle.statusText,
        executionNote = lifecycle.note;
      if (s.ruleGate) {
        reasons.push("规则否决：" + s.ruleGate);
        if (["NEXT_SESSION_PLAN", "WAIT_ENTRY"].includes(status)) {
          status = "REJECTED";
          statusText = statusLabel(status);
          executionNote =
            "规则否决：" + s.ruleGate + "；与研究记录一并保留，不由高分或价格抵消。";
        } else {
          executionNote =
            (executionNote ? executionNote + " " : "") +
            "规则否决：" +
            s.ruleGate;
        }
      }

      const archived = archiveReason(status, triggerGeometry, base.price);
      if (archived) {
        status = "ARCHIVED";
        statusText = `已归档·${archived}`;
        executionNote = "未入场旧信号的目标或止损已被价格越过，退出当前队列；历史记录与回放保留。";
      } else if (channel === "pullback") {
        status = "RESEARCH_ONLY";
        statusText = "影子通道·只研究不执行";
        executionNote = "v10.6 起趋势回踩仅保留回放与研究记录，不生成开盘或盘中操作候选；其他通道不受影响。";
      } else if (["NEXT_SESSION_PLAN", "WAIT_ENTRY"].includes(status)) {
        if (prefiltered) {
          status = "RESEARCH_ONLY";
          if (rrPrefail) {
            statusText = "预筛剔除·整区赔率不足";
            reasons.push(`冻结入场区最优净赔率 ${round(bestZoneRR, 2) ?? "—"}∶1＜${round(channelMinRR(channel, cfg), 1)}∶1`);
            executionNote = "整个冻结入场区均无法达到赔率门，默认退出信号台；研究与回放保留。";
          } else {
            statusText = "预筛剔除·止损距离不合格";
            reasons.push(`入场区下沿止损距离 ${round(zoneRiskCheck.stopAtr, 2)} ATR 不在允许区间 ${round(cfg.minStopAtr, 1)}～${round(cfg.maxStopAtr, 1)} ATR`);
            executionNote = "止损过近易被日常波动扫损或过宽风险失控，整个入场区均无法通过执行门槛，默认退出信号台；研究与回放保留。";
          }
        } else if (reasons.length) {
          status = g.netRR >= 1 && g.netRR < channelMinRR(channel, cfg) ? "RESEARCH_ONLY" : "REJECTED";
          statusText = statusLabel(status);
          executionNote = "当前未通过执行硬门槛；实际开盘仍须重新检查，不因高分放宽。";
        } else if (g.netRR < channelMinRR(channel, cfg)) {
          status = "RESEARCH_ONLY";
          statusText = statusLabel(status);
          executionNote = "当前成本后净赔率不足；实际开盘仍须重新检查，不能由高分抵消。";
        }
      }
      const inZone = base.price >= g.zoneLo && base.price <= g.zoneHi,
        E = scoreE(g, age, f, cfg, market),
        S = round(s.Q.value * 0.6 + E.value * 0.4, 1);
      base.channels.push({
        ...s,
        status,
        statusText,
        executionNote,
        executionHorizon: lifecycle.horizon,
        inEntryZone: inZone,
        attempts: lifecycle.attempts || [],
        usedAttempts: lifecycle.usedAttempts,
        remainingAttempts: lifecycle.remainingAttempts,
        maxAttempts: lifecycle.maxAttempts,
        expiredReason: lifecycle.expiredReason || null,
        entryDate: lifecycle.entryDate || null,
        entryPrice: lifecycle.entryPrice || null,
        modelEntryGeometry: lifecycle.entryGeometry || null,
        age,
        geometry: g,
        triggerGeometry,
        E,
        S,
        triggerQ: s.Q,
        triggerE: s.E,
        triggerS: s.S,
        reasons,
        triggerDate,
        firstTrigger: age === 0 && lifecycle.usedAttempts === 0,
        zoneBestRR: bestZoneRR,
        prefiltered,
        archiveReason: archived || null,
      });
    }
    const eligible = base.channels.filter((x) => x.status !== "OBSERVING");
    if (eligible.length) {
      const primaryRank = (x) =>
        x.prefiltered ? 7.5 : statusRank(x.status);
      eligible.sort(
        (a, b) =>
          primaryRank(a) - primaryRank(b) ||
          a.age - b.age ||
          (b.geometry.netRR || 0) - (a.geometry.netRR || 0) ||
          a.channel.localeCompare(b.channel),
      );
      base.primary = eligible[0];
      base.status = base.primary.status;
      base.statusText = base.primary.statusText || statusLabel(base.status);
      base.prefiltered = base.primary.status === "RESEARCH_ONLY" && String(base.primary.statusText || "").startsWith("预筛剔除");
      base.archiveReason = base.primary.archiveReason || null;
      const active = eligible.filter((x) =>
        ["NEXT_SESSION_PLAN", "WAIT_ENTRY", "MODEL_ENTERED"].includes(x.status),
      );
      if (
        active.some((x) => x.channel === "oversold") &&
        active.some((x) => x.channel === "breakout")
      ) {
        base.status = "MANUAL_REVIEW";
        base.statusText = "超跌与突破通道冲突，需人工研究";
      }
    } else {
      const obs = base.channels
        .slice()
        .sort(
          (a, b) => b.stage - a.stage || a.channel.localeCompare(b.channel),
        );
      base.primary = obs[0] || null;
      base.status = "OBSERVING";
      base.statusText =
        base.primary && base.primary.missing.length
          ? base.primary.missing[0]
          : "三通道均未形成";
    }
    base.alternates = base.primary
      ? base.channels.filter(
          (x) => x !== base.primary && x.status !== "OBSERVING",
        )
      : [];
    return base;
  }
  function benchmarkSlice(b, date) {
    return asNormalized(b).filter((x) => x.date <= date);
  }
  function statusRank(s) {
    return (
      {
        NEXT_SESSION_PLAN: 0,
        WAIT_ENTRY: 1,
        MODEL_ENTERED: 2,
        RESEARCH_ONLY: 3,
        EXPIRED: 4,
        ARCHIVED: 8,
        MANUAL_REVIEW: 5,
        UNTRADABLE: 6,
        REJECTED: 7,
      }[s] ?? 9
    );
  }
  function statusLabel(s) {
    return (
      {
        NEXT_SESSION_PLAN: "首次开盘预案",
        WAIT_ENTRY: "等待下次开盘",
        MODEL_ENTERED: "开盘已触发·模型待结算",
        EXPIRED: "已失效",
        ARCHIVED: "已归档",
        RESEARCH_ONLY: "降级研究",
        MANUAL_REVIEW: "冲突复核",
        UNTRADABLE: "暂不可成交",
        REJECTED: "已拒绝",
        OBSERVING: "观察",
        DATA_ERROR: "数据异常",
        INDEX_ONLY: "指数参考",
        UNSUPPORTED: "不适用日线模型",
      }[s] || s
    );
  }
  function openingDecision(signal, entryBar, market, cfg) {
    const zone = signal.geometry;
    if (!zone || !zone.valid) return { status: "SKIP", reason: "非法几何" };
    if (!entryBar || !finite(entryBar.open) || +entryBar.open <= 0)
      return { status: "SKIP", reason: "缺少有效开盘价" };
    const open = +entryBar.open;
    if (
      market === "A" &&
      signal.signalClose > 0 &&
      signal.limitPct &&
      open / signal.signalClose - 1 >= (signal.limitPct - 0.2) / 100 &&
      open >= entryBar.high
    )
      return { status: "SKIP", reason: "开盘接近涨停，无法确认成交" };
    if (open < zone.zoneLo || open > zone.zoneHi)
      return { status: "SKIP", reason: "开盘不在入场区" };
    const entryGeometry = repriceGeometry(zone, open, cfg),
      riskCheck = executionRiskCheck(zone, open, cfg, signal.channel);
    if (!riskCheck.pass) return { status: "SKIP", reason: riskCheck.reason };
    if (!entryGeometry.valid || entryGeometry.netRR < channelMinRR(signal.channel, cfg))
      return { status: "SKIP", reason: "开盘成本后净赔率不足" };
    return { status: "ENTER", reason: null, entryGeometry, open };
  }

  function executeTrade(signal, entryBar, futureBars, market, cfg) {
    const decision = openingDecision(signal, entryBar, market, cfg);
    if (decision.status === "SKIP") return decision;
    const open = decision.open,
      slip = cfg.slippageBps / 10000,
      fee = cfg.feeBps / 20000,
      entry = open * (1 + slip + fee),
      stop = signal.geometry.stop,
      target = signal.geometry.target,
      initialRisk = entry - stop * (1 - slip - fee),
      allBars = futureBars.length && futureBars[0].date === entryBar.date
        ? futureBars.slice()
        : [entryBar, ...futureBars],
      holdingBars = allBars.slice(0, cfg.holdingDays);
    if (initialRisk <= 0) return { status: "SKIP", reason: "初始风险非法" };
    if (!holdingBars.length) return { status: "SKIP", reason: "缺少持有期日K" };
    const netR = (price) => (price * (1 - slip - fee) - entry) / initialRisk,
      netReturnPct = (price) => (price * (1 - slip - fee) - entry) / entry * 100;
    let exit = null,
      exitDate = null,
      reason = "TIMEOUT",
      exitIndex = -1,
      firstTargetDay = null,
      firstStopDay = null,
      blockedAtLast = false,
      sawBlockedExit = false;
    const start = market === "A" ? 1 : 0;
    for (let j = 0; j < holdingBars.length; j++) {
      const b = holdingBars[j];
      if (j < start) continue;
      if (firstStopDay === null && (b.open <= stop || b.low <= stop)) firstStopDay = j;
      if (firstTargetDay === null && (b.open >= target || b.high >= target)) firstTargetDay = j;
      let px = null;
      blockedAtLast = false;
      if (b.open <= stop) {
        px = b.open;
        reason = "GAP_STOP";
      } else if (b.open >= target) {
        px = b.open;
        reason = "GAP_TARGET";
      } else {
        const hitStop = b.low <= stop,
          hitTarget = b.high >= target;
        if (hitStop && hitTarget) {
          px = stop;
          reason = "BOTH_STOP_FIRST";
        } else if (hitStop) {
          px = stop;
          reason = "STOP";
        } else if (hitTarget) {
          px = target;
          reason = "TARGET";
        }
      }
      if (px !== null) {
        const prev = j > 0 ? holdingBars[j - 1] : entryBar,
          onePrice = Math.abs(b.high - b.low) <= Math.max(1e-6, b.close * 1e-6),
          atLimitDown = market === "A" && signal.limitPct && prev && prev.close > 0 &&
            b.open <= prev.close * (1 - (signal.limitPct - 0.2) / 100);
        if (reason.includes("STOP") && onePrice && atLimitDown) {
          sawBlockedExit = true;
          blockedAtLast = true;
          reason = "TIMEOUT";
          continue;
        }
        exit = px * (1 - slip - fee);
        exitDate = b.date;
        exitIndex = j;
        break;
      }
    }
    if (exit === null) {
      const b = last(holdingBars);
      exit = b.close * (1 - slip - fee);
      exitDate = b.date;
      exitIndex = holdingBars.length - 1;
      reason = blockedAtLast ? "LIMIT_DOWN_EXIT_BLOCKED" : "TIMEOUT";
    }
    const settled = reason !== "LIMIT_DOWN_EXIT_BLOCKED" &&
      (reason !== "TIMEOUT" || holdingBars.length >= cfg.holdingDays),
      R = (exit - entry) / initialRisk,
      actualBars = holdingBars.slice(0, exitIndex + 1),
      closePath = actualBars.map((b, t) => ({
        t,
        date: b.date,
        close: b.close,
        netR: netR(b.close),
        netReturnPct: netReturnPct(b.close),
      })),
      counterfactualPath = allBars.slice(0, 11).map((b, t) => ({
        t,
        date: b.date,
        close: b.close,
        netR: netR(b.close),
        netReturnPct: netReturnPct(b.close),
      })),
      fixedHorizon = {};
    for (const horizon of [1, 3, 5, 10]) {
      const cf = counterfactualPath.find((x) => x.t === horizon),
        locked = settled && exitIndex <= horizon;
      fixedHorizon[horizon] = cf && (locked || !settled || exitIndex > horizon)
        ? {
            t: horizon,
            date: cf.date,
            netR: locked ? R : cf.netR,
            netReturnPct: locked ? (exit - entry) / entry * 100 : cf.netReturnPct,
            lockedExit: locked,
            available: true,
          }
        : { t: horizon, date: cf ? cf.date : null, netR: null, netReturnPct: null, available: false };
    }
    return {
      status: "CLOSED",
      settled,
      rightCensored: !settled,
      entryDate: entryBar.date,
      exitDate,
      entry: open,
      entryCost: entry,
      initialRisk,
      exit,
      R,
      reason,
      exitIndex,
      holdingTradingDays: exitIndex,
      firstTargetDay,
      firstStopDay,
      mfeR: max(actualBars.map((b) => netR(b.high))),
      maeR: min(actualBars.map((b) => netR(b.low))),
      mfePct: max(actualBars.map((b) => netReturnPct(b.high))),
      maePct: min(actualBars.map((b) => netReturnPct(b.low))),
      closePath,
      counterfactualPath,
      fixedHorizon,
      sawBlockedExit,
    };
  }
  function executeTradeWindow(signal, candidateBars, market, cfg, maxAttempts = 1) {
    const attempts = [],
      limit = Math.max(1, Math.min(maxAttempts, candidateBars.length)),
      stop = signal.geometry && signal.geometry.stop;
    for (let i = 0; i < limit; i++) {
      if (Number.isFinite(stop) && Number.isFinite(candidateBars[i].close) && candidateBars[i].close <= stop) {
        attempts.push({ date: candidateBars[i].date, status: "SKIP", reason: "该日收盘已触及失效锚点" });
        return { status: "SKIP", reason: "等待期间收盘触及失效锚点", pending: false, entryOffset: null, attempts };
      }
      const researchDays = Math.max(cfg.holdingDays, 11),
        future = candidateBars.slice(i, i + researchDays),
        result = executeTrade(signal, candidateBars[i], future, market, cfg);
      attempts.push({ date: candidateBars[i].date, status: result.status, reason: result.reason });
      if (result.status === "CLOSED") return { ...result, entryOffset: i, entryWaitDays: i + 1, attempts };
    }
    const pending = limit < Math.max(1, maxAttempts);
    return {
      status: "SKIP",
      reason: pending ? "入场窗口未满，暂未成交" : "信号有效期内未出现可执行开盘",
      pending,
      entryOffset: null,
      attempts,
    };
  }
  function replaySymbol(o) {
    const cfg = { ...DEFAULTS, ...(o.config || {}) },
      bars = normalizeBars(o.bars),
      benchmark = asNormalized(o.benchmarkBars),
      market = o.market || "A",
      trades = [],
      skipped = [],
      conflicts = [],
      runState = Object.fromEntries(
        Object.keys(CHANNELS).map((c) => [
          c,
          { blockedUntil: -1, prevTriggered: false },
        ]),
      );
    if (DAILY_EXCLUDED.has(o.code))
      return { trades, skipped, conflicts, diagnostics: { excluded: 1, conflictCount: 0 } };
    if (bars.length < cfg.minBars + 15)
      return { trades, skipped, conflicts, diagnostics: { excluded: 0, conflictCount: 0 } };
    const shared = featureShared(bars);
    for (let t = cfg.minBars - 1; t < bars.length - 2; t++) {
      const f = featureAt(bars.slice(0, t + 1), shared, t),
        date = bars[t].date,
        bb = benchmarkSlice(benchmark, date);
      const daySignals = {}, dayTriggers = {};
      for (const channel of Object.keys(CHANNELS)) {
        const s = finalizeHistorical(channel, f, bb, cfg, market, o.code);
        daySignals[channel] = s;
        dayTriggers[channel] =
          !!s && s.stage === 3 && s.Q && s.E && s.geometry && s.geometry.valid &&
          s.geometry.netRR >= channelMinRR(channel, cfg) && s.liquidity && s.liquidity.pass;
      }
      const newOversold = dayTriggers.oversold && !runState.oversold.prevTriggered,
        newBreakout = dayTriggers.breakout && !runState.breakout.prevTriggered;
      if (newOversold && newBreakout) {
        conflicts.push({ code: o.code, name: o.name, signalDate: date, reason: "超跌与突破同时触发，回放不独立双入场" });
        for (const channel of Object.keys(CHANNELS)) runState[channel].prevTriggered = dayTriggers[channel];
        continue;
      }
      for (const channel of Object.keys(CHANNELS)) {
        const st = runState[channel];
        if (t <= st.blockedUntil) {
          st.prevTriggered = false;
          continue;
        }
        const s = daySignals[channel], trigger = dayTriggers[channel];
        if (trigger && !st.prevTriggered) {
          const entryWindowDays = Math.max(1, CHANNELS[channel].maxAge - 1),
            researchDays = Math.max(cfg.holdingDays, 11),
            future = bars.slice(
              t + 1,
              Math.min(bars.length, t + entryWindowDays + researchDays),
            );
          if (!future.length) continue;
          s.signalClose = bars[t].close;
          s.limitPct = market === "A" ? priceLimit(o.code, o.name) : null;
          const result = executeTradeWindow(s, future, market, cfg, entryWindowDays);
          if (result.status === "SKIP") {
            if (!result.pending) skipped.push({
              code: o.code,
              name: o.name,
              channel,
              signalDate: date,
              Q: s.Q.value,
              E: s.E.value,
              S: s.S,
              ...result,
            });
          } else {
            trades.push({
              code: o.code,
              name: o.name,
              channel,
              signalDate: date,
              Q: s.Q.value,
              E: s.E.value,
              S: s.S,
              ...result,
            });
            st.blockedUntil = t + 1 + (result.entryOffset || 0) + result.exitIndex;
          }
        }
        st.prevTriggered = trigger;
      }
    }
    return { trades, skipped, conflicts, diagnostics: { excluded: 0, conflictCount: conflicts.length } };
  }

  function scoreDiagnostics(trades) {
    const stats = (arr) => {
      const rs = arr.map((x) => x.R).filter(Number.isFinite);
      return {
        count: arr.length,
        avgR: mean(rs),
        winRate: rs.length ? (rs.filter((x) => x > 0).length / rs.length) * 100 : null,
      };
    };
    const out = [];
    for (const channel of Object.keys(CHANNELS)) {
      for (const metric of ["Q", "E", "S"]) {
        const arr = trades
          .filter(
            (x) =>
              x.channel === channel &&
              Number.isFinite(x[metric]) &&
              Number.isFinite(x.R),
          )
          .sort((a, b) => a[metric] - b[metric]);
        if (arr.length < 30) {
          out.push({
            channel,
            metric,
            count: arr.length,
            buckets: [],
            spread: null,
            monotonic: null,
            status: "样本不足",
          });
          continue;
        }
        const cut1 = Math.floor(arr.length / 3),
          cut2 = Math.floor((arr.length * 2) / 3),
          lows = arr.slice(0, cut1),
          mids = arr.slice(cut1, cut2),
          highs = arr.slice(cut2),
          buckets = [
            { label: "低", ...stats(lows), range: [lows[0][metric], last(lows)[metric]] },
            { label: "中", ...stats(mids), range: [mids[0][metric], last(mids)[metric]] },
            { label: "高", ...stats(highs), range: [highs[0][metric], last(highs)[metric]] },
          ],
          spread = buckets[2].avgR - buckets[0].avgR,
          monotonic =
            buckets[0].avgR <= buckets[1].avgR &&
            buckets[1].avgR <= buckets[2].avgR;
        out.push({
          channel,
          metric,
          count: arr.length,
          buckets,
          spread,
          monotonic,
          status: monotonic ? "分桶单调" : "分桶非单调",
        });
      }
    }
    return out;
  }
  function settledTrade(t) {
    return t && t.status === "CLOSED" && t.settled !== false && Number.isFinite(t.R);
  }
  function rStats(rs) {
    const wins = rs.filter((x) => x > 0),
      losses = rs.filter((x) => x <= 0),
      positive = sum(wins),
      negative = Math.abs(sum(losses));
    return {
      count: rs.length,
      winRate: rs.length ? wins.length / rs.length * 100 : null,
      avgR: mean(rs),
      medianR: median(rs),
      profitFactor: !rs.length ? null : negative ? positive / negative : positive ? Infinity : 0,
    };
  }
  function percentile(values, p) {
    if (!values.length) return null;
    const a = values.slice().sort((x, y) => x - y),
      pos = (a.length - 1) * p,
      lo = Math.floor(pos),
      hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }
  function clusterConfidence(trades, iterations = 400) {
    const usable = trades.filter(settledTrade),
      groups = new Map();
    for (const t of usable) {
      const key = t.code || t.name || "unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t.R);
    }
    const clusters = [...groups.values()];
    if (!clusters.length) return { clusters: 0, iterations: 0, avgR: null, winRate: null, profitFactor: null };
    let seed = 0x51f15e;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      },
      avg = [],
      win = [],
      pf = [];
    for (let i = 0; i < iterations; i++) {
      const rs = [];
      for (let j = 0; j < clusters.length; j++) {
        const picked = clusters[Math.floor(random() * clusters.length)];
        rs.push(...picked);
      }
      const s = rStats(rs);
      avg.push(s.avgR);
      win.push(s.winRate);
      if (Number.isFinite(s.profitFactor)) pf.push(s.profitFactor);
    }
    const interval = (a) => a.length ? [percentile(a, 0.025), percentile(a, 0.975)] : null;
    return {
      clusters: clusters.length,
      iterations,
      avgR: interval(avg),
      winRate: interval(win),
      profitFactor: interval(pf),
    };
  }
  function fixedHorizonDiagnostics(trades) {
    const out = [];
    for (const channel of Object.keys(CHANNELS)) {
      for (const horizon of [1, 3, 5, 10]) {
        const rows = trades.filter((t) => t.channel === channel)
          .map((t) => t.fixedHorizon && t.fixedHorizon[horizon])
          .filter((h) => h && h.available && Number.isFinite(h.netR)),
          stats = rStats(rows.map((h) => h.netR));
        out.push({
          channel,
          horizon,
          ...stats,
          avgReturnPct: mean(rows.map((h) => h.netReturnPct).filter(Number.isFinite)),
        });
      }
    }
    return out;
  }
  function counterfactualAt(t, horizon) {
    return t.counterfactualPath && t.counterfactualPath.find((x) => x.t === horizon);
  }
  function counterfactualDiagnostics(trades) {
    const closed = trades.filter(settledTrade),
      stopped = closed.filter((t) => t.reason.includes("STOP")),
      targeted = closed.filter((t) => t.reason.includes("TARGET"));
    return [1, 3, 5, 10].map((horizon) => {
      const stopRows = stopped.map((t) => ({ t, cf: counterfactualAt(t, horizon) })).filter((x) => x.cf),
        targetRows = targeted.map((t) => ({ t, cf: counterfactualAt(t, horizon) })).filter((x) => x.cf);
      return {
        horizon,
        stopCount: stopRows.length,
        stopRecovered: stopRows.filter((x) => x.cf.netR > 0).length,
        stopFurtherDown: stopRows.filter((x) => x.cf.netR < x.t.R).length,
        targetCount: targetRows.length,
        targetContinued: targetRows.filter((x) => x.cf.netR > x.t.R).length,
      };
    });
  }
  const FAILURE_CATEGORIES = [
    { key: "STOP_RECOVERY", label: "止损后收复（反事实）", definition: "止损样本在不退出路径的T+5或T+10净R>0" },
    { key: "STOP_CONTINUED", label: "止损后继续下跌", definition: "可观察的最新反事实净R低于实际止损净R" },
    { key: "HIGH_MFE_POOR", label: "高MFE·收益兑现差", definition: "MFE≥1R，且实际净R低于min(0.5R, MFE/2)" },
    { key: "LOW_MFE_LOSS", label: "低MFE·最终亏损", definition: "实际净R≤0且MFE<0.5R" },
    { key: "TIMEOUT_FLAT", label: "超时·收益近零", definition: "TIMEOUT且|实际净R|<0.25R" },
    { key: "OTHER", label: "其他／未分类", definition: "不满足以上研究标签" },
  ];
  function failureCategory(t) {
    const cf5 = counterfactualAt(t, 5),
      cf10 = counterfactualAt(t, 10),
      latestCf = cf10 || cf5,
      stopped = t.reason.includes("STOP");
    if (stopped && ((cf5 && cf5.netR > 0) || (cf10 && cf10.netR > 0))) return "STOP_RECOVERY";
    if (stopped && latestCf && latestCf.netR < t.R) return "STOP_CONTINUED";
    if (Number.isFinite(t.mfeR) && t.mfeR >= 1 && t.R < Math.min(0.5, t.mfeR / 2)) return "HIGH_MFE_POOR";
    if (t.R <= 0 && Number.isFinite(t.mfeR) && t.mfeR < 0.5) return "LOW_MFE_LOSS";
    if (t.reason === "TIMEOUT" && Math.abs(t.R) < 0.25) return "TIMEOUT_FLAT";
    return "OTHER";
  }
  function failureMatrix(trades) {
    const closed = trades.filter(settledTrade);
    return FAILURE_CATEGORIES.map((category) => {
      const rows = closed.filter((t) => failureCategory(t) === category.key),
        channels = {};
      for (const channel of Object.keys(CHANNELS)) {
        const rs = rows.filter((t) => t.channel === channel).map((t) => t.R);
        channels[channel] = { count: rs.length, avgR: mean(rs) };
      }
      return { ...category, count: rows.length, avgR: mean(rows.map((t) => t.R)), channels };
    });
  }
  function skipReasonCategory(reason) {
    const text = String(reason || "");
    if (text.includes("失效锚点")) return { key: "INVALIDATED", label: "等待期间结构失效" };
    if (text.includes("不在入场区")) return { key: "OUTSIDE_ZONE", label: "开盘离开入场区" };
    if (text.includes("净赔率不足")) return { key: "RR_FAIL", label: "实际开盘净赔率不足" };
    if (text.includes("涨停")) return { key: "LIMIT_UP", label: "接近涨停·无法确认成交" };
    if (text.includes("开盘价") || text.includes("日K") || text.includes("数据")) return { key: "DATA", label: "缺少有效开盘或日K" };
    return { key: "OTHER", label: "其他／窗口耗尽" };
  }
  function unfilledFunnel(skipped) {
    const counts = new Map(),
      totals = {};
    for (const s of skipped) totals[s.channel] = (totals[s.channel] || 0) + 1;
    for (const s of skipped) {
      const attempts = s.attempts || [],
        lastAttempt = attempts[attempts.length - 1],
        category = skipReasonCategory(s.reason.includes("失效锚点") ? s.reason : lastAttempt ? lastAttempt.reason : s.reason),
        key = [s.channel, category.key].join("|"),
        old = counts.get(key) || { channel: s.channel, ...category, count: 0 };
      old.count++;
      counts.set(key, old);
    }
    return [...counts.values()].map((x) => ({
      ...x,
      pct: totals[x.channel] ? x.count / totals[x.channel] * 100 : null,
    })).sort((a, b) => a.channel.localeCompare(b.channel) || b.count - a.count);
  }
  function clusterMeanInterval(rows, valueOf, iterations = 400) {
    const groups = new Map();
    for (const row of rows) {
      const value = valueOf(row);
      if (!Number.isFinite(value)) continue;
      const key = row.code || row.name || "unknown";
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(value);
    }
    const clusters = [...groups.values()];
    if (!clusters.length) return { clusters: 0, iterations: 0, mean: null };
    let seed = 0x51f15e;
    const random = () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 4294967296;
      },
      samples = [];
    for (let i = 0; i < iterations; i++) {
      const values = [];
      for (let j = 0; j < clusters.length; j++) {
        const picked = clusters[Math.floor(random() * clusters.length)];
        values.push(...picked);
      }
      samples.push(mean(values));
    }
    return { clusters: clusters.length, iterations, mean: [percentile(samples, 0.025), percentile(samples, 0.975)] };
  }
  function tailConcentrationOne(trades) {
    const closed = trades.filter(settledTrade),
      ordered = closed.slice().sort((a, b) => b.R - a.R),
      grossProfit = sum(ordered.filter((t) => t.R > 0).map((t) => t.R)),
      share = (n) => grossProfit > 0 ? sum(ordered.slice(0, n).filter((t) => t.R > 0).map((t) => t.R)) / grossProfit * 100 : null,
      without = (n) => ordered.length > n ? mean(ordered.slice(n).map((t) => t.R)) : null;
    return {
      count: closed.length,
      top1Share: share(1),
      top5Share: share(5),
      avgRWithoutTop1: without(1),
      avgRWithoutTop5: without(5),
    };
  }
  function tailConcentrationDiagnostics(trades) {
    return [{ channel: "all" }, ...Object.keys(CHANNELS).map((channel) => ({ channel }))].map((x) => ({
      ...x,
      ...tailConcentrationOne(x.channel === "all" ? trades : trades.filter((t) => t.channel === x.channel)),
    }));
  }
  function pairedHorizonDiagnostics(trades) {
    return Object.keys(CHANNELS).map((channel) => {
      const rows = trades.filter((t) => {
        const a = t.fixedHorizon && t.fixedHorizon[5], b = t.fixedHorizon && t.fixedHorizon[10];
        return t.channel === channel && a && b && a.available && b.available && Number.isFinite(a.netR) && Number.isFinite(b.netR);
      }).map((t) => ({ code: t.code, name: t.name, delta: t.fixedHorizon[10].netR - t.fixedHorizon[5].netR }));
      return {
        channel,
        count: rows.length,
        avgDelta: mean(rows.map((x) => x.delta)),
        medianDelta: median(rows.map((x) => x.delta)),
        improvedPct: rows.length ? rows.filter((x) => x.delta > 0).length / rows.length * 100 : null,
        confidence: clusterMeanInterval(rows, (x) => x.delta),
      };
    });
  }
  function replaySummary(items) {
    const trades = items.flatMap((x) => x.trades || []),
      closedTrades = trades.filter(settledTrade),
      skipped = items.flatMap((x) => x.skipped || []),
      by = {};
    for (const channel of Object.keys(CHANNELS))
      by[channel] = { channel, trades: [], skipped: 0 };
    trades.forEach((t) => by[t.channel].trades.push(t));
    skipped.forEach((t) => {
      if (by[t.channel]) by[t.channel].skipped++;
    });
    const summarize = (g) => {
      const closed = g.trades.filter(settledTrade),
        stats = rStats(closed.map((x) => x.R));
      return {
        channel: g.channel,
        ...stats,
        pending: g.trades.length - closed.length,
        skipped: g.skipped || 0,
        targets: closed.filter((x) => x.reason.includes("TARGET")).length,
        stops: closed.filter((x) => x.reason.includes("STOP")).length,
        confidence: clusterConfidence(closed),
        status: stats.count < 30 ? "样本不足" : "探索性样本≥30，仍非样本外证明",
      };
    };
    return {
      overall: summarize({ trades, skipped: skipped.length }),
      channels: Object.values(by).map(summarize),
      trades,
      closedCount: closedTrades.length,
      pendingCount: trades.length - closedTrades.length,
      skipped,
      skippedCount: skipped.length,
      diagnostics: {
        conflicts: items.flatMap((x) => x.conflicts || []),
        conflictCount: items.reduce((n, x) => n + ((x.conflicts || []).length), 0),
        excludedSymbols: items.filter((x) => x.diagnostics && x.diagnostics.excluded).map((x) => x.code || x.name || "已排除标的"),
      },
      scoreDiagnostics: scoreDiagnostics(closedTrades),
      fixedHorizon: fixedHorizonDiagnostics(trades),
      counterfactual: counterfactualDiagnostics(closedTrades),
      failureMatrix: failureMatrix(closedTrades),
      unfilledFunnel: unfilledFunnel(skipped),
      tailConcentration: tailConcentrationDiagnostics(trades),
      pairedHorizon: pairedHorizonDiagnostics(trades),
      executionBlocked: trades.filter((t) => t.sawBlockedExit).length,
    };
  }

  function executeIntradayTrade(signal, entryDate, entryPrice, bars, market, cfg) {
    const all = normalizeBars(bars), entryBar = all.find((b) => b.date === entryDate);
    if (!entryBar) return { status: "PENDING", reason: "入场日日K尚未完成或缺失", entryDate };
    const holdingBars = all.filter((b) => b.date > entryDate).slice(0, cfg.holdingDays);
    if (!holdingBars.length) return { status: "PENDING", reason: "等待入场后的第一根完成日K", entryDate };
    const slip = cfg.slippageBps / 10000, fee = cfg.feeBps / 20000,
      entry = entryPrice * (1 + slip + fee), stop = signal.geometry.stop, target = signal.geometry.target,
      initialRisk = entry - stop * (1 - slip - fee);
    if (initialRisk <= 0) return { status: "SKIP", reason: "盘中入场初始风险非法", entryDate };
    const netR = (price) => (price * (1 - slip - fee) - entry) / initialRisk,
      netReturnPct = (price) => (price * (1 - slip - fee) - entry) / entry * 100;
    let exit = null, exitDate = null, reason = "TIMEOUT", exitIndex = -1,
      firstTargetDay = null, firstStopDay = null, blockedAtLast = false, sawBlockedExit = false;
    for (let j = 0; j < holdingBars.length; j++) {
      const b = holdingBars[j];
      if (firstStopDay === null && (b.open <= stop || b.low <= stop)) firstStopDay = j + 1;
      if (firstTargetDay === null && (b.open >= target || b.high >= target)) firstTargetDay = j + 1;
      let px = null;
      blockedAtLast = false;
      if (b.open <= stop) { px = b.open; reason = "GAP_STOP"; }
      else if (b.open >= target) { px = b.open; reason = "GAP_TARGET"; }
      else {
        const hitStop = b.low <= stop, hitTarget = b.high >= target;
        if (hitStop && hitTarget) { px = stop; reason = "BOTH_STOP_FIRST"; }
        else if (hitStop) { px = stop; reason = "STOP"; }
        else if (hitTarget) { px = target; reason = "TARGET"; }
      }
      if (px !== null) {
        const prev = j > 0 ? holdingBars[j - 1] : entryBar,
          onePrice = Math.abs(b.high - b.low) <= Math.max(1e-6, b.close * 1e-6),
          atLimitDown = market === "A" && signal.limitPct && prev && prev.close > 0 &&
            b.open <= prev.close * (1 - (signal.limitPct - 0.2) / 100);
        if (reason.includes("STOP") && onePrice && atLimitDown) {
          sawBlockedExit = true; blockedAtLast = true; reason = "TIMEOUT"; continue;
        }
        exit = px * (1 - slip - fee); exitDate = b.date; exitIndex = j; break;
      }
    }
    if (exit === null) {
      const b = last(holdingBars);
      exit = b.close * (1 - slip - fee); exitDate = b.date; exitIndex = holdingBars.length - 1;
      reason = blockedAtLast ? "LIMIT_DOWN_EXIT_BLOCKED" : "TIMEOUT";
    }
    const settled = reason !== "LIMIT_DOWN_EXIT_BLOCKED" &&
        (reason !== "TIMEOUT" || holdingBars.length >= cfg.holdingDays),
      R = (exit - entry) / initialRisk, actualBars = holdingBars.slice(0, exitIndex + 1),
      closePath = actualBars.map((b, i) => ({ t: i + 1, date: b.date, close: b.close, netR: netR(b.close), netReturnPct: netReturnPct(b.close) }));
    return {
      status: "CLOSED", settled, rightCensored: !settled, executionModel: INTRADAY_MODEL,
      entryDate, exitDate, entry: entryPrice, entryCost: entry, initialRisk, exit, R, reason,
      exitIndex, holdingTradingDays: exitIndex + 1, firstTargetDay, firstStopDay,
      mfeR: max(actualBars.map((b) => netR(b.high))), maeR: min(actualBars.map((b) => netR(b.low))),
      mfePct: max(actualBars.map((b) => netReturnPct(b.high))), maePct: min(actualBars.map((b) => netReturnPct(b.low))),
      closePath, sawBlockedExit,
      researchBoundary: "入场日只有触发快照，没有触发后的逐笔路径；MFE/MAE与退出仅从下一完成日K开始，不还原入场日后续走势",
    };
  }
  function summarizeIntraday(entries) {
    const rows = Array.isArray(entries) ? entries : [],
      closed = rows.filter((e) => e.done && e.result && e.result.status === "CLOSED" && e.result.settled !== false && Number.isFinite(e.result.R)),
      skipped = rows.filter((e) => e.done && (!e.result || e.result.status !== "CLOSED")),
      stats = rStats(closed.map((e) => e.result.R)),
      by = {};
    for (const channel of ["oversold", "breakout"]) {
      const group = closed.filter((e) => e.channel === channel), gs = rStats(group.map((e) => e.result.R));
      by[channel] = { channel, ...gs, pending: rows.filter((e) => !e.done && e.channel === channel).length };
    }
    // v14.3：执行模型标签按档案实际值汇总（缺省按 V2 旧档案），避免历史档案被新标签覆盖。
    const models = new Set(rows.map((e) => e.executionModel || "INTRADAY_V2"));
    return {
      executionModel: models.size === 1 ? [...models][0] : "MIXED",
      total: rows.length, closed: closed.length, skipped: skipped.length,
      pending: rows.length - closed.length - skipped.length, ...stats,
      channels: Object.values(by), status: closed.length < 30 ? "样本不足·仅前向诊断" : "探索性样本≥30·仍非有效性证明",
    };
  }
  function makeSynthetic(n = 140) {
    const out = [];
    let price = 20;
    for (let i = 0; i < n; i++) {
      const ret = Math.sin(i / 8) * 0.008 + (i > 70 ? 0.001 : -0.0005),
        open = price,
        close = price * (1 + ret),
        high = Math.max(open, close) * 1.008,
        low = Math.min(open, close) * 0.992;
      out.push({
        date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
        open,
        high,
        low,
        close,
        volume: 1e6 + i * 1000,
        amount: close * (1e6 + i * 1000),
      });
      price = close;
    }
    return out;
  }
  function makePullbackSynthetic() {
    const out = [];
    let p = 10,
      d = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 130; i++) {
      const r = i < 105 ? 0.004 : i < 112 ? -0.012 : i < 129 ? 0.003 : 0.02,
        o = p,
        c = p * (1 + r),
        v = i === 129 ? 2e7 : 1e7;
      out.push({
        date: new Date(d + i * 864e5).toISOString().slice(0, 10),
        open: o,
        high: Math.max(o, c) * 1.004,
        low: Math.min(o, c) * 0.996,
        close: c,
        volume: v,
        amount: c * v,
      });
      p = c;
    }
    return out;
  }
  function makeBreakoutSynthetic() {
    const out = [],
      d = Date.parse("2026-07-01T00:00:00Z");
    for (let i = 0; i < 100; i++) {
      const c = i < 99 ? 10 + Math.sin(i / 4) * 0.08 : 10.15,
        o = i < 99 ? c - 0.01 : 10.1,
        v = i < 99 ? 1e7 : 2.2e7;
      out.push({
        date: new Date(d + i * 864e5).toISOString().slice(0, 10),
        open: o,
        high: i < 99 ? Math.max(o, c) + 0.06 : c + 0.01,
        low: i < 99 ? Math.min(o, c) - 0.06 : o - 0.02,
        close: c,
        volume: v,
        amount: c * v,
      });
    }
    return out;
  }

  function runSelfTests() {
    const tests = [];
    const test = (name, fn) => {
      try {
        const r = fn();
        tests.push({
          name,
          pass: r === true,
          detail: r === true ? "通过" : String(r),
        });
      } catch (e) {
        tests.push({ name, pass: false, detail: e.message });
      }
    };
    test("滚动均线与边界", () =>
      JSON.stringify(rolling([1, 2, 3, 4], 2)) ===
      JSON.stringify([null, 1.5, 2.5, 3.5]));
    test("恒定价格 RSI 为中性50", () =>
      last(rsiSeries(Array(30).fill(10))) === 50);
    test("ATR 与 OHLC 非法值拦截", () =>
      normalizeBars([
        {
          date: "2026-01-01",
          open: 10,
          high: 9,
          low: 8,
          close: 8.5,
          volume: 1,
        },
      ]).length === 0);
    test("特征前缀不变性（无未来数据）", () => {
      const b = makeSynthetic(),
        a = features(b.slice(0, 100)),
        c = features(b).bars.slice(0, 100);
      return (
        a.date === c[c.length - 1].date &&
        a.prevHigh20 === max(c.slice(-21, -1).map((x) => x.high))
      );
    });
    test("成本增加不会提高净赔率", () => {
      const b = makeSynthetic(),
        f = features(b),
        s = {
          anchors: {
            pressure: f.close - 1,
            baseLow: f.close - 4,
            baseRange: 3,
          },
        },
        g1 = netGeometry("breakout", f, s, f.close, {
          ...DEFAULTS,
          feeBps: 0,
          slippageBps: 0,
        }),
        g2 = netGeometry("breakout", f, s, f.close, DEFAULTS);
      return g2.netRR < g1.netRR;
    });
    test("同日止损目标同时触及采用止损优先", () => {
      const sig = {
          geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 9, target: 12 },
        },
        future = [
          { date: "2026-01-03", open: 10, high: 12.5, low: 8.5, close: 11 },
        ],
        r = executeTrade(
          sig,
          { date: "2026-01-02", open: 10 },
          future,
          "US",
          DEFAULTS,
        );
      return r.reason === "BOTH_STOP_FIRST";
    });
    test("未入场信号不计为交易", () => {
      const sig = {
          geometry: { valid: true, zoneLo: 9, zoneHi: 10, stop: 8, target: 12 },
        },
        r = executeTrade(
          sig,
          { date: "2026-01-02", open: 11 },
          [],
          "US",
          DEFAULTS,
        );
      return r.status === "SKIP";
    });
    test("趋势回踩构造样本可形成（MA60标量回归）", () => {
      const b = makePullbackSynthetic(),
        s = historicalSetup("pullback", b, b, DEFAULTS);
      return s && s.stage === 3 && s.metrics.ma60 > 0;
    });
    test("突破确认构造样本可形成", () => {
      const b = makeBreakoutSynthetic(),
        s = historicalSetup("breakout", b, b, DEFAULTS);
      return s && s.stage === 3 && s.geometry.netRR > 1.5;
    });
    test("A股午休不采纳当日未完成K线", () => {
      const b = makeSynthetic(100);
      b[b.length - 1].date = "2026-10-26";
      const kept = completedBars(
        b,
        "A",
        new Date("2026-10-26T04:00:00Z"),
      );
      return kept[kept.length - 1].date !== "2026-10-26";
    });
    test("触发后几何快照不随最新ATR漂移", () => {
      const b = makeBreakoutSynthetic(),
        s0 = historicalSetup("breakout", b, b, DEFAULTS),
        lastBar = b[b.length - 1],
        c = lastBar.close * 1.01,
        later = b.concat([
          {
            date: "2027-01-01",
            open: c * 0.99,
            high: c * 1.12,
            low: c * 0.88,
            close: c,
            volume: lastBar.volume * 2,
            amount: c * lastBar.volume * 2,
          },
        ]),
        f1 = features(later),
        changed = netGeometry("breakout", f1, s0, c, DEFAULTS, lastBar.close);
      return (
        changed.zoneHi !== s0.geometry.zoneHi &&
        s0.geometry.zoneHi ===
          netGeometry("breakout", features(b), s0, lastBar.close, DEFAULTS).zoneHi
      );
    });
    test("A股16点后采纳当日已完成K线", () => {
      const b = makeSynthetic(100);
      b[b.length - 1].date = "2026-10-26";
      const kept = completedBars(
        b,
        "A",
        new Date("2026-10-26T12:00:00Z"),
      );
      return kept[kept.length - 1].date === "2026-10-26";
    });
    test("北交所普通股票涨跌幅为30%", () =>
      priceLimit("bj920001", "测试") === 30);
    test("增量特征快照与独立逐日计算一致", () => {
      const b = makeSynthetic(140),
        shared = featureShared(b),
        pick = (f) =>
          f && [
            f.date,
            f.close,
            f.atr,
            f.prevHigh20,
            f.prevLow60,
            f.volAvg20,
            f.amountAvg20,
            f.baseHigh,
            f.baseLow,
            f.ma60Prev5,
            f.swings,
          ];
      for (const n of [60, 80, 100, 139, 140]) {
        const a = featureAt(b.slice(0, n), shared, n - 1),
          z = features(b.slice(0, n));
        if (JSON.stringify(pick(a)) !== JSON.stringify(pick(z))) return false;
      }
      return true;
    });
    test("A股15:01与16:00边界均保留完成K线", () => {
      const b = makeSynthetic(100);
      b[b.length - 1].date = "2026-10-26";
      return ["2026-10-26T07:01:00Z", "2026-10-26T08:00:00Z"].every((t) => {
        const kept = completedBars(b, "A", new Date(t));
        return kept[kept.length - 1].date === "2026-10-26";
      });
    });
    test("K线长期断档截取最近连续段", () => {
      const b = makeSynthetic(90);
      for (let i = 50; i < b.length; i++) b[i].date = new Date(Date.parse(b[i].date) + 60 * 864e5).toISOString().slice(0, 10);
      const q = klineSeriesQuality(b);
      return q.pass && q.bars.length === 40;
    });
    test("异常收益拼接被质量防线拒绝", () => {
      const b = makeSynthetic(90), x = b[b.length - 1];
      x.close = x.open * 3;
      x.high = Math.max(x.high, x.close);
      return !klineSeriesQuality(b).pass;
    });
    test("高周期压力不使用未完成周月", () => {
      const b = makeSynthetic(160), p0 = higherTimeframePressures(b, 8);
      b[b.length - 1].high = 9999;
      return JSON.stringify(higherTimeframePressures(b, 8)) === JSON.stringify(p0);
    });
    test("高周期压力只收缩目标并保持入场止损", () => {
      const b = makeSynthetic(180), f0 = features(b), setup = { anchors: { pressure: f0.close - 1, baseLow: f0.close - 4, baseRange: 3 } };
      const g0 = netGeometry("breakout", f0, setup, f0.close, DEFAULTS);
      const keys = [...new Set(b.map((x) => x.date.slice(0, 7)))], key = keys[keys.length - 5];
      for (const x of b) if (x.date.startsWith(key)) x.high = f0.close + 0.5;
      const f1 = { ...f0, bars: b }, g1 = netGeometry("breakout", f1, setup, f1.close, DEFAULTS);
      return g1.higherPressure && g1.target < g0.target && g1.stop === g0.stop && g1.zoneLo === g0.zoneLo && g1.zoneHi === g0.zoneHi;
    });
    test("盘前首次信号只形成开盘预案而非盘中等待", () => {
      const b = makeBreakoutSynthetic();
      for (let i = 79; i < 85; i++) b[i].low -= 0.4;
      const s = historicalSetup("breakout", b, b, DEFAULTS),
        next = new Date(Date.parse(last(b).date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10),
        r = analyzeSymbol({ code: "sh600000", name: "测试", bars: b, benchmarkBars: b,
          quote: { price: s.geometry.entryPrice, pct: 1 }, now: new Date(next + "T00:00:00Z") });
      return r.status === "NEXT_SESSION_PLAN" && r.statusText === "今日开盘预案·余3次" &&
        r.primary.usedAttempts === 0 && r.primary.remainingAttempts === 3 &&
        r.primary.geometry.zoneHi === s.geometry.zoneHi;
    });
    test("突破连续三次开盘区外即窗口耗尽且不以现价回区复活", () => {
      // v14.5 适配：三通道 maxAge 4（3 次开盘窗口），窗口耗尽需连续三次区外开盘
      const b = makeBreakoutSynthetic();
      for (let i = 79; i < 85; i++) b[i].low -= 0.4;
      const s = historicalSetup("breakout", b, b, DEFAULTS),
        next = new Date(Date.parse(last(b).date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10),
        d2 = new Date(Date.parse(next + "T00:00:00Z") + 864e5).toISOString().slice(0, 10),
        d3 = new Date(Date.parse(d2 + "T00:00:00Z") + 864e5).toISOString().slice(0, 10),
        open = s.geometry.zoneHi + 0.01,
        outside = (d) => ({ date: d, open, high: open, low: open * 0.99, close: open * 0.995, volume: 1e7, amount: open * 1e7 }),
        bars2 = b.concat([outside(next), outside(d2), outside(d3)]),
        now = new Date(d3 + "T12:00:00Z"),
        r = analyzeSymbol({ code: "sh600000", name: "测试", bars: bars2, benchmarkBars: bars2,
          quote: { price: s.geometry.entryPrice, open, high: open, low: open, pct: 1, qtime: now.getTime() }, now }),
        trade = executeTrade(s, { date: next, open, high: open, low: open }, [], "A", DEFAULTS);
      return r.status === "EXPIRED" && r.statusText === "已失效·窗口耗尽" && !r.prefiltered &&
        r.primary.usedAttempts === 3 && r.primary.remainingAttempts === 0 && trade.status === "SKIP";
    });
    test("开盘条件满足转模型待结算而非盘中候选", () => {
      const b = makeBreakoutSynthetic(), s = historicalSetup("breakout", b, b, DEFAULTS),
        next = new Date(Date.parse(last(b).date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10),
        price = s.geometry.entryPrice, now = new Date(next + "T04:00:00Z"),
        r = analyzeSymbol({ code: "sh600000", name: "测试", bars: b, benchmarkBars: b,
          quote: { price, open: price, high: price, low: price, pct: 1, qtime: now.getTime() }, now });
      return r.status === "MODEL_ENTERED" && r.statusText === "开盘已触发·模型待结算" &&
        r.primary.usedAttempts === 1 && r.primary.entryPrice === price && r.primary.remainingAttempts === 0;
    });
    test("回踩一次开盘失败后保留一次等待窗口", () => {
      const now = new Date("2026-10-27T14:00:00Z"),
        r = signalLifecycle({ channel: "pullback", triggerDate: "2026-10-26",
          geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16 },
          signalClose: 10, limitPct: null, bars: [],
          quote: { price: 10, open: 12, high: 12, low: 12, qtime: now.getTime() },
          market: "US", now, config: DEFAULTS });
      return r.status === "WAIT_ENTRY" && r.statusText === "等待下次开盘·余2次" &&
        r.usedAttempts === 1 && r.remainingAttempts === 2;
    });
    test("盘前区内信号标今日开盘并保留完整窗口", () => {
      const b = makeBreakoutSynthetic(), s = historicalSetup("breakout", b, b, DEFAULTS),
        next = new Date(Date.parse(last(b).date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10),
        price = s.geometry.entryPrice,
        r = analyzeSymbol({ code: "sh600000", name: "测试", bars: b, benchmarkBars: b,
          quote: { price, pct: 1 }, now: new Date(next + "T00:00:00Z") });
      return r.status === "NEXT_SESSION_PLAN" && r.statusText === "今日开盘预案·余3次" &&
        r.primary.executionHorizon === "TODAY_OPEN" && r.primary.usedAttempts === 0 &&
        r.primary.remainingAttempts === 3;
    });
    test("盘后按实际开盘结果区分已触发与窗口耗尽", () => {
      const b = makeBreakoutSynthetic(), s = historicalSetup("breakout", b, b, DEFAULTS),
        next = new Date(Date.parse(last(b).date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10),
        price = s.geometry.entryPrice, now = new Date(next + "T12:00:00Z"),
        inside = analyzeSymbol({ code: "sh600000", name: "测试", bars: b, benchmarkBars: b,
          quote: { price, open: price, high: price, low: price, pct: 1, qtime: now.getTime() }, now });
      for (let i = 79; i < 85; i++) b[i].low -= 0.4;
      const outsideSetup = historicalSetup("breakout", b, b, DEFAULTS),
        open = outsideSetup.geometry.zoneHi + 0.01,
        outside = analyzeSymbol({ code: "sh600000", name: "测试", bars: b, benchmarkBars: b,
          quote: { price: outsideSetup.geometry.entryPrice, open, high: open, low: open, pct: 1, qtime: now.getTime() }, now });
      return inside.status === "MODEL_ENTERED" && outside.status === "WAIT_ENTRY" &&
        outside.statusText === "等待下次开盘·余2次" && outside.primary.usedAttempts === 1;
    });
    test("回踩第三次开盘失败后窗口耗尽", () => {
      // v14.5：maxAge 4 → 3 次开盘窗口，需三次区外开盘才耗尽
      const now = new Date("2026-10-28T20:00:00Z"),
        bars = ["2026-10-26", "2026-10-27", "2026-10-28"].map((date) => ({ date, open: 12, high: 12, low: 12, close: 12, volume: 1 })),
        r = signalLifecycle({ channel: "pullback", triggerDate: "2026-10-23",
          geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16 },
          signalClose: 10, limitPct: null, bars,
          quote: { price: 12, open: 12, high: 12, low: 12, qtime: now.getTime() },
          market: "US", now, config: DEFAULTS });
      return r.status === "EXPIRED" && r.statusText === "已失效·窗口耗尽" &&
        r.usedAttempts === 3 && r.remainingAttempts === 0;
    });
    test("等待期间收盘破位立即取消剩余窗口", () => {
      const now = new Date("2026-10-27T20:00:00Z"),
        bars = [
          { date: "2026-10-26", open: 12, high: 12, low: 7, close: 7.5, volume: 1 },
          { date: "2026-10-27", open: 10, high: 10, low: 10, close: 10, volume: 1 },
        ],
        r = signalLifecycle({ channel: "pullback", triggerDate: "2026-10-23",
          geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16 },
          signalClose: 10, limitPct: null, bars,
          quote: { price: 10, open: 10, high: 10, low: 10, qtime: now.getTime() },
          market: "US", now, config: DEFAULTS });
      return r.status === "EXPIRED" && r.statusText === "已失效·结构失效" && r.usedAttempts === 1;
    });
    test("破位完成日K不再允许同日开盘补入场", () => {
      const bars = [{ date: "2026-01-02", open: 10, high: 10.2, low: 7.9, close: 7.8, volume: 1 }],
        r = signalLifecycle({ channel: "breakout", triggerDate: "2026-01-01",
          geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16 },
          signalClose: 10, limitPct: null, bars,
          quote: { price: 7.8, open: 10, high: 10.2, low: 7.9, qtime: Date.parse("2026-01-03T00:00:00Z") },
          market: "US", now: new Date("2026-01-03T00:00:00Z"), config: DEFAULTS });
      return r.status === "EXPIRED" && r.expiredReason === "结构失效" && r.usedAttempts === 1 &&
        !r.attempts.some((x) => x.status === "ENTER");
    });
    test("盘中低点穿透冻结止损开盘模型同步失效", () => {
      const now = new Date("2026-10-27T14:30:00Z"),
        r = signalLifecycle({ channel: "breakout", triggerDate: "2026-10-26",
          geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16 },
          signalClose: 10, limitPct: null, bars: [],
          quote: { price: 10, open: 10, high: 10.2, low: 7.9, qtime: now.getTime() },
          market: "US", now, config: DEFAULTS });
      return r.status === "EXPIRED" && r.expiredReason === "结构失效" && r.usedAttempts === 1;
    });
    test("盘中缺少当日开盘价时禁止猜测剩余窗口", () => {
      const now = new Date("2026-10-27T14:00:00Z"),
        r = signalLifecycle({ channel: "pullback", triggerDate: "2026-10-26",
          geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16 },
          signalClose: 10, limitPct: null, bars: [],
          quote: { price: 10, open: null, qtime: null },
          market: "US", now, config: DEFAULTS });
      return r.status === "DATA_ERROR" && r.statusText.includes("开盘窗口待确认");
    });
    test("次日区内开盘仍须通过净赔率门槛", () => {
      const sig = { geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 12 } },
        r = executeTrade(sig, { date: "2026-01-02", open: 11, high: 11, low: 11 }, [], "US", DEFAULTS);
      return r.status === "SKIP" && r.reason === "开盘成本后净赔率不足";
    });
    test("个股K线落后于市场基准即数据异常", () => {
      const b = makeBreakoutSynthetic(),
        next = new Date(Date.parse(last(b).date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10),
        r = analyzeSymbol({ code: "usTEST", name: "测试", bars: b.slice(0, -1), benchmarkBars: b,
          quote: { price: 10, pct: 0 }, now: new Date(next + "T00:00:00Z") });
      return r.status === "DATA_ERROR" && r.quality.errors.some((x) => x.includes("K线交易日不一致"));
    });
    test("回踩信号可在有效期第二日区内开盘入场", () => {
      const sig = { channel: "pullback", geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16 } },
        days = [
          { date: "2026-01-02", open: 12, high: 12.2, low: 11.8, close: 12 },
          { date: "2026-01-03", open: 10, high: 10.4, low: 9.8, close: 10.2 },
        ],
        r = executeTradeWindow(sig, days, "US", DEFAULTS, 2);
      return r.status === "CLOSED" && r.entryDate === "2026-01-03" && r.entryOffset === 1 && r.attempts.length === 2;
    });
    test("突破信号不越过原有效期等待", () => {
      const sig = { channel: "breakout", geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 12 } },
        days = [
          { date: "2026-01-02", open: 12, high: 12.2, low: 11.8, close: 12 },
          { date: "2026-01-03", open: 10, high: 10.4, low: 9.8, close: 10.2 },
        ],
        r = executeTradeWindow(sig, days, "US", DEFAULTS, 1);
      return r.status === "SKIP" && !r.pending && r.attempts.length === 1;
    });
    test("等待期间收盘破位则取消后续入场", () => {
      const sig = { channel: "pullback", geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 12 } },
        days = [
          { date: "2026-01-02", open: 12, high: 12.2, low: 7.9, close: 7.8 },
          { date: "2026-01-03", open: 10, high: 10.4, low: 9.8, close: 10.2 },
        ],
        r = executeTradeWindow(sig, days, "US", DEFAULTS, 2);
      return r.status === "SKIP" && r.reason === "等待期间收盘触及失效锚点" && r.attempts.length === 1;
    });
    test("分桶诊断少于30笔只报样本不足", () => {
      const trades = Array.from({ length: 29 }, (_, i) => ({ channel: "breakout", Q: i, E: i, S: i, R: 0.1 }));
      return scoreDiagnostics(trades).filter((x) => x.channel === "breakout").every((x) => x.status === "样本不足" && !x.buckets.length);
    });
    test("空间诊断只增加元数据且不改变交易几何", () => {
      const f = features(makeSynthetic(180)),
        setup = { anchors: { pressure: f.close - 1, baseLow: f.close - 4, baseRange: 3 } },
        g = netGeometry("breakout", f, setup, f.close, DEFAULTS),
        moved = repriceGeometry(g, f.close * 1.01, DEFAULTS);
      return g.atrValue > 0 && Number.isFinite(g.targetAtr) && Number.isFinite(g.stopAtr) &&
        moved.stop === g.stop && moved.target === g.target &&
        Math.abs(moved.targetAtr - (g.target - f.close * 1.01) / g.atrValue) < 1e-9;
    });
    test("不足持有期只右删失且保留已可观察固定期限", () => {
      const sig = { geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 20 } },
        entry = { date: "2026-01-01", open: 10, high: 10.2, low: 9.8, close: 10 },
        next = { date: "2026-01-02", open: 10.1, high: 10.5, low: 9.9, close: 10.4 },
        r = executeTrade(sig, entry, [next], "US", DEFAULTS),
        s = replaySummary([{ trades: [{ ...r, channel: "breakout", code: "usTEST" }], skipped: [] }]);
      return r.settled === false && r.fixedHorizon[1].available && s.overall.count === 0 &&
        s.pendingCount === 1 && s.fixedHorizon.find((x) => x.channel === "breakout" && x.horizon === 1).count === 1;
    });
    test("提前目标退出后期限收益锁定且反事实独立", () => {
      const sig = { geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 14 } },
        entry = { date: "2026-01-01", open: 10, high: 10.2, low: 9.8, close: 10 },
        future = Array.from({ length: 10 }, (_, i) => ({
          date: new Date(Date.UTC(2026, 0, 2 + i)).toISOString().slice(0, 10),
          open: i === 0 ? 14 : 15 + i * 0.2,
          high: 15 + i * 0.2,
          low: 10.5,
          close: 15 + i * 0.2,
        })),
        r = executeTrade(sig, entry, future, "US", DEFAULTS);
      return r.settled && r.reason === "GAP_TARGET" && r.fixedHorizon[5].lockedExit &&
        r.fixedHorizon[5].netR === r.R && r.counterfactualPath[5].netR > r.R &&
        Number.isFinite(r.mfeR) && Number.isFinite(r.maeR) && r.firstTargetDay === 1;
    });
    test("A股一字跌停无法按止损价假定退出", () => {
      const sig = { geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 9, target: 16 }, limitPct: 10 },
        entry = { date: "2026-01-01", open: 10, high: 10.2, low: 9.8, close: 10 },
        limitDown = { date: "2026-01-02", open: 8.8, high: 8.8, low: 8.8, close: 8.8 },
        r = executeTrade(sig, entry, [limitDown], "A", DEFAULTS);
      return r.settled === false && r.reason === "LIMIT_DOWN_EXIT_BLOCKED" && r.sawBlockedExit && r.firstStopDay === 1;
    });
    test("A股入场当日不执行止损但记录日内 excursion", () => {
      const sig = { geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 9, target: 20 }, limitPct: 10 },
        entry = { date: "2026-01-01", open: 10, high: 10.2, low: 8.5, close: 10 },
        next = { date: "2026-01-02", open: 10.1, high: 10.5, low: 9.9, close: 10.4 },
        r = executeTrade(sig, entry, [next], "A", DEFAULTS);
      return r.reason === "TIMEOUT" && r.firstStopDay === null && r.maeR < 0 && r.closePath.length === 2;
    });
    test("固定期限统计和未成交漏斗不重复计数", () => {
      const sig = { geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 14 } },
        entry = { date: "2026-01-01", open: 10, high: 10.2, low: 9.8, close: 10 },
        future = Array.from({ length: 10 }, (_, i) => ({ date: `2026-01-${String(i + 2).padStart(2, "0")}`, open: 14, high: 15, low: 10.5, close: 15 })),
        r = executeTrade(sig, entry, future, "US", DEFAULTS),
        skipped = [
          { channel: "breakout", reason: "信号有效期内未出现可执行开盘", attempts: [{ reason: "开盘不在入场区" }, { reason: "开盘不在入场区" }] },
          { channel: "breakout", reason: "等待期间收盘触及失效锚点", attempts: [{ reason: "开盘不在入场区" }] },
        ],
        s = replaySummary([{ trades: [{ ...r, channel: "breakout", code: "usTEST" }], skipped }]),
        outside = s.unfilledFunnel.find((x) => x.key === "OUTSIDE_ZONE"),
        invalidated = s.unfilledFunnel.find((x) => x.key === "INVALIDATED");
      return s.fixedHorizon.filter((x) => x.channel === "breakout" && x.count === 1).length === 4 &&
        outside.count === 1 && outside.pct === 50 && invalidated.count === 1 && s.overall.count === 1;
    });
    test("聚类区间可复现且反事实不进入实际绩效", () => {
      const sig = { geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 14 } },
        entry = { date: "2026-01-01", open: 10, high: 10.2, low: 9.8, close: 10 },
        future = Array.from({ length: 10 }, (_, i) => ({ date: `2026-02-${String(i + 1).padStart(2, "0")}`, open: 14, high: 15, low: 10.5, close: 15 })),
        base = executeTrade(sig, entry, future, "US", DEFAULTS),
        items = [{ trades: ["a", "b"].map((code) => ({ ...base, code, channel: "pullback" })), skipped: [] }],
        a = replaySummary(items), b = replaySummary(items);
      return a.overall.count === 2 && a.overall.confidence.clusters === 2 &&
        JSON.stringify(a.overall.confidence.avgR) === JSON.stringify(b.overall.confidence.avgR) &&
        a.counterfactual.find((x) => x.horizon === 5).targetContinued === 2 && a.overall.avgR === base.R;
    });
    test("A股触发日盘后区内开盘不消耗窗口", () => {
      const now = new Date("2026-10-27T12:00:00Z"),
        r = signalLifecycle({ channel: "pullback", triggerDate: "2026-10-27",
          geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16 },
          signalClose: 10, limitPct: 10, bars: [],
          quote: { price: 10, open: 10, high: 10, low: 10, qtime: now.getTime() },
          market: "A", now, config: DEFAULTS });
      return r.status === "NEXT_SESSION_PLAN" && r.usedAttempts === 0 && r.remainingAttempts === 3;
    });
    test("美股触发日盘后区外开盘不错误失效", () => {
      const now = new Date("2026-10-27T20:00:00Z"),
        r = signalLifecycle({ channel: "breakout", triggerDate: "2026-10-27",
          geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16 },
          signalClose: 10, limitPct: null, bars: [],
          quote: { price: 12, open: 12, high: 12, low: 12, qtime: now.getTime() },
          market: "US", now, config: DEFAULTS });
      return r.status === "NEXT_SESSION_PLAN" && r.usedAttempts === 0 && r.remainingAttempts === 3;
    });
    test("回放显式排除杠杆反向ETF", () => {
      const r = replaySymbol({ code: "usSOXS", name: "SOXS", bars: makeSynthetic(160), market: "US" });
      return !r.trades.length && r.diagnostics.excluded === 1;
    });
    test("回放汇总保留冲突与排除诊断", () => {
      const s = replaySummary([{ code: "usSOXS", trades: [], skipped: [], conflicts: [{ signalDate: "2026-01-02" }], diagnostics: { excluded: 1 } }]);
      return s.diagnostics.conflictCount === 1 && s.diagnostics.excludedSymbols.includes("usSOXS");
    });
    test("趋势回踩实时状态只作影子研究", () => {
      const b = makePullbackSynthetic(), s = historicalSetup("pullback", b, b, DEFAULTS),
        next = new Date(Date.parse(last(b).date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10),
        r = analyzeSymbol({ code: "sh600000", name: "测试", bars: b, benchmarkBars: b,
          quote: { price: s.geometry.entryPrice, pct: 1 }, now: new Date(next + "T00:00:00Z") });
      return s.stage === 3 && r.status === "RESEARCH_ONLY" && r.statusText.includes("影子通道") && !r.prefiltered;
    });
    test("基准首源陈旧时选择报价日佐证的新源", () => {
      const v = arbitrateBenchmarkDate({ market: "US", now: new Date("2026-10-27T21:00:00Z"), quoteDay: "2026-10-27",
        candidates: [{ source: "新浪", date: "2026-10-26" }, { source: "腾讯", date: "2026-10-27" }] });
      return !v.error && v.chosen.source === "腾讯" && v.expectedDate === "2026-10-27" && !!v.warning;
    });
    test("盘中基准只允许完成日且接受前一交易日", () => {
      const v = arbitrateBenchmarkDate({ market: "US", now: new Date("2026-10-28T14:00:00Z"), quoteDay: "2026-10-28",
        candidates: [{ source: "新浪", date: "2026-10-26" }, { source: "腾讯", date: "2026-10-27" }] });
      return !v.error && v.expectedDate === "2026-10-27";
    });
    test("盘后全源陈旧构成市场级异常", () => {
      const v = arbitrateBenchmarkDate({ market: "A", now: new Date("2026-10-27T12:00:00Z"), quoteDay: "2026-10-27",
        candidates: [{ source: "腾讯", date: "2026-10-26" }, { source: "东财", date: "2026-10-26" }] });
      return !!v.error && v.error.includes("市场级日K陈旧");
    });
    test("多源日期冲突且无报价时间时拒绝猜测", () => {
      const v = arbitrateBenchmarkDate({ market: "US", now: new Date("2026-10-27T21:00:00Z"), quoteDay: null,
        candidates: [{ source: "新浪", date: "2026-10-26" }, { source: "腾讯", date: "2026-10-27" }] });
      return !!v.error && v.error.includes("无法独立裁决");
    });
    const intraBase = () => ({
      code: "sh600000", name: "测试", market: "A", now: new Date("2026-10-27T02:00:00Z"), status: "NEXT_SESSION_PLAN",
      primary: { stage: 3, channel: "breakout", age: 0, triggerDate: "2026-10-26", liquidity: { pass: true },
        triggerGeometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16, atrValue: 1, entryPrice: 10 } },
      quote: { price: 10.1, qtime: Date.parse("2026-10-27T02:00:00Z"), amount: 4e6, prevClose: 9.8, high: 10.2, low: 9.9 },
      averageAmount20: 24e6,
      samples: [
        { price: 10, low: 9.8, qtime: Date.parse("2026-10-27T01:58:30Z") },
        { price: 10.1, low: 9.9, qtime: Date.parse("2026-10-27T02:00:00Z") },
      ],
      config: DEFAULTS,
    });
    test("盘中七门通过才形成人工限价提示", () => {
      const a = intradayAdvice(intraBase());
      return a.actionable && a.state === "ACTIONABLE" && a.checks.length === 7 && a.checks.every((x) => x.pass) && a.validOnlyToday;
    });
    test("盘中单次报价只能进入确认中", () => {
      const o = intraBase(); o.samples = o.samples.slice(-1);
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "CONFIRMING" && a.confirmation.count === 1;
    });
    test("重复报价时间不冒充第二次确认", () => {
      const o = intraBase(); o.samples[0].qtime = o.samples[1].qtime;
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "CONFIRMING" && !a.confirmation.spaced;
    });
    test("盘中高于冻结入场区不追价", () => {
      const o = intraBase(); o.quote.price = 12;
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "WAIT_ZONE" && a.title.includes("不追价");
    });
    test("盘中净赔率不足优先于区内提示", () => {
      const o = intraBase(); o.primary.triggerGeometry.target = 10.2;
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "WAIT_RR";
    });
    test("盘中超过执行阈值的陈旧报价禁止操作", () => {
      const o = intraBase(); o.quote.qtime = o.now.getTime() - 4 * 60e3;
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "STALE";
    });
    test("盘中量能节奏不足不能由价格上涨替代", () => {
      const o = intraBase(); o.quote.amount = 1e6;
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "WAIT_VOLUME" && a.volumePace < DEFAULTS.intradayMinVolumePace;
    });
    test("盘中日内触及止损锚点即失效", () => {
      const o = intraBase(); o.quote.low = 7.99;
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "INVALIDATED";
    });
    test("开盘窗口耗尽不自动否决独立盘中模型", () => {
      const o = intraBase(); o.status = "EXPIRED"; o.primary.expiredReason = "窗口耗尽";
      const a = intradayAdvice(o);
      return a.actionable && a.state === "ACTIONABLE";
    });
    test("结构失效同时否决开盘与盘中模型", () => {
      const o = intraBase(); o.status = "EXPIRED"; o.primary.expiredReason = "结构失效";
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "INVALIDATED";
    });
    test("趋势回踩盘中仍只作影子研究", () => {
      const o = intraBase(); o.primary.channel = "pullback"; o.status = "RESEARCH_ONLY";
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "RESEARCH_ONLY";
    });
    test("开盘模型入场后止损提示优先且A股当日不假定可卖", () => {
      const o = intraBase(); o.status = "MODEL_ENTERED"; o.primary.entryDate = "2026-10-27"; o.quote.price = 7.9;
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "RISK_STOP" && a.detail.includes("当日不可卖");
    });
    test("盘前只形成预案不生成挂单指令", () => {
      const o = intraBase(); o.now = new Date("2026-10-27T01:00:00Z"); o.quote.qtime = o.now.getTime();
      const a = intradayAdvice(o);
      return !a.live && !a.actionable && a.state === "NON_SESSION" && a.title.includes("不提前挂单");
    });
    test("无日线预案时盘中上涨不创造信号", () => {
      const o = intraBase(); o.status = "OBSERVING"; o.primary = null; o.quote.price = 20;
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "NO_PLAN";
    });
    test("信号当日盘后即开放七门试算，不再跨日排队", () => {
      const base = intraBase(),
        postSame = {
          ...base,
          now: new Date("2026-10-26T12:00:00Z"),
          quote: { ...base.quote, qtime: Date.parse("2026-10-26T07:00:00Z") },
        },
        aSame = intradayAdvice(postSame);
      return aSame.state !== "WAIT_DATE" && (aSame.state === "NON_SESSION" || aSame.state === "SIMULATED");
    });
    test("信号年龄放宽至2日且须落在冻结区±1%漂移护栏内", () => {
      const o = intraBase(); o.primary.age = 2;
      const a2 = intradayAdvice(o),
        a3 = intradayAdvice({ ...o, primary: { ...o.primary, age: 3 } }),
        aDrift = intradayAdvice({ ...o, quote: { ...o.quote, price: 11.15 } });
      return a2.actionable && a3.state === "EXPIRED" &&
        aDrift.state === "WAIT_ZONE" && !aDrift.actionable;
    });
    test("同一报价与样本重复计算保持纯函数", () => {
      const o = intraBase(), before = JSON.stringify(o), a = intradayAdvice(o), b = intradayAdvice(o);
      return JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(o) === before;
    });
    test("仅净赔率拒绝允许盘中重算而硬拒绝不放行", () => {
      const o = intraBase(); o.status = "REJECTED"; o.primary.reasons = ["当前成本后净赔率低于1"];
      const soft = intradayAdvice(o);
      o.primary.reasons = ["20日平均成交额不足"];
      const hard = intradayAdvice(o);
      return soft.actionable && !hard.actionable && hard.state === "BLOCKED";
    });
    test("开盘模型非盘中不沿用旧价发风险指令", () => {
      const o = intraBase(); o.status = "MODEL_ENTERED"; o.primary.entryDate = "2026-10-27";
      o.now = new Date("2026-10-27T12:00:00Z"); o.quote.qtime = o.now.getTime(); o.quote.price = 7.9;
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "NON_SESSION";
    });
    test("盘中独立结算不还原入场日日内路径", () => {
      const signal = { geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16 }, limitPct: 10 },
        entry = { date: "2026-10-27", open: 10, high: 20, low: 7, close: 10 },
        next = { date: "2026-10-28", open: 9.9, high: 10, low: 7.9, close: 8.2 },
        pending = executeIntradayTrade(signal, entry.date, 10, [entry], "A", DEFAULTS),
        result = executeIntradayTrade(signal, entry.date, 10, [entry, next], "A", DEFAULTS);
      return pending.status === "PENDING" && result.status === "CLOSED" && result.settled && result.reason === "STOP" &&
        result.holdingTradingDays === 1 && result.firstStopDay === 1;
    });
    test("盘中前向汇总与开盘模型分开统计", () => {
      const s = summarizeIntraday([
        { channel: "breakout", done: true, result: { status: "CLOSED", settled: true, R: 1 } },
        { channel: "oversold", done: false },
      ]);
      return s.total === 2 && s.closed === 1 && s.pending === 1 && s.avgR === 1 && s.executionModel === "INTRADAY_V2";
    });
    test("未入场目标越过自动归档且模型入场继续监控", () => {
      const g = { stop: 8, target: 12 };
      return archiveReason("EXPIRED", g, 12) === "目标已越过" &&
        archiveReason("NEXT_SESSION_PLAN", g, 8) === "止损已击穿" &&
        archiveReason("MODEL_ENTERED", g, 12) === null;
    });
    test("整区最优赔率不足可识别且不按现价误判", () => {
      const dead = { valid: true, zoneLo: 9.95, zoneHi: 10, stop: 9, target: 10.1, atrValue: 1 },
        viable = { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 16, atrValue: 1 },
        b = makeBreakoutSynthetic(), cfg = { ...DEFAULTS, minRR: 999 },
        s = historicalSetup("breakout", b, b, cfg),
        next = new Date(Date.parse(last(b).date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10),
        r = analyzeSymbol({ code: "sh600000", name: "测试", bars: b, benchmarkBars: b, config: cfg,
          quote: { price: s.geometry.entryPrice, pct: 1 }, now: new Date(next + "T00:00:00Z") });
      return zoneBestRR(dead, DEFAULTS) < DEFAULTS.minRR && zoneBestRR(viable, DEFAULTS) >= DEFAULTS.minRR &&
        r.status === "RESEARCH_ONLY" && r.statusText === "预筛剔除·整区赔率不足" && r.prefiltered;
    });
    test("开盘止损过近拒绝且不移动结构止损", () => {
      const signal = { signalClose: 10, limitPct: 10,
        geometry: { valid: true, zoneLo: 9, zoneHi: 11, stop: 9.95, target: 16, atrValue: 1 } },
        entry = { date: "2026-10-27", open: 10, high: 10.2, low: 9.9, close: 10 },
        r = openingDecision(signal, entry, "A", DEFAULTS);
      return r.status === "SKIP" && r.reason.includes("止损过近") && signal.geometry.stop === 9.95;
    });
    test("盘中止损过宽优先拒绝且保留原锚点", () => {
      const o = intraBase(); o.primary.triggerGeometry.stop = 5; o.primary.triggerGeometry.target = 30;
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "RISK_DISTANCE" && a.checks.some((x) => x.key === "riskDistance" && !x.pass) &&
        o.primary.triggerGeometry.stop === 5;
    });
    test("突破预告只给条件与预估几何不生成交易记录", () => {
      const p = breakoutPreview(makeSynthetic(180), DEFAULTS);
      return p && p.requiredClose > p.pressure && p.requiredVolume > 0 && p.geometry &&
        p.geometry.zoneLo === p.pressure && !Object.hasOwn(p, "recordOrigin");
    });
    test("旧档案缺少ATR时风险检查兼容且新几何正常拦截", () => {
      const legacy = executionRiskCheck({ stop: 8 }, 10, DEFAULTS),
        current = executionRiskCheck({ stop: 9.9, atrValue: 1 }, 10, DEFAULTS);
      return legacy.pass && legacy.unavailable && !current.pass && current.reason.includes("止损过近");
    });
    test("期限诊断使用同信号配对且聚类区间可计算", () => {
      const make = (code, a, b) => ({ code, channel: "oversold", fixedHorizon: {
        5: { available: true, netR: a }, 10: { available: true, netR: b },
      } }),
        rows = pairedHorizonDiagnostics([make("a", 0.1, 0.4), make("b", 0.2, 0.2)])[0];
      return rows.count === 2 && Math.abs(rows.avgDelta - 0.15) < 1e-9 && rows.confidence.clusters === 2;
    });
    test("尾部集中度与剔除最大盈利后平均R", () => {
      const trades = [5, 1, -1, -1].map((R) => ({ R, status: "CLOSED", settled: true, channel: "oversold" })),
        all = tailConcentrationDiagnostics(trades)[0];
      return all.count === 4 && Math.abs(all.top1Share - 500 / 6) < 1e-9 && Math.abs(all.avgRWithoutTop1 + 1 / 3) < 1e-9;
    });
    test("PF无有限样本时聚类区间保持不可计算", () => {
      const ci = clusterConfidence([{ code: "a", R: 1, status: "CLOSED", settled: true }]);
      return ci.profitFactor === null;
    });
    test("规则插件：否决门与评分修正按序生效", () => {
      const b = makeBreakoutSynthetic();
      globalThis.QuantRules = [
        { id: "t-adj", appliesTo: ["breakout"], scoreAdjust: (q) => 5 },
      ];
      const s1 = historicalSetup("breakout", b, b, DEFAULTS, "A", "sh600000");
      globalThis.QuantRules = [
        { id: "t-veto", appliesTo: ["breakout"], gates: () => "测试否决" },
      ];
      const s2 = historicalSetup("breakout", b, b, DEFAULTS, "A", "sh600000");
      globalThis.QuantRules = [];
      const s0 = historicalSetup("breakout", b, b, DEFAULTS, "A", "sh600000");
      return (
        s1.Q.value === Math.min(100, s0.Q.value + 5) &&
        s2.ruleGate === "测试否决" &&
        s2.appliedRules.includes("t-veto") &&
        !s0.appliedRules.length
      );
    });
    test("盘中触发型超跌：虚拟K线触发并冻结几何", () => {
      const mk = () => {
          const out = [], d0 = Date.parse("2026-01-01T00:00:00Z"),
            push = (close, o, h, l) => {
              out.push({
                date: new Date(d0 + out.length * 864e5).toISOString().slice(0, 10),
                open: o, high: h, low: l, close, volume: 1e6, amount: close * 1e6,
              });
            };
          for (let i = 0; i < 76; i++) push(10 + 0.03 * Math.sin(i * 1.3), 10, 10.06, 9.94);
          push(8.6, 9.9, 9.95, 8.55);
          push(8.65, 8.6, 8.7, 8.57); push(8.7, 8.65, 8.75, 8.6); push(8.68, 8.7, 8.72, 8.6);
          return out;
        },
        now = new Date("2026-10-28T14:00:00Z"),
        r = intradayOversoldPlan(mk(), { price: 9.3, open: 8.7, high: 9.35, low: 8.6, qtime: now.getTime() }, DEFAULTS, "US", now);
      return r && r.channel === "oversold" && r.triggerDate === "2026-10-28" &&
        r.geometry.valid && r.geometry.stop > 0 && r.geometry.stop < 8.9 &&
        r.Q && Number.isFinite(r.Q.value);
    });
    test("A股盘中触发虚拟K线量单位手→股回归", () => {
      const mk = () => {
          const out = [], d0 = Date.parse("2026-01-01T00:00:00Z"),
            push = (close, o, h, l) => {
              out.push({
                date: new Date(d0 + out.length * 864e5).toISOString().slice(0, 10),
                open: o, high: h, low: l, close, volume: 1e6, amount: close * 1e6,
              });
            };
          for (let i = 0; i < 76; i++) push(10 + 0.03 * Math.sin(i * 1.3), 10, 10.06, 9.94);
          push(8.6, 9.9, 9.95, 8.55);
          push(8.65, 8.6, 8.7, 8.57); push(8.7, 8.65, 8.75, 8.6); push(8.68, 8.7, 8.72, 8.6);
          return out;
        },
        now = new Date("2026-10-28T02:00:00Z"),
        r = intradayOversoldPlan(mk(), { price: 9.3, open: 8.7, high: 9.35, low: 8.6, volume: 1e4, qtime: now.getTime() }, DEFAULTS, "A", now);
      return r && r.metrics.volContraction === false && Math.abs(r.metrics.volRatio - 1) < 0.05;
    });
    test("盘中触发只面向阶段①/②且限盘中会话", () => {
      const now = new Date("2026-10-28T14:00:00Z"),
        flat = intradayOversoldPlan(makeSynthetic(140), { price: 20, open: 20, high: 20, low: 20, qtime: now.getTime() }, DEFAULTS, "US", now),
        closed = intradayOversoldPlan(makeSynthetic(140), { price: 20, open: 20, high: 20, low: 20, qtime: now.getTime() }, DEFAULTS, "US", new Date("2026-10-25T14:00:00Z"));
      return flat === null && closed === null;
    });
    test("确认样本超过样本有效期不计入确认", () => {
      const o = intraBase();
      o.config = { ...DEFAULTS, intradaySampleMaxAgeSec: 60 };
      o.samples = o.samples.map((x) => ({ ...x, qtime: x.qtime - 90 * 1000 }));
      const a = intradayAdvice(o);
      return !a.actionable && a.state === "CONFIRMING" && a.confirmation.count < 2;
    });
    // v14.3 回归：涨停可成交检查严格用行情源昨收；缺失时跳过，不用可能陈旧的冻结 triggerPrice 兜底。
    test("涨停判定缺少昨收时跳过可成交检查（不用冻结价兜底）", () => {
      const o = intraBase();
      o.primary.triggerGeometry = { valid: true, zoneLo: 9, zoneHi: 11, stop: 8.4, target: 16, atrValue: 2, entryPrice: 10 };
      o.quote = { price: 10.99, qtime: Date.parse("2026-10-27T02:00:00Z"), amount: 4e6, prevClose: null, high: 10.99, low: 10.99 };
      const a = intradayAdvice(o);
      return a.actionable && a.state === "ACTIONABLE";
    });
    // v14.3 回归：美股盘中报价年龄使用独立阈值 1200 秒（旧 180 秒会让免费延迟行情恒为 STALE）。
    test("美股盘中报价年龄使用独立宽松阈值", () => {
      const now = new Date("2026-10-27T14:00:00Z"),
        o = intraBase();
      o.market = "US"; o.code = "usTEST"; o.now = now;
      o.quote = { price: 10.1, qtime: now.getTime() - 300e3, amount: 4e6, prevClose: 9.8, high: 10.2, low: 9.9 };
      o.samples = [
        { price: 10, low: 9.8, qtime: now.getTime() - 60e3 },
        { price: 10.1, low: 9.9, qtime: now.getTime() },
      ];
      const a = intradayAdvice(o);
      return a.actionable && a.state === "ACTIONABLE";
    });
    // v14.5 回归：RSI 恢复触发器——收复事件日收盘、RSI 修复至≥40，但收盘仍在 MA5 下方。
    // 构造：84 根平台 + 单日暴跌 -14%（z≈-14，事件唯一）+ 4 根小阳企稳 + 末根收复事件收盘
    // 但位于 MA5 下方的阴线；旧触发器（穿头破脚/金叉且站上MA5）在此形态下永不触发。
    test("RSI恢复触发器：收复事件收盘但未过MA5仍触发", () => {
      const out = [], d0 = Date.parse("2026-01-01T00:00:00Z"),
        push = (c, o, h, l) => { out.push({ date: new Date(d0 + out.length * 864e5).toISOString().slice(0, 10), open: o, high: h, low: l, close: c, volume: 1e6, amount: c * 1e6 }); };
      for (let i = 0; i < 84; i++) push(10 + 0.03 * Math.sin(i * 1.3), 10, 10.06, 9.94);
      push(8.5, 9.9, 9.95, 8.45);
            push(8.8, 8.5, 8.860000000000001, 8.46); push(9.1, 8.8, 9.16, 8.760000000000002); push(9.4, 9.1, 9.46, 9.06); push(9.7, 9.4, 9.76, 9.360000000000001);
      push(9.2, 9.7, 9.76, 9.16);
      const s = historicalSetup("oversold", out, null, DEFAULTS, "A", "sh600000");
      return s.stage === 3 && s.metrics.rsiRecover === true && s.metrics.close < s.metrics.ma5;
    });
    // v14.5 回归：通道级净赔率门槛——同一几何（净赔率≈1.41），突破通道拒绝、超跌通道放行。
    test("通道级净赔率门槛：突破1.5拒绝而超跌1.2放行", () => {
      const geometry = { valid: true, zoneLo: 9, zoneHi: 11, stop: 8, target: 12.9, atrValue: 1, entryPrice: 10 },
        entry = { date: "2026-10-27", open: 10, high: 10.1, low: 9.9, close: 10, volume: 1e6, amount: 1e7 },
        skip = openingDecision({ geometry, signalClose: 10, limitPct: null, channel: "breakout" }, entry, "A", DEFAULTS),
        enter = openingDecision({ geometry, signalClose: 10, limitPct: null, channel: "oversold" }, entry, "A", DEFAULTS);
      return skip.status === "SKIP" && skip.reason === "开盘成本后净赔率不足" && enter.status === "ENTER";
    });
    // v14.8 回归：企稳分级降级为评分/警示项——高波动事件（requiredStable=3）未攒够分级根数
    // 时，只要无新低＋有企稳证据＋出现触发器，仍应触发（v13.3 硬门 V 型延迟教训）。
    test("超跌企稳不足分级数即触发（分级降级为评分项）", () => {
      const out = [], d0 = Date.parse("2026-01-01T00:00:00Z"),
        push = (c, o, h, l) => { out.push({ date: new Date(d0 + out.length * 864e5).toISOString().slice(0, 10), open: o, high: h, low: l, close: c, volume: 1e6, amount: c * 1e6 }); };
      for (let i = 0; i < 84; i++) push(10 + 0.03 * Math.sin(i * 1.3), 10, 10.06, 9.94);
      push(7.0, 9.9, 9.95, 6.95);   // 事件日：暴跌约 30%，事件期 ATR% ≥4% → requiredStable=3
      push(7.6, 7.0, 7.7, 6.96);    // 企稳 bar 1（收阳、未破低点缓冲）
      push(8.2, 7.6, 8.3, 7.5);     // 企稳 bar 2
      push(9.2, 8.2, 9.3, 8.1);     // 触发日：阳线收复前高 8.3 且站上 MA5（仅 2 根企稳 < 要求的 3 根）
      const s = historicalSetup("oversold", out, null, DEFAULTS, "A", "sh600000");
      return s.stage === 3 && s.metrics.stableCount === 2 && s.metrics.requiredStable === 3;
    });
    // v14.8 回归：止损上限按通道分级——3.2 ATR 的止损，超跌放行、突破拒绝。
    test("止损上限按通道分级：超跌放宽突破不变", () => {
      const geometry = { valid: true, zoneLo: 9, zoneHi: 11, stop: 6.8, target: 20, atrValue: 1, entryPrice: 10 },
        entry = { date: "2026-10-27", open: 10, high: 10.1, low: 9.9, close: 10, volume: 1e6, amount: 1e7 },
        enter = openingDecision({ geometry, signalClose: 10, limitPct: null, channel: "oversold" }, entry, "A", DEFAULTS),
        skip = openingDecision({ geometry, signalClose: 10, limitPct: null, channel: "breakout" }, entry, "A", DEFAULTS);
      return enter.status === "ENTER" && skip.status === "SKIP" && skip.reason.includes("止损过宽");
    });
    return tests;
  }
  return {
    VERSION,
    STRATEGY_VERSION,
    DEFAULTS,
    CHANNELS,
    clamp,
    mean,
    median,
    normalizeBars,
    klineSeriesQuality,
    higherTimeframePressures,
    features,
    historicalSetup,
    breakoutPreview,
    zoneBestRR,
    channelMinRR,
    executionRiskCheck,
    archiveReason,
    analyzeSymbol,
    replaySymbol,
    replaySummary,
    executeTrade,
    executeTradeWindow,
    executeIntradayTrade,
    summarizeIntraday,
    intradayPlanKey,
    completedBars,
    latestCompletedDate,
    marketSession,
    signalLifecycle,
    intradayAdvice,
    intradayOversoldPlan,
    arbitrateBenchmarkDate,
    openingDecision,
    tzInfo,
    statusLabel,
    statusRank,
    priceLimit,
    repriceGeometry,
    scoreE,
    runSelfTests,
    makeSynthetic,
  };
})();
if (typeof window !== "undefined") window.QuantCore = QuantCore;
if (typeof module !== "undefined" && module.exports) module.exports = QuantCore;
