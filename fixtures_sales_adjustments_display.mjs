import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = readFileSync(new URL('./js/app.js', import.meta.url), 'utf8');
const context = vm.createContext({ console, Number, Math, Array, fmt: n => String(n), esc: s => String(s) });
for (const name of ['summarizeSalesAdjustments', 'loadSalesAdjustments', 'salesAdjustmentSummaryHtml', 'rgAdjustmentNotCollectedHtml', 'loadDailySalesBriefing']) {
  const match = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n}`));
  assert.ok(match, name);
  vm.runInContext(match[0], context);
}
const row = (overrides = {}) => ({ id: 'r1', receipt_type: 'RETURN', qty: 1, estimated_adjustment_amount: 100,
  settled_adjustment_amount: null, amount_status: 'ESTIMATED', channel: 'RG', ...overrides });
const summarize = rows => context.summarizeSalesAdjustments(rows);
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS', name); }
check('추정 반품금액이 확정합계 0에 가려지지 않음', () => assert.equal(summarize([row()]).return_amount, 100));
check('확정/추정 혼합은 행별 선택', () => assert.equal(summarize([row(), row({amount_status:'SETTLED', settled_adjustment_amount:80})]).return_amount, 180));
check('실제 확정금액 0은 추정으로 대체하지 않음', () => assert.equal(summarize([row({amount_status:'SETTLED', settled_adjustment_amount:0})]).return_amount, 0));
check('철회 제외', () => assert.equal(summarize([row({amount_status:'WITHDRAWN'})]).return_qty, 0));
check('반품과 취소 분리', () => { const s = summarize([row(), row({receipt_type:'CANCEL', qty:2})]); assert.equal(s.return_qty,1); assert.equal(s.cancel_qty,2); });
check('이상 유형/금액은 0으로 숨기지 않음', () => { assert.throws(()=>summarize([row({receipt_type:'UNKNOWN'})])); assert.throws(()=>summarize([row({qty:'bad'})])); });
check('매출 없는 날 반품은 음수 순매출', () => assert.match(context.salesAdjustmentSummaryHtml(summarize([row()]),0), /₩-100/));
check('조회실패는 반품 0으로 표시하지 않음', () => assert.match(context.salesAdjustmentSummaryHtml(null,100), /확인할 수 없습니다/));
let calls = [];
let briefing = {gross_amount:1000, net_amount:900, cancel_qty:0, return_qty:1, return_amount_estimated:100, return_amount_settled:0};
let pages = [[row()]];
let queryError = null;
context.sb = {from(table) {
  const q = {
    select(){return q;}, eq(){return q;}, gte(k,v){calls.push(['gte',v]);return q;},
    lte(k,v){calls.push(['lte',v]);return q;}, order(){return q;},
    range(from,to){calls.push(['range',from,to]); return Promise.resolve({data:pages[from/500]||[],error:queryError});},
    maybeSingle(){return Promise.resolve({data:briefing,error:null});}
  }; return q;
}};
let b = await context.loadDailySalesBriefing('2026-09-09');
check('브리핑 추정 반품 100 표시에 필요한 원본 합계',()=>assert.equal(b.adjustment_summary.return_amount,100));
briefing = {...briefing,net_amount:800};
b = await context.loadDailySalesBriefing('2026-09-09');
check('스냅샷 차이는 잘못된 금액 대신 재집계 안내',()=>{ assert.equal(b.adjustment_summary,null);assert.match(b.adjustment_display_error,/재집계/); });
queryError = new Error('RLS/query failed');
b = await context.loadDailySalesBriefing('2026-09-09');
check('반품 조회실패에도 저장된 브리핑은 유지',()=>{assert.equal(b.net_amount,800);assert.match(b.adjustment_display_error,/조회 실패/);});
queryError = null; calls=[];pages=[Array.from({length:500},()=>row()),[row()]];
const summary = await context.loadSalesAdjustments('2026-09-01','2026-09-30');
check('페이지 경계를 넘어 전체 반품 집계',()=>{assert.equal(summary.return_qty,501);assert.equal(calls.filter(c=>c[0]==='range').length,2);});
check('월별 접수일 필터 전달',()=>{assert.ok(calls.some(c=>c[0]==='gte'&&c[1]==='2026-09-01'));assert.ok(calls.some(c=>c[0]==='lte'&&c[1]==='2026-09-30'));});
// 2026-09-10 [로켓그로스 취소·반품 미수집] 0원을 '반품 없음'으로 오해하지 않게 하는 경고
check('RG 매출이 있으면 미수집 경고를 표시', () => {
  const html = context.rgAdjustmentNotCollectedHtml(true);
  assert.match(html, /자동 수집되지 않습니다/);
  assert.match(html, /포함돼 있지 않으며/);
  assert.match(html, /판매 리포트/);
});
check('RG 매출이 없으면 경고를 띄우지 않음', () => assert.equal(context.rgAdjustmentNotCollectedHtml(false), ''));
check('경고가 임의의 숫자를 만들어내지 않음', () => {
  const html = context.rgAdjustmentNotCollectedHtml(true);
  assert.ok(!/₩[0-9]/.test(html), '경고문에 금액을 지어내면 안 됨');
});

console.log(`${passed} tests passed`);
