// fixtures_inbound_freight_cm.mjs
// ------------------------------------------------
// 2026-09-11 입고 트럭 운송비 → 공헌이익 검증(네트워크 0건).
// js/inbound_freight.js 는 실제 파일, app.js 의 cmOfSale·sumCM·computeCmOfMonth·카드·입고 처리 등은
// 소스에서 실제 정의를 잘라 같은 컨텍스트에서 실행해요(미러 아님).
//   1) 입고 전(WING 초안·승인 단계): 공헌이익 차감 0 · 예상 원가로만
//   2) 입고 후: 쿠팡 재고 선입선출 - 앞선 입고분이 먼저 팔리고, 이번 트럭분이 팔린 수량만 차감
//   3) 기존 매출·상품원가·수수료·물류비·광고비는 운송비 유무와 무관하게 똑같음(중복 차감 없음)
//   4) 187,000원 전체를 이번 달에 즉시 빼지 않음 · 공헌이익엔 공급가액만(VAT 제외)
//   5) 실제 청구금액으로 교체해도 예상값과 더해지지 않음 · 부가세는 실제 청구만 한 번
//   6) 입고 처리 화면은 운송 묶음 기록이 있으면 purchase_costs 에 운송비를 넣지 않음
import { readFileSync } from "fs";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
const app = read("./js/app.js");
const ctx = vm.createContext({ console, Map, Set });
vm.runInContext(read("./js/inbound_freight.js"), ctx);

const grabFn = name => {
  const m = app.match(new RegExp(`\\n(async )?function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`${name} 없음`);
  return m[0];
};
const grabLine = re => { const m = app.match(re); if (!m) throw new Error(String(re)); return m[0]; };
let TODAY = "2026-09-12";
vm.runInContext(`
  let vatCfg = { enabled: true, salePriceIncludesVat: true, purchaseCostIncludesVat: false, expenseIncludesVat: true };
  const VAT_RATE = 0.1;
  ${grabLine(/const netAmt = [\s\S]*?\n};/)}
  ${grabLine(/const vatAmt = [\s\S]*?\n};/)}
  ${grabLine(/const isTaxable = .*/)}
  ${grabLine(/const saleNet = .*/)}
  ${grabLine(/const saleVat = .*/)}
  ${grabLine(/const buyNet = .*/)}
  ${grabLine(/const buyVat = .*/)}
  ${grabLine(/const expNet = .*/)}
  ${grabLine(/const expVat = .*/)}
  ${grabLine(/const monthOf = .*/)}
  ${grabLine(/const isSetProd = .*/)}
  ${grabLine(/const setBaseOf = .*/)}
  let erpProducts = [], erpChannelList = [], erpTransfers = [];
  let erpFreight = { bySale: new Map(), records: [], costs: [], error: null };
  let poCache = [], poItemCache = {};
  let me = { id: "u1", name: "장팀장", approver: true };
  const fmt = n => Math.round(Number(n) || 0).toLocaleString("ko-KR");
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const cfv = v => (v === "" || v == null ? "" : Number(v).toLocaleString("ko-KR"));
  const numOf = v => Number(String(v).replace(/,/g, "")) || 0;
  const vatTag = () => "";
  const prodName = id => (erpProducts.find(p => p.id === id) || {}).name || id;
  ${grabFn("effCost")}
  ${grabFn("isCoupangPoolSale")}
  ${grabFn("channelSetting")}
  ${grabFn("shipKeyOf")}
  ${grabFn("shipChargedRows")}
  ${grabFn("cmOfSale")}
  ${grabFn("sumCM")}
  ${grabFn("adNetOf")}
  ${grabFn("adVatOf")}
  ${grabFn("computeCmOfMonth")}
  ${grabFn("inboundFreightCardHtml")}
  ${grabLine(/const poFreightRecord = .*/)}
  ${grabFn("poFreightPanelHtml")}
  ${grabFn("openReceiveModal")}
  ${grabFn("saveReceive")}
`, ctx);
ctx.today = () => TODAY;

let failures = 0;
const check = (a, e, label) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}` + (ok ? "" : ` (실제=${JSON.stringify(a)}, 기대=${JSON.stringify(e)})`));
  if (!ok) failures++;
};
const near = (a, e, label, tol = 1e-6) => check(Math.abs(a - e) <= tol ? e : a, e, label);
const has = (h, n, label) => check(String(h).includes(n), true, label);

