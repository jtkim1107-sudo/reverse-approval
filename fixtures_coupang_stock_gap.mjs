/* 원장 쿠팡재고 ↔ 쿠팡 실재고(WING) 차이 감지
 * 2026-11-06 [대표 요청] 입고 오류로 반출됐는데 재고 이동을 안 적으면 원장만 '쿠팡에 있다'고 봅니다.
 *   그 물건은 우리 창고에 있는데 발주 판단에는 재고 0 으로 보여 중복 발주가 납니다.
 * 원칙: 모르면 비교하지 않는다(원장 미확정·실재고 없음은 건너뜀) · '반출'로 단정하지 않는다. */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const src = readFileSync(new URL('./js/app.js', import.meta.url), 'utf8');
const coupangStockGaps = eval('(' + src.match(/function coupangStockGaps\([\s\S]*?\n}/)[0] + ')');
const coupangGapSum = eval(src.match(/const coupangGapSum = [^\n]*\n/)[0].replace(/^const coupangGapSum = /, '').replace(/;\n$/, ''));

const products = [
  { id: 'a', code: 'A1', name: '발판 그레이' },
  { id: 'b', code: 'B1', name: '스프레이건' },
  { id: 'c', code: 'C1', name: '위탁상품', trade_type: '위탁' },
  { id: 'd', code: 'D1', name: '세트상품' },
];
const run = (stock, live, stockCheck = null) => coupangStockGaps({ stock, live, products, stockCheck });

/* ---------- 반출했는데 기록 안 함: 원장 > 실재고 ---------- */
let r = run({ a: { atCoupang: 240 } }, { a: 0 });
assert.equal(r.length, 1);
assert.equal(r[0].kind, 'MISSING_OUT');
assert.equal(r[0].gap, 240);
assert.equal(r[0].ledger, 240);
assert.equal(r[0].live, 0);
assert.equal(r[0].name, '발판 그레이');
assert.equal(r[0].code, 'A1');

/* ---------- 들어왔는데 기록 안 함: 실재고 > 원장 ---------- */
r = run({ a: { atCoupang: 10 } }, { a: 60 });
assert.equal(r[0].kind, 'UNRECORDED_IN');
assert.equal(r[0].gap, 50);

/* ---------- 맞으면 아무것도 안 낸다 ---------- */
assert.deepEqual(run({ a: { atCoupang: 100 } }, { a: 100 }), []);
assert.deepEqual(run({ a: { atCoupang: 0 } }, { a: 0 }), []);

/* ---------- 모르면 비교하지 않는다 ---------- */
assert.deepEqual(run({ a: { atCoupang: 240 } }, {}), [], '실재고를 못 읽었으면 건너뜀');
assert.deepEqual(run({ a: { atCoupang: 240 } }, { a: null }), [], 'null 도 건너뜀');
assert.deepEqual(run({ a: { atCoupang: 240 } }, { a: undefined }), [], 'undefined 도 건너뜀');
assert.deepEqual(run({ a: { atCoupang: 240, check: '취소·반품 회수 확인 필요' } }, { a: 0 }), [],
  '원장이 확정 안 된 상품은 비교하지 않음');
assert.deepEqual(run({ a: { atCoupang: 240 } }, { a: 0 }, '매출을 읽지 못함'), [],
  '원장 전체를 못 믿는 상태면 아무것도 비교하지 않음');

/* ---------- 재고를 갖지 않는 상품은 제외 ---------- */
assert.deepEqual(run({ c: { atCoupang: 100 } }, { c: 0 }), [], '위탁은 공급처 재고');
assert.deepEqual(run({ d: { atCoupang: 100, isSet: true } }, { d: 0 }), [], '연동 세트는 자체 재고 없음');

/* ---------- 차이가 큰 순으로 ---------- */
r = run({ a: { atCoupang: 30 }, b: { atCoupang: 500 } }, { a: 0, b: 0 });
assert.deepEqual(r.map(x => x.product_id), ['b', 'a']);

/* ---------- 두 방향이 섞여 있어도 따로 센다 ---------- */
r = run({ a: { atCoupang: 240 }, b: { atCoupang: 0 } }, { a: 0, b: 70 });
assert.equal(coupangGapSum(r, 'MISSING_OUT'), 240);
assert.equal(coupangGapSum(r, 'UNRECORDED_IN'), 70);
assert.equal(r.filter(x => x.kind === 'MISSING_OUT').length, 1);
assert.equal(r.filter(x => x.kind === 'UNRECORDED_IN').length, 1);

/* ---------- 상품 마스터에 없는 id 도 터지지 않는다 ---------- */
r = run({ zz: { atCoupang: 5 } }, { zz: 0 });
assert.equal(r[0].name, '?');
assert.equal(r[0].gap, 5);

/* ---------- 빈 입력 ---------- */
assert.deepEqual(coupangStockGaps({}), []);
assert.deepEqual(coupangStockGaps({ stock: {}, live: {}, products: [] }), []);
assert.equal(coupangGapSum([], 'MISSING_OUT'), 0);

/* ---------- atCoupang 이 없으면 0 으로 본다(음수 clamp 뒤 값) ---------- */
r = run({ a: {} }, { a: 40 });
assert.equal(r[0].kind, 'UNRECORDED_IN');
assert.equal(r[0].gap, 40);

console.log('PASS: 원장 ↔ 실재고 차이(양방향) · 모르면 비교 안 함 · 위탁/세트 제외 · 큰 순 정렬');
