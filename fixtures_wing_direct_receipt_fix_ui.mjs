// fixtures_wing_direct_receipt_fix_ui.mjs
// ------------------------------------------------
// 2026-09-27 WING 직접입고 최종수량 정정 화면(js/wing_direct_receipt_fix.js) 검증 - 네트워크 0건.
// 가짜 서버는 Rebirth-ops PR #85(20260927e) RPC 규칙을 그대로 흉내 냄: 승인자만 · 미러 지문 CAS · 요청 키 멱등(같은 내용=ALREADY,
// 다른 내용=오류) · 한 SKU 라도 막히면 전부 안 씀 · 이미 활성 확정/조정이면 막음.
// 입고 1096696429834932224 · 발주 리버스-발주-2026-010 · 대표 확정 011-01=24 011-02=24 012-01=24 012-02=24 013-01=48 013-02=24
//   1) 순수 함수: 수량 검사 · 계획(차이·확정 상태·발주 조정·VAT 별도 금액 -108,000) · 문의메일 후보 가능성
//   2) 화면: 승인자 아니면 조회 0·버튼 0 · 미리보기 표 · 메일 경고 · 입력 전엔 실행 버튼 막힘
//   3) 확정 실행: 6개 적용 · 탭 2개(같은 내용) 두 번째 = 이미 적용 · 한 SKU drift = 전부 안 씀(SKU 별 표시) · 세션 만료 · 중복 클릭 BUSY · 권한 없음 DENIED
//   4) 조정 실행: 확정 뒤에만 · 6개 적용 · 재실행 = 이미 적용 · 부분 실패(한 품목 원본 drift) = 전부 안 씀
//   5) 표 직접 쓰기 0 · SMTP/WING 호출 코드 없음 · 연결(라우트·메뉴·스크립트·app.js 버전)
import { readFileSync } from "fs";
import vm from "vm";
import { webcrypto } from "crypto";

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

const SHIP = "1096696429834932224", PO = "리버스-발주-2026-010";
const SKUS = [["1M1D-011-01", "95981694043", 24, 0, null, 4000, 24], ["1M1D-011-02", "95981694047", 24, 0, null, 4500, 24],
              ["1M1D-012-01", "95981694046", 48, 24, 24, 4000, 48], ["1M1D-012-02", "95981694045", 48, 24, 24, 4500, 48],
              ["1M1D-013-01", "95981694044", 24, 0, null, 4000, 24], ["1M1D-013-02", "95981694042", 24, 24, 24, 4500, 24]];
const FINAL = { "95981694043": 24, "95981694047": 24, "95981694046": 24, "95981694045": 24, "95981694044": 48, "95981694042": 24 };

