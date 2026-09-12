// fixtures_po_freight_est_inactive.mjs
// ------------------------------------------------
// 2026-09-12 [사용자 확정] 발주서에 저장된 예상 운송비(freight_est)가 취소된 운송 묶음 기준이면 현재 비용으로 쓰지 않음(네트워크 0건).
// app.js 의 openReceiveModal·saveReceive·markOrdered 와 poFreight* 도우미는 소스에서 실제 정의를 잘라 실행(미러 아님). DB 는 가짜.
//   1) PO-016 모양(운송비 기록이 무효·대체뿐): 입고 처리에 187,000 미리 채우지 않음 · 입고 확정해도 purchase_costs 운송비 0건
//   2) 발주 완료 대금(자금일보 나갈 돈)에 187,000 더하지 않음 - 4,080,000
//   3) 발주서 목록·상세는 원래 값 ₩187,000 을 그대로 보여주되 '취소된 운송 묶음 · 현재 비용 아님' 표시(감사 이력 보존)
//   4) 회귀: 살아 있는 기록이 있으면 입력칸 없음(중복 방지 그대로) · 기록이 없는 일반 발주는 예전처럼 미리 채움·대금 포함
//   5) 운송비 기록을 못 읽었으면 예전 동작(미리 채우지 않음 · 대금은 저장값)
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

const writes = [];
const modal = { innerHTML: "" };
let freightInput = { value: "" };
const table = t => ({
  insert: async row => { writes.push([t, "insert", row]); return { error: null }; },
  update: patch => ({ eq: () => ({ select: async () => { writes.push([t, "update", patch]); return { data: [{ id: "x" }], error: null }; },
                                   then: r => { writes.push([t, "update", patch]); return r({ error: null }); } }) }),
});
const ctx = vm.createContext({
  console, Map, Set, JSON, Number, String, Date, Math,
  sb: { from: table },
  document: {
    getElementById: id => ({ "modal-root": modal, "rc-date": { value: "2026-09-12" }, "rc-freight": freightInput, "btn-rc-save": {} })[id] || null,
    querySelectorAll: () => [{ dataset: { item: "i1", pid: "p1", cost: "8500", remain: "480" }, querySelector: () => ({ value: "480" }) }],
  },
  fmt: v => Number(v).toLocaleString("en-US"), cfv: v => (v === "" ? "" : Number(v).toLocaleString("en-US")),
  esc: v => String(v), prodName: () => "모노플랫", vatTag: () => "", today: () => "2026-09-12", numOf: v => Number(String(v).replace(/,/g, "")) || 0,
  toast: () => {}, closeModal: () => {}, route: () => {}, addDaysStr: () => "2026-10-12", confirmed: [],
  me: { name: "테스트" }, erpSupplierList: [{ name: "리파코 주식회사", pay_terms: "월말" }],
});
vm.runInContext(`var confirm = msg => { confirmed.push(msg); return true; };
  let erpFreight = { records: [], history: [], error: null }; let poCache = []; let poItemCache = {};`, ctx);
vm.runInContext(grabLine(/const poFreightRecord = [^\n]*\n/), ctx);
vm.runInContext(grabLine(/const poFreightInactiveOnly = [\s\S]*?;\n/), ctx);
vm.runInContext(grabLine(/const poCurrentFreightEst = [^\n]*\n/), ctx);
vm.runInContext(grabLine(/const poFreightInactiveTag = [\s\S]*?;\n/), ctx);
for (const f of ["openReceiveModal", "saveReceive", "markOrdered"]) vm.runInContext(grabFn(f), ctx);

const PO = { id: "po16", po_no: "리버스-발주-2026-016", supplier: "리파코 주식회사", deliver_to: "쿠팡", status: "approved", total: 4080000, freight_est: 187000 };
const setWorld = (freight, po = PO) => {
  writes.length = 0; ctx.confirmed.length = 0; modal.innerHTML = "";
  vm.runInContext(`erpFreight = ${JSON.stringify(freight)}; poCache = [${JSON.stringify(po)}];
    poItemCache = { "${po.id}": [{ id: "i1", product_id: "p1", qty: 480, received_qty: 0, unit_cost: 8500 }] };`, ctx);
};
const HIST = [{ purchase_order_id: "po16", status: "SUPERSEDED", gross_amount: 187000 }, { purchase_order_id: "po16", status: "VOID_PENDING_REBUILD", gross_amount: 187000 }];

