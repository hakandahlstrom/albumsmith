import express from "express";
import session from "express-session";
import crypto from "node:crypto";
import fs from "node:fs";
import sessionFileStore from "session-file-store";

const FileStore = sessionFileStore(session);

const { FLICKR_KEY, FLICKR_SECRET, BASE_URL } = process.env;
const DATA_DIR = process.env.DATA_DIR || "/app/data";
fs.mkdirSync(DATA_DIR, { recursive: true });
const VERSION = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = `${DATA_DIR}/session-secret`;
  try { return fs.readFileSync(file, "utf8").trim(); } catch (e) { /* not created yet */ }
  const secret = crypto.randomBytes(32).toString("base64url");
  fs.writeFileSync(file, secret, { mode: 0o600 });
  console.log("[setup] Created a session secret in the data folder");
  return secret;
}
const SESSION_SECRET = sessionSecret();
for (const [name, value] of Object.entries({ FLICKR_KEY, FLICKR_SECRET, SESSION_SECRET, BASE_URL })) {
  if (!value) {
    console.error(`Missing required setting ${name} (see .env.example)`);
    process.exit(1);
  }
}
if (SESSION_SECRET.length < 16) {
  console.error("SESSION_SECRET must be at least 16 characters (use a long random string)");
  process.exit(1);
}
const IS_HTTPS = BASE_URL.startsWith("https://");
const REST = "https://www.flickr.com/services/rest/";
const OAUTH = "https://www.flickr.com/services/oauth";

const enc = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function signedQuery(method, url, extra, token, tokenSecret = "") {
  const params = {
    oauth_consumer_key: FLICKR_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...(token ? { oauth_token: token } : {}),
    ...extra,
  };
  const norm = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join("&");
  const base = [method, enc(url), enc(norm)].join("&");
  const key = `${enc(FLICKR_SECRET)}&${enc(tokenSecret)}`;
  params.oauth_signature = crypto.createHmac("sha1", key).update(base).digest("base64");
  return Object.keys(params)
    .map((k) => `${enc(k)}=${enc(params[k])}`)
    .join("&");
}

async function oauthGet(url, extra, token, tokenSecret) {
  const res = await fetch(`${url}?${signedQuery("GET", url, extra, token, tokenSecret)}`);
  const text = await res.text();
  if (!res.ok) throw new Error(`Flickr HTTP ${res.status}: ${text}`);
  return text;
}

export async function flickr(sess, method, params = {}) {
  const u = sess.user;
  const text = await oauthGet(
    REST,
    { method, format: "json", nojsoncallback: "1", ...params },
    u.token,
    u.secret
  );
  const data = JSON.parse(text);
  if (data.stat !== "ok") throw new Error(`Flickr API ${data.code}: ${data.message}`);
  return data;
}

const requireAuth = (req, res, next) =>
  req.session.user ? next() : res.status(401).json({ error: "Not logged in" });

const app = express();
app.get("/health", (req, res) => res.json({ status: "ok" }));
if (IS_HTTPS) app.set("trust proxy", Number(process.env.TRUST_PROXY || 1));

app.use(
  session({
    store: new FileStore({ path: `${DATA_DIR}/sessions`, ttl: 7 * 24 * 3600, retries: 0, logFn: () => {} }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax", secure: IS_HTTPS, maxAge: 7 * 24 * 3600 * 1000 },
  })
);

const SETUP_CODE = process.env.SETUP_CODE || crypto.randomBytes(9).toString("base64url");
let setupFails = 0;
let setupLockedUntil = 0;
const sameCode = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const loginHits = [];
const loginLimited = () => {
  const now = Date.now();
  while (loginHits.length && now - loginHits[0] > 60000) loginHits.shift();
  if (loginHits.length >= 10) return true;
  loginHits.push(now);
  return false;
};
setImmediate(() => {
  if (!readToken()) console.log(`[setup] No Flickr account is linked yet. Setup code: ${SETUP_CODE}`);
});

const page = (body, title = "Welcome") =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Albumsmith</title><link rel="icon" type="image/svg+xml" href="/assets/favicon.svg"><link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">` +
  `<link rel="stylesheet" href="/assets/style.css">` +
  `<body><nav class="topbar"><a class="brand" href="/">Album<b>smith</b></a></nav>` +
  `<header><h1>${title}</h1></header>` +
  `<div class="welcome">${body}</div>` +
  `<footer class="site-foot">Albumsmith. This product uses the Flickr API but is not endorsed or certified by SmugMug, Inc.</footer>`;

const LOGIN_PAGE = page(`<p class="lead">Smart albums for Flickr.</p>
<p>Describe an album once, with tags, dates or "on this day", and Albumsmith keeps it up to date every night.</p>
<p><a class="btn primary" href="/auth/login">Log in with Flickr</a></p>
<p class="muted">You will be sent to Flickr to approve access. Albumsmith only changes the contents and order of your albums.</p>`);
const SETUP_PAGE = page(`<p><b>First-time setup.</b> Albumsmith is not linked to a Flickr account yet. To make sure that only you can do that, enter the setup code that Albumsmith wrote to its log when it started.<br><br>To find it, open the container log (for example <code>docker compose logs albumsmith</code>, or the Logs view in Portainer) and look for the line that says <code>Setup code:</code>. You can also choose your own code by setting the <code>SETUP_CODE</code> variable.</p>
<form id="f"><input id="c" type="password" autocomplete="off" placeholder="Setup code" required> <button>Continue</button></form>
<p id="m"></p>
<script>
document.getElementById("f").onsubmit = async (e) => {
  e.preventDefault();
  const r = await fetch("/auth/setup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: document.getElementById("c").value }) });
  if (r.ok) location.href = "/auth/login";
  else document.getElementById("m").textContent = (await r.json()).error || "Failed";
};
</script>`);

app.post("/auth/setup", express.json(), (req, res) => {
  if (!req.is("application/json")) return res.status(415).json({ error: "JSON required" });
  if (readToken()) return res.status(403).json({ error: "Already set up" });
  if (Date.now() < setupLockedUntil) return res.status(429).json({ error: "Too many attempts, try again later" });
  if (!sameCode(req.body && req.body.code, SETUP_CODE)) {
    if (++setupFails >= 5) {
      setupFails = 0;
      setupLockedUntil = Date.now() + 15 * 60 * 1000;
    }
    return res.status(403).json({ error: "Wrong setup code" });
  }
  req.session.setupOk = true;
  req.session.save(() => res.json({ ok: true }));
});

app.use("/assets", express.static("/app/public/assets", { index: false, maxAge: "1h" }));
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/", (req, res) => {
  if (!req.session.user) {
    if (!readToken() && !req.session.setupOk) return res.type("html").send(SETUP_PAGE);
    return res.type("html").send(LOGIN_PAGE);
  }
  res.sendFile("index.html", { root: "/app/public" });
});

