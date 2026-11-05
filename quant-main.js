/* Quant v14.3 · quant-main.js
   启动与事件层：共享状态、全局工具、模块加载校验、规则插件加载（RULE_MANIFEST）、事件绑定、boot。
   加载顺序：quant-rules → quant-core → quant-data → quant-journal → quant-ui → 本文件（最后）。 */
"use strict";

const C = QuantCore,
    $ = (id) => document.getElementById(id);

const DEFAULT_LIST = [
    ["sh000001", "上证指数", 1],
    ["sz399006", "创业板指", 1],
    ["usIXIC", "纳斯达克综合", 1],
    ["usINX", "标普500", 1],
    ["usDJI", "道琼斯工业", 1],
    ["sh600519", "贵州茅台", 0],
    ["sz000333", "美的集团", 0],
    ["sh601318", "中国平安", 0],
    ["sh600036", "招商银行", 0],
    ["sh600030", "中信证券", 0],
    ["sh600900", "长江电力", 0],
    ["sh601088", "中国神华", 0],
    ["sh600938", "中国海油", 0],
    ["sh601899", "紫金矿业", 0],
    ["sz300750", "宁德时代", 0],
    ["sz002594", "比亚迪", 0],
    ["sh601012", "隆基绿能", 0],
    ["sz000858", "五粮液", 0],
    ["sh600276", "恒瑞医药", 0],
    ["sz300760", "迈瑞医疗", 0],
    ["sh603259", "药明康德", 0],
    ["sz002475", "立讯精密", 0],
    ["sh688981", "中芯国际", 0],
    ["sz000063", "中兴通讯", 0],
    ["sh601138", "工业富联", 0],
    ["sz002230", "科大讯飞", 0],
    ["sh510300", "沪深300ETF", 0],
    ["sh510500", "中证500ETF", 0],
    ["usNVDA", "NVIDIA", 0],
    ["usAAPL", "Apple", 0],
    ["usMSFT", "Microsoft", 0],
    ["usAMZN", "Amazon", 0],
    ["usGOOGL", "Alphabet", 0],
    ["usMETA", "Meta", 0],
  ];

  const LOCAL_SEARCH_ITEMS = DEFAULT_LIST.map((x) => ({
      code: x[0], name: x[1], aliases: [x[0], x[0].replace(/^us/, ""), x[1]],
    })).concat([
      { code: "usDRAM", name: "存储芯片ETF-Roundhill", aliases: ["dram", "roundhill", "roundhill memory etf", "memory etf", "存储芯片", "存储芯片etf", "内存芯片"] },
      { code: "usKLAC", name: "科磊", aliases: ["klac", "kla", "kla corporation", "科磊", "科磊半导体"] },
    ]);

const state = {
    list: [],
    rows: new Map(),
    bars: new Map(),
    quotes: {},
    benchmark: { A: [], US: [] },
    loading: false,
    scanning: false,
    scanToken: 0,
    replaying: false,
    replayToken: 0,
    replayWorker: null,
    replayWorkerUrl: null,
    mode: "watch",
    logs: [],
    config: { ...C.DEFAULTS, deepLimit: 60 },
    scanMeta: null,
    expanded: new Set(),
    pins: new Set(),
    pinOnly: false,
    autoRefresh: false,
    autoMinutes: 5,
    lastRefreshAt: 0,
    intradayLoading: false,
    intradaySeq: 0,
    lastIntradayAt: 0,
    intradayMessage: "尚未执行独立报价刷新",
    intradaySamples: {},
    intradayRecords: [],
    intradayCapturing: false,
    marketHealth: { A: null, US: null },
    loadStartedAt: 0,
    lastReplay: null,
  };

const isUS = (code) => code.startsWith("us"),
    isIndex = (code) =>
      state.list.some((x) => x[0] === code && x[2]) ||
      ["sh000001", "sz399006", "usIXIC", "usINX", "usDJI"].includes(code);

function toast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove("show"), 2800);
  }

function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

