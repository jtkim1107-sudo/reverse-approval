// fixtures_supplier_mail_approval_ui.mjs
// ------------------------------------------------
// 2026-09-28 공급처 메일 발송 승인 화면(js/supplier_mail_approval.js, migration 20260928b) 검증 - 네트워크 0건, 서버는 가짜.
//   1) 순수 함수: 버튼 상태(권한·상태·기한·지문) · 결과 해석(APPROVED/ALREADY/REJECTED/STALE_FINGERPRINT/EXPIRED/BLOCKED/오류)
//   2) 화면: 승인 권한자 아니면 rpc 0·버튼 0·데이터 0 · 미리보기 = 수신자·발신자·제목·본문 전체·첨부파일명·상품/수량/출고일·생성 사유 · 상수 없음
//   3) [발송 승인]: 누르기 직전 초안 다시 읽음 → 확인창(본문 전체) → rpc 1번(초안 ID·그때 지문·메모, 사용자 ID 없음) · 그 사이 바뀌면 rpc 0
//      · STALE_FINGERPRINT 는 실패 · 중복 클릭 BUSY · 권한 없으면 DENIED · 표 직접 쓰기 0
//   4) [거부]: 사유 5자 이상 · rpc 1번 · 5) 연결: 라우트·메뉴·스크립트(app.js 앞)·app.js 버전
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

const BODY = "안녕하세요 공급처 갑 담당자님.\n가상 상품 10박스(200개) 출고 가능일을 알려 주세요.\n<script>alert(1)</script>\n";
const DRAFT = (over = {}) => ({
  id: "d1", status: "PENDING_APPROVAL", mail_kind: "RESTOCK_INQUIRY", source_table: "restock_supplier_inquiries", source_key: "q1",
  supplier_name: "공급처 갑", recipient: "vendor-a@example.com", sender: "ops@naver.example", subject: "[재입고 사전 문의] 가상 상품",
  body_text: BODY, body_sha256: "b".repeat(64), attachments: [{ filename: "입고요청서.pdf", sha256: "c".repeat(64), size: 1234 }],
  message_id: "<ri-prod-x@taltal-app.internal>", in_reply_to: null,
  context: { items: [{ product_name: "가상 상품", quantity: 10, unit: "BOX" }], inbound_date: "2026-10-07", center: "동탄1" },
  reason: "재입고 사전 문의(수량·출고 가능일 문의)", content_fingerprint: "f".repeat(64), expires_at: "2026-10-01T00:00:00Z", expired: false,
  approved_by: null, approved_at: null, created_at: "2026-09-28T01:00:00Z",
  events: [{ from: null, to: "PENDING_APPROVAL", at: "2026-09-28T01:00:00Z", note: "재입고 사전 문의", by_approver: false }], ...over });
const SERVER = {};
function resetServer() {
  SERVER.list = [DRAFT(), DRAFT({ id: "d2", status: "SENT", recipient: "vendor-b@example.com", approved_by: "ap", approved_by_name: "장팀장",
    approved_at: "2026-09-27T02:00:00Z" })];
  SERVER.one = { d1: DRAFT(), d2: SERVER.list[1] };
  SERVER.approveResult = { status: "APPROVED", draft_id: "d1" };
  SERVER.rejectResult = { status: "REJECTED", draft_id: "d1" };
  SERVER.error = null; SERVER.delay = 0;
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
    if (fn === "fn_preview_supplier_mail_drafts") {
      if (args && args.p_draft_id) return { data: { drafts: SERVER.one[args.p_draft_id] ? [JSON.parse(JSON.stringify(SERVER.one[args.p_draft_id]))] : [] }, error: null };
      return { data: { drafts: JSON.parse(JSON.stringify(SERVER.list)) }, error: null };
    }
    if (SERVER.delay) await new Promise(r => setTimeout(r, SERVER.delay));
    if (SERVER.error) return { data: null, error: { message: SERVER.error } };
    return { data: fn === "fn_approve_supplier_mail_draft" ? SERVER.approveResult : SERVER.rejectResult, error: null };
  } };
}
const toasts = [];
const doc = makeDoc();
const ctx = vm.createContext({ console, Map, Set, JSON, Number, String, Date, Math, Promise, Object, Array, RegExp, setTimeout,
  document: doc, location: { hash: "#/suppliermailapproval" }, toast: m => toasts.push(m), closeModal: () => {} });
