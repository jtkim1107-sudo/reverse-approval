-- ============================================================================
-- 2단계 마이그레이션 — 재입고(창고→쿠팡 이동)에 입고 운송비 달기
--
-- ✅ 2026-11-06 적용 완료 (Supabase SQL Editor, 대표 승인 후 실행)
--    확인: shipment_group_id nullable=YES · inbound_plan_id nullable=YES
--          source_ck convalidated=true · fn_add_reinbound_freight 생성(security definer)
--          실행 권한 postgres / authenticated / service_role (anon 제거)
-- 2026-11-06 실제 스키마를 조회해서 다시 쓴 판(앞의 초안은 추측이었고 틀린 데가 있었어요)
--
-- 이미 적용돼 있는 것 (다시 안 해도 됩니다)
--   · inbound_freight_costs.stock_transfer_id uuid  → stock_transfers(id) ON DELETE RESTRICT
--   · inbound_freight_costs_source_ck  CHECK (num_nonnulls(purchase_order_id, stock_transfer_id) = 1)  ※ NOT VALID
--   · inbound_freight_costs_transfer_active_uq  (stock_transfer_id) WHERE ACTIVE
--   · purchase_order_id · purchase_order_item_id 는 원래부터 nullable
--
-- 아직 막혀 있는 것 (아래 ①②③ 가 그것)
--   · inbound_freight_costs.shipment_group_id 가 NOT NULL
--       → 운송 묶음은 purchase_order_id·센터·슬롯이 전부 NOT NULL 이라 재입고에는 만들 수 없음
--   · inbound_freight_allocations.inbound_plan_id 가 NOT NULL
--       → 재입고에는 입고 계획(inbound_plans)이 없음
--   · RLS 가 SELECT 만 허용 (ifc_select_authenticated · ifa_select_authenticated)
--       → 앱에서 insert 가 안 되므로 SECURITY DEFINER 함수로 넣어야 함
--
-- 지켜야 하는 기존 규칙
--   · trg_check_inbound_freight_cost_sum (DEFERRABLE INITIALLY DEFERRED)
--     배분 합계 = supply_amount 여야 함 → 한 트랜잭션 안에서 cost + allocation 을 같이 넣으면 통과
--   · chk_inbound_freight_split : supply + vat = gross
--   · allocated_supply 는 0 이상 정수 · pallet_count > 0 · total_pallet_count > 0
--   · basis='ACTUAL' 이면 invoice_date 필수
-- ============================================================================

begin;

-- ① 재입고 운송비는 운송 묶음(발주 기준)에 속하지 않습니다.
alter table public.inbound_freight_costs alter column shipment_group_id drop not null;
-- UNIQUE(shipment_group_id) 는 그대로 둡니다 - Postgres 는 NULL 을 여러 번 허용하므로
-- 재입고 기록끼리 충돌하지 않고, 발주 기준 기록의 '묶음당 1건' 규칙은 유지됩니다.

-- ② 재입고 배분에는 입고 계획이 없습니다.
alter table public.inbound_freight_allocations alter column inbound_plan_id drop not null;

-- ③ 둘 중 하나만 채우는 규칙을 정식 확정 (위반 행 0건 확인함)
alter table public.inbound_freight_costs validate constraint inbound_freight_costs_source_ck;

