-- Reservations and portal settings. Only the admin API (with the project's
-- secret key) reads or writes these tables: row level security is on and
-- there are no policies, so the public API keys can't reach them.

create table public.reservations (
  id          bigint generated always as identity primary key,
  branch      text not null check (branch in ('mon-city', 'golden-palace', 'phan-chu-trinh')),
  date        date not null,
  time        text not null check (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  party_size  int  not null check (party_size between 1 and 100),
  name        text not null check (char_length(name) between 1 and 60),
  phone       text not null check (char_length(phone) between 9 and 20),
  note        text not null default '' check (char_length(note) <= 500),
  confirm_by  text not null default 'call' check (confirm_by in ('call', 'sms', 'zalo')),
  lang        text not null default 'vi' check (lang in ('vi', 'en', 'ja')),
  -- online bookings are confirmed straight away; staff can cancel or mark no-shows
  status      text not null default 'confirmed' check (status in ('new', 'confirmed', 'cancelled', 'noshow')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz,
  updated_by  text,
  notified_at timestamptz,          -- when the branch was emailed
  notify_error text,                -- why it wasn't, if it failed
  ip_hash     text                  -- for the per-visitor rate limit, never the raw address
);
create index reservations_date_branch on public.reservations (date, branch);
create index reservations_ip_recent on public.reservations (ip_hash, created_at);

-- One row per settings group (booking rules, branch contacts), edited in
-- the portal's Settings page.
create table public.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

alter table public.reservations enable row level security;
alter table public.settings enable row level security;
