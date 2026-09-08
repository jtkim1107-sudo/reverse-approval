// fixtures_dedupe_auto_over_manual_sales.mjs
// ------------------------------------------------
// 2026-09-08 [매출 이중집계 수정, 사용자 명시] dedupeAutoOverManualSales()가
// js/app.js에 실제로 배포되는 그대로 동작하는지 검증. 미러(복사본) 대신
// app.js 소스에서 함수 정의를 정규식으로 그대로 뽑아 eval하므로, 배포되는
// 실제 코드와 절대 어긋나지 않음(드리프트 방지). 브라우저/Supabase 의존성
// 전혀 없음 - 순수 함수 검증만.
import { readFileSync } from "fs";

const src = readFileSync(new URL("./js/app.js", import.meta.url), "utf8");
const m = src.match(/function dedupeAutoOverManualSales\([\s\S]*?\n}/);
if (!m) {
  console.error("FAIL: dedupeAutoOverManualSales 함수를 app.js에서 찾지 못함");
  process.exit(1);
}
const dedupeAutoOverManualSales = eval(`(${m[0]})`);

let failures = 0;
function check(actual, expected, label) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}` + (ok ? "" : ` (실제=${JSON.stringify(actual)}, 기대=${JSON.stringify(expected)})`));
  if (!ok) failures++;
}

console.log("=== A. auto+manual 동일 그룹 -> auto만 집계 ===");
const a = [
  { date: "2026-09-01", product_id: "p1", channel: "RG", qty: 24, amount: 451440, external_key: "RG-1" },
  { date: "2026-09-01", product_id: "p1", channel: "RG", qty: 22, amount: 412830, external_key: null },
];
const rA = dedupeAutoOverManualSales(a);
check(rA.length, 1, "결과 1행만 남음");
check(rA[0].external_key, "RG-1", "남은 행은 auto(external_key 있음)");

console.log("\n=== B. manual만 존재 -> manual 유지 ===");
const b = [{ date: "2026-08-20", product_id: "p2", channel: "MP", qty: 5, amount: 50000, external_key: null }];
const rB = dedupeAutoOverManualSales(b);
check(rB.length, 1, "자동화 이전 정상 수기 매출은 그대로 유지됨(무조건 제외 금지 확인)");
check(rB[0].external_key, null, "manual 그대로");

console.log("\n=== C. auto만 존재 -> auto 유지 ===");
const c = [{ date: "2026-09-07", product_id: "p3", channel: "RG", qty: 48, amount: 833420, external_key: "RG-9" }];
const rC = dedupeAutoOverManualSales(c);
check(rC.length, 1, "auto 단독 행은 그대로 유지");

console.log("\n=== D. 서로 다른 상품/채널 -> 각각 정상 유지 ===");
const d = [
  { date: "2026-09-02", product_id: "p1", channel: "RG", qty: 18, amount: 338580, external_key: "RG-2" },
  { date: "2026-09-02", product_id: "p1", channel: "RG", qty: 18, amount: 338580, external_key: null }, // 같은 그룹 manual - 제외돼야 함
  { date: "2026-09-02", product_id: "p1", channel: "MP", qty: 1, amount: 9900, external_key: null }, // 다른 채널(MP) - auto 없으니 유지
  { date: "2026-09-02", product_id: "p2", channel: "RG", qty: 4, amount: 59600, external_key: null }, // 다른 상품 - auto 없으니 유지
];
const rD = dedupeAutoOverManualSales(d);
check(rD.length, 3, "그룹별로 독립 판정됨(같은 상품/RG는 auto만, MP/다른상품은 manual 유지)");
check(rD.some(r => r.channel === "MP"), true, "다른 채널(MP)의 manual 행은 살아있음");
check(rD.some(r => r.product_id === "p2"), true, "다른 상품(p2)의 manual 행은 살아있음");
check(rD.filter(r => r.product_id === "p1" && r.channel === "RG").length, 1, "같은 상품/채널 그룹은 auto 1건만");

console.log(`\n=== 결과: ${failures === 0 ? "전체 통과" : failures + "건 실패"} ===`);
process.exit(failures === 0 ? 0 : 1);
