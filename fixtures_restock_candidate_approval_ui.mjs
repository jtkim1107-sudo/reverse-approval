// fixtures_restock_candidate_approval_ui.mjs
// ------------------------------------------------
// 2026-09-27 재입고 후보 승인 화면(js/restock_candidate_approval.js) 검증 - 네트워크 0건, DB 는 가짜.
//   1) 순수 함수: EA(BOX×입수·PLT×입수) · 재고 판단 대조 · 버튼 상태(권한·택배만·리허설·재확인 대기·유통기한·출고일·재고 판단)
//   2) 화면: 승인 권한자 아니면 조회 0·버튼 0 · 승인 대기 후보만 표시 · 상품명 상수 없음(서버 데이터 그대로)
//   3) [승인]: 확인창 → rpc 1번(후보 ID·근거·센터 null - 사용자 ID 없음) · 이미 처리됨이면 rpc 0 · 중복 클릭 BUSY · 오류 표시 뒤 재조회
//   4) [거절]: 사유 5자 이상 · 트럭 후보도 거절 가능(승인은 보기만)
//   5) 연결: 라우트·메뉴·스크립트(app.js 앞)·app.js 버전
import { readFileSync } from "fs";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
let fails = 0, passes = 0;
const check = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(got)}, 기대=${JSON.stringify(want)})`}`);
  if (ok) passes++; else fails++;
};
const tick = () => new Promise(r => setTimeout(r, 0));
function makeDoc() {
  const els = new Map();
  const el = id => { if (!els.has(id)) els.set(id, { id, innerHTML: "", textContent: "", value: "", disabled: false, dataset: {}, setAttribute() {}, removeAttribute() {}, remove() { els.delete(id); } }); return els.get(id); };
  return { getElementById: el, querySelectorAll: () => [], els };
}
const DB = {};
function resetDb() {
  DB.restock_inquiry_wing_candidates = [
    { id: "p1", status: "PENDING_APPROVAL", product_id: "A", inquiry_id: "q1", inquiry_item_id: "i1", extracted_quantity: 10, extracted_unit: "BOX",
      extracted_eta_date: "2099-10-12", extraction_evidence: "PARCEL RECONFIRMED 200EA", quantity_reconfirmation_id: "rc1", created_at: "2026-09-27T00:00:00Z" },
    { id: "t1", status: "PENDING_APPROVAL", product_id: "B", inquiry_id: "q1", inquiry_item_id: "i2", extracted_quantity: 1, extracted_unit: "PLT",
      extracted_eta_date: "2099-10-12", extraction_evidence: "1PLT", created_at: "2026-09-27T00:00:00Z" },
    { id: "x1", status: "APPROVED", product_id: "A", inquiry_id: "q1", inquiry_item_id: "i9", extracted_quantity: 5, extracted_unit: "BOX", created_at: "2026-09-26T00:00:00Z" },
  ];
  DB.product_procurement = [{ product_id: "A", inbound_shipment_mode: "PARCEL", units_per_box: 20, inbound_expiration_required: true, inbound_expiration_date: "2028-05-01" },
                            { product_id: "B", inbound_shipment_mode: "TRUCK", units_per_plt: 36 }];
  DB.products = [{ id: "A", code: "CODE-A", name: "상품 가" }, { id: "B", code: "CODE-B", name: "상품 나" }];
  DB.restock_supplier_inquiries = [{ id: "q1", supplier_name: "공급처 갑", is_rehearsal: false, status: "REPLIED" }];
  DB.restock_quantity_reconfirmations = [{ id: "rc1", status: "CONFIRMED", inquiry_item_id: "i1", confirmed_ea: 200, revised_ea: 200 }];
}
const FAKE = { rpcResult: { status: "APPROVED" }, rpcError: null, rpcDelay: 0, decisions: [{ product_id: "A", decision: "ORDER_NOW", recommended_order_qty_ea: 200 }] };
const calls = [];
function fakeSb() {
  const builder = t => {
    const b = { _f: [], select() { calls.push(["select", t]); return b; }, order() { return b; }, in(c, v) { b._f.push([c, v]); return b; }, eq(c, v) { b._f.push([c, [v]]); return b; },
      insert() { calls.push(["insert", t]); return b; }, update() { calls.push(["update", t]); return b; }, delete() { calls.push(["delete", t]); return b; },
      then(res, rej) { let rows = DB[t] || []; for (const [c, v] of b._f) rows = rows.filter(r => v.map(String).includes(String(r[c])));
        return Promise.resolve({ data: JSON.parse(JSON.stringify(rows)), error: null }).then(res, rej); } };
    return b;
  };
  return { from: builder, rpc: async (fn, args) => { calls.push(["rpc", fn, JSON.parse(JSON.stringify(args))]);
    if (FAKE.rpcDelay) await new Promise(r => setTimeout(r, FAKE.rpcDelay));
    return FAKE.rpcError ? { data: null, error: { message: FAKE.rpcError } } : { data: FAKE.rpcResult, error: null }; } };
}
const toasts = [];
const doc = makeDoc();
const ctx = vm.createContext({ console, Map, Set, JSON, Number, String, Date, Math, Promise, Object, Array, RegExp, setTimeout,
  document: doc, location: { hash: "#/restockapproval" }, toast: m => toasts.push(m), closeModal: () => {},
  fetchInventoryDecisions: async () => ({ ok: true, decisions: FAKE.decisions, calculatedAt: "2026-09-27T00:00:00Z" }) });
