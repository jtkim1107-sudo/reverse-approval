/* inventory_display.js
 * -------------------------------------------------------------------------
 * 2026-09-24 공유재고 대표 1줄 표시 - 아가드 1개/2개 세트/3개 세트처럼 같은 물리재고를 나눠 쓰는 SKU 를 재고·발주
 * 표와 요약 숫자에서 한 줄(기준상품)로 보여 줘요. 묶음·요약 숫자는 서버(/api/inventory/decisions 의 display,
 * inventory_display_groups.py)가 계산하고, 이 파일은 그 결과로 줄을 고르고 구성 SKU 를 보여 주기만 해요(쓰기 0).
 *
 *   · display 가 없거나(서버가 아직 옛 버전) 형식이 다르거나 대표 행을 decisions 에서 못 찾으면 null → 화면은
 *     예전처럼 SKU 마다 한 줄(숨기거나 지어내지 않음).
 *   · 재고·판매량을 더하지 않아요 - 대표 줄 값은 기준상품 행 그대로(이미 공유재고 전체 기준), 구성 표는 각 SKU 값 그대로.
 */
(function (global) {
  "use strict";

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = n => Number(n || 0).toLocaleString("ko-KR");
  const DECISION_TEXT = { ORDER_NOW: "지금 발주", ORDER_SOON: "곧 발주", AWAITING_INBOUND: "입고대기", OK: "정상", DATA_CHECK: "확인 필요", RESTOCK_EXCLUDED: "재입고 제외" };

  function valid(display) {
    return !!display && display.version === 1 && !display.error && Array.isArray(display.rows) && !!display.summary
      && typeof display.automation_blocked_count === "number";
  }

  /** [{d: 대표 decision, members, divergent}] - 쓸 수 없으면 null(예전 표시로) */
  function entries(decisions, display) {
    if (!valid(display)) return null;
    const byVid = new Map((decisions || []).map(d => [String(d.vendor_item_id ?? ""), d]));
    const out = [];
    for (const r of display.rows) {
      const d = byVid.get(String(r.vendor_item_id ?? ""));
      if (!d || (r.product_id && d.product_id !== r.product_id)) return null;
      out.push({ d, members: Array.isArray(r.members) ? r.members : [], divergent: Array.isArray(r.divergent_members) ? r.divergent_members : [],
                 automationBlocked: !!r.automation_blocked });
    }
    return out;
  }

  /** 요약 숫자·자동화 막힘 - display 가 쓸 수 있으면 묶음 기준, 아니면 서버 SKU 기준 summary 그대로 */
  function counts(result, list) {
    if (list) return { summary: result.display.summary, blocked: result.display.automation_blocked_count };
    return { summary: result.summary || {}, blocked: null };
  }

  const setLabel = m => (m.role === "base" || m.set_qty === 1) ? "1개" : `${m.set_qty}개 세트`;

  /** 목록 상품 칸 - "구성: 1개 · 2개 세트 · 3개 세트" (+ 구성마다 판정이 다르면 알림) */
  function membersLineHtml(entry) {
    if (!entry || entry.members.length < 2) return "";
    const parts = entry.members.map(m => `<span title="SKU ${esc(m.vendor_item_id)}">${esc(setLabel(m))}</span>`).join(" · ");
    const warn = entry.divergent.length ? ` <span style="color:var(--amber)">· 구성 ${fmt(entry.divergent.length)}개 상태 다름(상세 확인)</span>` : "";
    return `<span class="erp-sub">공유재고 구성: ${parts}${warn}</span>`;
  }

  /** 상세 모달 - 구성 SKU 표(각 SKU 값 그대로, 더하지 않음) */
  function membersDetailHtml(entry) {
    if (!entry || entry.members.length < 2) return "";
    const rows = entry.members.map(m => {
      const unit = m.role === "base" ? "개" : "세트";
      const stock = m.live_stock == null ? "확인 불가" : `${fmt(m.live_stock)}${unit}`;
      const vel = m.avg_daily_sales == null ? "-" : `${Number(m.avg_daily_sales).toFixed(2)}${unit}/일`;
      const div = entry.divergent.includes(m.vendor_item_id);
      return `<tr${div ? ' style="background:var(--amber-bg)"' : ""}><td>${esc(setLabel(m))}</td><td><code>${esc(m.vendor_item_id)}</code></td>
        <td class="num">${esc(stock)}</td><td class="num">${esc(vel)}</td>
        <td>${esc(DECISION_TEXT[m.decision] || m.decision || "-")}</td><td>${m.automation_blocked ? esc(m.automation_label || "막힘") : "-"}</td></tr>`;
    }).join("");
    return `<h4 style="font-size:13px;margin:14px 0 4px">공유재고 구성 SKU</h4>
      <p style="font-size:12px;color:var(--text-sub);margin:0 0 4px">같은 물리재고를 나눠 써요. 세트의 판매가능 수는 기준재고를 세트로 환산한 값이라 더하지 않아요.</p>
      <div class="table-wrap"><table class="items-table"><thead><tr><th>구성</th><th>SKU</th><th class="num">판매가능</th><th class="num">판매속도</th><th>재고 상태</th><th>자동화</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  /** 상세를 연 decision 이 대표인 묶음 - 없으면 null */
  function entryForDecision(result, d) {
    const list = result && entries(result.decisions, result.display);
    return (list && d && list.find(e => e.d === d)) || null;
  }

  global.InventoryDisplay = { valid, entries, counts, membersLineHtml, membersDetailHtml, entryForDecision };
})(typeof window !== "undefined" ? window : globalThis);