// ── 가짜 서버(20260927e 규칙) ──
const SV = {};
function resetServer() {
  SV.mirror = Object.fromEntries(SKUS.map(([code, vid, req, rcv, stow]) => [vid, { vid, code, pid: "p-" + code, req, rcv, stow, fp: "fp-" + vid + "-0" }]));
  SV.poi = Object.fromEntries(SKUS.map(([code, vid, , , , cost, prcv]) => ["poi-" + vid, { id: "poi-" + vid, pid: "p-" + code, qty: prcv, received_qty: prcv, unit_cost: cost }]));
  SV.conf = {}; SV.adj = {}; SV.batches = {}; SV.adjKeys = {}; SV.decisions = SKUS.map(([code]) => ({ product_id: "p-" + code, decision: "DATA_CHECK",
    logistics_status: "INCOMPLETE", automation_blocked: true, automation_label: "발주정보 없음", auto_po_allowed: false }));
  SV.procurements = []; SV.errorNext = null; SV.delay = 0; SV.approvers = new Set(["ap"]);
}
const calls = [];
function fakeSb(user) {
  const builder = t => {
    const b = { _f: [], select() { calls.push(["select", t]); return b; }, in(c, v) { b._f.push([c, v]); return b; }, eq() { return b; },
      insert() { calls.push(["insert", t]); return b; }, update() { calls.push(["update", t]); return b; }, delete() { calls.push(["delete", t]); return b; },
      then(res) { return Promise.resolve({ data: t === "product_procurement" ? SV.procurements : [], error: null }).then(res); } };
    return b;
  };
  const rpc = async (fn, a) => {
    calls.push(["rpc", fn, JSON.parse(JSON.stringify(a))]);
    if (SV.delay) await new Promise(r => setTimeout(r, SV.delay));
    if (SV.errorNext) { const e = SV.errorNext; SV.errorNext = null; return { data: null, error: { message: e } }; }
    if (!SV.approvers.has(user)) return { data: null, error: { message: "NOT_APPROVER 입고수량 확정·조정은 승인 권한자 본인만" } };
    if (fn === "fn_preview_wing_direct_receipts") {
      const po = a.p_po_no === PO ? { id: "po10", po_no: PO, status: "done" } : null;
      return { data: { wing_inbound_id: a.p_wing_inbound_id, po, candidate_po_nos: [PO], read_at: "2026-09-27T08:00:00Z",
        rows: Object.values(SV.mirror).map(m => { const c = SV.conf[m.vid]; const pi = SV.poi["poi-" + m.vid]; const aj = SV.adj[pi.id];
          return { vendor_item_id: m.vid, product_id: m.pid, product_code: m.code, product_name: "원형의자발커버", requested_qty: m.req, received_qty: m.rcv,
            stowed_qty: m.stow, wing_status: "STOWING", source_checked_at: "2026-09-17T22:41:51Z", fingerprint: m.fp,
            active_confirmation: c ? { id: c.id, batch_id: c.batch, confirmed_received_qty: c.qty, fingerprint_matches: c.fp === m.fp } : null,
            po_items: po ? [{ id: pi.id, qty: pi.qty, received_qty: pi.received_qty, unit_cost: pi.unit_cost,
              active_adjustment: aj ? { id: aj.id, adjusted_received_qty: aj.adjusted } : null }] : [] }; }) }, error: null };
    }
    if (fn === "fn_confirm_wing_direct_receipts") {
      const hash = JSON.stringify([a.p_items.map(i => [i.vendor_item_id, i.expected_fingerprint, i.confirmed_received_qty]).sort(), a.p_reason]);
      const ex = SV.batches[a.p_idempotency_key];
      if (ex) return ex.hash === hash ? { data: { status: "ALREADY_CONFIRMED", batch_id: ex.id }, error: null }
                                      : { data: null, error: { message: "IDEMPOTENCY_PAYLOAD_MISMATCH" } };
      const blockers = [];
      for (const it of a.p_items) {
        const m = SV.mirror[it.vendor_item_id];
        if (!m) blockers.push({ vendor_item_id: it.vendor_item_id, reason: "MIRROR_ROW_NOT_FOUND" });
        else if (m.fp !== it.expected_fingerprint) blockers.push({ vendor_item_id: it.vendor_item_id, reason: "MIRROR_DRIFT" });
        else if (SV.conf[it.vendor_item_id]) blockers.push({ vendor_item_id: it.vendor_item_id, reason: "ALREADY_ACTIVE_CONFIRMATION" });
      }
      if (blockers.length) return { data: { status: "BLOCKED", blockers }, error: null };
      const id = "batch-" + (Object.keys(SV.batches).length + 1);
      SV.batches[a.p_idempotency_key] = { id, hash };
      const items = a.p_items.map(it => { SV.conf[it.vendor_item_id] = { id: "conf-" + it.vendor_item_id, batch: id, qty: it.confirmed_received_qty, fp: SV.mirror[it.vendor_item_id].fp };
        return { vendor_item_id: it.vendor_item_id, confirmation_id: "conf-" + it.vendor_item_id, confirmed_received_qty: it.confirmed_received_qty }; });
      return { data: { status: "CONFIRMED", batch_id: id, items }, error: null };
    }
    if (fn === "fn_record_po_receipt_adjustments") {
      if (SV.adjKeys[a.p_idempotency_key]) return { data: { status: "ALREADY_RECORDED" }, error: null };
      const blockers = [];
      for (const it of a.p_items) {
        const pi = SV.poi[it.po_item_id];
        if (!pi) blockers.push({ po_item_id: it.po_item_id, reason: "PO_ITEM_NOT_IN_PO" });
        else if (pi.received_qty !== it.expected_original_received_qty) blockers.push({ po_item_id: it.po_item_id, reason: "ORIGINAL_DRIFT" });
        else if (SV.adj[pi.id]) blockers.push({ po_item_id: pi.id, reason: "ALREADY_ACTIVE_ADJUSTMENT" });
      }
      if (blockers.length) return { data: { status: "BLOCKED", blockers }, error: null };
      SV.adjKeys[a.p_idempotency_key] = true;
      let total = 0;
      const items = a.p_items.map(it => { const pi = SV.poi[it.po_item_id]; const vid = it.po_item_id.slice(4); const adjusted = SV.conf[vid].qty;
        const d = (adjusted - pi.received_qty) * pi.unit_cost; total += d; SV.adj[pi.id] = { id: "adj-" + vid, adjusted };
        return { po_item_id: pi.id, original: pi.received_qty, adjusted, amount_delta: d }; });
      return { data: { status: "RECORDED", items, amount_delta_total: total }, error: null };
    }
    return { data: null, error: { message: "unknown rpc" } };
  };
  return { from: builder, rpc };
}

