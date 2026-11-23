// Real end to end: real publik sign-in (approve the printed link), real publik AI writing mods through the panel UI.
// node test/e2e.cjs <profileDir> <outDir>
const path = require("path"), fs = require("fs");
const pw = require(process.env.PW || "playwright-core");
const ext = path.resolve(__dirname, "..");
const [profile, out] = [process.argv[2], process.argv[3] || path.join(ext, "test", "out")];
fs.mkdirSync(out, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
(async () => {
  const ctx = await pw.chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const id = sw.url().split("/")[2];
  const ask = async (site, prompts, name) => {
    const page = await ctx.newPage();
    await page.goto(site, { waitUntil: "domcontentloaded" }); await page.waitForTimeout(5000);
    const tabId = await sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url.startsWith(u))?.id, site.slice(0, 25));
    const panel = await ctx.newPage(); await panel.setViewportSize({ width: 390, height: 820 });
    await panel.goto(`chrome-extension://${id}/src/panel.html?tab=${tabId}`); await panel.waitForTimeout(4000);
    for (const [i, p] of prompts.entries()) {
      log(name, "ask:", p);
      await panel.fill("textarea", p); await panel.keyboard.press("Enter");
      await panel.waitForFunction(() => !document.querySelector(".msg.work"), null, { timeout: 180000 }).catch(() => log("timeout"));
      await page.bringToFront(); await page.waitForTimeout(6000);
      const msgs = await panel.$$eval(".msg", (m) => m.map((x) => x.className.replace("msg ", "") + ": " + x.innerText.replace(/\n/g, " ")).slice(-1));
      log(name, "->", msgs.join(" | "));
      await page.screenshot({ path: `${out}/${name}-${i + 1}.png` });
      await panel.screenshot({ path: `${out}/${name}-panel-${i + 1}.png` });
    }
    const mods = await sw.evaluate(async () => (await chrome.storage.local.get("mods")).mods);
    fs.writeFileSync(`${out}/${name}-mods.json`, JSON.stringify(mods, null, 2));
  };

  const panel = await ctx.newPage();
  await panel.goto(`chrome-extension://${id}/src/panel.html`);
  for (let i = 0; i < 120; i++) {
    const g = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "gate", provision: true }));
    const st = g?.data?.state;
    if (i === 0 || i % 10 === 0) log("gate:", st, st === "sign_in" ? g.data.claimUrl : JSON.stringify(g.data).slice(0, 200));
    if (st === "sign_in" && i === 0) fs.writeFileSync(`${out}/claim-url.txt`, g.data.claimUrl);
    if (st === "choose") { log("choose:", JSON.stringify(g.data)); await panel.evaluate(() => chrome.runtime.sendMessage({ type: "choose", choice: "publik" })); }
    if (st === "ready") { log("ready:", JSON.stringify(g.data)); break; }
    await panel.waitForTimeout(5000);
  }
  await panel.close();
  const only = process.env.ONLY;
  if (!only || only === "hn") await ask("https://news.ycombinator.com/", ["Collapse every post about AI, LLMs or AI companies", "Make it look calm: warm paper background, serif headlines, more space between posts"], "hn");
  if (only === "tone") await ask("https://news.ycombinator.com/", ["Show the tone of every headline and tint the hype ones"], "tone");
  if (only === "js") { await sw.evaluate(() => chrome.storage.local.set({ customCode: true })); await ask("https://news.ycombinator.com/", ["Use custom code to label each post's topic"], "js"); }
  if (!only || only === "yt") await ask("https://www.youtube.com/results?search_query=lofi", ["Get rid of all thumbnails and anything Shorts", "Rewrite clickbait titles as plain, calm titles"], "yt");
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
