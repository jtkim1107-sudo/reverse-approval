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
global.esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inventorySharedInventoryBadge = extractFn("inventorySharedInventoryBadge");

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
check(inventoryIncomingSourceLabel("SHARED_POOL"), "기준 상품 입고예정에서 환산", "[핵심] SHARED_POOL(공유재고 child) - 원시 코드값이 그대로 새지 않고 한글 라벨로 표시");

console.log("\n=== inventorySharedInventoryBadge ===");
check(inventorySharedInventoryBadge({ shared_inventory: null }), "", "공유재고 관계 없으면 빈 문자열(일반 상품 대다수, 회귀 없음)");
check(
  inventorySharedInventoryBadge({ shared_inventory: { role: "child", base_product_name: "아가드 구름목욕시간 제로", set_qty: 2 } }),
  '<br><span class="chip waiting" style="margin-top:4px;display:inline-block">🔗 아가드 구름목욕시간 제로과 재고 공유(1개→2개 소모)</span>',
  "[핵심] child - 🔗 기준상품명 + 소모배수가 뱃지에 명확히 보임"
);
check(
  inventorySharedInventoryBadge({ shared_inventory: { role: "base" } }),
  '<br><span class="chip approved" style="margin-top:4px;display:inline-block">📦 공유재고 기준상품(다른 구성이 이 재고를 나눠 씀)</span>',
  "base - 기준상품이라는 사실도 뱃지로 보임"
);

console.log(`\n=== 결과: ${failures === 0 ? "전체 통과" : failures + "건 실패"} ===`);
process.exit(failures === 0 ? 0 : 1);
