// fixtures_cm_simple_ui.mjs
// 2026-09-30 공헌이익 단순 보기(승인 목업) 검증 - 네트워크·DB 0건, 실제 js/cm_simple.js 실행.
//   입력은 2026-09-29 23:49 운영 기여액 요약(실행 9a31d629)과 같은 숫자.
//   · 4칸·한 줄 흐름이 기존 잠정 공헌이익과 원 단위까지 같음(계산 방식 변경 없음) · 어긋나면 단순 보기를 그리지 않음
//   · 확인할 일 5건(할 일 4 · 자동 대기 1) 쉬운 이름·금액 영향·할 일
//   · 기술 표시(ACCRUED·VAT 미확인·정산파일/API·실행번호·버전)는 상세보기 안에서만
//   · 저장된 스냅샷은 '이전 계산 보기' 안 · 설정 메뉴 하나(월 선택·수동 광고비·고정비·광고비 새로고침)
import { readFileSync } from "fs";
import vm from "vm";

const file = p => readFileSync(new URL(p, import.meta.url).pathname, "utf8");
const fails = [];
const check = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { console.log(`        기대=${JSON.stringify(want)}\n        실제=${JSON.stringify(got)}`); fails.push(label); }
};
const text = html => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const ctx = { window: {}, console, Date, Object, Math, String, Number, JSON, Intl, isNaN, Set, Array, RegExp };
ctx.globalThis = ctx.window;
vm.createContext(ctx);
vm.runInContext(file("./js/erp_ui.js"), ctx);
vm.runInContext(file("./js/cm_simple.js"), ctx);
const C = ctx.window.CmSimple;

