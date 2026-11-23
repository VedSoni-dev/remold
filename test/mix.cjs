// Mix end to end: three real tabs in a group → combine → two asks (merge, and match with page visits).
const path = require("path"), fs = require("fs"); const pw = require(process.env.PW);
const ext = process.argv[2], prof = process.argv[3], out = process.argv[4]; fs.mkdirSync(out, { recursive: true });
(async () => {
  const ctx = await pw.chromium.launchPersistentContext(prof, { channel: "chromium", headless: true, viewport: { width: 1440, height: 900 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker"); const id = sw.url().split("/")[2];
  const panel = await ctx.newPage(); await panel.goto(`chrome-extension://${id}/src/panel.html`); await panel.waitForTimeout(3000);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "choose", choice: "publik" }));
  for (const u of ["https://news.ycombinator.com/", "https://news.ycombinator.com/newest", "https://www.youtube.com/results?search_query=lofi"]) { const p = await ctx.newPage(); await p.goto(u, { waitUntil: "domcontentloaded" }); }
  await new Promise((r) => setTimeout(r, 4000));
  const r = await panel.evaluate(async () => { const tabs = await chrome.tabs.query({}); const ids = tabs.filter((t) => /ycombinator|youtube/.test(t.url)).map((t) => t.id); return chrome.runtime.sendMessage({ type: "mixFromTabs", tabIds: ids, title: "morning" }); });
  console.log("mix:", JSON.stringify(r));
  await new Promise((r) => setTimeout(r, 2000));
  const mix = ctx.pages().find((p) => p.url().includes("mix.html")); await mix.bringToFront(); await mix.waitForTimeout(1500);
  await mix.screenshot({ path: `${out}/mix-empty.png` });
  for (const [i, q] of ["Merge everything into one feed", "Match each poster to their profile"].entries()) {
    await mix.fill("textarea", q); await mix.keyboard.press("Enter");
    await mix.waitForTimeout(2500); await mix.screenshot({ path: `${out}/mix-busy-${i}.png` });
    await mix.waitForFunction(() => !document.body.classList.contains("busy"), null, { timeout: 180000 });
    await mix.waitForTimeout(800); await mix.screenshot({ path: `${out}/mix-${i}.png` });
    console.log(q, "->", (await mix.$$eval(".msg", (m) => m.map((x) => x.innerText))).slice(-1)[0]);
  }
  console.log("tabs after:", (await panel.evaluate(async () => (await chrome.tabs.query({})).map((t) => new URL(t.url).host + (t.groupId > -1 ? "[g]" : "")))).join(" "));
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
