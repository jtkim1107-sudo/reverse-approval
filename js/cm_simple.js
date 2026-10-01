/* cm_simple.js - 공헌이익 화면 단순 보기 (2026-09-30, 사용자 승인 목업 3장 구조)
 * -------------------------------------------------------------------------
 * 숫자를 새로 계산하지 않아요. 백엔드가 매일 기록하는 최신 기여액 요약(sync_job_status 'cm_contribution_latest' detail -
 * cm_contribution.summary_for_status)의 줄(lines)·월 공통비·잠정 공헌이익을 '보는 순서'만 바꿔요.
 *   · 맨 위 4칸: 잠정 공헌이익 · 순매출 · 총비용 · 확인할 항목
 *   · 한 줄 흐름: 순매출 − 상품원가 − 판매수수료 − 광고비 − 물류비 − 공통비 − 반품손실 = 공헌이익
 *       상품원가 = 판매 원가 − 반품 원가 환입 · 물류비 = 판매분 입고 운반비 · 공통비 = 쿠팡 월 공통비(입고·풀필먼트·보관·세이버)
 *       토스쇼핑 정산분(TOSS_CONTRIBUTION)이 있으면 '+ 토스쇼핑' 한 칸, 모르는 줄이 생기면 '기타' 한 칸 - 흐름 합 = 잠정 공헌이익 검산,
 *       어긋나면 model.ok=false → 화면은 기존 카드 그대로(단순 보기를 그리지 않음)
 *   · 확인할 일: 기존 사유(reasons)를 쉬운 이름 · 금액 영향 · 할 일로 바꿔 보여 줘요(자동으로 풀리는 건 '자동 대기')
 *   · 기술 표시(ACCRUED·VAT 미확인·정산파일/API·실행번호·버전·파일)는 상세보기 안에서만.
 * DB·네트워크 호출 없음.
 */
