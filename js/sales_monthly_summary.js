(function (global) {
  "use strict";

  const RG_CHANNEL = "쿠팡 로켓그로스";

  const n = (value) => Number(value) || 0;
  const dateOf = (row) => String(row.sales_date || row.date || "").slice(0, 10);

  function groupKey(date, productKey, channel) {
    return `${date}|${productKey}|${channel}`;
  }

  function build({ month, statisticsRows = [], salesRows = [], adjustmentRows = [], productName }) {
    const nameOf = typeof productName === "function" ? productName : (id) => id;
    const groups = new Map();

    const put = (key, initial) => {
      if (!groups.has(key)) groups.set(key, initial);
      return groups.get(key);
    };

    // 로켓그로스는 주문 원장이 아니라 쿠팡 판매통계 NET을 유일한 금액 기준으로 씁니다.
    for (const row of statisticsRows) {
      const date = dateOf(row);
      if (!date.startsWith(month) || (row.channel || RG_CHANNEL) !== RG_CHANNEL) continue;
      const productKey = row.product_id || `option:${row.option_id}`;
      const key = groupKey(date, productKey, RG_CHANNEL);
      const g = put(key, {
        key, date, product_id: row.product_id || null,
        product_name: row.product_id ? (nameOf(row.product_id) || row.product_name) : row.product_name,
        channel: RG_CHANNEL, source: "STATISTICS_NET", option_ids: [], order_count: null,
        gross_qty: 0, gross_amount: 0, cancel_qty: 0, cancel_amount: 0,
        net_qty: 0, net_amount: 0, ledger_rows: [],
        mapping_statuses: [], reconciliation_statuses: [],
      });
      g.gross_qty += n(row.gross_qty);
      g.gross_amount += n(row.gross_amount);
      g.cancel_qty += n(row.cancel_qty);
      g.cancel_amount += n(row.cancel_amount);
      g.net_qty += n(row.net_qty);
      g.net_amount += n(row.net_amount);
      if (row.option_id && !g.option_ids.includes(String(row.option_id))) g.option_ids.push(String(row.option_id));
      const ms = row.mapping_status || (row.product_id ? "MATCHED" : "UNMATCHED");
      if (!g.mapping_statuses.includes(ms)) g.mapping_statuses.push(ms);
      if (row.reconciliation_status && !g.reconciliation_statuses.includes(row.reconciliation_status)) {
        g.reconciliation_statuses.push(row.reconciliation_status);
      }
    }

    // 판매자배송 등 비-RG 채널은 기존 주문 원장을 날짜+상품+채널로 묶습니다.
    for (const row of salesRows) {
      const date = dateOf(row);
      const channel = row.channel || "기타";
      if (!date.startsWith(month) || channel === RG_CHANNEL) continue;
      const productKey = row.product_id || `unknown:${row.id || row.memo || ""}`;
      const key = groupKey(date, productKey, channel);
      const g = put(key, {
        key, date, product_id: row.product_id || null,
        product_name: nameOf(row.product_id) || row.product_id || "미등록 상품",
        channel, source: "ORDER_MINUS_ADJUSTMENT", option_ids: [], order_count: 0,
        gross_qty: 0, gross_amount: 0, cancel_qty: 0, cancel_amount: 0,
        net_qty: 0, net_amount: 0, ledger_rows: [],
        mapping_statuses: [row.product_id ? "MATCHED" : "UNMATCHED"], reconciliation_statuses: [],
      });
      g.gross_qty += n(row.qty);
      g.gross_amount += n(row.amount);
      g.net_qty += n(row.qty);
      g.net_amount += n(row.amount);
      g.order_count += 1;
      g.ledger_rows.push(row);
    }

    // RG 조정은 이미 판매통계에 들어 있으므로 절대 다시 차감하지 않습니다.
    for (const row of adjustmentRows) {
      const date = dateOf(row);
      const channel = row.channel || "기타";
      if (!date.startsWith(month) || channel === RG_CHANNEL) continue;
      const productKey = row.product_id || `unknown-adjustment:${row.id || ""}`;
      const key = groupKey(date, productKey, channel);
      const g = put(key, {
        key, date, product_id: row.product_id || null,
        product_name: nameOf(row.product_id) || row.product_id || "미등록 상품",
        channel, source: "ORDER_MINUS_ADJUSTMENT", option_ids: [], order_count: 0,
        gross_qty: 0, gross_amount: 0, cancel_qty: 0, cancel_amount: 0,
        net_qty: 0, net_amount: 0, ledger_rows: [],
        mapping_statuses: [row.product_id ? "MATCHED" : "UNMATCHED"], reconciliation_statuses: [],
      });
      const qty = Math.abs(n(row.qty));
      const amount = Math.abs(n(row.used_amount != null ? row.used_amount : row.estimated_adjustment_amount));
      g.cancel_qty += qty;
      g.cancel_amount += amount;
      g.net_qty -= qty;
      g.net_amount -= amount;
    }

    const entries = [...groups.values()].sort((a, b) =>
      b.date.localeCompare(a.date) || b.net_amount - a.net_amount || a.product_name.localeCompare(b.product_name, "ko")
    );
    const rg = entries.filter((e) => e.source === "STATISTICS_NET");
    const mp = entries.filter((e) => e.source === "ORDER_MINUS_ADJUSTMENT");
    const sum = (list, field) => list.reduce((total, row) => total + n(row[field]), 0);

    return {
      entries,
      has_rg_statistics: statisticsRows.some((r) => dateOf(r).startsWith(month)),
      collected_dates: [...new Set(statisticsRows.map(dateOf).filter((d) => d.startsWith(month)))].sort(),
      rocket_growth: {
        gross_qty: sum(rg, "gross_qty"), gross_amount: sum(rg, "gross_amount"),
        cancel_qty: sum(rg, "cancel_qty"), cancel_amount: sum(rg, "cancel_amount"),
        net_qty: sum(rg, "net_qty"), net_amount: sum(rg, "net_amount"),
      },
      marketplace: {
        gross_qty: sum(mp, "gross_qty"), gross_amount: sum(mp, "gross_amount"),
        cancel_qty: sum(mp, "cancel_qty"), cancel_amount: sum(mp, "cancel_amount"),
        net_qty: sum(mp, "net_qty"), net_amount: sum(mp, "net_amount"),
      },
      total: {
        net_qty: sum(entries, "net_qty"), net_amount: sum(entries, "net_amount"),
      },
    };
  }

  // rgOnly: 대시보드 '오늘 로켓그로스 판매현황'처럼 로켓그로스(판매통계 NET)만 볼 때.
  // 따로 계산하지 않고 같은 entries에서 걸러 쓰므로 매출 입력 화면과 값이 같습니다.
  function forDate(summary, date, { rgOnly = false } = {}) {
    if (!summary?.has_rg_statistics || !date) return null;
    const entries = summary.entries.filter((row) =>
      row.date === date && (!rgOnly || row.source === "STATISTICS_NET"));
    const sum = (field) => entries.reduce((total, row) => total + n(row[field]), 0);
    return {
      date, entries,
      net_qty: sum("net_qty"), net_amount: sum("net_amount"),
      gross_qty: sum("gross_qty"), gross_amount: sum("gross_amount"),
      cancel_qty: sum("cancel_qty"), cancel_amount: sum("cancel_amount"),
      collected: summary.collected_dates.includes(date),
    };
  }

  /* ── CSV (2026-09-11) ─────────────────────────────────────────────────────
     사용자 지시: "CSV는 화면에 렌더링되는 것과 동일한 API 응답과 동일한 집계 결과를 사용,
     화면과 CSV가 각각 별도로 매출을 계산하지 않도록 공통 데이터 배열". 여기서는 *계산하지 않고*
     build() 가 만든 entries(화면 표가 그리는 바로 그 배열)를 순서 그대로 한 줄씩 옮기기만 해요.
     주문번호는 넣지 않습니다(화면이 상품별 집계라서). */
  const CSV_HEADER = ["판매일", "ERP 상품코드", "상품명", "채널", "전체수량", "취소·반품수량", "순판매수량",
    "전체매출", "취소·반품금액", "순매출", "데이터 원천", "쿠팡 옵션 ID", "매핑상태", "대사상태"];
  const SOURCE_LABEL = { STATISTICS_NET: "쿠팡 판매통계 NET", ORDER_MINUS_ADJUSTMENT: "주문 − 취소·반품" };
  const MAPPING_LABEL = { MATCHED: "매핑됨", UNMATCHED: "미매핑" };
  const RECON_LABEL = { MATCH: "일치", RECONCILIATION_MISMATCH: "정산 차이", NOT_COMPARED: "비교 전(정산 엑셀 없음)" };
  // 숫자는 쉼표·원 기호 없이. 부동소수 흔적(0.1+0.2)만 걷어내고 값은 바꾸지 않아요.
  const num = (v) => { const x = Math.round(n(v) * 100) / 100; return Object.is(x, -0) ? 0 : x; };

  function csvRows(summary, { productCode } = {}) {
    const codeOf = typeof productCode === "function" ? productCode : () => "";
    const body = summary.entries.map((g) => {
      const mapping = (g.mapping_statuses || []).map((m) => MAPPING_LABEL[m] || m).join("/")
        || (g.product_id ? "매핑됨" : "미매핑");
      const recon = g.source === "STATISTICS_NET"
        ? ((g.reconciliation_statuses || []).map((r) => RECON_LABEL[r] || r).join("/") || "")
        : "해당 없음(판매자배송)";
      return [g.date, g.product_id ? (codeOf(g.product_id) || "") : "", g.product_name, g.channel,
        num(g.gross_qty), num(g.cancel_qty), num(g.net_qty),
        num(g.gross_amount), num(g.cancel_amount), num(g.net_amount),
        SOURCE_LABEL[g.source] || g.source, (g.option_ids || []).join(" "), mapping, recon];
    });
    const sum = (i) => num(body.reduce((t, r) => t + r[i], 0));
    const total = ["합계", "", `${summary.entries.length}행`, "", sum(4), sum(5), sum(6), sum(7), sum(8), sum(9),
      "", "", "", ""];
    return [CSV_HEADER, ...body, total];
  }

  function csvCell(v) {
    if (typeof v === "number") return String(v);
    const s = String(v == null ? "" : v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // Excel 한글 깨짐 방지 UTF-8 BOM + CRLF.
  function toCsv(summary, opts = {}) {
    return "\uFEFF" + csvRows(summary, opts).map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
  }

  global.SalesMonthlySummary = { build, forDate, csvRows, toCsv, CSV_HEADER, RG_CHANNEL };
})(window);
