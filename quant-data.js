/* Quant v13.0 · quant-data.js
   数据适配层：东财/腾讯/新浪 报价、日K、搜索、缓存。被 quant-main.js 启动流程调用；不直接操作判定。
   加载顺序：quant-rules → quant-core → quant-data → quant-journal → quant-ui → quant-main。 */
"use strict";

function runDataAdapterTests() {
    const tests = [], test = (name, fn) => {
      try {
        const r = fn();
        tests.push({ name, pass: r === true, detail: r === true ? "通过" : String(r) });
      } catch (e) {
        tests.push({ name, pass: false, detail: e.message });
      }
    };
    test("美股直接代码与类别股连字符规范化", () =>
      normalizeCode("usDRAM") === "usDRAM" && normalizeCode("usBRK-B") === "usBRK.B");
    test("腾讯与东财美股搜索结果可解析", () => {
      const a = normSearchItem("dram.am", "存储芯片ETF-Roundhill"), b = normSearchItem("105.KLAC", "科磊");
      return a && a.code === "usDRAM" && b && b.code === "usKLAC";
    });
    test("东财美股交易所回退与纳指代码正确", () =>
      emSecidCandidates("usDRAM").join(",") === "105.DRAM,106.DRAM,107.DRAM" &&
      emSecidCandidates("usIXIC").join(",") === "100.IXIC");
    test("腾讯成交额按市场采用正确单位", () =>
      txAmount("1889055778", "usDRAM") === 1889055778 && txAmount("12.5", "sh600519") === 125000);
    test("A股K线量单位常量（腾讯股/新浪股/东财手）", () =>
      TX_A_VOL_UNIT === 1 && SINA_A_VOL_UNIT === 1 && EM_A_VOL_UNIT === 100);
    test("DRAM与科磊本地别名可离线命中", () =>
      searchLocal("dram")[0].code === "usDRAM" && searchLocal("科磊")[0].code === "usKLAC");
    test("美股长历史日K仅保留最近320根", () => {
      const rows = recentKlines(Array.from({ length: 500 }, (_, i) => ({ d: String(i) })));
      return rows.length === 320 && rows[0].d === "180" && rows[319].d === "499";
    });
    return tests;
  }

let jp = 0;

function jsonp(url, ms = 9000) {
    return new Promise((resolve, reject) => {
      const cb = "__q10jp" + jp++,
        s = document.createElement("script");
      let done = false;
      const cleanup = () => {
        clearTimeout(timer);
        try {
          delete window[cb];
        } catch (e) {
          window[cb] = undefined;
        }
        s.remove();
      };
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("JSONP超时"));
      }, ms);
      window[cb] = (data) => {
        if (done) return;
        done = true;
        cleanup();
        resolve(data);
      };
      s.onerror = () => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("JSONP网络错误"));
      };
      s.src =
        url + (url.includes("?") ? "&" : "?") + "cb=" + cb + "&_=" + Date.now();
      document.head.appendChild(s);
    });
  }

async function fetchJSON(url, ms = 9000) {
    const ctl = new AbortController(),
      timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }

async function fetchGBK(url, ms = 9000) {
    const ctl = new AbortController(),
      timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const b = await r.arrayBuffer();
      try {
        return new TextDecoder("gbk").decode(b);
      } catch (e) {
        return new TextDecoder().decode(b);
      }
    } finally {
      clearTimeout(timer);
    }
  }

function emSecidCandidates(code) {
    if (isUS(code)) {
      const s = code.slice(2).toUpperCase(),
        index = { IXIC: "100.IXIC", INX: "100.SPX", DJI: "100.DJIA" }[s];
      return index ? [index] : ["105." + s, "106." + s, "107." + s];
    }
    return [(code.startsWith("sh") ? "1." : "0.") + code.slice(2)];
  }

function parseQuoteTime(raw, market) {
    if (!raw) return null;
    const m = String(raw).match(
      /^(\d{4})[-/]?(\d{2})[-/]?(\d{2})[ T]?(\d{2})?:?(\d{2})?:?(\d{2})?/,
    );
    if (!m) return null;
    const tz = market === "A" ? "Asia/Shanghai" : "America/New_York",
      guess = Date.UTC(
        +m[1],
        +m[2] - 1,
        +m[3],
        +(m[4] || 0),
        +(m[5] || 0),
        +(m[6] || 0),
      );
    try {
      const z = C.tzInfo(new Date(guess), tz),
        local = Date.UTC(
          +z.day.slice(0, 4),
          +z.day.slice(5, 7) - 1,
          +z.day.slice(8, 10),
          Math.floor(z.minute / 60),
          z.minute % 60,
          0,
        );
      return guess + (guess - local);
    } catch (e) {
      return guess;
    }
  }

