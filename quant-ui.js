/* Quant v13.0 · quant-ui.js
   渲染层：信号台、详情、回放汇总、诊断等全部 DOM 渲染。只读 state，不改判定逻辑。
   加载顺序：quant-rules → quant-core → quant-data → quant-journal → quant-ui → quant-main。 */
"use strict";

let selfTestCache = null;

function getSelfTests() {
    if (!selfTestCache) {
      const ruleTests = (globalThis.QuantRules || []).flatMap((rule) => {
        if (typeof rule.selfTest !== "function") return [];
        try {
          const ok = rule.selfTest();
          return [
            {
              name: "规则·" + rule.id,
              pass: ok === true,
              detail: ok === true ? "通过" : String(ok),
            },
          ];
        } catch (e) {
          return [{ name: "规则·" + rule.id, pass: false, detail: e.message }];
        }
      });
      selfTestCache = C.runSelfTests().concat(
        runForwardAuditTests(),
        runDataAdapterTests(),
        ruleTests,
      );
    }
    return selfTestCache;
  }

const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

const fmt = (x, d = 2) =>
    Number.isFinite(Number(x)) ? Number(x).toFixed(d) : "—";

const shortDate = (x) => (x ? String(x).slice(5, 10) : "—");

function renderAutoButton() {
    $("autoBtn").textContent = state.autoRefresh ? `自动：${state.autoMinutes}分钟` : "自动：关";
    $("autoBtn").setAttribute("aria-pressed", String(state.autoRefresh));
    $("autoBtn").title = state.autoRefresh
      ? `盘中每${state.autoMinutes}分钟只刷新报价；非盘中才全量复核日K与信号`
      : "开启后，盘中轻量刷新报价，非盘中全量复核信号";
  }

function statusClass(s) {
    if (s === "MODEL_ENTERED") return "current";
    if (s === "NEXT_SESSION_PLAN") return "plan";
    if (s === "WAIT_ENTRY") return "wait";
    if (["RESEARCH_ONLY", "EXPIRED", "ARCHIVED"].includes(s)) return "research";
    return ["DATA_ERROR", "REJECTED", "UNTRADABLE", "MANUAL_REVIEW", "UNSUPPORTED"].includes(s)
      ? "error" : "";
  }

const rank = (s) => C.statusRank(s);

function eligibleRow(r) {
    return ["NEXT_SESSION_PLAN", "WAIT_ENTRY"].includes(r.status) || currentIntraday(r).actionable;
  }

function filteredRows() {
    const text = $("filterText").value.trim().toLowerCase(),
      status = $("filterStatus").value,
      channel = $("filterChannel").value,
      market = $("filterMarket").value,
      sort = $("sortMode").value;
    let rows = [...state.rows.values()].filter((r) => !isIndex(r.code));
    if (status !== "ARCHIVED") rows = rows.filter((r) => r.status !== "ARCHIVED");
    if (!["all", "PREFILTERED", "ARCHIVED"].includes(status)) rows = rows.filter((r) => !r.prefiltered);
    rows = rows.filter(
      (r) =>
        (!text || (r.name + " " + r.code).toLowerCase().includes(text)) &&
        (market === "all" || r.market === market) &&
        (!state.pinOnly || state.pins.has(r.code)) &&
        (status === "all" ||
          (status === "PREFILTERED"
            ? r.prefiltered
            : status === "eligible" ? eligibleRow(r) : status === "INTRADAY_ACTION" ? currentIntraday(r).actionable : r.status === status)) &&
        (channel === "all" ||
          r.channels.some(
            (c) => c.channel === channel && c.status !== "OBSERVING",
          )),
    );
    rows.sort((a, b) => {
      const intraDiff = sort === "status" ? Number(currentIntraday(b).actionable) - Number(currentIntraday(a).actionable) : 0;
      if (intraDiff) return intraDiff;
      const ar = rank(a.status) - rank(b.status);
      if (ar) return ar;
      const ageDiff =
        ((a.primary && a.primary.age) ?? 99) -
        ((b.primary && b.primary.age) ?? 99);
      if (sort === "fresh") return ageDiff || a.code.localeCompare(b.code);
      if (ageDiff) return ageDiff;
      if (a.primary && b.primary && a.primary.channel !== b.primary.channel)
        return a.primary.channel.localeCompare(b.primary.channel);
      if (sort === "rr")
        return (
          ((b.primary && b.primary.geometry.netRR) || -1) -
            ((a.primary && a.primary.geometry.netRR) || -1) ||
          a.code.localeCompare(b.code)
        );
      return (
        ((b.primary && b.primary.S) || -1) -
          ((a.primary && a.primary.S) || -1) || a.code.localeCompare(b.code)
      );
    });
    return rows;
  }

function statusReason(r) {
    const p = r.primary;
    if (!p || p.stage !== 3 || !["REJECTED", "RESEARCH_ONLY"].includes(r.status)) return "";
    const g = p.geometry;
    if (r.status === "RESEARCH_ONLY" && g && g.netRR >= 1 && g.netRR < state.config.minRR)
      return `净赔率 ${fmt(g.netRR, 2)}∶1＜${fmt(state.config.minRR, 1)}∶1`;
    return (p.reasons || [])[0] || "未通过执行门槛";
  }

function actionGuidance(r) {
    const p = r.primary && r.primary.stage === 3 ? r.primary : null,
      g = p && (p.triggerGeometry || p.geometry),
      zone = g ? `${fmt(g.zoneLo)}～${fmt(g.zoneHi)}` : "—",
      rr = g && Number.isFinite(g.netRR) ? `${fmt(g.netRR)}∶1` : "—";
    if (!p) {
      if (r.status === "DATA_ERROR") return { title: "不操作｜先修复数据", detail: (r.quality && r.quality.errors[0]) || r.statusText };
      if (r.status === "UNSUPPORTED") return { title: "不适用｜不生成交易候选", detail: r.statusText };
      return { title: "继续观察｜尚未触发", detail: r.statusText || "等待通道条件成立" };
    }
    switch (r.status) {
      case "NEXT_SESSION_PLAN":
        return { title: "仅作预案｜不提前挂单", detail: `冻结区 ${zone}；盘前只看情景，盘中五门通过后才人工限价评估，未触发当日作废。` };
      case "WAIT_ENTRY":
        return { title: "开盘模型等待｜盘中独立确认", detail: `原开盘模型余 ${p.remainingAttempts ?? "—"} 次窗口；盘中另按 ${zone} 与五门确认，不相互冒充成交。` };
      case "MODEL_ENTERED":
        return { title: "开盘模型已入场｜不是新买点", detail: `${p.entryDate || "入场日待核"} 已触发；模型止损 ${fmt(g.stop)}、目标 ${fmt(g.target)}，不重复追加。` };
      case "RESEARCH_ONLY":
        return { title: "只观察｜不开仓", detail: `${statusReason(r) || "执行条件不足"}；高分不能抵消硬门槛。` };
      case "REJECTED": {
        const hard = (p.reasons || []).some((x) => !String(x).includes("净赔率"));
        return hard
          ? { title: "放弃｜硬门槛未通过", detail: `${statusReason(r) || r.statusText}；不能由盘中价格或高分抵消。` }
          : { title: "当前净赔率未过｜盘中重核", detail: `${statusReason(r) || r.statusText}；若价格回到冻结区，仍须重新通过全部五门。` };
      }
      case "ARCHIVED":
        return { title: "已归档｜不再执行", detail: `${p.archiveReason || "目标或止损已越过"}；未入场旧信号退出当前队列，历史研究保留。` };
      case "EXPIRED":
        return p.expiredReason === "窗口耗尽"
          ? { title: "开盘模型结束｜盘中另行核验", detail: "开盘窗口耗尽可能只代表开盘价不合格；独立盘中模型仍须重新检查结构、年龄与五门。" }
          : { title: "不再操作｜信号结构失效", detail: r.statusText || "不沿用旧入场区，不以盘中反弹复活信号。" };
      case "MANUAL_REVIEW":
        return { title: "先人工复核｜暂不操作", detail: "超跌与突破通道判断冲突，不能静默选择高分通道。" };
      case "UNTRADABLE":
        return { title: "不可成交｜不操作", detail: r.statusText };
      default:
        return { title: "暂不操作｜等待复核", detail: "当前没有可执行动作" };
    }
  }

function signedPct(v, d = 1) {
    if (!Number.isFinite(v)) return "—";
    return `${v > 0 ? "+" : ""}${fmt(v, d)}%`;
  }

