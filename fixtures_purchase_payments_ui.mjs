// fixtures_purchase_payments_ui.mjs
// ---------------------------------------------------------------------------
// 2026-10-22 발주·입고·지급 한눈에(js/purchase_payments.js) 회귀 테스트 - 네트워크 0건.
//   검증: VAT 중복 없음 · 부분 지급 · 재신청 중복 집계 없음 · 연도 전환(12월→다음 해 1/20)
//         · 자금일보(cash_plans) 합계 일치 · 운반비 1회·미확정 표시 · 상태 독립 · 모바일 레이아웃
import { readFileSync } from "fs";
import vm from "vm";

const SRC = new URL("./js/purchase_payments.js", import.meta.url);
const CSS = readFileSync(new URL("./css/style.css", import.meta.url), "utf8");
const APP = readFileSync(new URL("./js/app.js", import.meta.url), "utf8");
const IDX = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(readFileSync(SRC, "utf8"), ctx);
const PP = ctx.PurchasePayments;

let n = 0; const fails = [];
const check = (label, got, want) => {
  n++; const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { console.log(`        기대=${JSON.stringify(want)}\n        실제=${JSON.stringify(got)}`); fails.push(label); }
};
const text = h => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const VAT = { enabled: true, purchaseCostIncludesVat: false };
const TAXABLE = { id: "p1", name: "모서리 보호대", tax_type: "과세" };
const FREE = { id: "p2", name: "면세품", tax_type: "면세" };
const TODAY = "2026-10-22";

console.log("[1] 지급 예정일 - 매입월 다음 달 20일 · 연도 전환");
check("10월 → 11월 20일", PP.nextTwentieth("2026-10-19"), "2026-11-20");
check("12월 → 다음 해 1월 20일", PP.nextTwentieth("2026-12-31"), "2027-01-20");
check("1월 → 2월 20일", PP.nextTwentieth("2027-01-01"), "2027-02-20");
check("11월 30일 → 12월 20일", PP.nextTwentieth("2026-11-30"), "2026-12-20");

console.log("\n[2] VAT - 설정대로 한 번만 붙임(이중 부과 없음)");
check("과세·매입원가 VAT 별도 → ×1.1 반올림", PP.payableOf(669600, TAXABLE, VAT), 736560);
check("면세는 그대로", PP.payableOf(669600, FREE, VAT), 669600);
check("매입원가에 VAT 포함 설정이면 그대로", PP.payableOf(736560, TAXABLE, { enabled: true, purchaseCostIncludesVat: true }), 736560);
check("VAT 기능 꺼짐이면 그대로", PP.payableOf(669600, TAXABLE, { enabled: false }), 669600);

console.log("\n[3] 통장 매칭 - 적힌 것만 차감");
const TXNS = [
  { id: "t1", kind: "출금", date: "2026-11-20", amount: 300000, memo: "리파코 · 리버스-발주-2026-018 1차" },
  { id: "t2", kind: "출금", date: "2026-11-20", amount: 500000, memo: "리파코주식회사 · 통장 07:20 · BANK_STMT:abc" },
  { id: "t3", kind: "입금", date: "2026-11-20", amount: 900000, memo: "리버스-발주-2026-018 환입" },
];
check("발주번호가 적힌 출금만", PP.matchedPayments(TXNS, { poNo: "리버스-발주-2026-018", purchaseIds: [] }).map(t => t.id), ["t1"]);
check("적히지 않은 출금은 지급으로 보지 않음", PP.matchedPayments(TXNS, { poNo: "리버스-발주-2026-999", purchaseIds: [] }), []);
check("매입 id 로도 매칭", PP.matchedPayments([{ id: "x", kind: "출금", memo: "매입 pur-1 지급" }], { purchaseIds: ["pur-1"] }).length, 1);

console.log("\n[4] 입고 상태 - 수량과 오류를 따로 · 재신청은 원건에 묶음");
check("일부 입고", PP.inboundStateOf([{ qty: 100, received_qty: 40 }], []).state, "PARTIAL");
check("미입고 · 입고 완료", [PP.inboundStateOf([{ qty: 10, received_qty: 0 }], []).state,
                            PP.inboundStateOf([{ qty: 10, received_qty: 10 }], []).state], ["NONE", "DONE"]);
const inbErr = PP.inboundStateOf([{ qty: 10, received_qty: 10 }],
  [{ id: "i1", preflight_status: "FAILED", last_error_message: "센터 매핑 실패" }]);
check("입고 수량은 찼지만 신청 기록이 오류면 '확인 필요' 로 남김(현재 오류로 단정 안 함)",
      [inbErr.state, inbErr.errors, inbErr.checks, inbErr.checkReason], ["DONE", 0, 1, "센터 매핑 실패"]);
check("재신청·재시도는 원건에 묶어 중복으로 세지 않음",
      PP.inboundStateOf([{ qty: 10, received_qty: 10 }],
        [{ id: "a" }, { id: "b", resubmission_of_plan_id: "a" }, { id: "c", retry_of_plan_id: "a" }]).plans, 1);

console.log("\n[5] 모델 - 재신청 매입이 같은 발주면 한 묶음(이중 집계 없음)");
const PO = { id: "po1", po_no: "리버스-발주-2026-018", supplier: "리파코 주식회사", date: "2026-09-28", status: "done", freight_est: 120000 };
const ITEMS = [{ id: "it1", po_id: "po1", product_id: "p1", qty: 200, unit_cost: 6500, amount: 1300000, received_qty: 200, _name: "모서리 보호대" }];
const PURCHASES = [
  { id: "pur-1", po_id: "po1", product_id: "p1", date: "2026-10-05", qty: 100, unit_cost: 6500, amount: 650000, supplier: "리파코 주식회사", _name: "모서리 보호대" },
  { id: "pur-2", po_id: "po1", product_id: "p1", date: "2026-10-19", qty: 100, unit_cost: 6500, amount: 650000, supplier: "리파코 주식회사",
    memo: "사용자 확인: 기존 발주의 재신청. 실제 입고 111", _name: "모서리 보호대" },
];
const PLAN_AMOUNT = PP.payableOf(650000, TAXABLE, VAT) * 2;
const PLANS = [{ id: "cp1", date: "2026-11-20", kind: "출금", amount: PLAN_AMOUNT,
                 title: "리파코 주식회사 2026-10 매입대금 (리버스-발주-2026-018)",
                 memo: "AUTO_PURCHASE_TERMS=2026-10:po1 | 매입월 다음 달 20일 · VAT 포함 · 운반비 별도 | PURCHASE_IDS=pur-1,pur-2" }];
