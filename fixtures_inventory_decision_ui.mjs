// fixtures_inventory_decision_ui.mjs
// ------------------------------------------------
// 2026-09-08 [재고·발주 판단 엔진 통일, 사용자 명시] 프론트 순수 함수
// (inventoryOutlookText/inventoryIncomingText) 검증. app.js 소스에서 실제
// 함수 정의를 그대로 추출해 eval(미러 아님, 배포되는 코드와 절대 안 어긋남).
import { readFileSync } from "fs";

const src = readFileSync(new URL("./js/app.js", import.meta.url), "utf8");

function extractFn(name) {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`${name} not found in app.js`);
  return eval(`(${m[0]})`);
}

const fmtMatch = src.match(/const fmt = [^;]+;/);
global.fmt = eval(fmtMatch[0].replace("const fmt = ", ""));

const inventoryOutlookText = extractFn("inventoryOutlookText");
const inventoryIncomingText = extractFn("inventoryIncomingText");

const labelMatch = src.match(/const INCOMING_SOURCE_LABEL = \{[\s\S]*?\};/);
global.INCOMING_SOURCE_LABEL = eval(`(${labelMatch[0].replace("const INCOMING_SOURCE_LABEL = ", "").replace(/;\s*$/, "")})`);
const srcLabelFnMatch = src.match(/const inventoryIncomingSourceLabel = [^;]+;/);
const inventoryIncomingSourceLabel = eval(`(${srcLabelFnMatch[0].replace("const inventoryIncomingSourceLabel = ", "").replace(/;\s*$/, "")})`);

let failures = 0;
function check(actual, expected, label) {
  const ok = actual === expected;
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}` + (ok ? "" : ` (실제=${JSON.stringify(actual)}, 기대=${JSON.stringify(expected)})`));
  if (!ok) failures++;
}

console.log("=== inventoryOutlookText ===");
check(inventoryOutlookText({ decision: "DATA_CHECK" }), "확인 필요", "DATA_CHECK -> 확인 필요");
check(inventoryOutlookText({ decision: "ORDER_NOW", live_stock: 0, incoming_qty: 0 }), "품절", "재고 0, 입고예정 없음 -> 품절");
check(inventoryOutlookText({ decision: "AWAITING_INBOUND", live_stock: 0, incoming_qty: 320 }), "품절 · 입고대기", "재고 0, 입고예정 있음 -> 품절·입고대기");
check(inventoryOutlookText({ decision: "OK", live_stock: 100, days_of_stock_now: 12.3 }), "약 12.3일", "정상 - 재고일수 표시");

console.log("\n=== inventoryIncomingText ===");
check(inventoryIncomingText({ incoming_qty: 0 }), "-", "입고예정 없음 -> -");
check(inventoryIncomingText({ incoming_qty: 320, incoming_date: "2026-09-07" }), "+320 · 09/07", "[핵심] 09-11 등 임의 날짜 아니라 시스템 incoming_date 그대로 표시");
check(inventoryIncomingText({ incoming_qty: 80, incoming_date: null }), "+80 · 날짜 확인필요", "PO는 있지만 확정일 없음 -> 날짜 확인필요(추정 안 함)");

console.log("\n=== inventoryIncomingSourceLabel ===");
check(inventoryIncomingSourceLabel("PO_DUE_DATE"), "발주서 예상입고일", "[핵심] PO_DUE_DATE - 사람이 확인한 예상입고일 표시");
check(inventoryIncomingSourceLabel("INBOUND_PLAN"), "WING 예약 슬롯", "INBOUND_PLAN - WING 슬롯만 있을 때");
check(inventoryIncomingSourceLabel("PO_ONLY"), "발주만 있음(입고일 미확정)", "PO_ONLY - 확정일 없음");
check(inventoryIncomingSourceLabel(undefined), "-", "값 없으면 - 표시");

console.log(`\n=== 결과: ${failures === 0 ? "전체 통과" : failures + "건 실패"} ===`);
process.exit(failures === 0 ? 0 : 1);
