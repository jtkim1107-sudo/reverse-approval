// fixtures_cm_settlement_ui.mjs - js/cm_settlement.js(새 공헌이익 표시) 로컬 검증. 네트워크·DB 없음.
//   node fixtures_cm_settlement_ui.mjs
import fs from "node:fs";
import vm from "node:vm";
const ctx = { console };
ctx.globalThis = ctx; ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(new URL("./js/erp_ui.js", import.meta.url), "utf8"), ctx);
vm.runInContext(fs.readFileSync(new URL("./js/cm_settlement.js", import.meta.url), "utf8"), ctx);
const C = ctx.CmSettlement;
const D = (c, p, o = {}) => C.primaryHtml(c, o) + C.compareHtml(c, p);   // 2026-09-15 주 결과 카드 + 같은 기간 비교(참고)
let n = 0, fail = 0;
const check = (label, got, want) => { n++; const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) fail++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n       기대=${JSON.stringify(want)}\n       실제=${JSON.stringify(got)}`}`); };
const sbWith = (row, err) => ({ from: () => ({ select() { return this; }, eq() { return this; },
  maybeSingle: async () => (err ? { data: null, error: { message: "x" } } : { data: row, error: null }) }) });

console.log("[1] 스위치 - {enabled:true} 만 켜짐(기본 OFF)");
check("행 없음 → OFF", await C.isEnabled(sbWith(null)), false);
check("읽기 실패 → OFF", await C.isEnabled(sbWith(null, true)), false);
check("enabled:false → OFF", await C.isEnabled(sbWith({ value: { enabled: false } })), false);
check("enabled:'true'(문자) → OFF", await C.isEnabled(sbWith({ value: { enabled: "true" } })), false);
check("enabled:true → ON", await C.isEnabled(sbWith({ value: { enabled: true } })), true);
check("문자열 JSON enabled:true → ON", await C.isEnabled(sbWith({ value: '{"enabled": true}' })), true);

const r = { revenue: 56000, cost: 10000, cm: 12350, cm_rate: 22.05, status: "PROVISIONAL", inbound_freight: 0, cm_with_recovery_candidates: 13350,
  revenue_parts: { rg_gross: 45000, rg_coupon: 0, rg_cancel: -9000, mp: 20000 }, fee: { total: 5650, settled: 0, cycle_open: 2550, estimated: 3100, vat_total: 155, unknown_rate_rows: 0 },
  ads: { performance_spend: 21000, cm_amount: 21000, billed: 20000, billed_status: "CYCLE_OPEN", outside_rg: 1000, outside_accrued: 1000, outside_billed: 0,
         outside_status: "ACCRUED", over_budget: 0, rounding: 0 },
  monthly_costs: { total: 8000 }, cost_recovery: { confirmed: 0, pending: 1000, candidate_amount: 1000, candidates: [{ vendor_item_id: "optR", qty: 1 }] },
  mp_unregistered: [{ product_code: "C-01", label: "포장비", orders: 2, qty: 2 }], cancel: { qty: 1 },
  cost_fallback: [{ product_code: "A-01", rows: 3, qty: 4, amount: 4000 }],
  lines: [{ code: "REVENUE_RG_GROSS", label: "로켓그로스 판매", amount: 45000, status: "CYCLE_OPEN" },
          { code: "UNREGISTERED_PACKAGING_FEE_C-01", label: "포장비 · C-01", amount: null, status: "COST_UNREGISTERED", orders: 2, qty: 2 }],
  coupang_display: { amount: -8105, sales_with_refund: 16500, deductions: 24605 } };
const cur = { MAIN: { period_start: "2026-09-01", period_end: "2026-09-12", cm_status: "PROVISIONAL", calc_assessment: "PROVISIONAL", confirmed: false, cm: 12350, reasons: [{ status: "CYCLE_OPEN", text: "x" }, { status: "COST_UNREGISTERED", text: "y" }], result: r, created_at: "2026-09-14T13:10" },
              COHORT: { as_of: "2026-09-12", cm: 20350, result: { ...r, cm: 20350, revenue: 65000 } } };