async function quotesEM(codes) {
    const lut = {},
      out = {};
    codes.forEach((c) => emSecidCandidates(c).forEach((secid) => (lut[secid] = c)));
    const url =
      "https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&fields=f13,f12,f14,f2,f3,f15,f16,f17,f18,f5,f6,f124&secids=" +
      codes.flatMap(emSecidCandidates).join(",");
    const j = await jsonp(url),
      arr = j && j.data && j.data.diff;
    if (!arr) throw new Error("东财报价为空");
    (Array.isArray(arr) ? arr : [arr]).forEach((d) => {
      const code = lut[d.f13 + "." + d.f12],
        price = +d.f2;
      if (!code || !Number.isFinite(price) || price <= 0) return;
      if (!out[code]) out[code] = {
        code,
        name: d.f14 || code,
        price,
        pct: Number.isFinite(+d.f3) ? +d.f3 : null,
        high: +d.f15 || null,
        low: +d.f16 || null,
        open: +d.f17 || null,
        prevClose: +d.f18 || null,
        volume: +d.f5 || 0,
        amount: +d.f6 || null,
        qtime: Number.isFinite(+d.f124) && +d.f124 > 0 ? +d.f124 * 1000 : null,
        source: "东财",
      };
    });
    return out;
  }

function txAmount(raw, code) {
    const value = parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    return isUS(code) ? value : value * 10000;
  }

  // A股日K成交量单位：腾讯/新浪返回"股"，东财返回"手"；统一归一为股。
  // 诊断区"成交额口径"行显示 成交额÷(收盘×量) 比值：≈1为股口径、≈100为手口径；若某源漂移，只改这里对应常量。
    const TX_A_VOL_UNIT = 1,
    SINA_A_VOL_UNIT = 1,
    EM_A_VOL_UNIT = 100;

async function quotesTX(codes) {
    const out = {},
      txt = await fetchGBK(
        "https://qt.gtimg.cn/q=" + codes.join(",") + "&_=" + Date.now(),
      ),
      re = /v_([a-z]{2}[0-9A-Za-z.]+)="([^"]*)"/g;
    let m;
    while ((m = re.exec(txt))) {
      const f = m[2].split("~"),
        price = parseFloat(f[3]),
        pre = parseFloat(f[4]);
      if (!Number.isFinite(price) || price <= 0) continue;
      out[m[1]] = {
        code: m[1],
        name: f[1] || m[1],
        price,
        pct: Number.isFinite(pre) && pre ? ((price - pre) / pre) * 100 : null,
        high: parseFloat(f[33]) || null,
        low: parseFloat(f[34]) || null,
        open: parseFloat(f[5]) || null,
        prevClose: pre || null,
        volume: parseFloat(f[36]) || 0,
        amount: txAmount(f[37], m[1]),
        qtime: parseQuoteTime(f[30], isUS(m[1]) ? "US" : "A"),
        source: "腾讯",
      };
    }
    return out;
  }

async function loadQuotes(codes) {
    const result = {};
    for (let i = 0; i < codes.length; i += 40) {
      const batch = codes.slice(i, i + 40),
        tx = await quotesTX(batch).catch(() => ({})),
        missing = batch.filter((c) => !tx[c]),
        em = missing.length ? await quotesEM(missing).catch(() => ({})) : {};
      for (const code of batch)
        result[code] = tx[code] ||
          em[code] || { code, price: null, error: "双源均无报价" };
      await new Promise((r) => setTimeout(r, 100));
    }
    return result;
  }

const KLINE_CACHE_PREFIX = "quant_v130_k_";

function cacheKey(code) {
    return KLINE_CACHE_PREFIX + code;
  }