const base = { pos: [PO], items: ITEMS, purchases: PURCHASES, products: [TAXABLE], plans: PLANS, txns: [],
               inbounds: [{ id: "i1", purchase_order_id: "po1" }], freights: [], vat: VAT, today: TODAY };
const m = PP.model(base);
check("같은 발주의 재신청 매입이 한 줄로", m.rows.length, 1);
check("상품대금 = 매입 2행 합(VAT 포함)", m.rows[0].goods, PLAN_AMOUNT);
check("수량도 합쳐서 한 번만", m.rows[0].qty, 200);
check("지급 예정일 11/20 · 매입월 2026-10", [m.rows[0].payDate, m.rows[0].month], ["2026-11-20", "2026-10"]);
check("매입월과 발주월이 다르면 기준 표시", m.rows[0].basisNote, "매입월 2026-10 기준 · 발주 2026-09");
check("[핵심] 자금일보 합계와 일치", [m.reconcile.ok, m.reconcile.screen, m.reconcile.cash], [true, PLAN_AMOUNT, PLAN_AMOUNT]);
check("다음 지급일 요약 - 확정분은 cash_plans 와 같은 금액",
      [m.due.date, m.due.confirmed.total, m.due.confirmed.count], ["2026-11-20", PLAN_AMOUNT, 1]);
check("업체별 내역", m.due.bySupplier, [{ name: "리파코 주식회사", amount: PLAN_AMOUNT }]);

console.log("\n[6] 운반비 - 확정된 것만 한 번, 미확정은 0원으로 속이지 않음");
const est = PP.model({ ...base, freights: [{ id: "f1", purchase_order_id: "po1", basis: "ESTIMATE", gross: 120000 }] }).rows[0];
check("예상만 있으면 잔액에 넣지 않음", [est.freight.confirmed, est.outstanding, est.outstandingBasis],
      [false, PLAN_AMOUNT, "상품대금 기준(운반비 미확정)"]);
check("화면에 '미확정' 을 적음", text(PP.cardHtml(PP.model({ ...base, freights: [{ id: "f1", purchase_order_id: "po1", basis: "ESTIMATE", gross: 120000 }] }))).includes("미확정"), true);
const act = PP.model({ ...base, freights: [{ id: "f1", purchase_order_id: "po1", basis: "ACTUAL", gross: 132000 }] }).rows[0];
check("확정 운반비는 한 번만 더함", [act.freight.confirmed, act.outstanding], [true, PLAN_AMOUNT + 132000]);
// 매입이 두 달에 걸치면 운반비는 가장 이른 달 한 번만
const twoMonths = PP.model({ ...base,
  purchases: [...PURCHASES, { id: "pur-3", po_id: "po1", product_id: "p1", date: "2026-11-03", qty: 10, unit_cost: 6500, amount: 65000, supplier: "리파코 주식회사", _name: "모서리 보호대" }],
  freights: [{ id: "f1", purchase_order_id: "po1", basis: "ACTUAL", gross: 132000 }] });
check("달이 나뉘어도 운반비는 한 번만", twoMonths.rows.filter(r => r.freight.amount > 0).length, 1);
check("달마다 지급 예정일이 따로", twoMonths.rows.map(r => r.payDate).sort(), ["2026-11-20", "2026-12-20"]);

console.log("\n[7] 지급 상태 - 부분 지급 · 확인 필요 · 완료");
const partial = PP.model({ ...base, txns: [{ id: "t1", kind: "출금", date: "2026-11-20", amount: 300000, memo: "리버스-발주-2026-018 1차" }] }).rows.find(r => r.basis === "PURCHASE");
check("일부 지급", [partial.payState, partial.paidAmount, partial.outstanding], ["PARTIAL", 300000, PLAN_AMOUNT - 300000]);
const full = PP.model({ ...base, txns: [{ id: "t1", kind: "출금", date: "2026-11-20", amount: PLAN_AMOUNT, memo: "리버스-발주-2026-018 전액" }] }).rows.find(r => r.basis === "PURCHASE");
check("지급 완료", [full.payState, full.outstanding], ["PAID", 0]);
const overdue = PP.model({ ...base, today: "2026-11-21" }).rows.find(r => r.basis === "PURCHASE");
check("지급일이 지났는데 매칭 없음 → 지급 확인 필요(완료 아님)", overdue.payState, "OVERDUE");
check("매칭 안 된 출금은 지급으로 바뀌지 않음",
      PP.model({ ...base, txns: [{ id: "t9", kind: "출금", date: "2026-11-20", amount: 999999, memo: "리파코주식회사 · 통장" }] })
        .rows.find(r => r.basis === "PURCHASE").payState, "SCHEDULED");

console.log("\n[8] 발주·입고·지급 독립 · 매입 입력 전 · 취소 발주");
const notPurchased = PP.model({ ...base, purchases: [], plans: [] }).rows[0];
check("매입 입력 전이면 발주 시점 단가로 잠정 · 지급 상태는 따로", [notPurchased.basis, notPurchased.payState], ["ORDER", "NOT_PURCHASED"]);
check("취소·반려 발주는 잠정 줄을 만들지 않음(기존 정책 보존)",
      [PP.model({ pos: [{ ...PO, status: "canceled" }], items: ITEMS, vat: VAT, today: TODAY }).rows.length,
       PP.model({ pos: [{ ...PO, status: "rejected" }], items: ITEMS, vat: VAT, today: TODAY }).rows.length], [0, 0]);
const html = PP.cardHtml(m);
check("발주 배지는 발주 상태만(입고 완료 라벨을 쓰지 않음)",
      [text(html).includes("발주 발주 완료"), text(html).includes("발주 입고 완료")], [true, false]);
