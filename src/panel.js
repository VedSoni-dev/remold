// The side panel: Sign in with publik, then a chat per site that writes, previews, checks and saves mods.
const $app = document.getElementById("app");
const local = chrome.storage.local;
const MARK = `<svg class="mark" viewBox="0 0 48 48" aria-hidden="true"><rect x="2" y="2" width="44" height="44" rx="13" fill="var(--clay)"/><path d="M14 31.5c0-7.5 4.2-13 10.2-13 4.6 0 7.4 3 7.4 6.6 0 3.1-2.1 5.2-4.8 5.2-2 0-3.3-1.2-3.3-2.9" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round"/><circle cx="33.5" cy="31.5" r="2.6" fill="#fff"/></svg>`;

const state = { gate: null, tab: null, host: null, mods: [], sel: null, busy: false, work: "", menu: false, live: {}, error: null, ctx: [], view: "site", memory: [] };

// ---------- tiny DOM helper ----------
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v; // only for our own static markup
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const send = (type, data = {}) => chrome.runtime.sendMessage({ type, ...data }).then((r) => {
  if (!r?.ok) { const e = new Error(r?.error ?? "Something went wrong."); e.status = r?.status; e.link = r?.link; throw e; }
  return r.data;
});
const favicon = (url) => { try { return `https://www.google.com/s2/favicons?sz=64&domain=${new URL(url).hostname}`; } catch { return ""; } };
const hostOf = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : null; } catch { return null; } };
const uid = () => crypto.randomUUID().slice(0, 8);

// ---------- the gate ----------
let pollUntil = 0, pollTimer = 0;
async function refreshGate(provision = false) {
  state.gate = await send("gate", { provision }).catch((e) => ({ state: "unreachable", message: e.message }));
  if (state.gate.state === "needs_install") state.gate = await send("gate", { provision: true }).catch((e) => ({ state: "unreachable", message: e.message }));
  if (state.gate.state === "ready") { clearTimeout(pollTimer); send("opened").catch(() => {}); await loadTab(); }
  render();
}
function startPoll() {
  pollUntil = Date.now() + 10 * 60_000;
  const tick = async () => {
    await refreshGate();
    if (state.gate.state !== "ready" && Date.now() < pollUntil) pollTimer = setTimeout(tick, 3000);
    else if (state.gate.state !== "ready") { state.gate.timedOut = true; render(); }
  };
  clearTimeout(pollTimer);
  pollTimer = setTimeout(tick, 3000);
}

function gateView() {
  const g = state.gate;
  const wrap = h("section", { class: "gate" }, h("div", { html: MARK }));
  if (!g) return wrap.append(h("div", { class: "note" }, h("span", { class: "spin" }), "Loading…")), wrap;
  wrap.append(h("h1", {}, "Make the internet yours again."));
  if (g.state === "sign_in") {
    wrap.append(
      h("p", {}, "Describe how any site should look or behave, and Remold changes it. Hide what you hate, filter the slop with AI, restyle anything, and use your other tabs as context."),
      h("div", { class: "stack" },
        h("button", { class: "btn clay wide", onclick: () => { chrome.tabs.create({ url: g.claimUrl }); startPoll(); state.gate.waiting = true; render(); } }, "Sign in with publik"),
        h("div", { class: "note" }, g.waiting ? [h("span", { class: "spin" }), "Waiting for you to sign in in your browser."] : g.timedOut ? "No sign-in after 10 minutes. Click Sign in with publik to try again." : "")),
      h("p", { class: "fine" }, "Remold is free and open source on publik, a free software marketplace. Using it through publik earns its builder a share of usage, which keeps it free. Make a free publik account."));
  } else if (g.state === "choose") {
    wrap.append(
      h("p", {}, `${g.handle ? `You are signed in as ${g.handle}.` : "You are signed in to publik."} ${g.what ?? ""} Remold uses AI to write your changes. ${g.hasPlan ? "Connect your plan to use it here." : "Get a publik plan to use it."}`),
      h("div", { class: "stack" },
        g.hasPlan
          ? h("button", { class: "btn clay wide", onclick: async () => { state.gate = await send("choose", { choice: "publik" }); if (state.gate.state === "ready") await loadTab(); render(); } }, "Connect your plan")
          : h("button", { class: "btn clay wide", onclick: () => { chrome.tabs.create({ url: g.topUpUrl }); startPoll(); state.gate.waiting = true; render(); } }, "Get a plan"),
        !g.hasPlan && h("button", { class: "btn ghost wide", onclick: async () => { state.gate = await send("choose", { choice: "publik" }); if (state.gate.state === "ready") await loadTab(); render(); } }, "I already have one"),
        h("div", { class: "note" }, g.waiting ? [h("span", { class: "spin" }), "Waiting for your plan. Finish in your browser."] : "")));
  } else if (g.state === "unreachable") {
    wrap.append(h("p", {}, g.message ?? "publik is not reachable."), h("button", { class: "btn wide", onclick: () => refreshGate(true) }, "Retry"));
  }
  return wrap;
}

