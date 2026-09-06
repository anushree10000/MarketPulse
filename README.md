# Smart Market Watchlist

A watchlist that answers one question: **what changed since I last looked, and does it actually matter?**
Not a price ticker — a change-detection system that happens to have a watchlist UI on top of it.

## Running it

**Backend**
```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```
This starts the API, creates `watchlist.db` (SQLite) on first run, and immediately starts a
simulated market feed for a fixed universe of ~12 symbols (AAPL, NVDA, TSLA, MSFT, GOOGL, AMZN,
META, AMD, NFLX, SPY, COIN, PLTR), ticking every 3 seconds.

**Frontend**
```bash
cd frontend
python3 -m http.server 8080
```
Open `http://localhost:8080`. Register an account (any username/password — this is a local demo,
not a real auth system to harden), and a starter watchlist is created automatically. Add a few
symbols from the dropdown and watch the "Since you last checked" panel and per-symbol attention
scores populate as the simulated feed ticks.

No API keys, no external services, no build step required to run the core app.

**Optional: live ticker search.** The "add symbol" box searches any real-world
ticker via Finnhub's free-tier API, not just the fixed 12-symbol demo universe.
To enable it:
```bash
export MARKET_DATA_API_KEY=your_finnhub_key   # free at finnhub.io, no card required
```
Without this set, search falls back to a substring match over the local demo
universe instead of failing outright -- see "Search: live lookup with a local
fallback" below for why that's a deliberate design choice, not a stopgap.
Adding a symbol found this way seeds it with a real starting quote (price,
open/high/low), and the existing simulated tick engine takes over from that
real baseline -- so a newly-added ticker isn't starting from a placeholder.

---

## Why it's built this way

### The core mechanism: an event log, not a snapshot diff

The obvious way to build "what changed since last time" is: store a snapshot of prices when the
user leaves, diff against a new snapshot when they return. That breaks the moment there's more
than one device — whose snapshot is authoritative if you check on your phone at 10am and your
laptop at 11am?

Instead, every symbol has an **append-only log of detected events** (`symbol_events`, monotonically
sequenced per symbol), and every user has a **read cursor** into that log per symbol
(`user_watch_state.last_seen_seq`). "What's new" is just `WHERE seq > cursor`. This is naturally
multi-device consistent — any device asks the same question and gets the same answer — and the
event log doubles as a full activity timeline for free.

It also decouples two things that are easy to accidentally conflate:
- **Market truth** — did NVDA actually break out? Computed once, objectively, per symbol.
- **User relevance** — does this matter to *you*, given when you last looked? Cheap per-user filtering
  of a shared log.

This is also the scaling story: detection cost is a function of **unique symbols**, not
**users × symbols**. If 10,000 users all watch NVDA, the expensive computation (is this a
meaningful change?) still runs once per NVDA tick. Fan-out to subscribers is comparatively free —
a filtered read against an index, not a recomputation.

### Detection: adaptive z-scores, not fixed thresholds

A 3% move is noise for TSLA and enormous for a utility stock. Fixed thresholds ("flag any 3%
move") can't account for that, so every signal here is scored as a **z-score against that specific
symbol's own recent behavior**:

- price move vs. that symbol's own recent return distribution
- volume vs. that symbol's own recent volume distribution (would ideally be bucketed by
  time-of-day in a production version, since 10am volume ≠ 2pm volume — noted as a next step)
- a moving-average cross with a deadband, so tiny EMA jitter doesn't get reported as a trend change

Rolling statistics are maintained as **exponential moving averages on the `Symbol` row** rather
than a stored tick history — an O(1) update per tick regardless of symbol count, which is what
makes it plausible to run continuously across a large universe without a separate time-series
store for a v1. See `backend/app/detection.py` for the full logic and thresholds — it's pure
functions with no HTTP/DB coupling, so it's straightforward to unit test or swap in a smarter
model later without touching the rest of the system.

### Data provider: simulated, but the seam is real

There's a single function, `generate_tick()` in `market_feed.py`, standing in for a real vendor
feed (Finnhub / Polygon / Alpaca). Everything downstream — detection, the event log, the API, the
UI — only knows "a tick arrived with a price, volume, and timestamp." Swapping the simulator for a
real websocket client is a change to that one file.

### A correctness bug worth calling out (and how it was caught)

