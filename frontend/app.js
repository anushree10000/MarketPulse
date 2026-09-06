/*
 * Smart Market Watchlist -- frontend
 *
 * Vanilla JS, no build step, so this runs by pointing any static file
 * server at `frontend/`. It's a thin fetch/render layer over the REST API.
 */

const API_BASE = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:8000"
  : ""; // same-origin if deployed behind a reverse proxy

const POLL_INTERVAL_MS = 5000;
const AUTH_PATHS = ["/api/auth/login", "/api/auth/register"];

let state = {
  token: localStorage.getItem("smw_token") || null,
  username: localStorage.getItem("smw_username") || null,
  watchlists: [],
  activeWatchlistId: null,
  allSymbols: [],
  pollHandle: null,
};

// ---------------------------------------------------------------- API ----

function extractErrorMessage(body, fallback) {
  // FastAPI validation errors (422) return `detail` as an ARRAY of objects,
  // not a string -- e.g. [{"loc":[...],"msg":"String should have at least
  // 6 characters", ...}]. Rendering that array directly produces
  // "[object Object]". Pull out the human-readable msg fields instead.
  if (!body || body.detail == null) return fallback;
  if (typeof body.detail === "string") return body.detail;
  if (Array.isArray(body.detail)) {
    return body.detail.map(e => e.msg || JSON.stringify(e)).join("; ");
  }
  return fallback;
}

async function api(path, options = {}) {
  const headers = options.headers || {};
  if (state.token) headers["Authorization"] = `Bearer ${state.token}`;
  if (options.body && !(options.body instanceof URLSearchParams)) {
    headers["Content-Type"] = "application/json";
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  } catch (networkErr) {
    throw new Error(
      `Can't reach the server at ${API_BASE || "this origin"}. Is the backend running on port 8000?`
    );
  }

  const isAuthCall = AUTH_PATHS.includes(path);

  // Only treat 401 as "your session expired" for calls made WITH a token.
  // A 401 on login/register itself just means wrong credentials -- there
  // was no session to expire, so don't log out or show that message.
  if (res.status === 401 && state.token && !isAuthCall) {
    logout();
    throw new Error("Session expired -- please log in again.");
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(extractErrorMessage(body, `Request failed (${res.status})`));
  }
  if (res.status === 204) return null;
  return res.json();
}

// -------------------------------------------------------------- theme ----
// The initial theme is already applied by the inline script in <head>
// (before first paint, to avoid a flash of the wrong theme). This just
// keeps the toggle buttons in sync and handles switching it.

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function applyThemeIcon() {
  const dark = currentTheme() === "dark";
  const icon = dark ? "☀" : "☾";
  const label = dark ? "Light mode" : "Dark mode";
  const title = dark ? "Switch to light mode" : "Switch to dark mode";
  [document.getElementById("theme-toggle-btn"), document.getElementById("theme-toggle-btn-auth")]
    .forEach(btn => {
      if (!btn) return;
      const iconEl = btn.querySelector(".theme-toggle-icon");
      const labelEl = btn.querySelector(".theme-toggle-label");
      if (iconEl) iconEl.textContent = icon;
      if (labelEl) labelEl.textContent = label;
      btn.title = title;
      btn.setAttribute("aria-label", title);
    });
}

function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("smw_theme", next);
  applyThemeIcon();
  if (detailChartSymbol) loadPriceChart(detailChartSymbol);
}

document.getElementById("theme-toggle-btn").addEventListener("click", toggleTheme);
document.getElementById("theme-toggle-btn-auth").addEventListener("click", toggleTheme);
applyThemeIcon();

// -------------------------------------------------------------- auth -----

document.getElementById("login-btn").addEventListener("click", async (e) => {
  e.preventDefault();
  await doLogin();
});
document.getElementById("register-btn").addEventListener("click", async () => {
  await doRegister();
});
document.getElementById("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await doLogin();
});

async function doLogin() {
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  const errEl = document.getElementById("auth-error");
  errEl.textContent = "";
  if (!username || !password) {
    errEl.textContent = "Enter a username and password.";
    return;
  }
  try {
    const form = new URLSearchParams();
    form.set("username", username);
    form.set("password", password);
    const data = await api("/api/auth/login", { method: "POST", body: form });
    setSession(data.access_token, username);
  } catch (err) {
    errEl.textContent = err.message;
  }
}

