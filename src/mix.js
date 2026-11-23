// The mix tab: every other tab in this Chrome tab group is a live source. Say what you want and Remold reads all of
// them (and visits pages for you if it needs to), then the AI builds one combined view here.
const local = chrome.storage.local;
const id = location.hash.slice(1);
const $ = (s) => document.querySelector(s);
let mix = null, sources = [], busy = false, liveTimer = 0, layoutOverride = null;

const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data }).then((r) => {
  if (!r?.ok) { const e = new Error(r?.error ?? "Something went wrong."); e.link = r?.link; throw e; }
  return r.data;
});
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v; else if (k.startsWith("on")) el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const fav = (site) => `https://www.google.com/s2/favicons?sz=64&domain=${site}`;
const safe = (u) => (typeof u === "string" && /^https?:\/\//.test(u) ? u : null);

// ---------- sources ----------
async function loadSources() {
  try { const r = await send("mixSources", { mixId: id }); mix = r.mix; sources = r.sources; } catch (e) { document.body.textContent = e.message; return; }
  document.title = `${mix.title} · Remold mix`;
  if (document.activeElement !== $(".title")) $(".title").value = mix.title;
  const counts = mix.lastSources ?? {};
  $(".sources").replaceChildren(...(sources.length ? sources.map((s) => h("li", { title: s.url, onclick: () => chrome.tabs.update(s.tabId, { active: true }) },
    h("span", { class: "sid" }, s.sid), h("img", { src: s.favIconUrl || fav(s.host), alt: "" }),
    h("span", { class: "t" }, h("b", {}, s.host), " ", s.title ?? ""), counts[s.host] != null ? h("span", { class: "n" }, `${counts[s.host]} items`) : null))
    : [h("li", {}, h("span", { class: "t" }, "No tabs yet. Drag tabs into this group."))]));
}
chrome.tabs.onUpdated.addListener((_, ch) => { if (ch.status === "complete" || ch.title || "groupId" in ch) loadSources(); });
chrome.tabs.onRemoved.addListener(() => loadSources());
chrome.tabs.onAttached?.addListener(() => loadSources());
$(".title").addEventListener("change", async (e) => {
  const { mixes = {} } = await local.get("mixes");
  if (mixes[id]) { mixes[id].title = e.target.value.trim() || mixes[id].title; await local.set({ mixes }); mix = mixes[id]; }
  if (mix.groupId != null) chrome.tabGroups.update(mix.groupId, { title: mix.title }).catch(() => {});
});

// ---------- chat + run ----------
function chatView(work) {
  const box = $(".chat");
  const items = (mix?.chat ?? []).map((c) => h("div", { class: `msg ${c.role}` }, c.text, c.role === "ai" && c.lookups ? `\n(visited ${c.lookups} pages)` : ""));
  if (!items.length && !work) {
    items.push(h("div", { class: "chips" }, suggestions().map((s) => h("button", { class: "chip", type: "button", onclick: () => run(s) }, s))));
  }
  if (work) items.push(h("div", { class: "msg work" }, h("span", { class: "dot" }), work));
  box.replaceChildren(...items);
  box.scrollTop = box.scrollHeight;
}
function suggestions() {
  const hosts = sources.map((s) => s.host);
  const has = (x) => hosts.some((hh) => hh.includes(x));
  const out = ["Merge everything into one feed, newest first", "Only what's about AI, from every tab", "One table of everything with links"];
  if (has("x.com") && has("linkedin")) out.unshift("Match each X poster to their LinkedIn profile");
  if (has("youtube") && has("x.com")) out.unshift("Pair each YouTube video with what people on X say about it");
  if (hosts.length >= 2) out.push("What do these tabs have in common?");
  return out.slice(0, 5);
}
chrome.runtime.onMessage.addListener((m) => { if (m?.type === "mixProgress" && m.mixId === id && busy) chatView(m.text); });

async function run(prompt) {
  prompt = prompt.trim();
  if (!prompt || busy) return;
  busy = true; layoutOverride = null;
  document.body.classList.add("busy");
  $(".go").disabled = true;
  mix.chat = [...(mix.chat ?? []), { role: "you", text: prompt }];
  chatView(`Reading ${sources.length} tab${sources.length === 1 ? "" : "s"}…`);
  try {
    const r = await send("mixRun", { mixId: id, prompt });
    const { mixes = {} } = await local.get("mixes");
    mix = mixes[id] ?? mix;
    mix.lastSources = Object.fromEntries(r.sources.map((s) => [s.site, s.items]));
    if (mixes[id]) { mixes[id].lastSources = mix.lastSources; await local.set({ mixes }); }
    render();
  } catch (e) {
    mix.chat.push({ role: "err", text: e.message });
  }
  busy = false;
  document.body.classList.remove("busy");
  $(".go").disabled = false;
  chatView();
  loadSources();
}
$(".ask").addEventListener("submit", (e) => { e.preventDefault(); const q = e.target.q.value; e.target.q.value = ""; run(q); });
$(".ask textarea").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $(".ask").requestSubmit(); } });
$(".ask input[name=live]").addEventListener("change", (e) => {
  clearInterval(liveTimer);
  if (e.target.checked) liveTimer = setInterval(() => { if (mix?.prompt && !busy && document.visibilityState === "visible") run(mix.prompt); }, 120_000);
});

