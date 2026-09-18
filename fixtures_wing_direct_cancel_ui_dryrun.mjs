// fixtures_wing_direct_cancel_ui_dryrun.mjs
// ------------------------------------------------
// loadInvWingDirectSection()/decideWingDirectCancellation() 의 취소 확인 배지·버튼 로직.
// app.js 소스에서 실제 함수 정의를 그대로 추출해 eval(미러 아님, 배포되는 코드와 절대 안 어긋남).
// 실제 네트워크/DB 없음 - sb는 인자로 받은 고정 데이터만 돌려주는 가짜 체이너.
import { readFileSync } from "fs";

const src = readFileSync(new URL("./js/app.js", import.meta.url), "utf8");

function extractFn(name) {
  const m = src.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`${name} not found in app.js`);
  return eval(`(${m[0]})`);
}

global.esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMatch = src.match(/const fmt = [^;]+;/);
global.fmt = eval(fmtMatch[0].replace("const fmt = ", ""));

let toasts;
global.toast = m => toasts.push(m);
let routeCalls;
global.route = () => { routeCalls++; };
global.inventoryDecisionsCache = "stale";
global._inventoryDecisionsForceRefreshNext = false;

// --- fake box (document.getElementById("inv-wing-direct-section")) ---
function fakeBox() {
  return { _html: "", get innerHTML() { return this._html; }, set innerHTML(h) { this._html = h; } };
}

// --- fake sb: .from(table).select(cols)[.eq(...)][.in(...)][.order(...)] -> {data,error} ---
function fakeSb(tables, rpcResult) {
  const calls = { rpc: [] };
  const chain = (table) => {
    const c = {
      _table: table,
      select() { return c; }, eq() { return c; }, in() { return c; }, order() { return c; },
      then(resolve) { resolve(tables[table] || { data: [], error: null }); },
    };
    // sb.from(...).select(...).eq(...) 는 await 되므로 thenable 이면 충분(진짜 프로미스 아님).
    return c;
  };
  return {
    from: table => chain(table),
    rpc: (fn, args) => { calls.rpc.push({ fn, args }); return Promise.resolve(rpcResult); },
    _calls: calls,
  };
}

let failures = 0;
function check(cond, label, detail) {
  console.log(`  ${cond ? "OK " : "FAIL"} ${label}${cond ? "" : ` - ${detail ?? ""}`}`);
  if (!cond) failures++;
}

const loadInvWingDirectSection = extractFn("loadInvWingDirectSection");
const decideWingDirectCancellation = extractFn("decideWingDirectCancellation");

const BASE_ROW = { wing_inbound_id: "1097838317866586114", vendor_item_id: "95936822309",
  requested_qty: 320, received_qty: 0, expected_date: "2026-09-04", wing_status: "INIT_COMPLETED" };

async function run(rowsOverride, { overrides = [], overrideError = null, linkError = null, links = [], approver = true } = {}) {
  global.me = { approver };
  global.document = { getElementById: id => (id === "inv-wing-direct-section" ? box : null) };
  const box = fakeBox();
  global.document.getElementById = id => (id === "inv-wing-direct-section" ? box : null);
  global.sb = fakeSb({
    wing_direct_inbounds: { data: rowsOverride, error: null },
    purchase_orders: { data: links, error: linkError },
    wing_direct_inbound_overrides: { data: overrides, error: overrideError },
  });
  await loadInvWingDirectSection("prod-mat");
  return box._html;
}

console.log("=== 취소 확인 없음(대조군) - 기존 동작 그대로 ===");
{
  const html = await run([BASE_ROW]);
  check(html.includes(">320<"), "신청 수량 320 표시");
  check(html.includes(">검토 필요<"), "PO 연결도 취소 확인도 없으면 '검토 필요' 배지");
  check(!html.includes("취소 확인(제외)"), "취소 확인 배지 없음(대조군)");
  check(html.includes("onclick=\"decideWingDirectCancellation('1097838317866586114','CONFIRM_CANCELLED','prod-mat')\""),
    "승인권자에게 '취소 확인' 버튼(행동=CONFIRM_CANCELLED)");
}

console.log("\n=== [핵심] 취소 확인됨(충돌 없음) - 미입고에서 제외, 배지 표시 ===");
{
  const html = await run([BASE_ROW], { overrides: [{ wing_inbound_id: "1097838317866586114", reason: "대표 확인", confirmed_at: "2026-09-18T11:19:33+00:00" }] });
  check(html.includes("취소 확인(제외)"), "미입고 칸이 숫자 대신 '취소 확인(제외)'로 표시");
  check(html.includes("✓ 취소 확인"), "상태 칸에 '✓ 취소 확인' 배지");
  check(!html.includes("검토 필요"), "취소 확인된 행은 '검토 필요'로 안 뜸");
  check(html.includes("onclick=\"decideWingDirectCancellation('1097838317866586114','REVOKE','prod-mat')\""),
    "버튼이 '취소 확인 철회'(REVOKE)로 바뀜");
}

console.log("\n=== [핵심] 취소 확인 + PO 연결(🔗)이 같이 있어도 입고중 합계(linkedPendingTotal)에서 제외 ===");
{
  const html = await run([BASE_ROW],
    { overrides: [{ wing_inbound_id: "1097838317866586114", reason: "대표 확인" }],
      links: [{ po_no: "리버스-발주-2026-099", wing_direct_shipment_id: "1097838317866586114" }] });
  check(html.includes("🔗"), "PO 연결 배지 자체는 그대로 보임(발주서 연결 표시 보존)");
  check(!html.includes("WING 기준 미입고(입고중) 합계"), "취소 확인된 건만 있으면 입고중 합계 배너 자체가 안 뜸(0개라서)");
}