-- ④ 재입고 운송비 등록 함수 - RLS 가 SELECT 만 허용하므로 이 함수로만 넣습니다.
--    한 트랜잭션에서 cost + allocation 을 같이 넣어 합계 트리거를 통과시킵니다.
create or replace function public.fn_add_reinbound_freight(
  p_transfer_id   uuid,
  p_gross         numeric,
  p_vat           numeric,
  p_pallet_count  integer,
  p_basis         text default 'ESTIMATE',
  p_invoice_ref   text default null,
  p_invoice_date  date default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_tr      stock_transfers%rowtype;
  v_supply  numeric;
  v_id      uuid;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = '로그인이 필요합니다.';
  end if;

  select * into v_tr from stock_transfers where id = p_transfer_id;
  if not found then
    raise exception using errcode = '23503', message = '그 재고 이동 기록을 찾지 못했습니다.';
  end if;
  if v_tr.kind <> '쿠팡입고' then
    raise exception using errcode = '23514',
      message = format('창고 → 쿠팡 입고 이동에만 운송비를 달 수 있어요(받은 값: %s).', v_tr.kind);
  end if;

  v_supply := p_gross - coalesce(p_vat, 0);
  if p_gross is null or p_gross <= 0 or coalesce(p_vat, 0) < 0 or v_supply < 0 then
    raise exception using errcode = '23514', message = '결제 총액과 매입 VAT 를 확인해 주세요.';
  end if;
  if v_supply <> round(v_supply) then
    raise exception using errcode = '23514', message = '공급가액이 원 단위 정수가 아닙니다.';
  end if;
  if p_pallet_count is null or p_pallet_count <= 0 then
    raise exception using errcode = '23514', message = 'PLT 는 1 이상이어야 합니다.';
  end if;
  if p_basis not in ('ESTIMATE', 'ACTUAL') then
    raise exception using errcode = '23514', message = 'basis 는 ESTIMATE 또는 ACTUAL 이어야 합니다.';
  end if;
  if p_basis = 'ACTUAL' and p_invoice_date is null then
    raise exception using errcode = '23514', message = '실제 청구로 넣으려면 청구 일자가 필요합니다.';
  end if;

  -- 같은 이동에 살아 있는 운송비가 이미 있으면 막습니다(인덱스도 막지만 메시지를 또렷하게).
  if exists (select 1 from inbound_freight_costs
             where stock_transfer_id = p_transfer_id and coalesce(status, 'ACTIVE') = 'ACTIVE') then
    raise exception using errcode = '23505', message = '이 재입고에는 이미 운송비가 등록돼 있습니다.';
  end if;

  insert into inbound_freight_costs (
    shipment_group_id, purchase_order_id, stock_transfer_id,
    basis, gross_amount, supply_amount, vat_amount,
    allocation_basis, total_pallet_count, carrier_invoice_ref, invoice_date, status, audit)
  values (
    null, null, p_transfer_id,
    p_basis, p_gross, v_supply, coalesce(p_vat, 0),
    'PLT', p_pallet_count, p_invoice_ref, p_invoice_date, 'ACTIVE',
    jsonb_build_array(jsonb_build_object(
      'at', now(), 'by', coalesce(auth.jwt() ->> 'email', auth.uid()::text),
      'what', 'reinbound_freight_added', 'transfer', p_transfer_id)))
  returning id into v_id;

  -- 이동 1건 = 상품 1개라 배분도 한 줄. 합계가 공급가액과 정확히 같아 트리거를 통과합니다.
  insert into inbound_freight_allocations (
    freight_cost_id, inbound_plan_id, purchase_order_item_id, product_id,
    sort_order, pallet_count, qty, allocated_supply, rounding_adjusted)
  values (v_id, null, null, v_tr.product_id, 1, p_pallet_count, v_tr.qty::integer, v_supply, false);

  return v_id;
end;
$fn$;

revoke all on function public.fn_add_reinbound_freight(uuid, numeric, numeric, integer, text, text, date) from public;
-- Supabase 는 ALTER DEFAULT PRIVILEGES 로 새 함수에 anon EXECUTE 를 자동으로 붙입니다.
-- PUBLIC 경유가 아니라 직접 부여된 권한이라 위 revoke 로는 안 빠져요 - 따로 거둬들입니다.
-- (함수 안에서 auth.uid() 로도 막고 있지만, 쓰기 함수를 비로그인에 열어 둘 이유가 없습니다.)
revoke execute on function public.fn_add_reinbound_freight(uuid, numeric, numeric, integer, text, text, date) from anon;
grant execute on function public.fn_add_reinbound_freight(uuid, numeric, numeric, integer, text, text, date) to authenticated;

commit;


-- ⑤ 적용 확인
select
  (select is_nullable from information_schema.columns
    where table_schema='public' and table_name='inbound_freight_costs' and column_name='shipment_group_id') AS costs_group_nullable,
  (select is_nullable from information_schema.columns
    where table_schema='public' and table_name='inbound_freight_allocations' and column_name='inbound_plan_id') AS alloc_plan_nullable,
  (select convalidated from pg_constraint where conname='inbound_freight_costs_source_ck') AS source_ck_validated,
  (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname='fn_add_reinbound_freight') AS rpc_created,
  (select jsonb_agg(grantee||':'||privilege_type) from information_schema.routine_privileges
    where routine_schema='public' and routine_name='fn_add_reinbound_freight') AS grants;


-- ============================================================================
-- 되돌리기
-- ============================================================================
-- begin;
-- drop function if exists public.fn_add_reinbound_freight(uuid, numeric, numeric, integer, text, text, date);
-- -- 아래 둘은 그 사이 들어간 NULL 행을 먼저 지운 뒤에만 됩니다.
-- -- delete from inbound_freight_costs where stock_transfer_id is not null;
-- -- alter table public.inbound_freight_allocations alter column inbound_plan_id set not null;
-- -- alter table public.inbound_freight_costs alter column shipment_group_id set not null;
-- commit;


-- ============================================================================
-- RPC 동작 점검 (선택) — 일부러 예외를 던져 전부 되돌리므로 데이터가 남지 않습니다.
-- 2026-11-06 실행 결과: gross 110,000 = supply 100,000 + vat 10,000 ·
--   allocated_supply = supply_amount (지연 합계 트리거 immediate 로 확인) ·
--   shipment_group_id NULL · purchase_order_id NULL · stock_transfer_id 연결됨 · inbound_plan_id NULL
-- ============================================================================
-- do $$
-- declare v_tr uuid; v_f uuid; v_msg text;
-- begin
--   perform set_config('request.jwt.claims', '{"sub":"11111111-1111-1111-1111-111111111111"}', true);
--   insert into stock_transfers (date, product_id, qty, kind, memo, created_by)
--     select current_date, id, 10, '쿠팡입고', 'RPC 점검(롤백)', 'check' from products limit 1
--     returning id into v_tr;
--   v_f := fn_add_reinbound_freight(v_tr, 110000, 10000, 2);
--   set constraints all immediate;   -- 지연된 합계 트리거를 지금 바로 돌려 확인
--   select jsonb_pretty(to_jsonb(x)) into v_msg from (
--     select c.gross_amount, c.supply_amount, c.vat_amount, c.basis, c.status,
--            (c.shipment_group_id is null) as grp_null, (c.purchase_order_id is null) as po_null,
--            (c.stock_transfer_id = v_tr) as linked,
--            a.qty, a.pallet_count, a.allocated_supply, (a.inbound_plan_id is null) as plan_null
--     from inbound_freight_costs c join inbound_freight_allocations a on a.freight_cost_id = c.id
--     where c.id = v_f) x;
--   raise exception 'CHECK_RESULT %', v_msg;
-- end $$;
