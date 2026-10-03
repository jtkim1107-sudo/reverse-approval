/* erp_home.js - ERP 첫 화면 '한눈에 보기' (2026-10-03, ERP 7개 영역 재정리)
 * -------------------------------------------------------------------------
 * 숫자를 화면에서 계산하지 않아요. VM GET /api/erp/home 이 아침 보고서와 같은 계산(run_kakao_morning_report)으로
 * 만든 값을 그대로 보여 줘요 → 첫 화면 · 아침 보고서 · 각 영역 화면이 같은 값.
 *   매출(어제) · 공헌이익(월 누적 잠정) · 재고금액 · 가용자금(ERP 잔액·통장 기준 시각) · 입출금 예정(7일·45일 최저)
 *   · 광고 성과(어제·7일) · 오늘 조치사항(운영)
 * 값이 없으면 0 이 아니라 '확인 필요'. 조회 실패면 실패라고(마지막 값을 최신처럼 쓰지 않음).
 */
(function (root) {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v))) ? null : Number(v);
  const won = v => (num(v) === null ? "확인 필요" : (num(v) < 0 ? "−₩" : "₩") + Math.round(Math.abs(num(v))).toLocaleString("ko-KR"));
  const pct = (v, d = 1) => (num(v) === null ? "확인 필요" : `${(num(v) * 100).toFixed(d)}%`);
  const roas = v => (num(v) === null ? "확인 필요" : `${Math.round(num(v)).toLocaleString("ko-KR")}%`);
  const md = s => (s ? String(s).slice(5, 10).replace("-", "/") : "");
  const tone = st => (/확인 필요|실패|미완|없음/.test(String(st || "")) ? "warn" : "ok");

  function tile({ id, title, value, sub, status, href, neg }) {
    return `<a class="eh-tile eh-${tone(status)}" id="eh-${id}" href="${esc(href)}">
      <span class="eh-t">${esc(title)}</span>
      <b class="eh-v${neg ? " eh-neg" : ""}">${esc(value)}</b>
      <span class="eh-s">${sub}</span>
      ${status ? `<span class="eh-st">${esc(status)}</span>` : ""}</a>`;
  }

  /** 서버 응답 → 타일 7개(순서 = 대표 지시: 매출 · 공헌이익 · 재고금액 · 가용자금 · 입출금 예정 · 광고 성과 · 오늘 조치사항) */
  function tiles(h) {
    const s = h.sales || {}, p = h.profit || {}, inv = h.inventory || {}, c = h.cash || {}, a = h.ads || {}, acts = h.actions || [];
    const d7 = a.d7 || {};
    const pending = h.pending_approvals || {};
    const pendingText = pending.error
      ? "결재 대기 확인 필요"
      : (num(pending.count) === null ? "" : `결재 대기 ${num(pending.count)}건`);
    const actionTitles = acts.filter(x => x.link !== "#/inbox").slice(0, 2).map(x => x.title);
    const invSub = inv.total === null || inv.total === undefined
      ? esc(inv.error || "재고·원가 확인 필요")
      : `${esc(inv.products)}개 상품 · 입고 예정분 ${esc(won(inv.incoming_value))}${(inv.cost_unconfirmed || []).length ? ` · 원가 미확정 ${inv.cost_unconfirmed.length}` : ""}${(inv.missing_cost || []).length + (inv.missing_qty || []).length ? ` · 제외 ${(inv.missing_cost || []).length + (inv.missing_qty || []).length}` : ""}`;
    return [
      tile({ id: "sales", title: s.label || "어제 순매출", value: won(s.yesterday), href: "#/sales",
             sub: `${esc(md(s.yesterday_date))} · ${esc(s.yesterday_state || "")}${(s.metrics || []).find(m => m[0] === "전일 대비") ? ` · 전일 대비 ${esc((s.metrics || []).find(m => m[0] === "전일 대비")[1])}` : ""}`,
             status: s.status }),
      tile({ id: "profit", title: "월 누적 잠정 공헌이익(본업)", value: p.valid ? won(p.amount) : "확인 필요", neg: num(p.amount) < 0, href: "#/profit",
             sub: p.valid ? `${esc(md((p.period || [])[0]))}~${esc(md((p.period || [])[1]))} · 보상 포함 ${esc(won(p.with_other_income))}` : esc((p.notes || [])[0] || ""),
             status: p.status }),
      tile({ id: "inventory", title: "현재 재고금액(원가·부가세 제외)", value: won(inv.total), href: "#/stockflow/stock",
             sub: invSub, status: inv.complete === false ? "일부 확인 필요" : "" }),
      tile({ id: "cash", title: "가용자금(ERP 잔액)", value: won(c.balance), href: "#/cash",
             sub: c.last_bank ? `통장 ${esc(md(c.last_bank))} ${esc(String(c.last_bank).slice(11, 16))} 기준${c.bank_age_days > 1 ? ` · ${esc(c.bank_age_days)}일 지남` : ""}` : "통장 대사 기록 없음",
             status: c.bank_age_days > 1 ? "통장 최신화 필요" : c.status }),
      tile({ id: "plans", title: "입출금 예정(7일)", value: `${won(c.in7)} / ${won(c.out7)}`, href: "#/cash",
             sub: `45일 최저 잔액 ${esc(won(c.min_balance))}${c.min_date ? ` (${esc(md(c.min_date))})` : ""}`, status: "" }),
      tile({ id: "ads", title: "광고 성과(어제)", value: `${won(a.cost)} · ROAS ${roas(a.roas)}`, href: "#/ads",
             sub: d7.complete ? `7일 ROAS ${esc(roas(d7.roas))} · 광고비율 ${esc(pct(d7.ad_cost_ratio))}` : "7일 자료 확인 필요",
             status: a.campaign_fresh === false ? "캠페인 수치 최신 아님" : a.status }),
      tile({ id: "actions", title: "오늘 조치사항", value: `${acts.length}건`, href: "#dash-home-actions",
             sub: esc([pendingText, ...actionTitles].filter(Boolean).join(" · ") || "운영 조치 없음"),
             status: pending.error || acts.some(x => x.level === "alert") ? "확인 필요" : "" }),
    ].join("");
  }

  /** 로그인 사용자 기준 결재 대기를 운영 조치와 합쳐요. 서버 운영 조치 원본은 바꾸지 않아요. */
  function withPendingApprovals(h, { count = null, error = false } = {}) {
    const out = { ...(h || {}), actions: [...((h && h.actions) || [])] };
    const n = num(count);
    out.pending_approvals = { count: error ? null : Math.max(0, Math.trunc(n || 0)), error: !!error };
    if (error) {
      out.actions.push({ level: "warn", title: "결재 대기 건수 확인 필요", detail: "결재 대기 화면에서 직접 확인해 주세요", link: "#/inbox" });
    } else if (n > 0) {
      out.actions.push({ level: "action", title: `결재 대기 ${Math.trunc(n)}건`, detail: "내 결재 차례인 문서를 확인해 주세요", link: "#/inbox" });
    }
    return out;
  }

  function actionsHtml(acts) {
    if (!acts || !acts.length) return `<p class="eh-none">운영 조치사항이 없어요.</p>`;
    const icon = { alert: "⛔", warn: "⚠", action: "✅", info: "ℹ" };
    return `<ul class="eh-acts">${acts.map(x => `<li class="eh-a-${esc(x.level)}"><a href="${esc(x.link || "#/dashboard")}">
      <b>${icon[x.level] || "•"} ${esc(x.title)}</b><small>${esc(x.detail || "")}</small></a></li>`).join("")}</ul>`;
  }

  function pendingApprovalLink(pending) {
    if (!pending || pending.error || num(pending.count) !== 0) return "";
    return `<a class="eh-inbox-link" href="#/inbox">결재 대기 0건 확인 <span aria-hidden="true">→</span></a>`;
  }

  function html(h) {
    return `<section class="card eh" id="dash-home" aria-labelledby="eh-h">
      <div class="card-head"><h2 id="eh-h">한눈에 보기</h2><span class="eh-at">계산 ${esc(String(h.generated_at || "").slice(11, 16))} · 아침 보고서와 같은 계산</span></div>
      <div class="eh-grid">${tiles(h)}</div>
      <div id="dash-home-actions"><h3 class="eh-h3">오늘 조치사항(운영)</h3>${actionsHtml(h.actions)}${pendingApprovalLink(h.pending_approvals)}</div>
    </section>`;
  }

  function errorHtml(msg) {
    return `<section class="card eh" id="dash-home"><div class="card-head"><h2>한눈에 보기</h2></div>
      <p class="eh-fail" role="alert">첫 화면 요약을 불러오지 못했어요(${esc(msg)}). 이전 값을 대신 보여 주지 않아요 - 아래 영역별 카드를 확인하세요.</p></section>`;
  }

  async function load({ base, token, fetchFn = root.fetch } = {}) {
    const r = await fetchFn(`${base}/api/erp/home`, { headers: { Authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  root.ErpHome = { load, html, errorHtml, tiles, actionsHtml, withPendingApprovals, pendingApprovalLink };
})(typeof window !== "undefined" ? window : globalThis);
