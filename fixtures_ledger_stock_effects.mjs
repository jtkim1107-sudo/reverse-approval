// fixtures_ledger_stock_effects.mjs
// ------------------------------------------------
// 2026-09-16 ERP 장부재고(매입−판매) 재고 흐름 검증(네트워크 0건). app.js 의 실제 loadErpBase 를 가짜 DB 로 실행해요.
// 취소·회수는 전용 표의 상품별 뷰 sales_cancel_stock_by_product 와 동기화 요약 sync_job_status('rg_ledger_cancel_status')만 읽어요.
//   1) 정산 취소(금전 환불)만으로는 재고 변화 0 · 뷰의 확정 재고 효과(승인된 WING_CANCEL·WING_RETURN)만 판매에서 되돌림 · 세트는 기준 EA
//   2) 회수 미확인(unknown_qty)이 있는 상품·세트는 확정 숫자가 아님 → '취소·반품 회수 확인 필요 · 회수 미확인 M개 · 원장상 N개(참고)'
//      · WING 실시간 재고가 있으면 그 값을 먼저 · 판매 입력은 확정 안 된 품목을 '충분'으로 판단하지 않음
//   3) (임시) 반품 재판매 판매는 정상 매입재고에서 빼지 않고 따로 셈 · 매출·원가는 그대로 · 회수 확정분과 겹치면 숨김
//   4) 뷰·요약을 못 읽거나 요약이 없음·실패·36시간 초과·형식 오류·기록 불완전이면 전체 '재고 계산 확인 필요'
//      · 기능 꺼짐(state DISABLED)은 실패가 아님 → '취소·회수 확인 기능 꺼짐'(확정값으로 안 씀) · 자동 수집 상태 카드도 실패로 안 봄
//   5) 반품 재판매 판매에는 입고 운임 배부 안 함 · 같은 자료로 다시 계산해도 값 같음
import { runLedger } from "./erp_ledger_harness.mjs";

const APP = new URL("./js/app.js", import.meta.url).pathname;
const FR = new URL("./js/inbound_freight.js", import.meta.url).pathname;
let n = 0; const fails = [];
const check = (label, got, want) => {
  n++; const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { console.log(`        기대=${JSON.stringify(want)}\n        실제=${JSON.stringify(got)}`); fails.push(label); }
};
const RG = "쿠팡 로켓그로스";
const products = [
  { id: "mat", code: "1M1N-001-02", name: "발판(그레이)", cost_price: 8500, tax_type: "과세", fee_rate: 11.88, unit_fee: null },
  { id: "d500", code: "1G1A-003-01", name: "제습제 500ml", cost_price: 5500, tax_type: "과세", fee_rate: 8.58, unit_fee: 1254 },
  { id: "d500s2", code: "1G1A-003-01-S2", name: "제습제 500ml 2개 세트", cost_price: null, set_parent_id: "d500", set_qty: 2, tax_type: "과세" },
  { id: "bin", code: "1M1A-013-01", name: "휴지통", cost_price: 5500, tax_type: "과세", fee_rate: 10, unit_fee: 1000 },
];
const purchases = [
  { id: "b1", date: "2026-08-27", product_id: "mat", qty: 240, warehouse: "쿠팡", unit_cost: 8500, created_at: "2026-08-27T00:00:00Z" },
  { id: "b2", date: "2026-08-24", product_id: "d500", qty: 40, warehouse: "쿠팡", unit_cost: 5500, created_at: "2026-08-24T00:00:00Z" },
  { id: "b3", date: "2026-08-24", product_id: "bin", qty: 100, warehouse: "쿠팡", unit_cost: 5500, created_at: "2026-08-24T00:00:00Z" },
];
const sale = (id, d, pid, key, qty, amount) => ({ id, date: d, channel: RG, product_id: pid, qty, amount, unit_price: amount / qty,
  memo: key.split("-")[1], external_key: key, created_by: "쿠팡자동동기화", created_at: `${d}T10:00:00Z`, unit_cost: null });
