/* live_sales.js
 * -------------------------------------------------------------------------
 * 2026-09-29 [사용자 지시: "예전에 보이던 실시간 매출 현황 화면 복구 - 오늘 누적 매출액·주문 건수·
 * 판매 수량·취소·반품·마지막 수집 시각, 전일 확정 매출과 명확히 구분, 사이드바 메뉴"]
 *
 * 2026-09-29 [사용자 지시: "별도 탭을 없애고 이 기능을 ERP 대시보드에"] 사이드바 #/livesales 는 없애고
 * 대시보드 '실시간 매출' 카드(dashboardHtml)로 옮겼어요. #/livesales 주소는 라우터가 대시보드로 바꿔요.
 *
 * 원래 화면: 2026-09-11 대시보드 '오늘 로켓그로스 판매현황' 카드(0f045d2, SalesRefresh.todayCardHtml).
 * 2026-09-13 대시보드 정리(935c5ed)에서 '매출 요약'(어제 기준)으로 바뀌며 화면에서 빠졌어요.
 * 이 화면은 그 카드와 *같은 원천·같은 공통 집계*만 씁니다(새 쿼리·새 계산식 없음):
 *   · 금액·수량: buildMonthlyNetSales → SalesMonthlySummary.forDate (매출 입력·대시보드와 같은 값)
 *       - 로켓그로스 = 쿠팡 판매통계 순매출(전체 거래 − 취소·반품)
 *       - 판매자배송 등 = 주문 원장 − 조정(취소·반품)
 *   · 수집 시각·상태: SalesRefresh.loadDayState / statusLineHtml (로켓그로스 수집 이력)
 *   · 오늘 값 갱신: 기존 'WING 판매데이터 다시 수집'(확인창 → GCP 가 WING 에서 받아 저장). 이 파일은
 *     그 버튼을 그려 줄 뿐 스스로 수집·저장하지 않아요. '화면 새로고침'은 DB 를 다시 읽기만 해요.
 *
 * 전일 '확정'은 그날이 끝난 뒤(다음 날 00:00 KST 이후) 받은 판매통계만이에요. 하루가 끝나기 전에
 * 받은 값은 '잠정'(06:20 통합수집 때 확정), 수집이 없으면 '미수집'(0원 아님).
 * 로켓그로스 판매통계에는 주문 건수가 없어요 - 지어내지 않고 '판매통계 미제공'으로 표시.
 */
