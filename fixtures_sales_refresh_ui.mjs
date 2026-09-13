// fixtures_sales_refresh_ui.mjs
// 2026-09-10 판매현황 새로고침(매출 입력 · 대시보드) 격리 검증 - 네트워크 없음.
//   · 클릭 1회 = 서버 호출 1회, 연속 클릭은 한 번만
//   · 실행 중 버튼 잠금 + "수집 중…", 끝나면 화면 다시 그리기(DB 재조회)
//   · 실패·만료를 0원으로 그리지 않음, 기존 값 유지 표시
//   · 매출 입력과 대시보드가 같은 공통 집계 값을 씀
//   · 프런트에 비밀값 없음
import fs from "node:fs";

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok && extra !== undefined) console.log("   ", extra);
}

const refreshSrc = fs.readFileSync(new URL("./js/sales_refresh.js", import.meta.url), "utf8");
const summarySrc = fs.readFileSync(new URL("./js/sales_monthly_summary.js", import.meta.url), "utf8");
const appSrc = fs.readFileSync(new URL("./js/app.js", import.meta.url), "utf8");
const indexSrc = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");

// ── 가짜 브라우저 ────────────────────────────────────────────────────────────
function makeEnv({ respond, jwt = "user-jwt" } = {}) {
  const buttons = [
    { dataset: { date: "2026-09-10", source: "sales", label: "판매현황 새로고침" }, textContent: "판매현황 새로고침", disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
    { dataset: { date: "2026-09-10", source: "dashboard", label: "새로고침" }, textContent: "새로고침", disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } },
  ];
  const win = {
    fetchCalls: [], routeCalls: 0, toasts: [], busySeen: [],
    sb: { auth: { getSession: async () => ({ data: { session: jwt ? { access_token: jwt } : null } }) } },
    toast(m) { win.toasts.push(m); },
    async route() { win.routeCalls += 1; },
  };
  const g = globalThis;
  g.document = { querySelectorAll: () => buttons };
  g.fetch = async (url, opt = {}) => {
    win.fetchCalls.push({ url, opt });
    win.busySeen.push(buttons.map(b => [b.disabled, b.textContent]));
    await new Promise(r => setTimeout(r, 30));
    return respond(url, opt);
  };
  new Function("window", refreshSrc)(win);
  new Function("window", summarySrc)(win);
  return { win, buttons, R: win.SalesRefresh };
}
const json = (status, body) => ({ status, json: async () => body });

// ── 1. 클릭 1회 = 호출 1회, 중복 클릭 차단 ─────────────────────────────────
{
  const { win, buttons, R } = makeEnv({
    respond: () => json(200, { status: "UPDATED", ok: true, changed: true, sales_date: "2026-09-10",
      collected_at: "2026-09-10T23:55:03+09:00", net_amount: 250620, net_qty: 20, message: "교체" }),
  });
  const p1 = R.click(buttons[0]);
  const p2 = R.click(buttons[0]);          // 연속 클릭
  const p3 = R.click(buttons[1]);          // 다른 화면 버튼도 같이 막힘
  await Promise.all([p1, p2, p3]);
  const refreshCalls = win.fetchCalls.filter(c => c.url.endsWith("/api/sales-statistics/refresh"));
  check(refreshCalls.length === 1, "연속 클릭 3번 → 서버 수집 요청 1번", refreshCalls.length);
  check(win.busySeen[0].every(([d, t]) => d === true && t === "수집 중…"), "요청 중에는 모든 새로고침 버튼 잠금 + '수집 중…'", win.busySeen[0]);
  check(buttons.every(b => b.disabled === false) && buttons[0].textContent === "판매현황 새로고침", "끝나면 버튼 복구");
  check(win.routeCalls === 1, "끝나면 화면 1회 다시 그리기(DB 재조회)", win.routeCalls);
  const c = refreshCalls[0];
  check(c.opt.method === "POST", "POST 로 호출");
  check(c.opt.headers.Authorization === "Bearer user-jwt", "로그인 세션 JWT 로 인증");
  check(c.opt.credentials === "omit", "쿠키를 보내지 않음");
  check(JSON.parse(c.opt.body).date === "2026-09-10" && JSON.parse(c.opt.body).source === "sales", "본문에 날짜·화면만");
  check(c.url.startsWith("https://34-30-248-218.sslip.io/"), "GCP 서버만 호출(WING 직접 호출 없음)", c.url);
  check(!win.fetchCalls.some(x => /coupang\.com/.test(x.url)), "브라우저에서 WING/쿠팡 호출 0회");
  check(win.toasts[0].startsWith("방금 갱신"), "완료 알림 '방금 갱신'", win.toasts);

  // 순차 클릭은 매번 수집
  await R.click(buttons[0]);
  check(win.fetchCalls.filter(x => x.url.endsWith("/refresh")).length === 2, "끝난 뒤 다시 누르면 다시 수집");
}

