// fixtures_restock_wing_recovery_ui.mjs
// ------------------------------------------------
// 2026-09-27 재입고 WING 복구 화면(js/restock_wing_recovery.js) 검증 - 네트워크 0건, DB 는 가짜.
//   1) 순수 함수: 기대 EA(BOX×입수) · 재고 판단 대조 · RPC 응답 해석(멱등·BLOCKED 사유) · 버튼 상태 표(권한·단계·재고판단)
//   2) 화면: 승인 권한자 아니면 조회 0건·버튼 0개 · 승인자는 제출·WING 신청·수량·정책 유통기한·취소·대체 후보 표시
//   3) [취소 승인]: 확인창(대상·사유 필수) → rpc 1번(사용자 ID 없음) · 이미 처리됨(stale)이면 rpc 0 · 중복 클릭 BUSY · 오류·BLOCKED 표시 뒤 서버 재조회 · 멱등 응답
//   4) [대체 후보]: WING_CANCELLED 뒤에만 · 재고 판단이 달라지면 막힘 · 기대 EA·정책 유통기한을 그대로 보냄
//   5) [대체 후보 승인/거절]: 기존 후보 RPC(택배는 센터 null)
//   6) 라우트·메뉴·스크립트 연결 · WING 직접입고 취소와 다른 이름·경로
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
  const el = id => {
    if (!els.has(id)) els.set(id, { id, innerHTML: "", textContent: "", value: "", disabled: false, dataset: {}, classList: { toggle() {} },
      setAttribute() {}, removeAttribute() {}, remove() { els.delete(id); } });
    return els.get(id);
  };
  return { getElementById: el, querySelectorAll: () => [], els };
}

const SUB = "ebd293e2-8223-41f2-9358-6d4e18aa395c", CAND = "f67a010c-aa24-4745-bfdb-2015cb4cb445", PROD = "b23e501b", SHIP = "1107348548925542400";
const DB = {};
function resetDb() {
  DB.restock_inquiry_wing_submissions = [{ id: SUB, candidate_id: CAND, product_id: PROD, status: "SUBMITTED", wing_shipment_id: SHIP, quantity: 10, unit: "BOX",
    idempotency_key: `restock-wing-submit:${CAND}`, began_at: "2026-09-26T14:58:00Z" }];
  DB.restock_inquiry_wing_candidates = [{ id: CAND, status: "CLAIMED", extracted_quantity: 10, extracted_unit: "BOX", extracted_eta_date: "2026-10-12", replaces_candidate_id: null }];
  DB.restock_wing_submission_cancellations = [];
  DB.restock_wing_submission_cancellation_events = [];
  DB.product_procurement = [{ product_id: PROD, inbound_shipment_mode: "PARCEL", orderable_unit: "BOX", units_per_box: 20, inbound_expiration_required: true, inbound_expiration_date: "2028-05-01" }];
  DB.products = [{ id: PROD, code: "1K1A-018-01", name: "아가드 구름목욕시간 제로" }];
  DB.inbound_plans = [{ id: "p1", coupang_shipment_id: SHIP, internal_status: "SUCCEEDED", inbound_date: "2026-10-13", destination_center_raw: "YAS1" }];
}
const FAKE = { rpcResult: null, rpcError: null, rpcDelay: 0, loadError: null, decision: { product_id: PROD, decision: "ORDER_NOW", recommended_order_qty_ea: 200 } };
const calls = [];
function fakeSb() {
  const builder = t => {
    const b = { _in: [], select() { calls.push(["select", t]); return b; }, order() { return b; }, in(c, v) { b._in.push([c, v]); return b; }, eq(c, v) { b._in.push([c, [v]]); return b; },
      insert() { calls.push(["insert", t]); return b; }, update() { calls.push(["update", t]); return b; }, delete() { calls.push(["delete", t]); return b; },
      then(res, rej) {
        if (FAKE.loadError && t === "restock_wing_submission_cancellations") return Promise.resolve({ data: null, error: { message: FAKE.loadError } }).then(res, rej);
        let rows = DB[t] || [];
        for (const [c, v] of b._in) rows = rows.filter(r => v.map(String).includes(String(r[c])));
        return Promise.resolve({ data: JSON.parse(JSON.stringify(rows)), error: null }).then(res, rej);
      } };
    return b;
  };
  return {
    from: builder,
    rpc: async (fn, args) => {
      calls.push(["rpc", fn, JSON.parse(JSON.stringify(args))]);
      if (FAKE.rpcDelay) await new Promise(r => setTimeout(r, FAKE.rpcDelay));
      if (FAKE.rpcError) return { data: null, error: { message: FAKE.rpcError } };
      return { data: FAKE.rpcResult, error: null };
    },
  };
}
const toasts = [];
const doc = makeDoc();
const ctx = vm.createContext({ console, Map, Set, JSON, Number, String, Date, Math, Promise, Object, Array, RegExp, setTimeout, encodeURIComponent,
  document: doc, location: { hash: "#/restockrecovery" }, toast: m => toasts.push(m), closeModal: () => {}, alert: () => {},
  fetchInventoryDecisions: async () => ({ ok: true, decisions: FAKE.decision ? [FAKE.decision] : [], calculatedAt: "2026-09-26T21:31:11Z" }) });
