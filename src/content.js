// Remold's runtime: runs the person's mods on every page (and inside mix panes), and reads the page for the AI.
// A mod is plain data in the Remold kit (see prompts.js); nothing here evaluates code from a mod. Custom code, when the
// person turns it on, runs through chrome.userScripts in the background, not here.
(() => {
  if (window.__remold) return;
  window.__remold = true;
  const TOP = window === window.top;
  const host = location.hostname.replace(/^www\./, "");
  const active = new Map(); // modId -> controller
  let preview = null;       // { id, spec } shown by the panel before saving
  const stats = {};         // modId -> counts, for the panel

  // ---------- which mods run here ----------
  const hostMatch = (h) => !h || h === "*" || host === h || host.endsWith(`.${h}`);
  const pathMatch = (paths) => !paths?.length || paths.some((p) => { try { return new RegExp(p).test(location.pathname); } catch { return false; } });

  async function sync() {
    let mods = [];
    try { mods = (await chrome.storage.local.get("mods")).mods ?? []; } catch { return; }
    const want = new Map();
    for (const m of mods) {
      if (!m.enabled) continue;
      if (!(m.spec.scope === "everywhere" || hostMatch(m.host))) continue;
      if (!pathMatch(m.spec.paths)) continue;
      if (preview && preview.id === m.id) continue;
      want.set(m.id, m.spec);
    }
    if (preview && pathMatch(preview.spec.paths)) want.set(preview.id, preview.spec);
    for (const [id, ctl] of active) {
      if (!want.has(id) || ctl.json !== JSON.stringify(want.get(id))) { ctl.stop(); active.delete(id); }
    }
    for (const [id, spec] of want) if (!active.has(id)) active.set(id, run(id, spec));
  }

  // ---------- running one mod ----------
  function run(id, spec) {
    const json = JSON.stringify(spec);
    const st = (stats[id] = { hide: {}, filters: [], rewrite: [], inject: 0, replace: 0, redirect: null, js: null, errors: [] });
    const cleanups = [];
    const safeAll = (sel, root = document) => { try { return [...root.querySelectorAll(sel)]; } catch { st.errors.push(`bad selector: ${sel}`); return []; } };

    // redirect first: before anything paints
    if (TOP) for (const r of spec.redirect ?? []) {
      try {
        const here = location.pathname + location.search;
        if (new RegExp(r.from).test(here)) {
          const to = new URL(r.to, location.href);
          if (to.href !== location.href && !new RegExp(r.from).test(to.pathname + to.search)) { st.redirect = to.href; location.replace(to.href); return { json, stop() {} }; }
        }
      } catch { st.errors.push(`bad redirect: ${r.from}`); }
    }

    // css + hide as one stylesheet
    const style = document.createElement("style");
    style.dataset.remold = id;
    const hideCss = (spec.hide ?? []).map((s) => `${s}{display:none!important}`).join("\n");
    style.textContent = `${spec.css ?? ""}\n${hideCss}\n${FILTER_CSS}`;
    const mountStyle = () => (document.head || document.documentElement).appendChild(style);
    mountStyle();
    cleanups.push(() => style.remove());

    // things that need the DOM: inject, actions, filters, rewrite, replace
    let alive = true;
    const pass = () => {
      if (!alive) return;
      if (!style.isConnected) mountStyle();
      for (const s of spec.hide ?? []) st.hide[s] = safeAll(s).length;
      inject();
      for (const f of filterState) scanFilter(f);
      for (const r of rewriteState) scanRewrite(r);
      for (const a of aiState) scanAI(a);
      replaceText();
    };

    // inject static html (sanitized), once per anchor
    const injected = [];
    function inject() {
      (spec.inject ?? []).forEach((it, n) => {
        for (const anchor of safeAll(it.at)) {
          const mark = `remoldInj${n}`;
          const holder = it.where === "before" || it.where === "after" ? anchor.parentElement : anchor;
          if (!holder || anchor.dataset[mark] === id) continue;
          anchor.dataset[mark] = id;
          const frag = sanitize(it.html);
          const nodes = [...frag.childNodes];
          ({ before: () => anchor.before(frag), after: () => anchor.after(frag), prepend: () => anchor.prepend(frag), append: () => anchor.append(frag) })[it.where]();
          nodes.forEach((x) => { if (x.nodeType === 1) x.dataset.remoldBy = id; injected.push(x); });
          injected.anchors = (injected.anchors ?? []).concat([[anchor, mark]]);
          st.inject++;
        }
      });
    }
    cleanups.push(() => { injected.forEach((x) => x.remove()); (injected.anchors ?? []).forEach(([a, m]) => delete a.dataset[m]); });

    // actions
    const doAction = (a) => {
      const targets = a.target ? safeAll(a.target) : [];
      const t0 = targets[0];
      switch (a.do) {
        case "hide": targets.forEach((t) => t.style.setProperty("display", "none", "important")); break;
        case "show": targets.forEach((t) => t.style.removeProperty("display")); break;
        case "toggle": targets.forEach((t) => (t.style.display === "none" ? t.style.removeProperty("display") : t.style.setProperty("display", "none", "important"))); break;
        case "click": t0?.click(); break;
        case "scroll_to": t0?.scrollIntoView({ behavior: "smooth", block: "start" }); break;
        case "scroll_by": window.scrollBy({ top: Number(a.value) || 600, behavior: "smooth" }); break;
        case "focus": t0?.focus(); break;
        case "add_class": targets.forEach((t) => t.classList.add(a.value)); break;
        case "remove_class": targets.forEach((t) => t.classList.remove(a.value)); break;
        case "toggle_class": targets.forEach((t) => t.classList.toggle(a.value)); break;
        case "open_url": if (/^https?:\/\//.test(a.value) || a.value.startsWith("/")) location.href = a.value; break;
      }
    };
    const onClick = (e) => {
      for (const a of spec.actions ?? []) {
        if (a.on !== "click" || !a.trigger) continue;
        try { if (e.target.closest?.(a.trigger)) { e.preventDefault(); doAction(a); } } catch { /* bad selector */ }
      }
    };
    const onKey = (e) => {
      const el = e.target;
      if (el?.isContentEditable || /^(input|textarea|select)$/i.test(el?.tagName ?? "")) return;
      for (const a of spec.actions ?? []) {
        if (a.on !== "key" || !a.key) continue;
        const parts = a.key.toLowerCase().split("+");
        const key = parts.pop();
        if (e.key.toLowerCase() !== key) continue;
        if (parts.includes("shift") !== e.shiftKey || parts.includes("alt") !== e.altKey || (parts.includes("ctrl") || parts.includes("cmd")) !== (e.ctrlKey || e.metaKey)) continue;
        e.preventDefault(); e.stopPropagation(); doAction(a);
      }
    };
    if ((spec.actions ?? []).some((a) => a.on === "click")) { document.addEventListener("click", onClick, true); cleanups.push(() => document.removeEventListener("click", onClick, true)); }
    if ((spec.actions ?? []).some((a) => a.on === "key")) { window.addEventListener("keydown", onKey, true); cleanups.push(() => window.removeEventListener("keydown", onKey, true)); }
    const loadActions = (spec.actions ?? []).filter((a) => a.on === "load");

    // Real time and on screen: AI only looks at elements on screen or about to be (800 px ahead), as you scroll.
    const near = new WeakSet();
    const watched = new WeakSet();
    const io = new IntersectionObserver((entries) => {
      let any = false;
      for (const e of entries) if (e.isIntersecting && !near.has(e.target)) { near.add(e.target); any = true; }
      if (any && alive) pass();
    }, { rootMargin: "800px 0px 800px 0px" });
    cleanups.push(() => io.disconnect());
    const onScreen = (el) => { if (near.has(el)) return true; if (!watched.has(el)) { watched.add(el); io.observe(el); } return false; };
    const textOf = (el, sel, max = 700) => {
      let t = "";
      try { t = (sel ? [...el.querySelectorAll(sel)].map((x) => x.innerText).join(" ") : el.innerText) || ""; } catch { t = el.innerText || ""; }
      return t.replace(/\s+/g, " ").trim().slice(0, max);
    };

    // AI filters: each item judged once (cached by text in the background)
    const filterState = (spec.filters ?? []).map((f, n) => ({ ...f, n, seen: new WeakMap(), queue: [], timer: 0, hidden: 0, judged: 0, matched: 0 }));
    st.filters = filterState.map((f) => ({ items: f.items, matched: 0, judged: 0, hidden: 0 }));
    function scanFilter(f) {
      const items = safeAll(f.items);
      st.filters[f.n].matched = items.length;
      for (const el of items) {
        if (el.dataset.remoldFiltered || !onScreen(el)) continue;
        const text = textOf(el, f.text);
        if (text.length < 4) continue;
        const h = quickHash(text);
        if (f.seen.get(el) === h) continue;
        f.seen.set(el, h);
        f.queue.push({ el, h, text });
      }
      if (f.queue.length && !f.timer) f.timer = setTimeout(() => flushFilter(f), 350);
    }
    async function flushFilter(f) {
      f.timer = 0;
      const batch = f.queue.splice(0, 40);
      if (!batch.length || !alive) return;
      const uniq = [...new Map(batch.map((b) => [b.h, { h: b.h, text: b.text }])).values()];
      const r = await chrome.runtime.sendMessage({ type: "classify", rule: f.hide_if, items: uniq }).catch(() => null);
      if (!alive) return;
      if (r?.ok) {
        for (const b of batch) {
          f.judged++;
          if (r.data[b.h]) { applyFilter(b.el, f); f.hidden++; }
        }
      } else if (r && !r.ok) st.errors.push(r.error);
      Object.assign(st.filters[f.n], { judged: f.judged, hidden: f.hidden });
      if (f.queue.length) f.timer = setTimeout(() => flushFilter(f), 50);
    }
    function applyFilter(el, f) {
      if (el.dataset.remoldFiltered) return;
      el.dataset.remoldFiltered = id;
      el.dataset.remoldAction = f.action;
      // items that span sibling elements (a table row plus its detail rows): the next ones go with it
      const tail = [];
      for (let i = 0, n = el.nextElementSibling; i < (f.also_next ?? 0) && n; i++, n = n.nextElementSibling) {
        n.dataset.remoldFiltered = id; n.dataset.remoldAction = f.action; tail.push(n);
      }
      if (f.action === "collapse" || f.action === "blur") {
        const isRow = el.tagName === "TR", isLi = el.tagName === "LI" && /^(UL|OL)$/.test(el.parentElement?.tagName ?? "");
        const tag = document.createElement("button");
        tag.type = "button";
        tag.className = "remold-filter-tag";
        tag.textContent = `${f.label} · show`;
        tag.dataset.remoldBy = id;
        let holder = tag;
        if (isRow || isLi) {
          holder = document.createElement(isRow ? "tr" : "li");
          holder.dataset.remoldBy = id;
          holder.className = "remold-filter-holder";
          if (isRow) { const td = document.createElement("td"); td.colSpan = 99; td.append(tag); holder.append(td); } else holder.append(tag);
        }
        tag.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); el.dataset.remoldAction = "shown"; tail.forEach((n) => (n.dataset.remoldAction = "shown")); holder.remove(); }, { once: true });
        el.before(holder);
      }
    }
    cleanups.push(() => {
      document.querySelectorAll(`[data-remold-filtered="${id}"]`).forEach((el) => { delete el.dataset.remoldFiltered; delete el.dataset.remoldAction; });
      document.querySelectorAll(`.remold-filter-holder[data-remold-by="${id}"], .remold-filter-tag[data-remold-by="${id}"]`).forEach((t) => t.remove());
    });

    // AI rewrite of short texts
    const rewriteState = (spec.rewrite ?? []).map((r, n) => ({ ...r, n, done: new WeakMap(), queue: [], timer: 0, count: 0 }));
    st.rewrite = rewriteState.map((r) => ({ items: r.items, matched: 0, rewritten: 0 }));
    function scanRewrite(r) {
      const items = safeAll(r.items);
      st.rewrite[r.n].matched = items.length;
      for (const el of items) {
        if (!onScreen(el)) continue;
        const text = (el.innerText || "").trim();
        if (!text || text.length > 300 || r.done.get(el) === text) continue;
        r.done.set(el, text);
        r.queue.push({ el, text, h: quickHash(text) });
      }
      if (r.queue.length && !r.timer) r.timer = setTimeout(() => flushRewrite(r), 400);
    }
    async function flushRewrite(r) {
      r.timer = 0;
      const batch = r.queue.splice(0, 30);
      if (!batch.length || !alive) return;
      const uniq = [...new Map(batch.map((b) => [b.h, { h: b.h, text: b.text }])).values()];
      const res = await chrome.runtime.sendMessage({ type: "rewrite", instruction: r.instruction, items: uniq }).catch(() => null);
      if (!alive || !res?.ok) { if (res && !res.ok) st.errors.push(res.error); return; }
      for (const b of batch) {
        const v = res.data[b.h];
        if (typeof v === "string" && v !== b.text && b.el.isConnected) {
          b.el.dataset.remoldOriginal ??= b.text;
          // write into the deepest text node so the site's own markup and links survive
          const tn = deepestText(b.el);
          if (tn) tn.textContent = v; else b.el.textContent = v;
          r.done.set(b.el, v.trim());
          r.count++;
        }
      }
      st.rewrite[r.n].rewritten = r.count;
      if (r.queue.length) r.timer = setTimeout(() => flushRewrite(r), 50);
    }

    // AI on anything: for each element on screen, ask the AI something and act on the answer.
    //   then: hide|collapse|blur|dim (yes/no) · badge (a short label) · replace (new text) · style (pick one of "styles")
    const aiState = (spec.ai ?? []).map((a, n) => ({ ...a, n, seen: new WeakMap(), queue: [], timer: 0, done: 0, acted: 0 }));
    st.ai = aiState.map((a) => ({ items: a.items, matched: 0, done: 0, acted: 0 }));
    const answerOf = (then) => (["hide", "collapse", "blur", "dim"].includes(then) ? "yesno" : then === "badge" ? "label" : then === "replace" ? "text" : "pick");
    function scanAI(a) {
      const items = safeAll(a.items);
      st.ai[a.n].matched = items.length;
      for (const el of items) {
        if (el.dataset.remoldBy || !onScreen(el)) continue;
        const text = textOf(el, a.text, a.then === "replace" ? 400 : 900);
        if (text.length < 2) continue;
        const h = quickHash(text);
        if (a.seen.get(el) === h) continue;
        a.seen.set(el, h);
        a.queue.push({ el, h, text });
      }
      if (a.queue.length && !a.timer) a.timer = setTimeout(() => flushAI(a), 300);
    }
    async function flushAI(a) {
      a.timer = 0;
      const batch = a.queue.splice(0, 25);
      if (!batch.length || !alive) return;
      const uniq = [...new Map(batch.map((b) => [b.h, { h: b.h, text: b.text }])).values()];
      const r = await chrome.runtime.sendMessage({ type: "aiEach", ask: a.ask, answer: answerOf(a.then), choices: Object.keys(a.styles ?? {}), items: uniq }).catch(() => null);
      if (!alive) return;
      if (r?.ok) for (const b of batch) { a.done++; if (b.el.isConnected && actAI(a, b.el, r.data[b.h], b.text)) a.acted++; }
      else if (r && !r.ok) st.errors.push(r.error);
      Object.assign(st.ai[a.n], { done: a.done, acted: a.acted });
      if (a.queue.length) a.timer = setTimeout(() => flushAI(a), 50);
    }
    function actAI(a, el, v, text) {
      if (v == null || v === false || v === "") return false;
      if (["hide", "collapse", "blur", "dim"].includes(a.then)) { applyFilter(el, { action: a.then, label: a.label || "Hidden", also_next: a.also_next }); return true; }
      if (a.then === "replace" && typeof v === "string" && v !== text) {
        el.dataset.remoldOriginal ??= text;
        const tn = deepestText(el); if (tn) tn.textContent = v; else el.textContent = v;
        a.seen.set(el, quickHash(textOf(el, a.text, 400)));
        return true;
      }
      if (a.then === "badge" && typeof v === "string") {
        el.querySelectorAll(`:scope > .remold-badge[data-remold-by="${id}"]`).forEach((b) => b.remove());
        const b = document.createElement("span");
        b.className = "remold-badge"; b.dataset.remoldBy = id; b.textContent = `${a.label ? `${a.label}: ` : ""}${v}`.slice(0, 60);
        (a.badge_at ? el.querySelector(a.badge_at) ?? el : el).prepend(b);
        return true;
      }
      if (a.then === "style" && typeof v === "string" && a.styles?.[v] != null) {
        el.dataset.remoldStyle = `${id}-${a.n}-${v}`.replace(/[^\w-]/g, "_");
        return true;
      }
      return false;
    }
    // "style" answers become attribute rules in this mod's stylesheet
    const styleRules = aiState.filter((a) => a.then === "style").flatMap((a) => Object.entries(a.styles ?? {}).map(([k, css]) =>
      `[data-remold-style="${`${id}-${a.n}-${k}`.replace(/[^\w-]/g, "_")}"]{${css}}`)).join("\n");
    if (styleRules) style.textContent += `\n${styleRules}`;
    cleanups.push(() => {
      document.querySelectorAll(`.remold-badge[data-remold-by="${id}"]`).forEach((b) => b.remove());
      document.querySelectorAll(`[data-remold-style^="${id}-"]`).forEach((el) => delete el.dataset.remoldStyle);
    });

    // regex text replacement in text nodes
    const replaced = new WeakSet();
    const rules = (spec.replace ?? []).map((r) => { try { return { re: new RegExp(r.find, r.flags.includes("g") ? r.flags : `${r.flags}g`), with: r.with, in: r.in }; } catch { st.errors.push(`bad regex: ${r.find}`); return null; } }).filter(Boolean);
    function replaceText() {
      for (const r of rules) {
        const roots = r.in ? safeAll(r.in) : [document.body].filter(Boolean);
        for (const root of roots) {
          const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.parentElement?.closest("script,style,textarea,input,[contenteditable=true]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
          let n;
          while ((n = walk.nextNode())) {
            if (replaced.has(n)) continue;
            r.re.lastIndex = 0;
            if (r.re.test(n.nodeValue)) { r.re.lastIndex = 0; n.nodeValue = n.nodeValue.replace(r.re, r.with); replaced.add(n); st.replace++; }
          }
        }
      }
    }

    // custom code: only through the background's userScripts (when the person turned it on)
    if (spec.js) chrome.runtime.sendMessage({ type: "runjs", code: spec.js }).then((r) => { st.js = r?.data?.ran ? "ran" : "off"; }).catch(() => { st.js = "off"; });

    // watch the page: sites keep rendering (infinite feeds, SPA navigation)
    let pending = 0;
    const mo = new MutationObserver(() => { if (!pending) pending = setTimeout(() => { pending = 0; pass(); }, 200); });
    const start = () => {
      if (!alive) return;
      pass();
      loadActions.forEach(doAction);
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: (spec.replace ?? []).length > 0 });
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true }); else start();
    cleanups.push(() => mo.disconnect());

    return { json, stop() { alive = false; cleanups.forEach((c) => { try { c(); } catch { /* keep going */ } }); delete stats[id]; } };
  }

  const FILTER_CSS = `[data-remold-action="hide"]{display:none!important}
[data-remold-action="collapse"]{display:none!important}
[data-remold-action="blur"]{filter:blur(14px)!important;pointer-events:none!important;user-select:none!important}
[data-remold-action="dim"]{opacity:.28!important;transition:opacity .2s}
[data-remold-action="dim"]:hover{opacity:1!important}
.remold-filter-tag{all:unset;display:block;box-sizing:border-box;width:calc(100% - 16px);margin:6px 8px;padding:7px 12px;border-radius:10px;
 font:500 12px/1.3 ui-sans-serif,system-ui,-apple-system,sans-serif;letter-spacing:.01em;color:#6b6b6b;background:rgba(127,127,127,.09);
 cursor:pointer;text-align:left}
.remold-filter-holder{list-style:none}
.remold-badge{all:unset;display:inline-block;margin:0 6px 4px 0;padding:2px 8px;border-radius:999px;font:600 11px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
 background:#c4572e;color:#fff;vertical-align:middle;white-space:nowrap}
.remold-filter-tag:hover{background:rgba(127,127,127,.16);color:#3a3a3a}`;

  function sanitize(html) {
    const doc = new DOMParser().parseFromString(`<template>${html}</template>`, "text/html");
    const frag = doc.querySelector("template").content;
    frag.querySelectorAll("script,iframe,object,embed,link,meta,base,form").forEach((n) => n.remove());
    frag.querySelectorAll("*").forEach((el) => {
      for (const a of [...el.attributes]) {
        const v = a.value.trim().toLowerCase();
        if (a.name.startsWith("on") || ((a.name === "href" || a.name === "src" || a.name === "action" || a.name === "xlink:href") && (v.startsWith("javascript:") || v.startsWith("data:text"))))
          el.removeAttribute(a.name);
      }
    });
    return document.importNode(frag, true);
  }

  function deepestText(el) {
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let best = null, n;
    while ((n = walk.nextNode())) if (n.nodeValue.trim() && (!best || n.nodeValue.length > best.nodeValue.length)) best = n;
    return best;
  }

  function quickHash(s) {
    let h1 = 0x811c9dc5, h2 = 0;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = (h2 * 31 + c) | 0; }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }

  // ---------- reading the page for the AI ----------
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "LINK", "META", "TEMPLATE", "PATH", "DEFS", "SYMBOL", "USE", "G", "CLIPPATH", "LINEARGRADIENT", "IFRAME"]);
  const hashed = (c) => /^(css|r|sc|jsx|emotion|tw)-[a-z0-9]+$/i.test(c) || /[a-z]+[A-Z0-9_]{5,}/.test(c) && /\d/.test(c) || c.length > 32;
  function sig(el) {
    const cls = [...el.classList].filter((c) => !hashed(c)).slice(0, 3);
    let s = el.tagName.toLowerCase();
    if (el.id && !/\d{3,}/.test(el.id)) s += `#${el.id}`;
    if (cls.length) s += `.${cls.join(".")}`;
    for (const a of ["data-testid", "data-test-id", "role", "aria-label", "name", "type"]) {
      const v = el.getAttribute(a);
      if (v) s += `[${a}="${v.slice(0, 40)}"]`;
    }
    if (el.tagName === "A") { const href = el.getAttribute("href") ?? ""; if (href) s += `[href="${href.slice(0, 50)}"]`; }
    if (el.tagName === "IMG") s += `[alt="${(el.getAttribute("alt") ?? "").slice(0, 30)}"]`;
    return s;
  }
  const shape = (el) => `${el.tagName}|${el.id}|${el.getAttribute("data-testid") ?? ""}|${[...el.classList].filter((c) => !hashed(c)).slice(0, 2).join(".")}`;
  function ownText(el) {
    let t = "";
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.nodeValue;
    return t.replace(/\s+/g, " ").trim().slice(0, 70);
  }
  function visible(el) {
    if (el === document.body) return true;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0 && getComputedStyle(el).display !== "contents") return false;
    return true;
  }
  function outline(budget = 16000) {
    const lines = [];
    let used = 0;
    const walk = (el, depth) => {
      if (used > budget || depth > 22 || SKIP.has(el.tagName.toUpperCase()) || el.dataset?.remoldBy) return;
      if (!visible(el)) return;
      const kids = [...el.children];
      const text = ownText(el);
      const line = `${"  ".repeat(Math.min(depth, 14))}${sig(el)}${text ? ` "${text}"` : ""}`;
      // skip boring single-child wrappers to save space
      const boring = !text && kids.length === 1 && !el.id && !el.getAttribute("data-testid") && !el.getAttribute("role") && /^(DIV|SPAN)$/.test(el.tagName) && el.classList.length === 0;
      if (!boring) { lines.push(line); used += line.length + 1; }
      const groups = new Map();
      for (const k of kids) { const s = shape(k); groups.set(s, (groups.get(s) ?? 0) + 1); }
      const shown = new Map();
      for (const k of kids) {
        const s = shape(k), n = groups.get(s);
        const c = (shown.get(s) ?? 0) + 1;
        shown.set(s, c);
        if (n > 3 && c > 2) {
          if (c === 3) { const l = `${"  ".repeat(Math.min(depth + 1, 14))}… ×${n - 2} more like ${sig(k)}`; lines.push(l); used += l.length + 1; }
          continue;
        }
        walk(k, boring ? depth : depth + 1);
      }
    };
    if (document.body) walk(document.body, 0);
    return lines.join("\n").slice(0, budget + 400);
  }
  /** Candidate item lists: 4+ elements of the same kind with real text (posts, video cards, comments). */
  function repeated() {
    const seen = new Map();
    for (const el of document.querySelectorAll("body *")) {
      if (SKIP.has(el.tagName.toUpperCase()) || el.dataset.remoldBy) continue;
      const tid = el.getAttribute("data-testid");
      const cls = [...el.classList].find((c) => !hashed(c) && !c.startsWith("remold"));
      const key = tid ? `[data-testid="${tid}"]` : el.tagName.includes("-") ? el.tagName.toLowerCase() : el.tagName === "ARTICLE" ? "article"
        : cls && !/^(SPAN|A|B|I|EM|STRONG|IMG|SVG|BUTTON)$/.test(el.tagName) ? `${el.tagName.toLowerCase()}.${CSS.escape(cls)}` : null;
      if (!key) continue;
      const text = (el.innerText || "").replace(/\s+/g, " ").trim();
      const e = seen.get(key) ?? { n: 0, len: 0, sample: "" };
      e.n++; e.len += Math.min(text.length, 400);
      if (!e.sample && text.length > 20) e.sample = text.slice(0, 110);
      seen.set(key, e);
    }
    return [...seen.entries()].filter(([, e]) => e.n >= 4 && e.len / e.n >= 25 && e.sample)
      .sort((a, b) => b[1].len - a[1].len).slice(0, 16)
      .map(([k, e]) => `${k} ×${e.n}  e.g. "${e.sample}"`).join("\n");
  }

  /** Everything readable on screen right now, top to bottom. */
  function screenText(max) {
    const out = [], vh = innerHeight;
    const walk = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT, { acceptNode: (n) =>
      n.nodeValue.trim() && !n.parentElement?.closest("script,style,noscript,[data-remold-by]") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    let n, len = 0;
    while ((n = walk.nextNode()) && len < max) {
      const r = n.parentElement.getBoundingClientRect();
      if (r.bottom < 0 || r.top > vh || r.width === 0) continue;
      const t = n.nodeValue.replace(/\s+/g, " ").trim();
      out.push(t); len += t.length + 1;
    }
    return out.join(" ").slice(0, max);
  }

  // ---------- messages from the panel ----------
  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === "snapshot") {
      if (!TOP) return false;
      respond({ url: location.href, title: document.title, host, outline: outline(), repeated: repeated() });
      return false;
    }
    if (msg?.type === "preview") {
      preview = msg.spec ? { id: msg.id, spec: msg.spec } : null;
      if (active.has(msg.id)) { active.get(msg.id).stop(); active.delete(msg.id); }
      sync().then(() => setTimeout(() => respond(TOP ? { stats: stats[msg.id] ?? null } : null), msg.wait ?? 1500));
      return TOP;
    }
    if (msg?.type === "screenText") {
      if (!TOP) return false;
      respond({ text: screenText(msg.max ?? 6000) });
      return false;
    }
    if (msg?.type === "stats") { if (!TOP) return false; respond({ stats, host }); return false; }
    return false;
  });

  chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && ch.mods) sync(); });

  // SPA navigation: re-check path-scoped mods when the URL changes
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; for (const [id, c] of active) { c.stop(); active.delete(id); } sync(); } }, 600);

  sync();
})();
