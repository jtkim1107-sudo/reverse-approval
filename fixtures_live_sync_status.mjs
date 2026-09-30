// fixtures_live_sync_status.mjs - 2026-10-01 [사용자 지시] 10분 자동 수집 실패 시각을 '운영 상태'에 · 공통 WING 경고는 화면 맨 아래
// 네트워크·DB 없음
import { readFileSync } from "fs";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
let failures = 0;
const check = (a, e, label) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) failures++;
  console.log(`${ok ? "  OK " : "  FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(a)}, 기대=${JSON.stringify(e)})`}`);
};
const ctx = vm.createContext({ console, Intl, Date });
vm.runInContext(read("./js/erp_ui.js"), ctx);
vm.runInContext(read("./js/erp_dashboard.js"), ctx);
const D = ctx.ErpDashboard;
const plain = h => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const NOW = new Date();
const iso = hAgo => new Date(NOW.getTime() - hAgo * 3600000).toISOString();
const okSession = { level: "ok", auth: { state: "AUTH_OK", checked_at: iso(1) }, next_collection: { risk: "OK" } };
const base = { health: { session: okSession, last_success_at: iso(0.2) }, dataDate: "2026-10-01", today: "2026-10-01", yesterday: "2026-09-30",
  dayState: { latest: { status: "OK", collected_at: iso(20) }, last_check: { status: "OK" } }, adYesterday: { status: "OK" }, jobs: [], plans: [] };

console.log("=== 1. 오늘 실시간 매출 자동 수집 ===");
let m = D.statusModel({ ...base, liveState: { latest: { status: "OK", collected_at: iso(0.2) }, last_check: { collected_at: iso(0.2) } } });
check(m.items.some(i => i.key === "live"), false, "마지막 시도 정상 → 실패 항목 없음");
check(m.items.find(i => i.key === "last").text.includes("마지막 정상 수집"), true, "마지막 정상 수집 줄은 그대로(자동 수집 완료 시각)");
const failAt = iso(0.1);
m = D.statusModel({ ...base, liveState: { latest: { status: "FAILED", collected_at: failAt, error: "SESSION_EXPIRED: 세션 만료" }, last_check: { collected_at: iso(1) } } });
const it = m.items.find(i => i.key === "live");
check([!!it, it && it.tone, m.problems.includes(it)], [true, "check", true], "[핵심] 실패 → '운영 확인 필요'에 올림");
check(/^실시간 매출 수집 실패 (\d\d-\d\d )?\d\d:\d\d$/.test(it.text), true, "실패 시각 표시(KST)");
check([it.why.includes("기존 매출 유지"), it.why.includes("마지막 수집"), /SESSION_EXPIRED/.test(it.why)], [true, true, false], "기존 값 유지 · 마지막 수집 · 코드 대신 말");
check(!!it.collect, false, "할 일 '수집 오류' 건수에는 넣지 않음(운영 상태에만)");
const h = plain(D.statusHtml(m, { at: NOW }));
check(h.includes("실시간 매출 수집 실패"), true, "운영 상태 카드에 보임");
m = D.statusModel({ ...base, liveState: { latest: { status: "FAILED", collected_at: failAt, error: "EMPTY_SNAPSHOT 빈 스냅샷" } } });
check(m.items.some(i => i.key === "live"), false, "자정 직후 판매 행 없음은 실패 아님(수집 대기)");
m = D.statusModel({ ...base, liveState: null });
check(m.items.some(i => i.key === "live"), false, "이력을 못 읽으면 지어내지 않음");

console.log("\n=== 2. 공통 WING 경고 영역 위치 ===");
const idx = read("./index.html");
const at = idx.indexOf('id="wing-session-banner"');
check([at > idx.indexOf('id="content"'), at < idx.indexOf('id="modal-root"'), idx.split('id="wing-session-banner"').length], [true, true, 2],
  "[핵심] #content(각 탭 주요 내용) 뒤 · .main 안 · 하나만");
const css = read("./css/style.css");
check([/#wing-session-banner \{[^}]*padding: 0 26px 32px/.test(css), /@media[\s\S]*#wing-session-banner \{ padding: 0 14px 28px; \}/.test(css), /#wing-session-banner \{[^}]*overflow-wrap: anywhere/.test(css)],
  [true, true, true], "PC·모바일 본문과 같은 여백 · 긴 문구 줄바꿈(가로 넘침 방지)");
const sr = read("./js/sales_refresh.js");
check(/return `\$\{sessionBannerHtml\(health\)\}/.test(sr), false, "매출 화면 상태 줄(상단)에 경고를 또 쓰지 않음");
check(sr.includes("margin:0;font-size:13px"), true, "배너 자체 여백 0(영역 여백만)");
const app = read("./js/app.js");
check(/liveStateP = globalThis\.SalesRefresh\.loadDayState\(td\)/.test(app) && /liveState: lv\.ok \? lv\.v : null/.test(app), true, "대시보드 운영 상태에 오늘 수집 이력 연결(읽기만)");

console.log(failures ? `\n${failures} FAILED` : "\n전부 통과");
process.exit(failures ? 1 : 0);
