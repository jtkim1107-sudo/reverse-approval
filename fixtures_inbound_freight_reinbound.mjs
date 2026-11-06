/* 반출(쿠팡→창고 회수) → 재입고(창고→쿠팡) 때 입고 운송비가 물건을 따라가는지
 * 2026-11-06 [대표 지적] "재고원가에 얹혀야지, 외부운송비가 2번 들었으니까"
 *   예전: 회수 때 그 로트의 운임을 그냥 없앰 → 영영 공헌이익으로 못 가고 재고원가에 묶인 채 남음
 *   지금: 회수로 나간 운임을 들고 나갔다가, 그 뒤 다시 들여보낸 로트에 얹음 → 팔릴 때 정상 차감
 * (재입고 트럭값 자체를 새로 다는 건 2단계 - 컬럼 추가가 필요해 여기 범위 밖) */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ctx = vm.createContext({ console, Map, Set, Number, String, Math, JSON });
vm.runInContext(readFileSync(new URL('./js/inbound_freight.js', import.meta.url), 'utf8'), ctx);
const IF = ctx.InboundFreight;

const P = 'p1', TODAY = '2026-11-30';
const products = [{ id: P }];
const cost = (id, po, supply) => ({ id, shipment_group_id: 'g-' + id, purchase_order_id: po,
  basis: 'ACTUAL', status: 'ACTIVE', gross_amount: Math.round(supply * 1.1), supply_amount: supply, vat_amount: Math.round(supply * .1) });
const alloc = (fid, qty, supply) => ({ id: fid + '-a', freight_cost_id: fid, product_id: P,
  sort_order: 1, pallet_count: 18, qty, allocated_supply: String(supply) });
const buy = (id, po, qty, date) => ({ id, product_id: P, qty, warehouse: '쿠팡', date, created_at: date + 'T01:00:00Z', po_id: po });
const sale = (id, qty, date) => ({ id, product_id: P, qty, date, created_at: date + 'T01:00:00Z' });
const move = (id, kind, qty, date) => ({ id, product_id: P, qty, kind, date, created_at: date + 'T01:00:00Z' });

const run = ({ costs, allocations, buys, sales = [], transfers = [] }) =>
  IF.compute({ costs, allocations, buys, sales, transfers, products, isCoupangSale: () => true, today: TODAY });
const sumBySale = r => [...r.bySale.values()].reduce((s, x) => s + x.supply, 0);
const a0 = r => r.records[0].allocs[0];

/* ---------- 기본: 반출 없이 그대로 팔리면 예전과 같다 (회귀 확인) ---------- */
let r = run({ costs: [cost('fc1', 'po1', 600000)], allocations: [alloc('fc1', 100, 600000)],
  buys: [buy('b1', 'po1', 100, '2026-10-30')], sales: [sale('s1', 100, '2026-11-10')] });
assert.equal(sumBySale(r), 600000, '반출이 없으면 전액 차감 (기존 동작)');
assert.equal(a0(r).inventorySupply, 0);

/* ---------- 핵심: 반출됐다 재입고된 뒤 팔리면 운임이 따라온다 ---------- */
r = run({ costs: [cost('fc1', 'po1', 600000)], allocations: [alloc('fc1', 100, 600000)],
  buys: [buy('b1', 'po1', 100, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 100, '2026-11-03'), move('t2', '쿠팡입고', 100, '2026-11-07')],
  sales: [sale('s1', 100, '2026-11-10')] });
assert.equal(sumBySale(r), 600000, '반출·재입고를 거쳐도 운임 전액이 공헌이익에서 빠져야 함');
assert.equal(a0(r).soldQty, 100);
assert.equal(a0(r).inventorySupply, 0, '재고원가에 묶여 남지 않음');

/* ---------- 반출만 하고 아직 안 들여보냈으면 차감하지 않고 재고원가로 남는다 ---------- */
r = run({ costs: [cost('fc1', 'po1', 600000)], allocations: [alloc('fc1', 100, 600000)],
  buys: [buy('b1', 'po1', 100, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 100, '2026-11-03')] });
assert.equal(sumBySale(r), 0, '우리 창고에 있는 물건의 운임은 아직 비용이 아님');
assert.equal(a0(r).inventorySupply, 600000, '재고원가로 남아 있어야 함');

/* ---------- 일부만 반출·재입고 ---------- */
r = run({ costs: [cost('fc1', 'po1', 600000)], allocations: [alloc('fc1', 100, 600000)],
  buys: [buy('b1', 'po1', 100, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 40, '2026-11-03'), move('t2', '쿠팡입고', 40, '2026-11-07')],
  sales: [sale('s1', 100, '2026-11-10')] });
