// fixtures_restock_inquiry_close_ui.mjs
// ------------------------------------------------
// 2026-09-27 재입고 문의 테스트 종료 화면(js/restock_inquiry_close.js) 검증 - 네트워크 0건, 서버는 가짜.
//   1) 순수 함수: 버튼 상태(권한·막힘 사유·이미 종료) · 결과 해석(CLOSED/ALREADY_CLOSED/STALE_STATE/BLOCKED/오류)
//   2) 화면: 승인 권한자 아니면 rpc 0·버튼 0 · 서버 미리보기 그대로 표시(상수 없음) · 막힌 문의는 버튼 막힘+이유
//   3) [테스트로 종료]: 누르기 직전 미리보기 다시 읽음 → 확인창(보낸 메일 보존·공급처 메일 없음 안내) → rpc 1번(문의 ID·그때 지문·사유, 사용자 ID 없음)
//      · 사유 5자 미만이면 멈춤 · 그 사이 막힘/종료면 rpc 0 · 중복 클릭 BUSY · STALE_STATE 는 실패 표시 · 표 직접 쓰기 0
//   4) 연결: 라우트·메뉴·스크립트(app.js 앞)·app.js 버전
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

const ENTRY = (over = {}) => ({
  inquiry_id: "q1", fingerprint: "fp-1", blockers: [], closure: null,
  inquiry: { id: "q1", status: "REPLIED", kind: "RESTOCK", is_rehearsal: false, supplier_name: "공급처 갑", subject: "[재입고 사전 문의] 합적", sent_at: "2026-09-25T01:00:00Z" },
  items: [{ id: "i1", product_name: "상품 가", status: "REPLIED", quantity: 1, unit: "PLT" }, { id: "i2", product_name: "상품 나", status: "REPLIED", quantity: 1, unit: "PLT" }],
  reconfirmations: [{ id: "rc1-aaaa", status: "PENDING_SUPPLIER_CONFIRMATION", original_ea: 800, revised_ea: 200 }],
  reconfirmation_mails: [{ id: "m1-bbbbb", status: "SENT", sent_at: "2026-09-27T02:42:00Z" }],
  candidates: [], submissions: [], ...over });
const SERVER = {};
function resetServer() {
  SERVER.list = [ENTRY(), ENTRY({ inquiry_id: "q2", fingerprint: "fp-2", blockers: ["ACTIVE_CANDIDATE"],
    inquiry: { ...ENTRY().inquiry, id: "q2", supplier_name: "공급처 을" }, candidates: [{ id: "c9", status: "PENDING_APPROVAL" }] })];
  SERVER.closures = [];
  SERVER.one = { q1: ENTRY(), q2: SERVER.list[1] };
  SERVER.closeResult = { status: "CLOSED", reconfirmations_cancelled: 1, items_cancelled: 2, mails_preserved: 1 };
  SERVER.closeError = null; SERVER.delay = 0;
}
const calls = [];
function fakeSb() {
  const builder = t => {
    const b = { select() { calls.push(["select", t]); return b; }, insert() { calls.push(["insert", t]); return b; }, update() { calls.push(["update", t]); return b; },
      delete() { calls.push(["delete", t]); return b; }, eq() { return b; }, in() { return b; }, order() { return b; }, then(res) { return Promise.resolve({ data: [], error: null }).then(res); } };
    return b;
  };
  return { from: builder, rpc: async (fn, args) => {
    calls.push(["rpc", fn, JSON.parse(JSON.stringify(args))]);
    if (fn === "fn_preview_restock_inquiry_test_close") {
      if (args && args.p_inquiry_id) return { data: JSON.parse(JSON.stringify(SERVER.one[args.p_inquiry_id] || { inquiry_id: args.p_inquiry_id, inquiry: null, blockers: ["INQUIRY_NOT_FOUND"] })), error: null };
      return { data: { inquiries: JSON.parse(JSON.stringify(SERVER.list)), recent_closures: JSON.parse(JSON.stringify(SERVER.closures)) }, error: null };
    }
    if (SERVER.delay) await new Promise(r => setTimeout(r, SERVER.delay));
    return SERVER.closeError ? { data: null, error: { message: SERVER.closeError } } : { data: SERVER.closeResult, error: null };
  } };
}
const toasts = [];
const doc = makeDoc();
const ctx = vm.createContext({ console, Map, Set, JSON, Number, String, Date, Math, Promise, Object, Array, RegExp, setTimeout,
  document: doc, location: { hash: "#/restockinquiryclose" }, toast: m => toasts.push(m), closeModal: () => {} });