(function (root) {
  "use strict";

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => Math.round(Math.abs(Number(n) || 0)).toLocaleString("ko-KR");
  const won = n => (Number(n) < 0 ? "−₩" : "₩") + fmt(n);
  const signed = n => (Number(n) > 0 ? "+" : "") + won(n);
  const num = v => Number(v) || 0;
  const badge = (kind, text) => (root.ErpUi && root.ErpUi.badge ? root.ErpUi.badge(kind, { text, small: true }) : `<span class="erp-badge erp-badge--sm">${esc(text)}</span>`);

  const REVENUE_CODES = ["REVENUE_RG_GROSS", "REVENUE_RG_COUPON", "REVENUE_RG_CANCEL", "REVENUE_MP", "REVENUE_MP_REFUND"];
  const KNOWN = new Set([...REVENUE_CODES, "COST_PRODUCT", "COST_RECOVERY", "RETURN_LOSS", "TOSS_CONTRIBUTION"]);
  const isFee = c => c.startsWith("FEE_");
  const isAd = c => c.startsWith("AD_");

  /** 요약 → 화면 모델. 검산이 맞지 않으면 ok=false(기존 화면 유지). */
  function model(d) {
    const p = d && d.provisional_cm;
    if (!d || !Array.isArray(d.lines) || !p || p.is_confirmed !== false) return { ok: false, why: "잠정 공헌이익 없음" };
    const by = {};
    d.lines.forEach(l => { by[l.code] = (by[l.code] || 0) + num(l.amount); });
    const sum = f => d.lines.filter(l => f(l.code)).reduce((t, l) => t + num(l.amount), 0);
    const revenue = REVENUE_CODES.reduce((t, c) => t + (by[c] || 0), 0);
    const cost = -((by.COST_PRODUCT || 0) + (by.COST_RECOVERY || 0));
    const fee = -sum(isFee);
    const ad = -sum(isAd);
    const logi = num(p.inbound_freight);
    const common = num(p.monthly_cost);
    const loss = -(by.RETURN_LOSS || 0);
    const toss = by.TOSS_CONTRIBUTION || 0;
    const other = sum(c => !KNOWN.has(c) && !isFee(c) && !isAd(c));
    const cm = num(p.amount);
    const flowSum = revenue - cost - fee - ad - logi - common - loss + toss + other;
    if (Math.abs(flowSum - cm) > 2) return { ok: false, why: `흐름 합 ${Math.round(flowSum)} ≠ 잠정 공헌이익 ${cm}` };
    const terms = [["순매출", revenue, ""], ["상품원가", cost, "−"], ["판매수수료", fee, "−"], ["광고비", ad, "−"],
                   ["물류비", logi, "−"], ["공통비", common, "−"], ["반품손실", loss, "−"]];
    if (toss) terms.push(["토스쇼핑", toss, "+"]);
    if (Math.abs(other) >= 1) terms.push(["기타", other, "+"]);
    const todos = todoItems(d, by);
    return { ok: true, revenue, cost, fee, ad, logi, common, loss, toss, other, cm, totalCost: revenue - cm,
             rate: revenue ? cm / revenue * 100 : null, terms, todos,
             mine: todos.filter(t => t.mine).length, auto: todos.filter(t => !t.mine).length };
  }

  const md = s => { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? `${Number(m[1])}월 ${Number(m[2])}일` : String(s || ""); };
  const countIn = (text, re) => { const m = re.exec(String(text || "")); return m ? Number(m[1]) : null; };

  /** 기존 사유(reasons) → 쉬운 한국어 할 일. 모르는 사유도 빠뜨리지 않고 그대로 한 줄. */
  function todoItems(d, by) {
    const out = [];
    const reasons = d.reasons || [];
    const has = f => reasons.find(f);
    const month = Number(String(d.month || "").slice(5, 7)) || "";
    const used = new Set();
    const take = f => { const r = reasons.find((x, i) => !used.has(i) && f(x)); if (r) used.add(reasons.indexOf(r)); return r; };

    const accrued = take(r => r.status === "ACCRUED" && /광고/.test(r.label + r.text) && !/토스/.test(r.label));
    if (accrued) {
      const a = num(d.ads && d.ads.outside_accrued) || -num(by.AD_OUTSIDE_ACCRUED);
      out.push({ key: "AD_INVOICE", title: "광고비 청구서 확인", sub: `쿠팡 정산 밖 광고비 ${fmt(a)}원을 미리 비용으로 넣어 둠`,
                 impact: `0 ~ +₩${fmt(a)}`, action: "쿠팡 광고 청구서(계정 전체) 올리기", mine: true });
    }
    const saver = ((d.monthly_cost && d.monthly_cost.items) || []).find(i => i.code === "SUBSCRIPTION" && i.vat_basis === "UNCONFIRMED" && num(i.amount));
    if (saver) {
      const amt = num(saver.amount);
      out.push({ key: "SAVER_VAT", title: "세이버 VAT 확인", sub: `세이버 ${fmt(amt)}원을 부가세 포함 여부 모른 채 그대로 사용`,
                 impact: `0 ~ +₩${fmt(amt - Math.round(amt / 1.1))}`, action: "세이버 청구서에서 부가세 포함인지 보고 알려 주기", mine: true });
    }
    const rec = take(r => r.status === "RECOVERY_CANDIDATE");
    if (rec) {
      const rc = d.recovery || {};
      out.push({ key: "RETURN", title: "반품 회수 확인",
                 sub: `취소·반품 ${fmt(rc.check_pending_rows)}건 · 원가 ${fmt(rc.check_pending_amount)}원은 되돌려 두고 손실은 우선 0원`,
                 impact: `−₩${fmt(rc.check_pending_amount)} ~ 0`, action: "WING에서 실제 회수 수량 확인 후 기록", mine: true });
    }
    const cost = take(r => r.status === "COST_UNCONFIRMED" && !/토스/.test(r.label));
    if (cost) {
      const rw = d.rows || {};
      const parts = [];
      if (num(rw.no_cost)) parts.push(`원가가 없는 판매 ${fmt(rw.no_cost)}줄`);
      if (num(rw.cost_fallback)) parts.push(`현재 원가로 대신 계산한 판매 ${fmt(rw.cost_fallback)}줄`);
      out.push({ key: "COST", title: "원가 없는 판매 확인", sub: parts.join(" · ") || cost.text, impact: "금액 미정",
                 action: "제품 마스터에서 원가 입력", mine: true });
    }
    // 기다리면 풀리는 것(정산 진행 중 · 요율 없는 판매 · 토스 구매확정 전) - 한 줄로
    const waits = [];
    const open = take(r => r.status === "CYCLE_OPEN" && !/토스/.test(r.label));
    if (open) {
      const days = (d.open_cycle_days || []).map(md).join("·");
      const openFee = -num(by.FEE_CYCLE_OPEN);
      waits.push(`${days || "일부 날짜"} 정산 진행 중${openFee ? `(수수료 ${fmt(openFee)}원)` : ""}`);
    }
    const est = take(r => r.status === "ESTIMATED" && /요율/.test(r.label));
    if (est) waits.push(`요율 없는 판매 ${countIn(est.text, /(\d+)\s*줄/) ?? ""}줄`);
    const tossWait = take(r => /토스 정산 대기/.test(r.label));
    if (tossWait) waits.push(`토스 구매확정 전 ${num(d.toss && d.toss.pending && d.toss.pending.rows) || countIn(tossWait.text, /(\d+)\s*건/) || ""}건`);
    if (waits.length) {
      out.push({ key: "WAIT", title: `${month}월 정산 완료 대기`, sub: waits.join(" · "), impact: "금액 미정",
                 action: "할 일 없음 - 정산 자료가 들어오면 자동 반영", mine: false });
    }
    reasons.forEach((r, i) => {
      if (used.has(i)) return;
      out.push({ key: "OTHER", title: r.label, sub: r.text, impact: "금액 미정", action: "상세보기에서 확인", mine: true });
    });
    return out;
  }

  function flowHtml(m) {
    const parts = m.terms.map(([k, v, op], i) => `${i ? `<span class="cms-op">${op}</span>` : ""}<span class="cms-t"><b>${won(v)}</b><span>${esc(k)}</span></span>`);
    parts.push(`<span class="cms-op">=</span><span class="cms-t cms-res${m.cm < 0 ? " neg" : ""}"><b>${won(m.cm)}</b><span>공헌이익</span></span>`);
    return `<div class="cms-flow" aria-label="공헌이익 계산 흐름">${parts.join("")}</div>`;
  }

  function todoHtml(m) {
    if (!m.todos.length) return `<p class="cms-muted">확인할 일이 없어요.</p>`;
    return `<ul class="cms-todo">${m.todos.map(t => `<li data-key="${esc(t.key)}"><div class="cms-ti"><b>${badge(t.mine ? "check" : "pending", t.mine ? "할 일" : "자동 대기")} ${esc(t.title)}</b>
      <small>${esc(t.sub)}</small></div><div class="cms-imp">${esc(t.impact)}</div><div class="${t.mine ? "cms-act" : "cms-auto"}">${esc(t.action)}</div></li>`).join("")}</ul>`;
  }

  /** 맨 위 카드(4칸 + 흐름 + 확인할 일). settingsHtml = 설정 메뉴 안 내용(월 선택·수동 광고비·고정비·광고비 새로고침) */
  function topHtml(m, d, { settingsHtml = "", updated = "", staleHtml = "" } = {}) {
    const month = String(d.month || "");
    const [y, mo] = [month.slice(0, 4), Number(month.slice(5, 7))];
    const p = d.provisional_cm;
    return `<div class="card cms" id="cm-simple">
      <div class="cms-head">
        <div><h2>${esc(y)}년 ${mo}월 공헌이익</h2>
          <div class="cms-period">${mo}월 ${Number(String(p.period_start).slice(8, 10))}일 ~ ${Number(String(p.period_end).slice(8, 10))}일 자료 · 잠정(월 확정 전)${updated ? ` · 갱신 ${esc(updated)}` : ""}</div></div>
        <details class="cms-set"><summary class="btn sm secondary">⚙ 설정 ▾</summary><div class="cms-menu" role="menu">${settingsHtml}</div></details>
      </div>
      ${staleHtml}
      <div class="grid-stats cms-kpi">
        <div class="stat"><div class="stat-label">잠정 공헌이익(본업)</div><div class="stat-value${m.cm < 0 ? " red" : ""}">${won(m.cm)}</div>
          <small>공헌이익률 ${m.rate == null ? "—" : `${m.rate < 0 ? "−" : ""}${Math.abs(m.rate).toFixed(1)}%`} · 확정 전</small></div>
        <div class="stat"><div class="stat-label">순매출</div><div class="stat-value blue">${won(m.revenue)}</div><small>부가세 제외 · 환불·쿠폰 뺀 금액</small></div>
        <div class="stat"><div class="stat-label">총비용</div><div class="stat-value">${won(m.totalCost)}</div><small>원가·수수료·광고·물류·공통비·반품손실</small></div>
        <div class="stat"><div class="stat-label">확인할 항목</div><div class="stat-value${m.todos.length ? " amber" : " green"}">${m.todos.length}건</div>
          <small>내가 할 일 ${m.mine} · 자동 대기 ${m.auto}</small></div>
      </div>
      ${otherIncomeHtml(p)}
      ${flowHtml(m)}
      <h3 class="cms-h3">확인할 일</h3>
      ${todoHtml(m)}
      <!--cms-more-->
    </div>`;
  }

  /** 2026-10-01 재고 손실 보상 = 본업과 분리한 기타 영업수익. 요약에 값이 있을 때만(없으면 0원으로 만들지 않음). */
  function otherIncomeHtml(p) {
    if (!p || p.other_income == null || p.amount_with_other_income == null) return "";
    return `<p class="cms-other" id="cms-other-income">기타 영업수익 · 재고 손실 보상 <b>${signed(p.other_income)}</b> → 보상 포함 손익 <b class="${num(p.amount_with_other_income) < 0 ? "red" : ""}">${won(p.amount_with_other_income)}</b> <small>(본업 공헌이익과 별도)</small></p>`;
  }

  // ── 상세보기 안 ────────────────────────────────────────────────────────
  function calcTableHtml(d, m) {
    const p = d.provisional_cm;
    const st = { CONFIRMED: "✓ 확정", CYCLE_OPEN: "⏳ 정산 진행 중", ESTIMATED: "ℹ 예상", ACCRUED: "⚠ 청구 미확인(ACCRUED)",
                 COST_UNCONFIRMED: "⚠ 원가 미확정", COST_UNREGISTERED: "비용 미등록", VAT_UNCONFIRMED: "⚠ VAT 미확인",
                 RECOVERY_CANDIDATE: "✎ 회수·손실 확인 대기", NOTICE_MISSING: "공지 미확인" };
    const row = (label, v, src = "", s = "", cls = "") => `<tr${cls ? ` class="${cls}"` : ""}><td>${esc(label)}</td><td class="num">${won(v)}</td><td>${esc(src)}</td><td>${esc(s)}</td></tr>`;
    const rev = d.lines.filter(l => REVENUE_CODES.includes(l.code));
    const rest = d.lines.filter(l => !REVENUE_CODES.includes(l.code));
    const monthly = ((d.monthly_cost && d.monthly_cost.items) || []).map(i =>
      row(`월 공통비 · ${i.label}${i.vat_basis === "INCLUDED_SPLIT" ? " (공급가, VAT 분리)" : ""}`, -num(i.amount), "정산파일",
          i.vat_basis === "UNCONFIRMED" ? "⚠ VAT 미확인" : i.vat_basis === "INCLUDED_SPLIT" ? "✓ 대표 확정" : "⏳"));
    const rw = d.rows || {};
    return `<div class="table-wrap"><table class="cms-tbl"><thead><tr><th>항목</th><th class="num">금액(공급가액)</th><th>출처</th><th>상태</th></tr></thead><tbody>
      ${rev.map(l => row(l.label, l.amount, l.source, st[l.status] || l.status)).join("")}
      ${row("= 순매출", m.revenue, "", "", "tot")}
      ${rest.map(l => row(l.label, l.amount, l.source, st[l.status] || l.status)).join("")}
      ${row("판매분 입고 운반비(리파코 → 쿠팡창고)", -num(p.inbound_freight), "ERP", "✓ 확정")}
      ${monthly.join("")}
      ${row("= 잠정 공헌이익(본업)", m.cm, "", "잠정", "tot")}
      ${p.other_income != null ? row("+ 기타 영업수익 · 재고 손실 보상", p.other_income, "정산파일", "본업과 별도") : ""}
      ${p.amount_with_other_income != null ? row("= 보상 포함 손익", p.amount_with_other_income, "", "잠정", "tot") : ""}
    </tbody></table></div>
    <p class="cms-muted">주문 ${fmt(rw.orders)}건 · 취소 ${fmt(rw.cancels)}건 · 판매수수료·광고비 VAT 는 매입세액이라 공헌이익에서 빼지 않아요.</p>`;
  }

  function adCompareHtml(d, m, adInfo) {
    const days = (adInfo && adInfo.days) || [];
    const p = d.provisional_cm;
    const inPeriod = days.filter(x => x.date >= p.period_start && x.date <= p.period_end && x.auto && x.status === "OK");
    const daily = inPeriod.reduce((t, x) => t + num(x.auto.net), 0);
    const ads = d.ads || {};
    const rc = adInfo && adInfo.recon;
    return `<table class="cms-tbl"><tbody>
      <tr><td>광고 성과용 집행액 (WING 일별 합계 ${esc(String(p.period_start).slice(5))}~${esc(String(p.period_end).slice(5))})</td><td class="num">${won(daily)}</td></tr>
      <tr><td>공헌이익에 쓴 실제 청구액</td><td class="num"><b>${won(m.ad)}</b></td></tr>
      <tr><td class="cms-muted">&nbsp;&nbsp;로켓그로스 정산 청구액 + 정산 밖 청구 미확인(ACCRUED)${num(ads.outside_billed) ? " + 정산 밖 실제 청구" : ""}</td>
        <td class="num cms-muted">${won(ads.billed)} + ${won(ads.outside_accrued)}${num(ads.outside_billed) ? ` + ${won(ads.outside_billed)}` : ""}</td></tr>
      ${rc && rc.diff != null ? `<tr><td class="cms-muted">&nbsp;&nbsp;WING 구간 합계와 반올림 차이(ROUNDING_DIFFERENCE · ${esc(String(rc.periodStart).slice(5))}~${esc(String(rc.periodEnd).slice(5))})</td><td class="num cms-muted">${won(Math.abs(rc.diff))}</td></tr>` : ""}
    </tbody></table>`;
  }

  function recoveryHtml(d) {
    const rc = d.recovery || {};
    return `<table class="cms-tbl"><tbody>
      <tr><td>취소·반품 원가 재고 복원 (전량 회수 운영 기준 · 환불 수량 × 원판매 원가)</td><td class="num">${won(rc.confirmed)} · ${fmt(rc.check_pending_rows)}건 확인 대기</td></tr>
      <tr><td>반품 손실 (폐기·파손 기록분만)</td><td class="num">${won(-num(rc.loss))}</td></tr>
      <tr><td>회수·손실 확인 대기 (전량 미회수면 최대)</td><td class="num">${won(rc.check_pending_amount)} (최대 ${won(-num(rc.check_pending_amount))})</td></tr>
    </tbody></table>`;
  }

  function freightHtml(d) {
    return `<table class="cms-tbl"><tbody><tr><td>판매분 입고 운반비 (FIFO 판매분 귀속 · 반품은 원래 배치로 복원 · 등급상품 재판매 1회 재차감)</td><td class="num">${won(num(d.provisional_cm.inbound_freight))}</td></tr></tbody></table>`;
  }

  function sourcesHtml(d, { updatedAt = "" } = {}) {
    const mc = d.monthly_cost || {};
    return `<p class="cms-muted cms-src">정산파일(쿠팡 정산 원본) · ERP(매출·원가·운송비) · API(쿠팡 매출내역·WING 광고 지표) · 대표 확정(판매자배송 택배비·포장비 0원)<br>
      최신 자료 ${esc(d.latest_data_date)} · 계산 ${esc(updatedAt || d.generated_at)} · 실행 ${esc(String(d.run_id || "").slice(0, 8))} · 계산 버전 ${esc(d.contrib_version)} / ${esc(d.calc_version)}<br>
      월 비용 조회 ${esc(mc.range || "")}${d.inputs_hash ? ` · 입력 해시 ${esc(String(d.inputs_hash).slice(0, 16))}` : ""}${d.artifacts ? ` · 보관 ${esc(d.artifacts)}` : ""}</p>`;
  }

  /** 상세보기 + 이전 계산 보기(기존 카드들을 그대로 접어 넣음) */
  function moreHtml(d, m, { adInfo = null, adCardHtml = "", freightCardHtml = "", previousHtml = "", updatedAt = "" } = {}) {
    const sub = (title, body) => `<details class="cms-sub" open><summary>${esc(title)}</summary>${body}</details>`;
    return `<details class="cms-more" id="cms-detail"><summary><span>상세보기<small>계산표 · 광고비 두 값 · 반품·회수 · 입고 운송비 · 데이터 출처</small></span></summary>
        ${sub("계산표 (항목별 금액 · 출처 · 상태)", calcTableHtml(d, m))}
        ${sub("광고비 두 값 비교", adCompareHtml(d, m, adInfo) + adCardHtml)}
        ${sub("반품·회수", recoveryHtml(d))}
        ${sub("입고 운송비", freightHtml(d) + freightCardHtml)}
        ${sub("데이터 출처", sourcesHtml(d, { updatedAt }))}
      </details>
      <details class="cms-more" id="cms-previous"><summary><span>이전 계산 보기<small>저장된 공헌이익 스냅샷 · 코호트 · 쿠팡 정산 잔액</small></span></summary>
        ${previousHtml || `<p class="cms-muted">저장된 이전 계산이 없어요.</p>`}
      </details>`;
  }

  root.CmSimple = { model, todoItems, topHtml, otherIncomeHtml, moreHtml, calcTableHtml, adCompareHtml, recoveryHtml, freightHtml, sourcesHtml, flowHtml, todoHtml };
})(typeof window !== "undefined" ? window : globalThis);
