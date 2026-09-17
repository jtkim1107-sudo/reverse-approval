/**
 * fixtures_inv_wing_direct_section_dryrun.js
 * ------------------------------------------------
 * loadInvWingDirectSection() 의 *** 실제 함수 경로 *** 회귀테스트(네트워크·브라우저 없음). 다른
 * fixtures_wing_direct_*_dryrun.js 와 같은 원칙 - js/app.js 의 진짜 소스를 Node vm 으로 그대로
 * 실행한다(재구현 아님, 복붙 아님 - 드리프트 위험 없음).
 *
 * 2026-09-18 [PM 실측 확인] WING shipment 1101728071683166209 는 purchase_orders.wing_direct_
 * shipment_id 로 리버스-발주-2026-016(PO#016)에 이미 연결돼 있다 - 그레이160/블랙80, 합 240 이
 * 아직 WING 기준 미입고다. ERP 매입 원장(received_qty=480, 전량 완료 기록)은 이 작업에서 절대
 * 건드리지 않으므로, 이 값을 별도로 화면에 보여주는 것만으로 풀어야 한다.
 *
 * 2026-09-18 [PM 교차검증 지적 - 1차 구현 버그 2건, 이 파일로 회귀 고정]:
 *   1) 합계를 "이 상품의 죽지 않은 모든 WING 신청"으로 계산하면, 발주서에 연결 안 된 오래된(레거시)
 *      WING 신청까지 다 더해져서 실제보다 훨씬 큰 숫자(실측: 그레이 1,360개)가 "입고중"인 것처럼
 *      보인다 - 합계는 발주서 연결이 *** 확인된 *** shipment 만 더해야 한다.
 *   2) purchase_orders 연결 조회 자체가 실패했을 때 조용히 "연결 없음"(집계 0)으로 넘기면 안 된다 -
 *      "진짜로 연결이 없음"과 "확인을 못 함"을 구분 못 해 위험하다(fail-closed 원칙과 동일) - 조회
 *      실패는 명확히 "조회 실패"로 표시하고 숫자를 안 낸다.
 *
 * *** 로컬 실행만 - 이 파일은 index.html 에서 안 불러옴(운영 번들에 안 들어감, node 로만 실행) ***
 *   node js/fixtures_inv_wing_direct_section_dryrun.js
 */
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const FAILS = [];
function check(name, got, want) {
  const ok = got === want;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`        기대=${JSON.stringify(want)}  실제=${JSON.stringify(got)}`); FAILS.push(name); }
}
function checkIncludes(name, haystack, needle, shouldInclude = true) {
  const ok = String(haystack || "").includes(needle) === shouldInclude;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`        needle=${JSON.stringify(needle)} shouldInclude=${shouldInclude}`); console.log(`        실제 HTML=${haystack}`); FAILS.push(name); }
}

// ── 1) 진짜 소스 로드 ────────────────────────────────────────────────────────────────────────
const APP_JS_PATH = path.join(__dirname, "app.js");
const ERP_UI_JS_PATH = path.join(__dirname, "erp_ui.js");
const appSrcFull = fs.readFileSync(APP_JS_PATH, "utf8");
const CUT_MARKER = "/* ---------- 모바일 사이드바 ---------- */";
const cutIdx = appSrcFull.indexOf(CUT_MARKER);
if (cutIdx < 0) throw new Error(`app.js 에서 절단 지점을 못 찾음("${CUT_MARKER}") - 파일이 바뀌었으면 이 테스트도 같이 고쳐야 해요`);
const appSrc = appSrcFull.slice(0, cutIdx);
const erpUiSrc = fs.readFileSync(ERP_UI_JS_PATH, "utf8");

// ── 2) 가짜 DOM(inv-wing-direct-section 하나만 있으면 됨) ──────────────────────────────────────
function makeFakeElement(id) {
  const el = { id, dataset: {}, style: {} };
  let _innerHTML = "";
  Object.defineProperty(el, "innerHTML", { get() { return _innerHTML; }, set(v) { _innerHTML = v; } });
  return el;
}
function makeFakeDocument() {
  const elements = new Map();
  return {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeFakeElement(id)); return elements.get(id); },
    querySelector: () => null, querySelectorAll: () => [], createElement: tag => makeFakeElement("el-" + tag),
    body: makeFakeElement("body"), addEventListener() {},
  };
}

