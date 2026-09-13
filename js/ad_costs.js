/* ad_costs.js
 * -------------------------------------------------------------------------
 * 2026-09-11 쿠팡 광고비 자동수집 연결 (사용자 지시: "공헌이익 탭의 광고비를 쿠팡에서
 * 자동 수집", "자동수집과 수동 입력을 무조건 더하지 말 것", "수집 실패를 0원으로
 * 계산하지 말고 '광고비 미확정'").
 *
 * 공헌이익·팀 목표·부가세 화면이 *같은* 광고비 목록을 쓰도록 한곳에 모았어요.
 *
 *   · 자동수집(ad_cost_daily)이 기본 원천입니다. 날짜별 마지막 정상 수집(OK) 스냅샷만 씁니다.
 *   · 수동 입력(ad_costs)은 지우거나 고치지 않아요. 계산 포함 여부만 정합니다.
 *       - 자동수집 시작일 이전 날짜          → 포함 (INCLUDED_PRE_AUTO)
 *       - 보정 사유(adjustment_reason)가 있음 → 자동수집과 별도로 포함 (INCLUDED_ADJUSTMENT)
 *       - 같은 날 자동수집과 금액이 같음       → 제외 · 중복 (MATCHED_MANUAL_DUPLICATE) - 2026-09-11
 *       - 그 밖(자동수집 기간, 금액이 다름)     → 제외 + 대사 필요 (RECONCILIATION_NEEDED) - 자동 보정 안 함
 *     자동수집과 수동 입력을 같은 날 동시에 더하지 않아요(모든 월 공통).
 *   · 자동수집 기간인데 정상 수집이 없는 날(실패·미수집)은 0원이 아니라 "미확정"입니다.
 *     그 달 공헌이익도 확정값으로 보이지 않게 상태를 돌려줘요.
 *   · 오늘 광고비는 내일 수집되므로 오늘은 미확정 계산에서 빼고 따로 알려요.
 *   · 금액은 행마다 부가세 포함 여부(vat_included)를 원천 기준으로 가지고 있어요.
 *     계산은 공급가액(net) · 부가세(vat)로 나눠서 넘깁니다 - 다른 비용과 같은 기준.
 *   · 이 파일은 조회만 합니다. 쓰기(수집)는 GCP 서버만 해요(브라우저에는 쓰기 권한이 없어요).
 */