check("입고·지급 배지는 따로", ["입고 입고 완료", "지급 예정"].map(w => text(html).includes(w)), [true, true]);
check("매입 입력 전 줄은 예정일에 (예상) 을 붙임",
      text(PP.cardHtml(PP.model({ ...base, purchases: [], plans: [] }))).includes("(예상)"), true);
check("다음 할 일 문장", PP.nextTodo(m.rows[0]).length > 0, true);
check("결재 대기면 결재부터", PP.nextTodo({ ...m.rows[0], po: { status: "progress" } }), "결재 올린 발주서를 승인·반려 처리");

console.log("\n[8-2] 상단 합계 - 매입 전 발주도 '예상' 으로 포함(확정/예상/보류 구분)");
const PO17 = { id: "po17", po_no: "리버스-발주-2026-017", supplier: "리파코 주식회사", date: "2026-10-05", status: "ordered" };
const IT17 = [{ id: "i17", po_id: "po17", product_id: "p1", qty: 200, unit_cost: 6500, amount: 1300000, received_qty: 0, _name: "구름목욕시간" }];
const withEst = PP.model({ ...base, pos: [PO, PO17], items: [...ITEMS, ...IT17] });
const EST17 = PP.payableOf(1300000, TAXABLE, VAT);
check("[핵심] 매입 전 발주도 같은 지급일 합계에 '예상' 으로 들어감",
      [withEst.due.date, withEst.due.confirmed.total, withEst.due.estimated.total, withEst.due.total],
      ["2026-11-20", PLAN_AMOUNT, EST17, PLAN_AMOUNT + EST17]);
check("확정분은 여전히 자금일보와 같은 금액", withEst.reconcile.ok, true);
check("결재 대기·검토 초안은 보류로 빼고 사유를 남김", (() => {
  const h = PP.model({ ...base, pos: [PO, { ...PO17, status: "progress" }], items: [...ITEMS, ...IT17] });
  return [h.due.estimated.total, h.due.hold.total, h.due.hold.items[0].reason.includes("결재 대기")];
})(), [0, EST17, true]);
check("취소 발주는 예상에도 넣지 않음",
      PP.model({ ...base, pos: [PO, { ...PO17, status: "canceled" }], items: [...ITEMS, ...IT17] }).due.estimated.total, 0);
// 매입 전 → 매입 후 전환: 같은 발주를 두 번 세지 않아요
const halfPurchase = [{ id: "pur-17a", po_id: "po17", product_id: "p1", date: "2026-10-20", qty: 100, unit_cost: 6500,
                        amount: 650000, supplier: "리파코 주식회사", _name: "구름목욕시간" }];
const halfCfg = { ...base, pos: [PO, PO17], items: [...ITEMS, ...IT17], purchases: [...PURCHASES, ...halfPurchase] };
const half = PP.model(halfCfg);
check("[핵심] 일부만 매입 입력되면 확정+예상 합이 발주 전액과 같고 중복이 없음",
      [half.due.confirmed.total, half.due.estimated.total, half.due.confirmed.total + half.due.estimated.total],
      [PLAN_AMOUNT + PP.payableOf(650000, TAXABLE, VAT), EST17 - PP.payableOf(650000, TAXABLE, VAT), PLAN_AMOUNT + EST17]);
check("남은 몫 줄에 발주−매입 근거를 남김", (() => {
  const r = half.rows.find(x => x.basis === "ORDER" && x.poId === "po17");
  return [r.orderedPayable, r.purchasedPayable, r.goods];
})(), [EST17, PP.payableOf(650000, TAXABLE, VAT), EST17 - PP.payableOf(650000, TAXABLE, VAT)]);
check("전액 매입되면 예상 줄이 사라짐",
      PP.model({ ...base, pos: [PO, PO17], items: [...ITEMS, ...IT17],
                 purchases: [...PURCHASES, { ...halfPurchase[0], qty: 200, amount: 1300000 }] })
        .rows.filter(r => r.basis === "ORDER" && r.poId === "po17").length, 0);

console.log("\n[8-3] 출금 중복 차감 금지 · 총액 상한");
const twoMonthBase = { ...base, purchases: [...PURCHASES,
  { id: "pur-9", po_id: "po1", product_id: "p1", date: "2026-11-05", qty: 10, unit_cost: 6500, amount: 65000, supplier: "리파코 주식회사", _name: "모서리 보호대" }] };
const amb = PP.model({ ...twoMonthBase, txns: [{ id: "tz", kind: "출금", date: "2026-11-20", amount: 500000, memo: "리버스-발주-2026-018 지급" }] });
check("같은 발주의 매입월이 둘이면 어느 달인지 몰라 차감하지 않음",
      [amb.rows.reduce((s, r) => s + r.paidAmount, 0), amb.ambiguousPayouts.length], [0, 1]);
check("여러 발주가 적힌 출금도 차감하지 않음", (() => {
  const x = PP.model({ ...base, pos: [PO, PO17], items: [...ITEMS, ...IT17],
    txns: [{ id: "tm", kind: "출금", date: "2026-11-20", amount: 100000, memo: "리버스-발주-2026-018 · 리버스-발주-2026-017 합산 지급" }] });
  return [x.rows.reduce((s, r) => s + r.paidAmount, 0), x.ambiguousPayouts[0].reason.includes("여러 발주")];
})(), [0, true]);
check("공급자 이름만 적힌 합산 지급은 매칭하지 않음",
      PP.model({ ...base, txns: [{ id: "tsup", kind: "출금", date: "2026-11-20", amount: 3000000, memo: "리파코 주식회사 합산 지급" }] })
        .rows.reduce((s, r) => s + r.paidAmount, 0), 0);
check("총액 상한 - 발주 금액보다 많이 빼지 않고 초과는 확인 필요로",
      (() => { const x = PP.model({ ...base, txns: [{ id: "tover", kind: "출금", date: "2026-11-20", amount: PLAN_AMOUNT + 50000, memo: "리버스-발주-2026-018 전액" }] });
               const r = x.rows.find(y => y.basis === "PURCHASE");
               return [r.paidAmount, r.outstanding, r.overPaid, x.overPaid.length]; })(),
      [PLAN_AMOUNT, 0, 50000, 1]);