const prod = { revenue: 60000, rg_revenue: 40000, mp_revenue: 20000, cost: 9000, fee: 7000, logi: 3000, ship: 0, inFreight: 0, ads: 21500, cmNet: 20500 };

console.log("[2] 운영 → 새 계산 차이 구성");
const cmp = C.compare(cur.MAIN, prod);
check("항목 합 = 신규 − 운영, 반올림 줄 없음", [Math.round(cmp.items.reduce((s, x) => s + x.amount, 0)), cmp.diff, cmp.items.some(x => x.label === "반올림")], [-8150, -8150, false]);

console.log("[3] 상세 카드");
const h = D(cur, prod, { month: "2026-09" });
check("새 계산·운영·차이 금액", [h.includes("₩12,350"), h.includes("₩20,500"), h.includes("−8,150")], [true, true, true]);
check("미등록 비용은 '금액 없음'(0원 아님)", [h.includes("금액 없음"), h.includes("0원 확정 아님")], [true, true]);
check("상태 배지 문구", ["정산 진행 중", "예상", "비용 미등록", "확정"].map(t => h.includes(t)), [true, true, true, true]);
check("'원가환입 후보' → '회수·손실 확인 대기' 배지 이름", [C.chip("RECOVERY_CANDIDATE").includes("회수·손실 확인 대기"), h.includes("원가환입 후보")], [true, false]);
check("정산 밖 광고비는 '청구 미확인(ACCRUED)' + 대체 안내", [h.includes("청구 미확인(ACCRUED)"), h.includes("그 금액으로 바뀌어요(더하지 않음)")], [true, true]);
check("쿠팡 표시 이익: 별도 aside · '공헌이익 아님'", [/<aside class="cmv2-coupang"/.test(h), h.includes("공헌이익 아님")], [true, true]);
check("코호트는 기본 접힌 details", /<details class="cmv2-cohort">/.test(h), true);
check("옛(v2.5) 결과: 자동 환입 전 계산 안내 · '승인 수량만 반영' 문구 없음 · 재판매분은 판매 원가로 다시 비용",
      [h.includes("자동 원가환입 전(v2.5) 계산이에요"), h.includes("승인 수량만"), h.includes("판매 원가로 다시 비용")], [true, false, true]);
check("결과 없음 안내", C.noticeHtml("EMPTY", { month: "2026-09" }).includes("아직 없어요"), true);
check("조회 실패 안내 · 기존 계산을 주 결과로 대신 쓰지 않음", [C.noticeHtml("ERROR", { error: "boom" }).includes("정산자료 계산 조회 실패"),
      C.noticeHtml("ERROR", { error: "boom" }).includes("기존 운영 계산을 대신 주 결과로 보여 주지 않아요"), /₩/.test(C.noticeHtml("ERROR", { error: "boom" }))], [true, true, false]);