function log(msg, type = "info") {
    const line = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} [${type}] ${msg}`;
    state.logs.unshift(line);
    state.logs = state.logs.slice(0, 100);
    $("eventLog").innerHTML = state.logs.map(esc).join("<br>");
  }

function safeGet(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (e) {
      return null;
    }
  }

function safeSet(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
      return true;
    } catch (e) {
      toast("浏览器存储不可用");
      return false;
    }
  }

function validList(a) {
    return (
      Array.isArray(a) &&
      a.every(
        (x) =>
          Array.isArray(x) &&
          /^(sh|sz|bj|us)[0-9A-Za-z.]+$/.test(x[0]) &&
          String(x[1] || "").trim(),
      )
    );
  }

function loadLocal() {
    const saved = safeGet("quant_v10_watchlist");
    state.list = (validList(saved) && saved.length ? saved : DEFAULT_LIST).map(
      (x) => [x[0], x[1], x[2] ? 1 : 0],
    );
    const cfg = safeGet("quant_v10_settings");
    if (cfg) state.config = { ...state.config, ...cfg };
    const pins = safeGet("quant_v10_pins");
    if (Array.isArray(pins)) state.pins = new Set(pins.filter((x) => typeof x === "string"));
    const intraSamples = safeGet("quant_v11_intraday_samples_v1");
    if (intraSamples && typeof intraSamples === "object" && !Array.isArray(intraSamples)) state.intradaySamples = intraSamples;
    const intraRecords = safeGet("quant_v11_intraday_v1");
    if (intraRecords && Array.isArray(intraRecords.entries)) state.intradayRecords = intraRecords.entries;
    const prefs = safeGet("quant_v10_monitor");
    if (prefs) {
      state.autoRefresh = prefs.autoRefresh === true;
      state.autoMinutes = [1, 5, 10].includes(+prefs.autoMinutes) ? +prefs.autoMinutes : 5;
    }
  }

function saveMonitorPrefs() {
    safeSet("quant_v10_monitor", { autoRefresh: state.autoRefresh, autoMinutes: state.autoMinutes });
    safeSet("quant_v10_pins", [...state.pins]);
  }

function saveList() {
    safeSet("quant_v10_watchlist", state.list);
  }

async function pool(items, size, fn) {
    let index = 0;
    const workers = Array.from(
      { length: Math.min(size, items.length) },
      async () => {
        while (index < items.length) {
          const i = index++;
          await fn(items[i], i);
        }
      },
    );
    await Promise.all(workers);
  }

function currentConfig() {
    return {
      ...state.config,
      feeBps: +$("feeBps").value || state.config.feeBps,
      slippageBps: +$("slippageBps").value || state.config.slippageBps,
      holdingDays: +$("holdingDays").value || 10,
    };
  }

function tickClock() {
    const now = new Date(),
      a = C.marketSession("A", now),
      u = C.marketSession("US", now),
      label = {
        REGULAR: "盘中",
        PRE: "盘前",
        POST: "盘后",
        MIDDAY: "午间休市",
        CLOSED: "休市",
      },
      key = a.state + "|" + u.state;
    const localTime = (market) => {
      const z = C.tzInfo(now, market === "A" ? "Asia/Shanghai" : "America/New_York");
      return `${z.day} ${String(Math.floor(z.minute / 60)).padStart(2, "0")}:${String(z.minute % 60).padStart(2, "0")}`;
    };
    $("clockText").textContent = `A股${label[a.state]} · 美股${label[u.state]}`;
    $("clockText").title = `上海 ${localTime("A")}；纽约 ${localTime("US")}；交易日以实际行情日期为准`;
    if (
      state.sessionKey &&
      state.sessionKey !== key &&
      state.rows.size &&
      !state.loading &&
      !state.scanning
    ) {
      log("交易时段变化，重新核对信号状态：" + state.sessionKey + " → " + key);
      refreshSignals(true);
    }
    state.sessionKey = key;
    const hasRegular = [a, u].some((x) => x.state === "REGULAR"),
      lastAuto = hasRegular ? state.lastIntradayAt : state.lastRefreshAt;
    if (state.autoRefresh && !document.hidden && !state.loading && !state.scanning && !state.replaying && !state.intradayLoading && state.rows.size && now - lastAuto >= state.autoMinutes * 60e3) {
      log(hasRegular ? `盘中轻量报价刷新：每${state.autoMinutes}分钟` : `非盘中全量复核：每${state.autoMinutes}分钟`);
      hasRegular ? refreshIntradayQuotes(false) : refreshSignals(true);
    }
    renderIntradayPanel();
  }

async function refreshIntradayQuotes(manual = true) {
    if (state.intradayLoading || state.loading || state.scanning || !state.rows.size) return;
    const seq = ++state.intradaySeq, codes = [...state.rows.keys()];
    state.intradayLoading = true;
    state.intradayMessage = "正在只刷新报价，不重算日K";
    renderIntradayPanel();
    try {
      const quotes = await loadQuotes(codes);
      if (seq !== state.intradaySeq) return;
      let updated = 0;
      for (const r of state.rows.values()) {
        const q = quotes[r.code];
        if (!q || !Number.isFinite(q.price) || q.price <= 0) continue;
        r.price = q.price;
        r.pct = Number.isFinite(q.pct) ? q.pct : null;
        r.quoteTime = q.qtime || null;
        r.source = q.source || "—";
        r.quoteOpen = Number.isFinite(q.open) ? q.open : null;
        r.quoteHigh = Number.isFinite(q.high) ? q.high : null;
        r.quoteLow = Number.isFinite(q.low) ? q.low : null;
        state.quotes[r.code] = q;
        updated++;
      }
      state.lastIntradayAt = Date.now();
      state.intradayMessage = `${updated}/${codes.length} 只报价已更新；日线Q、模型状态与冻结几何未重算`;
      log(`盘中报价层完成：${updated}/${codes.length} 只；未发起全池日K刷新`);
      captureAllIntradaySamples();
      captureIntradayTriggers();
      renderSignals();
      if (manual) toast("盘中报价已更新；七门状态与触发档案已复核");
    } catch (e) {
      state.intradayMessage = "报价刷新失败：" + e.message + "；不沿用旧动作";
      log(state.intradayMessage, "error");
      if (manual) toast(state.intradayMessage);
    } finally {
      if (seq === state.intradaySeq) {
        state.intradayLoading = false;
        renderIntradayPanel();
      }
    }
  }

function updateStatus(text) {
    $("statusLine").textContent = text;
  }

function setProgress(done, total, show = true) {
    $("loadProgress").classList.toggle("hidden", !show);
    $("loadProgress").firstElementChild.style.width =
      (total ? (done / total) * 100 : 0) + "%";
  }

function loadingText(text, done, total) {
    if (!state.loadStartedAt || !done || done >= total) return text;
    const elapsed = (Date.now() - state.loadStartedAt) / 1000,
      remain = Math.max(1, Math.round(((total - done) * elapsed) / done));
    return `${text}；预计剩余约 ${remain} 秒`;
  }

async function loadBenchmarks(force = true) {
    for (const [market, code] of [["A", "sh000001"], ["US", "usIXIC"]]) {
      const now = new Date(), zone = market === "A" ? "Asia/Shanghai" : "America/New_York",
        session = C.marketSession(market, now),
        health = { market, expectedDate: null, quoteDay: null, source: null, candidates: [], error: null, warning: null };
      state.marketHealth[market] = health;
      try {
        const quote = (await loadQuotes([code]))[code],
          // v14.3：A股基准与个股 K 线源统一为 东财→腾讯→新浪（此前基准仍为 腾讯→东财→新浪，
          // 基准/个股复权口径不一致会系统性污染 RS、偏离度与20日高低点）；美股保持 新浪→腾讯→东财。
          chain = market === "US" ? [klineSina, klineTX, klineEM] : [klineEM, klineTX, klineSina],
          names = market === "US" ? ["新浪", "腾讯", "东财"] : ["东财", "腾讯", "新浪"],
          settled = await Promise.all(chain.map(async (fn, i) => {
            try {
              const bars = acceptKline(await fn(code));
              return { bars, source: names[i], date: C.latestCompletedDate(bars, market, now), meta: klineMeta(names[i], code) };
            } catch (e) { return { source: names[i], error: e.message }; }
          })),
          candidates = settled.filter((x) => x.bars && x.date).sort((a, b) => b.date.localeCompare(a.date));
        health.quoteDay = quote && quote.qtime ? C.tzInfo(new Date(quote.qtime), zone).day : null;
        health.candidates = settled.map((x) => ({ source: x.source, date: x.date || null, error: x.error || null }));
        if (!candidates.length)
          throw new Error("三源均无质量合格的参考基准：" + settled.map((x) => x.source + ":" + x.error).join(" / "));
        const verdict = C.arbitrateBenchmarkDate({ market, now, quoteDay: health.quoteDay, candidates }),
          chosen = verdict.chosen;
        health.expectedDate = verdict.expectedDate;
        health.source = chosen.source;
        health.error = verdict.error;
        health.warning = verdict.warning;
        state.benchmark[market] = chosen.bars;
        writeCache(code, chosen.bars, chosen.source, chosen.meta);
        if (health.error) log(`${market} 市场级数据异常：${health.error}`, "error");
        else if (health.warning) log(`${market} 基准日期仲裁：${health.warning}`, "warning");
      } catch (e) {
        state.benchmark[market] = [];
        health.error = e.message;
        log(market + " 参考基准加载失败：" + e.message, "error");
      }
    }
  }

async function refreshSignals(force = true) {
    if (state.loading || state.scanning) return;
    if (state.replaying) cancelReplay(false);
    state.loading = true;
    state.loadStartedAt = Date.now();
    state.mode = "watch";
    state.scanMeta = null;
    $("refreshBtn").disabled = true;
    $("refreshBtn").textContent = "加载中…";
    state.rows.clear();
    state.bars.clear();
    renderSignals();
    updateStatus("正在取得双源报价与参考基准…");
    setProgress(0, state.list.length, true);
    try {
      const codes = state.list.filter((x) => !x[2]).map((x) => x[0]);
      state.quotes = await loadQuotes(codes);
      await loadBenchmarks(force);
      renderEnvironment();
      let done = 0;
      const items = state.list.filter((x) => !x[2]);
      await pool(items, 3, async (item) => {
        const [code, name] = item,
          quote = state.quotes[code];
        try {
          if (!quote || !Number.isFinite(quote.price))
            throw new Error((quote && quote.error) || "无有效报价");
          const market = isUS(code) ? "US" : "A",
            health = state.marketHealth[market],
            expectedDate = C.latestCompletedDate(state.benchmark[market], market, new Date());
          if (health && health.error) throw new Error("市场级数据异常：" + health.error);
          if (!expectedDate) throw new Error(market + " 参考基准缺失，无法核验K线交易日");
          const k = await loadKline(code, force, expectedDate);
          state.bars.set(code, k.bars);
          const r = C.analyzeSymbol({
            code,
            name: quote.name || name,
            market,
            bars: k.bars,
            quote,
            benchmarkBars: state.benchmark[isUS(code) ? "US" : "A"],
            now: new Date(),
            config: state.config,
          });
          applyKlineMeta(r, k, quote);
          state.rows.set(code, r);
        } catch (e) {
          state.rows.set(code, {
            code,
            name,
            market: isUS(code) ? "US" : "A",
            price: quote && quote.price,
            pct: quote && quote.pct,
            source: (quote && quote.source) || "—",
            status: "DATA_ERROR",
            statusText: e.message,
            quality: { errors: [e.message] },
            channels: [],
            primary: null,
            barsDate: null,
            session: C.marketSession(isUS(code) ? "US" : "A"),
          });
          log(code + " " + e.message, "error");
        }
        done++;
        setProgress(done, items.length, true);
        updateStatus(loadingText(`研究池加载 ${done}/${items.length}；失败显式保留，不用旧分数替代`, done, items.length));
        renderSignals();
      });
      const valid = [...state.rows.values()].filter(
        (r) => r.status !== "DATA_ERROR",
      ).length;
      updateStatus(
        `研究池完成：${valid}/${items.length} 只有效；${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      );
      state.lastIntradayAt = Date.now();
      state.intradayMessage = "随全量信号刷新更新报价；日线与冻结几何已复核";
      updateForwardJournal();
      captureAllIntradaySamples();
      updateIntradayJournal();
      captureIntradayTriggers();
      log(`研究池刷新完成，有效 ${valid}/${items.length}`);
    } catch (e) {
      updateStatus("刷新失败：" + e.message);
      log(e.message, "error");
      toast("刷新失败，请查看数据诊断");
    } finally {
      state.loading = false;
      $("refreshBtn").disabled = false;
      $("refreshBtn").textContent = "刷新信号";
      setProgress(0, 1, false);
      state.lastRefreshAt = Date.now();
      renderSignals();
    }
  }