console.log("\n=== [핵심] 취소 확인 + 실제 입고(received_qty>0) = 충돌 - 자동 제외 안 하고 경고만 ===");
{
  const conflictRow = { ...BASE_ROW, received_qty: 50 };
  const html = await run([conflictRow], { overrides: [{ wing_inbound_id: "1097838317866586114", reason: "대표 확인" }] });
  check(html.includes("⚠️ 취소 확인·실입고 충돌"), "충돌 배지 표시");
  check(!html.includes("취소 확인(제외)"), "[핵심] 충돌이면 자동으로 제외하지 않음 - 숫자(미입고 270) 그대로 보임");
  check(html.includes(">270<"), "미입고 수량 270(320-50) 그대로 계산됨(취소 확인이 조용히 숫자를 지우지 않음)");
}

console.log("\n=== [핵심] 취소 확인 이력 조회 실패 - fail-closed 경고, 표는 계속 보임(전체 숨김 아님) ===");
{
  const html = await run([BASE_ROW], { overrideError: { message: "network down" } });
  check(html.includes("취소 확인 이력 조회 실패"), "조회 실패 경고 문구 표시");
  check(!html.includes("취소 확인(제외)"), "[핵심] 조회 실패를 '취소 확인 없음'으로 착각해 제외하지 않음(숫자 그대로 보임)");
  check(html.includes(">320<"), "미입고 수량은 원래대로 보임(조용히 안전 방향 - 안 보여주는 게 아니라 경고+원본 유지)");
}

console.log("\n=== 승인 권한 없는 사용자 - 버튼 자체가 안 뜸(RPC 는 서버에서도 막지만 UI 도 안 보여줌) ===");
{
  const html = await run([BASE_ROW], { approver: false });
  check(!html.includes("decideWingDirectCancellation"), "승인권자 아니면 취소 확인/철회 버튼이 아예 없음");
}

console.log("\n=== decideWingDirectCancellation() - 입력 검증·오류·성공 경로 ===");
{
  global.me = { approver: true };
  global.window = { prompt: () => "짧음" };
  toasts = []; routeCalls = 0;
  global.sb = fakeSb({}, { error: null });
  await decideWingDirectCancellation("123", "CONFIRM_CANCELLED", "prod-mat");
  check(toasts.some(t => t.includes("5자 이상")), "사유 5자 미만이면 RPC 호출 전에 막힘");
  check(global.sb._calls.rpc.length === 0, "RPC 자체가 안 불림(검증 실패 시)");
}
{
  global.window = { prompt: () => null };
  toasts = []; routeCalls = 0;
  global.sb = fakeSb({}, { error: null });
  await decideWingDirectCancellation("123", "CONFIRM_CANCELLED", "prod-mat");
  check(toasts.length === 0 && global.sb._calls.rpc.length === 0, "취소(prompt null)면 아무 것도 안 함");
}
{
  global.window = { prompt: () => "대표가 취소 확인함" };
  toasts = []; routeCalls = 0;
  global.sb = fakeSb({}, { error: { message: "permission denied", code: "42501" } });
  global.document = { getElementById: () => fakeBox() };
  await decideWingDirectCancellation("123", "CONFIRM_CANCELLED", "prod-mat");
  check(toasts.some(t => t.includes("처리하지 않았어요") && t.includes("permission denied")), "[핵심] RPC 실패(권한 없음 등)를 사람이 알 수 있게 오류 메시지 그대로 보여줌");
  check(global.inventoryDecisionsCache === "stale", "실패 시 캐시를 안 지움(성공한 것처럼 화면을 안 새로고침)");
}
{
  global.window = { prompt: () => "대표가 취소 확인함(그레이 발판 320개 09-04)" };
  toasts = []; routeCalls = 0;
  global.inventoryDecisionsCache = "stale";
  global.sb = fakeSb({ wing_direct_inbounds: { data: [BASE_ROW], error: null }, purchase_orders: { data: [], error: null },
    wing_direct_inbound_overrides: { data: [], error: null } }, { error: null });
  global.document = { getElementById: () => fakeBox() };
  await decideWingDirectCancellation("1097838317866586114", "CONFIRM_CANCELLED", "prod-mat");
  check(toasts.some(t => t.includes("취소 확인을 기록했습니다")), "성공 시 안내");
  check(global.sb._calls.rpc[0].fn === "fn_decide_wing_direct_cancel" &&
        global.sb._calls.rpc[0].args.p_shipment_id === "1097838317866586114" &&
        global.sb._calls.rpc[0].args.p_action === "CONFIRM_CANCELLED", "[핵심] RPC 인자가 정확함(shipment/action 그대로 전달)");
  check(global.inventoryDecisionsCache === null, "성공 시 재고판단 캐시를 비워 다음 조회가 새로 계산되게 함");
  check(global._inventoryDecisionsForceRefreshNext === true, "다음 조회는 강제 새로고침");
  check(routeCalls === 1, "화면을 다시 그림(route 호출)");
}

console.log("\n=== XSS - onclick 인자에 들어가는 shipment id 가 escape 되는지(따옴표 탈출 방지) ===");
{
  const evilRow = { ...BASE_ROW, wing_inbound_id: "123'-alert(1)-'" };
  const html = await run([evilRow]);
  check(!html.includes("123'-alert(1)-'"), "esc() 없이 원문 그대로 안 새어나감");
  check(html.includes("123&#39;-alert(1)-&#39;"), "작은따옴표가 &#39; 로 이스케이프되어 onclick 속성 탈출 불가(기존 XSS 수정 4806232 와 동일 원칙 준수)");
}

console.log(`\n${failures === 0 ? "모두 통과" : failures + "건 실패"}`);
process.exit(failures === 0 ? 0 : 1);
