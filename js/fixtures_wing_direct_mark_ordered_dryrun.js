/**
 * fixtures_wing_direct_mark_ordered_dryrun.js
 * ------------------------------------------------
 * markOrderedFromWingDirect() 의 *** 실제 함수 경로 *** 회귀테스트(네트워크/브라우저 없음).
 *
 * 2026-09-18 [Codex 추가 안전 검토] WING 직접입고 검토 초안을 승인해 만든 발주서에 일반
 * markOrdered() 를 그대로 쓰면: (1) "거래처에 발주 완료" 문구가 실제로 안 한 재주문을 한 것처럼
 * 보이고, (2) 지급예정일을 항상 today()+30 로 추정해서 공급처 실제 결제조건(예: 리파코 익월 20일)
 * 과 다르고, 이미 사후에 등록된 지급예정과 중복될 위험이 있다. markOrderedFromWingDirect() 는
 * (a) 날짜를 절대 추정하지 않고(사람이 직접 입력해야만 등록), (b) 같은 po_no 로 이미 등록된
 * 지급예정이 있으면 새로 만들지 않는지, (c) status 전이는 markOrdered() 와 같은 값을 쓰는지를
 * 검증한다.
 *
 * node js/fixtures_wing_direct_mark_ordered_dryrun.js
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

const APP_JS_PATH = path.join(__dirname, "app.js");
const ERP_UI_JS_PATH = path.join(__dirname, "erp_ui.js");
const appSrcFull = fs.readFileSync(APP_JS_PATH, "utf8");
const CUT_MARKER = "/* ---------- 모바일 사이드바 ---------- */";
const cutIdx = appSrcFull.indexOf(CUT_MARKER);
if (cutIdx < 0) throw new Error(`app.js 에서 절단 지점을 못 찾음("${CUT_MARKER}")`);
const appSrc = appSrcFull.slice(0, cutIdx);
const erpUiSrc = fs.readFileSync(ERP_UI_JS_PATH, "utf8");