async function scanAllA() {
    if (state.scanning) {
      state.scanToken++;
      state.scanning = false;
      $("scanBtn").textContent = "全A初筛深扫";
      updateStatus("已请求取消扫描；在途请求返回后不再写入结果");
      return;
    }
    if (state.loading) return;
    if (state.replaying) cancelReplay(false);
    const token = ++state.scanToken;
    state.scanning = true;
    state.loadStartedAt = Date.now();
    state.mode = "scan";
    state.rows.clear();
    state.bars.clear();
    state.scanMeta = "正在分页初筛";
    $("scanBtn").textContent = "取消扫描";
    setProgress(0, 1, true);
    renderSignals();
    try {
      const loaded = await loadUniverse(
        (done, total, source) => {
          updateStatus(`全A初筛（${source}）：已读取 ${done}/${total} 只`);
          setProgress(done, Number.isFinite(+total) && +total > 0 ? +total : 6000, true);
        },
        token,
      );
      if (!loaded) return;
      const all = [...new Map(loaded.all.map((d) => [d.symbol || ((+d.f13 === 1 ? "sh" : "sz") + d.f12), d])).values()].map((d) =>
          d.symbol
            ? {
                code: d.symbol,
                name: d.name,
                price: +d.trade,
                pct: Number.isFinite(+d.changepercent) ? +d.changepercent : null,
                high: +d.high || null,
                low: +d.low || null,
                open: +d.open || null,
                prevClose: +d.settlement || null,
                volume: +d.volume || 0,
                amount: +d.amount || null,
                qtime: d.ticktime
                  ? parseQuoteTime(
                      C.tzInfo(new Date(), "Asia/Shanghai").day +
                        " " +
                        d.ticktime,
                      "A",
                    )
                  : null,
              }
            : {
                code: /^([48]|920)/.test(String(d.f12)) ? "bj" + d.f12 : (+d.f13 === 1 ? "sh" : "sz") + d.f12,
                name: d.f14,
                price: +d.f2,
                pct: Number.isFinite(+d.f3) ? +d.f3 : null,
                high: +d.f15 || null,
                low: +d.f16 || null,
                open: +d.f17 || null,
                prevClose: +d.f18 || null,
                volume: +d.f5 || 0,
                amount: +d.f6 || null,
                qtime: +d.f124 ? +d.f124 * 1000 : null,
              },
        ),
        stage1 = all
          .filter((d) => {
            const name = String(d.name || "");
            return (
              Number.isFinite(d.price) &&
              d.price > 0 &&
              d.amount >= state.config.minAmountA &&
              !/ST|退/.test(name)
            );
          })
          .sort((a, b) => b.amount - a.amount),
        deep = stage1.slice(0, +state.config.deepLimit);
      const scanSession = C.marketSession("A", new Date()),
        timingNote = ["REGULAR", "MIDDAY"].includes(scanSession.state) ? "；盘中按累计成交额初筛，与盘后横截面不可直接比较" : "";
      state.scanMeta = `${loaded.source}初筛 ${all.length} 只（北交所 ${all.filter((d) => d.code.startsWith("bj")).length}）→ 当额与风险标记合格 ${stage1.length} 只 → 深扫 ${deep.length} 只${timingNote}`;
      log(state.scanMeta);
      if (!deep.length) throw new Error("初筛后无深扫标的");
      await loadBenchmarks(true);
      renderEnvironment();
      let done = 0;
      await pool(deep, 3, async (d) => {
        if (token !== state.scanToken) return;
        const code = d.code,
          quote = { ...d, source: loaded.source };
        try {
          const health = state.marketHealth.A,
            expectedDate = C.latestCompletedDate(state.benchmark.A, "A", new Date());
          if (health && health.error) throw new Error("市场级数据异常：" + health.error);
          if (!expectedDate) throw new Error("A股参考基准缺失，无法核验K线交易日");
          const k = await loadKline(code, true, expectedDate);
          state.bars.set(code, k.bars);
          const r = C.analyzeSymbol({
            code,
            name: d.name,
            market: "A",
            bars: k.bars,
            quote,
            benchmarkBars: state.benchmark.A,
            now: new Date(),
            config: state.config,
          });
          applyKlineMeta(r, k, quote);
          state.rows.set(code, r);
        } catch (e) {
          if (token !== state.scanToken) return;
          state.rows.set(code, {
            code,
            name: d.name,
            market: "A",
            price: quote.price,
            pct: quote.pct,
            source: loaded.source,
            status: "DATA_ERROR",
            statusText: e.message,
            quality: { errors: [e.message] },
            channels: [],
            primary: null,
            barsDate: null,
            session: C.marketSession("A"),
          });
        }
        done++;
        setProgress(done, deep.length, true);
        updateStatus(loadingText(`全A深扫 ${done}/${deep.length}；${loaded.source}初筛 ${all.length} 只，非全市场逐只深扫`, done, deep.length));
        renderSignals();
      });
      if (token !== state.scanToken) return;
      updateStatus(
        `扫描完成：${state.scanMeta}；有效 ${[...state.rows.values()].filter((r) => r.status !== "DATA_ERROR").length}/${deep.length}`,
      );
      state.lastIntradayAt = Date.now();
      state.intradayMessage = "随全A深扫更新报价；日线与冻结几何已复核";
      log("全A扫描完成");
    } catch (e) {
      if (token === state.scanToken) {
        state.scanMeta = "扫描失败：" + e.message;
        updateStatus(state.scanMeta);
        log(e.message, "error");
        toast("扫描失败，请查看诊断");
      }
    } finally {
      if (token === state.scanToken) {
        state.scanning = false;
        $("scanBtn").textContent = "全A初筛深扫";
        setProgress(0, 1, false);
        renderSignals();
      }
    }
  }

