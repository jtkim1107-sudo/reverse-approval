/* ad_sales_daily.js
 * -------------------------------------------------------------------------
 * 2026-09-20 [PR-1: 계정 단위 일별 광고비×전체매출 대시보드, 사용자 승인]
 *
 * 서버 GET /api/ad-sales-daily/series?start=&end= 의 결과를 그대로 그려요.
 * *** 계산은 이 파일에 없습니다 *** - 매출·광고비 판정(수집 대기/실패, VAT 기준,
 * 이중 차감 방지)은 전부 서버(erp_ad_sales_daily_api.py)가 정하고, 이 파일은
 * 응답 필드를 그대로 표시만 합니다.
 *
 *   · 광고비 대비 매출 비율(ROAS 류)은 이 화면에서 계산하지 않아요 - 광고비는 VAT 제외,
 *     매출은 VAT 포함이라 그대로 나누면 기준이 섞입니다. 두 값을 나란히 보여줄 뿐이에요.
 *   · 상품별·캠페인별 분해는 여기 없어요(#/adprofit 참고 - 별도 화면, 일별 데이터 없음).
 *   · 수집 안 된/실패한 날은 0원이 아니라 "—" + 상태로 표시합니다.
 */
(function (global) {
  "use strict";

  const API_BASE = global.WING_SUBMIT_API_BASE || "https://34-30-248-218.sslip.io";
  const PREFIX = "/api/ad-sales-daily";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const won = (v) => (isNum(v) ? (v < 0 ? "−₩" : "₩") + Math.abs(Math.round(v)).toLocaleString("ko-KR") : "—");
  const UI = () => global.ErpUi;
  const badge = (kind, text, reason) => (UI() ? UI().badge(kind, { text, reason, small: true })
    : `<span class="erp-badge erp-badge--${esc(kind)}">${esc(text)}${reason ? ` · ${esc(reason)}` : ""}</span>`);

  const PERIODS = [7, 30, 90];

  function todayKst() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  }
  function addDays(ds, n) {
    const d = new Date(`${ds}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // ── 서버 호출 ─────────────────────────────────────────────────────────────
  const state = { period: 30, start: "", end: "", series: null, loading: false, error: null };

  async function jwt() {
    const sb = global.sb;
    if (!sb || !sb.auth || typeof sb.auth.getSession !== "function") return null;
    try { const { data } = await sb.auth.getSession(); return (data && data.session && data.session.access_token) || null; } catch (e) { return null; }
  }
  async function api(path) {
    const token = await jwt();
    if (!token) return { status: 401, body: { status: "AUTH", message: "로그인 세션이 없어요. 다시 로그인해 주세요." } };
    try {
      const res = await fetch(`${API_BASE}${PREFIX}${path}`, { credentials: "omit", headers: { Authorization: `Bearer ${token}` } });
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      return { status: res.status, body: body || { status: "ERROR", message: `서버 응답을 읽지 못했어요(HTTP ${res.status})` } };
    } catch (e) {
      return { status: 0, body: { status: "ERROR", message: "서버에 연결하지 못했어요." } };
    }
  }

  function setPeriod(days) {
    const end = todayKst();
    state.period = days;
    state.start = addDays(end, -(days - 1));
    state.end = end;
  }

  async function loadSeries() {
    state.loading = true;
    state.error = null;
    const r = await api(`/series?start=${encodeURIComponent(state.start)}&end=${encodeURIComponent(state.end)}`);
    state.loading = false;
    if (r.status !== 200) {
      state.series = null;
      state.error = (r.body && r.body.message) || `조회 실패(HTTP ${r.status})`;
      return;
    }
    state.series = r.body;
  }

  // ── 집계(응답을 그대로 더할 뿐 - 새 판정 규칙 없음) ─────────────────────────
  function totals(series) {
    const days = (series && series.days) || [];
    const salesDays = days.filter((d) => isNum(d.total_sales.amount));
    const adDays = days.filter((d) => isNum(d.ad_spend.amount));
    return {
      salesSum: salesDays.reduce((s, d) => s + d.total_sales.amount, 0),
      salesMissing: days.length - salesDays.length,
      salesProvisional: salesDays.filter((d) => d.total_sales.confirmed === false).length,
      adSum: adDays.reduce((s, d) => s + d.ad_spend.amount, 0),
      adMissing: days.length - adDays.length,
      total: days.length,
    };
  }

  // ── 화면 ────────────────────────────────────────────────────────────────
  function periodButtonsHtml() {
    return `<div class="adsd-periods" role="group" aria-label="기간 선택">${PERIODS.map((p) =>
      `<button type="button" class="btn sm ${p === state.period ? "" : "secondary"}" onclick="AdSalesDaily.pick(${p})">최근 ${p}일</button>`).join("")}
      <span class="adp-note">${esc(state.start)} ~ ${esc(state.end)}</span></div>`;
  }

  function kpiHtml(series) {
    const t = totals(series);
    const items = [
      { label: "일별 전체 매출 합계", value: won(t.salesSum), kind: "info",
        sub: [t.salesMissing ? `${t.salesMissing}일 미수집 제외` : "", t.salesProvisional ? `합계에 잠정 ${t.salesProvisional}일 포함(D+7 확인 전)` : ""]
          .filter(Boolean).join(" · ") || "전 기간 수집·확정 완료" },
      { label: "일별 광고비 합계(VAT 제외)", value: won(t.adSum), kind: "info",
        sub: t.adMissing ? `${t.adMissing}일 미수집·실패 제외` : "전 기간 수집 완료" },
    ];
    return UI() ? UI().summaryHtml(items, { label: "기간 합계" })
      : `<div class="erp-summary">${items.map((x) => `<div class="erp-stat"><span class="erp-stat-label">${esc(x.label)}</span><span class="erp-stat-value">${esc(x.value)}</span></div>`).join("")}</div>`;
  }

  function basisHtml(series) {
    if (!series || !series.basis) return "";
    return `<div class="card adsd-basis">
      <p class="adp-note"><b>매출 기준</b> · ${esc(series.basis.total_sales)}</p>
      <p class="adp-note"><b>광고비 기준</b> · ${esc(series.basis.ad_spend)}</p>
    </div>`;
  }

  function dayStatusBadge(status) {
    if (status === "OK") return "";
    const kind = status === "수집 대기" || status === "미수집" ? "muted" : "check";
    return badge(kind, status);
  }

  /* 2026-09-20 [PR-1 후속: 확정/잠정 표시] confirmed 는 값이 있을 때만 true/false, 값이
     없으면(수집 대기 등) null - 그때는 뱃지를 안 띄워요(잠정도 확정도 아니라 "값 자체가 없음"). */
  function confirmedBadge(totalSales) {
    if (totalSales.confirmed == null) return "";
    return badge(totalSales.confirmed ? "ok" : "check", totalSales.confirmed_label);
  }

  function barRow(label, amount, max, cls) {
    const pct = max > 0 && isNum(amount) ? Math.max(2, Math.min(100, (amount / max) * 100)) : 0;
    return `<div class="adsd-bar-row"><span class="adsd-bar-label">${esc(label)}</span>
      <div class="bar"><div class="bar-fill ${cls}" style="width:${pct}%"></div></div>
      <span class="adsd-bar-value">${isNum(amount) ? won(amount) : "—"}</span></div>`;
  }

  function daysTableHtml(series) {
    const days = (series && series.days) || [];
    if (!days.length) return "";
    const maxSales = Math.max(1, ...days.map((d) => (isNum(d.total_sales.amount) ? d.total_sales.amount : 0)));
    const maxAd = Math.max(1, ...days.map((d) => (isNum(d.ad_spend.amount) ? d.ad_spend.amount : 0)));
    const rows = days.slice().reverse().map((d) => `
      <tr>
        <td class="erp-card-head"><b>${esc(d.date.slice(5))}</b></td>
        <td data-label="전체 매출">${barRow("매출", d.total_sales.amount, maxSales, "green")}
          ${d.total_sales.display_status !== "OK" ? dayStatusBadge(d.total_sales.display_status) : confirmedBadge(d.total_sales)}</td>
        <td data-label="광고비">${barRow("광고비", d.ad_spend.amount, maxAd, "amber")}
          ${d.ad_spend.status !== "OK" ? dayStatusBadge(d.ad_spend.status) : ""}</td>
      </tr>`).join("");
    return `<div class="table-wrap"><table class="erp-cards">
      <thead><tr><th>일자</th><th>전체 매출</th><th>광고비</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  function pageHtml() {
    const s = state.series;
    return `<div class="adsd-page">
      <div class="card">
        <div class="card-head"><h2>일별 광고비 × 전체 매출</h2></div>
        ${periodButtonsHtml()}
        <p class="adp-note">상품별 분석은 이 화면에 없어요 - <a href="#/adprofit">상품별 광고·이익</a>에서 기간 합계로 확인하세요
          (일별 상품 데이터는 아직 없어요).</p>
      </div>
      ${state.loading ? `<div class="card"><p class="adp-note">불러오는 중…</p></div>` : ""}
      ${state.error ? `<div class="card">${badge("error", "조회 실패", state.error)}</div>` : ""}
      ${s ? `<div class="card">${kpiHtml(s)}</div>${basisHtml(s)}<div class="card">${daysTableHtml(s)}</div>` : ""}
    </div>`;
  }

  function paint() {
    const el = global.document && global.document.getElementById("content");
    if (el && el.querySelector(".adsd-page")) el.innerHTML = pageHtml();
  }

  async function pick(days) {
    setPeriod(days);
    paint();
    await loadSeries();
    paint();
  }

  async function view() {
    if (!state.start) setPeriod(state.period);
    await loadSeries();
    return pageHtml();
  }

  global.AdSalesDaily = { view, pick, totals, state };
})(typeof window !== "undefined" ? window : globalThis);