function rrLineText(g) {
    if (!g || !g.valid || !Number.isFinite(g.netRR) || g.netRR <= 0)
      return "净赔率 —";
    const minRR = state.config.minRR || C.DEFAULTS.minRR,
      gateGap = (g.netRR / minRR - 1) * 100,
      excellentGap = (g.netRR / 2 - 1) * 100;
    const gate = `${g.netRR >= minRR ? "高于" : "低于"}门槛${fmt(minRR, 1)}：${signedPct(gateGap)}`,
      excellent = g.netRR >= 2 ? "已达2.0以上" : `距2.0：${signedPct(excellentGap)}`;
    return `净赔率 ${fmt(g.netRR, 2)}∶1｜${gate}；${excellent}`;
  }

function entryLineText(g, price) {
    if (!g || !Number.isFinite(price) || !Number.isFinite(g.zoneLo) || !Number.isFinite(g.zoneHi) || g.zoneHi < g.zoneLo)
      return "入场区 —";
    const mid = (g.zoneLo + g.zoneHi) / 2,
      midPct = (price / mid - 1) * 100,
      zone = `入场区 ${fmt(g.zoneLo)}～${fmt(g.zoneHi)}`;
    if (price >= g.zoneLo && price <= g.zoneHi)
      return `${zone}｜现价在区内，距中点 ${signedPct(midPct)}`;
    if (price > g.zoneHi) {
      const diff = price - g.zoneHi, diffPct = diff / g.zoneHi * 100;
      return `${zone}｜高出上沿 ${fmt(diff)}（${signedPct(diffPct)}），距中点 ${signedPct(midPct)}${diffPct <= 0.5 ? "｜贴上沿外" : "｜已离开入场区"}`;
    }
    const diff = g.zoneLo - price, diffPct = diff / g.zoneLo * 100;
    return `${zone}｜低于下沿 ${fmt(diff)}（${signedPct(diffPct)}），距中点 ${signedPct(midPct)}`;
  }

function freshLineText(p) {
    if (!p) return "信号 —";
    return `信号：${p.triggerDate || "—"}${p.age === 0 ? "首次触发" : `触发后${p.age}日`}｜开盘窗 ${p.usedAttempts ?? 0}/${p.maxAttempts ?? "—"}，余 ${p.remainingAttempts ?? "—"} 次`;
  }

function scoreBadgeHTML(p, preview = false) {
    if (!p || !p.Q) return `<span class="score-badge">未形成评分</span>`;
    const q = fmt(p.Q.value, 1), e = p.E ? fmt(p.E.value, 1) : "—", s = Number.isFinite(p.S) ? fmt(p.S, 1) : "—";
    return `<span class="score-badge">${preview ? "预估 " : ""}Q ${q} · E ${e} · S ${s}</span>`;
  }

function displaySignal(r) {
    const raw = r.primary;
    if (raw && raw.stage === 3) return { p: raw, preview: false };
    if (raw && raw.previewGeometry && Number.isFinite(r.price)) {
      const g = C.repriceGeometry(raw.previewGeometry, r.price, state.config);
      g.triggerPrice = r.price;
      return {
        p: {
          ...raw,
          Q: raw.previewQ || null,
          E: raw.previewE || null,
          S: Number.isFinite(raw.previewS) ? raw.previewS : null,
          geometry: g,
          inEntryZone: r.price >= g.zoneLo && r.price <= g.zoneHi,
        },
        preview: true,
      };
    }
    return { p: null, preview: false };
  }

function conclusionHTML(r) {
    const p = r.primary && r.primary.stage === 3 ? r.primary : null,
      g = p && p.geometry,
      a = actionGuidance(r);
    if (!p && r.primary && r.primary.previewGeometry && Number.isFinite(r.price) && !["DATA_ERROR", "UNSUPPORTED", "UNTRADABLE"].includes(r.status)) {
      const pg = C.repriceGeometry(r.primary.previewGeometry, r.price, state.config),
        rr = rrLineText(pg),
        entry = entryLineText(pg, r.price),
        risk = `止损 ${fmt(pg.stop)}（${stopDistanceText(pg, r.price)}），目标 ${fmt(pg.target)}（${targetDistanceText(pg, r.price)}）`,
        zoneRR = Number.isFinite(r.primary.previewZoneBestRR) ? `整区最优预估 ${fmt(r.primary.previewZoneBestRR, 2)}∶1 / 门槛 ${fmt(state.config.minRR, 1)}∶1` : "整区最优预估 —";
      return `<div class="verdict"><div class="verdict-title">观察中｜空间预估（未触发）</div><div class="verdict-detail">${esc(rr)}｜${esc(entry)}｜${esc(risk)}｜${esc(zoneRR)}。正式信号未形成；预估只用于评估交易空间，不构成买点、不进前向样本。</div></div>`;
    }
    let title = a.title, detail = a.detail;
    if (!p && !["DATA_ERROR", "UNSUPPORTED", "UNTRADABLE"].includes(r.status))
      detail = "数据已加载；未形成正式信号，不生成评分、净赔率与冻结交易几何。";
    if (p && g) {
      const rr = rrLineText(g),
        entry = entryLineText(g, r.price),
        risk = `止损 ${fmt(g.stop)}（${stopDistanceText(g, r.price)}），目标 ${fmt(g.target)}（${targetDistanceText(g, r.price)}）`,
        fresh = freshLineText(p);
      if (r.status === "NEXT_SESSION_PLAN") {
        title = "只做预案，不提前挂单";
        detail = `${rr}；${entry}。只在回区且五门通过时评估；${risk}；${fresh}。`;
      } else if (r.status === "WAIT_ENTRY") {
        title = "开盘等待｜盘中独立确认";
        detail = `${rr}；${entry}。开盘余 ${p.remainingAttempts ?? "—"} 次；${risk}；${fresh}。`;
      } else if (r.status === "MODEL_ENTERED") {
        title = "开盘模型已入场｜不是新买点";
        detail = `${p.entryDate || "入场日待核"} 已触发；${risk}；不重复追加。`;
      } else if (["RESEARCH_ONLY", "REJECTED", "EXPIRED", "ARCHIVED", "MANUAL_REVIEW", "UNTRADABLE"].includes(r.status)) {
        const reason = statusReason(r) || r.statusText || a.detail;
        title = a.title;
        detail = `${reason}｜${rr}｜${entry}${["NEXT_SESSION_PLAN", "WAIT_ENTRY", "MODEL_ENTERED"].includes(r.status) ? "" : `｜${fresh}`}`;
      }
    }
    return `<div class="verdict"><div class="verdict-title">${esc(title)}</div><div class="verdict-detail">${esc(detail)}</div></div>`;
  }

function actionHTML(r, detail = false) {
    return conclusionHTML(r);
  }

function currentQuote(r) {
    const q = state.quotes[r.code] || {};
    return {
      ...q, price: r.price, pct: r.pct, qtime: r.quoteTime,
      open: Number.isFinite(q.open) ? q.open : r.quoteOpen,
      high: Number.isFinite(q.high) ? q.high : r.quoteHigh,
      low: Number.isFinite(q.low) ? q.low : r.quoteLow,
    };
  }

function currentIntradayKey(r, quoteDay) {
    return C.intradayPlanKey({ code: r.code, primary: r.primary }, quoteDay);
  }

