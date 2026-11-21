// Immich trip albums + monthly digest (Bun + TypeScript, no dependencies).
//
// 1. Trip suggestions: every SCAN_HOURS, groups photos that are in no album and were
//    taken away from home (by Immich's reverse-geocoded city/state/country) into trips,
//    and proposes a "YYYY-MM Place" album for each. Nothing is created until you press
//    Approve on the app's page. You can rename the album or add to an existing one.
// 2. Monthly digest: on DIGEST_DAY at DIGEST_HOUR, summarises last month: new unsorted
//    photos, new duplicate groups, new unnamed faces, storage growth, and whether a newer
//    Immich release is out.
// New suggestions and each digest are announced with an Immich notification (the bell),
// unless DRY_RUN is on, in which case nothing at all is written to Immich.
//
// Note: this file must not contain the dollar sign (it is inlined into docker-compose.yml).

type Exif = { city?: string | null; state?: string | null; country?: string | null; fileSizeInByte?: number | null };
type Asset = { id: string; type: string; localDateTime: string; createdAt: string; exifInfo?: Exif };
type Album = { id: string; albumName: string; startDate?: string | null; endDate?: string | null; assetCount: number };
type Person = { id: string; name: string; isHidden: boolean };

type Trip = {
  key: string; start: string; end: string; name: string; places: string; inProgress: boolean;
  geoIds: string[]; extraIds: string[]; sample: string[]; overlaps: { id: string; name: string }[];
};
type Decision = { status: "approved" | "dismissed"; at: string; album?: string; count?: number };
type Digest = {
  month: string; label: string; createdAt: string; preview?: boolean; baseline?: boolean;
  uploaded: number; uploadedBytes: number; unsorted: number;
  duplicates: number; newDuplicates: number;
  unnamed: number; newUnnamed: { id: string; count: number }[]; newUnnamedTotal: number;
  disk?: { used: string; available: string; percent: number };
  version: { current: string; latest?: string; url?: string; newer: boolean };
};
type State = {
  decisions: Record<string, Decision>; notified: string[];
  seenDuplicates: string[]; seenPeople: string[];
  digests: Digest[]; lastScan?: string;
};

// ---------- config ----------
const env = (k: string, d?: string): string => {
  const v = typeof process !== "undefined" ? process.env[k] : undefined;
  if (v !== undefined && v !== "") return v;
  if (d !== undefined) return d;
  throw new Error("missing env " + k);
};
const flag = (k: string, d: string) => ["1", "true", "yes", "on"].includes(env(k, d).toLowerCase());
const trimSlash = (s: string): string => (s.endsWith("/") ? trimSlash(s.slice(0, -1)) : s);

const CFG = {
  url: trimSlash(env("IMMICH_URL", "")),
  key: env("IMMICH_API_KEY", ""),
  home: env("HOME_PLACES", "Bangkok, Thailand; Nonthaburi, Thailand; Samut Prakan, Thailand; Abu Dhabi, United Arab Emirates"),
  minPhotos: Number(env("MIN_PHOTOS", "20")),
  gapDays: Number(env("GAP_DAYS", "2")),
  scanHours: Number(env("SCAN_HOURS", "6")),
  digestDay: Number(env("DIGEST_DAY", "1")),
  digestHour: Number(env("DIGEST_HOUR", "9")),
  dryRun: flag("DRY_RUN", "false"),
  pageUrl: trimSlash(env("PAGE_URL", "")),
  port: Number(env("PORT", "3000")),
  stateFile: env("STATE_FILE", "/data/state.json"),
};

const HOME = CFG.home.split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
  const i = s.lastIndexOf(",");
  return i < 0 ? { region: "", country: s } : { region: s.slice(0, i).trim(), country: s.slice(i + 1).trim() };
});

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

