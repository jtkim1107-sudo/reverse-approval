-- ============================================================================
-- 발주서(purchase_orders / purchase_order_items) ↔ 매입 원장(purchases) 대조
--
-- 왜 필요한가:
--   재고는 purchases 로만 계산되고(js/app.js loadErpBase), 발주서의 입고 수량은
--   purchase_order_items.received_qty 로 따로 관리됩니다. 둘을 맞춰 주는 제약·트리거가
--   없고, 같이 쓰는 곳은 입고 확정 saveReceive() 한 군데뿐입니다(js/app.js:9078).
--   그 함수가 purchases insert 뒤의 update 에러를 확인하지 않아서, 한쪽만 기록된 채
--   남을 수 있습니다 → "재고와 발주서 내역이 안 맞는" 상태.
--
-- 쓰는 법: Supabase 대시보드 → SQL Editor 에 ⓞ 부터 차례로 붙여 실행.
--          전부 select 만 하는 읽기 전용입니다. 아무 데이터도 바꾸지 않습니다.
--
-- 주의(설계상):
--   · received_qty 가 NULL 인 행이 있을 수 있어 전부 coalesce 로 0 처리했습니다.
--     (코드도 일관되지 않습니다 - app.js:7317 은 `|| 0`, app.js:6794/9115 는 그냥 Number)
--   · 같은 발주서에 같은 상품이 두 줄로 들어간 경우, 매입 원장은 어느 줄의 입고인지
--     구분할 수 없습니다(purchases 에 po_item_id 가 없음). 그래서 발주품목 쪽도
--     (po_id, product_id) 로 합쳐서 비교합니다.
-- ============================================================================


-- ⓞ-1 자료량 확인 — ⓞ 가 0/NULL 로 나왔을 때 '정말 맞는 것'인지 '비교할 자료가 없는 것'인지 가릅니다.
--     po_items_received_rows 와 purchases_with_po 가 둘 다 0 이면 ⓞ 의 0 은 "맞다"가 아니라
--     "입고 처리(saveReceive) 경로를 아예 안 쓰고 있다"는 뜻입니다.
select
  (select count(*) from purchase_orders)                                  AS purchase_orders,
  (select count(*) from purchase_orders where status in ('done','partial')) AS po_done_or_partial,
  (select count(*) from purchase_order_items)                             AS po_items,
  (select count(*) from purchase_order_items where coalesce(received_qty,0) > 0) AS po_items_received_rows,
  (select coalesce(sum(coalesce(received_qty,0)),0) from purchase_order_items)   AS po_received_qty_total,
  (select count(*) from purchases)                                        AS purchases_rows,
  (select count(*) from purchases where po_id is not null)                AS purchases_with_po,
  (select count(*) from purchases where po_id is null)                    AS purchases_without_po,
  (select coalesce(sum(qty),0) from purchases)                            AS purchases_qty_total,
  (select count(*) from sales)                                            AS sales_rows,
  (select count(*) from stock_transfers)                                  AS stock_transfer_rows;


-- ⓞ 먼저 이것부터: 어긋남이 있는지, 어느 방향인지 한 줄 요약
--    purchase_missing_qty > 0  → 매입(재고) 누락. 재고가 실제보다 적게 보입니다.
--    po_missing_qty       > 0  → 발주서 입고수량 누락. 발주서가 미입고로 남아 있습니다.
with po_item AS (
  select i.po_id, i.product_id, sum(coalesce(i.received_qty, 0))::numeric AS received_qty
  from purchase_order_items i
  group by i.po_id, i.product_id
), buy AS (
  select po_id, product_id, sum(qty)::numeric AS buy_qty
  from purchases where po_id is not null
  group by po_id, product_id
), diff AS (
  select coalesce(t.po_id, b.po_id) AS po_id,
         coalesce(t.received_qty, 0) - coalesce(b.buy_qty, 0) AS d
  from po_item t full join buy b on b.po_id = t.po_id and b.product_id = t.product_id
)
select count(*) filter (where d <> 0)            AS mismatched_rows,
       count(distinct po_id) filter (where d <> 0) AS mismatched_pos,
       sum(d) filter (where d > 0)               AS purchase_missing_qty,
       sum(-d) filter (where d < 0)              AS po_missing_qty
