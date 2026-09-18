import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('./js/app.js', import.meta.url), 'utf8');
const grab = name => src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}`))?.[0];
const pad2 = n => String(n).padStart(2, '0');
const VAT_RATE = .1;
const isTaxable = p => (p?.tax_type || '과세') === '과세';
const ripacoEstimatedPayDate = eval('(' + grab('ripacoEstimatedPayDate') + ')');
const poEstimatedCashPayment = eval('(' + grab('poEstimatedCashPayment') + ')');
const wingDirectPaymentBasis = eval('(' + grab('wingDirectPaymentBasis') + ')');
const lastBankStatementAt = eval('(' + grab('lastBankStatementAt') + ')');

assert.equal(ripacoEstimatedPayDate('2026-09-17'), '2026-10-20');
assert.equal(ripacoEstimatedPayDate('2026-12-31'), '2027-01-20');
assert.equal(ripacoEstimatedPayDate('2026-08-31'), '2026-09-20');
const items = [
  { product_id: 'taxed', qty: 2, unit_cost: 10000, amount: 20000 },
  { product_id: 'free', qty: 1, unit_cost: 5000, amount: 5000 },
];
const products = [{ id: 'taxed', tax_type: '과세' }, { id: 'free', tax_type: '면세' }];
assert.equal(poEstimatedCashPayment({}, items, products, { enabled: true, purchaseCostIncludesVat: false }), 27000);
assert.equal(poEstimatedCashPayment({}, items, products, { enabled: true, purchaseCostIncludesVat: true }), 25000);
assert.equal(poEstimatedCashPayment({}, items, products, { enabled: false, purchaseCostIncludesVat: false }), 25000);
assert.equal(wingDirectPaymentBasis({ total: 3960000, freight_est: 187000 },
  [{ product_id: 'taxed', qty: 720, unit_cost: 5500, amount: 3960000 }], products,
  { enabled: true, purchaseCostIncludesVat: false }), 4356000);
assert.equal(wingDirectPaymentBasis({ total: 25000 }, items, products,
  { enabled: true, purchaseCostIncludesVat: false }), 27000);
assert.equal(wingDirectPaymentBasis({ total: 25000 }, items, products,
  { enabled: true, purchaseCostIncludesVat: true }), 25000);
assert.throws(() => wingDirectPaymentBasis({ total: 25000 }, items, products.slice(0, 1),
  { enabled: true, purchaseCostIncludesVat: false }), /과세 구분/);
assert.throws(() => wingDirectPaymentBasis({ total: 25001 }, items, products,
  { enabled: true, purchaseCostIncludesVat: false }), /품목 합계/);
assert.equal(lastBankStatementAt([
  { date: '2026-09-16', memo: '통장 10:08:00 · BANK_STMT_20260917:x' },
  { date: '2026-09-17', memo: '통장 07:41:48 · BANK_STMT:abc' },
  { date: '2026-09-17', memo: '수동 입력' },
]), '2026-09-17 07:41:48');
console.log('PASS: 다음 달 20일, 연도 경계, 과세·면세 혼합 발주의 VAT 포함 지급 추정');