vm.runInContext(read("./js/erp_ui.js"), ctx);
vm.runInContext(read("./js/restock_wing_recovery.js"), ctx);
const R = ctx.RestockWingRecovery;
const APPROVER = { id: "2ba083ad", approver: true }, STAFF = { id: "2d9b2258", approver: false };
const rpcs = () => calls.filter(c => c[0] === "rpc");
const writes = () => calls.filter(c => ["insert", "update", "delete"].includes(c[0]));

async function runWithConfirm(promiseFn, reason, answer = true) {
  const p = promiseFn();
  for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
  const opened = doc.getElementById("modal-root").innerHTML;
  if (reason !== undefined) doc.getElementById("erp-confirm-reason").value = reason;
  ctx.ErpUi._answer(answer);
  const res = await p;
  return { res, opened };
}

console.log("=== 1. 순수 함수 ===");
check([R.expectedEa({ extracted_quantity: 10, extracted_unit: "BOX" }, { units_per_box: 20 }), R.expectedEa({ extracted_quantity: 5, extracted_unit: "EA" }, {}),
       R.expectedEa({ extracted_quantity: 10, extracted_unit: "BOX" }, { units_per_box: null }), R.expectedEa({ extracted_quantity: 1, extracted_unit: "PLT" }, { units_per_box: 20 })],
      [200, 5, null, null], "[핵심] 기대 EA = BOX×박스 입수 · EA 그대로 · 입수 없음/PLT 는 모름(null)");
check([R.decisionCheck({ decision: "ORDER_NOW", recommended_order_qty_ea: 200 }, 200).ok, R.decisionCheck({ decision: "DATA_CHECK", decision_reason: "NO_SALES_HISTORY" }, 200).ok,
       R.decisionCheck({ decision: "ORDER_NOW", recommended_order_qty_ea: 400 }, 200).text, R.decisionCheck(null, 200).ok, R.decisionCheck(null, 200, { error: "x" }).ok],
      [true, false, "지금 추천 400EA ≠ 원래 200EA", null, null], "[핵심] 재고 판단 대조: ORDER_NOW·같은 EA 만 통과 · DATA_CHECK·다른 EA 는 막음 · 모르면 판단 보류(null)");
