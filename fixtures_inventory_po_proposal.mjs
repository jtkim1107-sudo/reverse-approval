import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const src = readFileSync(new URL('./js/app.js', import.meta.url), 'utf8');
const fn = eval('(' + src.match(/function buildInventoryPOProposal\([\s\S]*?\n}/)[0] + ')');
const products = [{id:'p'}];
const row = { product_id:'p', product_name:'상품', decision:'ORDER_NOW', supplier_name:'리파코 주식회사', recommended_order_qty_ea:60, purchase_cost:6000, avg_daily_sales:2, live_stock:20, order_unit:'PLT' };
const calc = r => fn(r, '2026-09-08', products);
assert.equal(calc([row]).lines[0].dueDate, '2026-09-11');
assert.equal(calc([row]).lines[0].qty,60);
assert.equal(calc([{...row,live_stock:0}]).lines[0].urgent,true);
assert.equal(calc([{...row,live_stock:0}]).lines[0].dueDate,'2026-09-01');
for (const change of [{decision:'OK'},{decision:'DATA_CHECK'},{decision:'AWAITING_INBOUND'},{open_po_qty:80},{incoming_qty:80},{open_po_refs:[{}]},{live_stock:null},{avg_daily_sales:0},{recommended_order_qty_ea:1.5},{order_unit:null},{supplier_name:'다른 업체'},{shared_inventory:{role:'child'}}]) {
 assert.equal(calc([{...row,...change}]).lines.length,0,JSON.stringify(change));
}
assert.equal(calc([row,row]).lines.length,0);
assert.equal(calc([]).lines.length,0);
console.log('PASS: due-date buffer, urgent shortage, PLT recommendation, existing orders, invalid data, shared stock and duplicate exclusions');