const sales = [
  sale("s1", "2026-09-02", "mat", "RG-1001-95936822309", 2, 37620), sale("s2", "2026-09-03", "bin", "RG-1002-95928210719", 1, 11900),
  sale("s3", "2026-09-04", "bin", "RG-1003-95928210719", 2, 23800), sale("s4", "2026-09-05", "bin", "RG-1004-95928210719", 1, 11900),
  sale("s5", "2026-09-06", "bin", "RG-1005-95928210719", 1, 11900), sale("s6", "2026-09-06", "bin", "RG-1006-95928210719", 1, 11900),
  sale("s7", "2026-09-01", "d500s2", "RG-1007-95928560705", 1, 23800), sale("s8", "2026-09-13", "mat", "RG-1008-96002628403", 2, 32820),
];
const vrow = (pid, o) => ({ product_id: pid, unknown_qty: 0, unknown_order_row_qty: 0, unknown_manual_total_day_qty: 0, unknown_unlinked_qty: 0, resale_unknown_qty: 0,
  stock_effect_qty: 0, recovered_qty: 0, ...o });
// 뷰(백엔드가 기록·연결한 결과): 발판 미확인 1 · 휴지통 출고 전 취소 1 + 회수 1 = 확정 2, 미확인 2 · 세트 출고 전 취소 1(기준 2 EA)
const VIEW = [vrow("mat", { unknown_qty: 1, unknown_order_row_qty: 1 }), vrow("bin", { unknown_qty: 2, unknown_order_row_qty: 2, stock_effect_qty: 2, recovered_qty: 1 }),
  vrow("d500s2", { stock_effect_qty: 1 })];
const FRESH = new Date(Date.now() - 2 * 3600000).toISOString();
const job = (extra = {}, detail = {}) => [{ job_name: "rg_ledger_cancel_status", last_success_at: FRESH, last_attempt_at: FRESH, last_error: null,
  consecutive_failures: 0, detail: { version: 3, state: "OK", writes_enabled: true, complete: true, order_row: { rows: 5, qty: 6 },
    manual_total_day: { rows: 0, qty: 0 }, unlinked_order: { rows: 0, qty: 0 }, unknown_qty: 3, ...detail }, ...extra }];
const DISABLED = { version: 3, state: "DISABLED", generated_at: FRESH, writes_enabled: false, complete: false };
const jobDisabled = (extra = {}) => [{ job_name: "rg_ledger_cancel_status", last_success_at: FRESH, last_attempt_at: FRESH, last_error: null,
  consecutive_failures: 0, detail: DISABLED, ...extra }];
const channels = [{ name: RG, fee_rate: 0, ship_fee: 0, unit_fee: 0, ship_type: "풀필먼트" }];
const roles = [{ vendor_item_id: "96002628403", product_id: "mat", role: "RESALE_RETURN", active: true }];
const tables = { products, purchases, sales, purchase_costs: [], sales_channels: channels, stock_transfers: [], suppliers: [], inbound_freight_costs: [],
  inbound_freight_allocations: [], vendor_item_roles: roles, sales_cancel_stock_by_product: VIEW, sync_job_status: job() };

console.log("\n[1] 확정 재고 효과만 되돌림 · 정산 취소만으로는 0");
let { api, base } = await runLedger(APP, FR, tables);
let st = api.stock();
check("발판: 정산 취소(미확인 1)는 되돌리지 않음 → 판매 2 그대로 · 반품 재판매 2 따로 · 240−2 = 238", [st.mat.sold, st.mat.resaleSold, st.mat.stock], [2, 2, 238]);
check("휴지통: 판매 6 − 확정 효과 2 = 4 → 96 · 회수분 1", [st.bin.sold, st.bin.stock, st.bin.recoveredQty], [4, 96, 1]);
check("세트 확정 효과 1 → 기준상품 2 EA 되돌림 → 500ml 40", [st.d500.sold, st.d500.stock], [0, 40]);

console.log("\n[2] 회수 미확인 → 확정 숫자 아님");
check("발판·휴지통은 '취소·반품 회수 확인 필요'", [st.mat.recoveryUnknownQty, st.bin.recoveryUnknownQty, Boolean(api.checkOf("mat")), Boolean(api.checkOf("bin"))], [1, 2, true, true]);
check("선택창 문구(휴지통)", api.label("bin"), "취소·반품 회수 확인 필요 · 회수 미확인 2개 · 원장상 96개(참고)");
check("선택창에 확정 숫자처럼 '재고 N' 없음", [/^재고 \d/.test(api.label("bin")), /^재고 \d/.test(api.label("mat"))], [false, false]);
check("확정 상품(제습제·세트)은 숫자", [api.label("d500"), api.label("d500s2")], ["재고 40", "20세트 가능"]);
api.setLive({ bin: 288, d500: 22 });
check("WING 실시간 재고 먼저", [api.label("bin"), api.label("d500")],
      ["쿠팡 실재고 288개(WING) · 취소·반품 회수 확인 필요 · 회수 미확인 2개 · 원장상 96개(참고)", "쿠팡 실재고 22개(WING)"]);