(function (global) {
  "use strict";

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const won = (n) => (n == null ? "—" : `₩${Math.round(Number(n)).toLocaleString("ko-KR")}`);
  const ea = (n) => (n == null ? "—" : `${Number(n).toLocaleString("ko-KR")}개`);
  const cnt = (n) => (n == null ? "—" : `${Number(n).toLocaleString("ko-KR")}건`);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  function nextDate(date) {
    const [y, m, d] = String(date).split("-").map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + 1));
    return t.toISOString().slice(0, 10);
  }
  /** 그 날짜가 끝나는 시각(다음 날 00:00 KST). */
  function dayEndMs(date) { return Date.parse(`${nextDate(date)}T00:00:00+09:00`); }

  /** 날짜 하나의 채널별 값. summary 는 그 날짜가 속한 달의 공통 집계(없으면 null). */
  function dayModel(summary, date, forDate) {
    const all = summary && forDate ? forDate(summary, date) : null;
    const rg = summary && forDate ? forDate(summary, date, { rgOnly: true }) : null;
    // forDate 는 그 달에 로켓그로스 판매통계가 하나도 없으면(매월 1일 새벽 등) null 이에요 - 판매자배송 원장은
    // 그와 무관하게 같은 공통 집계 entries 에서 날짜로만 골라요(값·계산은 build() 그대로).
    const mpEntries = (all ? all.entries : (summary && summary.entries) || [])
      .filter((e) => e.date === date && e.source === "ORDER_MINUS_ADJUSTMENT");
    const mpSum = (f) => mpEntries.reduce((t, e) => t + num(e[f]), 0);
    const rgCollected = !!(rg && rg.collected);
    const mp = {
      net_amount: mpSum("net_amount"), net_qty: mpSum("net_qty"),
      gross_amount: mpSum("gross_amount"), gross_qty: mpSum("gross_qty"),
      cancel_amount: mpSum("cancel_amount"), cancel_qty: mpSum("cancel_qty"),
      order_count: mpEntries.reduce((t, e) => t + num(e.order_count), 0),
      has_rows: mpEntries.length > 0,
    };
    const rgv = rgCollected ? {
      net_amount: rg.net_amount, net_qty: rg.net_qty, gross_amount: rg.gross_amount, gross_qty: rg.gross_qty,
      cancel_amount: rg.cancel_amount, cancel_qty: rg.cancel_qty,
    } : null;
    return {
      date, summaryLoaded: !!summary, rgCollected, rg: rgv, mp,
      // 합계는 로켓그로스가 수집됐을 때만 - 미수집을 0원으로 더하지 않아요
      total: rgCollected ? {
        net_amount: rgv.net_amount + mp.net_amount, net_qty: rgv.net_qty + mp.net_qty,
        cancel_amount: rgv.cancel_amount + mp.cancel_amount, cancel_qty: rgv.cancel_qty + mp.cancel_qty,
      } : null,
    };
  }

  /** 전일 값의 확정 여부: 그날이 끝난 뒤 받은 판매통계면 CONFIRMED, 그 전이면 PROVISIONAL, 없으면 NOT_COLLECTED. */
  function confirmState(day, state) {
    if (!day.rgCollected) return "NOT_COLLECTED";
    const lc = state && state.last_check;
    const at = lc ? Date.parse(lc.collected_at) : NaN;
    if (!Number.isFinite(at)) return "UNKNOWN";
    return at >= dayEndMs(day.date) ? "CONFIRMED" : "PROVISIONAL";
  }

  function model({ todaySummary, yesterdaySummary, today, yesterday, todayState, yesterdayState, forDate }) {
    const t = dayModel(todaySummary, today, forDate);
    const y = dayModel(yesterdaySummary, yesterday, forDate);
    return { today: t, yesterday: { ...y, confirm: confirmState(y, yesterdayState) }, todayState, yesterdayState };
  }

  const stat = (label, value, sub, cls = "") => `<div class="stat"><div class="stat-label">${label}</div>
      <div class="stat-value ${cls}">${value}</div>${sub ? `<div style="font-size:12px;color:var(--text-sub)">${sub}</div>` : ""}</div>`;

  function lastCollectedText(state) {
    const lc = state && state.last_check;
    const kst = global.SalesRefresh && global.SalesRefresh.kst;
    if (!lc) return "수집 기록 없음";
    return kst ? kst(lc.collected_at, true) : String(lc.collected_at);
  }

  function channelTable(day) {
    const rg = day.rg;
    const mp = day.mp;
    const row = (name, v, orders, note) => `<tr><td>${name}</td>
        <td class="num">${v ? won(v.net_amount) : "—"}</td><td class="num">${v ? ea(v.net_qty) : "—"}</td>
        <td class="num">${orders}</td><td class="num">${v ? `${won(v.cancel_amount)} (${ea(v.cancel_qty)})` : "—"}</td>
        <td style="font-size:12px;color:var(--text-sub)">${note}</td></tr>`;
    return `<div class="table-wrap"><table>
      <thead><tr><th>채널</th><th class="num">순매출</th><th class="num">순 판매수량</th><th class="num">주문 건수</th>
        <th class="num">취소·반품</th><th>기준</th></tr></thead>
      <tbody>
        ${row("쿠팡 로켓그로스", rg, "판매통계 미제공", rg ? "쿠팡 판매통계(전체 거래 − 취소·반품)" : "<b>미수집</b> · 0원 아님")}
        ${row("판매자배송 등", mp.has_rows ? mp : null, mp.has_rows ? cnt(mp.order_count) : "—", mp.has_rows ? "주문 원장 − 조정" : "주문 없음 또는 아직 동기화 전")}
      </tbody></table></div>`;
  }

  function todayHtml(m, { today, refreshButton = "", statusLine = "" }) {
    const d = m.today;
    const t = d.total;
    const body = d.rgCollected ? `<div class="grid-stats">
        ${stat("오늘 누적 순매출", won(t.net_amount), `로켓그로스 ${won(d.rg.net_amount)} · 그 외 ${won(d.mp.net_amount)}`, "blue")}
        ${stat("판매 수량", ea(t.net_qty), "순 판매수량(취소·반품 제외)")}
        ${stat("주문 건수", d.mp.has_rows ? cnt(d.mp.order_count) : "—", "판매자배송 등만 · 로켓그로스는 판매통계 미제공")}
        ${stat("취소·반품", won(t.cancel_amount), ea(t.cancel_qty), "amber")}
        ${stat("마지막 수집", esc(lastCollectedText(m.todayState)), "로켓그로스 판매통계 기준")}
      </div>`
      : `<div role="status" style="background:#f8f9fb;border:1px solid var(--line,#e5e7eb);border-radius:9px;padding:12px;margin:6px 0 12px">
          <b>${esc(today)} 로켓그로스 판매통계가 아직 없어요 — 0원이 아니라 미수집입니다.</b>
          <div style="font-size:12.5px;color:var(--text-sub);margin-top:4px">매일 06:20 통합수집은 <b>전날</b> 판매만 받아요.
            오늘 누적은 'WING 판매데이터 다시 수집'을 눌렀을 때만 들어옵니다(확인창 → GCP 가 WING 에서 받아 저장).
            · 마지막 수집: ${esc(lastCollectedText(m.todayState))}</div></div>`;
    return `<div class="card" id="live-sales-today" style="margin-bottom:14px">
      <div class="card-head"><h2>오늘 누적 매출 <span style="font-size:12px;font-weight:400;color:var(--text-sub)">(${esc(today)} · 진행 중 · 잠정)</span></h2>
        ${refreshButton}</div>
      ${statusLine}
      ${body}
      ${channelTable(d)}
      <p style="font-size:11.5px;color:var(--text-sub);margin:6px 0 0">오늘 값은 하루가 끝나지 않아 계속 바뀌는 <b>잠정값</b>이에요 · 쿠팡 자체 집계 지연이 있을 수 있어요</p>
    </div>`;
  }

  const CONFIRM_LABEL = {
    CONFIRMED: ["approved", "전일 확정"],
    PROVISIONAL: ["progress", "잠정 · 하루가 끝나기 전 수집 (06:20 통합수집 때 확정)"],
    NOT_COLLECTED: ["rejected", "미수집 · 0원 아님"],
    UNKNOWN: ["progress", "수집 시각 확인 필요"],
  };

  function yesterdayHtml(m, { yesterday }) {
    const d = m.yesterday;
    const [chipCls, chipText] = CONFIRM_LABEL[d.confirm] || CONFIRM_LABEL.UNKNOWN;
    const t = d.total;
    const body = d.rgCollected ? `<div class="grid-stats">
        ${stat("전일 순매출", won(t.net_amount), `로켓그로스 ${won(d.rg.net_amount)} · 그 외 ${won(d.mp.net_amount)}`)}
        ${stat("판매 수량", ea(t.net_qty), "")}
        ${stat("주문 건수", d.mp.has_rows ? cnt(d.mp.order_count) : "—", "판매자배송 등만")}
        ${stat("취소·반품", won(t.cancel_amount), ea(t.cancel_qty), "amber")}
      </div>` : "";
    return `<div class="card" id="live-sales-yesterday" style="margin-bottom:14px">
      <div class="card-head"><h2>전일 매출 <span style="font-size:12px;font-weight:400;color:var(--text-sub)">(${esc(yesterday)})</span></h2>
        <span class="chip ${chipCls}">${esc(chipText)}</span></div>
      <p style="font-size:12.5px;color:var(--text-sub);margin:0 0 8px">마지막 수집 ${esc(lastCollectedText(m.yesterdayState))}
        · 오늘 누적과 합치지 않은 별도 값이에요</p>
      ${body}
      ${channelTable(d)}
    </div>`;
  }

  /** 2026-09-29 대시보드 '실시간 매출' 카드(전체 폭). 오늘 누적(잠정)이 주인공이고, 전일은 한 줄 요약 + 펼치는 채널표.
   *  아래 '매출 요약'(로켓그로스만·최신 수집일·이번 달)과 겹치지 않게 여기서는 *판매자배송 포함 합계*와 채널별 값만
   *  보여 주고, 로켓그로스 값은 같은 공통 집계라 매출 요약과 같다고 밝혀요. 버튼: 수집(기존 확인창) · 화면 새로고침(읽기). */
  function dashboardHtml(m, { today, yesterday, refreshButton = "", statusLine = "", at = null } = {}) {
    const d = m.today;
    const y = m.yesterday;
    const t = d.total;
    const [chipCls, chipText] = CONFIRM_LABEL[y.confirm] || CONFIRM_LABEL.UNKNOWN;
    const reread = `<button type="button" class="btn sm secondary" onclick="dashboardRefresh()" title="저장된 값을 다시 읽어요(WING 수집·저장 없음)">화면 새로고침</button>`;
    const hm = at ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false }).format(at) : "";
    const todayBody = d.rgCollected ? `<div class="grid-stats">
        ${stat("오늘 누적 순매출", won(t.net_amount), `로켓그로스 ${won(d.rg.net_amount)} · 그 외 ${won(d.mp.net_amount)}`, "blue")}
        ${stat("판매 수량", ea(t.net_qty), "순 판매수량(취소·반품 제외)")}
        ${stat("주문 건수", d.mp.has_rows ? cnt(d.mp.order_count) : "—", "판매자배송 등만 · 로켓그로스 미제공")}
        ${stat("취소·반품", won(t.cancel_amount), ea(t.cancel_qty), "amber")}
        ${stat("마지막 수집", esc(lastCollectedText(m.todayState)), "로켓그로스 판매통계")}
      </div>`
      : `<div role="status" class="live-empty" style="background:#f8f9fb;border:1px solid var(--line,#e5e7eb);border-radius:9px;padding:10px 12px;margin:4px 0 10px">
          <b>오늘(${esc(today)}) 로켓그로스 판매통계 미수집 — 0원이 아니에요.</b>
          <div style="font-size:12.5px;color:var(--text-sub);margin-top:3px">06:20 통합수집은 전날 판매만 받아요. 오늘 누적은 'WING 판매데이터 다시 수집'을 눌렀을 때만 들어와요
            · 마지막 수집: ${esc(lastCollectedText(m.todayState))}</div></div>`;
    const yt = y.total;
    const ydLine = y.rgCollected
      ? `<b>${won(yt.net_amount)}</b> <span class="dash-sub">(로켓그로스 ${won(y.rg.net_amount)} · 그 외 ${won(y.mp.net_amount)})</span>
         · ${ea(yt.net_qty)} · 주문 ${y.mp.has_rows ? cnt(y.mp.order_count) : "—"}(판매자배송 등) · 취소·반품 ${won(yt.cancel_amount)} (${ea(yt.cancel_qty)})`
      : `<b>미수집</b> <span class="dash-sub">0원 아님</span>`;
    return `<section class="card" id="dash-live" style="margin:0 0 14px">
      <div class="card-head"><h2>실시간 매출 <span style="font-size:12px;font-weight:400;color:var(--text-sub)">오늘 ${esc(today)} · 진행 중 · 잠정${hm ? ` · 화면 ${esc(hm)}` : ""}</span></h2>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">${refreshButton}${reread}</div></div>
      ${statusLine}
      ${todayBody}
      <details class="live-detail" open><summary style="cursor:pointer;font-size:13px;font-weight:600;margin:4px 0">오늘 채널별</summary>${channelTable(d)}</details>
      <div class="live-yday" id="dash-live-yesterday" style="border-top:1px solid var(--line,#e5e7eb);margin-top:10px;padding-top:10px;font-size:13.5px">
        <span style="font-weight:600">전일 ${esc(yesterday)}</span> <span class="chip ${chipCls}">${esc(chipText)}</span>
        · ${ydLine}
        <div style="font-size:12px;color:var(--text-sub);margin-top:3px">마지막 수집 ${esc(lastCollectedText(m.yesterdayState))} · 오늘 누적과 합치지 않은 별도 값 ·
          로켓그로스 값은 아래 '매출 요약'과 같은 공통 집계(매출 요약은 로켓그로스만, 여기는 판매자배송 포함 합계)</div>
        <details class="live-detail"><summary style="cursor:pointer;font-size:12.5px;margin-top:6px">전일 채널별 표</summary>${channelTable(y)}</details>
      </div>
      <p style="font-size:11.5px;color:var(--text-sub);margin:8px 0 0">오늘 값은 하루가 끝나지 않아 계속 바뀌는 <b>잠정값</b>이에요 · 쿠팡 자체 집계 지연이 있을 수 있어요</p>
    </section>`;
  }

  function viewHtml(m, opts) {
    const reread = `<button type="button" class="btn sm secondary" onclick="route()" title="DB 에 저장된 값을 다시 읽어요(수집·저장 없음)">화면 새로고침</button>`;
    return `<div class="card" style="margin-bottom:14px;padding:10px 14px">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between">
          <span style="font-size:12.5px;color:var(--text-sub)">화면을 연 시각 ${esc(opts.openedAt || "")} · 금액은 매출 입력·대시보드와 같은 공통 집계</span>
          ${reread}</div></div>
      ${todayHtml(m, opts)}
      ${yesterdayHtml(m, opts)}`;
  }

  global.LiveSales = { model, dayModel, confirmState, dayEndMs, nextDate, todayHtml, yesterdayHtml, viewHtml, dashboardHtml };
})(typeof window !== "undefined" ? window : globalThis);