function readCache(code, expectedDate = null) {
    try {
      const j = JSON.parse(sessionStorage.getItem(cacheKey(code)) || "null");
      if (j && Date.now() - j.t < 20 * 60e3 && Array.isArray(j.b)) {
        const q = C.klineSeriesQuality(j.b, C.DEFAULTS.minBars),
          market = isUS(code) ? "US" : "A";
        if (!q.pass) return null;
        const actualDate = C.latestCompletedDate(q.bars, market, new Date());
        if (expectedDate && actualDate !== expectedDate) return null;
        return {
          bars: q.bars,
          source: "会话缓存(" + (j.source || "未知") + ")",
          cachedAt: j.t,
          adjustment: j.adjustment || "复权口径未确认",
          adjustmentConfirmed: j.adjustmentConfirmed === true,
        };
      }
    } catch (e) {}
    return null;
  }

function writeCache(code, bars, source, meta) {
    try {
      sessionStorage.setItem(
        cacheKey(code),
        JSON.stringify({
          t: Date.now(),
          b: bars,
          source,
          adjustment: meta && meta.adjustment,
          adjustmentConfirmed: !!(meta && meta.adjustmentConfirmed),
        }),
      );
    } catch (e) {}
  }

function recentKlines(rows) {
    return rows.length > 320 ? rows.slice(-320) : rows;
  }

function acceptKline(input) {
    const q = C.klineSeriesQuality(input, C.DEFAULTS.minBars);
    if (!q.pass) throw new Error(q.errors.join("；"));
    return q.bars;
  }

function klineMeta(source, code) {
    if (!isUS(code) && (source === "腾讯" || source === "东财"))
      return { adjustment: "前复权", adjustmentConfirmed: true };
    return { adjustment: "复权口径未确认", adjustmentConfirmed: false };
  }

async function klineEM(code) {
    let lastError = null;
    for (const secid of emSecidCandidates(code)) {
      try {
        const url =
            "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=" +
            secid +
            "&klt=101&fqt=1&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&beg=0&end=20500101&lmt=320",
          j = await jsonp(url),
          kl = j && j.data && j.data.klines;
        if (!kl || kl.length < 30) throw new Error("东财日K不足");
        const bars = kl.map((s) => {
            const a = s.split(",");
            return {
              date: a[0], open: +a[1], close: +a[2], high: +a[3], low: +a[4],
              volume: +a[5] * (isUS(code) ? 1 : EM_A_VOL_UNIT), amount: Number.isFinite(+a[6]) ? +a[6] : null,
            };
          }),
          norm = C.normalizeBars(bars);
        return acceptKline(norm);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError || new Error("东财日K网络错误");
  }

async function klineTX(code) {
    const keys = isUS(code) && !/^us(IXIC|INX|DJI)$/.test(code)
        ? [code + ".OQ", code + ".N", code + ".AM", code]
        : [code],
      hosts = [
        "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/fqkline/get",
        "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get",
      ];
    let lastError = null;
    for (const host of hosts) {
      for (const key of keys) {
        try {
          const url =
              host + "?param=" + key + ",day,,,320,qfq&_=" + Date.now(),
            j = await fetchJSON(url),
            d = j && j.data && (j.data[key] || j.data[code]),
            arr = d && (d.qfqday || d.day);
          if (!arr) throw new Error("腾讯日K为空");
          const bars = arr.map((k) => ({
              date: k[0],
              open: +k[1],
              close: +k[2],
              high: +k[3],
              low: +k[4],
              volume: +k[5],
              amount: +k[2] * +k[5] * (isUS(code) ? 1 : TX_A_VOL_UNIT),
            })),
            norm = C.normalizeBars(bars);
          return acceptKline(norm);
        } catch (e) {
          lastError = e;
        }
      }
    }
    throw lastError || new Error("腾讯日K网络错误");
  }

function klineSina(code) {
    const us = isUS(code),
      gname = "__q10sina" + jp++,
      rawSym = code.slice(2).toLowerCase(),
      sym = us
        ? ({ ixic: ".ixic", inx: ".inx", dji: ".dji" }[rawSym] || rawSym)
        : code;
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      let done = false;
      const cleanup = () => {
          clearTimeout(timer);
          try {
            delete window[gname];
          } catch (e) {
            window[gname] = undefined;
          }
          s.remove();
        },
        timer = setTimeout(() => {
          if (done) return;
          done = true;
          cleanup();
          reject(new Error("新浪日K超时"));
        }, 8000);
      s.onload = () => {
        if (done) return;
        done = true;
        const arr = window[gname];
        cleanup();
        if (!Array.isArray(arr) || arr.length < 30)
          return reject(new Error("新浪日K不足"));
        const recent = recentKlines(arr),
          raw = us
            ? recent.map((x) => ({
                date: x.d || x.date,
                open: +x.o,
                high: +x.h,
                low: +x.l,
                close: +x.c,
                volume: +x.v,
                amount: +x.c * +x.v,
              }))
            : recent.map((x) => ({
                date: x.day,
                open: +x.open,
                high: +x.high,
                low: +x.low,
                close: +x.close,
                volume: +x.volume,
                amount: +x.close * +x.volume * SINA_A_VOL_UNIT,
              })),
          bars = C.normalizeBars(raw);
        try {
          resolve(acceptKline(bars));
        } catch (e) {
          reject(new Error("新浪日K质量不合格：" + e.message));
        }
      };
      s.onerror = () => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error("新浪日K网络错误"));
      };
      s.src = us
        ? "https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20" +
          gname +
          "=/US_MinKService.getDailyK?symbol=" +
          sym
        : "https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20" +
          gname +
          "=/CN_MarketDataService.getKLineData?symbol=" +
          sym +
          "&scale=240&ma=no&datalen=320";
      document.head.appendChild(s);
    });
  }

