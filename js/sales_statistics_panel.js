/* sales_statistics_panel.js
 * -------------------------------------------------------------------------
 * 2026-09-10 [사용자 지시: "로켓그로스 매출 화면과 오전 매출 브리핑은
 * sales_daily_statistics.net_qty, net_amount 를 사용", "화면에서 기준을
 * `쿠팡 판매통계 순매출`로 명시", "미매핑 옵션도 옵션명과 쿠팡 옵션 ID로 표시"]
 *
 * *** app.js를 전혀 건드리지 않는 독립 모듈입니다. ***
 * app.js에는 아직 올리지 않은 EPP 적재 UI 505줄이 보류 중이라, 매출·반품
 * 변경분만 따로 떼어낼 수 있게 별도 파일로 뒀어요. 되돌릴 때도 이 파일과
 * index.html의 <script> 한 줄만 지우면 됩니다.
 *
 * 붙이는 법 - app.js 변경은 *마크업 한 줄*뿐입니다:
 *   index.html : <script src="js/sales_statistics_panel.js?v=1"></script>  (app.js 다음)
 *   app.js     : viewSales()의 `${briefingHtml}` 를
 *                `<div id="${MOUNT_ID}">${briefingHtml}</div>` 로 감싸기
 * 그 다음은 이 파일이 알아서 해요(autoMount가 DOM에 마운트 지점이 나타나는 걸
 * 감시했다가 붙습니다). 되돌릴 때는 이 두 줄만 원복하면 원래 화면 그대로예요.
 *
 * *** 중복 집계 방지 ***: 마운트에 성공하면 그 안에 있던 기존 브리핑 카드를
 * 치웁니다. 기준이 다른 두 집계(옛 sales−adjustments vs 판매통계 NET)가 한
 * 화면에 같이 보이면 어느 쪽이 맞는지 알 수 없어요.
 *
 * 백엔드: erp_sales_statistics_api.register_routes()가 등록하는 읽기 전용 2개
 *     GET /api/sales-statistics/screen?date=YYYY-MM-DD
 *     GET /api/sales-statistics/briefing?date=YYYY-MM-DD
 */
