// fixtures_cm_contribution_card.mjs
// 2026-09-16 '최신 자료 기여액(월 공통비 차감 전)' 카드 (네트워크 0건 - 가짜 sb, 실제 js/cm_settlement.js 실행).
//   · 확정 공헌이익(₩205,663 · ~09-13)과 기여액(~09-15)이 한 화면에 따로 보이고, 기여액이 확정값을 덮지 않아요.
//   · 월 공통비가 없으면 '금액 없음' + 사유. ₩0 으로 그리지 않아요.
//   · 기여액에는 '공헌이익'이라는 이름을 붙이지 않고 '공헌이익 아님'을 분명히 적어요.
//   · 갱신이 실패하면 직전 성공 값 + '갱신 실패' 안내, 확정값으로 갈아끼우지 않아요.
import { readFileSync } from "fs";
import vm from "vm";

const file = p => readFileSync(new URL(p, import.meta.url).pathname, "utf8");
let n = 0;
const fails = [];
const check = (label, got, want) => {
  n++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { console.log(`        기대=${JSON.stringify(want)}\n        실제=${JSON.stringify(got)}`); fails.push(label); }
};

// js/cm_settlement.js 를 그대로 실행(운영과 같은 코드)
const ctx = { window: {}, console, Date, Object, Math, String, Number, JSON, Promise, Intl, isNaN, Set };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(file("./js/cm_settlement.js"), ctx);
const CM = ctx.window.CmSettlement;

const OK_AT = "2026-09-16T06:25:00+00:00";
const DETAIL = {
  version: 1, contrib_version: "cm_contribution_v1", calc_version: "cm_settlement_v2.7", run_id: "abcd1234-ef",
  generated_at: "2026-09-16T15:25:00+09:00", inputs_hash: "59c6b4b4e68ca448",
  month: "2026-09", period_start: "2026-09-01", period_end: "2026-09-15", latest_data_date: "2026-09-15",
  subtotal_before_monthly: 2722604,
  lines: [{ code: "REVENUE_RG_GROSS", label: "로켓그로스 판매(공급가액)", amount: 12462926, status: "CYCLE_OPEN", source: "정산파일" },
          { code: "COST_PRODUCT", label: "상품원가(판매 수량 × 판매일 원가)", amount: -6241071, status: "COST_UNCONFIRMED", source: "ERP" },
          { code: "AD_BILLED", label: "광고비 · 로켓그로스 정산 청구액(VAT 제외)", amount: -888134, status: "CYCLE_OPEN", source: "정산파일" }],
  monthly_cost: { range: "2026-09-01~2026-09-15", available: false, total: null, status: "COST_SUMMARY_MISSING",
                  reason: "정산 원천 월 비용 조회(2026-09-01~2026-09-15) 없음" },
  settlement_closed: false, open_cycle_days: ["2026-09-14", "2026-09-15"],
  reasons: [{ status: "CYCLE_OPEN", label: "정산 진행 중", text: "2026-09-14, 2026-09-15 은 정산 주기가 끝나지 않았어요" },
            { status: "COST_SUMMARY_MISSING", label: "월 공통비 없음", text: "0원으로 만들지 않고 기여액만 보여 줘요" }],
  rows: { orders: 761, cancels: 82, estimated: 0, mp: 4 },
  ads: { billed: 888134, outside_billed: 0, outside_accrued: 38725, cm_amount: 926859 },
  recovery: { confirmed: 755700, loss: 0, check_pending_amount: 0, check_pending_rows: 0 },
  confirmed_cm: { period_end: "2026-09-13", as_of: "2026-09-13", cm: 205663, cm_status: "PROVISIONAL", confirmed: false, snapshot_id: 7 },
  artifacts: "wing_downloads/cm_contribution_runs/2026-09-15__ddbb6d3a",
};
const CONFIRMED_MAIN = { id: 7, month: "2026-09", basis: "MAIN", period_start: "2026-09-01", period_end: "2026-09-13",
                         cm: 205663, revenue: 8606815, cm_status: "PROVISIONAL" };

function fakeSb(row, error = null) {
  return { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error }) }) }) }) };
}

console.log("\n[1] 스냅샷 읽기");
const good = await CM.loadContribution(fakeSb({ job_name: "cm_contribution_latest", last_success_at: OK_AT,
  last_attempt_at: OK_AT, last_error: null, consecutive_failures: 0, detail: DETAIL }));
