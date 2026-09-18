// fixtures_wing_direct_cancel_ui_dryrun.mjs
// ------------------------------------------------
// loadInvWingDirectSection()/decideWingDirectCancellation() 의 취소 확인 배지·버튼 로직.
// app.js 소스에서 실제 함수 정의를 그대로 추출해 eval(미러 아님, 배포되는 코드와 절대 안 어긋남).
// 실제 네트워크/DB 없음 - sb는 인자로 받은 고정 데이터만 돌려주는 가짜 체이너.
//
// 2026-09-18 [교차검증 지적] 인라인 onclick="fn('${esc(id)}')" 는 브라우저가 속성값을 HTML
// 엔티티로 1차 디코드한 뒤 그 결과를 인라인 핸들러의 JS 소스로 2차 파싱하므로, esc() 가 막는 건
// "HTML 속성값 탈출"뿐이고 "디코드된 문자열이 다시 JS 로 파싱되며 생기는 코드 실행"은 못 막는다
// (실제 Chromium 에서 재현 확인: onclick="...('123&#39;-(window.alert(1))-&#39;',...)" 를 클릭하면
// alert(1) 이 실제로 실행됨). 그래서 인라인 onclick 을 없애고 data-* 속성 + addEventListener 로
// 바꿨다 - dataset 값은 속성값 디코드가 1회만 일어나고 그대로 문자열로만 쓰이며 JS 소스로 다시
// 파싱되지 않는다. 아래 fakeBox() 는 이 배선(querySelectorAll(".wing-cancel-btn") ->
// addEventListener -> click())이 실제로 동작하는지까지 검증한다(단순 문자열 포함 여부 확인 아님).
import { readFileSync } from "fs";

const src = readFileSync(new URL("./js/app.js", import.meta.url), "utf8");

function extractFn(name) {
  const m = src.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`${name} not found in app.js`);
  return eval(`(${m[0]})`);
}

global.esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const unesc = s => String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const fmtMatch = src.match(/const fmt = [^;]+;/);
global.fmt = eval(fmtMatch[0].replace("const fmt = ", ""));

let toasts;
global.toast = m => toasts.push(m);
let routeCalls;
global.route = () => { routeCalls++; };
global.inventoryDecisionsCache = "stale";
global._inventoryDecisionsForceRefreshNext = false;

// --- fake box: innerHTML setter parses <button class="...wing-cancel-btn..."> tags into real
// clickable elements(dataset/disabled/addEventListener/click) - not a full DOM, but the actual
// wiring code under test(box.querySelectorAll(...).forEach(btn => btn.addEventListener(...))) runs
// unmodified against these elements, and click() really invokes the registered listener.
function fakeBox() {
  const box = {
    _html: "", _buttons: [],
    get innerHTML() { return this._html; },
    set innerHTML(h) {
      this._html = h;
      this._buttons = [];
      const re = /<button\b([^>]*)>/g;
      let m;
      while ((m = re.exec(h))) {
        const attrs = m[1];
        if (!/class="[^"]*wing-cancel-btn/.test(attrs)) continue;
        const get = name => { const mm = attrs.match(new RegExp(name + '="([^"]*)"')); return mm ? unesc(mm[1]) : undefined; };
        const el = {
          dataset: { shipmentId: get("data-shipment-id"), action: get("data-action") },
          disabled: /(^|\s)disabled(\s|=|>|$)/.test(attrs),
          _listeners: [],
          addEventListener(type, fn) { el._listeners.push({ type, fn }); },
          click() { if (el.disabled) return; el._listeners.filter(l => l.type === "click").forEach(l => l.fn()); },
        };
        this._buttons.push(el);
      }
    },
    querySelectorAll(sel) { return sel === ".wing-cancel-btn" ? this._buttons : []; },
  };
  return box;
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
global.decideWingDirectCancellation = decideWingDirectCancellation;   // 클릭 배선이 부르는 전역 참조

