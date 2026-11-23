// Remold's service worker: publik sign-in, every AI call, mod generation, the filter cache, custom code, and mixes.
import * as publik from "./publik.js";
import { AI_EACH_SYSTEM, FILTER_SYSTEM, MIX_SYSTEM, MOD_SYSTEM, REWRITE_SYSTEM, aiEachUserMessage, filterUserMessage, mixUserMessage, modUserMessage, rewriteUserMessage } from "./prompts.js";

const local = chrome.storage.local;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "remold-open", title: "Remold this site", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "remold-mix-group", title: "Combine this tab group into one tab", contexts: ["page", "action"] });
  });
});
chrome.runtime.onStartup.addListener(() => { publik.sendUsage("app_opened"); });

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "remold-open" && tab) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  if (info.menuItemId === "remold-mix-group" && tab) {
    if (!(await publik.isReady())) { chrome.sidePanel.open({ tabId: tab.id }).catch(() => {}); return; }
    if (tab.groupId !== -1) mixFromGroup(tab.groupId); else chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

// Usage: active_session every 30 minutes while the browser runs (publik's rule; the sender throttles itself).
chrome.alarms.create("remold-usage", { periodInMinutes: 30 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "remold-usage") publik.sendUsage("active_session"); });

// ---------- messages ----------