app.get("/auth/login", async (req, res) => {
  if (!readToken() && !req.session.setupOk) return res.redirect("/");
  if (loginLimited()) return res.status(429).send("Too many attempts, try again in a minute");
  const text = await oauthGet(`${OAUTH}/request_token`, { oauth_callback: `${BASE_URL}/auth/callback` });
  const p = new URLSearchParams(text);
  req.session.reqToken = p.get("oauth_token");
  req.session.reqSecret = p.get("oauth_token_secret");
  req.session.save(() =>
    res.redirect(`${OAUTH}/authorize?oauth_token=${enc(p.get("oauth_token"))}&perms=write`)
  );
});

app.get("/auth/callback", async (req, res) => {
  const { oauth_token, oauth_verifier } = req.query;
  if (!req.session.reqToken || oauth_token !== req.session.reqToken) {
    return res.status(400).send("Invalid login state, try again from /");
  }
  const text = await oauthGet(`${OAUTH}/access_token`, { oauth_verifier }, oauth_token, req.session.reqSecret);
  const p = new URLSearchParams(text);
  req.session.user = {
    token: p.get("oauth_token"),
    secret: p.get("oauth_token_secret"),
    nsid: p.get("user_nsid"),
    username: p.get("username"),
  };
  const owner = readToken();
  if (!owner && !req.session.setupOk) {
    delete req.session.user;
    return res.status(403).send("Setup code required");
  }
  if (owner && owner.nsid !== req.session.user.nsid) {
    delete req.session.user;
    return res.status(403).send("This instance belongs to another Flickr account");
  }
  saveToken(req.session.user);
  delete req.session.setupOk;
  delete req.session.reqToken;
  delete req.session.reqSecret;
  req.session.save(() => res.redirect("/"));
});

app.post("/auth/logout", (req, res) => {
  if (!req.is("json")) return res.status(415).json({ error: "JSON only" });
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", requireAuth, async (req, res) => {
  const data = await flickr(req.session, "flickr.test.login");
  res.json({ nsid: data.user.id, username: data.user.username._content });
});

app.get("/api/version", requireAuth, (req, res) => res.json({ version: VERSION }));

app.get("/api/photosets", requireAuth, async (req, res) => {
  const sets = [];
  let page = 1;
  let pages = 1;
  do {
    const data = await flickr(req.session, "flickr.photosets.getList", {
      per_page: "500",
      page: String(page),
    });
    pages = Number(data.photosets.pages);
    for (const s of data.photosets.photoset) {
      sets.push({
        id: s.id,
        url: `https://www.flickr.com/photos/${encodeURIComponent(req.session.user.nsid)}/albums/${s.id}`,
        title: s.title._content,
        description: s.description._content,
        count: Number(s.photos) + Number(s.videos || 0),
        primary: s.primary,
        thumb: `https://live.staticflickr.com/${s.server}/${s.primary}_${s.secret}_q.jpg`,
        created: Number(s.date_create),
        updated: Number(s.date_update),
      });
    }
    page++;
  } while (page <= pages);
  res.json({ total: sets.length, sets });
});

