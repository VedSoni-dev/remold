const path = require("path"); const pw = require(process.env.PW);
const ext = path.resolve(__dirname, "..");
(async () => {
  const ctx = await pw.chromium.launchPersistentContext("", { channel: "chromium", headless: true, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const p = await ctx.newPage(); await p.goto(process.argv[2], { waitUntil: "domcontentloaded" }); await p.waitForTimeout(4000);
  const s = await sw.evaluate(async (u) => { const t = (await chrome.tabs.query({})).find((t) => t.url.startsWith(u)); return chrome.tabs.sendMessage(t.id, { type: "snapshot" }, { frameId: 0 }); }, process.argv[2].slice(0, 20));
  console.log(s.outline.slice(0, 3000)); console.log("---repeated\n" + s.repeated);
  await ctx.close();
})();
