// fixtures_resale_return_ui.mjs
// ------------------------------------------------
// 2026-09-14 [사용자 확정] 반품 재판매 SKU 화면(js/resale_return.js + app.js 연결) - 네트워크 0건, DB 는 가짜.
//   1) [핵심] 서버 스위치 꺼짐(새 필드 없음) → 재고 칸 문구가 운영 app.js(935c5ed)와 같음 · 공헌이익 계산 함수는 한 글자도 안 바뀜
//   2) 정상 SKU 행: 정상 286 · 반품 2 · 공유재고 합계 288 따로 표시 · 확인 불가 반품 SKU 안내
//   3) 반품 SKU 행: 기준 SKU 판단을 따른다는 안내 · 자기 재고는 참고
//   4) 원가환입 참고 카드는 이번 배포에 없음 - 공헌이익 화면(viewProfit) 운영과 동일
//   5) index.html 에 resale_return.js 가 app.js 보다 먼저
import { readFileSync } from "fs";
import { execSync } from "child_process";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
let fails = 0;
const check = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(got)}, 기대=${JSON.stringify(want)})`}`);
  if (!ok) fails++;
};
const BASE_REV = "935c5ed";   // 2026-09-13 운영 반영본(origin/main)
const src = read("./js/app.js");
const baseSrc = execSync(`git -C "${new URL(".", import.meta.url).pathname}" show ${BASE_REV}:js/app.js`, { encoding: "utf8", maxBuffer: 64 << 20 });

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(read("./js/resale_return.js"), ctx);
const RR = ctx.ResaleReturn;

function extract(source, name, env) {
  const m = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`${name} not found`);
  const c = { ...env };
  vm.createContext(c);
  vm.runInContext(`${m[0]}; this.__fn = ${name};`, c);
  return { fn: c.__fn, text: m[0] };
}
const fmt = eval(src.match(/const fmt = [^;]+;/)[0].replace("const fmt = ", ""));
const envNew = { fmt, ResaleReturn: RR };
const unitNew = extract(src, "inventoryStockUnit", envNew).fn;
const snapNew = extract(src, "inventorySnapshotRef", envNew).fn;
const stockNew = extract(src, "inventoryStockText", { ...envNew, inventoryStockUnit: unitNew, inventorySnapshotRef: snapNew }).fn;
const envOld = { fmt };
const stockOld = extract(baseSrc, "inventoryStockText", { ...envOld, inventoryStockUnit: extract(baseSrc, "inventoryStockUnit", envOld).fn,
  inventorySnapshotRef: extract(baseSrc, "inventorySnapshotRef", envOld).fn }).fn;

console.log("=== 1) 스위치 꺼짐 = 지금 화면 ===");
const offRows = [
  { live_stock: 286 }, { live_stock: 0 }, { live_stock: null, snapshot_stock: 280 }, { live_stock: null },
  { live_stock: 21, shared_inventory: { role: "child", snapshot_available_sets: 20 } }, { live_stock: 2, decision: "ORDER_NOW" },
];
check(offRows.map(stockNew), offRows.map(stockOld), "[핵심] 새 필드 없는 행의 재고 문구가 운영 app.js 와 같음(6가지 모양)");
for (const fn of ["computeCmOfMonth", "cmOfSale", "sumCM"]) {
  check(extract(src, fn, {}).text, extract(baseSrc, fn, {}).text, `[핵심] 공헌이익 계산 함수 ${fn} 는 운영과 한 글자도 같음(원가환입을 더하지 않음)`);
}
const outNew = extract(src, "inventoryOutlookText", envNew).fn, outOld = extract(baseSrc, "inventoryOutlookText", envOld).fn;
const outRows = [{ decision: "DATA_CHECK" }, { decision: "ORDER_NOW", live_stock: 0 }, { decision: "ORDER_NOW", live_stock: 0, incoming_qty: 5 },
  { decision: "OK", live_stock: 100, days_of_stock_now: 12.3 }, { decision: "RESTOCK_EXCLUDED" }, { decision: "OK", live_stock: 3 }];
check(outRows.map(outNew), outRows.map(outOld), "[핵심] 새 필드 없는 행의 재고전망 문구가 운영 app.js 와 같음");
check([outNew({ decision: "ORDER_NOW", live_stock: 0, days_of_stock_now: 28.8, resale_pool: { role: "resale" } }),
       outNew({ decision: "DATA_CHECK", live_stock: 0, resale_pool: { role: "resale" } })], ["공유재고 약 28.8일", "확인 필요"],
  "반품 SKU 행(자기 재고 0)은 '품절'이 아니라 공유재고 전망");
check([RR.stockSuffix({ live_stock: 5 }), RR.detailRowsHtml({ live_stock: 5 }), RR.resaleNoticeHtml({})],
  ["", "", ""], "새 필드가 없으면 아무것도 그리지 않음");

console.log("\n=== 2) 정상 SKU 행 공유재고 ===");
const D = (qty, basis) => ({ qty, basis, reason: null });
const base = { vendor_item_id: "95936822309", live_stock: 288, resale_pool: { role: "base", status: "POOLED" },
  stock_breakdown: { normal: 286, resale: 2, total: 288, resale_by_vendor_item: { "96002628403": 2, "95993892715": 0, "96033687251": 0 }, resale_unknown: [],
    resale_detail: { "96002628403": D(2, "PRESENT"), "95993892715": D(0, "PRESENT"), "96033687251": D(0, "ABSENT_ZERO") },
    snapshot: { complete: true, reason: null, pages: 2, rows: 29 } } };
