// fixtures_truck_inbound_prep_ui.mjs
// ------------------------------------------------
// 2026-09-08 [TRUCK 준비대기 UX, 사용자 명시] truckPrepActionHtml() 검증.
// app.js 소스에서 실제 함수 정의를 그대로 추출해 eval(미러 아님) - 백엔드
// /api/truck-inbound-prep이 이미 만든 required_action에 따라 화면이 올바른
// 액션 UI(무게 입력/센터 선택/확인)를 고르는지, 개발자 용어(vendorItemId 등)가
// 첫 화면 텍스트에 노출되지 않는지 확인해요.
import { readFileSync } from "fs";

const src = readFileSync(new URL("./js/app.js", import.meta.url), "utf8");

function extractFn(name) {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`${name} not found in app.js`);
  return eval(`(${m[0]})`);
}

global.esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const truckPrepActionHtml = extractFn("truckPrepActionHtml");

let failures = 0;
function check(actual, expected, label) {
  const ok = actual === expected;
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}` + (ok ? "" : ` (실제=${JSON.stringify(actual)}, 기대=${JSON.stringify(expected)})`));
  if (!ok) failures++;
}
function checkContains(haystack, needle, label) {
  const ok = haystack.includes(needle);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}` + (ok ? "" : ` (문자열에 없음: ${JSON.stringify(needle)})`));
  if (!ok) failures++;
}
function checkNotContains(haystack, needle, label) {
  const ok = !haystack.includes(needle);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}` + (ok ? "" : ` (있으면 안 되는데 있음: ${JSON.stringify(needle)})`));
  if (!ok) failures++;
}

console.log("=== truckPrepActionHtml ===");

const weightRow = {
  purchase_order_item_id: "poi-015", vendor_item_id: "95936822308",
  product_id: "black-pid", channel_mapping_id: "mapping-black", required_action: "ENTER_WEIGHT",
};
const weightHtml = truckPrepActionHtml(weightRow, "");
checkContains(weightHtml, "무게(g)", "[핵심] ENTER_WEIGHT - 무게 입력 필드가 보임");
checkContains(weightHtml, "saveTruckMetadataWeight('95936822308','black-pid','mapping-black','poi-015')",
  "무게 저장 버튼에 vendor_item_id/product_id/channel_mapping_id/poi_id가 그대로 전달됨(재조회 없이)");
checkNotContains(weightHtml, "product_channel_mapping", "[핵심] 개발자 용어(product_channel_mapping)가 첫 화면 액션에 노출 안 됨");

const centerRow = { id: "prep-1", required_action: "SELECT_CENTER" };
const centerHtml = truckPrepActionHtml(centerRow, '<option value="c1">서울센터</option>');
checkContains(centerHtml, "서울센터", "[핵심] SELECT_CENTER - 센터 선택 드롭다운이 보임");
checkContains(centerHtml, "saveTruckPrepCenter('prep-1')", "센터 저장 버튼에 prep id가 전달됨");

const procRow = { purchase_order_item_id: "poi-010a", required_action: "REGISTER_PROCUREMENT" };
const procHtml = truckPrepActionHtml(procRow, "");
checkContains(procHtml, "확인", "[핵심] REGISTER_PROCUREMENT 등 자가입력 불가 상태는 '확인' 버튼만(거짓 액션 안 보여줌)");
checkNotContains(procHtml, "product_procurement", "[핵심] 개발자 용어(product_procurement)가 첫 화면 액션에 노출 안 됨");
checkContains(procHtml, "toggleTruckPrepDetail('poi-010a')", "'확인' 버튼이 상세보기 토글로 연결됨");

console.log(`\n=== 결과: ${failures === 0 ? "전체 통과" : failures + "건 실패"} ===`);
process.exit(failures === 0 ? 0 : 1);