function currentIntraday(r) {
    const quote = currentQuote(r),
      zone = r.market === "A" ? "Asia/Shanghai" : "America/New_York",
      quoteDay = quote.qtime ? C.tzInfo(new Date(quote.qtime), zone).day : null;
    let primary = r.primary, previewBased = false;
    if (
      (!primary || primary.stage !== 3) &&
      primary && primary.previewGeometry && Number.isFinite(r.price) &&
      !["DATA_ERROR", "UNSUPPORTED", "INDEX_ONLY", "UNTRADABLE"].includes(r.status)
    ) {
      // 未触发（阶段①／②）标的：用 v12.6 的预估几何合成临时预案，走同一套五门口径试算。
      // 结果只允许展示，永远不可执行、不建档、不进前向样本。
      primary = {
        ...primary,
        stage: 3,
        triggerGeometry: primary.previewGeometry,
        triggerDate: r.barsDate || null,
        age: 0,
        liquidity: { pass: true },
        reasons: [],
        expiredReason: null,
      };
      previewBased = true;
    }
    const key = currentIntradayKey({ ...r, primary }, quoteDay),
      bars = state.bars.get(r.code) || [],
      completed = C.completedBars(bars, r.market, new Date()),
      lastBar = completed.length ? completed[completed.length - 1] : null,
      prevBar = completed.length > 1 ? completed[completed.length - 2] : null,
      a = C.intradayAdvice({
        code: r.code, name: r.name, market: r.market, status: r.status, statusText: r.statusText,
        primary, quote, averageAmount20: r.averageAmount20,
        samples: state.intradaySamples[key] || [], now: new Date(), config: state.config,
        simPrice: lastBar ? lastBar.close : null,
        simAmount: lastBar && Number.isFinite(lastBar.amount) ? lastBar.amount : null,
        simHigh: lastBar ? lastBar.high : null,
        simLow: lastBar ? lastBar.low : null,
        simOpen: lastBar ? lastBar.open : null,
        simPrevClose: prevBar ? prevBar.close : null,
        simDate: lastBar ? lastBar.date : null,
      });
    if (previewBased) {
      a.previewBased = true;
      a.actionable = false;
      if (a.state === "ACTIONABLE") a.state = "SIMULATED";
      a.title = "预估·未触发｜" + a.title;
      a.detail += "；以上为对未触发结构按预估几何进行的五门试算，不构成买点、不建档、不进前向样本。";
    }
    const record = state.intradayRecords.find((e) => e.planKey === a.planKey && e.version === C.VERSION && e.geometryHash === (r.primary && r.primary.triggerGeometry ? stableHash(r.primary.triggerGeometry) : null));
    a.triggerLogged = !!record;
    a.recordId = record && record.id;
    if (a.actionable && record) a.title = "五门通过｜已留痕·人工限价评估";
    return a;
  }

function intradayHTML(r, detail = false) {
    if (isIndex(r.code)) return "";
    const a = currentIntraday(r),
      checks = detail && a.checks && a.checks.length
        ? `<span class="intraday-checks">${a.checks.map((x) => `<span class="${x.pass ? "ok" : "warn"}">${x.pass ? "通过" : "未过"}·${esc(x.label)}：${esc(x.detail)}</span>`).join("")}</span>`
        : "";
    const simTag = a.simulated ? '<span class="badge research">收盘模拟</span> ' : "";
    return `<span class="intraday-copy tone-${esc(a.tone)}"><strong>${simTag}盘中｜${esc(a.title)}</strong><span>${esc(a.detail)}</span>${checks}</span>`;
  }

function intradayChecksHTML(r) {
    const a = currentIntraday(r),
      simNote = a.simulated ? '<p class="small muted" style="margin:0 0 6px">非盘中：以下按最近完成日K收盘数据模拟计算，仅反映收盘时点理论状态，不构成可执行指令。</p>' : "",
      previewNote = a.previewBased ? '<p class="small muted" style="margin:0 0 6px">未触发结构：以下按预估几何（v12.6 空间预估）走同一套五门口径试算，只用于评估条件差距，不构成买点、不建档、不进前向样本。</p>' : "";
    if (a.checks && a.checks.length)
      return simNote + previewNote + `<div class="intraday-checks">${a.checks.map((x) => `<span class="${x.pass ? "ok" : "warn"}">${x.pass ? "通过" : "未过"}·${esc(x.label)}：${esc(x.detail)}</span>`).join("")}</div>`;
    if (r.status === "MODEL_ENTERED" && r.primary && (r.primary.triggerGeometry || r.primary.modelEntryGeometry))
      return intradayMonitorHTML(r);
    return `<p class="small muted">五门不适用于当前状态：${esc(a.title)}。${esc(a.detail)}</p>`;
  }

function intradayMonitorHTML(r) {
    const p = r.primary,
      g = p.modelEntryGeometry || p.triggerGeometry,
      entry = Number.isFinite(p.entryPrice) ? p.entryPrice : g && g.entryPrice,
      risk = Number.isFinite(entry) && g && Number.isFinite(g.stop) && entry > g.stop ? entry - g.stop : null,
      rNow = risk && Number.isFinite(r.price) ? (r.price - entry) / risk : null,
      toStopPct = g && Number.isFinite(g.stop) && r.price > 0 ? (g.stop / r.price - 1) * 100 : null,
      toTargetPct = g && Number.isFinite(g.target) && r.price > 0 ? (g.target / r.price - 1) * 100 : null,
      rec = forwardEntries().find((e) => e.code === r.code && e.channel === p.channel && e.triggerDate === p.triggerDate),
      settle = rec
        ? rec.done && rec.result
          ? rec.result.status === "CLOSED"
            ? `已结算 ${fmt(rec.result.R, 2)}R（${rec.result.reason}）`
            : `未成交（${rec.result.reason}）`
          : (rec.pendingStage || "待结算")
        : "前向记录未匹配（可能为 v12.0 前旧档案）";
    return `<p class="small muted" style="margin:0 0 6px">开盘模型已入场：五门是未入场计划的盘中执行路径，已入场标的不重复走五门，只监控冻结止损／目标与结算进度；不代表你的实际持仓。</p><div class="geometry-grid"><div><span>模型入场</span><b class="num">${fmt(entry)}（${esc(p.entryDate || "日期待核")}）</b></div><div><span>现价浮动</span><b class="num ${rNow > 0 ? "up" : rNow < 0 ? "down" : ""}">${Number.isFinite(rNow) ? fmt(rNow, 2) + "R" : "—"}</b></div><div><span>距冻结止损</span><b class="num">${toStopPct === null ? "—" : fmt(toStopPct, 1) + "%"}</b></div><div><span>距冻结目标</span><b class="num">${toTargetPct === null ? "—" : "+" + fmt(toTargetPct, 1) + "%"}</b></div><div><span>模型结算</span><b>${esc(settle)}</b></div></div>`;
  }

function renderIntradayPanel() {
    const rows = [...state.rows.values()].filter((r) => !isIndex(r.code)),
      regular = rows.filter((r) => C.marketSession(r.market, new Date()).state === "REGULAR"),
      advice = regular.map((r) => currentIntraday(r)),
      actionable = advice.filter((a) => a.actionable).length,
      confirming = advice.filter((a) => ["CONFIRMING", "WAIT_VOLUME", "WAIT_ZONE", "WAIT_RR"].includes(a.state)).length,
      risk = advice.filter((a) => a.tone === "danger").length;
    $("countIntraday").textContent = actionable;
    $("intradayStatus").textContent = state.loading || state.scanning
      ? "等待日线信号与冻结几何加载"
      : !rows.length
        ? "暂无监控标的"
        : regular.length
          ? `盘中监控 ${regular.length} 只｜五门通过 ${actionable}｜等待／确认 ${confirming}｜风险拦截 ${risk}`
          : "非盘中｜只保留预案，不生成隔夜挂单";
    $("intradaySummary").textContent = regular.length
      ? "数据→结构→盘中确认→交易几何→可成交五门独立核验；首次通过自动留痕，仅当日有效，不改写日线Q。"
      : "盘前只准备、盘中才执行；未触发预案收盘作废，报价与确认样本仅保存在本机。";
    const stamp = state.lastIntradayAt
      ? new Date(state.lastIntradayAt).toLocaleTimeString("zh-CN", { hour12: false })
      : "—";
    $("intradayMeta").textContent = `最近报价刷新 ${stamp}｜${state.intradayMessage}`;
    $("intradayBtn").disabled = state.loading || state.scanning || state.intradayLoading || !rows.length;
    $("intradayBtn").textContent = state.intradayLoading ? "报价刷新中…" : "刷新盘中报价";
  }

function rrText(g) {
    return g && g.valid && Number.isFinite(g.netRR) && g.netRR > 0 ? `${fmt(g.netRR, 2)}∶1` : "—";
  }

function stopDistanceText(g, price) {
    if (!g || !Number.isFinite(price) || !Number.isFinite(g.stop)) return "—";
    const d = (g.stop / price - 1) * 100;
    return price <= g.stop ? `已破止损 ${fmt(Math.abs(d), 1)}%` : pctText(d, false);
  }

function targetDistanceText(g, price) {
    if (!g || !Number.isFinite(price) || !Number.isFinite(g.target)) return "—";
    const d = (g.target / price - 1) * 100;
    return price >= g.target ? `已越目标 ${fmt(Math.abs(d), 1)}%` : pctText(d);
  }

function pctText(v, signed = true) {
    if (!Number.isFinite(v)) return "—";
    return `${signed && v > 0 ? "+" : ""}${fmt(v, 1)}%`;
  }

