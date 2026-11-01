/* Quant v13.0 · quant-journal.js
   留痕层：开盘模型前向、盘中触发档案、localStorage 读写。冻结口径与 quant-core.js 一致。
   加载顺序：quant-rules → quant-core → quant-data → quant-journal → quant-ui → quant-main。 */
"use strict";

function saveIntradaySamples() {
    try { localStorage.setItem("quant_v11_intraday_samples_v1", JSON.stringify(state.intradaySamples)); } catch (e) {}
  }

function captureIntradaySample(r) {
    if (!r.primary || r.primary.stage !== 3 || isIndex(r.code)) return false;
    const q = currentQuote(r);
    if (!q.qtime || !Number.isFinite(q.price) || q.price <= 0 || C.marketSession(r.market, new Date()).state !== "REGULAR") return false;
    const zone = r.market === "A" ? "Asia/Shanghai" : "America/New_York",
      quoteDay = C.tzInfo(new Date(q.qtime), zone).day,
      today = C.tzInfo(new Date(), zone).day;
    if (quoteDay !== today) return false;
    const key = currentIntradayKey(r, quoteDay), rows = Array.isArray(state.intradaySamples[key]) ? state.intradaySamples[key] : [],
      previous = rows[rows.length - 1];
    if (previous && previous.qtime === q.qtime && previous.price === q.price) return false;
    rows.push({ qtime: q.qtime, price: q.price, low: q.low, high: q.high, amount: q.amount, source: q.source || r.source });
    state.intradaySamples[key] = rows.slice(-16);
    return true;
  }

function captureAllIntradaySamples() {
    let changed = false;
    const cutoff = Date.now() - 36 * 60e3;
    for (const [key, rows] of Object.entries(state.intradaySamples)) {
      if (!Array.isArray(rows) || !rows.length || !Number.isFinite(rows[rows.length - 1].qtime) || rows[rows.length - 1].qtime < cutoff) {
        delete state.intradaySamples[key]; changed = true;
      }
    }
    for (const r of state.rows.values()) changed = captureIntradaySample(r) || changed;
    if (changed) saveIntradaySamples();
    return changed;
  }

function intradayEntries() {
    return state.intradayRecords;
  }

function saveIntraday(entries) {
    state.intradayRecords = entries.slice(0, 300);
    safeSet("quant_v11_intraday_v1", { version: C.VERSION, executionModel: "INTRADAY_V1", entries: state.intradayRecords });
  }

function canonicalIntradayConfig(cfg) {
    return Object.fromEntries(Object.keys(C.DEFAULTS).map((key) => [key, (cfg || {})[key]]));
  }

function captureIntradayTriggers() {
    if (state.loading || state.scanning || state.mode !== "watch") return 0;
    const entries = intradayEntries().slice(), ids = new Set(entries.map((e) => e.id));
    let added = 0;
    for (const r of state.rows.values()) {
      if (isIndex(r.code) || C.marketSession(r.market, new Date()).state !== "REGULAR") continue;
      const p = r.primary, a = currentIntraday(r);
      if (!a.actionable || !p || !p.triggerGeometry) continue;
      const geometryHash = stableHash(p.triggerGeometry),
        id = [C.VERSION, a.planKey, geometryHash].join("|");
      if (ids.has(id)) continue;
      const cfg = { ...state.config }, currentGeometry = C.repriceGeometry(p.triggerGeometry, r.price, cfg),
        completed = C.completedBars(state.bars.get(r.code) || [], r.market, new Date()),
        f = completed.length ? C.features(completed) : null,
        E = f ? C.scoreE(currentGeometry, p.age, f, cfg, r.market) : null,
        tq = p.triggerQ || p.Q, te = p.triggerE || p.E,
        q = currentQuote(r), nowIso = new Date().toISOString();
      entries.unshift({
        id, planKey: a.planKey, version: C.VERSION, executionModel: "INTRADAY_V1",
        savedAt: nowIso, firstTriggeredAt: new Date(q.qtime).toISOString(), dataAsOf: r.barsDate || null,
        recordOrigin: "PRE_ENTRY", done: false, pendingStage: "等待入场日日K完成",
        pendingDetail: "模型按首次五门通过报价建档；不代表用户实际成交", nextCheckDate: "入场日完成日K入库后",
        lastCheckedAt: nowIso, lastDataAsOf: r.barsDate || null,
        modelParamsHash: stableHash({ config: canonicalIntradayConfig(cfg) }), geometryHash,
        code: r.code, name: r.name, market: r.market, channel: p.channel, triggerDate: p.triggerDate,
        executionDate: a.quoteDay, entryPrice: r.price, netRR: a.netRR, volumePace: a.volumePace,
        Q: tq.value, E: te && te.value, S: Number.isFinite(p.triggerS) ? p.triggerS : p.S,
        E_intraday: E && E.value, S_intraday: E ? round1(tq.value * 0.6 + E.value * 0.4) : null,
        checks: a.checks, confirmation: a.confirmation,
        quote: { price: q.price, qtime: q.qtime, amount: q.amount, high: q.high, low: q.low, prevClose: q.prevClose, source: q.source || r.source },
        config: cfg,
        signal: { geometry: p.triggerGeometry, signalClose: p.triggerGeometry.entryPrice, limitPct: r.market === "A" ? C.priceLimit(r.code, r.name) : null },
      });
      ids.add(id); added++;
      log(`盘中五门通过并留痕：${r.name} ${p.channel} @ ${fmt(r.price)}；仅模型快照，非实际成交`);
    }
    if (added) {
      saveIntraday(entries);
      renderIntradayJournal();
      toast(`新增 ${added} 条盘中触发快照；请人工复核账户纪律`);
    }
    return added;
  }

