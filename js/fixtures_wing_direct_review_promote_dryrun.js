/**
 * fixtures_wing_direct_review_promote_dryrun.js
 * ------------------------------------------------
 * promoteWingDirectDraft()/rejectWingDirectDraft() 의 *** 실제 함수 경로 *** 회귀테스트(네트워크·
 * 브라우저 없음). 백엔드 fixtures_*.py 와 같은 원칙 - 손으로 만든 요약이 아니라 js/app.js 의 진짜
 * 소스를 Node vm 으로 그대로 실행해서(재구현 아님, 복붙 아님 - 드리프트 위험 없음) 그 실제 코드
 * 경로를 태운다.
 *
 * 2026-09-18 [Codex 재교차검증 지적 - fail-open 버그 3건]:
 *   1) 다른 활성 PO 겹침 조회 error 를 버려서, 조회 실패해도 "겹침 없음"으로 잘못 전환됨.
 *   2) 품목 조회가 성공해도 items=[] 면 빈 초안을 그대로 승인할 수 있었음.
 *   3) 전환 직전 WING 원본(wing_direct_inbounds)의 현재 상태/신선도를 재확인하지 않아, 수집 뒤
 *      WING 쪽에서 CANCELLED 로 바뀌었거나 원본이 오래된 초안도 승인 가능했음.
 * 이 파일은 세 버그가 실제로 막히는지, 그리고 정상 경로(전결/결재자 지정)는 여전히 통과하는지를
 * 진짜 promoteWingDirectDraft() 를 호출해서 검증한다.
 *
 * *** 로컬 실행만 - 이 파일은 index.html 에서 안 불러옴(운영 번들에 안 들어감, node 로만 실행) ***
 *   node js/fixtures_wing_direct_review_promote_dryrun.js
 */
"use strict";
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const FAILS = [];
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`        기대=${JSON.stringify(want)}  실제=${JSON.stringify(got)}`); FAILS.push(name); }
}

// ── 1) 진짜 소스 로드 - "/* ---------- 모바일 사이드바 ---------- */" 주석 직전까지만(그 뒤는
//      boot()/이벤트 리스너 배선일 뿐 테스트 대상 함수와 무관 - 실행하려면 브라우저 전용 API 가
//      훨씬 많이 필요해짐). 테스트 대상 함수(promoteWingDirectDraft 등)는 전부 그 앞에 있다. ──────
const APP_JS_PATH = path.join(__dirname, "app.js");
const ERP_UI_JS_PATH = path.join(__dirname, "erp_ui.js");
const appSrcFull = fs.readFileSync(APP_JS_PATH, "utf8");
const CUT_MARKER = "/* ---------- 모바일 사이드바 ---------- */";
const cutIdx = appSrcFull.indexOf(CUT_MARKER);
if (cutIdx < 0) throw new Error(`app.js 에서 절단 지점을 못 찾음("${CUT_MARKER}") - 파일이 바뀌었으면 이 테스트도 같이 고쳐야 해요`);
const appSrc = appSrcFull.slice(0, cutIdx);
const erpUiSrc = fs.readFileSync(ERP_UI_JS_PATH, "utf8");

// ── 2) 가짜 DOM ──────────────────────────────────────────────────────────────────────────────
function makeFakeElement(id) {
  const el = {
    id, value: "", textContent: "", disabled: false, hidden: false,
    dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    appendChild() {}, remove() {}, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [],
  };
  // confirmModal()/infoModal() 은 modal-root.innerHTML = "..." 로만 "떴다"는 걸 표시한다(실제 클릭
  // 이벤트가 없음) - _onInnerHTML 훅으로 그 순간을 결정적으로 감지한다(run() 이 내부 클로저의
  // confirmModal 을 직접 부르기 때문에 ErpUi.confirmModal 을 밖에서 바꿔치기해도 못 가로챈다).
  let _innerHTML = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return _innerHTML; },
    set(v) { _innerHTML = v; if (el._onInnerHTML) el._onInnerHTML(v); },
  });
  return el;
}
function makeFakeDocument() {
  const elements = new Map();
  return {
    _elements: elements,
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeFakeElement(id)); return elements.get(id); },
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: tag => makeFakeElement("el-" + tag),
    body: makeFakeElement("body"),
    addEventListener() {},
  };
}