async function loadKline(code, force = false, expectedDate = null) {
    if (!force) {
      const cached = readCache(code, expectedDate);
      if (cached) return cached;
    }
    const chain = isUS(code)
      ? [klineSina, klineTX, klineEM]
      : [klineEM, klineTX, klineSina],
      names = isUS(code) ? ["新浪", "腾讯", "东财"] : ["东财", "腾讯", "新浪"],
      errors = [];
    for (let i = 0; i < chain.length; i++) {
      try {
        const bars = acceptKline(await chain[i](code)),
          meta = klineMeta(names[i], code),
          actualDate = C.latestCompletedDate(bars, isUS(code) ? "US" : "A", new Date());
        if (expectedDate && actualDate !== expectedDate)
          throw new Error(`K线交易日不一致：实际 ${actualDate || "—"}，市场基准 ${expectedDate}`);
        writeCache(code, bars, names[i], meta);
        return { bars, source: names[i], ...meta, fallbacks: errors.slice() };
      } catch (e) {
        errors.push(names[i] + ":" + e.message);
      }
    }
    throw new Error("日K三源均失败：" + errors.join(" / "));
  }

function applyKlineMeta(r, k, quote) {
    r.kSource = k.source;
    r.kFallbacks = k.fallbacks || [];
    r.kAdjustment = k.adjustment || "复权口径未确认";
    r.adjustmentConfirmed = k.adjustmentConfirmed === true;
    const warnings = [];
    if (r.market === "A" && !r.adjustmentConfirmed)
      warnings.push("A股K线复权口径未确认，除权除息附近结构需人工复核");
    const lastClose = k.bars && k.bars.length ? k.bars[k.bars.length - 1].close : null;
    if (r.market === "A" && quote && Number.isFinite(quote.price) && Number.isFinite(lastClose)) {
      const diffPct = Math.abs(quote.price / lastClose - 1) * 100,
        limit = C.priceLimit(r.code, r.name);
      if (diffPct > limit + 1)
        warnings.push("现价与最近日K偏离超过单日涨跌幅，可能存在复权、延迟或数据错位");
    }
    r.quality = r.quality || { errors: [], warnings: [] };
    r.quality.warnings = [...(r.quality.warnings || []), ...warnings];
  }

async function universePage(pn) {
    const fs = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048",
      url =
        "https://push2.eastmoney.com/api/qt/clist/get?pn=" +
        pn +
        "&pz=100&po=1&np=1&fltt=2&invt=2&fid=f6&fs=" +
        encodeURIComponent(fs) +
        "&fields=f12,f13,f14,f2,f3,f5,f6,f15,f16,f17,f18,f124";
    const j = await jsonp(url, 10000),
      d = j && j.data,
      arr = d && d.diff;
    if (!d || !arr) throw new Error("全A列表第" + pn + "页为空");
    return { rows: Array.isArray(arr) ? arr : [arr], total: +d.total || 0 };
  }

