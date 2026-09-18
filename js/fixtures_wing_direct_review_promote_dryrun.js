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
    // 2026-09-18 [PM 지적 - 테스트 중단 원인] 새 manifest 조회가 .order(...).limit(1) 을 부르는데
    // 이 가짜 builder 에 limit() 이 없어서 precheck() 안에서 TypeError 로 조용히 실패했다 - 양성
    // 케이스([6i]/[8]/[9]/[10])가 confirm() 까지 못 가고 armConfirmSignal 의 await 만 영원히 남아
    // (마이크로태스크만 대기 중이라 Node 가 그냥 조용히 종료해버림 - 테스트가 "중단"된 게 아니라
    // "그 뒤로 아무것도 안 됨"으로 보인 이유) 전체 실행 결과가 [6j] 뒤로 통째로 안 보였다.
    limit(...a) { calls.push(["limit", ...a]); return builder; },
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
// 2026-09-18 [PM 지적 - manifest 기반 원본 완전성 재확인] "다음 수집에서 SKU 가 원본에서 사라짐"을
// 정확히 겨냥한 24시간 값 - STALE_CHECKED_AT(40h, 이미 기존 36h 검사에 걸림)과 겹치지 않게 분리.
const YESTERDAY_CHECKED_AT = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

const BASE_PO = { id: "po-1", po_no: "리버스-발주-WING검토-ship-1", status: "wing_direct_review",
  supplier: "리파코", total: 1000000, memo: "", wing_direct_shipment_id: "ship-1" };
const BASE_ITEMS = [{ po_id: "po-1", product_id: "prod-a", vendor_item_id: "vid-a", qty: 100, received_qty: 0, wing_observed_received_qty: 0 }];
// 기본 미러 - BASE_ITEMS 와 수량이 정확히 같아야(품목쪽 qty=requested_qty, wing_observed_received_qty=received_qty)
// 그 자체로는 안 막힘(수량 비교 통과) - 수량이 다른 테스트만 따로 override.
const MATCHING_MIRROR_ROW = { vendor_item_id: "vid-a", requested_qty: 100, received_qty: 0, wing_status: "STOWING", source_checked_at: FRESH_CHECKED_AT };
// 2026-09-18 [PM 핵심 요청] promoteWingDirectDraft() 가 이제 승인 직전 최신 수집 manifest 도 다시
// 읽는다 - 이 검사 자체를 안 겨냥하는(다른 사유를 테스트하는) 기존 케이스가 전부 막히지 않으려면,
// "지금 mirror 행 그대로가 최신 회차 전부"라고 말하는 완벽히 일치하는 기본 manifest 를 깔아준다
// (백엔드 fixtures 의 _default_manifest()/ev_call() 과 같은 원칙) - manifest 검사 자체를 겨냥하는
// 케이스만(아래 [13]) 명시적으로 다른 값을 준다.
const DEFAULT_MANIFEST_ROW = { collected_at: FRESH_CHECKED_AT, shipment_sku_map: { "ship-1": ["vid-a"] }, qty_review_keys: [] };

