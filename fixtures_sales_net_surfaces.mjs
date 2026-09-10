import fs from "node:fs";

const src = fs.readFileSync(new URL("./js/app.js", import.meta.url), "utf8");
let failures = 0;
function check(ok, label) {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
}
function body(from, to) {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start + from.length);
  return src.slice(start, end < 0 ? src.length : end);
}

const dashboard = body("async function viewDashboard()", "/* ---------- 문서 목록");
const report = body("async function viewReport()", "/* ==================== 발주서");
const ai = body("async function viewAiReport()", "/* ---------- 업무 지시");
const helper = body("async function buildMonthlyNetSales", "function monthlySalesSummaryHtml");

check(dashboard.includes("buildMonthlyNetSales") && dashboard.includes("이번 달 순매출"), "대시보드는 공통 순매출 집계를 사용");
check(dashboard.includes('id="rg-sales-statistics-mount"'), "대시보드 아침 브리핑도 판매통계 패널로 교체");
check(!dashboard.includes("이번 달 주문매출"), "대시보드의 옛 주문매출 라벨 제거");
check(report.includes("Promise.all(months.map(m => buildMonthlyNetSales"), "최근 6개월을 공통 순매출 집계로 계산");
check(report.includes("판매통계 미수집 월은 주문 합계로 대신하지 않습니다"), "월별 리포트 fail-closed 안내");
check(!report.includes("sales.filter(r => monthOf(r) === m).reduce"), "월별 리포트의 원 주문 직접 합산 제거");
check(ai.includes("SalesMonthlySummary?.forDate") && ai.includes("쿠팡 판매통계 NET"), "AI 리포트에 같은 일자 NET 기준 표시");
check(helper.includes('adjustmentResult.status !== "fulfilled"'), "판매자배송 조정 조회 실패도 fail-closed");
check(helper.includes("SalesMonthlySummary?.build"), "세 화면이 한 집계 구현을 공유");

console.log(failures ? `실패 ${failures}건` : "전체 통과");
process.exit(failures ? 1 : 0);