async function universeSinaPage(pn, node = "hs_a") {
    const url =
      "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=" +
      pn +
      "&num=100&sort=amount&asc=0&node=" + node + "&symbol=&_=" +
      Date.now(),
      arr = await fetchJSON(url, 10000);
    if (!Array.isArray(arr)) throw new Error("新浪全A列表第" + pn + "页异常");
    return { rows: arr, total: null, source: "新浪" };
  }

async function loadUniverse(onProgress, token) {
    try {
      const all = [];
      let total = 0;
      for (let pn = 1; pn <= 60; pn++) {
        if (token !== state.scanToken) return null;
        const page = await universePage(pn);
        total = page.total;
        all.push(...page.rows);
        onProgress(all.length, total || "…", "东财");
        if (all.length >= total || page.rows.length < 100) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      return { all, source: "东财", total };
    } catch (e) {
      log("东财全A列表失败，切换新浪：" + e.message, "error");
      const all = [];
      for (const node of ["hs_a", "hs_bjs"]) {
        for (let pn = 1; pn <= 70; pn++) {
          if (token !== state.scanToken) return null;
          const page = await universeSinaPage(pn, node);
          all.push(...page.rows);
          onProgress(all.length, "…", "新浪/" + node);
          if (page.rows.length < 100) break;
          await new Promise((r) => setTimeout(r, 120));
        }
      }
      if (!all.length) throw new Error("东财与新浪全A列表均失败");
      return { all, source: "新浪", total: null };
    }
  }

function usCodeFromTicker(ticker) {
    return "us" + String(ticker).toUpperCase().replace(/-/g, ".");
  }

function normalizeCode(raw) {
    const s = raw.trim();
    if (/^us[A-Za-z0-9.-]{1,15}$/i.test(s))
      return usCodeFromTicker(s.slice(2));
    if (/^(sh|sz|bj)\d{6}$/.test(s)) return s;
    if (/^\d{6}$/.test(s)) {
      if (/^[48]/.test(s) || /^920/.test(s)) return "bj" + s;
      return (/^[6]/.test(s) ? "sh" : "sz") + s;
    }
    throw new Error("请输入6位A股代码、sh/sz/bj代码或usTicker");
  }

function isCodeLike(v) {
    return /^(sh|sz|bj|us)?[0-9A-Za-z.-]{1,15}$/i.test(String(v).trim()) && (/\d{6}$/.test(String(v).trim()) || /^us/i.test(String(v).trim()));
  }

function normSearchItem(raw, name) {
    const c = String(raw || "").toUpperCase().trim(),
      usEM = c.match(/^(?:105|106|107)\.([A-Z][A-Z0-9.-]{0,14})$/),
      usTX = c.match(/^([A-Z][A-Z0-9.-]{0,14})\.(?:OQ|N|AM)$/);
    let code = null;
    if (usEM) code = usCodeFromTicker(usEM[1]);
    else if (usTX) code = usCodeFromTicker(usTX[1]);
    else if (/^(5|6|9)\d{5}\.(SH|SS)$/.test(c)) code = "sh" + c.slice(0, 6);
    else if (/^(0|1|2|3)\d{5}\.SZ$/.test(c)) code = "sz" + c.slice(0, 6);
    else if (/^([48]\d{5}|920\d{3})\.(BJ|BSE)$/.test(c)) code = "bj" + c.slice(0, 6);
    else if (/^1\.(5|6|9)\d{5}$/.test(c)) code = "sh" + c.slice(2);
    else if (/^0\.([48]\d{5}|920\d{3})$/.test(c)) code = "bj" + c.slice(2);
    else if (/^0\.(0|1|2|3)\d{5}$/.test(c)) code = "sz" + c.slice(2);
    else if (/^([48]\d{5}|920\d{3})$/.test(c)) code = "bj" + c;
    else if (/^(5|6|9)\d{5}$/.test(c)) code = "sh" + c;
    else if (/^(0|1|2|3)\d{5}$/.test(c)) code = "sz" + c;
    const cleanName = String(name || "").replace(/<[^>]+>/g, "").trim();
    return code && cleanName ? { code, name: cleanName } : null;
  }

async function searchEM(kw) {
    const url = "https://searchapi.eastmoney.com/api/suggest/get?input=" + encodeURIComponent(kw) + "&type=14&count=10&token=D43BF722C8E33BDC906FB84D85E326E8",
      j = await jsonp(url, 7000),
      arr = j && j.QuotationCodeTable && j.QuotationCodeTable.Data,
      out = [], seen = new Set();
    for (const d of arr || []) {
      const name = d.SuggestName || d.Name || "";
      for (const raw of [d.QuoteID, d.SecurityId, d.Code]) {
        const it = normSearchItem(raw, name);
        if (it && !seen.has(it.code)) { seen.add(it.code); out.push(it); break; }
      }
    }
    return out;
  }

function searchSmartbox(kw) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      let done = false;
      const cleanup = () => { clearTimeout(timer); script.remove(); };
      const timer = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error("搜索超时")); } }, 6000);
      script.charset = "GBK";
      script.onload = () => {
        if (done) return; done = true; cleanup();
        const out = [], seen = new Set();
        String(window.v_hint || "").split(";").forEach((line) => {
          const f = line.split("~"), it = f.length > 1 && normSearchItem(f[1], f[0]);
          if (it && !seen.has(it.code)) { seen.add(it.code); out.push(it); }
        });
        resolve(out);
      };
      script.onerror = () => { if (!done) { done = true; cleanup(); reject(new Error("搜索失败")); } };
      script.src = "https://smartbox.gtimg.cn/s3/?v=2&q=" + encodeURIComponent(kw) + "&t=all&_=" + Date.now();
      document.head.appendChild(script);
    });
  }

