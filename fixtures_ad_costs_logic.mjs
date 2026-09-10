// fixtures_ad_costs_logic.mjs
// 2026-09-11 쿠팡 광고비 자동수집 - 월 광고비 판정 로직(js/ad_costs.js) 격리 검증. 네트워크 없음.
//   · KST 날짜·월 경계 · 광고비 0원(정상 수집)과 수집 실패 구분 · 실패 후 기존 정상값 유지
//   · 수동 입력 중복 방지(RECONCILIATION_NEEDED) · 자동수집 이전 기간 수동 포함 · 보정 사유 포함
//   · 음수 환급 부호 보존 · 부가세 포함/별도 기준 · 월 합계 · 오늘분 미반영
import fs from "node:fs";
import vm from "node:vm";

let failures = 0;
function check(ok, label, extra) {
  if (!ok) failures += 1;
  console.log(`${ok ? "OK" : "FAIL"} ${label}`);
  if (!ok && extra !== undefined) console.log("   ", JSON.stringify(extra));
}

const src = fs.readFileSync(new URL("./js/ad_costs.js", import.meta.url), "utf8");
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const A = ctx.window.AdCosts;

const okColl = (d, total, at = `${d}T22:10:00Z`, vat = false) => ({ expense_date: d, status: "OK", total_amount: total, vat_included: vat, row_count: total ? 1 : 0, collected_at: at });
const failColl = (d, error, at) => ({ expense_date: d, status: "DATA_CHECK_NEEDED", total_amount: null, error, collected_at: at });
const row = (d, amount, vat = false, extra = {}) => ({ expense_date: d, amount, vat_included: vat, ...extra });
const rangeRef = (month, start, end, amount, at = "2026-09-11T07:20:00+09:00") =>
  ({ month, ref_type: "WING_AD_METRICS_RANGE", period_start: start, period_end: end, amount, vat_included: false, collected_at: at });

// ── 1. 광고비 0원(정상 수집)과 수집 실패 구분 ───────────────────────────────
{
  const r = A.monthAds({
    month: "2026-09", today: "2026-09-04",
    autoRows: [row("2026-09-01", 10000), row("2026-09-03", 5000)],
    collections: [okColl("2026-09-01", 10000), okColl("2026-09-02", 0), okColl("2026-09-03", 5000)],
    manualRows: [], refs: [rangeRef("2026-09", "2026-09-01", "2026-09-03", 15000)],
  });
  check(r.state === A.STATE.CONFIRMED, "09-02 0원은 정상 수집(OK, 행 없음) → 확정(대사 일치)", r.state);
  check(r.days.find((x) => x.date === "2026-09-02").status === "OK", "0원 날짜 상태 OK");
  check(r.totals.net === 15000, "월 합계(공급가액) 15,000", r.totals);
  check(r.todayPending === true, "오늘(09-04)은 내일 수집 - 미확정 계산에서 제외하고 따로 표시");
  check(!r.undeterminedDays.includes("2026-09-04"), "오늘은 미확정 일자에 넣지 않음");

  const f = A.monthAds({
    month: "2026-09", today: "2026-09-04",
    autoRows: [row("2026-09-01", 10000), row("2026-09-03", 5000)],
    collections: [okColl("2026-09-01", 10000), failColl("2026-09-02", "SESSION_EXPIRED: 세션 만료", "2026-09-02T22:10:00Z"), okColl("2026-09-03", 5000)],
    manualRows: [],
  });
  check(f.state === A.STATE.UNDETERMINED, "09-02 수집 실패 → 월 광고비 미확정", f.state);
  check(JSON.stringify(f.undeterminedDays) === JSON.stringify(["2026-09-02"]), "미확정 일자 = 09-02", f.undeterminedDays);
  check(f.lastFailure && /SESSION_EXPIRED/.test(f.lastFailure.error), "마지막 실패 사유 표시용", f.lastFailure);
  check(!f.rows.some((x) => x.date === "2026-09-02"), "실패일을 0원 행으로 넣지 않음");
  const nullTotal = A.monthAds({ month: "2026-09", today: "2026-09-02",
    collections: [{ expense_date: "2026-09-01", status: "OK", total_amount: null, vat_included: false, collected_at: "2026-09-01T22:00:00Z" }], manualRows: [] });
  check(nullTotal.state === A.STATE.UNDETERMINED, "OK 인데 합계가 비어 있는 이력은 0원으로 보지 않고 미확정", nullTotal.state);

  const none = A.monthAds({ month: "2026-09", today: "2026-09-04", autoRows: [], collections: [], manualRows: [] });
  check(none.state === A.STATE.UNDETERMINED && none.undeterminedDays.length === 3, "수집 이력이 없으면 0원이 아니라 미확정(3일)", none.undeterminedDays);
}

