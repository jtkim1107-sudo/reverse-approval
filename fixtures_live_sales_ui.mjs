// fixtures_live_sales_ui.mjs
// 2026-09-29 실시간 매출(대시보드 '실시간 매출' 카드, 예전 #/livesales) 격리 검증 - 네트워크·DB 없음.
//   · 오늘 누적(잠정)과 전일(확정/잠정/미수집)을 분리 · 미수집을 0원으로 그리지 않음
//   · 금액·수량은 공통 집계(SalesMonthlySummary.build/forDate) 값 그대로 - 대시보드 카드·매출 입력과 같은 값
//   · 주문 건수: 판매자배송 등 원장 행 수만, 로켓그로스는 '판매통계 미제공'(지어내지 않음)
//   · 월 경계(오늘 10-01 · 전일 09-30)는 달별 집계를 따로 씀
//   · 화면은 DB 에 쓰지 않음(수집은 기존 확인창 버튼만) · 라우트·사이드바·스크립트 순서
import fs from "node:fs";

let failures = 0;
function check(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) console.log("   expected", JSON.stringify(expected), "\n   actual  ", JSON.stringify(actual));
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const liveSrc = read("./js/live_sales.js");
const summarySrc = read("./js/sales_monthly_summary.js");
const refreshSrc = read("./js/sales_refresh.js");
const appSrc = read("./js/app.js");
const indexSrc = read("./index.html");

const win = {};
new Function("window", summarySrc)(win);
new Function("window", refreshSrc)(win);
new Function("window", liveSrc)(win);
const { SalesMonthlySummary: S, LiveSales: L, SalesRefresh: R } = win;

const RG = "쿠팡 로켓그로스";
const stat = (d, opt, gq, ga, cq, ca, pid = "P1") => ({ sales_date: d, channel: RG, option_id: opt, product_id: pid,
  gross_qty: gq, gross_amount: ga, cancel_qty: cq, cancel_amount: ca, net_qty: gq - cq, net_amount: ga - ca });
const sale = (id, d, qty, amount, ch = "쿠팡 판매자배송") => ({ id, date: d, channel: ch, product_id: "P3", qty, amount });
const build = (month, stats, sales = [], adj = []) => S.build({ month, statisticsRows: stats, salesRows: sales, adjustmentRows: adj, productName: (x) => x });
const state = (iso) => ({ last_check: iso ? { collected_at: iso, status: "OK" } : null, latest: iso ? { collected_at: iso, status: "OK" } : null });

console.log("\n[1] 오늘 누적 · 전일 확정 분리 (같은 달)");
const TD = "2026-09-29", YD = "2026-09-28";
const sep = build("2026-09",
  [stat(TD, "A", 5, 59500, 1, 11900), stat(YD, "A", 20, 238000, 2, 23800), stat(YD, "B", 3, 30000, 0, 0, "P2")],
  [sale("m1", TD, 2, 30000), sale("m2", TD, 1, 15000), sale("m3", YD, 4, 60000), sale("rg-ledger", TD, 999, 9999999, RG)],
  [{ id: "a1", date: TD, channel: "쿠팡 판매자배송", product_id: "P3", qty: 1, used_amount: 15000 }]);
let m = L.model({ todaySummary: sep, yesterdaySummary: sep, today: TD, yesterday: YD,
  todayState: state("2026-09-29T02:10:00Z"), yesterdayState: state("2026-09-28T21:20:30Z"), forDate: S.forDate });
check(m.today.rg, { net_amount: 47600, net_qty: 4, gross_amount: 59500, gross_qty: 5, cancel_amount: 11900, cancel_qty: 1 }, "오늘 로켓그로스 = 판매통계 NET(주문원장 999 무시)");
check([m.today.mp.net_amount, m.today.mp.net_qty, m.today.mp.order_count, m.today.mp.cancel_amount], [30000, 2, 2, 15000], "오늘 판매자배송 = 주문 − 조정 · 주문 2건");
check(m.today.total, { net_amount: 77600, net_qty: 6, cancel_amount: 26900, cancel_qty: 2 }, "오늘 합계 = 로켓그로스 + 그 외");
const dash = S.forDate(sep, TD, { rgOnly: true });
check([m.today.rg.net_amount, m.today.rg.net_qty, m.today.rg.cancel_amount], [dash.net_amount, dash.net_qty, dash.cancel_amount], "[핵심] 대시보드·매출 입력과 같은 공통 집계 값");
check(m.yesterday.total.net_amount, 238000 - 23800 + 30000 + 60000, "전일 합계는 오늘과 섞이지 않음");
check(m.yesterday.confirm, "CONFIRMED", "[핵심] 전일 06:20 KST(=09-28 21:20Z, 하루 끝난 뒤) 수집 = 전일 확정");

console.log("\n[2] 전일 잠정 · 미수집 · 오늘 미수집");
m = L.model({ todaySummary: sep, yesterdaySummary: sep, today: TD, yesterday: YD, todayState: null,
  yesterdayState: state("2026-09-28T09:00:00Z"), forDate: S.forDate });