assert.equal(sumBySale(r), 600000, '40개만 오갔어도 전액 차감');

/* ---------- 반출보다 적게 들여보내면 그만큼만 따라오고 나머지는 재고원가 ---------- */
r = run({ costs: [cost('fc1', 'po1', 600000)], allocations: [alloc('fc1', 100, 600000)],
  buys: [buy('b1', 'po1', 100, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 100, '2026-11-03'), move('t2', '쿠팡입고', 60, '2026-11-07')],
  sales: [sale('s1', 60, '2026-11-10')] });
assert.equal(sumBySale(r), 360000, '들여보낸 60개분(60×6,000)만 차감');
assert.equal(a0(r).inventorySupply, 240000, '창고에 남은 40개분은 재고원가로');

/* ---------- 대표님 상황: 기존 재고가 있어 선입선출이 섞여도 운임 총액은 보존된다 ----------
   있던 60개(운임 120,000 · 개당 2,000) + 10/30 신규 100개(운임 600,000 · 개당 6,000)
   11/3 에 100개 반출 → 선입선출이 기존 60개부터 집어가지만, 집어간 운임을 버리지 않고
   11/7 재입고 로트로 옮기므로 다 팔면 운임 720,000 이 전부 공헌이익에서 빠진다. */
r = run({
  costs: [cost('fcA', 'poA', 120000), cost('fcB', 'poB', 600000)],
  allocations: [alloc('fcA', 60, 120000), alloc('fcB', 100, 600000)],
  buys: [buy('bA', 'poA', 60, '2026-10-01'), buy('bB', 'poB', 100, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 100, '2026-11-03'), move('t2', '쿠팡입고', 100, '2026-11-07')],
  sales: [sale('s1', 160, '2026-11-20')] });
assert.equal(sumBySale(r), 720000, '운임 총액(120,000 + 600,000)이 전부 차감돼야 함');
const byId = Object.fromEntries(r.records.map(x => [x.cost.id, x.allocs[0]]));
assert.equal(byId.fcA.soldSupply, 120000, '기존 재고 운임도 제자리를 찾음');
assert.equal(byId.fcB.soldSupply, 600000);
assert.equal(byId.fcA.inventorySupply + byId.fcB.inventorySupply, 0);

/* ---------- 같은 날 반출·재입고라도 멈춘다(무한 반복 방지) ----------
   같은 날짜 로트에는 옮기지 않으므로 그날 운임은 재고원가로 남고, 계산은 정상 종료된다. */
r = run({ costs: [cost('fc1', 'po1', 600000)], allocations: [alloc('fc1', 100, 600000)],
  buys: [buy('b1', 'po1', 100, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 100, '2026-11-03'), move('t2', '쿠팡입고', 100, '2026-11-03')],
  sales: [sale('s1', 100, '2026-11-10')] });
assert.equal(a0(r).soldSupply + a0(r).inventorySupply, 600000, '어느 쪽이든 운임 총액은 보존');

/* ---------- 반출을 두 번 거쳐도 보존된다 ---------- */
r = run({ costs: [cost('fc1', 'po1', 600000)], allocations: [alloc('fc1', 100, 600000)],
  buys: [buy('b1', 'po1', 100, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 100, '2026-11-03'), move('t2', '쿠팡입고', 100, '2026-11-07'),
              move('t3', '쿠팡회수', 100, '2026-11-10'), move('t4', '쿠팡입고', 100, '2026-11-14')],
  sales: [sale('s1', 100, '2026-11-20')] });
assert.equal(sumBySale(r), 600000, '두 번 오가도 전액 차감');

console.log('PASS: 반출된 입고 운송비가 재입고 로트를 따라가 팔릴 때 공헌이익에서 빠짐');
console.log('PASS: 미재입고·부분재입고·선입선출 혼재·같은날·2회 반출 모두 운임 총액 보존');

/* ================= 2단계: 재입고 트럭값(운임②)도 얹힌다 =================
 * DB: inbound_freight_costs.stock_transfer_id 로 이동에 직접 달린 운송비
 *     (purchase_order_id 와 둘 중 하나만 — source_ck)
 * 기대: 반출돼 따라온 운임① + 재입고 운임② 가 같은 수량 위에 겹쳐 얹히고, 팔릴 때 둘 다 빠진다. */
const trCost = (id, transferId, supply) => ({ id, shipment_group_id: null, purchase_order_id: null,
  stock_transfer_id: transferId, basis: 'ACTUAL', status: 'ACTIVE',
  gross_amount: Math.round(supply * 1.1), supply_amount: supply, vat_amount: Math.round(supply * .1),
  invoice_date: '2026-11-07' });