check("요약을 읽음", [good.detail.period_end, good.detail.subtotal_before_monthly], ["2026-09-15", 2722604]);
check("행이 없으면 null", await CM.loadContribution(fakeSb(null)), null);
check("읽기 실패는 error", (await CM.loadContribution(fakeSb(null, { message: "권한 없음" }))).error, "권한 없음");
check("모르는 형식은 error(확정값으로 대체하지 않음)",
      typeof (await CM.loadContribution(fakeSb({ detail: { version: 9 } }))).error, "string");

console.log("\n[2] 카드 - 두 기준이 함께, 확정값은 그대로");
const html = CM.contributionHtml(good, { confirmed: CONFIRMED_MAIN });
check("기여액 금액 표시", html.includes("₩2,722,604"), true);
check("확정 공헌이익 ₩205,663 그대로 표시", html.includes("₩205,663"), true);
check("기여액 기준일 09-15", html.includes("2026-09-15"), true);
check("확정 기준 기간 09-01~09-13 표시", html.includes("09-01~09-13"), true);
check("'공헌이익이 아니다'를 분명히", html.includes("이 금액은 공헌이익이 아닙니다"), true);
check("주 숫자 이름은 '월 공통비 차감 전 기여액'", html.includes("월 공통비 차감 전 기여액"), true);
check("갱신 시각 표시(KST)", /갱신 2026-09-16 \d{2}:\d{2} KST/.test(html), true);
check("보관 경로(재현성) 표시", html.includes("cm_contribution_runs/2026-09-15__ddbb6d3a"), true);
check("계산 버전 표시", html.includes("cm_contribution_v1"), true);

console.log("\n[3] 월 공통비 누락은 0원으로 그리지 않음");
check("'금액 없음'으로", html.includes("금액 없음"), true);
check("₩0 으로 그리지 않음", /월 공통비[\s\S]{0,400}₩0</.test(html), false);
check("누락 사유 문구", html.includes("정산 원천 월 비용 조회가 이 기간에 아직 없어요"), true);
check("사유 배지가 코드 대신 우리말", html.includes("월 공통비 없음") && !html.includes(">COST_SUMMARY_MISSING<"), true);
check("미마감 정산일 숨기지 않음", html.includes("2026-09-14") && html.includes("2026-09-15"), true);
const withMonthly = { ...good, detail: { ...DETAIL, monthly_cost: { range: "2026-09-01~2026-09-13", available: true,
  total: 2055917, status: "PROVISIONAL", reason: null } } };
check("월 공통비가 있으면 금액으로", CM.contributionHtml(withMonthly, { confirmed: CONFIRMED_MAIN }).includes("−₩2,055,917"), true);

console.log("\n[4] 갱신 실패 - 직전 성공값 유지 + 사실 표시");
const stale = { detail: DETAIL, lastSuccessAt: OK_AT, lastAttemptAt: "2026-09-17T06:25:00+00:00",
                lastError: "RuntimeError: 503", failures: 2 };
check("실패 안내 문구", /마지막 갱신 시도가 실패했어요\(2회 연속\)/.test(CM.contribStale(stale)), true);
const sh = CM.contributionHtml(stale, { confirmed: CONFIRMED_MAIN });
check("값은 직전 성공분 그대로", sh.includes("₩2,722,604"), true);
check("'갱신 실패' 배지", sh.includes("갱신 실패"), true);
check("성공만 있으면 실패 안내 없음", CM.contribStale(good), null);

console.log("\n[5] 결과 없음·조회 실패");
check("결과 없음 안내", CM.contributionHtml(null).includes("아직 기여액 스냅샷이 없어요"), true);
const err = CM.contributionHtml({ error: "HTTP 500" });
check("조회 실패 안내", err.includes("기여액을 불러오지 못했어요"), true);
check("확정값을 대신 쓰지 않음을 명시", err.includes("확정 공헌이익 값을 대신 쓰지 않아요"), true);

console.log("\n[6] 대시보드 - 확정 기준일과 기여액 기준일이 한 칸에");
const dash = CM.dashboardContributionHtml(good);
check("기여액 한 줄", dash.includes("₩2,722,604"), true);
check("최신 자료 기준일", dash.includes("최신 자료 2026-09-15 까지"), true);
check("'공헌이익 아님' 표시", dash.includes("공헌이익 아님"), true);
check("월 공통비 자료 없음 표시", dash.includes("월 공통비 자료 없음"), true);
check("결과 없으면 아무것도 안 그림", CM.dashboardContributionHtml(null), "");