function renderSignals() {
    const rows = filteredRows(), body = $("signalRows");
    body.innerHTML = rows.map((r) => {
      const disp = displaySignal(r),
        p = disp.p,
        g = p && p.geometry,
        preview = disp.preview,
        open = state.expanded.has(r.code);
      return `<tr class="signal-row" data-code="${esc(r.code)}" tabindex="0" aria-expanded="${open}"><td data-label="标的" class="col-stock"><div class="stock-heading"><button class="ghost pin-toggle" data-pin="${esc(r.code)}" type="button" aria-pressed="${state.pins.has(r.code)}" aria-label="${state.pins.has(r.code) ? "取消钉住" : "钉住"}${esc(r.name)}">${state.pins.has(r.code) ? "已钉" : "钉"}</button><div><div class="stock-name">${esc(r.name)}</div><div class="stock-code">${esc(r.code)}</div></div></div></td><td data-label="现价" class="price col-price"><span class="${r.pct > 0 ? "up" : r.pct < 0 ? "down" : ""}">${fmt(r.price)}</span><br><span class="small ${r.pct > 0 ? "up" : r.pct < 0 ? "down" : "muted"}">${r.pct === null ? "—" : (r.pct > 0 ? "+" : "") + fmt(r.pct) + "%"}</span></td><td data-label="状态与操作" class="col-action"><div class="row-status"><span class="badge ${statusClass(r.status)}">${esc(r.statusText || C.statusLabel(r.status))}</span>${g && g.higherPressure ? `<div class="small warn">${esc(g.higherPressure.period)}压力限制目标</div>` : ""}</div>${conclusionHTML(r)}${intradayHTML(r)}</td><td data-label="主通道" class="col-channel"><span class="channel-name">${p ? esc(p.name) : r.status === "DATA_ERROR" ? "数据异常" : "未触发"}</span>${r.alternates && r.alternates.length ? `<div class="small muted">另有 ${r.alternates.length} 通道</div>` : ""}</td><td data-label="形态 / 执行 / 排序" class="metric col-qe">${scoreBadgeHTML(p, preview)}</td><td data-label="净赔率" class="metric col-rr"><span class="score ${g ? "" : "na"}">${g ? rrText(g) : r.status === "DATA_ERROR" ? "数据异常" : "未形成"}</span>${preview ? '<div class="small muted">预估·未触发</div>' : ""}</td><td data-label="交易几何" class="metric col-geometry">${g ? `<div class="geometry-lines"><span><small>入场</small>${fmt(g.zoneLo)}～${fmt(g.zoneHi)}</span><span class="geometry-risk"><small>止损</small>${fmt(g.stop)}（${stopDistanceText(g, r.price)}）</span><span class="geometry-risk"><small>目标</small>${fmt(g.target)}（${targetDistanceText(g, r.price)}）</span></div>${preview ? '<div class="small muted">预估·未触发</div>' : ""}` : r.status === "DATA_ERROR" ? "数据异常" : "未触发·无冻结几何"}</td><td data-label="数据" class="col-data"><span class="small num">${shortDate(r.barsDate)}</span><br><span class="small muted">${esc(r.source)}</span></td></tr>${open ? `<tr class="detail-row open" data-detail="${esc(r.code)}"><td colspan="8">${detailHTML(r)}</td></tr>` : ""}`;
    }).join("");
    $("signalEmpty").classList.toggle("hidden", rows.length > 0 || state.loading || state.scanning);
    if (!rows.length && !state.loading && !state.scanning)
      $("signalEmpty").innerHTML = "<strong>当前筛选下没有候选</strong>空候选是合法结果；可切换“全部状态”查看拒绝原因，或单独查看“已归档／预筛剔除”。";
    const all = [...state.rows.values()].filter((r) => !isIndex(r.code));
    for (const [id, status] of [["countPlan", "NEXT_SESSION_PLAN"], ["countWait", "WAIT_ENTRY"], ["countEntered", "MODEL_ENTERED"], ["countError", "DATA_ERROR"]])
      $(id).textContent = all.filter((r) => r.status === status).length;
    $("coverageTop").textContent = all.filter((r) => r.status !== "DATA_ERROR").length + " / " + all.length;
    const health = [state.marketHealth.A, state.marketHealth.US].filter(Boolean),
      healthErrors = health.filter((h) => h.error), healthWarnings = health.filter((h) => !h.error && h.warning);
    $("freshnessTop").textContent = healthErrors.length ? `${healthErrors.length} 个市场异常` : health.length ? health.map((h) => `${h.market} ${h.expectedDate ? h.expectedDate.slice(5) : "—"}`).join(" · ") : "待核验";
    $("freshnessTop").className = healthErrors.length ? "up" : healthWarnings.length ? "warn" : "ok";
    $("freshnessTop").title = health.map((h) => `${h.market === "A" ? "A股" : "美股"} ${h.expectedDate || "—"}${h.error ? "｜" + h.error : h.warning ? "｜" + h.warning : ""}`).join("；");
    renderIntradayPanel();
    renderBreakoutPreview(); renderObservations(); renderBreadth(); renderDiagnostics();
  }

function dimHTML(title, obj, notes = {}) {
    return `<h4>${esc(title)}</h4><div class="score-table">${Object.entries(obj || {}).map(([k, v]) => `<div class="score-row"><span>${esc(k)}${notes[k] ? `<small>${esc(notes[k])}</small>` : ""}</span><span>${v === null ? "—" : fmt(v, 1)}</span></div>`).join("")}</div>`;
  }

