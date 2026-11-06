/* 발주서 작성 모달의 운반비 추천 — PLT → 차종(규격), 과거 운송 기록 → 후보 정렬
 * 2026-11-06 대표 확인 규격: 1톤 2 / 2.5톤 3 / 3.5톤 4 / 5톤 10 / 5톤축 12 / 11톤 18 PLT
 * 운임은 차량 단위라 (센터 × 차종)이 같으면 과거 금액을 그대로 쓸 수 있다는 전제. */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const src = readFileSync(new URL('./js/app.js', import.meta.url), 'utf8');
const pick = re => eval('(' + src.match(re)[0] + ')');
const vehicleForPlt = pick(/function vehicleForPlt\([\s\S]*?\n}/);
const freightSuggestions = pick(/function freightSuggestions\([\s\S]*?\n}/);
const SPECS = eval(src.match(/const VEHICLE_SPECS_DEFAULT = \[[\s\S]*?\n\];/)[0].replace(/^const VEHICLE_SPECS_DEFAULT = /, '').replace(/;$/, ''));

/* ---------- 규격: PLT → 차종 ---------- */
assert.equal(SPECS.length, 6);
assert.deepEqual(SPECS.find(s => s.type === '1톤'), { type: '1톤', maxPlt: 2 }, '코드에 이미 확인돼 있던 1톤=2PLT 와 일치해야 함');

const v = (plt, specs = SPECS) => vehicleForPlt(plt, specs);
assert.equal(v(18).type, '11톤');
assert.equal(v(18).slack, 0, '18PLT 는 11톤 꽉 참');
assert.equal(v(18).trucks, 1);
assert.equal(v(1).type, '1톤');
assert.equal(v(1).slack, 1);
assert.equal(v(2).type, '1톤');
assert.equal(v(3).type, '2.5톤', '2PLT 를 넘으면 바로 윗 차종');
assert.equal(v(5).type, '5톤', '4PLT(3.5톤) 초과 → 5톤');
assert.equal(v(10).type, '5톤');
assert.equal(v(11).type, '5톤축', '5톤(10PLT) 초과 → 5톤축(12PLT)');
assert.equal(v(12).type, '5톤축');
assert.equal(v(13).type, '11톤');
// 가장 작은 차종으로 채우되, 규격을 넘으면 추측하지 않고 '초과'로 알린다
assert.equal(v(19).over, true);
assert.equal(v(19).trucks, 2);
assert.equal(v(36).trucks, 2);
assert.equal(v(37).trucks, 3);
// 모르면 판정하지 않는다
for (const bad of ['', null, undefined, 0, -3, 1.5, 'abc']) assert.equal(v(bad).ok, false, String(bad));
assert.equal(v(18, []).ok, false, '규격이 없으면 차종을 추측하지 않음');
assert.equal(v(18, [{ type: '11톤', maxPlt: 0 }]).ok, false, '잘못된 규격 줄은 무시');
// 순서가 뒤섞여 등록돼 있어도 가장 작은 적합 차종을 고른다
assert.equal(v(3, [{ type: '11톤', maxPlt: 18 }, { type: '2.5톤', maxPlt: 3 }]).type, '2.5톤');

/* ---------- 실적: 과거 운송 기록 → 후보 ---------- */
const groups = [
  { id: 'g1', vehicle_type: '11톤', vehicle_count: 1, total_pallet_count: 18 },
  { id: 'g2', vehicle_type: '5톤', vehicle_count: 1, total_pallet_count: 10 },
  { id: 'g3', vehicle_type: '11톤', vehicle_count: 1, total_pallet_count: 17 },
  { id: 'g4', vehicle_type: '11톤', vehicle_count: 2, total_pallet_count: 36 },
];
const plans = [
  { shipment_group_id: 'g1', destination_center_id: 'CHA1' },
  { shipment_group_id: 'g2', destination_center_id: 'CHA1' },
  { shipment_group_id: 'g3', destination_center_id: 'DEK1' },
  { shipment_group_id: 'g4', destination_center_id: 'CHA1' },
];
const cost = (id, g, over = {}) => ({ id, shipment_group_id: g, gross_amount: 600000,
  basis: 'ACTUAL', status: 'ACTIVE', invoice_date: '2026-10-29', ...over });

