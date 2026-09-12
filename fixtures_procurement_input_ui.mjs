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
function fakeSb() {
  const tables = { products, product_procurement: procurements, purchase_recommendations: reco, suppliers: [{ name: "리파코 주식회사", active: true }],
                   purchase_order_items: poItems, product_procurement_audit: audits, procurement_sync_state: [] };
  const builder = t => {
    const b = { _in: null, select() { return b; }, order() { return b; }, limit() { return b; },
      in(c, v) { b._in = [c, v]; return b; },
      insert() { calls.push(["insert", t]); return b; }, update() { calls.push(["update", t]); return b; }, upsert() { calls.push(["upsert", t]); return b; },
      then(res, rej) { let rows = tables[t] || []; if (b._in) rows = rows.filter(r => b._in[1].includes(r[b._in[0]])); return Promise.resolve({ data: JSON.parse(JSON.stringify(rows)), error: null }).then(res, rej); } };
    return b;
  };
  return {
    from: builder,
    rpc: async (fn, args) => {
      calls.push(["rpc", fn, JSON.parse(JSON.stringify(args))]);
      if (args.p_product_id === "dh12") return { data: null, error: { message: "NOT_INTEGER:min_order_quantity 소수는 입력할 수 없어요(1.5)" } };
      return { data: { status: "SAVED" }, error: null };
    },
  };
}

const doc = makeDoc();
const ctx = vm.createContext({ console, Map, Set, JSON, Number, String, Date, Math, Promise, Object, Array, RegExp, URLSearchParams,
  document: doc, confirm: () => true, toast: () => {}, alert: () => {} });
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
check(Object.keys(PI.validateRow({ ...base, supplier_name: "  ", orderable_unit: "", lead_time_days: "0" }, spray).errors).sort(),
      ["lead_time_days", "orderable_unit", "supplier_name"], "공급처 공백·발주단위 없음·리드타임 0 거부");
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
check(html.includes('<button class="btn" onclick="ProcurementInput.review()" disabled>'), true, "바뀐 게 없으면 [변경 내용 확인] 잠김");
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
PI.onInput("mat", "cost_vat_basis", "VAT_EXCLUDED");
PI.onInput("mat", "lead_time_days", "9");
PI.review(); await PI.saveAll();
check(calls.find(c => c[0] === "rpc")[2].p_expected_updated_at, "2026-09-11T05:06:07.654321+00:00", "[핵심] 기존 행은 updated_at 문자열 그대로(마이크로초 유지)");

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
check(index.includes('href="#/procurement" data-route="procurement"') && index.includes('<script src="js/procurement_input.js?v=1"></script>')
      && index.indexOf("procurement_input.js") < index.indexOf("js/app.js"), true, "메뉴·스크립트(app.js 보다 먼저)");
check(/product_procurement"\)\.(insert|update|upsert)/.test(read("./js/procurement_input.js") + app), false, "화면 코드 어디에도 product_procurement 직접 쓰기 없음");

console.log(`\n=== 결과: ${fails ? `실패 ${fails}건` : "전체 통과"} ===`);
process.exit(fails ? 1 : 0);