function detailHTML(r) {
    const p = r.primary && r.primary.stage === 3 ? r.primary : null,
      dataLine = `完成日K ${esc(r.barsDate)}；报价 ${esc(r.source)}；K线源 ${esc(r.kSource || "—")}；${esc(r.kAdjustment || "复权口径未确认")}`,
      warnings = (r.quality && r.quality.warnings) || [];
    if (!p) {
      const obs = r.primary;
      let previewBlock = "";
      if (obs && obs.previewGeometry && Number.isFinite(r.price)) {
        const pg = C.repriceGeometry(obs.previewGeometry, r.price, state.config),
          pressurePct = pg.higherPressure && r.price > 0 ? (pg.higherPressure.price / r.price - 1) * 100 : null,
          rawTargetPct = r.price > 0 ? (pg.rawTarget / r.price - 1) * 100 : null,
          narrow = Number.isFinite(pg.targetAtr) && pg.targetAtr < 1,
          zoneRR = Number.isFinite(obs.previewZoneBestRR) ? `整区最优预估净赔率 ${fmt(obs.previewZoneBestRR, 2)}∶1（门槛 ${fmt(state.config.minRR, 1)}∶1）` : "整区最优预估净赔率 —";
        previewBlock = `<div><h3>交易空间与价位（预估）</h3><div class="geometry-grid"><div><span>预估入场区</span><b class="num">${fmt(pg.zoneLo)}～${fmt(pg.zoneHi)}</b></div><div><span>现价净赔率（预估）</span><b class="num rr-now">${rrText(pg)}</b></div><div><span>预估止损</span><b class="num">${fmt(pg.stop)}（${stopDistanceText(pg, r.price)}）</b><small>${fmt(pg.stopAtr, 2)} 倍 ATR</small></div><div><span>预估第一目标</span><b class="num">${fmt(pg.target)}（${targetDistanceText(pg, r.price)}）</b><small>${fmt(pg.targetAtr, 2)} 倍 ATR</small></div>${pg.higherPressure ? `<div><span>最近高周期压力</span><b class="warn num">${esc(pg.higherPressure.period)} ${fmt(pg.higherPressure.price)}（${signedPct(pressurePct)}）</b><small>原目标 ${fmt(pg.rawTarget)}（${signedPct(rawTargetPct)}），已收缩</small></div>` : `<div><span>高周期压力</span><b>未提前收缩目标</b></div>`}<div><span>结构锚点</span><b>${esc(pg.anchorLabel)}</b></div></div>${narrow ? `<p class="small warn space-warning">空间偏窄：预估目标距现价不足 1 倍 ATR，可能处于日常波动范围内。</p>` : ""}<p class="small muted" style="margin-top:8px">${esc(zoneRR)}。以上为对未触发结构按现价的预估：不构成买点、不冻结几何、不进前向样本。费用 ${state.config.feeBps} bps（往返）＋滑点 ${state.config.slippageBps} bps（单边）。止损不保证成交。</p>${obs.previewQ ? dimHTML("预估 Q 子项（未触发）", obs.previewQ.dims) : ""}</div>`;
      }
      return `<div class="detail"><div class="detail-checks"><h3>盘中五门核验</h3>${intradayChecksHTML(r)}</div>${previewBlock}<div><h3>观察原因</h3><p>${esc(r.statusText)}</p><p class="small muted">${esc(freshLineText(null))}；排序分 ${obs && obs.previewQ ? scoreBadgeHTML({ Q: obs.previewQ, E: obs.previewE, S: obs.previewS }, true) : scoreBadgeHTML(null)}</p></div><div><h3>数据时点</h3><p>${dataLine}</p></div><div><h3>质量诊断</h3><p>${esc([...((r.quality && r.quality.errors) || []), ...warnings].join("；") || "未形成三通道候选")}</p></div></div>`;
    }
    const g = p.geometry, alt = r.alternates || [], a = actionGuidance(r),
      pressurePct = g.higherPressure && r.price > 0 ? (g.higherPressure.price / r.price - 1) * 100 : null,
      rawTargetPct = r.price > 0 ? (g.rawTarget / r.price - 1) * 100 : null,
      pressure = g.higherPressure
        ? `<div><span>最近高周期压力</span><b class="warn num">${esc(g.higherPressure.period)} ${fmt(g.higherPressure.price)}（${signedPct(pressurePct)}）</b><small>原目标 ${fmt(g.rawTarget)}（${signedPct(rawTargetPct)}），已收缩</small></div>`
        : `<div><span>高周期压力</span><b>未提前收缩目标</b></div>`,
      pressureList = (g.higherPressures || []).slice(0, 3).map((x) => `${esc(x.period)} ${fmt(x.price)}（${signedPct(r.price > 0 ? (x.price / r.price - 1) * 100 : null)}）`).join("；") || "未识别到上方已确认摆动压力",
      attemptLine = (p.attempts || []).map((x) => `${x.date} ${x.status === "ENTER" ? "条件满足" : "未入场"}：${x.reason}`).join("；") || "尚未进行开盘检查",
      windowLine = `开盘窗口：已检查 ${p.usedAttempts ?? 0} / ${p.maxAttempts ?? "—"} 次；剩余 ${p.remainingAttempts ?? "—"} 次；${attemptLine}`,
      narrow = Number.isFinite(g.targetAtr) && g.targetAtr < 1;
    return `<div class="detail"><div class="detail-checks"><h3>盘中五门核验</h3>${intradayChecksHTML(r)}</div><div><h3>交易翻译</h3><p><b>${esc(a.title)}</b> ${esc(a.detail)}</p><div class="exec-lines"><span class="exec-line">${esc(rrLineText(g))}</span><span class="exec-line">${esc(entryLineText(g, r.price))}</span><span class="exec-line">${esc(`止损 ${fmt(g.stop)}（${stopDistanceText(g, r.price)}）；目标 ${fmt(g.target)}（${targetDistanceText(g, r.price)}）；结构锚点 ${g.anchorLabel}`)}</span><span class="exec-line">${esc(freshLineText(p))}｜${esc(p.name)}｜排序分 ${esc(`Q ${fmt(p.Q.value, 1)} · E ${fmt(p.E.value, 1)} · S ${fmt(p.S, 1)}`)}</span></div><h4>信号依据</h4><ul class="reason-list">${(p.evidence || []).map((x) => `<li>${esc(x)}</li>`).join("")}<li>首次有效触发：${esc(p.triggerDate)}；信号年龄 ${p.age} 个完成交易日</li><li>${esc(windowLine)}</li>${(p.reasons || []).map((x) => `<li class="warn">${esc(x)}</li>`).join("")}</ul><h4>其他合格通道</h4><p>${alt.length ? alt.map((x) => esc(x.name) + " / " + esc(x.statusText)).join("；") : "无"}</p></div><div><h3>交易空间与价位</h3><div class="geometry-grid"><div><span>入场区</span><b class="num">${fmt(g.zoneLo)}～${fmt(g.zoneHi)}</b></div><div><span>现价净赔率</span><b class="num rr-now">${rrText(g)}</b></div><div><span>止损</span><b class="num">${fmt(g.stop)}（${stopDistanceText(g, r.price)}）</b><small>${fmt(g.stopAtr, 2)} 倍 ATR</small></div><div><span>第一目标</span><b class="num">${fmt(g.target)}（${targetDistanceText(g, r.price)}）</b><small>${fmt(g.targetAtr, 2)} 倍 ATR</small></div>${pressure}<div><span>结构锚点</span><b>${esc(g.anchorLabel)}</b></div></div>${narrow ? `<p class="small warn space-warning">空间偏窄：第一目标距现价不足 1 倍 ATR，可能处于日常波动范围内；这只是提示，不自动改写候选或拉远目标。</p>` : ""}<p class="small muted" style="margin-top:8px">百分比按现价计算；ATR 距离用于判断空间是否被日常波动主导，不是新硬门槛。上方压力：${pressureList}。费用 ${state.config.feeBps} bps（往返）＋滑点 ${state.config.slippageBps} bps（单边）。止损不保证成交。</p></div><div><h3>数据时点</h3><p>${dataLine}；${r.session.state === "REGULAR" ? "常规交易时段" : "非盘中，盘中未完成K线未计入Q"}</p>${warnings.length ? `<p class="small warn">${esc(warnings.join("；"))}</p>` : ""}<h4>质量诊断</h4><p>${esc([...((r.quality && r.quality.errors) || []), ...warnings].join("；") || "通过")}</p></div></div>`;
  }

function previewVolume(v, market) {
    if (!Number.isFinite(v)) return "—";
    return market === "A" ? `${fmt(v / 10000, 2)}万股` : `${fmt(v / 1e6, 2)}百万股`;
  }

function renderBreakoutPreview() {
    const rows = [];
    for (const r of state.rows.values()) {
      if (isIndex(r.code) || r.status === "DATA_ERROR" || C.marketSession(r.market, new Date()).state !== "REGULAR") continue;
      const q = currentQuote(r), completed = C.completedBars(state.bars.get(r.code) || [], r.market, new Date());
      if (!q.qtime || !completed.length) continue;
      const zone = r.market === "A" ? "Asia/Shanghai" : "America/New_York",
        quoteDay = C.tzInfo(new Date(q.qtime), zone).day,
        today = C.tzInfo(new Date(), zone).day;
      if (quoteDay !== today || !completed.length || completed[completed.length - 1].date >= quoteDay) continue;
      if (![q.open, q.high, q.low, q.volume, q.price].every((x) => Number.isFinite(x) && x > 0)) continue;
      const virtualBar = { date: quoteDay, open: +q.open, high: +q.high, low: +q.low,
          close: +q.price, volume: +q.volume * (r.market === "A" ? 100 : 1), amount: Number.isFinite(q.amount) ? +q.amount : null },
        p = C.breakoutPreview(completed.concat(virtualBar), state.config);
      if (!p || !p.near) continue;
      const ret2 = completed.length >= 2 ? (r.price / completed[completed.length - 2].close - 1) * 100 : null;
      rows.push({ r, p, ret2, passes: [p.above, p.volumeOk, p.priceOk].filter(Boolean).length });
    }
    rows.sort((a, b) => Number(a.p.prefiltered) - Number(b.p.prefiltered) || b.passes - a.passes || (b.ret2 || -999) - (a.ret2 || -999));
    const visible = rows.slice(0, 8);
    $("breakoutPreviewRows").innerHTML = visible.map(({ r, p, ret2 }) => {
      const g = p.geometry,
        allPass = p.above && p.volumeOk && p.priceOk,
        status = p.prefiltered ? "预筛未过（赔率或止损距离）·仅观察" : allPass ? "若收盘仍满足→可形成正式预案" : p.above ? "价格已越压·其余条件待确认" : "等待收盘越压",
        geometry = `${fmt(g.zoneLo)}～${fmt(g.zoneHi)}<br><span class="small muted">止损 ${fmt(g.stop)} / 目标 ${fmt(g.target)}</span><br><span class="small muted">整区最优 ${rrText({ ...g, valid: true, netRR: p.zoneBestRR })}</span>`;
      return `<tr><td data-label="标的"><div class="stock-name">${esc(r.name)}</div><div class="stock-code">${esc(r.code)}</div></td><td data-label="现价 / 近2日" class="num">${fmt(r.price)}<br><span class="small ${ret2 > 0 ? "up" : ret2 < 0 ? "down" : "muted"}">近2日 ${ret2 === null ? "—" : (ret2 > 0 ? "+" : "") + fmt(ret2, 1) + "%"}</span></td><td data-label="收盘价格条件" class="num">收盘＞${fmt(p.requiredClose)}<br><span class="small muted">前20日压力 ${fmt(p.pressure)}</span></td><td data-label="全日量能 / 收盘位置" class="num">全日量≥${previewVolume(p.requiredVolume, r.market)}<br><span class="small muted">当前 ${previewVolume(p.currentVolume, r.market)} · 位置 ${fmt(p.closePos * 100, 0)}%／需≥55%</span></td><td data-label="下一交易日预估" class="num">${geometry}</td><td data-label="预告状态"><span class="badge ${p.prefiltered || !allPass ? "wait" : "plan"}">${esc(status)}</span></td></tr>`;
    }).join("");
    $("breakoutPreviewEmpty").classList.toggle("hidden", visible.length > 0);
    $("breakoutPreviewMeta").textContent = rows.length ? `当前 ${rows.length} 只接近突破条件，按条件完成度展示前 8 只；预估几何收盘后重冻结，不计入Q或前向样本。` : "当前没有符合临近突破范围的盘中标的；预告只在连续竞价时段生成。";
  }

