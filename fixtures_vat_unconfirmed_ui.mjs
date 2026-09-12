// fixtures_vat_unconfirmed_ui.mjs
// ------------------------------------------------
// 2026-09-12 [사용자 확정] VAT 확인 대기(VAT_UNCONFIRMED) 안전 규칙 - 화면 쪽 검증(네트워크 0건, DB 는 가짜).
// app.js 의 savePO·decidePO·buildInventoryPOProposal 과 VAT 도우미는 소스에서 실제 정의를 잘라 실행(미러 아님).
//   1) 판정: 발주정보 없음=NO_PROCUREMENT · VAT 미확인=VAT_UNCONFIRMED · 확인 뒤 원가 변경=VAT_UNCONFIRMED · 확인=CONFIRMED
//      · 세트는 부모 기준 · 조회 실패=VAT_STATUS_UNKNOWN(미확인과 같이 다룸)
//   2) 발주안: 확인된 상품만 자동으로, 미확인·실패는 needsAck(사람이 경고 보고 직접 추가)
//   3) 결재 올리기: 미확인 품목이 있으면 경고 체크 없이는 저장 0건 · 체크하면 저장 + 메모에 확인 기록
//      · 체크한 품목과 지금 품목이 다르면 다시 확인 · 확인된 품목만이면 경고 없음
//   4) 승인: 미확인 품목이 있으면 경고 체크 없이는 승인 0건 · 체크하면 승인 + 결재선에 확인 기록 · 반려는 그대로
//   5) 재고 화면: 추천 수량 옆 '참고용 · VAT 미확인' 표시(추천 수량은 그대로 보여줌)
import { readFileSync } from "fs";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
const app = read("./js/app.js");
let fails = 0;
const check = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(got)}, 기대=${JSON.stringify(want)})`}`);
  if (!ok) fails++;
};
const grabFn = name => {
  const m = app.match(new RegExp(`\\n(async )?function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`${name} 없음`);
  return m[0];
};
const grabLine = re => { const m = app.match(re); if (!m) throw new Error(String(re)); return m[0]; };

// ── 가짜 DB ─────────────────────────────────────────────────────────────────
const DB = {
  products: [
    { id: "dh12", code: "1G1A-003-01", cost_price: 5500, set_parent_id: null },
    { id: "dh24", code: "1G1A-003-01-S2", cost_price: null, set_parent_id: "dh12" },
    { id: "mat", code: "1M1N-001-01", cost_price: 8500, set_parent_id: null },
    { id: "spray", code: "1M1A-009-01", cost_price: 6300, set_parent_id: null },
    { id: "chg", code: "CHG", cost_price: 7000, set_parent_id: null },
  ],
  product_procurement: [
    { product_id: "dh12", cost_vat_basis: null },               // VAT 미확인(기존 8행 모양)
    { product_id: "mat", cost_vat_basis: "VAT_EXCLUDED" },      // 확인됨
    { product_id: "chg", cost_vat_basis: "VAT_EXCLUDED" },      // 확인 뒤 원가 변경(6000 → 7000)
  ],
  product_procurement_audit: [
    { id: 1, product_id: "mat", action: "UPDATE", cost_price_seen: 8500 },
    { id: 2, product_id: "chg", action: "CREATE", cost_price_seen: 6000 },
  ],
  purchase_orders: [], purchase_order_items: [],
};
const STATE = { failVat: false, writes: [] };
function fakeSb() {
  const builder = t => {
    const b = { _f: [], _single: false, select() { return b; }, order() { return b; }, limit() { return b; },
      in(c, v) { b._f.push(r => v.includes(r[c])); return b; }, eq(c, v) { b._f.push(r => r[c] === v); return b; },
      maybeSingle() { b._single = true; return b; }, single() { b._single = true; return b; },
      insert(row) { STATE.writes.push([t, "insert", row]); b._ins = row; return b; },
      update(patch) { STATE.writes.push([t, "update", patch]); b._upd = patch; return b; },
      delete() { STATE.writes.push([t, "delete"]); return b; },
      then(res, rej) {
        if (STATE.failVat && ["product_procurement", "product_procurement_audit"].includes(t)) return Promise.resolve({ data: null, error: { message: "timeout" } }).then(res, rej);
        if (b._ins) return Promise.resolve({ data: { id: "po-new" }, error: null }).then(res, rej);
        if (b._upd) return Promise.resolve({ data: [{ id: "x" }], error: null }).then(res, rej);
        let rows = (DB[t] || []).filter(r => b._f.every(f => f(r)));
        rows = JSON.parse(JSON.stringify(rows));
        return Promise.resolve({ data: b._single ? rows[0] || null : rows, error: null }).then(res, rej);
      } };
    return b;
  };
  return { from: builder, rpc: async () => ({ data: "리버스-발주-2026-099", error: null }) };
}

// ── 가짜 DOM(id 로 찾는 요소 + 발주 행) ───────────────────────────────────────
const els = {};
const el = id => (els[id] = els[id] || { id, value: "", checked: false, dataset: {}, innerHTML: "", disabled: false, textContent: "" });
let ROWS = [];
const mkRow = (pid, qty, cost) => ({ dataset: {}, querySelector: sel => ({ ".po-prod": { dataset: { pid } }, ".po-qty": { value: String(qty) }, ".po-cost": { value: String(cost) } })[sel] });
// 체크박스: 경고 HTML 을 그리면 그 안의 data-pids 를 가진 요소가 생긴 것처럼
const renderAck = (boxId, ackId) => {
  const m = (el(boxId).innerHTML.match(new RegExp(`id="${ackId}" data-pids="([^"]*)"`)) || [])[1];
  if (m !== undefined) { el(ackId).dataset.pids = m; }
};
const toasts = [];
const ctx = vm.createContext({
  console, Map, Set, JSON, Number, String, Date, Math, Promise, Object, Array, RegExp,
  document: {
    getElementById: id => (id.startsWith("po-vat-") && id.endsWith("-ack") && !els[id]?.dataset?.pids) ? null : el(id),
    querySelectorAll: sel => sel === "#po-rows tr" ? ROWS : [],
  },
  toast: m => toasts.push(m), closeModal: () => {}, route: () => {}, nowStr: () => "2026-09-12 23:50",
  today: () => "2026-09-12", fmt: v => Number(v).toLocaleString("en-US"), esc: v => String(v ?? ""),
  numOf: v => Number(String(v ?? "").replace(/,/g, "")) || 0, pidOf: sel => sel?.dataset?.pid || "",
  prodName: id => (DB.products.find(p => p.id === id) || {}).code || "?",
  me: { id: "boss", name: "장팀장" },
});
vm.runInContext(read("./js/procurement_input.js"), ctx);
vm.runInContext("var sb = null;", ctx);
ctx.sb = fakeSb();
vm.runInContext(grabLine(/const poVatUnconfirmed = [^\n]*\n/), ctx);
vm.runInContext(grabLine(/const poVatAcked = [^\n]*\n/), ctx);
for (const f of ["poVatWarnHtml", "buildInventoryPOProposal", "savePO", "decidePO"]) vm.runInContext(grabFn(f), ctx);
const PI = ctx.ProcurementInput;