// ── 2. 실패 후에도 기존 정상값 유지 ───────────────────────────────────────────
{
  const r = A.monthAds({
    month: "2026-09", today: "2026-09-10",
    autoRows: [row("2026-09-05", 7000)],
    collections: [...["01", "02", "03", "04", "06", "07", "08", "09"].map((d) => okColl(`2026-09-${d}`, 0)),
                  okColl("2026-09-05", 7000, "2026-09-05T22:10:00Z"),
                  failColl("2026-09-05", "AUTH_BLOCKED: 차단", "2026-09-08T22:10:00Z")],   // D+3 재수집 실패
    manualRows: [], refs: [rangeRef("2026-09", "2026-09-01", "2026-09-09", 7000)],
  });
  const d5 = r.days.find((x) => x.date === "2026-09-05");
  check(d5.status === "OK" && r.totals.net === 7000, "D+3 재수집이 실패해도 09-05 기존 정상값 7,000 유지", { d5, t: r.totals });
  check(d5.failedAfterOk === true && /AUTH_BLOCKED/.test(d5.lastError), "기존값 유지 + 최근 실패 사유 표시", d5);
  check(r.state === A.STATE.CONFIRMED, "정상값이 있으므로 확정 유지");
}

// ── 3. 수동 입력 중복 방지 ──────────────────────────────────────────────────
{
  const manualRows = [
    { id: "m1", date: "2026-08-27", channel: null, amount: 59365, memo: "", created_by: "장팀장" },
    { id: "m2", date: "2026-09-02", channel: null, amount: 11000, memo: "쿠팡 광고", created_by: "장팀장" },
    { id: "m3", date: "2026-09-03", channel: null, amount: -2200, memo: "광고 크레딧 환급", created_by: "장팀장", adjustment_reason: "쿠팡 광고 크레딧 환급(청구서 9월분)" },
  ];
  const sep = A.monthAds({
    month: "2026-09", today: "2026-09-04",
    autoRows: [row("2026-09-02", 10000)],
    collections: [okColl("2026-09-01", 0), okColl("2026-09-02", 10000), okColl("2026-09-03", 0)],
    manualRows, manualVatIncluded: true,
  });
  const m2 = sep.manual.find((m) => m.id === "m2");
  check(m2.decision === "RECONCILIATION_NEEDED" && m2.included === false, "자동수집 날짜의 일반 수동 입력은 제외 + RECONCILIATION_NEEDED", m2);
  check(m2.autoSameDay === 11000, "같은 날 자동수집 금액(부가세 포함 11,000) 함께 표시", m2);
  check(sep.reconciliationNeeded.length === 1, "중복 확인 필요 1건");
  const m3 = sep.manual.find((m) => m.id === "m3");
  check(m3.decision === "INCLUDED_ADJUSTMENT" && m3.included, "보정 사유가 있는 수동 행은 별도 포함", m3);
  check(sep.totals.net === 10000 + -2000, "합계 = 자동 10,000 + 보정 −2,000 (수동 11,000 은 더하지 않음)", sep.totals);
  check(!sep.manual.some((m) => m.id === "m1"), "다른 달 수동 행은 이 달 계산에 없음");

  const aug = A.monthAds({ month: "2026-08", today: "2026-09-04", autoRows: [], collections: [], manualRows, manualVatIncluded: true });
  check(aug.state === A.STATE.MANUAL_ONLY, "자동수집 시작 전 달(8월)은 수동 입력 기준", aug.state);
  check(aug.manual[0].decision === "INCLUDED_PRE_AUTO" && aug.totals.net === Math.round(59365 / 1.1), "8월 수동 행은 포함(공급가액)", aug.totals);
}