function makeFakeElement(id) {
  const el = { id, value: "", textContent: "", disabled: false, hidden: false, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    appendChild() {}, remove() {}, closest: () => null, querySelector: () => null, querySelectorAll: () => [] };
  let _innerHTML = "";
  Object.defineProperty(el, "innerHTML", { get() { return _innerHTML; }, set(v) { _innerHTML = v; if (el._onInnerHTML) el._onInnerHTML(v); } });
  return el;
}
function makeFakeDocument() {
  const elements = new Map();
  return {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeFakeElement(id)); return elements.get(id); },
    querySelector: () => null, querySelectorAll: () => [],
    createElement: tag => makeFakeElement("el-" + tag), body: makeFakeElement("body"), addEventListener() {},
  };
}
function makeQueryBuilder(sandbox, table) {
  const calls = [];
  let isSingle = false;
  const resolveNow = () => Promise.resolve(sandbox.__sbScript(table, calls, isSingle));
  const builder = {
    select(...a) { calls.push(["select", ...a]); return builder; },
    eq(...a) { calls.push(["eq", ...a]); return builder; },
    in(...a) { calls.push(["in", ...a]); return builder; },
    ilike(...a) { calls.push(["ilike", ...a]); return builder; },
    insert(...a) { calls.push(["insert", ...a]); return builder; },
    update(...a) { calls.push(["update", ...a]); return builder; },
    maybeSingle() { isSingle = true; return resolveNow(); },
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
    var __test = {
      setMe: function (v) { me = v; },
      getMarkOrdered: function () { return markOrderedFromWingDirect; },
    };
    route = async function () { __test.routeCalls = (__test.routeCalls || 0) + 1; };
    loadPOs = async function () { __test.loadPOsCalls = (__test.loadPOsCalls || 0) + 1; };
    closeModal = function () { __test.closeModalCalls = (__test.closeModalCalls || 0) + 1; };
    toast = function (msg) { __test.toasts = __test.toasts || []; __test.toasts.push(msg); };
  `;
  new vm.Script(erpUiSrc + "\n" + appSrc + "\n" + trailer, { filename: "app-bundle.js" }).runInContext(context);
  return context;
}

function armConfirmSignal(ctx) {
  let resolveReady;
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("확인창이 열리지 않아 테스트 중단")), 2000);
    resolveReady = () => { clearTimeout(timeout); resolve(); };
  });
  const modalRoot = ctx.document.getElementById("modal-root");
  modalRoot._onInnerHTML = html => { if (html.includes("erp-confirm-title")) resolveReady(); };
  return ready;
}

const BASE_PO = { id: "po-1", po_no: "리버스-발주-WING검토-ship-1", status: "approved",
  supplier: "리파코", total: 500000, memo: "", freight_est: 0, wing_direct_shipment_id: "ship-1" };

function scriptFor({ poRow = BASE_PO, existingPlans = [], updateCalls = [], insertCalls = [],
  items = [{ product_id: "prod-1", qty: 100, unit_cost: 5000, amount: 500000 }],
  taxType = "과세", vatSetting = { enabled: true, purchaseCostIncludesVat: false } } = {}) {
  return (table, calls) => {
    if (table === "settings") return { data: { value: vatSetting }, error: null };
    if (table === "purchase_order_items") return { data: items, error: null };
    if (table === "products") return { data: [{ id: "prod-1", tax_type: taxType }], error: null };
    if (table === "purchase_orders" && calls.some(c => c[0] === "update")) {
      updateCalls.push(calls.find(c => c[0] === "update")[1]);
      return { data: [{ id: poRow.id }], error: null };
    }
    if (table === "purchase_orders") return { data: poRow, error: null };
    if (table === "cash_plans" && calls.some(c => c[0] === "insert")) {
      insertCalls.push(calls.find(c => c[0] === "insert")[1]);
      return { data: [{ id: "plan-new" }], error: null };
    }
    if (table === "cash_plans") return { data: existingPlans, error: null };
    throw new Error(`시나리오에 없는 테이블: ${table}`);
  };
}

async function main() {
  console.log("=".repeat(70));
  console.log("markOrderedFromWingDirect() - 실제 함수 경로 (vm, 네트워크 없음)");
  console.log("=".repeat(70));

  // [1] 승인 권한 없음 -> DENIED, 아무 것도 안 씀
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: false });
    const updateCalls = [], insertCalls = [];
    ctx.__sbScript = scriptFor({ updateCalls, insertCalls });
    const res = await ctx.__test.getMarkOrdered()("po-1");
    check("[1] 승인 권한 없음 -> DENIED", res.status, "DENIED");
    check("[1] update/insert 둘 다 없음", [updateCalls.length, insertCalls.length], [0, 0]);
  }

  // [2] 이미 같은 po_no 로 등록된 지급예정 있음 -> status 는 바뀌지만 cash_plans 는 새로 안 만듦(중복 방지)
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: true });
    const updateCalls = [], insertCalls = [];
    ctx.__sbScript = scriptFor({
      updateCalls, insertCalls,
      existingPlans: [{ id: "plan-existing", date: "2026-10-20", amount: 500000, title: "리파코 매입대금(WING 사후기록, 리버스-발주-WING검토-ship-1)" }],
    });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getMarkOrdered()("po-1");
    await ready;
    ctx.document.getElementById("wing-order-due-date").value = "2026-11-01";   // 있어도 무시돼야 함(중복 방지 우선)
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[2] DONE", res.status, "DONE");
    check("[2] status='ordered' 로는 바뀜", updateCalls[0]?.status, "ordered");
    check("[2] 중복이라 cash_plans insert 는 0번", insertCalls.length, 0);
  }

  // [3] 중복 없음 + 지급예정일 직접 입력 -> 그 날짜 그대로 등록(today()+30 추정 안 함), 제목에 'WING 사후기록' 표시
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: true });
    const updateCalls = [], insertCalls = [];
    ctx.__sbScript = scriptFor({ updateCalls, insertCalls, existingPlans: [] });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getMarkOrdered()("po-1");
    await ready;
    ctx.document.getElementById("wing-order-due-date").value = "2026-10-20";   // 리파코 실제 결제조건(익월 20일) - 사람이 직접 입력
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[3] DONE", res.status, "DONE");
    check("[3] cash_plans 에 사람이 입력한 날짜 그대로(추정 아님)", insertCalls[0]?.date, "2026-10-20");
    check("[3] 제목에 'WING 사후기록' 표시(일반 발주와 구분)", (insertCalls[0]?.title || "").includes("WING 사후기록"), true);
    check("[3] 금액은 과세 상품 VAT 포함(운반비 별도)", insertCalls[0]?.amount, 550000);
  }

  // [4] 중복 없음 + 지급예정일 비워둠 -> status 만 바뀌고 cash_plans 는 안 만듦(추정 등록 금지)
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: true });
    const updateCalls = [], insertCalls = [];
    ctx.__sbScript = scriptFor({ updateCalls, insertCalls, existingPlans: [] });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getMarkOrdered()("po-1");
    await ready;
    // wing-order-due-date 를 비워둔 채 확인(기본값 "")
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[4] DONE", res.status, "DONE");
    check("[4] status='ordered'", updateCalls[0]?.status, "ordered");
    check("[4] 날짜 안 넣으면 cash_plans insert 0번(추정 등록 안 함)", insertCalls.length, 0);
  }

  // [5] status 가 'approved' 아니거나 wing_direct_shipment_id 없음 -> 대상 아님으로 막힘
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: true });
    const updateCalls = [], insertCalls = [];
    ctx.__sbScript = scriptFor({ poRow: { ...BASE_PO, wing_direct_shipment_id: null }, updateCalls, insertCalls });
    const res = await ctx.__test.getMarkOrdered()("po-1");
    check("[5] wing_direct_shipment_id 없음 -> 막힘(update 없음)", updateCalls.length, 0);
    check("[5] status !== DONE", res.status !== "DONE", true);
  }

  // [6] 확인창 대기 중 품목 변경 -> 오래된 지급예정액으로 확정하지 않음
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: true });
    const updateCalls = [], insertCalls = [];
    const items = [{ product_id: "prod-1", qty: 100, unit_cost: 5000, amount: 500000 }];
    ctx.__sbScript = scriptFor({ updateCalls, insertCalls, items });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getMarkOrdered()("po-1");
    await ready;
    items[0] = { product_id: "prod-1", qty: 50, unit_cost: 10000, amount: 500000 };
    ctx.document.getElementById("wing-order-due-date").value = "2026-10-20";
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[6] 품목 변경 차단", res.status !== "DONE", true);
    check("[6] update/insert 없음", [updateCalls.length, insertCalls.length], [0, 0]);
  }

  // [7] VAT 설정 행 없음 -> 기본값으로 계산하지 않고 결재/지급예정 모두 유지
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: true });
    const updateCalls = [], insertCalls = [];
    ctx.__sbScript = scriptFor({ updateCalls, insertCalls, vatSetting: null });
    const res = await ctx.__test.getMarkOrdered()("po-1");
    check("[7] VAT 설정 없음 차단", res.status !== "DONE", true);
    check("[7] update/insert 없음", [updateCalls.length, insertCalls.length], [0, 0]);
  }

  // [8] 확인창 대기 중 VAT 기준 변경 -> 오래된 금액으로 등록하지 않음
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: true });
    const updateCalls = [], insertCalls = [];
    const vatSetting = { enabled: true, purchaseCostIncludesVat: false };
    ctx.__sbScript = scriptFor({ updateCalls, insertCalls, vatSetting });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getMarkOrdered()("po-1");
    await ready;
    vatSetting.purchaseCostIncludesVat = true;
    ctx.document.getElementById("wing-order-due-date").value = "2026-10-20";
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[8] VAT 기준 변경 차단", res.status !== "DONE", true);
    check("[8] update/insert 없음", [updateCalls.length, insertCalls.length], [0, 0]);
  }

  // [9] 확인창 대기 중 공급처 변경 -> 과거 공급처명으로 지급예정 등록 차단
  {
    const ctx = buildContext();
    ctx.__test.setMe({ id: "me-1", approver: true });
    const updateCalls = [], insertCalls = [];
    const poRow = { ...BASE_PO };
    ctx.__sbScript = scriptFor({ updateCalls, insertCalls, poRow });
    const ready = armConfirmSignal(ctx);
    const p = ctx.__test.getMarkOrdered()("po-1");
    await ready;
    poRow.supplier = "다른 공급처";
    ctx.document.getElementById("wing-order-due-date").value = "2026-10-20";
    ctx.ErpUi._answer(true);
    const res = await p;
    check("[9] 공급처 변경 차단", res.status !== "DONE", true);
    check("[9] update/insert 없음", [updateCalls.length, insertCalls.length], [0, 0]);
  }

  console.log("\n" + "=".repeat(70));
  if (FAILS.length) { console.log(`FAIL ${FAILS.length}건: ${FAILS.join(", ")}`); process.exit(1); }
  console.log("모두 통과");
}

main().catch(e => { console.error("테스트 실행 중 예외:", e); process.exitCode = 1; });