(function (global) {
  "use strict";

  const VAT_RATE = 0.1;
  const AUTO_CHANNEL = "쿠팡 광고";
  // 자동수집이 원천이 되는 첫 날짜(백필 시작일). 이 날 이전은 수동 입력이 원천이에요.
  // 수집 이력에서 추정하지 않아요 - 첫날 백필이 실패하면 그날이 조용히 '수동 기간'이 되어
  // 0원처럼 보이게 되기 때문입니다.
  // 2026-09-11 8월 1~31일을 WING 원천에서 전체 재수집(부가세 별도 공급가액) → 시작일을 8월 1일로 옮겼어요.
  // 서버 coupang_ad_costs.AUTO_START 와 같아야 해요.
  const AUTO_START_DATE = "2026-08-01";

  // 수동 행의 계산 포함 여부
  const MANUAL = {
    PRE_AUTO: "INCLUDED_PRE_AUTO",
    ADJUSTMENT: "INCLUDED_ADJUSTMENT",
    DUPLICATE: "MATCHED_MANUAL_DUPLICATE",
    RECONCILIATION_NEEDED: "RECONCILIATION_NEEDED",
  };
  // 월 광고비 상태
  const STATE = {
    CONFIRMED: "CONFIRMED",            // 자동수집 기간 전 날짜가 정상 수집됨
    UNDETERMINED: "UNDETERMINED",      // 정상 수집이 없는 날이 있음 → 공헌이익 미확정
    // 2026-09-11 사용자 확정(A안): 일별 광고비 합계를 ERP 광고비·공헌이익에 그대로 쓰고,
    // 쿠팡 기간 합계와의 차이는 날짜·캠페인에 배분하거나 보정하지 않고 차이 그대로 보존·표시해요.
    ROUNDING_DIFFERENCE: "ROUNDING_DIFFERENCE",  // 일별 합 ≠ 쿠팡 기간 합계(반올림) → 공헌이익 반영, "잠정" 표시
    PENDING_RECON: "PENDING_RECON",              // 쿠팡 기간 합계를 아직 못 받음 → 공헌이익 반영, "잠정" 표시
    MANUAL_ONLY: "MANUAL_ONLY",        // 자동수집 시작 전 달 - 수동 입력 기준
  };

  const round = (n) => Math.round(Number(n) || 0);

  function addDays(ds, n) {
    const d = new Date(`${ds}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function monthDays(month) {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const out = [];
    for (let i = 1; i <= last; i++) out.push(`${month}-${String(i).padStart(2, "0")}`);
    return out;
  }

  /* 원천 금액 → 공급가액·부가세. 원천이 부가세 포함이면 떼어내고, 별도면 10% 를 붙여요.
     vat_included 를 모르면(null) 계산하지 않고 호출자가 미확정으로 다룹니다. */
  function splitVat(amount, vatIncluded, vatEnabled = true) {
    const a = Number(amount) || 0;
    if (!vatEnabled) return { net: a, vat: 0 };
    if (vatIncluded === true) {
      const net = Math.round(a / (1 + VAT_RATE));
      return { net, vat: a - net };
    }
    if (vatIncluded === false) return { net: a, vat: Math.round(a * VAT_RATE) };
    return null;
  }

  /* 날짜별 마지막 수집 이력 → {date: {lastOk…, lastAt, lastStatus, lastError}}.
     "정상 수집"은 status OK 인 가장 최근 이력이에요(광고비 0원 날짜도 OK 이력으로 남아요).
     합계는 서버가 날짜 단위 원자 교체 때 저장한 값(total_amount, vat_included)을 씁니다 -
     여러 달 화면에서 행을 전부 읽지 않아도 되고, 행 합계와 이력 합계는 DB 함수가 대조해요. */
  function latestByDate(collections) {
    const by = {};
    for (const c of collections || []) {
      const d = String(c.expense_date).slice(0, 10);
      const cur = by[d] || { lastOkAt: null, lastOkTotal: null, lastOkVatIncluded: null, lastOkRows: null,
                             lastAt: null, lastStatus: null, lastError: null };
      const at = c.collected_at || "";
      if (!cur.lastAt || at > cur.lastAt) {
        cur.lastAt = at; cur.lastStatus = c.status; cur.lastError = c.error || null;
      }
      if (c.status === "OK" && (!cur.lastOkAt || at > cur.lastOkAt)) {
        cur.lastOkAt = at;
        cur.lastOkTotal = c.total_amount == null ? null : Number(c.total_amount);
        cur.lastOkVatIncluded = c.vat_included == null ? null : c.vat_included;
        cur.lastOkRows = c.row_count == null ? null : Number(c.row_count);
      }
      by[d] = cur;
    }
    return by;
  }

  /**
   * 한 달 광고비 계산의 단일 진입점.
   *
   * @param {object} p
   *   month        'YYYY-MM'
   *   today        'YYYY-MM-DD' (KST)
   *   autoStart    자동수집 시작일(이 날짜부터 자동수집이 원천). null 이면 자동수집 없음
   *   collections  ad_cost_collections 행
   *   manualRows   ad_costs 행 (수동 입력)
   *   vatEnabled   부가세 계산 사용 여부(설정)
   *   manualVatIncluded  수동 입력 금액의 부가세 포함 여부(설정 expenseIncludesVat)
   *   refs         ad_cost_monthly_refs 행 (월 대사·캠페인 상세). A안: 일별 합계를 쓰고, 쿠팡 기간
   *                합계와 차이가 있으면 ROUNDING_DIFFERENCE 로 차이만 보존·표시(보정·배분 없음).
   * @returns {object} { rows, manual, days, state, totals, lastOkAt, lastFailure }
   *   rows: 계산에 넣을 행 [{date, channel, net, vat, amount, source, id}]
   */
  function monthAds(p) {
    const month = p.month;
    const today = p.today;
    const autoStart = p.autoStart === undefined ? AUTO_START_DATE : p.autoStart;
    const vatEnabled = p.vatEnabled !== false;
    const inMonth = (d) => String(d).slice(0, 7) === month && String(d) <= today;
    const coll = latestByDate(p.collections);

    // ── 자동수집: 날짜별 마지막 정상 수집의 합계 ────────────────────────────
    const autoByDate = {};
    const unknownVatDates = new Set();
    for (const [d, c] of Object.entries(coll)) {
      if (!inMonth(d) || !c.lastOkAt || c.lastOkTotal == null) continue;
      const sv = splitVat(c.lastOkTotal, c.lastOkVatIncluded, vatEnabled);
      if (!sv) { unknownVatDates.add(d); continue; }
      autoByDate[d] = { net: sv.net, vat: sv.vat, amount: c.lastOkTotal, rows: c.lastOkRows };
    }

    // ── 날짜별 판정 ─────────────────────────────────────────────────────────
    const days = [];
    const yesterday = addDays(today, -1);
    for (const d of monthDays(month)) {
      if (d > today) break;
      const autoPeriod = !!autoStart && d >= autoStart;
      const c = coll[d] || null;
      let status;
      if (!autoPeriod) status = "MANUAL_PERIOD";
      else if (d === today) status = "TODAY_PENDING";            // 내일 수집
      else if (unknownVatDates.has(d)) status = "UNDETERMINED";   // 부가세 기준 불명
      else if (c && c.lastOkAt && c.lastOkTotal != null) status = "OK";
      else status = "UNDETERMINED";                               // 실패·미수집 → 0원 금지
      days.push({
        date: d, status, autoPeriod,
        auto: autoByDate[d] || null,
        lastOkAt: c ? c.lastOkAt : null,
        lastError: c && c.lastStatus !== "OK" ? c.lastError : null,
        failedAfterOk: !!(c && c.lastOkAt && c.lastStatus !== "OK"),
      });
    }
    const dayMap = Object.fromEntries(days.map((x) => [x.date, x]));

    // ── 수동 행 포함/제외 ───────────────────────────────────────────────────
    const manual = [];
    for (const m of p.manualRows || []) {
      const d = String(m.date).slice(0, 10);
      if (!inMonth(d)) continue;
      const autoPeriod = !!autoStart && d >= autoStart;
      const reason = (m.adjustment_reason || "").trim();
      const dayAuto = dayMap[d] && dayMap[d].status === "OK" && dayMap[d].auto ? dayMap[d].auto : null;
      let decision;
      if (!autoPeriod) decision = MANUAL.PRE_AUTO;
      else if (reason) decision = MANUAL.ADJUSTMENT;
      // 같은 날짜·같은 금액(원천 금액과 원 단위까지 같음) → 자동수집과 중복. 수동 행은 그대로 두고 계산에서만 뺍니다.
      else if (dayAuto && round(m.amount) === round(dayAuto.amount)) decision = MANUAL.DUPLICATE;
      else decision = MANUAL.RECONCILIATION_NEEDED;
      const sv = splitVat(m.amount, p.manualVatIncluded !== false, vatEnabled);
      manual.push({
        id: m.id, date: d, channel: m.channel || null, amount: Number(m.amount) || 0,
        net: sv.net, vat: sv.vat, memo: m.memo || "", created_by: m.created_by || "",
        adjustment_reason: reason || null, decision,
        included: decision === MANUAL.PRE_AUTO || decision === MANUAL.ADJUSTMENT,
        autoSameDay: dayMap[d] && dayMap[d].auto ? round(dayMap[d].auto.net + dayMap[d].auto.vat) : null,
      });
    }

    // ── 계산에 넣을 행 ──────────────────────────────────────────────────────
    const rows = [];
    for (const x of days) {
      if (x.status === "OK" && x.auto) {
        rows.push({ date: x.date, channel: AUTO_CHANNEL, net: round(x.auto.net), vat: round(x.auto.vat),
                    amount: round(x.auto.amount), source: "AUTO", id: null });
      }
    }
    for (const m of manual) {
      if (m.included) rows.push({ date: m.date, channel: m.channel, net: m.net, vat: m.vat,
                                  amount: m.amount, source: "MANUAL", id: m.id });
    }

    const undetermined = days.filter((x) => x.status === "UNDETERMINED");
    const anyAuto = days.some((x) => x.autoPeriod);

    // ── 월 대사: 일별 저장값 합 vs WING 구간 합계(같은 기간) ──────────────────
    const latestRef = (type) => (p.refs || []).filter((r) => r.month === month && r.ref_type === type)
      .sort((a, b) => (String(a.collected_at) < String(b.collected_at) ? 1 : -1))[0] || null;
    const rangeRef = latestRef("WING_AD_METRICS_RANGE");
    const settleRef = latestRef("WING_RG_AD_SETTLEMENT");
    let recon = null;
    if (rangeRef && rangeRef.period_end) {
      const pe = String(rangeRef.period_end).slice(0, 10);
      const ps = String(rangeRef.period_start || `${month}-01`).slice(0, 10);
      const inRange = days.filter((x) => x.date >= ps && x.date <= pe);
      const allOk = inRange.length > 0 && inRange.every((x) => x.status === "OK");
      const dailySum = inRange.reduce((s, x) => s + (x.auto ? Number(x.auto.amount) : 0), 0);
      const rangeAmt = Number(rangeRef.amount);
      recon = { periodStart: ps, periodEnd: pe, dailySum, rangeAmount: rangeAmt, allOk,
                diff: allOk ? round(dailySum - rangeAmt) : null, matched: allOk && dailySum === rangeAmt,
                collectedAt: rangeRef.collected_at };
    }
    const settlement = settleRef ? {
      amount: Number(settleRef.amount), billable: settleRef.billable_amount == null ? null : Number(settleRef.billable_amount),
      vat: settleRef.vat_amount == null ? null : Number(settleRef.vat_amount),
      billed: settleRef.billed_amount == null ? null : Number(settleRef.billed_amount),
      campaigns: Array.isArray(settleRef.campaigns) ? settleRef.campaigns : [],
      collectedAt: settleRef.collected_at } : null;

    const state = !anyAuto ? STATE.MANUAL_ONLY
      : undetermined.length ? STATE.UNDETERMINED
      : !recon ? STATE.PENDING_RECON
      : recon.matched ? STATE.CONFIRMED : STATE.ROUNDING_DIFFERENCE;

    const sum = (arr, k) => arr.reduce((s, r) => s + (Number(r[k]) || 0), 0);
    const autoRowsIn = rows.filter((r) => r.source === "AUTO");
    const manualIn = rows.filter((r) => r.source === "MANUAL");
    const okAts = days.map((x) => x.lastOkAt).filter(Boolean).sort();
    const failures = days.filter((x) => x.lastError).sort((a, b) => (a.date < b.date ? 1 : -1));

    return {
      month, rows, manual, days, state, recon, settlement,
      undeterminedDays: undetermined.map((x) => x.date),
      todayPending: days.some((x) => x.status === "TODAY_PENDING"),
      reconciliationNeeded: manual.filter((m) => m.decision === MANUAL.RECONCILIATION_NEEDED),
      duplicates: manual.filter((m) => m.decision === MANUAL.DUPLICATE),
      totals: {
        net: sum(rows, "net"), vat: sum(rows, "vat"),
        autoNet: sum(autoRowsIn, "net"), autoVat: sum(autoRowsIn, "vat"),
        manualNet: sum(manualIn, "net"), manualVat: sum(manualIn, "vat"),
        duplicateAmount: manual.filter((m) => m.decision === MANUAL.DUPLICATE).reduce((s, m) => s + m.amount, 0),
      },
      lastOkAt: okAts.length ? okAts[okAts.length - 1] : null,
      lastFailure: failures.length ? { date: failures[0].date, error: failures[0].lastError } : null,
      yesterday,
    };
  }

  // ── 화면 ────────────────────────────────────────────────────────────────
  const API_BASE = global.WING_SUBMIT_API_BASE || "https://34-30-248-218.sslip.io";
  const BTN_CLASS = "js-ad-refresh";
  const REQUEST_TIMEOUT_MS = 170000;      // 한 달치 재수집 - 서버는 150초 안에 끝내도록 잡혀 있어요
  let inflight = null;
  let lastResult = null;

  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const won = (n) => (n == null ? "—" : `₩${Math.round(Number(n)).toLocaleString("ko-KR")}`);
  const num = (n) => (n == null ? "—" : Number(n).toLocaleString("ko-KR"));

  function kst(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d)) return String(ts);
    return `${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false }).format(d)} KST`;
  }

  /* 수집 실패 사유를 사람이 읽을 말로. 내부 경로·명령·값은 보여주지 않아요. */
  function reasonText(error) {
    const e = String(error || "");
    if (!e) return "";
    if (/^(SESSION_EXPIRED|NO_SESSION)/.test(e)) return "쿠팡 세션 만료 · 세션 갱신 필요";
    if (/^AUTH_BLOCKED/.test(e)) return "쿠팡 보안(Akamai) 차단";
    if (/^FORMAT_CHANGED/.test(e)) return "쿠팡 광고 보고서 형식이 바뀜 · 파서 확인 필요";
    if (/^PARTIAL/.test(e)) return "일부만 수집됨 · 저장하지 않음";
    if (/^(DOWNLOAD_FAILED|SOURCE_ERROR)/.test(e)) return "쿠팡 응답 오류";
    if (/^APPLY_FAILED/.test(e)) return "DB 저장 실패(롤백)";
    return e.split(/맥에서|python3|\n/)[0].slice(0, 80);
  }

  const DAY_LABEL = {
    OK: ["정상 수집", "ok"], UNDETERMINED: ["미확정", "warn"], TODAY_PENDING: ["내일 수집", "muted"],
    MANUAL_PERIOD: ["수동 입력 기간", "muted"],
  };
  const DECISION_LABEL = {
    INCLUDED_PRE_AUTO: ["계산 포함 · 자동수집 이전", "ok"],
    INCLUDED_ADJUSTMENT: ["계산 포함 · 보정", "ok"],
    MATCHED_MANUAL_DUPLICATE: ["계산 제외 · 자동수집과 같은 금액(중복)", "muted"],
    RECONCILIATION_NEEDED: ["계산 제외 · 금액 다름 · 대사 필요", "warn"],
  };
  const chip = ([label, tone]) => `<span class="ad-chip ad-${tone}">${esc(label)}</span>`;

  function refreshButtonHtml(month) {
    return `<button type="button" class="btn sm secondary ${BTN_CLASS}" data-month="${esc(month)}"
      data-label="광고비 새로고침" title="GCP 서버가 쿠팡 광고 보고서를 지금 다시 받아 옵니다(어제까지)"
      ${inflight ? 'disabled aria-busy="true"' : ""} onclick="AdCosts.refreshClick(this)">${inflight ? "수집 중…" : "광고비 새로고침"}</button>`;
  }

  /* 상단 공헌이익 숫자 옆에 붙는 상태 문구. 미확정이면 숫자를 확정처럼 보이지 않게. */
  function cmBadge(info) {
    if (!info) return "";
    if (info.state === STATE.UNDETERMINED) {
      return `<div class="ad-cm-note ad-warn">광고비 미확정 ${info.undeterminedDays.length}일 · 공헌이익 미확정</div>`;
    }
    if (info.state === STATE.ROUNDING_DIFFERENCE) {
      return `<div class="ad-cm-note ad-warn">잠정 · 쿠팡 기간 합계와 ${won(Math.abs(info.recon.diff)).replace("₩", "")}원 차이</div>`;
    }
    if (info.state === STATE.PENDING_RECON) {
      return `<div class="ad-cm-note ad-warn">잠정 · 쿠팡 기간 합계 대사 전</div>`;
    }
    if (info.todayPending) return `<div class="ad-cm-note ad-muted">오늘 광고비는 내일 수집 후 반영</div>`;
    return "";
  }

  /**
   * 공헌이익 탭 "쿠팡 광고비" 카드.
   * info: monthAds() 결과, detailRows: 이 달 ad_cost_daily 행(캠페인·상품 상세), opts.autoError: 조회 오류
   */
  function cardHtml(info, detailRows, opts = {}) {
    const t = info.totals;
    const stateChip = info.state === STATE.UNDETERMINED ? chip(["광고비 미확정", "warn"])
      : info.state === STATE.ROUNDING_DIFFERENCE ? chip([`잠정 · 쿠팡 기간 합계와 ${won(Math.abs(info.recon.diff)).replace("₩", "")}원 차이`, "warn"])
      : info.state === STATE.PENDING_RECON ? chip(["잠정 · 쿠팡 기간 합계 대사 전", "warn"])
      : info.state === STATE.MANUAL_ONLY ? chip(["수동 입력 기준", "muted"]) : chip(["정상 수집 · 대사 일치", "ok"]);
    const rc = info.recon, st = info.settlement;
    const reconPanel = info.days.some((x) => x.autoPeriod) ? `
      <div class="ad-recon">
        <div class="ad-recon-row"><span>일별 광고비 합계${rc ? ` (${esc(rc.periodStart.slice(5))}~${esc(rc.periodEnd.slice(5))})` : ""}</span><b>${rc ? won(rc.dailySum) : "—"}</b></div>
        <div class="ad-recon-row"><span>WING 구간 합계 (같은 기간 한 번에 조회 · 홈 '최근 7일' 위젯과 같은 계산)</span><b>${rc ? won(rc.rangeAmount) : "수집 전"}</b></div>
        <div class="ad-recon-row"><span>차이 (ROUNDING_DIFFERENCE · 보정·배분하지 않음)</span><b class="${rc && rc.matched ? "" : "ad-warn-text"}">${rc ? (rc.allOk ? (rc.matched ? "0원 · 일치" : `${won(rc.diff)} · 반올림 차이`) : "기간 안에 미확정 날짜 있음") : "—"}</b></div>
        ${st ? `<div class="ad-recon-row"><span>로켓그로스 정산 청구가능 광고비(이 달, 로켓그로스 상품분) · 부가세 ${won(st.vat)} 별도</span><b>${won(st.billable)}</b></div>` : ""}
        <p class="ad-sub">일별 값은 쿠팡이 하루 단위로 알려 준 금액 그대로이고, 구간 합계는 쿠팡이 기간 전체를 한 번에 계산한 금액이에요.
          쿠팡 쪽 반올림 단위가 달라 몇 원 차이가 날 수 있어요. 공헌이익에는 일별 합계를 쓰고, 차이는 특정 날짜·캠페인에
          나누거나 고치지 않고 그대로 표시합니다(잠정).</p>
      </div>` : "";
    const failNote = info.lastFailure
      ? `<div class="ad-note ad-warn">최근 수집 실패 (${esc(info.lastFailure.date)}): ${esc(reasonText(info.lastFailure.error))}
          — 기존 정상 광고비는 그대로 유지하고, 실패한 날은 0원으로 계산하지 않아요.</div>` : "";
    const undetNote = info.state === STATE.UNDETERMINED
      ? `<div class="ad-note ad-warn">정상 수집이 없는 날: ${info.undeterminedDays.map((d) => esc(d.slice(5))).join(", ")}
          — 이 날들의 광고비를 알 수 없어 이 달 공헌이익은 <b>미확정</b>입니다.</div>` : "";
    const autoErr = opts.autoError
      ? `<div class="ad-note ad-warn">자동수집 광고비를 불러오지 못했어요(${esc(String(opts.autoError.message || opts.autoError).slice(0, 80))}).
          자동수집 기간의 광고비는 미확정으로 표시합니다.</div>` : "";
    const recon = info.reconciliationNeeded.length
      ? `<div class="ad-note ad-warn">RECONCILIATION_NEEDED · 자동수집 기간에 입력한 수동 광고비 ${info.reconciliationNeeded.length}건이
          같은 날 자동수집 금액과 달라요. 자동으로 고치지 않고 <b>계산에서만 뺐어요</b>. 실제로 별도 비용이면 보정 사유를 적어 다시 입력해 주세요.</div>` : "";
    const dupNote = info.duplicates && info.duplicates.length
      ? `<div class="ad-note ad-muted">MATCHED_MANUAL_DUPLICATE · 수동 입력 ${info.duplicates.length}건(${won(t.duplicateAmount)})은 같은 날 자동수집 금액과 같아
          중복으로 보고 계산에서 뺐어요. 수동 행은 지우거나 고치지 않았습니다.</div>` : "";

    const dayRows = info.days.filter((x) => x.autoPeriod).slice().reverse().map((x) => {
      const man = info.manual.filter((m) => m.date === x.date);
      const manTxt = man.length ? man.map((m) => `${won(m.amount)} ${m.included ? "포함" : m.decision === "MATCHED_MANUAL_DUPLICATE" ? "중복 제외" : "제외"}`).join(", ") : "—";
      const note = x.failedAfterOk ? `최근 재수집 실패(${esc(reasonText(x.lastError))}) · 기존값 유지`
        : x.status === "UNDETERMINED" && x.lastError ? esc(reasonText(x.lastError))
        : x.status === "UNDETERMINED" ? "수집 이력 없음" : x.lastOkAt ? `수집 ${esc(kst(x.lastOkAt))}` : "";
      // 2026-09-13 [ERP UI 정리] 720px 이하 카드형(원천·공급가액이 핵심, 수동 입력·비고는 [세부 보기]) - 값은 그대로
      return `<tr><td class="erp-card-head"><b>${esc(x.date.slice(5))}</b><button type="button" class="erp-m-toggle" aria-expanded="false" onclick="ErpUi.toggleCard(this)">세부 보기</button></td><td data-label="상태">${chip(DAY_LABEL[x.status] || [x.status, "muted"])}</td>
        <td class="num" data-label="원천 금액">${x.auto ? won(x.auto.amount) : "—"}</td>
        <td class="num" data-label="공급가액">${x.auto ? won(x.auto.net) : "—"}</td>
        <td class="num erp-m-detail" data-label="수동 입력">${manTxt}</td><td class="ad-sub erp-m-detail" data-label="비고">${note}</td></tr>`;
    }).join("");

    // 캠페인 상세: 로켓그로스 정산 '광고비 내역'(월 단위, 캠페인별). 일별 원천은 계정 합계만 줘요.
    const settleCamps = st && st.campaigns.length ? `
      <details class="ad-detail" open><summary>캠페인별 광고비 (로켓그로스 정산 광고비 내역 · ${esc(info.month)} · ${st.campaigns.length}개)</summary>
        <div class="table-wrap"><table class="erp-cards erp-cards-flex">
          <thead><tr><th>광고유형</th><th>캠페인</th><th class="num">클릭</th><th class="num">광고비</th><th class="num">청구가능 광고비</th></tr></thead>
          <tbody>${st.campaigns.slice().sort((a, b) => Number(b.amount) - Number(a.amount)).map((c) => `
            <tr><td data-label="광고유형">${esc(c.ad_type)}</td><td class="erp-card-head"><b>${esc(c.campaign_name)}</b></td><td class="num" data-label="클릭">${num(c.clicks)}</td>
              <td class="num" data-label="광고비">${won(c.amount)}</td><td class="num" data-label="청구가능 광고비">${won(c.billable_amount)}</td></tr>`).join("")}
          </tbody></table></div>
        <p class="ad-sub">상품(옵션)별 광고비는 쿠팡이 GCP 에서 읽을 수 있는 경로로 제공하지 않아요(광고센터는 서버 접속이 차단됨).</p>
      </details>` : "";
    // 캠페인 → 상품 상세 (이 달 행)
    const byCamp = {};
    for (const r of detailRows || []) {
      const k = `${r.campaign_id || "-"}|${r.campaign_name || "(캠페인 없음)"}`;
      const c = byCamp[k] || (byCamp[k] = { name: r.campaign_name || "(캠페인 없음)", id: r.campaign_id, amount: 0,
                                             impressions: 0, clicks: 0, ad_sales: 0, items: {} });
      c.amount += Number(r.amount) || 0;
      c.impressions += Number(r.impressions) || 0;
      c.clicks += Number(r.clicks) || 0;
      c.ad_sales += Number(r.ad_sales) || 0;
      const ik = r.vendor_item_id || r.product_name || "-";
      const it = c.items[ik] || (c.items[ik] = { name: r.product_name || "", vid: r.vendor_item_id, amount: 0, clicks: 0 });
      it.amount += Number(r.amount) || 0; it.clicks += Number(r.clicks) || 0;
    }
    const camps = Object.values(byCamp).filter((c) => c.id).sort((a, b) => b.amount - a.amount);
    const detail = camps.length ? `
      <details class="ad-detail"><summary>캠페인·상품별 상세 (${camps.length}개 캠페인)</summary>
        <div class="table-wrap"><table>
          <thead><tr><th>캠페인 / 상품</th><th class="num">광고비(원천)</th><th class="num">노출</th><th class="num">클릭</th><th class="num">광고 매출</th></tr></thead>
          <tbody>${camps.map((c) => `
            <tr><td><b>${esc(c.name)}</b>${c.id ? ` <small class="ad-sub">${esc(c.id)}</small>` : ""}</td>
              <td class="num"><b>${won(c.amount)}</b></td><td class="num">${num(c.impressions)}</td>
              <td class="num">${num(c.clicks)}</td><td class="num">${won(c.ad_sales)}</td></tr>
            ${Object.values(c.items).sort((a, b) => b.amount - a.amount).map((it) => `
            <tr><td style="padding-left:18px">${esc(it.name || "(상품명 없음)")}${it.vid ? ` <small class="ad-sub">옵션 ${esc(it.vid)}</small>` : ""}</td>
              <td class="num">${won(it.amount)}</td><td></td><td class="num">${num(it.clicks)}</td><td></td></tr>`).join("")}`).join("")}
          </tbody></table></div></details>` : "";

    const manualRows = info.manual.length ? info.manual.map((m) => `
      <tr><td class="erp-card-head"><b>${esc(m.date.slice(5))}</b></td><td data-label="채널">${esc(m.channel || "전체")}</td>
        <td class="num" data-label="금액"><b>${won(m.amount)}</b></td>
        <td class="ad-wrap" data-label="계산"><div>${chip(DECISION_LABEL[m.decision])}${(m.decision === "RECONCILIATION_NEEDED" || m.decision === "MATCHED_MANUAL_DUPLICATE") && m.autoSameDay != null
          ? `<div class="ad-sub">같은 날 자동수집 ${won(m.autoSameDay)}</div>` : ""}${m.adjustment_reason
          ? `<div class="ad-sub">사유: ${esc(m.adjustment_reason)}</div>` : ""}</div></td>
        <td class="ad-wrap" data-label="메모">${esc(m.memo)}</td><td data-label="입력자">${esc(m.created_by)}</td>
        <td class="erp-actions"><button class="btn sm danger" onclick="deleteErpRow('ad_costs','${esc(m.id)}')">삭제</button></td></tr>`).join("")
      : `<tr><td colspan="7" class="empty">이 달 수동 입력 광고비가 없습니다</td></tr>`;

    const resNote = lastResult && lastResult.month === info.month
      ? `<div class="ad-note ${lastResult.ok ? "ad-ok" : "ad-warn"}">${esc(lastResult.message || "")}</div>` : "";

    return `
    <div class="card" id="ad-cost-card">
      <div class="card-head"><h2>${esc(info.month)} 쿠팡 광고비</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap">${refreshButtonHtml(info.month)}
          <button class="btn sm secondary" onclick="openAdModal()">＋ 수동 광고비 입력</button></div></div>
      <div class="ad-status">${stateChip}
        <span class="ad-sub">마지막 정상 수집 ${info.lastOkAt ? esc(kst(info.lastOkAt)) : "없음"}</span>
        <span class="ad-sub">원천: WING 광고 지표(일별 집행 광고비, 부가세 별도) · GCP 자동수집 · 시작 ${esc(AUTO_START_DATE)}</span></div>
      ${resNote}${autoErr}${undetNote}${failNote}${recon}${dupNote}${reconPanel}
      <div class="grid-stats" style="margin-top:10px">
        <div class="stat"><div class="stat-label">광고비 (공급가액)</div>
          <div class="stat-value ${info.state !== STATE.CONFIRMED && info.state !== STATE.MANUAL_ONLY ? "amber" : ""}">${won(t.net)}${info.state === STATE.UNDETERMINED ? " <small>+ 미확정</small>" : (info.state === STATE.ROUNDING_DIFFERENCE || info.state === STATE.PENDING_RECON) ? " <small>잠정</small>" : ""}</div></div>
        <div class="stat"><div class="stat-label">부가세</div><div class="stat-value">${won(t.vat)}</div></div>
        <div class="stat"><div class="stat-label">자동수집</div><div class="stat-value">${won(t.autoNet)}</div></div>
        <div class="stat"><div class="stat-label">수동 입력(포함분)</div><div class="stat-value">${won(t.manualNet)}</div></div>
      </div>
      ${info.days.some((x) => x.autoPeriod) ? `
      <h3 style="margin-top:14px;font-size:14px">날짜별 광고비</h3>
      <div class="table-wrap"><table class="erp-cards">
        <thead><tr><th>일자</th><th>상태</th><th class="num">원천 금액</th><th class="num">공급가액</th><th class="num">수동 입력</th><th>비고</th></tr></thead>
        <tbody>${dayRows}</tbody></table></div>` : ""}
      ${settleCamps}${detail}
      <h3 style="margin-top:14px;font-size:14px">수동 입력 광고비</h3>
      <div class="table-wrap"><table class="erp-cards">
        <thead><tr><th>일자</th><th>채널</th><th class="num">금액</th><th>계산</th><th>메모</th><th>입력자</th><th></th></tr></thead>
        <tbody>${manualRows}</tbody></table></div>
      <p class="ad-sub" style="margin-top:8px">자동수집 기간에는 쿠팡 원천 광고비가 기준이고, 수동 입력은 보정 사유가 있을 때만 더해요.
        같은 날 같은 금액이면 중복(MATCHED_MANUAL_DUPLICATE), 금액이 다르면 대사 필요(RECONCILIATION_NEEDED)로 표시하고 계산에서 뺍니다.
        수집이 실패해도 기존 정상 광고비는 지우지 않고, 실패한 날은 "미확정"으로 표시합니다.</p>
    </div>`;
  }

  async function sessionJwt() {
    const sb = global.sb;
    if (!sb || !sb.auth || typeof sb.auth.getSession !== "function") return null;
    try {
      const { data } = await sb.auth.getSession();
      return (data && data.session && data.session.access_token) || null;
    } catch (e) { return null; }
  }

  async function requestRefresh(month) {
    const jwt = await sessionJwt();
    if (!jwt) return { status: "AUTH", ok: false, month, message: "로그인 세션이 없어요. 다시 로그인해 주세요." };
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetch(`${API_BASE}/api/ad-costs/refresh`, {
        method: "POST", credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ month }), signal: ctrl ? ctrl.signal : undefined,
      });
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (res.status === 401) return { status: "AUTH", ok: false, month, message: "인증이 만료됐어요. 다시 로그인해 주세요." };
      if (body && body.status) return { month, ...body };
      return { status: "FAILED", ok: false, month, message: `서버 오류(HTTP ${res.status}). 기존 광고비는 그대로 유지됩니다.` };
    } catch (e) {
      return { status: e && e.name === "AbortError" ? "TIMEOUT" : "FAILED", ok: false, month,
        message: e && e.name === "AbortError" ? "서버 응답이 늦어요. 끝나면 화면을 다시 불러옵니다."
          : "서버에 연결하지 못했어요. 기존 광고비는 그대로 유지됩니다." };
    } finally { if (timer) clearTimeout(timer); }
  }

  function setBusy(busy) {
    if (typeof document === "undefined") return;
    document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => {
      b.disabled = busy;
      b.setAttribute("aria-busy", busy ? "true" : "false");
      b.textContent = busy ? "수집 중…" : (b.dataset.label || "광고비 새로고침");
    });
  }

  async function refreshClick(btn) {
    if (inflight) return inflight;                         // 중복 클릭 차단(서버도 409)
    const month = btn && btn.dataset ? btn.dataset.month : null;
    setBusy(true);
    inflight = (async () => {
      const res = await requestRefresh(month);
      lastResult = { ...res, month: res.month || month };
      if (typeof global.toast === "function") global.toast(res.message || res.status);
      return res;
    })();
    try { return await inflight; } finally {
      inflight = null;
      setBusy(false);
      if (typeof global.route === "function") await global.route();
    }
  }

  global.AdCosts = { AUTO_START_DATE, monthAds, cardHtml, cmBadge, refreshClick, reasonText, splitVat, latestByDate, MANUAL, STATE, AUTO_CHANNEL, monthDays, addDays };
})(typeof window !== "undefined" ? window : globalThis);
