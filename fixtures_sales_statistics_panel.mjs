/* fixtures_sales_statistics_panel.mjs
 * 2026-09-10 [사용자 지시: "데이터가 없거나 수집 실패 상태이면 0원으로 표시하지
 * 말고 `수집 대기` 또는 `DATA_CHECK_NEEDED`로 표시", "화면에서 기준을
 * `쿠팡 판매통계 순매출`로 명시", "미매핑 옵션도 옵션명과 쿠팡 옵션 ID로 표시"]
 *
 * *** 네트워크 0건 *** - 렌더 함수만 호출하는 격리 테스트예요.
 * 실행: node fixtures_sales_statistics_panel.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "js/sales_statistics_panel.js"), "utf8");
const global_ = { WING_SUBMIT_API_BASE: "http://test.invalid" };
new Function("window", src)(global_);
const P = global_.SalesStatisticsPanel;

let failures = 0;
const check = (actual, expected, label) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}`);
  if (!ok) console.log(`       기대=${JSON.stringify(expected)}\n       실제=${JSON.stringify(actual)}`);
};

const OK_PAYLOAD = {
  date: "2026-09-09",
  display_status: "OK",
  basis_label: "쿠팡 판매통계 순매출",
  last_collected_at: "2026-09-10T11:28:00+09:00",
  rocket_growth: {
    display_status: "OK", basis_label: "쿠팡 판매통계 순매출",
    gross_qty: 36, gross_amount: 491970, cancel_qty: 7, cancel_amount: 124760,
    net_qty: 29, net_amount: 367210,
    unmatched_option_count: 1, unmatched_net_amount: 14380,
  },
  marketplace: { net_qty: 0, net_amount: 0 },
  by_option: [
    { option_id: "95928210719", product_name: "모노플랫 우든 원터치 가정용 쓰레기통 휴지통 7L",
      option_unit: "본품", gross_qty: 26, gross_amount: 309400, cancel_qty: 1,
      cancel_amount: 11900, net_qty: 25, net_amount: 297500, mapping_status: "MATCHED",
      reconciliation_status: "RECONCILIATION_MISMATCH",
      reconciliation_qty_diff: -1, reconciliation_amount_diff: -11900 },
    { option_id: "95936822309", product_name: "모노플랫 논슬립 EPP 욕실 다용도실 발판 70x48cm x 2set",
      option_unit: "그레이, 2개", gross_qty: 0, gross_amount: 0, cancel_qty: 6,
      cancel_amount: 112860, net_qty: -6, net_amount: -112860, mapping_status: "MATCHED",
      reconciliation_status: "MATCH" },
    { option_id: "95928560700", product_name: "모노플랫 제습제 습기제거제 12입 옷장 화장실 염화칼슘",
      option_unit: "12개, 600ml", gross_qty: 1, gross_amount: 14380, cancel_qty: 0,
      cancel_amount: 0, net_qty: 1, net_amount: 14380, mapping_status: "UNMATCHED",
      reconciliation_status: "MATCH" },
  ],
  reconciliation_alerts: [
    { option_id: "95928210719", product_name: "모노플랫 우든 원터치 가정용 쓰레기통 휴지통 7L",
      qty_diff: -1, amount_diff: -11900 },
  ],
};

console.log("\n=== A. 정상 렌더 (2026-09-09) ===");
const html = P.render(OK_PAYLOAD);
check(html.includes("367,210원"), true, "[핵심] 순매출 367,210원 표시");
check(html.includes("29개"), true, "[핵심] 순수량 29개 표시");
check(html.includes("쿠팡 판매통계 순매출"), true, "[필수] 기준을 화면에 명시");
check(html.includes("124,760원") && html.includes("7개"), true, "[필수] 반품·취소 7개 / 124,760원");
check(html.includes("판매통계 ‘총 취소’ 열"), true, "취소 출처를 화면에 표기");

console.log("\n=== B. 옵션별 표시 ===");
check(html.includes("-6개") && html.includes("-112,860원"), true, "[필수] EPP −6개 / −112,860원");
check(html.includes("그레이, 2개"), true, "[필수] 세트 단위 그대로 표시(낱개 환산 없음)");
check(html.includes("쿠팡 옵션 ID 95928560700"), true, "[필수] 미매핑도 쿠팡 옵션 ID로 표시");
check(html.includes("모노플랫 제습제 습기제거제 12입 옷장 화장실 염화칼슘"), true,
  "[필수] 미매핑도 옵션명 표시");
check(html.includes("상품 미매핑"), true, "[필수] 미매핑 뱃지");
check(html.includes("14,380원"), true, "[필수] 미매핑 1개 / 14,380원이 화면에 남아 있음");
check(html.includes("총계에 포함"), true, "[필수] 미매핑이 총계에 포함된다고 안내");

console.log("\n=== C. 정산 대사 경고 ===");
check(html.includes("정산 대사 차이"), true, "[필수] 대사 경고 표시");
check(html.includes("1개") && html.includes("11,900원"), true, "[필수] 1개 / 11,900원");
check(html.includes("어느 쪽도 임의로 보정하지 않았어요"), true, "[필수] 매출값 미변경 명시");
check(html.includes("367,210원"), true, "[필수] 경고가 있어도 매출은 그대로");

console.log("\n=== D. 수집 대기 - 0원으로 그리지 않음 ===");
const waiting = P.render({
  date: "2026-09-11", display_status: "수집 대기", basis_label: "쿠팡 판매통계 순매출",
  rocket_growth: { net_qty: null, net_amount: null, gross_qty: null, gross_amount: null,
    cancel_qty: null, cancel_amount: null }, marketplace: {}, by_option: [],
});
check(waiting.includes("수집 대기"), true, "[필수] '수집 대기' 표시");
check(waiting.includes("매출 0원이 아니라 미수집"), true, "[필수] 0원 아님을 명시");
check(waiting.includes("0원"), true, "  (문구상 '0원이 아니라'로만 등장)");
check(/ss-card-value">0원</.test(waiting), false, "[필수] 카드에 0원을 숫자로 찍지 않음");
check(waiting.includes("—"), true, "[필수] 값 없음은 대시로 표시");
check(waiting.includes("<table"), false, "미수집이면 옵션 표를 그리지 않음");

console.log("\n=== E. 수집 실패 - DATA_CHECK_NEEDED ===");
const failed = P.render({
  date: "2026-09-09", display_status: "DATA_CHECK_NEEDED", basis_label: "쿠팡 판매통계 순매출",
  rocket_growth: { net_qty: null, net_amount: null, gross_qty: null, gross_amount: null,
    cancel_qty: null, cancel_amount: null,
    collection_error: "헤더에 필요한 열이 없어요: ['순 판매 금액(전체 거래 금액 - 취소 금액)']" },
  marketplace: {}, by_option: [],
});
check(failed.includes("DATA_CHECK_NEEDED"), true, "[필수] DATA_CHECK_NEEDED 표시");
check(failed.includes("기존 데이터는 그대로 유지"), true, "[필수] 기존 유지 안내");
check(failed.includes("필요한 열이 없어요"), true, "[필수] 실패 사유 노출");
check(/ss-card-value">0원</.test(failed), false, "[필수] 0원으로 그리지 않음");

console.log("\n=== F. 브리핑 한 줄 ===");
const brief = P.briefingLine({
  ready: true, net_qty: 29, net_amount: 367210, cancel_qty: 7, cancel_amount: 124760,
  basis_label: "쿠팡 판매통계 순매출",
  reconciliation_alerts: [{ qty_diff: -1, amount_diff: -11900 }],
});
check(brief.includes("367,210원") && brief.includes("29개"), true, "[핵심] 브리핑 순매출");
check(brief.includes("쿠팡 판매통계 순매출"), true, "[필수] 브리핑에 기준 명시");
check(brief.includes("정산 대사 차이"), true, "[필수] 브리핑에 대사 경고");
const brief0 = P.briefingLine({ ready: false, display_status: "수집 대기" });
check(brief0.includes("0원 아님"), true, "[필수] 미수집 브리핑은 0원 아님을 명시");
check(/>0원</.test(brief0), false, "[필수] 브리핑에 0원 숫자를 찍지 않음");

console.log("\n=== G. XSS 이스케이프 ===");
const xss = P.render({
  date: "2026-09-09", display_status: "OK", basis_label: "x",
  rocket_growth: { net_qty: 1, net_amount: 1, gross_qty: 1, gross_amount: 1,
    cancel_qty: 0, cancel_amount: 0 },
  marketplace: {}, by_option: [{ option_id: "<img src=x onerror=alert(1)>",
    product_name: "<script>bad()</script>", option_unit: null, gross_qty: 1,
    gross_amount: 1, cancel_qty: 0, cancel_amount: 0, net_qty: 1, net_amount: 1,
    mapping_status: "MATCHED", reconciliation_status: "MATCH" }],
});
check(xss.includes("<script>bad()"), false, "옵션명이 이스케이프됨");
check(xss.includes("&lt;img src=x"), true, "옵션 ID도 이스케이프됨");

console.log("\n=== H. 인증 방식 ===");
// 목적은 "프런트에 시크릿을 심지 않는 것"이지 "인증하지 않는 것"이 아니에요.
// 사용자 Supabase 세션 JWT 를 그대로 재사용합니다(app.js 기존 방식과 동일).
check(src.includes("sb.auth.getSession"), true, "[필수] 세션 JWT 를 Supabase 클라이언트에서 가져옴");
check(src.includes("Authorization: `Bearer ${jwt}`"), true, "[필수] Authorization 헤더로 전송");
check(/sb_secret_|service_role|SUPABASE_SERVICE|SUPABASE_SECRET/.test(src), false,
  "[필수] 시크릿 키 문자열이 패널에 없음");
check(/apikey/.test(src), false, "[필수] apikey 헤더를 직접 만들지 않음");
check(src.includes('credentials: "omit"'), true, "쿠키는 보내지 않음");

console.log(`\n=== 결과: ${failures === 0 ? "전체 통과" : failures + "건 실패"} ===`);
process.exit(failures === 0 ? 0 : 1);