async function doRegister() {
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  const errEl = document.getElementById("auth-error");
  errEl.textContent = "";
  if (!username || !password) {
    errEl.textContent = "Enter a username and password first.";
    return;
  }
  if (username.length < 3) {
    errEl.textContent = "Username must be at least 3 characters.";
    return;
  }
  if (password.length < 6) {
    errEl.textContent = "Password must be at least 6 characters.";
    return;
  }
  if (password.length > 72) {
    errEl.textContent = "Password must be 72 characters or fewer.";
    return;
  }
  try {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setSession(data.access_token, username);
  } catch (err) {
    errEl.textContent = err.message;
  }
}

function setSession(token, username) {
  state.token = token;
  state.username = username;
  localStorage.setItem("smw_token", token);
  localStorage.setItem("smw_username", username);
  document.getElementById("auth-error").textContent = "";
  document.getElementById("username").value = "";
  document.getElementById("password").value = "";
  showApp().catch(err => {
    console.error(err);
    logout();
  });
}

function logout() {
  state.token = null;
  state.username = null;
  state.activeWatchlistId = null;
  state.watchlists = [];
  localStorage.removeItem("smw_token");
  localStorage.removeItem("smw_username");
  if (state.pollHandle) clearInterval(state.pollHandle);
  document.getElementById("app-screen").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("hidden");
}

document.getElementById("logout-btn").addEventListener("click", logout);

// ------------------------------------------------------------- boot ------

async function showApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-screen").classList.remove("hidden");
  document.getElementById("current-user").textContent = state.username;

  await loadAllSymbols();
  await loadWatchlists();

  if (state.pollHandle) clearInterval(state.pollHandle);
  state.pollHandle = setInterval(refreshActiveWatchlist, POLL_INTERVAL_MS);
}

async function loadAllSymbols() {
  state.allSymbols = await api("/api/symbols");
}

let searchDebounceHandle = null;

function currentWatchlistSymbols() {
  return new Set(
    (state.watchlists.find(w => w.id === state.activeWatchlistId)?.symbols) || []
  );
}

function setSearchEnabled(enabled) {
  const input = document.getElementById("add-symbol-input");
  input.disabled = !enabled;
  if (!enabled) input.value = "";
}

function renderSearchResults(results, query) {
  const list = document.getElementById("symbol-search-results");
  const already = currentWatchlistSymbols();

  if (query === undefined) {
    // Called with no query context (e.g. clearing on blur/close) -- just hide.
    list.classList.add("hidden");
    list.innerHTML = "";
    return;
  }

  if (!results.length) {
    // Empty on purpose, visibly -- an unstyled blank box under the input
    // is indistinguishable from "this is broken." But the message stays
    // purely product-facing: no server/config language, ever -- a user
    // can't act on "set an env var," and it reads as an unfinished product.
    list.innerHTML = `<li class="search-empty">No matches for "${escapeHtml(query)}". Try a well-known ticker like AAPL, TSLA, or MSFT.</li>`;
    list.classList.remove("hidden");
    return;
  }

  list.innerHTML = results.map(r => {
    const added = already.has(r.symbol);
    return `
      <li class="search-result ${added ? "added" : ""}" data-symbol="${r.symbol}" data-name="${escapeHtml(r.name)}">
        <span class="sr-symbol">${r.symbol}</span>
        <span class="sr-name">${escapeHtml(r.name)}</span>
        ${r.source === "local" ? '<span class="sr-badge" title="Sample data, not a live quote">sample</span>' : ""}
        ${added ? '<span class="sr-badge">added</span>' : ""}
      </li>`;
  }).join("");
  list.classList.remove("hidden");

  list.querySelectorAll(".search-result:not(.added)").forEach(li => {
    li.addEventListener("click", async () => {
      const symbol = li.dataset.symbol;
      const name = li.dataset.name;
      if (!state.activeWatchlistId) return;
      try {
        await api(`/api/watchlists/${state.activeWatchlistId}/items`, {
          method: "POST",
          body: JSON.stringify({ symbol, name }),
        });
        setSearchEnabled(true);
        document.getElementById("add-symbol-input").value = "";
        list.classList.add("hidden");
        await loadAllSymbols();
        await loadWatchlists(state.activeWatchlistId);
      } catch (err) {
        alert(err.message);
      }
    });
  });
}