// 차종이 맞는 기록이 맨 위로
let out = freightSuggestions({ costs: [cost('c2', 'g2'), cost('c1', 'g1')], groups, plans, vehicleType: '11톤' });
assert.equal(out[0].id, 'c1');
assert.equal(out[0].vehicleType, '11톤');
assert.equal(out[0].centerId, 'CHA1');
assert.equal(out[0].plt, 18);

// 차종이 같으면 센터가 맞는 쪽이 위로
out = freightSuggestions({ costs: [cost('c3', 'g3'), cost('c1', 'g1')], groups, plans, vehicleType: '11톤', centerId: 'CHA1' });
assert.equal(out[0].id, 'c1');
assert.equal(out[1].id, 'c3');

// 무효·대체된 기록은 빼고, 금액 0 도 뺀다 (기존 집계 규칙과 같음)
for (const st of ['VOID_PENDING_REBUILD', 'SUPERSEDED', 'NEEDS_REVIEW'])
  assert.equal(freightSuggestions({ costs: [cost('x', 'g1', { status: st })], groups, plans }).length, 0, st);
assert.equal(freightSuggestions({ costs: [cost('x', 'g1', { gross_amount: 0 })], groups, plans }).length, 0);
// status 가 비어 있으면 ACTIVE 로 본다
assert.equal(freightSuggestions({ costs: [cost('x', 'g1', { status: null })], groups, plans }).length, 1);

// 같은 (센터 × 차종) 은 가장 최근 1건만 - 실제 청구가 예상보다 먼저
out = freightSuggestions({ costs: [
  cost('old', 'g1', { invoice_date: '2026-08-01' }),
  cost('new', 'g1', { invoice_date: '2026-10-29' }),
], groups, plans });
assert.equal(out.length, 1);
assert.equal(out[0].id, 'new');
out = freightSuggestions({ costs: [
  cost('est', 'g1', { basis: 'ESTIMATE', invoice_date: null, date: '2026-11-05' }),
  cost('act', 'g1', { basis: 'ACTUAL', invoice_date: '2026-10-29' }),
], groups, plans });
assert.equal(out.length, 1);
assert.equal(out[0].id, 'act', '더 최근이어도 예상보다 실제 청구가 먼저');
assert.equal(out[0].actual, true);

// 센터가 다르면 같은 차종이어도 각각 남는다
out = freightSuggestions({ costs: [cost('c1', 'g1'), cost('c3', 'g3')], groups, plans });
assert.equal(out.length, 2);

// 운송 묶음·센터를 모르는 기록도 버리지 않고 '미상'으로 남긴다
out = freightSuggestions({ costs: [cost('c9', 'nope')], groups, plans });
assert.equal(out.length, 1);
assert.equal(out[0].vehicleType, null);
assert.equal(out[0].centerId, null);

// 2대 묶음은 대수를 그대로 알려준다(합계 금액이라 나눠 쓰면 안 됨)
out = freightSuggestions({ costs: [cost('c4', 'g4')], groups, plans });
assert.equal(out[0].vehicleCount, 2);

// 빈 입력에도 터지지 않는다
assert.deepEqual(freightSuggestions({}), []);
assert.deepEqual(freightSuggestions({ costs: [], groups: [], plans: [] }), []);
assert.equal(freightSuggestions({ costs: Array.from({ length: 20 }, (_, i) =>
  cost('c' + i, 'g' + i)), groups, plans }).length <= 6, true, '목록은 6건까지');