function disposeReplay() {
    if (state.replayWorker) state.replayWorker.terminate();
    if (state.replayWorkerUrl) URL.revokeObjectURL(state.replayWorkerUrl);
    state.replayWorker = null;
    state.replayWorkerUrl = null;
    state.replaying = false;
    $("replayBtn").disabled = false;
    $("replayBtn").textContent = "回放已加载标的";
  }

function cancelReplay(showMessage = true) {
    if (!state.replaying) return;
    state.replayToken++;
    disposeReplay();
    if (showMessage)
      $("replayOutput").innerHTML =
        '<div class="notice">已取消本次回放；未生成不完整汇总，可重新开始。</div>';
    log("已取消回放；已有研究池与信号不受影响");
  }

async function runReplayFallback(items, cfg, token, results, onProgress) {
    for (let i = 0; i < items.length; i++) {
      if (token !== state.replayToken) return;
      const item = items[i];
      results.push(
        C.replaySymbol({
          ...item,
          benchmarkBars: state.benchmark[item.market],
          config: cfg,
        }),
      );
      onProgress(i + 1, items.length, results[results.length - 1]);
      await new Promise((r) => setTimeout(r, 0));
    }
    if (token !== state.replayToken) return;
    const summary = C.replaySummary(results);
    renderReplay(summary, cfg);
    log(
      `回放完成（兼容模式）：${summary.overall.count} 笔成交，${summary.skippedCount} 个未成交信号`,
    );
    disposeReplay();
  }