console.log("=== 1. VAT 확인 상태 판정 ===");
const st = await PI.fetchVatStatus(ctx.sb, ["dh12", "dh24", "mat", "spray", "chg"]);
check(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.status])),
      { dh12: "VAT_UNCONFIRMED", dh24: "VAT_UNCONFIRMED", mat: "CONFIRMED", spray: "NO_PROCUREMENT", chg: "VAT_UNCONFIRMED" },
      "[핵심] 미확인·세트(부모 기준)·확인·발주정보 없음·확인 뒤 원가 변경");
check(st.dh24.reason.includes("세트 - 부모 1G1A-003-01"), true, "세트는 부모 기준이라고 표시");
check(st.chg.reason.includes("6000 → 7000"), true, "확인 뒤 원가 변경 사유");
STATE.failVat = true;
check(Object.values(await PI.fetchVatStatus(ctx.sb, ["mat"])).map(v => v.status), ["VAT_STATUS_UNKNOWN"], "[핵심] 조회 실패 → 확인 못 함(미확인과 같이)");
STATE.failVat = false;
check([PI.vatNeedsAck("VAT_UNCONFIRMED"), PI.vatNeedsAck("VAT_STATUS_UNKNOWN"), PI.vatNeedsAck("CONFIRMED"), PI.vatNeedsAck("NO_PROCUREMENT")],
      [true, true, false, false], "경고 확인이 필요한 상태");