// ── 4. 음수 환급 부호 보존 · 부가세 기준 ───────────────────────────────────
{
  const r = A.monthAds({
    month: "2026-09", today: "2026-09-03",
    collections: [okColl("2026-09-01", 10000 - 1500), okColl("2026-09-02", 11000, undefined, true)],
    manualRows: [],
  });
  const d1 = r.days.find((x) => x.date === "2026-09-01").auto;
  check(d1.net === 8500 && d1.vat === 850, "환급 −1,500 부호 보존(원천 합계 8,500) → 공급가액 8,500 · 부가세 850", d1);
  const neg = A.monthAds({ month: "2026-09", today: "2026-09-02", collections: [okColl("2026-09-01", -3000)], manualRows: [] });
  check(neg.totals.net === -3000 && neg.totals.vat === -300, "그날 전체가 환급(−3,000)이어도 부호 그대로", neg.totals);
  const d2 = r.days.find((x) => x.date === "2026-09-02").auto;
  check(d2.net === 10000 && d2.vat === 1000, "부가세 포함 원천 11,000 → 공급가액 10,000 · 부가세 1,000", d2);
  check(r.totals.net === 18500 && r.totals.vat === 1850, "월 합계 공급가액 18,500 · 부가세 1,850", r.totals);

  const unk = A.monthAds({ month: "2026-09", today: "2026-09-02",
                           collections: [okColl("2026-09-01", 5000, undefined, null)], manualRows: [] });
  check(unk.state === A.STATE.UNDETERMINED, "부가세 포함 여부를 모르는 원천은 계산하지 않고 미확정", unk.state);

  const off = A.splitVat(11000, true, false);
  check(off.net === 11000 && off.vat === 0, "부가세 계산을 끈 설정에서는 원천 금액 그대로");
}

// ── 5. KST 날짜·월 경계 ─────────────────────────────────────────────────────
{
  const r = A.monthAds({
    month: "2026-09", today: "2026-10-01",
    autoRows: [row("2026-08-31", 999), row("2026-09-30", 3000), row("2026-10-01", 777)],
    collections: [okColl("2026-08-31", 999), okColl("2026-09-30", 3000), okColl("2026-10-01", 777),
                  ...A.monthDays("2026-09").filter((d) => d !== "2026-09-30").map((d) => okColl(d, 0))],
    manualRows: [], refs: [rangeRef("2026-09", "2026-09-01", "2026-09-30", 3000), rangeRef("2026-10", "2026-10-01", "2026-10-01", 777)],
  });
  check(r.totals.net === 3000, "9월 합계는 09-01~09-30 만(08-31, 10-01 제외)", r.totals);
  check(r.state === A.STATE.CONFIRMED && !r.todayPending, "10-01 에 본 9월은 30일 모두 수집되면 확정", { s: r.state, p: r.todayPending });
  check(A.monthDays("2026-02").length === 28 && A.addDays("2026-09-30", 1) === "2026-10-01", "월 길이·날짜 더하기(UTC 고정, 기기 시간대 무관)");
  const fut = A.monthAds({ month: "2026-09", today: "2026-09-05",
                           collections: [okColl("2026-09-20", 5000)], manualRows: [] });
  check(!fut.rows.some((x) => x.date === "2026-09-20"), "미래 날짜 행은 계산하지 않음");
}