function renderObservations() {
    const text = $("observeText").value.trim().toLowerCase(),
      ch = $("observeChannel").value,
      rows = [];
    for (const r of state.rows.values()) {
      if (isIndex(r.code) || r.status === "DATA_ERROR") continue;
      if (text && !(r.name + " " + r.code).toLowerCase().includes(text))
        continue;
      for (const s of r.channels) {
        if (s.stage > 0 && s.stage < 3 && (ch === "all" || s.channel === ch))
          rows.push({ r, s });
      }
    }
    $("observeRows").innerHTML = rows
      .map(
        ({ r, s }) =>
          `<tr><td><div class="stock-name">${esc(r.name)}</div><div class="stock-code">${esc(r.code)}</div></td><td>${esc(s.name)}</td><td><span class="badge wait">阶段 ${s.stage === 2 ? "② 准备" : "① 观察"}</span></td><td>${esc((s.missing || []).join("；") || "等待条件确认")}</td><td>${esc((s.evidence || []).join("；") || "—")}</td><td class="num">${esc(r.barsDate)}</td></tr>`,
      )
      .join("");
    $("observeEmpty").classList.toggle("hidden", rows.length > 0);
  }

function renderBreadth() {
    const parts = [];
    for (const market of ["A", "US"]) {
      const rows = [...state.rows.values()].filter((r) => r.market === market && !isIndex(r.code) && Number.isFinite(r.price));
      let adv = 0, dec = 0, flat = 0, nh = 0, nl = 0, stale = 0;
      const weekly = [];
      for (const r of rows) {
        if (r.pct > 0) adv++; else if (r.pct < 0) dec++; else flat++;
        const completed = C.completedBars(state.bars.get(r.code) || [], market, new Date()),
          bars = completed.slice(-20);
        if (bars.length >= 20) {
          if (r.price >= Math.max(...bars.map((b) => b.high))) nh++;
          if (r.price <= Math.min(...bars.map((b) => b.low))) nl++;
        }
        if (r.status !== "DATA_ERROR" && completed.length >= 6)
          weekly.push((completed[completed.length - 1].close / completed[completed.length - 6].close - 1) * 100);
        if (r.session && r.session.state === "REGULAR" && r.quoteTime && Date.now() - r.quoteTime > 20 * 60e3) stale++;
      }
      const wUp = weekly.filter((x) => x > 0).length,
        wDown = weekly.filter((x) => x < 0).length,
        wMedian = C.median(weekly),
        wHigh = weekly.filter((x) => x >= 5).length,
        wLow = weekly.filter((x) => x <= -5).length,
        weekText = weekly.length ? ` · 近5日涨${wUp}/跌${wDown} · 中位${wMedian >= 0 ? "+" : ""}${fmt(wMedian, 1)}% · ±5% ${wHigh}/${wLow}` : "";
      if (rows.length) parts.push(`${market === "A" ? "A股" : "美股"} 涨${adv}/跌${dec}/平${flat} · 20日新高${nh}/新低${nl} · 陈旧报价${stale}${weekText}`);
    }
    $("breadthLine").textContent = parts.length ? parts.join("｜") + "（仅当前池，近5日按完成K线，不入分）" : "市场宽度：尚无有效报价";
  }

function renderEnvironment() {
    const render = (id, bars, market) => {
      const f = C.features(C.completedBars(bars, market, new Date())),
        support =
          f &&
          f.close > f.ma20[f.n - 1] &&
          f.ma20[f.n - 1] > f.ma60[f.n - 1],
        cautious =
          f &&
          f.close < f.ma20[f.n - 1] &&
          f.ma20[f.n - 1] < f.ma60[f.n - 1];
      $(id).textContent = !f
        ? "数据不足"
        : support
          ? "趋势支持（仅展示）"
          : cautious
            ? "环境谨慎（不扣分）"
            : "中性（不扣分）";
      $(id).className = !f ? "muted" : support ? "ok" : "warn";
      return f;
    };
    render("envA", state.benchmark.A, "A");
    const us = render("envUS", state.benchmark.US, "US");
    $("envUSMeta").textContent = us
      ? `纳指 ${fmt(us.close)} · ${us.date}`
      : "纳指数据不足";
  }

function renderDiagnostics() {
    const rows = [...state.rows.values()],
      sources = {};
    rows.forEach((r) => (sources[r.source] = (sources[r.source] || 0) + 1));
    const kSources = {};
    rows.forEach(
      (r) => (kSources[r.kSource || "—"] = (kSources[r.kSource || "—"] || 0) + 1),
    );
    const unitRatios = {};
    for (const [code, bars] of state.bars) {
      if (!Array.isArray(bars) || !bars.length) continue;
      const b = bars[bars.length - 1];
      if (!(b.amount > 0) || !(b.close > 0) || !(b.volume > 0)) continue;
      const src = ((state.rows.get(code) || {}).kSource) || "—";
      (unitRatios[src] = unitRatios[src] || []).push(b.amount / (b.close * b.volume));
    }
    const unitText =
      Object.entries(unitRatios)
        .map(([k, arr]) => {
          const med = C.median(arr);
          return `${k} ≈${fmt(med, 2)}（${med > 50 ? "手口径·应改UNIT常量" : med >= 0.5 ? "股口径·正常" : "异常"}）`;
        })
        .join("；") || "—";
    const passed = rows.filter((r) => r.status !== "DATA_ERROR").length,
      unconfirmedA = rows.filter((r) => r.market === "A" && r.kSource && !r.adjustmentConfirmed).length,
      dataWarnings = rows.flatMap((r) => (r.quality && r.quality.warnings) || []),
      fallbackCount = rows.reduce((n, r) => n + ((r.kFallbacks && r.kFallbacks.length) || 0), 0),
      expectedA = C.latestCompletedDate(state.benchmark.A, "A", new Date()),
      expectedUS = C.latestCompletedDate(state.benchmark.US, "US", new Date()),
      healthText = ["A", "US"].map((market) => {
        const h = state.marketHealth[market];
        if (!h) return `${market === "A" ? "A股" : "美股"} 待核验`;
        const sources = (h.candidates || []).map((x) => `${x.source}:${x.date || "失败"}`).join("、");
        return `${market === "A" ? "A股" : "美股"} 采用 ${h.source || "—"} ${h.expectedDate || "—"}／报价日 ${h.quoteDay || "—"}（${sources}）${h.error ? "｜异常：" + h.error : h.warning ? "｜" + h.warning : ""}`;
      });
    let oldestCache = null, cacheCount = 0;
    for (const key of Object.keys(sessionStorage)) {
      if (!key.startsWith(KLINE_CACHE_PREFIX)) continue;
      try {
        const j = JSON.parse(sessionStorage.getItem(key) || "null");
        if (j && Number.isFinite(j.t)) {
          cacheCount++;
          if (oldestCache === null || j.t < oldestCache) oldestCache = j.t;
        }
      } catch (e) {}
    }
    const cacheText = oldestCache ? `${cacheCount} 条；最旧 ${Math.max(0, Math.round((Date.now() - oldestCache) / 60000))} 分钟` : "无会话K线缓存";
    $("sourceStats").innerHTML =
      `<table><tbody><tr><td>当前模式</td><td class="num">${state.mode === "scan" ? "全A初筛深扫" : "本机客观研究池"}</td></tr><tr><td>有效 / 总数</td><td class="num">${passed} / ${rows.length}</td></tr><tr><td>报价来源</td><td>${esc(
        Object.entries(sources)
          .map(([k, v]) => k + " " + v)
          .join("；") || "—",
      )}</td></tr><tr><td>K线来源</td><td>${esc(
        Object.entries(kSources)
          .map(([k, v]) => k + " " + v)
          .join("；") || "—",
      )}</td></tr><tr><td>成交额口径</td><td>${esc(unitText)}</td></tr><tr><td>基准完成日</td><td>A股 ${esc(expectedA || "缺失")}；美股 ${esc(expectedUS || "缺失")}</td></tr><tr><td>日期新鲜 / 仲裁</td><td>${healthText.map(esc).join("<br>")}</td></tr><tr><td>盘中报价层</td><td>${esc(state.intradayMessage)}；最近 ${state.lastIntradayAt ? esc(new Date(state.lastIntradayAt).toLocaleString("zh-CN", { hour12: false })) : "—"}</td></tr><tr><td>盘中证据</td><td>报价样本组 ${Object.keys(state.intradaySamples).length}；触发档案 ${state.intradayRecords.length}（只含公开行情，本机保存）</td></tr><tr><td>缓存 / 降级</td><td>${esc(cacheText)}；K线降级记录 ${fallbackCount} 条</td></tr><tr><td>复权 / 一致性</td><td class="${unconfirmedA || dataWarnings.length ? "warn" : ""}">${unconfirmedA ? `A股复权未确认 ${unconfirmedA} 只；` : ""}${dataWarnings.length ? `警告 ${dataWarnings.length} 条` : "无警告"}</td></tr><tr><td>深扫覆盖</td><td>${esc(state.scanMeta || "尚未执行全A扫描")}</td></tr><tr><td>账户数据</td><td>未读取、未计算、未上传</td></tr></tbody></table>`;
    const tests = getSelfTests();
    $("selfTests").innerHTML =
      tests
        .map(
          (t) =>
            `<div class="test-line"><span>${esc(t.name)}</span><b class="${t.pass ? "ok" : "up"}">${t.pass ? "通过" : "失败：" + esc(t.detail)}</b></div>`,
        )
        .join("") +
      `<p class="small muted" style="margin-top:8px">${tests.filter((t) => t.pass).length}/${tests.length} 项通过；自测验证程序不变量，不证明策略收益。</p>`;
  }