// ── 2. 실패 응답들 ──────────────────────────────────────────────────────────
{
  const { R } = makeEnv({ respond: () => json(401, { detail: "인증이 필요해요." }) });
  const r = await R.requestRefresh("2026-09-10", "sales");
  check(r.status === "AUTH" && /로그인/.test(r.message), "401 → 다시 로그인 안내");
}
{
  const { R } = makeEnv({ respond: () => json(409, { status: "IN_PROGRESS", ok: false, message: "타이머 재수집이 진행 중이에요" }) });
  const r = await R.requestRefresh("2026-09-10", "sales");
  check(r.status === "IN_PROGRESS", "409 → 진행 중 안내 그대로");
}
{
  const { R } = makeEnv({ respond: () => { throw new TypeError("Failed to fetch"); } });
  const r = await R.requestRefresh("2026-09-10", "sales");
  check(r.status === "FAILED" && r.keep_existing && /기존 매출은 그대로/.test(r.message), "네트워크 오류 → 실패 + 기존 유지");
}
{
  const { R } = makeEnv({ jwt: null, respond: () => json(200, {}) });
  const r = await R.requestRefresh("2026-09-10", "sales");
  check(r.status === "AUTH", "세션 없으면 호출하지 않음");
}

// ── 3. 상태 줄: 0원 금지 · 기존 유지 · 변경 없음 · KST ─────────────────────
{
  const { R } = makeEnv({ respond: () => json(200, {}) });
  const hist = (rows) => R.summarizeHistory("2026-09-09", rows);
  const okRow = { collected_at: "2026-09-10T05:30:46+00:00", status: "OK", outcome: "REPLACED" };
  const unch = { collected_at: "2026-09-10T14:55:00+00:00", status: "OK", outcome: "UNCHANGED" };
  const fail = { collected_at: "2026-09-10T15:00:00+00:00", status: "DATA_CHECK_NEEDED", outcome: "DATA_CHECK_NEEDED",
    error: "SESSION_EXPIRED: 인증 쿠키가 만료 - 맥에서 세션 갱신 1회: python3 '/Users/x/refresh_wing_session.py'" };

  let h = R.statusLineHtml({ date: "2026-09-09", state: hist([unch, okRow]), hasData: true, today: "2026-09-10" });
  check(h.includes("WING에서 현재 조회 가능한 최신값"), "‘WING에서 현재 조회 가능한 최신값’ 표시");
  check(h.includes("데이터 기준일 <b>2026-09-09</b> (오늘 아님)"), "데이터 기준일과 오늘 아님 표시");
  check(h.includes("23:55 KST") && h.includes("변경 없음"), "마지막 수집(확인) 시각 KST + 변경 없음", h);
  check(h.includes("값이 바뀐 시각") && h.includes("14:30 KST"), "값이 바뀐 시각을 따로 표시(시각만 바꾸지 않음)", h);

  h = R.statusLineHtml({ date: "2026-09-09", state: hist([fail, okRow]), hasData: true, today: "2026-09-10" });
  check(h.includes("최신 데이터 확인 필요"), "마지막 시도 실패 + 저장값 있음 → '최신 데이터 확인 필요'");
  check(h.includes("WING 세션 만료") && h.includes("기존 값을 그대로"), "실패 사유 + 기존 값 유지 안내", h);
  check(!h.includes("python3") && !h.includes("/Users/"), "내부 경로·명령은 화면에 안 보임");

  h = R.statusLineHtml({ date: "2026-09-10", state: hist([fail]), hasData: false, today: "2026-09-10" });
  check(h.includes("수집 실패") && h.includes("0원 아님"), "저장값 없는 실패 → '수집 실패', 0원 아님");
  check(!/₩0\b/.test(h), "상태 줄에 ₩0 없음");

  const noRows = { collected_at: "2026-09-10T15:10:00+00:00", status: "DATA_CHECK_NEEDED", error: "SalesStatisticsFormatError: 옵션 행이 하나도 없어요 - 빈 스냅샷을 0원으로 발행하지 않습니다." };
  h = R.statusLineHtml({ date: "2026-09-11", state: R.summarizeHistory("2026-09-11", [noRows]), hasData: false, today: "2026-09-11" });
  check(h.includes("수집 대기") && !h.includes("수집 실패"), "WING 에 아직 판매 행 없음 → '수집 대기'(실패 아님)", h);
  check(h.includes("0원으로 저장하지 않음"), "판매 행 없음 안내");
}