// ---------- Immich API ----------
async function api(method: string, path: string, body?: unknown, accept = "application/json"): Promise<Response> {
  const headers: Record<string, string> = { Accept: accept };
  if (CFG.key) headers["x-api-key"] = CFG.key;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(CFG.url + "/api" + path, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(method + " " + path + " -> " + res.status + " " + (await res.text()).slice(0, 200));
  return res;
}
// (a generic arrow function would be read as JSX by "bun -e")
async function get<T>(path: string): Promise<T> {
  return (await (await api("GET", path)).json()) as T;
}

async function searchAll(filter: Record<string, unknown>): Promise<Asset[]> {
  const out: Asset[] = [];
  let page: number | null = 1;
  while (page) {
    const r = (await (await api("POST", "/search/metadata", { ...filter, withExif: true, size: 1000, page })).json()) as {
      assets: { items: Asset[]; nextPage: string | null };
    };
    out.push(...r.assets.items);
    page = r.assets.nextPage ? Number(r.assets.nextPage) : null;
  }
  return out;
}

// ---------- trip detection ----------
const day = (a: Asset) => (a.localDateTime || a.createdAt).slice(0, 10);
const dayNum = (d: string) => Math.round(Date.parse(d + "T00:00:00Z") / 864e5);
const today = () => {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
};
const isHome = (e: Exif) => HOME.some((h) => h.country === e.country && (!h.region || h.region === e.state || h.region === e.city));

// English-friendly place names: drop accents (Nikkō -> Nikko, Şalālah -> Salalah).
const ascii = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/Đ/g, "D").replace(/đ/g, "d").replace(/’/g, "'");