from diff;


-- ① 어긋난 건 상세 (ⓞ 에서 mismatched_rows > 0 이면 이걸로 건별 확인)
with po_item AS (
  select i.po_id, i.product_id,
         sum(i.qty)::numeric AS ordered_qty,
         sum(coalesce(i.received_qty, 0))::numeric AS received_qty,
         count(*) AS item_rows
  from purchase_order_items i
  group by i.po_id, i.product_id
), buy AS (
  select po_id, product_id,
         sum(qty)::numeric AS buy_qty, sum(amount)::numeric AS buy_amount,
         min(date) AS first_date, max(date) AS last_date, count(*) AS buy_rows
  from purchases where po_id is not null
  group by po_id, product_id
)
select o.po_no, o.supplier, o.status, o.date AS po_date,
       pr.code AS product_code, pr.name AS product_name,
       coalesce(t.ordered_qty, 0)  AS ordered_qty,
       coalesce(t.received_qty, 0) AS received_qty,
       coalesce(b.buy_qty, 0)      AS purchased_qty,
       coalesce(t.received_qty, 0) - coalesce(b.buy_qty, 0) AS diff_qty,
       case when coalesce(t.received_qty, 0) > coalesce(b.buy_qty, 0) then '매입(재고) 누락'
            when coalesce(t.received_qty, 0) < coalesce(b.buy_qty, 0) then '발주서 입고수량 누락'
       end AS verdict,
       b.first_date, b.last_date, b.buy_rows,
       case when coalesce(t.item_rows, 0) > 1
            then '같은 상품이 발주품목에 ' || t.item_rows || '줄 - 줄 단위 대조는 수동 확인 필요' end AS caveat
from po_item t
full join buy b on b.po_id = t.po_id and b.product_id = t.product_id
join purchase_orders o on o.id = coalesce(t.po_id, b.po_id)
left join products pr on pr.id = coalesce(t.product_id, b.product_id)
where coalesce(t.received_qty, 0) <> coalesce(b.buy_qty, 0)
order by abs(coalesce(t.received_qty, 0) - coalesce(b.buy_qty, 0)) desc, o.date desc;


-- ② 매입에 po_id 는 있는데 그 발주서에 그 품목이 없는 건 (입고 확정 때 품목을 잘못 고름)
select pu.id AS purchase_id, pu.date, o.po_no, o.status,
       pr.code AS product_code, pr.name AS product_name,
       pu.qty, pu.amount, pu.warehouse, pu.created_by, pu.memo
from purchases pu
join purchase_orders o on o.id = pu.po_id
left join products pr on pr.id = pu.product_id
where not exists (
  select 1 from purchase_order_items i
  where i.po_id = pu.po_id and i.product_id = pu.product_id)
order by pu.date desc;


-- ③ '입고 완료 / 부분 입고' 인데 매입 원장이 하나도 없는 발주서
--    = 발주서는 입고 처리됐는데 재고엔 전혀 안 들어간 건
select o.po_no, o.supplier, o.status, o.date AS po_date, o.due_date, o.total,
       (select sum(coalesce(i.received_qty, 0)) from purchase_order_items i where i.po_id = o.id) AS received_qty
from purchase_orders o
where o.status in ('done', 'partial')
  and not exists (select 1 from purchases pu where pu.po_id = o.id)
order by o.date desc;


-- ④ 취소·반려된 발주서인데 매입이 남아 있는 건 (재고는 늘어난 채 발주서만 취소)
select o.po_no, o.status, pu.date, pr.code AS product_code, pr.name AS product_name,
       pu.qty, pu.amount, pu.created_by
from purchases pu
join purchase_orders o on o.id = pu.po_id
left join products pr on pr.id = pu.product_id
where o.status in ('canceled', 'rejected')
order by pu.date desc;


-- ⑤ 발주서 없이 들어온 매입 (매입 직접 입력·엑셀 업로드 → 재고엔 있고 발주서엔 없음)
--    정상인 경우도 많습니다. 월별 규모만 보고 예상과 맞는지 확인하세요.
select to_char(pu.date::date, 'YYYY-MM') AS month,
       count(*) AS rows, sum(pu.qty) AS qty, sum(pu.amount) AS amount,
       string_agg(distinct pu.created_by, ', ') AS entered_by