// ---- 운영 모양의 기준 데이터(이름·수량·PO 는 리버스-발주-2026-016 그대로, 판매량은 시험용) ----
const G = "p-grey", B = "p-black", SETG = "p-grey-2set";
const PO16 = "po-016", PO_A = "po-0827", PO_G2 = "po-0911g", PO_B2 = "po-0911b";
const GROUP = "e0eb258d-9666-4326-8949-0d8012983285";
const products = [
  { id: G, name: "EPP 발판(그레이)", cost_price: 8500, fee_rate: 10.8, unit_fee: 2300 },
  { id: B, name: "EPP 발판(블랙)", cost_price: 8500, fee_rate: 10.8, unit_fee: 2300 },
  { id: SETG, name: "EPP 발판(그레이) 2개", set_parent_id: G, set_qty: 2 },
];
const channels = [{ name: "쿠팡 로켓그로스", ship_type: "풀필먼트", fee_rate: 10.8, unit_fee: 2300 },
                  { name: "스마트스토어", ship_type: "직접배송", fee_rate: 5, ship_fee: 3500 }];
const cost = (over = {}) => ({ id: "fc-1", shipment_group_id: GROUP, purchase_order_id: PO16, basis: "ESTIMATE",
  gross_amount: 187000, supply_amount: 170000, vat_amount: 17000, total_pallet_count: 6, allocation_basis: "PLT",
  purchase_orders: { po_no: "리버스-발주-2026-016" }, audit: [], ...over });
const allocs = (g = 113333, b = 56667, fid = "fc-1") => [
  { id: `${fid}-g`, freight_cost_id: fid, product_id: G, purchase_order_item_id: "poi-g", sort_order: 1, pallet_count: 4, qty: 320, allocated_supply: String(g), rounding_adjusted: false },
  { id: `${fid}-b`, freight_cost_id: fid, product_id: B, purchase_order_item_id: "poi-b", sort_order: 2, pallet_count: 2, qty: 160, allocated_supply: String(b), rounding_adjusted: true },
];
const buysBase = [
  { id: "b1", date: "2026-08-27", product_id: G, qty: 240, warehouse: "쿠팡", po_id: PO_A, unit_cost: 8500, amount: 2040000 },
  { id: "b2", date: "2026-08-27", product_id: B, qty: 80, warehouse: "쿠팡", po_id: PO_A, unit_cost: 8500, amount: 680000 },
  { id: "b3", date: "2026-09-11", product_id: G, qty: 320, warehouse: "쿠팡", po_id: PO_G2, unit_cost: 8500, amount: 2720000 },
  { id: "b4", date: "2026-09-11", product_id: B, qty: 80, warehouse: "쿠팡", po_id: PO_B2, unit_cost: 8500, amount: 680000 },
];
const receipt16 = [
  { id: "b16g", date: "2026-09-14", product_id: G, qty: 320, warehouse: "쿠팡", po_id: PO16, unit_cost: 8500, amount: 2720000 },
  { id: "b16b", date: "2026-09-14", product_id: B, qty: 160, warehouse: "쿠팡", po_id: PO16, unit_cost: 8500, amount: 1360000 },
];
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const salesUntil = end => {
  const out = [];
  for (let d = "2026-08-28"; d <= end; d = addDays(d, 1)) {
    out.push({ id: `sg-${d}`, date: d, product_id: G, qty: 10, amount: 10 * 19900, unit_cost: 8500, channel: "쿠팡 로켓그로스", memo: `g${d}` });
    out.push({ id: `sb-${d}`, date: d, product_id: B, qty: 3, amount: 3 * 19900, unit_cost: 8500, channel: "쿠팡 로켓그로스", memo: `b${d}` });
  }
  return out;
};
const ads = [{ date: "2026-09-05", channel: "쿠팡 광고", net: 50000, vat: 5000 }, { date: "2026-10-05", channel: "쿠팡 광고", net: 70000, vat: 7000 }];