const toasts = [];
function makeCtx(user) {
  const doc = makeDoc();
  const ctx = vm.createContext({ console, Map, Set, JSON, Number, String, Date, Math, Promise, Object, Array, RegExp, setTimeout, TextEncoder, Uint8Array,
    crypto: webcrypto, document: doc, location: { hash: `#/wingreceiptfix?id=${SHIP}&po=${encodeURIComponent(PO)}` }, toast: m => toasts.push(m), closeModal: () => {},
    fetchInventoryDecisions: async () => ({ ok: true, decisions: SV.decisions }) });
  vm.runInContext(read("./js/erp_ui.js"), ctx);
  vm.runInContext(read("./js/wing_direct_receipt_fix.js"), ctx);
  return { ctx, doc, W: ctx.WingReceiptFix, sb: fakeSb(user), me: { id: user, approver: user === "ap" } };
}
async function withConfirm(t, fn, reason, ans = true) {
  const p = fn();
  for (let i = 0; i < 80; i++) { await tick(); if (t.doc.els.has("erp-confirm-go")) break; }
  const opened = t.doc.getElementById("modal-root").innerHTML;
  if (reason !== undefined) t.doc.getElementById("erp-confirm-reason").value = reason;
  t.ctx.ErpUi._answer(ans);
  return { res: await p, opened };
}
const rpcs = fn => calls.filter(c => c[0] === "rpc" && (!fn || c[1] === fn));
const fill = t => { for (const [vid, q] of Object.entries(FINAL)) t.W._state.inputs[vid] = String(q); };
const REASON = "대표 확인 - WING 판매개시·과착 회송 화면과 공급처 출고 수량 기준";

console.log("=== 1. 순수 함수 ===");
resetServer();
let t = makeCtx("ap");
check([t.W.parseQty("48").value, t.W.parseQty("").error, t.W.parseQty("-1").error, t.W.parseQty("2.5").error, t.W.parseQty("1,000").value],
      [48, "확정 수량을 넣어 주세요", "0 이상 정수만", "0 이상 정수만", 1000], "수량 검사: 빈칸·음수·소수 거부, 쉼표 허용");
await t.W.view(t.sb, t.me);
fill(t);
const plan = t.W.buildPlan(t.W._state.preview, t.W._state.inputs);
check(plan.rows.map(r => [r.vid, r.mirrorReceived, r.qty, r.diff, r.poOriginal, r.poAdjusted, r.amountDelta]),
      SKUS.map(([, vid, , rcv, , cost, prcv]) => [vid, rcv, FINAL[vid], FINAL[vid] - rcv, prcv, FINAL[vid], (FINAL[vid] - prcv) * cost]),
      "[핵심] SKU 별 원본 WING 입고 · 확정 · 차이 · 발주 원본→조정 · 금액 영향");
check(plan.amountTotal, -108000, "[핵심] VAT 별도 금액 영향 합계 -108,000원");
check([t.W.confirmItems(plan).items.length, t.W.adjustItems(plan).why.startsWith("확정 기록이 먼저")], [6, true], "확정 6개 준비 · 조정은 확정 먼저");
check([t.W.mailCheck(SV.decisions[0], null).possible, t.W.mailCheck(null, null).possible,
       t.W.mailCheck({ decision: "ORDER_NOW", logistics_status: "COMPLETE", automation_blocked: false, auto_po_allowed: true }, { supplier_name: "공급처" }).possible],
      [false, null, true], "[핵심] 문의메일 후보 가능성: 필수 조건 하나라도 아니면 불가 · 판단 행 없으면 판단 불가 · 모두 충족이면 가능");