function searchLocal(kw) {
    const q = String(kw || "").trim().toLowerCase(), out = [], seen = new Set();
    if (!q) return out;
    for (const item of LOCAL_SEARCH_ITEMS) {
      if (!item.aliases.some((x) => String(x).toLowerCase().includes(q)) || seen.has(item.code)) continue;
      seen.add(item.code);
      out.push({ code: item.code, name: item.name });
    }
    return out;
  }

let searchSeq = 0, searchTimer = null;

async function searchSymbols(kw) {
    const seq = ++searchSeq;
    $("searchResults").innerHTML = '<div class="empty">正在搜索名称与代码…</div>';
    let items = searchLocal(kw), errors = [];
    if (!items.length) {
      try { items = await searchEM(kw); } catch (e) { errors.push("东财" + e.message); }
    }
    if (!items.length) {
      try { items = await searchSmartbox(kw); } catch (e) { errors.push("腾讯" + e.message); }
    }
    if (seq !== searchSeq) return;
    $("searchResults").innerHTML = items.length
      ? items.map((x) => `<button class="search-result" type="button" data-add-code="${esc(x.code)}" data-add-name="${esc(x.name)}"><span>${esc(x.name)}</span><span class="stock-code">${esc(x.code)}${state.list.some((v) => v[0] === x.code) ? " · 已在池" : ""}</span></button>`).join("")
      : `<div class="empty">未找到可添加标的${errors.length ? "；" + esc(errors.join(" / ")) : ""}。可直接输入完整代码。</div>`;
  }

async function addSymbol() {
    const input = $("addSymbol");
    try {
      const raw = input.value.trim();
      if (!raw) return toast("请输入名称或代码");
      if (!isCodeLike(raw)) return searchSymbols(raw);
      const code = normalizeCode(raw);
      if (state.list.some((x) => x[0] === code))
        return toast("该标的已在研究池");
      $("addBtn").disabled = true;
      $("addBtn").textContent = "校验中";
      const q = await loadQuotes([code]),
        quote = q[code];
      if (!quote || !Number.isFinite(quote.price))
        throw new Error("行情源未确认该代码");
      state.list.push([code, quote.name || code, 0]);
      saveList();
      input.value = "";
      $("searchResults").innerHTML = "";
      renderWatchList();
      toast("已添加 " + quote.name);
      log("研究池新增 " + code + " " + (quote.name || ""));
    } catch (e) {
      $("searchResults").innerHTML =
        '<div class="notice">' + esc(e.message) + "</div>";
    } finally {
      $("addBtn").disabled = false;
      $("addBtn").textContent = "校验并添加";
    }
  }

/* 模块导出（boot 加载校验与外部调试入口） */
globalThis.QuantData = {
  loadQuotes, loadKline, applyKlineMeta, loadUniverse, searchSymbols, addSymbol,
  normalizeCode, runDataAdapterTests,
};
