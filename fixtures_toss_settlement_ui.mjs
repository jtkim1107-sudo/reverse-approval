// fixtures_toss_settlement_ui.mjs
// 2026-09-29 토스쇼핑 실제 수수료·공헌이익 화면(승인 PNG 3장 구조) 검증 - 네트워크·DB 0건, 실제 js 파일 실행.
//   ① 대시보드 공헌이익 카드: 기존 목록 안 토스쇼핑 한 줄만(정산 전: 매출·합계 미포함 / 정산 완료: 기여·광고비 상태)
//      토스 없는 달은 그대로 · 펼침 내역 표 구조 그대로 · 광고비 추정 금액을 그리지 않음
//   ② 매출 내역 행: 채널 칸 '토스쇼핑' 옆 작은 배지(정산 전 / 정산 완료) · 쿠팡 행은 배지 없음
//   ③ 주문 상세 창: 기존 표 아래 '수수료·정산 내역' 표 하나 - 정산 전이면 확정 열 전부 '—', 정산 후 실제 수수료·요율·지급일
import { readFileSync } from "fs";
import vm from "vm";

const file = p => readFileSync(new URL(p, import.meta.url).pathname, "utf8");
const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { console.log(`        기대=${JSON.stringify(want)}\n        실제=${JSON.stringify(got)}`); fails.push(label); }
};
const text = html => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const ctx = { window: {}, console, Date, Object, Math, String, Number, JSON, Promise, Intl, isNaN, Set, Array };
ctx.globalThis = ctx.window;
vm.createContext(ctx);
vm.runInContext(file("./js/erp_ui.js"), ctx);
vm.runInContext(file("./js/cm_settlement.js"), ctx);
vm.runInContext(file("./js/toss_settlement.js"), ctx);
const CM = ctx.window.CmSettlement, T = ctx.window.TossSettlement;
const fmt = n => Math.round(Number(n) || 0).toLocaleString("ko-KR");

console.log("\n[1] 대시보드 공헌이익 카드 - 토스쇼핑 한 줄");
const base = {
  latest_data_date: "2026-09-28", subtotal_before_monthly: 5069091,
  monthly_cost: { range: "2026-09-01~2026-09-28", available: true, total: 4603218, status: "OK", items: [{ code: "WAREHOUSING", label: "WAREHOUSING", amount: 4603218 }] },
  provisional_cm: { is_confirmed: false, amount: -56117, monthly_cost: 4603218, inbound_freight: 521990, subtotal_before_monthly: 5069091,
                    period_start: "2026-09-01", period_end: "2026-09-28" },
  lines: [{ code: "REVENUE_RG_GROSS", label: "로켓그로스 판매(공급가액)", amount: 20000000 }, { code: "COST_PRODUCT", label: "상품원가", amount: -14930909 }],
};
const at = "2026-09-29T07:01:00+09:00";
const card = d => CM.dashboardContributionHtml({ detail: d, lastSuccessAt: at, lastAttemptAt: at });
const noToss = card(base);
check("토스 매출 없는 달: 토스 줄 없음(기존 그대로)", noToss.includes("토스쇼핑"), false);
const pending = { orders: 1, pending: { rows: 1, revenue_sup: 8091 }, settled: { rows: 0 }, cost_missing_rows: 0,
                  ads: { status: "AD_SOURCE_UNAVAILABLE", amount: null }, contribution: null, in_total: false, final: false };
const pHtml = card({ ...base, toss: pending });
check("[핵심] 정산 전: 승인 문구 그대로", text(pHtml.match(/<div class="cmv2-dtoss">[\s\S]*?<\/div>/)[0]),
      "토스쇼핑 매출 1건 · 원가·수수료 확인 전 · 합계 미포함 ₩8,091");
check("토스 줄은 '갱신' 줄 바로 위(기존 목록 안)", pHtml.indexOf("cmv2-dtoss") < pHtml.indexOf("<span>갱신</span>") &&
      pHtml.indexOf("cmv2-dtoss") > pHtml.indexOf("기여액 <small>"), true);
