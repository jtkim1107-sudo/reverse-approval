/* purchase_payments.js — 발주 · 입고 · 지급을 한 줄로 보는 카드 (2026-10-22 대표 승인)
 * -------------------------------------------------------------------------------
 * 읽기만 해요. 발주 전송·입고 신청·승인·송금·알림은 이 파일에 없습니다.
 *
 * 한 줄에 담는 것: 업체 · 상품 · 수량 · 단가 · 상품대금 · 발주 상태 · 입고 상태 · 지급 상태
 *                 · 지급 예정일 · 미지급 잔액 · 다음 할 일 (자세한 품목은 펼침)
 *
 * 계산 기준(서버 cash_purchase_terms.py 와 같은 원천·같은 식)
 *   · 지급 예정일 = 매입월 다음 달 20일 (10월 → 11/20, 12월 → 다음 해 1/20)
 *   · 상품대금  = 매입 원장(purchases) 행마다 qty×단가, 과세·매입원가 VAT 별도 설정이면 ×1.1 후 원 단위 반올림
 *   · 그룹 기준 = (매입월, 발주) — 자금일보 cash_plans(AUTO_PURCHASE_TERMS=월:발주) 와 같은 묶음이라 합계가 일치해요.
 *   · 매입 원장이 아직 없으면 발주서 품목(발주 시점 단가)으로 '발주 기준' 잠정 표시 - 기준을 화면에 적어요.
 *
 * 지키는 것
 *   · 발주 시점 단가 보존: 금액은 purchases/purchase_order_items 에 저장된 단가만 써요(상품 마스터 현재 원가를 쓰지 않음).
 *   · 발주·입고·지급은 서로 다른 상태로 따로 표시 - 하나가 끝나도 나머지를 끝난 것처럼 보이지 않게.
 *   · 운반비는 확정(실제 청구)된 것만 한 번 더해요. 미확정이면 더하지 않고 '운반비 미확정'을 적어 0원 확정으로 오해하지 않게.
 *   · 기지급액은 통장 거래에 그 발주(발주번호·매입 id)가 적힌 출금만 차감해요. 적히지 않은 출금은 '확인 필요'로 두고 지급 완료로 바꾸지 않아요.
 *   · 재신청 입고는 원래 발주에 묶여 들어와요(발주 단위 그룹) - 새 매입으로 두 번 세지 않습니다.
 */