// ---------- the current tab ----------
async function loadTab() {
  // ?tab=<id> pins the panel to one tab (opening panel.html in its own tab for testing); otherwise the active tab
  const pinned = Number(new URLSearchParams(location.search).get("tab"));
  const tab = pinned ? await chrome.tabs.get(pinned).catch(() => null) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  state.tab = tab ?? null;
  state.host = tab ? hostOf(tab.url) : null;
  state.ctx = tab && state.host ? await send("contextTabs", { tabId: tab.id }).catch(() => []) : [];
  state.inGroup = !!tab && tab.groupId !== -1;
  state.memory = await send("memoryList").catch(() => []);
  state.mods = ((await local.get("mods")).mods ?? []);
  if (state.draft && state.draft.host !== state.host) state.draft = null;
  if (state.sel && !modsHere().some((m) => m.id === state.sel) && state.draft?.id !== state.sel) state.sel = null;
}
const modsHere = () => state.mods.filter((m) => m.host === state.host || m.spec.scope === "everywhere");
async function saveMods() { await local.set({ mods: state.mods }); }

chrome.tabs.onActivated.addListener(async () => { if (state.gate?.state === "ready") { await loadTab(); render(); } });
chrome.runtime.onMessage.addListener((m) => { if (m?.type === "progress" && state.busy) work(m.text); });
chrome.tabs.onUpdated.addListener(async (id, ch) => { if (state.gate?.state === "ready" && id === state.tab?.id && (ch.url || ch.status === "complete" || "groupId" in ch)) { await loadTab(); render(); } });

// live counts from the page, every 2 s while the panel is open
setInterval(async () => {
  if (state.gate?.state !== "ready" || !state.tab || !state.host) return;
  const r = await chrome.tabs.sendMessage(state.tab.id, { type: "stats" }, { frameId: 0 }).catch(() => null);
  if (!r?.stats) return;
  state.live = r.stats;
  document.querySelectorAll("[data-live]").forEach((el) => { const t = liveText(state.live[el.dataset.live]); el.textContent = t.text; el.classList.toggle("warn", t.warn); });
}, 2000);

function liveText(s) {
  if (!s) return { text: "", warn: false };
  const bits = [];
  const hidden = Object.values(s.hide ?? {}).reduce((a, b) => a + b, 0);
  if (hidden) bits.push(`${hidden} hidden`);
  for (const f of s.filters ?? []) if (f.matched) bits.push(f.judged ? `${f.hidden} of ${f.judged} filtered` : `judging ${f.matched}…`);
  for (const r of s.rewrite ?? []) if (r.rewritten) bits.push(`${r.rewritten} rewritten`);
  for (const m of s.match ?? []) if (m.matched) bits.push(`${m.acted} of ${m.matched} filtered by your list`);
  for (const a of s.ai ?? []) if (a.matched) bits.push(a.done ? `AI on ${a.done}, changed ${a.acted}` : `AI reading ${a.matched}…`);
  if (s.inject) bits.push(`${s.inject} added`);
  if (s.replace) bits.push(`${s.replace} replaced`);
  if (s.errors?.length) return { text: s.errors[s.errors.length - 1].slice(0, 90), warn: true };
  return { text: bits.join(" · ") || "on", warn: false };
}