function updateIntradayJournal() {
    if (state.mode !== "watch") return;
    const entries = intradayEntries().slice(), nowIso = new Date().toISOString();
    let changed = false;
    for (const e of entries) {
      if (e.done) continue;
      changed = true; e.lastCheckedAt = nowIso;
      const rawBars = state.bars.get(e.code) || [],
        bars = C.completedBars(rawBars, e.market, new Date());
      if (!bars.length) {
        setPending(e, "等待标的日K", "档案保留；标的仍在池时等待日K，移出池后重新加入可继续", "下次完整刷新后");
        continue;
      }
      e.lastDataAsOf = bars[bars.length - 1].date;
      const result = C.executeIntradayTrade(e.signal, e.executionDate, e.entryPrice, bars, e.market, e.config);
      e.pendingResult = result;
      if (result.status === "SKIP" || (result.status === "CLOSED" && result.settled !== false)) {
        e.done = true; e.result = result; e.settledAt = nowIso; clearPending(e);
      } else if (result.status === "CLOSED") {
        setPending(e, "盘中模型持仓中", `${result.exitDate || e.lastDataAsOf} 已观察到路径，但持有期不足或退出受限；不按已结算绩效统计`, "后续完成日K后");
      } else {
        setPending(e, bars.some((b) => b.date === e.executionDate) ? "等待次日日K" : "等待入场日日K完成",
          `${result.reason}；入场日不利用完整日K倒推触发后的高低点`, "下一完成日K后");
      }
    }
    if (changed) saveIntraday(entries);
    renderIntradayJournal();
  }

function renderIntradayJournal() {
    const all = intradayEntries(), s = C.summarizeIntraday(all),
      metric = (label, value) => `<div><span class="small muted">${label}</span><b>${value}</b></div>`,
      dash = (x, d = 2) => Number.isFinite(x) ? fmt(x, d) : "—";
    $("intradayOutput").innerHTML = `<div class="result-grid">${metric("首次触发快照", s.total)}${metric("已结算 / 待结算", `${s.closed} / ${s.pending}`)}${metric("平均净R", dash(s.avgR, 3))}${metric("Profit factor", Number.isFinite(s.profitFactor) ? pfText(s.profitFactor) : s.profitFactor === Infinity ? "∞" : "—")}</div><div class="notice ${s.closed < 30 ? "" : "info"}">${esc(s.status)}。这是独立 Intraday v1 模型：首次五门通过时按当时报价模拟入场并计成本，不是用户实际成交；与开盘价前向模型绝不混合。</div><p class="small muted">触发保存公开报价、确认样本、Q／E、冻结几何和参数指纹。入场日没有触发后的逐笔路径，因此退出、MFE／MAE只从下一完成日K开始；A股与美股均不利用入场日完整日K倒推当日退出。记录仅保存当前浏览器，最多300条。</p>${all.length ? `<table><thead><tr><th>标的 / 通道</th><th>日线触发 / 盘中触发</th><th>入场 / 净赔率 / 量能</th><th>触发Q/E与盘中E</th><th>状态 / 净R</th><th>确认证据</th></tr></thead><tbody>${all.slice(0, 30).map((e) => `<tr><td>${esc(e.name)}<div class="stock-code">${esc(e.code)}</div></td><td>${esc(C.CHANNELS[e.channel].name)}<div class="small muted">${esc(e.triggerDate)} / ${esc(e.executionDate)}</div></td><td class="num">${dash(e.entryPrice)}<div class="small muted">${dash(e.netRR)}∶1 / ${dash(e.volumePace)}×</div></td><td class="num">${dash(e.Q, 1)} / ${dash(e.E, 1)}<div class="small muted">E盘中 ${dash(e.E_intraday, 1)}</div></td><td>${e.done ? esc(e.result && e.result.reason || "已结束") : esc(e.pendingStage || "待结算")}<div class="num small">${e.done && e.result && Number.isFinite(e.result.R) ? fmt(e.result.R, 3) : "—"}</div></td><td class="small">${e.confirmation ? `${e.confirmation.required}次报价 · 区内 ${e.confirmation.heldZone ? "是" : "否"} · 未走弱 ${e.confirmation.notWeakening ? "是" : "否"}` : "—"}<div class="muted">${esc(e.quote && e.quote.source || "—")} · ${esc(e.firstTriggeredAt || "—")}</div></td></tr>`).join("")}</tbody></table>` : '<div class="empty"><strong>尚无盘中触发记录</strong>盘前预案和单次报价不会建档；只有五门首次全部通过才生成不可变模型快照。</div>'}`;
  }