const handlers = {
  async gate({ provision }) { return publik.gate({ provision }); },
  async choose({ choice }) { await publik.setChoice(choice); publik.sendUsage("app_opened"); return publik.gate(); },
  async signOut() { await publik.signOut(); return publik.gate(); },
  async opened() { publik.sendUsage("app_opened"); return true; },

  /** The panel asks for a mod: snapshot the tab, ask the AI, return { reply, mod }. */
  async generate({ tabId, request, current, feedback, history }) {
    const snap = await snapshot(tabId);
    const customCode = await customCodeOn();
    const messages = [...(history ?? []).slice(-6),
      { role: "user", content: modUserMessage({ ...snap, current, request, customCode, feedback }) }];
    const text = await publik.chat({ system: MOD_SYSTEM, messages, tier: "smart", maxTokens: 6000 });
    const out = parseJSON(text);
    if (!out || typeof out !== "object") throw new Error("The AI answered in a shape Remold could not read. Try again.");
    const mod = out.mod && typeof out.mod === "object" ? cleanMod(out.mod, customCode) : null;
    return { reply: String(out.reply ?? (mod ? mod.summary : "Done.")).slice(0, 600), mod, host: snap.host };
  },

  /** Judge items against a filter rule. Cached by text, so each post is judged once. */
  async classify({ rule, items }) {
    const cache = await verdicts();
    const ruleKey = await hash(rule);
    const ask = [], out = {};
    for (const it of items) {
      const k = `${ruleKey}:${it.h}`;
      if (k in cache.map) out[it.h] = cache.map[k]; else ask.push(it);
    }
    for (let i = 0; i < ask.length; i += 20) {
      const chunk = ask.slice(i, i + 20);
      const text = await publik.chat({ system: FILTER_SYSTEM, messages: [{ role: "user", content: filterUserMessage(rule, chunk.map((c) => c.text)) }], tier: "fast", maxTokens: 300 });
      const j = parseJSON(text);
      const hit = new Set((Array.isArray(j?.match) ? j.match : []).map(Number));
      chunk.forEach((c, n) => { out[c.h] = hit.has(n + 1); cache.put(`${ruleKey}:${c.h}`, out[c.h]); });
    }
    cache.save();
    return out;
  },

  /** The kit's "ai" block: one question about each element. answer: yesno | label | text | pick (one of choices). */
  async aiEach({ ask, answer, choices, items }) {
    const cache = await verdicts("aiEach", 8000);
    const key = await hash(`${answer}|${ask}|${(choices ?? []).join(",")}`);
    const ask2 = [], out = {};
    for (const it of items) { const k = `${key}:${it.h}`; if (k in cache.map) out[it.h] = cache.map[k]; else ask2.push(it); }
    for (let i = 0; i < ask2.length; i += 20) {
      const chunk = ask2.slice(i, i + 20);
      const text = await publik.chat({ system: AI_EACH_SYSTEM, messages: [{ role: "user", content: aiEachUserMessage(ask, answer, choices, chunk.map((c) => c.text)) }], tier: "fast", maxTokens: answer === "text" ? 2500 : 900 });
      const arr = parseJSON(text)?.answers;
      chunk.forEach((c, n) => {
        let v = Array.isArray(arr) ? arr[n] : null;
        if (answer === "yesno") v = v === true || v === "yes";
        else if (answer === "pick") v = (choices ?? []).includes(v) ? v : null;
        else v = typeof v === "string" && v.trim() ? v.trim() : null;
        out[c.h] = v; cache.put(`${key}:${c.h}`, v);
      });
    }
    cache.save();
    return out;
  },

  /** Free-form AI, for custom code (remold.ai). */
  async aiRaw({ prompt, system, tier, json }) {
    const text = await publik.chat({ system: [system, json ? "Answer with one JSON value only: no prose, no code fence." : ""].filter(Boolean).join("\n\n") || undefined,
      messages: [{ role: "user", content: String(prompt).slice(0, 30_000) }], tier: ["fast", "balanced", "smart"].includes(tier) ? tier : "fast", maxTokens: 3000 });
    return json ? parseJSON(text) ?? (() => { try { return JSON.parse(text); } catch { return text; } })() : text;
  },

  async rewrite({ instruction, items }) {
    const cache = await verdicts("rewrites", 3000);
    const key = await hash(instruction);
    const ask = [], out = {};
    for (const it of items) {
      const k = `${key}:${it.h}`;
      if (k in cache.map) out[it.h] = cache.map[k]; else ask.push(it);
    }
    for (let i = 0; i < ask.length; i += 15) {
      const chunk = ask.slice(i, i + 15);
      const text = await publik.chat({ system: REWRITE_SYSTEM, messages: [{ role: "user", content: rewriteUserMessage(instruction, chunk.map((c) => c.text)) }], tier: "fast", maxTokens: 1500 });
      const arr = parseJSON(text)?.out;
      chunk.forEach((c, n) => { const v = Array.isArray(arr) && typeof arr[n] === "string" ? arr[n] : c.text; out[c.h] = v; cache.put(`${key}:${c.h}`, v); });
    }
    cache.save();
    return out;
  },

  /** Custom code (only if the person turned it on and Chrome's "Allow User Scripts" is on). */
  async runjs({ code }, sender) {
    if (!(await customCodeOn()) || !chrome.userScripts?.execute) return { ran: false, why: "off" };
    await chrome.userScripts.configureWorld({ messaging: true }).catch(() => {});
    await chrome.userScripts.execute({ target: { tabId: sender.tab.id, frameIds: [sender.frameId ?? 0] }, js: [{ code: `${REMOLD_API}\n;(async () => {\n${code}\n})().catch((e) => console.warn("[remold]", e));` }], world: "USER_SCRIPT", injectImmediately: true });
    return { ran: true };
  },
  async userScriptsStatus() {
    const granted = await chrome.permissions.contains({ permissions: ["userScripts"] });
    let enabled = false;
    if (granted) { try { await chrome.userScripts.getScripts(); enabled = typeof chrome.userScripts.execute === "function"; } catch { enabled = false; } }
    return { granted, enabled, on: (await local.get("customCode")).customCode === true };
  },

  // ---------- mixes: a tab group's tabs feed one new tab that combines their data ----------
  async mixFromGroup({ groupId }) { return mixFromGroup(groupId); },
  async mixFromTabs({ tabIds, title }) { return mixFromTabs(tabIds, title); },
  async mixSources({ mixId }) { return mixSources(mixId); },
  async mixRun({ mixId, prompt }, sender) { return mixRun(mixId, prompt, sender); },
};

// Custom code talks to Remold through chrome.runtime.sendMessage in its own world; only the AI calls are open to it.
chrome.runtime.onUserScriptMessage?.addListener((msg, sender, respond) => {
  const allowed = { ai: handlers.aiRaw, each: handlers.aiEach };
  const h = allowed[msg?.type];
  if (!h) return false;
  Promise.resolve(h(msg, sender)).then((data) => respond({ ok: true, data }), (e) => respond({ ok: false, error: e?.message ?? String(e) }));
  return true;
});