check("토스 줄 외 카드 구조 동일(줄 하나만 추가)", pHtml.replace(/\s*<div class="cmv2-dtoss">[\s\S]*?<\/div>/, "").replace(/\s+/g, " "),
      noToss.replace(/\s+/g, " "));
check("정산 전: 합계 금액 그대로", pHtml.includes("−₩56,117"), true);
const settled = { orders: 2, pending: { rows: 1, revenue_sup: 8091 }, settled: { rows: 1, revenue_sup: 7636, ship_cost: 2727 }, cost_missing_rows: 0,
                  ads: { status: "AD_SOURCE_UNAVAILABLE", amount: null }, contribution: 5787, in_total: true, final: false };
check("정산 완료: 기여·광고비 확인 필요(추정 금액 없음)", text(card({ ...base, toss: settled }).match(/<div class="cmv2-dtoss">[\s\S]*?<\/div>/)[0]),
      "토스쇼핑 기여 1건 · 정산 완료 · 배송·포장비 ₩2,727 · 정산 대기 1건 합계 미포함 · 광고비 확인 필요 ₩5,787");
check("확인 필요 건수(0원으로 두지 않음)", text(card({ ...base, toss: { ...pending, needs_review: { rows: 2 } } }).match(/<div class="cmv2-dtoss">[\s\S]*?<\/div>/)[0]),
      "토스쇼핑 매출 1건 · 원가·수수료 확인 전 · 확인 필요 2건 · 합계 미포함 ₩8,091");
check("실제 광고비가 있으면 차감 금액만 작게", text(card({ ...base, toss: { ...settled, pending: { rows: 0 }, final: true,
      ads: { status: "AD_ACTUAL", amount: 1500 } } }).match(/<div class="cmv2-dtoss">[\s\S]*?<\/div>/)[0]),
      "토스쇼핑 기여 1건 · 정산 완료 · 확정 · 배송·포장비 ₩2,727 · 광고비 ₩1,500 차감 ₩5,787");
const bd = CM.dashboardProvisionalBreakdownHtml({ detail: { ...base, toss: pending }, lastSuccessAt: at });
check("펼침 내역 표는 기존 줄 그대로(정산 전 토스는 줄 없음)", (bd.match(/<tr/g) || []).length, base.lines.length + 4);

console.log("\n[2] 매출 내역 행 배지");
const g = rows => ({ channel: "토스쇼핑", product_id: "P3", ledger_rows: rows });
const row1 = { external_key: "TOSS-319161890", amount: 8900, qty: 1 };
const data0 = { byOpid: {}, shipByOrder: {}, error: null };
const pay = { order_id: "289170040", order_product_id: "319161890", step_type: "PAY", order_product_price: 8900, shopping_discount_merchant: 500,
              shopping_discount_toss: 212, toss_pay_discount: 0, toss_pay_point: 0, product_fee: 600, product_vat: 60, pay_fee: 250, pay_vat: 25,
              product_fee_rate: 0.07, pay_fee_rate: 0.0297, settlement_amount: 7465, payout_date: "2026-10-06", review_status: "OK" };
const shipRow = { order_id: "289170040", order_product_id: null, is_shipping: true, step_type: "PAY", delivery_fee_amount: 3000,
                  shopping_discount_merchant: 0, pay_fee: 90, pay_vat: 9, product_fee: 0, product_vat: 0, settlement_amount: 2901, payout_date: "2026-10-06" };