const BASE_ROW = { wing_inbound_id: "1097838317866586114", vendor_item_id: "95936822309",
  requested_qty: 320, received_qty: 0, expected_date: "2026-09-04", wing_status: "INIT_COMPLETED" };

async function run(rowsOverride, { overrides = [], overrideError = null, linkError = null, links = [], approver = true } = {}) {
  global.me = { approver };
  const box = fakeBox();
  global.document = { getElementById: id => (id === "inv-wing-direct-section" ? box : null) };
  global.sb = fakeSb({
    wing_direct_inbounds: { data: rowsOverride, error: null },
    purchase_orders: { data: links, error: linkError },
    wing_direct_inbound_overrides: { data: overrides, error: overrideError },
  });
  await loadInvWingDirectSection("prod-mat");
  return box;
}

console.log("=== 취소 확인 없음(대조군) - 기존 동작 그대로 ===");
{
  const box = await run([BASE_ROW]);
  check(box._html.includes(">320<"), "신청 수량 320 표시");
  check(box._html.includes(">검토 필요<"), "PO 연결도 취소 확인도 없으면 '검토 필요' 배지");
  check(!box._html.includes("취소 확인(제외)"), "취소 확인 배지 없음(대조군)");
  const btn = box._buttons[0];
  check(!!btn && btn.dataset.shipmentId === "1097838317866586114" && btn.dataset.action === "CONFIRM_CANCELLED" && !btn.disabled,
    "승인권자에게 '취소 확인' 버튼(action=CONFIRM_CANCELLED), 비활성 아님");
}

console.log("\n=== [핵심] 취소 확인됨(충돌 없음) - 미입고에서 제외, 배지 표시, 버튼은 REVOKE로 ===");
{
  const box = await run([BASE_ROW], { overrides: [{ wing_inbound_id: "1097838317866586114", reason: "대표 확인", confirmed_at: "2026-09-18T11:19:33+00:00" }] });
  check(box._html.includes("취소 확인(제외)"), "미입고 칸이 숫자 대신 '취소 확인(제외)'로 표시");
  check(box._html.includes("✓ 취소 확인"), "상태 칸에 '✓ 취소 확인' 배지");
  check(!box._html.includes("검토 필요"), "취소 확인된 행은 '검토 필요'로 안 뜸");
  check(box._buttons[0].dataset.action === "REVOKE", "버튼 행동이 '취소 확인 철회'(REVOKE)로 바뀜");
}

console.log("\n=== [핵심] 취소 확인 + PO 연결(🔗)이 같이 있어도 입고중 합계(linkedPendingTotal)에서 제외 ===");
{
  const box = await run([BASE_ROW],
    { overrides: [{ wing_inbound_id: "1097838317866586114", reason: "대표 확인" }],
      links: [{ po_no: "리버스-발주-2026-099", wing_direct_shipment_id: "1097838317866586114" }] });
  check(box._html.includes("🔗"), "PO 연결 배지 자체는 그대로 보임(발주서 연결 표시 보존)");
  check(!box._html.includes("WING 기준 미입고(입고중) 합계"), "취소 확인된 건만 있으면 입고중 합계 배너 자체가 안 뜸(0개라서)");
}

console.log("\n=== [핵심] 취소 확인 + 실제 입고(received_qty>0) = 충돌 - 자동 제외 안 하고 경고만 ===");
{
  const conflictRow = { ...BASE_ROW, received_qty: 50 };
  const box = await run([conflictRow], { overrides: [{ wing_inbound_id: "1097838317866586114", reason: "대표 확인" }] });
  check(box._html.includes("⚠️ 취소 확인·실입고 충돌"), "충돌 배지 표시");
  check(!box._html.includes("취소 확인(제외)"), "[핵심] 충돌이면 자동으로 제외하지 않음 - 숫자(미입고 270) 그대로 보임");
  check(box._html.includes(">270<"), "미입고 수량 270(320-50) 그대로 계산됨(취소 확인이 조용히 숫자를 지우지 않음)");
}