(function (global) {
  "use strict";

  const API_BASE =
    global.WING_SUBMIT_API_BASE || "https://34-30-248-218.sslip.io";

  const BASIS_LABEL = "쿠팡 판매통계 순매출";
  const MOUNT_ID = "rg-sales-statistics-mount";

  // 화면 상태 - *** 미수집을 0원으로 그리지 않기 위한 분기 ***
  const STATUS_OK = "OK";
  const STATUS_WAITING = "수집 대기";
  const STATUS_DATA_CHECK = "DATA_CHECK_NEEDED";

  /* 스타일도 이 모듈이 들고 있어요 - 기존 CSS 파일을 건드리지 않아야
     매출·반품 변경분만 따로 떼어낼 수 있습니다. 한 번만 주입합니다. */
  const CSS = `
.ss-panel{font-family:inherit;color:#1f2430;margin:8px 0 24px}
.ss-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.ss-head h3{margin:0;font-size:17px;font-weight:700}
.ss-basis-badge{font-size:12px;font-weight:600;color:#1c4f8b;background:#e8f1fb;
  border:1px solid #bcd8f5;border-radius:999px;padding:2px 10px}
.ss-muted{color:#6b7280;font-size:12px}
.ss-foot{margin-top:8px}
.ss-banner{border-radius:8px;padding:10px 12px;margin:8px 0;font-size:13px;line-height:1.55}
.ss-banner strong{display:block;margin-bottom:3px}
.ss-banner-wait{background:#fff8e6;border:1px solid #f0d9a0;color:#7a5b12}
.ss-banner-error{background:#fdecec;border:1px solid #f2c0c0;color:#8c2020}
.ss-banner-warn{background:#fff4e8;border:1px solid #f3cfa4;color:#8a4b12}
.ss-list{margin:4px 0 0;padding-left:18px}
.ss-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:12px 0}
.ss-card{border:1px solid #e3e6ec;border-radius:10px;padding:12px 14px;background:#fff}
.ss-card-main{border-color:#bcd8f5;background:#f7fbff}
.ss-card-cancel .ss-card-value{color:#a13b3b}
.ss-card-label{font-size:12px;color:#6b7280;margin-bottom:4px}
.ss-card-value{font-size:19px;font-weight:700;font-variant-numeric:tabular-nums}
.ss-card-sub{font-size:13px;color:#4b5563;font-variant-numeric:tabular-nums}
.ss-basis{font-size:11px;color:#6b7280;margin-top:5px}
.ss-table{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
.ss-table th,.ss-table td{border-bottom:1px solid #eceef2;padding:9px 8px;text-align:left;vertical-align:top}
.ss-table th{font-size:12px;color:#6b7280;font-weight:600;background:#fafbfc}
.ss-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.ss-strong{font-weight:700}
.ss-row-neg td{background:#fff7f7}
.ss-row-neg .ss-strong{color:#a13b3b}
.ss-name{font-weight:600}
.ss-unit{font-size:12px;color:#4b5563}
.ss-optid{font-size:11px;color:#8b93a1;font-variant-numeric:tabular-nums}
.ss-tag{display:inline-block;font-size:11px;border-radius:4px;padding:1px 6px;margin:4px 4px 0 0}
.ss-tag-unmatched{background:#eef0f4;color:#4b5563;border:1px solid #dcdfe6}
.ss-tag-mismatch{background:#fff4e8;color:#8a4b12;border:1px solid #f3cfa4}
.ss-empty{color:#6b7280;text-align:center;padding:18px}
.ss-brief{font-size:14px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
@media (prefers-color-scheme:dark){
  .ss-panel{color:#e5e7eb}
  .ss-card,.ss-table th{background:#1b1f27;border-color:#2c313b}
  .ss-card-main{background:#16243a;border-color:#2f4a6d}
  .ss-table th,.ss-table td{border-bottom-color:#2c313b}
  .ss-row-neg td{background:#2a1c1c}
  .ss-basis-badge{background:#16243a;border-color:#2f4a6d;color:#9cc4ef}
}`;

  function injectCss() {
    if (typeof document === "undefined") return;
    if (document.getElementById("ss-panel-css")) return;
    const el = document.createElement("style");
    el.id = "ss-panel-css";
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }

  function won(n) {
    if (n == null) return "—";
    return Math.round(n).toLocaleString("ko-KR") + "원";
  }

  // 2026-09-11 [사용자 지시: "최종 갱신 시각은 KST로 표시"] 서버 값(UTC ISO)을 그대로 쓰지 않아요.
  function kstTime(ts) {
    const d = new Date(ts);
    if (isNaN(d)) return String(ts);
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d) + " KST";
  }

  function ea(n) {
    if (n == null) return "—";
    // 순매출은 음수가 정상이에요(반품이 판매보다 많은 날). 부호를 살립니다.
    return n.toLocaleString("ko-KR") + "개";
  }

  /* 수집이 안 됐거나 실패한 날은 숫자를 그리지 않아요.
     0원으로 보이면 "그날 안 팔렸다"로 오해합니다. */
  function statusBanner(payload) {
    const st = payload.display_status;
    if (st === STATUS_OK) return "";
    const rg = payload.rocket_growth || {};
    if (st === STATUS_DATA_CHECK) {
      return `<div class="ss-banner ss-banner-error">
        <strong>판매통계 점검 필요 (DATA_CHECK_NEEDED)</strong>
        <div>수집이 실패해서 매출을 새로 발행하지 않았습니다. 기존 데이터는 그대로 유지됩니다.</div>
        ${rg.collection_error ? `<div class="ss-muted">사유: ${esc(rg.collection_error)}</div>` : ""}
        <div class="ss-muted">WING 판매분석에서 해당 일자를 다시 내려받아 수집 폴더에 넣어주세요.</div>
      </div>`;
    }
    return `<div class="ss-banner ss-banner-wait">
      <strong>판매통계 수집 대기</strong>
      <div>아직 이 날짜의 판매통계가 들어오지 않았습니다. <b>매출 0원이 아니라 미수집</b>입니다.</div>
    </div>`;
  }

  /* 정산자료와 차이가 있어도 매출값은 그대로 두고 경고만 띄웁니다. */
  function reconciliationAlerts(alerts) {
    if (!alerts || !alerts.length) return "";
    const items = alerts
      .map(
        (a) => `<li>정산 대사 차이 <b>${ea(Math.abs(a.qty_diff))} / ${won(
          Math.abs(a.amount_diff)
        )}</b> · 옵션 ${esc(a.option_id)}${
          a.product_name ? ` (${esc(a.product_name)})` : ""
        }</li>`
      )
      .join("");
    return `<div class="ss-banner ss-banner-warn">
      <strong>정산자료와 차이가 있습니다</strong>
      <ul class="ss-list">${items}</ul>
      <div class="ss-muted">매출값은 판매통계 기준 그대로 두었습니다 — 어느 쪽도 임의로 보정하지 않았어요.</div>
    </div>`;
  }

  function summaryCards(payload) {
    const rg = payload.rocket_growth || {};
    const mp = payload.marketplace || {};
    return `<div class="ss-cards">
      <div class="ss-card ss-card-main">
        <div class="ss-card-label">로켓그로스 순매출</div>
        <div class="ss-card-value">${won(rg.net_amount)}</div>
        <div class="ss-card-sub">${ea(rg.net_qty)}</div>
        <div class="ss-basis">기준: ${esc(rg.basis_label || BASIS_LABEL)}</div>
      </div>
      <div class="ss-card">
        <div class="ss-card-label">전체 거래</div>
        <div class="ss-card-value">${won(rg.gross_amount)}</div>
        <div class="ss-card-sub">${ea(rg.gross_qty)}</div>
      </div>
      <div class="ss-card ss-card-cancel">
        <div class="ss-card-label">반품·취소</div>
        <div class="ss-card-value">${won(rg.cancel_amount)}</div>
        <div class="ss-card-sub">${ea(rg.cancel_qty)}</div>
        <div class="ss-basis">판매통계 ‘총 취소’ 열</div>
      </div>
      <div class="ss-card">
        <div class="ss-card-label">마켓플레이스 순매출</div>
        <div class="ss-card-value">${won(mp.net_amount)}</div>
        <div class="ss-card-sub">${ea(mp.net_qty)}</div>
        <div class="ss-basis">기존 계산(주문 − 조정)</div>
      </div>
    </div>`;
  }

  function optionRows(list) {
    if (!list || !list.length) {
      return `<tr><td colspan="6" class="ss-empty">표시할 옵션이 없습니다.</td></tr>`;
    }
    return list
      .map((o) => {
        const unmatched = o.mapping_status === "UNMATCHED";
        const mismatch = o.reconciliation_status === "RECONCILIATION_MISMATCH";
        const neg = o.net_qty < 0;
        return `<tr class="${neg ? "ss-row-neg" : ""}">
          <td>
            <div class="ss-name">${esc(o.product_name || "(이름 없음)")}</div>
            ${o.option_unit ? `<div class="ss-unit">${esc(o.option_unit)}</div>` : ""}
            <div class="ss-optid">쿠팡 옵션 ID ${esc(o.option_id)}</div>
            ${
              unmatched
                ? `<span class="ss-tag ss-tag-unmatched">상품 미매핑</span>`
                : ""
            }
            ${
              mismatch
                ? `<span class="ss-tag ss-tag-mismatch">정산 대사 차이 ${ea(
                    Math.abs(o.reconciliation_qty_diff)
                  )} / ${won(Math.abs(o.reconciliation_amount_diff))}</span>`
                : ""
            }
          </td>
          <td class="ss-num">${ea(o.gross_qty)}</td>
          <td class="ss-num">${won(o.gross_amount)}</td>
          <td class="ss-num">${ea(o.cancel_qty)}</td>
          <td class="ss-num">${won(o.cancel_amount)}</td>
          <td class="ss-num ss-strong">${ea(o.net_qty)}<br>${won(o.net_amount)}</td>
        </tr>`;
      })
      .join("");
  }

  function render(payload) {
    const rg = payload.rocket_growth || {};
    const ready = payload.display_status === STATUS_OK;
    const unmatchedNote =
      ready && rg.unmatched_option_count
        ? `<div class="ss-muted ss-foot">상품 미매핑 ${rg.unmatched_option_count}개 옵션
           (${won(rg.unmatched_net_amount)}) 도 <b>총계에 포함</b>돼 있습니다 —
           매핑 전이라 상품명 대신 쿠팡 옵션 ID로 표시됩니다.</div>`
        : "";
    return `<section class="ss-panel">
      <header class="ss-head">
        <h3>로켓그로스 매출 · ${esc(payload.date)}</h3>
        <div class="ss-basis-badge">${esc(payload.basis_label || BASIS_LABEL)}</div>
        ${
          payload.last_collected_at
            ? `<div class="ss-muted">최근 수집 ${esc(kstTime(payload.last_collected_at))}</div>`
            : ""
        }
      </header>
      ${statusBanner(payload)}
      ${reconciliationAlerts(payload.reconciliation_alerts)}
      ${summaryCards(payload)}
      ${
        ready
          ? `<table class="ss-table">
              <thead><tr>
                <th>옵션</th><th class="ss-num">전체 수량</th><th class="ss-num">전체 금액</th>
                <th class="ss-num">취소 수량</th><th class="ss-num">취소 금액</th>
                <th class="ss-num">순매출</th>
              </tr></thead>
              <tbody>${optionRows(payload.by_option)}</tbody>
            </table>${unmatchedNote}`
          : ""
      }
    </section>`;
  }

  function briefingLine(fig) {
    if (!fig || !fig.ready) {
      return `<div class="ss-banner ss-banner-wait">
        로켓그로스 판매통계 ${esc((fig && fig.display_status) || STATUS_WAITING)}
        — 매출 수치를 발행하지 않았습니다(<b>0원 아님</b>).
      </div>`;
    }
    const alerts = (fig.reconciliation_alerts || [])
      .map(
        (a) =>
          `<span class="ss-tag ss-tag-mismatch">정산 대사 차이 ${ea(
            Math.abs(a.qty_diff)
          )} / ${won(Math.abs(a.amount_diff))}</span>`
      )
      .join("");
    return `<div class="ss-brief">
      <b>${won(fig.net_amount)}</b> · ${ea(fig.net_qty)}
      <span class="ss-basis">기준: ${esc(fig.basis_label || BASIS_LABEL)}</span>
      <span class="ss-muted">반품·취소 ${ea(fig.cancel_qty)} / ${won(
      fig.cancel_amount
    )}</span>
      ${alerts}
    </div>`;
  }

  /* 인증은 *** 로그인한 사용자의 Supabase 세션 JWT *** 를 그대로 씁니다.
     app.js의 fetchInventoryDecisions() 등과 완전히 같은 방식이에요.
     새 비밀값을 프런트에 심지 않기 위해서입니다 - 서버 쓰기용 자격증명은
     브라우저에 절대 오면 안 되고, 서버에서만 씁니다.
     (이 파일에는 비밀값 관련 문자열 자체를 두지 않아 grep 검사가 깨끗합니다) */
  async function sessionJwt() {
    const sb = global.sb || (global.supabase && global.__sbClient);
    if (!sb || !sb.auth || typeof sb.auth.getSession !== "function") return null;
    try {
      const { data } = await sb.auth.getSession();
      return (data && data.session && data.session.access_token) || null;
    } catch (e) {
      return null;
    }
  }

  async function fetchJson(path) {
    const jwt = await sessionJwt();
    if (!jwt) throw new Error("로그인 세션이 없어요.");
    const res = await fetch(`${API_BASE}${path}`, {
      credentials: "omit",
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  async function mount(el, dateStr) {
    if (!el) return null;
    injectCss();
    el.innerHTML = `<div class="ss-muted">판매통계 불러오는 중…</div>`;
    try {
      const payload = await fetchJson(
        `/api/sales-statistics/screen?date=${encodeURIComponent(dateStr)}`
      );
      el.innerHTML = render(payload);
      return payload;
    } catch (e) {
      // 실패를 0원으로 그리지 않아요.
      el.innerHTML = `<div class="ss-banner ss-banner-error">
        <strong>판매통계를 불러오지 못했습니다</strong>
        <div class="ss-muted">${esc(e.message)}</div>
      </div>`;
      return null;
    }
  }

  async function mountBriefing(el, dateStr) {
    if (!el) return null;
    injectCss();
    try {
      const fig = await fetchJson(
        `/api/sales-statistics/briefing?date=${encodeURIComponent(dateStr)}`
      );
      el.innerHTML = briefingLine(fig);
      return fig;
    } catch (e) {
      el.innerHTML = `<div class="ss-muted">브리핑 매출 조회 실패: ${esc(e.message)}</div>`;
      return null;
    }
  }

  /* app.js가 만든 마운트 지점에 붙어요. 그 안에 있던 기존 브리핑 카드는
     기준이 다른 집계라서 함께 보여주지 않습니다. */
  async function mountInto(node, dateStr) {
    if (!node || node.dataset.ssMounted === "1") return null;
    node.dataset.ssMounted = "1";
    const legacy = node.innerHTML;
    const payload = await mount(node, dateStr);
    if (!payload) {
      // 새 기준을 못 불러왔을 때도 옛 집계를 그대로 되살리지 않아요 - 기준이
      // 다른 숫자를 확정값처럼 보여주는 게 더 위험합니다. 대신 되살릴 수
      // 있도록 원본을 남겨두고 안내만 덧붙입니다.
      node.dataset.ssLegacy = legacy;
      node.insertAdjacentHTML(
        "beforeend",
        `<div class="ss-muted ss-foot">기존 브리핑 카드는 기준이 달라(옛 주문−조정) 함께
         표시하지 않았습니다.</div>`
      );
    }
    return payload;
  }

  function autoMount(getDate) {
    if (typeof document === "undefined") return;
    const pick = () => {
      const node = document.getElementById(MOUNT_ID);
      if (node) mountInto(node, (getDate || defaultDate)());
    };
    pick();
    new MutationObserver(pick).observe(document.body, { childList: true, subtree: true });
  }

  function defaultDate() {
    const d = new Date(Date.now() + 9 * 3600 * 1000 - 86400 * 1000);
    return d.toISOString().slice(0, 10);          // KST 기준 어제
  }

  global.SalesStatisticsPanel = {
    mount,
    mountInto,
    autoMount,
    MOUNT_ID,
    mountBriefing,
    render,
    briefingLine,
    injectCss,
    CSS,
    BASIS_LABEL,
    STATUS_OK,
    STATUS_WAITING,
    STATUS_DATA_CHECK,
  };
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => autoMount());
    } else {
      autoMount();
    }
  }
})(window);
