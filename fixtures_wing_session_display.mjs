// fixtures_wing_session_display.mjs - WING 경고 표시(상단 경고 · 대시보드 운영 상태 · 매출 화면 배너) 검증 - 네트워크·DB 없음
// 2026-09-15 [사용자 지시] 표시만 바꿔요 - 서버 판정·인증·세션 연장·수집은 그대로.
//   1) 지금 인증 정상 + 다음 06:20 위험(AT_RISK) → 빨간 'WING 로그인 필요' 없음, 노란 '다음 06:20 수집 전 로그인 갱신 권장'
//   2) 실제 만료(SESSION_EXPIRED · NO_SESSION) → 빨간 'WING 로그인 필요'
//   3) 정상 안전 → 경고 없음
//   + 대시보드에서는 상단 경고와 운영 경고를 하나로 · 시각은 KST(실행 TZ 와 무관)
import { readFileSync } from "fs";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
let failures = 0;
const check = (ok, label, extra) => {
  if (!ok) failures++;
  console.log(`${ok ? "  OK " : "  FAIL"} ${label}`);
  if (!ok && extra !== undefined) console.log("      ", String(extra).slice(0, 600));
};
const plain = h => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const count = (h, s) => plain(h).split(s).length - 1;

const el = { innerHTML: "", hidden: true };
let apiBody = null;
const ctx = vm.createContext({
  console, Intl, Date, setTimeout, clearTimeout,
  sb: { auth: { getSession: async () => ({ data: { session: { access_token: "jwt" } } }) } },
  fetch: async () => ({ ok: true, json: async () => apiBody }),
  document: { getElementById: id => (id === "wing-session-banner" ? el : null), querySelectorAll: () => [] },
  location: { hash: "#/sales" },
});
vm.runInContext(read("./js/erp_ui.js"), ctx);
vm.runInContext(read("./js/erp_dashboard.js"), ctx);
vm.runInContext(read("./js/sales_refresh.js"), ctx);
const R = ctx.SalesRefresh, D = ctx.ErpDashboard;

const LOGIN_ACTION = "맥에서 WING 로그인 갱신을 실행해 로그인·SMS 인증을 마쳐 주세요. 실제 인증·다운로드 확인이 끝나면 이 경고는 자동으로 사라져요.";
// 1) 09-15 14:53 KST 화면과 같은 응답(wing_session_health.view 모양) - 지금 AUTH_OK, 다음 06:20 은 로그인 후 24.0시간
const riskS = {
  state: "AUTH_OK", level: "alert", needs_login: true, needs_renewal: true, warning: false,
  message: "WING 로그인 필요 - 다음 06:20 은 로그인 후 24.0시간 시점이라 약 24시간 패턴(추정)상 그 전에 세션이 끝날 수 있어요.",
  action_hint: LOGIN_ACTION, hours_left: 12.0,
  cookie: { state: "OK", hours_left: 12.0 },
  auth: { state: "AUTH_OK", label: "실제 인증 정상", checked_at: "2026-09-15T14:51:02+09:00", stale: false,
          last_ok_at: "2026-09-15T14:51:02+09:00", last_ok_source: "keepalive" },
  keepalive: { last_success_at: "2026-09-15T14:51:00+09:00", last_failure_at: "2026-09-15T05:50:10+09:00", consecutive_failures: 0, failing: false },
  next_collection: { at: "2026-09-16T06:20:00+09:00", risk: "AT_RISK", login_age_at_collection_hours: 24.0,
    reason: "다음 06:20 은 로그인 후 24.0시간 시점이라 약 24시간 패턴(추정)상 그 전에 세션이 끝날 수 있어요",
    recommended_login_after: "2026-09-15T07:20:00+09:00", login_now_covers_next: true },
  login: { login_at: "2026-09-15T06:20:00+09:00", known: true, source: "MAC_REFRESH" },
  checked_at: "2026-09-15T14:53:00+09:00",
};
// 2) 실제 만료 - 쿠키는 남아 있어도 재인증 실패
const expiredS = {
  ...riskS, state: "SESSION_EXPIRED", level: "alert",
  message: "WING 로그인 필요 - 실제 인증이 실패했어요(쿠키는 9.5시간 남아 있지만 쿠키 시간과 무관). 세션이 복구될 때까지 수집은 저장하지 않아요. 기존 매출은 그대로예요.",
  cookie: { state: "OK", hours_left: 9.5 },
  auth: { state: "SESSION_EXPIRED", label: "실제 인증 실패(로그인 필요)", checked_at: "2026-09-15T17:51:00+09:00", stale: false,
          last_ok_at: "2026-09-15T14:51:02+09:00", last_ok_source: "keepalive" },
  keepalive: { last_success_at: "2026-09-15T14:51:00+09:00", last_failure_at: "2026-09-15T17:51:00+09:00", consecutive_failures: 1, failing: true },
  next_collection: { at: "2026-09-16T06:20:00+09:00", risk: "EXPIRED", reason: "지금 실제 인증이 안 돼요 - 로그인 전에는 수집하지 못해요",
    recommended_login_after: "2026-09-15T07:20:00+09:00", login_now_covers_next: true },
  checked_at: "2026-09-15T17:52:00+09:00",
};
// 3) 정상 안전 - 14:59 재로그인 뒤(다음 06:20 은 로그인 후 15.3시간)
const safeS = {
  ...riskS, level: "ok", needs_login: false, needs_renewal: false, message: null, action_hint: null,
  next_collection: { at: "2026-09-16T06:20:00+09:00", risk: "OK", login_age_at_collection_hours: 15.3,
    reason: "다음 06:20 은 로그인 후 15.3시간 시점 - 약 24시간 패턴(추정)상 유지될 것으로 보여요(확정 아님)" },
  login: { login_at: "2026-09-15T14:59:09+09:00", known: true, source: "MAC_REFRESH" },
};
const dashBase = { dataDate: "2026-09-14", today: "2026-09-15", yesterday: "2026-09-14",
  dayState: { latest: { status: "OK", collected_at: new Date(Date.now() - 3 * 3600000).toISOString() }, last_check: { status: "OK" } },
  adYesterday: { status: "OK" }, jobs: [], plans: [] };