const ir = (fn, d, e) => R.interpretRpc(fn, d, e);
check([ir("fn_approve_restock_wing_submission_cancel", { status: "CANCEL_APPROVED" }).ok, ir("fn_approve_restock_wing_submission_cancel", { status: "ALREADY_CANCEL_APPROVED" }).idempotent,
       ir("fn_approve_restock_wing_submission_cancel", { status: "BLOCKED", reasons: ["CONFIRM_MAIL_IN_FLIGHT"] }).ok,
       ir("fn_create_restock_replacement_candidate", { status: "BLOCKED", reasons: ["NOT_ORDER_NOW"] }).message,
       ir("fn_create_restock_replacement_candidate", { status: "ALREADY_CREATED", candidate_id: "abcdef1234" }).idempotent,
       ir("x", null, { message: "NOT_APPROVER" }).message, ir("fn_approve_restock_inquiry_wing_candidate", { status: "APPROVED" }).ok],
      [true, true, false, "지금 재고 판단이 '지금 발주'가 아니에요 (NOT_ORDER_NOW)", true, "NOT_APPROVER", true],
      "[핵심] RPC 해석: 성공·멱등(ALREADY_*) 구분 · BLOCKED 는 실패 + 사람 문구(코드 포함) · 오류 문구 그대로");
resetDb();
const baseRows = () => R.buildRows({ submissions: DB.restock_inquiry_wing_submissions, candidates: DB.restock_inquiry_wing_candidates,
  cancellations: DB.restock_wing_submission_cancellations, procurements: DB.product_procurement, products: DB.products, plans: DB.inbound_plans, events: [] });
const row0 = baseRows()[0];
check([row0.ea, row0.policyExpiry, row0.lane, row0.plan.destination_center_raw], [200, "2028-05-01", "PARCEL", "YAS1"], "행 조립: 200EA · 정책 유통기한 · 레인 · 입고계획");
const st = (row, isApprover = true, dc = { ok: true }) => { const a = R.actionState(row, { isApprover, decisionCheck: dc });
  return ["cancel", "replace", "approve", "reject"].map(k => a[k].enabled); };
check(st(row0, false), [false, false, false, false], "[핵심] 승인 권한자 아니면 모든 버튼 비활성");
check(st(row0), [true, false, false, false], "[핵심] 취소 기록 없음: 취소 승인만 활성(대체 후보는 WING 취소 확인 뒤)");
const withC = (status, extra = {}) => ({ ...row0, cancellation: { id: "c1", status, attempt_no: 1 }, ...extra });
check(["CANCEL_APPROVED", "CANCEL_SENDING", "CANCEL_UNKNOWN", "CANCEL_FAILED"].map(s => st(withC(s))),
      [[false, false, false, false], [false, false, false, false], [false, false, false, false], [false, false, false, false]],
      "[핵심] 취소 승인·진행·불명·실패 상태에선 대체 후보 비활성(취소 승인도 중복 비활성)");
check(st(withC("WING_CANCELLED")), [false, true, false, false], "[핵심] WING_CANCELLED 뒤에만 대체 후보 활성");
check([st(withC("WING_CANCELLED"), true, { ok: false, text: "x" })[1], R.actionState(withC("WING_CANCELLED"), { isApprover: true, decisionCheck: { ok: false, text: "지금 재고 판단: DATA_CHECK" } }).replace.why],
      [false, "지금 재고 판단: DATA_CHECK"], "[핵심] 재고 판단이 달라지면 대체 후보 비활성 + 이유 표시");
check(st(withC("WING_CANCELLED", { replacement: { id: "n1", status: "PENDING_APPROVAL" } })), [false, false, true, true], "대체 후보 승인 대기: 승인·거절만 활성(대체 후보 중복 생성 비활성)");
check(st(withC("WING_CANCELLED", { replacement: { id: "n1", status: "APPROVED" } })), [false, false, false, false], "대체 후보 승인됨: 모두 비활성");
check(st({ ...row0, lane: "TRUCK" })[0], false, "택배(PARCEL) 아닌 제출은 취소 비활성");
check(st({ ...row0, submission: { ...row0.submission, status: "SUBMIT_UNKNOWN" } })[0], false, "SUBMITTED 아닌 제출은 취소 비활성");