const FORWARD_KEY = "quant_v10_forward_v1";

function forwardEntries() {
    const j = safeGet(FORWARD_KEY);
    return j && Array.isArray(j.entries) ? j.entries : [];
  }

function capForwardEntries(entries, max = 500) {
    if (entries.length <= max) return entries;
    const protectedEntries = entries.filter((e) => !e.done || isStrictForward(e)),
      protectedSet = new Set(protectedEntries),
      ordinary = entries.filter((e) => !protectedSet.has(e)),
      keep = new Set([...protectedEntries, ...ordinary.slice(0, Math.max(0, max - protectedEntries.length))]);
    return entries.filter((e) => keep.has(e));
  }

function saveForward(entries) {
    safeSet(FORWARD_KEY, { version: C.VERSION, strategyVersion: C.STRATEGY_VERSION, entries: capForwardEntries(entries) });
  }

function stableHash(value) {
    const text = JSON.stringify(value), x = String(text);
    let h = 2166136261;
    for (let i = 0; i < x.length; i++) {
      h ^= x.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

function signalKey(e) {
    return e.signalKey || [e.code, e.channel, e.triggerDate].join("|");
  }

function compareForwardArchives(a, b) {
    const at = String(a.savedAt || ""), bt = String(b.savedAt || "");
    if (at && bt && at !== bt) return at.localeCompare(bt);
    if (at !== bt) return at ? -1 : 1;
    const version = String(a.version || "").localeCompare(String(b.version || ""), undefined, { numeric: true });
    if (version) return version;
    return String(a.recordId || a.id || "").localeCompare(String(b.recordId || b.id || ""));
  }

function uniqueForward(entries) {
    const chosen = new Map();
    for (const e of entries) {
      const key = signalKey(e), old = chosen.get(key);
      if (!old || compareForwardArchives(e, old) < 0) chosen.set(key, e);
    }
    return [...chosen.values()];
  }

function originLabel(e) {
    return { PRE_ENTRY: "事前登记", WINDOW_BACKFILL: "窗口中补录", POST_ENTRY: "入场后补录" }[e.recordOrigin] || "旧版档案";
  }

function canonicalModelConfig(cfg) {
    const dailyKeys = ["minBars", "minAmountA", "minAmountUS", "feeBps", "slippageBps", "minRR", "holdingDays", "minStopAtr", "maxStopAtr"];
    return Object.fromEntries(dailyKeys.map((key) => [key, (cfg || {})[key]]));
  }

function modelParamsHash(e) {
    return e.modelParamsHash || stableHash({ config: canonicalModelConfig(e.config) });
  }

function strategyCohortVersion(e) {
    return e.strategyVersion || `legacy:${e.version || "unknown"}`;
  }

function cohortKey(e) {
    return `${strategyCohortVersion(e)}|${modelParamsHash(e)}`;
  }

function currentCohortKey() {
    return `${C.STRATEGY_VERSION}|${stableHash({ config: canonicalModelConfig(state.config) })}`;
  }

function isStrictForward(e) {
    return e.recordOrigin === "PRE_ENTRY" && !!e.savedAt && !!e.dataAsOf && e.dataAsOf === e.triggerDate;
  }

const round1 = (x) => Number.isFinite(x) ? Math.round(x * 10) / 10 : null;

function summarizeForward(entries) {
    const closed = entries.filter((e) => e.done && e.result && e.result.status === "CLOSED"),
      skipped = entries.filter((e) => e.done && e.result && e.result.status === "SKIP"),
      pending = entries.filter((e) => !e.done),
      rs = closed.map((e) => e.result.R).filter(Number.isFinite);
    return {
      total: entries.length,
      closed: closed.length,
      skipped: skipped.length,
      pending: pending.length,
      avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null,
    };
  }

function nextTradingDateAfter(market, date) {
    const hit = (state.benchmark[market] || []).find((b) => b.date > date);
    return hit ? hit.date : null;
  }

function setPending(e, stage, detail, nextCheck) {
    e.done = false;
    e.pendingStage = stage;
    e.pendingDetail = detail || null;
    e.nextCheckDate = nextCheck || "下一交易日开盘";
  }

function clearPending(e) {
    e.pendingStage = null;
    e.pendingDetail = null;
    e.nextCheckDate = null;
  }

function entryScoreSnapshot(e, bars, result) {
    if (!result || result.status !== "CLOSED") return null;
    const offset = result.entryOffset || 0,
      triggerIndex = bars.findIndex((b) => b.date === e.triggerDate),
      entryBar = triggerIndex >= 0 ? bars[triggerIndex + 1 + offset] : null;
    if (!entryBar) return null;
    const decision = C.openingDecision(e.signal, entryBar, e.market, e.config);
    if (decision.status !== "ENTER") return null;
    const history = bars.slice(0, triggerIndex + 1 + offset),
      f = C.features(history);
    if (!f) return null;
    const score = C.scoreE(decision.entryGeometry, offset, f, e.config, e.market);
    return {
      modelEntryDate: result.entryDate || entryBar.date,
      modelEntryPrice: +entryBar.open,
      E_entry: score.value,
      S_entry: round1(e.Q * 0.6 + score.value * 0.4),
    };
  }

function entryScoreFromRow(r, p, cfg) {
    if (!p.entryDate || !p.modelEntryGeometry || !Number.isFinite(p.entryPrice)) return null;
    const history = (state.bars.get(r.code) || []).filter((b) => b.date < p.entryDate),
      f = history.length ? C.features(history) : null;
    if (!f) return null;
    const age = history.filter((b) => b.date > p.triggerDate).length,
      score = C.scoreE(p.modelEntryGeometry, age, f, cfg, r.market);
    return {
      modelEntryDate: p.entryDate,
      modelEntryPrice: p.entryPrice,
      E_entry: score.value,
      S_entry: round1((p.triggerQ || p.Q).value * 0.6 + score.value * 0.4),
    };
  }

function updateForwardJournal() {
    if (state.mode !== "watch") return;
    const entries = forwardEntries(), nowIso = new Date().toISOString();
    for (const e of entries) {
      if (!e.recordId) e.recordId = e.id;
      if (!e.modelParamsHash) e.modelParamsHash = modelParamsHash(e);
      if (!e.geometryHash && e.signal && e.signal.geometry) e.geometryHash = stableHash(e.signal.geometry);
      if (e.isPrimary === undefined) e.isPrimary = true;
      if (e.done) continue;
      e.lastCheckedAt = nowIso;
      if (!e.signal || !e.signal.geometry || !e.config) {
        setPending(e, "档案数据异常", "缺少几何或参数快照；建议导出备份后清空并重建档案", "人工处理后");
        continue;
      }
      const bars = state.bars.get(e.code);
      if (!bars || !bars.length) {
        const inPool = state.list.some((x) => x[0] === e.code);
        setPending(
          e,
          inPool ? "等待标的日K" : "标的已移出当前研究池",
          inPool ? "标的仍在研究池，但本次尚未载入日K" : "档案保留；重新加入研究池并刷新后可继续结算",
          inPool ? "下次刷新后" : "重新加入研究池后",
        );
        continue;
      }
      e.lastDataAsOf = bars.length ? bars[bars.length - 1].date : null;
      const i = bars.findIndex((b) => b.date === e.triggerDate);
      if (i < 0) {
        setPending(e, "触发日K缺失", `当前日K截至 ${e.lastDataAsOf || "—"}，未找到触发日 ${e.triggerDate}`, "数据修复后");
        continue;
      }
      if (!bars[i + 1]) {
        setPending(e, "等待首次开盘", "触发日后的第一根完成日K尚未入库", nextTradingDateAfter(e.market, e.triggerDate) || "下一交易日开盘");
        continue;
      }
      const entryWindowDays = e.entryWindowDays || 1,
        researchDays = Math.max(e.config.holdingDays, 11),
        future = bars.slice(i + 1, i + entryWindowDays + researchDays),
        result = C.executeTradeWindow(e.signal, future, e.market, e.config, entryWindowDays),
        closedComplete = result.status === "CLOSED" && result.settled !== false;
      e.pendingResult = result;
      if (result.status === "CLOSED" && !Number.isFinite(e.E_entry)) {
        const entryScore = entryScoreSnapshot(e, bars, result);
        if (entryScore) Object.assign(e, entryScore);
      }
      if ((result.status === "SKIP" && !result.pending) || closedComplete) {
        e.done = true;
        e.result = result;
        e.settledAt = nowIso;
        clearPending(e);
      } else if (result.status === "CLOSED") {
        const dueIndex = i + 1 + (result.entryOffset || 0) + e.config.holdingDays - 1,
          due = bars[dueIndex] ? bars[dueIndex].date : `第${e.config.holdingDays}个持有交易日`;
        setPending(
          e,
          "模型持仓中",
          `${result.entryDate || e.modelEntryDate || "入场日待核"} 入场；持有期至 ${due}，或先触发止损/目标${result.reason === "LIMIT_DOWN_EXIT_BLOCKED" ? "；最新日一字跌停，退出仍受限" : ""}`, 
          nextTradingDateAfter(e.market, e.lastDataAsOf) || "下一完成日K后",
        );
      } else {
        const attempts = result.attempts || [], used = attempts.length,
          lastAttempt = used ? attempts[used - 1] : null;
        if (!used) {
          setPending(e, "等待首次开盘", "尚无首次开盘检查结果", nextTradingDateAfter(e.market, e.triggerDate) || "下一交易日开盘");
        } else if (lastAttempt && lastAttempt.reason === "缺少有效开盘价") {
          setPending(e, "开盘数据待确认", `${lastAttempt.date} 缺少有效开盘价，不能猜测是否已用窗口`, "开盘价补齐后");
        } else {
          setPending(
            e,
            "等待下次开盘",
            `已检查 ${used} / ${entryWindowDays} 次；最近原因：${lastAttempt ? lastAttempt.reason : "—"}`,
            nextTradingDateAfter(e.market, e.lastDataAsOf) || "下一交易日开盘",
          );
        }
      }
    }
    const ids = new Set(entries.map((e) => e.id)),
      identities = new Set(entries.map((e) => [
        strategyCohortVersion(e),
        signalKey(e),
        modelParamsHash(e),
        e.entryWindowDays || 1,
        e.geometryHash || (e.signal && e.signal.geometry ? stableHash(e.signal.geometry) : "missing"),
      ].join("|")));
    for (const r of state.rows.values()) {
      for (const p of r.channels || []) {
        if (!p || p.stage !== 3 || !p.triggerGeometry || !["NEXT_SESSION_PLAN", "WAIT_ENTRY", "MODEL_ENTERED"].includes(p.status)) continue;
        const cfg = { ...state.config },
          entryWindowDays = Math.max(1, C.CHANNELS[p.channel].maxAge - 1),
          key = [r.code, p.channel, p.triggerDate].join("|"),
          fingerprint = stableHash({ config: cfg, entryWindowDays, geometry: p.triggerGeometry }),
          id = [C.STRATEGY_VERSION, key, fingerprint].join("|"),
          modelHash = stableHash({ config: canonicalModelConfig(cfg) }),
          geometryHash = stableHash(p.triggerGeometry),
          isPrimary = !!r.primary && r.primary.channel === p.channel,
          identity = [C.STRATEGY_VERSION, key, modelHash, entryWindowDays, geometryHash].join("|");
        if (ids.has(id) || identities.has(identity)) continue;
        ids.add(id);
        identities.add(identity);
        const tq = p.triggerQ || p.Q,
          te = p.triggerE || p.E,
          ts = Number.isFinite(p.triggerS) ? p.triggerS : p.S,
          recordOrigin = p.entryDate ? "POST_ENTRY" : p.age === 0 ? "PRE_ENTRY" : "WINDOW_BACKFILL",
          entryScore = entryScoreFromRow(r, p, cfg);
        entries.unshift({
          id, recordId: id, signalKey: key, version: C.VERSION, strategyVersion: C.STRATEGY_VERSION, savedAt: nowIso, done: false,
          modelParamsHash: modelHash, geometryHash,
          recordOrigin,
          isPrimary,
          rowStatus: r.status,
          pendingStage: p.entryDate ? "模型持仓中" : p.age === 0 ? "等待首次开盘" : "等待下次开盘",
          pendingDetail: p.entryDate ? "等待后续完成日K结算" : "等待下一次可核验开盘",
          nextCheckDate: nextTradingDateAfter(r.market, p.triggerDate) || "下一交易日开盘",
          dataAsOf: r.barsDate || null,
          lastDataAsOf: r.barsDate || null,
          lastCheckedAt: nowIso,
          modelEntryDate: entryScore ? entryScore.modelEntryDate : null,
          modelEntryPrice: entryScore ? entryScore.modelEntryPrice : null,
          E_entry: entryScore ? entryScore.E_entry : null,
          S_entry: entryScore ? entryScore.S_entry : null,
          code: r.code, name: r.name, market: r.market, channel: p.channel, triggerDate: p.triggerDate,
          Q: tq.value, E: te && te.value, S: ts,
          observedQ: p.Q.value, observedE: p.E.value, observedS: p.S,
          config: cfg, entryWindowDays,
          signal: { geometry: p.triggerGeometry, signalClose: p.triggerGeometry.entryPrice, limitPct: r.market === "A" ? C.priceLimit(r.code, r.name) : null },
        });
      }
    }
    saveForward(entries);
    renderForward();
  }

function runForwardAuditTests() {
    const tests = [], test = (name, fn) => {
      try {
        const r = fn();
        tests.push({ name, pass: r === true, detail: r === true ? "通过" : String(r) });
      } catch (e) {
        tests.push({ name, pass: false, detail: e.message });
      }
    };
    test("纯前向统计排除补录档案", () => {
      const rows = [
        { code: "a", channel: "breakout", triggerDate: "2026-01-01", dataAsOf: "2026-01-01", recordOrigin: "POST_ENTRY", savedAt: "2026-01-02T00:00:00Z", done: true, result: { status: "CLOSED", R: -1 } },
        { code: "b", channel: "pullback", triggerDate: "2026-01-02", dataAsOf: "2026-01-02", recordOrigin: "PRE_ENTRY", savedAt: "2026-01-02T00:00:00Z", done: true, result: { status: "CLOSED", R: 0.5 } },
        { code: "b", channel: "pullback", triggerDate: "2026-01-02", dataAsOf: "2026-01-02", recordOrigin: "PRE_ENTRY", savedAt: "2026-01-03T00:00:00Z", done: true, result: { status: "CLOSED", R: 2 } },
        { code: "c", channel: "oversold", triggerDate: "2026-01-03", dataAsOf: "2026-01-03", recordOrigin: "PRE_ENTRY", savedAt: "2026-01-03T00:00:00Z", done: true, result: { status: "SKIP" } },
      ];
      const observation = summarizeForward(uniqueForward(rows)),
        strict = summarizeForward(uniqueForward(rows.filter(isStrictForward)));
      return observation.closed === 2 && strict.total === 2 && strict.closed === 1 && strict.skipped === 1 && strict.pending === 0 && strict.avgR === 0.5;
    });
    test("严格前向校验数据日且不同参数簇隔离", () => {
      const valid = { version: "v10.5", triggerDate: "2026-01-02", dataAsOf: "2026-01-02", savedAt: "2026-01-02T08:00:00Z", recordOrigin: "PRE_ENTRY", config: { minRR: 1.5 } },
        missingDate = { ...valid, dataAsOf: null },
        changed = { ...valid, config: { minRR: 2 } };
      return isStrictForward(valid) && !isStrictForward(missingDate) && cohortKey(valid) !== cohortKey(changed) &&
        modelParamsHash(valid) === modelParamsHash({ ...valid, config: { ...valid.config, deepLimit: 120 } });
    });
    test("入场评分冻结实际开盘执行质量", () => {
      const bars = C.makeSynthetic(100),
        close = bars[bars.length - 1].close,
        next = new Date(Date.parse(bars[bars.length - 1].date + "T00:00:00Z") + 864e5).toISOString().slice(0, 10),
        open = close,
        geometry = { valid: true, zoneLo: close * 0.99, zoneHi: close * 1.01, stop: close * 0.9, target: close * 1.2 },
        entryBar = { date: next, open, high: open, low: open, close: open, volume: 1e7, amount: open * 1e7 },
        e = {
          triggerDate: bars[bars.length - 1].date,
          Q: 80,
          signal: { geometry, signalClose: close, limitPct: null },
          config: C.DEFAULTS,
          market: "US",
        },
        result = C.executeTradeWindow(e.signal, [entryBar], "US", C.DEFAULTS, 1),
        snap = entryScoreSnapshot(e, bars.concat([entryBar]), result);
      return result.status === "CLOSED" && !!snap && snap.modelEntryPrice === open &&
        Number.isFinite(snap.E_entry) && snap.S_entry === round1(e.Q * 0.6 + snap.E_entry * 0.4);
    });
    test("页面升级不重置策略簇但策略升级会隔离", () => {
      const a = { version: "v12.0", strategyVersion: C.STRATEGY_VERSION, config: { minRR: 1.5 } },
        b = { ...a, version: "v12.1" }, changed = { ...a, strategyVersion: "OPENING_DAILY_V2" };
      return cohortKey(a) === cohortKey(b) && cohortKey(a) !== cohortKey(changed) &&
        strategyCohortVersion({ version: "v11.2" }) === "legacy:v11.2";
    });
    test("无保存时间的重复旧档案按数值版本确定性去重", () => {
      const newer = { code: "a", channel: "breakout", triggerDate: "2026-01-01", version: "v10.10" },
        older = { ...newer, version: "v10.6" };
      return uniqueForward([newer, older])[0].version === "v10.6";
    });
    test("档案上限保护未结算与严格前向记录", () => {
      const rows = Array.from({ length: 510 }, (_, i) => ({ id: `old-${i}`, done: true, recordOrigin: "POST_ENTRY" }));
      rows.push({ id: "pending", done: false }, { id: "strict", done: true, recordOrigin: "PRE_ENTRY", savedAt: "2026-01-01", dataAsOf: "2026-01-01", triggerDate: "2026-01-01" });
      const capped = capForwardEntries(rows);
      return capped.length === 500 && capped.some((e) => e.id === "pending") && capped.some((e) => e.id === "strict");
    });
    return tests;
  }

function forwardIdentity(e) {
    return [
      strategyCohortVersion(e), signalKey(e), modelParamsHash(e), e.entryWindowDays || 1,
      e.geometryHash || (e.signal && e.signal.geometry ? stableHash(e.signal.geometry) : "missing"),
    ].join("|");
  }

function currentCaptureCandidates() {
    const cfg = { ...state.config }, out = [], seen = new Set();
    for (const r of state.rows.values()) {
      for (const p of r.channels || []) {
        if (!p || p.stage !== 3 || !p.triggerGeometry || !["NEXT_SESSION_PLAN", "WAIT_ENTRY", "MODEL_ENTERED"].includes(p.status)) continue;
        const key = [r.code, p.channel, p.triggerDate].join("|"),
          entryWindowDays = Math.max(1, C.CHANNELS[p.channel].maxAge - 1),
          modelHash = stableHash({ config: canonicalModelConfig(cfg) }),
          geometryHash = stableHash(p.triggerGeometry),
          identity = [C.STRATEGY_VERSION, key, modelHash, entryWindowDays, geometryHash].join("|");
        if (seen.has(identity)) continue;
        seen.add(identity);
        out.push({ key, identity, code: r.code, name: r.name, channel: p.channel, triggerDate: p.triggerDate });
      }
    }
    return out;
  }

function forwardCaptureHTML(all, strictRows) {
    const candidates = currentCaptureCandidates(),
      identities = new Map();
    for (const e of all) {
      const key = forwardIdentity(e);
      if (!identities.has(key)) identities.set(key, []);
      identities.get(key).push(e);
    }
    const registered = candidates.filter((c) => identities.has(c.identity)),
      strict = candidates.filter((c) => (identities.get(c.identity) || []).some(isStrictForward)),
      post = candidates.filter((c) => {
        const rows = identities.get(c.identity) || [];
        return rows.length && !rows.some(isStrictForward) && rows.some((e) => e.recordOrigin === "POST_ENTRY");
      }),
      windowBackfill = candidates.filter((c) => {
        const rows = identities.get(c.identity) || [];
        return rows.length && !rows.some(isStrictForward) && !rows.some((e) => e.recordOrigin === "POST_ENTRY") && rows.some((e) => e.recordOrigin === "WINDOW_BACKFILL");
      }),
      unproven = all.filter((e) => e.recordOrigin === "PRE_ENTRY" && !isStrictForward(e)).length,
      entered = strictRows.filter((e) => e.modelEntryDate || e.pendingStage === "模型持仓中" || (e.done && e.result && e.result.status === "CLOSED")).length,
      metric = (label, value) => `<div><span class="small muted">${label}</span><b>${value}</b></div>`;
    return `<details class="research-detail" open><summary>前向捕获链 · 当前加载队列</summary><div class="result-grid">${metric("可登记经济信号", candidates.length)}${metric("已登记", registered.length)}${metric("严格事前登记", strict.length)}${metric("未登记 / 证据不足", `${candidates.length - registered.length} / ${registered.length - strict.length}`)}</div><p class="small muted">捕获范围仅是当前仍处有效窗口的信号，不是历史全量。当前队列：入场后补录 ${post.length}、窗口中补录 ${windowBackfill.length}、未登记 ${candidates.length - registered.length}；全部档案另有 ${unproven} 条 PRE_ENTRY 证据不足。</p><p class="small muted">当前策略簇严格链：样本 ${strictRows.length} → 模型曾入场 ${entered} → 未成交 ${strictRows.filter((e) => e.done && e.result && e.result.status === "SKIP").length} → 已结算 ${strictRows.filter((e) => e.done && e.result && e.result.status === "CLOSED").length}；待结算 ${strictRows.filter((e) => !e.done).length}。静态页面只有打开并刷新时才能登记。</p></details>`;
  }

function forwardGroups(all) {
    const map = new Map();
    for (const e of all) {
      const key = signalKey(e);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e);
    }
    return [...map.entries()].map(([key, entries]) => {
      const archives = entries.slice().sort((a, b) => compareForwardArchives(b, a));
      return { key, archives, representative: uniqueForward(entries)[0] };
    }).sort((a, b) => String(b.representative.triggerDate || "").localeCompare(String(a.representative.triggerDate || "")) || a.key.localeCompare(b.key));
  }

function forwardArchiveList(entries) {
    return `<details class="forward-archives"><summary>${entries.length} 份版本档案</summary><ol class="small muted">${entries.map((e) => `<li>${esc(e.version || "legacy")} · ${esc(strategyCohortVersion(e))} · ${esc(originLabel(e))} · Q/E/S ${fmt(e.Q, 1)}/${fmt(e.E, 1)}/${fmt(e.S, 1)}<br>保存 ${esc(e.savedAt || "—")} · 登记日 ${esc(e.dataAsOf || "—")}</li>`).join("")}</ol></details>`;
  }

function forwardObservationRow(group) {
    const e = group.representative,
      entryScoreText = (x) => Number.isFinite(x.E_entry) ? `${fmt(x.E_entry, 1)} / ${fmt(x.S_entry, 1)}` : "—";
    return `<tr><td>${esc(e.name)}<div class="stock-code">${esc(e.code)}</div></td><td>${esc(C.CHANNELS[e.channel].name)}<div class="small muted">${esc(e.triggerDate)} · 代表档案 ${esc(e.version || "legacy")}</div>${forwardArchiveList(group.archives)}</td><td class="num small">${fmt(e.Q, 1)} / ${fmt(e.E, 1)} / ${fmt(e.S, 1)}</td><td class="num">${entryScoreText(e)}</td><td>${esc(originLabel(e))}<div class="small muted">${e.done ? esc(e.result.status === "SKIP" ? "未成交" : "已结算") : esc(e.pendingStage || "待结算")}</div>${!e.done && e.pendingDetail ? `<div class="small muted">${esc(e.pendingDetail)}</div>` : ""}</td><td class="num">${e.done ? (e.result.status === "CLOSED" ? fmt(e.result.R, 3) : "—") : "—"}<div class="small muted">${e.done ? esc(e.result.reason) : ""}</div>${e.done && e.result.status === "CLOSED" ? tradePathHTML(e.result) : ""}</td><td class="small muted">登记 ${esc(e.dataAsOf || "—")}<br>当前 ${esc(e.lastDataAsOf || e.dataAsOf || "—")}<br>${e.done ? `结算 ${esc((e.settledAt || "").slice(0, 10) || "—")}` : `下次 ${esc(e.nextCheckDate || "—")}`}</td></tr>`;
  }

function renderForward() {
    const all = forwardEntries(),
      observation = summarizeForward(uniqueForward(all)),
      strictAll = all.filter(isStrictForward),
      currentKey = currentCohortKey(),
      strictRows = uniqueForward(strictAll.filter((e) => cohortKey(e) === currentKey)),
      strict = summarizeForward(strictRows),
      cohortMap = new Map(),
      groups = forwardGroups(all),
      metric = (label, value) => `<div><span class="small muted">${label}</span><b>${value}</b></div>`;
    for (const e of strictAll) {
      const key = cohortKey(e);
      if (!cohortMap.has(key)) cohortMap.set(key, []);
      cohortMap.get(key).push(e);
    }
    const cohorts = [...cohortMap.entries()].map(([key, rows]) => ({ key, rows, summary: summarizeForward(uniqueForward(rows)) }))
      .sort((a, b) => (a.key === currentKey ? -1 : b.key === currentKey ? 1 : a.key.localeCompare(b.key)));
    $("forwardOutput").innerHTML = `<h3 style="margin:16px 0 8px">当前策略内核 · 严格纯前向</h3><div class="result-grid">${metric("严格口径样本", strict.total)}${metric("已结算 / 未成交", `${strict.closed} / ${strict.skipped}`)}${metric("待结算", strict.pending)}${metric("平均净R", strict.avgR === null ? "—" : fmt(strict.avgR, 3))}</div>${strict.total === 0 ? '<div class="notice">当前策略簇没有严格前向样本，不能据此判断收益、执行优势或页面版本优劣。</div>' : ""}<p class="small muted">策略 ${esc(C.STRATEGY_VERSION)} · 页面 ${esc(C.VERSION)} · 参数簇 ${esc(currentKey)}。严格口径要求 PRE_ENTRY、savedAt 和 dataAsOf=triggerDate；页面展示升级不重置策略簇，旧档案缺少策略版本时按 legacy:页面版本隔离。</p>${forwardCaptureHTML(all, strictRows)}<details class="research-detail" ${cohorts.length > 1 ? "open" : ""}><summary>严格前向 · 分策略版本与参数簇</summary>${cohorts.length ? `<table><thead><tr><th>模型簇</th><th>去重样本</th><th>结算 / 未成交</th><th>待结算</th><th>平均净R</th></tr></thead><tbody>${cohorts.map((x) => `<tr><td class="small">${esc(x.key)}${x.key === currentKey ? ' <span class="badge current">当前</span>' : ""}</td><td class="num">${x.summary.total}</td><td class="num">${x.summary.closed} / ${x.summary.skipped}</td><td class="num">${x.summary.pending}</td><td class="num">${fmt(x.summary.avgR, 3)}</td></tr>`).join("")}</tbody></table>` : '<div class="empty">暂无符合严格口径的前向样本。</div>'}</details><h3 style="margin:16px 0 8px">全部观察样本 · 按经济信号分组</h3><div class="result-grid">${metric("经济信号去重", observation.total)}${metric("已结算 / 未成交", `${observation.closed} / ${observation.skipped}`)}${metric("待结算", observation.pending)}${metric("观察平均净R", observation.avgR === null ? "—" : fmt(observation.avgR, 3))}</div><p class="small muted">默认每个“标的＋通道＋触发日”一行，共 ${groups.length} 组、${all.length} 份原始档案；代表档案用于去重汇总，展开可审计各版本 Q/E/S 与登记证据，不删除跨版本记录。观察汇总可能混合旧策略，不用于版本优劣或纯前向结论。一般档案上限500条，未结算与严格前向记录不因上限删除。</p>${groups.length ? `<table><thead><tr><th>标的 / 通道</th><th>触发 / 版本档案</th><th>代表档案 Q/E/S</th><th>入场时 E/S</th><th>登记 / 状态</th><th>净R / 退出 / 路径</th><th>数据 / 下一检查</th></tr></thead><tbody>${groups.slice(0, 30).map(forwardObservationRow).join("")}</tbody></table>${groups.length > 30 ? '<p class="small muted">仅显示最近30组；完整原始档案请导出。</p>' : ""}` : '<div class="empty">暂无前向记录；完成本机研究池刷新后自动建立。</div>'}`;
  }

/* 模块导出（boot 加载校验与外部调试入口） */
globalThis.QuantJournal = {
  forwardEntries, saveForward, updateForwardJournal, renderForward,
  intradayEntries, saveIntraday, updateIntradayJournal, renderIntradayJournal,
  captureIntradayTriggers,
};
