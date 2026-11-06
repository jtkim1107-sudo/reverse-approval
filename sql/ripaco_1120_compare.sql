-- ============================================================================
-- 리파코 10월 마감내역서 ↔ 앱의 11/20 지급예정 목록 대조
--
-- 앱 규칙(js/purchase_payments.js 머리말 · 서버 cash_purchase_terms.py 와 같은 식):
--   지급 예정일 = 매입월 다음 달 20일  →  2026-10 매입 = 2026-11-20 지급
--   상품대금    = 매입 원장(purchases) 행마다 qty × unit_cost,
--                 과세 상품이고 '매입원가 VAT 별도' 설정이면 ×1.1 후 원 단위 반올림
--   운반비는 별도 청구서 (여기 합계에 안 들어갑니다)
--
-- 공급처 마감내역서(2026-10-02 ~ 2026-10-29, 19줄) 기준값:
--   수량 1,877 · 공급가 13,707,100 · 부가세 1,370,710 · 총액 15,077,810
-- ============================================================================

-- ⓐ VAT 설정 먼저 — 금액 비교의 전제입니다
--    purchaseCostIncludesVat = false 여야 과세 상품에 ×1.1 이 붙습니다.
select value from settings where key = 'vat';


-- ⓑ 11/20 지급예정 합계 (앱 기준) — 마감내역서 총액과 바로 비교
select count(*) AS purchase_rows,
       sum(pu.qty) AS qty,
       sum(pu.amount) AS supply,
       sum(case when pr.tax_type = '과세' then round(pu.amount * 0.1) else 0 end) AS vat_est,
       sum(pu.amount) + sum(case when pr.tax_type = '과세' then round(pu.amount * 0.1) else 0 end) AS payable_est
from purchases pu
left join products pr on pr.id = pu.product_id
where pu.supplier = '리파코 주식회사'
  and pu.date::date between date '2026-10-01' and date '2026-10-31';


-- ⓒ 상품별 집계 (앱 기준) — 마감내역서 품명·수량·단가와 줄 맞춰 비교
select pr.code AS product_code, pr.name AS product_name, pr.tax_type,
       sum(pu.qty) AS qty,
       min(pu.unit_cost) AS unit_cost_min, max(pu.unit_cost) AS unit_cost_max,
       sum(pu.amount) AS supply,
       count(*) AS rows
from purchases pu
left join products pr on pr.id = pu.product_id
where pu.supplier = '리파코 주식회사'
  and pu.date::date between date '2026-10-01' and date '2026-10-31'
group by pr.code, pr.name, pr.tax_type
order by supply desc;


-- ⓓ 건별 전체 (앱 기준) — 마감내역서의 매출일자·매출번호와 1:1로 맞춰 보는 용도
select pu.date, o.po_no, pr.code AS product_code, pr.name AS product_name,
       pu.qty, pu.unit_cost, pu.amount, pu.warehouse, pu.memo, pu.created_by
from purchases pu
left join products pr on pr.id = pu.product_id
left join purchase_orders o on o.id = pu.po_id
where pu.supplier = '리파코 주식회사'
  and pu.date::date between date '2026-10-01' and date '2026-10-31'
order by pu.date, pr.code;


-- ⓔ 경계 확인 — 9월 말·11월 초 매입 (마감일 기준 차이로 다른 달에 들어갔는지)
--    마감내역서는 공급처의 '매출일자', 앱은 '입고일(purchases.date)' 이라 월말·월초가 어긋날 수 있습니다.
select pu.date, pr.code AS product_code, pr.name AS product_name, pu.qty, pu.unit_cost, pu.amount
from purchases pu
left join products pr on pr.id = pu.product_id
where pu.supplier = '리파코 주식회사'
  and (pu.date::date between date '2026-09-20' and date '2026-09-30'
    or pu.date::date between date '2026-11-01' and date '2026-11-10')
order by pu.date;


-- ⓕ 이미 자금일보에 등록된 11/20 출금 예정 (markOrdered 가 넣은 추정액)
--    발주 시점 추정치라 마감내역서와 다를 수 있고, 중복 등록도 여기서 보입니다.
select date, kind, title, amount, memo, created_by, created_at
from cash_plans
where date = date '2026-11-20'
order by created_at;