const TOKEN_FILE = `${DATA_DIR}/token.json`;
const readToken = () => (fs.existsSync(TOKEN_FILE) ? JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8")) : null);
const saveToken = (u) => {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(u), { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
};

const RULES_FILE = `${DATA_DIR}/rules.json`;
const loadRules = () => (fs.existsSync(RULES_FILE) ? JSON.parse(fs.readFileSync(RULES_FILE, "utf8")) : []);
const SORTS = { 0: "interestingness-desc", 3: "date-taken-asc", 4: "date-taken-desc" };
const SET_MAX = 4500; // Flickr sets hold at most 4500 photos
const pad = (n) => String(n).padStart(2, "0");

async function searchIds(sess, base, { from, to }) {
  const ids = [];
  let page = 1;
  let pages = 1;
  for (;;) {
    const p = { ...base, per_page: "500", page: String(page) };
    if (from) p.min_taken_date = `${from} 00:00:00`;
    if (to) p.max_taken_date = `${to} 23:59:59`;
    const data = await flickr(sess, "flickr.photos.search", p);
    pages = Math.max(pages, Number(data.photos.pages));
    const got = data.photos.photo.length;
    for (const ph of data.photos.photo) ids.push(ph.id);
    page++;
    // Flickr sometimes reports too few pages: keep going while pages come back full (search is capped at 4000 anyway)
    if (!(page <= pages || (got === 500 && page <= 8))) break;
  }
  return [...new Set(ids)];
}

async function ruleIds(sess, rule, sortOverride) {
  const base = {
    user_id: "me",
    content_type: "6",
    sort: sortOverride || SORTS[rule.sortCode] || "interestingness-desc",
  };
  if (rule.tags.length) {
    base.tags = rule.tags.join(",");
    base.tag_mode = rule.tagMode;
  }
  if (rule.onThisDay) {
    const { month, day, yearStart, yearEnd } = rule.onThisDay;
    const last = yearEnd || new Date().getFullYear();
    const years = [];
    for (let y = yearStart; y <= last; y++) years.push(y);
    if (base.sort === "date-taken-desc") years.reverse();
    const ids = [];
    for (const y of years) {
      const d = `${y}-${pad(month)}-${pad(day)}`;
      ids.push(...(await searchIds(sess, base, { from: d, to: d })));
    }
    return ids;
  }
  const range = rule.taken || {};
  const first = await searchIds(sess, base, range);
  // Flickr cuts a search off at about 4000-4500 results BEFORE sorting, so "newest first" is only
  // reliable when the search is not cut off. When it is, search one year at a time, newest year first.
  if (first.length >= 4000 && base.sort === "date-taken-desc") {
    const yTo = range.to ? Number(range.to.slice(0, 4)) : new Date().getFullYear();
    const yFrom = range.from ? Number(range.from.slice(0, 4)) : 1900;
    const ids = [];
    const seen = new Set();
    for (let y = yTo; y >= yFrom && ids.length < SET_MAX; y--) {
      const from = range.from && y === yFrom ? range.from : `${y}-01-01`;
      const to = range.to && y === yTo ? range.to : `${y}-12-31`;
      for (const id of await searchIds(sess, base, { from, to })) {
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      }
    }
    return ids.slice(0, SET_MAX);
  }
  // A Flickr set holds at most SET_MAX photos: keep the first SET_MAX in the chosen sort order
  return first.slice(0, SET_MAX);
}

async function setIds(sess, id) {
  const ids = [];
  let page = 1;
  let pages = 1;
  do {
    const data = await flickr(sess, "flickr.photosets.getPhotos", {
      photoset_id: id,
      user_id: sess.user.nsid,
      per_page: "500",
      page: String(page),
    });
    pages = Number(data.photoset.pages);
    for (const ph of data.photoset.photo) ids.push(ph.id);
    page++;
  } while (page <= pages);
  return ids;
}

app.get("/api/dryrun", requireAuth, async (req, res) => {
  const rule = loadRules().find((r) => r.id === req.query.id || r.title === req.query.title);
  if (!rule) return res.status(404).json({ error: "No such rule" });
  const found = await ruleIds(req.session, rule, req.query.sort);
  const current = await setIds(req.session, rule.id);
  const cur = new Set(current);
  const fnd = new Set(found);
  const toAdd = found.filter((i) => !cur.has(i));
  const toRemove = current.filter((i) => !fnd.has(i));
  const common = found.filter((i) => cur.has(i));
  const currentCommon = current.filter((i) => fnd.has(i));
  res.json({
    title: rule.title,
    sort: req.query.sort || SORTS[rule.sortCode] || "interestingness-desc",
    search: found.length,
    inSet: current.length,
    toAdd: toAdd.length,
    toRemove: toRemove.length,
    orderEqual: common.length === currentCommon.length && common.every((v, i) => v === currentCommon[i]),
    sampleAdd: toAdd.slice(0, 5),
    sampleRemove: toRemove.slice(0, 5),
  });
});

const BACKUP_DIR = `${DATA_DIR}/backups`;
const saveRules = (rules, force = false) => {
  const next = JSON.stringify(rules, null, 2);
  try {
    if (fs.existsSync(RULES_FILE)) {
      const prev = fs.readFileSync(RULES_FILE, "utf8");
      if (prev !== next) {
        fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const files = fs.readdirSync(BACKUP_DIR).filter((f) => /^rules-.*\.json$/.test(f)).sort();
        const last = files.length ? fs.statSync(`${BACKUP_DIR}/${files[files.length - 1]}`).mtimeMs : 0;
        if (force || Date.now() - last > 60000) {
          fs.writeFileSync(`${BACKUP_DIR}/rules-${new Date().toISOString().replace(/[:.]/g, "-")}.json`, prev);
          for (const f of files.slice(0, Math.max(0, files.length + 1 - 20))) fs.unlinkSync(`${BACKUP_DIR}/${f}`);
        }
      }
    }
  } catch (e) {
    console.error("[backup] " + e.message);
  }
  fs.writeFileSync(RULES_FILE, next);
};

async function oauthPost(url, extra, token, tokenSecret) {
  const body = signedQuery("POST", url, extra, token, tokenSecret);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Flickr HTTP ${res.status}: ${text}`);
  return text;
}

async function flickrPost(sess, method, params = {}) {
  const u = sess.user;
  const text = await oauthPost(REST, { method, format: "json", nojsoncallback: "1", ...params }, u.token, u.secret);
  const data = JSON.parse(text);
  if (data.stat !== "ok") throw new Error(`Flickr API ${data.code}: ${data.message}`);
  return data;
}

app.post("/api/sync", requireAuth, async (req, res) => {
  const rules = loadRules();
  const rule = rules.find((r) => r.id === req.query.id || r.title === req.query.title);
  if (!rule) return res.status(404).json({ error: "No such rule" });
  if (!rule.autoSync) return res.status(403).json({ error: "autoSync is off for this rule" });
  const found = await ruleIds(req.session, rule);
  const current = rule.id ? await setIds(req.session, rule.id) : [];
  const cur = new Set(current);
  const fnd = new Set(found);
  const plan = {
    title: rule.title,
    setExists: Boolean(rule.id),
    search: found.length,
    inSet: current.length,
    toAdd: found.filter((i) => !cur.has(i)).length,
    toRemove: current.filter((i) => !fnd.has(i)).length,
  };
  if (req.query.apply !== "1") return res.json({ applied: false, ...plan });
  if (found.length === 0) {
    return res.json({ applied: false, ...plan, note: "No matching photos; Flickr cannot create an empty album" });
  }
  const primary = rule.primaryPhotoId && fnd.has(rule.primaryPhotoId) ? rule.primaryPhotoId : found[0];
  if (!rule.id) {
    const created = await flickrPost(req.session, "flickr.photosets.create", {
      title: rule.title,
      description: rule.description || "",
      primary_photo_id: primary,
    });
    rule.id = created.photoset.id;
    rule.primaryPhotoId = primary;
    saveRules(rules);
  }
  await flickrPost(req.session, "flickr.photosets.editPhotos", {
    photoset_id: rule.id,
    primary_photo_id: primary,
    photo_ids: found.join(","),
  });
  res.json({ applied: true, ...plan, setId: rule.id });
});

const LAST_RUN_FILE = `${DATA_DIR}/last-run.json`;
const SYNC_TIME = process.env.SYNC_TIME || "03:30";
let running = false;

const HISTORY_FILE = `${DATA_DIR}/run-history.json`;
const NOTIFY_URL = process.env.NOTIFY_URL || "";

function summarize(out) {
  const rs = out.results || [];
  return {
    trigger: out.trigger,
    started: out.started,
    finished: out.finished || null,
    rules: rs.length,
    updated: rs.filter((r) => r.applied).length,
    errors: rs.filter((r) => r.error).length,
    skipped: rs.filter((r) => r.skipped).length,
    error: out.error || null,
    problems: rs.filter((r) => r.error || r.skipped).map((r) => ({ title: r.title, error: r.error || null, skipped: r.skipped || null })),
  };
}

async function recordRun(out) {
  const s = summarize(out);
  try {
    let hist = [];
    try { hist = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch {}
    hist.unshift(s);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(hist.slice(0, 30), null, 2));
  } catch (e) {
    console.error("[history]", e.message);
  }
  if (NOTIFY_URL && (s.errors || s.skipped || s.error)) {
    try {
      const names = s.problems.slice(0, 5).map((p) => p.title).join(", ");
      const headers = { Title: "Albumsmith: sync problems" };
      if (process.env.NOTIFY_TOKEN) headers.Authorization = `Bearer ${process.env.NOTIFY_TOKEN}`;
      await fetch(NOTIFY_URL, {
        method: "POST",
        headers,
        body: `${s.errors} errors, ${s.skipped} skipped${s.error ? ": " + s.error : ""}${names ? " (" + names + ")" : ""}`,
      });
    } catch (e) {
      console.error("[notify]", e.message);
    }
  }
}

if (!fs.existsSync(HISTORY_FILE) && fs.existsSync(LAST_RUN_FILE)) {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([summarize(JSON.parse(fs.readFileSync(LAST_RUN_FILE, "utf8")))], null, 2));
  } catch {}
}

// Flickr's search is sometimes incomplete (it can even return 0 results). When a result would remove
// a lot of photos, search again a couple of times and keep the attempt that removes the fewest.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const removedFrom = (current, found) => {
  const keep = new Set(found);
  return current.filter((x) => !keep.has(x)).length;
};
const looksIncomplete = (current, found) =>
  current.length > 0 && removedFrom(current, found) > Math.max(5, current.length * 0.1);
async function ruleIdsStable(sess, rule, current, retries = 2) {
  let best = await ruleIds(sess, rule);
  for (let i = 0; i < retries && looksIncomplete(current, best); i++) {
    await wait(5000 * (i + 1));
    const again = await ruleIds(sess, rule);
    if (removedFrom(current, again) < removedFrom(current, best)) best = again;
  }
  return best;
}

async function runAll(trigger, onlyKey) {
  if (running) return { error: "A run is already in progress" };
  running = true;
  const started = new Date().toISOString();
  const results = [];
  try {
    const token = readToken();
    if (!token) {
      const out = { trigger, started, error: "No saved token; log in once first", results };
      fs.writeFileSync(LAST_RUN_FILE, JSON.stringify(out, null, 2));
      await recordRun(out);
      return out;
    }
    const sess = { user: token };
    const rules = loadRules();
    for (const rule of rules.filter((r) => r.autoSync && (!onlyKey || (r.id || r.uid) === onlyKey))) {
      try {
        const current = rule.id ? await setIds(sess, rule.id) : [];
        let found = onlyKey ? await ruleIds(sess, rule) : await ruleIdsStable(sess, rule, current);
        const removedCount = (f) => {
          const keep = new Set(f);
          return current.filter((x) => !keep.has(x)).length;
        };
        const tooMany = (f) => removedCount(f) > Math.max(5, current.length * 0.1);
        const same = found.length === current.length && found.every((v, i) => v === current[i]);
        const result = { title: rule.title, search: found.length, inSet: current.length, changed: !same, applied: false };
        if (!onlyKey && current.length && tooMany(found)) {
          result.skipped = `would remove ${removedCount(found)} of ${current.length} photos`;
        } else if (!same && found.length > 0) {
          const primary = rule.primaryPhotoId && found.includes(rule.primaryPhotoId) ? rule.primaryPhotoId : found[0];
          if (!rule.id) {
            const created = await flickrPost(sess, "flickr.photosets.create", {
              title: rule.title,
              description: rule.description || "",
              primary_photo_id: primary,
            });
            rule.id = created.photoset.id;
            rule.primaryPhotoId = primary;
            saveRules(rules);
          }
          await flickrPost(sess, "flickr.photosets.editPhotos", {
            photoset_id: rule.id,
            primary_photo_id: primary,
            photo_ids: found.join(","),
          });
          result.applied = true;
        }
        results.push(result);
      } catch (e) {
        results.push({ title: rule.title, error: e.message });
      }
    }
    const out = { trigger, started, finished: new Date().toISOString(), results };
    if (!onlyKey) fs.writeFileSync(LAST_RUN_FILE, JSON.stringify(out, null, 2));
    if (!onlyKey) await recordRun(out);
    console.log(`[sync] ${trigger}: ${results.length} rules, ${results.filter((r) => r.applied).length} updated, ${results.filter((r) => r.error).length} errors, ${results.filter((r) => r.skipped).length} skipped`);
    return out;
  } finally {
    running = false;
  }
}

app.get("/api/jobs/status", requireAuth, (req, res) => {
  res.json(fs.existsSync(LAST_RUN_FILE) ? JSON.parse(fs.readFileSync(LAST_RUN_FILE, "utf8")) : { note: "No run yet" });
});

app.get("/status", (req, res) => {
  if (!req.session.user) return res.redirect("/");
  res.sendFile("status.html", { root: "/app/public" });
});

app.get("/api/status", requireAuth, (req, res) => {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8")); } catch {}
  res.json({ syncTime: SYNC_TIME, notify: Boolean(NOTIFY_URL), running, history });
});

app.post("/api/jobs/run", requireAuth, async (req, res) => {
  res.json(await runAll("manual"));
});

let lastRunDay = null;
setInterval(() => {
  const now = new Date();
  const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const day = now.toDateString();
  if (hhmm === SYNC_TIME && lastRunDay !== day) {
    lastRunDay = day;
    runAll("schedule").catch((e) => console.error("[sync] failed:", e.message));
  }
}, 30 * 1000);

app.use(express.json({ limit: "2mb" }));

const keyOf = (r) => r.id || r.uid;
const requireJson = (req, res, next) =>
  req.is("application/json") ? next() : res.status(415).json({ error: "JSON required" });

const kindOf = (r) =>
  r.onThisDay ? "On this day"
  : r.tags.length && r.taken ? "Tags + dates"
  : r.tags.length ? "Tags"
  : r.taken ? "Dates" : "Manual";

const describe = (r) => {
  const parts = [];
  if (r.tags.length) parts.push(`tags (${r.tagMode}): ${r.tags.join(", ")}`);
  if (r.taken) parts.push(`taken ${r.taken.from || "..."} to ${r.taken.to || "open"}`);
  if (r.onThisDay) parts.push(`${r.onThisDay.month}/${r.onThisDay.day} each year from ${r.onThisDay.yearStart}`);
  parts.push(`sort: ${SORTS[r.sortCode] || "interestingness-desc"}`);
  return parts.join(" | ");
};

app.get("/rules", (req, res) => {
  if (!req.session.user) return res.redirect("/");
  res.sendFile("rules.html", { root: "/app/public" });
});

app.get("/api/rules", requireAuth, (req, res) => {
  const last = fs.existsSync(LAST_RUN_FILE)
    ? JSON.parse(fs.readFileSync(LAST_RUN_FILE, "utf8"))
    : { results: [] };
  const byTitle = Object.fromEntries((last.results || []).map((x) => [x.title, x]));
  res.json({
    lastRun: last.finished || null,
    rules: loadRules().map((r) => ({
      key: keyOf(r),
      title: r.title,
      kind: kindOf(r),
      summary: describe(r),
      autoSync: Boolean(r.autoSync),
      setId: r.id,
      last: byTitle[r.title] || null,
    })),
  });
});

app.post("/api/rules/:key/autosync", requireAuth, requireJson, (req, res) => {
  const rules = loadRules();
  const rule = rules.find((r) => keyOf(r) === req.params.key);
  if (!rule) return res.status(404).json({ error: "No such rule" });
  rule.autoSync = Boolean(req.body && req.body.enabled);
  saveRules(rules);
  res.json({ key: req.params.key, autoSync: rule.autoSync });
});

app.post("/api/rules/:key/sync", requireAuth, requireJson, async (req, res) => {
  res.json(await runAll("manual", req.params.key));
});

const importRule = (r) => {
  if (!r || typeof r !== "object") return { error: "Not a rule" };
  const t = r.taken && typeof r.taken === "object" ? r.taken : {};
  const n = normRule({
    title: r.title,
    description: r.description,
    tags: Array.isArray(r.tags) ? r.tags.join(",") : "",
    tagMode: r.tagMode,
    takenFrom: t.from || "",
    takenTo: t.to || "",
    onThisDay: r.onThisDay,
    sortCode: r.sortCode,
  });
  if (n.error) return { error: n.error };
  const rule = { ...n.rule };
  if (/^\d{1,20}$/.test(String(r.id || ""))) rule.id = String(r.id);
  if (/^[A-Za-z0-9-]{1,64}$/.test(String(r.uid || ""))) rule.uid = String(r.uid);
  if (/^\d{1,20}$/.test(String(r.primaryPhotoId || ""))) rule.primaryPhotoId = String(r.primaryPhotoId);
  rule.lockPrimary = r.lockPrimary === true;
  rule.autoSync = r.autoSync === true;
  if (typeof r.managed === "boolean") rule.managed = r.managed;
  return { rule };
};

const ruleSig = (r) => {
  const t = r.taken && (r.taken.from || r.taken.to) ? [r.taken.from || null, r.taken.to || null] : null;
  const o = r.onThisDay ? [Number(r.onThisDay.month), Number(r.onThisDay.day), Number(r.onThisDay.yearStart)] : null;
  return JSON.stringify([r.title, r.description || "", r.tags || [], r.tagMode === "all" ? "all" : "any", t, o,
    Number(r.sortCode), Boolean(r.autoSync), r.id ? String(r.id) : null,
    r.primaryPhotoId ? String(r.primaryPhotoId) : null, Boolean(r.lockPrimary)]);
};

app.get("/api/rules/export", requireAuth, (req, res) => {
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Disposition", `attachment; filename="albumsmith-rules-${day}.json"`);
  res.type("application/json").send(JSON.stringify(
    { app: "albumsmith", format: 1, exported: new Date().toISOString(), rules: loadRules() }, null, 2));
});

app.post("/api/rules/import", requireAuth, requireJson, (req, res) => {
  const body = req.body || {};
  const list = Array.isArray(body.data && body.data.rules) ? body.data.rules : Array.isArray(body.data) ? body.data : null;
  if (!list || list.length > 5000) return res.status(400).json({ error: "This does not look like an Albumsmith rules file" });
  const mode = body.mode === "replace" ? "replace" : "merge";
  const invalid = [];
  const incoming = [];
  const seen = new Set();
  list.forEach((item, i) => {
    const r = importRule(item);
    if (!r.error && r.rule.id) {
      if (seen.has(r.rule.id)) r.error = "The same album appears twice";
      seen.add(r.rule.id);
    }
    if (r.error) invalid.push({ index: i + 1, title: String((item && item.title) || ""), error: r.error });
    else incoming.push(r.rule);
  });
  if (mode === "replace" && !incoming.length) return res.status(400).json({ error: "The file has no valid rules to import" });
  const existing = loadRules();
  const find = (rule) => existing.findIndex((e) => (rule.id && e.id === rule.id) || (rule.uid && e.uid === rule.uid));
  let added = 0, changed = 0, unchanged = 0;
  const next = mode === "replace" ? [] : existing.slice();
  const touched = new Set();
  for (const rule of incoming) {
    const i = find(rule);
    if (i >= 0) {
      touched.add(i);
      const merged = { ...existing[i], ...rule };
      if (ruleSig(existing[i]) === ruleSig(merged)) unchanged++; else changed++;
      if (mode === "replace") next.push(merged); else next[i] = merged;
    } else {
      added++;
      if (!rule.id && !rule.uid) rule.uid = crypto.randomUUID();
      next.push(rule);
    }
  }
  const removed = mode === "replace" ? existing.length - touched.size : 0;
  const summary = { total: list.length, added, changed, unchanged, removed, invalidCount: invalid.length, invalid: invalid.slice(0, 10) };
  if (!body.apply) return res.json({ ...summary, applied: false });
  if (invalid.length) return res.status(400).json({ error: "Some rules in the file are not valid. Nothing was imported.", invalid: summary.invalid });
  saveRules(next, true);
  console.log(`[rules] import (${mode}): ${added} added, ${changed} changed, ${removed} removed`);
  res.json({ ...summary, applied: true });
});

const normRule = (b) => {
  const title = String(b.title || "").trim();
  if (!title) return { error: "Title is required" };
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const from = String(b.takenFrom || "").trim();
  const to = String(b.takenTo || "").trim();
  if ((from && !re.test(from)) || (to && !re.test(to))) return { error: "Dates must be YYYY-MM-DD" };
  if (from && to && from > to) return { error: "From date is after To date" };
  const tags = String(b.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!(String(b.sortCode) in SORTS)) return { error: "Unknown sort" };
  let onThisDay = null;
  if (b.onThisDay) {
    const month = Number(b.onThisDay.month), day = Number(b.onThisDay.day), yearStart = Number(b.onThisDay.yearStart);
    if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31 && yearStart >= 1900 && yearStart <= 2100))
      return { error: "Check month, day and year" };
    if (tags.length || from || to) return { error: "On this day cannot be combined with tags or dates" };
    onThisDay = { month, day, yearStart };
  } else if (!tags.length && !from && !to) {
    return { error: "Add tags or a date range, otherwise the rule matches everything" };
  }
  return {
    rule: {
      title,
      description: String(b.description || "").trim(),
      tags,
      tagMode: b.tagMode === "all" ? "all" : "any",
      taken: from || to ? { from: from || null, to: to || null } : null,
      onThisDay,
      sortCode: Number(b.sortCode),
    },
  };
};

app.get("/rule", (req, res) => {
  if (!req.session.user) return res.redirect("/");
  res.sendFile("rule.html", { root: "/app/public" });
});

app.get("/api/rules/:key", requireAuth, (req, res) => {
  const rule = loadRules().find((r) => keyOf(r) === req.params.key);
  if (!rule) return res.status(404).json({ error: "No such rule" });
  res.json(rule);
});

app.post("/api/rules/preview", requireAuth, requireJson, async (req, res) => {
  const n = normRule(req.body || {});
  if (n.error) return res.status(400).json({ error: n.error });
  try {
    const ids = await ruleIds(req.session, n.rule);
    res.json({ count: ids.length, capped: ids.length >= 4000 });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
});

app.post("/api/rules", requireAuth, requireJson, (req, res) => {
  const n = normRule(req.body || {});
  if (n.error) return res.status(400).json({ error: n.error });
  const rules = loadRules();
  const rule = { ...n.rule, uid: crypto.randomUUID(), autoSync: false };
  rules.push(rule);
  saveRules(rules);
  res.json({ key: rule.uid });
});

app.put("/api/rules/:key", requireAuth, requireJson, (req, res) => {
  const n = normRule(req.body || {});
  if (n.error) return res.status(400).json({ error: n.error });
  const rules = loadRules();
  const i = rules.findIndex((r) => keyOf(r) === req.params.key);
  if (i < 0) return res.status(404).json({ error: "No such rule" });
  rules[i] = { ...rules[i], ...n.rule };
  saveRules(rules);
  res.json({ key: req.params.key });
});

app.delete("/api/rules/:key", requireAuth, requireJson, (req, res) => {
  const rules = loadRules();
  const i = rules.findIndex((r) => keyOf(r) === req.params.key);
  if (i < 0) return res.status(404).json({ error: "No such rule" });
  const [gone] = rules.splice(i, 1);
  saveRules(rules, true);
  console.log(`[rules] deleted rule "${gone.title}" (album ${gone.id || "none"} left untouched on Flickr)`);
  res.json({ deleted: true, title: gone.title });
});

const PLAN_FILE = `${DATA_DIR}/plan-all.json`;
let planState = { running: false, done: 0, total: 0 };

async function planAll(sess) {
  const rules = loadRules().filter((r) => r.id);
  planState = { running: true, done: 0, total: rules.length };
  const results = [];
  try {
    for (const rule of rules) {
      const row = { key: keyOf(rule), title: rule.title };
      try {
        const current = await setIds(sess, rule.id);
        const found = await ruleIdsStable(sess, rule, current);
        const cur = new Set(current);
        const fnd = new Set(found);
        row.found = found.length;
        row.inSet = current.length;
        row.toAdd = found.filter((x) => !cur.has(x)).length;
        row.toRemove = current.filter((x) => !fnd.has(x)).length;
        row.orderOnly = !row.toAdd && !row.toRemove && found.join() !== current.join();
        const newestFirst = Number(rule.sortCode) === 4;
        row.capped = found.length >= 4000 && !newestFirst;
        row.limited = newestFirst && found.length >= SET_MAX;
      } catch (e) {
        row.error = String((e && e.message) || e);
      }
      results.push(row);
      planState.done++;
    }
    fs.writeFileSync(PLAN_FILE, JSON.stringify({ finished: new Date().toISOString(), results }, null, 2));
  } finally {
    planState.running = false;
  }
}

const readPlan = () => {
  if (!fs.existsSync(PLAN_FILE)) return null;
  const plan = JSON.parse(fs.readFileSync(PLAN_FILE, "utf8"));
  const keys = new Set(loadRules().map(keyOf));
  if (Array.isArray(plan.results)) plan.results = plan.results.filter((r) => keys.has(r.key));
  return plan;
};

// ---- Sort albums on Flickr (order of the album list) ----
const collator = new Intl.Collator("sv", { numeric: true, sensitivity: "base" });
const byTitle = (a, b) => collator.compare(a.title, b.title);
const ALBUM_ORDERS = {
  "title-asc": (a, b) => byTitle(a, b),
  "title-desc": (a, b) => byTitle(b, a),
  "updated-desc": (a, b) => b.updated - a.updated || byTitle(a, b),
  "updated-asc": (a, b) => a.updated - b.updated || byTitle(a, b),
  "count-desc": (a, b) => b.count - a.count || byTitle(a, b),
  "count-asc": (a, b) => a.count - b.count || byTitle(a, b),
};

async function fetchAlbums(sess) {
  const out = [];
  let page = 1;
  let pages = 1;
  do {
    const data = await flickr(sess, "flickr.photosets.getList", { per_page: "500", page: String(page) });
    pages = Number(data.photosets.pages);
    for (const s of data.photosets.photoset) {
      out.push({
        id: s.id,
        title: s.title._content,
        count: Number(s.photos) + Number(s.videos || 0),
        updated: Number(s.date_update),
      });
    }
    page++;
  } while (page <= pages);
  return out;
}

async function sortPlan(sess, by) {
  const cmp = ALBUM_ORDERS[by];
  if (!cmp) {
    const e = new Error("Unknown sort order");
    e.status = 400;
    throw e;
  }
  const current = await fetchAlbums(sess);
  const proposed = current.slice().sort(cmp);
  const moved = proposed.filter((x, i) => x.id !== current[i].id).length;
  return { proposed, moved };
}

app.get("/sort", (req, res) => {
  if (!req.session.user) return res.redirect("/");
  res.sendFile("sort.html", { root: "/app/public" });
});

app.get("/api/sort/preview", requireAuth, async (req, res) => {
  const p = await sortPlan(req.session, String(req.query.by || ""));
  res.json({
    total: p.proposed.length,
    moved: p.moved,
    albums: p.proposed.map((x) => ({ title: x.title, count: x.count, updated: x.updated })),
  });
});

app.post("/api/sort/apply", requireAuth, requireJson, async (req, res) => {
  const by = String((req.body && req.body.by) || "");
  const p = await sortPlan(req.session, by);
  await flickrPost(req.session, "flickr.photosets.orderSets", {
    photoset_ids: p.proposed.map((x) => x.id).join(","),
  });
  console.log(`[sort] ${by}: sent order for ${p.proposed.length} albums (${p.moved} moved)`);
  res.json({ applied: true, total: p.proposed.length, moved: p.moved });
});

app.get("/plan", (req, res) => {
  if (!req.session.user) return res.redirect("/");
  res.sendFile("plan.html", { root: "/app/public" });
});

app.get("/api/plan", requireAuth, (req, res) => {
  res.json({ state: planState, result: readPlan() });
});

app.post("/api/plan/start", requireAuth, requireJson, (req, res) => {
  if (planState.running) return res.status(409).json({ error: "Already running" });
  planAll(req.session).catch((e) => console.error("[plan] failed:", e));
  res.json({ started: true });
});

app.post("/api/rules/autosync-bulk", requireAuth, requireJson, (req, res) => {
  const plan = readPlan();
  if (!plan) return res.status(400).json({ error: "Run the check first" });
  const safe = new Set(
    plan.results.filter((r) => !r.error && !r.capped && !r.toRemove).map((r) => r.key)
  );
  const keys = new Set((req.body && req.body.keys) || []);
  const rules = loadRules();
  let enabled = 0;
  for (const r of rules) {
    const k = keyOf(r);
    if (keys.has(k) && safe.has(k)) {
      if (!r.autoSync) enabled++;
      r.autoSync = true;
    }
  }
  saveRules(rules);
  console.log(`[plan] bulk auto-sync enabled for ${enabled} rules`);
  res.json({ enabled });
});

app.get("/diff", requireAuth, async (req, res) => {
  const rule = loadRules().find((r) => keyOf(r) === req.query.key);
  if (!rule || !rule.id) return res.status(404).type("text/plain").send("No such rule");
  const found = await ruleIds(req.session, rule);
  const current = await setIds(req.session, rule.id);
  const fnd = new Set(found);
  const cur = new Set(current);
  const add = found.filter((x) => !cur.has(x));
  const rem = current.filter((x) => !fnd.has(x));
  const info = async (id) => {
    try {
      const d = await flickr(req.session, "flickr.photos.getInfo", { photo_id: id });
      const p = d.photo;
      const tags = (p.tags.tag || []).map((t) => t.raw).join(", ");
      return `${id} | taken ${p.dates.taken} | ${p.title._content} | tags: ${tags}\n    https://www.flickr.com/photo.gne?id=${id}`;
    } catch (e) {
      return `${id} | error: ${(e && e.message) || e}`;
    }
  };
  const lines = [`${rule.title}: rule finds ${found.length}, set has ${current.length}`, ""];
  lines.push(`In rule but not in set: ${add.length} (showing up to 6)`);
  for (const id of add.slice(0, 6)) lines.push("  " + (await info(id)));
  lines.push("", `In set but not in rule: ${rem.length} (showing up to 6)`);
  for (const id of rem.slice(0, 6)) lines.push("  " + (await info(id)));
  res.type("text/plain").send(lines.join("\n"));
});

app.use((err, req, res, next) => {
  const status = err.status >= 400 && err.status < 600 ? err.status : 500;
  console.error(`[error] ${req.method} ${req.path}: ${err.message}`);
  const visible = status < 500 || /^Flickr/.test(err.message);
  const msg = visible ? err.message : "Something went wrong. See the container log for details.";
  if (req.path.startsWith("/api/")) return res.status(status).json({ error: msg });
  res.status(status).type("text").send(msg);
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => console.log(`Albumsmith ${VERSION} listening on :${PORT}`));