function setup({ today, buys, sales, costs, allocations, transfers = [] }) {
  TODAY = today;
  ctx.erpProducts = products; ctx.erpChannelList = channels;
  vm.runInContext(`erpProducts = globalThis.__p; erpChannelList = globalThis.__c;`, Object.assign(ctx, { __p: products, __c: channels }));
  const res = ctx.InboundFreight.compute({ costs, allocations, buys, sales, transfers, products,
    isCoupangSale: vm.runInContext("isCoupangPoolSale", ctx), today });
  ctx.__f = { ...res, costs, error: null };
  vm.runInContext("erpFreight = globalThis.__f;", ctx);
  return res;
}
const noFreight = () => { ctx.__f = { bySale: new Map(), records: [], costs: [], error: null }; vm.runInContext("erpFreight = globalThis.__f;", ctx); };
const cmMonth = (month, sales) => vm.runInContext("computeCmOfMonth", ctx)(month, sales, ads, [{ amount: 1000000 }]);
const pick = m => ({ revenue: m.t.revenue, cost: m.t.cost, fee: m.t.fee, ship: m.t.ship, logi: m.t.logi, ad: m.adTotal, qty: m.t.qty });

console.log("=== 1. 입고 전(WING 초안·승인 단계, 오늘 09-12) ===");
{
  const sales = salesUntil("2026-09-12");
  const r = setup({ today: "2026-09-12", buys: buysBase, sales, costs: [cost()], allocations: allocs() });
  check(r.bySale.size, 0, "[핵심] 판매 배부 0건 - 입고 전에는 공헌이익에서 빼지 않음");
  check(r.records[0].stage, "BEFORE_RECEIPT", "상태 = 입고 전");
  near(r.records[0].pendingSupply, 170000, "입고 전 예상 원가 170,000(공급가액)로만 표시");
  const withF = cmMonth("2026-09", sales);
  noFreight(); const base = cmMonth("2026-09", sales);
  check(withF.cmNet, base.cmNet, "[핵심] 9월 공헌이익 = 운송비 기록 없을 때와 같음(187,000 즉시 차감 없음)");
  setup({ today: "2026-09-12", buys: buysBase, sales, costs: [cost()], allocations: allocs() });
  const card = vm.runInContext("inboundFreightCardHtml", ctx)("2026-09");
  has(card, "운송 묶음 ID", "카드: 운송 묶음 ID"); has(card, GROUP.slice(0, 8), "카드: 묶음 e0eb258d");
  has(card, "총 6PLT, 4:2", "카드: 배분 근거 총 6PLT, 4:2"); has(card, "예상", "카드: 예상 구분");
  has(card, "₩187,000", "카드: 결제 총액 187,000 (VAT 포함)"); has(card, "공급가액 ₩170,000", "카드: 공급가액 170,000");
  has(card, "매입 VAT ₩17,000", "카드: 매입 VAT 17,000"); has(card, "₩113,333", "카드: 그레이 113,333"); has(card, "₩56,667", "카드: 블랙 56,667");
  has(card, "₩354", "카드: 개당 배부액은 화면에서만 반올림(₩354)");
  has(card, "입고 전 · 예상 원가(공헌이익 차감 없음)", "카드: 입고 전 예상 원가 문구");
}