document.getElementById("add-symbol-input").addEventListener("input", (e) => {
  const query = e.target.value.trim();
  clearTimeout(searchDebounceHandle);
  if (query.length < 1) {
    renderSearchResults([], undefined);
    return;
  }
  searchDebounceHandle = setTimeout(async () => {
    try {
      const results = await api(`/api/symbols/search?q=${encodeURIComponent(query)}`);
      // A slow/out-of-order response for a query the user has already changed
      // would flash stale results -- only render if this is still the latest query.
      if (document.getElementById("add-symbol-input").value.trim() === query) {
        renderSearchResults(results, query);
      }
    } catch (err) {
      const list = document.getElementById("symbol-search-results");
      list.innerHTML = `<li class="search-empty">Search failed: ${escapeHtml(err.message)}</li>`;
      list.classList.remove("hidden");
    }
  }, 300);
});

document.addEventListener("click", (e) => {
  const wrap = document.getElementById("symbol-search-wrap");
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById("symbol-search-results").classList.add("hidden");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.getElementById("symbol-search-results").classList.add("hidden");
});

// --------------------------------------------------------- watchlists ----

async function loadWatchlists(keepActiveId) {
  state.watchlists = await api("/api/watchlists");
  renderWatchlistSidebar();

  const noWlState = document.getElementById("no-watchlist-state");
  const table = document.querySelector(".watchlist-table");
  const panelHeader = document.querySelector(".panel-header");

  if (state.watchlists.length === 0) {
    state.activeWatchlistId = null;
    document.getElementById("active-watchlist-name").textContent = "No watchlists yet";
    document.getElementById("watchlist-body").innerHTML = "";
    document.getElementById("empty-state").classList.add("hidden");
    document.getElementById("since-last-checked").classList.add("hidden");
    noWlState.classList.remove("hidden");
    table.classList.add("hidden");
    panelHeader.classList.add("hidden");
    setSearchEnabled(false);
    return;
  }

  noWlState.classList.add("hidden");
  table.classList.remove("hidden");
  panelHeader.classList.remove("hidden");

  const targetId = keepActiveId && state.watchlists.some(w => w.id === keepActiveId)
    ? keepActiveId
    : (state.activeWatchlistId && state.watchlists.some(w => w.id === state.activeWatchlistId)
        ? state.activeWatchlistId
        : state.watchlists[0].id);

  await selectWatchlist(targetId);
}

function renderWatchlistSidebar() {
  const list = document.getElementById("watchlist-list");
  list.innerHTML = "";
  state.watchlists.forEach(w => {
    const li = document.createElement("li");
    li.className = w.id === state.activeWatchlistId ? "active" : "";
    li.innerHTML = `<span class="wl-name">${escapeHtml(w.name)}</span><span class="del-wl" title="Delete list">&times;</span>`;
    li.querySelector(".wl-name").addEventListener("click", () => selectWatchlist(w.id));
    li.querySelector(".del-wl").addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm(`Delete watchlist "${w.name}"? This can't be undone.`)) return;
      try {
        await api(`/api/watchlists/${w.id}`, { method: "DELETE" });
        if (state.activeWatchlistId === w.id) state.activeWatchlistId = null;
        await loadWatchlists();
      } catch (err) {
        alert(err.message);
      }
    });
    list.appendChild(li);
  });
}

