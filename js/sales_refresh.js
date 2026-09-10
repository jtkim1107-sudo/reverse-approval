/* sales_refresh.js
 * -------------------------------------------------------------------------
 * 2026-09-10 [사용자 지시: "버튼을 누르면 단순히 Supabase 데이터를 다시 읽는
 * 것이 아니라, GCP 백엔드가 WING 판매통계를 즉시 다시 수집해야 한다."]
 *
 * 매출 입력 탭과 대시보드가 *같은* 새로고침을 쓰도록 한곳에 모았어요.
 *
 *   · 브라우저는 WING 을 부르지 않습니다. GCP 의 POST /api/sales-statistics/refresh
 *     하나만 부르고, 인증은 로그인한 사용자의 Supabase 세션 JWT 입니다.
 *     (이 파일에는 비밀값 관련 문자열을 두지 않아요.)
 *   · 수집이 끝나면 화면을 다시 그려서 Supabase 에 저장된 값을 다시 읽어요.
 *     숫자는 전부 SalesMonthlySummary(공통 집계)가 계산하니, 어느 화면에서
 *     새로고침해도 다른 화면과 같은 값이 보입니다.
 *   · 한 번에 하나만 돌아요. 누르는 순간 모든 새로고침 버튼이 잠깁니다.
 *     서버도 파일 잠금으로 한 번 더 막아요(409).
 *   · 실패·세션 만료를 0원으로 그리지 않아요. 기존 값이 있으면 "기존 값 유지"로,
 *     없으면 숫자 대신 "—" 입니다.
 */