const L = (code, amount, status, source, label) => ({ code, amount, status, source, label });
const D = {
  month: "2026-09", period_start: "2026-09-01", period_end: "2026-09-28", latest_data_date: "2026-09-28",
  run_id: "9a31d629-b981-4649-aa71-e0c3ba715219", generated_at: "2026-09-29T23:49:36+09:00", inputs_hash: "abcdef0123456789ff",
  contrib_version: "cm_contribution_v1", calc_version: "cm_settlement_v2.7", subtotal_before_monthly: 5069091,
  lines: [L("REVENUE_RG_GROSS", 23328533, "CYCLE_OPEN", "정산파일", "로켓그로스 판매(공급가액)"),
          L("REVENUE_RG_COUPON", -1547579, "CYCLE_OPEN", "정산파일", "− 판매자 부담 쿠폰"),
          L("REVENUE_RG_CANCEL", -2790428, "CYCLE_OPEN", "정산파일", "− 환불(정산취소 전체, 한 번만)"),
          L("REVENUE_MP", 129974, "CONFIRMED", "ERP", "판매자배송 매출(공급가액)"),
          L("REVENUE_MP_REFUND", 0, "CONFIRMED", "API", "− 판매자배송 취소·반품"),
          L("COST_PRODUCT", -11673772, "COST_UNCONFIRMED", "ERP", "상품원가(판매 수량 × 판매일 원가)"),
          L("FEE_SETTLED", -2135226, "CONFIRMED", "정산파일", "판매수수료 · 정산 확정"),
          L("FEE_CYCLE_OPEN", -92135, "CYCLE_OPEN", "정산파일", "판매수수료 · 정산 진행 중"),
          L("FEE_ESTIMATED", -1285, "ESTIMATED", "API", "판매수수료 · 예상(정산 행 없음)"),
          L("AD_BILLED", -1598062, "CYCLE_OPEN", "정산파일", "광고비 · 로켓그로스 정산 청구액(VAT 제외)"),
          L("AD_OUTSIDE_BILLED", 0, "CONFIRMED", "ERP", "광고비 · 로켓그로스 정산 밖 실제 청구액"),
          L("AD_OUTSIDE_ACCRUED", -41429, "ACCRUED", "API", "광고비 · 로켓그로스 정산 밖 청구 미확인(ACCRUED)"),
          L("COST_RECOVERY", 1490500, "CONFIRMED", "ERP", "+ 반품 원가 환입(승인 근거)"),
          L("RETURN_LOSS", 0, "CONFIRMED", "ERP", "− 반품 손실(승인 근거)")],
  monthly_cost: { range: "2026-09-01~2026-09-28", available: true, total: 4603218, status: "OK",
                  items: [{ code: "WAREHOUSING", label: "입고비", amount: 1823640, vat_basis: "EXCLUDED" },
                          { code: "FULFILLMENT", label: "풀필먼트비", amount: 2679331, vat_basis: "EXCLUDED" },
                          { code: "STORAGE", label: "보관비", amount: 0, vat_basis: "EXCLUDED" },
                          { code: "SUBSCRIPTION", label: "세이버/구독요금", amount: 100247, vat_basis: "UNCONFIRMED" }] },
  provisional_cm: { is_confirmed: false, amount: -56117, monthly_cost: 4603218, inbound_freight: 521990, subtotal_before_monthly: 5069091,
                    period_start: "2026-09-01", period_end: "2026-09-28" },
  open_cycle_days: ["2026-09-28"],
  reasons: [{ status: "CYCLE_OPEN", label: "정산 진행 중", text: "2026-09-28 은 정산 주기가 끝나지 않아 수수료가 확정 전이에요" },
            { status: "COST_UNCONFIRMED", label: "원가 미확정", text: "원가를 전혀 못 찾은 판매 6줄 · 판매일 원가 이력이 없어 현재 상품 원가를 쓴 판매 2줄 - 이 달은 원가를 확정할 수 없어요" },
            { status: "ACCRUED", label: "청구 미확인(ACCRUED)", text: "로켓그로스 정산 밖 광고비 41,429원 청구 확인 전 - 미리 비용으로 잡아 둠" },
            { status: "ESTIMATED", label: "수수료 요율 미확인", text: "요율 이력이 없어 수수료를 넣지 못한 판매 2줄 - 0원으로 두지 않고 확인 대상" },
            { status: "RECOVERY_CANDIDATE", label: "회수·손실 확인 대기", text: "취소·반품 163건 회수·손실 확인 전 - 원가는 자동 환입, 손실은 우선 0원" },
            { status: "CYCLE_OPEN", label: "토스 정산 대기", text: "토스쇼핑 1건 구매확정 전 - 실제 수수료 정산 없음 - 합계 미포함(수수료 추정 안 함)" }],
  rows: { orders: 1388, cancels: 163, estimated: 1, mp: 8, no_cost: 6, cost_fallback: 2 },
  ads: { billed: 1598062, outside_billed: 0, outside_accrued: 41429, cm_amount: 1639491 },
  recovery: { confirmed: 1490500, loss: 0, check_pending_amount: 1490500, check_pending_rows: 163, check_needed_rows: 0 },
  toss: { pending: { rows: 1, revenue_sup: 8091 }, in_total: false },
  artifacts: "wing_downloads/cm_contribution_runs/2026-09-28__9a31d629",
};

console.log("\n[1] 4칸·한 줄 흐름 - 기존 계산과 원 단위 일치");
const m = C.model(D);
check("검산 통과", m.ok, true);
check("[핵심] 순매출·상품원가(환입 차감)·수수료·광고비·물류비·공통비·반품손실·공헌이익",
      [m.revenue, m.cost, m.fee, m.ad, m.logi, m.common, m.loss, m.cm], [19120500, 10183272, 2228646, 1639491, 521990, 4603218, 0, -56117]);
check("총비용 = 순매출 − 공헌이익", m.totalCost, 19176617);
check("흐름 칸 순서(토스·기타 없음)", m.terms.map(t => t[0]), ["순매출", "상품원가", "판매수수료", "광고비", "물류비", "공통비", "반품손실"]);
check("흐름 합 = 공헌이익(월 공통비 전 기여액 5,069,091 도 일치)", m.revenue - m.cost - m.fee - m.ad, 5069091);

