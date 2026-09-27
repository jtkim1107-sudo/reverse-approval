// fixtures_wing_direct_receipt_fix_ui.mjs
// ------------------------------------------------
// 2026-09-27 WING 직접입고 최종수량 정정 화면(js/wing_direct_receipt_fix.js) 검증 - 네트워크 0건.
// 가짜 서버는 Rebirth-ops PR #85(20260927e) RPC 규칙을 그대로 흉내 냄: 승인자만 · 미러 지문 CAS · 요청 키 멱등(같은 내용=ALREADY,
// 다른 내용=오류) · 한 SKU 라도 막히면 전부 안 씀 · 이미 활성 확정/조정이면 막음.
// 입고 1096696429834932224 · 발주 리버스-발주-2026-010 · 대표 확정 011-01=24 011-02=24 012-01=24 012-02=24 013-01=48 013-02=24
//   1) 순수 함수: 수량 검사 · 계획(차이·확정 상태·발주 조정·VAT 별도 금액 -108,000) · 문의메일 스냅샷 게이트·보류 해제 조건 · 되돌리기 대상
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
  SV.snapshots = [snap(0, Date.now() - 5 * 60000, Date.now() - 60 * 60000)]; SV.holds = []; SV.revokeKeys = {}; SV.releases = [];
}
const calls = [];
function snap(n, computedMs, cacheMs, gate = null) {
  return { id: "snap-" + Math.random().toString(16).slice(2, 8), source: "MAIL_STAGE", computed_at: new Date(computedMs).toISOString(),
           cache_calculated_at: new Date(cacheMs).toISOString(), gate, gate_reason: gate ? "x" : null, candidate_count: n, blocked_count: 13,
           candidates: Array.from({ length: n }, (_, i) => ({ product_id: "px" + i, product_code: "ZZ-" + i, supplier_name: "리파코 주식회사", recommended_order_qty_ea: 20 })),
           candidates_fp: "fp" + n };
}
function addHold(kind) { const h = { id: "hold-" + (SV.holds.length + 1), source_kind: kind, reason: kind + " 보류", created_at: new Date().toISOString(), status: "ACTIVE" }; SV.holds.push(h); return h.id; }
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
    if (fn === "fn_preview_restock_inquiry_mail_state") {
      return { data: { active_holds: SV.holds.filter(h => h.status === "ACTIVE"), snapshots: [...SV.snapshots].reverse().slice(0, 5) }, error: null };
    }
    if (fn === "fn_release_restock_inquiry_mail_hold") {
      const h = SV.holds.find(x => x.id === a.p_hold_id);
      if (!h) return { data: { status: "BLOCKED", reason: "HOLD_NOT_FOUND" }, error: null };
      if (h.status === "RELEASED") return { data: { status: "ALREADY_RELEASED" }, error: null };
      const sn = SV.snapshots.find(x => x.id === a.p_snapshot_id), latest = SV.snapshots[SV.snapshots.length - 1];
      if (!sn) return { data: { status: "BLOCKED", reason: "SNAPSHOT_NOT_FOUND" }, error: null };
      if (sn.gate) return { data: { status: "BLOCKED", reason: "SNAPSHOT_GATE_BLOCKED" }, error: null };
      if (!(sn.computed_at > h.created_at && sn.cache_calculated_at > h.created_at)) return { data: { status: "BLOCKED", reason: "SNAPSHOT_NOT_AFTER_HOLD" }, error: null };
      if (sn !== latest) return { data: { status: "BLOCKED", reason: "SNAPSHOT_NOT_LATEST" }, error: null };
      if (sn.candidate_count > 0 && a.p_acknowledged_candidates_fp !== sn.candidates_fp) return { data: { status: "BLOCKED", reason: "CANDIDATES_NOT_ACKNOWLEDGED" }, error: null };
      h.status = "RELEASED"; SV.releases.push([h.id, sn.id, a.p_acknowledged_candidates_fp]);
      return { data: { status: "RELEASED", hold_id: h.id, snapshot_id: sn.id }, error: null };
    }
    if (fn === "fn_revoke_po_receipt_adjustments" || fn === "fn_revoke_wing_direct_receipt_confirmations") {
      const adj = fn === "fn_revoke_po_receipt_adjustments";
      const hash = JSON.stringify([fn, a.p_items.map(i => [i.id, i.expected_qty]).sort(), a.p_reason]);
      const ex = SV.revokeKeys[a.p_idempotency_key];
      if (ex) return ex.hash === hash ? { data: { status: "ALREADY_REVOKED", revocation_batch_id: ex.id }, error: null } : { data: null, error: { message: "IDEMPOTENCY_PAYLOAD_MISMATCH" } };
      const findRec = id => adj ? Object.entries(SV.adj).find(([, v]) => v.id === id) : Object.entries(SV.conf).find(([, v]) => v.id === id);
      const blockers = [];
      for (const it of a.p_items) {
        const f = findRec(it.id);
        if (!f) { blockers.push({ id: it.id, reason: "ALREADY_REVOKED" }); continue; }
        const [k, v] = f;
        if ((adj ? v.adjusted : v.qty) !== it.expected_qty) blockers.push({ id: it.id, reason: "VALUE_DRIFT" });
        else if (!adj && SV.adj["poi-" + k]) blockers.push({ id: it.id, reason: "ACTIVE_PO_ADJUSTMENT_EXISTS" });
      }
      if (blockers.length) return { data: { status: "BLOCKED", blockers }, error: null };
      const id = "rv-" + (Object.keys(SV.revokeKeys).length + 1);
      SV.revokeKeys[a.p_idempotency_key] = { id, hash };
      for (const it of a.p_items) { const [k] = findRec(it.id); delete (adj ? SV.adj : SV.conf)[k]; }
      return { data: { status: "REVOKED", revocation_batch_id: id, inquiry_mail_hold_id: addHold("REVOCATION"), items: a.p_items.map(i => ({ id: i.id })) }, error: null };
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
      return { data: { status: "CONFIRMED", batch_id: id, items, inquiry_mail_hold_id: addHold("CONFIRMATION") }, error: null };
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
      return { data: { status: "RECORDED", items, amount_delta_total: total, inquiry_mail_hold_id: addHold("PO_ADJUSTMENT") }, error: null };
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
  t.doc.els.delete("erp-confirm-go");
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
const NOW = Date.now();
check([t.W.mailGate({ snapshots: [snap(0, NOW + 60000, NOW)] }, NOW).ok, t.W.mailGate({ snapshots: [snap(0, NOW + 10 * 60000, NOW)] }, NOW).ok], [true, false],
      "PC 시계가 서버보다 조금 늦어도(1분) 통과 · 10분 미래 시각은 거부");
check([t.W.mailGate(null, NOW).ok, t.W.mailGate({ snapshots: [] }, NOW).ok, t.W.mailGate({ snapshots: [snap(0, NOW - 40 * 60000, NOW - 50 * 60000)] }, NOW).ok,
       t.W.mailGate({ snapshots: [snap(0, NOW - 5 * 60000, NOW, "C_CACHE")] }, NOW).ok, t.W.mailGate({ snapshots: [snap(2, NOW - 5 * 60000, NOW)] }, NOW).ok],
      [false, false, false, false, true], "[핵심] 실행 전 문의메일 게이트: 상태 없음·스냅샷 없음·30분 넘음·게이트 막힘 → 실행 막힘, 30분 안 정확한 스냅샷이면 열림");
const HOLD = { id: "h", created_at: new Date(NOW - 10 * 60000).toISOString() };
check([t.W.holdReleaseState(HOLD, snap(0, NOW - 20 * 60000, NOW)).enabled, t.W.holdReleaseState(HOLD, snap(0, NOW, NOW - 20 * 60000)).enabled,
       t.W.holdReleaseState(HOLD, snap(0, NOW, NOW, "C_CACHE")).enabled, t.W.holdReleaseState(HOLD, snap(0, NOW, NOW)), t.W.holdReleaseState(HOLD, snap(3, NOW, NOW)).needsAck],
      [false, false, false, { enabled: true, needsAck: false, why: "" }, true],
      "[핵심] 보류 해제: 보류 뒤 스냅샷·보류 뒤 재계산 캐시·게이트 통과만 · 후보 있으면 목록 확인 필요");
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
check([html.includes("95981694043"), html.includes("리버스-발주-2026-010"), html.includes("운영 문의메일 단계의 정확한 후보"),
       html.includes("후보 <b>0</b>건"), (html.match(/data-erp-key="wrf-confirm" disabled/g) || []).length],
      [true, true, true, true, 1], "[핵심] 미리보기 표 · 발주 · 운영 스냅샷(후보 0건) 표시 · 확정 수량 입력 전엔 실행 막힘");
check(rpcs().every(c => ["fn_preview_wing_direct_receipts", "fn_preview_restock_inquiry_mail_state"].includes(c[1])), true, "화면 진입은 읽기 RPC 만");
// 스냅샷이 오래되면 실행 자체가 막힘
SV.snapshots = [snap(0, Date.now() - 45 * 60000, Date.now() - 60 * 60000)];
fill(t); calls.length = 0;
let rs = await t.W.confirm();
check([rs.status, rpcs("fn_confirm_wing_direct_receipts").length, String(rs.message).includes("30분")], ["STALE", 0, true],
      "[핵심] 정확한 운영 후보 스냅샷이 30분 넘으면 확정 실행 막힘(RPC 0)");
SV.snapshots = [];
rs = await t.W.confirm();
check([rs.status, String(rs.message).includes("--preview-only")], ["STALE", true], "[핵심] 스냅샷이 없으면 막힘 + VM 미리보기 안내");
SV.snapshots = [snap(0, Date.now() - 5 * 60000, Date.now() - 60 * 60000)];
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
check([html.includes("확정 완료 48"), (html.match(/data-erp-key="wrf-adjust" disabled/g) || []).length], [true, 0], "새로고침 뒤 확정됨 표시 · 조정 버튼 열림");
// 탭 2개: 두 번째 탭이 같은 내용(같은 키)을 확정 전 미리보기로 보냄 → 이미 적용
resetServer(); calls.length = 0;
const tabA = makeCtx("ap"), tabB = makeCtx("ap");
await tabA.W.view(tabA.sb, tabA.me); await tabB.W.view(tabB.sb, tabB.me); fill(tabA); fill(tabB);
const pa = withConfirm(tabA, () => tabA.W.confirm(), REASON);
r = await pa;
// 탭 B 는 확정 전 화면(미리보기 재조회 없이) - 서버 쪽 규칙 확인을 위해 같은 키·같은 내용을 직접 보냄
const planB = tabB.W.buildPlan(tabB.W._state.preview, tabB.W._state.inputs);
const itemsB = tabB.W.confirmItems(planB).items;
const keyB = await tabB.W.idemKey("wdr", SHIP, { kind: "confirm", items: itemsB, reason: REASON });
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

console.log("\n=== 5. 문의메일 보류 해제 ===");
resetServer(); t = makeCtx("ap"); await t.W.view(t.sb, t.me); fill(t);
await withConfirm(t, () => t.W.confirm(), REASON);
check(SV.holds.filter(h => h.status === "ACTIVE").length, 1, "[핵심] 확정 실행과 함께 서버가 문의메일 보류를 걺");
const hid = SV.holds[0].id;
html = await t.W.view(t.sb, t.me);
check([html.includes(`data-erp-key="wrf-release-${hid}" disabled`), html.includes("보류 뒤에 계산된 스냅샷이 아직 없어요")], [true, true],
      "[핵심] 보류 뒤 스냅샷이 없으면 해제 버튼 막힘");
calls.length = 0;
let rr = await t.W.release(hid);
check([rr.status, rpcs("fn_release_restock_inquiry_mail_hold").length], ["STALE", 0], "해제 직접 호출도 재조회 뒤 막힘(RPC 0)");
SV.snapshots.push(snap(2, Date.now() + 1000, Date.now() + 1000));
html = await t.W.view(t.sb, t.me);
check([html.includes(`data-erp-key="wrf-release-${hid}" disabled`), html.includes("후보 2건에 문의 메일이 나가도 됨을 확인"), html.includes("ZZ-0")], [true, true, true],
      "[핵심] 보류 뒤 스냅샷에 후보 2건 → 후보 목록 표시 · 확인 체크 전엔 해제 막힘");
calls.length = 0;
rr = await t.W.release(hid);
check([rr.status, String(rr.message).includes("확인 체크"), rpcs("fn_release_restock_inquiry_mail_hold").length], ["STALE", true, 0], "[핵심] 후보 확인 체크 없이 해제 직접 호출 → 막힘(RPC 0)");
t.W.setAck(hid, true); calls.length = 0;
rr = await withConfirm(t, () => t.W.release(hid), "후보 2건 확인 후 해제");
const rel = rpcs("fn_release_restock_inquiry_mail_hold")[0][2];
check([rr.res.status, rel.p_acknowledged_candidates_fp, SV.holds[0].status, rr.opened.includes("실제 메일이 나갈 수 있어요")], ["DONE", "fp2", "RELEASED", true],
      "[핵심] 확인 체크 뒤 해제: 후보 목록 지문 전송 · 확인창 경고");
resetServer(); t = makeCtx("ap"); await t.W.view(t.sb, t.me); fill(t);
await withConfirm(t, () => t.W.confirm(), REASON);
SV.snapshots.push(snap(0, Date.now() + 1000, Date.now() + 1000));
await t.W.view(t.sb, t.me);
rr = await withConfirm(t, () => t.W.release(SV.holds[0].id), "정정 뒤 후보 0건 확인");
check([rr.res.status, rpcs("fn_release_restock_inquiry_mail_hold").slice(-1)[0][2].p_acknowledged_candidates_fp], ["DONE", null], "후보 0건 스냅샷이면 확인 없이 해제");
const st3 = makeCtx("st"); await st3.W.view(st3.sb, st3.me); calls.length = 0;
rr = await st3.W.release("hold-1");
check([rr.status, rpcs().length], ["DENIED", 0], "[핵심] 권한 없는 세션의 해제는 DENIED(RPC 0)");

console.log("\n=== 6. 되돌리기(조정 취소 → 확정 취소) ===");
resetServer(); t = makeCtx("ap"); await t.W.view(t.sb, t.me); fill(t);
await withConfirm(t, () => t.W.confirm(), REASON);
await withConfirm(t, () => t.W.adjust(), "WING 확정 기준 발주 입고수량 조정 - 청구 대조 전");
html = await t.W.view(t.sb, t.me);
check([html.includes('data-erp-key="wrf-revoke-conf" disabled'), html.includes("발주 조정 6건을 먼저 취소해야"), html.includes("조정 24→48 → 취소 시 원본 24"), html.includes("B. 확정 취소 (6건)")],
      [true, true, true, true], "[핵심] 읽기 전용 되돌리기 미리보기 · 조정이 있으면 확정 취소 막힘(순서)");
calls.length = 0;
let rv = await t.W.revokeConfirmations();
check([rv.status, rpcs("fn_revoke_wing_direct_receipt_confirmations").length], ["STALE", 0], "[핵심] 순서 위반 직접 호출도 막힘(RPC 0)");
// 서버에 순서 위반을 그대로 보내면 서버가 막는지(화면 우회 대비)
const convs = Object.values(SV.conf).map(c => ({ id: c.id, expected_qty: c.qty }));
const srv = await t.sb.rpc("fn_revoke_wing_direct_receipt_confirmations", { p_items: convs, p_reason: "순서 위반 우회 시도", p_idempotency_key: "rvc-bypass-0001" });
check([srv.data.status, srv.data.blockers[0].reason, Object.keys(SV.conf).length], ["BLOCKED", "ACTIVE_PO_ADJUSTMENT_EXISTS", 6], "서버도 순서 위반 거부(아무것도 안 바뀜)");
// 조정 취소: 한 품목 값이 그 사이 바뀌면(drift) 전부 안 함
const orig4 = t.sb.rpc;
t.sb.rpc = async (fn, a) => { if (fn === "fn_revoke_po_receipt_adjustments") SV.adj["poi-95981694045"].adjusted = 99; return orig4(fn, a); };
rv = await withConfirm(t, () => t.W.revokeAdjustments(), "공급처 청구 확인 결과 수량 재검토 필요");
check([rv.res.status, Object.keys(SV.adj).length, t.W._state.lastRevoke["95981694045"].state, t.W._state.lastRevoke["95981694043"].state], ["FAILED", 6, "DRIFT", "FAILED"],
      "[핵심] 조정 취소 중 한 품목 drift → 전부 안 함 · SKU 별 drift/적용 안 됨 표시");
t.sb.rpc = orig4; SV.adj["poi-95981694045"].adjusted = 24;
// 세션 만료
t.sb.rpc = async (fn, a) => fn === "fn_revoke_po_receipt_adjustments" ? { data: null, error: { message: "JWT expired" } } : orig4(fn, a);
rv = await withConfirm(t, () => t.W.revokeAdjustments(), "공급처 청구 확인 결과 수량 재검토 필요");
check([rv.res.status, t.W._state.lastRevoke["95981694043"].text.includes("세션이 만료"), Object.keys(SV.adj).length], ["FAILED", true, 6], "[핵심] 취소 중 세션 만료 → 실패 표시·변경 0");
t.sb.rpc = orig4;
// 정상 조정 취소 + 두 탭
const tab2 = makeCtx("ap"); await tab2.W.view(tab2.sb, tab2.me);
const planT2 = tab2.W.buildPlan(tab2.W._state.preview, tab2.W._state.inputs);
calls.length = 0;
rv = await withConfirm(t, () => t.W.revokeAdjustments(), "공급처 청구 확인 결과 수량 재검토 필요");
const revSent = rpcs("fn_revoke_po_receipt_adjustments")[0][2];
check([rv.res.status, Object.keys(SV.adj).length, Object.values(t.W._state.lastRevoke).map(x => x.state), revSent.p_items.length],
      ["DONE", 0, Array(6).fill("APPLIED"), 6], "[핵심] 조정 취소 6건 적용 · SKU 별 결과 · 취소 묶음 ID");
check(/취소 묶음 rv-1/.test(t.W._state.lastRevokeMeta) && /요청 키 rva-/.test(t.W._state.lastRevokeMeta), true, "감사 식별자(취소 묶음·요청 키) 표시");
const it2 = tab2.W.revokeItems(planT2, "revoke_adj").items;
const kT2 = await tab2.W.idemKey("rva", SHIP, { kind: "revoke_adj", items: it2, reason: "공급처 청구 확인 결과 수량 재검토 필요" });
const r2 = await tab2.sb.rpc("fn_revoke_po_receipt_adjustments", { p_items: it2, p_reason: "공급처 청구 확인 결과 수량 재검토 필요", p_idempotency_key: kT2 });
check([r2.data.status, tab2.W.interpretResult("revoke_adj", it2.map(i => i.id), r2.data, null).perKey[it2[0].id].state], ["ALREADY_REVOKED", "ALREADY"],
      "[핵심] 두 번째 탭이 같은 내용으로 취소 → 이미 취소됨(서버 1번만)");
calls.length = 0;
rv = await t.W.revokeAdjustments();
check([rv.status, rpcs("fn_revoke_po_receipt_adjustments").length], ["STALE", 0], "이미 취소된 뒤 다시 누르면 '취소할 조정 없음'(RPC 0)");
// 확정 취소(조정 취소 뒤)
SV.delay = 20; calls.length = 0;
const pc1 = withConfirm(t, () => t.W.revokeConfirmations(), "공급처 청구 확인 결과 수량 재검토 필요");
await tick();
const dup = await t.W.revokeConfirmations();
rv = await pc1; SV.delay = 0;
check([dup.status, rv.res.status, rpcs("fn_revoke_wing_direct_receipt_confirmations").length, Object.keys(SV.conf).length], ["BUSY", "DONE", 1, 0],
      "[핵심] 조정 취소 뒤 확정 취소 6건 · 중복 클릭 BUSY(RPC 1번)");
check(SV.holds.filter(h => h.status === "ACTIVE").length, 4, "확정·조정·조정 취소·확정 취소마다 문의메일 보류");
const st4 = makeCtx("st"); await st4.W.view(st4.sb, st4.me); calls.length = 0;
rv = await st4.W.revokeAdjustments();
check([rv.status, rpcs().length], ["DENIED", 0], "[핵심] 권한 없는 세션의 취소는 DENIED(RPC 0)");

console.log("\n=== 6-2. 화면 다시 열기(빈 입력칸) - 서버 확정값 기준 표시 ===");
resetServer(); t = makeCtx("ap"); await t.W.view(t.sb, t.me); fill(t);
await withConfirm(t, () => t.W.confirm(), REASON);
await withConfirm(t, () => t.W.adjust(), "WING 확정 기준 발주 입고수량 조정 - 청구 대조 전");
const re = makeCtx("ap");                     // 새 탭 = 입력칸 비어 있음
html = await re.W.view(re.sb, re.me);
let rp = re.W.buildPlan(re.W._state.preview, re.W._state.inputs);
check([rp.rows.map(r => r.confState), rp.rows.map(r => r.adjState), rp.rows.map(r => r.qtySource), rp.inputErrors.length, rp.amountTotal],
      [Array(6).fill("SAME"), Array(6).fill("SAME"), Array(6).fill("CONFIRMED"), 0, 0],
      "[핵심] 빈 입력칸 + 유효 확정 → 확정 완료(SAME)·조정 완료 · 입력 오류 0 · 새 금액 0");
check([(html.match(/확정 완료 /g) || []).length, html.includes("확정값과 다름"), html.includes("다른 값 확정"), (html.match(/조정 완료/g) || []).length,
       html.includes('value="48"'), html.includes("확정 수량을 넣어 주세요")],
      [6, false, false, 6, true, false], "[핵심] 표시: 확정 완료 6 · '다름' 경고 없음 · 입력칸에 확정값 표시 · 빈칸 오류 없음");
check([html.includes('data-erp-key="wrf-confirm" disabled'), html.includes('data-erp-key="wrf-adjust" disabled'),
       html.includes('data-erp-key="wrf-revoke-adj" disabled'), html.includes('data-erp-key="wrf-revoke-conf" disabled'),
       html.includes("모두 이미 같은 값으로 확정됨"), html.includes("모두 이미 조정됨")],
      [true, true, false, true, true, true], "[핵심] 버튼: 확정·조정 막힘(할 일 없음) · 조정 취소 열림 · 확정 취소 순서상 막힘");
calls.length = 0;
const rr0 = await re.W.confirm();
check([rr0.status, rpcs("fn_confirm_wing_direct_receipts").length], ["STALE", 0], "다시 연 화면에서 확정 눌러도 새로 쓸 것 없음(RPC 0)");
// 사용자가 한 SKU 를 실제로 다른 값으로 바꿨을 때만 경고
re.W._state.inputs["95981694044"] = "24";
html = await re.W.view(re.sb, re.me);
rp = re.W.buildPlan(re.W._state.preview, re.W._state.inputs);
check([rp.rows.find(r => r.vid === "95981694044").confState, html.includes("⚠ 확정값과 다름(확정 48 · 입력 24)"), (html.match(/확정 완료 /g) || []).length,
       rp.rows.find(r => r.vid === "95981694044").adjState],
      ["CONFLICT", true, 5, "CONFLICT"], "[핵심] 실제로 다른 값(48→24) 입력 → 그 행만 '확정값과 다름' 경고");
calls.length = 0;
const rr1 = await re.W.confirm();
check([rr1.status, rpcs("fn_confirm_wing_direct_receipts").length, String(rr1.message).includes("95981694044")], ["STALE", 0, true], "다른 값 입력 상태로는 확정 실행 막힘(RPC 0)");
re.W._state.inputs["95981694044"] = "48";     // 같은 값을 직접 넣으면 경고 없음
rp = re.W.buildPlan(re.W._state.preview, re.W._state.inputs);
check([rp.rows.find(r => r.vid === "95981694044").confState, rp.rows.find(r => r.vid === "95981694044").qtySource], ["SAME", "INPUT"], "같은 값 입력 → 확정 완료");
re.W._state.inputs["95981694044"] = "  ";     // 지우면 다시 서버 확정값 기준
rp = re.W.buildPlan(re.W._state.preview, re.W._state.inputs);
check([rp.rows.find(r => r.vid === "95981694044").confState, rp.rows.find(r => r.vid === "95981694044").qtySource], ["SAME", "CONFIRMED"], "입력을 지우면 다시 서버 확정값 기준");
// 확정이 없는 SKU 는 여전히 빈칸 = 입력 필요(확정 일부만 있는 경우)
resetServer(); t = makeCtx("ap"); await t.W.view(t.sb, t.me);
SV.conf["95981694044"] = { id: "conf-95981694044", batch: "batch-x", qty: 48, fp: SV.mirror["95981694044"].fp };
const part = makeCtx("ap"); html = await part.W.view(part.sb, part.me);
rp = part.W.buildPlan(part.W._state.preview, part.W._state.inputs);
check([rp.rows.find(r => r.vid === "95981694044").confState, rp.inputErrors.length, html.includes('data-erp-key="wrf-confirm" disabled')], ["SAME", 5, true],
      "확정 1개만 있을 때: 그 행은 확정 완료 · 나머지 5개는 입력 필요 · 실행 막힘");
// WING 값이 바뀐 확정은 빈칸이어도 drift 표시
SV.mirror["95981694044"].fp = "fp-changed";
html = await part.W.view(part.sb, part.me);
check([html.includes("확정 뒤 WING 값 바뀜"), html.includes("확정 완료 48")], [true, false], "지문이 바뀐 확정은 빈칸이어도 drift 표시(확정 완료 아님)");

console.log("\n=== 7. 연결 ===");
const app = read("./js/app.js"), index = read("./index.html");
check([/wingreceiptfix: \{ title: "WING 직접입고 최종수량 정정", render: \(\) => \(globalThis\.WingReceiptFix \? WingReceiptFix\.view\(sb, me\)/.test(app),
       index.includes('<script src="js/wing_direct_receipt_fix.js?v=2"></script>'), index.includes('href="#/wingreceiptfix" data-route="wingreceiptfix"'),
       index.indexOf("wing_direct_receipt_fix.js") < index.indexOf("js/app.js"), /js\/app\.js\?v=(14[7-9]|1[5-9]\d)/.test(index)],
      [true, true, true, true, true], "[핵심] 라우트·스크립트(app.js 앞)·메뉴·app.js?v=147 이상");
console.log(`\n${fails ? "FAIL" : "ALL PASS"} ${passes} / FAIL ${fails}`);
process.exit(fails ? 1 : 0);