check("판매 입력: 확정 안 된 품목은 이유가 있어 '충분' 판단 안 함", [Boolean(api.checkOf("bin")), api.checkOf("d500")], [true, null]);
const setFlag = await runLedger(APP, FR, { ...tables, sales_cancel_stock_by_product: [vrow("d500", { unknown_qty: 1, unknown_manual_total_day_qty: 1 })] });
check("기준상품 미확인(합계일) 1 → 세트도 확정 아님", [setFlag.api.stock().d500.recoveryUnknownQty, setFlag.api.label("d500s2")],
      [1, "취소·반품 회수 확인 필요 · 회수 미확인 1개 · 원장상 19세트(참고)"]);
const setUnknown = await runLedger(APP, FR, { ...tables, sales_cancel_stock_by_product: [vrow("d500s2", { unknown_qty: 1, unknown_order_row_qty: 1 })] });
check("세트 상품 주문의 미확인 1 → 기준상품 2 EA 미확인", setUnknown.api.stock().d500.recoveryUnknownQty, 2);
const unl = await runLedger(APP, FR, { ...tables, sales_cancel_stock_by_product: [vrow("d500", { unknown_qty: 2, unknown_unlinked_qty: 2 })] });
check("원장에 없는 주문의 취소(UNLINKED_ORDER) 미확인 2 → 확정 아님 · 원장 판매(세트 1 = 2 EA)는 그대로", [unl.api.stock().d500.sold, unl.api.label("d500")],
      [2, "취소·반품 회수 확인 필요 · 회수 미확인 2개 · 원장상 38개(참고)"]);

console.log("\n[3] 공헌이익은 그대로 · 반품 재판매 임시 처리");
const m = api.monthCm(base.sales, "2026-09", "2026-09-15");
check("반품 재판매 판매 원가 17,000 그대로 · 취소된 주문 행도 기존 계산(참고값)에 그대로", [m.per.s8.cost, m.per.s1.cost], [17000, 17000]);
check("loadErpBase 가 돌려주는 매출 목록 그대로", base.sales.map(s => s.id), sales.map(s => s.id));
const overlap = await runLedger(APP, FR, { ...tables, sales_cancel_stock_by_product: [vrow("mat", { stock_effect_qty: 1, recovered_qty: 1 })] });
check("반품 재판매 역할 상품에 회수 확정분 → 겹침으로 숨김", Boolean(overlap.api.checkOf("mat")), true);

console.log("\n[4] 원천을 믿을 수 없으면 전체 숨김");
const cases = [["요약 없음", { sync_job_status: [] }], ["최근 실패", { sync_job_status: job({ last_error: "ValueError", last_attempt_at: new Date().toISOString() }) }],
  ["오래됨(40시간)", { sync_job_status: job({ last_success_at: new Date(Date.now() - 40 * 3600000).toISOString() }) }],
  ["형식 오류(옛 버전 2)", { sync_job_status: job({}, { version: 2 }) }], ["상태 칸 없음", { sync_job_status: job({}, { state: undefined }) }],
  ["OK 인데 쓰기 꺼짐(형식 오류)", { sync_job_status: job({}, { writes_enabled: false }) }],
  ["기록 불완전(원천 변경·미기록)", { sync_job_status: job({}, { complete: false }) }],
  ["모르는 상태 값", { sync_job_status: job({}, { state: "PAUSED" }) }]];
for (const [label, patch] of cases) {
  const r = await runLedger(APP, FR, { ...tables, ...patch });
  check(`취소 자료 ${label} → 재고 계산 확인 필요`, [String(r.api.stockCheck()).startsWith("취소 자료"), r.api.label("d500")], [true, "재고 계산 확인 필요"]);
}
for (const [t, label] of [["sales_cancel_stock_by_product", "취소·회수 기록"], ["sync_job_status", "취소 자료"], ["vendor_item_roles", "반품 재판매 SKU"], ["sales", "매출"]]) {
  const r = await runLedger(APP, FR, tables, { errors: { [t]: "permission denied" } });
  check(`${label} 조회 실패 → 재고 계산 확인 필요`, [r.api.stockCheck(), r.api.label("d500")], [`${label}: permission denied`, "재고 계산 확인 필요"]);
}