console.log("\n=== 2. 판매·재고 발주안 ===");
const row = { product_id: "dh12", product_name: "제습제", decision: "ORDER_NOW", supplier_name: "리파코 주식회사", recommended_order_qty_ea: 40,
              purchase_cost: 5500, avg_daily_sales: 2, live_stock: 20, order_unit: "BOX" };
const prods = [{ id: "dh12" }, { id: "mat" }];
const pr = ctx.buildInventoryPOProposal([row, { ...row, product_id: "mat" }], "2026-09-12", prods, st);
check([pr.lines.map(l => l.product_id), pr.needsAck.map(l => [l.product_id, l.vat.status])], [["mat"], [["dh12", "VAT_UNCONFIRMED"]]],
      "[핵심] 확인된 상품만 자동 발주안, VAT 미확인은 needsAck(자동 제외)");
check(ctx.buildInventoryPOProposal([{ ...row, decision: "DATA_CHECK" }], "2026-09-12", prods, st).needsAck.length, 0, "MISSING·데이터확인은 여전히 제외");

console.log("\n=== 3. 결재 올리기(기안) ===");
const setupSave = rows => { ROWS = rows; STATE.writes.length = 0; toasts.length = 0;
  for (const [k, v] of Object.entries({ "po-date": "2026-09-12", "po-supplier": "리파코 주식회사", "po-due": "", "po-deliver": "쿠팡", "po-freight": "", "po-memo": "8월 보충", "po-appr": "ceo" }))
    el(k).value = v;
  el("po-rows").dataset = {}; el("po-vat-save-warn").innerHTML = ""; delete els["po-vat-save-ack"]; };
setupSave([mkRow("dh12", 40, 5500), mkRow("mat", 80, 8500)]);
await ctx.savePO(false);
check([STATE.writes.filter(w => w[0] === "purchase_orders").length, el("po-vat-save-warn").innerHTML.includes("VAT 기준이 확인되지 않은 품목 1개"),
       el("po-vat-save-warn").innerHTML.includes("1G1A-003-01"), toasts.at(-1).includes("경고를 확인")],
      [0, true, true, true], "[핵심] 미확인 품목이 있으면 경고만 보여주고 저장 0건");
renderAck("po-vat-save-warn", "po-vat-save-ack");
el("po-vat-save-ack").checked = true;
await ctx.savePO(false);
const ins = STATE.writes.find(w => w[0] === "purchase_orders" && w[1] === "insert");
check([!!ins, ins && ins[2].memo, ins && ins[2].status], [true, "8월 보충 [VAT 미확인 확인(기안 장팀장): 1G1A-003-01]", "progress"],
      "[핵심] 경고 체크 → 저장 + 메모에 누가 무엇을 확인했는지");
setupSave([mkRow("dh12", 40, 5500)]);
el("po-vat-save-ack").dataset.pids = "chg"; el("po-vat-save-ack").checked = true;   // 다른 품목을 확인해 둔 상태
await ctx.savePO(false);
check(STATE.writes.filter(w => w[0] === "purchase_orders").length, 0, "확인한 품목과 지금 품목이 다르면 다시 확인");
setupSave([mkRow("mat", 80, 8500)]);
await ctx.savePO(false);
check([STATE.writes.filter(w => w[0] === "purchase_orders").length, el("po-vat-save-warn").innerHTML, STATE.writes.find(w => w[1] === "insert")[2].memo],
      [1, "", "8월 보충"], "확인된 품목만이면 경고 없이 그대로 저장(메모 그대로)");
