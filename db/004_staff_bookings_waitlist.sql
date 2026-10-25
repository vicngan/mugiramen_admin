-- Bookings staff add in the portal (taken by phone, or walk-ins, who may not
-- leave a number), and a waiting list for times with no table left.
alter table public.reservations drop constraint reservations_status_check;
alter table public.reservations add constraint reservations_status_check
  check (status in ('new', 'confirmed', 'cancelled', 'noshow', 'waitlist'));
alter table public.reservations drop constraint reservations_phone_check;
alter table public.reservations add constraint reservations_phone_check
  check (phone = '' or char_length(phone) between 9 and 20);
-- web: the website's form · phone / walkin: added by staff
alter table public.reservations add column source text not null default 'web'
  check (source in ('web', 'phone', 'walkin'));
comment on column public.reservations.status is 'new (waiting for the guest or staff to confirm) | confirmed | cancelled | noshow | waitlist (asked for a full time; holds no table)';