from purchases pu
where pu.po_id is null
group by 1
order by 1 desc;


-- ⑥ 같은 입고를 두 번 확정한 흔적 (같은 발주·같은 상품·같은 날·같은 수량)
--    po_id 가 NULL 인 묶음은 수동 매입 중복 입력 의심입니다.
select o.po_no, pu.po_id, pr.code AS product_code, pr.name AS product_name,
       pu.date, pu.qty, count(*) AS rows, array_agg(pu.id) AS purchase_ids,
       array_agg(distinct pu.created_by) AS created_by
from purchases pu
left join purchase_orders o on o.id = pu.po_id
left join products pr on pr.id = pu.product_id
group by o.po_no, pu.po_id, pr.code, pr.name, pu.date, pu.qty
having count(*) > 1
order by pu.date desc;


-- ⑦ 상품별 총정리 — 발주 대비 입고·매입 (어느 상품에서 틀어졌는지 한눈에)
--    purchased_with_po 만 발주서와 비교합니다(발주서 없는 매입은 따로 표시).
with ord AS (
  select i.product_id,
         sum(i.qty) AS ordered_qty,
         sum(coalesce(i.received_qty, 0)) AS received_qty
  from purchase_order_items i
  join purchase_orders o on o.id = i.po_id
  where o.status not in ('canceled', 'rejected', 'wing_direct_review')
  group by i.product_id
), buy AS (
  select product_id,
         sum(case when po_id is not null then qty else 0 end) AS purchased_with_po,
         sum(case when po_id is null     then qty else 0 end) AS purchased_without_po
  from purchases
  group by product_id
)
select pr.code AS product_code, pr.name AS product_name, pr.id AS product_id,
       coalesce(o.ordered_qty, 0)           AS ordered_qty,
       coalesce(o.received_qty, 0)          AS received_qty,
       coalesce(b.purchased_with_po, 0)     AS purchased_with_po,
       coalesce(b.purchased_without_po, 0)  AS purchased_without_po,
       coalesce(o.received_qty, 0) - coalesce(b.purchased_with_po, 0) AS diff_qty
from products pr
left join ord o on o.product_id = pr.id
left join buy b on b.product_id = pr.id
where coalesce(o.ordered_qty, 0) <> 0 or coalesce(b.purchased_with_po, 0) <> 0
   or coalesce(b.purchased_without_po, 0) <> 0
order by abs(coalesce(o.received_qty, 0) - coalesce(b.purchased_with_po, 0)) desc, pr.code;


-- ⑧ 매입의 po_id 가 가리키는 발주서가 아예 없는 건 (발주서 삭제 등 - ①에서는 안 보입니다)
select pu.id AS purchase_id, pu.po_id, pu.date, pr.code AS product_code, pr.name AS product_name,
       pu.qty, pu.amount, pu.memo, pu.created_by
from purchases pu
left join purchase_orders o on o.id = pu.po_id
left join products pr on pr.id = pu.product_id
where pu.po_id is not null and o.id is null
order by pu.date desc;


-- ============================================================================
-- 여기서부터는 "발주서는 맞는데 재고가 안 맞는" 경우용 (ⓞ 가 0 으로 나왔을 때)
-- js/app.js loadErpBase() 의 재고 계산식을 그대로 SQL 로 옮긴 것입니다.
-- ============================================================================