vm.runInContext(read("./js/erp_ui.js"), ctx);
vm.runInContext(read("./js/restock_candidate_approval.js"), ctx);
const A = ctx.RestockCandidateApproval;
const APPROVER = { id: "ap", approver: true }, STAFF = { id: "st", approver: false };
const rpcs = () => calls.filter(c => c[0] === "rpc");
async function withConfirm(fn, reason, ans = true) {
  const p = fn();
  for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
  const opened = doc.getElementById("modal-root").innerHTML;
  if (reason !== undefined) doc.getElementById("erp-confirm-reason").value = reason;
  ctx.ErpUi._answer(ans);
  return { res: await p, opened };
}

console.log("=== 1. 순수 함수 ===");
check([A.expectedEa({ extracted_quantity: 10, extracted_unit: "BOX" }, { units_per_box: 20 }), A.expectedEa({ extracted_quantity: 1, extracted_unit: "PLT" }, { units_per_plt: 36 }),
       A.expectedEa({ extracted_quantity: 7, extracted_unit: "EA" }, {}), A.expectedEa({ extracted_quantity: 10, extracted_unit: "BOX" }, {})], [200, 36, 7, null], "EA 환산(정책 데이터만)");
resetDb();
const rows = A.buildRows({ candidates: DB.restock_inquiry_wing_candidates.slice(0, 2), procurements: DB.product_procurement, products: DB.products,
                          inquiries: DB.restock_supplier_inquiries, reconfirmations: DB.restock_quantity_reconfirmations });
const ok = { ok: true };
const st = (row, c = {}) => { const a = A.actionState(row, { isApprover: true, decisionCheck: ok, today: "2026-09-27", ...c }); return [a.approve.enabled, a.reject.enabled]; };
check([st(rows[0]), st(rows[1]), st(rows[0], { isApprover: false })], [[true, true], [false, true], [false, false]],
      "[핵심] 택배 후보는 승인·거절 · 트럭 후보는 거절만(센터 선택 필요) · 권한자 아니면 둘 다 막힘");
check(st({ ...rows[0], rehearsal: true }), [false, false], "리허설 후보는 이 화면에서 처리 안 함");
check(st({ ...rows[0], reconfirmPending: true }), [false, true], "[핵심] 공급처 수량 재확인 대기 중이면 승인 막힘");
check(st({ ...rows[0], policyExpiry: null }), [false, true], "[핵심] 유통기한 관리 상품인데 정책 날짜 없으면 승인 막힘");
check(st({ ...rows[0], candidate: { ...rows[0].candidate, extracted_eta_date: "2026-09-01" } }), [false, true], "[핵심] 출고 가능일이 지났으면 승인 막힘");
check([st(rows[0], { decisionCheck: A.decisionCheck({ decision: "DATA_CHECK" }, 200) }), A.decisionCheck({ decision: "ORDER_NOW", recommended_order_qty_ea: 400 }, 200).text],
      [[false, true], "지금 추천 400EA ≠ 후보 200EA"], "[핵심] 재고 판단이 ORDER_NOW·같은 EA 가 아니면 승인 막힘(이유 표시)");
check(st({ ...rows[0], candidate: { ...rows[0].candidate, status: "APPROVED" } }), [false, false], "승인 대기 아닌 후보는 버튼 막힘");

console.log("\n=== 2. 화면 · 권한 ===");
calls.length = 0;
const staffHtml = await A.view(fakeSb(), STAFF);
check([calls.length, staffHtml.includes("<button"), staffHtml.includes("상품 가")], [0, false, false], "[핵심] 승인 권한자 아니면 조회 0·버튼 0·데이터 0");
resetDb();
const html = await A.view(fakeSb(), APPROVER);
check([html.includes("상품 가"), html.includes("상품 나"), html.includes("x1"), html.includes("200EA"), html.includes("공급처 갑"), html.includes("2028-05-01"),
       html.includes("승인 전에는 WING 에 제출되지 않아요")], [true, true, false, true, true, true, true],
      "[핵심] 승인 대기 후보만(승인된 x1 제외) · 공급처·수량·유통기한 표시 · WING 미전송 안내");