/* ---------- 운임① 600,000 + 운임② 600,000 → 다 팔면 1,200,000 ---------- */
r = run({
  costs: [cost('fc1', 'po1', 600000), trCost('fc2', 't2', 600000)],
  allocations: [alloc('fc1', 100, 600000), alloc('fc2', 100, 600000)],
  buys: [buy('b1', 'po1', 100, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 100, '2026-11-03'), move('t2', '쿠팡입고', 100, '2026-11-07')],
  sales: [sale('s1', 100, '2026-11-10')] });
assert.equal(sumBySale(r), 1200000, '외부 운송비가 두 번 들었으면 두 번 다 공헌이익에서 빠져야 함');
let m = Object.fromEntries(r.records.map(x => [x.cost.id, x.allocs[0]]));
assert.equal(m.fc1.soldSupply, 600000, '처음 운임도 전액');
assert.equal(m.fc2.soldSupply, 600000, '재입고 운임도 전액');
assert.equal(m.fc1.inventorySupply + m.fc2.inventorySupply, 0);

/* ---------- 아직 안 팔렸으면 둘 다 재고원가로 남는다 ---------- */
r = run({
  costs: [cost('fc1', 'po1', 600000), trCost('fc2', 't2', 600000)],
  allocations: [alloc('fc1', 100, 600000), alloc('fc2', 100, 600000)],
  buys: [buy('b1', 'po1', 100, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 100, '2026-11-03'), move('t2', '쿠팡입고', 100, '2026-11-07')] });
assert.equal(sumBySale(r), 0);
m = Object.fromEntries(r.records.map(x => [x.cost.id, x.allocs[0]]));
assert.equal(m.fc1.inventorySupply + m.fc2.inventorySupply, 1200000, '둘 다 재고원가로');

/* ---------- 절반만 팔면 절반씩 ---------- */
r = run({
  costs: [cost('fc1', 'po1', 600000), trCost('fc2', 't2', 600000)],
  allocations: [alloc('fc1', 100, 600000), alloc('fc2', 100, 600000)],
  buys: [buy('b1', 'po1', 100, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 100, '2026-11-03'), move('t2', '쿠팡입고', 100, '2026-11-07')],
  sales: [sale('s1', 50, '2026-11-10')] });
assert.equal(sumBySale(r), 600000, '50개 판매 → (6,000+6,000)×50');

/* ---------- 반출 없이 그냥 이동만 시켜도 그 이동의 운임은 얹힌다 ---------- */
r = run({
  costs: [trCost('fc2', 't2', 300000)],
  allocations: [alloc('fc2', 50, 300000)],
  buys: [buy('b1', null, 50, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 50, '2026-11-03'), move('t2', '쿠팡입고', 50, '2026-11-07')],
  sales: [sale('s1', 50, '2026-11-10')] });
assert.equal(sumBySale(r), 300000);

/* ---------- 이동에 달린 기록은 발주 쪽 지도에 섞이지 않는다 (purchase_order_id 가 둘 다 null) ----------
   예전 키가 'null|상품' 이라 이동 기록 두 건이 서로를 덮어쓸 수 있었어요. */
r = run({
  costs: [trCost('fcA', 'tA', 100000), trCost('fcB', 'tB', 200000)],
  allocations: [alloc('fcA', 10, 100000), alloc('fcB', 20, 200000)],
  buys: [buy('b1', 'po1', 30, '2026-10-01')],
  transfers: [move('tZ', '쿠팡회수', 30, '2026-11-01'),
              move('tA', '쿠팡입고', 10, '2026-11-05'), move('tB', '쿠팡입고', 20, '2026-11-06')],
  sales: [sale('s1', 30, '2026-11-20')] });
m = Object.fromEntries(r.records.map(x => [x.cost.id, x.allocs[0]]));
assert.equal(m.fcA.soldSupply, 100000, '이동 A 의 운임은 A 에만');
assert.equal(m.fcB.soldSupply, 200000, '이동 B 의 운임은 B 에만');

/* ---------- 운임이 없는 재입고는 예전처럼 0 (회귀) ---------- */
r = run({ costs: [cost('fc1', 'po1', 600000)], allocations: [alloc('fc1', 100, 600000)],
  buys: [buy('b1', 'po1', 100, '2026-10-30')],
  transfers: [move('t1', '쿠팡회수', 100, '2026-11-03'), move('t2', '쿠팡입고', 100, '2026-11-07')],
  sales: [sale('s1', 100, '2026-11-10')] });
assert.equal(sumBySale(r), 600000, '재입고 운임을 안 넣었으면 운임① 만');

console.log('PASS: 재입고 트럭값이 이동에 직접 달려 재고원가에 얹히고, 운임①과 겹쳐 함께 차감됨');
