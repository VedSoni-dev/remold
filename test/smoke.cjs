// Loads the unpacked extension in Playwright's Chromium and checks the runtime, the panel gate and a mix.
// node test/smoke.cjs [outDir]
const path = require("path");
const pw = require(process.env.PW || "playwright-core");
const ext = path.resolve(__dirname, "..");
const out = process.argv[2] || path.join(ext, "test", "out");
require("fs").mkdirSync(out, { recursive: true });
(async () => {
  const ctx = await pw.chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  console.log("extension", id);

  // 1. panel gate (real publik provisioning)
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 380, height: 760 });
  await panel.goto(`chrome-extension://${id}/src/panel.html`);
  await panel.waitForTimeout(5000);
  await panel.screenshot({ path: `${out}/panel-gate.png` });
  console.log("gate text:", (await panel.innerText("body")).slice(0, 200).replace(/\n/g, " | "));

  // 2. canned mods on YouTube: hide thumbnails + a css tweak + an injected element with a click action
  await sw.evaluate(async () => {
    await chrome.storage.local.set({ mods: [{ id: "t1", host: "youtube.com", enabled: true, chat: [], spec: {
      title: "No thumbnails", summary: "", scope: "site", paths: [], css: "html,body,ytd-app{background:#f3efe6!important} .remold-note{position:fixed;bottom:16px;left:16px;z-index:99999;background:#c4572e;color:#fff;padding:8px 12px;border-radius:10px;font:600 13px system-ui;cursor:pointer}",
      hide: ["ytd-thumbnail", "yt-thumbnail-view-model", "ytd-rich-shelf-renderer[is-shorts]", "ytd-reel-shelf-renderer"],
      filters: [], rewrite: [], replace: [{ find: "Shorts", with: "Shorties", flags: "g", in: "" }],
      inject: [{ at: "body", where: "append", html: "<div class='remold-note' onclick='alert(1)'>remolded</div><script>alert(2)</script>" }],
      actions: [{ on: "click", trigger: ".remold-note", do: "toggle", target: "ytd-masthead", value: "" }], redirect: [], js: "" } }] });
  });
  const yt = await ctx.newPage();
  await yt.goto("https://www.youtube.com/results?search_query=lofi", { waitUntil: "domcontentloaded" });
  await yt.waitForTimeout(6000);
  await yt.screenshot({ path: `${out}/youtube.png` });
  const r = await yt.evaluate(() => ({
    style: !!document.querySelector("style[data-remold]"),
    thumbsVisible: [...document.querySelectorAll("ytd-thumbnail, yt-thumbnail-view-model")].filter((e) => e.offsetParent).length,
    note: !!document.querySelector(".remold-note"), noteOnclick: document.querySelector(".remold-note")?.getAttribute("onclick"), scripts: document.querySelectorAll("script:not([src])").length,
  }));
  console.log("youtube:", JSON.stringify(r));
  await yt.click(".remold-note");
  await yt.waitForTimeout(300);
  console.log("masthead hidden after click:", await yt.evaluate(() => getComputedStyle(document.querySelector("ytd-masthead")).display));
  // stats through the content script, like the panel asks
  const stats = await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: "https://www.youtube.com/*" }); return chrome.tabs.sendMessage(t.id, { type: "stats" }, { frameId: 0 }); });
  console.log("stats:", JSON.stringify(stats.stats.t1));
  const snap = await sw.evaluate(async () => { const [t] = await chrome.tabs.query({ url: "https://www.youtube.com/*" }); return chrome.tabs.sendMessage(t.id, { type: "snapshot" }, { frameId: 0 }); });
  console.log("snapshot outline chars:", snap.outline.length, "\nrepeated:\n" + snap.repeated.slice(0, 600));
  require("fs").writeFileSync(`${out}/youtube-outline.txt`, snap.outline);

  // 3. toggle off -> style gone
  await sw.evaluate(async () => { const { mods } = await chrome.storage.local.get("mods"); mods[0].enabled = false; await chrome.storage.local.set({ mods }); });
  await yt.waitForTimeout(800);
  console.log("after toggle off, style present:", await yt.evaluate(() => !!document.querySelector("style[data-remold]")), "note:", await yt.evaluate(() => !!document.querySelector(".remold-note")));

  // 4. mix: three tabs into one
  const urls = ["https://www.youtube.com/", "https://news.ycombinator.com/", "https://en.wikipedia.org/wiki/Clay"];
  for (const u of urls) { const p = await ctx.newPage(); await p.goto(u, { waitUntil: "domcontentloaded" }).catch(() => {}); }
  const res = await panel.evaluate(async (urls) => {
    const tabs = await chrome.tabs.query({});
    const ids = urls.map((u) => tabs.find((t) => t.url.startsWith(u))?.id).filter(Boolean);
    const g = await chrome.tabs.group({ tabIds: ids });
    await chrome.tabGroups.update(g, { title: "morning" });
    return chrome.runtime.sendMessage({ type: "mixFromGroup", groupId: g });
  }, urls);
  console.log("mix:", JSON.stringify(res));
  await new Promise((r) => setTimeout(r, 1500));
  const mixPage = ctx.pages().find((p) => p.url().includes("mix.html"));
  if (mixPage) {
    await mixPage.waitForTimeout(7000);
    await mixPage.screenshot({ path: `${out}/mix.png` });
    const frames = mixPage.frames().map((f) => f.url()).filter((u) => u.startsWith("http"));
    console.log("mix frames:", frames.join(" , "));
    console.log("blocked panes:", await mixPage.evaluate(() => [...document.querySelectorAll(".blocked.on")].length));
    await mixPage.click('button[data-layout="focus"]'); await mixPage.waitForTimeout(800);
    await mixPage.screenshot({ path: `${out}/mix-focus.png` });
  } else console.log("no mix page");
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