const dash = s => D.statusModel({ ...dashBase, health: { session: s, last_success_at: new Date(Date.now() - 3 * 3600000).toISOString() } });

console.log(`(실행 TZ=${process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone})`);

console.log("=== 1. 지금 인증 정상 + 다음 06:20 위험 ===");
{
  const d = R.sessionDisplay(riskS);
  check(d.kind === "renew" && d.tone === "check" && d.title === "다음 06:20 수집 전 로그인 갱신 권장", "판정: 노랑 '다음 06:20 수집 전 로그인 갱신 권장'", JSON.stringify(d));
  const h = R.topBannerHtml(riskS);
  check(!h.includes("WING 로그인 필요"), "상단: 빨간 'WING 로그인 필요' 없음", plain(h));
  check(h.includes('role="status"') && h.includes("#fff4e8") && !h.includes("#fdecec"), "상단: 노란 경고(role=status)");
  check(plain(h).includes("다음 06:20 수집 전 로그인 갱신 권장 · 지금 WING 인증은 정상이에요(09. 15. 14:51 KST 확인)."), "상단: 지금 인증 정상임을 먼저 알림", plain(h));
  check(plain(h).includes("마지막 실제 인증 성공(AUTH_OK) 09. 15. 14:51 KST"), "상단: 마지막 인증 성공 시각 그대로");
  check(plain(h).includes("다음 06:20 수집(09. 16. 06:20 KST): 로그인 갱신 권장 - 수집 전에 세션이 끝날 수 있음(추정) · 그때 로그인 후 24시간"), "상단: 다음 06:20 수집 시각 그대로", plain(h));
  check(plain(h).includes("쿠키 12.0시간 남음(참고 - 쿠키만으로 정상 판단 안 함) · 쿠키 만료 예상 09. 16. 02:53 KST"), "상단: 쿠키 만료 예상(확인 시각 + 남은 시간, KST)", plain(h));
  check(plain(h).includes("지금 로그인하면 다음 06:20 수집까지 유지될 것으로 추정"), "상단: 갱신 안내 유지");
  check(R.sessionBannerHtml({ last_success_at: "2026-09-15T09:14:00+09:00", session: riskS }) === "", "매출 화면: 같은 경고를 또 쓰지 않음(상단 하나)");
  const line = R.statusLineHtml({ date: "2026-09-15", state: R.summarizeHistory("2026-09-15", []), hasData: true, today: "2026-09-15",
    health: { last_success_at: "2026-09-15T09:14:00+09:00", session: riskS } });
  check(!line.includes("WING 로그인 필요") && line.includes("실제 인증 정상"), "매출 화면 상태줄: 로그인 필요 없음 · 실제 인증 정상", plain(line));

  const m = dash(riskS);
  const wing = m.items.filter(i => ["wing", "next"].includes(i.key));
  check(wing.length === 1 && wing[0].tone === "check" && wing[0].text === "다음 06:20 수집 전 로그인 갱신 권장", "대시보드: WING 항목 하나(인증+06:20 합침) · 노랑", JSON.stringify(wing.map(i => [i.key, i.tone, i.text])));
  const dh = D.statusHtml(m, { at: new Date("2026-09-15T14:53:00+09:00") });
  check(!dh.includes("운영 경고") && dh.includes("운영 확인 필요") && dh.includes("dash-status--check") && !dh.includes('role="alert"'), "대시보드: 빨간 '운영 경고' 아님 → '운영 확인 필요'(노랑)");
  check(!dh.includes("WING 로그인 필요"), "대시보드: 'WING 로그인 필요' 없음");
  check(count(dh, "다음 06:20 은 로그인 후 24.0시간") === 1, "대시보드: 같은 이유 문장 한 번만", plain(dh));
  check(plain(dh).includes("마지막 실제 인증 성공(AUTH_OK) 09. 15. 14:51 KST") && plain(dh).includes("쿠키 만료 예상 09. 16. 02:53 KST")
    && plain(dh).includes("다음 06:20 수집(09. 16. 06:20 KST)"), "대시보드: 인증 성공·쿠키 만료 예상·다음 06:20 시각을 같은 카드에", plain(dh));
  check(!dh.includes("화면 맨 위 WING 안내"), "대시보드: '맨 위 안내 보라'는 중복 안내 없음");
  check(dh.includes("dashboardWingGuide()"), "대시보드: 'WING 로그인 갱신 방법 보기' 유지");

  // 상단 영역: 대시보드에서는 숨김(운영 상태 카드가 같은 경고를 그림), 다른 화면에서는 표시
  apiBody = { running: false, session: riskS };
  ctx.location.hash = "#/dashboard";
  await R.renderTopBanner({ force: true });
  check(el.hidden && el.innerHTML === "", "대시보드(#/dashboard): 상단 경고 숨김 → 운영 상태 카드 하나만");
  ctx.location.hash = "";
  await R.renderTopBanner({ force: true });
  check(el.hidden, "대시보드(해시 없음 = 첫 화면): 상단 경고 숨김");
  ctx.location.hash = "#/sales";
  await R.renderTopBanner({ force: true });
  check(!el.hidden && el.innerHTML.includes("다음 06:20 수집 전 로그인 갱신 권장") && !el.innerHTML.includes("WING 로그인 필요"), "다른 화면(#/sales): 상단 노란 경고 표시");

  // 지금 인증이 '확인 필요'(AUTH_UNVERIFIED)여도 실패가 아니면 빨강 아님
  const unv = { ...riskS, state: "AUTH_UNVERIFIED", auth: { ...riskS.auth, state: "AUTH_UNVERIFIED", stale: true } };
  const hu = R.topBannerHtml(unv);
  check(R.sessionDisplay(unv).kind === "renew" && !hu.includes("WING 로그인 필요") && !hu.includes("지금 WING 인증은 정상"), "인증 확인 필요 + 06:20 위험 → 노랑(정상이라고도 쓰지 않음)", plain(hu));
}