const OKD = { decision: "ORDER_NOW", logistics_status: "COMPLETE", automation_blocked: false, auto_po_allowed: true }, OKP = { supplier_name: "공급처" };
check([t.W.mailCheck({ ...OKD, automation_blocked: true }, OKP).possible, t.W.mailCheck({ ...OKD, logistics_status: "INCOMPLETE" }, OKP).possible,
       t.W.mailCheck({ ...OKD, auto_po_allowed: false }, OKP).possible, t.W.mailCheck({ ...OKD, decision: "OK" }, OKP).possible, t.W.mailCheck(OKD, { supplier_name: " " }).possible],
      [false, false, false, false, false], "[핵심] 필수 조건 하나씩만 어긋나도 후보 불가(막힘·물류·자동 발주·지금 발주·공급처)");
const k1 = await t.W.idemKey("wdr", SHIP, { items: [{ a: 1 }], reason: "x" }), k2 = await t.W.idemKey("wdr", SHIP, { items: [{ a: 1 }], reason: "x" });
check([k1 === k2, /^[A-Za-z0-9:_.-]{8,120}$/.test(k1), k1 !== await t.W.idemKey("wdr", SHIP, { items: [{ a: 2 }], reason: "x" })], [true, true, true],
      "[핵심] 요청 키 = 내용 지문(같은 내용 같은 키, 서버 키 형식)");

console.log("\n=== 2. 화면 · 권한 ===");
resetServer(); calls.length = 0;
const staff = makeCtx("st");
const staffHtml = await staff.W.view(staff.sb, staff.me);
check([calls.length, staffHtml.includes("<button"), staffHtml.includes("95981694043")], [0, false, false], "[핵심] 승인 권한자 아니면 조회 0·버튼 0·데이터 0");
t = makeCtx("ap");
let html = await t.W.view(t.sb, t.me);
check([html.includes("95981694043"), html.includes("리버스-발주-2026-010"), html.includes("실행 직후 공급처 메일이 나갈 수 있어요"),
       html.includes("후보 불가"), (html.match(/data-erp-key="wrf-confirm" disabled/g) || []).length],
      [true, true, true, true, 1], "[핵심] 미리보기 표 · 발주 · 메일 경고 · 후보 불가 표시 · 확정 수량 입력 전엔 실행 막힘");
check(rpcs().every(c => c[1] === "fn_preview_wing_direct_receipts"), true, "화면 진입은 읽기 RPC 만");
const mod = read("./js/wing_direct_receipt_fix.js");
check([/1096696429834932224|리버스-발주-2026-010|1M1D-0/.test(mod), /from\([^)]*\)\.(insert|update|delete|upsert)/.test(mod), /\bfetch\(|XMLHttpRequest|sendMail|smtp_send|wing\.coupang/i.test(mod), /p_(user|actor|approver)_id/.test(mod)],
      [false, false, false, false], "[핵심] 입고·발주·상품 상수 없음 · 표 직접 쓰기 없음 · SMTP/WING 호출 없음 · 사용자 ID 파라미터 없음");

console.log("\n=== 3. 확정 실행 ===");
fill(t); calls.length = 0;
let r = await withConfirm(t, () => t.W.confirm(), REASON);
check([r.res.status, rpcs("fn_confirm_wing_direct_receipts").length, Object.keys(SV.conf).length], ["DONE", 1, 6], "[핵심] 6개 확정 적용(RPC 1번)");
const sent = rpcs("fn_confirm_wing_direct_receipts")[0][2];
check([sent.p_wing_inbound_id, sent.p_items.map(i => [i.vendor_item_id, i.confirmed_received_qty, i.expected_fingerprint]).sort()],
      [SHIP, Object.entries(FINAL).map(([v, q]) => [v, q, "fp-" + v + "-0"]).sort()], "[핵심] 보낸 값: 입고ID·SKU·확정값·미리보기 지문(사용자 ID 없음)");