console.log("\n=== 2. 입고 후 선입선출(09-14 입고, 오늘 10-31) ===");
const salesOct = salesUntil("2026-10-31");
const buysAll = [...buysBase, ...receipt16];
{
  const r = setup({ today: "2026-10-31", buys: buysAll, sales: salesOct, costs: [cost()], allocations: allocs() });
  const [ag, ab] = r.records[0].allocs;
  check(r.records[0].stage, "RECEIVED", "상태 = 입고 완료");
  // 그레이: 09-14 이전 판매 170 → 08-27분 남은 70 + 09-11분 320 = 390개가 먼저 팔려야 이번 트럭분 시작(10-23부터)
  check(ag.soldQty, 90, "[핵심] 그레이: 앞선 입고분 390개 소진 뒤 10-23~10-31 판매 90개만 이번 트럭 운송비");
  near(ag.soldByMonth["2026-10"], 90 * 113333 / 320, "그레이 10월 차감 = 90 × 354.165625 (소수 그대로)");
  check(ag.soldByMonth["2026-09"] || 0, 0, "그레이 9월 차감 0");
  // 블랙: 09-14 이전 51 → 29 + 80 = 109개 먼저. 10-20 판매 3개 중 2개부터 이번 트럭분
  check(ab.soldQty, 35, "블랙: 10-20 일부(2개) + 10-21~10-31 33개 = 35개");
  check(r.bySale.get("sb-2026-10-20").units, 2, "블랙 10-20 판매 3개 중 2개만 배부(부분 소진)");
  check(r.bySale.has("sg-2026-10-22"), false, "그레이 10-22 판매는 앞선 입고분이라 운송비 없음");
  near(ag.inventorySupply, 230 * 113333 / 320, "[핵심] 그레이 미판매 230개분은 재고원가로 남음");
  const total = r.records[0].soldSupply + r.records[0].inventorySupply + r.records[0].pendingSupply;
  near(total, 170000, "판매분 + 재고원가 + 입고 전 = 공급가액 170,000 (한 번만)");

  const withF = cmMonth("2026-10", salesOct);
  const f10 = withF.t.inFreight;
  noFreight(); const base = cmMonth("2026-10", salesOct);
  check(pick(withF), pick(base), "[핵심] 매출·상품원가·수수료·배송비·물류비·광고비·수량은 운송비와 무관하게 동일(중복 차감 없음)");
  near(base.cmNet - withF.cmNet, f10, "[핵심] 공헌이익 차이 = 판매분 배부 운송비만");
  near(f10, 90 * 113333 / 320 + 35 * 56667 / 160, "10월 배부액 = 그레이 90개 + 블랙 35개분(공급가액)");
  check(f10 < 170000 && f10 < 187000, true, "10월에 187,000(또는 170,000) 전체가 빠지지 않음");
  setup({ today: "2026-10-31", buys: buysAll, sales: salesOct, costs: [cost()], allocations: allocs() });
  const sep = cmMonth("2026-09", salesOct); noFreight(); const sepBase = cmMonth("2026-09", salesOct);
  check(sep.cmNet, sepBase.cmNet, "9월(입고 직후) 공헌이익 차감 0 - 앞선 재고가 팔린 달");
  setup({ today: "2026-10-31", buys: buysAll, sales: salesOct, costs: [cost()], allocations: allocs() });
  const withVat = cmMonth("2026-10", salesOct);
  check(withVat.t.inVat, base.t.inVat, "공헌이익 쪽 매입세액엔 운송비 VAT 안 들어감(부가세 화면에서만)");
  const card = vm.runInContext("inboundFreightCardHtml", ctx)("2026-10");
  has(card, "입고 완료 · 판매분만 차감", "카드: 입고 완료 · 판매분만 차감");
  has(card, "재고원가로 남음", "카드: 재고원가 열");
}

