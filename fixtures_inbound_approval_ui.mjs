// fixtures_inbound_approval_ui.mjs
// ------------------------------------------------
// 2026-09-11 입고 요청 거절 + 쿠팡 센터명 한글 표시 - 화면 판단 검증(네트워크 0건).
// js/coupang_centers.js · js/inbound_approval.js 는 실제 파일을 그대로 실행하고,
// app.js 의 버튼 조건(rgActionsHtml 등)은 소스에서 실제 정의를 잘라 eval 해요(미러 아님).
import { readFileSync } from "fs";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
const ctx = vm.createContext({ console });
vm.runInContext(read("./js/coupang_centers.js"), ctx);
vm.runInContext(read("./js/inbound_approval.js"), ctx);
const { CoupangCenters: CC, InboundApproval: IA } = ctx;

let failures = 0;
const check = (a, e, label) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}` + (ok ? "" : ` (실제=${JSON.stringify(a)}, 기대=${JSON.stringify(e)})`));
  if (!ok) failures++;
};
const has = (h, n, label) => check(String(h).includes(n), true, label);
const hasNot = (h, n, label) => check(String(h).includes(n), false, label);
const plain = html => String(html).replace(/<small class="center-code">.*?<\/small>/g, "").replace(/<[^>]+>/g, "").trim();

// 운영 coupang_centers 에서 실제로 읽은 모양(이름·코드) 그대로
const MASTER = [
  { id: "c-cha1", center_name: "천안1", center_code: "CHA1" },
  { id: "c-mcn1", center_name: "목천1", center_code: "MCN1" },
  { id: "c-don1", center_name: "동탄1", center_code: "DON1" },
  { id: "c-inc4", center_name: "인천4", center_code: "INC4" },
  { id: "c-xrc14", center_name: "XRC14", center_code: "XRC14" },       // 마스터에 한글명 없음
  { id: "c-yon1", center_name: "용인1", center_code: "YON1" },
];

console.log("=== 1. 쿠팡 센터명(센터 마스터 하나로만) ===");
check(CC.text("CHA1"), "센터명 확인 필요 (코드: CHA1)", "마스터를 아직 못 읽었으면 추측하지 않고 '센터명 확인 필요'");
CC.setRows(MASTER);
check(CC.text("INC4"), "인천4센터", "알려진 코드 INC4 → 인천4센터");
check(CC.text("cha1"), "천안1센터", "소문자 코드도 같은 센터(천안1센터)");
check(CC.text({ id: "c-mcn1", code: "WRONG" }), "목천1센터", "destination_center_id 가 있으면 id 우선");
check(CC.text({ id: "c-mcn1" }), "목천1센터", "id 만 있어도 센터명");
check(CC.text("ZZZ9"), "센터명 확인 필요 (코드: ZZZ9)", "미등록 코드 → 센터명 확인 필요 (코드: ZZZ9)");
check(CC.text("XRC14"), "센터명 확인 필요 (코드: XRC14)", "마스터 이름이 코드 그대로(한글 없음) → 추측 금지, 확인 필요");
check(CC.text(""), "-", "코드·id 모두 없으면 -");
const h = CC.html("CHA1");
has(h, "천안1센터", "화면 HTML 에 한글 센터명");
has(h, '<small class="center-code">(CHA1)</small>', "코드는 보조정보 (CHA1) 로만");
has(h, 'title="센터 코드 CHA1"', "툴팁에 코드");
check(plain(h), "천안1센터", "보조 코드를 빼면 한글명만 남음(코드만 표시 금지)");
check(CC.optionText({ id: "c-inc4" }), "인천4센터 (INC4)", "선택 목록(option)은 '인천4센터 (INC4)'");
CC.setRows([{ id: "x", center_name: "용인백암센터", center_code: "YBA1" }]);
check(CC.text("YBA1"), "용인백암센터", "이름이 이미 '센터'로 끝나면 '센터' 중복 안 붙임");
CC.setRows(MASTER);

console.log("\n=== 2. 승인·거절 버튼(승인 권한자만) ===");
const APPROVER = { id: "u-appr", name: "장팀장", approver: true };
const STAFF = { id: "u-staff", name: "김사원", approver: false };
const base = { id: "p1", transport_type: "TRUCK", preflight_status: "PASSED", approval_status: "PENDING_APPROVAL",
  submit_status: "NOT_SUBMITTED", internal_status: "PENDING", destination_center_id: "c-cha1", destination_center_raw: "CHA1" };
const items2 = [{ pallet_count: 2, coupang_inbound_qty: 240, inventory_name: "아가드" }];
const C = (me, extra = {}) => ({ me, items: items2, supersededIds: new Set(), migrated: true, ...extra });

let d = IA.decisionHtml(base, C(APPROVER));
has(d, "decideRgInbound('p1','APPROVED')", "승인 대기 + 승인 권한자 → 승인 버튼");
has(d, "openRgRejectModal('p1')", "승인 옆에 거절 버튼");
has(d, "openRgPlanDetail('p1')", "상세 버튼");
d = IA.decisionHtml(base, C(STAFF));
hasNot(d, "decideRgInbound", "일반 사용자 → 승인 버튼 없음");
hasNot(d, "openRgRejectModal", "일반 사용자 → 거절 버튼 없음");
has(d, "openRgPlanDetail('p1')", "일반 사용자도 상세(상태·사유) 조회 가능");
d = IA.decisionHtml(base, C(APPROVER, { migrated: false }));
has(d, "disabled title=\"DB 적용 전", "DB 적용 전이면 승인·거절 버튼 잠금(직접 UPDATE 경로로 되돌리지 않음)");

console.log("\n=== 3. 1PLT 단독 입고 ===");
const one = [{ pallet_count: 1, coupang_inbound_qty: 120 }];
check(IA.singlePltBlocked(base, one, "1톤"), true, "1PLT + 1톤 → 차단");
check(IA.singlePltBlocked(base, one, null), true, "1PLT + 차량 미확인 → 차단(추정 통과 금지)");
check(IA.singlePltBlocked(base, one, "5톤"), false, "1PLT + 5톤 확인 → 차단 아님(제출 게이트와 같은 기준)");
check(IA.singlePltBlocked({ ...base, transport_type: "PARCEL" }, [{ pallet_count: 0 }], null), false, "택배는 대상 아님");
const onePlt = { ...base, id: "p1plt", approval_status: "APPROVED" };            // 운영 e2c1ec84 와 같은 모양
const c1 = C(APPROVER, { items: one, singlePlt: true });
d = IA.decisionHtml(onePlt, c1);
has(d, "openRgRejectModal('p1plt')", "승인됨+미제출 1PLT 요청 → 거절 가능(자동 삭제 안 함)");
hasNot(d, "decideRgInbound('p1plt','APPROVED')", "이미 승인된 건엔 승인 버튼 없음");
const cell = IA.approvalCellHtml(onePlt, c1);
has(cell, "승인 불가 · 1PLT 단독 입고", "승인 칸에 '승인 불가 · 1PLT 단독 입고' 기본 표시");
check(IA.defaultRejectReason(c1), "승인 불가 · 1PLT 단독 입고", "거절 사유 기본값 = 승인 불가 · 1PLT 단독 입고");
check(IA.defaultRejectCode(c1), "SINGLE_PLT_LOAD", "사유 코드 SINGLE_PLT_LOAD");
d = IA.decisionHtml({ ...base, id: "p1pend" }, C(APPROVER, { items: one, singlePlt: true }));
has(d, `<button class="btn sm" disabled title="승인 불가 · 1PLT 단독 입고">승인</button>`, "승인 대기 1PLT → 승인 버튼 잠금");
has(d, "openRgRejectModal('p1pend')", "…거절은 가능");

console.log("\n=== 4. WING 제출된 요청 · 대체된 요청 ===");
const submitted = { ...base, id: "psub", approval_status: "APPROVED", submit_status: "SUBMIT_ATTEMPTED", internal_status: "SUCCEEDED", coupang_shipment_id: "SHIP1" };
d = IA.decisionHtml(submitted, C(APPROVER));
has(d, "WING 제출 완료 · 거절 불가", "WING 제출 완료 → 'WING 제출 완료 · 거절 불가'");
hasNot(d, "openRgRejectModal", "…거절 버튼 없음");
check(IA.canReject(submitted, C(APPROVER)), false, "canReject=false");
check(IA.wingSubmittedLabel({ ...submitted, coupang_shipment_id: null, internal_status: "FAILED" }), "WING 제출 시도됨 · 거절 불가",
  "제출 시도 후 실패한 건은 '제출 시도됨 · 거절 불가'(완료로 오표시 안 함)");
check(IA.canReject({ ...base, approval_status: "APPROVED" }, C(APPROVER, { supersededIds: new Set(["p1"]) })), false, "이미 새 요청으로 대체된 건은 거절 대상 아님");
check(IA.canReject({ ...base, internal_status: "CANCELLED" }, C(APPROVER)), false, "취소된 건은 거절 대상 아님");
check(IA.canReject({ ...base, preflight_status: "RUNNING" }, C(APPROVER)), false, "PRE-FLIGHT 진행 중은 거절 대기");

console.log("\n=== 5. 거절된 요청: 사유·거절자·시각 표시, 승인·제출·재계획 없음, 수정 후 재요청 ===");
const rej = { ...base, id: "prej", approval_status: "REJECTED", rejection_reason: "재고 과다, 다음 달 재검토",
  rejected_by_name: "장팀장", rejected_at: "2026-09-11T05:20:00Z", purchase_order_id: "po1" };
const cellR = IA.approvalCellHtml(rej, C(STAFF));
has(cellR, "거절됨", "상태 칩 '거절됨'");
has(cellR, "재고 과다, 다음 달 재검토", "일반 사용자도 거절 사유 확인");
has(cellR, "장팀장 · 2026-09-11 14:20", "거절자·거절시각(KST)");
d = IA.decisionHtml(rej, C(APPROVER, { poDrafterId: "u-staff" }));
hasNot(d, "decideRgInbound", "거절 요청 → 승인 버튼 없음");
hasNot(d, "openRgRejectModal", "거절 요청 → 재거절 버튼 없음");
has(d, "openRgResubmitModal('prej')", "승인 권한자 → 수정 후 재요청");
has(IA.decisionHtml(rej, C(STAFF, { poDrafterId: "u-staff" })), "openRgResubmitModal('prej')", "요청 작성자(발주 기안자) → 수정 후 재요청");
hasNot(IA.decisionHtml(rej, C({ id: "u-other", approver: false }, { poDrafterId: "u-staff" })), "openRgResubmitModal", "작성자·승인권자 아니면 재요청 버튼 없음");
hasNot(IA.decisionHtml(rej, C(APPROVER, { supersededIds: new Set(["prej"]) })), "openRgResubmitModal", "이미 새 요청이 있으면 재요청 버튼 없음");
has(IA.approvalCellHtml(rej, C(STAFF, { child: { id: "pnew-1234567", approval_status: "PENDING_APPROVAL" } })), "→ 새 요청 pnew-123", "원본 → 새 요청 연결 표시");
has(IA.approvalCellHtml({ ...base, id: "pnew", resubmission_of_plan_id: "prej-999999" }, C(STAFF)), "↩ 거절된 요청 prej-999의 재요청", "새 요청 → 원본 연결 표시");

// app.js 실제 버튼 조건(rgActionsHtml·배지 건수) - 소스에서 잘라 실행
const app = read("./js/app.js");
const seg = app.slice(app.indexOf("const RG_RETRYABLE_ERROR_PATTERNS"), app.indexOf("// WING 실제 제출 - decideRgInbound()와 동일한 원칙"));
const appCtx = vm.createContext({ esc: s => String(s ?? ""), Date, Number, String, JSON, console });
vm.runInContext(seg + "\n;globalThis.__t = { rgActionsHtml, rgCanDecide, rgCanPrepareReplan, rgCanSubmit };", appCtx);
const T = appCtx.__t;
const stale = { ...rej, inbound_date: "2026-09-01", inbound_time: "09:30:00" };
check(T.rgActionsHtml(stale, new Set(), {}), "", "거절 요청 → 쿠팡 제출·재계획·재시도 버튼 0개(app.js 실제 함수)");
check(T.rgCanPrepareReplan(stale, new Set()), false, "거절 요청은 재계획 대상 아님");
check(T.rgCanSubmit(rej), false, "거절 요청은 쿠팡 제출 버튼 조건 불충족");
const plansForBadge = [base, rej, onePlt, submitted];
check(plansForBadge.filter(T.rgCanDecide).length, 1, "승인 대기 건수에서 거절 제외(배지 조건 = app.js rgCanDecide)");
has(T.rgActionsHtml({ ...onePlt, inbound_date: "2026-09-01", inbound_time: "09:30:00" }, new Set(), {}), "openRgReplanModal", "[회귀] 거절 전 만료 슬롯 요청은 재계획 버튼 그대로");

console.log("\n=== 6. 상세 모달 ===");
const det = IA.detailHtml(rej, { ...C(STAFF), items: items2, poNo: "PO-015", coupang: 1,
  events: [{ event_type: "PREFLIGHT_PASSED", created_at: "2026-09-10T01:00:00Z", detail: {} },
           { event_type: "HUMAN_REJECTED", created_at: "2026-09-11T05:20:00Z", detail: { reason: "재고 과다, 다음 달 재검토", rejected_by_name: "장팀장" } }] });
has(det, "천안1센터", "상세 모달 쿠팡센터 = 한글명");
has(det, "(CHA1)", "…코드는 보조정보");
has(det, "거절자</th><td>장팀장 · 2026-09-11 14:20", "거절자·시각");
has(det, "<b>거절</b> <span class=\"rg-ev-note\">사유: 재고 과다, 다음 달 재검토 · 장팀장</span>", "처리 이력에 거절 사유·거절자");
const detW = IA.detailHtml({ ...rej, coupang_inbound_plan_id: "1100911584579948544" }, C(STAFF));
has(detW, "취소 API가 확인되지 않아 자동 취소하지 않았습니다", "WING 초안은 남고 취소 API 미호출 안내");

console.log("\n=== 7. CSV = 화면과 같은 한글 센터명 ===");
const plans = [
  { ...base, id: "a1111111-x", supplier: "리파코", destination_center_id: "c-cha1", destination_center_raw: "CHA1", inbound_date: "2026-09-15", inbound_time: "09:30:00" },
  { ...rej, id: "b2222222-x", supplier: "리파코", destination_center_id: null, destination_center_raw: "INC4" },
  { ...base, id: "c3333333-x", supplier: "리파코", destination_center_id: null, destination_center_raw: "ZZZ9" },
  { ...onePlt, id: "d4444444-x", supplier: "리파코" },
];
const ctxFor = p => ({ items: p.id.startsWith("d") ? one : items2, singlePlt: p.id.startsWith("d"), poNo: "PO-015" });
const rows = IA.csvRows(plans, ctxFor);
const col = name => IA.CSV_HEADER.indexOf(name);
check(rows.map(r => r[col("쿠팡센터")]), ["천안1센터", "인천4센터", "센터명 확인 필요 (코드: ZZZ9)", "천안1센터"], "CSV 쿠팡센터 열 = 한글명/확인 필요");
check(rows.map(r => r[col("센터코드")]), ["CHA1", "INC4", "ZZZ9", "CHA1"], "CSV 센터코드는 별도 보조 열");
check(plans.map(p => plain(CC.html({ id: p.destination_center_id, code: p.destination_center_raw }))), rows.map(r => r[col("쿠팡센터")]),
  "화면 표시(보조 코드 제외)와 CSV 센터명이 행마다 동일");
check(rows[1][col("거절 사유")], "재고 과다, 다음 달 재검토", "CSV 거절 사유");
check(rows[3][col("승인불가 사유")], "승인 불가 · 1PLT 단독 입고", "CSV 1PLT 승인 불가 사유");
const csv = IA.toCsv(rows);
check(csv.charCodeAt(0), 0xfeff, "엑셀용 BOM");
has(csv, '"재고 과다, 다음 달 재검토"', "쉼표 포함 값은 따옴표로 감쌈");

console.log("\n=== 8. 화면 어디에도 코드만 표시하는 곳이 남지 않았는지(app.js 소스 검사) ===");
for (const [pat, label] of [
  [/<td>\$\{esc\(p\.destination_center_raw/, "입고신청 내역 표"],
  [/\$\{esc\(fcCode/, "슬롯 선택 모달"],
  [/@\$\{esc\(pr\.proposed\.fc_code/, "재계획 제안 메모"],
  [/\$\{esc\(c\.fc_code\)\}/, "택배 센터 후보"],
  [/esc\(center \? center\.center_name/, "입고 물류 최적화 차량"],
  [/\$\{esc\(c\.center_name\)\}<\/option>/, "TRUCK 준비대기 센터 선택"],
]) check(pat.test(app), false, `${label}: 코드/마스터 원문 직접 표시 없음`);
check((app.match(/CoupangCenters\.(html|text|optionText)\(/g) || []).length >= 12, true, "센터 표시는 CoupangCenters 한 곳으로 모임");
check(/from\("inbound_plans"\)\s*\.update\(\{\s*approval_status/.test(app), false, "화면이 approval_status 를 직접 UPDATE 하는 코드 없음");
check(/event_type: decision === "REJECTED" \? "HUMAN_REJECTED"/.test(app), false, "화면이 HUMAN_REJECTED 이벤트를 직접 쓰는 코드 없음");
check(/sb\.rpc\("fn_decide_inbound_plan"/.test(app), true, "승인·거절은 DB RPC fn_decide_inbound_plan 으로만");
const idx = read("./index.html");
check(idx.indexOf("coupang_centers.js") > 0 && idx.indexOf("coupang_centers.js") < idx.indexOf("js/app.js"), true, "index.html 이 app.js 전에 센터 모듈 로드");
check(idx.indexOf("inbound_approval.js") > 0 && idx.indexOf("inbound_approval.js") < idx.indexOf("js/app.js"), true, "index.html 이 app.js 전에 승인 모듈 로드");

console.log(failures ? `\n=== 결과: 실패 ${failures}건 ===` : "\n=== 결과: 전체 통과 ===");
process.exit(failures ? 1 : 0);