check([r.opened.includes("확정 <b>48</b>"), r.opened.includes("원본 WING 기록은 바꾸지 않고")], [true, true], "확인창: 원본→확정·원본 보존 안내");
check(Object.values(t.W._state.lastConfirm).map(x => x.state), Array(6).fill("APPLIED"), "[핵심] 결과: SKU 별 '적용' + 확정 ID");
html = await t.W.view(t.sb, t.me);
check([html.includes("확정됨 48"), (html.match(/data-erp-key="wrf-adjust" disabled/g) || []).length], [true, 0], "새로고침 뒤 확정됨 표시 · 조정 버튼 열림");
// 탭 2개: 두 번째 탭이 같은 내용(같은 키)을 확정 전 미리보기로 보냄 → 이미 적용
resetServer(); calls.length = 0;
const tabA = makeCtx("ap"), tabB = makeCtx("ap");
await tabA.W.view(tabA.sb, tabA.me); await tabB.W.view(tabB.sb, tabB.me); fill(tabA); fill(tabB);
const pa = withConfirm(tabA, () => tabA.W.confirm(), REASON);
r = await pa;
// 탭 B 는 확정 전 화면(미리보기 재조회 없이) - 서버 쪽 규칙 확인을 위해 같은 키·같은 내용을 직접 보냄
const planB = tabB.W.buildPlan(tabB.W._state.preview, tabB.W._state.inputs);
const itemsB = tabB.W.confirmItems(planB).items;
const keyB = await tabB.W.idemKey("wdr", SHIP, { items: itemsB, reason: REASON });
const rb = await tabB.sb.rpc("fn_confirm_wing_direct_receipts", { p_wing_inbound_id: SHIP, p_items: itemsB, p_reason: REASON, p_idempotency_key: keyB });
check([r.res.status, rb.data.status, Object.keys(SV.batches).length], ["DONE", "ALREADY_CONFIRMED", 1], "[핵심] 탭 2개 같은 내용 → 두 번째는 '이미 적용'(서버 묶음 1개)");
check(tabB.W.interpretResult("confirm", itemsB.map(i => i.vendor_item_id), rb.data, null).perKey["95981694044"].state, "ALREADY", "탭 B 결과 SKU 별 '이미 적용'");
// 탭 B 가 다시 누르면 재조회로 이미 확정됨을 알아서 막음(RPC 0)
calls.length = 0;
r = await tabB.W.confirm();
check([r.status, rpcs("fn_confirm_wing_direct_receipts").length], ["STALE", 0], "[핵심] 탭 B 에서 다시 누르면 재조회로 '새로 확정할 SKU 없음' (RPC 0)");
// 한 SKU drift → 전부 안 씀
resetServer(); calls.length = 0;
t = makeCtx("ap"); await t.W.view(t.sb, t.me); fill(t);
const origRpc = t.sb.rpc;
t.sb.rpc = async (fn, a) => { if (fn === "fn_confirm_wing_direct_receipts") SV.mirror["95981694046"].fp = "fp-changed"; return origRpc(fn, a); };
r = await withConfirm(t, () => t.W.confirm(), REASON);
const per = t.W._state.lastConfirm;
check([r.res.status, Object.keys(SV.conf).length, per["95981694046"].state, per["95981694043"].state], ["FAILED", 0, "DRIFT", "FAILED"],
      "[핵심] 실행 순간 한 SKU WING 값 변경 → 전부 안 씀 · 그 SKU 'drift', 나머지 '적용 안 됨(부분 적용 없음)'");
t.sb.rpc = origRpc;
// 이미 다른 값 확정된 SKU 가 있으면 화면이 막음
SV.conf["95981694044"] = { id: "c-x", batch: "b-x", qty: 24, fp: SV.mirror["95981694044"].fp };
calls.length = 0;
r = await t.W.confirm();
check([r.status, rpcs("fn_confirm_wing_direct_receipts").length, String(r.message).includes("95981694044")], ["STALE", 0, true], "[핵심] 이미 다른 값 확정(충돌) SKU 있으면 실행 막힘(RPC 0)");
// 세션 만료
resetServer(); t = makeCtx("ap"); await t.W.view(t.sb, t.me); fill(t);
const orig2 = t.sb.rpc;
t.sb.rpc = async (fn, a) => fn === "fn_confirm_wing_direct_receipts" ? { data: null, error: { message: "JWT expired" } } : orig2(fn, a);
r = await withConfirm(t, () => t.W.confirm(), REASON);
check([r.res.status, t.W._state.lastConfirm["95981694043"].text.includes("세션이 만료"), Object.keys(SV.conf).length], ["FAILED", true, 0],
      "[핵심] 세션 만료 → 실패 표시(다시 로그인 안내)·기록 0");
