# បាល់ទាត់ផ្ទាល់ — soccer-live

Khmer-language football livestream site: a live/upcoming/finished match table (fixtures from ESPN's
public scoreboard API), match pages with a video player, three sponsor slots and anonymous comments, and a
password-protected admin page. Production URL: **https://soccer.dybladex.online**.

- Node.js 22 + Express 4, SQLite (`better-sqlite3`, WAL), no build step, vanilla HTML/CSS/JS.
- No registration or sign-in for visitors. The only login is `/admin`.

## Layout

```
server.js            Express app: pages, public API, admin API, rate limits, sessions
espn.js              ESPN scoreboard client + in-memory cache (per league/date, TTL 60 s)
db.js                SQLite schema + queries (comments, streams, banners, settings)
config.json          League slugs, cache TTLs, time window (edit to add/remove leagues)
public/
  index.html         Home: match table
  match.html         Match page (server injects title + initial data)
  admin.html         Admin page
  css/app.css        All styles (dark theme, mobile-first)
  js/common.js       Shared helpers + all Khmer UI strings
  js/home.js         Match table, 30 s refresh, 1 s countdowns
  js/match.js        Player (iframe / HLS via hls.js CDN), sponsor slots, comments (8 s polling)
  js/admin.js        Admin UI
scripts/smoke.sh     End-to-end verification (API + headless Chrome)
scripts/browser-check.mjs  Dependency-free Chrome DevTools Protocol UI check used by smoke.sh
```

## Configuration

| Env var          | Required | Notes |
|------------------|----------|-------|
| `ADMIN_PASSWORD` | **yes**  | Server refuses to start without it. |
| `SESSION_SECRET` | recommended | Signs the admin cookie. Random per process if unset (admin is logged out on restart). |
| `IP_SALT`        | recommended | Salt for `sha256(ip + salt)` comment hashes. Random per process if unset. |
| `PORT`           | no | Default `3000`. |
| `DATA_DIR`       | no | SQLite location (`soccer.db`). Default `./data`. |
| `UPLOADS_DIR`    | no | Banner images. Default `$DATA_DIR/uploads`; the Docker image sets `/app/uploads`. |

Generate secrets with `openssl rand -hex 32`. A local `.env` file is loaded automatically if present
(existing environment variables win).

## Run locally

```bash
npm install
ADMIN_PASSWORD=change-me SESSION_SECRET=$(openssl rand -hex 32) IP_SALT=$(openssl rand -hex 32) npm start
# http://localhost:3000  ·  http://localhost:3000/admin
```

## Deploy (Docker)

```bash
cp .env.example .env        # fill ADMIN_PASSWORD, SESSION_SECRET, IP_SALT
mkdir -p data uploads && sudo chown 1000:1000 data uploads   # container runs as uid 1000 (node)
docker compose up -d --build
curl -s http://127.0.0.1:8117/healthz
```

The container listens on `127.0.0.1:8117` only; expose it through the Cloudflare tunnel
(`soccer.dybladex.online → http://127.0.0.1:8117`). Express runs with `trust proxy = 1`, and the
visitor IP is taken from `CF-Connecting-IP` **only** when the TCP peer is loopback/private (i.e. the
request came through the local proxy), so the header can't be spoofed from outside.

Backups: copy `data/soccer.db*` (WAL mode — use `sqlite3 data/soccer.db ".backup out.db"` for a
consistent copy) and `uploads/`.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | `{"ok":true}` |
| GET | `/api/matches` | `{updatedAt, matches:[Match]}` — live first, then kickoff ascending; window now−6 h … now+7 d |
| GET | `/api/match/:id` | `{match, stream:{url,kind}\|null}`; `kind` = `hls` (`.m3u8`) or `embed` (iframe) |
| GET | `/api/match/:id/comments?after=<id>` | `{comments:[{id,name,body,createdAt}], count}` ascending, max 200 |
| POST | `/api/match/:id/comments` | `{name?, body}` → 201. 1 comment / 10 s per IP hash (429 otherwise) |
| GET | `/api/slots` | `{showAdPlaceholders, slots:[Banner]}` (public sponsor-slot config) |
| POST | `/api/admin/login` | `{password}` → 200 + `sid` cookie (HttpOnly, SameSite=Lax, signed); 5 failed tries / 15 min / IP |
| POST | `/api/admin/logout` | |
| GET | `/api/admin/state` | `{streams, banners, matches, settings}` (matches: live + upcoming, next 7 days) |
| POST | `/api/admin/stream` | `{matchId, url}`; empty `url` deletes. Accepts a URL or pasted `<iframe src=…>` code |
| POST | `/api/admin/banner` | multipart `slot`, `linkUrl`, optional `image` (PNG/JPG/GIF/WebP ≤ 3 MB) — or JSON `{slot, type:"html", html}` |
| DELETE | `/api/admin/banner/:slot` | |
| POST | `/api/admin/settings` | `{showAdPlaceholders: boolean}` |

Match: `{id, kickoff, state: pre|in|post, clock, statusDetail, league:{name,logo}, home:{name,short,logo,score}, away:{…}, hasStream}`.

## Fixtures & caching

- Each league in `config.json` is queried for the UTC dates yesterday/today/tomorrow
  (`publicDayOffsets`), all requests in parallel, 8 s timeout each.
- Cache entries are per league+date, TTL 60 s. Stale data (≤ 5 min) is served instantly while it
  refreshes in the background; a failed request keeps the last good payload and retries after 20 s.
  `/api/matches` never returns 500.
- The admin match list additionally fetches days +2…+7 (`adminExtraDayOffsets`, 10-minute TTL) so
  stream links can be prepared a week ahead. That fetch only happens when the admin page is open.

## Sponsor slots

| Slot | Position | Desktop (≥ 860 px) | Mobile |
|---|---|---|---|
| 1 | directly above the player, full width | 970×90 max | 320×100 fluid |
| 2 | below the player, left half | 728×90 ratio, 50 % width | full width, stacked |
| 3 | below the player, right half | 728×90 ratio, 50 % width | full width, under slot 2 |

Space is reserved with `aspect-ratio`, so loading a banner never shifts the layout. Image banners
render as `<a target="_blank" rel="noopener sponsored">`. HTML banners are injected as-is and their
`<script>` tags are executed, so **only paste ad code you trust** — it runs with full access to the
public pages. Admin previews show HTML ad code as text and never execute it.

## Verification

```bash
bash scripts/smoke.sh
```

Starts the server on `:18117` with a throwaway `/tmp/soccer-smoke` data dir, tests the API
(including rate limits, admin login, stream + banner upload), drives the UI in headless Chrome at
390×844 and 1440×900 (screenshots in `/tmp/soccer-shots`), then stops the server and deletes the
data dir. Requires `google-chrome`/`chromium` (set `CHROME_BIN` to override).

## Content rights

Only add streams the site owner has the right to broadcast. The admin page shows this reminder.