const data1 = { byOpid: { "319161890": [pay] }, shipByOrder: { "289170040": [shipRow] }, error: null };
check("정산 행 없음 → 정산 전", T.groupStatus(g([row1]), data0), "PENDING");
check("결제 정산 행 있음 → 정산 완료", T.groupStatus(g([row1]), data1), "SETTLED");
check("여러 주문 중 하나라도 정산 전이면 정산 전", T.groupStatus(g([row1, { external_key: "TOSS-2" }]), data1), "PENDING");
check("쿠팡 행은 배지 없음", T.groupStatus({ channel: "쿠팡 판매자배송", ledger_rows: [] }, data1), null);
check("배지 문구", [text(T.badgeHtml("PENDING")), text(T.badgeHtml("SETTLED")), T.badgeHtml(null)], ["⏳ 정산 전", "✓ 정산 완료", ""]);
check("작은 배지(sm)", T.badgeHtml("PENDING").includes("erp-badge--sm"), true);

console.log("\n[3] 주문 상세 - 수수료·정산 내역");
const tbl = d => T.feeTableHtml(g([row1]), d, { fmt, taxable: true, today: "2026-09-29" });
const cells = html => [...html.matchAll(/<tr><th scope="row"[^>]*>([\s\S]*?)<\/th><td[^>]*>([\s\S]*?)<\/td><td[^>]*>([\s\S]*?)<\/td><\/tr>/g)]
  .map(m => [text(m[1]).split(" ")[0], text(m[2]), text(m[3])]);
const p0 = cells(tbl(data0));
check("정산 전: 행 12개(승인 표 + 배송·포장비 한 줄)", p0.length, 12);
check("정산 전: 확정 열 전부 '—'", p0.every(c => c[2] === "—"), true);
check("정산 전: 수수료는 '정산 전'(요율 추정 없음)", [p0[4][1], p0[5][1], tbl(data0).includes("%")], ["정산 전", "정산 전", false]);
check("정산 전: 판매가·매출(공급가액)", [p0[0][1], p0[3][1]], ["₩8,900", "₩8,091"]);
const p1 = cells(tbl(data1));
check("정산 완료: 판매가·판매자 할인·토스 부담", [p1[0][2], p1[1][2], p1[2][2]], ["₩8,900", "₩500", "₩212"]);
check("정산 완료: 매출(공급가액) = (8,900−500)÷1.1", p1[3][2], "₩7,636");
check("[핵심] 실제 수수료·요율·VAT(API 값 그대로)", [p1[4][2], p1[5][2]], ["₩600 7% · VAT ₩60", "₩250 2.97% · VAT ₩25"]);
check("배송비·배송비 수수료", p1[6][2], "₩3,000 수수료 ₩90");
check("기타 차감 0(계산값 = 정산 지급액)", p1[7][2], "₩0");
check("정산 지급액·지급 예정일", p1[10][2], "₩10,366 10-06 지급 예정");
const mism = { ...data1, byOpid: { "319161890": [{ ...pay, settlement_amount: 7400 }] } };
check("정산 지급액이 다르면 기타 차감 + 확인 필요", cells(tbl(mism))[7][2], "₩65 확인 필요");
check("원가는 공헌이익 화면 한 곳에서만(이 표에서 계산 안 함)", p1[8], ["상품원가", "공헌이익 화면 기준", "—"]);
const tblS = (d, shipFee, orderLines = {}, rows = [row1]) => T.feeTableHtml(g(rows), d, { fmt, taxable: true, today: "2026-09-29", shipFee, orderLines });
check("[핵심] 배송·포장비: 상품 마스터 주문당 값", cells(tblS(data1, 3000))[9], ["배송·포장비", "₩3,000 주문당 ₩3,000 × 1건", "₩3,000 주문당 ₩3,000 × 1건"]);
check("배송·포장비 미입력 → 확인 필요(0원 아님)", cells(tblS(data0, null))[9], ["배송·포장비", "미입력 확인 필요", "—"]);
check("0 은 입력값", cells(tblS(data0, 0))[9][1], "₩0 주문당 ₩0 × 1건");
const r289 = { ...row1, memo: "토스쇼핑 주문 289170040 · 주문결제 09-28 10:47 KST · 배송중" };
check("같은 주문에 다른 상품이 있으면 기준 밖 확인 필요", cells(tblS(data0, 3000, { "289170040": 2 }, [r289]))[9][1], "확인 필요 여러 상품·여러 개 1건 · 주문당 ₩3,000 기준 밖");
check("여러 개(qty 2) 주문도 기준 밖", T.shipCost(g([{ ...r289, qty: 2 }]), { shipFee: 3000, orderLines: { "289170040": 1 } }).review, 1);
check("주문별 줄 수(이 달 토스 행 전체)", T.orderLineCounts([g([r289]), g([{ ...r289, external_key: "TOSS-2" }]), { channel: "쿠팡 판매자배송", ledger_rows: [r289] }]), { "289170040": 2 });
check("읽기 실패면 정산 전 + 안내", text(tbl({ ...data0, error: "relation does not exist" })).includes("정산 자료를 읽지 못해 정산 전으로 표시"), true);
check("쿠팡 행 상세에는 표 없음", T.feeTableHtml({ channel: "쿠팡 판매자배송", ledger_rows: [] }, data1, { fmt }), "");