// ── 3-B. 오늘 판매 행 없음 → 서버가 어제를 받은 경우 ────────────────────────
{
  const { win, buttons, R } = makeEnv({
    respond: () => json(200, { status: "UPDATED", ok: true, changed: true, sales_date: "2026-09-10",
      fallback_from: { sales_date: "2026-09-11", status: "NO_ROWS", message: "WING 판매통계에 아직 2026-09-11 판매 행이 없어요." },
      message: "2026-09-11은 WING에 아직 판매 행이 없어 최신 판매일 2026-09-10을 받았어요 · 교체" }),
  });
  buttons[0].dataset.date = "2026-09-11";
  await R.click(buttons[0]);
  check(R._lastResults["2026-09-10"].status === "UPDATED", "받은 날짜(어제)에 '방금 갱신'");
  check(R._lastResults["2026-09-11"].status === "NO_ROWS", "오늘 쪽에는 '판매 행 없음' 기록");
  const card = R.todayCardHtml({ day: null, date: "2026-09-10", today: "2026-09-11", state: R.summarizeHistory("2026-09-10", []),
    todayState: R.summarizeHistory("2026-09-11", []) });
  check(card.includes("오늘(2026-09-11) 수집") && card.includes("판매 행이 없어요"), "대시보드 카드에 오늘 판매 행 없음 안내");
  check(win.fetchCalls.filter(c => c.url.endsWith("/refresh")).length === 1, "대체 수집도 클릭 1회 = 요청 1회");
}

// ── 3-C. 세션 상태 배너 (2026-09-11: 세션 갱신 필요 + 마지막 정상 수집 시각) ─────
{
  const { R } = makeEnv({ respond: () => json(200, {}) });
  const st = R.summarizeHistory("2026-09-11", []);
  const last = "2026-09-10T15:40:00+00:00";                    // = 09-11 00:40 KST
  let h = R.statusLineHtml({ date: "2026-09-11", state: st, hasData: true, today: "2026-09-11",
    health: { last_success_at: last, session: { state: "SESSION_EXPIRED", needs_renewal: true, warning: false,
      message: "세션 갱신 필요 - WING 세션이 만료돼 수집을 멈췄어요. 기존 매출은 그대로 유지됩니다." } } });
  check(h.includes("세션 갱신 필요") && h.includes('role="alert"'), "만료 → '세션 갱신 필요' 경고 배너", h.slice(0, 200));
  check(h.includes("마지막 정상 수집 09. 11. 00:40 KST"), "마지막 정상 수집 시각(KST) 표시", h.slice(0, 400));
  check(h.includes("0원 아님"), "저장하지 않아도 0원이 아님을 안내");
  h = R.statusLineHtml({ date: "2026-09-11", state: st, hasData: true, today: "2026-09-11",
    health: { last_success_at: last, session: { state: "OK", hours_left: 8, needs_renewal: false, warning: true,
      message: "세션 자동 연장이 2회 연속 실패했어요(AUTH_BLOCKED). 아직 8시간 남아 수집은 가능합니다." } } });
  check(h.includes("연속 실패") && !h.includes("세션 갱신 필요"), "연장 실패지만 여유 있음 → 주의 문구(갱신 필요 아님)");
  // 2026-09-13: 쿠키 남은 시간만으로 '정상'이라 쓰지 않아요 - 실제 인증(AUTH_OK)과 쿠키(참고)를 따로.
  h = R.statusLineHtml({ date: "2026-09-11", state: st, hasData: true, today: "2026-09-11",
    health: { last_success_at: last, session: { state: "AUTH_OK", level: "ok", hours_left: 11.94,
      cookie: { hours_left: 11.94 }, auth: { state: "AUTH_OK", checked_at: "2026-09-12T23:51:03+00:00", stale: false } } } });
  check(h.includes("WING 실제 인증 정상 (09. 13. 08:51 KST 확인) · 쿠키 11.9시간 남음(참고)") && !h.includes("sales-session-banner"),
    "정상 → 실제 인증과 쿠키를 나눈 짧은 상태만", h.slice(-400));
  h = R.statusLineHtml({ date: "2026-09-11", state: st, hasData: true, today: "2026-09-11",
    health: { last_success_at: last, session: { state: "AUTH_OK", level: "ok", cookie: { hours_left: 11.9 },
      auth: { state: "AUTH_OK", checked_at: "2026-09-12T23:51:03+00:00", stale: false },
      next_collection: { risk: "OK", login_age_at_collection_hours: 22.0 } } } });
  check(h.includes("다음 06:20 수집 가능(추정)(로그인 후 22시간 · 약 24시간 추정 기준)"), "정상일 때도 다음 06:20 예측 표시(추정)", h.slice(-300));
  h = R.statusLineHtml({ date: "2026-09-11", state: st, hasData: true, today: "2026-09-11",
    health: { last_success_at: last, session: { state: "OK", hours_left: 11.94, needs_renewal: false, warning: false } } });
  check(!h.includes("세션 정상") && !h.includes("인증 정상") && h.includes("쿠키 11.9시간 남음(참고)"),
    "*** 쿠키 시간만 있는 응답은 '정상'으로 표시하지 않음 ***", h.slice(-300));
  h = R.statusLineHtml({ date: "2026-09-11", state: st, hasData: true, today: "2026-09-11", health: null });
  check(!h.includes("sales-session-banner"), "세션 상태를 못 읽으면 배너 없이 기존 표시");
  const card = R.todayCardHtml({ day: null, date: "2026-09-11", today: "2026-09-11", state: st,
    health: { last_success_at: last, session: { state: "NO_SESSION", needs_renewal: true, message: "세션 갱신 필요" } } });
  check(card.includes("세션 갱신 필요"), "대시보드 카드에도 같은 배너");
}