check(stockNew(base), "288개 (정상 286 + 반품 2)", "[핵심] 목록: 합계 288 · 정상 286 + 반품 2 (96033687251 없음=0 은 확인 불가 아님)");
const rows = RR.detailRowsHtml(base);
check(["정상 SKU 재고</td><td class=\"num\">286개", "반품 재판매 재고", "<b>288개</b>", "96033687251 0개(재고 목록에 없음)", "96002628403 2개",
  "확인 불가"].map(t => rows.includes(t)), [true, true, true, true, true, false],
  "[핵심] 상세: 정상·반품·합계 + SKU 별(96033687251 은 '0개(재고 목록에 없음)') · 확인 불가 문구 없음");
const zero = { ...base, live_stock: 286, stock_breakdown: { ...base.stock_breakdown, resale: 0, total: 286,
  resale_detail: { "96002628403": D(0, "ABSENT_ZERO"), "95993892715": D(0, "PRESENT"), "96033687251": D(0, "ABSENT_ZERO") } } };
check([stockNew(zero), RR.detailRowsHtml(zero).includes("반품 재판매 재고") && RR.detailRowsHtml(zero).includes(">0개</td>")],
  ["286개 (정상 286 + 반품 0)", true], "[핵심] 반품 재고가 모두 0/없음 → '반품 재판매 재고 0' 표시");
const unk = { ...base, live_stock: 286, resale_pool: { role: "base", status: "RESALE_PARTIAL_UNKNOWN" },
  stock_breakdown: { normal: 286, resale: 0, total: 286, resale_by_vendor_item: {}, resale_unknown: ["95993892715", "96002628403", "96033687251"],
    resale_detail: { "96002628403": { qty: null, basis: "UNKNOWN", reason: "FETCH_FAILED:HTTPError" } }, snapshot: { complete: false, reason: "FETCH_FAILED:HTTPError" } } };
check([stockNew(unk), RR.detailRowsHtml(unk).includes("반품 재판매 재고 확인 불가(전체 재고 조회 실패)")], ["286개 (정상 286 + 반품 0 · 반품 재고 확인 불가)", true],
  "[핵심] 전체 조회 실패만 '반품 재고 확인 불가'(사유 표시)");
check(stockNew({ live_stock: null, snapshot_stock: 280, resale_pool: { role: "base", status: "NORMAL_UNKNOWN" },
  stock_breakdown: { normal: null, resale: null, total: null, resale_unknown: [] } }), "확인 불가 · 스냅샷 280개",
  "[핵심] 정상 SKU 조회 실패면 합계를 만들지 않고 지금처럼 '확인 불가'");

console.log("\n=== 3) 반품 SKU 행 ===");
const resale = { vendor_item_id: "96002628403", live_stock: 2, resale_pool: { role: "resale", base_vendor_item_id: "95936822309", own_stock: 2,
  offer_condition: "PACKAGE_DAMAGED", total: 288, status: "POOLED" } };
check(stockNew(resale), "2개 (반품 재판매 · 공유재고에 포함)", "목록: 자기 재고 + 공유재고 포함 표시");
check(RR.resaleNoticeHtml({ ...resale, live_stock: 0, resale_pool: { ...resale.resale_pool, own_stock: 0, own_stock_basis: "ABSENT_ZERO" } })
  .includes("판매 가능 0개(쿠팡 재고 목록에 없음)"), true, "반품 SKU 가 쿠팡 재고 목록에 없으면 '판매 가능 0개(쿠팡 재고 목록에 없음)'");
const note = RR.resaleNoticeHtml(resale);
check(["포장 훼손", "판매 가능 2개", "95936822309", "합계 288개", "신규 입고·발주 SKU 로는 쓰지 않아요"].map(t => note.includes(t)), [true, true, true, true, true],
  "상세: 기준 SKU·합계·입고 SKU 아님 안내");

console.log("\n=== 5) 연결 ===");
const html = read("./index.html");
check(html.indexOf("js/resale_return.js") > 0 && html.indexOf("js/resale_return.js") < html.indexOf("js/app.js"), true, "index.html: resale_return.js 가 app.js 보다 먼저");
check(["ResaleReturn.detailRowsHtml(d)", "ResaleReturn.resaleNoticeHtml(d)", "ResaleReturn.stockSuffix(d)"].map(t => src.includes(t)), [true, true, true],
  "app.js: 재고 목록·상세 연결");
check([src.includes("loadRecovery"), src.includes("cmReferenceHtml"), /cost_recovery/.test(read("./js/resale_return.js"))], [false, false, false],
  "[핵심] 원가환입 참고 카드·조회는 이번 배포에 없음(공헌이익 화면 변경 0)");
const fnText = (source, name) => (source.match(new RegExp(`(async )?function ${name}\\([\\s\\S]*?\\n}`)) || [""])[0];
// 2026-09-14 새 공헌이익(cm_settlement.js) 스위치 연결 두 줄만 빼고 비교 - 반품 작업은 공헌이익 화면을 바꾸지 않았음을 계속 확인해요.
const noCmv2 = t => t.split("\n").filter(l => !l.includes("const cmv2Html")).map(l => (l === "${cmv2Html}" ? "" : l)).join("\n");
check([fnText(src, "viewProfit").length > 1000, noCmv2(fnText(src, "viewProfit")) === fnText(baseSrc, "viewProfit"),
       fnText(src, "viewProfit").split("\n").filter(l => l.includes("cmv2Html")).length], [true, true, 2],
  "[핵심] 공헌이익 화면(viewProfit)은 새 공헌이익 스위치 연결 2줄 말고 운영과 한 글자도 같음");
check(/\.(insert|update|upsert|delete|rpc)\(/.test(read("./js/resale_return.js")), false, "resale_return.js 에 쓰기 호출 없음");

console.log(`\n결과: ${fails ? `실패 ${fails}건` : "전체 통과"}`);
process.exit(fails ? 1 : 0);