function ranked(items: Asset[], f: (e: Exif) => string | null | undefined): [string, number][] {
  const m = new Map<string, number>();
  for (const a of items) {
    const k = f(a.exifInfo ?? {});
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

// Names by province/prefecture/emirate (one or two), e.g. "Miyagi–Iwate", "Chiang Mai",
// several countries when the trip spans them ("Turkey–Oman"), else the country.
function placeName(items: Asset[]): string {
  const n = items.length;
  const countries = ranked(items, (e) => e.country);
  const multi = countries.filter(([, c]) => c >= 0.2 * n).slice(0, 3);
  if (multi.length > 1) return multi.map(([k]) => ascii(k)).join("–");
  const country = countries[0]?.[0] ?? "Trip";
  const clean = (s: string) => {
    const t = s.endsWith(" City") ? s.slice(0, -5) : s; // "Da Nang City" -> "Da Nang", but keep "Mexico City"
    return ascii(t === country ? s : t);
  };
  const states = ranked(items, (e) => e.state);
  if (states[0] && states[0][1] >= 0.5 * n) {
    const two = states[1] && states[1][1] >= 0.2 * n ? [states[0], states[1]] : [states[0]];
    return two.map(([k]) => clean(k)).join("–");
  }
  return ascii(country);
}

function describePlaces(items: Asset[]): string {
  return ranked(items, (e) => [e.city, e.state, e.country].filter(Boolean).join(", "))
    .slice(0, 4).map(([k, c]) => k + " (" + c + ")").join("; ");
}

function spread<T>(xs: T[], k: number): T[] {
  if (xs.length <= k) return xs;
  return Array.from({ length: k }, (_, i) => xs[Math.floor((i * (xs.length - 1)) / (k - 1))]);
}

// Only "YYYY-MM ..." event albums spanning at most ~6 weeks count as an existing album for a trip.
const DATED = /^\d{4}-\d{2} /;

async function findTrips(): Promise<Trip[]> {
  const [assets, albums] = await Promise.all([
    searchAll({ isNotInAlbum: true, visibility: "timeline" }),
    get<Album[]>("/albums"),
  ]);
  const away = assets.filter((a) => a.exifInfo?.country && !isHome(a.exifInfo)).sort((a, b) => (day(a) < day(b) ? -1 : 1));
  const noGeo = assets.filter((a) => !a.exifInfo?.country);

  const groups: { start: string; end: string; items: Asset[] }[] = [];
  for (const a of away) {
    const g = groups[groups.length - 1];
    if (g && dayNum(day(a)) - dayNum(g.end) <= CFG.gapDays) { g.items.push(a); g.end = day(a); }
    else groups.push({ start: day(a), end: day(a), items: [a] });
  }

  const names = new Set(albums.map((a) => a.albumName.toLowerCase()));
  const trips: Trip[] = [];
  for (const g of groups) {
    if (g.items.length < CFG.minPhotos) continue;
    g.items.sort((a, b) => (a.localDateTime < b.localDateTime ? -1 : 1));
    let name = g.start.slice(0, 7) + " " + placeName(g.items);
    for (let i = 2; names.has(name.toLowerCase()); i++) name = g.start.slice(0, 7) + " " + placeName(g.items) + " " + i;
    const overlaps = albums
      .filter((al) => DATED.test(al.albumName) && !al.albumName.includes("[Print Selection]") && al.startDate && al.endDate &&
        dayNum(al.endDate.slice(0, 10)) - dayNum(al.startDate.slice(0, 10)) <= 45 &&
        al.startDate.slice(0, 10) <= g.end && al.endDate.slice(0, 10) >= g.start)
      .map((al) => ({ id: al.id, name: al.albumName }));
    trips.push({
      key: g.start + "_" + ascii(ranked(g.items, (e) => e.country)[0][0]).replace(/[^A-Za-z]/g, ""),
      start: g.start, end: g.end, name, places: describePlaces(g.items),
      inProgress: dayNum(today()) - dayNum(g.end) <= CFG.gapDays,
      geoIds: g.items.map((a) => a.id),
      extraIds: noGeo.filter((a) => day(a) >= g.start && day(a) <= g.end).map((a) => a.id),
      sample: spread(g.items, 6).map((a) => a.id),
      overlaps,
    });
  }
  return trips.reverse(); // newest first
}

// ---------- digest ----------
const monthKey = (d: Date) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
const monthLabel = (d: Date) => d.toLocaleString("en-GB", { month: "long", year: "numeric" });

function newerVersion(latest: string, current: string): boolean {
  const p = (v: string) => v.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
  const [a, b] = [p(latest), p(current)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
}

async function versionInfo(): Promise<Digest["version"]> {
  const v = await get<{ major: number; minor: number; patch: number }>("/server/version");
  const current = "v" + v.major + "." + v.minor + "." + v.patch;
  try {
    const r = await fetch("https://api.github.com/repos/immich-app/immich/releases/latest", {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "immich-trip-digest" },
      signal: AbortSignal.timeout(30_000),
    });
    const j = (await r.json()) as { tag_name?: string; html_url?: string };
    if (j.tag_name) return { current, latest: j.tag_name, url: j.html_url, newer: newerVersion(j.tag_name, current) };
  } catch (err) {
    log("version check failed:", String(err));
  }
  return { current, newer: false };
}

// from..to is the upload window. preview=true leaves the "seen" lists alone.
async function buildDigest(from: Date, to: Date, label: string, state: State, preview: boolean): Promise<Digest> {
  const win = { createdAfter: from.toISOString(), createdBefore: to.toISOString() };
  const [timeline, archived, unsorted, dups, people, version] = await Promise.all([
    searchAll({ ...win, visibility: "timeline" }),
    searchAll({ ...win, visibility: "archive" }),
    searchAll({ ...win, visibility: "timeline", isNotInAlbum: true }),
    get<{ duplicateId: string }[]>("/duplicates"),
    get<{ people: Person[] }>("/people?withHidden=false&size=1000"),
    versionInfo(),
  ]);
  const uploads = [...timeline, ...archived];
  const baseline = !state.seenDuplicates.length && !state.seenPeople.length;
  const unnamed = people.people.filter((p) => !p.name && !p.isHidden);
  const seenD = new Set(state.seenDuplicates), seenP = new Set(state.seenPeople);
  const newDup = dups.filter((d) => !seenD.has(d.duplicateId));
  const newPeople = unnamed.filter((p) => !seenP.has(p.id));
  const counts: { id: string; count: number }[] = [];
  for (const p of newPeople.slice(0, 40)) {
    try { counts.push({ id: p.id, count: (await get<{ assets: number }>("/people/" + p.id + "/statistics")).assets }); }
    catch { counts.push({ id: p.id, count: 0 }); }
  }
  counts.sort((a, b) => b.count - a.count);
  let disk: Digest["disk"];
  try {
    const s = await get<{ diskUse: string; diskAvailable: string; diskUsagePercentage: number }>("/server/storage");
    disk = { used: s.diskUse, available: s.diskAvailable, percent: s.diskUsagePercentage };
  } catch { /* key lacks server.storage */ }
  if (!preview) {
    state.seenDuplicates = dups.map((d) => d.duplicateId);
    state.seenPeople = [...new Set([...state.seenPeople, ...people.people.map((p) => p.id)])];
  }
  return {
    month: monthKey(from), label, createdAt: new Date().toISOString(), preview, baseline,
    uploaded: uploads.length,
    uploadedBytes: uploads.reduce((s, a) => s + (a.exifInfo?.fileSizeInByte ?? 0), 0),
    unsorted: unsorted.length,
    duplicates: dups.length, newDuplicates: newDup.length,
    unnamed: unnamed.length, newUnnamed: counts.slice(0, 8), newUnnamedTotal: newPeople.length,
    disk, version,
  };
}

const gb = (b: number) => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.round(b / 1e6) + " MB");
const digestLine = (d: Digest) =>
  d.uploaded + " new photos/videos (" + gb(d.uploadedBytes) + "), " + d.unsorted + " still in no album, " +
  d.newDuplicates + " new duplicate groups, " + d.newUnnamedTotal + " new unnamed faces." +
  (d.version.newer ? " Immich " + d.version.latest + " is out (you run " + d.version.current + ")." : "");

// ---------- state ----------
async function loadState(): Promise<State> {
  const empty: State = { decisions: {}, notified: [], seenDuplicates: [], seenPeople: [], digests: [] };
  try {
    const f = Bun.file(CFG.stateFile);
    if (await f.exists()) return { ...empty, ...(await f.json()) };
  } catch (err) { log("state unreadable, starting fresh:", String(err)); }
  return empty;
}
const saveState = (s: State) => Bun.write(CFG.stateFile, JSON.stringify(s, null, 1));

// ---------- writes (all gated by DRY_RUN) ----------
let userId = "";
async function notify(title: string, description: string) {
  if (CFG.dryRun) return log("DRY RUN: would notify: " + title + " | " + description);
  if (!userId) userId = (await get<{ id: string }>("/users/me")).id;
  await api("POST", "/admin/notifications", { userId, title, description, level: "info", type: "Custom" });
  log("notified: " + title);
}

async function approveTrip(t: Trip, name: string, target: string, withExtra: boolean): Promise<Decision> {
  const ids = withExtra ? [...t.geoIds, ...t.extraIds] : t.geoIds;
  if (CFG.dryRun) throw new Error("Dry run is on, so nothing was created. Turn Dry run off in Runtipi first.");
  let albumId = target, albumName = t.overlaps.find((o) => o.id === target)?.name ?? name;
  if (target === "new") {
    const al = (await (await api("POST", "/albums", { albumName: name })).json()) as { id: string };
    albumId = al.id; albumName = name;
  }
  for (let i = 0; i < ids.length; i += 500) await api("PUT", "/albums/" + albumId + "/assets", { ids: ids.slice(i, i + 500) });
  log("approved " + t.key + ": " + ids.length + " assets -> " + albumName);
  return { status: "approved", at: new Date().toISOString(), album: albumName, count: ids.length };
}

// ---------- jobs ----------
let trips: Trip[] = [];
let lastError = "";
let preview: Digest | null = null;

async function scan(state: State) {
  trips = await findTrips();
  state.lastScan = new Date().toISOString();
  const fresh = trips.filter((t) => !t.inProgress && !state.decisions[t.key] && !state.notified.includes(t.key));
  if (fresh.length) {
    const list = fresh.slice(0, 5).map((t) => t.name + " (" + (t.geoIds.length + t.extraIds.length) + ")").join(", ");
    await notify(
      fresh.length + " trip album suggestion" + (fresh.length > 1 ? "s" : ""),
      list + (fresh.length > 5 ? " and " + (fresh.length - 5) + " more" : "") + ". Review and approve" + (CFG.pageUrl ? " at " + CFG.pageUrl : " on the Trip & Digest page") + ".",
    );
    if (!CFG.dryRun) state.notified.push(...fresh.map((t) => t.key));
  }
  log("scan: " + trips.length + " trips, " + fresh.length + " new");
  await saveState(state);
}

async function maybeDigest(state: State) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  const due = now.getDate() > CFG.digestDay || (now.getDate() === CFG.digestDay && now.getHours() >= CFG.digestHour);
  if (!due || state.digests.some((d) => d.month === monthKey(start))) return;
  const d = await buildDigest(start, end, monthLabel(start), state, false);
  state.digests.unshift(d);
  state.digests = state.digests.slice(0, 24);
  await saveState(state);
  await notify("Immich digest: " + d.label, digestLine(d));
}