// ── 3-E. ERP 상단 WING 세션 경고 (2026-09-13) ─────────────────────────────────
{
  const { R } = makeEnv({ respond: () => json(200, {}) });
  const alertS = {
    state: "SESSION_EXPIRED", level: "alert", needs_login: true,
    message: "WING 로그인 필요 - 실제 인증이 실패했어요(쿠키는 10.8시간 남아 있지만 쿠키 시간과 무관).",
    action_hint: "맥에서 WING 로그인 갱신을 실행해 로그인·SMS 인증을 마쳐 주세요. 실제 인증·다운로드 확인이 끝나면 이 경고는 자동으로 사라져요.",
    cookie: { hours_left: 10.8 },
    auth: { state: "SESSION_EXPIRED", last_ok_at: "2026-09-12T10:40:05+00:00", last_ok_source: "keepalive" },
    keepalive: { last_success_at: "2026-09-12T08:50:33+00:00", last_failure_at: "2026-09-12T11:51:00+00:00", consecutive_failures: 1 },
    next_collection: { at: "2026-09-12T21:20:00+00:00", risk: "EXPIRED", recommended_login_after: "2026-09-12T22:20:00+00:00" },
    login: { known: true, login_at: "2026-09-11T10:21:00+00:00" },
  };
  const h = R.topBannerHtml(alertS);
  check(h.includes("WING 로그인 필요") && h.includes('role="alert"'), "상단: 로그인 필요(빨강)", h.slice(0, 200));
  check(h.includes("마지막 실제 인증 성공(AUTH_OK) 09. 12. 19:40 KST"), "상단: 마지막 실제 AUTH_OK 시각", h);
  check(h.includes("마지막 성공 09. 12. 17:50 KST") && h.includes("마지막 실패 09. 12. 20:51 KST"), "상단: keepalive 마지막 성공·실패 시각");
  check(h.includes("다음 06:20 수집(09. 13. 06:20 KST): 불가"), "상단: 다음 06:20 수집 위험 여부");
  check(h.includes("맥에서 WING 로그인 갱신") && h.includes("자동으로 사라져요"), "상단: 맥 로그인 갱신 안내 · 자동 해제 안내");
  check(h.includes("쿠키 10.8시간 남음(참고 - 쿠키만으로 정상 판단 안 함)"), "상단: 쿠키 시간은 참고로만");
  check(!/\/Users\/|python3|refresh_wing|\.py/.test(h), "상단: 명령·경로 노출 없음");
  check((h.match(/WING 로그인 필요/g) || []).length === 1, "상단: 제목과 문구가 같은 말을 두 번 쓰지 않음", h.slice(0, 300));
  check(R.topBannerHtml({ ...alertS, next_collection: { ...alertS.next_collection, login_now_covers_next: true } })
    .includes("지금 로그인하면 다음 06:20 수집까지 유지될 것으로 추정"), "상단: 지금 로그인하면 다음 수집까지 유지(추정) 안내");
  check(h.includes("09. 13. 07:20 KST 이후 로그인을 권장"), "상단: 아직 이르면 권장 로그인 시각 안내");
  const line = R.statusLineHtml({ date: "2026-09-11", state: R.summarizeHistory("2026-09-11", []), hasData: true, today: "2026-09-11",
    health: { last_success_at: null, session: { ...alertS, auth: { ...alertS.auth, label: "실제 인증 실패(로그인 필요)" } } } });
  check(line.includes("WING 실제 인증 실패(로그인 필요) · 쿠키 10.8시간 남음(참고)") && !line.includes("실제 인증 실제 인증"),
    "카드: 실제 인증 실패와 쿠키 시간을 나눠 표시", line.slice(-300));
  const w = R.topBannerHtml({ ...alertS, level: "warn", state: "AUTH_OK", action_hint: "맥에서 WING 로그인 갱신을 실행해 주세요.",
    message: "확인 필요 - 로그인 기준 시각을 확인할 수 없어 다음 06:20 수집 가능 여부를 계산하지 못했어요.",
    next_collection: { at: "2026-09-13T21:20:00+00:00", risk: "UNKNOWN" }, login: { known: false } });
  check(w.includes("WING 세션 확인 필요") && w.includes('role="status"') && w.includes("로그인 기준 시각 확인 필요"), "상단: 확인 필요(주황)");
  check(R.topBannerHtml({ ...alertS, level: "ok" }) === "" && R.topBannerHtml(null) === "", "정상·응답 없음 → 상단 경고 없음");

  // 화면 요소에 그리기 · 로그인 후 실제 인증 성공이면 자동 해제
  const el = { innerHTML: "", hidden: true };
  let body = { running: false, session: alertS };
  globalThis.document = { querySelectorAll: () => [], getElementById: (id) => (id === "wing-session-banner" ? el : null) };
  globalThis.fetch = async (url) => ({ ok: true, json: async () => body, url });
  await R.renderTopBanner({ force: true });
  check(!el.hidden && el.innerHTML.includes("WING 로그인 필요"), "상단 영역 표시");
  body = { running: false, session: { ...alertS, state: "AUTH_OK", level: "ok", needs_login: false } };
  await R.renderTopBanner();
  check(!el.hidden, "1분 캐시 안에는 다시 부르지 않음");
  await R.renderTopBanner({ force: true });
  check(el.hidden && el.innerHTML === "", "실제 인증 성공 응답 → 경고 자동 해제(영역 숨김)");
  globalThis.fetch = async () => { throw new Error("offline"); };
  await R.renderTopBanner({ force: true });
  check(el.hidden, "상태를 못 읽으면 경고를 지어내지 않음");
  check(indexSrc.indexOf('id="wing-session-banner"') > indexSrc.indexOf("</header>") &&
    indexSrc.indexOf('id="wing-session-banner"') < indexSrc.indexOf('id="content"'), "index.html: 상단(헤더 아래·본문 위)에 경고 영역");
  const routeBody = appSrc.slice(appSrc.indexOf("async function route()"), appSrc.indexOf("const seq = ++routeSeq;"));
  check(routeBody.includes("renderTopBanner"), "모든 화면 이동 때 상단 경고 갱신");
}