function scoreDiagnosticsHTML(diags) {
    const cell = (b) => b ? `<b class="num">${fmt(b.avgR, 3)}</b><br><span class="small muted">${b.count}笔 / 胜率${fmt(b.winRate, 1)}%</span><br><span class="small muted">${fmt(b.range[0], 1)}～${fmt(b.range[1], 1)}</span>` : "—";
    return `<h3 style="margin:20px 0 8px">Q/E/S 分桶单调性（探索性）</h3><p class="small muted">每通道每分数至少30笔才分桶；只检查当前已加载池，不用于调参或证明收益。单调不等于稳定，非单调也不等于无效，须结合高低组差、区间与样本外结果。</p><table><thead><tr><th>通道 / 分数</th><th>低分组</th><th>中分组</th><th>高分组</th><th>高-低平均R</th><th>判定</th></tr></thead><tbody>${diags.map((d) => `<tr><td>${esc(C.CHANNELS[d.channel].name)} / ${d.metric}</td><td>${cell(d.buckets[0])}</td><td>${cell(d.buckets[1])}</td><td>${cell(d.buckets[2])}</td><td class="num">${fmt(d.spread, 3)}</td><td><span class="badge ${d.monotonic ? "current" : d.monotonic === false ? "error" : "wait"}">${esc(d.status)}</span></td></tr>`).join("")}</tbody></table>`;
  }

const pfText = (x) => x === Infinity ? "∞" : fmt(x, 2);

const researchInterval = (a, suffix = "") => a && a.length === 2 && a.every(Number.isFinite) ? `${fmt(a[0], 3)}～${fmt(a[1], 3)}${suffix}` : "—";

const researchR = (x) => Number.isFinite(x) ? fmt(x, 3) : "—";

function channelConfidenceHTML(rows) {
    return `<details class="research-detail"><summary>分通道聚类 Bootstrap 区间</summary><p class="small muted">按标的聚类重抽样；只描述当前池的不确定性，不消除选择、幸存者或共同市场 regime 偏差。</p><table><thead><tr><th>通道</th><th>已结算</th><th>平均R 95%区间</th><th>PF 95%区间</th><th>标的簇 / 次数</th></tr></thead><tbody>${rows.map((x) => { const ci = x.confidence || {}; return `<tr><td>${esc(C.CHANNELS[x.channel].name)}</td><td class="num">${x.count}</td><td class="num">${researchInterval(ci.avgR)}</td><td class="num">${researchInterval(ci.profitFactor)}</td><td class="num">${ci.clusters || 0} / ${ci.iterations || 0}</td></tr>`; }).join("")}</tbody></table></details>`;
  }

function pairedHorizonHTML(rows) {
    return `<details class="research-detail"><summary>T+10 − T+5 · 同信号配对差</summary><p class="small muted">只比较同一笔且两个期限均可观察的交易；提前退出仍锁定实际净R。配对减少样本构成差异，但不构成样本外证明。</p><table><thead><tr><th>通道</th><th>配对样本</th><th>平均ΔR</th><th>中位ΔR</th><th>T+10更优</th><th>平均ΔR 95%区间</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${esc(C.CHANNELS[x.channel].name)}</td><td class="num">${x.count}</td><td class="num">${researchR(x.avgDelta)}</td><td class="num">${researchR(x.medianDelta)}</td><td class="num">${researchPctText(x.improvedPct)}</td><td class="num">${researchInterval(x.confidence && x.confidence.mean)}</td></tr>`).join("")}</tbody></table></details>`;
  }

function tailConcentrationHTML(rows) {
    const name = (x) => x.channel === "all" ? "全部通道" : C.CHANNELS[x.channel].name;
    return `<details class="research-detail"><summary>尾部盈利集中度与剔除敏感性</summary><p class="small muted">Top 盈利贡献以总正收益为分母；剔除 Top1／Top5 后重算平均R。用于识别少数大盈利驱动，不是新的交易规则。</p><table><thead><tr><th>通道</th><th>样本</th><th>Top1盈利贡献</th><th>Top5盈利贡献</th><th>去Top1平均R</th><th>去Top5平均R</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${esc(name(x))}</td><td class="num">${x.count}</td><td class="num">${researchPctText(x.top1Share)}</td><td class="num">${researchPctText(x.top5Share)}</td><td class="num">${researchR(x.avgRWithoutTop1)}</td><td class="num">${researchR(x.avgRWithoutTop5)}</td></tr>`).join("")}</tbody></table></details>`;
  }

const researchPctText = (x, d = 1) => Number.isFinite(x) ? `${fmt(x, d)}%` : "—";

function fixedHorizonHTML(rows) {
    return `<details class="research-detail" open><summary>固定期限分通道对比 · 策略实际口径</summary><p class="small muted">T+N 指入场后的第N个交易日，以该日收盘观察；若此前已按策略退出，则锁定实际退出净R，不再假装持仓。平均收益率为成本后口径；N不足显示0，不用最后一根K线冒充到期。</p><table><thead><tr><th>通道 / 期限</th><th>样本N</th><th>胜率</th><th>平均净R</th><th>中位净R</th><th>平均净收益</th><th>PF</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${esc(C.CHANNELS[x.channel].name)} / T+${x.horizon}</td><td class="num">${x.count}</td><td class="num">${researchPctText(x.winRate)}</td><td class="num">${fmt(x.avgR, 3)}</td><td class="num">${fmt(x.medianR, 3)}</td><td class="num">${researchPctText(x.avgReturnPct, 2)}</td><td class="num">${pfText(x.profitFactor)}</td></tr>`).join("")}</tbody></table></details>`;
  }

function counterfactualHTML(rows) {
    return `<details class="research-detail"><summary>退出后反事实观察 · 不计入实际业绩</summary><p class="small muted">假设目标／止损均不退出，继续观察到对应期限。止损后收复=反事实净R&gt;0；止损后继续下跌=反事实净R低于实际止损净R；目标后继续=反事实净R高于实际目标净R。只用于提出影子实验假设。</p><table><thead><tr><th>期限</th><th>止损样本</th><th>止损后收复</th><th>止损后继续跌</th><th>目标样本</th><th>目标后继续涨</th></tr></thead><tbody>${rows.map((x) => `<tr><td>T+${x.horizon}</td><td class="num">${x.stopCount}</td><td class="num">${x.stopRecovered}（${researchPctText(x.stopCount ? x.stopRecovered / x.stopCount * 100 : null)}）</td><td class="num">${x.stopFurtherDown}（${researchPctText(x.stopCount ? x.stopFurtherDown / x.stopCount * 100 : null)}）</td><td class="num">${x.targetCount}</td><td class="num">${x.targetContinued}（${researchPctText(x.targetCount ? x.targetContinued / x.targetCount * 100 : null)}）</td></tr>`).join("")}</tbody></table></details>`;
  }

function failureMatrixHTML(rows) {
    return `<details class="research-detail"><summary>失效原因矩阵 · 研究标签而非因果结论</summary><table><thead><tr><th>标签 / 定义</th><th>合计 / 平均R</th><th>超跌</th><th>回踩</th><th>突破</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${esc(x.label)}<div class="small muted">${esc(x.definition)}</div></td><td class="num">${x.count} / ${fmt(x.avgR, 3)}</td>${Object.keys(C.CHANNELS).map((c) => `<td class="num">${x.channels[c].count} / ${fmt(x.channels[c].avgR, 3)}</td>`).join("")}</tr>`).join("")}</tbody></table></details>`;
  }

