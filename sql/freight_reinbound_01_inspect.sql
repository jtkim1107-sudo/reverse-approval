-- ============================================================================
-- 2단계 준비 ① 스키마 확인 (읽기 전용 · 아무것도 바꾸지 않음)
--
-- 재입고(창고→쿠팡 이동)에 입고 운송비를 달려면 inbound_freight_costs 에 연결 컬럼이
-- 필요합니다. 그런데 지금 그 표에 어떤 NOT NULL·CHECK·트리거·RLS 가 걸려 있는지에 따라
-- 마이그레이션 내용이 달라져서, 먼저 이걸 돌려 결과를 주세요.
-- 다섯 개를 순서대로 실행하고 결과를 그대로 붙여 주시면 됩니다.
-- ============================================================================

-- ⒜ 컬럼 (NOT NULL·기본값·생성컬럼 여부)
select table_name, ordinal_position AS pos, column_name, data_type,
       is_nullable, column_default, is_generated, generation_expression
from information_schema.columns
where table_schema = 'public'
  and table_name in ('inbound_freight_costs', 'inbound_freight_allocations', 'stock_transfers')
order by table_name, ordinal_position;


-- ⒝ 제약조건 (PK·FK·UNIQUE·CHECK) — 합계 검사가 여기 있을 가능성이 큽니다
select conrelid::regclass::text AS table_name, conname AS constraint_name,
       pg_get_constraintdef(oid) AS definition
from pg_constraint
where conrelid::regclass::text in ('inbound_freight_costs', 'inbound_freight_allocations', 'stock_transfers')
order by 1, 2;


-- ⒞ 트리거 (배분 합계 검증·감사로그 등이 트리거로 걸려 있을 수 있습니다)
select event_object_table AS table_name, trigger_name, action_timing, event_manipulation,
       action_statement
from information_schema.triggers
where event_object_schema = 'public'
  and event_object_table in ('inbound_freight_costs', 'inbound_freight_allocations')
order by 1, 2;


-- ⒟ RLS 정책 (앱에서 insert 가 되는지 — 지금은 읽기만 하고 있어서 확인이 필요합니다)
select tablename, policyname, cmd, roles::text, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('inbound_freight_costs', 'inbound_freight_allocations', 'stock_transfers')
order by tablename, policyname;


-- ⒠ 운송비 관련 함수 (fn_set_inbound_freight_actual 등 — 새 기록도 함수로 만들어야 할 수 있습니다)
select p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS args,
       pg_get_function_result(p.oid) AS returns
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (p.proname like '%freight%' or p.proname like '%inbound%')
order by 1;