// ---------- web page ----------
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const searchLink = (t: Trip) =>
  CFG.url + "/search?query=" + encodeURIComponent(JSON.stringify({ takenAfter: t.start + "T00:00:00.000Z", takenBefore: t.end + "T23:59:59.999Z" }));

function tripCard(t: Trip, d?: Decision): string {
  const thumbs = t.sample.map((id) => '<img loading="lazy" src="/thumb/' + esc(id) + '" alt="">').join("");
  const head = '<div class="th">' + thumbs + "</div><h3>" + esc(t.name) + "</h3><p class=m>" + esc(t.start) + " to " + esc(t.end) +
    " · " + t.geoIds.length + " with location" + (t.extraIds.length ? ", " + t.extraIds.length + " without" : "") + "<br>" +
    esc(t.places) + ' · <a href="' + esc(searchLink(t)) + '" target=_blank>open in Immich</a></p>';
  if (d) {
    const what = d.status === "approved" ? "Added " + d.count + " to “" + esc(d.album) + "”" : "Dismissed";
    return '<div class="card done">' + head + "<p>" + what + "</p>" +
      (d.status === "dismissed" ? '<form method=post action="/trips/' + esc(t.key) + '/undo"><button>Restore</button></form>' : "") + "</div>";
  }
  const opts = t.overlaps.map((o) => '<option value="' + esc(o.id) + '">Add to “' + esc(o.name) + '”</option>')
    .concat(['<option value="new">Create new album:</option>']).join("");
  return '<div class="card">' + head + '<form method=post action="/trips/' + esc(t.key) + '/approve">' +
    "<select name=target>" + opts + '</select> <input name=name value="' + esc(t.name) + '" aria-label="New album name">' +
    (t.extraIds.length ? ' <label><input type=checkbox name=extra checked> include ' + t.extraIds.length + " without location</label>" : "") +
    ' <button class=pri' + (CFG.dryRun ? " disabled title='Dry run is on'" : "") + ">Approve</button>" +
    ' <button formaction="/trips/' + esc(t.key) + '/dismiss">Dismiss</button></form></div>';
}

