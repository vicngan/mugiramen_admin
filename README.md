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
4. Give it its own domain, for example `admin.mugi.vn`. Every page is sent
   with `noindex` so search engines skip it.

The Umami calls are written against Umami's v2 API but have not been run
against a live account yet. Check the Settings page once the key is set.

## Not built yet

Reservations, job applications and staff accounts are sample data. They need
a database. Until then, drafts of unpublished edits are kept in the browser.