// ── 3) 가짜 Supabase ─────────────────────────────────────────────────────────────────────────
function makeQueryBuilder(sandbox, table) {
  const calls = [];
  const resolveNow = () => Promise.resolve(sandbox.__sbScript(table, calls));
  const builder = {
    select(...a) { calls.push(["select", ...a]); return builder; },
    eq(...a) { calls.push(["eq", ...a]); return builder; },
    in(...a) { calls.push(["in", ...a]); return builder; },
    order(...a) { calls.push(["order", ...a]); return builder; },
    then(resolve, reject) { return resolveNow().then(resolve, reject); },
  };
  return builder;
}
function makeFakeSb(sandbox) { return { from: table => makeQueryBuilder(sandbox, table) }; }

function buildContext() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.navigator = {};
  sandbox.document = makeFakeDocument();
  sandbox.window.supabase = { createClient: () => makeFakeSb(sandbox) };
  sandbox.__sbScript = () => ({ data: null, error: { message: "스크립트 미설정" } });
  const context = vm.createContext(sandbox);
  const trailer = `
    var __test = { run: function (productId) { return loadInvWingDirectSection(productId); } };
  `;
  const combined = erpUiSrc + "\n" + appSrc + "\n" + trailer;
  new vm.Script(combined, { filename: "app-bundle.js" }).runInContext(context);
  return context;
}

// ── 4) 시나리오별 가짜 select 스크립트 ──────────────────────────────────────────────────────────
function scriptFor({ wingRows = [], wingError = null, linkedPos = [], linkError = null,
  linkCalls = [] } = {}) {
  return (table, calls) => {
    if (table === "wing_direct_inbounds") return { data: wingRows, error: wingError };
    if (table === "purchase_orders") { linkCalls.push(calls); return { data: linkedPos, error: linkError }; }
    throw new Error(`시나리오에 없는 테이블 조회: ${table}`);
  };
}

