import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const src = readFileSync(new URL('./js/app.js', import.meta.url), 'utf8');
const fn = eval('(' + src.match(/function buildInventoryPOProposal\([\s\S]*?\n}/)[0] + ')');
const products = [{id:'p'}];
const row = { product_id:'p', product_name:'상품', decision:'ORDER_NOW', supplier_name:'리파코 주식회사', recommended_order_qty_ea:60, purchase_cost:6000, avg_daily_sales:2, live_stock:20, order_unit:'PLT' };
// 2026-09-12 VAT 확인 대기: 네 번째 인자(VAT 확인 상태)가 CONFIRMED 인 상품만 발주안에 자동으로 들어가요
const CONF = { p: { status: 'CONFIRMED', reason: 'VAT 기준 확인됨' } };
const calc = (r, vat = CONF) => fn(r, '2026-09-08', products, vat);
assert.equal(calc([row]).lines[0].dueDate, '2026-09-11');
assert.equal(calc([row]).lines[0].qty,60);
assert.equal(calc([{...row,live_stock:0}]).lines[0].urgent,true);
assert.equal(calc([{...row,live_stock:0}]).lines[0].dueDate,'2026-09-01');
for (const change of [{decision:'OK'},{decision:'DATA_CHECK'},{decision:'AWAITING_INBOUND'},{open_po_qty:80},{incoming_qty:80},{open_po_refs:[{}]},{live_stock:null},{avg_daily_sales:0},{recommended_order_qty_ea:1.5},{order_unit:null},{supplier_name:'다른 업체'},{shared_inventory:{role:'child'}}]) {
 assert.equal(calc([{...row,...change}]).lines.length,0,JSON.stringify(change));
}
assert.equal(calc([row,row]).lines.length,0);
assert.equal(calc([]).lines.length,0);
// VAT 확인 대기·조회 실패·상태 없음 → 자동 발주안에서 빠지고 needsAck(사람 경고 확인 뒤 직접 추가)로
for (const vat of [{ p: { status: 'VAT_UNCONFIRMED', reason: '매입원가 VAT 기준 미확인' } }, { p: { status: 'VAT_STATUS_UNKNOWN', reason: 'x' } }, {}, null]) {
  const r = calc([row], vat);
  assert.equal(r.lines.length, 0, JSON.stringify(vat));
  assert.equal(r.needsAck.length, 1, JSON.stringify(vat));
  assert.equal(r.needsAck[0].qty, 60);
}
assert.equal(calc([{...row, decision:'DATA_CHECK'}], { p: { status: 'VAT_UNCONFIRMED' } }).needsAck.length, 0, 'MISSING·데이터확인은 needsAck 에도 안 들어감');
console.log('PASS: VAT 확인 대기 상품은 자동 발주안 제외(needsAck), 확인된 상품만 자동');
console.log('PASS: due-date buffer, urgent shortage, PLT recommendation, existing orders, invalid data, shared stock and duplicate exclusions');
