-- Staff accounts for the admin portal. Like the other tables, only the admin
-- API (with the secret key) can reach it.
--
-- status: pending  — asked to join from the sign-in page, waiting for an owner
--         invited  — added by an owner, hasn't set a password yet
--         active   — can sign in
--         disabled — access removed (kept so their name stays on old changes)

create table public.staff (
  id             uuid primary key default gen_random_uuid(),
  email          text not null check (email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$'),
  name           text not null check (char_length(name) between 1 and 80),
  role           text not null default 'staff' check (role in ('owner', 'manager', 'staff')),
  branch         text not null default 'all' check (branch in ('all', 'office', 'mon-city', 'golden-palace', 'phan-chu-trinh')),
  perms          jsonb not null default '{}',
  status         text not null default 'invited' check (status in ('pending', 'invited', 'active', 'disabled')),
  password_hash  text,
  -- bumped to sign someone out everywhere (removed, password changed)
  token_version  int not null default 0,
  invite_hash    text,              -- sha256 of the one-time set-password link
  invite_expires timestamptz,
  failed_logins  int not null default 0,
  locked_until   timestamptz,
  last_login     timestamptz,
  created_at     timestamptz not null default now(),
  created_by     text
);
create unique index staff_email on public.staff (lower(email));
create index staff_invite on public.staff (invite_hash) where invite_hash is not null;

alter table public.staff enable row level security;