t.sb.rpc = orig2;
// 중복 클릭
resetServer(); t = makeCtx("ap"); await t.W.view(t.sb, t.me); fill(t); SV.delay = 20; calls.length = 0;
const p1 = withConfirm(t, () => t.W.confirm(), REASON);
await tick();
const second = await t.W.confirm();
r = await p1; SV.delay = 0;
check([second.status, rpcs("fn_confirm_wing_direct_receipts").length], ["BUSY", 1], "[핵심] 처리 중 다시 누르면 BUSY - RPC 1번");
// 권한 없는 세션이 직접 호출
const st2 = makeCtx("st"); await st2.W.view(st2.sb, st2.me); calls.length = 0;
r = await st2.W.confirm();
check([r.status, rpcs().length], ["DENIED", 0], "[핵심] 권한 없는 세션은 직접 불러도 DENIED(RPC 0)");
// 사유 5자 미만
resetServer(); t = makeCtx("ap"); await t.W.view(t.sb, t.me); fill(t); calls.length = 0;
const ps = t.W.confirm();
for (let i = 0; i < 80; i++) { await tick(); if (t.doc.els.has("erp-confirm-go")) break; }
t.doc.getElementById("erp-confirm-reason").value = "짧다"; t.ctx.ErpUi._answer(true); await tick();
check(rpcs("fn_confirm_wing_direct_receipts").length, 0, "사유 5자 미만이면 멈춤");
t.doc.getElementById("erp-confirm-reason").value = REASON; t.ctx.ErpUi._answer(true); await ps;

console.log("\n=== 4. 발주 조정 실행 ===");
calls.length = 0;
r = await withConfirm(t, () => t.W.adjust(), "WING 확정 기준 발주 입고수량 조정 - 청구 대조 전");
const adjSent = rpcs("fn_record_po_receipt_adjustments")[0][2];
check([r.res.status, adjSent.p_po_no, adjSent.p_items.length, Object.keys(SV.adj).length], ["DONE", PO, 6, 6], "[핵심] 확정 뒤 6개 조정 적용");
check(adjSent.p_items.map(i => [i.po_item_id, i.expected_original_received_qty]).sort(), SKUS.map(([, vid, , , , , prcv]) => ["poi-" + vid, prcv]).sort(),
      "[핵심] 보낸 값: 발주 품목·원본 입고수량(서버 CAS)");
check([r.opened.includes("-108,000원"), Object.values(t.W._state.lastAdjust).map(x => x.state)], [true, Array(6).fill("APPLIED")], "확인창 금액 합계 · 결과 SKU 별 적용");
calls.length = 0;
r = await t.W.adjust();
check([r.status, rpcs("fn_record_po_receipt_adjustments").length], ["STALE", 0], "다시 누르면 '새로 조정할 품목 없음'(RPC 0)");
// 부분 실패: 한 품목 원본이 그 사이 바뀜
resetServer(); t = makeCtx("ap"); await t.W.view(t.sb, t.me); fill(t);
await withConfirm(t, () => t.W.confirm(), REASON);
const orig3 = t.sb.rpc;
t.sb.rpc = async (fn, a) => { if (fn === "fn_record_po_receipt_adjustments") SV.poi["poi-95981694045"].received_qty = 47; return orig3(fn, a); };
r = await withConfirm(t, () => t.W.adjust(), "WING 확정 기준 발주 입고수량 조정 - 청구 대조 전");
check([r.res.status, Object.keys(SV.adj).length, t.W._state.lastAdjust["poi-95981694045"].text.includes("ORIGINAL_DRIFT"), t.W._state.lastAdjust["poi-95981694043"].state],
      ["FAILED", 0, true, "FAILED"], "[핵심] 한 품목 원본 drift → 조정 전부 안 씀(부분 실패 없음) · 품목 별 표시");
t.sb.rpc = orig3;
check(calls.filter(c => ["insert", "update", "delete"].includes(c[0])).length, 0, "[핵심] 표 직접 쓰기 0건");

console.log("\n=== 5. 연결 ===");
const app = read("./js/app.js"), index = read("./index.html");
check([/wingreceiptfix: \{ title: "WING 직접입고 최종수량 정정", render: \(\) => \(globalThis\.WingReceiptFix \? WingReceiptFix\.view\(sb, me\)/.test(app),
       index.includes('<script src="js/wing_direct_receipt_fix.js?v=1"></script>'), index.includes('href="#/wingreceiptfix" data-route="wingreceiptfix"'),
       index.indexOf("wing_direct_receipt_fix.js") < index.indexOf("js/app.js"), index.includes("js/app.js?v=147")],
      [true, true, true, true, true], "[핵심] 라우트·스크립트(app.js 앞)·메뉴·app.js?v=147");
console.log(`\n${fails ? "FAIL" : "ALL PASS"} ${passes} / FAIL ${fails}`);
process.exit(fails ? 1 : 0);