check("한 출금이 확정·예상 줄에 모두 걸리면 확정 줄에만 붙음", (() => {
  const x = PP.model({ ...halfCfg, txns: [{ id: "tp", kind: "출금", date: "2026-11-20", amount: 100000, memo: "리버스-발주-2026-017 1차" }] });
  const conf = x.rows.find(r => r.poId === "po17" && r.basis === "PURCHASE");
  const est = x.rows.find(r => r.poId === "po17" && r.basis === "ORDER");
  return [conf.paidAmount, est.paidAmount, x.ambiguousPayouts.length];
})(), [100000, 0, 0]);

console.log("\n[8-4] 입고 오류 - 지금 오류와 지나간 오류를 구분");
const past = PP.inboundStateOf([{ qty: 10, received_qty: 10 }],
  [{ id: "a", preflight_status: "FAILED", last_error_message: "센터 매핑 실패" },
   { id: "b", resubmission_of_plan_id: "a", internal_status: "RECEIVED" }]);
check("재신청으로 끝난 오류는 '지난 오류' 로", [past.errors, past.pastErrors, past.pastReasons], [0, 1, ["센터 매핑 실패"]]);
const now = PP.inboundStateOf([{ qty: 10, received_qty: 0 }],
  [{ id: "a", preflight_status: "FAILED", last_error_message: "센터 매핑 실패" }]);
check("대체 계획이 없으면 '지금 오류'", [now.errors, now.pastErrors, now.errorKind], [1, 0, "오류"]);
// 2026-10-22 실데이터(발주-2026-015): 사람이 반려한 건은 '반려' 로 말해요(시스템 오류와 할 일이 달라요)
const rej = PP.inboundStateOf([{ qty: 80, received_qty: 0 }],
  [{ id: "a", internal_status: "PENDING", rejection_code: "SINGLE_PLT", rejection_reason: "승인 불가 · 1PLT 단독 입고" }]);
check("반려는 '반려' 로 구분", [rej.errors, rej.errorKind, rej.errorReason], [1, "반려", "승인 불가 · 1PLT 단독 입고"]);
check("다음 할 일에도 반려로", PP.nextTodo({ po: { status: "ordered" }, basis: "PURCHASE", inbound: rej, freight: {}, payState: "SCHEDULED", payDate: "2026-11-20", outstanding: 0 }),
      "입고 신청 반려 확인: 승인 불가 · 1PLT 단독 입고");
check("복구 완료(RECOVERED)도 지난 오류",
      PP.inboundStateOf([{ qty: 10, received_qty: 10 }], [{ id: "a", last_error_code: "X", recovery_status: "RECOVERED" }]).errors, 0);
// 2026-10-22 실데이터(발주-2026-016): 오류가 난 계획이 취소·DB 동기화로 끝나 있었어요
check("취소된 계획의 오류는 지난 오류",
      PP.inboundStateOf([{ qty: 480, received_qty: 480 }],
        [{ id: "a", preflight_status: "FAILED", last_error_code: "SessionInvalidError", internal_status: "CANCELLED" }]).errors, 0);
check("복구가 DB 동기화까지 끝났으면 지난 오류",
      PP.inboundStateOf([{ qty: 1, received_qty: 1 }],
        [{ id: "a", internal_status: "FAILED", last_error_code: "PREFLIGHT_DRAFT_CREATED", recovery_status: "DB_SYNCED" }]).errors, 0);
check("복구 진행 중 + 아직 미입고면 지금 오류",
      PP.inboundStateOf([{ qty: 240, received_qty: 0 }],
        [{ id: "a", internal_status: "PLAN_CREATED", preflight_status: "FAILED",
           recovery_status: "PLAN_ID_CAPTURED", last_error_code: "SLOT_UNAVAILABLE_AFTER_MIN_EDD" }]).errors, 1);
const pastRow = PP.model({ ...base, inbounds: [{ id: "a", purchase_order_id: "po1", preflight_status: "FAILED", last_error_message: "센터 매핑 실패" },
                                               { id: "b", purchase_order_id: "po1", resubmission_of_plan_id: "a", internal_status: "RECEIVED" }] });
check("지난 오류는 다음 할 일에 올리지 않음", PP.nextTodo(pastRow.rows.find(r => r.basis === "PURCHASE")).includes("입고 신청 오류"), false);
check("지난 오류는 접어서 배지로만", text(PP.cardHtml(pastRow)).includes("지난 입고 오류 1건"), true);

console.log("\n[8-5] 자금일보 연결 - 예상 출금·대조표(같은 계산, 이중 합산 없음)");
const linked = PP.model({ ...base, pos: [PO, PO17], items: [...ITEMS, ...IT17] });
check("예상 출금 목록을 자금일보에 그대로 넘김",
      linked.estimatedPlans.map(x => [x.date, x.occDate, x.kind, x.amount, x.estimate, !!x.poNo]),
      [["2026-11-20", "2026-11-20", "출금", EST17, true, true]]);
check("자금일보 흐름표가 쓰는 occDate 가 있어야 날짜 칸이 비지 않아요",
      linked.estimatedPlans.every(x => !!x.occDate), true);
check("cash_plans 에 이미 있는 확정분은 예상으로 다시 넣지 않음",
      linked.estimatedPlans.filter(x => x.poNo === PO.po_no).length, 0);
