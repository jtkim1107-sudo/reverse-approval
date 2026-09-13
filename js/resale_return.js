/* resale_return.js
 * -------------------------------------------------------------------------
 * 2026-09-14 반품 재판매 SKU 표시 (사용자 확정 기준) - 계산은 서버, 이 파일은 보여 주기만 해요(쓰기 0).
 *
 *   · 재고: 서버(inventory_decision)가 공유재고 스위치를 켰을 때만 stock_breakdown·resale_pool 을 보내요.
 *     정상 SKU 행 = 정상 재고 · 반품 재판매 재고 · 공유재고 합계를 따로 보여 줘요(합계가 live_stock).
 *     반품 SKU 행 = 정상 SKU 판단을 따르고, 자기 판매가능 재고는 참고로만.
 *     필드가 없으면(스위치 꺼짐) 아무것도 그리지 않아요 - 화면이 지금과 같아요.
 *   · 반품 원가환입(참고 카드)은 이번 배포에 없어요 - 다음 공헌이익 작업에서 따로. 공헌이익 화면은 바뀌지 않아요.
 */
(function (global) {
  "use strict";

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => Number(n || 0).toLocaleString("ko-KR");
  const OFFER_LABEL = { RETURN_GOOD: "반품(상태 좋음)", RETURN_NORMAL: "반품(보통)", PACKAGE_DAMAGED: "포장 훼손" };
  // 서버 판정 근거(resale_return.py): PRESENT=재고 목록에 행 있음 · ABSENT_ZERO=완전한 재고 목록에 없음 → 0 · UNKNOWN=조회 실패·부분 응답
  const SNAPSHOT_REASON = { PARTIAL_PAGES: "응답 일부만 받음", TIME_UNKNOWN: "기준시각 불명", STALE: "오래된 조회", NO_PAGES: "응답 없음" };
  const reasonText = r => !r ? "" : r.startsWith("FETCH_FAILED") ? "전체 재고 조회 실패" : r.startsWith("PARSE_ERROR") ? "응답 형식 오류"
    : r.startsWith("PAGE_ERROR") ? "응답 오류 코드" : (SNAPSHOT_REASON[r] || r);

  /** 정상 SKU 행의 공유재고 내역 {normal, resale, total, unknown[]} - 없으면 null */
  function breakdown(d) {
    const b = d && d.stock_breakdown;
    if (!b || b.total == null && b.normal == null) return null;
    return { normal: b.normal, resale: b.resale || 0, total: b.total, unknown: b.resale_unknown || [],
             byVendorItem: b.resale_by_vendor_item || {}, detail: b.resale_detail || {}, snapshot: b.snapshot || {} };
  }

  /** 반품 재판매 SKU 행인가 */
  function isResaleRow(d) {
    return !!(d && d.resale_pool && d.resale_pool.role === "resale");
  }

  /** 목록 '현재재고' 칸 뒤에 붙는 짧은 내역 */
  function stockSuffix(d) {
    const b = breakdown(d);
    if (b && b.normal != null) return ` (정상 ${fmt(b.normal)} + 반품 ${fmt(b.resale)}${b.unknown.length ? ` · 반품 재고 확인 불가` : ""})`;
    if (isResaleRow(d)) return " (반품 재판매 · 공유재고에 포함)";
    return "";
  }

  /** 상세 모달 '현재' 표에 넣을 행들 */
  function detailRowsHtml(d) {
    const b = breakdown(d);
    if (b && b.normal != null) {
      const per = Object.keys(b.detail).length
        ? Object.entries(b.detail).map(([v, x]) => `${esc(v)} ${x.qty == null ? "확인 불가" : `${fmt(x.qty)}개${x.basis === "ABSENT_ZERO" ? "(재고 목록에 없음)" : ""}`}`).join(" · ")
        : Object.entries(b.byVendorItem).map(([v, q]) => `${esc(v)} ${fmt(q)}개`).join(" · ");
      return `
          <tr><td>정상 SKU 재고</td><td class="num">${fmt(b.normal)}개</td></tr>
          <tr><td>반품 재판매 재고${per ? ` <small style="color:var(--text-sub)">${per}</small>` : ""}</td><td class="num">${fmt(b.resale)}개</td></tr>
          ${b.unknown.length ? `<tr><td colspan="2" style="color:var(--amber);font-size:12.5px">반품 재판매 재고 확인 불가(${esc(reasonText(b.snapshot.reason) || "조회 실패")}) - ${b.unknown.map(esc).join(", ")} 은 합계에서 빠져 있어요(자동화 막힘)</td></tr>` : ""}
          <tr><td><b>공유재고 합계</b> <small style="color:var(--text-sub)">재고 판단·발주 추천 기준</small></td><td class="num"><b>${fmt(b.total)}개</b></td></tr>`;
    }
    return "";
  }

  /** 반품 SKU 행 상세 안내 */
  function resaleNoticeHtml(d) {
    if (!isResaleRow(d)) return "";
    const rp = d.resale_pool;
    const own = rp.own_stock_unknown || rp.own_stock == null ? "재고 확인 불가"
      : rp.own_stock_basis === "ABSENT_ZERO" ? "판매 가능 0개(쿠팡 재고 목록에 없음)" : `판매 가능 ${fmt(rp.own_stock)}개`;
    return `<p style="font-size:13px;background:var(--gray-bg);border-radius:8px;padding:8px 10px;margin:0 0 8px">
            ♻️ 쿠팡이 반품 재고를 다시 올린 리스팅이에요(${esc(OFFER_LABEL[rp.offer_condition] || rp.offer_condition || "-")}) · ${own}.
            이 재고는 기준 SKU <code>${esc(rp.base_vendor_item_id || "-")}</code> 공유재고${rp.total != null ? `(합계 ${fmt(rp.total)}개)` : ""}에 들어가고,
            판단도 기준 SKU 를 따라요. 신규 입고·발주 SKU 로는 쓰지 않아요(SKU 사용 보류).</p>`;
  }

  global.ResaleReturn = { breakdown, isResaleRow, stockSuffix, detailRowsHtml, resaleNoticeHtml, OFFER_LABEL };
})(typeof window !== "undefined" ? window : globalThis);