console.log("\n=== [핵심] 취소 확인 이력 조회 실패 - fail-closed 경고 + 버튼 비활성화 ===");
{
  const box = await run([BASE_ROW], { overrideError: { message: "network down" } });
  check(box._html.includes("취소 확인 이력 조회 실패"), "조회 실패 경고 문구 표시");
  check(!box._html.includes("취소 확인(제외)"), "[핵심] 조회 실패를 '취소 확인 없음'으로 착각해 제외하지 않음(숫자 그대로 보임)");
  check(box._html.includes(">320<"), "미입고 수량은 원래대로 보임");
  const btn = box._buttons[0];
  check(!!btn && btn.disabled === true, "[핵심] 조회 실패 시 버튼이 disabled 로 렌더링됨");
  let called = false;
  const spy = () => { called = true; };
  const saved = global.decideWingDirectCancellation;
  global.decideWingDirectCancellation = spy;
  btn._listeners = [{ type: "click", fn: () => saved(btn.dataset.shipmentId, btn.dataset.action, "prod-mat") }];
  btn.click();
  global.decideWingDirectCancellation = saved;
  check(called === false, "[핵심] disabled 버튼은 클릭해도 아무 동작 안 함(click() 자체가 막음)");
}

console.log("\n=== 승인 권한 없는 사용자 - 버튼 자체가 안 뜸 ===");
{
  const box = await run([BASE_ROW], { approver: false });
  check(box._buttons.length === 0, "승인권자 아니면 취소 확인/철회 버튼이 아예 안 만들어짐");
}

console.log("\n=== [핵심 - 실제 클릭 경로] 악의적 ID로 실제 버튼을 클릭 - 인라인 onclick 재파싱 없음 ===");
{
  const MALICIOUS_ID = "123'-(window.alert(1))-'";
  const evilRow = { ...BASE_ROW, wing_inbound_id: MALICIOUS_ID };
  const box = await run([evilRow]);
  check(!box._html.includes("onclick="), "[핵심] 인라인 onclick 속성 자체가 더 이상 없음(2차 JS 파싱 경로 제거)");
  const btn = box._buttons[0];
  check(!!btn, "악의적 ID를 가진 행에도 버튼이 렌더링됨");
  check(btn.dataset.shipmentId === MALICIOUS_ID, "[핵심] dataset 에 악의적 ID가 원문 그대로(속성값 디코드 1회만) 보존됨 - HTML 탈출도 안 됨(속성이 끊기지 않고 정확히 파싱됐다는 뜻)");

  let capturedArgs = null;
  global.sb = fakeSb({}, { error: null });
  const spy = (id, action, pid) => { capturedArgs = [id, action, pid]; return decideWingDirectCancellation(id, action, pid); };
  global.decideWingDirectCancellation = spy;
  global.window = { prompt: () => "실제 클릭 경로 검증용 사유 - 5자 이상" };
  toasts = []; routeCalls = 0;
  btn._listeners = [{ type: "click", fn: () => spy(btn.dataset.shipmentId, btn.dataset.action, "prod-mat") }];
  btn.click();
  await new Promise(r => setTimeout(r, 0));
  check(capturedArgs && capturedArgs[0] === MALICIOUS_ID, "[핵심] 클릭 핸들러가 악의적 ID를 변형·손상 없이 그대로 전달함(디코드된 문자열이 코드로 재실행되지 않았다는 증거 - 손상됐다면 더 이상 원문과 같을 수 없음)");
  check(toasts.some(t => t.includes("기록했습니다")), "클릭이 실제로 정상 동작까지 이어짐");
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
  global.inventoryDecisionsCache = "stale";
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

console.log(`\n${failures === 0 ? "모두 통과" : failures + "건 실패"}`);
process.exit(failures === 0 ? 0 : 1);