/** What custom code gets: window.remold. Real-time AI on anything on screen. */
const REMOLD_API = `if (!globalThis.remold) {
  const call = (m) => chrome.runtime.sendMessage(m).then((r) => { if (!r?.ok) throw new Error(r?.error || "Remold AI failed"); return r.data; });
  const hashOf = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36) + s.length; };
  const textOf = (x) => (typeof x === "string" ? x : (x?.innerText || "")).replace(/\\s+/g, " ").trim().slice(0, 900);
  const each = async (els, ask, answer, choices) => {
    const items = [...els].map((e) => ({ h: hashOf(textOf(e)), text: textOf(e) }));
    const r = await call({ type: "each", ask, answer, choices, items });
    return items.map((it) => r[it.h]);
  };
  globalThis.remold = {
    /** Ask the AI anything. remold.ai("prompt", { json: true, tier: "fast"|"balanced"|"smart", system }) */
    ai: (prompt, o = {}) => call({ type: "ai", prompt, ...o }),
    /** true/false per element or string: does it match the rule? */
    judge: (els, rule) => each(els, rule, "yesno"),
    /** a short label per element (e.g. "sentiment in one word") */
    label: (els, ask) => each(els, ask, "label"),
    /** one of the choices per element */
    pick: (els, ask, choices) => each(els, ask, "pick", choices),
    /** new text per element */
    rewrite: (els, instruction) => each(els, instruction, "text"),
    /** Everything readable on screen right now. */
    screenText: (max = 6000) => { const out = []; const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n, len = 0;
      while ((n = w.nextNode()) && len < max) { const t = n.nodeValue.replace(/\\s+/g, " ").trim(); if (!t || n.parentElement.closest("script,style")) continue;
        const r = n.parentElement.getBoundingClientRect(); if (r.bottom < 0 || r.top > innerHeight || !r.width) continue; out.push(t); len += t.length + 1; } return out.join(" ").slice(0, max); },
    /** Call fn(el) once for every element matching selector as it comes on screen (now and as the page scrolls or grows). */
    onScreen: (selector, fn, margin = "600px") => { const seen = new WeakSet(), io = new IntersectionObserver((es) => es.forEach((e) => {
        if (e.isIntersecting && !seen.has(e.target)) { seen.add(e.target); io.unobserve(e.target); Promise.resolve(fn(e.target)).catch((x) => console.warn("[remold]", x)); } }), { rootMargin: margin });
      const scan = () => document.querySelectorAll(selector).forEach((el) => { if (!seen.has(el) && !el.__remoldObs) { el.__remoldObs = 1; io.observe(el); } });
      scan(); new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true }); },
    /** Put a small label on an element. */
    badge: (el, text) => { const b = document.createElement("span"); b.dataset.remoldBy = "js"; b.textContent = text;
      b.style.cssText = "display:inline-block;margin:0 6px 4px 0;padding:2px 8px;border-radius:999px;font:600 11px/1.5 system-ui,sans-serif;background:#c4572e;color:#fff"; el.prepend(b); return b; },
  };
}`;

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  const h = handlers[msg?.type];
  if (!h) return false;
  Promise.resolve(h(msg, sender)).then((data) => respond({ ok: true, data }),
    (e) => respond({ ok: false, error: e?.message ?? String(e), status: e?.status ?? 500, link: e?.link ?? null }));
  return true;
});

// ---------- helpers ----------

async function snapshot(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: "snapshot" }, { frameId: 0 });
    if (r?.outline) return r;
  } catch { /* no content script yet: inject it */ }
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["src/content.js"] }).catch(() => {});
  const r = await chrome.tabs.sendMessage(tabId, { type: "snapshot" }, { frameId: 0 }).catch(() => null);
  if (!r?.outline) throw new Error("Remold can't read this page. Chrome blocks extensions on its own pages and the Web Store; try a normal website.");
  return r;
}

const customCodeOn = async () => (await local.get("customCode")).customCode === true;