console.log("=== 1·3. PO-016 모양 - 기록이 무효·대체뿐 ===");
setWorld({ records: [], history: HIST, error: null });
check([vm.runInContext("poFreightInactiveOnly('po16')", ctx), vm.runInContext(`poCurrentFreightEst(poCache[0])`, ctx)], [true, 0], "[핵심] 현재 비용으로 쓸 예상 운송비 0");
check(vm.runInContext(`poFreightInactiveTag(poCache[0])`, ctx).includes("취소된 운송 묶음 · 현재 비용 아님"), true, "목록·상세: 원래 값 옆에 '현재 비용 아님' 표시");
vm.runInContext(`openReceiveModal("po16")`, ctx);
check([modal.innerHTML.includes('id="rc-freight" type="text" inputmode="numeric" class="comma" value=""'), modal.innerHTML.includes("미리 채우지 않았어요")],
      [true, true], "[핵심] 입고 처리: 187,000 미리 채우지 않음 + 안내");
freightInput.value = "";
await vm.runInContext(`saveReceive("po16")`, ctx);
check(writes.filter(w => w[0] === "purchase_costs").length, 0, "[핵심] 입고 확정해도 purchase_costs 운송비 0건(재고원가·매입에 187,000 없음)");
check(writes.filter(w => w[0] === "purchases").length, 1, "매입(상품)은 그대로 기록");

console.log("\n=== 2. 발주 완료 대금 ===");
setWorld({ records: [], history: HIST, error: null });
await vm.runInContext(`markOrdered("po16")`, ctx);
const cash = writes.find(w => w[0] === "cash_plans");
check([cash && cash[2].amount, ctx.confirmed[0].includes("4,080,000"), ctx.confirmed[0].includes("운송비 포함")], [4080000, true, false],
      "[핵심] 자금일보 나갈 돈 4,080,000(187,000 제외) · '운송비 포함' 문구 없음");

console.log("\n=== 4. 회귀 ===");
setWorld({ records: [{ cost: { purchase_order_id: "po16", id: "act" }, gross: 198000, basis: "ESTIMATE" }], history: HIST, error: null });
vm.runInContext(`openReceiveModal("po16")`, ctx);
check([modal.innerHTML.includes('id="rc-freight"'), modal.innerHTML.includes("운송 묶음 기록 ₩198,000")], [false, true], "살아 있는 기록이 있으면 입력칸 없음(중복 방지 그대로)");
await vm.runInContext(`markOrdered("po16")`, ctx);
check(writes.find(w => w[0] === "cash_plans")[2].amount, 4267000, "살아 있는 기록이 있으면 발주서 예상 운송비는 예전처럼 대금에 포함");
const plain = { ...PO, id: "po9", po_no: "리버스-발주-2026-009", freight_est: 99000 };
setWorld({ records: [], history: [], error: null }, plain);
vm.runInContext(`openReceiveModal("po9")`, ctx);
check(modal.innerHTML.includes('value="99,000"'), true, "기록이 없는 일반 발주: 예전처럼 저장값 미리 채움");
await vm.runInContext(`markOrdered("po9")`, ctx);
check(writes.find(w => w[0] === "cash_plans")[2].amount, 4179000, "일반 발주: 대금에 운송비 포함(예전 그대로)");

console.log("\n=== 5. 운송비 기록을 못 읽음 ===");
setWorld({ records: [], history: [], error: "x" });
vm.runInContext(`openReceiveModal("po16")`, ctx);
check(modal.innerHTML.includes('value=""') && modal.innerHTML.includes("확인하지 못해"), true, "예전처럼 미리 채우지 않고 안내");
check(vm.runInContext(`poCurrentFreightEst(poCache[0])`, ctx), 187000, "대금 계산은 저장값(모를 땐 예전 동작)");

console.log(`\n=== 결과: ${fails ? `실패 ${fails}건` : "전체 통과"} ===`);
process.exit(fails ? 1 : 0);