console.log("\n=== 3. 입고 일부·초과 · 세트 · 판매자배송 · 이중 기록 방지 ===");
{
  const partial = [...buysBase,
    { id: "p1", date: "2026-09-14", product_id: G, qty: 200, warehouse: "쿠팡", po_id: PO16 },
    { id: "p2", date: "2026-09-20", product_id: G, qty: 130, warehouse: "쿠팡", po_id: PO16 }];   // 330 > 배분 320
  const r = setup({ today: "2026-09-25", buys: partial, sales: [], costs: [cost()], allocations: allocs() });
  check(r.records[0].allocs[0].receivedQty, 320, "그레이 입고 200+130 → 운송비는 배분 수량 320개까지만");
  check(r.records[0].stage, "PARTIAL_RECEIPT", "블랙 미입고 → 일부 입고");
  near(r.records[0].pendingSupply, 56667, "블랙 몫 56,667 은 입고 전 예상으로 남음");
  const setSales = [{ id: "s-set", date: "2026-09-15", product_id: SETG, qty: 5, amount: 5 * 36000, channel: "쿠팡 로켓그로스" }];
  const onlyNew = [{ id: "n1", date: "2026-09-14", product_id: G, qty: 320, warehouse: "쿠팡", po_id: PO16 }];
  const r2 = setup({ today: "2026-09-30", buys: onlyNew, sales: setSales, costs: [cost()], allocations: allocs() });
  check(r2.bySale.get("s-set").units, 10, "연동 세트 2개입 5건 → 낱개 10개분 배부");
  const ssSales = [{ id: "s-ss", date: "2026-09-15", product_id: G, qty: 5, amount: 99500, channel: "스마트스토어" }];
  const r3 = setup({ today: "2026-09-30", buys: onlyNew, sales: ssSales, costs: [cost()], allocations: allocs() });
  check(r3.bySale.size, 0, "직접배송 채널 판매는 쿠팡 입고분을 쓰지 않음");
  const before = [{ id: "s-early", date: "2026-09-13", product_id: G, qty: 5, amount: 99500, channel: "쿠팡 로켓그로스" }];
  const r4 = setup({ today: "2026-09-30", buys: onlyNew, sales: before, costs: [cost()], allocations: allocs() });
  check(r4.bySale.size, 0, "입고일(09-14) 이전 판매는 이번 트럭분을 쓰지 않음");
  const dup = [cost(), cost({ id: "fc-2", shipment_group_id: "other" })];
  const r5 = setup({ today: "2026-10-31", buys: buysAll, sales: salesOct, costs: dup, allocations: [...allocs(), ...allocs(113333, 56667, "fc-2")] });
  check(r5.records[1].allocs[0].receivedQty, 0, "같은 PO·상품이 두 기록에 걸려도 입고분은 첫 기록에만(운송비 두 번 방지)");
  const sumF = [...r5.bySale.values()].reduce((s, v) => s + v.supply, 0);
  near(sumF, 90 * 113333 / 320 + 35 * 56667 / 160, "이중 기록이 있어도 배부 합계는 한 번분");
}

console.log("\n=== 4. 실제 청구금액 교체 · 부가세 ===");
{
  const actual = cost({ basis: "ACTUAL", gross_amount: 198000, supply_amount: 180000, vat_amount: 18000,
    estimate_gross: 187000, estimate_supply: 170000, estimate_vat: 17000, invoice_date: "2026-09-16", carrier_invoice_ref: "INV-1" });
  const r = setup({ today: "2026-10-31", buys: buysAll, sales: salesOct, costs: [actual], allocations: allocs(120000, 60000) });
  const f = [...r.bySale.values()].reduce((s, v) => s + v.supply, 0);
  near(f, 90 * 375 + 35 * 375, "[핵심] 실제 180,000 → 개당 375로 교체(예상 354.17과 더하지 않음)");
  check([...r.bySale.values()].every(v => v.basis === "ACTUAL"), true, "배부 행 기준 = 실제");
  const card = vm.runInContext("inboundFreightCardHtml", ctx)("2026-10");
  has(card, "실제 청구", "카드: 실제 청구 구분"); has(card, "예상 ₩187,000은 교체됨(중복 반영 없음)", "카드: 예상값 교체 표시");
  const q3 = d => d >= "2026-07-01" && d <= "2026-09-30";
  const v3 = ctx.InboundFreight.vatRows([actual], q3), v4 = ctx.InboundFreight.vatRows([actual], d => d >= "2026-10-01");
  check([v3.actualVat, v3.actualSupply, v4.actualVat], [18000, 180000, 0], "[핵심] 매입 VAT 18,000 은 청구일(9/16) 분기에 한 번만");
  const est = ctx.InboundFreight.vatRows([cost()], q3);
  check([est.actualVat, est.estimateVat, est.estimateSupply], [0, 17000, 170000], "예상 17,000 은 합계 제외 · 따로 표시(공급가액 170,000 / VAT 17,000)");
}