console.log('PASS: PLT → 차종 판정(규격 6종 · 초과 시 대수 · 모르면 판정 안 함)');
console.log('PASS: 과거 운반비 후보(차종>센터>실제청구>최신 · 무효 제외 · 조합별 1건 · 미상 보존)');

/* ---------- 화면: 칩 그리기 · 눌러서 채우기 (가짜 DOM) ---------- */
import vm from 'node:vm';
const grab = re => { const m = src.match(re); assert.ok(m, '소스에서 못 찾음: ' + re); return m[0]; };
const uiSrc = [
  grab(/const VEHICLE_SPECS_DEFAULT = \[[\s\S]*?\n\];/),
  grab(/function vehicleForPlt\([\s\S]*?\n}/),
  grab(/function freightSuggestions\([\s\S]*?\n}/),
  grab(/const FREIGHT_PICK_EMPTY = \{.*\n/),
  grab(/let freightPick = .*\n/),
  grab(/const freightCenterName = .*\n/),
  grab(/function renderFreightPicker\([\s\S]*?\n}/),
  grab(/function applyFreightPick\([\s\S]*?\n}/),
].join('\n') + '\nglobalThis.__pick = () => freightPick;';

// 발주서 작성 모달(메모 있음) · 입고 확정 모달(메모 없음) 두 설정을 같은 컴포넌트로 씁니다.
const CFG_PO = { pltId: 'po-plt', hintId: 'po-plt-hint', boxId: 'po-freight-pick', amountId: 'po-freight', memoId: 'po-memo' };
const CFG_RC = { pltId: 'rc-plt', hintId: 'rc-plt-hint', boxId: 'rc-freight-pick', amountId: 'rc-freight', memoId: null };

function makeDom(cfg, pltValue) {
  const el = id => ({ id, value: '', innerHTML: '', _max: null,
    getAttribute(k) { return k === 'maxlength' ? this._max : null; } });
  const els = {};
  for (const id of [cfg.pltId, cfg.hintId, cfg.boxId, cfg.amountId, cfg.memoId].filter(Boolean)) els[id] = el(id);
  els[cfg.pltId].value = pltValue;
  if (cfg.memoId) els[cfg.memoId]._max = 100;
  return { els, document: { getElementById: id => els[id] || null } };
}
const mkCtx = (pltValue, state, cfg = CFG_PO) => {
  const dom = makeDom(cfg, pltValue);
  const ctx = vm.createContext({
    document: dom.document,
    esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    fmt: n => (Number(n) || 0).toLocaleString('ko-KR'),
    CoupangCenters: { label: r => (r && r.id === 'CHA1' ? '천안1센터 (CHA1)' : r && r.id ? r.id : '-') },
    vehicleSpecs: SPECS, vehicleSpecsSaved: true,
  });
  vm.runInContext(uiSrc, ctx);
  Object.assign(ctx.__pick(), { cfg }, state);
  return { ctx, els: dom.els };
};

// 18PLT → 11톤으로 안내하고, 11톤 기록을 맨 위에 둔다
let { ctx, els } = mkCtx('18', { loaded: true, costs: [cost('c2', 'g2'), cost('c1', 'g1')], groups, plans });
ctx.renderFreightPicker();
assert.match(els['po-plt-hint'].innerHTML, /11톤/);
assert.match(els['po-plt-hint'].innerHTML, /꽉 참/);
assert.match(els['po-freight-pick'].innerHTML, /천안1센터 \(CHA1\)/);
assert.match(els['po-freight-pick'].innerHTML, /₩600,000/);
assert.equal(ctx.__pick().list[0].id, 'c1');

// 눌러서 채우기 → 금액칸과 메모에 근거가 남고, 다시 누르면 해제된다 (저장은 안 함)
ctx.applyFreightPick(0);
assert.equal(els['po-freight'].value, '600,000');
assert.match(els['po-memo'].value, /운반비 근거: 천안1센터 \(CHA1\) 11톤 10-29 청구 ₩600,000/);
ctx.applyFreightPick(0);
assert.equal(els['po-freight'].value, '', '다시 누르면 비움');
assert.equal(els['po-memo'].value, '', '메모의 근거도 같이 지움');

// 메모 길이 제한을 넘으면 잘린 근거를 남기지 않는다 (금액은 그대로 채움)
({ ctx, els } = mkCtx('18', { loaded: true, costs: [cost('c1', 'g1')], groups, plans }));
ctx.renderFreightPicker();
els['po-memo'].value = 'x'.repeat(95);
ctx.applyFreightPick(0);
assert.equal(els['po-freight'].value, '600,000');
assert.equal(els['po-memo'].value, 'x'.repeat(95), '잘린 근거는 넣지 않음');

// 19PLT → 규격 초과를 숨기지 않고 알린다 · 1PLT 는 정책 경고
({ ctx, els } = mkCtx('19', { loaded: true, costs: [], groups, plans }));
ctx.renderFreightPicker();
assert.match(els['po-plt-hint'].innerHTML, /넘어요/);
assert.match(els['po-plt-hint'].innerHTML, /2대 필요/);
({ ctx, els } = mkCtx('1', { loaded: true, costs: [], groups, plans }));
ctx.renderFreightPicker();
assert.match(els['po-plt-hint'].innerHTML, /1PLT 단독 출발은 정책상 막혀요/);

// 못 읽었을 때 '기록 없음'으로 조용히 넘기지 않는다
({ ctx, els } = mkCtx('18', { loaded: true, error: '권한 없음' }));
ctx.renderFreightPicker();
assert.match(els['po-freight-pick'].innerHTML, /불러오지 못했어요/);
assert.match(els['po-freight-pick'].innerHTML, /권한 없음/);
({ ctx, els } = mkCtx('18', { loaded: true, costs: [], groups: [], plans: [] }));
ctx.renderFreightPicker();
assert.match(els['po-freight-pick'].innerHTML, /기록이 아직 없어요/);

// PLT 를 안 넣어도 터지지 않고, 과거 기록은 그대로 보여 준다
({ ctx, els } = mkCtx('', { loaded: true, costs: [cost('c1', 'g1')], groups, plans }));
ctx.renderFreightPicker();
assert.match(els['po-plt-hint'].innerHTML, /입고 PLT 를 넣으면/);
assert.match(els['po-freight-pick'].innerHTML, /₩600,000/);

console.log('PASS: 화면 - 차종 안내 · 칩 렌더 · 눌러 채우기/해제 · 메모 길이 보호 · 실패를 0건으로 숨기지 않음');

/* ---------- 입고 확정 모달: 발주서 없이 들어온 건도 같은 추천을 쓴다 (메모칸 없음) ---------- */
({ ctx, els } = mkCtx('18', { loaded: true, costs: [cost('c1', 'g1')], groups, plans }, CFG_RC));
ctx.renderFreightPicker();
assert.match(els['rc-plt-hint'].innerHTML, /11톤/);
assert.match(els['rc-freight-pick'].innerHTML, /₩600,000/);
ctx.applyFreightPick(0);
assert.equal(els['rc-freight'].value, '600,000', '메모칸이 없어도 금액은 채워짐');
ctx.applyFreightPick(0);
assert.equal(els['rc-freight'].value, '', '메모칸이 없어도 해제됨');

// 설정이 비면(모달이 닫힌 뒤 등) 아무 일도 하지 않는다
({ ctx, els } = mkCtx('18', { loaded: true, costs: [cost('c1', 'g1')], groups, plans }, CFG_RC));
ctx.renderFreightPicker();
Object.assign(ctx.__pick(), { cfg: null });
ctx.renderFreightPicker();
ctx.applyFreightPick(0);
assert.equal(els['rc-freight'].value, '', '모달이 닫혔으면 조용히 아무것도 안 함');

console.log('PASS: 입고 확정 모달 - 발주서 없이 들어온 입고도 같은 추천(메모 없이 금액만)');
