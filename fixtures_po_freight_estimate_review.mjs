// fixtures_po_freight_estimate_review.mjs
// ------------------------------------------------
// 2026-09-12 [사용자 확정] 발주서 '예상 운송비' 검토 표시 - 374,000원(=187,000원 이중) 수정 확인(네트워크 0건).
// js/inbound_freight.js 는 실제 파일, app.js 의 loadPOFreightReview 는 소스에서 실제 정의를 잘라 실행(미러 아님).
//   1) PO-016 모양(살아 있는 운송 없음): '활성 예상 운송비 ₩0' · 적용 링크 없음 · 187,000 은 무효·대체 이력(합산 안 함)으로만
//   2) 결과 모르는 요청은 확인 항목으로 따로
//   3) 살아 있는 묶음 합계가 저장값과 다르면 예전처럼 적용 제안(금액 = 활성 합계)
//   4) 저장값과 같으면 제안 없음(이력만) · 연결된 자동입고 없으면 아무것도 안 보임
//   5) 예전 서버 응답(새 필드 없음)도 그대로 동작
import { readFileSync } from "fs";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
const app = read("./js/app.js");
let fails = 0;
const check = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(got)}, 기대=${JSON.stringify(want)})`}`);
  if (!ok) fails++;
};
const grabFn = name => {
  const m = app.match(new RegExp(`\\n(async )?function ${name}\\([\\s\\S]*?\\n}`));
  if (!m) throw new Error(`${name} 없음`);
  return m[0];
};

const el = { innerHTML: "" };
let nextResult = null, fetches = 0;
const ctx = vm.createContext({
  console, Map, Set, JSON, Number, String, encodeURIComponent,
  document: { getElementById: id => (id === "po-freight-review" ? el : null) },
  sb: { auth: { getSession: async () => ({ data: { session: { access_token: "jwt" } } }) } },
  fetch: async () => { fetches++; return { ok: true, json: async () => nextResult }; },
  LIVE_STOCK_API_BASE: "https://fixture.invalid",
  CoupangCenters: { load: async () => {}, label: () => "목천1센터 (MCN1)" },
  fmt: v => Number(v).toLocaleString("en-US"),
  esc: v => String(v),
});
vm.runInContext(read("./js/inbound_freight.js"), ctx);
vm.runInContext(grabFn("loadPOFreightReview"), ctx);
const IF = vm.runInContext("InboundFreight", ctx);
const show = async (result, current) => { el.innerHTML = ""; nextResult = result; await vm.runInContext(`loadPOFreightReview("po-016", ${current})`, ctx); return el.innerHTML; };

const HIST = [{ shipment_group_id: "b28edc90-f651", status: "VOID_PENDING_REBUILD", gross_amount: 187000 },
              { shipment_group_id: "e0eb258d-9666", status: "SUPERSEDED", gross_amount: 187000 }];

console.log("=== 1. PO-016 모양 - 살아 있는 운송 없음 ===");
const po16 = { total_freight_est: null, active_total: 0, active_group_count: 0, groups: [], plan_count: 0, history: HIST, needs_review: [] };
check(IF.estimateReview(po16, 187000).mode, "inactive", "[핵심] 판정: 활성 운송 없음");
let html = await show(po16, 187000);
check([html.includes("활성 예상 운송비 ₩0"), html.includes("적용 →"), html.includes("374,000")], [true, false, false],
      "[핵심] '활성 예상 운송비 ₩0' · 적용 링크 없음 · 374,000 없음");
check([html.includes("b28edc90") && html.includes("무효 · 재작성 대기"), html.includes("e0eb258d") && html.includes("대체됨"),
       (html.match(/합산 안 함/g) || []).length], [true, true, 2], "[핵심] 187,000 은 무효·대체 이력으로만(합산 안 함 2줄)");

console.log("\n=== 2. 결과 모르는 요청은 확인 항목 ===");
html = await show({ ...po16, needs_review: [{ kind: "plan", plan_id: "e2c1ec84-xxxx", status: "RECOVERY_NEEDED" }] }, 187000);
check([html.includes("확인 필요: 요청"), html.includes("RECOVERY_NEEDED"), html.includes("적용 →")], [true, true, false], "확인 항목으로 따로 · 적용 없음");
html = await show({ ...po16, history: [], needs_review: [{ kind: "shipment_group", shipment_group_id: "rev1", status: "NEEDS_REVIEW" }] }, 0);
check([html.includes("확인 필요: 운송 묶음"), html.includes("검토 필요")], [true, true], "NEEDS_REVIEW 묶음 확인 항목");

console.log("\n=== 3. 살아 있는 묶음 - 저장값과 다르면 적용 제안 ===");
const act = { total_freight_est: 187000, active_total: 187000, active_group_count: 1, plan_count: 2,
              groups: [{ consolidated: true, vehicle_type: "5톤", total_pallet_count: 6, destination_center_id: "c", excluded_individual_costs: [132000, 88000] }],
              history: [HIST[1]], needs_review: [] };
html = await show(act, 0);
check([html.includes("적용 →"), html.includes("applyPOFreightEstimate('po-016', 187000)"), html.includes("대체됨")], [true, true, true],
      "[핵심] 적용 제안 금액 = 활성 합계 187,000 · 대체 이력도 같이");
html = await show({ ...act, total_freight_est: 374000, active_total: 374000, active_group_count: 2 }, 187000);
check(html.includes("applyPOFreightEstimate('po-016', 374000)"), true, "서로 다른 활성 묶음 2개면 374,000 이 맞는 제안");

console.log("\n=== 4. 저장값과 같음 · 자동입고 없음 ===");
html = await show(act, 187000);
check([html.includes("적용 →"), html.includes("대체됨")], [false, true], "저장값과 같으면 제안 없이 이력만");
html = await show({ total_freight_est: null, groups: [], plan_count: 0 }, 0);
check(html, "", "연결된 자동입고 없음 → 아무것도 안 보임");

console.log("\n=== 5. 예전 서버 응답(새 필드 없음) ===");
html = await show({ total_freight_est: 99000, groups: [{ selection_reason: "천안1센터 (CHA1)" }], plan_count: 1 }, 0);
check([html.includes("적용 →"), html.includes("99,000")], [true, true], "예전 응답도 적용 제안 그대로");
check(fetches > 0, true, "fetch 는 가짜(네트워크 0건)");

console.log(`\n=== 결과: ${fails ? `실패 ${fails}건` : "전체 통과"} ===`);
process.exit(fails ? 1 : 0);