// ── 3-D. 정산 대사 표시 (NOT_COMPARED 는 오류·0원이 아님) ────────────────────
{
  const { R } = makeEnv({ respond: () => json(200, {}) });
  const nc = R.reconSummary([{ reconciliation_status: "NOT_COMPARED" }, { reconciliation_status: "NOT_COMPARED" }]);
  check(nc.status === "NOT_COMPARED", "정산 없음 → NOT_COMPARED");
  const t = R.reconText(nc);
  check(t.includes("비교 전") && t.includes("판매통계 기준 그대로") && !/오류|실패|₩0/.test(t), "NOT_COMPARED 문구: 비교 전 · 오류·0원 아님", t);
  const mm = R.reconSummary([{ reconciliation_status: "MATCH" },
    { reconciliation_status: "RECONCILIATION_MISMATCH", reconciliation_qty_diff: -1, reconciliation_amount_diff: -11900 }]);
  const tm = R.reconText(mm);
  check(mm.status === "RECONCILIATION_MISMATCH" && tm.includes("-1개") && tm.includes("임의 보정 없음"), "차이: 기록만 · 보정 없음", tm);
  check(R.reconText(R.reconSummary([{ reconciliation_status: "MATCH" }])).includes("일치"), "MATCH → 일치");
  const st = { ...R.summarizeHistory("2026-09-10", []), recon: nc };
  const line = R.statusLineHtml({ date: "2026-09-10", state: st, hasData: true, today: "2026-09-11" });
  check(line.includes("정산 대사: 비교 전"), "상태 줄에 대사 상태 표시");
  const lineNoData = R.statusLineHtml({ date: "2026-09-11", state: st, hasData: false, today: "2026-09-11" });
  check(!lineNoData.includes("정산 대사"), "값이 없는 날엔 대사 문구를 붙이지 않음");
}