console.log("\n=== 2. 실제 만료 ===");
{
  const d = R.sessionDisplay(expiredS);
  check(d.kind === "expired" && d.tone === "error" && d.title === "WING 로그인 필요", "판정: 빨강 'WING 로그인 필요'", JSON.stringify(d));
  const h = R.topBannerHtml(expiredS);
  check(h.includes('role="alert"') && h.includes("#fdecec") && count(h, "WING 로그인 필요") === 1, "상단: 빨간 경고 · 제목 한 번", plain(h));
  check(plain(h).includes("실제 인증이 실패했어요") && plain(h).includes("다음 06:20 수집(09. 16. 06:20 KST): 불가"), "상단: 실패 이유 · 06:20 불가");
  check(!plain(h).includes("지금 WING 인증은 정상"), "상단: 만료인데 '정상'이라 쓰지 않음");
  const sb = R.sessionBannerHtml({ last_success_at: "2026-09-15T09:14:00+09:00", session: expiredS });
  check(sb.includes('role="alert"') && sb.includes("WING 로그인 필요"), "매출 화면: 빨간 배너 유지(기존 동작)");
  const m = dash(expiredS);
  const wing = m.items.filter(i => ["wing", "next"].includes(i.key));
  check(wing.length === 1 && wing[0].tone === "error" && wing[0].text === "WING 로그인 필요", "대시보드: WING 항목 하나 · 빨강", JSON.stringify(wing.map(i => [i.key, i.tone, i.text])));
  const dh = D.statusHtml(m, { at: new Date() });
  // 2026-09-15 [사용자 지시] 문제가 있으면 제목은 '운영 확인 필요' - 실제 만료는 빨간 테두리(dash-status--error)·role=alert 로 구분
  check(dh.includes("운영 확인 필요") && dh.includes('role="alert"') && dh.includes("dash-status--error"), "대시보드: 실제 만료 = 빨간 '운영 확인 필요'(빨간 테두리)");
  check(count(dh, "WING 로그인 필요") === 1, "대시보드: 'WING 로그인 필요' 한 번만", plain(dh));
  // 쿠키 파일이 없음 · 옛 응답(state 없음) 도 빨강(안전한 쪽)
  check(R.sessionDisplay({ ...expiredS, state: "NO_SESSION" }).kind === "expired", "NO_SESSION → 빨강");
  check(R.sessionDisplay({ level: "alert", message: "WING 로그인 필요 - x", next_collection: { risk: "AT_RISK" } }).kind === "expired", "상태 없는 옛 응답의 alert → 빨강 유지");
  check(R.sessionDisplay({ needs_renewal: true, message: "세션 갱신 필요" }).kind === "expired", "level 없는 옛 응답(needs_renewal) → 빨강 유지");
  // 쿠키 기준으로도 만료(서버 state=SESSION_EXPIRED)면 06:20 위험 여부와 관계없이 빨강
  check(R.sessionDisplay({ ...riskS, state: "SESSION_EXPIRED" }).kind === "expired", "state=SESSION_EXPIRED 이면 AT_RISK 이어도 빨강");
}