vm.runInContext(read("./js/erp_ui.js"), ctx);
vm.runInContext(read("./js/restock_inquiry_close.js"), ctx);
const C = ctx.RestockInquiryClose;
const APPROVER = { id: "ap", approver: true }, STAFF = { id: "st", approver: false };
const rpcs = (fn) => calls.filter(c => c[0] === "rpc" && (!fn || c[1] === fn));
async function withConfirm(fn, reason, ans = true) {
  const p = fn();
  for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
  const opened = doc.getElementById("modal-root").innerHTML;
  if (reason !== undefined) doc.getElementById("erp-confirm-reason").value = reason;
  ctx.ErpUi._answer(ans);
  return { res: await p, opened };
}

console.log("=== 1. 순수 함수 ===");
const st = (e, a = true) => C.actionState(e, { isApprover: a });
check([st(ENTRY()).enabled, st(ENTRY(), false).enabled, st(ENTRY({ blockers: ["ACTIVE_CANDIDATE"] })).enabled,
       st(ENTRY({ closure: { closed_at: "2026-09-27T06:00:00Z" } })).enabled, st(ENTRY({ fingerprint: null })).enabled, st({ inquiry: null }).enabled],
      [true, false, false, false, false, false], "[핵심] 버튼: 승인자·막힘 없음·미종료·지문 있음일 때만");
check(st(ENTRY({ blockers: ["ACTIVE_WING_SUBMISSION", "INQUIRY_NOT_ACTIVE:CANCELLED"] })).why.includes("[재입고 WING 복구]"), true, "막힘 사유를 사람이 할 일로 풀어서 표시");
check(C.summary(ENTRY()), { pendingReconfirmations: 1, sentMails: 1, activeItems: 2 }, "요약: 대기 재확인·보낸 메일·열린 줄");
check([C.interpretRpc({ status: "CLOSED", reconfirmations_cancelled: 1, items_cancelled: 2, mails_preserved: 1 }).ok, C.interpretRpc({ status: "ALREADY_CLOSED" }).ok,
       C.interpretRpc({ status: "STALE_STATE" }).ok, C.interpretRpc({ status: "BLOCKED", reasons: ["ACTIVE_CANDIDATE"] }).ok, C.interpretRpc(null, { message: "NOT_APPROVER" }).message,
       C.interpretRpc({ status: "WHAT" }).ok], [true, true, false, false, "NOT_APPROVER", false], "[핵심] 결과 해석: STALE·BLOCKED·오류·모르는 응답은 실패");

console.log("\n=== 2. 화면 · 권한 ===");
resetServer(); calls.length = 0;
const staffHtml = await C.view(fakeSb(), STAFF);
check([calls.length, staffHtml.includes("<button"), staffHtml.includes("공급처 갑")], [0, false, false], "[핵심] 승인 권한자 아니면 rpc 0·버튼 0·데이터 0");
const html = await C.view(fakeSb(), APPROVER);
check([rpcs("fn_preview_restock_inquiry_test_close").length, html.includes("공급처 갑"), html.includes("공급처 을"), html.includes("800EA → 200EA"),
       html.includes("보낸 메일 1통은 기록 그대로"), (html.match(/disabled/g) || []).length, html.includes("[재입고 후보 승인]에서 먼저 거절")],
      [1, true, true, true, true, 1, true], "[핵심] 서버 미리보기 그대로 · 막힌 문의(을)만 버튼 막힘+이유 · 메일 보존 안내");
const mod = read("./js/restock_inquiry_close.js");
check([/리파코|아가드|lipaco|7127d0fe|571f0c1a/i.test(mod), /from\([^)]*\)\.(insert|update|delete|upsert)/.test(mod), /p_(user|actor|approver)_id/.test(mod), /smtp|wing\.coupang/i.test(mod)],
      [false, false, false, false], "[핵심] 공급처·상품·ID 상수 없음 · 표 직접 쓰기 없음 · 사용자 ID 파라미터 없음 · SMTP/WING 호출 없음");

console.log("\n=== 3. [테스트로 종료] ===");
calls.length = 0;
let r = await withConfirm(() => C.close("q1"), "테스트 문의였음 - 대표 지시");
const closeCalls = rpcs("fn_close_restock_inquiry_as_test");
check([r.res.status, closeCalls.length, closeCalls[0] && closeCalls[0][2]], ["DONE", 1, { p_inquiry_id: "q1", p_expected_fingerprint: "fp-1", p_reason: "테스트 문의였음 - 대표 지시" }],
      "[핵심] 종료 rpc 1번(문의 ID·누르기 직전 지문·사유 - 사용자 ID 없음)");