// ---------- the view ----------
function render() {
  const v = mix?.view;
  const root = $(".view");
  if (!v) {
    root.replaceChildren(h("div", { class: "empty" },
      h("h1", {}, "Combine your ", h("span", {}, "tabs.")),
      h("p", {}, "Every tab in this group is a source. Ask for anything across them: one merged feed, a table, posts matched to people's profiles on another site, videos paired with what people say about them. Remold reads the tabs, visits pages for you if it has to, and builds it here.")));
    return;
  }
  const layout = layoutOverride ?? v.layout;
  const tools = h("div", { class: "tools" }, ["feed", "cards", "table", "board", "columns"].map((l) =>
    h("button", { "aria-pressed": String(l === layout), onclick: () => { layoutOverride = l; render(); } }, l)));
  const head = h("div", { class: "vhead" }, h("div", {}, h("h1", {}, v.title), v.note ? h("div", { class: "note" }, v.note) : null), tools);
  root.replaceChildren(head, layout === "table" ? table(v) : grouped(v, layout));
}

function srcChip(v, sid) {
  const site = v.sites?.[sid];
  return site ? h("span", { class: "src" }, h("img", { src: fav(site), alt: "" }), site) : null;
}
function card(v, x, i) {
  const link = safe(x.link);
  return h("article", { class: "card", style: `animation-delay:${Math.min(i, 20) * 25}ms` },
    srcChip(v, x.source),
    safe(x.image) ? h("img", { class: "pic", src: x.image, alt: "", loading: "lazy" }) : null,
    x.title ? (link ? h("a", { class: "ttl", href: link, target: "_blank", rel: "noopener" }, x.title) : h("div", { class: "ttl" }, x.title)) : null,
    x.text ? h("div", { class: "txt", onclick: (e) => e.currentTarget.classList.toggle("open") }, x.text) : null,
    x.meta ? h("div", { class: "meta" }, x.meta) : null,
    x.tags?.length ? h("div", { class: "tags" }, x.tags.map((t) => h("span", {}, t))) : null,
    x.fields && Object.keys(x.fields).length ? h("dl", { class: "fields" }, Object.entries(x.fields).flatMap(([k, val]) => [h("dt", {}, k), h("dd", {}, val)])) : null,
    x.related?.length ? h("div", { class: "related" }, h("div", { class: "lab" }, "matched"), x.related.map((r) => h("div", { class: "r" },
      srcChip(v, r.source), " ", safe(r.link) ? h("a", { class: "ttl", href: r.link, target: "_blank", rel: "noopener" }, r.title || r.link) : h("b", {}, r.title || ""),
      r.text ? h("div", {}, r.text) : null, r.meta ? h("div", { class: "meta" }, r.meta) : null))) : null,
    link && !x.title ? h("a", { class: "meta", href: link, target: "_blank", rel: "noopener" }, link) : null);
}
function grouped(v, layout) {
  if (layout === "feed" || layout === "cards") return h("div", { class: `items ${layout}` }, v.items.map((x, i) => card(v, x, i)));
  const key = layout === "columns" ? (x) => v.sites?.[x.source] ?? "other" : (x) => x.group || "Other";
  const groups = new Map();
  for (const x of v.items) { const k = key(x); (groups.get(k) ?? groups.set(k, []).get(k)).push(x); }
  return h("div", { class: `items ${layout}` }, [...groups].map(([k, xs]) => h("div", { class: "col" },
    h("h3", {}, layout === "columns" ? h("img", { src: fav(k), alt: "", width: 14, height: 14 }) : null, `${k} · ${xs.length}`),
    h("div", { class: "stack" }, xs.map((x, i) => card(v, x, i))))));
}
function table(v) {
  const fieldKeys = [...new Set(v.items.flatMap((x) => Object.keys(x.fields ?? {})))].slice(0, 8);
  const cols = ["source", "title", ...fieldKeys, "meta", "matched"];
  return h("table", {}, h("thead", {}, h("tr", {}, cols.map((c) => h("th", {}, c)))),
    h("tbody", {}, v.items.map((x) => h("tr", {}, cols.map((c) => h("td", {},
      c === "source" ? srcChip(v, x.source)
      : c === "title" ? (safe(x.link) ? h("a", { href: x.link, target: "_blank", rel: "noopener" }, x.title || x.text?.slice(0, 120) || x.link) : (x.title || x.text?.slice(0, 120) || ""))
      : c === "meta" ? (x.meta ?? "")
      : c === "matched" ? (x.related ?? []).map((r) => h("div", {}, safe(r.link) ? h("a", { href: r.link, target: "_blank", rel: "noopener" }, r.title || r.link) : (r.title || "")))
      : (x.fields?.[c] ?? "")))))));
}