console.log("\n[2] 확인할 일 - 쉬운 이름 · 금액 영향 · 할 일");
check("5건 · 할 일 4 · 자동 대기 1", [m.todos.map(t => t.key), m.mine, m.auto], [["AD_INVOICE", "SAVER_VAT", "RETURN", "COST", "WAIT"], 4, 1]);
check("금액 영향", m.todos.map(t => t.impact), ["0 ~ +₩41,429", "0 ~ +₩9,113", "−₩1,490,500 ~ 0", "금액 미정", "금액 미정"]);
check("이름", m.todos.map(t => t.title), ["광고비 청구서 확인", "세이버 VAT 확인", "반품 회수 확인", "원가 없는 판매 확인", "9월 정산 완료 대기"]);
check("자동 대기 내용", m.todos[4].sub, "9월 28일 정산 진행 중(수수료 92,135원) · 요율 없는 판매 2줄 · 토스 구매확정 전 1건");
check("원가 확인 내용", m.todos[3].sub, "원가가 없는 판매 6줄 · 현재 원가로 대신 계산한 판매 2줄");
check("모르는 사유도 빠뜨리지 않음", C.model({ ...D, reasons: [...D.reasons, { status: "X", label: "새 사유", text: "설명" }] }).todos.slice(-1)[0].title, "새 사유");

console.log("\n[3] 안전장치 - 어긋나면 단순 보기 안 그림");
check("잠정 공헌이익과 흐름이 다르면 ok=false", C.model({ ...D, provisional_cm: { ...D.provisional_cm, amount: -50000 } }).ok, false);
check("잠정 공헌이익 없음(월 공통비 없음) → ok=false", C.model({ ...D, provisional_cm: null }).ok, false);
const withToss = C.model({ ...D, lines: [...D.lines, L("TOSS_CONTRIBUTION", 3000, "ESTIMATED", "API", "토스쇼핑 기여")],
                          provisional_cm: { ...D.provisional_cm, amount: -53117 } });
check("토스 정산분이 생기면 '+ 토스쇼핑' 한 칸 · 검산 통과", [withToss.ok, withToss.terms.slice(-1)[0][0]], [true, "토스쇼핑"]);