vm.runInContext(read("./js/erp_ui.js"), ctx);
vm.runInContext(read("./js/supplier_mail_approval.js"), ctx);
const C = ctx.SupplierMailApproval;
const APPROVER = { id: "ap", approver: true }, STAFF = { id: "st", approver: false };
const rpcs = fn => calls.filter(c => c[0] === "rpc" && (!fn || c[1] === fn));
async function withConfirm(fn, reason, ans = true) {
  const p = fn();
  for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
  const opened = doc.getElementById("modal-root").innerHTML;
  if (reason !== undefined) doc.getElementById("erp-confirm-reason").value = reason;
  ctx.ErpUi._answer(ans);
  return { res: await p, opened };
}

console.log("=== 1. 순수 함수 ===");
const st = (d, a = true) => C.actionState(d, { isApprover: a });
check([st(DRAFT()).enabled, st(DRAFT(), false).enabled, st(DRAFT({ status: "APPROVED" })).enabled, st(DRAFT({ expired: true })).enabled,
       st(DRAFT({ content_fingerprint: null })).enabled, st(null).enabled], [true, false, false, false, false, false],
      "[핵심] 승인 버튼: 승인자·승인 대기·기한 안·지문 있음일 때만");
check([C.interpretRpc({ status: "APPROVED" }).ok, C.interpretRpc({ status: "ALREADY_APPROVED" }).ok, C.interpretRpc({ status: "REJECTED" }).ok,
       C.interpretRpc({ status: "STALE_FINGERPRINT" }).ok, C.interpretRpc({ status: "EXPIRED" }).ok, C.interpretRpc({ status: "BLOCKED", reasons: ["NOT_PENDING"] }).ok,
       C.interpretRpc(null, { message: "AUTOMATION_NOT_ALLOWED" }).message, C.interpretRpc({ status: "??" }).ok],
      [true, true, true, false, false, false, "AUTOMATION_NOT_ALLOWED", false], "[핵심] 결과 해석: 지문 불일치·기한·거부됨·오류·모르는 응답은 실패");

console.log("\n=== 2. 화면 · 권한 · 미리보기 ===");
resetServer(); calls.length = 0;
const staffHtml = await C.view(fakeSb(), STAFF);
check([calls.length, staffHtml.includes("<button"), staffHtml.includes("vendor-a")], [0, false, false], "[핵심] 승인 권한자 아니면 rpc 0·버튼 0·데이터 0");
const html = await C.view(fakeSb(), APPROVER);
check([html.includes("vendor-a@example.com"), html.includes("ops@naver.example"), html.includes("[재입고 사전 문의] 가상 상품"),
       html.includes("가상 상품 10박스(200개) 출고 가능일을 알려 주세요."), html.includes("입고요청서.pdf"), html.includes("가상 상품 · 10BOX"),
       html.includes("2026-10-07"), html.includes("재입고 사전 문의(수량·출고 가능일 문의)"), html.includes("&lt;script&gt;"), html.includes("<script>alert")],
      [true, true, true, true, true, true, true, true, true, false], "[핵심] 미리보기 = 수신자·발신자·제목·본문 전체·첨부파일명·상품/수량·출고(입고)일·생성 사유(HTML 이스케이프)");
check([(html.match(/발송 승인<\/button>/g) || []).length, html.includes("발송 완료"), html.includes("장팀장")], [1, true, true],
      "승인 대기만 버튼 · 지난 초안은 상태·승인자 표시");
const mod = read("./js/supplier_mail_approval.js");
check([/리파코|lipaco|hanmail/i.test(mod), /from\([^)]*\)\.(insert|update|delete|upsert)/.test(mod), /p_(user|actor|approver)_id/.test(mod), /smtp|sendmail|nodemailer/i.test(mod.replace(/SMTP 없음|SMTP 0|보내지 않아요/g, ""))],
      [false, false, false, false], "[핵심] 공급처 상수 없음 · 표 직접 쓰기 없음 · 사용자 ID 파라미터 없음 · 메일 발송 코드 없음");

console.log("\n=== 3. [발송 승인] ===");
calls.length = 0;
let r = await withConfirm(() => C.approve("d1"), "문구 확인");
const ap = rpcs("fn_approve_supplier_mail_draft");
check([r.res.status, ap.length, ap[0] && ap[0][2]], ["DONE", 1, { p_draft_id: "d1", p_expected_fingerprint: "f".repeat(64), p_note: "문구 확인" }],
      "[핵심] 승인 rpc 1번(초안 ID·누르기 직전 지문·메모 - 사용자 ID 없음)");
check(calls.findIndex(c => c[1] === "fn_preview_supplier_mail_drafts" && c[2].p_draft_id === "d1") < calls.findIndex(c => c[1] === "fn_approve_supplier_mail_draft"),
      true, "[핵심] 누르기 직전 이 초안을 서버에서 다시 읽은 뒤 승인");
