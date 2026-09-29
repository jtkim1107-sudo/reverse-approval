// fixtures_toss_shopping_ui.mjs
// 2026-09-29 토스쇼핑 매출 연결 - 별도 탭 없이 기존 매출 내역·월 합계·대시보드 실시간 매출에 합쳐지는지(네트워크·DB 0)
//   · 공통 집계(SalesMonthlySummary.build): 토스쇼핑 주문 원장 − 조정이 '그 외' 합계에 한 번만 · 로켓그로스 주문 원장 무시 그대로
//   · 매출 내역 행: '토스쇼핑 · 상품명' (쿠팡 두 채널은 기존 상품명 그대로) · 주문 상세 창 제목도
//   · 월 요약 문구·대시보드 실시간 매출: '그 외'를 채널별로(판매자배송 · 토스쇼핑), 채널 합 = 그 외 합계
import fs from "node:fs";

let failures = 0;
function check(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) console.log("   expected", JSON.stringify(expected), "\n   actual  ", JSON.stringify(actual));
}
const read = (p) => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const win = {};
new Function("window", read("./js/sales_monthly_summary.js"))(win);
new Function("window", read("./js/sales_refresh.js"))(win);
new Function("window", read("./js/live_sales.js"))(win);
const S = win.SalesMonthlySummary, L = win.LiveSales;
const appSrc = read("./js/app.js");

const RG = "쿠팡 로켓그로스", MP = "쿠팡 판매자배송", TOSS = "토스쇼핑", D = "2026-09-29";
const stats = [{ sales_date: D, channel: RG, option_id: "A", product_id: "P1", gross_qty: 5, gross_amount: 59500, cancel_qty: 1, cancel_amount: 11900, net_qty: 4, net_amount: 47600 }];
const sales = [
  { id: "rg", date: D, channel: RG, product_id: "P1", qty: 99, amount: 9999999, external_key: "RG-1" },
  { id: "mp", date: D, channel: MP, product_id: "P2", qty: 1, amount: 9880, external_key: "MP-1-001", memo: "23103271964635" },
  { id: "t1", date: D, channel: TOSS, product_id: "P3", qty: 1, amount: 25900, external_key: "TOSS-1", memo: "토스쇼핑 주문 O-1 · 주문결제 09-29 14:05 KST · 결제완료" },
  { id: "t2", date: D, channel: TOSS, product_id: "P3", qty: 2, amount: 30000, external_key: "TOSS-2", memo: "토스쇼핑 주문 O-2 · 주문결제 09-29 15:00 KST · 결제취소" },
];
const adj = [{ id: "a1", date: D, channel: TOSS, product_id: "P3", qty: 2, used_amount: 30000 }];
const sum = S.build({ month: "2026-09", statisticsRows: stats, salesRows: sales, adjustmentRows: adj, productName: (id) => ({ P1: "휴지통", P2: "스프레이건", P3: "원형의자발커버" }[id]) });

console.log("\n[1] 공통 집계 - 중복 없음");
const toss = sum.entries.find((e) => e.channel === TOSS);
check([toss.product_name, toss.order_count, toss.gross_amount, toss.cancel_amount, toss.net_amount, toss.net_qty], ["원형의자발커버", 2, 55900, 30000, 25900, 1],
  "토스쇼핑 행 1개(날짜·상품·채널) · 주문 2건 · 취소 30,000 차감");
check(sum.total.net_amount, 47600 + 9880 + 25900, "[핵심] 전체 합계 = 로켓그로스 NET + 판매자배송 + 토스쇼핑(각 한 번) · RG 주문 원장 무시");
check(sum.marketplace.net_amount, 9880 + 25900, "'그 외' 합계에 토스쇼핑 포함");

console.log("\n[2] 매출 내역 행 표시");
const pick = (name) => { const m = appSrc.match(new RegExp(`(?:const|function) ${name}[\\s\\S]*?\\n}\\n|const ${name} = [^\\n]*\\n`)); if (!m) throw new Error(name); return m[0]; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Math.round(Number(n) || 0).toLocaleString("ko-KR");
const ctx = new Function("esc", "fmt", `${pick("COUPANG_SALES_CHANNELS")}${pick("salesRowTitle")}${pick("otherChannelsSummaryText")}; return { salesRowTitle, otherChannelsSummaryText };`)(esc, fmt);
check(ctx.salesRowTitle(toss), "토스쇼핑 · 원형의자발커버", "[핵심] 토스쇼핑 행: '토스쇼핑 · 상품명'");
check(ctx.salesRowTitle(sum.entries.find((e) => e.channel === MP)), "스프레이건", "쿠팡 판매자배송 행은 기존 상품명 그대로");
check(ctx.salesRowTitle(sum.entries.find((e) => e.channel === RG)), "휴지통", "로켓그로스 행 그대로");
check(/<b>\$\{esc\(salesRowTitle\(group\)\)\}<\/b>/.test(appSrc) && /\$\{esc\(group\.date\)\} · \$\{esc\(salesRowTitle\(group\)\)\}<\/h3>/.test(appSrc), true, "매출 내역 표·주문 상세 창 제목이 같은 표시 함수");
check(toss.ledger_rows.map((r) => r.memo), ["토스쇼핑 주문 O-1 · 주문결제 09-29 14:05 KST · 결제완료", "토스쇼핑 주문 O-2 · 주문결제 09-29 15:00 KST · 결제취소"],
  "주문 상세: 주문번호·주문결제 시각·상태가 적요로(기존 행 구조)");
check(ctx.otherChannelsSummaryText(sum, sum.marketplace), "· 판매자배송 순매출 ₩9,880 (1개) · 토스쇼핑 순매출 ₩25,900 (1개)", "[핵심] 월 요약: 판매자배송·토스쇼핑 따로");
check(ctx.otherChannelsSummaryText({ entries: [] }, { net_amount: 0, net_qty: 0 }), "· 판매자배송 순매출 ₩0 (0개)", "그 외 채널 없으면 기존 문구");

console.log("\n[3] 대시보드 실시간 매출");
const m = L.model({ todaySummary: sum, yesterdaySummary: sum, today: D, yesterday: "2026-09-28", todayState: null, yesterdayState: null, forDate: S.forDate });
check([m.today.mp.net_amount, Object.keys(m.today.mp.channels).sort(), m.today.mp.channels[TOSS].net_amount, m.today.mp.channels[TOSS].order_count], [35780, [MP, TOSS].sort(), 25900, 2],
  "'그 외' = 판매자배송 + 토스쇼핑 · 채널별 분리");
check(Object.values(m.today.mp.channels).reduce((t, c) => t + c.net_amount, 0), m.today.mp.net_amount, "채널 합 = 그 외 합계(중복 없음)");
const html = L.dashboardHtml(m, { today: D, yesterday: "2026-09-28" });
const rows = [...html.matchAll(/<tr><td>([^<]+)<\/td>/g)].map((x) => x[1]);
check(rows.slice(0, 3), ["쿠팡 로켓그로스", MP, TOSS], "[핵심] 채널별 표: 로켓그로스 · 쿠팡 판매자배송 · 토스쇼핑");
check(html.includes("₩83,380"), true, "오늘 누적 합계 = 47,600 + 9,880 + 25,900");

console.log(failures ? `\nFAIL ${failures}` : "\nALL PASS");
process.exit(failures ? 1 : 0);