An earlier version of this endpoint advanced the read cursor on every GET, and the
frontend polled it every 5 seconds to keep prices live. That silently collapsed
"since you last checked" into "since 5 seconds ago" for anyone who left the tab
open — the exact feature the project is built around, quietly defeating itself.

Fixed by separating the two concerns: `GET /watchlists/{id}/state` is now purely
a **peek** (computes the diff, never mutates), and the cursor only advances via
explicit **ack** actions — `POST .../symbols/{symbol}/ack` (fires when a user
opens a symbol's detail view) and `POST .../ack-all` ("mark all as read"). That
makes "checked" mean something a person did, not something a timer did.

### Staleness / conflicting data

- Every symbol carries `updated_at`; the UI classifies freshness as `live` / `delayed` / `stale`
  based on tick age, independent of whatever the underlying feed claims.
- Out-of-order ticks are rejected implicitly by construction (single feed writer per symbol here);
  with 2+ real vendors, the policy would be **most-recent-timestamp wins, with a configurable
  source-priority tiebreak** — not silent averaging, since averaging can mask one feed going bad.
- SQLite runs in **WAL (write-ahead log) mode** rather than its default journal mode. The
  background feed thread writes continuously while API requests read/write concurrently;
  in the default mode, writers and readers block each other, which surfaced as intermittent
  "database is locked" / "attempt to write a readonly database" errors under concurrent
  access during testing. WAL lets a writer and readers proceed simultaneously, matching
  this app's actual access pattern.

### Search: live lookup with a local fallback

The add-symbol box calls `GET /api/symbols/search`, which tries Finnhub first
and falls back to a substring match over the fixed demo universe if no key is
configured or the call fails. That's an intentional asymmetry with quote
lookup: a *search* with slightly narrower results is still a working feature
-- the UI marks local-fallback results with a "demo" badge so it's honest
about which mode it's in, rather than pretending everything is live. A
*quote* lookup for a brand-new symbol has no such fallback: if a genuine
starting price can't be fetched, `POST .../items` returns a 404 rather than
inventing a number that would silently corrupt the detection engine's rolling
stats for that symbol. Both calls sit behind a short in-memory TTL cache so a
user typing doesn't fire one outbound request per keystroke.

### Charts: our own recorded ticks, not a vendor candle endpoint

The symbol detail view shows a price history chart. It's deliberately **not**
built on Finnhub's historical-candle endpoint (`/stock/candle`) -- that
endpoint is premium-only on Finnhub's free tier for US stocks and returns a
403 ("you don't have access to this resource") on a free key. Depending on
it would mean the chart silently breaks the moment someone runs this
without a paid plan.

Instead, the feed loop that's already ticking every `TICK_INTERVAL_SECONDS`
records its own price to a `price_ticks` table on every tick (see
`market_feed.run_feed_once`), and `GET /api/symbols/{symbol}/history` reads
that back. This works identically for the simulated universe and for
real-world tickers onboarded through search (`seed_symbol_from_quote` writes
the first point), needs no extra vendor call per chart open, and can't be
broken by a future API tier change. History is capped at
`MAX_HISTORY_POINTS` per symbol and pruned periodically rather than kept
forever -- it's recent-session chart data, not a permanent OHLC archive.

### What's intentionally NOT built

Charts, technical-indicator overlays, alerts, news/catalyst integration, dark-pool/options flow,
and a real distributed processing pipeline (Kafka, worker pools) are all sensible v2 features —
but building them here would trade a working, well-reasoned core for a wider, shallower surface
area. The system is architected so none of them require re-doing the schema or detection logic:
alerts are a consumer of the same event log; a real-time feed is a drop-in replacement for
`generate_tick()`; horizontal scaling is a matter of sharding the per-symbol detection loop across
workers, since it's already embarrassingly parallel by symbol.

## Project layout

```
backend/
  app/
    database.py     SQLAlchemy engine/session (SQLite; one-line swap to Postgres)
    models.py        User, Watchlist, WatchlistItem, Symbol, SymbolEvent, UserWatchState
    schemas.py        Pydantic request/response models
    security.py        Password hashing + JWT
    detection.py         Pure z-score detection engine (no I/O)
    market_feed.py        Simulated feed + background tick loop
    main.py                 FastAPI routes
frontend/
  index.html, style.css, app.js    Vanilla JS SPA (no build step), polls the API every 5s
```