// ── 5b. 공헌이익 탭 광고비 카드 렌더 ─────────────────────────────────────
{
  const info = A.monthAds({
    month: "2026-09", today: "2026-09-11",
    collections: [okColl("2026-09-01", 12000), okColl("2026-09-02", 0),
                  failColl("2026-09-03", "SESSION_EXPIRED: SSO 세션이 끝남", "2026-09-03T22:10:00Z"),
                  ...["04", "05", "06", "07", "08", "09", "10"].map((d) => okColl(`2026-09-${d}`, 1000))],
    manualRows: [{ id: "m9", date: "2026-09-02", channel: null, amount: 5500, memo: "수기", created_by: "장팀장" }],
    manualVatIncluded: true,
  });
  const html = A.cardHtml(info, [
    { expense_date: "2026-09-01", campaign_id: "C1", campaign_name: "휴지통 캠페인", vendor_item_id: "95928210719",
      product_name: "모노플랫 휴지통", amount: 12000, impressions: 3000, clicks: 40, ad_sales: 90000 }]);
  check(html.includes("광고비 미확정") && html.includes("정상 수집이 없는 날: 09-03"), "미확정 상태·미확정 일자(09-03) 표시");
  check(/마지막 정상 수집 .*KST/.test(html), "마지막 정상 수집 시각 표시");
  check(html.includes("쿠팡 세션 만료") && html.includes("기존 정상 광고비는 그대로 유지"), "실패 사유 + 기존값 유지 안내(원문 명령·경로 없이)");
  check(html.includes("광고비 새로고침") && html.includes("AdCosts.refreshClick(this)") && html.includes('data-month="2026-09"'), "광고비 새로고침 버튼(이 달)");
  check(html.includes("＋ 수동 광고비 입력"), "수동 입력 버튼 유지(자동수집과 구분된 이름)");
  check(html.includes("계산 제외 · 중복 확인 필요") && html.includes("같은 날 자동수집 ₩0"), "수동 행 중복 경고(같은 날 자동수집 금액 함께)");
  check(html.includes("휴지통 캠페인") && html.includes("옵션 95928210719"), "캠페인·상품별 상세");
  check(html.includes("원천: WING 광고 지표(일별 집행 광고비, 부가세 별도)"), "출처·부가세 기준 표시");
  check(!/SSO 세션이 끝남/.test(html), "서버 원문 오류를 그대로 노출하지 않고 사람 말로 바꿈");
  check(A.cmBadge(info).includes("공헌이익 미확정"), "상단 공헌이익 옆 '미확정' 배지");
  const ok = A.monthAds({ month: "2026-09", today: "2026-09-02", collections: [okColl("2026-09-01", 100)], manualRows: [],
                          refs: [rangeRef("2026-09", "2026-09-01", "2026-09-01", 100)] });
  check(A.cmBadge(ok).includes("오늘 광고비는 내일 수집 후 반영") && !A.cmBadge(ok).includes("미확정"), "정상일 땐 오늘분 안내만");
  const x = A.cardHtml(A.monthAds({ month: "2026-09", today: "2026-09-02", collections: [],
    manualRows: [{ id: "<img src=x onerror=alert(1)>", date: "2026-09-01", amount: 1, memo: "<script>alert(1)</script>" }] }), []);
  check(!x.includes("<script>alert") && !x.includes("<img src=x"), "메모·ID 는 이스케이프(HTML 주입 차단)");
}