// ---------- the swarm while it works ----------
(() => {
  const cv = $(".swarm"), cx = cv.getContext("2d");
  const cols = ["#ff5a1f", "#8b7bff", "#ffd23f", "#5ee0ff", "#ff6fae", "#ffffff"];
  const bs = Array.from({ length: 90 }, (_, i) => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, a: Math.random() * 6.28, r: 60 + Math.random() * 320, s: 0.7 + Math.random() * 0.6, c: cols[i % cols.length] }));
  const draw = (now) => {
    const W = cv.clientWidth, H = cv.clientHeight, d = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== W * d) { cv.width = W * d; cv.height = H * d; }
    cx.setTransform(d, 0, 0, d, 0, 0);
    cx.clearRect(0, 0, W, H);
    if (document.body.classList.contains("busy")) for (const b of bs) {
      b.a += 0.01 * b.s;
      const tx = W / 2 + Math.cos(b.a + now / 3000) * b.r * 1.4, ty = H / 2 + Math.sin(b.a * 1.3) * b.r * 0.8;
      b.x += (tx - b.x) * 0.05; b.y += (ty - b.y) * 0.05;
      cx.save(); cx.translate(b.x, b.y); cx.scale(b.s, b.s);
      cx.beginPath(); cx.moveTo(0, 0); cx.lineTo(0, 17); cx.lineTo(4.5, 13); cx.lineTo(7.5, 20); cx.lineTo(10.2, 18.8); cx.lineTo(7.3, 12.4); cx.lineTo(13, 12.4); cx.closePath();
      cx.fillStyle = b.c; cx.fill(); cx.lineWidth = 1.4; cx.strokeStyle = "#050507"; cx.stroke(); cx.restore();
    }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
})();

(async () => { await loadSources(); render(); chatView(); })();
