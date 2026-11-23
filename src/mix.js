// A mix: several sites in one tab. Each pane is a real site in a frame (the background drops the headers that stop
// framing, for this tab only), and every mod the person made for that site still runs inside its pane.
const local = chrome.storage.local;
const id = location.hash.slice(1);
const $ = (s) => document.querySelector(s);
const panesEl = $(".panes");
let mix = null;

const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data }).then((r) => {
  if (!r?.ok) { const e = new Error(r?.error ?? "Something went wrong."); e.link = r?.link; throw e; }
  return r.data;
});
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };
const favicon = (u) => `https://www.google.com/s2/favicons?sz=64&domain=${hostOf(u)}`;

async function save() {
  const { mixes = {} } = await local.get("mixes");
  mixes[id] = mix;
  await local.set({ mixes });
}

async function boot() {
  const { mixes = {} } = await local.get("mixes");
  mix = mixes[id];
  if (!mix) { document.body.textContent = "This mix was removed."; return; }
  await send("mixAllow"); // framing headers off for this tab, before any frame loads
  render(true);
}

/** Pane sizes become grid tracks. focus: first pane big, the rest stacked on the right. */
function tracks() {
  const n = mix.panes.length, s = mix.panes.map((p) => `${p.size}fr`);
  switch (mix.layout) {
    case "rows": return { cols: "1fr", rows: s.join(" "), area: (i) => `${i + 1} / 1 / ${i + 2} / 2` };
    case "grid": {
      const c = Math.ceil(Math.sqrt(n)), r = Math.ceil(n / c);
      return { cols: `repeat(${c}, 1fr)`, rows: `repeat(${r}, 1fr)`, area: (i) => `${Math.floor(i / c) + 1} / ${(i % c) + 1}` };
    }
    case "focus": {
      if (n === 1) return { cols: "1fr", rows: "1fr", area: () => "1 / 1" };
      const rest = mix.panes.slice(1).map((p) => `${p.size}fr`).join(" ");
      return { cols: `${mix.panes[0].size * 2.2}fr 1fr`, rows: rest, area: (i) => (i === 0 ? `1 / 1 / ${n} / 2` : `${i} / 2 / ${i + 1} / 3`) };
    }
    default: return { cols: s.join(" "), rows: "1fr", area: (i) => `1 / ${i + 1} / 2 / ${i + 2}` };
  }
}

const frames = new Map(); // url+index -> pane element (kept across re-layouts so pages don't reload)