console.log("\n=== 2. 화면 · 권한 ===");
calls.length = 0;
const staffHtml = await R.view(fakeSb(), STAFF);
check([calls.length, staffHtml.includes("승인 권한자만 볼 수 있는"), staffHtml.includes("<button"), staffHtml.includes(SHIP)], [0, true, false, false],
      "[핵심] 승인 권한자 아니면 조회 0건 · 데이터·버튼 없음");
const html = await R.view(fakeSb(), APPROVER);
check([html.includes("재입고 WING 복구"), html.includes(SHIP), html.includes("2028-05-01"), html.includes("200EA"), html.includes("취소 기록 없음"),
       html.includes("WING 상세 열기"), html.includes("fn_decide_wing_direct_cancel"), writes().length],
      [true, true, true, true, true, true, false, 0], "[핵심] 승인자 화면: 제출·WING 신청·정책 유통기한·200EA·취소 상태 표시 · 쓰기 0");
check([(html.match(/data-erp-key="rwr-cancel-[^"]+"\s+title=/g) || []).length, (html.match(/data-erp-key="rwr-cancel-[^"]+"\s+disabled/g) || []).length], [1, 0],
      "취소 승인 버튼은 활성 1개(비활성 0)");
check((html.match(/data-erp-key="rwr-replace-[^"]+"\s+disabled/g) || []).length, 1, "대체 후보 버튼은 비활성(WING 취소 확인 전)");
check([html.includes("지금 발주 · 추천 200EA"), html.includes("WING 직접입고 발주서의 [WING 취소]와는 다른 기능")], [true, true], "재고 판단 표시 · 직접입고 취소와 다름 안내");

console.log("\n=== 3. [취소 승인] ===");
resetDb(); calls.length = 0; FAKE.rpcResult = { status: "CANCEL_APPROVED" };
await R.view(fakeSb(), APPROVER);
let r = await runWithConfirm(() => R.approveCancel(SUB), "유통기한 2028-06-01 오기록 - 취소 후 재신청");
check([r.res.status, rpcs().length, rpcs()[0][1], Object.keys(rpcs()[0][2]).sort(), rpcs()[0][2].p_submission_id],
      ["DONE", 1, "fn_approve_restock_wing_submission_cancel", ["p_reason", "p_submission_id"], SUB],
      "[핵심] 확인 → rpc 1번(제출 ID·사유만 - 사용자 ID 없음, 서버가 로그인 세션으로 판단)");
check([r.opened.includes(SHIP), r.opened.includes("200EA"), r.opened.includes("2028-05-01"), r.opened.includes("WING 에는 아직 아무것도 보내지 않아요")],
      [true, true, true, true], "[핵심] 확인창: 정확한 대상(WING 신청 번호·수량·정책 유통기한) + WING 미전송 안내");
calls.length = 0;
const pShort = R.approveCancel(SUB);
for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
doc.getElementById("erp-confirm-reason").value = "짧음";
ctx.ErpUi._answer(true);
await tick();
check([rpcs().length, doc.getElementById("erp-confirm-err").textContent.includes("5자 이상")], [0, true], "사유 5자 미만이면 확인창에서 멈춤(rpc 0)");
ctx.ErpUi._answer(false); await pShort;
// 이미 처리됨(다른 사람이 먼저 승인) → stale
DB.restock_wing_submission_cancellations = [{ id: "c1", submission_id: SUB, status: "CANCEL_APPROVED", attempt_no: 0, approved_at: "2026-09-27T00:00:00Z" }];
calls.length = 0;
r = await R.approveCancel(SUB);
check([r.status, rpcs().length], ["STALE", 0], "[핵심] 누르기 직전 서버 재확인 - 이미 취소 기록이 있으면 멈춤(rpc 0)");
// 중복 클릭
resetDb(); calls.length = 0; FAKE.rpcDelay = 20;
const p1 = R.approveCancel(SUB);
const second = await R.approveCancel(SUB);
for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
doc.getElementById("erp-confirm-reason").value = "중복 클릭 시험 사유";
ctx.ErpUi._answer(true);
await p1;
check([second.status, rpcs().length], ["BUSY", 1], "[핵심] 처리 중 다시 누르면 BUSY - rpc 1번뿐");
FAKE.rpcDelay = 0;
// RPC 오류 · BLOCKED · 멱등
for (const [label, setup, want] of [
  ["RPC 오류", () => { FAKE.rpcError = "NOT_APPROVER"; }, ["FAILED", "NOT_APPROVER"]],
  ["서버 BLOCKED", () => { FAKE.rpcError = null; FAKE.rpcResult = { status: "BLOCKED", reasons: ["CONFIRM_MAIL_IN_FLIGHT"] }; }, ["FAILED", "확정 메일이 발송 중이거나 결과 불명이에요 - 먼저 해소해 주세요 (CONFIRM_MAIL_IN_FLIGHT)"]],
]) {
  resetDb(); calls.length = 0; setup();
  const loadsBefore = calls.filter(c => c[0] === "select").length;
  const x = await runWithConfirm(() => R.approveCancel(SUB), "오류 표시 시험 사유");
  const errText = doc.getElementById("erp-confirm-err").textContent;
  check([x.res.status, x.res.message, errText.includes("서버 상태를 다시 읽었어요"), calls.filter(c => c[0] === "select").length > loadsBefore], [...want, true, true],
        `[핵심] ${label}: 실패로 표시 · 확인창에 사유 · 서버 상태 다시 읽음`);
}
FAKE.rpcError = null;
resetDb(); calls.length = 0; FAKE.rpcResult = { status: "ALREADY_CANCEL_APPROVED" }; toasts.length = 0;
r = await runWithConfirm(() => R.approveCancel(SUB), "멱등 응답 시험 사유");
check([r.res.status, toasts.some(t => t.includes("새로 만들지 않았어요"))], ["DONE", true], "멱등 응답(ALREADY_*)은 새로 만들지 않았다고 표시");

console.log("\n=== 4. [대체 후보 만들기] ===");
resetDb(); calls.length = 0;
await R.view(fakeSb(), APPROVER);
r = await R.createReplacement(SUB);
check([r.status, rpcs().length], ["STALE", 0], "[핵심] WING 취소 확인 전 → 멈춤(rpc 0)");
DB.restock_wing_submission_cancellations = [{ id: "c1", submission_id: SUB, candidate_id: CAND, status: "WING_CANCELLED", attempt_no: 2, observed_wing_status: "CANCELLED" }];
FAKE.decision = { product_id: PROD, decision: "DATA_CHECK", recommended_order_qty_ea: null, decision_reason: "NO_SALES_HISTORY" };
calls.length = 0;
r = await R.createReplacement(SUB);
check([r.status, rpcs().length], ["STALE", 0], "[핵심] WING 취소 확인이어도 지금 재고 판단이 DATA_CHECK 면 멈춤(rpc 0)");
FAKE.decision = { product_id: PROD, decision: "ORDER_NOW", recommended_order_qty_ea: 200 };
FAKE.rpcResult = { status: "PENDING_APPROVAL", candidate_id: "n1", ea: 200, expiration_date: "2028-05-01" };
calls.length = 0;
r = await runWithConfirm(() => R.createReplacement(SUB), "WING 취소 확인 - 같은 근거로 재신청");
check([r.res.status, rpcs().length, rpcs()[0] && rpcs()[0][2]],
      ["DONE", 1, { p_cancellation_id: "c1", p_expected_ea: 200, p_expected_expiration_date: "2028-05-01", p_note: "WING 취소 확인 - 같은 근거로 재신청" }],
      "[핵심] 대체 후보: 취소 ID·기대 200EA·정책 유통기한 2028-05-01·근거를 그대로 보냄(사용자 ID 없음)");
check([r.opened.includes("지금 발주 · 추천 200EA"), r.opened.includes("원 후보당 대체 후보는 1개뿐")], [true, true], "확인창: 지금 재고 판단·1개 규칙 안내");
DB.restock_inquiry_wing_candidates.push({ id: "n1", status: "PENDING_APPROVAL", extracted_quantity: 10, extracted_unit: "BOX", replaces_candidate_id: CAND });
calls.length = 0;
r = await R.createReplacement(SUB);
check([r.status, rpcs().length], ["STALE", 0], "대체 후보가 이미 있으면 다시 만들지 않음(rpc 0)");

console.log("\n=== 5. [대체 후보 승인/거절] ===");
FAKE.rpcResult = { status: "APPROVED", lane: "PARCEL" }; calls.length = 0;
r = await runWithConfirm(() => R.approveReplacement(SUB), "대체 후보 택배 200EA 확인");
check([r.res.status, rpcs()[0][1], rpcs()[0][2]], ["DONE", "fn_approve_restock_inquiry_wing_candidate", { p_candidate_id: "n1", p_note: "대체 후보 택배 200EA 확인", p_destination_center_id: null }],
      "[핵심] 대체 후보 승인: 기존 후보 승인 RPC · 택배라 센터 null");
FAKE.rpcResult = { status: "REJECTED" }; calls.length = 0;
r = await runWithConfirm(() => R.rejectReplacement(SUB), "대체 후보 거절 시험");
check([r.res.status, rpcs()[0][1], rpcs()[0][2]], ["DONE", "fn_reject_restock_inquiry_wing_candidate", { p_candidate_id: "n1", p_note: "대체 후보 거절 시험" }], "대체 후보 거절: 기존 거절 RPC");
DB.restock_inquiry_wing_candidates[1].status = "APPROVED"; calls.length = 0;
r = await R.approveReplacement(SUB);
check([r.status, rpcs().length], ["STALE", 0], "이미 승인된 대체 후보는 다시 승인하지 않음(rpc 0)");
// 권한 없는 사용자가 함수를 직접 불러도 막힘(버튼이 없어도)
await R.view(fakeSb(), STAFF); calls.length = 0;
r = await R.approveCancel(SUB);
check([r.status, rpcs().length], ["DENIED", 0], "[핵심] 승인 권한자 아닌 세션은 함수를 직접 불러도 DENIED(rpc 0)");
check(writes().length, 0, "[핵심] 화면 전체에서 표 직접 쓰기 0건(쓰기는 RPC 만)");
// 불러오기 실패 표시
resetDb(); FAKE.loadError = "permission denied for table restock_wing_submission_cancellations";
const errHtml = await R.view(fakeSb(), APPROVER);
check([errHtml.includes("불러오지 못했어요"), errHtml.includes("permission denied")], [true, true], "불러오기 실패는 화면에 사유 표시");
FAKE.loadError = null;

console.log("\n=== 6. 연결 ===");
const app = read("./js/app.js"), index = read("./index.html");
check([/restockrecovery: \{ title: "재입고 WING 복구", render: \(\) => \(globalThis\.RestockWingRecovery \? RestockWingRecovery\.view\(sb, me\)/.test(app),
       index.includes('<script src="js/restock_wing_recovery.js?v=1"></script>'), index.includes('href="#/restockrecovery" data-route="restockrecovery"'),
       index.indexOf("restock_wing_recovery.js") < index.indexOf("js/app.js")],
      [true, true, true, true], "[핵심] app.js 라우트·index.html 스크립트(app.js 앞)·메뉴 연결");
const mod = read("./js/restock_wing_recovery.js");
check([mod.includes("fn_decide_wing_direct_cancel("), mod.includes("fn_cancel_wing_direct_po("), /from\([^)]*\)\.(insert|update|delete|upsert)/.test(mod),
       /p_(user|actor|approver)_id/.test(mod), app.includes('wingdirectcancel: { title: "재입고 WING 복구"')],
      [false, false, false, false, false], "[핵심] 직접입고 취소 RPC 안 부름 · 표 직접 쓰기 없음 · 사용자 ID 파라미터 없음 · 이름 겹침 없음");

console.log(`\n${fails ? "FAIL" : "ALL PASS"} ${passes} / FAIL ${fails}`);
process.exit(fails ? 1 : 0);
