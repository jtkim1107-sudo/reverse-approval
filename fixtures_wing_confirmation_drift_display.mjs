// fixtures_wing_confirmation_drift_display.mjs
// ------------------------------------------------
// 2026-09-28 WING_DIRECT_CONFIRMATION_DRIFT 표시 전용 개선 검증(네트워크 0건).
//   SKU 95981694042 / ERP 1M1D-013-02 운영 응답 형태 그대로(decision=DATA_CHECK, decision_reason_code=QUALITY_FLAG,
//   decision_check_label='⚠️ 데이터 확인 필요', decision_reason='WING_DIRECT_CONFIRMATION_DRIFT').
//   1) 짧은 문구·상세 문구가 사람이 읽을 문구로 보임
//   2) 우선순위: 서버 human label → 구체 decision_check_label → 알려진 코드 매핑 → 기존 동작
//   3) 판정·행 객체는 그대로(표시만), 다른 상품 배지/문구는 이전 erp_ui.js(bc0b22f, v=4) 와 한 글자도 안 달라짐
//   4) 후보 승인·WING 복구(제출) 모듈은 표시 문구를 판단에 쓰지 않음
import { readFileSync } from "fs";
import { execSync } from "child_process";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
let fails = 0, passes = 0;
const check = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(got)}, 기대=${JSON.stringify(want)})`}`);
  if (ok) passes++; else fails++;
};
const load = src => { const ctx = vm.createContext({ console }); vm.runInContext(src, ctx); return ctx.ErpUi; };
const UI = load(read("./js/erp_ui.js"));
let OLD = null;
try { OLD = load(execSync("git show bc0b22f:js/erp_ui.js", { cwd: new URL(".", import.meta.url).pathname, encoding: "utf8" })); } catch { /* git 없으면 비교 생략 */ }
const decode = s => String(s).replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const SHORT = "WING 확정 후 수량 변동 – 재확정 필요";
const DETAIL = "WING 직접입고 최종수량을 사람이 확정한 뒤 WING 값이 바뀌었어요(확정 지문 불일치). 안전하게 확정을 쓰지 않고 다시 사람 확인으로 두었어요. 시스템·관리자 도구 › WING 직접입고 최종수량 정정에서 다시 확정하면 재고 판단이 풀려요.";

// 운영 응답(2026-09-28 19:42 KST 캐시)에서 표시에 쓰는 필드만 발췌
const LIVE = {
  vendor_item_id: "95981694042", product_name: "모드라이프 원형 테니스공 체어슈즈 의자발커버 바닥보호", option_name: "베이지 16개 중",
  decision: "DATA_CHECK", decision_reason_code: "QUALITY_FLAG", decision_check_label: "⚠️ 데이터 확인 필요", decision_label: "⚠️ 데이터확인",
  decision_reason: "WING_DIRECT_CONFIRMATION_DRIFT", data_quality_flags: ["WING_DIRECT_CONFIRMATION_DRIFT"],
  automation_blocked: false, automation_ready: false, automation_ready_label: "재고 판단 확인 필요",
  recommended_order_qty_ea: null, recommended_order_qty_box: null, incoming_qty: 0, live_stock: 22,
};

console.log("[1] 해당 SKU - 짧은 문구 + 상세 문구");
const before = JSON.stringify(LIVE);
const b = decode(UI.decisionBadge(LIVE));
check(b.includes(`확인 필요<span class="erp-badge-reason">${SHORT}</span>`), true, "배지: '확인 필요' + 짧은 문구");
check(b.includes(`title="${DETAIL}"`), true, "배지 title: 상세 문구");
check(b.includes("WING_DIRECT_CONFIRMATION_DRIFT"), false, "원시 코드가 화면에 안 보임");
check(b.includes("erp-badge--check"), true, "배지 종류는 그대로 check(DATA_CHECK)");
check(UI.checkReasonShort(LIVE), SHORT, "checkReasonShort = 짧은 문구");
check(UI.reasonText(LIVE.decision_reason), DETAIL, "reasonText(코드) = 상세 문구(모달 본문)");
check(UI.reasonText("  WING_DIRECT_CONFIRMATION_DRIFT "), DETAIL, "앞뒤 공백 있어도 매핑");
check(decode(UI.decisionBadge(LIVE, { noReason: true })).includes(SHORT), false, "noReason(대시보드) 은 사유 생략 그대로");
check(JSON.stringify(LIVE), before, "행 객체 변경 없음(판정·발주량 그대로)");
check([LIVE.decision, LIVE.recommended_order_qty_ea, LIVE.decision_reason_code], ["DATA_CHECK", null, "QUALITY_FLAG"], "판정 DATA_CHECK / 발주량 null 유지");

