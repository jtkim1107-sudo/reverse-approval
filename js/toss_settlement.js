/* toss_settlement.js - 토스쇼핑 정산(실제 수수료) 표시 부품 (2026-09-29, 승인 PNG 3장 구조 그대로)
 * -------------------------------------------------------------------------
 * 새 탭·메뉴·카드 섹션 없음. 기존 화면 두 곳에만 붙어요.
 *   · 매출 내역 행: 채널 칸 '토스쇼핑' 옆 작은 배지(정산 전 / 정산 완료)
 *   · 매출 행 '주문 N건' 상세 창: 기존 주문 표 아래 '수수료·정산 내역' 표 하나(주문일(잠정) | 토스 정산(확정))
 * 숫자를 새로 추정하지 않아요. 수수료·할인 부담·정산 지급액은 toss_settlement_steps(공식 정산 API 원본)의 값만 보여 주고,
 * 행이 없으면 '정산 전'. 공헌이익 금액은 공헌이익 화면(백엔드 cm_toss) 한 곳에서만 계산해요.
 * DB 쓰기 없음(읽기 1회: toss_settlement_steps SELECT). 표가 아직 없거나 읽기 실패면 모두 '정산 전'으로 두고 안내만.
 */
(function (root) {
  "use strict";

  const CHANNEL = "토스쇼핑";
  const KEY = /^TOSS-(\d+)$/;
  const FIELDS = "settle_key,order_id,order_product_id,is_shipping,step_type,order_product_status,quantity,order_product_price," +
    "shopping_discount_toss,shopping_discount_merchant,toss_pay_discount,toss_pay_point,delivery_fee_amount,pay_fee_rate," +
    "product_fee_rate,pay_fee,pay_vat,product_fee,product_vat,settlement_amount,transaction_date,payout_date,review_status";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const n = v => (v === null || v === undefined || v === "" ? 0 : Number(v) || 0);

  function opidOf(row) {
    const m = KEY.exec(String(row && row.external_key || ""));
    return m ? m[1] : null;
  }
  function isToss(group) { return !!group && group.channel === CHANNEL; }

  /** 읽기 전용 - 이 달 토스 행의 정산 행. 결과 { byOpid, shipByOrder, error } (실패해도 throw 안 함) */
  async function load(sb, opids) {
    const out = { byOpid: {}, shipByOrder: {}, error: null };
    const ids = [...new Set((opids || []).filter(Boolean).map(String))];
    if (!ids.length || !sb) return out;
    try {
      const { data, error } = await sb.from("toss_settlement_steps").select(FIELDS).in("order_product_id", ids);
      if (error) throw error;
      const orders = new Set();
      (data || []).forEach(r => { (out.byOpid[r.order_product_id] = out.byOpid[r.order_product_id] || []).push(r); orders.add(r.order_id); });
      if (orders.size) {
        const { data: ship, error: e2 } = await sb.from("toss_settlement_steps").select(FIELDS)
          .in("order_id", [...orders]).eq("is_shipping", true);
        if (e2) throw e2;
        (ship || []).forEach(r => { (out.shipByOrder[r.order_id] = out.shipByOrder[r.order_id] || []).push(r); });
      }
    } catch (e) {
      out.error = String(e && e.message || e);
    }
    return out;
  }

  /** 행(날짜·상품) 단위: 모든 주문상품에 결제(PAY) 정산 행이 있으면 정산 완료, 아니면 정산 전 */
  function groupStatus(group, data) {
    if (!isToss(group)) return null;
    const ids = (group.ledger_rows || []).map(opidOf).filter(Boolean);
    if (!ids.length) return "PENDING";
    return ids.every(id => ((data && data.byOpid[id]) || []).some(s => s.step_type === "PAY")) ? "SETTLED" : "PENDING";
  }

  function badgeHtml(status) {
    if (!status) return "";
    const UI = root.ErpUi;
    const [kind, text] = status === "SETTLED" ? ["ok", "정산 완료"] : ["pending", "정산 전"];
    return UI && UI.badge ? UI.badge(kind, { text, small: true }) : `<span class="erp-badge erp-badge--sm">${esc(text)}</span>`;
  }

  function rate(v) {
    if (v === null || v === undefined || v === "") return "";
    const p = Number(v) * 100;
    return `${Number.isInteger(p) ? p : p.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
  }

  /** 상세 창 아래 표 - 주문일(잠정) | 토스 정산(확정) */
  const ORDER_RE = /토스쇼핑 주문 (\S+)/;
  function orderIdOf(row) { const m = ORDER_RE.exec(String(row && row.memo || "")); return m ? m[1] : null; }

  /** 이 달 토스 주문별 줄 수(여러 상품 주문 판단용) - 매출 내역 전체 토스 행에서 */
  function orderLineCounts(groups) {
    const out = {};
    (groups || []).filter(isToss).forEach(g => (g.ledger_rows || []).forEach(r => {
      const o = orderIdOf(r); if (o) out[o] = (out[o] || 0) + 1;
    }));
    return out;
  }

  /** 배송·포장비(상품 마스터 ship_fee · 주문당 · VAT 포함) - 입력양식 규칙 '그 상품 단독 주문 1건' 밖이면 확인 필요 */
  function shipCost(group, { shipFee = null, orderLines = {} } = {}) {
    const rows = group.ledger_rows || [];
    let n = 0, review = 0;
    rows.forEach(r => {
      const single = Number(r.qty) === 1 && (orderLines[orderIdOf(r)] || 1) === 1;
      if (!single || shipFee === null || shipFee === undefined || shipFee === "") review += 1; else n += 1;
    });
    const missing = shipFee === null || shipFee === undefined || shipFee === "";
    return { perOrder: missing ? null : Number(shipFee), orders: n, review, missing, total: missing ? null : Number(shipFee) * n };
  }

  function feeTableHtml(group, data, { fmt, taxable = true, today = "", shipFee = null, orderLines = {} } = {}) {
    if (!isToss(group)) return "";
    const won = v => `₩${fmt(v)}`;
    const dash = `<span style="color:var(--text-sub)">—</span>`;
    const sm = s => `<small style="color:var(--text-sub);font-size:11.5px;font-weight:400;margin-left:6px">${s}</small>`;
    const th = `style="padding:6px 8px;width:auto;white-space:nowrap"`;
    const td = `class="num" style="padding:6px 8px;text-align:right;white-space:nowrap"`;
    const row = (l, sub, pre, post) => `<tr><th scope="row" ${th}>${l}${sub ? sm(sub) : ""}</th><td ${td}>${pre}</td><td ${td}>${post}</td></tr>`;
    const sup = v => (taxable ? Math.round(v / 1.1) : v);

    const rows = group.ledger_rows || [];
    const gross = rows.reduce((t, r) => t + n(r.amount), 0);
    const ids = rows.map(opidOf).filter(Boolean);
    const steps = ids.flatMap(id => (data && data.byOpid[id]) || []);
    const orderIds = [...new Set(steps.map(s => s.order_id))];
    const ship = orderIds.flatMap(o => (data && data.shipByOrder[o]) || []);
    const status = groupStatus(group, data);
    const settled = status === "SETTLED";
    const refunded = steps.some(s => s.step_type === "REFUND");
    const review = steps.concat(ship).some(s => s.review_status === "CHANGED_NEEDS_REVIEW");

    const sum = (arr, f) => arr.reduce((t, s) => t + n(s[f]), 0);
    const price = sum(steps, "order_product_price");
    const merchant = sum(steps, "shopping_discount_merchant");
    const tossFunded = sum(steps, "shopping_discount_toss") + sum(steps, "toss_pay_discount") + sum(steps, "toss_pay_point");
    const productFee = sum(steps, "product_fee"), productVat = sum(steps, "product_vat");
    const payFee = sum(steps, "pay_fee"), payVat = sum(steps, "pay_vat");
    const custShip = sum(ship, "delivery_fee_amount"), shipPayFee = sum(ship, "pay_fee") + sum(ship, "product_fee");
    const shipVat = sum(ship, "pay_vat") + sum(ship, "product_vat");
    const expected = price - merchant - productFee - productVat - payFee - payVat + (custShip - sum(ship, "shopping_discount_merchant") - shipPayFee - shipVat);
    const paid = sum(steps, "settlement_amount") + sum(ship, "settlement_amount");
    const other = expected - paid;
    const payStep = steps.find(s => s.step_type === "PAY") || {};
    const payout = [...steps, ...ship].map(s => s.payout_date).filter(Boolean).sort().slice(-1)[0] || "";
    const payoutText = payout ? `${payout.slice(5)} ${today && payout <= today ? "지급" : "지급 예정"}` : "";

    const post = v => (settled ? v : dash);
    const sc = shipCost(group, { shipFee, orderLines });
    const shipPre = sc.missing ? `<b>미입력</b>${sm("확인 필요")}`
      : !sc.orders ? `<b>확인 필요</b>${sm(`여러 상품·여러 개 ${fmt(sc.review)}건 · 주문당 ${won(sc.perOrder)} 기준 밖`)}`
      : `${won(sc.total)}${sm(`주문당 ${won(sc.perOrder)} × ${fmt(sc.orders)}건`)}${sc.review ? sm(`여러 상품·여러 개 ${fmt(sc.review)}건 확인 필요`) : ""}`;
    const body = [
      row("판매가", "판매가 × 수량", won(gross), post(won(price))),
      row("판매자 부담 할인", "셀러 쿠폰 · 매출에서 차감", "확인 전", post(won(merchant))),
      row("토스 부담 할인·포인트", "참고 · 토스가 정산에서 채워 줌", `정산 뒤 확인`, post(won(tossFunded))),
      row("매출(공급가액)", "(판매가 − 판매자 할인) ÷ 1.1", won(sup(gross)), post(won(sup(price - merchant)))),
      row("상품 판매 수수료", "요율·금액 · 부가세 별도", "정산 전",
          post(`${won(productFee)}${sm(`${rate(payStep.product_fee_rate)} · VAT ${won(productVat)}`)}`)),
      row("결제 수수료", "요율·금액 · 부가세 별도", "정산 전",
          post(`${won(payFee)}${sm(`${rate(payStep.pay_fee_rate)} · VAT ${won(payVat)}`)}`)),
      row("배송비", "고객 결제 배송비 · 결제 수수료만", "정산 전",
          post(ship.length ? `${won(custShip)}${sm(`수수료 ${won(shipPayFee)}`)}` : "없음")),
      row("기타 차감", "계산값과 정산 금액 차이", dash, post(Math.abs(other) >= 1 ? `<b>${won(other)}</b>${sm("확인 필요")}` : won(0))),
      row("상품원가", "원가 × 수량", "공헌이익 화면 기준", dash),
      row("배송·포장비", "상품 마스터 · 주문당 · VAT 포함", shipPre, settled ? shipPre : dash),
      row("정산 예정액 / 지급액", "지급일", "정산 전", post(`${won(paid)}${payoutText ? sm(payoutText) : ""}`)),
    ].join("");
    const cmRow = `<tr><th scope="row" ${th}><b>공헌이익</b></th><td ${td}><b>합계 미포함</b>${sm("구매확정 전 - 실제 수수료 정산 없음")}</td>`
      + `<td ${td}>${settled ? `<a href="#/profit">공헌이익 화면에 반영</a>` : dash}</td></tr>`;
    const notes = [
      refunded ? "환불 단계 포함(음수)" : "",
      review ? "이전 조회와 달라진 정산 행 있음 - 확인 필요" : "",
      data && data.error ? "정산 자료를 읽지 못해 정산 전으로 표시" : "",
    ].filter(Boolean).join(" · ");
    return `<div id="toss-fee" style="margin-top:16px">
      <div style="display:flex;align-items:center;gap:8px;margin:6px 0 6px;flex-wrap:wrap"><b style="font-size:14px">수수료·정산 내역</b> ${badgeHtml(status)}
        <span style="font-size:12px;color:var(--text-sub)">토스쇼핑 정산 조회 기준 · 요율 추정 없음${notes ? ` · ${esc(notes)}` : ""}</span></div>
      <div class="table-wrap"><table class="rg-detail"><thead><tr><th ${th}></th><th ${th} style="text-align:right">주문일(잠정)</th>
        <th ${th} style="text-align:right">토스 정산(확정)</th></tr></thead><tbody>${body}${cmRow}</tbody></table></div></div>`;
  }

  root.TossSettlement = { CHANNEL, opidOf, isToss, load, groupStatus, badgeHtml, feeTableHtml, shipCost, orderLineCounts, orderIdOf };
})(typeof window !== "undefined" ? window : globalThis);
