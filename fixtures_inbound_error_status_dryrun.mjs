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

const errorRow={...BASE_ROW,wing_inbound_id:"1110744421407657984",requested_qty:200};
const plannedRow={...BASE_ROW,wing_inbound_id:"1114936574614704128",requested_qty:200,expected_date:"2099-10-23"};
const box=await run([errorRow,plannedRow],{links:[{po_no:"017",wing_direct_shipment_id:errorRow.wing_inbound_id,memo:"[ERP_INBOUND_ERROR_CONFIRMED]"},{po_no:"new",wing_direct_shipment_id:plannedRow.wing_inbound_id,memo:""}]});
check(box._html.includes("입고 오류 (사용자 확인)"),"Confirmed error remains visible");
check(box._html.includes("입고 예정 · 2099-10-23"),"Planned inbound visible separately");
check(box._html.includes("합계: 200개"),"Only planned 200 counted, not error 200");
if(failures) process.exit(1);