// ---------- making a mod ----------
function feedbackFrom(spec, s) {
  if (!s) return null;
  const bad = [];
  for (const [sel, n] of Object.entries(s.hide ?? {})) if (!n) bad.push(`hide "${sel}" matched 0 elements`);
  (s.filters ?? []).forEach((f) => { if (!f.matched) bad.push(`filter items "${f.items}" matched 0 elements`); });
  (s.rewrite ?? []).forEach((r) => { if (!r.matched) bad.push(`rewrite items "${r.items}" matched 0 elements`); });
  (s.ai ?? []).forEach((a) => { if (!a.matched) bad.push(`ai items "${a.items}" matched 0 elements`); });
  (s.match ?? []).forEach((m) => { if (!m.matched) bad.push(`match items "${m.items}" matched 0 elements`); });
  if ((spec.inject ?? []).length && !s.inject) bad.push("inject: none of the anchors matched");
  for (const e of s.errors ?? []) if (/^bad /.test(e)) bad.push(e);
  // a mod that only hides things and hid nothing at all is broken; partial misses are fine on sites that vary by page
  const onlyHide = !spec.css && !(spec.filters ?? []).length && !(spec.inject ?? []).length && !(spec.rewrite ?? []).length && !(spec.ai ?? []).length && !(spec.match ?? []).length;
  const total = Object.values(s.hide ?? {}).reduce((a, b) => a + b, 0);
  if (!bad.length) return null;
  if (!onlyHide && bad.length === 1 && total > 0) return null;
  return bad.join("\n");
}

async function ask(text, opts = {}) {
  text = text.trim();
  if (!text || state.busy || !state.tab) return;
  let mod = state.mods.find((m) => m.id === state.sel) ?? (state.draft?.id === state.sel ? state.draft : null);
  if (!mod) mod = state.draft = { id: uid(), host: state.host, enabled: true, created: Date.now(), chat: [], spec: null };
  const existing = state.mods.includes(mod);
  mod.chat.push({ role: "you", text });
  state.busy = true; state.error = null; state.sel = mod.id;
  work("Reading the page…");
  try {
    // this mod's whole conversation goes along (older turns as a short recap), plus Remold's memory in the background
    const turns = mod.chat.filter((c) => c.ai);
    const recap = turns.slice(0, -3).map((c) => `- they asked "${c.ask}" → ${c.text}`).join("\n");
    const history = [...(recap ? [{ role: "user", content: `Earlier in this mod:\n${recap}` }, { role: "assistant", content: "{\"reply\":\"Got it.\",\"mod\":null}" }] : []),
      ...turns.slice(-3).flatMap((c) => [{ role: "user", content: c.ask }, { role: "assistant", content: c.ai }])];
    setTimeout(() => state.busy && state.work === "Reading the page…" && work("Writing your change…"), 1400);
    let out = await send("generate", { tabId: state.tab.id, request: text, current: mod.spec, history, refresh: !!opts.refresh });
    if (!out.mod) { mod.chat.push({ role: "ai", text: out.reply }); finish(mod, existing); return; }
    work("Trying it on the page…");
    let r = await chrome.tabs.sendMessage(state.tab.id, { type: "preview", id: mod.id, spec: out.mod, wait: 1600 }).catch(() => null);
    const fb = feedbackFrom(out.mod, r?.stats);
    if (fb) {
      work("Fixing what didn't match…");
      const fixed = await send("generate", { tabId: state.tab.id, request: text, current: out.mod, feedback: fb, history });
      if (fixed.mod) { out = fixed; r = await chrome.tabs.sendMessage(state.tab.id, { type: "preview", id: mod.id, spec: out.mod, wait: 1600 }).catch(() => null); }
    }
    const prev = mod.spec;
    mod.spec = out.mod;
    mod.host = out.mod.scope === "everywhere" ? state.host : (out.host || state.host);
    mod.updated = Date.now();
    const extra = [out.read ? `read ${out.read} page${out.read === 1 ? "" : "s"} from your other tabs` : "", out.remembered?.length ? `remembered: ${out.remembered.map((m) => m.text).join("; ")}` : ""].filter(Boolean).join(" · ");
    mod.chat.push({ role: "ai", text: out.reply, ask: text, ai: JSON.stringify({ reply: out.reply, mod: out.mod }), prev: prev ?? null, stats: [liveText(r?.stats).text, extra].filter(Boolean).join(" · ") });
    if (out.remembered?.length) state.memory = await send("memoryList").catch(() => state.memory);
    if (!state.mods.includes(mod)) state.mods.unshift(mod);
    await saveMods();
    await chrome.tabs.sendMessage(state.tab.id, { type: "preview", id: mod.id, spec: null, wait: 0 }).catch(() => {});
    finish(mod, existing);
  } catch (e) {
    await chrome.tabs.sendMessage(state.tab.id, { type: "preview", id: mod.id, spec: null, wait: 0 }).catch(() => {});
    mod.chat.push({ role: "err", text: e.message, link: e.link ?? null });
    if (existing) await saveMods();
    finish(mod, existing);
  }
}
function finish(mod) {
  state.busy = false; state.work = "";
  state.draft = state.mods.includes(mod) ? null : mod;
  render();
  const t = document.querySelector(".scroll"); if (t) t.scrollTop = t.scrollHeight;
}
function work(text) { state.work = text; render(); const t = document.querySelector(".scroll"); if (t) t.scrollTop = t.scrollHeight; }