function scriptFor({ poRow = BASE_PO, items = BASE_ITEMS, itemsError = null,
  mirrorRows = [MATCHING_MIRROR_ROW], mirrorError = null,
  manifestRows = [DEFAULT_MANIFEST_ROW], manifestError = null,
  overlapRows = [], overlapError = null,
  // 2026-09-18 [PM 요청 - 완료매입 이력 표시] promoteWingDirectDraft() 가 이제 purchase_order_items
  // 를 "in" 필터로 *두 번* 다른 목적으로 조회한다(기존: 활성 발주서 겹침 / 신규: 완료 PO 이력) -
  // 둘 다 같은 테이블·같은 in() 호출이라 select 문자열(due_date 포함 여부)로 구분해야 한다.
  doneItems = [], doneItemsError = null, purchaseRows = [], purchasesError = null,
  updateOk = true, updateCalls = [] } = {}) {
  return (table, calls) => {
    if (table === "purchase_orders" && calls.some(c => c[0] === "update")) {
      updateCalls.push(calls.find(c => c[0] === "update")[1]);
      if (!updateOk) return { data: null, error: { message: "update 실패(시뮬레이션)" } };
      return { data: [{ id: poRow.id }], error: null };
    }
    if (table === "purchase_orders") return { data: poRow, error: null };
    if (table === "purchase_order_items") {
      const selectCall = calls.find(c => c[0] === "select");
      const selectStr = selectCall ? String(selectCall[1] || "") : "";
      const isInQuery = calls.some(c => c[0] === "in");
      if (isInQuery && selectStr.includes("due_date")) return { data: doneItems, error: doneItemsError };
      if (isInQuery) return { data: overlapRows, error: overlapError };
      return { data: items, error: itemsError };
    }
    if (table === "purchases") return { data: purchaseRows, error: purchasesError };
    if (table === "wing_direct_inbounds") return { data: mirrorRows, error: mirrorError };
    if (table === "wing_direct_inbound_collection_manifest") return { data: manifestRows, error: manifestError };
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

    // ── [13] [PM 핵심 요청] manifest 기반 원본 완전성 재확인(TOCTOU 방어) ─────────────────────────
    ["[13a] 최신 수집 manifest 조회 자체가 실패 -> 막힘(조용히 통과 안 함)",
      { manifestError: { message: "network down" } }],
    ["[13b] 최신 수집 manifest 가 아예 없음(빈 배열, 수집기가 manifest 를 남기기 전 버전) -> 막힘",
      { manifestRows: [] }],
    ["[13c] manifest 에 이 shipment 자체가 없음(다른 shipment 것만 있음) -> 막힘",
      { manifestRows: [{ collected_at: FRESH_CHECKED_AT, shipment_sku_map: { "completely-different-ship": ["v1"] }, qty_review_keys: [] }] }],
    ["[13d] manifest.collected_at 형식 이상 -> 막힘(fail-closed, 추정 안 함)",
      { manifestRows: [{ collected_at: "이상한값", shipment_sku_map: { "ship-1": ["vid-a"] }, qty_review_keys: [] }] }],
    ["[13d2] manifest.collected_at 에 타임존 없음(naive, JS Date 는 로컬로 해석함) -> 막힘",
      { manifestRows: [{ collected_at: "2026-09-18T03:00:00", shipment_sku_map: { "ship-1": ["vid-a"] }, qty_review_keys: [] }] }],
    ["[13e] manifest.shipment_sku_map[shipmentId] 가 배열이 아님(오염된 데이터) -> 막힘(throw 아니라 명시적 안내)",
      { manifestRows: [{ collected_at: FRESH_CHECKED_AT, shipment_sku_map: { "ship-1": "vid-a" }, qty_review_keys: [] }] }],
    ["[13f] manifest.qty_review_keys 가 배열이 아님(오염된 데이터) -> 막힘(throw 아니라 명시적 안내)",
      { manifestRows: [{ collected_at: FRESH_CHECKED_AT, shipment_sku_map: { "ship-1": ["vid-a"] }, qty_review_keys: "oops" }] }],
    ["[13g] mirror 행의 source_checked_at 에 타임존 없음(naive) -> 막힘",
      { mirrorRows: [{ vendor_item_id: "vid-a", requested_qty: 100, received_qty: 0, wing_status: "STOWING", source_checked_at: "2026-09-18T01:00:00" }] }],
    // 2026-09-18 [PM 독립 리뷰 - TOCTOU 핵심 재현] A+B 초안을 승인하려는 순간, 그 사이(평가~승인)에
    // 수집기가 한 번 더 돌아서 다음 WING GET 에서 B 가 원본에서 사라진 24시간 시나리오. B 의 mirror
    // 행은 수집기가 안 지워서 어제 값(24시간 전) 그대로 남아 있고, 이건 기존 36시간 신선도 검사
    // (badChecked)는 그냥 통과한다(24h < 36h) - 최신 manifest 는 이번 회차에 A 만 실제로 봤다고
    // 말하므로, manifest 의 SKU 집합과 mirror 의 SKU 집합이 안 맞아서 여기서 막혀야 한다.
    ["[13h] [핵심 재현] A+B 초안 - 다음 WING GET 에서 B 가 원본에서 사라진 24시간 시나리오 -> 막힘"
     + "(기존 36h 신선도 검사만으론 못 잡음 - B 의 옛 행이 24h<36h 라 그냥 통과했을 것)",
      { items: [{ po_id: "po-1", product_id: "prod-a", vendor_item_id: "vid-a", qty: 100, received_qty: 0, wing_observed_received_qty: 0 },
               { po_id: "po-1", product_id: "prod-b", vendor_item_id: "vid-b", qty: 50, received_qty: 0, wing_observed_received_qty: 0 }],
       mirrorRows: [{ vendor_item_id: "vid-a", requested_qty: 100, received_qty: 0, wing_status: "STOWING", source_checked_at: FRESH_CHECKED_AT },
                   { vendor_item_id: "vid-b", requested_qty: 50, received_qty: 0, wing_status: "STOWING", source_checked_at: YESTERDAY_CHECKED_AT }],
       // 오늘(FRESH_CHECKED_AT) 회차의 WING 원본엔 vid-a 만 실제로 있었음(vid-b 는 사라짐).
       manifestRows: [{ collected_at: FRESH_CHECKED_AT, shipment_sku_map: { "ship-1": ["vid-a"] }, qty_review_keys: [] }] }],
    // 방어적 이중 확인 - SKU 집합 비교는 우연히 통과했다고 가정해도(가상 시나리오) qty_review_keys 가 별도로 막음.
    ["[13i] [방어적 이중 확인] SKU 집합이 manifest 와 일치해도 qty_review_keys 에 이 shipment 가 있으면 막힘",
      { manifestRows: [{ collected_at: FRESH_CHECKED_AT, shipment_sku_map: { "ship-1": ["vid-a"] }, qty_review_keys: [["ship-1", "vid-a"]] }] }],

    // ── [14] [PM 요청] 완료매입 이력 표시(14일 창 밖 놓침 방지) - 조회 실패는 fail-closed ─────────
    ["[14a] 과거 완료 발주 이력 조회 자체가 실패 -> 막힘(조용히 통과 안 함)",
      { doneItemsError: { message: "network down" } }],
    ["[14b] 매입 원장 조회 자체가 실패 -> 막힘(조용히 통과 안 함)",
      { purchasesError: { message: "network down" } }],
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
    const twoSkuManifest = [{ collected_at: FRESH_CHECKED_AT, shipment_sku_map: { "ship-1": ["vid-a", "vid-b"] }, qty_review_keys: [] }];
    ctx.__sbScript = scriptFor({ items: twoItems, mirrorRows: twoMirrorRows, manifestRows: twoSkuManifest, updateCalls });
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

  // [13j] [PM 코드 리뷰 핵심 지적] source_checked_at/manifest.collected_at 이 같은 순간의 '다른'
  // ISO 표기(Z 대 +00:00, 소수초 유무)여도 - 문자열이 달라도 실제 순간이 같으면 오탐 없이 통과해야
  // 한다(parseTzAwareMs 가 new Date().getTime() 로 실제 순간을 비교하기 때문 - 문자열 비교였다면
  // 이 테스트가 깨졌을 것).
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "top-1", approver: true, rank: 99 });
    ctx.__test.setUsers([{ id: "top-1", rank: 99, name: "대표", role: "대표" }]);
    const updateCalls = [];
    // 2026-09-18 [PM 지적 - 테스트 자체 버그] Date.now() 는 밀리초를 포함하는데, 아래 zRepr 는 그
    // 소수초를 지우고 offsetRepr 는 남겨서(toISOString() 기본 출력) 두 표기가 "같은 순간의 다른
    // 문자열"이 아니라 실제로 다른 순간이 돼버렸다 - precheck() 가 (정확한 로직대로) 진짜 불일치로
    // 판단해 막았고, 그 뒤 confirm() 모달이 절대 안 떠서 armConfirmSignal 의 await 가 영원히 남았다
    // (테스트가 "중단"된 게 아니라 원인이 이 테스트 자신의 시각 계산 버그였음). 초 단위로 미리
    // 내림해서(밀리초를 0으로 고정) 두 표기가 문자열만 다르고 실제 순간은 정확히 같게 만든다.
    const sameInstantMs = Math.floor((Date.now() - 2 * 60 * 60 * 1000) / 1000) * 1000;
    const zRepr = new Date(sameInstantMs).toISOString().replace(/\.\d{3}Z$/, "Z");   // "...Z", 소수초 없음
    const offsetRepr = new Date(sameInstantMs).toISOString().replace("Z", "+00:00");   // "...000+00:00", 소수초 있음(기본 toISOString)
    if (zRepr === offsetRepr) throw new Error("[13j] 테스트 전제 깨짐 - 두 표기가 실제로 달라야 의미가 있음");
    if (new Date(zRepr).getTime() !== new Date(offsetRepr).getTime())
      throw new Error("[13j] 테스트 전제 깨짐 - 두 표기가 실제로는 같은 순간이어야 의미가 있음");
    ctx.__sbScript = scriptFor({
      mirrorRows: [{ vendor_item_id: "vid-a", requested_qty: 100, received_qty: 0, wing_status: "STOWING", source_checked_at: zRepr }],
      manifestRows: [{ collected_at: offsetRepr, shipment_sku_map: { "ship-1": ["vid-a"] }, qty_review_keys: [] }],
      updateCalls,
    });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getPromote()("po-1");
    await ready;
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[13j] [핵심] 문자열 표기만 다르고 실제로는 같은 순간 -> 오탐 없이 DONE 까지 도달", res.status, "DONE");
  }

  // [14c] 완료 발주·매입 이력이 둘 다 없음(정상적인 신규 상품) -> 불필요하게 안 막힘, 사유 없이도 DONE
  // (PM 지시: "정상적인 다른 주문은 불필요하게 막지 않으며" - 이 케이스가 그 요구를 직접 검증)
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "top-1", approver: true, rank: 99 });
    ctx.__test.setUsers([{ id: "top-1", rank: 99, name: "대표", role: "대표" }]);
    const updateCalls = [];
    ctx.__sbScript = scriptFor({ doneItems: [], purchaseRows: [], updateCalls });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getPromote()("po-1");
    await ready;
    ctx.ErpUi._answer(true);   // 사유란이 필수가 아니므로 빈 채로 확인해도 통과해야 함
    const res = await p;
    check("[14c] [핵심] 완료 이력 없음 -> 불필요하게 안 막힘, 사유 없이도 DONE", res.status, "DONE");
    check("[14c] 메모에 '확인 사유' 텍스트가 안 남음(강제된 적 없으므로)",
         (updateCalls[0]?.memo || "").includes("확인 사유"), false);
  }

  // [14d] [PM 요청 - 핵심 재현] 휴지통 shipment 1103886464850071552 실례 그대로: 신규 검토 초안
  // 720EA·₩3,960,000 대 과거 완료 PO 리버스-발주-2026-001(720EA, 2026-08-26 완료) + 매입원장
  // (2026-08-27, 720EA) - 기대일과 28일 차이라 백엔드 COMPLETED_PURCHASE_OVERLAP 의 14일 창 밖
  // (evaluate_shipment 단계에서 이미 못 잡음) - 이 승인 화면이 날짜 창과 무관하게 표시하고 사유를
  // 강제하는지 확인한다.
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "top-1", approver: true, rank: 99 });
    ctx.__test.setUsers([{ id: "top-1", rank: 99, name: "대표", role: "대표" }]);
    const updateCalls = [];
    const realDoneItems = [{
      qty: 720, received_qty: 720, product_id: "prod-a",
      purchase_orders: { po_no: "리버스-발주-2026-001", status: "done", due_date: "2026-08-26" },
    }];
    const realPurchaseRows = [{ date: "2026-08-27", qty: 720, product_id: "prod-a" }];
    ctx.__sbScript = scriptFor({ doneItems: realDoneItems, purchaseRows: realPurchaseRows, updateCalls });

    // 사유 없이 확인 -> 아직 처리 안 됨(필수 검증에 막힘, run() 안 끝남)
    let ready = armConfirmSignal(ctx);
    let p = ctx.__test.getPromote()("po-1");
    await ready;
    ctx.document.getElementById("erp-confirm-reason").value = "";
    ctx.ErpUi._answer(true);
    await Promise.resolve(); await Promise.resolve();
    check("[14d-a] [핵심] 완료 PO·매입 이력 있음(28일 차이, 14일 창 밖) + 사유 없음 -> 아직 처리 안 됨(update 없음)",
         updateCalls.length, 0);

    // 사유를 적으면 통과 + 메모에 남음
    ctx.document.getElementById("erp-confirm-reason").value = "완료 매입과 상품은 같지만 8월분 재고 소진 확인 후 재입고로 승인함";
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[14d-b] [핵심] 사유를 적으면 통과(자동 차단 아님 - 사람 판단으로 진행 가능)", res.status, "DONE");
    check("[14d-b] 메모에 완료 매입 확인 사유가 남음",
         (updateCalls[0]?.memo || "").includes("8월분 재고 소진 확인 후 재입고로 승인함"), true);
    check("[14d-b] 메모 라벨이 '겹침/이력 확인 사유'로 남음(어떤 검사가 걸렸는지 감사기록에 구분됨)",
         (updateCalls[0]?.memo || "").includes("[전환 시 겹침/이력 확인 사유]"), true);
  }

  // [14e] 완료 PO 는 없고 매입 원장에만 이력이 있는 경우도 똑같이 표시·사유 강제(두 소스 중 하나만
  // 있어도 놓치지 않아야 함 - 백엔드 _check_completed_purchase_overlap 이 두 소스를 독립적으로 보는
  // 것과 같은 원칙, 프론트는 자동 판단 없이 둘 다 그대로 보여줌).
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "top-1", approver: true, rank: 99 });
    ctx.__test.setUsers([{ id: "top-1", rank: 99, name: "대표", role: "대표" }]);
    const updateCalls = [];
    ctx.__sbScript = scriptFor({
      doneItems: [], purchaseRows: [{ date: "2026-07-01", qty: 200, product_id: "prod-a" }], updateCalls,
    });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getPromote()("po-1");
    await ready;
    ctx.document.getElementById("erp-confirm-reason").value = "";
    ctx.ErpUi._answer(true);
    await Promise.resolve(); await Promise.resolve();
    check("[14e] 매입 원장에만 이력 있어도 사유 없이는 아직 처리 안 됨", updateCalls.length, 0);
    ctx.document.getElementById("erp-confirm-reason").value = "7월 매입과 무관한 별개 재입고로 확인함";
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[14e] 사유 적으면 통과", res.status, "DONE");
  }

  console.log("\n" + "=".repeat(70));
  if (FAILS.length) { console.log(`FAIL ${FAILS.length}건: ${FAILS.join(", ")}`); process.exit(1); }
  console.log("모두 통과");
}

main().catch(e => { console.error("테스트 실행 중 예외:", e); process.exit(1); });