check(m.yesterday.confirm, "PROVISIONAL", "하루가 끝나기 전(09-28 18:00 KST) 수집 = 잠정");
check(L.dayEndMs(YD), Date.parse("2026-09-28T15:00:00Z"), "하루 끝 = 다음 날 00:00 KST");
const noToday = build("2026-09", [stat(YD, "A", 20, 238000, 2, 23800)], [sale("m1", TD, 2, 30000)]);
m = L.model({ todaySummary: noToday, yesterdaySummary: noToday, today: TD, yesterday: YD, todayState: null, yesterdayState: null, forDate: S.forDate });
check([m.today.rgCollected, m.today.rg, m.today.total], [false, null, null], "[핵심] 오늘 로켓그로스 미수집 → 값 null · 합계 안 만듦(0원 아님)");
check([m.today.mp.net_amount, m.today.mp.order_count], [30000, 1], "로켓그로스 미수집이어도 판매자배송은 그대로 보임");
let html = L.todayHtml(m, { today: TD });
const rgRow = (h) => (h.match(/<tr><td>쿠팡 로켓그로스<\/td>[\s\S]*?<\/tr>/) || [""])[0];
check([html.includes("0원이 아니라 미수집"), /오늘 누적 순매출/.test(html), rgRow(html).includes("₩"), rgRow(html).includes("미수집")], [true, false, false, true],
  "오늘 미수집 문구 · 오늘 합계 카드 없음 · 로켓그로스 행은 금액 대신 '—'·미수집");
check(m.yesterday.confirm, "UNKNOWN", "전일 값은 있는데 수집 이력을 못 읽으면 '확인 필요'(확정이라 하지 않음)");
const noYd = build("2026-09", [stat(TD, "A", 1, 11900, 0, 0)]);
m = L.model({ todaySummary: noYd, yesterdaySummary: noYd, today: TD, yesterday: YD, todayState: null, yesterdayState: null, forDate: S.forDate });
check(m.yesterday.confirm, "NOT_COLLECTED", "전일 판매통계 없음 = 미수집");
html = L.yesterdayHtml(m, { yesterday: YD });
check([html.includes("미수집 · 0원 아님"), html.includes("₩0"), rgRow(html).includes("₩")], [true, false, false], "전일 미수집 표시 · ₩0 없음 · 로켓그로스 행 금액 없음");

console.log("\n[3] 주문 건수 · 월 경계");
m = L.model({ todaySummary: sep, yesterdaySummary: sep, today: TD, yesterday: YD, todayState: state("2026-09-29T02:10:00Z"),
  yesterdayState: state("2026-09-28T21:20:30Z"), forDate: S.forDate });
html = L.viewHtml(m, { today: TD, yesterday: YD, openedAt: "09-29 11:10 KST" });
check([html.includes("판매통계 미제공"), html.includes("2건")], [true, true], "로켓그로스 주문 건수는 '판매통계 미제공', 판매자배송은 원장 2건");
check([html.includes("오늘 누적 매출"), html.includes("전일 매출"), html.includes("전일 확정"), html.includes("잠정값")], [true, true, true, true], "두 카드 분리 · 전일 확정 배지 · 오늘은 잠정 안내");
const oct = build("2026-10", [stat("2026-10-01", "A", 2, 23800, 0, 0)], [sale("o1", "2026-10-01", 1, 10000)]);
const sepEnd = build("2026-09", [stat("2026-09-30", "A", 7, 83300, 0, 0)]);
m = L.model({ todaySummary: oct, yesterdaySummary: sepEnd, today: "2026-10-01", yesterday: "2026-09-30",
  todayState: null, yesterdayState: state("2026-09-30T21:20:00Z"), forDate: S.forDate });
check([m.today.total.net_amount, m.yesterday.total.net_amount, m.yesterday.confirm], [33800, 83300, "CONFIRMED"], "월 경계: 오늘(10월)·전일(9월) 각자 달 집계");
const octNoRg = build("2026-10", [], [sale("o1", "2026-10-01", 1, 10000)]);
m = L.model({ todaySummary: octNoRg, yesterdaySummary: sepEnd, today: "2026-10-01", yesterday: "2026-09-30", todayState: null, yesterdayState: null, forDate: S.forDate });
check([m.today.rgCollected, m.today.mp.net_amount, m.today.mp.order_count], [false, 10000, 1], "새 달 첫날(로켓그로스 0건)에도 판매자배송 값은 보임");

console.log("\n[4] 대시보드 '실시간 매출' 카드(2026-09-29 별도 탭 → 대시보드 통합)");
m = L.model({ todaySummary: sep, yesterdaySummary: sep, today: TD, yesterday: YD, todayState: state("2026-09-29T02:10:00Z"),
  yesterdayState: state("2026-09-28T21:20:30Z"), forDate: S.forDate });