async function undo(mod, i) {
  const c = mod.chat[i];
  if (c.prev) mod.spec = c.prev;
  else { state.mods = state.mods.filter((m) => m !== mod); state.sel = null; await saveMods(); render(); return; }
  mod.chat.push({ role: "ai", text: "Undone. Back to how it was before that change." });
  await saveMods(); render();
}

// ---------- the ready view ----------
function suggestions(host) {
  const by = {
    "x.com": ["Hide posts that look AI-written", "Collapse spam, scams and engagement bait", "Remove the right sidebar and trends", "Make it warm paper colours with a serif font", "Hide like and view counts"],
    "twitter.com": ["Hide posts that look AI-written", "Remove the right sidebar and trends"],
    "youtube.com": ["Get rid of thumbnails", "Remove Shorts everywhere", "Hide the recommendations sidebar", "Open on my subscriptions, not the home feed", "Rewrite clickbait titles as plain ones"],
    "reddit.com": ["Hide promoted posts", "Collapse rage bait", "Make it compact like old reddit"],
    "linkedin.com": ["Collapse humblebrag and AI-written posts", "Hide promoted posts and the news sidebar"],
    "instagram.com": ["Hide Reels and Explore", "Remove suggested posts"],
    "news.ycombinator.com": ["Give it a calmer, roomier layout", "Dim posts about crypto"],
  };
  const key = Object.keys(by).find((k) => host === k || host?.endsWith(`.${k}`));
  const ctx = state.ctx.map((t) => t.host);
  const withCtx = [];
  if (key === "youtube.com" && ctx.some((c) => c.includes("x.com"))) withCtx.push("Only show videos from creators in my X feed");
  if (key === "x.com" && ctx.some((c) => c.includes("youtube"))) withCtx.push("Highlight posts from YouTubers I'm watching");
  if (key === "linkedin.com" && ctx.some((c) => c.includes("x.com"))) withCtx.push("Only show posts from people I follow on X");
  if (!withCtx.length && ctx.length) withCtx.push(`Use what's in my ${ctx[0]} tab to filter this page`);
  return withCtx.concat(key ? by[key] : ["Dark mode that actually looks good", "Hide ads, popups and cookie banners", "Bigger, calmer text for reading", "Make it look like a 1999 website"]).slice(0, 6);
}