console.log("\n[4b] 기능 꺼짐(DISABLED) - 실패 아님 · 확정값으로 안 씀");
const dis = await runLedger(APP, FR, { ...tables, sync_job_status: jobDisabled() });
check("꺼짐 → 이유 '취소·회수 확인 기능 꺼짐'(실패·재고 계산 확인 필요 아님)", [dis.api.stockCheck(), dis.api.label("d500"), dis.api.label("bin")],
      ["취소·회수 확인 기능 꺼짐", "취소·회수 확인 기능 꺼짐 · 원장상 40개(참고)", "취소·회수 확인 기능 꺼짐 · 원장상 96개(참고)"]);
check("꺼짐 → 선택창에 '재고 N' 확정 숫자 없음 · 세트도", [/^재고 \d|세트 가능$/.test(dis.api.label("d500")), dis.api.label("d500s2")],
      [false, "취소·회수 확인 기능 꺼짐 · 원장상 20세트(참고)"]);
dis.api.setLive({ d500: 22 });
check("꺼짐 + WING 실시간 재고 → 실재고 먼저", dis.api.label("d500"), "쿠팡 실재고 22개(WING) · 취소·회수 확인 기능 꺼짐 · 원장상 40개(참고)");
check("꺼짐 → 판매 입력은 '충분' 판단 안 함(모든 사입 품목 이유 있음)", [dis.api.checkOf("d500"), dis.api.checkOf("mat")],
      ["취소·회수 확인 기능 꺼짐", "취소·회수 확인 기능 꺼짐"]);
for (const [label, patch, opts] of [
  ["꺼짐인데 오래됨(40시간)", { sync_job_status: jobDisabled({ last_success_at: new Date(Date.now() - 40 * 3600000).toISOString() }) }],
  ["꺼짐 뒤 최근 실패", { sync_job_status: jobDisabled({ last_error: "RuntimeError: 503", last_attempt_at: new Date().toISOString() }) }],
  ["꺼짐 + 뷰 조회 실패", { sync_job_status: jobDisabled() }, { errors: { sales_cancel_stock_by_product: "permission denied" } }],
  ["꺼짐 + 버전 틀림", { sync_job_status: jobDisabled({ detail: { ...DISABLED, version: 2 } }) }]]) {
  const r = await runLedger(APP, FR, { ...tables, ...patch }, opts);
  check(`${label} → 재고 계산 확인 필요(fail-closed)`, r.api.label("d500"), "재고 계산 확인 필요");
}

console.log("\n[5] 입고 운임 · 다시 계산");
const fr = { ...tables, sales_cancel_stock_by_product: [],
  purchases: [...purchases, { id: "b4", date: "2026-09-11", product_id: "mat", qty: 320, warehouse: "쿠팡", unit_cost: 8500, po_id: "po11", created_at: "2026-09-11T00:00:00Z" }],
  sales: [sale("m1", "2026-09-12", "mat", "RG-2001-95936822309", 240, 240 * 18810), sale("m2", "2026-09-13", "mat", "RG-2002-96002628403", 1, 16410),
    sale("m3", "2026-09-14", "mat", "RG-2003-95936822309", 1, 18810)],
  inbound_freight_costs: [{ id: "fc1", status: "ACTIVE", basis: "ACTUAL", shipment_group_id: "g1", purchase_order_id: "po11", supply_amount: 320000, created_at: "2026-09-11T00:00:00Z" }],
  inbound_freight_allocations: [{ id: "a1", freight_cost_id: "fc1", product_id: "mat", qty: 320, pallet_count: 4, allocated_supply: 320000, sort_order: 1 }] };
({ api, base } = await runLedger(APP, FR, fr));
const bySale = api.freight().bySale;
check("반품 재판매 m2 운임 없음 · 정상 m3 트럭 입고분 1,000원", [bySale.has("m2"), bySale.get("m3") && bySale.get("m3").supply], [false, 1000]);
const a1 = (await runLedger(APP, FR, tables)).api.stock(), a2 = (await runLedger(APP, FR, tables)).api.stock();
check("같은 자료로 두 번 계산해도 같음", JSON.stringify(a1) === JSON.stringify(a2), true);

console.log(fails.length ? `\n실패 ${fails.length}/${n}: ${fails.join(", ")}` : `\n전부 통과 ${n}/${n}`);
process.exit(fails.length ? 1 : 0);