check("[핵심] 매입을 넣으면 예상이 사라져 이중 합산이 안 됨(멱등 전환)", (() => {
  const after = PP.model({ ...base, pos: [PO, PO17], items: [...ITEMS, ...IT17],
    purchases: [...PURCHASES, { id: "pur-17", po_id: "po17", product_id: "p1", date: "2026-10-25", qty: 200,
                                unit_cost: 6500, amount: 1300000, supplier: "리파코 주식회사", _name: "구름목욕시간" }],
    plans: [...PLANS, { id: "cp2", date: "2026-11-20", kind: "출금", amount: EST17,
                        title: "리파코 주식회사 2026-10 매입대금 (리버스-발주-2026-017)",
                        memo: "AUTO_PURCHASE_TERMS=2026-10:po17 | 매입월 다음 달 20일" }] });
  return [after.estimatedPlans.length, after.due.confirmed.total, after.due.estimated.total, after.due.total];
})(), [0, PLAN_AMOUNT + EST17, 0, PLAN_AMOUNT + EST17]);
check("부분 매입이면 남은 몫만 예상 출금으로", (() => {
  const x = PP.model(halfCfg);
  return [x.estimatedPlans.length, x.estimatedPlans[0].amount];
})(), [1, EST17 - PP.payableOf(650000, TAXABLE, VAT)]);
const sch = linked.schedule.find(d => d.date === "2026-11-20");
check("날짜별 대조표 - 확정·예상·운반비·기지급·잔액",
      [sch.confirmed, sch.estimated, sch.cash, sch.match, sch.freightConfirmed, sch.paid, sch.outstanding],
      [PLAN_AMOUNT, EST17, PLAN_AMOUNT, true, 0, 0, PLAN_AMOUNT + EST17]);
check("다월 발주도 날짜마다 따로 대조",
      twoMonths.schedule.map(d => [d.date, d.confirmed, d.match]),
      [["2026-11-20", PLAN_AMOUNT, true], ["2026-12-20", PP.payableOf(65000, TAXABLE, VAT), false]]);
check("부분 지급도 대조표에 반영", (() => {
  const x = PP.model({ ...base, txns: [{ id: "t1", kind: "출금", date: "2026-11-20", amount: 300000, memo: "리버스-발주-2026-018 1차" }] });
  const d = x.schedule.find(y => y.date === "2026-11-20");
  return [d.paid, d.outstanding, d.confirmed];
})(), [300000, PLAN_AMOUNT - 300000, PLAN_AMOUNT]);
check("확정 운반비도 대조표에", (() => {
  const x = PP.model({ ...base, freights: [{ id: "f1", purchase_order_id: "po1", basis: "ACTUAL", gross: 132000 }] });
  const d = x.schedule.find(y => y.date === "2026-11-20");
  return [d.freightConfirmed, d.outstanding];
})(), [132000, PLAN_AMOUNT + 132000]);
check("'실제로 나갈 돈' 이라고 단정하지 않고 예상·확인 필요를 유지",
      [text(PP.cardHtml(linked)).includes("실제로 나갈 돈"), text(PP.cardHtml(linked)).includes("미지급(확정 전)"),
       text(PP.cardHtml(linked)).includes("지급 확인 필요")], [false, true, true]);
check("app.js 자금일보가 같은 모델을 쓰고 확정·조정을 나눠 보여 줌",
      ["PurchasePayments.load(sb", "PurchasePayments.cashAdjustments", "planOutEst", "예상 · 매입 전", "확정만 반영하면"]
        .filter(w => !APP.includes(w)), []);

console.log("\n[8-6] 입고 오류 - 대체 신청 증거로 이력/확인 필요 가르기");
const ev = PP.inboundStateOf([{ qty: 240, received_qty: 240, wing_observed_received_qty: 240 }],
  [{ id: "a", internal_status: "PLAN_CREATED", preflight_status: "FAILED", recovery_status: "PLAN_ID_CAPTURED",
     last_error_code: "SLOT_UNAVAILABLE_AFTER_MIN_EDD" }], { wing_direct_shipment_id: "1110729122750939136" });
check("[실데이터 018] 대체 신청·관측 수량이 맞으면 이력으로",
      [ev.errors, ev.checks, ev.pastErrors, ev.pastEvidence.length], [0, 0, 1, 2]);
const noEv = PP.inboundStateOf([{ qty: 240, received_qty: 240 }],
  [{ id: "a", internal_status: "PLAN_CREATED", preflight_status: "FAILED", recovery_status: "PLAN_ID_CAPTURED",
     last_error_code: "SLOT_UNAVAILABLE_AFTER_MIN_EDD" }], {});
check("증거가 없으면 '확인 필요'(현재 오류로 단정하지 않음)", [noEv.errors, noEv.checks, noEv.pastErrors], [0, 1, 0]);
const notDone = PP.inboundStateOf([{ qty: 240, received_qty: 0 }],
  [{ id: "a", preflight_status: "FAILED", last_error_code: "X" }], {});
check("아직 입고가 안 됐으면 지금 오류 그대로", [notDone.errors, notDone.checks], [1, 0]);
check("확인 필요도 다음 할 일에 나옴",
      PP.nextTodo({ po: { status: "ordered" }, basis: "PURCHASE", inbound: noEv, freight: {}, payState: "SCHEDULED", payDate: "x", outstanding: 0 })
        .includes("어느 신청으로 받았는지 확인"), true);

console.log("\n[8-7] 등록 경로 · 연결 확인 · 입고 근거 있는 보류");
const directPO = { id: "pod", po_no: "리버스-발주-WING검토-111", supplier: "리파코 주식회사", date: "2026-10-12",
                   status: "done", wing_direct_shipment_id: "111" };
const directPur = [{ id: "pur-d", po_id: "pod", product_id: "p1", date: "2026-10-12", qty: 72, unit_cost: 9300,
                     amount: 669600, supplier: "리파코 주식회사", _name: "틈새 수납함",
                     memo: "WING검토-111 | 사용자 확인: 기존 발주의 재신청. 실제 입고 222" }];
const dm = PP.model({ ...base, pos: [PO, directPO], items: ITEMS, purchases: [...PURCHASES, ...directPur] });
const drow = dm.rows.find(r => r.poId === "pod");
check("[핵심] 발주서 없이 쿠팡에 먼저 입고한 건도 집계에 포함",
      [!!drow, drow.basis, drow.goods], [true, "PURCHASE", PP.payableOf(669600, TAXABLE, VAT)]);
check("등록 경로를 구분해 적음", [drow.route, dm.rows.find(r => r.poId === "po1").route],
      ["쿠팡 직접입고 → ERP 등록", "ERP 발주서 → 입고"]);
check("재신청 메모는 '연결 확인 필요' 로 남기고 금액을 임의로 합치거나 빼지 않음",
      [drow.linkNotes, drow.goods], [["재신청"], PP.payableOf(669600, TAXABLE, VAT)]);
