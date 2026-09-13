// fixtures_procurement_input_ui.mjs
// ------------------------------------------------
// 2026-09-12 [사용자 확정 정책] 발주·물류 정보 입력 화면(js/procurement_input.js) 검증 - 네트워크 0건, DB 는 가짜.
//   1) 입력 대상: 활성 MISSING_PROCUREMENT_DATA 중 단품·부모만(세트는 부모로 올림, 부모가 이미 입력됐으면 올리지 않음)
//   2) 정수 검사: 빈칸·0·음수·1.5·문자 거부, "1,000"·"24" 허용(반올림 안 함), BOX→BOX 입수·PLT→PLT 입수 필수
//   3) VAT 기준: 기본 선택 없음 · 고르기 전엔 저장 불가 · 확인 뒤 원가가 바뀌면 다시 골라야 함
//   4) 참고값은 회색 제안만(입력칸·저장값에 자동으로 안 들어감) · [넣기]를 눌러야 입력칸에 들어감
//   5) 저장: 변경 확인 창 → rpc fn_save_product_procurement 만(테이블 직접 쓰기 0건), 원가는 payload 에 없음, updated_at 문자열 그대로
//   6) 승인 권한자가 아니면 입력칸 잠김·저장 호출 0건 · 오류 문구 해석 · 세트 원가 미리보기(부모 × 구성수량)
//   7) app.js 라우트·메뉴·index.html 스크립트 연결
//   8) 2026-09-13 부분 저장(VAT 만 필수, 물류정보 입력 필요 표시·탭) · [편집]·[저장]·[취소] · 재입고 제외·SKU 사용 보류 관리(rpc 만, 사유 필수, 중복 클릭·실패 시 서버 재조회, 보기 전용 잠김)
import { readFileSync } from "fs";
import vm from "vm";