function digestHtml(d: Digest): string {
  const faces = d.newUnnamed.map((p) =>
    '<a href="' + esc(CFG.url + "/people/" + p.id) + '" target=_blank><img loading="lazy" src="/face/' + esc(p.id) + '" title="' + p.count + ' photos" alt=""></a>').join("");
  return '<div class=card><h3>' + esc(d.label) + (d.preview ? " (so far)" : "") + "</h3>" +
    (d.baseline ? "<p class=m>First digest, so duplicate groups and unnamed faces below are everything there is today, not just new ones.</p>" : "") + "<ul>" +
    "<li><b>" + d.uploaded + "</b> photos and videos added, <b>" + gb(d.uploadedBytes) + "</b>" + "</li>" +
    "<li><b>" + d.unsorted + "</b> of them are still in no album (screenshots already filed are not counted)</li>" +
    "<li><b>" + d.newDuplicates + "</b> new duplicate groups (" + d.duplicates + ' in total) · <a href="' + esc(CFG.url + "/utilities/duplicates") + '" target=_blank>review</a></li>' +
    "<li><b>" + d.newUnnamedTotal + "</b> new unnamed faces (" + d.unnamed + ' unnamed in total) · <a href="' + esc(CFG.url + "/people") + '" target=_blank>name them</a></li>' +
    (d.disk ? "<li>Disk: " + esc(d.disk.used) + " used, " + esc(d.disk.available) + " free (" + d.disk.percent + "%)</li>" : "") +
    "<li>Immich " + esc(d.version.current) + (d.version.newer
      ? ': <b>' + esc(d.version.latest) + ' is available</b> · <a href="' + esc(d.version.url) + '" target=_blank>release notes</a>'
      : d.version.latest ? " is the latest" : " (could not check GitHub)") + "</li></ul>" +
    (faces ? '<div class="th faces">' + faces + "</div>" : "") + "</div>";
}

