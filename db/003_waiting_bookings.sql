-- Online bookings now wait as "new" until the guest (from their link) or the
-- staff confirm them. The API always sets the status; this only keeps the
-- table's default in step.
alter table public.reservations alter column status set default 'new';
comment on column public.reservations.status is 'new (waiting for the guest or staff to confirm) | confirmed | cancelled | noshow';