console.log("\n[7] 최신 잠정 공헌이익 - 확정과 명확히 구분");
const PROV = { ...DETAIL,
  monthly_cost: { range: "2026-09-01~2026-09-15", available: true, total: 2453157, status: "PROVISIONAL", reason: null },
  provisional_cm: { amount: 269447, period_start: "2026-09-01", period_end: "2026-09-15", as_of: "2026-09-15",
                    subtotal_before_monthly: 2722604, monthly_cost: 2453157, monthly_cost_range: "2026-09-01~2026-09-15",
                    monthly_cost_status: "PROVISIONAL", inbound_freight: 0, settlement_closed: false,
                    open_cycle_days: ["2026-09-14", "2026-09-15"], is_confirmed: false,
                    confirm_blocked_reasons: ["정산 진행 중", "원가 미확정"],
                    note: "최신 자료 기준 잠정값" } };
const pg = { ...good, detail: PROV };
const ph = CM.contributionHtml(pg, { confirmed: CONFIRMED_MAIN });
check("잠정 공헌이익 금액 표시", ph.includes("₩269,447"), true);
check("'확정 아님' 을 값 옆에", /최신 잠정 공헌이익[\s\S]{0,120}확정 아님/.test(ph), true);
check("기간 표시", ph.includes("2026-09-01~2026-09-15"), true);
check("월 확정 전임을 본문에", ph.includes("아직 확정이 아닙니다") && ph.includes("월 마감 승인(월 확정)"), true);
check("저장 스냅샷을 덮지 않는다고 명시", ph.includes("저장된 공헌이익 스냅샷을 덮지도 않아요"), true);
check("저장된 확정값 ₩205,663 은 그대로 함께", ph.includes("₩205,663"), true);
check("승인 전 저장값을 확정으로 부르지 않음", ph.includes("저장된 월 공헌이익") && ph.includes("잠정 스냅샷"), true);
check("월 공통비 금액도 보여 줌", ph.includes("₩2,453,157"), true);
check("미마감 정산일 안내", ph.includes("2026-09-14") && ph.includes("2026-09-15"), true);
check("확정에 필요한 남은 확인 표시", ph.includes("정산 진행 중"), true);
check("갱신 시각 표시", /갱신 2026-09-16 \d{2}:\d{2} KST/.test(ph), true);
// is_confirmed 가 false 가 아니면 잠정 칸을 만들지 않음(오표기 방지)
const bad = { ...good, detail: { ...PROV, provisional_cm: { ...PROV.provisional_cm, is_confirmed: true } } };
check("확정으로 표시된 값은 잠정 칸으로 안 그림", CM.contributionHtml(bad, {}).includes("최신 잠정 공헌이익"), false);
check("월 공통비 없으면 기존 문구 유지", html.includes("이 금액은 공헌이익이 아닙니다"), true);
const pd = CM.dashboardContributionHtml(pg);
check("대시보드도 잠정 공헌이익", pd.includes("₩269,447") && pd.includes("최신 잠정 공헌이익"), true);
check("대시보드 '확정 아님'", pd.includes("확정 아님"), true);
check("대시보드 기여액도 함께", pd.includes("₩2,722,604"), true);
const freightProv = { ...pg, detail: { ...PROV, provisional_cm: {
  ...PROV.provisional_cm, amount: -75557, inbound_freight: 345004 } } };
const freightHtml = CM.contributionHtml(freightProv, { confirmed: CONFIRMED_MAIN });
check("판매분 입고 운반비를 별도 차감", freightHtml.includes("판매된 수량에 배분") && freightHtml.includes("−₩345,004"), true);
check("운반비를 뺀 잠정 공헌이익 표시", freightHtml.includes("−₩75,557"), true);
check("대시보드에도 운반비 설명", CM.dashboardContributionHtml(freightProv).includes("판매분 입고 운반비 ₩345,004"), true);

console.log("\n[8] 기존 확정 카드는 그대로");
const primary = CM.dashboardMainHtml({ MAIN: { ...CONFIRMED_MAIN, created_at: OK_AT, reasons: [], result: { revenue: 8606815 } } });
check("확정 카드 금액 불변", primary.includes("₩205,663"), true);
check("확정 카드에 기여액이 섞이지 않음", primary.includes("2,722,604"), false);

console.log(fails.length ? `\n실패 ${fails.length}/${n}: ${fails.join(", ")}` : `\n전부 통과 ${n}/${n}`);
process.exit(fails.length ? 1 : 0);