function readyView() {
  const g = state.gate;
  const top = h("header", { class: "top" },
    h("div", { class: "site" },
      state.host ? h("img", { src: favicon(state.tab.url), alt: "" }) : h("div", { html: MARK.replace('class="mark"', 'width="18" height="18"') }),
      h("span", { class: "host" }, state.host ?? "Remold")),
    h("button", { class: "who", onclick: () => { state.menu = !state.menu; render(); } }, g.handle ?? "publik"));
  const out = [top];
  if (state.menu) out.push(menuView());
  if (state.view === "library") { out.push(libraryView()); return out; }

  if (!state.host) {
    out.push(h("div", { class: "blocked" }, h("div", {},
      h("h2", {}, "Open a website"),
      h("p", {}, "Remold works on normal websites. Chrome doesn't let extensions change its own pages or the Web Store."),
      h("div", { class: "stack", style: "margin-top:14px" }, h("button", { class: "btn ghost small", onclick: () => { state.view = "library"; render(); } }, "Everything you've made")))));
    return out;
  }

  const scroll = h("div", { class: "scroll" });
  // the other tabs Remold can read for context while remolding this site
  if (state.ctx.length) {
    scroll.append(h("div", { class: "card ctx" },
      h("div", { class: "ctx-t" }, `Context: Remold can read your ${state.inGroup ? "other tabs in this group" : "other open tabs"}`),
      h("div", { class: "ctx-tabs" }, state.ctx.slice(0, 8).map((t) => h("span", { class: "ctx-tab", title: t.title }, h("img", { src: favicon(t.url), alt: "" }), t.host))),
      h("div", { class: "ctx-s" }, state.inGroup ? "Add a tab to this group to use it." : "Tip: put tabs in a tab group to choose exactly which ones.")));
  }

  const here = modsHere();
  const sel = state.mods.find((m) => m.id === state.sel) ?? (state.draft?.id === state.sel ? state.draft : null);
  if (here.length) {
    scroll.append(h("div", { class: "label" }, `Your mods on ${state.host}`));
    scroll.append(h("div", { class: "mods" }, here.map((m) => h("div", { class: `mod${m.id === state.sel ? " sel" : ""}`, onclick: () => { state.sel = state.sel === m.id ? null : m.id; render(); } },
      h("div", { class: "t" }, m.spec.title, m.spec.scope === "everywhere" ? " · every site" : "", m.spec.context?.length ? ` · uses ${[...new Set(m.spec.context.map((c) => c.tab || hostOf(c.url)))].join(", ")}` : ""),
      h("div", { class: "acts" },
        h("button", { class: "x", title: "Delete this mod", "aria-label": `Delete ${m.spec.title}`, onclick: async (e) => { e.stopPropagation(); await deleteMod(m); } }, "×"),
      h("button", { class: "toggle", role: "switch", "aria-checked": String(!!m.enabled), "aria-label": `Turn ${m.spec.title} ${m.enabled ? "off" : "on"}`,
        onclick: async (e) => { e.stopPropagation(); m.enabled = !m.enabled; await saveMods(); render(); } })),
      h("div", { class: "s" }, m.spec.summary || " "),
      m.enabled && h("div", { class: "live", "data-live": m.id }, liveText(state.live[m.id]).text)))));
  }

  if (sel) {
    const thread = h("div", { class: "thread" });
    sel.chat.forEach((c, i) => {
      if (c.role === "you") thread.append(h("div", { class: "msg you" }, c.text));
      else if (c.role === "err") thread.append(h("div", { class: "msg err" }, c.text, c.link ? h("div", { style: "margin-top:6px" }, h("a", { href: c.link, target: "_blank" }, "Top up on publik")) : null));
      else thread.append(h("div", { class: "msg ai" }, c.text, c.stats ? h("span", { class: "meta" }, c.stats) : null,
        c.ai && i === sel.chat.length - 1 && state.mods.includes(sel) ? h("div", { class: "row" }, h("button", { class: "btn ghost small", onclick: () => undo(sel, i) }, c.prev ? "Undo this change" : "Undo")) : null));
    });
    if (state.busy) thread.append(h("div", { class: "msg work" }, h("span", { class: "spin" }), state.work));
    scroll.append(h("div", { class: "thread-head" },
      h("div", { class: "label" }, state.mods.includes(sel) ? `Editing “${sel.spec.title}”` : "New mod"),
      h("div", { style: "display:flex;gap:12px" },
        state.mods.includes(sel) && h("button", { class: "linkish", onclick: async () => { sel.spec.scope = sel.spec.scope === "everywhere" ? "site" : "everywhere"; await saveMods(); render(); } }, sel.spec.scope === "everywhere" ? "Only this site" : "Every site"),
        state.mods.includes(sel) && sel.spec.context?.length && h("button", { class: "linkish", disabled: state.busy, onclick: () => ask("Refresh the data you read from my other tabs and update the mod with it. Keep everything else.", { refresh: true }) }, "Refresh context"),
        state.mods.includes(sel) && h("button", { class: "linkish", onclick: () => deleteMod(sel) }, "Delete"),
        h("button", { class: "linkish", onclick: () => { state.sel = null; state.draft = null; render(); } }, "New mod"))));
    scroll.append(thread);
  } else {
    scroll.append(h("div", { class: "empty" },
      h("h2", {}, here.length ? "Change something else" : `Remold ${state.host}`),
      h("p", {}, "Say what you want in plain words. Remold reads the page, writes the change and checks it worked."),
      h("div", { class: "chips" }, suggestions(state.host).map((s) => h("button", { class: "chip", onclick: () => ask(s) }, s)))));
  }
  out.push(scroll);

  const ta = h("textarea", { rows: "1", placeholder: sel && state.mods.includes(sel) ? "Change this mod…" : `Describe a change to ${state.host}…`, disabled: state.busy,
    oninput: (e) => { e.target.style.height = "auto"; e.target.style.height = `${e.target.scrollHeight}px`; btn.disabled = !e.target.value.trim() || state.busy; },
    onkeydown: (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const v = ta.value; ta.value = ""; ask(v); } } });
  const btn = h("button", { class: "send", disabled: true, "aria-label": "Send", html: `<svg width="14" height="14" viewBox="0 0 16 16"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    onclick: () => { const v = ta.value; ta.value = ""; ask(v); } });
  out.push(h("footer", { class: "composer" }, h("div", { class: "box" }, ta, btn),
    h("div", { class: "hint" }, h("span", {}, "Enter to send"), h("span", {}, "AI by publik"))));
  return out;
}

async function deleteMod(m) {
  if (!confirm(`Delete "${m.spec?.title ?? "this mod"}"? It stops running everywhere and can't be undone.`)) return;
  state.mods = state.mods.filter((x) => x.id !== m.id);
  if (state.sel === m.id) state.sel = null;
  await saveMods(); render();
}

/** Everything they've made, on every site, and everything Remold remembers about them. All deletable. */
function libraryView() {
  const wrap = h("div", { class: "scroll" });
  wrap.append(h("div", { class: "thread-head" }, h("div", { class: "label" }, "Everything you've made"), h("button", { class: "linkish", onclick: () => { state.view = "site"; render(); } }, "← Back")));
  const byHost = new Map();
  for (const m of state.mods) (byHost.get(m.host) ?? byHost.set(m.host, []).get(m.host)).push(m);
  if (!byHost.size) wrap.append(h("p", { class: "muted" }, "No mods yet. Open a site and say what you want."));
  for (const [hostName, list] of byHost) {
    wrap.append(h("div", { class: "lib-host" }, h("img", { src: `https://www.google.com/s2/favicons?sz=64&domain=${hostName}`, alt: "" }), hostName, h("span", { class: "muted" }, ` · ${list.length}`)));
    wrap.append(h("div", { class: "mods" }, list.map((m) => h("div", { class: "mod" },
      h("div", { class: "t" }, m.spec.title, m.spec.scope === "everywhere" ? " · every site" : ""),
      h("div", { class: "acts" },
        h("button", { class: "x", title: "Delete", "aria-label": `Delete ${m.spec.title}`, onclick: () => deleteMod(m) }, "×"),
        h("button", { class: "toggle", role: "switch", "aria-checked": String(!!m.enabled), "aria-label": `Turn ${m.spec.title} ${m.enabled ? "off" : "on"}`, onclick: async () => { m.enabled = !m.enabled; await saveMods(); render(); } })),
      h("div", { class: "s" }, m.spec.summary || " ")))));
  }
  // memory
  wrap.append(h("div", { class: "thread-head", style: "margin-top:10px" }, h("div", { class: "label" }, "What Remold remembers about you"),
    state.memory.length ? h("button", { class: "linkish", onclick: async () => { if (confirm("Forget everything Remold remembers about you?")) { state.memory = await send("memoryClear"); render(); } } }, "Forget all") : null));
  wrap.append(h("p", { class: "muted" }, "Remold keeps short notes about your taste from every chat and uses them on every site. Delete anything."));
  wrap.append(h("div", { class: "mem" }, state.memory.length ? state.memory.slice().reverse().map((f) => h("div", { class: "mem-row" },
    h("span", {}, f.host ? h("b", {}, `${f.host} · `) : null, f.text),
    h("button", { class: "x", "aria-label": "Forget this", title: "Forget this", onclick: async () => { state.memory = await send("memoryDelete", { id: f.id }); render(); } }, "×")))
    : [h("p", { class: "muted" }, "Nothing yet.")]));
  const add = h("input", { class: "mem-add", placeholder: "Tell Remold something to remember…", onkeydown: async (e) => { if (e.key === "Enter" && add.value.trim()) { state.memory = await send("memoryAdd", { text: add.value.trim() }); render(); } } });
  wrap.append(add);
  if (state.mods.length) wrap.append(h("button", { class: "btn ghost small", style: "margin-top:16px;align-self:flex-start", onclick: async () => {
    if (!confirm(`Delete all ${state.mods.length} mods on every site? This can't be undone.`)) return;
    state.mods = []; state.sel = null; await saveMods(); render();
  } }, "Delete all mods"));
  return wrap;
}

function menuView() {
  const m = h("div", { class: "menu" });
  m.append(h("div", { class: "sub" }, `Signed in with publik${state.gate.handle ? ` as ${state.gate.handle}` : ""} · ${state.gate.plan}`));
  m.append(h("button", { onclick: () => { state.view = "library"; state.menu = false; render(); } }, `Everything you've made (${state.mods.length})`),
    h("button", { onclick: () => { state.view = "library"; state.menu = false; render(); } }, `Memory (${state.memory.length})`));
  if (state.gate.topUpUrl) m.append(h("a", { href: state.gate.topUpUrl, target: "_blank" }, "Your publik wallet"));
  const cc = h("button", { onclick: toggleCustomCode }, "Custom code: …");
  send("userScriptsStatus").then((s) => { cc.textContent = `Custom code: ${s.on && s.enabled ? "on" : s.on ? "needs “Allow User Scripts”" : "off"}`; }).catch(() => {});
  m.append(cc, h("div", { class: "sub" }, "Lets the AI write JavaScript when the kit can't do something. Off by default."));
  m.append(h("hr"), h("a", { href: "https://github.com/VedSoni-dev/remold", target: "_blank" }, "Source code (MIT)"),
    h("button", { onclick: async () => { state.gate = await send("signOut"); state.menu = false; render(); } }, "Sign out"));
  return m;
}
async function toggleCustomCode() {
  const s = await send("userScriptsStatus");
  if (s.on) { await local.set({ customCode: false }); state.menu = false; render(); return; }
  const granted = s.granted || (await chrome.permissions.request({ permissions: ["userScripts"] }).catch(() => false));
  if (!granted) return;
  await local.set({ customCode: true });
  const s2 = await send("userScriptsStatus");
  if (!s2.enabled) chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
  state.menu = false; render();
}

function render() {
  $app.replaceChildren(...(state.gate?.state === "ready" ? readyView() : [gateView()]));
  const ta = $app.querySelector("textarea"); if (ta && !state.busy) ta.focus({ preventScroll: true });
}
document.addEventListener("click", (e) => { if (state.menu && !e.target.closest(".menu,.who")) { state.menu = false; render(); } });

render();
refreshGate(true);