(function (global) {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));
  const fmt = n => Math.round(num(n)).toLocaleString("ko-KR");
  const won = n => `₩${fmt(n)}`;
  const ymd = s => String(s || "").slice(0, 10);

  /** 매입월 다음 달 20일 - 서버 cash_purchase_terms.next_twentieth 와 같은 규칙(12월 → 다음 해 1월 20일) */
  function nextTwentieth(day) {
    const d = ymd(day);
    const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
    const ny = y + (m === 12 ? 1 : 0), nm = (m % 12) + 1;
    return `${ny}-${String(nm).padStart(2, "0")}-20`;
  }

  /** 매입 한 행의 지급 금액(VAT 포함) - 서버와 같은 순서: ×1.1 후 원 단위 반올림 */
  function payableOf(amount, product, vat) {
    let v = num(amount);
    const taxable = (product && product.tax_type) === "과세";
    if (vat && vat.enabled && !vat.purchaseCostIncludesVat && taxable) v *= 1.1;
    return Math.round(v);
  }

  // 발주 배지는 '발주가 어디까지 왔나'만 말해요 - 입고 진행은 입고 배지가 따로 말합니다.
  //   (발주서 화면의 기존 상태 라벨에서 'partial/done' 은 입고를 뜻해서 여기서는 쓰지 않아요)
  const PO_LABEL = { progress: "결재 대기", approved: "승인 완료", rejected: "반려", ordered: "발주 완료",
                     partial: "발주 완료", done: "발주 완료", canceled: "취소", wing_direct_review: "검토 초안" };
  const PO_KIND = { progress: "pending", approved: "ok", rejected: "rejected", ordered: "info",
                    partial: "info", done: "info", canceled: "muted", wing_direct_review: "pending" };
  // 지급 의무가 남아 있는 발주(예상 지급액을 잡는 대상) - 결재 전·검토 초안·취소는 넣지 않아요.
  const OBLIGATION = ["approved", "ordered", "partial", "done"];
  const HOLD = ["progress", "wing_direct_review"];

  function badge(kind, text, title) {
    const UI = global.ErpUi;
    if (UI && UI.badge) return UI.badge(kind, { text, small: true, title: title || "" });
    return `<span class="erp-badge erp-badge--sm"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
  }

  /** 입고 상태 - 수량(발주 대비 입고)과 입고 신청 오류를 따로 봐요(둘은 다른 사실) */
  function inboundStateOf(items, plans) {
    const ordered = items.reduce((s, i) => s + num(i.qty), 0);
    const got = items.reduce((s, i) => s + num(i.received_qty), 0);
    const live = plans.filter(p => !p.resubmission_of_plan_id && !p.retry_of_plan_id);  // 재신청·재시도는 원건에 묶어요
    const hasError = p => !!(p.preflight_status === "FAILED" || p.last_error_code || p.rejection_code
                            || p.submit_status === "FAILED" || p.recovery_status === "NEEDS_RECOVERY");
    // 그 계획을 대신해 다시 올린 계획이 있으면(재신청·재시도) 그 오류는 '지나간 일' 이에요.
    const replaced = new Set(plans.map(p => p.resubmission_of_plan_id || p.retry_of_plan_id).filter(Boolean));
    // 끝난 오류로 보는 경우(실측 2026-10-22): 다른 계획이 대신 올라갔거나, 그 계획 자체가 취소·입고 완료됐거나,
    //   복구가 끝나(DB 동기화까지) 더 손댈 게 없는 상태. 'PLAN_ID_CAPTURED' 처럼 복구 진행 중은 현재 오류로 둡니다.
    const DONE_STATUS = ["CANCELLED", "CANCELED", "RECEIVED", "DONE", "COMPLETED"];
    const DONE_RECOVERY = ["RECOVERED", "DB_SYNCED"];
    const resolved = p => replaced.has(p.id)
      || DONE_RECOVERY.includes(String(p.recovery_status || "").toUpperCase())
      || DONE_STATUS.includes(String(p.internal_status || "").toUpperCase());
    const errs = plans.filter(hasError);
    const open = errs.filter(p => !resolved(p));
    const past = errs.filter(resolved);
    const reasonOf = p => p.last_error_message || p.rejection_reason || p.rejection_code || p.last_error_code || "입고 신청 오류";
    const state = ordered <= 0 ? "UNKNOWN" : got <= 0 ? "NONE" : got < ordered ? "PARTIAL" : "DONE";
    return { ordered, got, remain: Math.max(ordered - got, 0), state, plans: live.length,
             errors: open.length, errorReason: open.length ? reasonOf(open[0]) : "",
             pastErrors: past.length, pastReasons: past.map(reasonOf).slice(0, 3) };
  }

  const INBOUND_TEXT = { NONE: ["pending", "미입고"], PARTIAL: ["pending", "일부 입고"], DONE: ["ok", "입고 완료"],
                         UNKNOWN: ["muted", "품목 없음"] };

  /** 통장 출금 ↔ 발주 연결 - 메모에 발주번호나 매입 id 가 적힌 것만(추측 매칭 없음) */
  function matchedPayments(txns, { poNo, purchaseIds }) {
    const keys = [poNo].filter(Boolean).concat(purchaseIds || []);
    if (!keys.length) return [];
    return (txns || []).filter(t => t.kind === "출금" && keys.some(k => String(t.memo || "").includes(k)
      || String(t.title || "").includes(k)));
  }

  /**
   * 출금 한 건을 '한 곳에만' 배분해요 - 같은 돈이 여러 발주·여러 매입월에 두 번 빠지지 않게.
   *   · 어느 줄을 가리키는지 하나로 정해지지 않으면(여러 발주 / 같은 발주의 여러 매입월) 배분하지 않고 '모호'로 남겨요.
   *   · 확정(매입 기준) 줄과 예상(매입 전) 줄이 같이 걸리면 확정 줄에 붙여요.
   *   · 공급처 이름만 적힌 출금은 애초에 걸리지 않아요(matchedPayments 기준).
   */
  function allocatePayments(txns, rows) {
    const byKey = new Map(), ambiguous = [];
    (txns || []).filter(t => t.kind === "출금").forEach(t => {
      const hay = `${t.memo || ""} ${t.title || ""}`;
      const hits = rows.filter(r => (r.matchKeys || []).some(k => k && hay.includes(k)));
      if (!hits.length) return;
      // 서로 다른 발주가 함께 적혀 있으면 배분 기준이 없어요(합산 지급 추정 금지)
      if (new Set(hits.map(h => h.poId)).size > 1) {
        ambiguous.push({ id: t.id, date: ymd(t.date), amount: num(t.amount),
                         reason: "여러 발주가 함께 적혀 있어 어느 발주 지급인지 알 수 없어요" });
        return;
      }
      // 같은 발주 안에서 확정(매입 기준) 줄이 있으면 거기에 붙여요 - 확정·예상에 두 번 빼지 않게
      const confirmed = hits.filter(h => h.basis === "PURCHASE");
      const target = confirmed.length ? confirmed : hits;
      if (new Set(target.map(h => h.key)).size > 1) {
        ambiguous.push({ id: t.id, date: ymd(t.date), amount: num(t.amount),
                         reason: "같은 발주의 매입월이 여러 개라 어느 달 지급인지 알 수 없어요" });
        return;
      }
      const cur = byKey.get(target[0].key) || { amount: 0, txns: [] };
      cur.amount += num(t.amount); cur.txns.push(t);
      byKey.set(target[0].key, cur);
    });
    return { byKey, ambiguous };
  }

  /**
   * 화면 자료 만들기(순수 계산 - 네트워크 없음).
   * 반환: { groups: [...], due: { date, total, bySupplier[] }, unverifiedPayouts, asOf }
   */
  function model({ pos = [], items = [], purchases = [], products = [], plans = [], txns = [],
                   inbounds = [], freights = [], vat = {}, today = "" } = {}) {
    const poById = Object.fromEntries(pos.map(p => [p.id, p]));
    const prodById = Object.fromEntries(products.map(p => [p.id, p]));
    const itemsByPo = {}, inboundByPo = {}, freightByPo = {};
    items.forEach(i => (itemsByPo[i.po_id] = itemsByPo[i.po_id] || []).push(i));
    inbounds.forEach(p => (inboundByPo[p.purchase_order_id] = inboundByPo[p.purchase_order_id] || []).push(p));
    freights.forEach(f => (freightByPo[f.purchase_order_id] = freightByPo[f.purchase_order_id] || []).push(f));

    // (매입월, 발주) 묶음 - 자금일보 cash_plans 와 같은 키
    const groups = new Map();
    const keyOf = (month, poId) => `${month}:${poId}`;
    purchases.forEach(p => {
      const month = ymd(p.date).slice(0, 7);
      const poId = p.po_id || `purchase:${p.id}`;
      const k = keyOf(month, poId);
      const g = groups.get(k) || { key: k, month, poId, basis: "PURCHASE", purchases: [], goods: 0, qty: 0,
                                   firstDate: ymd(p.date), supplier: p.supplier || "" };
      g.purchases.push(p);
      g.goods += payableOf(p.amount, prodById[p.product_id], vat);
      g.qty += num(p.qty);
      if (ymd(p.date) < g.firstDate) g.firstDate = ymd(p.date);
      g.supplier = g.supplier || p.supplier || "";
      groups.set(k, g);
    });
    // 발주는 넣었는데 매입 입력이 아직 안 된 몫 = '예상 지급액'.
    //   전부 미입력이면 발주 전액, 일부만 입력됐으면 *남은 몫만* 잡아 같은 발주를 두 번 세지 않아요.
    //   (매입이 들어오면 그 금액만큼 예상이 줄고 확정 줄로 옮겨 갑니다 - 전환 중에도 합계가 겹치지 않아요)
    pos.forEach(po => {
      if (po.status === "canceled" || po.status === "rejected") return;
      const its = itemsByPo[po.id] || [];
      if (!its.length) return;
      const orderedPayable = its.reduce((s, i) =>
        s + payableOf(num(i.amount) || num(i.qty) * num(i.unit_cost), prodById[i.product_id], vat), 0);
      const purchased = [...groups.values()].filter(g => g.poId === po.id).reduce((s, g) => s + g.goods, 0);
      const remain = orderedPayable - purchased;
      if (remain <= 0) return;                       // 매입이 발주액을 다 채웠으면 예상 줄이 필요 없어요
      const month = ymd(po.date).slice(0, 7);
      const hold = HOLD.includes(po.status);
      const partial = purchased > 0;
      groups.set(`${month}:${po.id}:EST`, {
        key: `${month}:${po.id}:EST`, month, poId: po.id, basis: "ORDER", purchases: [], firstDate: ymd(po.date),
        supplier: po.supplier || "", goods: remain, hold, partialOfPurchased: partial,
        orderedPayable, purchasedPayable: purchased,
        qty: partial ? 0 : its.reduce((s, i) => s + num(i.qty), 0),
      });
    });

    const rows = [...groups.values()].map(g => {
      const po = poById[g.poId] || null;
      const its = po ? (itemsByPo[po.id] || []) : [];
      const inb = inboundStateOf(its, po ? (inboundByPo[po.id] || []) : []);
      const frs = po ? (freightByPo[po.id] || []) : [];
      // 운반비는 발주마다 한 번만 - 그 발주의 가장 이른 묶음에만 붙여요(달이 나뉘어도 두 번 더하지 않게)
      const firstOfPo = [...groups.values()].filter(x => x.poId === g.poId).sort((a, b) => a.month.localeCompare(b.month))[0];
      const ownsFreight = firstOfPo && firstOfPo.key === g.key;
      const actual = frs.filter(f => f.basis === "ACTUAL");
      const freight = { records: frs.length, confirmed: actual.length > 0, owns: !!ownsFreight,
                        amount: ownsFreight ? actual.reduce((s, f) => s + num(f.gross), 0) : 0,
                        estimate: po ? num(po.freight_est) : 0 };
      const purchaseIds = g.purchases.map(p => p.id);
      const payDate = nextTwentieth(g.firstDate);
      const plan = (plans || []).find(p => String(p.memo || "").includes(`AUTO_PURCHASE_TERMS=${g.key}`)) || null;
      const base = g.goods + (freight.confirmed ? freight.amount : 0);
      const orderMonth = po ? ymd(po.date).slice(0, 7) : g.month;
      return { ...g, po, items: its, inbound: inb, freight, plan, payDate, base, purchaseIds,
               matchKeys: [po && po.po_no].filter(Boolean).concat(purchaseIds),
               orderMonth, basisNote: orderMonth !== g.month ? `매입월 ${g.month} 기준 · 발주 ${orderMonth}` : "",
               outstandingBasis: freight.confirmed ? "상품대금 + 확정 운반비" : "상품대금 기준(운반비 미확정)" };
    }).sort((a, b) => (a.payDate.localeCompare(b.payDate) || String(b.firstDate).localeCompare(String(a.firstDate))));

    // 출금 배분(중복 차감 금지) → 줄마다 확인된 기지급·미지급 잔액·지급 상태
    const alloc = allocatePayments(txns, rows);
    rows.forEach(r => {
      const got = alloc.byKey.get(r.key) || { amount: 0, txns: [] };
      r.paid = got.txns;
      r.paidAllocated = got.amount;
      r.paidAmount = Math.min(got.amount, r.base);        // 총액 상한 - 발주 금액보다 더 빼지 않아요
      r.overPaid = Math.max(got.amount - r.base, 0);
      r.outstanding = Math.max(r.base - r.paidAmount, 0);
      r.payState = r.hold ? "HOLD"
        : r.basis === "ORDER" ? "NOT_PURCHASED"
        : r.paidAmount <= 0 ? (r.payDate < today ? "OVERDUE" : "SCHEDULED")
        : r.paidAmount < r.base ? "PARTIAL" : "PAID";
    });

    // 다음 지급일 = 가장 가까운 미래의 20일(확정·예상을 같은 날짜로 함께 봅니다)
    const auto = (plans || []).filter(p => String(p.memo || "").includes("AUTO_PURCHASE_TERMS=") && p.kind === "출금");
    const dates = [...new Set(auto.map(p => ymd(p.date)).concat(rows.map(r => r.payDate)))].filter(Boolean).sort();
    const dueDate = dates.find(d => d >= today) || dates[dates.length - 1] || "";
    const at = rows.filter(r => r.payDate === dueDate);
    const confirmedRows = at.filter(r => r.basis === "PURCHASE");
    const estimateRows = at.filter(r => r.basis === "ORDER" && !r.hold);
    const holdRows = at.filter(r => r.hold);
    const sum = (list, f) => list.reduce((s, r) => s + num(f(r)), 0);
    const bucket = list => {
      const by = {};
      list.forEach(r => { const n = r.supplier || "확인 필요"; by[n] = (by[n] || 0) + num(r.goods); });
      return Object.entries(by).map(([name, amount]) => ({ name, amount })).sort((a, b) => b.amount - a.amount);
    };
    const due = {
      date: dueDate,
      confirmed: { total: sum(confirmedRows, r => r.goods), count: confirmedRows.length, bySupplier: bucket(confirmedRows) },
      estimated: { total: sum(estimateRows, r => r.goods), count: estimateRows.length, bySupplier: bucket(estimateRows) },
      hold: { total: sum(holdRows, r => r.goods), count: holdRows.length,
              items: holdRows.map(r => ({ po: r.po && r.po.po_no, amount: r.goods,
                reason: r.po && r.po.status === "progress" ? "결재 대기 - 승인 전이라 지급 의무가 확정되지 않았어요"
                  : "WING 직접입고 검토 초안 - 사람이 정식 발주로 전환해야 해요" })) },
      freightConfirmed: sum(confirmedRows.concat(estimateRows), r => (r.freight.confirmed ? r.freight.amount : 0)),
      paid: sum(confirmedRows.concat(estimateRows), r => r.paidAmount),
      outstanding: sum(confirmedRows.concat(estimateRows), r => r.outstanding),
    };
    due.total = due.confirmed.total + due.estimated.total;
    due.bySupplier = bucket(confirmedRows.concat(estimateRows));
    // 자금일보 대조 - 같은 원천·같은 정책인지 단계별로 보여 줘요(상품대금 → +확정 운반비 → −확인된 지급)
    const cashAt = auto.filter(p => ymd(p.date) === dueDate);
    const reconcile = {
      cash: cashAt.reduce((s, p) => s + num(p.amount), 0), cashCount: cashAt.length,
      screen: due.confirmed.total, ok: Math.abs(due.confirmed.total - cashAt.reduce((s, p) => s + num(p.amount), 0)) <= 1,
      freight: due.freightConfirmed, paid: due.paid, outstanding: due.outstanding,
      note: "자금일보 예정출금은 상품대금만 잡아요(운반비 별도·지급 대사 전). 이 화면은 거기에 확정 운반비를 더하고 확인된 지급을 뺀 잔액을 따로 보여 줍니다.",
    };
    const matchedIds = new Set(rows.flatMap(r => r.paid.map(t => t.id)));
    const ambiguousIds = new Set(alloc.ambiguous.map(a => a.id));
    const unverified = (txns || []).filter(t => t.kind === "출금" && ymd(t.date) >= "2026-09-01"
      && !matchedIds.has(t.id)).length;
    return { rows, due, reconcile, unverifiedPayouts: unverified, ambiguousPayouts: alloc.ambiguous,
             overPaid: rows.filter(r => r.overPaid > 0).map(r => ({ po: r.po && r.po.po_no, over: r.overPaid })),
             asOf: today };
  }

  function stateCell(r) {
    const po = r.po;
    const orderBadge = po ? badge(PO_KIND[po.status] || "pending", `발주 ${PO_LABEL[po.status] || po.status}`, "발주서 결재·진행 상태")
      : badge("muted", "발주서 없음", "매입 원장만 있는 건이에요");
    const [ik, it] = INBOUND_TEXT[r.inbound.state] || INBOUND_TEXT.UNKNOWN;
    const inBadge = po ? badge(ik, `입고 ${it}`, `발주 ${fmt(r.inbound.ordered)} · 입고 ${fmt(r.inbound.got)}`) : "";
    const errBadge = r.inbound.errors
      ? badge("error", "입고 오류", `${r.inbound.errorReason}${r.inbound.state === "DONE"
          ? " (입고 수량은 다 채워졌지만 이 입고 신청은 아직 정리되지 않았어요)" : ""}`) : "";
    const pastBadge = !r.inbound.errors && r.inbound.pastErrors
      ? badge("muted", `지난 입고 오류 ${r.inbound.pastErrors}건`, `재신청·재시도로 끝난 오류예요: ${r.inbound.pastReasons.join(" / ")}`) : "";
    const payBadge = { SCHEDULED: ["info", "지급 예정"], OVERDUE: ["pending", "지급 확인 필요"],
                       PARTIAL: ["pending", "일부 지급"], PAID: ["ok", "지급 완료"],
                       NOT_PURCHASED: ["info", "지급 예상(매입 전)"], HOLD: ["muted", "지급 보류"] }[r.payState];
    return `<div class="pp-states">${orderBadge}${inBadge}${errBadge}${pastBadge}${badge(payBadge[0], payBadge[1], "통장 매칭이 확인된 지급만 차감해요")}</div>`;
  }

  function nextTodo(r) {
    if (r.po && r.po.status === "progress") return "결재 올린 발주서를 승인·반려 처리";
    if (r.po && r.po.status === "wing_direct_review") return "WING 직접입고 검토 초안을 정식 발주로 전환하거나 취소";
    if (r.inbound.errors) return `입고 신청 오류 확인: ${r.inbound.errorReason}`;
    if (r.basis === "ORDER") return r.partialOfPurchased
      ? "남은 수량 매입 입력 → 예상이 확정 지급액으로 옮겨져요"
      : "입고된 수량으로 매입 입력 → 지급 예정이 잡혀요";
    if (r.inbound.state === "PARTIAL") return `남은 ${fmt(r.inbound.remain)}개 입고 확인`;
    if (!r.freight.confirmed && r.freight.records) return "운반비 실제 청구서 등록(지금은 상품대금만 잡혀 있어요)";
    if (r.payState === "OVERDUE") return "통장에서 지급 확인 → 출금 메모에 발주번호 적기";
    if (r.payState === "PARTIAL") return `남은 ${won(r.outstanding)} 지급 확인`;
    if (r.payState === "PAID") return "끝 - 더 할 일 없어요";
    return `${r.payDate} 지급 예정 (지금은 할 일 없음)`;
  }

  function itemsHtml(r) {
    const src = r.basis === "PURCHASE" ? r.purchases : r.items;
    if (!src.length) return `<p class="pp-note">품목 자료가 없어요.</p>`;
    return `<table class="pp-items"><thead><tr><th>상품</th><th class="num">수량</th><th class="num">단가</th><th class="num">금액</th></tr></thead><tbody>
      ${src.map(x => `<tr><td>${esc(x._name || x.product_name || x.option_name || x.product_id || "")}</td>
        <td class="num">${fmt(x.qty)}</td><td class="num">${won(x.unit_cost)}</td>
        <td class="num">${won(num(x.amount) || num(x.qty) * num(x.unit_cost))}</td></tr>`).join("")}
    </tbody></table>
    <p class="pp-note">단가는 ${r.basis === "PURCHASE" ? "매입 입력" : "발주서 작성"} 당시 저장된 값이에요 - 상품 마스터 원가를 나중에 바꿔도 이 금액은 바뀌지 않아요.</p>`;
  }

  function rowHtml(r) {
    const po = r.po;
    const title = po ? po.po_no : `매입 ${String(r.poId).replace("purchase:", "").slice(0, 8)}`;
    const names = (r.basis === "PURCHASE" ? r.purchases : r.items).map(x => x._name).filter(Boolean);
    const first = names[0] || "품목 확인 필요";
    const more = names.length > 1 ? ` 외 ${names.length - 1}종` : "";
    return `<details class="pp-row">
      <summary>
        <div class="pp-main">
          <b>${esc(r.supplier || "거래처 확인 필요")}</b>
          <span class="pp-sub">${esc(title)} · ${esc(first)}${esc(more)} · ${fmt(r.qty)}개</span>
        </div>
        <div class="pp-amt"><b>${won(r.goods)}</b><span class="pp-sub">상품대금(VAT 포함)</span></div>
        <div class="pp-pay"><b>${esc(r.payDate)}${r.basis === "ORDER" ? " <small>(예상)</small>" : ""}</b>
          <span class="pp-sub">미지급 ${won(r.outstanding)}</span></div>
        ${stateCell(r)}
      </summary>
      <div class="pp-detail">
        <div class="pp-facts">
          <div><span>기준</span><b>${r.basis === "PURCHASE" ? "매입 원장" : "발주서(매입 입력 전 잠정)"}${r.basisNote ? ` · ${esc(r.basisNote)}` : ""}</b></div>
          <div><span>지급 예정일</span><b>${esc(r.payDate)} <small>${r.basis === "ORDER"
            ? `발주월 ${esc(r.month)} 기준 예상 - 매입 입력하면 매입월 기준으로 확정돼요`
            : `매입월 ${esc(r.month)} 다음 달 20일`}</small></b></div>
          <div><span>상품대금</span><b>${won(r.goods)} <small>VAT 포함</small></b></div>
          <div><span>운반비</span><b>${r.freight.confirmed ? `${won(r.freight.amount)} <small>실제 청구 · 한 번만 반영</small>`
            : r.freight.records ? `<span class="pp-warn">미확정</span> <small>예상 ${won(r.freight.estimate)} · 잔액에 넣지 않았어요</small>`
            : `<small>기록 없음</small>`}</b></div>
          <div><span>확인된 기지급</span><b>${r.paidAmount ? won(r.paidAmount) : `<small>없음 · 통장에 이 발주가 적힌 출금만 차감해요</small>`}</b></div>
          <div><span>미지급 잔액</span><b>${won(r.outstanding)} <small>${esc(r.outstandingBasis)}</small></b></div>
          <div><span>입고</span><b>${fmt(r.inbound.got)} / ${fmt(r.inbound.ordered)}${r.inbound.errors
            ? ` · <span class="pp-warn">지금 오류 ${r.inbound.errors}건</span>` : ""}${r.inbound.pastErrors
            ? ` <small>· 지난 오류 ${fmt(r.inbound.pastErrors)}건(재신청·재시도로 끝남)</small>` : ""}</b></div>
          ${r.basis === "ORDER" && r.partialOfPurchased ? `<div><span>예상 남은 몫</span><b>${won(r.goods)}
            <small>발주 ${won(r.orderedPayable)} − 매입 입력 ${won(r.purchasedPayable)}</small></b></div>` : ""}
          ${r.overPaid ? `<div><span>확인 필요</span><b class="pp-warn">${won(r.overPaid)} 초과 매칭 <small>발주 금액보다 많은 출금이 걸려 있어요</small></b></div>` : ""}
          <div><span>다음 할 일</span><b>${esc(nextTodo(r))}</b></div>
        </div>
        ${itemsHtml(r)}
        ${po ? `<p class="pp-note"><a href="#/podoc/${esc(po.id)}">발주서 문서 보기 ›</a></p>` : ""}
      </div>
    </details>`;
  }

  function cardHtml(m) {
    if (!m || !m.rows.length) {
      return `<div class="card pp"><h2>💳 발주 · 입고 · 지급</h2><p class="pp-note">아직 매입·발주 자료가 없어요.</p></div>`;
    }
    const d = m.due;
    return `<div class="card pp" id="purchase-payments">
      <div class="card-head"><h2>💳 발주 · 입고 · 지급</h2>
        <small class="pp-sub">발주 · 입고 · 지급은 각각 따로 표시돼요 · 금액은 저장된 발주 시점 단가 기준</small></div>
      <div class="pp-due">
        <div class="pp-due-main"><span>다음 지급일</span><b>${esc(d.date || "예정 없음")}</b>
          <em>${won(d.total)}</em>
          <small>확정 ${won(d.confirmed.total)}(${d.confirmed.count}건 · 매입 입력됨)
            + 예상 ${won(d.estimated.total)}(${d.estimated.count}건 · 발주했지만 매입 전)
            ${d.hold.count ? ` · 보류 ${won(d.hold.total)}(${d.hold.count}건, 합계 제외)` : ""}</small>
          <small>매입월 다음 달 20일 · VAT 포함 · 운반비 별도(자금일보와 같은 계산)</small></div>
        ${d.bySupplier.length ? `<ul class="pp-due-list">${d.bySupplier.map(x =>
          `<li><span>${esc(x.name)}</span><b>${won(x.amount)}</b></li>`).join("")}</ul>` : ""}
      </div>
      <div class="pp-recon">
        ${m.reconcile.ok ? `<p class="pp-note">✓ 확정분 ${won(m.reconcile.screen)} 는 자금일보 ${esc(d.date)} 예정출금 ${m.reconcile.cashCount}건과 같은 금액이에요.</p>`
          : `<p class="pp-note pp-warn">⚠ 확정분 ${won(m.reconcile.screen)} 와 자금일보 ${won(m.reconcile.cash)} 가 달라요 - 매입 입력·지급 예정 반영을 확인해 주세요.</p>`}
        <p class="pp-note">같은 날 실제로 나갈 돈: 상품대금 ${won(d.confirmed.total + d.estimated.total)}
          ${d.freightConfirmed ? `＋ 확정 운반비 ${won(d.freightConfirmed)}` : "＋ 운반비 미확정(더하지 않음)"}
          ${d.paid ? `－ 확인된 지급 ${won(d.paid)}` : "－ 확인된 지급 없음"} ＝ <b>미지급 ${won(d.outstanding)}</b>.
          ${esc(m.reconcile.note)}</p>
        ${d.hold.count ? `<p class="pp-note">보류 ${d.hold.count}건은 합계에서 뺐어요: ${d.hold.items.map(h =>
          `${esc(h.po || "")} ${won(h.amount)}(${esc(h.reason)})`).join(" · ")}</p>` : ""}
        ${m.ambiguousPayouts.length ? `<p class="pp-note pp-warn">⚠ 어느 발주 지급인지 하나로 정해지지 않아 차감하지 않은 출금 ${m.ambiguousPayouts.length}건:
          ${m.ambiguousPayouts.slice(0, 3).map(a => `${esc(a.date)} ${won(a.amount)}(${esc(a.reason)})`).join(" · ")}</p>` : ""}
        ${m.overPaid.length ? `<p class="pp-note pp-warn">⚠ 발주 금액보다 많은 출금이 걸린 건 ${m.overPaid.length}건 - 초과분은 차감하지 않았어요.</p>` : ""}
      </div>
      <div class="pp-rows">${m.rows.map(rowHtml).join("")}</div>
      <p class="pp-note">통장 출금에 발주번호·매입 번호가 적혀 있지 않으면 지급으로 차감하지 않아요(지금 확인 안 된 출금 ${fmt(m.unverifiedPayouts)}건).
        실제 송금·발주 전송·입고 신청은 이 화면에서 하지 않습니다.</p>
    </div>`;
  }

  /** 화면에서 쓰는 로더 - 읽기 전용 조회만 해요 */
  async function load(sb, { today } = {}) {
    const [pos, items, purchases, products, plans, txns, inbounds, freights, settings] = await Promise.all([
      sb.from("purchase_orders").select("*").order("date", { ascending: false }),
      sb.from("purchase_order_items").select("*"),
      sb.from("purchases").select("*").gte("date", "2026-09-01"),
      sb.from("products").select("id,code,name,tax_type"),
      sb.from("cash_plans").select("*"),
      sb.from("cash_txns").select("*").gte("date", "2026-09-01"),
      sb.from("inbound_plans").select("id,purchase_order_id,preflight_status,last_error_code,last_error_message,rejection_code,rejection_reason,submit_status,recovery_status,resubmission_of_plan_id,retry_of_plan_id"),
      sb.from("inbound_freight_costs").select("*"),
      sb.from("settings").select("value").eq("key", "vat").maybeSingle(),
    ]);
    const err = [pos, items, purchases, products, plans, txns, inbounds, freights].find(r => r && r.error);
    if (err) return { error: err.error.message };
    const prod = Object.fromEntries((products.data || []).map(p => [p.id, p]));
    const name = x => { const p = prod[x.product_id]; return p ? `${p.name}` : (x.option_name || ""); };
    const withName = rows => (rows || []).map(x => ({ ...x, _name: name(x) }));
    let vat = (settings && settings.data && settings.data.value) || {};
    if (typeof vat === "string") { try { vat = JSON.parse(vat); } catch (e) { vat = {}; } }
    return model({ pos: pos.data || [], items: withName(items.data), purchases: withName(purchases.data),
                   products: products.data || [], plans: plans.data || [], txns: txns.data || [],
                   inbounds: inbounds.data || [], freights: freights.data || [], vat,
                   today: today || new Date().toISOString().slice(0, 10) });
  }

  global.PurchasePayments = { nextTwentieth, payableOf, inboundStateOf, matchedPayments, model, cardHtml, load, nextTodo };
})(typeof window !== "undefined" ? window : globalThis);
