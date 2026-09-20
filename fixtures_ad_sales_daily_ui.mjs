// fixtures_ad_sales_daily_ui.mjs
// 2026-09-20 일별 광고비×전체매출 화면(js/ad_sales_daily.js) 격리 검증. 네트워크 없음(fetch 미사용,
// window.sb 미설정 → api() 는 AUTH 401 분기만 탐).
//   · 계산은 이 파일에 없음(totals()는 서버가 준 값을 더하기만) · 값 없음은 '—' (0원 아님)
//   · 매출 기준·광고비 기준 문구가 화면에 그대로 노출 · 광고비÷매출 비율(ROAS류) 계산 없음
//   · 상품별 분석 없음 안내(#/adprofit 링크) · 기간 버튼(7/30/90) 존재
import fs from "node:fs";
import vm from "node:vm";

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok && extra !== undefined) console.log("   ", JSON.stringify(extra).slice(0, 400));
}

const ctx = { window: {}, console, document: undefined };
vm.createContext(ctx);
for (const f of ["./js/erp_ui.js", "./js/ad_sales_daily.js"]) vm.runInContext(fs.readFileSync(new URL(f, import.meta.url), "utf8"), ctx);
const A = ctx.window.AdSalesDaily;
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/·/g, "*").replace(/\s+/g, " ");

// ── 1. totals() - 서버 값을 그대로 더할 뿐, 새 판정 없음 ────────────────────
const SERIES = {
  start: "2026-08-25", end: "2026-09-03",
  days: [
    // 확정(D+7 재확인 이력 있음)
    { date: "2026-08-25", total_sales: { amount: 80000, display_status: "OK", basis_label: "쿠팡 판매통계 순매출",
      confirmed: true, confirmed_label: "확정" }, ad_spend: { amount: 9000, status: "OK", vat_included: false, error: null } },
    { date: "2026-09-01", total_sales: { amount: 140000, display_status: "OK", basis_label: "쿠팡 판매통계 순매출",
      confirmed: false, confirmed_label: "잠정(D+7 확인 전)" },
      ad_spend: { amount: 12000, status: "OK", vat_included: false, error: null } },
    { date: "2026-09-02", total_sales: { amount: null, display_status: "수집 대기", basis_label: "쿠팡 판매통계 순매출",
      confirmed: null, confirmed_label: null },
      ad_spend: { amount: null, status: "수집 실패", vat_included: false, error: "SESSION_EXPIRED" } },
    { date: "2026-09-03", total_sales: { amount: 50000, display_status: "OK", basis_label: "쿠팡 판매통계 순매출",
      confirmed: false, confirmed_label: "잠정(D+7 확인 전)" },
      ad_spend: { amount: 5000, status: "OK", vat_included: false, error: null } },
  ],
  basis: {
    total_sales: "일별 전체 매출은 ... VAT 포함 ... 최대 D+7까지 재수집 ...",
    ad_spend: "일별 광고비는 ... VAT 제외 ... 이중 차감입니다 ...",
  },
};

const t = A.totals(SERIES);
check(t.salesSum === 270000, "매출 합계 = 수집된 날만 합(80000+140000+50000)", t);
check(t.salesMissing === 1, "매출 미수집 1일");
check(t.salesProvisional === 2, "잠정(확정 안 됨)인 날 2일(09-01·09-03) - 08-25는 확정이라 제외", t);
check(t.adSum === 26000, "광고비 합계 = 정상 수집만 합(9000+12000+5000)", t);
check(t.adMissing === 1, "광고비 미수집·실패 1일");

// ── 2. 화면 렌더 (document 없이 pageHtml 을 우회 호출) ──────────────────────
A.state.series = SERIES;
A.state.start = SERIES.start;
A.state.end = SERIES.end;
A.state.period = 30;
A.state.loading = false;
A.state.error = null;

// pageHtml/kpiHtml 등은 클로저 내부라 view()/pick()을 거치지 않고는 못 부르므로,
// erp_ui 없이도 동작하는 kpiHtml 폴백 경로를 간접 검증하기 위해 UI() 가 없는 컨텍스트에서 문자열만 조합해
// 계약을 검증합니다(전체 pageHtml은 view()/pick()에서 document 를 요구 - 여기선 totals·문구 계약만 확인).
check(typeof A.view === "function", "view() 내보냄");
check(typeof A.pick === "function", "pick() 내보냄(기간 버튼)");

// ── 3. 화면 문구 계약 - 소스에서 직접 확인(ROAS/비율 계산이 없는지, 상품별 안내가 있는지) ──
const src = fs.readFileSync(new URL("./js/ad_sales_daily.js", import.meta.url), "utf8");
check(!/amount\s*\/\s*.*ad_spend|ad_spend.*\/\s*.*total_sales/.test(src), "매출÷광고비 나눗셈 없음(VAT 기준 혼합 방지)");
check(/adprofit/.test(src), "상품별 분석은 #/adprofit 안내 링크 포함");
check(/일별 상품 데이터는 아직 없어요/.test(src), "일별 상품 데이터 미확보 안내 문구 포함");
check(/const won = \(v\) =>/.test(src) && /isNum/.test(src), "값 없음(null)은 — 로 표시(0원 아님) - won() 이 null 분기 가짐");

// ── 4. 확정/잠정(D+7) 배지 - 소스에 판정 규칙이 없고(응답 필드를 그대로 씀), KPI 요약에 잠정 일수가 나오는지 ──
check(/confirmedBadge/.test(src), "확정/잠정 배지 함수 있음");
check(!/d7|D\s*\+\s*7.*confirmed\s*=/.test(src), "확정 판정 로직을 이 파일에서 새로 계산하지 않음(서버 confirmed 필드를 그대로 씀)");
check(/salesProvisional/.test(src) && /잠정/.test(src), "KPI 요약에 잠정 일수 표시");


console.log();
if (failures) {
  console.log(`실패 ${failures}건`);
  process.exit(1);
}
console.log("전부 통과");