export function parseJSON(text) {
  if (typeof text !== "string") return null;
  const t = text.replace(/^```(?:json)?/m, "").replace(/```\s*$/m, "").trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === "{") depth++; else if (c === "}" && --depth === 0) {
      try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
const arr = (v) => (Array.isArray(v) ? v : []);
const ACTIONS = new Set(["hide", "show", "toggle", "click", "scroll_to", "focus", "add_class", "remove_class", "toggle_class", "open_url", "scroll_by"]);

export function cleanMod(m, customCode) {
  return {
    title: str(m.title, 80) || "Untitled mod",
    summary: str(m.summary, 300),
    scope: m.scope === "everywhere" ? "everywhere" : "site",
    paths: arr(m.paths).map((p) => str(p, 200)).filter(Boolean).slice(0, 10),
    css: str(m.css, 40_000),
    hide: arr(m.hide).map((s) => str(s, 400)).filter(Boolean).slice(0, 60),
    filters: arr(m.filters).filter((f) => f && f.items && f.hide_if).slice(0, 6).map((f) => ({
      items: str(f.items, 400), text: str(f.text, 400), hide_if: str(f.hide_if, 600),
      action: ["hide", "collapse", "blur", "dim"].includes(f.action) ? f.action : "collapse", label: str(f.label, 40) || "Filtered",
      also_next: Math.min(3, Math.max(0, Number(f.also_next) || 0)) })),
    rewrite: arr(m.rewrite).filter((r) => r && r.items && r.instruction).slice(0, 3).map((r) => ({ items: str(r.items, 400), instruction: str(r.instruction, 600) })),
    replace: arr(m.replace).filter((r) => r && r.find).slice(0, 20).map((r) => ({ find: str(r.find, 300), with: str(r.with, 500), flags: str(r.flags, 6).replace(/[^gimsu]/g, "") || "g", in: str(r.in, 400) })),
    inject: arr(m.inject).filter((i) => i && i.at && i.html).slice(0, 12).map((i) => ({ at: str(i.at, 400), where: ["before", "after", "prepend", "append"].includes(i.where) ? i.where : "append", html: str(i.html, 20_000) })),
    actions: arr(m.actions).filter((a) => a && ACTIONS.has(a.do)).slice(0, 20).map((a) => ({
      on: ["load", "click", "key"].includes(a.on) ? a.on : "load", key: str(a.key, 20), trigger: str(a.trigger, 400), do: a.do, target: str(a.target, 400), value: str(a.value, 400) })),
    ai: arr(m.ai).filter((a) => a && a.items && a.ask && ["hide", "collapse", "blur", "dim", "badge", "replace", "style"].includes(a.then)).slice(0, 6).map((a) => ({
      items: str(a.items, 400), text: str(a.text, 400), ask: str(a.ask, 800), then: a.then, label: str(a.label, 40), badge_at: str(a.badge_at, 300),
      also_next: Math.min(3, Math.max(0, Number(a.also_next) || 0)),
      styles: a.then === "style" && a.styles && typeof a.styles === "object" ? Object.fromEntries(Object.entries(a.styles).slice(0, 8).map(([k, v]) => [str(k, 30), str(v, 600)])) : undefined })),
    redirect: arr(m.redirect).filter((r) => r && r.from && r.to).slice(0, 5).map((r) => ({ from: str(r.from, 300), to: str(r.to, 500) })),
    js: customCode ? str(m.js, 40_000) : "",
  };
}


async function hash(s) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A capped key → value cache in storage.local (oldest dropped first). */
async function verdicts(name = "verdicts", cap = 8000) {
  const map = (await local.get(name))[name] ?? {};
  let dirty = false;
  return {
    map,
    put(k, v) { map[k] = v; dirty = true; },
    save() {
      if (!dirty) return;
      const keys = Object.keys(map);
      for (let i = 0; i < keys.length - cap; i++) delete map[keys[i]];
      local.set({ [name]: map });
    },
  };
}

// ---------- mixes: many tabs, one combined view ----------
// A mix lives in its own tab inside a Chrome tab group. Every other tab in that group is a live source: Remold reads
// each one (the items on the page, their links and images, the visible text), the person says what they want, and the
// AI builds one view from all of it. It can also visit pages for them (in background tabs, signed in as them), e.g.
// look up each poster on another site, before it builds the view.

const MIX_URL = chrome.runtime.getURL("src/mix.html");
const isMixTab = (t) => (t.url ?? t.pendingUrl ?? "").startsWith(MIX_URL);

async function mixFromGroup(groupId) {
  const tabs = (await chrome.tabs.query({ groupId })).filter((t) => !isMixTab(t));
  const existing = (await chrome.tabs.query({ groupId })).find(isMixTab);
  if (existing) { await chrome.tabs.update(existing.id, { active: true }); return { mixId: existing.url.split("#")[1], tabId: existing.id }; }
  const g = await chrome.tabGroups.get(groupId).catch(() => null);
  const id = crypto.randomUUID().slice(0, 8);
  const { mixes = {} } = await local.get("mixes");
  mixes[id] = { id, groupId, title: g?.title || tabs.map((t) => hostOf(t.url)).filter(Boolean).slice(0, 3).join(" + ") || "Mix", chat: [], view: null, created: Date.now() };
  await local.set({ mixes });
  const last = tabs[tabs.length - 1];
  const tab = await chrome.tabs.create({ url: `${MIX_URL}#${id}`, windowId: last?.windowId, index: last ? last.index + 1 : undefined, active: true });
  await chrome.tabs.group({ tabIds: [tab.id], groupId }).catch(() => {});
  publik.beacon("active_session");
  return { mixId: id, tabId: tab.id };
}

/** Pick tabs → put them in a new group → mix that group. */
async function mixFromTabs(tabIds, title) {
  const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter((t) => t && /^https?:/.test(t.url ?? ""));
  if (tabs.length < 1) throw new Error("Pick at least one normal web page.");
  const groupId = await chrome.tabs.group({ tabIds: tabs.map((t) => t.id), createProperties: { windowId: tabs[0].windowId } });
  await chrome.tabGroups.update(groupId, { title: title || "mix", color: "orange" }).catch(() => {});
  return mixFromGroup(groupId);
}

const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

/** The live sources: every normal web page in the mix's group. */
async function mixSources(mixId) {
  const { mixes = {} } = await local.get("mixes");
  const mix = mixes[mixId];
  if (!mix) throw new Error("This mix was removed.");
  const tabs = mix.groupId != null && mix.groupId !== -1 ? await chrome.tabs.query({ groupId: mix.groupId }).catch(() => []) : [];
  return { mix, sources: tabs.filter((t) => !isMixTab(t) && /^https?:/.test(t.url ?? "")).map((t, i) => ({ sid: `s${i + 1}`, tabId: t.id, url: t.url, title: t.title, host: hostOf(t.url), favIconUrl: t.favIconUrl ?? null })) };
}

async function extractTab(tabId, opts = {}) {
  const ask = () => chrome.tabs.sendMessage(tabId, { type: "extract", scroll: opts.scroll !== false }, { frameId: 0 });
  try { const r = await ask(); if (r?.url) return r; } catch { /* not injected yet */ }
  const t = await chrome.tabs.get(tabId).catch(() => null);
  if (t?.discarded) { await chrome.tabs.reload(tabId); await waitLoaded(tabId); }
  await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, files: ["src/content.js"] }).catch(() => {});
  return ask().catch(() => null);
}