async function main() {
  console.log("=".repeat(70));
  console.log("loadInvWingDirectSection() - 실제 함수 경로 (vm, 네트워크 없음)");
  console.log("=".repeat(70));

  // ── [1] [핵심 - PM 실측 그대로] 그레이: WING 1101728071683166209 320신청/160입고(pending160),
  //         PO#016(리버스-발주-2026-016)에 연결됨 + 연결 안 된 레거시 WING 신청 2건(합 1,200 짜리
  //         큰 pending) - 합계 배너는 연결된 160 만 나와야 함(레거시는 절대 안 더함) ─────────────
  console.log("\n[1] [핵심] 그레이 - 연결된 shipment(160)만 합산, 레거시 미연결(1,200)은 안 더함");
  const ctx1 = buildContext();
  const linkCalls1 = [];
  ctx1.__sbScript = scriptFor({
    wingRows: [
      { wing_inbound_id: "1101728071683166209", vendor_item_id: "vid-gray", requested_qty: 320, received_qty: 160, expected_date: "2026-09-17", wing_status: "STOWING" },
      { wing_inbound_id: "legacy-1", vendor_item_id: "vid-gray", requested_qty: 800, received_qty: 0, expected_date: "2026-07-01", wing_status: "STOWING" },
      { wing_inbound_id: "legacy-2", vendor_item_id: "vid-gray", requested_qty: 400, received_qty: 0, expected_date: "2026-07-15", wing_status: "INIT_COMPLETED" },
    ],
    linkedPos: [{ po_no: "리버스-발주-2026-016", wing_direct_shipment_id: "1101728071683166209" }],
    linkCalls: linkCalls1,
  });
  await ctx1.__test.run("prod-gray");
  const html1 = ctx1.document.getElementById("inv-wing-direct-section").innerHTML;
  checkIncludes("[핵심] 합계 배너에 160 만 나옴(1,200 안 섞임)", html1, "WING 기준 미입고(입고중) 합계: 160개");
  checkIncludes("합계 1,200 이나 1,360 은 어디에도 안 나옴", html1, "1,200", false);
  checkIncludes("합계 1,360 도 안 나옴", html1, "1,360", false);
  checkIncludes("연결된 shipment 옆에 🔗 리버스-발주-2026-016 연결 배지", html1, "🔗 리버스-발주-2026-016 연결");
  checkIncludes("레거시 legacy-1 행에는 '검토 필요' 표시", html1, "검토 필요");
  check("purchase_orders 조회가 wing_direct_shipment_id in(...) 로 나감",
       linkCalls1[0].some(c => c[0] === "in" && c[1] === "wing_direct_shipment_id"), true);

  // ── [2] 블랙: 같은 shipment, requested=160/received=80(pending=80) - 합계 80 ────────────────
  console.log("\n[2] 블랙 - 같은 shipment 의 블랙 쪽(80)도 정확히 반영");
  const ctx2 = buildContext();
  ctx2.__sbScript = scriptFor({
    wingRows: [{ wing_inbound_id: "1101728071683166209", vendor_item_id: "vid-black", requested_qty: 160, received_qty: 80, expected_date: "2026-09-17", wing_status: "STOWING" }],
    linkedPos: [{ po_no: "리버스-발주-2026-016", wing_direct_shipment_id: "1101728071683166209" }],
  });
  await ctx2.__test.run("prod-black");
  const html2 = ctx2.document.getElementById("inv-wing-direct-section").innerHTML;
  checkIncludes("[핵심] 블랙 합계 80", html2, "WING 기준 미입고(입고중) 합계: 80개");

  // ── [3] [핵심] purchase_orders 연결 조회 자체가 실패 -> "연결 없음(0)"으로 조용히 넘기지 않고
  //         조회 실패를 명확히 표시, 숫자는 안 냄, 레거시 행에도 '검토 필요' 안 붙임(모르니까) ────
  console.log("\n[3] [핵심] 연결 조회 실패 -> 조용히 0 으로 안 넘기고 '조회 실패' 로 명확히 표시");
  const ctx3 = buildContext();
  ctx3.__sbScript = scriptFor({
    wingRows: [{ wing_inbound_id: "1101728071683166209", vendor_item_id: "vid-gray", requested_qty: 320, received_qty: 160, expected_date: "2026-09-17", wing_status: "STOWING" }],
    linkError: { message: "network down" },
  });
  await ctx3.__test.run("prod-gray");
  const html3 = ctx3.document.getElementById("inv-wing-direct-section").innerHTML;
  checkIncludes("[핵심] '연결된 발주서 조회 실패' 문구가 명확히 보임", html3, "연결된 발주서 조회 실패");
  checkIncludes("[핵심] 조회 실패 상태에서 '미입고(입고중) 합계' 숫자는 안 냄(0으로도 안 냄)", html3, "미입고(입고중) 합계", false);
  checkIncludes("조회 실패 상태에서는 '검토 필요' 도 안 붙임(모르는 걸 안다고 말 안 함)", html3, "검토 필요", false);

  // ── [4] 연결 조회는 정상인데 진짜로 연결된 PO 가 하나도 없음(진짜 레거시만) -> 합계 배너 자체가
  //         없어야 하고(0 이라 안 보임), 개별 행엔 '검토 필요' 는 붙어야 함 ─────────────────────
  console.log("\n[4] 진짜 미연결(레거시만) - 합계 배너 없음(0), 개별 행엔 '검토 필요'");
  const ctx4 = buildContext();
  ctx4.__sbScript = scriptFor({
    wingRows: [{ wing_inbound_id: "legacy-3", vendor_item_id: "vid-x", requested_qty: 100, received_qty: 0, expected_date: "2026-07-01", wing_status: "STOWING" }],
    linkedPos: [],
  });
  await ctx4.__test.run("prod-x");
  const html4 = ctx4.document.getElementById("inv-wing-direct-section").innerHTML;
  checkIncludes("합계 배너 자체가 없음(연결된 게 0개라서)", html4, "미입고(입고중) 합계", false);
  checkIncludes("개별 행엔 '검토 필요' 표시됨", html4, "검토 필요");

  // ── [5] 죽은 상태(CANCELLED)는 연결돼 있어도 합계·검토필요 둘 다 제외 ──────────────────────────
  console.log("\n[5] 죽은 상태는 연결돼 있어도 합계·검토필요 제외");
  const ctx5 = buildContext();
  ctx5.__sbScript = scriptFor({
    wingRows: [{ wing_inbound_id: "dead-1", vendor_item_id: "vid-y", requested_qty: 50, received_qty: 0, expected_date: "2026-07-01", wing_status: "CANCELLED" }],
    linkedPos: [{ po_no: "리버스-발주-임의", wing_direct_shipment_id: "dead-1" }],
  });
  await ctx5.__test.run("prod-y");
  const html5 = ctx5.document.getElementById("inv-wing-direct-section").innerHTML;
  checkIncludes("죽은 상태는 미입고(입고중) 합계 배너 없음", html5, "미입고(입고중) 합계", false);
  checkIncludes("죽은 상태는 '검토 필요' 도 안 붙음", html5, "검토 필요", false);

  console.log("\n" + "=".repeat(70));
  if (FAILS.length) { console.log(`FAIL ${FAILS.length}건: ${FAILS.join(", ")}`); process.exit(1); }
  console.log("모두 통과");
}

main().catch(e => { console.error(e); process.exit(1); });
