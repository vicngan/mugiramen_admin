# MUGI admin portal

The staff portal for the MUGI Ramen & Izakaya website. It's a separate repo
and a separate Netlify site from the public website
([mugiramen_webpage](https://github.com/vicngan/mugiramen_webpage)).

Staff edit the website's text, photos and menu, post news and job openings,
and handle reservations and settings. Everything they publish is written to
`content/site.json` in the website's repo as a git commit, so it behaves like
a developer push: it shows in `git log`, can be restored, and Netlify redeploys
the public site.

## How the two fit together

```
admin (this repo, e.g. admin.mugi.vn)          website repo (mugi.vn)
  index.html        the portal                   index.html      template
  api/*  ──── GitHub commit ───────────────────▶ content/site.json
  site/* ──── proxy (same address) ◀──────────── the live website
```

The public site appears under `/site/` on the admin's own address. The editor's
preview needs this: click-to-edit and the accessibility checks have to read the
page, and browsers only allow that when both are on one address.

## Running locally

Check out the website repo next to this one (`../mugi_landing`), then:

```sh
node tools/server.mjs
# admin: http://localhost:4321/
# site:  http://localhost:4321/site/   (served from ../mugi_landing)
```

Locally, publishing commits to that website checkout. Set `SITE_DIR` to use
another path. Without the server (for example, opening `index.html` as a
file), the portal runs in demo mode and nothing is saved.

## Files

- `index.html`: the whole portal (views, styles, logic).
- `lib/api.mjs`: the API routes, shared by the local server and Netlify.
- `lib/publish.mjs`: content validation and the git backends (local
  checkout or GitHub).
- `lib/stats.mjs`: visitor numbers from Umami.
- `lib/reservations.mjs`: online booking rules, settings and the branch email.
- `lib/db.mjs`: storage for bookings and settings (Supabase, or files in
  `data/` when running locally).
- `db/*.sql`: the database tables, applied in order.
- `netlify/functions/api.mjs`: the API on Netlify.
- `tools/server.mjs`: the local dev server.

## Deploying on Netlify

1. Create a new Netlify site from this repo. `netlify.toml` sets everything
   (no build command).
2. In `netlify.toml`, set the `/site/*` proxy target to the public website's
   address (it ships as `https://mugi-site.netlify.app`).
3. Under **Site configuration → Environment variables**, add:
   - `ADMIN_PASSWORD`: the sign-in password (required; without it, sign-in
     is refused).
   - `GITHUB_TOKEN`: a fine-grained token for the website repo only, with
     *Contents: read and write*.
   - `GITHUB_REPO`: `vicngan/mugiramen_webpage`.
   - `GITHUB_BRANCH`: optional, defaults to `main`. It must be the branch the
     website deploys from.
   - `SESSION_SECRET`: optional, any long random string. Changing it (or the
     token or password) signs everyone out.
   - `UMAMI_API_KEY`, `UMAMI_WEBSITE_ID`: optional, for real visitor numbers
     in Settings → Website & data.
   - `SUPABASE_URL`, `SUPABASE_SECRET_KEY`: the reservations database (see
     below). Without them, the booking form can't take bookings.
   - `RESEND_API_KEY`, `NOTIFY_FROM`: optional, to email each branch its new
     bookings (for example `MUGI <booking@mugi.vn>`). `ADMIN_URL`: optional,
     this portal's address, linked in those emails.
4. Give it its own domain, for example `admin.mugi.vn`. Every page is sent
   with `noindex` so search engines skip it.

The Umami calls are written against Umami's v2 API but have not been run
against a live account yet. Check the Settings page once the key is set.

## Reservations

The website's booking form posts to its own `/api/reservations`, which its
Netlify proxy passes to this API. A booking that meets the rules in
Settings → Booking (party size, how far ahead, last booking times, closed
days) is stored as confirmed straight away, and the branch's email in
Settings gets a message. Staff see new bookings within a minute (the
Reservations page can also turn on desktop alerts) and can cancel or mark
no-shows. Each visitor can send at most 5 bookings in 10 minutes.

The database is the Supabase project `mugi` (Singapore). Its tables are in
`db/`; row level security is on with no policies, so only this API, with the
secret key, can reach them. Find the key under Project settings → API keys →
Secret keys, and put it in Netlify (or in `.env` for local testing, together
with `SUPABASE_URL`). Locally, without those, bookings go to `data/`.

## Not built yet

Job applications and staff accounts are still sample data, and drafts of
unpublished edits are kept in the browser. Guest messages (SMS/Zalo) and Zalo
alerts to branches aren't connected.
# mugiramen_admin
