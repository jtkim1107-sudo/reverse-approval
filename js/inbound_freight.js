/* inbound_freight.js
 * -------------------------------------------------------------------------
 * 2026-09-11 입고 트럭 운송비 → 공헌이익 (사용자 확정 기준)
 *
 *   · 운송비 기록은 운송 묶음(트럭 1대)마다 1건(inbound_freight_costs) - 같은 묶음 운송비를 두 번 세지 않아요.
 *   · 공헌이익에는 공급가액만 씁니다. 매입 VAT 는 부가세 화면으로만 가요.
 *   · 상품별 배분(inbound_freight_allocations)은 PLT 비율 · 원 단위 · 마지막 행이 차이 흡수(DB 가 합계 검사).
 *     단위당 배부액은 소수 정밀도 그대로 계산하고 화면에서만 반올림해요.
 *   · 시점
 *       - 입고 전(WING 초안·승인 단계): 예상 원가로만 보여주고 공헌이익에서 빼지 않아요.
 *       - 입고 완료(매입 purchases 기록, 입고처 쿠팡): 그 수량의 재고원가에 운송비를 얹어요.
 *       - 그 뒤 실제 판매된 수량만큼만 공헌이익에서 빼요(쿠팡 재고 선입선출 - 먼저 들어온 재고부터 팔린 것으로).
 *       - 안 팔린 재고의 운송비는 재고원가로 남아요.
 *       - 실제 운송업체 청구금액이 등록되면 같은 기록이 ACTUAL 로 바뀌어 단위당 금액이 교체돼요(더하지 않음).
 *   · 기존 매출·광고비·상품원가 계산은 건드리지 않아요. 이 파일은 계산만 하고 쓰기는 없어요.
 */