// ── 4. 대시보드 카드 / 매출 입력 값 일치 (같은 공통 집계) ─────────────────
{
  const { win, R } = makeEnv({ respond: () => json(200, {}) });
  const S = win.SalesMonthlySummary;
  const stats = [
    { sales_date: "2026-09-10", channel: "쿠팡 로켓그로스", option_id: "A", product_id: "P1", product_name: "휴지통", gross_qty: 15, gross_amount: 178500, cancel_qty: 4, cancel_amount: 47600, net_qty: 11, net_amount: 130900 },
    { sales_date: "2026-09-10", channel: "쿠팡 로켓그로스", option_id: "B", product_id: null, product_name: "미매핑 옵션", gross_qty: 12, gross_amount: 193700, cancel_qty: 3, cancel_amount: 73980, net_qty: 9, net_amount: 119720 },
  ];
  const sales = [
    { id: "rg", date: "2026-09-10", channel: "쿠팡 로켓그로스", product_id: "P1", qty: 99, amount: 9999999 },   // 주문 원장 - RG 에 쓰면 안 됨
    { id: "mp", date: "2026-09-10", channel: "쿠팡 판매자배송", product_id: "P3", qty: 2, amount: 30000 },
  ];
  const adjustments = [{ id: "adj", date: "2026-09-10", channel: "쿠팡 로켓그로스", qty: 5, used_amount: 50000 }]; // returnRequests - RG 에 다시 빼면 안 됨
  const summary = S.build({ month: "2026-09", statisticsRows: stats, salesRows: sales, adjustmentRows: adjustments });
  const rgDay = S.forDate(summary, "2026-09-10", { rgOnly: true });
  const allDay = S.forDate(summary, "2026-09-10");
  check(rgDay.net_amount === 250620 && rgDay.net_qty === 20, "RG 순매출 = 판매통계 NET 합(미매핑 포함)", rgDay);
  check(rgDay.gross_amount - rgDay.cancel_amount === rgDay.net_amount, "항등식 순 = 전체 − 취소·반품");
  check(rgDay.cancel_amount === 121580, "RG 취소·반품 = 판매통계 '총 취소' 그대로(조정 이중 차감 없음)", rgDay.cancel_amount);
  check(allDay.net_amount === 280620, "rgOnly 없으면 판매자배송까지 합계(기존 동작 유지)", allDay.net_amount);

  const card = R.todayCardHtml({ day: rgDay, date: "2026-09-10", today: "2026-09-10", state: R.summarizeHistory("2026-09-10", []) });
  const line = R.dayLineHtml(rgDay, "2026-09-10");
  for (const v of ["₩250,620", "20개", "₩372,200", "27개", "₩121,580", "7개"]) {
    check(card.includes(v) && line.includes(v), `대시보드 카드와 매출 입력 줄이 같은 값 ${v}`);
  }
  check(card.includes("오늘 로켓그로스 판매현황") && card.includes("js-sales-refresh"), "카드 제목 + 새로고침 버튼");
  check(card.includes('data-source="dashboard"') && card.includes('data-date="2026-09-10"'), "카드 버튼은 오늘 날짜로 같은 API");

  const empty = R.todayCardHtml({ day: null, date: "2026-09-10", today: "2026-09-10", state: R.summarizeHistory("2026-09-10", []) });
  check(!empty.includes("₩0") && empty.includes("미수집"), "오늘 값 없음 → ₩0 아니라 미수집");

  const noToday = R.todayCardHtml({ day: S.forDate(summary, "2026-09-10", { rgOnly: true }), date: "2026-09-09", today: "2026-09-11",
    state: R.summarizeHistory("2026-09-09", []),
    todayState: R.summarizeHistory("2026-09-11", [{ collected_at: "2026-09-10T15:10:00+00:00", status: "DATA_CHECK_NEEDED", error: "SalesStatisticsFormatError: 옵션 행이 하나도 없어요 - 빈 스냅샷을 0원으로 발행하지 않습니다." }]) });
  check(noToday.includes("(오늘 아님)") && noToday.includes("WING에 아직 판매 행 없음"), "오늘 값 없을 때 기준일 명시 + 오늘 시도 실패 사유");
}