function render(first = false) {
  document.title = mix.title;
  $(".title").value = mix.title;
  $("#user-css").textContent = mix.css || "";
  document.querySelectorAll(".layouts button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.layout === mix.layout)));
  const t = tracks();
  panesEl.style.gridTemplateColumns = t.cols;
  panesEl.style.gridTemplateRows = t.rows;
  const keep = new Set();
  mix.panes.forEach((p, i) => {
    const key = `${i}:${p.url}`;
    keep.add(key);
    let el = frames.get(key);
    if (!el) { el = paneEl(p, i); frames.set(key, el); }
    el.style.gridArea = t.area(i);
    el.dataset.i = i;
    el.querySelector(".z").textContent = `${Math.round(p.zoom * 100)}%`;
    applyZoom(el, p.zoom);
    panesEl.append(el);
  });
  for (const [k, el] of frames) if (!keep.has(k)) { el.remove(); frames.delete(k); }
  grips();
  if (first) setTimeout(checkBlocked, 6000);
}

function paneEl(p, i) {
  const el = document.createElement("article");
  el.className = "pane";
  el.innerHTML = `<div class="pane-head" draggable="true"><img alt=""><span class="h"></span>
    <button class="zo" title="Zoom out">−</button><button class="z" title="Reset zoom"></button><button class="zi" title="Zoom in">+</button>
    <button class="rl" title="Reload">↻</button><button class="op" title="Open in its own tab">↗</button><button class="rm" title="Remove from mix">×</button></div>
    <div class="frame-wrap"><iframe allow="autoplay; fullscreen; clipboard-read; clipboard-write; encrypted-media; picture-in-picture"
      sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads allow-presentation allow-storage-access-by-user-activation"></iframe>
      <div class="blocked"><div><b></b><p>This site refused to load inside a mix. Open it in its own tab instead.</p></div></div></div>`;
  el.querySelector("img").src = favicon(p.url);
  el.querySelector(".h").textContent = hostOf(p.url);
  el.querySelector(".blocked b").textContent = hostOf(p.url);
  el.querySelector("iframe").src = p.url;
  const idx = () => Number(el.dataset.i);
  const zoom = (d) => { const q = mix.panes[idx()]; q.zoom = Math.min(1.5, Math.max(0.4, Math.round((d ? q.zoom + d : 1) * 10) / 10)); save(); render(); };
  el.querySelector(".zo").onclick = () => zoom(-0.1);
  el.querySelector(".zi").onclick = () => zoom(0.1);
  el.querySelector(".z").onclick = () => zoom(0);
  el.querySelector(".rl").onclick = () => { const f = el.querySelector("iframe"); f.src = f.src; };
  el.querySelector(".op").onclick = () => chrome.tabs.create({ url: mix.panes[idx()].url });
  el.querySelector(".rm").onclick = () => { mix.panes.splice(idx(), 1); frames.clear(); panesEl.replaceChildren(); save(); render(); };
  // drag a pane's head onto another to swap them
  const head = el.querySelector(".pane-head");
  head.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/remold-pane", String(idx())); document.body.classList.add("dragging"); });
  head.addEventListener("dragend", () => document.body.classList.remove("dragging"));
  el.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/remold-pane")) { e.preventDefault(); el.classList.add("drop"); } });
  el.addEventListener("dragleave", () => el.classList.remove("drop"));
  el.addEventListener("drop", (e) => {
    el.classList.remove("drop");
    const from = Number(e.dataTransfer.getData("text/remold-pane")), to = idx();
    if (Number.isNaN(from) || from === to) return;
    [mix.panes[from], mix.panes[to]] = [mix.panes[to], mix.panes[from]];
    // keep the loaded frames: swap their keys
    const a = [...frames.entries()].find(([, v]) => Number(v.dataset.i) === from), b = [...frames.entries()].find(([, v]) => Number(v.dataset.i) === to);
    frames.clear();
    if (a && b) { frames.set(`${to}:${mix.panes[to].url}`, a[1]); frames.set(`${from}:${mix.panes[from].url}`, b[1]); }
    save(); render();
  });
  // follow the pane's own navigation so the mix remembers where you were
  el.querySelector("iframe").addEventListener("load", () => { el.dataset.loaded = "1"; });
  return el;
}

function applyZoom(el, z) {
  const f = el.querySelector("iframe");
  f.style.width = `${100 / z}%`; f.style.height = `${100 / z}%`; f.style.transform = `scale(${z})`;
}

/** Drag handles between columns/rows change pane sizes. */
function grips() {
  panesEl.querySelectorAll(".grip").forEach((g) => g.remove());
  if (!["columns", "rows"].includes(mix.layout) || mix.panes.length < 2) return;
  const vertical = mix.layout === "columns";
  const els = [...panesEl.querySelectorAll(".pane")].sort((a, b) => a.dataset.i - b.dataset.i);
  for (let i = 1; i < els.length; i++) {
    const g = document.createElement("div");
    g.className = `grip ${vertical ? "v" : "h"}`;
    const r = els[i].getBoundingClientRect(), pr = panesEl.getBoundingClientRect();
    if (vertical) g.style.left = `${r.left - pr.left}px`; else { g.style.top = `${r.top - pr.top}px`; }
    g.style.position = "absolute";
    panesEl.style.position = "relative";
    g.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      g.setPointerCapture(e.pointerId);
      document.body.classList.add("dragging");
      const a = mix.panes[i - 1], b = mix.panes[i], total = a.size + b.size;
      const ra = els[i - 1].getBoundingClientRect(), rb = els[i].getBoundingClientRect();
      const span = vertical ? rb.right - ra.left : rb.bottom - ra.top, start = vertical ? ra.left : ra.top;
      const move = (ev) => {
        const frac = Math.min(0.88, Math.max(0.12, ((vertical ? ev.clientX : ev.clientY) - start) / span));
        a.size = +(total * frac).toFixed(3); b.size = +(total - a.size).toFixed(3);
        const t = tracks();
        panesEl.style.gridTemplateColumns = t.cols; panesEl.style.gridTemplateRows = t.rows;
      };
      const up = () => { g.removeEventListener("pointermove", move); document.body.classList.remove("dragging"); save(); grips(); };
      g.addEventListener("pointermove", move);
      g.addEventListener("pointerup", up, { once: true });
    });
    panesEl.append(g);
  }
}
window.addEventListener("resize", () => grips());

/** A frame that never painted anything we can see is likely blocked (some sites stop framing in other ways). */
function checkBlocked() {
  for (const el of panesEl.querySelectorAll(".pane")) if (!el.dataset.loaded) el.querySelector(".blocked").classList.add("on");
}

// ---------- the bar ----------
document.querySelectorAll(".layouts button").forEach((b) => b.addEventListener("click", () => { mix.layout = b.dataset.layout; save(); render(); }));
$(".title").addEventListener("change", (e) => { mix.title = e.target.value.trim() || mix.title; save(); render(); });
$(".unmix").addEventListener("click", () => send("unmix", { mixId: id }));
$(".add").addEventListener("click", () => {
  const d = document.createElement("dialog");
  d.innerHTML = `<form method="dialog"><b>Add a site to the mix</b><input name="u" placeholder="news.ycombinator.com" autofocus><div class="row"><button class="ghost" value="cancel">Cancel</button><button value="ok">Add</button></div></form>`;
  document.body.append(d);
  d.showModal();
  d.addEventListener("close", () => {
    const v = d.querySelector("input").value.trim();
    d.remove();
    if (d.returnValue !== "ok" || !v) return;
    const url = /^https?:\/\//.test(v) ? v : `https://${v}`;
    try { new URL(url); } catch { return; }
    mix.panes.push({ url, size: 1, zoom: 1 });
    save(); render();
  });
});
$(".ask").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = e.target.q, status = $(".status");
  const q = input.value.trim();
  if (!q) return;
  input.disabled = true; status.textContent = "Arranging…";
  try {
    const r = await send("arrangeMix", { mix, request: q });
    if (r.mix) {
      const urlsBefore = mix.panes.map((p) => p.url).join("|");
      mix = { ...mix, ...r.mix, id };
      if (mix.panes.map((p) => p.url).join("|") !== urlsBefore) { frames.clear(); panesEl.replaceChildren(); }
      await save(); render();
    }
    status.textContent = r.reply; input.value = "";
  } catch (err) { status.textContent = err.message; }
  input.disabled = false; input.focus();
  setTimeout(() => { if (status.textContent && !input.value) status.textContent = ""; }, 6000);
});

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.mixes) { const m = ch.mixes.newValue?.[id]; if (m && JSON.stringify(m) !== JSON.stringify(mix)) { mix = m; render(); } }
});

boot();
