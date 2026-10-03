// fixtures_erp_seven_areas.mjs - 2026-10-03 ERP 7개 핵심 영역 재정리(메뉴·옛 주소 이동·첫 화면·광고 현황) 로컬 검증. 네트워크 없음.
//   node fixtures_erp_seven_areas.mjs
import fs from "node:fs";
import vm from "node:vm";

let n = 0, fail = 0;
const check = (got, want, label) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n       기대=${JSON.stringify(want)}\n       실제=${JSON.stringify(got)}`}`); };
const read = p => fs.readFileSync(new URL(p, import.meta.url), "utf8");
const idx = read("./index.html"), app = read("./js/app.js");

console.log("[1] 메뉴 = 첫 화면 + 7개 영역 + 업무·설정 (순서)");
const labels = [...idx.matchAll(/<div class="nav-label">([^<]+)<\/div>/g)].map(m => m[1]);
check(labels, ["① 매출", "② 매입", "③ 재고", "④ 자금", "⑤ 자동 입고", "⑥ 하루 · 월간 브리핑", "⑦ 광고", "업무 · 설정"], "영역 라벨 순서");
const navRoutes = [...idx.matchAll(/data-route="([a-z]+)"/g)].map(m => m[1]);
const routeNames = [...app.matchAll(/^\s{2}([a-z]+): \{ title:/gm)].map(m => m[1]);
check(navRoutes.filter(r => !routeNames.includes(r)), [], "메뉴의 모든 화면이 routes 에 있음");
check(navRoutes.indexOf("dashboard"), 0, "첫 화면이 맨 위");
for (const gone of ["aireport", "rginbound", "shipmentplans", "inventory", "purchasereco", "livesales"])
  check(navRoutes.includes(gone), false, `메뉴에서 '${gone}' 제거(옛 주소는 이동)`);
check([/href="#\/stockflow\/stock" data-route="stockflow" data-tab="stock"/.test(idx), /href="#\/stockflow\/rginbound" data-route="stockflow" data-tab="rginbound"/.test(idx)],
      [true, true], "③ 재고 / ⑤ 자동 입고 는 같은 화면의 다른 탭(data-tab 으로 활성 표시)");
check(app.includes('el.dataset.route === name && (!el.dataset.tab || el.dataset.tab === (param || "stock"))'), true, "탭까지 비교해 활성 표시");
for (const id of ["badge-voc", "badge-po", "badge-inbox", "badge-rginbound", "badge-tasks"]) check(idx.includes(`id="${id}"`), true, `배지 ${id} 유지`);
check(/nav-admin-label hidden">[^<]*관리자 도구/.test(idx) && idx.includes('data-route="wingreceiptfix"'), true, "관리자 도구(승인 권한자만) 유지");

console.log("[2] 옛 주소 → 새 위치(replaceState, 뒤로가기 루프 없음)");
const moved = app.match(/const MOVED = (\{[^}]+\});/);
check(!!moved, true, "MOVED 표");
check(JSON.parse(moved[1].replace(/(\w+):/g, '"$1":')), { aireport: "briefing", rginbound: "stockflow/rginbound", shipmentplans: "stockflow/rginbound" }, "이동 대상");
const routeBody = app.slice(app.indexOf("async function route()"), app.indexOf("async function route()") + 6000);
check(/MOVED\[movedKey\]\) \{\s*history\.replaceState\(null, "", `#\/\$\{MOVED\[movedKey\]\}`\);\s*hash = MOVED\[movedKey\];/.test(routeBody), true, "replaceState 로 이동");
check(routeBody.indexOf("const MOVED") < routeBody.indexOf("const [name, param] = hash"), true, "이름을 정하기 전에 이동");
check([/briefing: \{ title: "하루 · 월간 브리핑", render: viewBriefing/.test(app), /ads: \{ title: "광고 현황"/.test(app)], [true, true], "새 화면 2개 등록");
for (const kept of ["profit", "report", "adprofit", "cash", "vat", "restockapproval", "suppliermailapproval", "wingreceiptfix", "restockrecovery", "restockinquiryclose", "stockflow", "po", "purchases"])
  check(routeNames.includes(kept), true, `기존 화면 보존: ${kept}`);

console.log("[3] 첫 화면 '한눈에 보기' - 값이 없으면 0 이 아니라 '확인 필요'");
const ctx = { console };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(read("./js/erp_home.js"), ctx);
vm.runInContext(read("./js/ad_status_view.js"), ctx);
const H = ctx.ErpHome, A = ctx.AdStatusView;
const home = {
  generated_at: "2026-10-03T17:40:00+09:00",
  sales: { label: "어제 쿠팡 합계 순매출", yesterday: 919970, yesterday_date: "2026-10-02", yesterday_state: "확정", status: "전일 확정", metrics: [["전일 대비", "+2.8%"]] },
  profit: { valid: true, amount: -128855.5, with_other_income: -128855.5, period: ["2026-10-01", "2026-10-02"], status: "잠정 · 최신 자료" },
  inventory: { total: 11916700, products: 25, incoming_value: 5927000, cost_unconfirmed: ["a", "b"], missing_cost: [], missing_qty: [], complete: true },
  cash: { balance: 16369265, last_bank: "2026-09-18 14:34:56", bank_age_days: 15, in7: 5740662, out7: 12922280, min_balance: 2856781, min_date: "2026-10-20" },
  ads: { cost: 54590, roas: 895.7, d7: { complete: true, roas: 762.8, ad_cost_ratio: 0.069 }, campaign_fresh: false, status: "수집 완료" },
  actions: [{ level: "alert", title: "WING 로그인 필요", detail: "x", link: "#/settings" }, { level: "action", title: "자동 입고 승인 대기 1건", detail: "y", link: "#/stockflow/rginbound" }],
};
const t = H.html(home);
const order = ["eh-sales", "eh-profit", "eh-inventory", "eh-cash", "eh-plans", "eh-ads", "eh-actions"].map(id => t.indexOf(`id="${id}"`));
check(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), true, "타일 7개 순서: 매출 · 공헌이익 · 재고금액 · 가용자금 · 입출금 예정 · 광고 · 오늘 조치사항");
check(["₩919,970", "−₩128,856", "₩11,916,700", "₩16,369,265", "₩5,740,662 / ₩12,922,280", "₩54,590 · ROAS 896%", "2건"].map(x => t.includes(x)), Array(7).fill(true), "표시 값");
check([t.includes("15일 지남"), t.includes("통장 최신화 필요"), t.includes("캠페인 수치 최신 아님"), t.includes("원가 미확정 2")], [true, true, true, true], "기준 시각·최신 아님 표시");
const empty = H.html({ sales: {}, profit: { valid: false, notes: ["최신 잠정 공헌이익을 계산할 수 없습니다."] }, inventory: { total: null, error: "재고 판단 캐시 없음" }, cash: {}, ads: {}, actions: [] });
check([empty.includes("₩0"), (empty.match(/확인 필요/g) || []).length >= 5, empty.includes("재고 판단 캐시 없음")], [false, true, true], "값 없음 → 확인 필요(0원 아님)");
check(H.errorHtml("HTTP 503").includes("이전 값을 대신 보여 주지 않아요"), true, "조회 실패 문구");

console.log("[4] 광고 현황 - 최신 아님 · 잠정 · 원가 확인 필요");
const adm = {
  report_date: "2026-10-02", status: "확인 필요", reasons: ["캠페인별: 광고센터 로그인 만료 - 표시한 캠페인 수치는 2026-09-29 자료(최신 아님)"],
  account: { d1: { complete: true, period: ["2026-10-02", "2026-10-02"], cost: 54590, ad_sales: 488970, roas: 895.7, ad_units: 25, orders: null, clicks: null, cvr: null,
                   orders_source: "확인 필요(캠페인 원본 최신 아님)", ad_cost_ratio: 0.065, ad_sales_share: 0.47, non_ad_sales_share: 0.53, vs_prev: { cost: -0.18, ad_sales: 0.21, roas: 0.47 } },
             d7: { complete: false, period: ["2026-09-26", "2026-10-02"], missing: ["2026-09-30"] }, d14: { complete: true, period: [], cost: 1, ad_sales: 2, roas: 200, vs_prev: {} },
             d30: { complete: true, period: [], cost: 1, ad_sales: 2, roas: 200, vs_prev: {} } },
  account_alerts: [], campaign_fresh: false, campaign_date: "2026-09-29", verdict_counts: { 관찰: 1 },
  campaigns: [{ id: "1", name: "욕실발판", cfg: { on: true, budget: 10000, roas_target: 1000 }, budget_burn_d1: 1.2, breakeven: 997, cost_check: true, verdict: "관찰", why: "±10%",
                periods: { d1: { cost: 12043 }, d7: { roas: 1098, orders: 42, clicks: 1133, cvr: 0.037, ad_profit: null }, d30: { roas: 1055 } }, alerts: ["예산 소진 - 전날 일예산의 120%"] }],
  change_reviews: [{ campaign_id: "1", date: "2026-09-30", text: "대표 결정 보류", until: "2026-10-06", before_7d: { complete: false, have: 1, need: 7 },
                     after: { d3: { complete: false, have: 0, need: 3 }, d7: { complete: false, pending_until: "2026-10-07" }, d14: { complete: false, pending_until: "2026-10-14" } }, rollback_proposal: null }],
};
const ah = A.html(adm);
check([ah.includes("2026-09-29</b> 자료예요(최신 아님"), ah.includes("원가 확인 필요"), ah.includes("잠정"), ah.includes("7일 없음") || ah.includes("1일 없음")], [true, true, true, true], "최신 아님 · 원가 확인 필요 · 누락 기간");
check([ah.includes("₩0"), ah.includes("광고 설정을 바꾸지 않아요"), ah.includes("10-06까지 보류"), ah.includes("10-07에 비교")], [false, true, true, true], "자동 변경 없음 · 대표 보류 · 비교 대기");
check(ah.includes('href="#/adprofit"'), true, "상품별 광고·이익(기존 쿠팡광고 탭)과 연결");

console.log("[5] 대시보드 연결");
const dash = app.slice(app.indexOf("/* ---------- 화면: 대시보드 ---------- */"), app.indexOf("/* ---------- 문서 목록 테이블 ---------- */"));
check([dash.includes("ErpHome.load({ base: WING_SUBMIT_API_BASE"), dash.includes("ErpHome.errorHtml"), dash.includes('id="dash-status-slot"')], [true, true, true], "한눈에 보기 + 운영 상태(맨 아래) 유지");
check(idx.indexOf("js/erp_home.js") > 0 && idx.indexOf("js/ad_status_view.js") > 0 && idx.indexOf("js/ad_status_view.js") < idx.indexOf("js/app.js"), true, "모듈이 app.js 보다 먼저");
check(dash.includes("약 24시간"), false, "옛 '약 24시간' 안내 제거");

console.log(`\n${n - fail}/${n} 통과`);
process.exit(fail ? 1 : 0);
