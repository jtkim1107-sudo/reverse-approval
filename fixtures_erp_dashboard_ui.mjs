// fixtures_erp_dashboard_ui.mjs - ERP 메인 대시보드(js/erp_dashboard.js + app.js 대시보드 영역) 검증 - 네트워크·DB 없음
// 2026-09-13 대시보드 정리: 숫자는 기존 공통 함수 값 그대로, 기술 코드 숨김, 0 대신 '확인 불가', 쓰기·업무 실행 버튼 없음.
import { readFileSync } from "fs";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
let failures = 0;
const check = (a, e, label) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) failures++;
  console.log(`${ok ? "  OK " : "  FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(a)}, 기대=${JSON.stringify(e)})`}`);
};
const has = (h, n, label) => check(String(h).includes(n), true, label);
const hasNot = (h, n, label) => check(String(h).includes(n), false, label);

const ctx = vm.createContext({ console, Intl, Date });
vm.runInContext(read("./js/erp_ui.js"), ctx);
vm.runInContext(read("./js/erp_dashboard.js"), ctx);
const D = ctx.ErpDashboard;
const fmt = n => (Number(n) || 0).toLocaleString("ko-KR");
const plain = h => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const NOW = new Date();
const iso = (hAgo) => new Date(NOW.getTime() - hAgo * 3600000).toISOString();

console.log("=== 1. 기술 코드 숨김 ===");
check(["MISSING_PROCUREMENT_DATA", "SESSION_EXPIRED", "DATA_CHECK_NEEDED", "RECOVERY_NEEDED"].map(D.codeText),
      ["발주·물류정보 미완성", "WING 로그인 필요", "데이터 확인 필요", "복구 확인 필요"], "코드 → 사람 말");
check(D.codeText("SOME_NEW_CODE"), "확인 필요", "모르는 코드는 코드 대신 '확인 필요'");
check(D.humanize("실패 (SESSION_EXPIRED) · UNKNOWN_THING_X"), "실패 (WING 로그인 필요) ·", "문장 안 코드 치환, 모르는 코드는 지움");

console.log("\n=== 2. A. 운영 상태 ===");
const okSession = { level: "ok", auth: { state: "AUTH_OK", checked_at: iso(1) }, next_collection: { risk: "OK" } };
const base = { health: { session: okSession, last_success_at: iso(3) }, dataDate: "2026-09-12", today: "2026-09-13", yesterday: "2026-09-12",
  dayState: { latest: { status: "OK", collected_at: iso(3) }, last_check: { status: "OK" } }, adYesterday: { status: "OK" },
  jobs: [{ job_name: "inventory_decisions_cache", last_success_at: iso(1), last_attempt_at: iso(1) }],
  plans: [{ id: "a", mail_status: "MAIL_SENT", mail_sent_at: iso(40), created_at: iso(5) }] };
let m = D.statusModel(base);
check([m.problems.length, m.items.map(i => i.key)], [0, ["wing", "next", "last", "date", "mail", "poller"]], "전체 정상: 문제 0 · WING·06:20·마지막 수집·기준일·메일·폴러");
let h = D.statusHtml(m, { at: NOW });
check([h.includes("확인된 문제 없음"), h.includes("운영 정상"), h.includes("dash-status--ok"), (h.match(/class="erp-badge /g) || []).length], [true, false, true, 1],
      "문제가 없으면 한 줄(배지 하나 + 글자) · '확인된 문제 없음'(모르는 항목까지 정상이라 하지 않음)");
check(m.items.filter(i => ["mail", "poller"].includes(i.key)).map(i => [i.tone, i.text]), [["none", "입고 메일 폴러 정보 없음"], ["none", "자동입고 폴러 정보 없음"]],
      "[핵심] 폴러는 최근 발송·요청 기록이 있어도 '정보 없음'(정상 추정 안 함)");
check([h.includes("화면 새로고침"), h.includes("dashboardRefresh()"), h.includes("SalesRefresh")], [true, true, false], "대시보드 새로고침은 읽기 전용 '화면 새로고침'만");
check(m.items.find(i => i.key === "poller").tone, "none", "자동입고 폴러: 상태 기록이 없으니 '정보 없음'(정상이라고 지어내지 않음)");
m = D.statusModel({ ...base, health: { session: { level: "alert", message: "WING 로그인 필요 - 실제 인증 실패(SESSION_EXPIRED)", next_collection: { risk: "EXPIRED" } }, last_success_at: iso(30) } });
h = D.statusHtml(m, { at: NOW });
check(m.problems.map(p => [p.key, p.tone]), [["wing", "error"], ["next", "error"], ["last", "check"]], "WING 로그인 필요: 긴급 · 다음 06:20 불가 · 마지막 수집 하루 넘음");
check([h.includes("운영 경고"), h.includes("dashboardWingGuide()"), h.includes('role="alert"')], [true, true, true], "크게 경고 + 'WING 로그인 갱신 방법 보기'");
check(m.problems[0].why.includes("WING 로그인 필요"), false, "이유 문구가 제목을 반복하지 않음");
hasNot(plain(h), "SESSION_EXPIRED", "기술 코드 안 보임");
m = D.statusModel({ ...base, dayState: { latest: { status: "FAILED", collected_at: iso(12), error: "SESSION_EXPIRED: 로그인 필요" }, last_check: null } });
check(m.problems.map(p => [p.key, p.tone, !!p.collect]), [["sales0620", "error", true]], "06:20 매출 수집 실패(저장값 없음) = 긴급 · 수집 오류로 셈");
m = D.statusModel({ ...base, dayState: { latest: { status: "FAILED", collected_at: iso(1), error: "x" }, last_check: { status: "OK" } } });
check(m.problems.map(p => [p.key, p.tone]), [["sales0620", "check"]], "최근 재수집만 실패(기존값 있음) = 확인 필요");
m = D.statusModel({ ...base, dataDate: "2026-09-10" });
check(m.problems.map(p => p.key), ["date"], "최신 데이터가 어제보다 오래됨 = 확인 필요");
m = D.statusModel({ ...base, adYesterday: { status: "UNDETERMINED", lastError: "SESSION_EXPIRED: x" } });
check(m.problems.map(p => [p.key, p.tone]), [["ad0620", "check"]], "어제 광고비 누락 = 확인 필요");
m = D.statusModel({ ...base, jobs: [{ job_name: "cs_inquiry_collect", last_success_at: iso(5), last_attempt_at: iso(1), last_error: "401", error_kind: "RELOGIN_REQUIRED" }] });
check([m.problems.map(p => p.key), m.problems[0].why.includes("WING 로그인 필요")], [["job-cs_inquiry_collect"], true], "고객문의 수집 실패(코드 대신 말)");
m = D.statusModel({ ...base, plans: [{ id: "a", mail_status: "MAIL_FAILED", internal_status: "PREFLIGHT_PASSED" }] });
check(m.problems.map(p => [p.key, p.text]), [["mail", "입고 메일 확인 필요 1건"]], "입고 메일 실패 = 확인 필요");
m = D.statusModel({ ...base, health: null, healthError: "Failed to fetch" });
check(m.items.find(i => i.key === "wing").tone, "none", "WING 상태 API 실패 = '확인 불가'(정상·오류로 지어내지 않음)");
m = D.statusModel({ ...base, plans: null });
check(m.items.filter(i => ["mail", "poller"].includes(i.key)).map(i => i.text), ["입고 메일 폴러 정보 없음", "자동입고 폴러 정보 없음"], "입고 요청을 못 읽어도 '정보 없음'(추정 안 함)");

console.log("\n=== 3. B. 오늘 해야 할 일 ===");
const t = D.todoModel({ docs: 1, po: 0, inbound: 2, reinbound: 1, exclusion: null, logistics: 2, stockCheck: 0, collect: 0, cs: 3, csUrgent: 1, tasks: 1 });
check(t.active.map(r => [r.key, r.count]), [["docs", 1], ["inbound", 2], ["reinbound", 1], ["logistics", 2], ["cs", 3], ["tasks", 1]], "건수 있는 것만 크게(정해진 순서)");
check([t.zero.map(r => r.key), t.unknown.map(r => r.key)], [["po", "stockcheck", "collect"], ["exclusion"]], "0건은 접고, 모르는 건 '확인 불가'(0 아님)");
check(t.rows.find(r => r.key === "cs").tone, "error", "긴급 고객문의가 있으면 빨강");
h = D.todoHtml(t, { at: NOW });
check([h.includes('href="#/inbox"'), h.includes('href="#/stockflow/rginbound"'), /onclick=/.test(h), /<button/.test(h)], [true, true, false, false],
      "누르면 해당 화면으로 이동만(버튼·실행 없음)");
has(plain(h), "0건: 발주서 · 재고 확인 필요 · 수집 오류", "0건 항목은 한 줄로");
has(plain(h), "확인 불가 재입고 제외 확인", "확인 불가 표시");
check(t.rows.filter(r => r.key.startsWith("docs") || r.key === "po" || r.key === "inbound" || r.key === "reinbound").map(r => r.tone),
      ["approval", "approval", "approval", "approval"], "승인 필요 = 보라(approval)");
has(ctx.ErpUi.badge("approval", { text: "1건" }), "erp-badge--approval", "ErpUi 승인 배지 종류");
has(read("./css/style.css"), ".erp-badge--approval, .erp-badge--reinbound", "승인 배지는 보라색");

console.log("\n=== 4. C. 매출 요약 (공통 집계 값 그대로) ===");
const calls = [];
const forDate = (summary, date, opts) => { calls.push([date, opts]); return { date, net_amount: date === "2026-09-12" ? 289800 : 460730, net_qty: 12, gross_amount: 311700, gross_qty: 13, cancel_amount: 21900, cancel_qty: 1, collected: true }; };
const summary = { has_rg_statistics: true, collected_dates: ["2026-09-10", "2026-09-11", "2026-09-12"], total: { net_amount: 5716230 }, rocket_growth: { net_amount: 5018730 }, marketplace: { net_amount: 697500 } };
let s = D.salesModel(summary, "2026-09-13", forDate);
check([s.shown, s.isToday, s.prevDate, s.dod.toFixed(1)], ["2026-09-12", false, "2026-09-11", "-37.1"], "오늘 값이 없으면 최신 확정일 · 전일 = 바로 앞 수집일");
check(calls.every(c => c[1] && c[1].rgOnly === true), true, "일 매출은 forDate(로켓그로스) - 기존 오늘 카드와 같은 호출");
h = plain(D.salesHtml(s, { fmt, at: NOW }));
check(["최신 확정일 기준 09-12", "₩289,800", "₩311,700", "₩21,900", "13개", "▼ 37.1%", "이번 달 순매출 ₩5,716,230"].every(x => h.includes(x)) && !h.includes("로켓그로스 ₩5,018,730") && !h.includes("판매자배송 ₩697,500"), true,
      "순매출·전체 거래액·취소반품·주문 수량·전일 대비·이번 달 누적(최신 확정일 기준 표시)");
s = D.salesModel({ ...summary, collected_dates: [...summary.collected_dates, "2026-09-13"] }, "2026-09-13", forDate);
check([s.shown, s.isToday], ["2026-09-13", true], "오늘 값이 있으면 오늘");
check(D.salesModel({ has_rg_statistics: false }, "2026-09-13", forDate).empty, true, "판매통계 없음 = 데이터 없음(0원 아님)");
has(plain(D.salesHtml({ empty: true }, { fmt })), "0원이 아니라 미수집", "데이터 없음 문구");
h = D.salesHtml(D.salesModel(summary, "2026-09-13", forDate), { fmt, at: NOW });
check([h.includes('href="#/sales"'), plain(h).includes("매출 상세"), /<button/.test(h), h.includes("다시 수집")], [true, true, false, false], "[핵심] 매출 카드: WING 수집 버튼 없음 · '매출 상세' 링크만");

console.log("\n=== 5. D+G. 공헌이익·광고비 (computeCmOfMonth 값 그대로) ===");
const cm = { t: { revenue: 4937461, cost: 2808500, fee: 493749, logi: 0, ship: 0, inFreight: 42500 }, adTotal: 498340, cmNet: 1094372, cmRate: 22.16 };
const adInfo = { state: "ROUNDING_DIFFERENCE", recon: { diff: -3 }, days: [{ date: "2026-09-11", status: "OK", auto: { net: 48660 } }, { date: "2026-09-12", status: "OK", auto: { net: 45090 } }],
  undeterminedDays: [], reconciliationNeeded: [{}], duplicates: [] };
let p = D.profitModel(cm, adInfo, { month: "2026-09" });
h = plain(D.profitHtml(p, { fmt, at: NOW }));
check(["₩4,937,461", "− ₩2,808,500", "56.9%", "− ₩493,749", "10.0%", "− ₩42,500", "0.9%", "− ₩498,340", "10.1%", "₩1,094,372", "22.2%"].every(x => h.includes(x)), true,
      "매출·원가·수수료·운송비·광고비·공헌이익·이익률 = 공헌이익 화면과 같은 값·같은 비율 식");
check([h.includes("물류비"), h.includes("출고배송비")], [false, false], "0원 줄은 공헌이익 화면처럼 생략");
check(["최신일 광고비 ₩45,090", "매출 대비 광고비율 10.1%", "잠정 · 쿠팡 기간 합계와 3원 차이", "수동 입력 확인 필요 1건"].every(x => h.includes(x)), true, "최신일 광고비·광고비율·데이터 확인");
check((h.match(/₩498,340/g) || []).length, 1, "[핵심] 광고비 누적은 한 번만(공헌이익·광고비 카드 하나로 합침)");
p = D.profitModel({ ...cm, cmNet: -18340888, cmRate: -371.5 }, adInfo, { month: "2026-09" });
h = D.profitHtml(p, { fmt, at: NOW });
check([h.includes("적자"), h.includes("dash-card--error"), plain(h).includes("₩-18,340,888")], [true, true, true], "공헌이익 음수 = 빨강 + '적자'");
p = D.profitModel(cm, { ...adInfo, state: "UNDETERMINED", undeterminedDays: ["2026-09-12"] }, { month: "2026-09" });
h = plain(D.profitHtml(p, { fmt, at: NOW }));
check([h.includes("미확정 잠정 ₩1,094,372"), h.includes("광고비 미확정 1일")], [true, true], "광고비 미확정 = 공헌이익 '미확정'(공헌이익 화면과 같은 규칙)");

console.log("\n=== 6. E. 재고·발주 ===");
const dec = (decision, v = {}) => ({ decision, product_id: v.id || decision, option_name: "", ...v });
const st = D.stockModel([dec("OK"), dec("ORDER_SOON", { days_of_stock_now: 11 }), dec("ORDER_NOW", { days_of_stock_now: 3 }), dec("ORDER_NOW", { id: "z", days_of_stock_now: 0 }),
  dec("AWAITING_INBOUND"), dec("DATA_CHECK", { automation_blocked: true, automation_label: "물류정보 입력 필요" }), dec("RESTOCK_EXCLUDED", { automation_blocked: true }),
  dec("ORDER_SOON", { id: "s2", days_of_stock_now: 5 }), dec("DATA_CHECK", { id: "d2" }), dec("ORDER_SOON", { id: "s3", days_of_stock_now: 9 })]);
check([st.orderNow, st.awaiting, st.soon, st.dataCheck, st.blocked, st.logistics], [2, 1, 3, 2, 1, 1], "품절·임박·입고대기·발주 검토·재고 확인·자동화 차단(재입고 제외 빼고)·물류정보");
check(st.top.map(d => d.product_id), ["z", "ORDER_NOW", "s2", "s3", "ORDER_SOON"], "위험 상품 5개 - 지금 발주 → 곧 발주, 남은 일수 적은 순");

console.log("\n=== 7. F. 입고·운송 ===");
const plans = [{ id: "p1", inbound_date: "2026-09-17", inbound_time: "09:30:00" }, { id: "p2", inbound_date: "2026-09-14", inbound_time: "09:30:00" },
  { id: "p3", inbound_date: "2026-09-17", inbound_time: "08:00:00" }, { id: "p4", inbound_date: "2026-09-11" }, { id: "p5", inbound_date: "2026-09-20", internal_status: "CANCELLED" },
  { id: "p6", inbound_date: "2026-09-21", approval_status: "REJECTED" }, { id: "p7", inbound_date: "2026-09-22" }];
const itemsByPlan = Object.fromEntries(plans.map(x => [x.id, x.id === "p7" ? [] : [{ coupang_inbound_qty: 1 }]]));
const ib = D.inboundModel({ plans, itemsByPlan, counts: { wing: 1, failed: 0, block: 0 }, freightReview: [], today: "2026-09-13", statusOf: () => ({ tone: "awaiting", text: "x" }) });
check(ib.upcoming.map(x => x.id), ["p2", "p3", "p1"], "가까운 일정부터(지난 일정·취소·거절·품목 없음 제외)");

console.log("\n=== 8. 불러오기 실패 · 마지막 정상값 ===");
const last = { html: D.shellHtml({ id: "dash-stock", title: "재고·발주", body: "<b>품절·임박 3</b>" }), at: NOW };
h = D.errorHtml("dash-stock", "재고·발주", "MOCK: 서버 계산 실패", last);
check([h.includes("품절·임박 3"), h.includes("새로고침 실패"), h.includes("마지막 정상값")], [true, true, true], "[핵심] 새로고침 실패 → 0 으로 바꾸지 않고 마지막 정상값 + 오류");
h = D.errorHtml("dash-stock", "재고·발주", "timeout", null);
check([h.includes("불러오지 못했어요"), h.includes("0 이 아니라"), h.includes("dashboardRefresh()")], [true, true, true], "처음부터 실패 → '불러오지 못했어요'(0 아님) + 다시 시도");
has(D.loadingHtml("dash-todo", "오늘 해야 할 일"), 'aria-busy="true"', "불러오는 중 상태 구분");

console.log("\n=== 9. 소스 - 쓰기·업무 실행 없음, 기존 계산 재사용 ===");
const app = read("./js/app.js");
const dashSrc = app.slice(app.indexOf("/* ---------- 화면: 대시보드 ---------- */"), app.indexOf("/* ---------- 문서 목록 테이블 ---------- */"));
const modSrc = read("./js/erp_dashboard.js");
for (const bad of [".insert(", ".upsert(", ".update(", ".delete(", ".rpc(", "claimMilestones(", "decideRgInbound", "releasePoHold", "submitRgInbound",
                   "openRgMultiSubmitModal", "fn_", "mail", "approve"]) {
  hasNot(dashSrc.replace(/\/\/.*$/gm, ""), bad, `대시보드 영역에 '${bad}' 없음`);
}
for (const bad of ["sb.", "fetch(", ".insert(", ".upsert(", ".rpc("]) hasNot(modSrc, bad, `erp_dashboard.js 에 '${bad}' 없음`);
check(["computeCmOfMonth(month, base.v.sales, adRowsAll(ad.v), fixed)", "adMonthState(ad.v, month)", "buildMonthlyNetSales(month, b.sales", "fetchInventoryDecisions()", "loadErpBase()"]
      .every(x => dashSrc.includes(x)), true, "공헌이익·광고비·매출·재고는 기존 함수 그대로(공헌이익 화면과 같은 입력)");
const rgBody = app.slice(app.indexOf("async function viewRgInbound("), app.indexOf("async function viewRgInbound(") + 6000);
check([rgBody.includes("rgCountPlan(counts, p, ctx.loadBlock)"), dashSrc.includes("rgCountPlan(counts, p, InboundApproval.loadBlock(p, items))")], [true, true],
      "[핵심] 입고 건수는 입고관리 화면과 같은 규칙(rgCountPlan)");
check(/dashboard: \{ title: "대시보드", render: viewDashboard, after: \(\) => dashboardHydrate\(\) \}/.test(app), true, "대시보드는 틀을 먼저 그리고 영역별로 채움");
check(dashSrc.includes("_dashLast[id]") && dashSrc.includes("ErpDashboard.errorHtml(id, title"), true, "새로고침 실패 시 마지막 정상값 사용");
const handlers = [...(dashSrc + modSrc).matchAll(/onclick="([^"(]+)\(/g)].map(x => x[1]);
check([...new Set(handlers)].sort(), ["dashboardRefresh", "dashboardWingGuide"], "[핵심] 대시보드 버튼은 화면 새로고침 · WING 로그인 갱신 방법 보기뿐");
hasNot(dashSrc, "SalesRefresh.buttonHtml", "대시보드에 WING 판매데이터 수집 버튼 없음");
for (const bad of ["team_milestones", "claimMilestones", "teamCardHtml", "loadTeamMonth"]) hasNot(dashSrc, bad, `대시보드 영역에 '${bad}' 없음(팀 목표 기록 쓰기 없음)`);
const srSrc = read("./js/sales_refresh.js");
check([/async function click\(btn\)[\s\S]{0,400}confirmCollect\(date\)/.test(srSrc), srSrc.includes('label = "WING 판매데이터 다시 수집"')], [true, true],
      "매출 화면의 WING 수집 버튼: 이름 명확 + 누르기 전 확인창");
const idx = read("./index.html");
check(idx.indexOf("js/erp_ui.js") < idx.indexOf("js/erp_dashboard.js") && idx.indexOf("js/erp_dashboard.js") < idx.indexOf("js/app.js"), true, "스크립트 순서 erp_ui → erp_dashboard → app");

console.log(failures ? `\n=== 결과: 실패 ${failures}건 ===` : "\n=== 결과: 전체 통과 ===");
process.exit(failures ? 1 : 0);