check([r.opened.includes("가상 상품 10박스(200개)"), r.opened.includes("vendor-a@example.com"), r.opened.includes("정확히 1번"), r.opened.includes("승인이 무효")],
      [true, true, true, true], "[핵심] 확인창: 본문 전체·수신자·1회 발송·변경 시 무효 안내");
calls.length = 0; SERVER.one.d1 = DRAFT({ content_fingerprint: "e".repeat(64), body_text: "바뀐 본문" });
r = await withConfirm(() => C.approve("d1"), "");
check([rpcs("fn_approve_supplier_mail_draft")[0][2].p_expected_fingerprint, r.opened.includes("바뀐 본문")], ["e".repeat(64), true],
      "[핵심] 화면에 떠 있던 값이 아니라 누르기 직전 서버 내용·지문으로 승인(확인창에 새 본문)");
SERVER.one.d1 = DRAFT({ status: "INVALIDATED" }); calls.length = 0;
r = await C.approve("d1");
check([r.status, rpcs("fn_approve_supplier_mail_draft").length], ["STALE", 0], "[핵심] 그 사이 무효·승인·만료되면 멈춤(rpc 0)");
resetServer(); SERVER.approveResult = { status: "STALE_FINGERPRINT", draft_id: "d1" }; calls.length = 0;
r = await withConfirm(() => C.approve("d1"), "");
check([r.res.status, r.res.message.includes("승인하지 않았어요")], ["FAILED", true], "[핵심] 서버 STALE_FINGERPRINT 는 실패 표시");
resetServer(); SERVER.delay = 20; calls.length = 0;
const p1 = C.approve("d1"); const second = await C.approve("d1");
for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
ctx.ErpUi._answer(true); await p1;
check([second.status, rpcs("fn_approve_supplier_mail_draft").length], ["BUSY", 1], "[핵심] 처리 중 다시 누르면 BUSY - rpc 1번");
SERVER.delay = 0; SERVER.error = "NOT_APPROVER"; calls.length = 0;
r = await withConfirm(() => C.approve("d1"), "");
check([r.res.status, r.res.message], ["FAILED", "NOT_APPROVER"], "서버 권한 거부는 실패 표시");
SERVER.error = null;
await C.view(fakeSb(), STAFF); calls.length = 0;
r = await C.approve("d1");
check([r.status, rpcs().length], ["DENIED", 0], "[핵심] 권한 없는 세션은 직접 불러도 DENIED(rpc 0)");

console.log("\n=== 4. [거부] ===");
resetServer(); await C.view(fakeSb(), APPROVER); calls.length = 0;
const pShort = C.reject("d1");
for (let i = 0; i < 50; i++) { await tick(); if (doc.els.has("erp-confirm-go")) break; }
doc.getElementById("erp-confirm-reason").value = "짧다"; ctx.ErpUi._answer(true); await tick();
check(rpcs("fn_reject_supplier_mail_draft").length, 0, "거부 사유 5자 미만이면 멈춤(rpc 0)");
doc.getElementById("erp-confirm-reason").value = "수량 문구 수정 필요"; ctx.ErpUi._answer(true); r = { res: await pShort };
check([r.res.status, rpcs("fn_reject_supplier_mail_draft")[0][2]], ["DONE", { p_draft_id: "d1", p_note: "수량 문구 수정 필요" }], "[핵심] 거부 rpc 1번(초안 ID·사유)");
check(calls.filter(c => ["insert", "update", "delete"].includes(c[0])).length, 0, "[핵심] 표 직접 쓰기 0건");

console.log("\n=== 5. 연결 ===");
const app = read("./js/app.js"), index = read("./index.html");
check([/suppliermailapproval: \{ title: "공급처 메일 발송 승인", render: \(\) => \(globalThis\.SupplierMailApproval \? SupplierMailApproval\.view\(sb, me\)/.test(app),
       index.includes('<script src="js/supplier_mail_approval.js?v=1"></script>'), index.includes('href="#/suppliermailapproval" data-route="suppliermailapproval"'),
       index.indexOf("supplier_mail_approval.js") < index.indexOf("js/app.js"), /js\/app\.js\?v=(15[1-9]|1[6-9]\d)\b/.test(index)],
      [true, true, true, true, true], "[핵심] 라우트·메뉴·스크립트(app.js 앞)·app.js?v=151 이상");
console.log(`\n${fails ? "FAIL" : "ALL PASS"} ${passes} / FAIL ${fails}`);
process.exit(fails ? 1 : 0);