// ── 5c. 월 대사: 일별 합계 = WING 구간 합계일 때만 확정 ─────────────────────
{
  // 2026-09-01~10 실측값 그대로 (일별 조회 합 646,517 / 구간 조회 646,490)
  const daily = { "01": 99789, "02": 95408, "03": 64667, "04": 69560, "05": 68463, "06": 64704, "07": 59309, "08": 47484, "09": 38595, "10": 38538 };
  const colls = Object.entries(daily).map(([d, v]) => okColl(`2026-09-${d}`, v));
  const settle = { month: "2026-09", ref_type: "WING_RG_AD_SETTLEMENT", amount: 611364, billable_amount: 608233, vat_amount: 60824,
    billed_amount: 669057, vat_included: false, collected_at: "2026-09-11T07:20:00+09:00",
    campaigns: [{ ad_type: "PA", campaign_name: "원터치 휴지통", clicks: 1720, amount: 173273, billable_amount: 172041 },
                { ad_type: "PA", campaign_name: "구름목욕시간", clicks: 329, amount: 82073, billable_amount: 82073 }] };
  const mis = A.monthAds({ month: "2026-09", today: "2026-09-11", collections: colls, manualRows: [],
                           refs: [rangeRef("2026-09", "2026-09-01", "2026-09-10", 646490), settle] });
  check(mis.state === A.STATE.ROUNDING_DIFFERENCE, "A안: 일별 합 646,517 ≠ 기간 646,490 → ROUNDING_DIFFERENCE(공헌이익 반영, 잠정)", mis.state);
  check(mis.recon.diff === 27 && mis.recon.dailySum === 646517, "차이 27원을 그대로 보여줌(보정 없음)", mis.recon);
  check(mis.totals.net === 646517, "A안: ERP 광고비 = 일별 합계 646,517 그대로(27원을 날짜·캠페인에 배분·보정하지 않음)", mis.totals);
  check(mis.rows.filter((r) => r.source === "AUTO").reduce((s2, r) => s2 + r.net, 0) === 646517 && mis.rows.length === 10, "계산 행 10일 = 일별 원천값 그대로(차이 행을 만들지 않음)");
  check(A.cmBadge(mis).includes("잠정 · 쿠팡 기간 합계와 27원 차이") && !A.cmBadge(mis).includes("미확정"), "상단 배지: '잠정 · 쿠팡 기간 합계와 27원 차이'(0원·미수집 처리 아님)", A.cmBadge(mis));
  const h = A.cardHtml(mis, []);
  check(h.includes("잠정 · 쿠팡 기간 합계와 27원 차이") && h.includes("₩646,517") && h.includes("₩646,490") && h.includes("₩27 · 반올림 차이") && h.includes("ROUNDING_DIFFERENCE"), "대사 패널: 일별 합·기간 합·차이(ROUNDING_DIFFERENCE)");
  check(h.includes("로켓그로스 정산 청구가능 광고비") && h.includes("₩608,233") && h.includes("부가세 ₩60,824 별도"), "정산 청구가능 광고비·부가세 별도 표시");
  check(h.includes("원터치 휴지통") && h.includes("₩172,041"), "캠페인별 광고비(정산 광고비 내역)");
  const matched = A.monthAds({ month: "2026-09", today: "2026-09-11", collections: colls, manualRows: [],
                               refs: [rangeRef("2026-09", "2026-09-01", "2026-09-10", 646517)] });
  check(matched.state === A.STATE.CONFIRMED && matched.recon.matched, "구간 합계가 정확히 같으면 확정", matched.state);
  const older = A.monthAds({ month: "2026-09", today: "2026-09-11", collections: colls, manualRows: [],
    refs: [rangeRef("2026-09", "2026-09-01", "2026-09-10", 646517, "2026-09-11T07:00:00+09:00"),
           rangeRef("2026-09", "2026-09-01", "2026-09-10", 646490, "2026-09-11T08:00:00+09:00")] });
  check(older.state === A.STATE.ROUNDING_DIFFERENCE, "월 참고값은 가장 최근 수집을 씀", older.state);
  const hole = A.monthAds({ month: "2026-09", today: "2026-09-11", collections: colls.filter((c) => c.expense_date !== "2026-09-05"),
                            manualRows: [], refs: [rangeRef("2026-09", "2026-09-01", "2026-09-10", 646490)] });
  check(hole.state === A.STATE.UNDETERMINED && hole.recon.diff === null, "기간 안에 미확정 날짜가 있으면 대사하지 않고 미확정", hole.recon);
  const noref = A.monthAds({ month: "2026-09", today: "2026-09-11", collections: colls, manualRows: [] });
  check(noref.state === A.STATE.PENDING_RECON && noref.totals.net === 646517 && A.cmBadge(noref).includes("대사 전"), "기간 합계를 아직 못 받았으면 일별 합계 반영 + '잠정 · 대사 전'", noref.state);
}

// ── 6. 브라우저 파일에 비밀값 없음 ─────────────────────────────────────────
{
  const banned = [/service_role/i, /SUPABASE_SECRET/i, /sb_secret_/i, /KEYCLOAK/i, /JSESSIONID/i, /COUPANG_(ACCESS|SECRET)/i, /Bearer\s+[A-Za-z0-9]/];
  check(!banned.some((re) => re.test(src)), "ad_costs.js 에 키·쿠키 이름/값 없음");
  check(!/\.(insert|update|delete|upsert)\(/.test(src), "ad_costs.js 는 쓰기 호출이 없음(조회·계산만)");
}

console.log(failures ? `\n실패 ${failures}건` : "\n전부 통과");
process.exit(failures ? 1 : 0);