console.log("[2] 우선순위: 서버 human label → 구체 label → 코드 매핑 → 기존");
check(UI.checkReasonShort({ ...LIVE, decision_reason_human_label: "⚠️ 서버가 준 사람 문구" }), "서버가 준 사람 문구", "decision_reason_human_label 최우선");
check(UI.checkReasonShort({ ...LIVE, human_label: "서버 human" }), "서버 human", "human_label 최우선");
check(UI.checkReasonShort({ ...LIVE, decision_check_label: "⚠️ WING 확정값 재확인" }), "WING 확정값 재확인", "구체 decision_check_label 은 서버 문구 그대로");
check(UI.checkReasonShort({ ...LIVE, decision_reason: "", data_quality_flags: ["WING_DIRECT_CONFIRMATION_DRIFT"] }), SHORT, "decision_reason 없어도 QUALITY_FLAG 의 flags 에서 매핑");
check(UI.checkReasonShort({ ...LIVE, decision_reason: "SOME_NEW_FLAG", data_quality_flags: ["SOME_NEW_FLAG"] }), "데이터 확인 필요", "모르는 코드 → 기존 문구");
check(UI.reasonText("SOME_NEW_FLAG"), "SOME_NEW_FLAG", "reasonText 모르는 코드 → 그대로");
check(UI.reasonText("MISSING_PROCUREMENT_DATA: 발주정보 없음"), "발주정보 없음", "reasonText 코드 접두어 떼기 기존 동작");
check(UI.checkReasonShort({ decision: "DATA_CHECK", decision_reason_code: "SALES_THIN", decision_reason: "판매 데이터 부족",
  decision_check_label: "⚠️ 데이터 확인 필요", data_quality_flags: ["WING_DIRECT_CONFIRMATION_DRIFT"] }), "데이터 확인 필요",
  "사람 문구 사유 + QUALITY_FLAG 아님 → flags 로 덮어쓰지 않음(기존)");

console.log("[3] 다른 상품 표시 - 이전 erp_ui.js 와 동일");
const OTHERS = [
  { decision: "ORDER_NOW", decision_reason: "재고 7일분 이하" },
  { decision: "ORDER_SOON", decision_reason: "REORDER_WITHIN_LEAD_TIME_V1: 리드타임 안" },
  { decision: "AWAITING_INBOUND", decision_reason: "입고예정 있음" },
  { decision: "OK", decision_reason: "" },
  { decision: "RESTOCK_EXCLUDED", decision_reason: "재입고 제외" },
  { decision: "DATA_CHECK", decision_check_label: "⚠️ 판매 데이터 부족", decision_reason: "SALES_DATA_THIN: 판매 데이터 부족" },
  { decision: "DATA_CHECK", decision_check_label: "⚠️ 데이터 확인 필요", decision_reason_code: "QUALITY_FLAG",
    decision_reason: "WING_DIRECT_PO_OVERLAP_REVIEW", data_quality_flags: ["WING_DIRECT_PO_OVERLAP_REVIEW"] },
  { decision: "DATA_CHECK", decision_check_label: "⚠️ 물류정보 입력 필요", decision_reason: "MISSING_PROCUREMENT_DATA: 발주정보 없음",
    automation_blocked: true, automation_label: "물류정보 입력 필요" },
];
if (OLD) {
  for (const d of OTHERS) {
    check([UI.decisionBadge(d), UI.decisionBadge(d, { noReason: true }), UI.automationBadge(d), UI.reasonText(d.decision_reason)],
      [OLD.decisionBadge(d), OLD.decisionBadge(d, { noReason: true }), OLD.automationBadge(d), OLD.reasonText(d.decision_reason)],
      `${d.decision} ${d.decision_reason || ""} - 표시 동일`);
  }
  check(UI.automationBadge(LIVE), OLD.automationBadge(LIVE), "해당 SKU 자동화 배지도 이전과 동일(재고 판단 확인 필요)");
} else console.log("  (git 없음 - HEAD 비교 생략)");

console.log("[4] 표시 전용 - 판정·후보·WING 제출 경로에 안 섞임");
const src = read("./js/erp_ui.js");
check(/\b(rpc|from|fetch)\s*\(/.test(src.slice(src.indexOf("const REASON_LABELS"), src.indexOf("function reasonText"))), false, "매핑 코드에 서버 호출 없음");
for (const f of ["restock_candidate_approval.js", "restock_wing_recovery.js", "wing_direct_receipt_fix.js", "procurement_input.js"]) {
  const s = read(`./js/${f}`);
  check(/checkReasonShort|REASON_LABELS|ErpUi\.reasonText|decisionBadge/.test(s), false, `${f} 는 이 표시 문구를 판단에 안 씀`);
}
// app.js 데이터 품질 줄(dataQualityFlagLabel)도 ErpUi.reasonText 로 상세 문구
const app = read("./js/app.js");
const m = app.match(/const DATA_QUALITY_FLAG_LABEL = \{[\s\S]*?\n\};\nfunction dataQualityFlagLabel\(code\) \{[\s\S]*?\n\}/);
const ctx = vm.createContext({ ErpUi: UI });
vm.runInContext(`${m[0]}; globalThis.f = dataQualityFlagLabel;`, ctx);
check(ctx.f("WING_DIRECT_CONFIRMATION_DRIFT"), DETAIL, "상세 모달 데이터 품질 줄 = 상세 문구");
check(ctx.f("WING_DIRECT_PO_OVERLAP_REVIEW"), "WING 직접입고가 최근 발주서와 겹칠 수 있어 자동 반영 보류(겹침 검토 필요)", "기존 WING 플래그 문구 유지");
const idx = read("./index.html");
check(/js\/erp_ui\.js\?v=5"/.test(idx), true, "index.html erp_ui.js 캐시버전 v=5");

console.log(`\n${fails ? "FAIL" : "ALL PASS"} ${passes} / FAIL ${fails}`);
process.exit(fails ? 1 : 0);