console.log("\n=== 5. 입고 처리 화면 - 운송비 중복 기록 방지 ===");
{
  setup({ today: "2026-09-14", buys: buysBase, sales: [], costs: [cost()], allocations: allocs() });
  const root = { innerHTML: "" };
  const inputs = { "rc-date": { value: "2026-09-14" }, "btn-rc-save": { disabled: false } };
  const inserted = [];
  const rowsDom = [
    { dataset: { item: "poi-g", pid: G, cost: "8500", remain: "320" }, querySelector: () => ({ value: "320" }) },
    { dataset: { item: "poi-b", pid: B, cost: "8500", remain: "160" }, querySelector: () => ({ value: "160" }) },
  ];
  ctx.document = { getElementById: id => (id === "modal-root" ? root : inputs[id] || null), querySelectorAll: () => rowsDom };
  const q = t => ({ insert: rec => { inserted.push(t); return Promise.resolve({ error: null }); },
                    update: () => ({ eq: () => Promise.resolve({ error: null }) }) });
  ctx.sb = { from: q }; ctx.toast = () => {}; ctx.closeModal = () => {}; ctx.route = () => {};
  vm.runInContext(`poCache = [{ id: "${PO16}", po_no: "리버스-발주-2026-016", supplier: "리파코 주식회사", deliver_to: "쿠팡", freight_est: 187000 }];
    poItemCache = { "${PO16}": [{ id: "poi-g", product_id: "${G}", qty: 320, received_qty: 0, unit_cost: 8500 },
                                { id: "poi-b", product_id: "${B}", qty: 160, received_qty: 0, unit_cost: 8500 }] };`, ctx);
  vm.runInContext(`openReceiveModal("${PO16}")`, ctx);
  check(root.innerHTML.includes('id="rc-freight"'), false, "[핵심] 운송 묶음 기록이 있는 PO는 운송비 입력칸이 없음");
  has(root.innerHTML, "운송 묶음 기록 ₩187,000 (예상, VAT 포함)", "입고 화면: 운송 묶음 기록으로 반영된다고 표시");
  await vm.runInContext(`saveReceive("${PO16}")`, ctx);
  check(inserted, ["purchases"], "[핵심] 입고 확정 시 purchases 만 기록 · purchase_costs 운송비 없음(중복 방지)");
  // 운송 묶음 기록이 없는 일반 PO 는 기존 그대로
  noFreight(); inserted.length = 0; inputs["rc-freight"] = { value: "55,000" };
  vm.runInContext(`openReceiveModal("${PO16}")`, ctx);
  has(root.innerHTML, 'id="rc-freight"', "기록 없는 PO는 기존 운송비 입력칸 그대로");
  await vm.runInContext(`saveReceive("${PO16}")`, ctx);
  check(inserted, ["purchase_costs", "purchases"], "기록 없는 PO는 기존처럼 운송비 → purchase_costs");
  // 기록을 못 읽은 경우 - 예상 운송비 미리 채우지 않음
  ctx.__f = { bySale: new Map(), records: [], costs: [], error: "permission denied" }; vm.runInContext("erpFreight = globalThis.__f;", ctx);
  vm.runInContext(`openReceiveModal("${PO16}")`, ctx);
  check(/id="rc-freight"[^>]*value=""/.test(root.innerHTML), true, "기록을 못 읽으면 예상 운송비 187,000을 미리 채우지 않음");
  const card = vm.runInContext("inboundFreightCardHtml", ctx)("2026-09");
  has(card, "입고 운송비가 빠져 있어요", "기록을 못 읽으면 공헌이익 화면에 알림");
}