check("대시보드: 비교 한 줄은 결과 없으면 빈 문자열 · 실패 안내", [C.dashboardCompareHtml(null, prod), C.dashboardNoticeHtml("ERROR", "x").includes("정산자료 계산 조회 실패")], ["", true]);
check("대시보드: 주 결과 새 값 · 비교 한 줄 운영·차이", [C.dashboardMainHtml(cur).includes("₩12,350"), ...["₩20,500", "−8,150"].map(t => C.dashboardCompareHtml(cur, prod).includes(t))], [true, true, true]);
check("스크립트 안에 쓰기 호출 없음(insert/update/upsert/delete/rpc)", /\.(insert|update|upsert|delete|rpc)\(/.test(fs.readFileSync(new URL("./js/cm_settlement.js", import.meta.url), "utf8")), false);
const hc = D({ ...cur, MAIN: { ...cur.MAIN, confirmed: true } }, prod, { month: "2026-09" });
check("확정 표시는 뷰의 confirmed(DB 판정 + 로그인 승인)일 때만", [h.includes("주 결과 · 잠정"), hc.includes("주 결과 · 확정")], [true, true]);
const hr = D({ ...cur, MAIN: { ...cur.MAIN, calc_assessment: "READY_FOR_APPROVAL", result: { ...r, status: "CONFIRMED" } } }, prod, { month: "2026-09" });
check("계산 결과 안의 status 가 CONFIRMED 여도 화면은 '승인 대기'(확정 아님)", [hr.includes("주 결과 · 승인 대기"), hr.includes("주 결과 · 확정")], [true, false]);
check("현재 원가 fallback 목록(상품·줄·수량·금액) + '확정할 수 없어요'", [h.includes("A-01"), h.includes("3줄 · 4개"), h.includes("₩4,000"), h.includes("확정할 수 없어요")], [true, true, true, true]);
check("프로모션 공지 미확인 배지 문구", C.chip("NOTICE_MISSING").includes("프로모션 공지 미확인"), true);
console.log("[4] 확정 자료 입력 목록 · 환불 참고 구분(2026-09-16)");
const r4 = { ...r, required_inputs: [
    { key: "PROMO_EVIDENCE", label: "8월 무료 프로모션 근거(입고비 · 풀필먼트비)", status: "NEEDED", impact_low: null, impact_high: 0, impact_note: "정산 원본 0원", how: "공지 원본 등록 → 승인" },
    { key: "SAVER_VAT", label: "세이버 비용 VAT 기준", status: "NEEDED", impact_low: 0, impact_high: 9113, impact_note: "", how: "확인" },
    { key: "RETURN_RECOVERY", label: "반품 원가환입", status: "PENDING_APPROVAL", impact_low: 0, impact_high: 577700, impact_note: "", how: "제안 → 승인" },
    { key: "COST_HISTORY", label: "원가 이력", status: "DONE", impact_low: 0, impact_high: 0, impact_note: "", how: "" }],
  refunds_reference: { status: "REFERENCE_ESTIMATE", total_rows: 3, total_supply: 9000, by_class: { CANCEL_EST: { label: "주문 취소(추정)", rows: 1, supply: 3000 },
    RETURN_EST: { label: "반품(추정)", rows: 2, supply: 6000 } } },
  cost_recovery: { ...r.cost_recovery, applied: [{ id: "a" }], proposals_pending: [{ id: "p" }], invalid: [{ id: "x" }], confirmed: 8500 } };
const h4 = D({ ...cur, MAIN: { ...cur.MAIN, result: r4 } }, prod, { month: "2026-09" });
check("입력 목록: 남은 3건 · 상태 문구 · 범위(금액 미정/0~+9,113)", [h4.includes("확정 자료 입력 목록 · 3건 남음"), h4.includes("입력 필요"), h4.includes("승인 대기"),
      h4.includes("? ~ 0"), h4.includes("0 ~ +9,113"), h4.includes("완료")], [true, true, true, true, true, true]);
check("[핵심] 환불은 한 번만 뺐다는 문구 + 세부 구분은 '참고 추정'·확정 자료 아님", [h4.includes("정산취소 전체) 3건 ₩9,000은 위에서 한 번만 뺐어요"), h4.includes("참고 추정</span> 세부 구분:"),
      h4.includes("확정 자료가 아니고 원가환입 근거로 쓰지 않아요")], [true, true, true]);
check("정산 원본과 맞지 않는 회수 확인 기록 1건은 반품 손실 근거로 안 씀(확인 필요)", h4.includes("맞지 않는 회수 확인 기록 1건 - 반품 손실 근거로 쓰지 않았어요"), true);
check("원가환입 제안 칸은 CmRecovery 가 없으면 그리지 않음(표시 파일은 쓰기 없음)", h4.includes('id="cmr"'), false);
console.log("[5] v2.5 비용 출처 · 확정/잠정 상태");
const r5 = { ...r, lines: [
    { code: "REVENUE_RG_GROSS", label: "로켓그로스 판매", amount: 45000, status: "CYCLE_OPEN", source: "정산파일" },
    { code: "FEE_SETTLED", label: "판매수수료 · 정산 확정", amount: -524794, status: "CONFIRMED", source: "정산파일 · API", source_amounts: { "정산파일": -519193, "API": -5601 } },
    { code: "MONTHLY_WAREHOUSING", label: "로켓그로스 입고비 (대표 확정 0원 · 정산 원본도 0원)", amount: -0, status: "CONFIRMED", source: "대표 확정" },
    { code: "AD_OUTSIDE_ACCRUED", label: "광고비 · 정산 밖 청구 미확인", amount: -11989, status: "ACCRUED", source: "API" },
    { code: "COST_PRODUCT", label: "상품원가", amount: -2445553, status: "CONFIRMED", source: "ERP" },
    { code: "UNREGISTERED_PARCEL_FEE_C-01", label: "판매자배송 택배비 · C-01", amount: null, status: "COST_UNREGISTERED", orders: 2, qty: 2, source: "수동 입력" },
    { code: "REVENUE_MP", label: "옛 결과(출처 없음)", amount: 1000, status: "CONFIRMED" }] };
const h5 = D({ ...cur, MAIN: { ...cur.MAIN, result: r5 } }, prod, { month: "2026-08" });
const rowOf = (html, label) => (html.split("<tr").find(x => x.includes(label)) || "");
check("[핵심] 계산 내역에 출처 칸 · 다섯 출처 문구", [h5.includes("<th>출처</th>"), ...["정산파일", "API", "ERP", "대표 확정", "수동 입력"].map(t => h5.includes(`<span class="cmv2-src">${t}</span>`))],
      [true, true, true, true, true, true]);
check("출처가 둘이면 출처별 금액(정산파일 −₩519,193 · API −₩5,601)", h5.includes("정산파일 −₩519,193 · API −₩5,601"), true);
check("[핵심] 확정 줄은 '확정'만 · 잠정 줄은 '잠정' + 이유 배지",
      [rowOf(h5, "대표 확정 0원").includes("잠정"), rowOf(h5, "대표 확정 0원").includes("확정"),
       rowOf(h5, "정산 밖 청구 미확인").includes('<span class="cmv2-prov">잠정</span>'), rowOf(h5, "정산 밖 청구 미확인").includes("청구 미확인(ACCRUED)"),
       rowOf(h5, "택배비 · C-01").includes('<span class="cmv2-prov">잠정</span>'), rowOf(h5, "택배비 · C-01").includes("금액 없음")],
      [false, true, true, true, true, true]);
check("옛 결과(출처 없음)는 출처 '—'", rowOf(h5, "옛 결과(출처 없음)").includes('<span class="cmv2-none">—</span>'), true);
const cmp5 = C.compare({ ...cur.MAIN, result: { ...r, mp_refunds: { supply: -2000 }, cm: r.cm - 2000 } }, prod);
check("운영 비교에 판매자배송 취소·반품 항목(반올림에 섞이지 않음)",
      [cmp5.items.find(x => x.label === "판매자배송 취소·반품(조회 자료)")?.amount, cmp5.items.some(x => x.label === "반올림")], [-2000, false]);
const h6 = D({ ...cur, MAIN: { ...cur.MAIN, result: { ...r, required_inputs: [{ key: "OWNER_ZERO_APPROVAL", kind: "APPROVAL",
    label: "8월 입고비 · 풀필먼트비 0원 확정 승인(대표 확인)", status: "PENDING_APPROVAL", impact_low: 0, impact_high: 0,
    impact_note: "DB 승인 대기 2행은 삭제하지 않음", how: "승인 권한자 로그인 → 기존 승인 대기 행을 정상 승인 절차로 0원 확정" }] } } }, prod, { month: "2026-08" });
check("8월 승인 대기 2행: '0원 확정 승인(대표 확인)' · 승인 대기 · 영향 0 · 삭제하지 않음",
      [h6.includes("0원 확정 승인(대표 확인)"), rowOf(h6, "0원 확정 승인").includes("승인 대기"), rowOf(h6, "0원 확정 승인").includes(">0<"), h6.includes("삭제하지 않음")],
      [true, true, true, true]);
console.log("[6] 화면 명칭(쿠팡 수익 현황과 같게) · 계산 시각 KST");
const r6 = { ...r, lines: [
    { code: "MONTHLY_WAREHOUSING", label: "로켓그로스 입고비 (월 공통, 상품 배분 없음)", amount: -781300, status: "CYCLE_OPEN", source: "정산파일" },
    { code: "MONTHLY_FULFILLMENT", label: "로켓그로스 풀필먼트비 (월 공통, 상품 배분 없음)", amount: -1174370, status: "CYCLE_OPEN", source: "정산파일" },
    { code: "INBOUND_FREIGHT", label: "입고 트럭 운송비(판매분 배부)", amount: -1000, status: "CONFIRMED", source: "ERP" },
    { code: "MP_SHIPPING_INCLUDED", label: "판매자배송 택배비·포장비 (상품원가에 포함 · 별도 0원)", amount: 0, status: "CONFIRMED", source: "대표 확정", orders: 4, qty: 5 }] };
const h6b = D({ ...cur, MAIN: { ...cur.MAIN, created_at: "2026-09-14T12:24:43.277288+00:00",
    reasons: [{ status: "NOTICE_MISSING", text: "입고비 · 풀필먼트비: 정산 원본 0원" }], result: r6 } }, prod, { month: "2026-09" });
check("[핵심] 입고비 → 입출고비 · 풀필먼트비 → 배송비 (입고 트럭 운송비는 그대로)",
      [h6b.includes("로켓그로스 입출고비 (월 공통"), h6b.includes("로켓그로스 배송비 (월 공통"), h6b.includes("풀필먼트비"), h6b.includes(">로켓그로스 입고비"),
       h6b.includes("입고 트럭 운송비")], [true, true, false, false, true]);
check("사유 배지 설명·차이 구성 이름도 같은 이름", [h6b.includes('title="입출고비 · 배송비: 정산 원본 0원"'), h6b.includes("로켓그로스 월 비용(입출고·배송·보관·세이버)")], [true, true]);
check("[핵심] 계산 시각 UTC 12:24 → 2026-09-14 21:24 KST", [h6b.includes("계산 2026-09-14 21:24 KST"), h6b.includes("계산 2026-09-14 12:24")], [true, false]);
check("[핵심] 쿠팡 '이익' = '상품원가 차감 전 쿠팡 정산 잔액'(공헌이익 아님)", [h6b.includes("상품원가 차감 전 쿠팡 정산 잔액"), h6b.includes("표시 이익")], [true, false]);
check("판매자배송 택배비·포장비: 상품원가에 포함 0원 · 대표 확정 · 확정", [h6b.includes("상품원가에 포함 · 별도 0원"), h6b.includes("4건 · 5개"),
      h6b.includes('<span class="cmv2-src">대표 확정</span>')], [true, true, true]);
console.log("[7] 취소·반품 원가환입(v2.7) - 자동 환입액 · 실제 회수 확인 수량 · 반품 손실 · 확인 대기(잠정)");
const rc7 = { confirmed: 181500, auto_rows: 21, auto_qty: 25, recovered_qty: 0, confirmed_rows: 0, loss: 0, check_pending_rows: 21, check_pending_qty: 25,
              check_pending_amount: 181500, check_needed: [], invalid: [], candidates: [] };
const r7 = { ...r, cost_recovery: rc7, lines: [{ code: "RECOVERY_CONFIRMED", label: "+ 취소·반품 원가환입(자동 · 환불 수량 × 원판매 원가)", amount: 181500,
             status: "RECOVERY_CANDIDATE", source: "정산파일 · ERP", orders: 21, qty: 25 }] };
const h7 = D({ ...cur, MAIN: { ...cur.MAIN, result: r7 } }, prod, { month: "2026-08" });
check("[핵심] 네 값 따로: 자동 원가환입액 ₩181,500(21건 · 25개) · 실제 회수 확인 0개 · 반품 손실 ₩0 · 확인 대기 25개(원가 ₩181,500)",
      [h7.includes("자동 원가환입액"), h7.includes("₩181,500 <small>21건 · 25개</small>"), h7.includes("실제 회수 확인 수량"), h7.includes("0개 <small>확인 완료 0건</small>"),
       h7.includes("반품 손실 <small>"), h7.includes("25개 <small>원가 ₩181,500 · 손실 우선 0원</small>")], [true, true, true, true, true, true]);
check("[핵심] 확인 전 금액은 잠정 · 원가환입 줄 상태 '잠정 회수·손실 확인 대기' · 최대 손실 안내",
      [h7.includes('<span class="cmv2-prov">잠정</span> 회수·손실 확인 전 금액이에요'), h7.includes("최대 −₩181,500"),
       (h7.split("<tr").find(x => x.includes("+ 취소·반품 원가환입(자동 · 환불")) || "").includes('<span class="cmv2-prov">잠정</span>')], [true, true, true]);
const h7c = D({ ...cur, MAIN: { ...cur.MAIN, result: { ...r7, cost_recovery: { ...rc7, recovered_qty: 22, confirmed_rows: 21, loss: 25500, check_pending_rows: 0,
             check_pending_qty: 0, check_pending_amount: 0 } } } }, prod, { month: "2026-08" });
check("확인 완료 뒤: 회수 22개 · 반품 손실 −₩25,500 · 잠정 안내 없음", [h7c.includes("22개 <small>확인 완료 21건</small>"), h7c.includes("−₩25,500"), h7c.includes("회수·손실 확인 전 금액이에요")],
      [true, true, false]);
const cmp7 = C.compare({ ...cur.MAIN, result: { ...r, cost_recovery: { ...rc7, loss: 25500 }, cm: r.cm + 181500 - 25500 } }, prod);
check("운영 비교: '취소·반품 원가환입(자동)' +181,500 · '반품 손실' −25,500 · 반올림 없음",
      [cmp7.items.find(x => x.label === "취소·반품 원가환입(자동)")?.amount, cmp7.items.find(x => x.label === "반품 손실")?.amount, cmp7.items.some(x => x.label === "반올림")],
      [181500, -25500, false]);
console.log("[8] 2026-09-15 정산자료 계산 = 주 결과 · 기존 운영 계산은 참고(접힌 비교 칸) · 조회 실패 표시");
const sbSw = (row, err) => ({ from: () => ({ select() { return this; }, eq() { return this; },
  maybeSingle: async () => (err ? { data: null, error: { message: "x" } } : { data: row, error: null }) }) });
check("스위치 상태: 행 없음 OFF · 읽기 실패 ERROR(꺼짐으로 보지 않음) · enabled:true ON · 'true' 문자 OFF",
      [await C.switchState(sbSw(null)), await C.switchState(sbSw(null, true)), await C.switchState(sbSw({ value: { enabled: true } })),
       await C.switchState(sbSw({ value: { enabled: "true" } }))], ["OFF", "ERROR", "ON", "OFF"]);
const rowsOf = rows => ({ from: () => ({ select() { return this; }, eq: async () => ({ data: rows, error: null }) }) });
const mk = (id, basis, cm, status = "SUCCEEDED", month = "2026-09") => ({ id, basis, cm, run_status: status, month, period_start: "2026-09-01", period_end: "2026-09-13" });
const pick = await C.loadCurrent(rowsOf([mk(3, "MAIN", -403423), mk(7, "MAIN", 205663), mk(9, "MAIN", 1, "FAILED"), mk(8, "COHORT", 250767), mk(4, "COHORT", -301319),
                                         mk(11, "MAIN", 2, "SUCCEEDED", "2026-08")]), "2026-09");
check("[핵심] 최신 결과 선택: month=2026-09 · MAIN · SUCCEEDED · id 가장 큰 7 (실패 행 9·다른 달 11 제외)", [pick.MAIN.id, pick.MAIN.cm, pick.COHORT.id], [7, 205663, 8]);
check("결과 조회 실패 → {error}(null 아님) · 결과 없음 → null",
      [(await C.loadCurrent({ from: () => ({ select() { return this; }, eq: async () => ({ data: null, error: { message: "boom" } }) }) }, "2026-09")).error,
       await C.loadCurrent(rowsOf([]), "2026-09")], ["boom", null]);
const r8 = { ...r, cm: 205663, cm_rate: 2.389536663678724, revenue: 8606815,
  cost_recovery: { confirmed: 600200, auto_rows: 70, auto_qty: 77, recovered_qty: 0, confirmed_rows: 0, loss: 0, check_pending_rows: 70, check_pending_qty: 77,
                   check_pending_amount: 600200, check_needed: [], invalid: [], candidates: [] },
  cost_summary_used: { file: "2026-09-01_2026-09-13__7cee2ca102b9.json", range: "2026-09-01~2026-09-13", sha256: "49d46d00" },
  lines: [{ code: "REVENUE_RG_GROSS", label: "로켓그로스 판매", amount: 10269977, status: "CONFIRMED", source: "정산파일" },
          { code: "AD_BILLED", label: "광고비", amount: -754829, status: "CONFIRMED", source: "정산파일" },
          { code: "FEE_ESTIMATED", label: "판매수수료 · 예상", amount: -4123, status: "ESTIMATED", source: "API" },
          { code: "COST_PRODUCT", label: "상품원가", amount: -5147771, status: "COST_UNCONFIRMED", source: "ERP" }] };
const reasons8 = [{ status: "ESTIMATED", text: "정산 행이 없어 예상 요율로 계산한 수수료 4,123원" }, { status: "VAT_UNCONFIRMED", text: "세이버/구독요금 VAT 기준 확인 전" },
  { status: "COST_UNCONFIRMED", text: "현재 상품 원가를 쓴 판매 4줄" }, { status: "ACCRUED", text: "정산 밖 광고비 38,722원" },
  { status: "CYCLE_OPEN", text: "월 중간(2026-09-13)까지만" }, { status: "RECOVERY_CANDIDATE", text: "취소·반품 70건 77개 회수·손실 확인 전" }];
const cur8 = { MAIN: { ...cur.MAIN, id: 7, run_status: "SUCCEEDED", calc_version: "cm_settlement_v2.7", period_end: "2026-09-13", cm: 205663, revenue: 8606815,
                       created_at: "2026-09-14T22:13:30.425779+00:00", reasons: reasons8, result: r8 }, COHORT: cur.COHORT };
const p8 = C.primaryHtml(cur8, { month: "2026-09", controls: '<button id="ctl">월</button>' });
check("[핵심] 주 결과 카드: ₩205,663 · 기간 2026-09-01~09-13 · 잠정 · 이익률 2.39% · 계산 2026-09-15 07:13 KST · 결과 #7 · v2.7",
      ["₩205,663", "2026-09-01~09-13", "잠정", "공헌이익률 2.39%", "계산 2026-09-15 07:13 KST", "결과 #7", "v2.7"].map(t => p8.includes(t)), [true, true, true, true, true, true, true]);
check("[핵심] 출처 표시(정산파일 · API · ERP · 쿠팡 차감 합계 파일)", [p8.includes("출처: 정산파일 · API · ERP"), p8.includes("2026-09-01_2026-09-13__7cee2ca102b9.json")], [true, true]);
check("[핵심] 자동 원가환입 ₩600,200(70건 · 77개) · 회수·손실 확인 대기 77개 · 반품 손실 ₩0",
      [p8.includes("자동 원가환입"), p8.includes("70건 · 77개"), p8.includes("회수·손실 확인 대기"), p8.includes(">77개<"), p8.includes("반품 손실")], [true, true, true, true, true]);
check("[핵심] 잠정 사유: 배지 + 사유 문장 6개 모두", reasons8.every(z => p8.includes(z.text)), true);
check("주 결과 카드 맨 위에 월 선택·버튼(controls) · 기존 운영 계산 문구 없음 · 주 금액 초록 강조 없음",
      [p8.includes('<button id="ctl">월</button>'), p8.includes("기존 운영 계산"), /stat-value[^"]*"[^>]*>₩205,663/.test(p8) && !/green/.test(p8.split("₩205,663")[0].slice(-80))], [true, false, true]);
const c8 = C.compareHtml(cur8, { ...prod, cmNet: 2805650 });
check("[핵심] 비교 칸: '기존 운영 계산(참고)' · 초록(cmv2-pos) 없음 · 차이 구성은 접힘(open 없음)",
      [c8.includes("기존 운영 계산(참고)"), c8.includes("cmv2-pos"), /<details class="cmv2-diff">/.test(c8), c8.includes("₩2,805,650"), c8.includes("−2,599,987")], [true, false, true, true, true]);
check("[핵심] 조회 실패 카드: '정산자료 계산 조회 실패' · 금액 없음 · 기존 계산은 참고라고 명시",
      [C.noticeHtml("ERROR", { month: "2026-09", error: "timeout" }).includes("정산자료 계산 조회 실패"), /₩/.test(C.noticeHtml("ERROR", { month: "2026-09" })),
       C.noticeHtml("ERROR", { month: "2026-09" }).includes("참고값으로만")], [true, false, true]);
const dm8 = C.dashboardMainHtml(cur8);
check("[핵심] 대시보드 주 결과 = 상세와 같은 값·기간·상태(₩205,663 · 2026-09-01~09-13 · 잠정 · 2.39%)",
      ["₩205,663", "2026-09-01~09-13", "잠정", "2.39%", "₩600,200"].map(t => dm8.includes(t)), [true, true, true, true, true]);
check("대시보드에서 내부 계산 메타데이터 숨김",
      [dm8.includes("결과 #7"), dm8.includes("출처 정산파일"), dm8.includes("7cee2ca102b9.json")], [false, false, false]);
check("대시보드 제목 설명", C.dashboardMeta(cur8), "정산자료 기준 · 2026-09-01~09-13 · 잠정 · 계산 2026-09-15 07:13 KST · 결과 #7");
// ErpDashboard.profitHtml - 정산자료 계산이 켜지면 잠정 계산 내역을 펼치고, 꺼지면 기존 화면 그대로
vm.runInContext(fs.readFileSync(new URL("./js/erp_dashboard.js", import.meta.url), "utf8"), ctx);
const Dsh = ctx.ErpDashboard;
const legacyModel = { month: "2026-09", t: { revenue: 11089565, cost: 5525171, fee: 1199919, logi: 427410, ship: 0, inFreight: 0 }, adTotal: 859517, cmNet: 3077548,
                      cmRate: 27.8, undet: false, lastAd: null, adRate: 7.8, adNotes: [], empty: false };
const fmtK = v => Math.round(Number(v || 0)).toLocaleString("ko-KR");
const off = Dsh.profitHtml(legacyModel, { fmt: fmtK, at: new Date("2026-09-15T07:15:00+09:00") });
const on = Dsh.profitHtml(legacyModel, { fmt: fmtK, at: new Date("2026-09-15T07:15:00+09:00"),
  settlement: { mode: "PRIMARY", mainHtml: dm8, breakdownHtml: '<details class="dash-provisional"><summary>9월 잠정 공헌이익 내역</summary><table><tr><td>월 공통비</td></tr></table></details>', meta: C.dashboardMeta(cur8) } });
check("대시보드 공헌이익 카드의 상단 내부 메타데이터 숨김",
      [on.includes("계산 2026-09-15 07:13 KST"), on.includes("결과 #7"), on.includes("갱신 09-15")], [false, false, false]);
check("대시보드 꺼짐: 기존 표 그대로(₩3,077,548 초록 · 비교 칸 없음)", [off.includes("dash-up"), off.includes("₩3,077,548"), off.includes("dash-legacy")], [true, true, false]);
check("[핵심] 대시보드 켜짐: 잠정 내역을 보여 주고 기존 계산은 표시하지 않음",
      [on.includes("₩205,663"), on.includes('<details class="dash-provisional">'), on.includes("월 공통비"), on.includes("₩3,077,548"), on.includes("기존 운영 계산(참고)")],
      [true, true, true, false, false]);
const onErr = Dsh.profitHtml(legacyModel, { fmt: fmtK, at: new Date(), settlement: { mode: "ERROR", mainHtml: C.dashboardNoticeHtml("ERROR", "timeout"), compareHtml: "", meta: "정산자료 계산 조회 실패", tone: "error" } });
check("[핵심] 대시보드 조회 실패: 실패 안내만 표시", [onErr.includes("정산자료 계산 조회 실패"), onErr.includes("₩3,077,548")], [true, false]);
check("대시보드 실패 안내에 존재하지 않는 아래 비교표를 안내하지 않음", onErr.includes("아래 기존 운영 계산"), false);
console.log(`\n${n - fail}/${n} 통과`);
process.exit(fail ? 1 : 0);