// ── 3) 가짜 Supabase ─────────────────────────────────────────────────────────────────────────
function makeQueryBuilder(sandbox, table) {
  const calls = [];
  let isSingle = false;
  const resolveNow = () => Promise.resolve(sandbox.__sbScript(table, calls, isSingle));
  const builder = {
    select(...a) { calls.push(["select", ...a]); return builder; },
    eq(...a) { calls.push(["eq", ...a]); return builder; },
    in(...a) { calls.push(["in", ...a]); return builder; },
    order(...a) { calls.push(["order", ...a]); return builder; },
    update(...a) { calls.push(["update", ...a]); return builder; },
    insert(...a) { calls.push(["insert", ...a]); return builder; },
    maybeSingle() { isSingle = true; return resolveNow(); },
    single() { isSingle = true; return resolveNow(); },
    then(resolve, reject) { return resolveNow().then(resolve, reject); },
  };
  return builder;
}
function makeFakeSb(sandbox) { return { from: table => makeQueryBuilder(sandbox, table) }; }

// ── 4) vm 컨텍스트 - window === context(브라우저처럼 self-reference), erp_ui.js 의
//      root.ErpUi = {...} 가 그대로 바깥 컨텍스트 전역 ErpUi 로도 보임 ──────────────────────────
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
    var __test = {
      setMe: function (v) { me = v; },
      setUsers: function (v) { USERS = v; },
      getPromote: function () { return promoteWingDirectDraft; },
      getReject: function () { return rejectWingDirectDraft; },
      getPOStatus: function () { return PO_STATUS; },
    };
    // route()/loadPOs() 는 이 테스트 대상이 아니고(화면 전체 렌더링·발주 전체 재조회라는 별개의 큰
    // 함수) 가짜 DOM/서버로는 안전하게 못 도니 no-op 로 바꿔치기 - promoteWingDirectDraft 자신의
    // 로직(precheck/confirm/exec)은 원본 그대로 실행됨(재정의 안 함).
    route = async function () { __test.routeCalls = (__test.routeCalls || 0) + 1; };
    loadPOs = async function () { __test.loadPOsCalls = (__test.loadPOsCalls || 0) + 1; };
    closeModal = function () { __test.closeModalCalls = (__test.closeModalCalls || 0) + 1; };
    toast = function (msg) { __test.toasts = __test.toasts || []; __test.toasts.push(msg); };
  `;
  const combined = erpUiSrc + "\n" + appSrc + "\n" + trailer;
  new vm.Script(combined, { filename: "app-bundle.js" }).runInContext(context);
  return context;
}

// 확인창(confirmModal)이 실제로 렌더된(= pending 이 세팅된) 시점을 결정적으로 신호받는다(setTimeout
// 추측 대신 - precheck 의 비동기 sb 조회 횟수가 시나리오마다 달라서 임의 대기는 경쟁조건이 됨).
// run() 이 클로저 안의 confirmModal 을 직접 호출하므로 ErpUi.confirmModal 바꿔치기로는 못 가로채고,
// modal-root.innerHTML 세팅(그 함수의 유일한 관찰 가능 부수효과)을 감지한다.
function armConfirmSignal(ctx) {
  let resolveReady;
  const ready = new Promise(r => { resolveReady = r; });
  const modalRoot = ctx.document.getElementById("modal-root");
  modalRoot._onInnerHTML = html => { if (html.includes("erp-confirm-title")) resolveReady(); };
  return ready;
}

const FRESH_CHECKED_AT = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();    // 2시간 전 - 신선
const STALE_CHECKED_AT = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();   // 40시간 전 - 오래됨(기준 36h)

const BASE_PO = { id: "po-1", po_no: "리버스-발주-WING검토-ship-1", status: "wing_direct_review",
  supplier: "리파코", total: 1000000, memo: "", wing_direct_shipment_id: "ship-1" };
const BASE_ITEMS = [{ po_id: "po-1", product_id: "prod-a", vendor_item_id: "vid-a", qty: 100, received_qty: 0, wing_observed_received_qty: 0 }];
// 기본 미러 - BASE_ITEMS 와 수량이 정확히 같아야(품목쪽 qty=requested_qty, wing_observed_received_qty=received_qty)
// 그 자체로는 안 막힘(수량 비교 통과) - 수량이 다른 테스트만 따로 override.
const MATCHING_MIRROR_ROW = { vendor_item_id: "vid-a", requested_qty: 100, received_qty: 0, wing_status: "STOWING", source_checked_at: FRESH_CHECKED_AT };

function scriptFor({ poRow = BASE_PO, items = BASE_ITEMS, itemsError = null,
  mirrorRows = [MATCHING_MIRROR_ROW], mirrorError = null,
  overlapRows = [], overlapError = null, updateOk = true, updateCalls = [] } = {}) {
  return (table, calls) => {
    if (table === "purchase_orders" && calls.some(c => c[0] === "update")) {
      updateCalls.push(calls.find(c => c[0] === "update")[1]);
      if (!updateOk) return { data: null, error: { message: "update 실패(시뮬레이션)" } };
      return { data: [{ id: poRow.id }], error: null };
    }
    if (table === "purchase_orders") return { data: poRow, error: null };
    if (table === "purchase_order_items" && calls.some(c => c[0] === "in")) return { data: overlapRows, error: overlapError };
    if (table === "purchase_order_items") return { data: items, error: itemsError };
    if (table === "wing_direct_inbounds") return { data: mirrorRows, error: mirrorError };
    throw new Error(`시나리오에 없는 테이블 조회: ${table}`);
  };
}

async function main() {
  console.log("=".repeat(70));
  console.log("promoteWingDirectDraft() / rejectWingDirectDraft() - 실제 함수 경로 (vm, 네트워크 없음)");
  console.log("=".repeat(70));

  // ── [1]~[6] precheck 단계에서 막혀야 하는 경우 - confirm() 까지 절대 안 감, update 호출 0건 ─────
  const blockCases = [
    ["[1] 겹침 조회 에러 -> 막힘(예전엔 data 만 보고 '겹침 없음'으로 잘못 통과)", { overlapError: { message: "network down" } }],
    ["[2] items=[] -> 막힘(빈 초안 승인 금지)", { items: [] }],
    ["[3] WING 원본 조회 실패 -> 막힘", { mirrorError: { message: "wing_direct_inbounds 조회 실패" } }],
    ["[4] WING 원본 행 없음(수집 전·삭제됨) -> 막힘", { mirrorRows: [] }],
    ["[5] WING 원본 CANCELLED(죽은 상태) -> 막힘", { mirrorRows: [{ wing_status: "CANCELLED", source_checked_at: FRESH_CHECKED_AT }] }],
    ["[6] WING 원본 36시간 초과(오래됨) -> 막힘", { mirrorRows: [{ vendor_item_id: "vid-a", requested_qty: 100, received_qty: 0, wing_status: "STOWING", source_checked_at: STALE_CHECKED_AT }] }],
    ["[6b] WING 수량이 초안 작성 뒤 바뀜(요청수량 100->80) -> 막힘(override 불가)",
      { mirrorRows: [{ vendor_item_id: "vid-a", requested_qty: 80, received_qty: 0, wing_status: "STOWING", source_checked_at: FRESH_CHECKED_AT }] }],
    ["[6c] WING 관측 입고량이 초안 작성 뒤 바뀜(0->30) -> 막힘",
      { mirrorRows: [{ vendor_item_id: "vid-a", requested_qty: 100, received_qty: 30, wing_status: "STOWING", source_checked_at: FRESH_CHECKED_AT }] }],
    ["[6d] 초안의 vendor_item_id 가 지금 원본에 아예 없음(빠짐/변경) -> 막힘",
      { mirrorRows: [{ vendor_item_id: "vid-different", requested_qty: 100, received_qty: 0, wing_status: "STOWING", source_checked_at: FRESH_CHECKED_AT }] }],
    // 2026-09-18 [Codex 재재검토 지적 - 배포 차단 허점 1: Math.max() 는 "가장 신선한 행 하나"만 보고
    // 전체를 판단했다 - 품목 2개짜리 shipment 에서 한 품목만 방금 수집되고 나머지는 36시간 넘게
    // 방치돼도 통과해버렸다. 이제 행 하나하나가 전부 36시간 이내여야 한다.
    ["[6e] 혼합 신선도 - 한 품목만 신선하고 나머지는 36시간 초과 -> 막힘(예전엔 Math.max 로 통과)",
      { items: [{ po_id: "po-1", product_id: "prod-a", vendor_item_id: "vid-a", qty: 100, received_qty: 0, wing_observed_received_qty: 0 },
               { po_id: "po-1", product_id: "prod-b", vendor_item_id: "vid-b", qty: 50, received_qty: 0, wing_observed_received_qty: 0 }],
       mirrorRows: [{ vendor_item_id: "vid-a", requested_qty: 100, received_qty: 0, wing_status: "STOWING", source_checked_at: FRESH_CHECKED_AT },
                   { vendor_item_id: "vid-b", requested_qty: 50, received_qty: 0, wing_status: "STOWING", source_checked_at: STALE_CHECKED_AT }] }],
    // 미래로 조작/오염된 시각(시계 오차 등)도 "신선함"으로 오판하면 안 됨 - 백엔드와 같은 5분 유예만 허용.
    ["[6f] source_checked_at 이 미래(비정상 시각) -> 막힘(신선함으로 오판 안 함)",
      { mirrorRows: [{ vendor_item_id: "vid-a", requested_qty: 100, received_qty: 0, wing_status: "STOWING",
                      source_checked_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }] }],
    // 2026-09-18 [Codex 재재검토 지적 - 배포 차단 허점 2] qtyChanged 는 초안 items 기준으로만 mirror 를
    // 찾아봐서, WING shipment 쪽에 초안엔 없던 새 vendor_item_id 행이 추가돼도 검사 대상이 안 돼 통과했다.
    ["[6g] WING 원본에 초안엔 없던 새 vendor_item_id 행이 추가됨 -> 막힘(부분집합 불일치)",
      { mirrorRows: [MATCHING_MIRROR_ROW, { vendor_item_id: "vid-new", requested_qty: 20, received_qty: 0, wing_status: "STOWING", source_checked_at: FRESH_CHECKED_AT }] }],
    // WING 원본 쪽에 같은 vendor_item_id 가 중복으로 들어오면(원본 데이터 자체를 못 믿음) 막는다.
    ["[6h] WING 원본에 같은 vendor_item_id 가 중복 -> 막힘(원본 신뢰 못 함)",
      { mirrorRows: [MATCHING_MIRROR_ROW, { ...MATCHING_MIRROR_ROW }] }],
    // 2026-09-18 [Codex 재재검토 지적] 주석은 "어느 쪽이든 중복이면 막는다"고 했지만 실제로는 mirror
    // 쪽만 검사했다 - 초안 자신의 items 에 중복 vendor_item_id 가 있어도(데이터 정합성 문제) 막혀야 함.
    ["[6j] 초안 품목(items) 자체에 같은 vendor_item_id 가 중복 -> 막힘",
      { items: [...BASE_ITEMS, { ...BASE_ITEMS[0] }],
       mirrorRows: [MATCHING_MIRROR_ROW] }],
  ];
  for (const [name, overrides] of blockCases) {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: true, rank: 5 });
    ctx.__test.setUsers([{ id: "me-1", rank: 5, name: "대표", role: "대표" }]);
    const updateCalls = [];
    ctx.__sbScript = scriptFor({ ...overrides, updateCalls });
    const res = await ctx.__test.getPromote()("po-1");   // confirm 이 안 뜨니 바로 await 가능(경쟁조건 없음)
    check(name, [res.status !== "DONE", updateCalls.length], [true, 0]);
    // infoModal() 이 막힌 이유를 보여주는 중인데 refresh() 가 바로 닫아버리면 안 됨(사람이 읽을 새도 없이 사라짐)
    check(`${name} - infoModal 을 refresh() 가 즉시 안 닫음`, ctx.__test.closeModalCalls || 0, 0);
  }

  // [6i] 양성 대조군 - 다품목(2개) 전부 신선·전부 수량 일치(집합도 정확히 같음) -> 안 막힘(새로 빡빡해진
  //      검사가 정상 케이스를 오탐하지 않는지 확인 - 6e~6h 가 전부 이 케이스의 한 조건씩만 깨뜨린 것임)
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "top-1", approver: true, rank: 99 });
    ctx.__test.setUsers([{ id: "top-1", rank: 99, name: "대표", role: "대표" }]);
    const updateCalls = [];
    const twoItems = [{ po_id: "po-1", product_id: "prod-a", vendor_item_id: "vid-a", qty: 100, received_qty: 0, wing_observed_received_qty: 0 },
                      { po_id: "po-1", product_id: "prod-b", vendor_item_id: "vid-b", qty: 50, received_qty: 0, wing_observed_received_qty: 0 }];
    const twoMirrorRows = [{ vendor_item_id: "vid-a", requested_qty: 100, received_qty: 0, wing_status: "STOWING", source_checked_at: FRESH_CHECKED_AT },
                          { vendor_item_id: "vid-b", requested_qty: 50, received_qty: 0, wing_status: "STOWING", source_checked_at: FRESH_CHECKED_AT }];
    ctx.__sbScript = scriptFor({ items: twoItems, mirrorRows: twoMirrorRows, updateCalls });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getPromote()("po-1");
    await ready;
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[6i] 다품목 전부 신선·전부 일치(집합도 같음) -> DONE(오탐 없음)", res.status, "DONE");
  }

  // [7] 승인 권한 없음(me.approver=false) -> allowed 가드에서 막힘(precheck 조차 안 감, 회귀 확인)
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: false, rank: 5 });
    ctx.__test.setUsers([{ id: "me-1", rank: 5, name: "직원", role: "직원" }]);
    const updateCalls = [];
    ctx.__sbScript = scriptFor({ updateCalls });
    const res = await ctx.__test.getPromote()("po-1");
    check("[7] 승인 권한 없음 -> DENIED, update 없음", [res.status, updateCalls.length], ["DENIED", 0]);
  }

  // [8] 정상 + 전결(approvers 없음) -> exec 까지 가서 status='approved'(주의: 'ordered' 아님)
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "top-1", approver: true, rank: 99 });
    ctx.__test.setUsers([{ id: "top-1", rank: 99, name: "대표", role: "대표" }]);   // 본인보다 랭크 높은 사람 없음 -> 전결
    const updateCalls = [];
    ctx.__sbScript = scriptFor({ updateCalls });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getPromote()("po-1");
    await ready;
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[8] 전결 - DONE", res.status, "DONE");
    check("[8] 전결 - status='approved'(주의: ordered 아님 - markOrdered() 만의 몫)", updateCalls[0]?.status, "approved");
    check("[8] 전결 - ordered_at=null", updateCalls[0]?.ordered_at, null);
    check("[8] 전결 - approval_line=[]", updateCalls[0]?.approval_line, []);
    check("[8] 전결 - loadPOs/route 로 새로고침, closeModal 은 run() 성공 경로가 1번만(중복 안 함)",
      [ctx.__test.loadPOsCalls, ctx.__test.closeModalCalls, ctx.__test.routeCalls], [1, 1, 1]);
  }

  // [9] 정상 + 결재자 지정(전결 아님) -> status='progress', approval_line 에 선택한 결재자
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: true, rank: 5 });
    ctx.__test.setUsers([{ id: "me-1", rank: 5, name: "장팀장", role: "팀장" }, { id: "boss-1", rank: 10, name: "대표", role: "대표이사" }]);
    const updateCalls = [];
    ctx.__sbScript = scriptFor({ updateCalls });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getPromote()("po-1");
    await ready;
    ctx.document.getElementById("wing-promote-appr").value = "boss-1";
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[9] 결재자 지정 - DONE", res.status, "DONE");
    check("[9] 결재자 지정 - status='progress'", updateCalls[0]?.status, "progress");
    check("[9] 결재자 지정 - approval_line[0].userId=boss-1", updateCalls[0]?.approval_line?.[0]?.userId, "boss-1");
  }

  // [10] 겹침 있음 -> 사유 없이 확인하면 막히고(필수 검증, run() 이 아직 안 끝남), 사유를 적으면
  //      통과 + 메모에 감사기록이 남는다
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "top-1", approver: true, rank: 99 });
    ctx.__test.setUsers([{ id: "top-1", rank: 99, name: "대표", role: "대표" }]);
    const updateCalls = [];
    ctx.__sbScript = scriptFor({
      updateCalls,
      overlapRows: [{ po_id: "po-other", product_id: "prod-a", purchase_orders: { po_no: "리버스-발주-2026-050", status: "progress" } }],
    });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getPromote()("po-1");
    await ready;
    ctx.document.getElementById("erp-confirm-reason").value = "";
    ctx.ErpUi._answer(true);   // 사유 필수인데 비어 있음 -> _answer() 안에서 막히고 pending 유지(run() 안 끝남)
    await Promise.resolve(); await Promise.resolve();
    check("[10a] 겹침+사유 없음 -> 아직 처리 안 됨(update 없음)", updateCalls.length, 0);
    ctx.document.getElementById("erp-confirm-reason").value = "확인 결과 수량이 달라 별개 매입임";
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[10b] 겹침+사유 적음 -> DONE", res.status, "DONE");
    check("[10b] 메모에 겹침 확인 사유가 남음", (updateCalls[0]?.memo || "").includes("확인 결과 수량이 달라 별개 매입임"), true);
  }

  // ── rejectWingDirectDraft() 도 같은 wing_direct_review 가드를 타는지 확인 ─────────────────────
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "top-1", approver: true, rank: 99 });
    ctx.__test.setUsers([{ id: "top-1", rank: 99, name: "대표", role: "대표" }]);
    const updateCalls = [];
    ctx.__sbScript = (table, calls) => {
      if (table === "purchase_orders" && calls.some(c => c[0] === "update")) {
        updateCalls.push(calls.find(c => c[0] === "update")[1]);
        return { data: [{ id: BASE_PO.id }], error: null };
      }
      if (table === "purchase_orders") return { data: { po_no: BASE_PO.po_no, status: "wing_direct_review" }, error: null };
      throw new Error("reject 시나리오에 없는 테이블: " + table);
    };
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getReject()("po-1");
    await ready;
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[11] rejectWingDirectDraft - DONE", res.status, "DONE");
    check("[11] rejectWingDirectDraft - status='canceled'", updateCalls[0]?.status, "canceled");
  }

  // ── PO_STATUS 에 wing_direct_review 항목이 실제로 존재하는지(라벨 오표시 회귀) ──────────────
  {
    const ctx = buildContext();
    const st = ctx.__test.getPOStatus();
    check("[12] PO_STATUS.wing_direct_review 존재", !!st.wing_direct_review, true);
    check("[12] 라벨이 '결재 대기' 로 안 빠짐(기본값 폴백 회귀)", st.wing_direct_review.label !== st.progress.label, true);
  }

  console.log("\n" + "=".repeat(70));
  if (FAILS.length) { console.log(`FAIL ${FAILS.length}건: ${FAILS.join(", ")}`); process.exit(1); }
  console.log("모두 통과");
}

main().catch(e => { console.error("테스트 실행 중 예외:", e); process.exit(1); });