setupSave([mkRow("spray", 60, 6300)]);
await ctx.savePO(true);
check(STATE.writes.filter(w => w[0] === "purchase_orders").length, 1, "발주정보 없는 품목의 수동 발주는 기존처럼(경고 대상 아님)");

console.log("\n=== 4. 결재 승인 ===");
const setupPO = pid => { STATE.writes.length = 0; toasts.length = 0; delete els["po-vat-approve-ack"]; el("po-vat-approve-warn").innerHTML = ""; el("btn-po-approve").disabled = false;
  DB.purchase_orders = [{ id: "po1", status: "progress", current_step: 0, approval_line: [{ userId: "boss", status: "pending", date: "" }] }];
  DB.purchase_order_items = [{ po_id: "po1", product_id: pid }]; };
setupPO("dh12");
await ctx.decidePO("po1", "approved");
check([STATE.writes.length, el("po-vat-approve-warn").innerHTML.includes("승인합니다"), el("btn-po-approve").disabled],
      [0, true, true], "[핵심] 미확인 품목 → 체크 없이는 승인 0건, 경고 + 승인 버튼 잠금");
renderAck("po-vat-approve-warn", "po-vat-approve-ack");
el("po-vat-approve-ack").checked = true;
await ctx.decidePO("po1", "approved");
const upd = STATE.writes.find(w => w[0] === "purchase_orders" && w[1] === "update");
check([upd && upd[2].status, upd && upd[2].approval_line[0].status, upd && upd[2].approval_line[0].vat_unconfirmed_ack],
      ["approved", "approved", { product_ids: ["dh12"], products: ["1G1A-003-01"], by: "boss", at: "2026-09-12 23:50" }],
      "[핵심] 경고 체크 → 승인 + 결재선에 VAT 미확인 확인 기록");
setupPO("dh12");
await ctx.decidePO("po1", "rejected");
check(STATE.writes.find(w => w[1] === "update")[2].status, "rejected", "반려는 경고 없이 그대로");
setupPO("mat");
await ctx.decidePO("po1", "approved");
const upd2 = STATE.writes.find(w => w[1] === "update");
check([upd2[2].status, "vat_unconfirmed_ack" in upd2[2].approval_line[0]], ["approved", false], "확인된 품목은 경고 없이 승인");
setupPO("dh12"); STATE.failVat = true;
await ctx.decidePO("po1", "approved");
check(STATE.writes.length, 0, "VAT 상태를 못 읽으면 체크 없이는 승인 안 됨(fail-closed)");
STATE.failVat = false;

console.log("\n=== 5. 재고 화면 표시 ===");
check(PI.vatChipHtml(st.dh12).includes("참고용 · VAT 미확인"), true, "추천 수량 옆 '참고용 · VAT 미확인'");
check(PI.vatChipHtml(st.mat), "", "확인된 상품은 표시 없음");
check(/const recoText = d\.recommended_order_qty_ea \? `\$\{fmt\(d\.recommended_order_qty_ea\)\}개\$\{ProcurementInput\.vatChipHtml\(invVatOf\(d\)\)\}`/.test(app), true,
      "[핵심] 추천 수량은 그대로 보여주고 옆에 표시만(참고용 추천 허용)");
check(/inventoryVatStatus = await ProcurementInput\.fetchVatStatus\(sb, result\.decisions/.test(app)
      && /buildInventoryPOProposal\(result\.decisions, today\(\), productPickList\("buy"\), vat\)/.test(app), true, "재고 화면·발주안이 VAT 상태를 읽어서 씀");

console.log(`\n=== 결과: ${fails ? `실패 ${fails}건` : "전체 통과"} ===`);
process.exit(fails ? 1 : 0);
