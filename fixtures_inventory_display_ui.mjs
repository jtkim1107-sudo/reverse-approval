// fixtures_inventory_display_ui.mjs - 공유재고 대표 1줄 표시(js/inventory_display.js + app.js 재고·발주 표·상세·대시보드) 검증
// 2026-09-24 아가드 1개(1K1A-018-01, SKU 95928260688) / 2개 세트(-S2, 95928260692) / 3개 세트(-S3, 95928260691)가 세 줄로
// 보이고 요약 숫자도 세 번 세지던 문제. 서버 display(inventory_display_groups.py) 모양 그대로의 가짜 응답 - 네트워크·DB 없음.
import { readFileSync } from "fs";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
let failures = 0;
const check = (a, e, label) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) failures++;
  console.log(`${ok ? "  OK " : "  FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(a)}, 기대=${JSON.stringify(e)})`}`);
};
const plain = h => String(h).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

const ctx = vm.createContext({ console, Intl, Date, Map, Set, JSON, Number, String, Array, Object, Promise });
vm.runInContext(read("./js/erp_ui.js"), ctx);
vm.runInContext(read("./js/erp_dashboard.js"), ctx);
vm.runInContext(read("./js/inventory_display.js"), ctx);
const X = ctx.InventoryDisplay;

// --- 운영 모양의 가짜 서버 응답 ---
const AG = "b23e501b-766a-479a-b785-906ff94fcb45";
const blocked = { automation_blocked: true, automation_status: "LOGISTICS_INCOMPLETE", automation_label: "물류정보 입력 필요" };
const A1 = { product_id: AG, vendor_item_id: "95928260688", product_name: "아가드 구름목욕시간 제로 대팩", decision: "ORDER_NOW", live_stock: 127, avg_daily_sales: 8.366,
  shared_inventory: { role: "base", base_product_id: AG, base_vendor_item_id: "95928260688" }, reference_shortage_ea: 49, ...blocked };
const A2 = { product_id: "1f9cddd3", vendor_item_id: "95928260692", product_name: "아가드 구름목욕시간 제로 대팩", decision: "ORDER_NOW", live_stock: 63, avg_daily_sales: 0.167,
  shared_inventory: { role: "child", set_qty: 2, base_product_id: AG, base_vendor_item_id: "95928260688", base_product_name: "아가드" }, ...blocked };
const A3 = { product_id: "10c1b1fc", vendor_item_id: "95928260691", product_name: "아가드 구름목욕시간 제로 대팩", decision: "ORDER_NOW", live_stock: 42, avg_daily_sales: 0.233,
  shared_inventory: { role: "child", set_qty: 3, base_product_id: AG, base_vendor_item_id: "95928260688", base_product_name: "아가드" }, ...blocked };
const N1 = { product_id: "pid-n", vendor_item_id: "70000000001", product_name: "일반 상품", decision: "OK", live_stock: 50, avg_daily_sales: 1, automation_blocked: false };
const R1 = { product_id: "pid-r", vendor_item_id: "80000000001", product_name: "독서대", decision: "ORDER_SOON", live_stock: 9, avg_daily_sales: 1, automation_blocked: false };
const R2 = { product_id: "pid-r", vendor_item_id: "80000000002", product_name: "독서대", decision: "ORDER_SOON", live_stock: 7, avg_daily_sales: 1, automation_blocked: false };
const member = (d, role, set_qty) => ({ product_id: d.product_id, vendor_item_id: d.vendor_item_id, live_stock: d.live_stock, avg_daily_sales: d.avg_daily_sales,
  decision: d.decision, automation_blocked: d.automation_blocked, automation_label: d.automation_label, role, set_qty });
const DISPLAY = { version: 1, warnings: [], row_count: 6, group_count: 4, automation_blocked_count: 1,
  summary: { ORDER_NOW: 1, ORDER_SOON: 2, AWAITING_INBOUND: 0, OK: 1, DATA_CHECK: 0, RESTOCK_EXCLUDED: 0 },
  rows: [
    { group_key: `shared:${AG}`, vendor_item_id: "95928260688", product_id: AG, decision: "ORDER_NOW", automation_blocked: true,
      members: [member(A1, "base", 1), member(A2, "child", 2), member(A3, "child", 3)], divergent_members: [] },
    { group_key: "sku:70000000001:pid-n", vendor_item_id: "70000000001", product_id: "pid-n", decision: "OK", automation_blocked: false, members: [], divergent_members: [] },
    { group_key: "sku:80000000001:pid-r", vendor_item_id: "80000000001", product_id: "pid-r", decision: "ORDER_SOON", automation_blocked: false, members: [], divergent_members: [] },
    { group_key: "sku:80000000002:pid-r", vendor_item_id: "80000000002", product_id: "pid-r", decision: "ORDER_SOON", automation_blocked: false, members: [], divergent_members: [] },
  ] };
const DECISIONS = [A2, N1, A1, R2, A3, R1];   // 서버 순서와 무관해야 함
const SKU_SUMMARY = { ORDER_NOW: 3, ORDER_SOON: 2, AWAITING_INBOUND: 0, OK: 1, DATA_CHECK: 0, RESTOCK_EXCLUDED: 0 };
const clone = o => JSON.parse(JSON.stringify(o));

console.log("=== 1. InventoryDisplay.entries - 대표 1줄 ===");
let ents = X.entries(DECISIONS, DISPLAY);
check(ents.map(e => e.d.vendor_item_id), ["95928260688", "70000000001", "80000000001", "80000000002"], "아가드 3 SKU → 기준상품 1줄 · 독서대 2 SKU 는 두 줄 그대로");
check(ents[0].d === A1, true, "대표 줄은 서버 decisions 의 기준상품 행 객체 그대로(복사·재계산 없음)");
check(ents[0].members.map(m => [m.vendor_item_id, m.live_stock]), [["95928260688", 127], ["95928260692", 63], ["95928260691", 42]], "구성 SKU 값 그대로(더하지 않음)");
check(X.counts({ display: DISPLAY, summary: SKU_SUMMARY }, ents), { summary: DISPLAY.summary, blocked: 1 }, "요약·자동화 막힘 = 서버 묶음 기준(지금 발주 1, 막힘 1)");

console.log("\n=== 2. 못 쓰는 display → 예전 표시(null) ===");
check(X.entries(DECISIONS, null), null, "display 없음(옛 서버)");
check(X.entries(DECISIONS, { ...DISPLAY, version: 2 }), null, "모르는 버전");
check(X.entries(DECISIONS, { version: 1, error: "boom" }), null, "서버 묶음 계산 실패");
check(X.entries(DECISIONS.filter(d => d !== A1), DISPLAY), null, "대표 행이 decisions 에 없음 → 지어내지 않음");
const wrongPid = clone(DISPLAY); wrongPid.rows[0].product_id = "other";
check(X.entries(DECISIONS, wrongPid), null, "SKU 는 같은데 product_id 가 다르면 → 예전 표시");
check(X.counts({ summary: SKU_SUMMARY }, null), { summary: SKU_SUMMARY, blocked: null }, "fallback 요약은 서버 SKU summary 그대로");

console.log("\n=== 3. 목록 구성 줄 · 상세 표 ===");
const line = plain(X.membersLineHtml(ents[0]));
check([line.includes("공유재고 구성: 1개 · 2개 세트 · 3개 세트"), line.includes("상태 다름")], [true, false], "목록: 구성 1개 · 2개 세트 · 3개 세트");
check(X.membersLineHtml(ents[1]), "", "일반 상품엔 구성 줄 없음");
const divergent = clone(DISPLAY); divergent.rows[0].divergent_members = ["95928260692"];
check(plain(X.membersLineHtml(X.entries(DECISIONS, divergent)[0])).includes("구성 1개 상태 다름"), true, "세트만 상태가 다르면 목록에서 알림");
const det = X.membersDetailHtml(ents[0]);
const dp = plain(det);
check([dp.includes("95928260688"), dp.includes("95928260692"), dp.includes("95928260691")], [true, true, true], "상세: SKU 3개 모두 보존");
check([dp.includes("127개"), dp.includes("63세트"), dp.includes("42세트"), dp.includes("더하지 않아요")], [true, true, true, true], "상세: 기준은 개·세트는 세트 단위, 합계 없음");
check([dp.includes("190"), dp.includes("232")], [false, false], "상세에 재고 합계(127+63, 127+63+42) 같은 숫자 없음");
check(X.membersDetailHtml(ents[1]), "", "일반 상품 상세엔 구성 표 없음");
check(X.entryForDecision({ decisions: DECISIONS, display: DISPLAY }, A1) === ents[0] || X.entryForDecision({ decisions: DECISIONS, display: DISPLAY }, A1).d === A1, true, "상세 모달: 기준상품 행으로 묶음 찾기");
check(X.entryForDecision({ decisions: DECISIONS, display: DISPLAY }, A2), null, "세트 행으로는 묶음 없음(세트 상세는 예전 그대로)");

console.log("\n=== 4. 재고·발주 화면 실제 렌더(app.js viewInventoryDecisions 추출) ===");
const src = read("./js/app.js");
const grab = (re, name) => { const m = src.match(re); if (!m) throw new Error(`${name} not found`); return m[0]; };
const viewSrc = grab(/async function viewInventoryDecisions\(\) \{[\s\S]*?\n\}\n/, "viewInventoryDecisions");
const metaSrc = grab(/const INVENTORY_DECISION_META = \{[\s\S]*?\n\};/, "INVENTORY_DECISION_META");
vm.runInContext(`${metaSrc.replace("const INVENTORY_DECISION_META", "var INVENTORY_DECISION_META")}
  var inventoryDecisionFilter = null, inventoryDecisionsCache = null, inventoryVatStatus = null, sb = { from() { throw new Error("DB 호출 금지(fixture)"); } };
  var esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  var fmt = n => Number(n || 0).toLocaleString("ko-KR");
  var fetchInventoryDecisions = async () => { throw new Error("네트워크 호출 금지(fixture)"); };
  var inventoryCacheHealthHtml = async () => "";
  var ProcurementInput = { fetchVatStatus: async () => ({}), vatNeedsAck: () => false, vatChipHtml: () => "" };
  var invVatOf = () => null;
  var loadInventoryProductIndex = async () => ({});
  var sortInventoryDecisionsByBrand = list => [...list].sort((a, b) => String(a.vendor_item_id).localeCompare(String(b.vendor_item_id)));
  var inventoryStockText = d => String(d.live_stock), inventoryVelocityText = d => String(d.avg_daily_sales);
  var inventoryOutlookText = () => "-", inventoryIncomingText = () => "-", inventoryReferenceShortageHtml = d => d.reference_shortage_ea ? "참고값 " + d.reference_shortage_ea + "개" : "-";
  ${viewSrc}`, ctx);
const render = async result => { ctx.inventoryDecisionsCache = result; ctx.inventoryDecisionFilter = null; return ctx.viewInventoryDecisions(); };
const rowCount = h => (h.match(/<tr data-clickable/g) || []).length;
const stat = (h, label) => { const m = plain(h).match(new RegExp(`${label} (\\d+)`)); return m ? Number(m[1]) : null; };

let html = await render({ ok: true, decisions: DECISIONS, summary: SKU_SUMMARY, display: DISPLAY, calculatedAt: null });
check(rowCount(html), 4, "[핵심] 표 4줄(아가드 1 + 일반 1 + 독서대 2) - 아가드 세 줄 아님");
check([html.includes("95928260692"), html.includes("95928260691")].map(Boolean), [true, true], "세트 SKU 는 구성 줄(툴팁)로 보존");
check((plain(html).match(/아가드 구름목욕시간 제로 대팩/g) || []).length, 1, "아가드 상품명은 한 번만");
check([stat(html, "지금 발주"), stat(html, "곧 발주"), stat(html, "정상"), stat(html, "자동화 막힘")], [1, 2, 1, 1], "[핵심] 요약: 지금 발주 1 · 곧 발주 2 · 정상 1 · 자동화 막힘 1(3 아님)");
check(plain(html).includes("공유재고 구성: 1개 · 2개 세트 · 3개 세트"), true, "아가드 줄에 구성 표시");
ctx.inventoryDecisionFilter = "ORDER_NOW";
ctx.inventoryDecisionsCache = { ok: true, decisions: DECISIONS, summary: SKU_SUMMARY, display: DISPLAY };
html = await ctx.viewInventoryDecisions();
check(rowCount(html), 1, "지금 발주 필터 → 1줄");
const shuffled = [A3, R1, N1, A2, R2, A1];
html = await render({ ok: true, decisions: shuffled, summary: SKU_SUMMARY, display: DISPLAY });
check([rowCount(html), stat(html, "지금 발주")], [4, 1], "서버 decisions 순서가 달라도 같은 결과");
html = await render({ ok: true, decisions: DECISIONS, summary: SKU_SUMMARY, display: null });
check([rowCount(html), stat(html, "지금 발주"), stat(html, "자동화 막힘")], [6, 3, 3], "display 없는 옛 서버 → 예전처럼 SKU 6줄·3(회귀 없음)");

console.log("\n=== 5. 대시보드 재고 카드 ===");
const D = ctx.ErpDashboard;
const reps = ents.map(e => e.d);
const st = D.stockModel(reps, { blocked: DISPLAY.automation_blocked_count });
check([st.orderNow, st.soon, st.blocked, st.total], [1, 2, 1, 4], "대시보드: 지금 발주 1 · 자동화 차단 1 · 전체 4");
check(st.top.filter(d => String(d.product_name).startsWith("아가드")).length, 1, "위험 상품 목록에 아가드는 한 번만");
check(D.stockModel(DECISIONS).orderNow, 3, "opts 없이 부르면 예전과 같음(SKU 기준)");
const dashCall = grab(/const invEntries = [\s\S]*?const model = ErpDashboard\.stockModel\([\s\S]*?\);\n/, "dashboard stockModel wiring");
check([dashCall.includes("InventoryDisplay.entries(inv.v.decisions, inv.v.display)"),
       /stockModel\(invEntries \? invEntries\.map\(e => e\.d\) : inv\.v\.decisions,\s*invEntries \? \{ blocked: inv\.v\.display\.automation_blocked_count \}/.test(dashCall)],
      [true, true], "app.js 대시보드가 display 대표 행 + 묶음 막힘 수로 셈");
const freeBase = { ...A1, automation_blocked: false, automation_label: null };
check(D.stockModel([freeBase, N1], { blocked: 1 }).blocked, 1, "기준상품은 안 막혔고 세트만 막힌 묶음 → 대시보드 자동화 차단 1(서버 묶음 값)");
check(src.includes("display: body.display || null"), true, "fetchInventoryDecisions 가 display 를 넘김");
check(/isBase && globalThis\.InventoryDisplay \? InventoryDisplay\.membersDetailHtml\(InventoryDisplay\.entryForDecision\(inventoryDecisionsCache, d\)\)/.test(src), true, "상세 모달에 구성 SKU 표 배선");
const idx = read("./index.html");
check(idx.indexOf("js/inventory_display.js") > 0 && idx.indexOf("js/inventory_display.js") < idx.indexOf("js/app.js"), true, "index.html 이 app.js 보다 먼저 로드");

console.log(failures ? `\n❌ ${failures}건 실패` : "\n✅ 전부 통과");
process.exit(failures ? 1 : 0);