function waitLoaded(tabId, ms = 15000) {
  return new Promise((res) => {
    const done = () => { clearTimeout(to); chrome.tabs.onUpdated.removeListener(on); setTimeout(res, 1800); };
    const on = (id, ch) => { if (id === tabId && ch.status === "complete") done(); };
    const to = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(on);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); }).catch(done);
  });
}

/** Visit a page in a background tab (signed in as the person), read it, close it. */
async function lookup(url, windowId) {
  if (!/^https?:\/\//.test(url)) return { url, error: "not a web address" };
  const tab = await chrome.tabs.create({ url, active: false, windowId });
  try {
    await waitLoaded(tab.id);
    const r = await extractTab(tab.id, { scroll: false });
    return r ? trimSource(r, 3500) : { url, error: "could not read the page" };
  } finally { chrome.tabs.remove(tab.id).catch(() => {}); }
}

/** Keep each source small enough for the model. */
function trimSource(r, budget = 7000) {
  const items = [];
  let used = 0;
  for (const list of r.lists ?? []) for (const it of list.items) {
    const line = { text: it.text.slice(0, 500), links: it.links.slice(0, 4), img: it.img || undefined, time: it.time || undefined };
    used += JSON.stringify(line).length;
    if (used > budget) break;
    items.push(line);
  }
  return { url: r.url, title: r.title, items, text: items.length < 4 ? (r.text ?? "").slice(0, Math.max(1500, budget - used)) : (r.screen ?? "").slice(0, 1200) };
}

async function mixRun(mixId, prompt, sender) {
  const { mix, sources } = await mixSources(mixId);
  if (!sources.length) throw new Error("This group has no web pages. Add tabs to the group, then ask again.");
  const say = (text) => chrome.tabs.sendMessage(sender.tab.id, { type: "mixProgress", mixId, text }).catch(() => {});
  const data = [];
  for (const s of sources) {
    say(`Reading ${s.host}…`);
    const r = await extractTab(s.tabId);
    data.push({ id: s.sid, site: s.host, ...(r ? trimSource(r) : { url: s.url, title: s.title, items: [], text: "(could not read this tab)" }) });
  }
  const history = (mix.chat ?? []).filter((c) => c.role === "you").slice(-4).map((c) => c.text);
  let lookups = [];
  let out = null;
  for (let round = 0; round < 3; round++) {
    say(round ? "Building it with what it found…" : "Building your mix…");
    const text = await publik.chat({ system: MIX_SYSTEM, messages: [{ role: "user", content: mixUserMessage({ sources: data, lookups, request: prompt, earlier: history, round }) }], tier: "smart", maxTokens: 8000 });
    out = parseJSON(text);
    if (!out) throw new Error("The AI answered in a shape Remold could not read. Try again.");
    const want = Array.isArray(out.lookups) ? out.lookups.filter((l) => l && typeof l.url === "string").slice(0, 8) : [];
    if (!want.length || round === 2) break;
    say(`Visiting ${want.length} page${want.length === 1 ? "" : "s"}: ${String(out.reply ?? "").slice(0, 120)}`);
    const got = [];
    for (let i = 0; i < want.length; i += 3) got.push(...await Promise.all(want.slice(i, i + 3).map((l) => lookup(l.url, sender.tab.windowId).then((r) => ({ for: String(l.for ?? "").slice(0, 120), ...r })))));
    lookups = lookups.concat(got);
  }
  const view = cleanView(out.view, data);
  const reply = String(out.reply ?? (view ? "Done." : "I couldn't build that. Try saying it another way.")).slice(0, 600);
  const { mixes = {} } = await local.get("mixes");
  if (mixes[mixId]) {
    mixes[mixId].chat = [...(mixes[mixId].chat ?? []), { role: "you", text: prompt }, { role: "ai", text: reply, lookups: lookups.length }].slice(-30);
    if (view) { mixes[mixId].view = view; mixes[mixId].prompt = prompt; mixes[mixId].updated = Date.now(); }
    await local.set({ mixes });
  }
  return { reply, view, lookups: lookups.length, sources: data.map((d) => ({ id: d.id, site: d.site, items: d.items.length })) };
}

const LAYOUTS = new Set(["feed", "cards", "table", "board", "columns"]);
function cleanView(v, data) {
  if (!v || typeof v !== "object" || !Array.isArray(v.items)) return null;
  const sites = Object.fromEntries(data.map((d) => [d.id, d.site]));
  const url = (u) => (typeof u === "string" && /^https?:\/\//.test(u) ? u.slice(0, 1000) : undefined);
  const item = (x) => ({
    source: typeof x.source === "string" && sites[x.source] ? x.source : undefined,
    title: str(x.title, 300), text: str(x.text, 2000), image: url(x.image), link: url(x.link), meta: str(x.meta, 200),
    tags: arr(x.tags).map((t) => str(t, 40)).filter(Boolean).slice(0, 6),
    fields: x.fields && typeof x.fields === "object" ? Object.fromEntries(Object.entries(x.fields).slice(0, 10).map(([k, val]) => [str(k, 40), str(String(val ?? ""), 300)])) : undefined,
    group: str(x.group, 80) || undefined,
  });
  return {
    title: str(v.title, 100) || "Mix", note: str(v.note, 400), layout: LAYOUTS.has(v.layout) ? v.layout : "feed", sites,
    items: v.items.slice(0, 200).map((x) => ({ ...item(x ?? {}), related: arr(x?.related).slice(0, 4).map((r) => item(r ?? {})) })),
  };
}