function unfilledFunnelHTML(rows, skippedCount = 0) {
    const mismatch = skippedCount > 0 && !rows.length;
    return `<details class="research-detail" open><summary>未成交原因漏斗 · ${skippedCount} 个信号 · 每个只记一个主原因</summary><p class="small muted">结构失效优先作为终因；其余取最后一次开盘检查原因。百分比以该通道未成交信号为分母，多次开盘尝试不会重复计数。</p>${mismatch ? `<div class="notice">未成交总数为 ${skippedCount}，但归因明细为空；请导出完整回放核查数据链路，不能据此推断原因。</div>` : ""}${rows.length ? `<table><thead><tr><th>通道</th><th>主原因</th><th>信号数</th><th>通道内占比</th></tr></thead><tbody>${rows.map((x) => `<tr><td>${esc(C.CHANNELS[x.channel].name)}</td><td>${esc(x.label)}</td><td class="num">${x.count}</td><td class="num">${researchPctText(x.pct)}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">本次没有已结束的未成交信号。</div>'}</details>`;
  }

function tradePathHTML(t) {
    const cf = t.counterfactualPath || [],
      actual = t.closePath || [];
    if (!cf.length && !actual.length) return "";
    return `<details class="path-detail"><summary>路径 / MFE / MAE</summary><div class="small muted path-metrics">MFE ${fmt(t.mfeR, 3)}R · MAE ${fmt(t.maeR, 3)}R · 等待 ${fmt(t.entryWaitDays, 0)} 日 · 持有 T+${fmt(t.holdingTradingDays, 0)} · 首次目标／止损 ${t.firstTargetDay === null ? "—" : "T+" + t.firstTargetDay}／${t.firstStopDay === null ? "—" : "T+" + t.firstStopDay}</div><div class="path-grid path-head"><span>交易日</span><span>策略实际</span><span>不退出反事实</span></div>${cf.map((p) => {
      const a = actual.find((x) => x.t === p.t),
        actualText = a ? `${fmt(a.netR, 3)}R` : t.settled !== false && t.exitIndex <= p.t ? `锁定 ${fmt(t.R, 3)}R` : "—";
      return `<div class="path-grid"><span>T+${p.t} · ${esc(p.date)}</span><span class="num">${actualText}</span><span class="num">${fmt(p.netR, 3)}R</span></div>`;
    }).join("")}</details>`;
  }

function renderReplay(s, cfg) {
    state.lastReplay = { version: C.VERSION, createdAt: new Date().toISOString(), config: cfg, summary: s };
    $("exportReplayBtn").disabled = false;
    const metric = (label, val) => `<div><span class="small muted">${label}</span><b>${val}</b></div>`,
      ci = s.overall.confidence || {},
      interval = (a, suffix = "") => a && a.length ? `${fmt(a[0], 3)}～${fmt(a[1], 3)}${suffix}` : "—";
    $("replayOutput").innerHTML =
      `<div class="result-grid">${metric("已结算样本", s.overall.count)}${metric("胜率", researchPctText(s.overall.winRate))}${metric("平均净R", fmt(s.overall.avgR, 3))}${metric("Profit factor", pfText(s.overall.profitFactor))}</div><div class="notice ${s.overall.count < 30 ? "" : "info"}">${esc(s.overall.status)}。当前池回放不是样本外验证；右删失／不可退出待结算 ${s.pendingCount || 0} 笔，未成交信号 ${s.skippedCount} 个，最大持有 ${cfg.holdingDays} 根日K。</div><p class="small ${s.diagnostics && s.diagnostics.conflictCount ? "warn" : "muted"}">一致性处理：杠杆／反向ETF排除 ${(s.diagnostics && s.diagnostics.excludedSymbols.length) || 0} 只；超跌／突破同日冲突 ${(s.diagnostics && s.diagnostics.conflictCount) || 0} 次，冲突日不生成独立双入场。趋势回踩仅作影子研究。</p><p class="small muted">按标的聚类Bootstrap（${ci.iterations || 0}次，${ci.clusters || 0}个标的簇）95%区间：平均R ${interval(ci.avgR)}；胜率 ${interval(ci.winRate, "%")}；PF ${interval(ci.profitFactor)}。区间只反映当前簇重抽样，不消除幸存者偏差、选择偏差或多重试验。</p><table><thead><tr><th>通道</th><th>结算 / 待结算 / 跳过</th><th>胜率</th><th>平均R</th><th>中位R</th><th>PF</th><th>目标 / 止损</th></tr></thead><tbody>${s.channels.map((x) => `<tr><td>${esc(C.CHANNELS[x.channel].name)}</td><td class="num">${x.count} / ${x.pending} / ${x.skipped}</td><td class="num">${researchPctText(x.winRate)}</td><td class="num">${fmt(x.avgR, 3)}</td><td class="num">${fmt(x.medianR, 3)}</td><td class="num">${pfText(x.profitFactor)}</td><td class="num">${x.targets} / ${x.stops}</td></tr>`).join("")}</tbody></table>${channelConfidenceHTML(s.channels || [])}${pairedHorizonHTML(s.pairedHorizon || [])}${fixedHorizonHTML(s.fixedHorizon || [])}${counterfactualHTML(s.counterfactual || [])}${failureMatrixHTML(s.failureMatrix || [])}${tailConcentrationHTML(s.tailConcentration || [])}${unfilledFunnelHTML(s.unfilledFunnel || [], s.skippedCount || 0)}${scoreDiagnosticsHTML(s.scoreDiagnostics || [])}<h3 style="margin:20px 0 8px">最近回放明细（最多20笔，可展开路径）</h3><table><thead><tr><th>标的</th><th>通道</th><th>信号 / 入场 / 退出</th><th>退出原因 / 路径</th><th>净R / T+5</th></tr></thead><tbody>${s.trades.slice(-20).reverse().map((t) => `<tr><td>${esc(t.name)}<div class="stock-code">${esc(t.code)}</div></td><td>${esc(C.CHANNELS[t.channel].name)}</td><td class="num small">${esc(t.signalDate)}<br>${esc(t.entryDate)} → ${esc(t.exitDate)}${t.settled === false ? '<br><span class="warn">待结算·不计总绩效</span>' : ""}</td><td>${esc(t.reason)}${tradePathHTML(t)}</td><td class="num ${t.R > 0 ? "up" : "down"}">${fmt(t.R, 3)}<div class="small muted">T+5 ${t.fixedHorizon && t.fixedHorizon[5] && t.fixedHorizon[5].available ? fmt(t.fixedHorizon[5].netR, 3) : "—"}</div></td></tr>`).join("")}</tbody></table>`;
  }

function renderWatchList() {
    $("watchList").innerHTML = state.list
      .map(
        (x, i) =>
          `<div class="watch-row"><div><b>${esc(x[1])}</b><div class="stock-code">${esc(x[0])}${x[2] ? " · 参考指数" : ""}</div></div><span class="small muted">${isUS(x[0]) ? "美股" : "A股"}</span><button class="ghost danger" data-remove="${i}" type="button">移除</button></div>`,
      )
      .join("");
  }

function openDialog(id) {
    $(id).showModal();
  }

/* 模块导出（boot 加载校验与外部调试入口） */
globalThis.QuantUI = {
  renderSignals, renderDiagnostics, renderIntradayPanel, renderReplay,
  getSelfTests, renderWatchList, openDialog,};