check("재고 이동 메모도 연결 확인 대상",
      PP.model({ ...base, pos: [PO, directPO], items: ITEMS,
        purchases: [...PURCHASES, { ...directPur[0], memo: "쿠팡 창고로 재고 이동분" }] })
        .rows.find(r => r.poId === "pod").linkNotes, ["재고 이동"]);
check("검토 초안이라도 입고 근거가 있으면 예상에 넣고 근거를 적음", (() => {
  const x = PP.model({ ...base, pos: [PO, { id: "pw", po_no: "WING검토-2", supplier: "리파코 주식회사", date: "2026-10-03",
                                            status: "wing_direct_review", wing_direct_shipment_id: "999" }],
    items: [...ITEMS, { id: "iw", po_id: "pw", product_id: "p1", qty: 10, unit_cost: 1000, amount: 10000,
                        received_qty: 10, wing_observed_received_qty: 10, _name: "x" }] });
  const r = x.rows.find(y => y.poId === "pw");
  return [r.hold, r.holdReleased, x.due.estimated.count >= 1, r.evidenceNote.includes("WING 관측")];
})(), [false, true, true, true]);
check("입고 근거가 없는 검토 초안은 보류 유지(임의 확정 금지)", (() => {
  const x = PP.model({ ...base, pos: [PO, { id: "pw2", po_no: "WING검토-3", supplier: "리파코 주식회사", date: "2026-10-03",
                                            status: "wing_direct_review" }],
    items: [...ITEMS, { id: "iw2", po_id: "pw2", product_id: "p1", qty: 10, unit_cost: 1000, amount: 10000, received_qty: 0, _name: "x" }] });
  return x.rows.find(y => y.poId === "pw2").hold;
})(), true);

console.log("\n[8-8] 자금일보 ↔ 발주 화면 합계 대조(0원 아닌 시나리오)");
// 자금일보가 반영하는 총액 = cash_plans(확정) + 조정항목(예상·운반비·미생성분 − 확인된 지급)
const cashTotalAt = (m, date) => {
  const cash = (m.rows.filter(r => r.payDate === date && r.plan).map(r => Number(r.plan.amount)))
    .reduce((a, b) => a + b, 0);
  const adj = PP.cashAdjustments(m, { from: date, to: date })
    .reduce((a, o) => a + (o.kind === "입금" ? -1 : 1) * o.amount, 0);
  return cash + adj;
};
// 자금일보 예측이 반영해야 할 금액 = 미지급 + 아직 통장에서 안 나간(미래 날짜) 확인 지급
const screenTotalAt = (m, date) => {
  const d = m.schedule.find(x => x.date === date) || {};
  return (d.outstanding || 0) + (d.paidFuture || 0);
};
const compare = (label, cfg, date) => {
  const m = PP.model(cfg);
  check(label, [cashTotalAt(m, date), screenTotalAt(m, date), cashTotalAt(m, date) === screenTotalAt(m, date)],
        [screenTotalAt(m, date), screenTotalAt(m, date), true]);
  return m;
};
compare("① 확정 운반비가 있는 날 - 양쪽 같은 잔액",
        { ...base, freights: [{ id: "f1", purchase_order_id: "po1", basis: "ACTUAL", gross: 132000 }] }, "2026-11-20");
compare("② 부분 지급(이미 통장에서 나감)이 있는 날 - 양쪽 같은 잔액",
        { ...base, txns: [{ id: "t1", kind: "출금", date: "2026-10-01", amount: 300000, memo: "리버스-발주-2026-018 1차" }] }, "2026-11-20");
check("② 과거 지급은 예정출금을 그만큼 줄임", (() => {
  const m2 = PP.model({ ...base, txns: [{ id: "t1", kind: "출금", date: "2026-10-01", amount: 300000, memo: "리버스-발주-2026-018 1차" }] });
  return [cashTotalAt(m2, "2026-11-20"), PLAN_AMOUNT - 300000];
})(), [PLAN_AMOUNT - 300000, PLAN_AMOUNT - 300000]);
compare("②-2 미래 날짜 지급은 아직 안 나갔으니 예측에 남음",
        { ...base, txns: [{ id: "t1", kind: "출금", date: "2026-11-25", amount: 300000, memo: "리버스-발주-2026-018 1차" }] }, "2026-11-20");
compare("③ 예상(매입 전 발주)이 섞인 날 - 양쪽 같은 잔액",
        { ...base, pos: [PO, PO17], items: [...ITEMS, ...IT17] }, "2026-11-20");
compare("④ 부분 매입 + 운반비 + 과거 부분 지급이 모두 있는 날",
        { ...halfCfg, freights: [{ id: "f1", purchase_order_id: "po1", basis: "ACTUAL", gross: 132000 }],
          txns: [{ id: "t1", kind: "출금", date: "2026-10-01", amount: 300000, memo: "리버스-발주-2026-018 1차" }] }, "2026-11-20");
compare("⑤ 확정 plan 이 아직 없는 날(예정출금 미생성) - 미생성분을 항목으로 더해 같은 잔액",
        { ...base, plans: [] }, "2026-11-20");
const mm = compare("⑥ 다월 발주 - 뒤 달도 같은 잔액",
        { ...base, purchases: [...PURCHASES, { id: "pur-9", po_id: "po1", product_id: "p1", date: "2026-11-05",
          qty: 10, unit_cost: 6500, amount: 65000, supplier: "리파코 주식회사", _name: "x" }] }, "2026-12-20");