check(calls.findIndex(c => c[1] === "fn_preview_restock_inquiry_test_close" && c[2].p_inquiry_id === "q1") < calls.findIndex(c => c[1] === "fn_close_restock_inquiry_as_test"),
      true, "[핵심] 누르기 직전 이 문의 미리보기를 다시 읽은 뒤 종료");
check([r.opened.includes("보낸 메일은 기록 그대로"), r.opened.includes("정정·사과 메일은 보내지 않아요"), r.opened.includes("800EA → 200EA"), r.opened.includes("되돌리는 버튼은 없어요")],
      [true, true, true, true], "확인창: 메일 보존·공급처 메일 없음·재확인 수량·되돌릴 수 없음");
calls.length = 0; SERVER.one.q1 = ENTRY({ fingerprint: "fp-1b" });
const pShort = C.close("q1");
for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
doc.getElementById("erp-confirm-reason").value = "짧다"; ctx.ErpUi._answer(true); await tick();
check(rpcs("fn_close_restock_inquiry_as_test").length, 0, "사유 5자 미만이면 멈춤(rpc 0)");
doc.getElementById("erp-confirm-reason").value = "지문 새로 받음 확인"; ctx.ErpUi._answer(true); await pShort;
check(rpcs("fn_close_restock_inquiry_as_test")[0][2].p_expected_fingerprint, "fp-1b", "[핵심] 화면에 떠 있던 값이 아니라 누르기 직전 서버 지문을 보냄");
SERVER.one.q1 = ENTRY({ closure: { closed_at: "2026-09-27T06:00:00Z" } }); calls.length = 0;
r = await C.close("q1");
check([r.status, rpcs("fn_close_restock_inquiry_as_test").length], ["STALE", 0], "[핵심] 그 사이 이미 종료됐으면 멈춤(rpc 0)");
SERVER.one.q1 = ENTRY({ blockers: ["RECONFIRM_MAIL_IN_FLIGHT"] }); calls.length = 0;
r = await C.close("q1");
check([r.status, rpcs("fn_close_restock_inquiry_as_test").length], ["STALE", 0], "[핵심] 그 사이 막힘(메일 발송 중)이 생기면 멈춤(rpc 0)");
resetServer(); calls.length = 0; SERVER.delay = 20;
const p1 = C.close("q1"); const second = await C.close("q1");
for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
doc.getElementById("erp-confirm-reason").value = "중복 클릭 시험"; ctx.ErpUi._answer(true); await p1;
check([second.status, rpcs("fn_close_restock_inquiry_as_test").length], ["BUSY", 1], "[핵심] 처리 중 다시 누르면 BUSY - rpc 1번");
SERVER.delay = 0; SERVER.closeResult = { status: "STALE_STATE", fingerprint: "fp-x" }; calls.length = 0;
r = await withConfirm(() => C.close("q1"), "지문 어긋남 시험");
check([r.res.status, r.res.message.includes("아무것도 바꾸지 않았어요"), rpcs("fn_preview_restock_inquiry_test_close").length >= 2], ["FAILED", true, true],
      "[핵심] 서버 STALE_STATE 는 실패로 표시 · 다시 읽음");
SERVER.closeResult = { status: "CLOSED" }; SERVER.closeError = "NOT_APPROVER"; calls.length = 0;
r = await withConfirm(() => C.close("q1"), "오류 표시 시험");
check([r.res.status, r.res.message], ["FAILED", "NOT_APPROVER"], "RPC 오류는 실패로 표시");
SERVER.closeError = null;
await C.view(fakeSb(), STAFF); calls.length = 0;
r = await C.close("q1");
check([r.status, rpcs().length], ["DENIED", 0], "[핵심] 권한 없는 세션은 직접 불러도 DENIED(rpc 0)");
check(calls.filter(c => ["insert", "update", "delete"].includes(c[0])).length, 0, "[핵심] 표 직접 쓰기 0건");

console.log("\n=== 4. 연결 ===");
const app = read("./js/app.js"), index = read("./index.html");
check([/restockinquiryclose: \{ title: "재입고 문의 테스트 종료", render: \(\) => \(globalThis\.RestockInquiryClose \? RestockInquiryClose\.view\(sb, me\)/.test(app),
       index.includes('<script src="js/restock_inquiry_close.js?v=1"></script>'), index.includes('href="#/restockinquiryclose" data-route="restockinquiryclose"'),
       index.indexOf("restock_inquiry_close.js") < index.indexOf("js/app.js"), index.includes("js/app.js?v=146")],
      [true, true, true, true, true], "[핵심] 라우트·스크립트(app.js 앞)·메뉴·app.js?v=146");
console.log(`\n${fails ? "FAIL" : "ALL PASS"} ${passes} / FAIL ${fails}`);
process.exit(fails ? 1 : 0);
