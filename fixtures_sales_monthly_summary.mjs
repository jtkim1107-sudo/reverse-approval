import fs from "node:fs";

const src = fs.readFileSync(new URL("./js/sales_monthly_summary.js", import.meta.url), "utf8");
const win = {};
new Function("window", src)(win);
const build = win.SalesMonthlySummary.build;

let failures = 0;
function check(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok) console.log(" expected", expected, "actual", actual);
}

const stats = [
  { sales_date: "2026-09-09", channel: "쿠팡 로켓그로스", option_id: "A", product_id: "P1", product_name: "옵션 A", gross_qty: 26, gross_amount: 309400, cancel_qty: 1, cancel_amount: 11900, net_qty: 25, net_amount: 297500 },
  { sales_date: "2026-09-09", channel: "쿠팡 로켓그로스", option_id: "B", product_id: "P2", product_name: "EPP", gross_qty: 0, gross_amount: 0, cancel_qty: 6, cancel_amount: 112860, net_qty: -6, net_amount: -112860 },
  { sales_date: "2026-09-08", channel: "쿠팡 로켓그로스", option_id: "C", product_id: "P1", product_name: "옵션 C", gross_qty: 2, gross_amount: 23800, cancel_qty: 0, cancel_amount: 0, net_qty: 2, net_amount: 23800 },
];
const sales = [
  { id: "rg-order", date: "2026-09-09", channel: "쿠팡 로켓그로스", product_id: "P1", qty: 999, amount: 999999 },
  { id: "m1", date: "2026-09-09", channel: "쿠팡 판매자배송", product_id: "P3", qty: 2, amount: 30000 },
  { id: "m2", date: "2026-09-09", channel: "쿠팡 판매자배송", product_id: "P3", qty: 1, amount: 15000 },
];
const adjustments = [
  { id: "rg-return", date: "2026-09-09", channel: "쿠팡 로켓그로스", product_id: "P1", qty: 10, used_amount: 100000 },
  { id: "mp-return", date: "2026-09-09", channel: "쿠팡 판매자배송", product_id: "P3", qty: 1, used_amount: 15000 },
];
const out = build({ month: "2026-09", statisticsRows: stats, salesRows: sales, adjustmentRows: adjustments, productName: id => ({P1:"휴지통",P2:"EPP",P3:"판매자배송 상품"}[id]) });

check(out.rocket_growth, { gross_qty: 28, gross_amount: 333200, cancel_qty: 7, cancel_amount: 124760, net_qty: 21, net_amount: 208440 }, "RG는 판매통계 NET만 합산");
check(out.marketplace, { gross_qty: 3, gross_amount: 45000, cancel_qty: 1, cancel_amount: 15000, net_qty: 2, net_amount: 30000 }, "판매자배송은 주문-조정");
check(out.total, { net_qty: 23, net_amount: 238440 }, "월 전체 순매출 합계");
check(out.entries.length, 4, "날짜+상품+채널 단위 4행");
check(out.entries.some(x => x.key === "2026-09-09|P3|쿠팡 판매자배송" && x.order_count === 2), true, "두 주문을 상품별 한 행으로 집계");
check(out.entries.some(x => x.key === "2026-09-09|P1|쿠팡 로켓그로스" && x.net_qty === 25), true, "RG 주문원장과 RG 조정을 이중 반영하지 않음");
check(win.SalesMonthlySummary.forDate(out, "2026-09-09"), {
  date: "2026-09-09",
  entries: out.entries.filter(x => x.date === "2026-09-09"),
  net_qty: 21, net_amount: 214640,
  gross_qty: 29, gross_amount: 354400,
  cancel_qty: 8, cancel_amount: 139760,
  collected: true,
}, "AI 일자 기준도 월 집계와 같은 NET에서 계산");

console.log(failures ? `실패 ${failures}건` : "전체 통과");
process.exit(failures ? 1 : 0);