check("예정출금 미생성분은 보정 한 줄로 더하고 cash_plans 를 만들지 않음", (() => {
  const adj = PP.cashAdjustments(PP.model({ ...base, plans: [] }), { from: "2026-11-20", to: "2026-11-20" });
  const x = adj.find(o => o.type === "RECONCILE");
  return [!!x, x.amount, x.note.includes("만들거나 고치지 않아요"), x.note.includes("미생성분")];
})(), [true, PLAN_AMOUNT, true, true]);
// 2026-10-22 Codex 지적: 기지급을 '입금' 으로 올리면 예측 잔액에 다시 더해져요 - 출금 감액으로만 반영합니다.
check("[핵심] 확인된 지급은 출금 감액(음수)으로만 - 입금으로 올리지 않음", (() => {
  const adj = PP.cashAdjustments(PP.model({ ...base, txns: [{ id: "t1", kind: "출금", date: "2026-10-01",
    amount: 300000, memo: "리버스-발주-2026-018 1차" }] }), { from: "2026-11-20", to: "2026-11-20" });
  const x = adj.find(o => o.type === "RECONCILE");
  return [adj.some(o => o.kind === "입금"), x.kind, x.amount];
})(), [false, "출금", -300000]);
check("cash_plans 가 이미 순액(지급분 차감됨)이어도 이중 차감 없음", (() => {
  const m2 = PP.model({ ...base, plans: [{ ...PLANS[0], amount: PLAN_AMOUNT - 300000 }],
    txns: [{ id: "t1", kind: "출금", date: "2026-10-01", amount: 300000, memo: "리버스-발주-2026-018 1차" }] });
  const adj = PP.cashAdjustments(m2, { from: "2026-11-20", to: "2026-11-20" });
  const total = (PLAN_AMOUNT - 300000) + adj.reduce((a, o) => a + o.amount, 0);
  return [total, screenTotalAt(m2, "2026-11-20"), adj.length];
})(), [PLAN_AMOUNT - 300000, PLAN_AMOUNT - 300000, 0]);
check("미래 날짜로 확인된 지급은 예측에서 빼지 않음(아직 안 나갔어요)", (() => {
  const m2 = PP.model({ ...base, txns: [{ id: "t1", kind: "출금", date: "2026-11-25", amount: 300000,
    memo: "리버스-발주-2026-018 1차" }] });
  const adj = PP.cashAdjustments(m2, { from: "2026-11-20", to: "2026-11-20" });
  return [adj.filter(o => o.type === "RECONCILE").length, m2.schedule[0].paidFuture];
})(), [0, 300000]);

console.log("\n[8-8b] 기한 지난 미지급 이월");
const overdueM = PP.model({ ...base, today: "2026-11-25" });
check("지급일이 지난 미지급은 carry 로 따로 모음",
      [overdueM.carry.count, overdueM.carry.total, overdueM.carry.dates[0].date], [1, PLAN_AMOUNT, "2026-11-20"]);
check("이월 금액을 화면에 적고 미래 예측과 구분",
      [text(PP.cardHtml(overdueM)).includes("이월 미지급"),
       text(PP.cardHtml(overdueM)).includes("미래 예측에는 들어가지 않는")], [true, true]);
check("이월은 미래 예측 조정에 포함되지 않음",
      PP.cashAdjustments(overdueM, { from: "2026-11-25", to: "2026-12-31" }).length, 0);
check("자금일보도 같은 carry 를 보여 줌", ["payModel.carry", "이월 미지급"].filter(w => !APP.includes(w)), []);
check("지급이 다 끝난 날은 이월에 없음",
      PP.model({ ...base, today: "2026-11-25", txns: [{ id: "t1", kind: "출금", date: "2026-11-20",
        amount: PLAN_AMOUNT, memo: "리버스-발주-2026-018 전액" }] }).carry.count, 0);

console.log("\n[8-9] 쿠팡 원천 역대조 - 매입·발주에 없는 실제 입고 검출");
const WD = [
  { product_id: "p1", wing_created_at: "2026-10-07T00:00:00Z", wing_request_id: "R1", wing_inbound_id: "I1",
    requested_qty: 100, received_qty: 100, stowed_qty: 100, wing_status: "STOWING" },
  { product_id: "p1", wing_created_at: "2026-10-12T00:00:00Z", wing_request_id: "R2", wing_inbound_id: "I2",
    requested_qty: 50, received_qty: 0, stowed_qty: 0, wing_status: "INIT_COMPLETED" },
  { product_id: "p1", wing_created_at: "2026-10-14T00:00:00Z", wing_request_id: "R3", wing_inbound_id: "I3",
    requested_qty: 72, received_qty: 0, stowed_qty: 0, wing_status: "CANCELLED" },
  { product_id: "p1", wing_created_at: "2026-10-05T00:00:00Z", wing_request_id: "R4", wing_inbound_id: "I4",
    requested_qty: 240, received_qty: 240, stowed_qty: 240, wing_status: "STOWING" },
];
const srcM = PP.model({ ...base, pos: [{ ...PO, wing_direct_shipment_id: "I4" }], wingInbounds: WD });
check("매입·발주 없이 실제 입고된 건을 잡아냄",
      srcM.sourceGaps.filter(g => g.kind === "매입·발주 없이 실제 입고됨").map(g => [g.request, g.received]), [["R1", 100]]);
check("신청만 있고 입고 전인 건은 따로 분류",
      srcM.sourceGaps.filter(g => g.kind === "신청만 있고 아직 입고 없음").map(g => g.request), ["R2"]);
check("취소 신청은 매입으로 보지 않음", srcM.sourceGaps.some(g => g.request === "R3"), false);
check("이미 매입·발주에 연결된 입고는 빠짐", srcM.sourceGaps.some(g => g.request === "R4"), false);
check("취소된 발주인데 실제 입고된 건도 잡아냄", (() => {
  const x = PP.model({ ...base, pos: [PO, { id: "pc", po_no: "WING검토-취소", supplier: "리파코 주식회사",
    date: "2026-10-16", status: "canceled", wing_direct_shipment_id: "I9" }],
    wingInbounds: [{ product_id: "p1", wing_created_at: "2026-10-16T00:00:00Z", wing_request_id: "R9",
                     wing_inbound_id: "I9", requested_qty: 50, received_qty: 50, stowed_qty: 50, wing_status: "STOWING" }] });
  return x.sourceGaps.map(g => [g.kind, g.po, g.received]);
})(), [["취소·반려 발주인데 실제 입고됨", "WING검토-취소", 50]]);
check("미연결 건에 지급월 후보·단가 근거를 건별로 남김", (() => {
  const g = srcM.sourceGaps.find(x => x.request === "R1");
  return [g.payMonth, g.unitEvidence, g.included];
})(), ["2026-11-20", [6500], false]);
check("단가 근거가 없으면 빈 목록(마스터 원가를 대입하지 않음)", (() => {
  const x = PP.model({ ...base, items: [], purchases: [], plans: [], wingInbounds: WD });
  return x.sourceGaps.find(g => g.request === "R1").unitEvidence;
})(), []);
check("합계가 '연결분만의 잠정액' 임을 화면에 적음",
      text(PP.cardHtml(srcM)).includes("현재 연결분만의 잠정액"), true);