-- ⑨ 쿠팡 재고 추적 누락 — 이동 기록(stock_transfers) 없이 팔린 쿠팡 재고
--    앱 계산식: 쿠팡재고 = 쿠팡직송매입 + 이동(쿠팡입고 − 쿠팡회수) − 쿠팡판매
--    stock_transfers 가 0 건이면 이동분이 전부 0 이라, 창고에서 쿠팡으로 보낸 물량이
--    쿠팡 재고로 잡히지 않고 자사창고에 남아 있는 것으로 보입니다.
--      coupang_untracked > 0  → 그만큼 쿠팡에서 팔렸는데 쿠팡 입고 기록이 없음
--                               (앱은 Math.max(0, ...) 로 0 에 눌러 버려 화면에선 안 보임)
--      in_house 가 실제보다 큼 → 자사창고 재고가 부풀어 보임
--
--    주의: 반품 재판매 SKU 제외와 매출 중복제거(dedupeAutoOverManualSales)는 반영하지
--          않았습니다. 앱 화면 숫자와 몇 개 단위로 다를 수 있고, 규모 판단용입니다.
with map AS (
  select p.id AS product_id,
         case when p.set_parent_id is not null and coalesce(p.set_qty, 0) > 0
              then p.set_parent_id else p.id end AS base_id,
         (case when p.set_parent_id is not null and coalesce(p.set_qty, 0) > 0
               then p.set_qty else 1 end)::numeric AS mult
  from products p
), sale AS (
  select m.base_id,
         sum(s.qty * m.mult) AS sold_all,
         sum(case when coalesce(c.ship_type,
                                case when s.channel like '%쿠팡%' then '풀필먼트' else '' end) = '풀필먼트'
                  then s.qty * m.mult else 0 end) AS sold_coupang
  from sales s
  join map m on m.product_id = s.product_id
  left join sales_channels c on c.name = s.channel
  where s.date::date <= current_date
  group by m.base_id
), buy AS (
  -- 앱과 똑같이 '기준상품에 직접 달린 매입'만 셉니다(세트상품에 달린 매입은 ⑩ 에서 따로)
  select pu.product_id AS base_id,
         sum(case when pu.warehouse = '쿠팡' then pu.qty else 0 end) AS bought_coupang,
         sum(case when pu.warehouse is distinct from '쿠팡' then pu.qty else 0 end) AS bought_house
  from purchases pu
  where pu.date::date <= current_date
  group by pu.product_id
), cancel AS (
  select m.base_id, sum(coalesce(v.stock_effect_qty, 0) * m.mult) AS cancel_effect
  from sales_cancel_stock_by_product v
  join map m on m.product_id = v.product_id
  group by m.base_id
)
select p.code AS product_code, p.name AS product_name,
       coalesce(b.bought_coupang, 0) AS bought_coupang,
       coalesce(b.bought_house, 0)   AS bought_house,
       coalesce(s.sold_coupang, 0)   AS sold_coupang,
       coalesce(s.sold_all, 0) - coalesce(s.sold_coupang, 0) AS sold_house,
       coalesce(cn.cancel_effect, 0) AS cancel_effect,
       coalesce(b.bought_coupang, 0) - (coalesce(s.sold_coupang, 0) - coalesce(cn.cancel_effect, 0)) AS at_coupang_raw,
       greatest(0, -(coalesce(b.bought_coupang, 0) - (coalesce(s.sold_coupang, 0) - coalesce(cn.cancel_effect, 0)))) AS coupang_untracked,
       coalesce(b.bought_house, 0) - (coalesce(s.sold_all, 0) - coalesce(s.sold_coupang, 0)) AS in_house,
       coalesce(b.bought_coupang, 0) + coalesce(b.bought_house, 0)
         - (coalesce(s.sold_all, 0) - coalesce(cn.cancel_effect, 0)) AS stock_total
from products p
left join buy b  on b.base_id = p.id
left join sale s on s.base_id = p.id
left join cancel cn on cn.base_id = p.id
where (p.set_parent_id is null or coalesce(p.set_qty, 0) = 0)
  and (coalesce(b.bought_coupang, 0) <> 0 or coalesce(b.bought_house, 0) <> 0 or coalesce(s.sold_all, 0) <> 0)
order by coupang_untracked desc, stock_total;


-- ⑩ 연동 세트상품에 직접 달린 매입 — 앱 재고 계산에서 통째로 빠집니다
--    loadErpBase() 는 기준상품(set_parent_id 가 없는 것)의 매입만 셉니다.
--    세트상품 id 로 매입이 들어가 있으면 그 수량은 재고 어디에도 반영되지 않습니다.
select pr.code AS product_code, pr.name AS product_name,
       pr.set_parent_id, pr.set_qty,
       count(*) AS purchase_rows, sum(pu.qty) AS qty, sum(pu.amount) AS amount,
       min(pu.date) AS first_date, max(pu.date) AS last_date
from purchases pu
join products pr on pr.id = pu.product_id
where pr.set_parent_id is not null and coalesce(pr.set_qty, 0) > 0
group by pr.code, pr.name, pr.set_parent_id, pr.set_qty
order by qty desc;


