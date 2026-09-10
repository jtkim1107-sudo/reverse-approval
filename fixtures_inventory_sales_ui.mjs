// fixtures_inventory_sales_ui.mjs
// ------------------------------------------------
// 2026-09-11 재고 발주 목록·상세 모달의 판매량 표시 검증. app.js 에서 실제 함수 정의를
// 그대로 뽑아 실행해요(미러 아님 - 배포되는 코드 그대로).
//   · 목록과 상세 모달이 같은 필드(sales_7d/sales_30d/avg_daily_sales)를 같은 값으로 보여줌
//   · 30일 중 일부만 수집되면 평균 대신 '데이터 부족 n/30일'
//   · 발주 판매량·속도는 RG 판매통계 NET 만. MP 는 참고로 분리 표시하고 합계에 넣지 않음
//     (MP 판매가 있어도 RG 표시값이 불변인지 별도 검증). 오늘 진행 중은 별도
//   · 공유재고 풀 base 는 DB set_qty 환산 합임을 명시
import { readFileSync } from "fs";
const src = readFileSync(new URL("./js/app.js", import.meta.url), "utf8");
function extractFn(name) {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`${name} not found in app.js`);
  return eval(`(${m[0]})`);
}
global.fmt = eval(src.match(/const fmt = [^;]+;/)[0].replace("const fmt = ", ""));
global.esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inventoryVelocityText = extractFn("inventoryVelocityText");
const inventorySalesBasisHtml = extractFn("inventorySalesBasisHtml");

let failures = 0;
const check = (ok, label, extra) => { console.log(`  ${ok ? "OK " : "FAIL"} ${label}`); if (!ok) { failures++; if (extra !== undefined) console.log("     ", extra); } };
const strip = h => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const basis = {
  window_7d: ["2026-09-04", "2026-09-10"], window_30d: ["2026-08-12", "2026-09-10"],
  sales_qty_7d: 66, sales_qty_30d: 211, rg_qty_7d: 66, rg_qty_30d: 211, mp_qty_7d: 0, mp_qty_30d: 0,
  mp_order_qty_7d: 0, mp_adjust_qty_7d: 0, mp_order_qty_30d: 0, mp_adjust_qty_30d: 0,
  velocity_7d: 9.429, velocity_30d: 7.033, avg_daily_sales: 7.033, covered_days_7d: 7, covered_days_30d: 30,
  wing_zero_days: 12, option_qty_30d: { "95936822309": 209, "95993892715": 1, "96002628403": 1 },
  today: { date: "2026-09-11", rg_qty: 3, coverage: "SNAPSHOT_PARTIAL" }, unit_basis: "판매 옵션 수량(재고 환산 없음)", flags: [],
};
const d = { sales_7d: 66, sales_30d: 211, avg_daily_sales: 7.033, sales_basis: basis };

console.log("=== 목록 = 상세 ===");
const list = inventoryVelocityText(d);
const modal = strip(inventorySalesBasisHtml(d, "개"));
check(list === "7.03/일", "목록 판매속도 = 30일 기준", list);
check(modal.includes("7.03개/일"), "상세 일평균 = 목록과 같은 값", modal.slice(0, 200));
check(modal.includes("66개 / 211개"), "상세 7일/30일 = 같은 필드 값");
check(modal.includes("09-04~09-10") && modal.includes("08-12~09-10") && modal.includes("오늘 제외"), "기간(KST 완료일) 표시");
check(modal.includes("최근 30일 로켓그로스 순판매 ÷ 30"), "계산식 표시(RG 만)");

console.log("=== 채널별 검산 · 오늘 · 옵션 · 단위 ===");
check(modal.includes("로켓그로스 판매통계 순판매") && modal.includes("66 / 211"), "발주 기준 = RG 7일/30일");
check(modal.includes("판매자배송") && modal.includes("참고 · 발주 계산 제외"), "MP 는 참고로 분리");