async function runReplay() {
    if (state.replaying) return cancelReplay();
    if (state.loading || state.scanning) return toast("请等待当前加载结束");
    const codes = [...state.bars.keys()].filter((c) => !isIndex(c));
    if (!codes.length) return toast("没有可回放的已加载日K");
    const cfg = currentConfig(),
      items = codes.map((code) => {
        const row = state.rows.get(code);
        return {
          code,
          name: (row && row.name) || code,
          market: isUS(code) ? "US" : "A",
          bars: state.bars.get(code),
        };
      }),
      token = ++state.replayToken,
      results = [];
    state.replaying = true;
    $("replayBtn").textContent = "取消回放";
    const onProgress = (done, total, result) => {
      if (token !== state.replayToken) return;
      const trades = results.reduce((n, x) => n + (x.trades || []).length, 0),
        skipped = results.reduce((n, x) => n + (x.skipped || []).length, 0);
      $("replayOutput").innerHTML = `<div class="empty"><strong>正在后台回放 ${done} / ${total}</strong>已得到 ${trades} 笔成交、${skipped} 个未成交信号。可切换页面或取消，不会阻塞操作。</div>`;
    };
    $("replayOutput").innerHTML =
      '<div class="empty"><strong>正在启动后台回放</strong>页面可以继续操作；完成前不会展示不完整结论。</div>';
    let workerSourceText = null;
    try {
      workerSourceText = await buildReplayWorkerSource();
    } catch (e) {
      log("回放Worker源码获取失败（多为 file:// 直开环境），切换主线程兼容回放：" + e.message, "warning");
    }
    try {
      if (!workerSourceText) throw new Error("worker source unavailable");
      const blob = new Blob([workerSourceText], {
          type: "text/javascript",
        }),
        workerUrl = URL.createObjectURL(blob),
        worker = new Worker(workerUrl);
      state.replayWorker = worker;
      state.replayWorkerUrl = workerUrl;
      worker.onmessage = (event) => {
        if (token !== state.replayToken) return;
        const data = event.data;
        if (data.type === "progress") {
          results.push(data.result);
          onProgress(data.done, data.total, data.result);
        } else if (data.type === "done") {
          const summary = C.replaySummary(results);
          renderReplay(summary, cfg);
          log(
            `回放完成：${summary.overall.count} 笔成交，${summary.skippedCount} 个未成交信号`,
          );
          disposeReplay();
        } else if (data.type === "error") {
          $("replayOutput").innerHTML =
            '<div class="notice">回放失败：' + esc(data.message) + "</div>";
          disposeReplay();
        }
      };
      worker.onerror = (event) => {
        if (token !== state.replayToken) return;
        event.preventDefault();
        $("replayOutput").innerHTML =
          '<div class="notice">后台回放启动失败：' +
          esc(event.message || "Worker错误") +
          "。请重试或使用支持Web Worker的浏览器。</div>";
        disposeReplay();
      };
      worker.postMessage({ items, benchmark: state.benchmark, config: cfg });
    } catch (e) {
      if (state.replayWorker) state.replayWorker.terminate();
      if (state.replayWorkerUrl) URL.revokeObjectURL(state.replayWorkerUrl);
      state.replayWorker = null;
      state.replayWorkerUrl = null;
      log("Web Worker不可用，回放切换兼容模式：" + e.message, "error");
      try {
        await runReplayFallback(items, cfg, token, results, onProgress);
      } catch (fallbackError) {
        if (token === state.replayToken) {
          $("replayOutput").innerHTML =
            '<div class="notice">回放失败：' +
            esc(fallbackError.message) +
            "</div>";
          disposeReplay();
        }
      }
    }
  }