-- ============================================================================
-- 매입이 전량 warehouse='쿠팡'(공급처 직송)인 경우용
--   boughtHouse 가 0 이므로 inHouse = −houseSold 가 됩니다.
--   즉 '풀필먼트'로 분류되지 않은 판매가 한 건이라도 있으면 자사창고 재고가 바로 음수가 되고,
--   그만큼이 쿠팡 재고에서는 안 빠져서 쿠팡 재고가 실제보다 많아 보입니다.
-- ============================================================================

-- ⑪ 채널별 분류 결과 — isCoupangPoolSale() 과 같은 규칙
--      등록된 채널이면 ship_type='풀필먼트' 인지로만 판단하고,
--      등록 안 된 채널이면 이름에 '쿠팡'이 들어가는지로 판단합니다(app.js:2762).
--      verdict='자사창고 차감' 인데 판매량이 큰 채널이 있으면 그게 원인입니다.
select s.channel,
       count(*) AS sale_rows,
       sum(s.qty) AS qty,
       min(s.date) AS first_date, max(s.date) AS last_date,
       (c.name is not null) AS channel_registered,
       c.ship_type,
       case when c.name is not null then
              case when c.ship_type = '풀필먼트' then '쿠팡재고 차감' else '자사창고 차감' end
            else
              case when s.channel like '%쿠팡%' then '쿠팡재고 차감(이름 추정)' else '자사창고 차감' end
       end AS verdict
from sales s
left join sales_channels c on c.name = s.channel
group by s.channel, c.name, c.ship_type
order by qty desc;


-- ⑫ 등록된 채널 목록 그대로 (ship_type 이 비었거나 오타면 여기서 보입니다)
select name, ship_type, created_at from sales_channels order by created_at;


-- ⑬ 상품별 자사창고 재고 — 매입이 전량 쿠팡 직송이면 '자사창고 차감' 판매량만큼 음수가 됩니다
with map AS (
  select p.id AS product_id,
         case when p.set_parent_id is not null and coalesce(p.set_qty, 0) > 0
              then p.set_parent_id else p.id end AS base_id,
         (case when p.set_parent_id is not null and coalesce(p.set_qty, 0) > 0
               then p.set_qty else 1 end)::numeric AS mult
  from products p
), sale AS (
  select m.base_id,
         sum(s.qty * m.mult) AS sold_all,
         sum(case when case when c.name is not null then c.ship_type = '풀필먼트'
                           else s.channel like '%쿠팡%' end
                  then s.qty * m.mult else 0 end) AS sold_coupang
  from sales s
  join map m on m.product_id = s.product_id
  left join sales_channels c on c.name = s.channel
  where s.date::date <= current_date
  group by m.base_id
), buy AS (
  select pu.product_id AS base_id,
         sum(case when pu.warehouse = '쿠팡' then pu.qty else 0 end) AS bought_coupang,
         sum(case when pu.warehouse is distinct from '쿠팡' then pu.qty else 0 end) AS bought_house
  from purchases pu
  where pu.date::date <= current_date
  group by pu.product_id
)
select p.code AS product_code, p.name AS product_name,
       coalesce(b.bought_coupang, 0) AS bought_coupang,
       coalesce(b.bought_house, 0)   AS bought_house,
       coalesce(s.sold_coupang, 0)   AS sold_coupang,
       coalesce(s.sold_all, 0) - coalesce(s.sold_coupang, 0) AS sold_house,
       coalesce(b.bought_house, 0) - (coalesce(s.sold_all, 0) - coalesce(s.sold_coupang, 0)) AS in_house,
       coalesce(b.bought_coupang, 0) - coalesce(s.sold_coupang, 0) AS at_coupang_raw,
       coalesce(b.bought_coupang, 0) + coalesce(b.bought_house, 0) - coalesce(s.sold_all, 0) AS stock_total
from products p
left join buy b  on b.base_id = p.id
left join sale s on s.base_id = p.id
where (p.set_parent_id is null or coalesce(p.set_qty, 0) = 0)
  and (coalesce(b.bought_coupang, 0) <> 0 or coalesce(b.bought_house, 0) <> 0 or coalesce(s.sold_all, 0) <> 0)
order by in_house, stock_total;
