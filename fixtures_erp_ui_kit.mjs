// fixtures_erp_ui_kit.mjs - ERP 공통 화면 부품(js/erp_ui.js)과 버튼 안전장치 (2026-09-13 ERP UI 정리)
// 실제 DB·WING·메일 없음. 가짜 sb·가짜 DOM 만 써요.  node fixtures_erp_ui_kit.mjs
import { readFileSync } from "fs";
import vm from "vm";
import { fakeErpDom } from "./erp_ui_fake_dom.mjs";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
const app = read("./js/app.js");
let failures = 0;
const check = (a, e, label) => {
  const ok = JSON.stringify(a) === JSON.stringify(e);
  if (!ok) failures++;
  console.log(`${ok ? "  OK " : "  FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(a)}, 기대=${JSON.stringify(e)})`}`);
};
const has = (h, n, label) => check(String(h).includes(n), true, label);
const hasNot = (h, n, label) => check(String(h).includes(n), false, label);
const grab = name => { const m = app.match(new RegExp(`\\n(async )?function ${name}\\([\\s\\S]*?\\n}`)); if (!m) throw new Error(name); return m[0]; };
const grabLine = re => { const m = app.match(re); if (!m) throw new Error(String(re)); return m[0]; };

// ─────────────────────────────────────────────────────────────────────────────
console.log("=== 1. 상태 배지 - 색만으로 말하지 않음(아이콘 + 문구) ===");
const kctx = vm.createContext({ console });
vm.runInContext(read("./js/erp_ui.js"), kctx);
const UI = kctx.ErpUi;
const EXPECT = { ok: "정상", awaiting: "입고대기", check: "확인 필요", logistics: "물류정보 입력 필요", reinbound: "재입고 승인 필요",
                 excluded: "재입고 제외", hold: "SKU 사용 보류", error: "오류" };
for (const [k, text] of Object.entries(EXPECT)) {
  const b = UI.badge(k);
  check([b.includes(`erp-badge--${k}`), b.includes('class="erp-ico"'), b.includes(text)], [true, true, true], `배지 ${k}: 색 클래스 + 아이콘 + '${text}'`);
}
has(UI.badge("check", { reason: "판매 데이터 부족" }), "판매 데이터 부족", "확인 필요 + 사유");
has(UI.badge("error", { reason: "서버 계산 실패" }), "서버 계산 실패", "오류 + 사유");
has(UI.badge("ok", { text: "<script>" }), "&lt;script&gt;", "문구는 HTML 이스케이프");
check(UI.badge("nope").includes("erp-badge--info"), true, "모르는 종류 → info(깨지지 않음)");

console.log("\n=== 2. 재고 상태 · 자동화 상태 분리(서버 값 그대로) ===");
has(UI.decisionBadge({ decision: "ORDER_NOW" }), "erp-badge--urgent", "ORDER_NOW → 지금 발주");
has(UI.decisionBadge({ decision: "AWAITING_INBOUND" }), "입고대기", "AWAITING_INBOUND → 입고대기(파랑)");
const dc = UI.decisionBadge({ decision: "DATA_CHECK", decision_check_label: "⚠️ 판매 데이터 부족" });
check([dc.includes("확인 필요"), dc.includes("판매 데이터 부족"), dc.includes("⚠️")], [true, true, false], "DATA_CHECK → 확인 필요 + 사유(앞 이모지 정리)");
has(UI.decisionBadge({ decision: "RESTOCK_EXCLUDED" }), "erp-badge--excluded", "RESTOCK_EXCLUDED → 재입고 제외(빨강)");
has(UI.automationBadge({ decision: "OK", automation_blocked: false }), "자동화 정상", "자동화 정상");
has(UI.automationBadge({ decision: "ORDER_NOW", automation_blocked: true, automation_label: "물류정보 입력 필요" }), "erp-badge--logistics", "물류정보 입력 필요 = 별도 주황 배지");
has(UI.automationBadge({ decision: "OK", automation_blocked: true, automation_label: "SKU 사용 보류" }), "erp-badge--hold", "SKU 사용 보류 배지");
has(UI.automationBadge({ decision: "RESTOCK_EXCLUDED", automation_blocked: true }), "자동화 대상 아님", "재입고 제외 상품은 자동화 대상 아님");
check(UI.automationBadge({ decision: "ORDER_NOW", automation_blocked: true, automation_label: "물류정보 입력 필요" }).includes("지금 발주"), false,
      "[핵심] 자동화 배지는 재고 판단 문구를 섞지 않음");

console.log("\n=== 3. 표준 상품명은 미리보기 전용(DB 이름 유지) ===");
check(UI.displayName("1M1A-009-01", "제습제 500ml x12"), "제습제 500ml x12", "[핵심] 운영(표준명 표 없음) → DB 상품명 그대로");
kctx.ERP_STANDARD_NAMES = { "1M1A-009-01": "모노플랫 제습제 500ml 12개" };
check(UI.displayName("1M1A-009-01", "제습제 500ml x12"), "모노플랫 제습제 500ml 12개", "미리보기(표준명 표 있음) → 표준 표시명");
const nc = UI.nameCellHtml({ code: "1M1A-009-01", name: "제습제 500ml x12", skus: ["95940933431"] });
check([nc.includes("모노플랫 제습제 500ml 12개"), nc.includes("DB 상품명: 제습제 500ml x12"), nc.includes("ERP 1M1A-009-01"), nc.includes("SKU 95940933431")],
      [true, true, true, true], "상품 칸: 표준명 + 툴팁에 DB 상품명 + ERP 코드·SKU 그대로");
delete kctx.ERP_STANDARD_NAMES;
has(UI.relationHtml({ role: "child", parentName: "모노플랫 제습제 500ml 12개", setQty: 3 }), "모노플랫 제습제 500ml 12개", "세트 → 부모상품 표시");
has(UI.summaryHtml([{ label: "승인대기", value: 2, kind: "pending" }, { label: "숨김", value: 0, hidden: true }]), "승인대기", "요약 카드");
hasNot(UI.summaryHtml([{ label: "숨김", value: 0, hidden: true }]), "숨김", "hidden 카드는 안 그림");

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 4. 쓰기 버튼 공통 흐름 ErpUi.run ===");
{
  const dom = fakeErpDom();
  const ctx = vm.createContext({ console, ...dom.globals });
  vm.runInContext(read("./js/erp_ui.js"), ctx); dom.bind(ctx);
  const R = ctx.ErpUi;
  let execs = 0, refreshes = 0;
  const base = over => ({ key: "k1", allowed: true, confirm: { title: "확인", rows: [["상품", "A"]] },
    exec: async () => { execs++; await new Promise(r => setTimeout(r, 5)); return { ok: true }; },
    successText: "완료", refresh: async () => { refreshes++; }, ...over });
  check((await R.run(base({ allowed: false, deniedText: "읽기 전용" }))).status, "DENIED", "권한 없음 → DENIED");
  check([execs, dom.modals.length, dom.toasts.at(-1)], [0, 0, "읽기 전용"], "권한 없음: 확인창·실행 없음, 안내만");
  const [a, b] = await Promise.all([R.run(base()), R.run(base())]);
  check([a.status, b.status, execs], ["DONE", "BUSY", 1], "[핵심] 중복 클릭 → 한 번만 실행");
  check(refreshes, 1, "성공 → 다시 읽기");
  check(R.isBusy("k1"), false, "끝나면 처리 중 해제");
  dom.user = { answer: "cancel" };
  check([(await R.run(base())).status, execs], ["CANCELLED", 1], "확인창 취소 → 실행 없음");
  dom.user = { answer: "confirm" };
  const st = await R.run(base({ precheck: async () => ({ ok: false, title: "바뀜", rows: [["수량", "10 → 12"]], message: "다시 확인" }) }));
  check([st.status, execs, refreshes], ["STALE", 1, 2], "[핵심] 최신 상태 재확인 실패 → 실행 없음 + 다시 읽기");
  has(dom.infos.at(-1), "10 → 12", "바뀐 내용 표시");
  const fl = await R.run(base({ exec: async () => { execs++; return { ok: false, message: "권한 없음(서버)" }; } }));
  check([fl.status, refreshes], ["FAILED", 3], "[핵심] 실패 → 실패 결과 + 서버 상태 다시 읽기");
  has(dom.els.get("erp-confirm-err").textContent, "권한 없음(서버) - 서버 상태를 다시 읽었어요", "실패 사유 표시");
  const th = await R.run(base({ exec: async () => { throw new Error("네트워크 끊김"); } }));
  check(th.status, "FAILED", "실행 중 예외도 실패로(처리 중에 멈추지 않음)");
  check(R.isBusy("k1"), false, "예외 뒤에도 처리 중 해제");
  // 필수 사유
  let got = null;
  dom.user = { answer: "confirm", reason: "  " };
  check((await R.run(base({ confirm: { title: "제외", reason: { label: "제외 사유", required: true } }, exec: async r => { got = r; return { ok: true }; } }))).status,
        "CANCELLED", "필수 사유 비움 → 실행 안 함");
  has(dom.state.lastError, "제외 사유를 입력해 주세요", "필수 사유 안내");
  dom.user = { answer: "confirm", reason: "  단종 " };
  await R.run(base({ confirm: { title: "제외", reason: { label: "제외 사유", required: true } }, exec: async r => { got = r; return { ok: true }; } }));
  check(got, "단종", "사유는 앞뒤 공백 정리해서 전달");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 5. 입고 승인 - 승인 직전 최신 상품·수량·센터·날짜·시간·운송비 재검증 ===");
{
  const dom = fakeErpDom();
  const PLAN = { id: "pl-a1-0000", approval_status: "PENDING_APPROVAL", preflight_status: "PASSED", submit_status: "NOT_SUBMITTED",
    internal_status: "READY", transport_type: "TRUCK", destination_center_id: "c1", destination_center_raw: "목천1",
    inbound_date: "2026-09-16", inbound_time: "09:00:00", total_plt: 3, purchase_order_id: "po-16", rejection_reason: null };
  const ITEMS = [{ inbound_plan_id: PLAN.id, inventory_name: "모노플랫 제습제 500ml 12개", coupang_inbound_qty: 360, pallet_count: 3 }];
  const GROUP = { status: "ACTIVE", vehicle_type: "5톤", vehicle_count: 1, total_transport_cost: 187000 };
  const DB = { plan: { ...PLAN }, items: ITEMS.map(x => ({ ...x })), group: { ...GROUP } };
  const rpcs = []; let routes = 0;
  const q = table => { const f = {}; const o = { select: () => o, eq: (k, v) => (f[k] = v, o), in: () => o, order: () => o,
    limit: async () => ({ data: table === "inbound_plans" && f.retry_of_plan_id ? [] : [], error: null }),
    maybeSingle: async () => ({ data: table === "inbound_plans" ? DB.plan : table === "purchase_orders" ? { po_no: "리버스-발주-2026-016" } : null, error: null }),
    then: r => r({ data: table === "inbound_plan_items" ? DB.items : [], error: null }) }; return o; };
  const ctx = vm.createContext({ console, ...dom.globals, me: { id: "u1", approver: true },
    esc: s => String(s ?? "").replace(/</g, "&lt;"), fmt: n => Number(n || 0).toLocaleString("ko-KR"),
    CoupangCenters: { load: async () => {}, text: c => c.code || c.id, html: c => c.code || c.id },
    route: async () => { routes++; }, loadRgShipmentGroupForPlan: async () => DB.group,
    openRgRejectModal: () => "REJECT_MODAL",
    sb: { from: t => q(t), rpc: async (fn, args) => { rpcs.push([fn, args]); return { data: { status: "APPROVED" }, error: null }; } } });
  vm.runInContext(read("./js/erp_ui.js"), ctx); dom.bind(ctx);
  vm.runInContext(read("./js/inbound_approval.js"), ctx);
  vm.runInContext("let _rgLast = { snap: {} };\n" + grab("rgPlanSnapshot") + "\n" + grabLine(/const RG_SNAP_LABEL = [\s\S]*?\};/) + "\n"
    + grab("rgSnapshotDiff") + "\n" + grab("rgConfirmRows") + "\n" + grab("rgGroupForCtx") + "\n" + grab("rgDecideRpc") + "\n" + grab("decideRgInbound")
    + "\n;globalThis.__r = { rgPlanSnapshot, rgSnapshotDiff, decideRgInbound, setSnap: (id, s) => { _rgLast.snap[id] = s; } };", ctx);
  const X = ctx.__r;
  const snap0 = X.rgPlanSnapshot(PLAN, ITEMS, GROUP);
  check(X.rgSnapshotDiff(snap0, X.rgPlanSnapshot(PLAN, ITEMS, GROUP)), [], "같은 내용 → 차이 없음");
  const d1 = X.rgSnapshotDiff(snap0, X.rgPlanSnapshot({ ...PLAN, inbound_time: "14:00:00" }, [{ ...ITEMS[0], coupang_inbound_qty: 240 }], { ...GROUP, total_transport_cost: 220000 }));
  check(d1.map(d => d.key).sort(), ["freight", "items", "time"], "시간·수량·운송비 변경을 모두 찾음");
  const d2 = X.rgSnapshotDiff(snap0, X.rgPlanSnapshot({ ...PLAN, destination_center_raw: "천안", inbound_date: "2026-09-17" }, ITEMS, GROUP));
  check(d2.map(d => d.key).sort(), ["center", "date"], "센터·날짜 변경을 찾음");

  // (a) 화면과 같음 → 최신값 확인창 → 승인 1번
  X.setSnap(PLAN.id, snap0);
  const r1 = await X.decideRgInbound(PLAN.id, "APPROVED");
  check([r1.status, rpcs.length], ["DONE", 1], "[핵심] 내용 그대로 → 확인창 → 승인 DB 함수 1번");
  check(rpcs[0], ["fn_decide_inbound_plan", { p_plan_id: PLAN.id, p_decision: "APPROVED", p_reason: null, p_reason_code: null }], "승인 = fn_decide_inbound_plan(APPROVED)");
  const m = dom.modals.at(-1);
  for (const [n, l] of [["모노플랫 제습제 500ml 12개", "상품"], ["360개", "수량"], ["목천1", "센터"], ["2026-09-16 09:00", "날짜·시간"], ["₩187,000", "운송비"], ["리버스-발주-2026-016", "발주서"]]) {
    has(m, n, `확인창: 최신 ${l}`);
  }
  has(m, "승인만으로 쿠팡(WING)에 제출되지 않아요", "[핵심] 승인 ≠ WING 제출 안내");
  check(routes, 1, "승인 뒤 화면 다시 읽기");
  // (b) 화면을 연 뒤 수량·운송비가 바뀜 → 승인 안 함
  DB.items = [{ ...ITEMS[0], coupang_inbound_qty: 240 }]; DB.group = { ...GROUP, total_transport_cost: 220000 };
  const r2 = await X.decideRgInbound(PLAN.id, "APPROVED");
  check([r2.status, rpcs.length], ["STALE", 1], "[핵심] 수량·운송비 바뀜 → 승인 DB 함수 호출 안 함");
  has(dom.infos.at(-1), "화면을 연 뒤 내용이 바뀌었어요", "바뀜 안내");
  has(dom.infos.at(-1), "₩220,000", "바뀐 운송비 표시");
  check(routes, 2, "바뀜 → 화면 다시 읽기");
  // (c) 다른 사람이 먼저 승인 → 승인 불가
  DB.items = ITEMS.map(x => ({ ...x })); DB.group = { ...GROUP }; DB.plan = { ...PLAN, approval_status: "APPROVED" };
  check([(await X.decideRgInbound(PLAN.id, "APPROVED")).status, rpcs.length], ["STALE", 1], "이미 승인된 요청 → 호출 안 함");
  // (d) 1PLT(적재 기준 미달)로 바뀜
  DB.plan = { ...PLAN, total_plt: 1 }; DB.items = [{ ...ITEMS[0], pallet_count: 1 }];
  check([(await X.decideRgInbound(PLAN.id, "APPROVED")).status, rpcs.length], ["STALE", 1], "적재 기준 미달로 바뀌면 승인 안 함");
  // (e) 권한 없음
  DB.plan = { ...PLAN }; DB.items = ITEMS.map(x => ({ ...x }));
  vm.runInContext("me = { id: 'u2', approver: false };", ctx);
  check([(await X.decideRgInbound(PLAN.id, "APPROVED")).status, rpcs.length], ["DENIED", 1], "[핵심] 승인 권한 없음 → 읽기 전용");
  check(await X.decideRgInbound(PLAN.id, "REJECTED"), "REJECT_MODAL", "거절은 사유 입력 창으로(사유 필수 창)");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 6. 처리된 요청은 버튼 잠금 · 재입고 승인 필요 카드 ===");
{
  const ctx = vm.createContext({ console });
  vm.runInContext(read("./js/coupang_centers.js"), ctx);
  vm.runInContext(read("./js/inbound_approval.js"), ctx);
  const IA = ctx.InboundApproval;
  let can;
  const AP = { id: "u1", approver: true };
  const base = { id: "pl-1", approval_status: "PENDING_APPROVAL", preflight_status: "PASSED", submit_status: "NOT_SUBMITTED", internal_status: "READY", transport_type: "TRUCK" };
  const rej = IA.decisionHtml({ ...base, approval_status: "REJECTED" }, { me: AP, items: [], migrated: true });
  check([rej.includes("거절 완료"), rej.includes("disabled"), /onclick="decideRgInbound/.test(rej)], [true, true, false], "[핵심] 거절된 요청 → '거절 완료' 잠김(승인 버튼 없음)");
  const sub = IA.decisionHtml({ ...base, approval_status: "APPROVED", submit_status: "SUBMIT_SUCCEEDED", coupang_shipment_id: "s1" }, { me: AP, items: [], migrated: true });
  check([sub.includes("rg-note"), /onclick="decideRgInbound/.test(sub), /openRgRejectModal/.test(sub)], [true, false, false], "WING 제출된 요청 → 제출 상태 문구만, 승인·거절 없음");
  has(can = IA.decisionHtml(base, { me: AP, items: [{ pallet_count: 3 }], migrated: true }), 'data-erp-key="rg-approve-pl-1"', "승인 버튼 = 처리 중 표시 연결");
  can = IA.decisionHtml(base, { me: AP, items: [{ pallet_count: 3 }], migrated: true });
  check(/disabled aria-disabled="true" title=/.test(can), false, "승인 가능한 요청은 잠김 표시 없음");
  check(IA.processedLabel({ internal_status: "CANCELLED" }), "취소됨", "취소된 요청 표시");

  const HOLD = { purchase_order_id: "po-16", held: true, reason: `${"재입고 승인 필요"} WING 입고 취소`, held_by: "system", held_at: "2026-09-12T05:00:00Z" };
  const rows = [{ poId: "po-16", poNo: "리버스-발주-2026-016", supplier: "리파코", hold: HOLD,
    items: [{ name: "모노플랫 제습제 500ml 12개", qty: 360, remain: 360 }], cancelNote: "WING 입고 취소 확인 09-12 14:02" }];
  const card = IA.reinboundCardHtml(rows, { me: AP, refreshOnclick: "route()" });
  for (const [n, l] of [["재입고 승인 필요", "제목"], ["리버스-발주-2026-016", "PO"], ["360개", "수량"], ["WING 입고 취소 확인 09-12 14:02", "취소 확인"],
                        ["releasePoHold('po-16')", "재입고 허용 버튼"], ["취소 사유 보기", "취소 사유 보기"], ["변경 이력", "변경 이력"], ["새로고침", "새로고침"],
                        ['data-erp-key="po-hold-po-16"', "처리 중 표시 연결"]]) has(card, n, `카드: ${l}`);
  const view = IA.reinboundCardHtml(rows, { me: { id: "u2", approver: false } });
  check([view.includes("releasePoHold"), view.includes("읽기 전용"), view.includes("취소 사유 보기")], [false, true, true], "[핵심] 권한 없음 → 재입고 허용 버튼 없음, 읽기 전용 · 보기 버튼만");
  const manual = IA.reinboundCardHtml([{ ...rows[0], hold: { ...HOLD, reason: "PO 점검" } }], { me: AP });
  check([manual.includes(">보류 해제<"), manual.includes(">재입고 허용<")], [true, false], "사람이 건 보류 → '보류 해제'(재입고 허용 아님)");
  check(IA.reinboundCardHtml([], { me: AP }), "", "보류 없음 → 카드 없음");
  has(IA.reinboundCardHtml([], { me: AP, error: "permission denied" }), "보류 목록을 불러오지 못했어요", "조회 실패 → 오류 배지 + 사유");
}

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n=== 7. 화면 소스 - 새 부품이 계산·키를 바꾸지 않음 ===");
const erpUi = read("./js/erp_ui.js");
for (const bad of ["sb.", ".from(", ".rpc(", "fetch(", ".upsert(", ".insert("]) hasNot(erpUi, bad, `erp_ui.js 에 '${bad}' 없음(부품은 DB·네트워크를 직접 부르지 않음)`);
hasNot(app + read("./js/procurement_input.js"), "ERP_STANDARD_NAMES =", "[핵심] 운영 코드는 표준명 표를 만들지 않음(미리보기 전용)");
has(read("./index.html"), "js/erp_ui.js", "index.html 이 erp_ui.js 를 불러옴");
check(read("./index.html").indexOf("js/erp_ui.js") < read("./index.html").indexOf("js/app.js"), true, "erp_ui.js 가 app.js 보다 먼저");

console.log(failures ? `\n=== 결과: 실패 ${failures}건 ===` : "\n=== 결과: 전체 통과 ===");
process.exit(failures ? 1 : 0);