const read = f => readFileSync(new URL(f, import.meta.url), "utf8");
let fails = 0;
const check = (got, want, label) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "OK " : "FAIL"} ${label}${ok ? "" : ` (실제=${JSON.stringify(got)}, 기대=${JSON.stringify(want)})`}`);
  if (!ok) fails++;
};

// 아주 작은 가짜 DOM - getElementById / querySelector 만 쓰는 화면이라 id 로 찾는 요소를 흉내
function makeDoc() {
  const els = new Map();
  const el = id => {
    if (!els.has(id)) els.set(id, { id, innerHTML: "", outerHTML: "", textContent: "", value: "", disabled: false,
      classList: { toggle() {} } });
    return els.get(id);
  };
  return { getElementById: el, els };
}

const P = (id, code, cost, extra = {}) => ({ id, code, name: code, cost_price: cost, tax_type: "과세", is_set: false, set_parent_id: null, set_qty: null, box_qty: null, ...extra });
const products = [
  P("spray", "1M1A-009-01", 6300), P("dh12", "1G1A-003-01", 5500, { box_qty: 40 }), P("agad1", "1K1A-018-01", 6500),
  P("dh24", "1G1A-003-01-S2", null, { is_set: true, set_parent_id: "dh12", set_qty: 2 }),
  P("agad2", "1K1A-018-01-S2", null, { is_set: true, set_parent_id: "agad1", set_qty: 2 }),
  P("agad3", "1K1A-018-01-S3", null, { is_set: true, set_parent_id: "agad1", set_qty: 3 }),
  P("mat", "1M1N-001-01", 8500),
];
const reco = [
  { vendor_item_id: "95940933431", product_id: "spray", status: "MISSING_PROCUREMENT_DATA", is_active: true, lead_time_days: 7, product_name: "스프레이건" },
  { vendor_item_id: "95928560701", product_id: "dh12", status: "MISSING_PROCUREMENT_DATA", is_active: true, lead_time_days: 7, product_name: "제습제 12" },
  { vendor_item_id: "95928560705", product_id: "dh24", status: "MISSING_PROCUREMENT_DATA", is_active: true, product_name: "제습제 24" },
  { vendor_item_id: "95928260692", product_id: "agad2", status: "MISSING_PROCUREMENT_DATA", is_active: true, product_name: "아가드 2" },
  { vendor_item_id: "95928260691", product_id: "agad3", status: "MISSING_PROCUREMENT_DATA", is_active: true, product_name: "아가드 3" },
  { vendor_item_id: "95928260688", product_id: "agad1", status: "STOCK_SUFFICIENT", is_active: true, product_name: "아가드 1" },
  { vendor_item_id: "95936822308", product_id: "mat", status: "STOCK_SUFFICIENT", is_active: true, product_name: "발판" },
  { vendor_item_id: "old", product_id: "mat", status: "MISSING_PROCUREMENT_DATA", is_active: false },
  { vendor_item_id: "95936822310", product_id: null, status: "UNMAPPED", is_active: true, product_name: "모노플랫 논슬립 EPP 욕실 다용도실 발판", option_name: "크림화이트 2개 70x48cm" },
];
const procurements = [
  { product_id: "agad1", supplier_name: "리파코 주식회사", orderable_unit: "BOX", units_per_box: 20, units_per_plt: 400, min_order_quantity: null, lead_time_days: 7, cost_vat_basis: null, updated_at: "2026-09-10T01:02:03.123456+00:00" },
  { product_id: "mat", supplier_name: "리파코 주식회사", orderable_unit: "PLT", units_per_box: null, units_per_plt: 80, min_order_quantity: 80, lead_time_days: 7, cost_vat_basis: "VAT_EXCLUDED", updated_at: "2026-09-11T05:06:07.654321+00:00" },
];
const poItems = [
  { product_id: "spray", qty: 60, unit_cost: 6300, purchase_orders: { po_no: "리버스-발주-2026-005", supplier: "리파코 주식회사", status: "done", date: "2026-08-20" } },
  { product_id: "spray", qty: 10, unit_cost: 6000, purchase_orders: { po_no: "리버스-발주-2026-099", supplier: "취소된 거래처", status: "canceled", date: "2026-09-01" } },
];
const audits = [{ id: 9, product_id: "mat", action: "UPDATE", cost_price_seen: 8000, cost_vat_basis: "VAT_EXCLUDED", actor_name: "팀장", created_at: "2026-09-11T05:06:07Z", changed_fields: ["min_order_quantity"] }];

const calls = [];
const exclusions = [
  { vendor_item_id: "95936822310", kind: "RESTOCK_EXCLUDED", product_id: null, active: true, reason: "크림화이트 재입고 안 함",
    excluded_by_name: "팀장", excluded_at: "2026-09-13T02:00:00+00:00", updated_at: "2026-09-13T02:00:00+00:00" },
  { vendor_item_id: "96020412319", kind: "CANDIDATE_EXCLUDED", product_id: "mat", active: true, reason: "중복 리스팅 - 바코드 확인 전 보류",
    excluded_by_name: "팀장", excluded_at: "2026-09-13T02:00:00+00:00", updated_at: "2026-09-13T02:00:00+00:00" },
  { vendor_item_id: "11111111", kind: "RESTOCK_EXCLUDED", product_id: null, active: false, reason: "옛 제외", released_by_name: "팀장",
    released_at: "2026-09-12T02:00:00+00:00", release_reason: "다시 판매", updated_at: "2026-09-12T02:00:00+00:00" },
];
const exclusionEvents = [{ id: 2, vendor_item_id: "95936822310", kind: "RESTOCK_EXCLUDED", action: "EXCLUDE", reason: "크림화이트 재입고 안 함",
                           actor_name: "팀장", created_at: "2026-09-13T02:00:00+00:00" }];
const mappings = [{ product_id: "dh12", external_id: "95928560701", channel: "rocket_growth" },
                  { product_id: "mat", external_id: "96020412319", channel: "rocket_growth" }];
const FAKE = { exclusionFail: false, rpcError: null, rpcDelay: 0, loads: 0 };
function fakeSb() {
  const tables = { products, product_procurement: procurements, purchase_recommendations: reco, suppliers: [{ name: "리파코 주식회사", active: true }],
                   purchase_order_items: poItems, product_procurement_audit: audits, procurement_sync_state: [],
                   vendor_item_exclusions: exclusions, vendor_item_exclusion_events: exclusionEvents, product_channel_mapping: mappings };
  const builder = t => {
    const b = { _in: null, _eq: null, select() { return b; }, order() { return b; }, limit() { return b; },
      in(c, v) { b._in = [c, v]; return b; }, eq(c, v) { b._eq = [c, v]; return b; },
      insert() { calls.push(["insert", t]); return b; }, update() { calls.push(["update", t]); return b; }, upsert() { calls.push(["upsert", t]); return b; },
      then(res, rej) {
        if (FAKE.exclusionFail && t === "vendor_item_exclusions") return Promise.resolve({ data: null, error: { message: "relation does not exist" } }).then(res, rej);
        let rows = tables[t] || []; if (b._in) rows = rows.filter(r => b._in[1].includes(r[b._in[0]]));
        if (b._eq) rows = rows.filter(r => r[b._eq[0]] === b._eq[1]);
        return Promise.resolve({ data: JSON.parse(JSON.stringify(rows)), error: null }).then(res, rej); } };
    return b;
  };
  return {
    from: builder,
    rpc: async (fn, args) => {
      calls.push(["rpc", fn, JSON.parse(JSON.stringify(args))]);
      if (FAKE.rpcDelay) await new Promise(r => setTimeout(r, FAKE.rpcDelay));
      if (FAKE.rpcError && fn !== "fn_save_product_procurement") return { data: null, error: { message: FAKE.rpcError } };
      if (fn === "fn_release_vendor_item_exclusion" && FAKE.alreadyReleased) return { data: { status: "ALREADY_RELEASED" }, error: null };
      if (args.p_product_id === "dh12") return { data: null, error: { message: "NOT_INTEGER:min_order_quantity 소수는 입력할 수 없어요(1.5)" } };
      if (fn !== "fn_save_product_procurement") return { data: { status: fn === "fn_set_vendor_item_exclusion" ? "EXCLUDED" : "RELEASED" }, error: null };
      return { data: { status: "SAVED", logistics_missing: PI.logisticsMissing(args.p_values) }, error: null };
    },
  };
}

const doc = makeDoc();
const ctx = vm.createContext({ console, Map, Set, JSON, Number, String, Date, Math, Promise, Object, Array, RegExp, URLSearchParams,
  document: doc, confirm: () => true, toast: () => {}, alert: () => {} });
vm.runInContext(read("./js/erp_ui.js"), ctx);   // 2026-09-13 ERP UI 정리: 공통 배지·요약·버튼 흐름
vm.runInContext(read("./js/procurement_input.js"), ctx);
const PI = ctx.ProcurementInput;

console.log("=== 1. 입력 대상 ===");
const bt = PI.buildTargets({ products, procurements, recoRows: reco });
check(bt.targets.map(v => v.product.code), ["1G1A-003-01", "1M1A-009-01"], "[핵심] 단품(스프레이) + 세트 부모(제습제 12) - 세트 자체는 대상 아님");
check(bt.setChildren.map(c => [c.product.code, c.parent && c.parent.code, c.set_qty]),
      [["1G1A-003-01-S2", "1G1A-003-01", 2], ["1K1A-018-01-S2", "1K1A-018-01", 2], ["1K1A-018-01-S3", "1K1A-018-01", 3]], "세트 3개와 부모·구성수량");
check(bt.targets.some(v => v.product.id === "agad1"), false, "부모(아가드 1개)가 이미 입력돼 있으면 입력 대상으로 올리지 않음");
check(bt.entered.map(v => v.product.code), ["1K1A-018-01", "1M1N-001-01"], "입력됨 탭 - 세트 제외");
check(bt.targets.find(v => v.product.id === "spray").skus, ["95940933431"], "비활성 추천 행의 SKU 는 쓰지 않음");

console.log("\n=== 2. 정수 검사 ===");
const pv = raw => PI.parseIntField(raw, true);
check([pv("").error, pv("0").error, pv("-3").error, pv("1.5").error, pv("abc").error, pv("24").value, pv("1,000").value, pv(" 7 ").value, pv("1.0").value],
      ["필수 항목이에요", "0보다 커야 해요", "0보다 커야 해요", "소수는 입력할 수 없어요", "숫자로 입력해 주세요", 24, 1000, 7, 1],
      "[핵심] 빈칸·0·음수·1.5·문자 거부 / '24'·'1,000'·' 7 ' 허용 / 1.0 은 1(반올림 없음)");
check(PI.parseIntField("", false), { value: null, error: null }, "선택 항목 빈칸은 통과");
check(PI.parseIntField("2000000", true).error, "값이 너무 커요", "지나치게 큰 값 거부");
const base = { supplier_name: "리파코 주식회사", orderable_unit: "UNIT", min_order_quantity: "60", units_per_box: "", units_per_plt: "", lead_time_days: "10", cost_vat_basis: "VAT_EXCLUDED" };
const spray = products[0];
check(PI.validateRow(base, spray).ok, true, "UNIT 발주는 BOX·PLT 입수 없이 저장 가능");
check(Object.keys(PI.validateRow({ ...base, orderable_unit: "BOX" }, spray).errors), ["units_per_box"], "BOX 발주면 BOX 입수 필수");
check(Object.keys(PI.validateRow({ ...base, orderable_unit: "PLT" }, spray).errors), ["units_per_plt"], "PLT 발주면 PLT 입수 필수");
// 2026-09-13 부분 저장 - 공급처·발주단위는 비워도 저장 가능(물류정보 입력 필요), 넣은 값(리드타임 0)은 거부
const partial = PI.validateRow({ ...base, supplier_name: "  ", orderable_unit: "", lead_time_days: "0" }, spray);
check([Object.keys(partial.errors).sort(), partial.missing, partial.complete],
      [["lead_time_days"], ["supplier_name", "orderable_unit"], false], "공급처 공백·발주단위 없음은 '물류정보 입력 필요', 리드타임 0 은 거부");
check(PI.validateRow({ ...base, units_per_box: "40", units_per_plt: "500" }, spray).warnings.length, 1, "PLT 입수가 BOX 입수의 배수가 아니면 경고(저장은 막지 않음)");
check(PI.validateRow(base, products[3]).ok, false, "세트 상품은 화면에서도 저장 불가");
check(PI.validateRow(base, { ...spray, cost_price: null }).errors.cost_price, "제품 마스터에 매입원가를 먼저 입력해 주세요", "원가 없음 → 저장 불가");

console.log("\n=== 3. VAT 기준 ===");
check(PI.validateRow({ ...base, cost_vat_basis: "" }, spray).errors.cost_vat_basis, "VAT 기준을 골라 주세요", "[핵심] VAT 미선택 → 저장 불가");
check(PI.formFromRow(null, spray, null).cost_vat_basis, "", "[핵심] 새 입력은 VAT 기본 선택 없음");
check(PI.formFromRow(procurements[1], products[6], 8000).cost_vat_basis, "", "[핵심] 확인 뒤 원가가 8,000 → 8,500 으로 바뀜 → 다시 골라야 함");
check(PI.formFromRow(procurements[1], products[6], 8500).cost_vat_basis, "VAT_EXCLUDED", "확인 때 원가 = 지금 원가면 저장된 기준 유지");
check(PI.formFromRow(procurements[0], products[2], 6500).cost_vat_basis, "", "기존 행(VAT 미확인)은 선택 없음");

console.log("\n=== 4·5·6. 화면 흐름(가짜 DB) ===");
const html = await PI.view(fakeSb(), { id: "u1", name: "팀장", approver: true });
check(html.includes("입력 필요 2") && html.includes("입력됨 2"), true, "탭 숫자");
check(/id="pi-spray-supplier_name" class="pi-in"\s+value=""/.test(html) && /id="pi-spray-supplier_name"[^>]*value="리파코/.test(html) === false, true, "[핵심] 제안 공급처가 입력칸에 자동으로 들어가지 않음");
check(html.includes("제안 리파코 주식회사 (PO-005)") && !html.includes("취소된 거래처"), true, "회색 제안: 최근 유효 발주 공급처(취소 발주 제외)");
check(html.includes("제안 40 (제품 마스터)"), true, "회색 제안: 제품 마스터 박스 입수");
check(html.includes("5,500원 × 2 = <b>11,000원</b>") && html.includes("6,500원 × 3 = <b>19,500원</b>"), true, "[핵심] 세트 원가 미리보기 = 부모 원가 × 구성수량(저장 안 함)");
check(PI.setPreview(products[3], products[1], null), { cost: 11000, supply: null, supply_exact: null, inherited: false, supplier_name: null, lead_time_days: null }, "세트 미리보기 함수");
check(PI.setPreview(products[3], products[1], { cost_vat_basis: "VAT_INCLUDED", supplier_name: "리파코", lead_time_days: 7 }).supply, 10000, "[핵심] 세트 공급가액 = 부모(5,500÷1.1=5,000) × 2");
check([PI.supplyPreview(5500, "VAT_INCLUDED"), PI.supplyPreview(6500, "VAT_INCLUDED"), PI.supplyPreview(6500, "VAT_EXCLUDED"), PI.supplyPreview(6500, "")],
      [{ exact: true, value: 5000 }, { exact: false, value: null }, { exact: true, value: 6500 }, null], "[핵심] 공급가액 미리보기: ÷1.1 나누어떨어질 때만 값(정수 연산)");
// 2026-09-13 [편집]을 눌러야 입력칸이 열림
check([html.includes('onclick="ProcurementInput.edit()">편집</button>'), /id="pi-spray-supplier_name"[^>]*disabled/.test(html), html.includes(">넣기<")],
      [true, true, false], "[핵심] 처음엔 보기 상태 - [편집] 버튼만, 입력칸 잠김·[넣기] 없음");
PI.onInput("spray", "supplier_name", "몰래 입력");
check(ctx.ProcurementInput._state.forms.spray.supplier_name, "", "[편집] 전에는 입력이 반영되지 않음");
PI.edit();
const edHtml = PI.render();
check([edHtml.includes("편집 중"), edHtml.includes('onclick="ProcurementInput.cancel()"'), edHtml.includes('onclick="ProcurementInput.review()" disabled>저장</button>'),
       /id="pi-spray-supplier_name"[^>]*disabled/.test(edHtml)], [true, true, true, false], "[편집] 뒤: 입력칸 열림 · [취소]·[저장] · 바뀐 게 없으면 [저장] 잠김");
PI.fill("spray", "supplier_name");
check(ctx.ProcurementInput._state.forms.spray.supplier_name, "리파코 주식회사", "[넣기]를 눌렀을 때만 입력칸에 들어감");
for (const [f, v] of Object.entries({ orderable_unit: "UNIT", min_order_quantity: "60", lead_time_days: "10" })) PI.onInput("spray", f, v);
PI.review();
check(doc.getElementById("modal-root").innerHTML.includes("VAT 기준"), false, "VAT 미선택이면 확인 창을 열지 않음");
PI.onInput("spray", "cost_vat_basis", "VAT_INCLUDED");
for (const [f, v] of Object.entries({ supplier_name: "리파코 주식회사", orderable_unit: "BOX", min_order_quantity: "1.5", units_per_box: "40", lead_time_days: "7", cost_vat_basis: "VAT_EXCLUDED" }))
  PI.onInput("dh12", f, v);
const foot = PI.render();
check(foot.includes("바뀐 2개 중 1개에 고칠 칸이 있어요"), true, "[핵심] 고칠 칸이 남으면 저장 버튼 잠김");
PI.onInput("dh12", "min_order_quantity", "40");
PI.review();
const modal = doc.getElementById("modal-root").innerHTML;
check(modal.includes("변경 내용 확인 · 2개 상품") && modal.includes("매입원가 <b>6,300원</b> = <b>VAT 포함 금액</b>"), true, "[핵심] 저장 전 변경 확인 창 - 원가와 고른 VAT 기준을 함께 보여줌");
check(modal.includes("— → <b>60</b>"), true, "바뀐 칸 전/후 표시");
check(modal.includes("6,300원 ÷ 1.1 이 나누어떨어지지 않아요") && modal.includes("BigQuery·공헌이익 공급가액 <b>5,500원</b>"), true,
      "[핵심] 확인 창에 공급가액(VAT 별도 5,500) · VAT 포함 6,300 은 멈춤 경고");
check(calls.filter(c => c[0] === "rpc").length, 0, "확인 창만으로는 저장 호출 없음");
// dh12 는 가짜 DB 가 오류를 돌려주도록 해 둠 - 화면이 오류를 그대로 보여주는지
PI.onInput("dh12", "min_order_quantity", "40");
await PI.saveAll();
const rpcs = calls.filter(c => c[0] === "rpc");
check(rpcs.map(c => c[1]), ["fn_save_product_procurement", "fn_save_product_procurement"], "[핵심] 저장은 rpc fn_save_product_procurement 만");
check(calls.filter(c => c[0] !== "rpc").length, 0, "[핵심] 테이블 직접 insert/update/upsert 0건");
const sp = rpcs.find(c => c[2].p_product_id === "spray")[2];
check(sp, { p_product_id: "spray", p_values: { supplier_name: "리파코 주식회사", orderable_unit: "UNIT", min_order_quantity: 60, units_per_box: null,
            units_per_plt: null, lead_time_days: 10, cost_vat_basis: "VAT_INCLUDED" }, p_cost_price_seen: 6300, p_expected_updated_at: null },
      "[핵심] payload: 정수는 숫자, 원가는 값에 없음(확인용 p_cost_price_seen 만), 새 행은 기준시각 없음");
check(JSON.stringify(sp.p_values).includes("cost_price"), false, "원가를 product_procurement 값으로 보내지 않음");
check(JSON.stringify(sp).includes("freight"), false, "운송비 요율은 보내지 않음");
const res = doc.getElementById("modal-root").innerHTML;
check(res.includes("1개 저장 · 1개 실패") && res.includes("소수는 입력할 수 없어요(1.5)") && res.includes("NOT_INTEGER:min_order_quantity"), true, "DB 오류를 상품별로 그대로 보여줌");

calls.length = 0;
await PI.view(fakeSb(), { id: "u1", name: "팀장", approver: true });
PI.edit();
PI.onInput("mat", "cost_vat_basis", "VAT_EXCLUDED");
PI.onInput("mat", "lead_time_days", "9");
PI.review(); await PI.saveAll();
check(calls.find(c => c[0] === "rpc")[2].p_expected_updated_at, "2026-09-11T05:06:07.654321+00:00", "[핵심] 기존 행은 updated_at 문자열 그대로(마이크로초 유지)");

console.log("\n=== 5-2. [취소] · 저장 실패 시 서버 재조회 ===");
await PI.view(fakeSb(), { id: "u1", name: "팀장", approver: true });
PI.edit(); PI.onInput("spray", "supplier_name", "임시 공급처");
PI.cancel();
check([ctx.ProcurementInput._state.editing, ctx.ProcurementInput._state.forms.spray.supplier_name], [false, ""], "[취소] → 입력값 버리고 보기 상태로(저장 호출 없음)");
calls.length = 0;
PI.edit();
for (const [f, v] of Object.entries({ cost_vat_basis: "VAT_EXCLUDED" })) PI.onInput("spray", f, v);
for (const [f, v] of Object.entries({ supplier_name: "리파코 주식회사", orderable_unit: "BOX", min_order_quantity: "40", units_per_box: "40", lead_time_days: "7", cost_vat_basis: "VAT_EXCLUDED" }))
  PI.onInput("dh12", f, v);
PI.review();
await Promise.all([PI.saveAll(), PI.saveAll()]);
check(calls.filter(c => c[0] === "rpc").length, 2, "[핵심] [저장]을 두 번 눌러도 상품당 1번만 호출(중복 감사 이력 없음)");
check([ctx.ProcurementInput._state.editing, ctx.ProcurementInput._state.forms.dh12.min_order_quantity, ctx.ProcurementInput._state.forms.spray.cost_vat_basis],
      [true, "40", ""], "[핵심] 실패한 상품(dh12)은 입력값 유지·편집 상태 유지, 저장된 상품은 서버에서 다시 읽은 값");

console.log("\n=== 6. 보기 전용 ===");
calls.length = 0;
const vhtml = await PI.view(fakeSb(), { id: "u2", name: "사원", approver: false });
check(vhtml.includes("보기 전용 - 승인 권한자만 수정할 수 있어요") && vhtml.includes('aria-label="공급처" disabled') === false && /disabled\s+oninput/.test(vhtml), true, "승인 권한자가 아니면 안내 + 입력칸 잠김");
check(vhtml.includes(">넣기<"), false, "보기 전용에는 [넣기] 없음");
PI.onInput("spray", "cost_vat_basis", "VAT_EXCLUDED"); PI.review(); await PI.saveAll();
check(calls.filter(c => c[0] === "rpc").length, 0, "[핵심] 보기 전용은 저장 호출 0건");
check([PI.errorMessage({ message: "NOT_APPROVER 승인 권한자만 발주·물류 정보를 저장할 수 있어요" }).code, PI.errorMessage({ message: "permission denied for table product_procurement" }).code],
      ["NOT_APPROVER", "PERMISSION"], "오류 코드 해석");

console.log("\n=== 7. 앱 연결 ===");
const app = read("./js/app.js"), index = read("./index.html");
check(/procurement: \{ title: "발주·물류 정보", render: viewProcurementInput \}/.test(app) && /async function viewProcurementInput\(\) \{\n  return ProcurementInput\.view\(sb, me\);/.test(app), true, "라우트 #/procurement");
check(index.includes('href="#/procurement" data-route="procurement"') && /<script src="js\/procurement_input\.js\?v=\d+"><\/script>/.test(index)
      && index.indexOf("procurement_input.js") < index.indexOf("js/app.js"), true, "메뉴·스크립트(app.js 보다 먼저)");
check(/product_procurement"\)\.(insert|update|upsert)/.test(read("./js/procurement_input.js") + app), false, "화면 코드 어디에도 product_procurement 직접 쓰기 없음");

console.log("\n=== 8. 부분 저장 · 재입고·동기화 제외(2026-09-13) ===");
const vo = PI.validateRow({ supplier_name: "", orderable_unit: "", min_order_quantity: "", units_per_box: "", units_per_plt: "", lead_time_days: "",
                            cost_vat_basis: "VAT_EXCLUDED" }, spray);
check([vo.ok, vo.complete, vo.missing, vo.payload.supplier_name, vo.payload.orderable_unit, vo.payload.min_order_quantity],
      [true, false, ["supplier_name", "orderable_unit", "min_order_quantity", "lead_time_days"], null, null, null],
      "[핵심] 원가 VAT 기준만으로 저장 가능 · 빠진 물류 칸 4개를 알려줌 · 빈 칸은 null 로 보냄");
check(Object.keys(PI.validateRow({ ...vo.payload, orderable_unit: "PLT", units_per_plt: "", cost_vat_basis: "VAT_EXCLUDED" }, spray).errors), ["units_per_plt"],
      "발주단위를 PLT 로 고르면 PLT 입수는 여전히 필수");
check([PI.logisticsMissing(procurements[0]), PI.logisticsMissing(procurements[1]), PI.logisticsMissing(null).length],
      [["min_order_quantity"], [], 4], "저장된 행의 빈 물류 칸(아가드 1개: 최소발주 없음)");
check(bt.incomplete.map(v => v.product.code), ["1K1A-018-01"], "[핵심] '물류정보 입력 필요' 탭 대상 = 저장됐지만 물류 칸이 빈 상품");
calls.length = 0;
const h8 = await PI.view(fakeSb(), { id: "u1", name: "팀장", approver: true });
PI.edit();
check(h8.includes("물류정보 입력 필요 1") && h8.includes("나중에 입력 가능"), true, "탭 숫자 · 물류 칸은 '나중에 입력 가능' 표시");
PI.tab("logistics");
const lh = PI.render();
check(lh.includes("1K1A-018-01") && lh.includes("최소발주 없음 - 채울 때까지 BigQuery 반영·추천 발주수량·자동 발주·WING 입고 초안이 막혀요"), true,
      "[핵심] 물류정보 입력 필요 탭: 빠진 칸과 막히는 것을 함께 안내");
PI.tab("targets");
PI.onInput("spray", "cost_vat_basis", "VAT_EXCLUDED");
PI.review();
const m8 = doc.getElementById("modal-root").innerHTML;
check(m8.includes("변경 내용 확인 · 1개 상품") && m8.includes("물류정보 입력 필요 - 공급처·발주단위·최소발주·리드타임 없음"), true,
      "[핵심] VAT 만 고르고 저장 → 확인 창에 물류정보 입력 필요 경고");
await PI.saveAll();
const r8 = calls.filter(c => c[0] === "rpc");
check([r8.length, r8[0][2].p_values.supplier_name, r8[0][2].p_values.min_order_quantity, r8[0][2].p_values.cost_vat_basis],
      [1, null, null, "VAT_EXCLUDED"], "[핵심] 부분 저장도 rpc fn_save_product_procurement 하나로");
check(doc.getElementById("modal-root").innerHTML.includes("저장됨") && doc.getElementById("modal-root").innerHTML.includes("물류정보 입력 필요"), true,
      "저장 결과에 물류정보 입력 필요 표시");

check(h8.includes("재입고 제외·SKU 사용 보류") && h8.includes("95936822310") && h8.includes("크림화이트 2개 70x48cm") && h8.includes("ERP 상품 연결 없음(쿠팡 SKU 만)")
      && h8.includes("96020412319") && h8.includes('<code class="pi-code">1M1N-001-01</code>') && h8.includes(">SKU 사용 보류</span>"), true,
      "[핵심] 제외 목록: 크림화이트(ERP 매핑 없이도 쿠팡 상품명·옵션 표시)·추가 SKU(SKU 사용 보류, 연결 상품 표시)");
check([h8.includes("ProcurementInput.refreshExclusions()"), (h8.match(/>제외 사유 보기</g) || []).length >= 2, (h8.match(/>변경 이력</g) || []).length >= 2,
       h8.includes(">재입고 제외 해제<"), h8.includes(">SKU 사용 보류 해제<")], [true, true, true, true, true], "버튼: 새로고침·제외 사유 보기·변경 이력·재입고 제외 해제·SKU 사용 보류 해제");
PI.exclusionDetail("95936822310", "RESTOCK_EXCLUDED");
const det = doc.getElementById("modal-root").innerHTML;
check(["크림화이트 2개 70x48cm", "ERP 상품 연결 없음", "크림화이트 재입고 안 함", "팀장", "UNMAPPED", "등록</b>"].every(t => det.includes(t)), true,
      "[핵심] 크림화이트 SKU 상세: 쿠팡 상품·ERP 연결 없음·제외 사유·등록자·변경 이력");
check(h8.includes("해제된 제외 1건") && h8.includes("다시 판매"), true, "해제된 제외는 사유와 함께 따로");
check((h8.match(/ProcurementInput\.releaseExclusion/g) || []).length, 2, "승인 권한자에게만 [해제] 버튼(활성 2건)");
calls.length = 0;
doc.getElementById("pi-ex-vid").value = "abc"; doc.getElementById("pi-ex-kind").value = "RESTOCK_EXCLUDED"; doc.getElementById("pi-ex-reason").value = "단종";
PI.addExclusion();
check(doc.getElementById("pi-ex-err").textContent, "쿠팡 옵션 ID(숫자)를 확인해 주세요", "숫자가 아닌 SKU 거부");
doc.getElementById("pi-ex-vid").value = "95936822310";
PI.addExclusion();
check(doc.getElementById("pi-ex-err").textContent, "이미 같은 종류로 제외돼 있어요", "이미 제외된 SKU 는 다시 등록하지 않음");
doc.getElementById("pi-ex-vid").value = "95928560701"; doc.getElementById("pi-ex-reason").value = "";
PI.addExclusion();
check(doc.getElementById("pi-ex-err").textContent, "사유를 입력해 주세요", "[핵심] 사유 필수");
doc.getElementById("pi-ex-reason").value = "단종 예정";
PI.addExclusion();
check(doc.getElementById("modal-root").innerHTML.includes("재입고 제외 등록 확인") && doc.getElementById("modal-root").innerHTML.includes("DB 가 쿠팡 SKU 연결에서 찾아 기록")
      && doc.getElementById("modal-root").innerHTML.includes("제습제 12") && calls.length === 0, true, "[핵심] 등록 전 확인 창(쿠팡 상품명·연결은 DB 가 기록) · 확인 전 호출 0건");
FAKE.rpcDelay = 20;
await Promise.all([PI.confirmExclusion(), PI.confirmExclusion()]);
FAKE.rpcDelay = 0;
check(calls.filter(c => c[0] === "rpc").map(c => [c[1], c[2]]),
      [["fn_set_vendor_item_exclusion", { p_vendor_item_id: "95928560701", p_kind: "RESTOCK_EXCLUDED", p_reason: "단종 예정" }]],
      "[핵심] 등록은 rpc fn_set_vendor_item_exclusion 만 · 두 번 눌러도 1번만 호출(연결 상품은 인자로 보내지 않음)");
calls.length = 0;
doc.getElementById("pi-ex-vid").value = "95928560705"; doc.getElementById("pi-ex-reason").value = "테스트 실패";
PI.addExclusion();
FAKE.rpcError = "NOT_APPROVER 승인 권한자만 제외를 설정할 수 있어요";
const selectsBefore = calls.filter(c => c[0] !== "rpc").length;
await PI.confirmExclusion();
FAKE.rpcError = null;
check([doc.getElementById("pi-ex-modal-err").textContent.includes("승인 권한자만") && doc.getElementById("pi-ex-modal-err").textContent.includes("서버 상태를 다시 읽었어요"),
       doc.getElementById("pi-ex-go").textContent], [true, "재입고 제외"], "[핵심] 실패 → 오류 표시 · 서버 상태 재조회(화면만 성공 처리 안 함) · 버튼 다시 사용 가능");
calls.length = 0;
PI.releaseExclusion("95936822310", "RESTOCK_EXCLUDED");
doc.getElementById("pi-ex-release-reason").value = "";
await PI.confirmRelease();
check([calls.length, doc.getElementById("pi-ex-modal-err").textContent], [0, "해제 사유를 입력해 주세요"], "[핵심] 해제 사유 없으면 호출 0건");
doc.getElementById("pi-ex-release-reason").value = "재입고 결정";
await PI.confirmRelease();
check(calls.filter(c => c[0] === "rpc").map(c => [c[1], c[2]]),
      [["fn_release_vendor_item_exclusion", { p_vendor_item_id: "95936822310", p_kind: "RESTOCK_EXCLUDED", p_reason: "재입고 결정" }]], "해제는 rpc fn_release_vendor_item_exclusion 만");
check(calls.filter(c => ["insert", "update", "upsert"].includes(c[0])).length, 0, "[핵심] 제외 표 직접 쓰기 0건");
calls.length = 0;
FAKE.alreadyReleased = true;
PI.releaseExclusion("96020412319", "CANDIDATE_EXCLUDED");
doc.getElementById("pi-ex-release-reason").value = "다시 눌림";
await PI.confirmRelease();
FAKE.alreadyReleased = false;
check(calls.filter(c => c[0] === "rpc").map(c => c[2].p_kind), ["CANDIDATE_EXCLUDED"], "SKU 사용 보류 해제도 같은 경로(이미 해제면 서버가 ALREADY_RELEASED - 이력 추가 없음)");
PI.exclusionHistory("95936822310");
check(doc.getElementById("modal-root").innerHTML.includes("등록</b>") && doc.getElementById("modal-root").innerHTML.includes("크림화이트 재입고 안 함"), true, "SKU 별 이력");
calls.length = 0;
const v8 = await PI.view(fakeSb(), { id: "u2", name: "사원", approver: false });
check([v8.includes("pi-ex-vid"), (v8.match(/ProcurementInput\.releaseExclusion/g) || []).length, v8.includes("보기 전용 - 승인 권한자만 등록·해제할 수 있어요")],
      [false, 0, true], "보기 전용: 등록칸·[해제] 없음");
PI.addExclusion(); PI.releaseExclusion("95936822310", "RESTOCK_EXCLUDED"); await PI.confirmExclusion(); await PI.confirmRelease();
check(calls.filter(c => c[0] === "rpc").length, 0, "[핵심] 보기 전용은 제외 호출 0건");
FAKE.exclusionFail = true;
const f8 = await PI.view(fakeSb(), { id: "u1", name: "팀장", approver: true });
FAKE.exclusionFail = false;
check([f8.includes("재입고 제외·SKU 사용 보류 목록을 불러오지 못했어요"), f8.includes("pi-ex-vid"), f8.includes("발주·물류 정보")], [true, false, true],
      "제외 목록 조회 실패 → 안내만, 등록칸 없음(발주정보 화면은 그대로)");

console.log(`\n=== 결과: ${fails ? `실패 ${fails}건` : "전체 통과"} ===`);
process.exit(fails ? 1 : 0);
