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
check("입고 완료여도 오류는 따로 남음", [inbErr.state, inbErr.errors, inbErr.errorReason], ["DONE", 1, "센터 매핑 실패"]);
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
check("대체 계획이 없으면 '지금 오류'", [now.errors, now.pastErrors], [1, 0]);
check("복구 완료(RECOVERED)도 지난 오류",
      PP.inboundStateOf([{ qty: 10, received_qty: 10 }], [{ id: "a", last_error_code: "X", recovery_status: "RECOVERED" }]).errors, 0);
const pastRow = PP.model({ ...base, inbounds: [{ id: "a", purchase_order_id: "po1", preflight_status: "FAILED", last_error_message: "센터 매핑 실패" },
                                               { id: "b", purchase_order_id: "po1", resubmission_of_plan_id: "a", internal_status: "RECEIVED" }] });
check("지난 오류는 다음 할 일에 올리지 않음", PP.nextTodo(pastRow.rows.find(r => r.basis === "PURCHASE")).includes("입고 신청 오류"), false);
check("지난 오류는 접어서 배지로만", text(PP.cardHtml(pastRow)).includes("지난 입고 오류 1건"), true);

console.log("\n[9] 화면 - 모바일 펼침 · 단가 보존 문구 · 송금 없음");
check("요약은 <summary>, 자세한 건 <details> 안", [html.includes("<details class=\"pp-row\">"), html.includes("<summary>")], [true, true]);
check("모바일 레이아웃 규칙", [CSS.includes("@media (max-width: 720px)"), CSS.includes(".pp-row > summary")], [true, true]);
check("발주 시점 단가 보존을 화면에 명시", text(html).includes("상품 마스터 원가를 나중에 바꿔도 이 금액은 바뀌지 않아요"), true);
check("자금일보와 같은 계산임을 명시", text(html).includes("자금일보와 같은 계산"), true);
// 쓰기·발송은 '코드 호출' 로 확인해요(안내 문구에 '송금' 같은 말이 들어가는 건 설명이라 괜찮아요)
check("쓰기·발송 호출 없음", [".insert(", ".update(", ".delete(", ".upsert(", ".rpc(", "fetch(", "XMLHttpRequest", "sendBeacon"]
      .filter(w => readFileSync(SRC, "utf8").includes(w)), []);
check("조회는 select 만", (readFileSync(SRC, "utf8").match(/\.from\("[a-z_]+"\)\.select\(/g) || []).length >= 8, true);
check("app.js 는 발주서 화면 맨 위에 카드만 끼움", [APP.includes("PurchasePayments.load(sb"), APP.includes("${payHtml}")], [true, true]);
check("index.html 에 스크립트 등록(app.js 보다 먼저)",
      [IDX.includes("js/purchase_payments.js"), IDX.indexOf("js/purchase_payments.js") < IDX.indexOf("js/app.js")], [true, true]);

console.log();
if (fails.length) { console.log(`실패 ${fails.length}/${n}: ${fails.join(", ")}`); process.exit(1); }
console.log(`전부 통과 ${n}/${n}`);
