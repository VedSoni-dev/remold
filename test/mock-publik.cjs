// A stand-in for publik's API so the whole pipeline can be tested without an account. Canned mods, keyword filters.
const http = require("http");
const port = Number(process.argv[2] || 8787);
let ytTries = 0;
const mods = {
  ai: { reply: "Posts about AI are collapsed. Click one to see it.", mod: { title: "No AI posts", summary: "Collapses Hacker News posts about AI.", filters: [{ items: "tr.athing", text: ".titleline", hide_if: "about AI, LLMs or AI companies", action: "collapse", label: "AI post", also_next: 2 }] } },
  calm: (cur) => ({ reply: "Warm paper, serif headlines, more room.", mod: { ...cur, title: "Calm HN", summary: "Collapses AI posts on a calm, warm layout.",
    css: "html,body,#hnmain{background:#f4efe4!important} #hnmain td{background:transparent} .titleline>a{font-family:Georgia,serif!important;font-size:16px!important;color:#2a2620!important} tr.athing td{padding-top:10px!important} .subtext{padding-bottom:8px!important}" } }),
  thumbs: (fb) => ({ reply: "Thumbnails and Shorts are gone.", mod: { title: "No thumbnails", summary: "Hides video thumbnails and Shorts.",
    hide: fb ? ["ytd-thumbnail", "yt-thumbnail-view-model", "ytd-reel-shelf-renderer", "grid-shelf-view-model"] : ["ytd-thumbnail-wrongname", "#thumbnail-broken"] } }),
  titles: (cur) => ({ reply: "Titles are rewritten as plain ones.", mod: { ...cur, rewrite: [{ items: "ytd-video-renderer #video-title yt-formatted-string", instruction: "plain calm titles" }] } }),
};
http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = (s, o) => { res.writeHead(s, { "content-type": "application/json", "access-control-allow-origin": "*" }); res.end(JSON.stringify(o)); };
    const url = req.url;
    if (url === "/api/v1/installs") return j(201, { key: ["pk", "mock"].join("_"), install_id: JSON.parse(body).install_id, claim_url: `http://127.0.0.1:${port}/claim` });
    if (url === "/api/v1/wallet") return j(200, { claim_state: "claimed", claim_url: null, account: { handle: "tester" }, plan: { kind: "plan", label: "publik Plus" }, balance_micros: 5000000, top_up_url: "https://publikhq.com/wallet" });
    if (url === "/api/v1/telemetry") return j(202, {});
    if (url === "/api/v1/chat/completions") {
      const b = JSON.parse(body); const sys = b.messages[0].content; const user = b.messages[b.messages.length - 1].content;
      let out;
      if (sys.startsWith("You are Remold")) {
        const asked = user.split("They asked: ").pop();
        const cur = (user.match(/Current mod \(they are editing it\):\n(.*)/) || [])[1]; const c = cur ? JSON.parse(cur) : {};
        const fb = user.includes("What happened when your last mod ran");
        if (/AI/.test(asked)) out = mods.ai; else if (/calm/i.test(asked) && /paper/.test(asked)) out = mods.calm(c);
        else if (/thumbnail/i.test(asked)) { ytTries++; out = mods.thumbs(fb); } else if (/clickbait/i.test(asked)) out = mods.titles(c);
        else out = { reply: "What should change?", mod: null };
        console.log("mod request:", asked.slice(0, 60), fb ? "(repair)" : "", "| outline chars", user.length);
      } else if (sys.startsWith("You judge")) {
        const items = [...user.matchAll(/\[(\d+)\] (.*)/g)];
        out = { match: items.filter((m) => /\b(AI|LLMs?|GPT|OpenAI|Anthropic|Claude|Gemini|model|agents?|Perplexity)\b/i.test(m[2])).map((m) => Number(m[1])) };
        console.log("judged", items.length, "matched", out.match.length);
      } else if (sys.startsWith("You rewrite")) {
        const items = [...user.matchAll(/\[(\d+)\] (.*)/g)];
        out = { out: items.map((m) => m[2].replace(/[^\p{L}\p{N}\s/,.'-]/gu, "").replace(/\s+/g, " ").trim().toLowerCase().replace(/^./, (c) => c.toUpperCase())) };
      } else out = {};
      return j(200, { choices: [{ message: { content: JSON.stringify(out) } }] });
    }
    j(404, { error: { message: "no" } });
  });
}).listen(port, () => console.log("mock publik on", port));