// ── 5. 화면 배선 · 자동 수집 상태 카드 숨김 · 비밀값 ────────────────────────
{
  const body = (from, to) => { const s = appSrc.indexOf(from); const e = appSrc.indexOf(to, s + from.length); return appSrc.slice(s, e); };
  const dash = body("async function viewDashboard()", "/* ---------- 문서 목록");
  const sales = body("async function viewSales()", "function addSaleRow()");
  check(!/await\s+renderSyncHealthCard\(\)/.test(dash) && !dash.includes("${syncHealthHtml}"), "대시보드에서 '자동 수집 상태' 카드 호출 제거");
  check(appSrc.includes("async function renderSyncHealthCard()") && appSrc.includes("async function viewUnmatchedSales()"), "자동 수집 상태 기능·누락 매출 화면은 남김");
  check(dash.includes("todayCardHtml") && dash.includes("{ rgOnly: true }"), "대시보드는 공통 집계로 오늘 RG 카드");
  check(dash.indexOf("${teamHtml}") < dash.indexOf("${todaySalesHtml}") && dash.indexOf("${todaySalesHtml}") < dash.indexOf("rg-sales-statistics-mount"), "카드는 자동 수집 상태가 있던 자리");
  const head = sales.slice(sales.indexOf("<h2>매출 내역"), sales.indexOf("${refreshHtml}"));
  check(head.includes("SalesRefresh.buttonHtml") && head.indexOf("buttonHtml") < head.indexOf("</h2>"), "‘매출 내역’ 제목 옆 새로고침 버튼");
  check(sales.includes("monthlySalesRowsHtml(monthlySummary)"), "상품별·날짜별 집계 행 유지(주문 단건 나열로 되돌리지 않음)");
  check(indexSrc.indexOf("sales_refresh.js") > -1 && indexSrc.indexOf("sales_refresh.js") < indexSrc.indexOf("js/app.js"), "index.html 에 모듈 등록(app.js 앞)");
  const un = body("async function viewUnmatchedSales()", "/* ---------- 리뷰");
  check(un.includes("${UNMATCHED_BASIS_NOTE}") && appSrc.includes("미매핑 옵션도 <b>이미 포함</b>"), "누락 화면: 로켓그로스는 총계에 포함됨을 명시");
  check(/PGRST205\|Could not find the table/.test(un) && un.includes("누락이 없다는 뜻이 아니며"), "누락 화면: 테이블 미적용을 오류·'누락 없음'으로 오인하지 않게");
  check(un.includes('"rocket_growth"') && un.includes("isRgRow"), "누락 화면: 내부 코드 rocket_growth 도 로켓그로스로 인식");
  check(!/net_amount\s*[-+]=/.test(un), "누락 화면: 총계를 더하거나 빼지 않음");
  for (const bad of ["sb_secret", "service_role", "SUPABASE_SECRET", "wing_session", "KEYCLOAK", "JSESSIONID"]) {
    check(!refreshSrc.includes(bad), `프런트 모듈에 '${bad}' 없음`);
  }
}

console.log(failures ? `=== 결과: ${failures}건 실패 ===` : "=== 결과: 전체 통과 ===");
process.exit(failures ? 1 : 0);
