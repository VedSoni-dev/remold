// Remold's service worker: publik sign-in, every AI call, mod generation, the filter cache, custom code, and mixes.
import * as publik from "./publik.js";
import { AI_EACH_SYSTEM, FILTER_SYSTEM, MIX_SYSTEM, MOD_SYSTEM, REWRITE_SYSTEM, aiEachUserMessage, filterUserMessage, mixUserMessage, modUserMessage, rewriteUserMessage } from "./prompts.js";

const local = chrome.storage.local;

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "remold-open", title: "Remold this site", contexts: ["page", "action"] });
    chrome.contextMenus.create({ id: "remold-mix-group", title: "Mix this tab group into one tab", contexts: ["page", "action"] });
  });
  await restoreMixRules();
});
chrome.runtime.onStartup.addListener(() => { restoreMixRules(); publik.sendUsage("app_opened"); });

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

  // ---------- mixes ----------
  async mixFromGroup({ groupId }) { return mixFromGroup(groupId); },
  async mixFromTabs({ tabIds, title }) { return mixFromTabs(tabIds, title); },
  async mixAllow(_, sender) { await allowFraming(sender.tab.id); return true; },
  async unmix({ mixId }, sender) {
    const { mixes = {} } = await local.get("mixes");
    const mix = mixes[mixId];
    if (!mix) return false;
    const ids = [];
    for (const p of mix.panes) ids.push((await chrome.tabs.create({ url: p.url, active: false, windowId: sender.tab.windowId })).id);
    if (ids.length) {
      const g = await chrome.tabs.group({ tabIds: ids, createProperties: { windowId: sender.tab.windowId } });
      await chrome.tabGroups.update(g, { title: mix.title, ...(mix.color ? { color: mix.color } : {}) }).catch(() => {});
      await chrome.tabs.update(ids[0], { active: true });
    }
    delete mixes[mixId];
    await local.set({ mixes });
    chrome.tabs.remove(sender.tab.id);
    return true;
  },
  async arrangeMix({ mix, request }) {
    const text = await publik.chat({ system: MIX_SYSTEM, messages: [{ role: "user", content: mixUserMessage(mix, request) }], tier: "balanced", maxTokens: 2000 });
    const out = parseJSON(text);
    if (!out?.mix) return { reply: String(out?.reply ?? "I couldn't arrange that. Try saying it another way."), mix: null };
    return { reply: String(out.reply ?? "Done."), mix: cleanMix(out.mix, mix) };
  },
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

function cleanMix(m, prev) {
  const panes = arr(m.panes).filter((p) => /^https?:\/\//.test(p?.url ?? "")).slice(0, 8).map((p) => ({
    url: p.url, size: Math.min(4, Math.max(0.3, Number(p.size) || 1)), zoom: Math.min(1.5, Math.max(0.4, Number(p.zoom) || 1)) }));
  return { ...prev, title: str(m.title, 60) || prev.title, layout: ["columns", "rows", "grid", "focus"].includes(m.layout) ? m.layout : prev.layout,
    panes: panes.length ? panes : prev.panes, css: str(m.css, 20_000) };
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

// ---------- mixes: many tabs into one ----------

const GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);

async function mixFromGroup(groupId) {
  const tabs = await chrome.tabs.query({ groupId });
  const g = await chrome.tabGroups.get(groupId).catch(() => null);
  return mixFromTabs(tabs.map((t) => t.id), g?.title || null, g?.color);
}

async function mixFromTabs(tabIds, title, color) {
  const tabs = (await Promise.all(tabIds.map((id) => chrome.tabs.get(id).catch(() => null)))).filter((t) => t && /^https?:/.test(t.url ?? ""));
  if (tabs.length < 2) throw new Error("A mix needs at least two normal web pages.");
  const id = crypto.randomUUID().slice(0, 8);
  const hosts = tabs.map((t) => new URL(t.url).hostname.replace(/^www\./, ""));
  const mix = { id, title: title || hosts.slice(0, 3).join(" + "), color: GROUP_COLORS.has(color) ? color : null,
    layout: tabs.length > 3 ? "grid" : "columns", panes: tabs.map((t) => ({ url: t.url, size: 1, zoom: 1 })), css: "", created: Date.now() };
  const { mixes = {} } = await local.get("mixes");
  mixes[id] = mix;
  await local.set({ mixes });
  const first = tabs[0];
  const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`src/mix.html#${id}`), windowId: first.windowId, index: first.index, active: true });
  await allowFraming(tab.id);
  if (first.groupId !== -1) await chrome.tabs.group({ tabIds: [tab.id], groupId: first.groupId }).catch(() => {});
  await chrome.tabs.remove(tabs.map((t) => t.id)).catch(() => {});
  publik.beacon("active_session");
  return { mixId: id, tabId: tab.id };
}

/** Sites send headers that stop them being shown inside another page. For a mix tab only (Chrome session rule scoped to
 *  that one tab), Remold drops those headers on its frames, so the sites can sit side by side. No other tab is touched. */
async function allowFraming(tabId) {
  const id = 1000 + (tabId % 1_000_000);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{ id, priority: 1, condition: { tabIds: [tabId], resourceTypes: ["sub_frame"] },
      action: { type: "modifyHeaders", responseHeaders: [
        { header: "x-frame-options", operation: "remove" },
        { header: "content-security-policy", operation: "remove" },
        { header: "content-security-policy-report-only", operation: "remove" },
      ] } }],
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1000 + (tabId % 1_000_000)] }).catch(() => {});
});

/** After a browser restart, open mix tabs need their rules back. */
async function restoreMixRules() {
  const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL("src/mix.html") + "*" }).catch(() => []);
  for (const t of tabs) await allowFraming(t.id).catch(() => {});
}