console.log("\n[4] 읽기 전용 로더");
const calls = [];
const fakeSb = rows => ({ from: t => { const q = { t, f: [] };
  const api = { select: () => api, in: (c, v) => { q.f.push(["in", c, v]); return api; }, eq: (c, v) => { q.f.push(["eq", c, v]); return api; },
    then: (res, rej) => { calls.push(q); const r = typeof rows === "function" ? rows(q) : rows; return Promise.resolve(r).then(res, rej); } };
  return api; } });
const got = await T.load(fakeSb(q => ({ data: q.f.some(f => f[0] === "eq") ? [shipRow] : [pay], error: null })), ["319161890", null, "319161890"]);
check("주문상품 행 + 같은 주문 배송비 행", [Object.keys(got.byOpid), Object.keys(got.shipByOrder), got.error], [["319161890"], ["289170040"], null]);
check("표 이름·중복 없는 id", [calls[0].t, calls[0].f[0]], ["toss_settlement_steps", ["in", "order_product_id", ["319161890"]]]);
const bad = await T.load(fakeSb({ data: null, error: { message: "relation \"toss_settlement_steps\" does not exist" } }), ["1"]);
check("표가 없으면 throw 없이 error 만(화면은 정산 전)", [Object.keys(bad.byOpid).length, /does not exist/.test(bad.error)], [0, true]);
check("토스 행 없으면 조회 안 함", (await T.load(fakeSb({ data: [] }), [])).error, null);

console.log("\n[5] app.js 연결(기존 화면에만)");
const app = file("./js/app.js"), idx = file("./index.html");
check("채널 칸 옆 배지만", /<td>\$\{esc\(group\.channel\)\}\$\{tossBadgeHtml\(group\)\}<\/td>/.test(app), true);
check("주문 상세 창의 기존 표 아래 한 번", (app.match(/TossSettlement\.feeTableHtml\(/g) || []).length, 1);
check("상품 마스터 ship_fee 를 넘김(없으면 null)", /shipFee: \(erpProducts\.find\(p => p\.id === group\.product_id\) \|\| \{\}\)\.ship_fee \?\? null/.test(app), true);
check("매출 화면에서 한 번 읽기", (app.match(/TossSettlement\.load\(/g) || []).length, 1);
check("새 탭·메뉴 없음(route·nav 추가 없음)", [/data-route="toss/.test(idx), /#\/toss/.test(app)], [false, false]);
check("스크립트 등록(app.js 앞)", idx.indexOf("js/toss_settlement.js") > 0 && idx.indexOf("js/toss_settlement.js") < idx.indexOf("js/app.js"), true);

console.log();
if (fails.length) { console.log(`실패 ${fails.length}건: ${fails.join(", ")}`); process.exit(1); }
console.log("전부 통과");