(function (global) {
  "use strict";

  const API_BASE = global.WING_SUBMIT_API_BASE || "https://34-30-248-218.sslip.io";
  const DATA_BASIS = "WING에서 현재 조회 가능한 최신값";
  const BTN_CLASS = "js-sales-refresh";
  const REQUEST_TIMEOUT_MS = 75000;       // 서버는 60초 안에 끝내도록 잡혀 있어요
  const JUST_NOW_MS = 90 * 1000;
  // 그날 판매 행이 없다는 서버 원문(파서·DB 함수 모두 "빈 스냅샷"을 포함). 추측 문구 금지.
  const NO_ROWS_RE = /빈 스냅샷|옵션 행이 하나도 없|EMPTY_SNAPSHOT/;

  let inflight = null;                    // 진행 중인 요청(중복 클릭 차단)
  const lastResults = {};                 // 날짜별 이번 페이지에서 받은 마지막 결과

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const won = (n) => (n == null ? "—" : `₩${Math.round(Number(n)).toLocaleString("ko-KR")}`);
  const ea = (n) => (n == null ? "—" : `${Number(n).toLocaleString("ko-KR")}개`);

  function kst(ts, withDate = false) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d)) return String(ts);
    const opt = { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hour12: false };
    if (withDate) Object.assign(opt, { month: "2-digit", day: "2-digit" });
    return `${new Intl.DateTimeFormat("ko-KR", opt).format(d)} KST`;
  }

  /* 서버·이력의 사유 문구를 사람이 읽을 말로. 내부 경로·명령은 보여주지 않아요. */
  function reasonText(error) {
    const e = String(error || "");
    if (!e) return "";
    if (e.startsWith("SESSION_EXPIRED") || e.startsWith("NO_SESSION")) return "WING 세션 만료";
    if (e.startsWith("AUTH_BLOCKED")) return "쿠팡 보안(Akamai) 차단";
    if (e.startsWith("MAPPING_UNAVAILABLE")) return "상품 매핑 조회 실패";
    if (e.startsWith("DOWNLOAD_FAILED")) return "WING 응답 오류";
    if (e.startsWith("APPLY_FAILED")) return "DB 저장 실패(롤백)";
    if (e.startsWith("VERIFY_FAILED")) return "저장 후 검증 실패";
    if (NO_ROWS_RE.test(e)) return "WING에 아직 판매 행 없음";
    return `파일 검증 실패: ${e.split(/맥에서|python3/)[0].slice(0, 80)}`;
  }

  async function sessionJwt() {
    const sb = global.sb;
    if (!sb || !sb.auth || typeof sb.auth.getSession !== "function") return null;
    try {
      const { data } = await sb.auth.getSession();
      return (data && data.session && data.session.access_token) || null;
    } catch (e) {
      return null;
    }
  }

  /* 서버 호출 1회. 예외 대신 항상 {status, message, ...} 를 돌려줘요. */
  async function requestRefresh(date, source) {
    const jwt = await sessionJwt();
    if (!jwt) return { status: "AUTH", ok: false, sales_date: date, message: "로그인 세션이 없어요. 다시 로그인해 주세요." };
    const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS) : null;
    try {
      const res = await fetch(`${API_BASE}/api/sales-statistics/refresh`, {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ date, source }),
        signal: ctrl ? ctrl.signal : undefined,
      });
      let body = null;
      try { body = await res.json(); } catch (e) { body = null; }
      if (res.status === 401) return { status: "AUTH", ok: false, sales_date: date, message: "인증이 만료됐어요. 다시 로그인해 주세요." };
      if (body && body.status) return body;
      if (res.status === 504 || res.status === 502) return timeoutResult(date);
      return { status: "FAILED", ok: false, sales_date: date, keep_existing: true,
        message: `서버 오류(HTTP ${res.status}). 기존 매출은 그대로 유지됩니다.` };
    } catch (e) {
      return e && e.name === "AbortError" ? timeoutResult(date)
        : { status: "FAILED", ok: false, sales_date: date, keep_existing: true,
            message: `서버에 연결하지 못했어요(${esc(e && e.message)}). 기존 매출은 그대로 유지됩니다.` };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function timeoutResult(date) {
    return { status: "TIMEOUT", ok: false, sales_date: date, keep_existing: true,
      message: "서버 응답이 늦어요. 서버에서는 계속 처리됐을 수 있어 끝나면 화면을 다시 불러옵니다." };
  }

  /* 응답이 늦었을 때 서버 수집이 끝날 때까지만 기다려요(최대 60초). */
  async function waitServerIdle() {
    const jwt = await sessionJwt();
    if (!jwt) return;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const res = await fetch(`${API_BASE}/api/sales-statistics/refresh-status`, {
          credentials: "omit", headers: { Authorization: `Bearer ${jwt}` } });
        const st = await res.json();
        if (!st.running) return;
      } catch (e) { return; }
    }
  }

  function setBusy(busy) {
    if (typeof document === "undefined") return;
    document.querySelectorAll(`.${BTN_CLASS}`).forEach((b) => {
      if (!b.dataset.label) b.dataset.label = b.textContent;
      b.disabled = busy;
      b.setAttribute("aria-busy", busy ? "true" : "false");
      b.textContent = busy ? "수집 중…" : b.dataset.label;
    });
  }

  /* 버튼 onclick. 한 번에 하나만 돌고, 끝나면 현재 화면을 다시 그려요. */
  async function click(btn) {
    if (inflight) return inflight;                         // *** 중복 클릭 차단 ***
    const date = btn && btn.dataset ? btn.dataset.date : null;
    const source = btn && btn.dataset ? btn.dataset.source : "";
    setBusy(true);
    inflight = (async () => {
      let res = await requestRefresh(date, source);
      if (res.status === "TIMEOUT") await waitServerIdle();
      lastResults[res.sales_date || date] = { ...res, received_at: Date.now() };
      // 오늘 판매 행이 없어 서버가 최신 판매일(어제)을 받았으면, 오늘 쪽에도 그 사실을 남겨요.
      if (res.fallback_from && res.fallback_from.sales_date) {
        lastResults[res.fallback_from.sales_date] = {
          status: "NO_ROWS", ok: false, sales_date: res.fallback_from.sales_date,
          message: res.fallback_from.message, received_at: Date.now() };
      }
      if (typeof global.toast === "function") global.toast(resultHeadline(res));
      return res;
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
      setBusy(false);
      if (typeof global.route === "function") await global.route();   // DB 에서 다시 읽기
    }
  }

  function isBusy() { return !!inflight; }

  function buttonHtml({ date, source, small = true, label = "판매현황 새로고침" }) {
    return `<button type="button" class="btn ${small ? "sm " : ""}secondary ${BTN_CLASS}"
      data-date="${esc(date)}" data-source="${esc(source)}" data-label="${esc(label)}"
      title="GCP 서버가 쿠팡 WING 판매통계를 지금 다시 받아 옵니다"
      ${inflight ? "disabled aria-busy=\"true\"" : ""}
      onclick="SalesRefresh.click(this)">${inflight ? "수집 중…" : esc(label)}</button>`;
  }

  function resultHeadline(res) {
    switch (res.status) {
      case "UPDATED": return "방금 갱신 · WING 판매통계를 새로 받았어요";
      case "UNCHANGED": return `변경 없음 · 확인 ${kst(res.checked_at || res.collected_at)}`;
      case "IN_PROGRESS": return res.message || "다른 수집이 진행 중이에요";
      default: return res.message || "수집 실패 · 기존 데이터 유지";
    }
  }

  /* 날짜 하나의 수집 이력 → 화면 상태. 이력은 로그인 사용자에게 SELECT 만 열려 있어요. */
  async function loadDayState(date) {
    const sb = global.sb;
    if (!sb || !date) return { date, error: "no-client", rows: [] };
    const { data, error } = await sb.from("sales_statistics_collections")
      .select("collected_at,status,outcome,error,total_net_qty,total_net_amount")
      .eq("sales_date", date).eq("channel", "쿠팡 로켓그로스")
      .order("collected_at", { ascending: false }).limit(20);
    if (error) return { date, error: error.message, rows: [] };
    return summarizeHistory(date, data || []);
  }

  function summarizeHistory(date, rows) {
    const ok = rows.filter((r) => r.status === "OK");
    const content = ok.find((r) => r.outcome !== "UNCHANGED") || null;
    return {
      date, rows,
      latest: rows[0] || null,                    // 성공·실패 포함 가장 최근 시도
      last_check: ok[0] || null,                  // WING 에서 실제로 받은 가장 최근(변경 없음 포함)
      last_change: content,                       // 내용이 바뀐(저장된) 가장 최근
    };
  }

  /* 상태 한 줄. 데이터 기준일과 수집 시각을 분리해서 보여줘요. */
  function statusLineHtml({ date, state, hasData, today }) {
    const res = lastResults[date];
    const fresh = res && Date.now() - res.received_at < JUST_NOW_MS;
    const latest = state && state.latest;
    const lastCheck = state && state.last_check;
    const lastChange = state && state.last_change;
    const failedLatest = latest && latest.status !== "OK";
    // WING 에 그날 판매 행이 아직 없는 건 '실패'가 아니라 '대기'예요(자정 직후 등).
    const noRowsLatest = failedLatest && NO_ROWS_RE.test(latest.error || "");
    const parts = [
      `<span>데이터 기준일 <b>${esc(date)}</b>${today && date !== today ? " (오늘 아님)" : ""}</span>`,
    ];
    if (lastCheck) {
      const unchanged = lastCheck.outcome === "UNCHANGED";
      parts.push(`<span>마지막 수집 ${esc(kst(lastCheck.collected_at, true))}${unchanged ? " · 변경 없음" : ""}</span>`);
      if (unchanged && lastChange) parts.push(`<span>값이 바뀐 시각 ${esc(kst(lastChange.collected_at, true))}</span>`);
    } else if (!failedLatest) {
      parts.push(`<span>수집 기록 없음</span>`);
    }
    let chip;
    if (fresh && res.status === "UPDATED") chip = `<span class="chip approved">방금 갱신</span>`;
    else if (fresh && res.status === "UNCHANGED") chip = `<span class="chip approved">변경 없음 · 확인 ${esc(kst(res.checked_at || res.collected_at))}</span>`;
    else if (!hasData && (noRowsLatest || (fresh && res.status === "NO_ROWS"))) {
      chip = `<span class="chip progress">수집 대기</span>`;
    } else if ((fresh && res && !res.ok && res.status !== "IN_PROGRESS") || failedLatest) {
      chip = hasData ? `<span class="chip progress">최신 데이터 확인 필요</span>`
        : `<span class="chip rejected">수집 실패</span>`;
    } else if (!hasData) chip = `<span class="chip progress">수집 대기</span>`;
    else chip = "";

    let note = "";
    if (fresh && res && !res.ok) {
      note = `<div role="alert" style="font-size:12.5px;margin-top:4px;color:#8a4b12">${esc(res.message || "")}</div>`;
    } else if (noRowsLatest && !hasData) {
      note = `<div style="font-size:12.5px;margin-top:4px;color:var(--text-sub)">
        ${esc(kst(latest.collected_at, true))} 확인 · WING에 아직 이 날짜 판매 행이 없어요(0원으로 저장하지 않음)</div>`;
    } else if (failedLatest) {
      note = `<div role="alert" style="font-size:12.5px;margin-top:4px;color:#8a4b12">
        ${esc(kst(latest.collected_at, true))} 수집 실패 · ${esc(reasonText(latest.error))} ·
        ${hasData ? "기존 값을 그대로 보여주고 있어요" : "표시할 저장값이 없어요(0원 아님)"}</div>`;
    }
    return `<div class="sales-refresh-status" style="font-size:12.5px;color:var(--text-sub);display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center;margin:4px 0 10px">
      ${chip}<span style="font-weight:600">${DATA_BASIS}</span>${parts.join("")}</div>${note}`;
  }

  /* 매출 입력 탭: 새로고침 대상 날짜의 로켓그로스 값 한 줄(공통 집계 값). */
  function dayLineHtml(day, date) {
    if (!day || !day.collected) return "";
    return `<p style="font-size:13px;margin:0 0 10px">
      <b>${esc(date)} 로켓그로스</b> 순매출 <b>${won(day.net_amount)}</b> (${ea(day.net_qty)})
      · 전체 거래 ${won(day.gross_amount)} (${ea(day.gross_qty)})
      · 취소·반품 ${won(day.cancel_amount)} (${ea(day.cancel_qty)})</p>`;
  }

  /* 대시보드 카드. 숫자는 공통 집계(SalesMonthlySummary.forDate)가 준 값만 씁니다. */
  function todayCardHtml({ day, date, today, state, todayState = null, source = "dashboard" }) {
    const has = !!(day && day.collected);
    // 오늘 값이 없어 다른 기준일을 보여줄 때, 오늘 수집을 시도했다가 실패했다면 그것도 알려요.
    let todayNote = "";
    if ((date || today) !== today) {
      const r = lastResults[today];
      const fresh = r && Date.now() - r.received_at < JUST_NOW_MS;
      const lt = todayState && todayState.latest;
      if (fresh && !r.ok) todayNote = `오늘(${today}) 수집: ${r.message || "실패"}`;
      else if (lt && lt.status !== "OK") {
        todayNote = `오늘(${today}) ${kst(lt.collected_at)} 수집 실패 · ${reasonText(lt.error)}`;
      }
    }
    const stat = (label, value, sub, cls = "") => `<div class="stat"><div class="stat-label">${label}</div>
      <div class="stat-value ${cls}">${value}</div>${sub ? `<div style="font-size:12px;color:var(--text-sub)">${sub}</div>` : ""}</div>`;
    const body = has ? `<div class="grid-stats">
        ${stat("순매출", won(day.net_amount), ea(day.net_qty), "blue")}
        ${stat("순 판매수량", ea(day.net_qty), "")}
        ${stat("전체 거래", won(day.gross_amount), ea(day.gross_qty))}
        ${stat("취소·반품", won(day.cancel_amount), ea(day.cancel_qty), "amber")}
      </div>`
      : `<p style="font-size:13.5px;margin:6px 0">${esc(date || today)} 로켓그로스 판매통계가 아직 없어요 — <b>0원이 아니라 미수집</b>입니다.
         새로고침을 누르면 GCP가 WING에서 지금 받아 옵니다.</p>`;
    return `<div class="card" id="rg-today-sales-card" style="margin-bottom:14px">
      <div class="card-head"><h2 style="font-size:15px">오늘 로켓그로스 판매현황</h2>
        ${buttonHtml({ date: today, source, label: "새로고침" })}</div>
      ${statusLineHtml({ date: has ? day.date : (date || today), state, hasData: has, today })}
      ${todayNote ? `<div role="alert" style="font-size:12.5px;margin:-4px 0 8px;color:#8a4b12">${esc(todayNote)}</div>` : ""}
      ${body}
      <p style="font-size:11.5px;color:var(--text-sub);margin:4px 0 0">기준: 쿠팡 판매통계 순매출(전체 거래 − 취소·반품) · 쿠팡 자체 집계 지연이 있을 수 있어요</p>
    </div>`;
  }

  global.SalesRefresh = {
    click, isBusy, buttonHtml, statusLineHtml, todayCardHtml, dayLineHtml, loadDayState,
    summarizeHistory, reasonText, resultHeadline, requestRefresh, kst,
    DATA_BASIS, BTN_CLASS, _lastResults: lastResults,
  };
})(typeof window !== "undefined" ? window : globalThis);