const STYLE = "body{font:15px system-ui,sans-serif;margin:0 auto;max-width:900px;padding:16px;background:#f6f6f4;color:#222}" +
  "h1{font-size:22px}h2{margin-top:32px;font-size:18px}h3{margin:8px 0 4px;font-size:16px}.m{color:#666;font-size:13px;margin:0 0 8px}" +
  ".card{background:#fff;border:1px solid #ddd;border-radius:10px;padding:12px;margin:10px 0}.done{opacity:.65}" +
  ".th{display:flex;gap:4px;overflow:hidden}.th img{width:110px;height:80px;object-fit:cover;border-radius:6px;background:#eee}" +
  ".faces img{width:56px;height:56px;border-radius:50%}input[name=name]{width:240px;padding:5px}select,button{padding:5px 8px}" +
  ".pri{background:#3b5bdb;color:#fff;border:0;border-radius:6px}.pri:disabled{background:#999}.warn{background:#fff4d6;padding:8px 12px;border-radius:8px}" +
  "details{margin-top:12px}@media(prefers-color-scheme:dark){body{background:#151515;color:#ddd}.card{background:#1f1f1f;border-color:#333}.m{color:#999}.warn{background:#3d3420}a{color:#8ab4ff}}";

function page(state: State, msg = ""): string {
  const pending = trips.filter((t) => !t.inProgress && !state.decisions[t.key]);
  const ongoing = trips.filter((t) => t.inProgress && !state.decisions[t.key]);
  const decided = trips.filter((t) => state.decisions[t.key]);
  return "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Trip albums & digest</title><style>" + STYLE + "</style>" +
    "<h1>Trip albums & digest</h1><p class=m>Last scan " + esc(state.lastScan ?? "never") + (lastError ? " · last error: " + esc(lastError) : "") +
    ' · <form method=post action=/scan style=display:inline><button>Scan now</button></form></p>' +
    (CFG.dryRun ? "<p class=warn>Dry run is on: nothing is written to Immich (no albums, no notifications).</p>" : "") +
    (msg ? "<p class=warn>" + esc(msg) + "</p>" : "") +
    "<h2>Suggested trip albums (" + pending.length + ")</h2>" + (pending.map((t) => tripCard(t)).join("") || "<p>Nothing to review.</p>") +
    (ongoing.length ? "<h2>Trips still going</h2><p class=m>Suggested once no new away photos arrive for " + CFG.gapDays + " days.</p>" + ongoing.map((t) => tripCard(t)).join("") : "") +
    (decided.length ? "<details><summary>Approved or dismissed (" + decided.length + ")</summary>" + decided.map((t) => tripCard(t, state.decisions[t.key])).join("") + "</details>" : "") +
    "<h2>Monthly digest</h2>" + (state.digests[0] ? digestHtml(state.digests[0]) : "<p>No digest yet.</p>") +
    (preview ? digestHtml(preview) : '<form method=post action=/digest/preview><button>Show this month so far</button></form>') +
    (state.digests.length > 1 ? "<details><summary>Earlier digests</summary>" + state.digests.slice(1).map(digestHtml).join("") + "</details>" : "");
}