console.log("\n=== 6. 대체된 기록(합배송 → 단일 다품목 입고, 2026-09-11)은 합산 안 함 ===");
{
  // 옛 합배송 그룹 기록(먼저 생성, SUPERSEDED) + 새 단일 입고 기록(ACTIVE) - 같은 PO·같은 상품
  const oldC = cost({ id: "fc-old", status: "SUPERSEDED", superseded_by_freight_id: "fc-new", shipment_group_id: "e0eb258d-old" });
  const newC = cost({ id: "fc-new", status: "ACTIVE", shipment_group_id: "b28edc90-new" });
  const r = setup({ today: "2026-10-31", buys: buysAll, sales: salesOct, costs: [oldC, newC],
                    allocations: [...allocs(113333, 56667, "fc-old"), ...allocs(113333, 56667, "fc-new")] });
  check(r.records.map(x => x.cost.id), ["fc-new"], "[핵심] 계산 대상은 ACTIVE 기록 1건뿐");
  check(r.history.map(x => x.id), ["fc-old"], "대체된 기록은 이력으로만");
  const f = [...r.bySale.values()].reduce((s, v) => s + v.supply, 0);
  near(f, 90 * 113333 / 320 + 35 * 56667 / 160, "[핵심] 먼저 만든 대체 기록이 있어도 배부는 새 기록 기준 한 번분");
  const q3 = d => d >= "2026-07-01" && d <= "2026-09-30";
  const v = ctx.InboundFreight.vatRows([oldC, newC], q3);
  check([v.estimateCount, v.estimateVat, v.estimateSupply], [1, 17000, 170000], "[핵심] 부가세 예상도 ACTIVE 1건만(17,000 한 번)");
  const void1 = cost({ id: "fc-void", status: "VOID_PENDING_REBUILD" });
  const r2 = setup({ today: "2026-10-31", buys: buysAll, sales: salesOct, costs: [void1], allocations: allocs(113333, 56667, "fc-void") });
  check([r2.records.length, r2.bySale.size], [0, 0], "무효·재작성 대기 기록만 있으면 공헌이익 차감 0");
  setup({ today: "2026-10-31", buys: buysAll, sales: salesOct, costs: [oldC, newC], allocations: [...allocs(113333, 56667, "fc-old"), ...allocs(113333, 56667, "fc-new")] });
  const card = vm.runInContext("inboundFreightCardHtml", ctx)("2026-10");
  has(card, "이력 (합산 안 함)", "카드: 이력 구역");
  has(card, "대체됨", "카드: 대체됨 표시");
  has(card, "e0eb258d", "카드: 옛 합배송 묶음 id 이력");
  check((card.match(/₩187,000 \(VAT 포함\) =/g) || []).length, 1, "카드 본문의 결제 총액 187,000 은 한 번만(이력 줄은 별도)");
  check(vm.runInContext(`poFreightRecord("${PO16}")`, ctx).cost.id, "fc-new", "발주서·입고 처리는 ACTIVE 기록을 봄");
}

console.log("\n=== 7. [2026-09-12] 입고 취소 뒤 무효(VOID_PENDING_REBUILD)·검토 필요(NEEDS_REVIEW) 기록은 합산 안 함 ===");
{
  const nr = cost({ id: "fc-nr", status: "NEEDS_REVIEW", basis: "ACTUAL", carrier_invoice_ref: "INV-1", invoice_date: "2026-09-16",
                    shipment_group_id: "gnr-1234-x" });
  const r = setup({ today: "2026-10-31", buys: buysAll, sales: salesOct, costs: [nr], allocations: allocs(113333, 56667, "fc-nr") });
  check([r.records.length, r.bySale.size, r.history.map(x => x.id)], [0, 0, ["fc-nr"]], "[핵심] NEEDS_REVIEW 기록은 공헌이익 차감 0 · 이력으로만");
  const q3 = d => d >= "2026-07-01" && d <= "2026-09-30";
  const v = ctx.InboundFreight.vatRows([nr], q3);
  check([v.estimateCount, v.estimateVat], [0, 0], "[핵심] 부가세(예상)에도 안 들어감");
  check(ctx.InboundFreight.isActive(nr), false, "isActive = false");
  const card = vm.runInContext("inboundFreightCardHtml", ctx)("2026-10");
  has(card, "검토 필요 · 실제 운송비 연결(입고 취소)", "카드: 이력에 '검토 필요' 표시");
}

console.log(`\n=== 결과: ${failures ? `실패 ${failures}건` : "전체 통과"} ===`);
process.exit(failures ? 1 : 0);
