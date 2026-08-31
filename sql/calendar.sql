-- 공용 일정 (회사 전체가 같이 보는 캘린더)
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 한 번만 실행하세요.

create table if not exists public.events (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  category    text not null default '기타',   -- 회의 / 출장 / 휴가 / 납품·입고 / 행사 / 기타
  start_date  date not null,
  end_date    date,                           -- 여러 날 걸치는 일정. 비우면 하루짜리
  start_time  time,                           -- 비우면 '종일'
  end_time    time,
  place       text default '',
  memo        text default '',
  creator_id  uuid references auth.users(id) on delete set null,
  created_by  text default '',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  -- 종료일이 시작일보다 앞서면 달력에서 아예 안 보이므로 아예 막는다
  constraint events_dates_ok check (end_date is null or end_date >= start_date)
);

create index if not exists events_start_date_idx on public.events (start_date);

-- 로그인한 직원만 읽고 쓸 수 있게 (다른 표들과 같은 방식)
alter table public.events enable row level security;

drop policy if exists "events_all_for_authenticated" on public.events;
create policy "events_all_for_authenticated" on public.events
  for all to authenticated using (true) with check (true);