function bindEvents() {
    document.querySelectorAll("[data-view]").forEach((btn) =>
      btn.addEventListener("click", () => {
        document
          .querySelectorAll("[data-view]")
          .forEach((x) => x.setAttribute("aria-selected", String(x === btn)));
        document
          .querySelectorAll(".view")
          .forEach((v) =>
            v.classList.toggle("active", v.id === "view-" + btn.dataset.view),
          );
      }),
    );
    $("refreshBtn").addEventListener("click", refreshSignals);
    $("intradayBtn").addEventListener("click", () => refreshIntradayQuotes(true));
    $("scanBtn").addEventListener("click", () => { $("watchDialog").close(); scanAllA(); });
    ["filterText", "filterStatus", "filterChannel", "filterMarket", "sortMode"].forEach((id) =>
      $(id).addEventListener(
        id === "filterText" ? "input" : "change",
        renderSignals,
      ),
    );
    ["observeText", "observeChannel"].forEach((id) =>
      $(id).addEventListener(
        id === "observeText" ? "input" : "change",
        renderObservations,
      ),
    );
    $("autoBtn").addEventListener("click", () => {
      state.autoRefresh = !state.autoRefresh;
      saveMonitorPrefs();
      renderAutoButton();
      toast(state.autoRefresh ? `已开启${state.autoMinutes}分钟自动刷新：盘中仅报价，非盘中全量复核` : "已关闭自动刷新");
    });
    $("setAutoMinutes").addEventListener("change", () => {
      state.autoMinutes = +$("setAutoMinutes").value;
      saveMonitorPrefs();
      renderAutoButton();
    });
    $("pinFilterBtn").addEventListener("click", () => {
      state.pinOnly = !state.pinOnly;
      $("pinFilterBtn").textContent = state.pinOnly ? "钉住：仅已钉" : "钉住：全部";
      $("pinFilterBtn").setAttribute("aria-pressed", String(state.pinOnly));
      renderSignals();
    });
    $("signalRows").addEventListener("click", (e) => {
      const pin = e.target.closest("[data-pin]");
      if (pin) {
        e.stopPropagation();
        const code = pin.dataset.pin;
        state.pins.has(code) ? state.pins.delete(code) : state.pins.add(code);
        saveMonitorPrefs();
        renderSignals();
        return;
      }
      const tr = e.target.closest("tr.signal-row");
      if (!tr) return;
      const code = tr.dataset.code;
      state.expanded.has(code)
        ? state.expanded.delete(code)
        : state.expanded.add(code);
      renderSignals();
    });
    $("signalRows").addEventListener("keydown", (e) => {
      if (!["Enter", " "].includes(e.key) || e.target.closest("[data-pin]")) return;
      const tr = e.target.closest("tr.signal-row");
      if (!tr) return;
      e.preventDefault();
      tr.click();
    });
    $("manageBtn").addEventListener("click", () => {
      renderWatchList();
      openDialog("watchDialog");
    });
    $("settingsBtn").addEventListener("click", () => {
      if ($("watchDialog").open) $("watchDialog").close();
      $("setMinRR").value = state.config.minRR;
      $("setDeepLimit").value = state.config.deepLimit;
      $("setMinAmountA").value = state.config.minAmountA / 1e4;
      $("setMinAmountUS").value = state.config.minAmountUS / 1e4;
      $("setAutoMinutes").value = state.autoMinutes;
      openDialog("settingsDialog");
    });
    document
      .querySelectorAll("[data-close]")
      .forEach((b) =>
        b.addEventListener("click", () => $(b.dataset.close).close()),
      );
    document.querySelectorAll("dialog").forEach((d) =>
      d.addEventListener("click", (e) => {
        if (e.target === d) d.close();
      }),
    );
    $("addBtn").addEventListener("click", addSymbol);
    $("addSymbol").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addSymbol();
    });
    $("addSymbol").addEventListener("input", () => {
      clearTimeout(searchTimer);
      const kw = $("addSymbol").value.trim();
      if (!kw || isCodeLike(kw)) {
        searchSeq++;
        $("searchResults").innerHTML = "";
        return;
      }
      searchTimer = setTimeout(() => searchSymbols(kw), 450);
    });
    $("searchResults").addEventListener("click", (e) => {
      const b = e.target.closest("[data-add-code]");
      if (!b) return;
      if (state.list.some((x) => x[0] === b.dataset.addCode)) return toast("该标的已在研究池");
      $("addSymbol").value = b.dataset.addCode;
      addSymbol();
    });
    $("watchList").addEventListener("click", (e) => {
      const b = e.target.closest("[data-remove]");
      if (!b) return;
      const removed = state.list[+b.dataset.remove];
      state.list.splice(+b.dataset.remove, 1);
      if (removed) state.pins.delete(removed[0]);
      saveMonitorPrefs();
      saveList();
      renderWatchList();
    });
    $("exportBtn").addEventListener("click", () => {
      downloadJSON({ version: C.VERSION, type: "objective-watchlist", items: state.list, pins: [...state.pins] }, `quant_${C.VERSION}_客观研究池.json`);
    });
    $("importBtn").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", async (e) => {
      try {
        const file = e.target.files[0];
        if (!file) return;
        const j = JSON.parse(await file.text()),
          items = j.items || j;
        if (!validList(items) || !items.length)
          throw new Error("文件不是有效的v10/v11/v12研究池");
        state.list = items.map((x) => [x[0], x[1], x[2] ? 1 : 0]);
        const codes = new Set(state.list.map((x) => x[0]));
        state.pins = new Set((Array.isArray(j.pins) ? j.pins : []).filter((x) => codes.has(x)));
        saveMonitorPrefs();
        saveList();
        renderWatchList();
        toast("研究池已导入，刷新后生效");
      } catch (err) {
        toast("导入失败：" + err.message);
      }
      e.target.value = "";
    });
    $("resetBtn").addEventListener("click", () => {
      if (!confirm("恢复默认客观研究池？当前本机研究池将被替换。")) return;
      state.list = DEFAULT_LIST.map((x) => x.slice());
      state.pins.clear();
      saveMonitorPrefs();
      saveList();
      renderWatchList();
      toast("已恢复默认池");
    });
    $("saveSettings").addEventListener("click", () => {
      const minRR = +$("setMinRR").value,
        deepLimit = +$("setDeepLimit").value,
        minA = +$("setMinAmountA").value * 1e4,
        minUS = +$("setMinAmountUS").value * 1e4;
      if (minRR < 1 || minRR > 5 || minA < 0 || minUS < 0)
        return toast("设置超出允许范围");
      state.config = {
        ...state.config,
        minRR,
        deepLimit,
        minAmountA: minA,
        minAmountUS: minUS,
      };
      safeSet("quant_v10_settings", state.config);
      $("settingsDialog").close();
      toast("设置已保存，请刷新信号");
    });
    $("replayBtn").addEventListener("click", runReplay);
    $("exportReplayBtn").addEventListener("click", () => {
      if (!state.lastReplay) return toast("请先完成一次完整回放");
      downloadJSON({ type: "objective-replay", ...state.lastReplay }, `quant_${C.VERSION}_完整回放.json`);
    });
    $("exportIntradayBtn").addEventListener("click", () => {
      downloadJSON({ type: "intraday-forward-journal", exportedAt: new Date().toISOString(), entries: intradayEntries() }, `quant_${C.VERSION}_盘中触发与前向.json`);
    });
    $("clearIntradayBtn").addEventListener("click", () => {
      if (!intradayEntries().length && !Object.keys(state.intradaySamples).length) return toast("当前没有盘中记录或样本");
      if (!confirm("清空当前浏览器中的盘中触发档案与确认样本？此操作不可撤销；开盘模型记录和研究池不受影响。")) return;
      saveIntraday([]); state.intradaySamples = {}; saveIntradaySamples();
      renderIntradayJournal(); renderSignals(); toast("盘中触发档案与确认样本已清空");
    });
    $("exportForwardBtn").addEventListener("click", () => {
      downloadJSON({ type: "objective-forward-journal", strategyVersion: C.STRATEGY_VERSION, exportedAt: new Date().toISOString(), entries: forwardEntries() }, `quant_${C.VERSION}_开盘模型前向.json`);
    });
    $("clearForwardBtn").addEventListener("click", () => {
      if (!forwardEntries().length) return toast("当前没有前向记录");
      if (!confirm("清空当前浏览器中的全部前向观察记录？此操作不可撤销；研究池不受影响。")) return;
      saveForward([]);
      renderForward();
      toast("前向观察记录已清空");
    });
  }