async function createWatchlist() {
  const name = prompt("Name your new watchlist (e.g. \"Swing Trades\"):");
  if (!name || !name.trim()) return;
  try {
    const w = await api("/api/watchlists", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
    await loadWatchlists(w.id);
  } catch (err) {
    alert(err.message);
  }
}

document.getElementById("new-watchlist-btn").addEventListener("click", createWatchlist);
document.getElementById("create-first-watchlist-btn").addEventListener("click", createWatchlist);

async function selectWatchlist(id) {
  state.activeWatchlistId = id;
  renderWatchlistSidebar();
  setSearchEnabled(true);
  const w = state.watchlists.find(x => x.id === id);
  document.getElementById("active-watchlist-name").textContent = w ? w.name : "Watchlist";
  await refreshActiveWatchlist();
}

// ----------------------------------------------------- state / polling ---

async function refreshActiveWatchlist() {
  if (!state.activeWatchlistId) return;
  let data;
  try {
    data = await api(`/api/watchlists/${state.activeWatchlistId}/state`);
  } catch (err) {
    return; // transient network hiccup -- next poll retries; don't spam the user
  }
  renderSinceLastChecked(data.items);
  renderWatchlistTable(data.items);
  document.getElementById("last-refresh").textContent =
    "Updated " + new Date(data.generated_at).toLocaleTimeString();
}

function severityFor(score) {
  if (score >= 60) return "high";
  if (score >= 25) return "medium";
  return "low";
}

function renderSinceLastChecked(items) {
  const panel = document.getElementById("since-last-checked");
  const content = document.getElementById("since-last-content");
  const withNews = items.filter(i => i.unseen_count > 0);

  if (withNews.length === 0) {
    panel.classList.add("hidden");
    content.innerHTML = "";
    return;
  }
  panel.classList.remove("hidden");
  content.innerHTML = withNews.map(item => {
    const top = item.new_events[0];
    const sev = severityFor(item.meaning_score);
    return `
      <div class="since-card severity-${sev}" data-symbol="${item.snapshot.symbol}">
        <div class="sym">${item.snapshot.symbol} <span style="font-weight:400;color:var(--text-tertiary);font-size:12px;">${item.unseen_count} update${item.unseen_count > 1 ? "s" : ""}</span></div>
        <div class="headline">${top ? escapeHtml(top.message) : ""}</div>
      </div>`;
  }).join("");

  content.querySelectorAll(".since-card").forEach(card => {
    card.addEventListener("click", () => openDetail(card.dataset.symbol));
  });
}

document.getElementById("mark-all-read-btn").addEventListener("click", async () => {
  if (!state.activeWatchlistId) return;
  try {
    await api(`/api/watchlists/${state.activeWatchlistId}/ack-all`, { method: "POST" });
    await refreshActiveWatchlist();
  } catch (err) {
    alert(err.message);
  }
});

function formatCompact(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(Math.round(n));
}

function renderWatchlistTable(items) {
  const body = document.getElementById("watchlist-body");
  const emptyState = document.getElementById("empty-state");
  const table = document.querySelector(".watchlist-table");
  body.innerHTML = "";

  if (items.length === 0) {
    emptyState.classList.remove("hidden");
    table.classList.add("hidden");
    return;
  }
  emptyState.classList.add("hidden");
  table.classList.remove("hidden");

  items.forEach(item => {
    const s = item.snapshot;
    const dir = s.change_pct >= 0 ? "up" : "down";
    const arrow = s.change_pct >= 0 ? "▲" : "▼";
    const dollarChange = (s.last_price - s.prev_close);
    const sev = severityFor(item.meaning_score);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="sym-cell">${s.symbol}<span class="sym-name">${escapeHtml(s.name)}</span></td>
      <td class="num">$${s.last_price.toFixed(2)}</td>
      <td class="num"><span class="plain-change ${dir}">${dollarChange >= 0 ? "+" : ""}${dollarChange.toFixed(2)}</span></td>
      <td class="num"><span class="change-pill ${dir}">${arrow} ${Math.abs(s.change_pct).toFixed(2)}%</span></td>
      <td class="num">${s.rel_volume.toFixed(2)}x</td>
      <td><span class="badge ${s.freshness}">${s.freshness}</span></td>
      <td>
        <div class="attention-score">
          <div class="attention-bar"><div class="attention-bar-fill attention-${sev}" style="width:${item.meaning_score}%"></div></div>
          <span class="score-num">${Math.round(item.meaning_score)}</span>
          ${item.unseen_count > 0 ? '<span class="unseen-dot" title="New activity"></span>' : ""}
        </div>
      </td>
      <td><button class="remove-btn" title="Remove from watchlist">&times;</button></td>
    `;
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".remove-btn")) return;
      openDetail(s.symbol);
    });
    tr.querySelector(".remove-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api(`/api/watchlists/${state.activeWatchlistId}/items/${s.symbol}`, { method: "DELETE" });
        await loadWatchlists(state.activeWatchlistId);
      } catch (err) {
        alert(err.message);
      }
    });
    body.appendChild(tr);
  });
}

// ----------------------------------------------------------- detail -----

let detailChartPoints = null;
let detailChartSymbol = null;
let detailChartResizeObserver = null;

function chartThemeColors() {
  const styles = getComputedStyle(document.documentElement);
  return {
    line: styles.getPropertyValue("--accent").trim() || "#3b82f6",
    grid: styles.getPropertyValue("--border").trim() || "#e5e7eb",
    text: styles.getPropertyValue("--text-tertiary").trim() || "#6b7280",
  };
}

/**
 * Dependency-free line chart, drawn straight onto the canvas element.
 *
 * This used to be a Chart.js instance loaded from a CDN. That's a bad trade
 * for a self-contained demo app: the one piece of the UI that best shows off
 * "meaningful change over time" could go dark any time the CDN was
 * unreachable (network policy, ad blocker, offline demo), for reasons that
 * have nothing to do with this project's own code. The rest of the app
 * already runs with zero external services by design (see README) -- the
 * chart is the one place that didn't, so it's the one place that could fail
 * independently of everything else working correctly.
 *
 * A price-over-time line for a few hundred points doesn't need a charting
 * library's full feature set (interactions, animations, mixed chart types).
 * Plain canvas drawing covers it in well under 100 lines, with no failure
 * mode beyond "canvas isn't supported," which no browser in practical use
 * has to worry about.
 */
function drawLineChart(canvas, points) {
  const colors = chartThemeColors();
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssWidth = Math.max(1, rect.width);
  const cssHeight = Math.max(1, rect.height);

  canvas.width = cssWidth * dpr;
  canvas.height = cssHeight * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const padding = { top: 10, right: 8, bottom: 20, left: 52 };
  const plotWidth = cssWidth - padding.left - padding.right;
  const plotHeight = cssHeight - padding.top - padding.bottom;
  if (plotWidth <= 0 || plotHeight <= 0) return;

  const prices = points.map(p => p.price);
  let minP = Math.min(...prices);
  let maxP = Math.max(...prices);
  if (minP === maxP) { minP -= 1; maxP += 1; } // flat series -- keep an axis range to draw against
  const pad = (maxP - minP) * 0.08;
  minP -= pad;
  maxP += pad;

  const xAt = (i) => padding.left + (i / (points.length - 1)) * plotWidth;
  const yAt = (price) => padding.top + (1 - (price - minP) / (maxP - minP)) * plotHeight;

  // Horizontal gridlines + y-axis price labels (4 bands)
  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.text;
  ctx.font = "10px inherit";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const bands = 4;
  for (let b = 0; b <= bands; b++) {
    const price = minP + ((bands - b) / bands) * (maxP - minP);
    const y = padding.top + (b / bands) * plotHeight;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(cssWidth - padding.right, y);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillText("$" + price.toFixed(2), padding.left - 8, y);
  }

  // A handful of evenly-spaced time labels along the x-axis
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const labelCount = Math.min(5, points.length);
  for (let l = 0; l < labelCount; l++) {
    const i = Math.round((l / (labelCount - 1 || 1)) * (points.length - 1));
    const t = new Date(points[i].timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    ctx.fillText(t, xAt(i), cssHeight - padding.bottom + 4);
  }

  // The price line itself
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xAt(i);
    const y = yAt(p.price);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = colors.line;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();
}

async function loadPriceChart(symbol) {
  const canvas = document.getElementById("detail-chart");
  const emptyMsg = document.getElementById("detail-chart-empty");

  let points;
  try {
    points = await api(`/api/symbols/${symbol}/history?limit=300`);
  } catch (err) {
    points = [];
  }

  if (points.length < 2) {
    detailChartPoints = null;
    canvas.classList.add("hidden");
    emptyMsg.textContent = "Not enough history yet — check back in a bit.";
    emptyMsg.classList.remove("hidden");
    return;
  }

  canvas.classList.remove("hidden");
  emptyMsg.classList.add("hidden");
  detailChartPoints = points;
  drawLineChart(canvas, points);

  // Redraw on resize (e.g. rotating a phone, resizing the detail panel) --
  // the canvas' backing size is set from its rendered CSS size above, so
  // a layout change needs a redraw to stay crisp rather than stretched.
  if (!detailChartResizeObserver) {
    detailChartResizeObserver = new ResizeObserver(() => {
      if (detailChartPoints) drawLineChart(canvas, detailChartPoints);
    });
    detailChartResizeObserver.observe(canvas);
  }
}

async function openDetail(symbol) {
  document.getElementById("detail-overlay").classList.remove("hidden");
  document.getElementById("detail-panel").classList.remove("hidden");
  document.getElementById("detail-symbol-title").textContent = symbol;
  detailChartSymbol = symbol;

  const snap = state.allSymbols.find(s => s.symbol === symbol);
  const nameEl = document.getElementById("detail-symbol-name");
  const priceBlock = document.getElementById("detail-price-block");
  const snapEl = document.getElementById("detail-snapshot");

  if (snap) {
    nameEl.textContent = snap.name;
    const dir = snap.change_pct >= 0 ? "up" : "down";
    const arrow = snap.change_pct >= 0 ? "▲" : "▼";
    priceBlock.innerHTML = `
      <div class="price">$${snap.last_price.toFixed(2)}</div>
      <div class="change plain-change ${dir}">${arrow} ${Math.abs(snap.change_pct).toFixed(2)}% today</div>
    `;
    snapEl.innerHTML = `
      <div><span>Day High</span>$${snap.day_high.toFixed(2)}</div>
      <div><span>Day Low</span>$${snap.day_low.toFixed(2)}</div>
      <div><span>Volume</span>${formatCompact(snap.last_volume)}</div>
      <div><span>Avg Volume</span>${formatCompact(snap.volume_mean)}</div>
      <div><span>Rel. Volume</span>${snap.rel_volume.toFixed(2)}x</div>
      <div><span>Data</span>${snap.freshness}</div>
    `;
  } else {
    nameEl.textContent = "";
    priceBlock.innerHTML = "";
    snapEl.innerHTML = "";
  }

  const list = document.getElementById("detail-events");
  list.innerHTML = "<li>Loading…</li>";
  loadPriceChart(symbol);
  try {
    const events = await api(`/api/symbols/${symbol}/events?since_seq=0`);
    list.innerHTML = events.length
      ? events.map(e => `
          <li>
            ${escapeHtml(e.message)}
            <div class="evt-meta">${e.event_type.replace(/_/g, " ")} — ${new Date(e.timestamp).toLocaleTimeString()} — score ${e.score.toFixed(0)}</div>
          </li>`).join("")
      : "<li>No events recorded yet for this symbol.</li>";
  } catch (err) {
    list.innerHTML = `<li>Couldn't load events: ${escapeHtml(err.message)}</li>`;
  }

  // Reviewing this symbol is what "checking" means -- advance this symbol's
  // cursor now, then refresh the table/since-panel so the unseen badge clears.
  if (state.activeWatchlistId) {
    try {
      await api(`/api/watchlists/${state.activeWatchlistId}/symbols/${symbol}/ack`, { method: "POST" });
      await refreshActiveWatchlist();
    } catch (err) {
      // non-fatal -- the detail view itself already loaded fine
      console.warn("Failed to mark symbol as read:", err.message);
    }
  }
}

function closeDetail() {
  document.getElementById("detail-overlay").classList.add("hidden");
  document.getElementById("detail-panel").classList.add("hidden");
  detailChartPoints = null;
  detailChartSymbol = null;
}

document.getElementById("close-detail").addEventListener("click", closeDetail);
document.getElementById("detail-overlay").addEventListener("click", closeDetail);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
});

// ------------------------------------------------------------ utils -----

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

// -------------------------------------------------------------- init ----

if (state.token) {
  showApp().catch(err => {
    console.error(err);
    logout();
  });
}