async function proxyImage(path: string): Promise<Response> {
  try {
    const r = await api("GET", path, undefined, "image/*");
    return new Response(r.body, { headers: { "Content-Type": r.headers.get("Content-Type") ?? "image/jpeg", "Cache-Control": "max-age=86400" } });
  } catch { return new Response("", { status: 404 }); }
}

const ID = /^[0-9a-f-]{36}/;

async function main() {
  const state = await loadState();
  await get("/albums?shared=false"); // fail fast on bad URL/key
  log("started: dry_run=" + CFG.dryRun + ", home=" + HOME.map((h) => h.region + "/" + h.country).join("; "));

  let busy = false;
  const run = async (job: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try { await job(); lastError = ""; } catch (err) { lastError = String(err); log("error:", lastError); }
    finally { busy = false; }
  };
  const tick = () => run(async () => {
    if (!state.lastScan || Date.now() - Date.parse(state.lastScan) >= CFG.scanHours * 36e5 || !trips.length) await scan(state);
    await maybeDigest(state);
  });
  tick();
  setInterval(tick, 10 * 60_000);

  const back = (msg?: string) => new Response(null, { status: 303, headers: { Location: msg ? "/?msg=" + encodeURIComponent(msg) : "/" } });
  Bun.serve({
    port: CFG.port,
    async fetch(req) {
      const u = new URL(req.url);
      const p = u.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && p.length === 0)
        return new Response(page(state, u.searchParams.get("msg") ?? ""), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      if (req.method === "GET" && p[0] === "thumb" && ID.test(p[1] ?? "")) return proxyImage("/assets/" + p[1] + "/thumbnail?size=thumbnail");
      if (req.method === "GET" && p[0] === "face" && ID.test(p[1] ?? "")) return proxyImage("/people/" + p[1] + "/thumbnail");
      if (req.method !== "POST") return new Response("Not found", { status: 404 });
      if (p[0] === "scan") { await run(() => scan(state)); return back(lastError || "Scan finished."); }
      if (p[0] === "digest" && p[1] === "preview") {
        const now = new Date();
        await run(async () => { preview = await buildDigest(new Date(now.getFullYear(), now.getMonth(), 1), now, monthLabel(now), state, true); });
        return back(lastError);
      }
      const t = trips.find((x) => x.key === p[1]);
      if (p[0] !== "trips" || !t) return back("That suggestion is gone. Scan again.");
      if (p[2] === "dismiss") { state.decisions[t.key] = { status: "dismissed", at: new Date().toISOString() }; await saveState(state); return back(); }
      if (p[2] === "undo") { delete state.decisions[t.key]; await saveState(state); return back(); }
      if (p[2] === "approve") {
        const f = await req.formData();
        const name = String(f.get("name") ?? "").trim() || t.name;
        try {
          state.decisions[t.key] = await approveTrip(t, name, String(f.get("target") ?? "new"), f.get("extra") === "on");
          await saveState(state);
          return back("Done: " + state.decisions[t.key].count + " added to “" + state.decisions[t.key].album + "”.");
        } catch (err) { return back(String(err)); }
      }
      return back();
    },
  });
  log("page on port " + CFG.port);
}

// In a browser (for testing) only the helpers above are defined; on Bun the service starts.
if (typeof Bun !== "undefined") main().catch((err) => { log("fatal:", String(err)); process.exit(1); });
