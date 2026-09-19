/**
 * fixtures_po_due_date_display_dryrun.js
 * ------------------------------------------------
 * 2026-09-19 [대표 지시 - "발주서 목록/상세 모달에 기한이 ? 로 보인다"는 보고를 읽기 전용으로 끝까지
 * 추적] 실제로는 due_date 가 아니라 *** 기안자(drafter) 표시 *** 문제였다:
 *
 *   - 목록: <small class="erp-sub">${esc(p.date)} · ${esc(userName(p.drafter_id))}</small>
 *   - 상세 모달: <td>기안</td><td>${esc(userName(p.drafter_id))}</td>
 *   - userName = id => (USERS.find(u => u.id === id) || {}).name || "?"
 *
 * WING 직접입고 자동 생성 검토 초안은 drafter_id=null(사람이 안 만듦) 이라 userName(null) 이 항상
 * "?" 를 돌려준다 - 대표가 본 "2026-09-19 · ?"는 "발주일 · 기안자"였지, "발주일 · 기한"이 아니었다.
 * 그리고 상세 모달 헤더 표에는애초에 due_date/기한 을 보여주는 칸 자체가 없었다(누락이지 값이
 * 사라진 버그가 아님) - purchase_orders SELECT("*")는 due_date 를 정상적으로 포함한다(1번 확인).
 *
 * 이 파일은 이 진단을 실제 함수 경로로 고정한다:
 *   [1] 픽스 전(REPRO) - openPODetail() 이 due_date 를 어디에도 안 보여주고, 기안 칸에 "?"만 보임
 *   [2] 픽스 후(FIX)   - due_date 가 있으면 "납품희망일" 로 보이고, WING 직접입고 자동 초안의
 *                        기안 칸은 "?" 대신 "자동생성"으로 보임(다른 정상 PO 는 기존 그대로 사람
 *                        이름이 보여야 함 - 회귀 없음)
 *   [3] 목록 행 템플릿도 같은 방식으로 고쳤는지 소스 문자열로 확인(viewPurchaseOrders() 는
 *       loadErpBase/loadReinboundRows 등 무거운 의존성이 많아 그 부분만 실제 함수로, 나머지는
 *       기존 promote 테스트와 같은 방식으로 no-op 오버라이드)
 *
 * *** 로컬 실행만 - 이 파일은 index.html 에서 안 불러옴(운영 번들에 안 들어감, node 로만 실행) ***
 *   node js/fixtures_po_due_date_display_dryrun.js
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
function checkContains(name, haystack, needle, shouldContain = true) {
  const ok = haystack.includes(needle) === shouldContain;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        ${shouldContain ? "포함돼야 하는데 없음" : "없어야 하는데 포함됨"}: ${JSON.stringify(needle)}`);
    FAILS.push(name);
  }
}
// "기안</td><td>...</td>" 처럼 특정 테이블 셀의 실제 내용만 뽑아서 비교 - "자동생성" 같은 단어가
// memo 등 다른 칸에도 우연히 나타날 수 있어 단순 includes() 로는 오탐이 날 수 있음(실측: 이
// 테스트를 처음 짤 때 memo 에 "[자동생성-검토필요]"가 이미 있어서 실제로 오탐이 났음).
function extractCell(html, labelCellText) {
  const re = new RegExp(`<td[^>]*>${labelCellText}</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`);
  const m = html.match(re);
  return m ? m[1] : null;
}

const APP_JS_PATH = path.join(__dirname, "app.js");
const ERP_UI_JS_PATH = path.join(__dirname, "erp_ui.js");
const INBOUND_APPROVAL_JS_PATH = path.join(__dirname, "inbound_approval.js");
const appSrcFull = fs.readFileSync(APP_JS_PATH, "utf8");
const CUT_MARKER = "/* ---------- 모바일 사이드바 ---------- */";
const cutIdx = appSrcFull.indexOf(CUT_MARKER);
if (cutIdx < 0) throw new Error(`app.js 에서 절단 지점을 못 찾음("${CUT_MARKER}") - 파일이 바뀌었으면 이 테스트도 같이 고쳐야 해요`);
const appSrc = appSrcFull.slice(0, cutIdx);
const erpUiSrc = fs.readFileSync(ERP_UI_JS_PATH, "utf8");
// openPODetail() 이 InboundApproval.poHoldChipHtml()/viewPurchaseOrders() 가 reinboundCardHtml() 을
// 쓴다 - erp_ui.js 와 같은 (function(root){...})(window) 모듈 패턴이라 그대로 번들에 포함하면
// sandbox.InboundApproval 로 붙는다(promote 테스트가 이 경로를 안 타서 안 겪었던 의존성).
const inboundApprovalSrc = fs.readFileSync(INBOUND_APPROVAL_JS_PATH, "utf8");