const mod = read("./js/restock_candidate_approval.js");
check([/리파코|아가드|lipaco/i.test(mod), /from\([^)]*\)\.(insert|update|delete|upsert)/.test(mod), /p_(user|actor|approver)_id/.test(mod)], [false, false, false],
      "[핵심] 상품·공급처 상수 없음 · 표 직접 쓰기 없음 · 사용자 ID 파라미터 없음");

console.log("\n=== 3. [승인] ===");
calls.length = 0;
let r = await withConfirm(() => A.approve("p1"), "택배 200EA 확인");
check([r.res.status, rpcs().length, rpcs()[0][1], rpcs()[0][2]], ["DONE", 1, "fn_approve_restock_inquiry_wing_candidate",
      { p_candidate_id: "p1", p_note: "택배 200EA 확인", p_destination_center_id: null }], "[핵심] 승인 rpc 1번(센터 null · 사용자 ID 없음)");
check([r.opened.includes("200EA"), r.opened.includes("2099-10-12"), r.opened.includes("이 화면은 WING 에 보내지 않아요")], [true, true, true], "확인창: 수량·출고일·WING 미전송");
DB.restock_inquiry_wing_candidates[0].status = "APPROVED"; calls.length = 0;
r = await A.approve("p1");
check([r.status, rpcs().length], ["STALE", 0], "[핵심] 이미 처리된 후보는 멈춤(rpc 0)");
resetDb(); calls.length = 0; FAKE.rpcDelay = 20;
const p1 = A.approve("p1"); const second = await A.approve("p1");
for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
doc.getElementById("erp-confirm-reason").value = "중복 시험"; ctx.ErpUi._answer(true); await p1;
check([second.status, rpcs().length], ["BUSY", 1], "[핵심] 처리 중 다시 누르면 BUSY - rpc 1번");
FAKE.rpcDelay = 0; FAKE.rpcError = "NOT_APPROVER"; calls.length = 0;
const selBefore = () => calls.filter(c => c[0] === "select").length;
const s0 = selBefore();
r = await withConfirm(() => A.approve("p1"), "오류 시험");
check([r.res.status, r.res.message, selBefore() > s0], ["FAILED", "NOT_APPROVER", true], "[핵심] RPC 오류는 실패로 표시 · 서버 상태 다시 읽음");
FAKE.rpcError = null;
FAKE.decisions = [{ product_id: "A", decision: "DATA_CHECK", recommended_order_qty_ea: null }]; calls.length = 0;
r = await A.approve("p1");
check([r.status, rpcs().length], ["STALE", 0], "[핵심] 누르기 직전 재고 판단이 바뀌었으면 멈춤(rpc 0)");
FAKE.decisions = [{ product_id: "A", decision: "ORDER_NOW", recommended_order_qty_ea: 200 }];
await A.view(fakeSb(), STAFF); calls.length = 0;
r = await A.approve("p1");
check([r.status, rpcs().length], ["DENIED", 0], "[핵심] 권한 없는 세션은 직접 불러도 DENIED(rpc 0)");

console.log("\n=== 4. [거절] ===");
await A.view(fakeSb(), APPROVER); FAKE.rpcResult = { status: "REJECTED" }; calls.length = 0;
const pr = A.reject("t1");
for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
doc.getElementById("erp-confirm-reason").value = "짧다"; ctx.ErpUi._answer(true); await tick();
check(rpcs().length, 0, "거절 사유 5자 미만이면 멈춤");
doc.getElementById("erp-confirm-reason").value = "트럭 1PLT 옛 후보 거절"; ctx.ErpUi._answer(true);
r = { res: await pr };
check([r.res.status, rpcs()[0][1], rpcs()[0][2]], ["DONE", "fn_reject_restock_inquiry_wing_candidate", { p_candidate_id: "t1", p_note: "트럭 1PLT 옛 후보 거절" }],
      "[핵심] 트럭 후보 거절 가능(기존 거절 RPC)");
check(calls.filter(c => ["insert", "update", "delete"].includes(c[0])).length, 0, "[핵심] 표 직접 쓰기 0건");

console.log("\n=== 5. 연결 ===");
const app = read("./js/app.js"), index = read("./index.html");
check([/restockapproval: \{ title: "재입고 후보 승인", render: \(\) => \(globalThis\.RestockCandidateApproval \? RestockCandidateApproval\.view\(sb, me\)/.test(app),
       index.includes('<script src="js/restock_candidate_approval.js?v=1"></script>'), index.includes('href="#/restockapproval" data-route="restockapproval"'),
       index.indexOf("restock_candidate_approval.js") < index.indexOf("js/app.js"), index.includes('js/app.js?v=145')],
      [true, true, true, true, true], "[핵심] 라우트·스크립트(app.js 앞)·메뉴·app.js?v=145");
console.log(`\n${fails ? "FAIL" : "ALL PASS"} ${passes} / FAIL ${fails}`);
process.exit(fails ? 1 : 0);
