/* ad_status_view.js - '광고 현황' 화면 #/ads (2026-10-03, ERP 7개 영역 재정리)
 * -------------------------------------------------------------------------
 * 계산은 VM GET /api/ad-status(ad_status.py)가 해요 - 화면은 표시만.
 *   · 계정 전체: 전일·7·14·30일 광고비 · 광고매출 · 광고 판매수량 · 광고 주문 · 클릭 · 전환율 · ROAS · 직전 같은 기간 대비 증감
 *     · 전체 매출 대비 광고비율 · 광고매출/광고 외 매출 비중
 *   · 캠페인: ON/OFF · 일예산 · 목표 ROAS · 실제 성과 · 예산 소진율 · 손익분기 ROAS · 광고 차감 후(광고 기여 기준 잠정) 이익
 *     · 유지/관찰/축소/중단/증액/판단 보류/꺼짐 · 경고
 *   · 설정 변경 전후 비교(변경 전 7일 vs 변경 뒤 3·7·14일) · 원복 제안 - 제안만, 광고 설정을 바꾸지 않아요.
 * 광고매출은 광고센터 귀속(기여) 기준 - 추가 매출로 확정하지 않아요. 캠페인 원본이 최신이 아니면 자료일과 '확인 필요'.
 */
(function (root) {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
  const won = v => (num(v) === null ? "—" : (num(v) < 0 ? "−₩" : "₩") + Math.round(Math.abs(num(v))).toLocaleString("ko-KR"));
  const cnt = v => (num(v) === null ? "—" : Math.round(num(v)).toLocaleString("ko-KR"));
  const pct = (v, d = 1) => (num(v) === null ? "—" : `${(num(v) * 100).toFixed(d)}%`);
  const roas = v => (num(v) === null ? "—" : `${Math.round(num(v)).toLocaleString("ko-KR")}%`);
  const delta = v => (num(v) === null ? "" : `<small class="as-d ${num(v) >= 0 ? "up" : "down"}">${num(v) >= 0 ? "▲" : "▼"}${Math.abs(num(v) * 100).toFixed(0)}%</small>`);
  const PERIODS = [["d1", "전일"], ["d7", "7일"], ["d14", "14일"], ["d30", "30일"]];
  const VERDICT_TONE = { 유지: "ok", 관찰: "info", 축소: "check", 중단: "check", 증액: "approval", "판단 보류": "pending", 꺼짐: "muted" };
  const badge = (kind, text) => (root.ErpUi && root.ErpUi.badge ? root.ErpUi.badge(kind, { text, small: true }) : `<span class="erp-badge erp-badge--sm">${esc(text)}</span>`);

  function accountHtml(m) {
    const a = m.account || {};
    const cell = (k, f) => { const x = a[k] || {}; return x.complete ? f(x) : `<span class="as-miss">확인 필요${(x.missing || []).length ? ` · ${x.missing.length}일 없음` : ""}</span>`; };
    const row = (label, f) => `<tr><th scope="row">${label}</th>${PERIODS.map(([k]) => `<td class="num">${cell(k, f)}</td>`).join("")}</tr>`;
    return `<div class="table-wrap"><table class="as-tbl" aria-label="계정 전체 광고 성과">
      <thead><tr><th>계정 전체</th>${PERIODS.map(([k, t]) => `<th class="num">${t}<br><small>${esc(((a[k] || {}).period || []).map(x => x.slice(5)).join("~"))}</small></th>`).join("")}</tr></thead>
      <tbody>
        ${row("광고비 <small>VAT 제외</small>", x => `${won(x.cost)} ${delta((x.vs_prev || {}).cost)}`)}
        ${row("광고매출 <small>광고 기여 기준</small>", x => `${won(x.ad_sales)} ${delta((x.vs_prev || {}).ad_sales)}`)}
        ${row("ROAS", x => `${roas(x.roas)} ${delta((x.vs_prev || {}).roas)}`)}
        ${row("광고 판매수량", x => cnt(x.ad_units))}
        ${row("광고 주문수", x => (x.orders === null || x.orders === undefined ? `<span class="as-miss" title="${esc(x.orders_source || "")}">확인 필요</span>` : cnt(x.orders)))}
        ${row("클릭수", x => (x.clicks === null || x.clicks === undefined ? `<span class="as-miss">확인 필요</span>` : cnt(x.clicks)))}
        ${row("전환율 <small>주문÷클릭</small>", x => (x.cvr === null || x.cvr === undefined ? `<span class="as-miss">확인 필요</span>` : pct(x.cvr, 2)))}
        ${row("광고비율 <small>광고비÷순매출(VAT 제외)</small>", x => (x.ad_cost_ratio === undefined ? `<span class="as-miss">매출 확인 필요</span>` : pct(x.ad_cost_ratio)))}
        ${row("광고매출 / 광고 외 매출", x => (x.ad_sales_share === undefined || x.ad_sales_share === null ? `<span class="as-miss">매출 확인 필요</span>` : `${pct(x.ad_sales_share, 0)} / ${pct(x.non_ad_sales_share, 0)}`))}
      </tbody></table></div>
      <p class="as-note">증감 ▲▼ = 직전 같은 길이 기간 대비. 광고 주문·클릭은 WING 계정 원본에 없어 캠페인 합계(실적일 광고센터 원본일 때만)로 보여 줘요.
        광고매출 비중은 취소 전 판매가 기준이에요.</p>`;
  }

  function campaignsHtml(m) {
    const cs = m.campaigns || [];
    if (!cs.length) return `<p class="as-miss">캠페인 원본이 없어 캠페인별 수치를 보여 줄 수 없어요. ${esc((m.reasons || []).join(" · "))}</p>`;
    const stale = !m.campaign_fresh;
    const head = stale ? `<p class="as-stale" role="alert">⚠ 아래 캠페인 수치·판정은 <b>${esc(m.campaign_date)}</b> 자료예요(최신 아님 - 광고센터 로그인·수집 필요). 오늘 판단에 그대로 쓰지 마세요.</p>` : "";
    const rows = cs.map(c => {
      const p7 = (c.periods || {}).d7 || {}, p1 = (c.periods || {}).d1 || {}, p30 = (c.periods || {}).d30 || {};
      const cfg = c.cfg || {};
      return `<tr data-cid="${esc(c.id)}">
        <th scope="row">${esc(c.name)}<br><small>${cfg.on ? "ON" : "OFF"} · 일예산 ${won(cfg.budget)} · 목표 ROAS ${cfg.roas_target ? esc(cfg.roas_target) + "%" : "—"}</small></th>
        <td class="num">${won(p1.cost)}<br><small>소진 ${c.budget_burn_d1 === null || c.budget_burn_d1 === undefined ? "—" : pct(c.budget_burn_d1, 0)}</small></td>
        <td class="num">${roas(p7.roas)}<br><small>30일 ${roas(p30.roas)}</small></td>
        <td class="num">${cnt(p7.orders)} / ${cnt(p7.clicks)}<br><small>전환 ${pct(p7.cvr, 2)}</small></td>
        <td class="num">${c.breakeven ? roas(c.breakeven) : "—"}${c.cost_check ? `<br><small class="as-miss">원가 확인 필요</small>` : ""}</td>
        <td class="num">${p7.ad_profit === null || p7.ad_profit === undefined ? `<span class="as-miss">원가 확인 필요</span>` : won(p7.ad_profit)}<br><small>잠정</small></td>
        <td>${badge(VERDICT_TONE[c.verdict] || "info", c.verdict)}<br><small>${esc(c.why || "")}</small>
          ${c.proposal ? `<details class="as-prop"><summary>변경 제안(승인 전 자동 변경 없음)</summary><small>현재 ${esc(c.proposal.current)} → 제안 ${esc(c.proposal.proposed)}<br>근거 ${esc(c.proposal.evidence)}<br>위험 ${esc(c.proposal.risk)} · 원복 ${esc(c.proposal.rollback)}</small></details>` : ""}</td>
        <td>${(c.alerts || []).length ? `<ul class="as-alerts">${c.alerts.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "—"}</td></tr>`;
    }).join("");
    const counts = Object.entries(m.verdict_counts || {}).map(([k, v]) => `${badge(VERDICT_TONE[k] || "info", `${k} ${v}`)}`).join(" ");
    return `${head}<p>${counts}</p><div class="table-wrap"><table class="as-tbl as-camp" aria-label="캠페인별 광고 성과">
      <thead><tr><th>캠페인 · 설정</th><th class="num">전일 광고비</th><th class="num">7일 ROAS</th><th class="num">7일 주문/클릭</th>
        <th class="num">손익분기 ROAS</th><th class="num">7일 광고 차감 후 이익</th><th>판정</th><th>경고</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
      <p class="as-note">광고 차감 후 이익 = 광고매출 × 100 ÷ 손익분기 ROAS − 광고비(광고 기여 기준 <b>잠정</b>, 증분 매출로 확정하지 않음).
        손익분기 근거가 추정(물류비 등)이면 '원가 확인 필요'. 판정: 손익분기 미만이면 축소(70% 미만은 중단), 130% 이상이면서 예산을 거의 다 쓰면 증액,
        최근 7일 설정 변경·대표 보류 기간은 판단 보류(보류 다음 날 재평가).</p>`;
  }

  function reviewsHtml(m) {
    const rs = m.change_reviews || [];
    if (!rs.length) return "";
    const names = Object.fromEntries((m.campaigns || []).map(c => [c.id, c.name]));
    const agg = x => (!x ? "—" : x.complete ? `${won(x.cost)} · ROAS ${roas(x.roas)} · 주문 ${cnt(x.orders)}`
      : x.pending_until ? `${esc(x.pending_until.slice(5))}에 비교` : `자료 부족(${esc(x.have)}/${esc(x.need)}일)`);
    return `<h3 class="as-h3">설정 변경 전후 비교</h3><div class="table-wrap"><table class="as-tbl"><thead><tr><th>변경</th><th>변경 전 7일</th>
      <th>변경 뒤 3일</th><th>변경 뒤 7일</th><th>변경 뒤 14일</th><th>원복 제안</th></tr></thead><tbody>
      ${rs.map(r => `<tr><th scope="row">${esc(names[r.campaign_id] || r.campaign_id)}<br><small>${esc(r.text)}${r.until ? ` · ${esc(r.until.slice(5))}까지 보류` : ""}</small></th>
        <td>${agg(r.before_7d)}</td><td>${agg((r.after || {}).d3)}</td><td>${agg((r.after || {}).d7)}</td><td>${agg((r.after || {}).d14)}</td>
        <td>${r.rollback_proposal ? esc(r.rollback_proposal) : "—"}</td></tr>`).join("")}</tbody></table></div>
      <p class="as-note">하루라도 캠페인 일자료가 없으면 비교하지 않아요(0원으로 채우지 않음). 원복은 제안만 - 대표 승인 뒤 광고센터에서 직접 바꿔요.</p>`;
  }

  function hourlyHtml(h, { date = "", days = 7 } = {}) {
    if (!h) return `<p class="as-miss">상품별 시간대 판매를 불러오지 못했어요. 이전 값을 대신 보여 주지 않아요.</p>`;
    const ps = h.products || [], cov = h.coverage || {}, total = h.totals || {};
    const dayLinks = [1, 7, 14, 30].map(n => `<a class="as-range${Number(days) === n ? " active" : ""}" href="#/ads?date=${esc(date || (h.period || [])[1] || "")}&days=${n}">${n === 1 ? "하루" : n + "일"}</a>`).join("");
    const hours = Array.from({ length: 24 }, (_, x) => x);
    const rows = ps.map(p => `<tr><th scope="row">${esc(p.name || p.code || "상품 확인 필요")}<br><small>${esc(p.code || "")} ${esc(p.spec || "")} · 합계 ${cnt(p.qty)}개 / ${won(p.amount)} · 일평균 ${Number(p.avg_daily_qty || 0).toFixed(1)}개</small></th>
      ${hours.map(hr => { const x = (p.hours || [])[hr] || {}; return `<td class="num${x.qty ? " as-hot" : ""}" title="${String(hr).padStart(2,"0")}:00~${String((hr+1)%24).padStart(2,"0")}:00 · ${cnt(x.qty || 0)}개 · ${won(x.amount || 0)}">${x.qty ? `${cnt(x.qty)}<small>${won(x.amount)}</small>` : "—"}</td>`; }).join("")}</tr>`).join("");
    return `<div class="card-head"><h2>상품별 1시간 판매 <small>${esc((h.period || []).join(" ~ "))}</small> ${badge(h.status === "정상" ? "ok" : "check", h.status || "확인 필요")}</h2>
      <div class="as-ranges">${dayLinks}</div></div>
      <div class="as-hour-summary"><b>${cnt(total.qty)}개 · ${won(total.amount)}</b><span>결제가 가장 많은 시간 ${total.peak_hour == null ? "—" : `${String(total.peak_hour).padStart(2,"0")}:00~${String((total.peak_hour+1)%24).padStart(2,"0")}:00`}</span></div>
      ${cov.automated_rows_without_time ? `<p class="as-stale">⚠ 자동수집 주문 ${cnt(cov.automated_rows_without_time)}줄에 결제시각이 없어 시간대 표에서 제외됐어요. 재수집이 필요합니다.</p>` : ""}
      ${!ps.length ? `<p class="as-miss">이 기간에 결제시각이 확인된 상품 판매가 없어요.</p>` : `<div class="table-wrap as-hour-wrap"><table class="as-tbl as-hour" aria-label="상품별 1시간 판매"><thead><tr><th>상품 · 기간 합계</th>${hours.map(x => `<th class="num">${String(x).padStart(2,"0")}시</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`}
      <p class="as-note">${esc(h.basis || "")} 각 칸은 <b>판매수량</b>, 아래 작은 숫자는 결제금액입니다. 광고센터는 일 단위 자료만 제공하므로 시간대 광고매출이나 시간대 ROAS를 추정하지 않아요.</p>`;
  }

  function html(m, { date = "", days = 7, hourly = null } = {}) {
    const st = m.status === "정상" ? badge("ok", "정상") : badge("check", "확인 필요");
    return `<div class="as" id="ad-status">
      <section class="card"><div class="card-head"><h2>광고 현황 <small>${esc(m.report_date)} 실적</small> ${st}</h2>
        <label class="as-date">실적일 <input type="date" value="${esc(date || m.report_date)}" onchange="if(this.value){location.hash='#/ads?date='+this.value}"></label></div>
        ${(m.reasons || []).length ? `<ul class="as-reasons">${m.reasons.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
        ${(m.account_alerts || []).length ? `<ul class="as-alerts as-acc-alerts">${m.account_alerts.map(x => `<li>⚠ ${esc(x)}</li>`).join("")}</ul>` : ""}
        ${accountHtml(m)}</section>
      <section class="card"><div class="card-head"><h2>캠페인별 성과 · 판정</h2></div>${campaignsHtml(m)}${reviewsHtml(m)}</section>
      <section class="card">${hourlyHtml(hourly, { date: date || m.report_date, days })}</section>
      <section class="card"><div class="card-head"><h2>연결 화면</h2></div>
        <p><a href="#/adprofit">상품별 광고·이익(광고센터 보고서 올리기 · 일일 광고 보고서 PNG) ›</a> · <a href="#/profit">공헌이익(광고비 실제 청구 기준) ›</a></p>
        <p class="as-note">이 화면은 광고 설정을 바꾸지 않아요. 변경은 제안만 하고, 대표 승인 뒤 광고센터에서 직접 바꿔요.</p></section>
    </div>`;
  }

  async function load(date, { base, token, fetchFn = root.fetch } = {}) {
    const r = await fetchFn(`${base}/api/ad-status${date ? `?date=${encodeURIComponent(date)}` : ""}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.message || body.detail || `HTTP ${r.status}`);
    return body;
  }

  async function loadHourly(date, days, { base, token, fetchFn = root.fetch } = {}) {
    const q = new URLSearchParams({ end: date, days: String(days) });
    const r = await fetchFn(`${base}/api/product-hourly-sales?${q}`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.message || body.detail || `HTTP ${r.status}`);
    return body;
  }

  async function view({ sb, base, hash = "" } = {}) {
    const m = /[?&]date=(\d{4}-\d{2}-\d{2})/.exec(hash || "");
    const dm = /[?&]days=(1|7|14|30)(?:&|$)/.exec(hash || "");
    const days = dm ? Number(dm[1]) : 7;
    const { data: { session } } = await sb.auth.getSession();
    if (!session?.access_token) return `<div class="card">ERP 로그인이 필요해요</div>`;
    try {
      const ad = await load(m ? m[1] : "", { base, token: session.access_token });
      const hourly = await loadHourly(m ? m[1] : ad.report_date, days, { base, token: session.access_token });
      return html(ad, { date: m ? m[1] : ad.report_date, days, hourly });
    } catch (e) {
      return `<div class="card"><h2>광고 현황</h2><p class="as-miss" role="alert">광고 현황을 불러오지 못했어요: ${esc(e.message || e)} - 이전 값을 대신 보여 주지 않아요.</p>
        <p><a href="#/adprofit">상품별 광고·이익 ›</a></p></div>`;
    }
  }

  root.AdStatusView = { html, view, load, loadHourly, accountHtml, campaignsHtml, reviewsHtml, hourlyHtml };
})(typeof window !== "undefined" ? window : globalThis);
