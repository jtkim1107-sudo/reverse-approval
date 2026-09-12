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

console.log("\n=== 2026-09-13 재입고 제외 · 물류정보 입력 필요 참고값 ===");
check(inventoryOutlookText({ decision: "RESTOCK_EXCLUDED", live_stock: 0 }), "재입고 안 함", "[핵심] 재입고 제외 -> '재입고 안 함'(품절로 보이지 않음)");
const metaMatch = src.match(/const INVENTORY_DECISION_META = \{[\s\S]*?\n\};/);
global.INVENTORY_DECISION_META = eval(`(${metaMatch[0].replace("const INVENTORY_DECISION_META = ", "").replace(/;\s*$/, "")})`);
check(INVENTORY_DECISION_META.RESTOCK_EXCLUDED.label, "⛔ 재입고 제외", "판정 라벨 ⛔ 재입고 제외");
const inventoryReferenceShortageHtml = extractFn("inventoryReferenceShortageHtml");
const ref = inventoryReferenceShortageHtml({ decision: "OK", automation_blocked: true, reference_shortage_ea: 28, reference_lead_time_days: 7,
                                              reference_shortage_note: "참고값 · 정식 추천수량 아님 · 기본 리드타임 7일 기준(안전재고 7일)" });
check(ref.includes("참고값 28개") && ref.includes("정식 추천수량 아님 · 기본 리드타임 7일 기준"), true, "[핵심] 참고 부족 EA: 참고값 · 정식 추천수량 아님 · 기본 리드타임 7일 기준");
check(inventoryReferenceShortageHtml({ decision: "RESTOCK_EXCLUDED", reference_shortage_ea: null }), "-", "재입고 제외는 참고값도 없음");
check(inventoryReferenceShortageHtml({ decision: "ORDER_NOW", recommended_order_qty_ea: 5, reference_shortage_ea: 5 }), "-", "정식 추천이 있으면 참고값을 보여주지 않음");
check(inventoryReferenceShortageHtml({ decision: "OK", reference_shortage_ea: 0 }), "-", "부족 예상 0 이면 표시 안 함");
global.inventoryDecisionLabel = extractFn("inventoryDecisionLabel");
const inventoryAutomationBadge = extractFn("inventoryAutomationBadge");
check(inventoryAutomationBadge({ decision: "OK", automation_blocked: true, automation_label: "물류정보 입력 필요", automation_reason: "최소발주수량 없음" }).includes("자동화: 물류정보 입력 필요"),
      true, "[핵심] 정상 판정 옆에 자동화 배지 '물류정보 입력 필요'(판정 칩은 그대로)");
check(inventoryAutomationBadge({ decision: "AWAITING_INBOUND", automation_blocked: true, automation_label: "SKU 사용 보류(동기화·발주·WING 후보에서 뺌)" }).includes("SKU 사용 보류"), true,
      "SKU 사용 보류 SKU 배지");
check(inventoryAutomationBadge({ decision: "RESTOCK_EXCLUDED", automation_blocked: true, automation_label: "재입고 제외" }), "", "재입고 제외는 판정 칩이 이미 ⛔ 재입고 제외 - 배지 중복 없음");
check(inventoryAutomationBadge({ decision: "OK", automation_blocked: false }), "", "막힘 없으면 배지 없음(기존 화면 그대로)");

global.inventoryStockUnit = extractFn("inventoryStockUnit");
global.inventorySnapshotRef = extractFn("inventorySnapshotRef");
global.inventoryStockDetailText = extractFn("inventoryStockDetailText");
global.inventorySalesBasisHtml = () => "";
global.inventoryIncomingSourceLabel = inventoryIncomingSourceLabel;
global.invVatOf = () => null;
global.ProcurementInput = { vatNeedsAck: () => false };
const modal = { innerHTML: "" };
global.document = { getElementById: id => (id === "modal-root" ? modal : null) };
global.inventoryDecisionsCache = { decisions: [
  { product_id: "desk", vendor_item_id: "95978525500", product_name: "독서대", decision: "ORDER_NOW", decision_reason: "지금 발주", open_po_refs: [] },
  { product_id: "desk", vendor_item_id: "96020412319", product_name: "독서대(중복 리스팅)", decision: "OK", decision_reason: "정상", open_po_refs: [],
    automation_blocked: true, automation_status: "CANDIDATE_EXCLUDED", automation_label: "SKU 사용 보류(동기화·발주·WING 후보에서 뺌)", automation_reason: "중복 리스팅" },
  { product_id: "old", vendor_item_id: "v-old", product_name: "단종 예정", decision: "RESTOCK_EXCLUDED", underlying_decision: "ORDER_NOW",
    decision_reason: "재입고 제외: 단종 (팀장 · 2026-09-13)", open_po_refs: [], automation_blocked: true, automation_label: "재입고 제외" },
  { product_id: "storage3", vendor_item_id: "95931203143", product_name: "수납함 3단", decision: "OK", decision_reason: "현재재고가 재발주점을 충분히 상회함",
    open_po_refs: [], automation_blocked: true, automation_status: "LOGISTICS_INCOMPLETE", automation_label: "물류정보 입력 필요",
    automation_reason: "물류정보 입력 필요: 최소발주수량·리드타임 없음", reference_shortage_ea: 12,
    reference_shortage_note: "참고값 · 정식 추천수량 아님 · 기본 리드타임 7일 기준(안전재고 7일)" },
] };
const openInventoryDecisionDetail = extractFn("openInventoryDecisionDetail");
openInventoryDecisionDetail("old", "v-old");
check(modal.innerHTML.includes("⛔ 재입고 제외 SKU <code>v-old</code>") && modal.innerHTML.includes("제외하지 않았다면: 🔴 지금 발주"), true,
      "재입고 제외 상세: 안내 + 원래 판정 참고");
openInventoryDecisionDetail("desk", "96020412319");
check(modal.innerHTML.includes("<h3>독서대(중복 리스팅)</h3>") && modal.innerHTML.includes("자동화: SKU 사용 보류"), true,
      "[핵심] 같은 상품의 SKU 가 둘이어도 누른 SKU 의 상세 · SKU 사용 보류 안내");
openInventoryDecisionDetail("storage3", "95931203143");
check(["🟢 정상", "자동화: 물류정보 입력 필요", "재고 판단(🟢 정상)은 그대로예요", "부족 예상(참고값)", "기본 리드타임 7일 기준"].every(t => modal.innerHTML.includes(t)), true,
      "[핵심] 물류정보 입력 필요 상세: 판정 칩은 🟢 정상 그대로 + 자동화 안내 + 참고값");
openInventoryDecisionDetail("desk");
check(modal.innerHTML.includes("<h3>독서대</h3>"), true, "SKU 없이 상품으로 여는 기존 경로(기준 상품 보기)도 그대로");

console.log(`\n=== 결과: ${failures === 0 ? "전체 통과" : failures + "건 실패"} ===`);
process.exit(failures === 0 ? 0 : 1);