function makeFakeElement(id) {
  const el = {
    id, value: "", textContent: "", disabled: false, hidden: false,
    dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    appendChild() {}, remove() {}, closest: () => null,
    querySelector: () => null, querySelectorAll: () => [],
  };
  let _innerHTML = "";
  Object.defineProperty(el, "innerHTML", {
    get() { return _innerHTML; },
    set(v) { _innerHTML = v; },
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
function makeFakeSb() {
  const builder = {
    select() { return builder; }, eq() { return builder; }, in() { return builder; },
    order() { return builder; }, limit() { return builder; }, update() { return builder; },
    insert() { return builder; }, maybeSingle: () => Promise.resolve({ data: null, error: null }),
    single: () => Promise.resolve({ data: null, error: null }),
    then(resolve) { return Promise.resolve({ data: [], error: null }).then(resolve); },
  };
  return { from: () => builder };
}

function buildContext() {
  const sandbox = {};
  sandbox.window = sandbox;
  sandbox.console = console;
  sandbox.navigator = {};
  sandbox.document = makeFakeDocument();
  sandbox.window.supabase = { createClient: () => makeFakeSb() };
  const context = vm.createContext(sandbox);
  const trailer = `
    var __test = {
      setMe: function (v) { me = v; },
      setUsers: function (v) { USERS = v; },
      setPoCache: function (v) { poCache = v; },
      setPoItemCache: function (v) { poItemCache = v; },
      setPoHoldById: function (v) { poHoldById = v; },
      setErpSupplierList: function (v) { erpSupplierList = v; },
      getOpenPODetail: function () { return openPODetail; },
      getViewPurchaseOrders: function () { return viewPurchaseOrders; },
      getModalHtml: function () { return document.getElementById("modal-root").innerHTML; },
    };
    // 이 테스트가 겨냥하는 openPODetail()/viewPurchaseOrders() 본체는 원본 그대로 실행 - 그 밖의
    // 무거운(네트워크/DB) 보조 호출만 no-op 로 바꿔치기(기존 promote 테스트와 같은 원칙).
    loadPOFreightReview = async function () {};
    loadPOLoadFillProposal = async function () {};
    loadPOHoldSection = async function () {};
    loadPOVatApproveWarning = async function () {};
    loadErpBase = async function () {};
    loadPOs = async function () {};
    loadPoHolds = async function () { return poHoldById || {}; };
    loadReinboundRows = async function () { return { rows: [], error: null }; };
  `;
  const combined = erpUiSrc + "\n" + inboundApprovalSrc + "\n" + appSrc + "\n" + trailer;
  new vm.Script(combined, { filename: "app-bundle.js" }).runInContext(context);
  return context;
}

const WING_DIRECT_PO = {
  id: "po-1", po_no: "리버스-발주-WING검토-1104592096410472448", status: "wing_direct_review",
  date: "2026-09-19", supplier: "리파코 주식회사", deliver_to: "쿠팡", total: 1408000,
  memo: "[자동생성-검토필요] ...", drafter_id: null, approval_line: [], current_step: 0,
  ordered_at: null, freight_est: 0, wing_direct_shipment_id: "1104592096410472448",
  due_date: "2026-10-06",
};
const NORMAL_PO = {
  // 2026-09-19 approval_line 을 비워 결재 이력 표(userName(s.userId) 도 같이 부름)와 기안 칸이
  // 우연히 같은 이름으로 섞여 오탐이 나는 걸 원천 차단 - "회귀 없음"이 정말 기안 칸만 보고 있다는
  // 확신을 위해 이 PO 는 완료(done) 상태로 둬서 approval_line/결재 이력 렌더 경로 자체를 안 탐.
  id: "po-2", po_no: "리버스-발주-2026-020", status: "done",
  date: "2026-09-10", supplier: "다른 공급처", deliver_to: "쿠팡", total: 500000,
  memo: "", drafter_id: "user-1", approval_line: [],
  current_step: 0, ordered_at: "2026-09-10T00:00:00Z", freight_est: 0, wing_direct_shipment_id: null,
  due_date: null,
};
const USERS = [{ id: "user-1", name: "김철수" }, { id: "user-2", name: "박영희" }];

function extractListSubtitle(html, poNo) {
  const re = new RegExp(`<b>${poNo.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}</b><small class="erp-sub">([^<]*)</small>`);
  const m = html.match(re);
  return m ? m[1] : null;
}

console.log("=".repeat(70));
console.log("openPODetail()/viewPurchaseOrders() - due_date 표시 (실제 함수 경로)");
console.log("=".repeat(70));

const ctx = buildContext();
ctx.__test.setMe({ id: "user-2", approver: true });
ctx.__test.setUsers(USERS);
ctx.__test.setPoCache([WING_DIRECT_PO, NORMAL_PO]);
ctx.__test.setPoItemCache({
  "po-1": [{ product_id: "prod-1", qty: 64, received_qty: 0, wing_observed_received_qty: 0, unit_cost: 22000, amount: 1408000 }],
  "po-2": [{ product_id: "prod-1", qty: 10, received_qty: 0, wing_observed_received_qty: 0, unit_cost: 50000, amount: 500000 }],
});
ctx.__test.setPoHoldById({});
ctx.__test.setErpSupplierList([]);

console.log("\n[1] 모달 - WING 직접입고 검토 초안(due_date=2026-10-06, drafter_id=null)");
ctx.__test.getOpenPODetail()("po-1");
const html1 = ctx.__test.getModalHtml();
checkContains("[핵심] due_date 값(2026-10-06)이 모달 어딘가에 보임", html1, "2026-10-06", true);
checkContains("[핵심] '납품희망일' 라벨로 보임(due_date 를 나타내는 것임을 사람이 알 수 있게)", html1, "납품희망일", true);
const draftCell1 = extractCell(html1, "기안");
check("[핵심-빈틈] 기안 칸이 의미 없는 '?' 가 아니라 '자동생성'으로 표시됨(WING 자동 초안 - memo 등 다른 칸과 혼동 없이 그 칸만 확인)",
     draftCell1, "자동생성");

console.log("\n[2] 모달 - 일반(사람이 만든) 발주서(drafter_id 있음, due_date 없음) - 회귀 없음");
ctx.__test.getOpenPODetail()("po-2");
const html2 = ctx.__test.getModalHtml();
const draftCell2 = extractCell(html2, "기안");
check("[회귀] 기안자 이름(김철수)이 기안 칸에 여전히 정상 표시됨(자동생성으로 안 덮임)", draftCell2, "김철수");
checkContains("[회귀] due_date 없으면 '납품희망일' 칸 자체가 안 뜨거나 빈 값으로 안 깨짐(2026-10-06 안 섞여 들어옴)", html2, "2026-10-06", false);

console.log("\n[3] 목록(viewPurchaseOrders) - 같은 WING 직접입고 검토 초안이 목록 행에도 반영되는지");
(async () => {
  const listHtml = await ctx.__test.getViewPurchaseOrders()();
  const subtitle1 = extractListSubtitle(listHtml, WING_DIRECT_PO.po_no);
  const subtitle2 = extractListSubtitle(listHtml, NORMAL_PO.po_no);
  check("[핵심] WING 직접입고 검토 초안의 목록 부제가 더 이상 '날짜 · ?' 가 아님(그 칸의 실제 텍스트로 확인)",
       subtitle1 && subtitle1.includes("?"), false);
  check("[핵심] 목록 부제에 due_date(2026-10-06)가 노출됨(대표가 원래 기대했던 정보, 그 PO 행만 확인)",
       subtitle1 && subtitle1.includes("2026-10-06"), true);
  check("[회귀] 일반 발주서(po-2)의 목록 부제는 여전히 '날짜 · 기안자 이름' 그대로(김철수)",
       subtitle2 && subtitle2.includes("김철수"), true);

  console.log(`\n${FAILS.length ? FAILS.length + "건 실패" : "모두 통과"}`);
  process.exit(FAILS.length ? 1 : 0);
})();