(function (global) {
  "use strict";

  const byDateThenCreated = (a, b) =>
    String(a.date || "").localeCompare(String(b.date || "")) ||
    String(a.created_at || "").localeCompare(String(b.created_at || "")) ||
    String(a.id || "").localeCompare(String(b.id || ""));

  // 입력
  //   costs        inbound_freight_costs 행
  //   allocations  inbound_freight_allocations 행
  //   buys         purchases 행(입고 기록) · sales 매출 행(중복 제거 후) · transfers stock_transfers 행
  //   products     제품 마스터(연동 세트 환산용) · isCoupangSale(r) 쿠팡 재고에서 빠지는 판매인가(풀필먼트)
  //   today        'YYYY-MM-DD' - 그날까지 실제로 일어난 입출고만
  // 출력
  //   bySale   Map(saleId → { supply, units, basis })   공헌이익에서 뺄 입고 운송비(공급가액, 소수 그대로)
  //   records  기록별 상태·배분·판매/재고 내역(화면용)
  // 2026-09-11 기록 상태: ACTIVE 만 계산(공헌이익·재고원가·부가세). VOID_PENDING_REBUILD(무효·재작성 대기)·
  // SUPERSEDED(새 입고로 대체됨)는 이력(history)으로만 돌려줘요 - 같은 트럭 운송비를 두 번 세지 않게.
  // 2026-09-12 NEEDS_REVIEW(입고 취소 뒤 실제 운송비·청구서가 붙어 있어 자동 무효화하지 않음)도 계산에서 빼고 이력으로만.
  const isActive = c => (c.status || "ACTIVE") === "ACTIVE";
  const STATUS_LABEL = { VOID_PENDING_REBUILD: "무효 · 재작성 대기", SUPERSEDED: "대체됨", NEEDS_REVIEW: "검토 필요 · 실제 운송비 연결(입고 취소)" };

  function compute({ costs: allCosts = [], allocations = [], buys = [], sales = [], transfers = [],
                     products = [], isCoupangSale = () => true, today = "9999-12-31" } = {}) {
    const costs = allCosts.filter(isActive);
    const history = allCosts.filter(c => !isActive(c));
    const upTo = arr => arr.filter(x => String(x.date || "") <= today);
    const prodById = new Map(products.map(p => [p.id, p]));
    // 판매 1줄이 쿠팡 재고의 어느 기본 상품을 몇 개 줄이는지(연동 세트는 낱개 × 구성 수량)
    const unitsOf = s => {
      const p = prodById.get(s.product_id);
      if (p && p.set_parent_id && Number(p.set_qty) > 0) return { base: p.set_parent_id, units: Number(s.qty) * Number(p.set_qty) };
      return { base: s.product_id, units: Number(s.qty) };
    };

    const records = costs.map(c => {
      const allocs = allocations.filter(a => a.freight_cost_id === c.id)
        .sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
        .map(a => ({
          ...a,
          allocated_supply: Number(a.allocated_supply),
          qty: Number(a.qty), pallet_count: Number(a.pallet_count),
          // 소수 정밀도 그대로(DB 생성 컬럼과 같은 식). 화면에서만 반올림.
          perUnit: Number(a.allocated_supply) / Number(a.qty),
          receivedQty: 0, soldQty: 0, soldSupply: 0, soldByMonth: {}, receiptDates: [],
        }));
      const totalPlt = allocs.reduce((s, a) => s + a.pallet_count, 0);
      return {
        cost: c, allocs,
        basis: c.basis === "ACTUAL" ? "ACTUAL" : "ESTIMATE",
        gross: Number(c.gross_amount), supply: Number(c.supply_amount), vat: Number(c.vat_amount),
        estimate: c.estimate_gross != null
          ? { gross: Number(c.estimate_gross), supply: Number(c.estimate_supply), vat: Number(c.estimate_vat) } : null,
        totalPlt, ratio: allocs.map(a => a.pallet_count).join(":"),
      };
    });
    // (PO, 상품) → 배분 행. 같은 PO·상품이 두 기록에 걸리면 먼저 만든 기록만(운송비 두 번 방지).
    const allocKey = (po, pid) => `${po}|${pid}`;
    const allocByKey = new Map();
    for (const r of records) {
      for (const a of r.allocs) {
        const k = allocKey(r.cost.purchase_order_id, a.product_id);
        if (!allocByKey.has(k)) allocByKey.set(k, { rec: r, alloc: a });
      }
    }

    // 쿠팡 재고 로트: 입고처 '쿠팡' 매입 + 창고→쿠팡 이동. 운송비는 배분 수량까지만 로트에 얹어요.
    const lotsByBase = new Map();
    const pushLot = (base, lot) => { if (!lotsByBase.has(base)) lotsByBase.set(base, []); lotsByBase.get(base).push(lot); };
    const inflows = [
      ...upTo(buys).filter(b => b.warehouse === "쿠팡").map(b => ({ kind: "buy", row: b, date: b.date, created_at: b.created_at, id: b.id })),
      ...upTo(transfers).filter(t => t.kind === "쿠팡입고").map(t => ({ kind: "move", row: t, date: t.date, created_at: t.created_at, id: t.id })),
    ].sort(byDateThenCreated);
    for (const f of inflows) {
      const qty = Number(f.row.qty) || 0;
      if (qty <= 0) continue;
      let freightUnits = 0, link = null;
      if (f.kind === "buy" && f.row.po_id) {
        link = allocByKey.get(allocKey(f.row.po_id, f.row.product_id)) || null;
        if (link) {
          freightUnits = Math.max(0, Math.min(qty, link.alloc.qty - link.alloc.receivedQty));
          link.alloc.receivedQty += freightUnits;
          if (freightUnits > 0) link.alloc.receiptDates.push(f.row.date);
        }
      }
      pushLot(f.row.product_id, { date: f.row.date, remaining: qty, freightRemaining: freightUnits, link });
    }

    // 쿠팡 재고에서 빠지는 것: 풀필먼트 판매(공헌이익 차감) · 회수 이동(차감 없이 재고원가로 남음)
    const outflows = [
      ...upTo(sales).filter(s => Number(s.qty) > 0 && isCoupangSale(s)).map(s => ({ kind: "sale", row: s, date: s.date, created_at: s.created_at, id: s.id })),
      ...upTo(transfers).filter(t => t.kind && t.kind !== "쿠팡입고").map(t => ({ kind: "move", row: t, date: t.date, created_at: t.created_at, id: t.id })),
    ].sort(byDateThenCreated);
    const bySale = new Map();
    for (const o of outflows) {
      const { base, units } = o.kind === "sale" ? unitsOf(o.row) : { base: o.row.product_id, units: Number(o.row.qty) };
      let need = units;
      const lots = lotsByBase.get(base) || [];
      for (const lot of lots) {
        if (need <= 0) break;
        if (lot.remaining <= 0 || String(lot.date) > String(o.date)) continue;   // 판매일 이후 입고분은 쓸 수 없음
        const take = Math.min(need, lot.remaining);
        // 로트 안에서는 운송비가 얹힌 수량부터 소진(한 매입 행이 배분 수량보다 많을 때만 의미 있음)
        const freightTake = Math.min(take, lot.freightRemaining);
        lot.remaining -= take;
        lot.freightRemaining -= freightTake;
        need -= take;
        if (freightTake > 0 && o.kind === "sale") {
          const a = lot.link.alloc;
          const amt = freightTake * a.perUnit;
          a.soldQty += freightTake;
          a.soldSupply += amt;
          const m = String(o.date).slice(0, 7);
          a.soldByMonth[m] = (a.soldByMonth[m] || 0) + amt;
          const cur = bySale.get(o.row.id) || { supply: 0, units: 0, basis: lot.link.rec.basis };
          cur.supply += amt; cur.units += freightTake;
          if (cur.basis !== lot.link.rec.basis) cur.basis = "MIXED";
          bySale.set(o.row.id, cur);
        }
      }
      // 기록에 없는 재고에서 나간 판매(입고 기록 누락)는 운송비를 붙이지 않아요 - 과대 차감 방지
    }

    for (const r of records) {
      for (const a of r.allocs) {
        a.receivedSupply = a.receivedQty * a.perUnit;
        a.pendingSupply = a.allocated_supply - a.receivedSupply;          // 입고 전 - 예상 원가로만
        a.inventorySupply = a.receivedSupply - a.soldSupply;               // 입고됐지만 안 팔림 - 재고원가
      }
      const sum = k => r.allocs.reduce((s, a) => s + a[k], 0);
      r.receivedQty = sum("receivedQty"); r.soldQty = sum("soldQty");
      r.soldSupply = sum("soldSupply"); r.inventorySupply = sum("inventorySupply"); r.pendingSupply = sum("pendingSupply");
      const totalQty = sum("qty");
      r.stage = r.receivedQty <= 0 ? "BEFORE_RECEIPT" : r.receivedQty < totalQty ? "PARTIAL_RECEIPT" : "RECEIVED";
      const dates = r.allocs.flatMap(a => a.receiptDates).sort();
      r.firstReceiptDate = dates[0] || null;
    }
    return { bySale, records, history };
  }

  // 월 합계(판매분 차감액) - 화면 요약용
  function soldInMonth(rec, month) {
    return rec.allocs.reduce((s, a) => s + (a.soldByMonth[month] || 0), 0);
  }

  // 부가세: 실제 청구(ACTUAL)만 청구일 기준으로 매입세액에 넣고, 예상은 따로 보여줘요.
  function vatRows(allCosts, inRange) {
    const costs = (allCosts || []).filter(isActive);
    const actual = costs.filter(c => c.basis === "ACTUAL" && c.invoice_date && inRange(c.invoice_date));
    const estimate = costs.filter(c => c.basis !== "ACTUAL");
    const sum = (arr, k) => arr.reduce((s, c) => s + Number(c[k] || 0), 0);
    return { actualVat: sum(actual, "vat_amount"), actualSupply: sum(actual, "supply_amount"), actualCount: actual.length,
             estimateVat: sum(estimate, "vat_amount"), estimateSupply: sum(estimate, "supply_amount"), estimateCount: estimate.length };
  }

  const STAGE_LABEL = {
    BEFORE_RECEIPT: "입고 전 · 예상 원가(공헌이익 차감 없음)",
    PARTIAL_RECEIPT: "일부 입고 · 판매분만 차감",
    RECEIVED: "입고 완료 · 판매분만 차감",
  };
  const basisLabel = b => (b === "ACTUAL" ? "실제 청구" : b === "MIXED" ? "예상·실제 혼합" : "예상");

  global.InboundFreight = { compute, soldInMonth, vatRows, STAGE_LABEL, STATUS_LABEL, basisLabel, isActive };
})(typeof window !== "undefined" ? window : globalThis);