check("증명 안 된 건은 금액을 0원으로 확정하지 않음(null 로 둠)",
      [text(PP.cardHtml(srcM)).includes("0원 확정이 아닙니다"),
       srcM.sourceGaps.filter(g => !g.provable).every(g => g.amount === null)], [true, true]);
// 증명 가능한 건(이 입고번호로 연결된 발주서에 같은 상품 품목·단가가 있는 경우)은 금액을 잡아 합계에 넣어요
const prov = PP.model({ ...base,
  pos: [PO, { id: "pc2", po_no: "WING검토-증명", supplier: "리파코 주식회사", date: "2026-10-16",
              status: "canceled", wing_direct_shipment_id: "I7" }],
  items: [...ITEMS, { id: "ix", po_id: "pc2", product_id: "p1", qty: 50, unit_cost: 8500, amount: 425000, _name: "베베 케이스" }],
  wingInbounds: [{ product_id: "p1", wing_created_at: "2026-10-16T00:00:00Z", wing_request_id: "R7", wing_inbound_id: "I7",
                   requested_qty: 50, received_qty: 50, stowed_qty: 50, wing_status: "STOWING" }] });
const provGap = prov.sourceGaps.find(g => g.request === "R7");
check("증명된 원천 입고는 발주서 단가로 금액을 잡고 합계에 포함",
      [provGap.provable, provGap.included, provGap.amount, provGap.evidence.includes("발주서 WING검토-증명")],
      [true, true, PP.payableOf(50 * 8500, TAXABLE, VAT), true]);
check("증명된 건이 지급 예정 합계·대조표에 흐름", (() => {
  const d = prov.schedule.find(x => x.date === "2026-11-20");
  return [d.estimated, prov.rows.some(r => r.fromSource)];
})(), [PP.payableOf(50 * 8500, TAXABLE, VAT), true]);
check("수량이 다르면 '수량 확인' 을 남김", (() => {
  const x = PP.model({ ...base,
    pos: [PO, { id: "pc3", po_no: "WING검토-수량", supplier: "리파코 주식회사", date: "2026-10-14",
                status: "canceled", wing_direct_shipment_id: "I8" }],
    items: [...ITEMS, { id: "iy", po_id: "pc3", product_id: "p1", qty: 60, unit_cost: 6300, amount: 378000, _name: "스프레이건" }],
    wingInbounds: [{ product_id: "p1", wing_created_at: "2026-10-14T00:00:00Z", wing_request_id: "R8", wing_inbound_id: "I8",
                     requested_qty: 60, received_qty: 40, stowed_qty: 40, wing_status: "STOWING" }] });
  const g = x.sourceGaps.find(y => y.request === "R8");
  return [g.amount, g.qtyMismatch, g.received];
})(), [PP.payableOf(40 * 6300, TAXABLE, VAT), false, 40]);
check("연결된 발주서가 없으면 증명 불가 - 금액 미포함",
      srcM.sourceGaps.filter(g => g.received > 0).every(g => g.provable === false), true);
check("누락이 없으면 '누락 0건' 으로 적음",
      text(PP.cardHtml(PP.model({ ...base, wingInbounds: [] }))).includes("누락 0건"), true);
check("자금일보도 같은 모델의 조정 항목을 씀", ["PurchasePayments.cashAdjustments", "PLAN_MISSING", "PAID_OFFSET"]
      .filter(w => !APP.includes(w)), []);

console.log("\n[9] 화면 - 모바일 펼침 · 단가 보존 문구 · 송금 없음");
check("요약은 <summary>, 자세한 건 <details> 안", [html.includes("<details class=\"pp-row\">"), html.includes("<summary>")], [true, true]);
check("모바일 레이아웃 규칙", [CSS.includes("@media (max-width: 720px)"), CSS.includes(".pp-row > summary")], [true, true]);
check("발주 시점 단가 보존을 화면에 명시", text(html).includes("상품 마스터 원가를 나중에 바꿔도 이 금액은 바뀌지 않아요"), true);
check("자금일보와 같은 계산임을 명시", text(html).includes("자금일보와 같은 계산"), true);
// 쓰기·발송은 '코드 호출' 로 확인해요(안내 문구에 '송금' 같은 말이 들어가는 건 설명이라 괜찮아요)
check("쓰기·발송 호출 없음", [".insert(", ".update(", ".delete(", ".upsert(", ".rpc(", "fetch(", "XMLHttpRequest", "sendBeacon"]
      .filter(w => readFileSync(SRC, "utf8").includes(w)), []);
check("조회는 select 만", (readFileSync(SRC, "utf8").match(/\.from\("[a-z_]+"\)\.select\(/g) || []).length >= 8, true);
// 현재/과거 오류를 가르려면 internal_status 가 꼭 필요해요(빠뜨리면 취소된 계획을 '지금 오류'로 봅니다)
check("입고 계획 조회에 판정용 칼럼이 다 들어 있음",
      ["internal_status", "recovery_status", "resubmission_of_plan_id", "retry_of_plan_id", "preflight_status"]
        .filter(c => !new RegExp(`inbound_plans"\\)\\.select\\("[^"]*${c}`).test(readFileSync(SRC, "utf8"))), []);
check("app.js 는 발주서 화면 맨 위에 카드만 끼움", [APP.includes("PurchasePayments.load(sb"), APP.includes("${payHtml}")], [true, true]);
check("index.html 에 스크립트 등록(app.js 보다 먼저)",
      [IDX.includes("js/purchase_payments.js"), IDX.indexOf("js/purchase_payments.js") < IDX.indexOf("js/app.js")], [true, true]);

console.log();
if (fails.length) { console.log(`실패 ${fails.length}/${n}: ${fails.join(", ")}`); process.exit(1); }
console.log(`전부 통과 ${n}/${n}`);
