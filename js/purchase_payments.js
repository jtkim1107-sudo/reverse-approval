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

  /** 입고 상태 - 수량(발주 대비 입고)과 입고 신청 오류를 따로 봐요(둘은 다른 사실)
   *  po: 대체 신청 증거를 보기 위한 발주(선택) - wing_direct_shipment_id 등 */
  function inboundStateOf(items, plans, po) {
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
    const reasonOf = p => p.last_error_message || p.rejection_reason || p.rejection_code || p.last_error_code || "입고 신청 오류";
    const state = ordered <= 0 ? "UNKNOWN" : got <= 0 ? "NONE" : got < ordered ? "PARTIAL" : "DONE";
    // 사람이 반려한 건(rejection_code)과 시스템 오류를 말로 구분해요 - 할 일이 다릅니다.
    const kindOf = p => (p.rejection_code ? "반려" : "오류");

    // 수량은 다 입고됐는데 신청 기록만 오류로 남은 경우 - '다른 신청으로 받았다'는 증거가 있으면 이력,
    //   없으면 '확인 필요'(현재 오류로 단정하지 않아요). 2026-10-22 발주-2026-018 사례.
    const observed = (items || []).reduce((s2, i) => s2 + num(i.wing_observed_received_qty), 0);
    const altPlan = p => plans.some(q => q.id !== p.id
      && (["SUBMITTED", "SUBMIT_SUCCEEDED", "OK"].includes(String(q.submit_status || "").toUpperCase())
          || DONE_STATUS.includes(String(q.internal_status || "").toUpperCase())));
    const altEvidence = [];
    if (po && po.wing_direct_shipment_id) altEvidence.push(`WING 직접입고 ${po.wing_direct_shipment_id} 연결`);
    if (ordered > 0 && observed >= ordered) altEvidence.push(`WING 관측 입고 수량 ${fmt(observed)}/${fmt(ordered)}`);
    const doneByOther = p => state === "DONE" && (altEvidence.length > 0 || altPlan(p));

    const past = errs.filter(p => resolved(p) || doneByOther(p));
    const rest = errs.filter(p => !past.includes(p));
    // 수량은 다 찼는데 증거가 없으면 '확인 필요'
    const check = rest.filter(() => state === "DONE");
    const open = rest.filter(p => !check.includes(p));
    return { ordered, got, remain: Math.max(ordered - got, 0), state, plans: live.length, observed,
             errors: open.length, errorReason: open.length ? reasonOf(open[0]) : "",
             errorKind: open.length ? kindOf(open[0]) : "",
             checks: check.length, checkReason: check.length ? reasonOf(check[0]) : "",
             pastErrors: past.length, pastReasons: past.map(reasonOf).slice(0, 3),
             pastEvidence: altEvidence };
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
                   inbounds = [], freights = [], wingInbounds = [], vat = {}, today = "",
                   start = "2026-09-01" } = {}) {
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
      if (ymd(p.date) < start) return;
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
      const purchased = purchases.filter(p => p.po_id === po.id).reduce((s, p) => s + payableOf(p.amount, prodById[p.product_id], vat), 0);
      const remain = orderedPayable - purchased;
      if (remain <= 0) return;                       // 매입이 발주액을 다 채웠으면 예상 줄이 필요 없어요
      const month = ymd(po.date).slice(0, 7);
      const received = its.reduce((a, i) => a + num(i.received_qty), 0);
      const observed = its.reduce((a, i) => a + num(i.wing_observed_received_qty), 0);
      // 보류(결재 대기·검토 초안)라도 '실제로 들어온 증거' 가 있으면 빠뜨리지 않고 예상에 넣어요(근거를 적어서).
      const evidence = received > 0 || observed > 0 || !!po.wing_direct_shipment_id;
      const hold = HOLD.includes(po.status) && !evidence;
      const holdReleased = HOLD.includes(po.status) && evidence;
      const partial = purchased > 0;
      groups.set(`${month}:${po.id}:EST`, {
        key: `${month}:${po.id}:EST`, month, poId: po.id, basis: "ORDER", purchases: [], firstDate: ymd(po.date),
        supplier: po.supplier || "", goods: remain, hold, holdReleased, partialOfPurchased: partial,
        evidenceNote: holdReleased ? `입고 근거 있음(입고 ${fmt(received)} · WING 관측 ${fmt(observed)}${po.wing_direct_shipment_id ? ` · 직접입고 ${po.wing_direct_shipment_id}` : ""})` : "",
        orderedPayable, purchasedPayable: purchased,
        qty: partial ? 0 : its.reduce((s, i) => s + num(i.qty), 0),
      });
    });

    const rows = [...groups.values()].map(g => {
      const po = poById[g.poId] || null;
      const its = po ? (itemsByPo[po.id] || []) : [];
      const inb = inboundStateOf(its, po ? (inboundByPo[po.id] || []) : [], po);
      const frs = po ? (freightByPo[po.id] || []) : [];
      // 운반비는 발주마다 한 번만 - 그 발주의 가장 이른 묶음에만 붙여요(달이 나뉘어도 두 번 더하지 않게)
      const firstOfPo = [...groups.values()].filter(x => x.poId === g.poId).sort((a, b) => a.month.localeCompare(b.month))[0];
      const ownsFreight = firstOfPo && firstOfPo.key === g.key;
      const actual = frs.filter(f => f.basis === "ACTUAL" && !["SUPERSEDED", "VOID_PENDING_REBUILD", "VOID", "CANCELED"].includes(f.status));
      const freight = { records: frs.length, confirmed: actual.length > 0, owns: !!ownsFreight,
                        amount: ownsFreight ? actual.reduce((s, f) => s + num(f.gross_amount ?? f.gross), 0) : 0,
                        estimate: po ? num(po.freight_est) : 0 };
      const purchaseIds = g.purchases.map(p => p.id);
      // 등록 경로 - ERP 발주서로 시작했는지, 쿠팡에 먼저 입고 신청하고 ERP 에 등록했는지(같은 매입 업무, 순서만 다름)
      const direct = !!(po && (po.wing_direct_shipment_id || String(po.po_no || "").includes("WING검토")));
      const route = !po ? "발주서 없이 매입 입력" : direct ? "쿠팡 직접입고 → ERP 등록" : "ERP 발주서 → 입고";
      // 재신청·이동처럼 '원매입과 묶어야 할 수 있는' 매입은 사람이 확인하도록 표시해요(임의로 합치거나 빼지 않아요)
      const linkWords = [["재신청", "재신청"], ["재시도", "재시도"], ["이동", "재고 이동"], ["대체", "대체 신청"]];
      const linkNotes = [...new Set(g.purchases.flatMap(x => linkWords
        .filter(([w]) => String(x.memo || "").includes(w)).map(([, label]) => label)))];
      const payDate = nextTwentieth(g.firstDate);
      const plan = (plans || []).find(p => String(p.memo || "").includes(`AUTO_PURCHASE_TERMS=${g.key}`)) || null;
      const base = g.goods + (freight.confirmed ? freight.amount : 0);
      const orderMonth = po ? ymd(po.date).slice(0, 7) : g.month;
      return { ...g, po, items: its, inbound: inb, freight, plan, payDate, base, purchaseIds, route, direct, linkNotes,
               matchKeys: [po && po.po_no].filter(Boolean).concat(purchaseIds),
               orderMonth, basisNote: orderMonth !== g.month ? `매입월 ${g.month} 기준 · 발주 ${orderMonth}` : "",
               outstandingBasis: freight.confirmed ? "상품대금 + 확정 운반비" : "상품대금 기준(운반비 미확정)" };
    }).sort((a, b) => (a.payDate.localeCompare(b.payDate) || String(b.firstDate).localeCompare(String(a.firstDate))));

    // ① 쿠팡 원천에서 출발한 역대조 - 실제 입고됐는데 ERP 매입·발주에 없는 건을 찾아요.
    //    금액은 단가 근거가 없어 잡지 않아요(0원으로 확정하지 않습니다 - 수량·상태만 알려 줘요).
    const shipToPo = {};
    pos.forEach(po => { if (po.wing_direct_shipment_id) shipToPo[String(po.wing_direct_shipment_id)] = po; });
    const memoHas = (key, productId) => purchases.some(x => x.product_id === productId && key && String(x.memo || "").includes(key));
    const sourceGaps = [];
    (wingInbounds || []).forEach(w => {
      const stamp = w.wing_created_at || w.expected_date || w.created_at;
      const when = stamp && String(stamp).includes("T")
        ? new Date(new Date(stamp).getTime() + 9 * 3600000).toISOString().slice(0, 10) : ymd(stamp);
      if (!when || when < (start || "")) return;
      const st = String(w.wing_status || "").toUpperCase();
      const req = String(w.wing_request_id || ""), inb = String(w.wing_inbound_id || "");
      const po = shipToPo[req] || shipToPo[inb] || null;
      const linkedPurchase = memoHas(req, w.product_id) || memoHas(inb, w.product_id) || (po && purchases.some(x => x.po_id === po.id && x.product_id === w.product_id));
      const got = num(w.received_qty) || num(w.stowed_qty);
      if (st.includes("CANCEL")) return;                       // 취소 신청은 매입이 아니에요
      if (linkedPurchase) return;                              // 매입 원장에 이미 잡혀 있어요
      if (po && !["canceled", "rejected"].includes(po.status)) return;   // 살아 있는 발주로 이미 집계돼요
      const kind = got > 0
        ? (po ? "취소·반려 발주인데 실제 입고됨" : "매입·발주 없이 실제 입고됨")
        : "신청만 있고 아직 입고 없음";
      // 증명 가능한 연결: 이 입고번호로 연결된 발주서에 같은 상품 품목이 있고 단가가 적혀 있을 때만.
      //   (상품·수량이 같다는 이유만으로 다른 발주에 붙이지 않아요. 상품 마스터 원가도 쓰지 않습니다.)
      const poItem = po ? (items || []).find(i => i.po_id === po.id && i.product_id === w.product_id && num(i.unit_cost) > 0) : null;
      const provable = !!(poItem && got > 0);
      const confirmedQty = Number((String(poItem?.memo || "").match(/PAYMENT_CONFIRMED_QTY=(\d+)/) || [])[1] || 0);
      const payableQty = provable && confirmedQty > 0 && confirmedQty <= num(poItem.qty) ? Math.max(got, confirmedQty) : got;
      const qtyMismatch = provable && num(poItem.qty) !== num(w.requested_qty);
      // 단가 '근거' 만 모아요 - 상품 마스터 원가(판매 원가)를 매입 단가로 대입하지 않습니다.
      const unitFromOrders = [...new Set((items || []).filter(i => i.product_id === w.product_id && num(i.unit_cost) > 0)
        .map(i => num(i.unit_cost)))];
      const unitFromPurchases = [...new Set(purchases.filter(x => x.product_id === w.product_id && num(x.unit_cost) > 0)
        .map(x => num(x.unit_cost)))];
      sourceGaps.push({ date: when, product: (prodById[w.product_id] || {}).code || w.vendor_item_id,
                        name: (prodById[w.product_id] || {}).name || "",
                        requested: num(w.requested_qty), received: got, payableQty, status: st, kind,
                        request: req, inbound: inb, po: po ? po.po_no : null,
                        payMonth: got > 0 ? nextTwentieth(when) : null,
                        unitEvidence: [...new Set(unitFromOrders.concat(unitFromPurchases))],
                        included: provable, provable, qtyMismatch,
                        unit: poItem ? num(poItem.unit_cost) : null,
                        amount: provable ? payableOf(payableQty * num(poItem.unit_cost), prodById[w.product_id], vat) : null,
                        evidence: provable
                          ? `발주서 ${po.po_no} 품목 단가 ${fmt(poItem.unit_cost)}원 · 이 입고번호로 연결된 발주서${qtyMismatch ? ` · 발주 ${fmt(poItem.qty)} ≠ 신청 ${fmt(w.requested_qty)}(수량 확인 필요)` : ""}`
                          : "단가·귀속 근거가 확정되지 않았어요",
                        note: provable ? "발주서 단가로 금액을 잡았고 '원천 입고(매입 미등록)' 로 합계에 넣었어요"
                          : "금액은 단가 근거가 확정되지 않아 잡지 않았어요(0원 확정 아님)" });
    });
    const sourceSummary = {
      total: sourceGaps.length,
      received: sourceGaps.filter(g => g.received > 0).length,
      receivedQty: sourceGaps.filter(g => g.received > 0).reduce((a, g) => a + g.received, 0),
      pending: sourceGaps.filter(g => g.received <= 0).length,
    };

    // 증명된 건은 줄로 더해 합계·대조표·자금일보에 같은 방식으로 흐르게 해요(매입 원장은 만들지 않아요).
    sourceGaps.filter(g => g.provable).forEach(g => {
      const po = pos.find(x => x.po_no === g.po) || null;
      rows.push({ key: `src:${g.inbound}:${g.product}`, month: g.date.slice(0, 7), poId: po ? po.id : `src:${g.inbound}`,
        basis: "ORDER", fromSource: true, purchases: [], firstDate: g.date, supplier: (po && po.supplier) || "",
        goods: g.amount, qty: g.payableQty, hold: false, po, items: [{ _name: g.name, qty: g.payableQty, unit_cost: g.unit, amount: g.payableQty * g.unit }], route: "쿠팡 직접입고 → ERP 미등록",
        inbound: { ordered: g.requested, got: g.received, remain: Math.max(g.requested - g.received, 0), state: g.received < g.requested ? "PARTIAL" : "DONE", plans: 0, observed: g.received,
                   errors: 0, errorReason: "", errorKind: "", checks: 0, checkReason: "", pastErrors: 0,
                   pastReasons: [], pastEvidence: [g.evidence] },
        freight: { records: 0, confirmed: false, owns: true, amount: 0, estimate: 0 },
        plan: null, payDate: g.payMonth, base: g.amount, purchaseIds: [], matchKeys: [g.inbound, g.request].filter(Boolean),
        orderMonth: g.date.slice(0, 7), basisNote: `신청 ${g.date} · 지급대상 ${fmt(g.payableQty)}개 / 입고 ${fmt(g.received)}개 · 매입 원장 미등록`,
        linkNotes: g.qtyMismatch ? ["수량 확인"] : [], evidenceNote: g.evidence,
        outstandingBasis: "상품대금 기준(운반비 미확정)" });
    });

    // 출금 배분(중복 차감 금지) → 줄마다 확인된 기지급·미지급 잔액·지급 상태
    const alloc = allocatePayments(txns, rows);
    rows.forEach(r => {
      const got = alloc.byKey.get(r.key) || { amount: 0, txns: [] };
      r.paid = got.txns;
      r.paidPast = got.txns.filter(t => ymd(t.date) <= today).reduce((a, t) => a + num(t.amount), 0);
      r.paidFuture = got.txns.filter(t => ymd(t.date) > today).reduce((a, t) => a + num(t.amount), 0);
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
      note: "자금일보 예정출금(확정)은 매입 입력된 상품대금만 잡아요. 자금일보에도 같은 예상·운반비·기지급을 같은 계산으로 함께 보여 줍니다.",
    };
    // 자금일보가 그대로 쓰는 '예상 출금'(매입 전 발주) - cash_plans 에 이미 있는 확정분과 겹치지 않아요.
    //   같은 발주가 매입 입력되면 그 금액만큼 예상이 줄고 확정(cash_plans)으로 옮겨 가 이중 합산이 되지 않습니다.
    const planKeys = new Set(auto.map(p => (String(p.memo || "").match(/AUTO_PURCHASE_TERMS=([^\s|]+)/) || [])[1]).filter(Boolean));
    const estimatedPlans = rows.filter(r => r.basis === "ORDER" && !r.hold && r.goods > 0 && !planKeys.has(r.key))
      .map(r => ({ date: r.payDate, occDate: r.payDate, kind: "출금", amount: r.goods, estimate: true, key: r.key,
                   poNo: r.po && r.po.po_no, supplier: r.supplier,
                   title: `${r.supplier} ${r.month} 발주 예상 매입대금 (${(r.po && r.po.po_no) || ""})`,
                   note: "매입 입력 전이라 예상이에요 - 매입을 넣으면 확정 예정출금으로 바뀌어요" }));
    // 날짜별 대조표(확정/예상/운반비/기지급/잔액) - 발주 화면과 자금일보가 같은 숫자를 쓰도록
    const byDate = {};
    rows.forEach(r => {
      if (r.hold) return;
      const d = byDate[r.payDate] || (byDate[r.payDate] = { date: r.payDate, confirmed: 0, estimated: 0,
                                                           freightConfirmed: 0, paid: 0, paidFuture: 0,
                                                           outstanding: 0, cash: 0 });
      d[r.basis === "PURCHASE" ? "confirmed" : "estimated"] += r.goods;
      d.freightConfirmed += r.freight.confirmed ? r.freight.amount : 0;
      d.paid += r.paidAmount;
      d.paidFuture += Math.min(r.paidFuture, r.paidAmount);
      d.outstanding += r.outstanding;
    });
    auto.forEach(p => {
      const d = byDate[ymd(p.date)] || (byDate[ymd(p.date)] = { date: ymd(p.date), confirmed: 0, estimated: 0,
                                                                freightConfirmed: 0, paid: 0, paidFuture: 0,
                                                                outstanding: 0, cash: 0 });
      d.cash += num(p.amount);
    });
    const schedule = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
      .map(d => ({ ...d, match: Math.abs(d.confirmed - d.cash) <= 1, overdue: d.date < today }));
    // 지급일이 지났는데 통장에서 확인이 안 된 금액 - 미래 예측에는 안 들어가니 '이월 미지급' 으로 따로 보여 줘요.
    const carryRows = schedule.filter(d => d.overdue && d.outstanding > 0);
    const carry = { total: carryRows.reduce((a, d) => a + d.outstanding, 0), count: carryRows.length,
                    dates: carryRows.map(d => ({ date: d.date, amount: d.outstanding, cash: d.cash, confirmed: d.confirmed })) };

    const matchedIds = new Set(rows.flatMap(r => r.paid.map(t => t.id)));
    const ambiguousIds = new Set(alloc.ambiguous.map(a => a.id));
    const unverified = (txns || []).filter(t => t.kind === "출금" && ymd(t.date) >= "2026-09-01"
      && !matchedIds.has(t.id)).length;
    return { rows, due, reconcile, schedule, carry, estimatedPlans, sourceGaps, sourceSummary, unverifiedPayouts: unverified, ambiguousPayouts: alloc.ambiguous,
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
      ? badge("error", `입고 ${r.inbound.errorKind || "오류"}`, `${r.inbound.errorReason}${r.inbound.state === "DONE"
          ? " (입고 수량은 다 채워졌지만 이 입고 신청은 아직 정리되지 않았어요)" : ""}`) : "";
    const checkBadge = r.inbound.checks
      ? badge("pending", "입고 확인 필요", `수량은 다 입고됐는데 이 신청 기록이 오류로 남아 있어요(대체 신청 증거 없음): ${r.inbound.checkReason}`) : "";
    const pastBadge = !r.inbound.errors && !r.inbound.checks && r.inbound.pastErrors
      ? badge("muted", `지난 입고 오류 ${r.inbound.pastErrors}건`,
              `끝난 오류예요: ${r.inbound.pastReasons.join(" / ")}${r.inbound.pastEvidence.length
                ? ` · 근거 ${r.inbound.pastEvidence.join(" · ")}` : " · 재신청·재시도로 대체됨"}`) : "";
    const payBadge = { SCHEDULED: ["info", "지급 예정"], OVERDUE: ["pending", "지급 확인 필요"],
                       PARTIAL: ["pending", "일부 지급"], PAID: ["ok", "지급 완료"],
                       NOT_PURCHASED: ["info", "지급 예상(매입 전)"], HOLD: ["muted", "지급 보류"] }[r.payState];
    return `<div class="pp-states">${orderBadge}${inBadge}${errBadge}${checkBadge}${pastBadge}${badge(payBadge[0], payBadge[1], "통장 매칭이 확인된 지급만 차감해요")}</div>`;
  }

  function nextTodo(r) {
    if (r.po && r.po.status === "progress") return "결재 올린 발주서를 승인·반려 처리";
    if (r.po && r.po.status === "wing_direct_review") return "WING 직접입고 검토 초안을 정식 발주로 전환하거나 취소";
    if (r.inbound.errors) return `입고 신청 ${r.inbound.errorKind || "오류"} 확인: ${r.inbound.errorReason}`;
    if (r.inbound.checks) return `입고는 끝났는데 신청 기록이 오류로 남아 있어요 - 어느 신청으로 받았는지 확인: ${r.inbound.checkReason}`;
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
          <b>${esc(r.supplier || "거래처 확인 필요")}</b>${r.direct ? ` ${badge("info", "직접입고", "쿠팡에 먼저 입고 신청하고 ERP 에 등록한 건이에요")}` : ""}${(r.linkNotes || []).length ? ` ${badge("pending", "연결 확인", r.linkNotes.join(" · "))}` : ""}
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
          <div><span>등록 경로</span><b>${esc(r.route)}${r.evidenceNote ? ` <small>· ${esc(r.evidenceNote)}</small>` : ""}</b></div>
          ${r.linkNotes && r.linkNotes.length ? `<div><span>연결 확인 필요</span><b class="pp-warn">${esc(r.linkNotes.join(" · "))}
            <small>원매입과 묶어야 하는 건지 확인해 주세요 - 자동으로 합치거나 빼지 않았어요</small></b></div>` : ""}
          <div><span>지급 예정일</span><b>${esc(r.payDate)} <small>${r.basis === "ORDER"
            ? `발주월 ${esc(r.month)} 기준 예상 - 매입 입력하면 매입월 기준으로 확정돼요`
            : `매입월 ${esc(r.month)} 다음 달 20일`}</small></b></div>
          <div><span>상품대금</span><b>${won(r.goods)} <small>VAT 포함</small></b></div>
          <div><span>운반비</span><b>${r.freight.confirmed ? `${won(r.freight.amount)} <small>실제 청구 · 한 번만 반영</small>`
            : r.freight.records ? `<span class="pp-warn">미확정</span> <small>예상 ${won(r.freight.estimate)} · 잔액에 넣지 않았어요</small>`
            : `<small>기록 없음</small>`}</b></div>
          <div><span>확인된 기지급</span><b>${r.paidAmount ? won(r.paidAmount) : `<small>없음 · 통장에 이 발주가 적힌 출금만 차감해요</small>`}</b></div>
          <div><span>미지급 잔액</span><b>${won(r.outstanding)} <small>${esc(r.outstandingBasis)}</small></b></div>
          <div><span>입고</span><b>${fmt(r.inbound.got)} / ${fmt(r.inbound.ordered)}${r.inbound.errors ? ` · <span class="pp-warn">지금 오류 ${r.inbound.errors}건</span>` : ""}${r.inbound.checks
            ? ` · <span class="pp-warn">확인 필요 ${r.inbound.checks}건</span>` : ""}${r.inbound.pastEvidence.length
            ? ` <small>· 대체 신청 근거: ${esc(r.inbound.pastEvidence.join(" · "))}</small>` : ""}${r.inbound.pastErrors
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
        <p class="pp-note">${esc(d.date)} 기준 <b>미지급(확정 전)</b>: 상품대금 ${won(d.confirmed.total)}(확정)
          ${d.estimated.total ? `＋ ${won(d.estimated.total)}(예상 · 매입 전)` : ""}
          ${d.freightConfirmed ? `＋ 확정 운반비 ${won(d.freightConfirmed)}` : "＋ 운반비 미확정(더하지 않음)"}
          ${d.paid ? `－ 확인된 지급 ${won(d.paid)}` : "－ 확인된 지급 없음(지급 확인 필요)"} ＝ <b>${won(d.outstanding)}</b>.
          실제 나갈 금액은 매입 입력·운반비 청구·통장 대사로 바뀔 수 있어요. ${esc(m.reconcile.note)}</p>
        ${d.hold.count ? `<p class="pp-note">보류 ${d.hold.count}건은 합계에서 뺐어요: ${d.hold.items.map(h =>
          `${esc(h.po || "")} ${won(h.amount)}(${esc(h.reason)})`).join(" · ")}</p>` : ""}
        ${m.carry && m.carry.count ? `<p class="pp-note pp-warn">⚠ 지급일이 지났는데 통장 확인이 안 된 <b>이월 미지급 ${won(m.carry.total)}</b>
          (${m.carry.dates.map(x => `${esc(x.date)} ${won(x.amount)}`).join(" · ")}).
          자금일보 미래 예측에는 들어가지 않는 금액이에요 - 예상 잔액에서 이미 빠진 돈이 아니니 <b>가용잔액으로 보면 안 돼요.</b>
          지급 여부를 통장에서 확인해 주세요(확인된 미지급이 아니라 '지급 미확인' 입니다).</p>` : ""}
        ${m.ambiguousPayouts.length ? `<p class="pp-note pp-warn">⚠ 어느 발주 지급인지 하나로 정해지지 않아 차감하지 않은 출금 ${m.ambiguousPayouts.length}건:
          ${m.ambiguousPayouts.slice(0, 3).map(a => `${esc(a.date)} ${won(a.amount)}(${esc(a.reason)})`).join(" · ")}</p>` : ""}
        ${m.overPaid.length ? `<p class="pp-note pp-warn">⚠ 발주 금액보다 많은 출금이 걸린 건 ${m.overPaid.length}건 - 초과분은 차감하지 않았어요.</p>` : ""}
      </div>
      <div class="pp-rows">${m.rows.map(rowHtml).join("")}</div>
      ${m.sourceSummary && m.sourceSummary.total ? `<div class="pp-recon">
        <p class="pp-note pp-warn">⚠ 쿠팡 원천 대조: 실제 입고·신청인데 ERP 매입·발주에 없는 건 ${fmt(m.sourceSummary.total)}건
          (이미 입고된 것 ${fmt(m.sourceSummary.received)}건 · 수량 ${fmt(m.sourceSummary.receivedQty)}개).
          단가 근거가 확정되지 않아 금액은 잡지 않았어요 - <b>0원 확정이 아닙니다.</b>
          그래서 위 지급 예정 합계는 <b>현재 연결분만의 잠정액</b>이에요.</p>
        <details class="pp-row"><summary><div class="pp-main"><b>원천에 있는데 ERP 에 없는 입고</b>
          <span class="pp-sub">쿠팡 직접입고 기록에서 출발해 역으로 맞춰 본 결과예요</span></div></summary>
          <div class="pp-detail"><table class="pp-items"><thead><tr><th>신청일</th><th>상품</th><th class="num">신청</th>
            <th class="num">입고</th><th>상태</th><th>분류 · 지급월 후보 · 단가 근거</th></tr></thead><tbody>
            ${m.sourceGaps.map(g => `<tr><td>${esc(g.date)}</td><td>${esc(g.product || "")}<small class="pp-sub">${esc(String(g.name).slice(0, 18))}</small></td>
              <td class="num">${fmt(g.requested)}</td><td class="num">${fmt(g.received)}</td>
              <td>${esc(g.status)}</td><td>${esc(g.kind)}${g.po ? ` <small>(${esc(g.po)})</small>` : ""}
                <small class="pp-sub">${g.payMonth ? `지급월 후보 ${esc(g.payMonth)} · ` : ""}단가 근거 ${g.unitEvidence.length
                  ? g.unitEvidence.map(won).join(" / ") : "없음"} · 금액 미포함</small></td></tr>`).join("")}
          </tbody></table>
          <p class="pp-note">신청번호·입고번호로 매입 원장·발주를 찾아본 결과입니다. <b>이 금액은 위 합계에 들어 있지 않아요</b> -
            지금 합계는 '연결된 것만' 의 잠정액입니다. 단가 근거가 여럿이거나 없으면 추정하지 않았어요.
            상품 마스터 원가(판매 원가)는 매입 단가로 쓰지 않습니다.</p></div>
        </details></div>` : `<p class="pp-note">✓ 쿠팡 직접입고 원천과 ERP 매입·발주가 모두 연결돼 있어요(누락 0건).</p>`}
      <p class="pp-note">통장 출금에 발주번호·매입 번호가 적혀 있지 않으면 지급으로 차감하지 않아요(지금 확인 안 된 출금 ${fmt(m.unverifiedPayouts)}건).
        실제 송금·발주 전송·입고 신청은 이 화면에서 하지 않습니다.</p>
    </div>`;
  }

  /**
   * 자금일보가 cash_plans(확정 예정출금) 위에 더해야 할 조정 항목 - 두 화면이 같은 잔액을 쓰게 해요.
   *   날짜별: 예상(매입 전) ＋ 확정 운반비 ＋ 예정출금 미생성분 － 확인된 기지급
   *   = 그 날짜의 '미지급(확정 전)'. cash_plans 금액은 그대로 두고 차이만 항목으로 보여 줘 이중 계상이 없어요.
   */
  function cashAdjustments(m, { from = "", to = "" } = {}) {
    if (!m || !m.schedule) return [];
    const out = [];
    m.schedule.forEach(d => {
      if ((from && d.date < from) || (to && d.date > to)) return;
      const items = [];
      m.rows.filter(r => r.payDate === d.date && r.basis === "ORDER" && !r.hold && r.goods > 0 && !(r.plan && r.plan.id))
        .forEach(r => items.push({ date: d.date, occDate: d.date, kind: "출금", amount: r.goods, estimate: true,
          type: "ESTIMATE", key: r.key, poNo: r.po && r.po.po_no, supplier: r.supplier,
          title: `${r.supplier} ${r.month} 발주 예상 매입대금 (${(r.po && r.po.po_no) || ""})`,
          note: "매입 입력 전이라 예상이에요 - 매입을 넣으면 확정 예정출금으로 바뀌어요" }));
      if (d.freightConfirmed > 0) items.push({ date: d.date, occDate: d.date, kind: "출금", amount: d.freightConfirmed,
        estimate: true, type: "FREIGHT", title: `입고 운반비(실제 청구) ${d.date} 지급분`,
        note: "확정된 운반비예요 - 매입대금 예정출금에는 들어 있지 않아 따로 더해요" });
      // 남은 차이를 '한 줄' 로 맞춰요 - cash_plans 가 총액이든 이미 깎인 순액이든 결과가 같아요(이중 차감 없음).
      //   미래 날짜로 확인된 지급은 아직 통장에서 안 나갔으니 예측에서는 그대로 나갈 돈으로 둡니다.
      const target = d.outstanding + (d.paidFuture || 0);
      const emitted = items.reduce((a, x) => a + x.amount, 0);
      const diff = Math.round(target - d.cash - emitted);
      if (Math.abs(diff) > 0.5) {
        const why = [];
        if (d.confirmed > d.cash) why.push("예정출금 미생성분");
        if (d.paid - (d.paidFuture || 0) > 0) why.push("통장에서 확인된 지급 차감");
        items.push({ date: d.date, occDate: d.date, kind: "출금", amount: diff, estimate: true, type: "RECONCILE",
          title: `${diff < 0 ? "예정출금 감액" : "예정출금 보정"} ${d.date}`,
          note: `${why.join(" · ") || "자금일보 예정출금과 발주 화면 미지급의 차이"} - 이 화면에서 cash_plans 를 만들거나 고치지 않아요`
        });
      }
      out.push(...items);
    });
    return out;
  }

  /** 화면에서 쓰는 로더 - 읽기 전용 조회만 해요 */
  async function load(sb, { today } = {}) {
    const [pos, items, purchases, products, plans, txns, inbounds, freights, wingInbounds, settings] = await Promise.all([
      sb.from("purchase_orders").select("*").order("date", { ascending: false }),
      sb.from("purchase_order_items").select("*"),
      sb.from("purchases").select("*"),
      sb.from("products").select("id,code,name,tax_type"),
      sb.from("cash_plans").select("*"),
      sb.from("cash_txns").select("*").gte("date", "2026-09-01"),
      sb.from("inbound_plans").select("id,purchase_order_id,internal_status,preflight_status,last_error_code,last_error_message,rejection_code,rejection_reason,submit_status,recovery_status,resubmission_of_plan_id,retry_of_plan_id"),
      sb.from("inbound_freight_costs").select("*"),
      sb.from("wing_direct_inbounds").select("*").order("wing_created_at", { ascending: false }),
      sb.from("settings").select("value").eq("key", "vat").maybeSingle(),
    ]);
    const err = [pos, items, purchases, products, plans, txns, inbounds, freights, wingInbounds, settings].find(r => r && r.error);
    const wingRows = wingInbounds && !wingInbounds.error ? (wingInbounds.data || []) : [];
    if (err) return { error: err.error.message };
    const prod = Object.fromEntries((products.data || []).map(p => [p.id, p]));
    const name = x => { const p = prod[x.product_id]; return p ? `${p.name}` : (x.option_name || ""); };
    const withName = rows => (rows || []).map(x => ({ ...x, _name: name(x) }));
    let vat = (settings && settings.data && settings.data.value) || {};
    if (typeof vat === "string") { try { vat = JSON.parse(vat); } catch (e) { vat = {}; } }
    return model({ pos: pos.data || [], items: withName(items.data), purchases: withName(purchases.data),
                   products: products.data || [], plans: plans.data || [], txns: txns.data || [],
                   inbounds: inbounds.data || [], freights: freights.data || [], wingInbounds: wingRows, vat,
                   today: today || new Date().toISOString().slice(0, 10) });
  }

  global.PurchasePayments = { nextTwentieth, payableOf, inboundStateOf, matchedPayments, allocatePayments,
                              model, cardHtml, load, nextTodo, cashAdjustments };
})(typeof window !== "undefined" ? window : globalThis);