console.log("\n[4] 화면 - 기본은 쉬운 말만, 기술 표시는 상세보기 안");
const top = C.topHtml(m, D, { settingsHtml: '<label class="cms-mi">월 선택 <input type="month" value="2026-09"></label><button class="cms-mi" onclick="openAdModal()">＋ 수동 광고비 입력</button><button class="cms-mi" onclick="openFixedModal()">고정비 설정</button>', updated: "09-29 23:49" });
const basic = top.replace(/<details class="cms-set">[\s\S]*?<\/details>/, "");
check("4칸 라벨", [...basic.matchAll(/stat-label">([^<]+)</g)].map(x => x[1]), ["잠정 공헌이익(본업)", "순매출", "총비용", "확인할 항목"]);
check("4칸 값", [...basic.matchAll(/stat-value[^"]*">([^<]+)</g)].map(x => x[1]), ["−₩56,117", "₩19,120,500", "₩19,176,617", "5건"]);
check("[핵심] 한 줄 흐름 문구", text(basic.match(/<div class="cms-flow"[\s\S]*?<\/div>/)[0]),
      "₩19,120,500 순매출 − ₩10,183,272 상품원가 − ₩2,228,646 판매수수료 − ₩1,639,491 광고비 − ₩521,990 물류비 − ₩4,603,218 공통비 − ₩0 반품손실 = −₩56,117 공헌이익");
check("[핵심] 기본 화면에 기술 표시 없음", ["ACCRUED", "VAT 미확인", "정산파일", "API", "실행", "cm_contribution", "해시", "9a31d629"].filter(w => text(basic).includes(w)), []);
check("기간·갱신 문구", text(basic.match(/<div class="cms-period">[\s\S]*?<\/div>/)[0]), "9월 1일 ~ 28일 자료 · 잠정(월 확정 전) · 갱신 09-29 23:49");
check("설정 메뉴 하나에 월 선택·수동 광고비·고정비", ["월 선택", "수동 광고비", "고정비 설정"].every(w => top.match(/<details class="cms-set">[\s\S]*?<\/details>/)[0].includes(w)), true);
const more = C.moreHtml(D, m, { adInfo: { days: [{ date: "2026-09-01", status: "OK", auto: { net: 99789 } }, { date: "2026-09-29", status: "UNDETERMINED" }], recon: { diff: -78, periodStart: "2026-09-01", periodEnd: "2026-09-28" } },
                         adCardHtml: '<div class="card" id="ad-card">광고비 카드</div>', freightCardHtml: '<div class="card" id="fr-card">운송비 카드</div>',
                         previousHtml: '<section id="cmv2">저장된 스냅샷 −₩100,995</section>', updatedAt: "2026-09-29 23:49 KST" });
check("상세보기·이전 계산 보기 기본 접힘", [/<details class="cms-more" id="cms-detail">/.test(more), /<details class="cms-more" id="cms-previous">/.test(more)], [true, true]);
check("상세보기 안 5개 소제목", [...more.matchAll(/<details class="cms-sub" open><summary>([^<]+)</g)].map(x => x[1].split(" ")[0]), ["계산표", "광고비", "반품·회수", "입고", "데이터"]);
check("기술 표시는 상세보기 안에(ACCRUED · VAT 미확인 · 실행번호 · 버전)", ["ACCRUED", "VAT 미확인", "9a31d629", "cm_settlement_v2.7"].every(w => more.includes(w)), true);
check("기존 광고비 카드·운송비 카드를 상세보기 안에 그대로", [more.includes('id="ad-card"'), more.includes('id="fr-card"')], [true, true]);
check("저장된 스냅샷은 '이전 계산 보기' 안", more.indexOf("저장된 스냅샷 −₩100,995") > more.indexOf('id="cms-previous"'), true);
check("계산표 합계 = 잠정 공헌이익(본업)", /= 잠정 공헌이익\(본업\)<\/td><td class="num">−₩56,117/.test(more), true);
check("기타 영업수익 없는 요약이면 줄도 없음(0원으로 만들지 않음)", basic.includes("cms-other-income"), false);
check("기타 영업수익·보상 포함 손익 줄(값 있을 때)", /재고 손실 보상 <b>\+₩140,415<\/b> → 보상 포함 손익 <b class="red">−₩142,553<\/b>/.test(
  C.otherIncomeHtml({ other_income: 140415, amount_with_other_income: -142553 })), true);
check("광고비 두 값(일별 합계는 기간 안 정상 수집만)", /WING 일별 합계 09-01~09-28\)<\/td><td class="num">₩99,789/.test(more), true);

console.log("\n[5] app.js 연결");
const app = file("./js/app.js"), idx = file("./index.html"), css = file("./css/style.css");
check("단순 보기 실패·다른 달이면 기존 화면(빈 문자열 반환)", [/d\.month !== erpMonth\) return ""/.test(app), /if \(!m\.ok\) \{[^}]*return ""; \}/.test(app)], [true, true]);
check("설정 메뉴에 기존 함수 그대로(openAdModal · openFixedModal · monthPicker · 광고비 새로고침)",
      ["openAdModal()", "openFixedModal()", "monthPicker()", "AdCosts.refreshButtonHtml"].every(w => app.slice(app.indexOf("function profitSimpleHtml")).includes(w)), true);
check("스크립트·스타일 등록", [idx.includes("js/cm_simple.js"), idx.indexOf("js/cm_simple.js") < idx.indexOf("js/app.js"), css.includes(".cms-flow")], [true, true, true]);
check("새 탭·메뉴 없음", /data-route="cm/.test(idx), false);

console.log();
if (fails.length) { console.log(`실패 ${fails.length}건: ${fails.join(", ")}`); process.exit(1); }
console.log("전부 통과");