console.log("\n=== 3. 정상 안전 ===");
{
  check(R.sessionDisplay(safeS).kind === "ok", "판정: 정상");
  check(R.topBannerHtml(safeS) === "", "상단: 경고 없음");
  apiBody = { running: false, session: safeS };
  ctx.location.hash = "#/sales";
  await R.renderTopBanner({ force: true });
  check(el.hidden && el.innerHTML === "", "상단 영역 숨김");
  check(R.sessionBannerHtml({ last_success_at: "2026-09-15T09:14:00+09:00", session: safeS }) === "", "매출 화면: 배너 없음");
  const m = dash(safeS);
  check(m.problems.length === 0 && JSON.stringify(m.items.filter(i => ["wing", "next"].includes(i.key)).map(i => [i.tone, i.text]))
    === JSON.stringify([["ok", "WING 인증 정상"], ["ok", "다음 06:20 수집 가능(추정)"]]), "대시보드: 문제 0 · 'WING 인증 정상' · '다음 06:20 수집 가능(추정)'", JSON.stringify(m.items));
  check(m.items.find(i => i.key === "wing").sub === "09-15 14:51 확인", "대시보드: 인증 확인 시각 KST", m.items.find(i => i.key === "wing").sub);
  // 자동 연장 실패 중(WATCH) 같은 '확인 필요'는 노랑 그대로
  const watch = { ...safeS, level: "warn", warning: true, message: "세션 자동 연장이 2회 연속 실패했어요(AUTH_BLOCKED).",
    next_collection: { ...safeS.next_collection, risk: "WATCH" } };
  check(R.sessionDisplay(watch).kind === "check" && R.topBannerHtml(watch).includes("WING 세션 확인 필요") && !R.topBannerHtml(watch).includes("WING 로그인 필요"),
    "자동 연장 실패 중(WATCH) → 노란 'WING 세션 확인 필요'(기존 그대로)");
}

console.log(failures ? `\n${failures} FAIL` : "\nALL OK");
process.exit(failures ? 1 : 0);