/* ─────────────────────────── v13.0 模块化启动与规则插件 ─────────────────────────── */

  /* 新增规则插件：把 rule-*.js 放到本目录，并在下方加一行 { file: "rule-xxx.js", v: "1.0" } 即可，内核不动。 */
  const RULE_MANIFEST = [
  ];

  function fatal(msg) {
    const f = $("fatal");
    if (f) {
      f.style.display = "block";
      f.textContent = msg;
    }
    try {
      log(msg, "error");
    } catch (e) {}
  }

  function loadScript(file, v) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = file + "?v=" + encodeURIComponent(v);
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(file));
      document.head.appendChild(s);
    });
  }

  async function loadExtraRules() {
    const seen = new Set();
    for (const r of RULE_MANIFEST) {
      const before = (globalThis.QuantRules || []).length;
      try {
        await loadScript(r.file, r.v);
      } catch (e) {
        fatal("规则文件加载失败：" + r.file + "；已停止启动，避免半套规则运行。");
        throw e;
      }
      const added = (globalThis.QuantRules || []).slice(before);
      if (!added.length) {
        fatal("规则文件 " + r.file + " 未注册任何规则（需向 window.QuantRules push 规则对象）。");
        throw new Error("empty rule file: " + r.file);
      }
      for (const rule of added) {
        if (!rule || typeof rule.id !== "string" || !rule.id) {
          fatal("规则文件 " + r.file + " 存在缺少 id 的规则对象。");
          throw new Error("bad rule in " + r.file);
        }
        if (seen.has(rule.id)) {
          fatal("规则 id 重复：" + rule.id);
          throw new Error("dup rule id: " + rule.id);
        }
        seen.add(rule.id);
      }
      log("规则插件加载：" + r.file + "（" + added.map((x) => x.id).join("、") + "）");
    }
  }

  const WORKER_BOOT = `
self.onmessage = (event) => {
        const { items, benchmark, config } = event.data;
        try {
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const result = QuantCore.replaySymbol({
              ...item,
              benchmarkBars: benchmark[item.market],
              config,
            });
            self.postMessage({ type: "progress", done: i + 1, total: items.length, result });
          }
          self.postMessage({ type: "done" });
        } catch (error) {
          self.postMessage({ type: "error", message: error.message || String(error) });
        }
      };`;

  async function buildReplayWorkerSource() {
    const v = encodeURIComponent(
        (globalThis.QRULES && globalThis.QRULES.VERSION) || String(Date.now())),
      fetchText = (file) =>
        fetch(file + "?v=" + v, { cache: "no-store" }).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.text();
        }),
      parts = await Promise.all([
        fetchText("quant-rules.js"),
        ...RULE_MANIFEST.map((r) => fetchText(r.file)),
        fetchText("quant-core.js"),
      ]);
    return parts.join("\n") + WORKER_BOOT;
  }

  async function boot() {
    const missing = [];
    if (!window.QuantCore) missing.push("quant-core.js");
    if (!window.QuantData) missing.push("quant-data.js");
    if (!window.QuantJournal) missing.push("quant-journal.js");
    if (!window.QuantUI) missing.push("quant-ui.js");
    if (missing.length) {
      fatal("核心模块加载失败：" + missing.join("、") + "；请确认全部文件与 quant.html 同目录上传后刷新。");
      return;
    }
    try {
      await loadExtraRules();
    } catch (e) {
      return;
    }
    loadLocal();
    bindEvents();
    renderWatchList();
    renderAutoButton();
    renderForward();
    renderIntradayJournal();
    $("pinFilterBtn").textContent = state.pinOnly ? "钉住：仅已钉" : "钉住：全部";
    $("pinFilterBtn").setAttribute("aria-pressed", String(state.pinOnly));
    renderDiagnostics();
    tickClock();
    setInterval(tickClock, 30000);
    log(
      "Quant " + C.VERSION + " 内核已加载：" +
        getSelfTests().filter((x) => x.pass).length +
        "/" +
        getSelfTests().length +
        " 项自测通过",
    );
    refreshSignals(false);
  }

  boot();