console.log("=== MP 판매가 있어도 RG 표시값 불변(2026-09-11 정책) ===");
const withMp = { ...d, sales_basis: { ...basis, mp_qty_7d: 5, mp_qty_30d: 20, mp_order_qty_30d: 21, mp_adjust_qty_30d: 1 } };
const mm = strip(inventorySalesBasisHtml(withMp, "개"));
check(inventoryVelocityText(withMp) === list, "목록 판매속도 불변(MP 무관)", inventoryVelocityText(withMp));
check(mm.includes("66개 / 211개") && mm.includes("7.03개/일"), "상세 7일/30일·일평균 불변");
check(mm.includes("5 / 20 (주문 21 − 조정 1)"), "MP 는 참고 칸에만(주문 − 조정)", mm.slice(mm.indexOf("판매자배송"), mm.indexOf("판매자배송") + 80));
check(!mm.includes("= 216") && !mm.includes("= 71"), "RG+MP 합계를 만들지 않음");
check(modal.includes("9.43/일"), "7일 평균(참고) = 7일 ÷ 7");
check(modal.includes("7일 7/7 · 30일 30/30") && modal.includes("판매 0 확인 12일"), "수집 완료 일수 표시");
check(modal.includes("오늘 진행 중") && modal.includes("3개"), "오늘은 따로(7·30일 미포함)");
check(modal.includes("95993892715 1") && modal.includes("96002628403 1"), "같은 ERP 상품의 다른 옵션까지 표시");
check(modal.includes("판매 옵션 수량(재고 환산 없음)"), "기준 단위 표시");

console.log("=== 데이터 부족 ===");
const lack = { sales_7d: 14, sales_30d: 40, avg_daily_sales: null,
  sales_basis: { ...basis, sales_qty_30d: 40, velocity_30d: null, avg_daily_sales: null, covered_days_30d: 29,
    flags: ["SALES_DATA_INSUFFICIENT: 최근 30일 중 29일만 수집 완료 - 판매속도를 만들지 않았어요"] } };
check(inventoryVelocityText(lack) === "데이터 부족 29/30일", "목록: 평균 대신 데이터 부족", inventoryVelocityText(lack));
const lm = strip(inventorySalesBasisHtml(lack, "개"));
check(lm.includes("데이터 부족(29/30일 수집)"), "상세: 데이터 부족");
check(lm.includes("29일만 수집 완료"), "부족 사유 표시");
check(!/0\.00개\/일/.test(lm), "0으로 평균을 만들지 않음");

console.log("=== 음수 NET · 공유재고 풀 · 매핑 없음 ===");
const neg = { sales_7d: -6, sales_30d: -6, avg_daily_sales: 0,
  sales_basis: { ...basis, sales_qty_7d: -6, sales_qty_30d: -6, rg_qty_7d: -6, rg_qty_30d: -6, velocity_30d: -0.2, avg_daily_sales: 0,
    flags: ["NET_NEGATIVE: 30일 순판매가 음수(반품 초과) - 발주 계산은 0/일로 봅니다"] } };
const nm = strip(inventorySalesBasisHtml(neg, "개"));
check(nm.includes("-6개 / -6개") && nm.includes("반품 초과"), "음수 순판매 그대로 + 사유");
const pool = { ...d, sales_7d: 60, sales_30d: 145, avg_daily_sales: 4.833, shared_inventory: { role: "base" } };
const pm = strip(inventorySalesBasisHtml(pool, "개"));
check(pm.includes("145개") && pm.includes("세트 구성수량(set_qty)"), "풀 base: DB set_qty 환산 합임을 명시");
check(inventoryVelocityText({ avg_daily_sales: 0.1, shared_inventory: { role: "child" } }) === "0.10세트/일", "세트 옵션은 세트 단위 그대로");
check(strip(inventorySalesBasisHtml({ sales_7d: 1, sales_30d: 2, avg_daily_sales: 0.067 }, "개")).includes("1개 / 2개"), "sales_basis 없는 응답도 깨지지 않음");

console.log("=== 화면 배선 ===");
check(src.includes("const velocityText = inventoryVelocityText(d);"), "목록이 공통 함수 사용");
check(src.includes("${inventorySalesBasisHtml(d, stockUnit)}"), "상세 모달이 공통 함수 사용");
check(src.includes("판매속도(30일)"), "목록 헤더에 기준 기간 표시");

console.log(failures ? `=== 결과: ${failures}건 실패 ===` : "=== 결과: 전체 통과 ===");
process.exit(failures ? 1 : 0);