let dh = L.dashboardHtml(m, { today: TD, yesterday: YD, refreshButton: R.buttonHtml({ date: TD, source: "dashboard" }), at: new Date("2026-09-29T02:30:00Z") });
check([dh.includes('id="dash-live"'), dh.includes("오늘 누적 순매출"), dh.includes("₩77,600"), dh.includes("전일 2026-09-28"), dh.includes("전일 확정")], [true, true, true, true, true],
  "오늘 누적 KPI(합계 ₩77,600)와 전일(확정 배지)을 한 카드에서 분리 표시");
check([dh.includes("SalesRefresh.click(this)"), dh.includes("dashboardRefresh()"), dh.includes("화면 새로고침")], [true, true, true],
  "[핵심] 대시보드 안에서 'WING 판매데이터 다시 수집'(기존 확인창) · '화면 새로고침'(다시 읽기) 둘 다");
check([dh.includes("오늘 채널별"), dh.includes("전일 채널별 표"), dh.includes("판매통계 미제공")], [true, true, true], "오늘·전일 채널별 표 · 로켓그로스 주문 건수 미제공 표시");
check(dh.includes("'매출 요약'과 같은 공통 집계"), true, "[핵심] 아래 매출 요약(로켓그로스만)과 값 관계를 밝혀 상충하지 않게");
m = L.model({ todaySummary: noToday, yesterdaySummary: noYd, today: TD, yesterday: YD, todayState: null, yesterdayState: null, forDate: S.forDate });
dh = L.dashboardHtml(m, { today: TD, yesterday: YD });
check([dh.includes("미수집 — 0원이 아니에요"), dh.includes("오늘 누적 순매출"), rgRow(dh).includes("₩"), dh.includes("<b>미수집</b>")], [true, false, false, true],
  "오늘·전일 미수집: 0원 대신 미수집 · 합계 카드 없음");

console.log("\n[5] 쓰기 없음 · 연결");
check(/\.(insert|update|upsert|delete|rpc)\s*\(|fetch\s*\(|sb\.from/.test(liveSrc), false, "[핵심] live_sales.js 는 DB·네트워크를 직접 부르지 않음");
const hyd = appSrc.slice(appSrc.indexOf("// H. 실시간 매출"), appSrc.indexOf("// D+G. 공헌이익"));
check([hyd.length > 300, /\.(insert|update|upsert|delete|rpc)\s*\(/.test(hyd), /requestRefresh|SalesRefresh\.click\(/.test(hyd)], [true, false, false],
  "[핵심] 대시보드 실시간 매출 블록은 읽기만(쓰기·수집 호출 없음)");
check([hyd.includes("salesP"), hyd.includes("buildMonthlyNetSales"), hyd.includes("SalesMonthlySummary.forDate"), hyd.includes("loadDayState"), hyd.includes("SalesRefresh.buttonHtml")],
  [true, true, true, true, true], "매출 요약과 같은 salesP·공통 집계 · 전일이 지난달이면 같은 경로로 그 달만");
check([/<div id="dash-live-slot" style="min-width:0">/.test(appSrc), /id="dash-live" style="[^"]*min-width:0/.test(liveSrc)], [true, true],
  "[핵심] 모바일 가로 넘침 방지: 대시보드 grid 안 슬롯·카드 min-width:0(09-29 390px 실측 623px 넘침)");
check(/<div id="dash-live-slot"/.test(appSrc) && appSrc.indexOf('id="dash-live-slot"') < appSrc.indexOf('<div class="dash-grid">'), true, "대시보드 슬롯: 운영 상태 아래 · 그리드 위(전체 폭)");
check([/livesales:\s*\{/.test(appSrc), appSrc.includes("async function viewLiveSales")], [false, false], "별도 라우트·화면 함수 제거");
check(/hash === "livesales"[\s\S]{0,160}history\.replaceState\(null, "", "#\/dashboard"\)/.test(appSrc), true, "[핵심] 예전 #/livesales 주소는 대시보드로 replaceState(뒤로가기 루프 없음)");
check(indexSrc.includes('data-route="livesales"') || indexSrc.includes("실시간 매출 현황"), false, "[핵심] 사이드바 메뉴 제거");
const pos = (s) => indexSrc.indexOf(s);
check(pos("js/sales_monthly_summary.js") < pos("js/live_sales.js") && pos("js/sales_refresh.js") < pos("js/live_sales.js") && pos("js/live_sales.js") < pos("js/app.js"),
  true, "스크립트 순서: 공통 집계·새로고침 → live_sales → app");
const v = Number((indexSrc.match(/app\.js\?v=(\d+)/) || [])[1]);
const lv = Number((indexSrc.match(/live_sales\.js\?v=(\d+)/) || [])[1]);
check([v >= 154, lv >= 3], [true, true], "캐시 버전 올림(app 154·live_sales 3 이상)");

console.log(failures ? `\nFAIL ${failures}` : "\nALL PASS");
process.exit(failures ? 1 : 0);
