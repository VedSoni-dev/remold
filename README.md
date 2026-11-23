# Remold

**Make the internet yours again.** Remold is a Chrome extension: open it on any website, say how you want the site to look or behave, and it changes. Free and open source (MIT).

- "Hide posts on X that look AI-written" → an AI reads each post and collapses the ones that are.
- "Get rid of thumbnails and Shorts on YouTube" → gone, on every page of YouTube, every visit.
- "Warm paper colours and a serif font" → the whole site restyled.
- "Open YouTube on my subscriptions" → the home feed redirects.
- Put tabs in a Chrome tab group → **Combine**: one new tab reads every tab in the group and builds whatever you ask from their data together ("match each X poster to their LinkedIn", "pair each YouTube video with what people say about it on X", "one table of everything").

![Remold's side panel](docs/img/panel.png)

## Install

Until it's on the Chrome Web Store:

1. Download `remold-0.3.0.zip` from [Releases](https://github.com/VedSoni-dev/remold/releases) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode** (top right), click **Load unpacked**, pick the unzipped folder.
3. Click Remold's icon (or ⌘⇧Y / Ctrl+Shift+Y). The side panel opens.
4. **Sign in with publik**. AI runs on your publik plan.

## How it works

You talk; the AI writes a **mod** in the Remold kit, a small declarative format the extension runs on the page. The AI doesn't write page code by default, so a mod is safe to run, easy to read and easy to change.

| kit piece | what it does |
|---|---|
| `css` | any styling: colours, fonts, widths, layout |
| `hide` | selectors to remove |
| `filters` | AI judges each item in a list (posts, videos, comments) against your rule and hides, collapses, blurs or dims the matches. Each item is judged once and cached |
| `ai` | AI on **anything on screen**, live as you scroll: ask a question about each element and act on the answer: hide/collapse/blur/dim (yes/no), a badge (e.g. each post's tone), new text (translate, summarise), or a style picked from categories (colour-code by topic) |
| `rewrite` | AI rewrites short texts, like clickbait titles |
| `replace` | regex text swaps |
| `inject` | static HTML added to the page (scripts and handlers stripped) |
| `actions` | small interactions: on load, on click or on a key → hide, toggle, click, scroll, focus, add a class, open a URL |
| `redirect` | send one path to another |
| `js` | custom code, only if you turn on **Custom code** (Chrome's `userScripts` API and its "Allow User Scripts" switch). It gets `window.remold`, real-time AI through your publik account (below) |

### AI in your own code: `window.remold`

With Custom code on, a mod's JavaScript can call publik's AI live, on whatever is on screen:

```js
remold.onScreen("article", async (post) => {           // runs as each post scrolls into view
  const [tone] = await remold.label([post], "tone in one word");
  remold.badge(post, tone);
});
await remold.judge(els, "is this an ad?");             // → [true, false, …]
await remold.pick(els, "topic", ["tech", "sport", "politics"]);
await remold.rewrite(els, "translate to Spanish");
await remold.ai(`Summarise: ${remold.screenText()}`);  // free-form, { json: true } for JSON
```

Answers per element are cached by text, so a post is only judged once.

When you ask, Remold reads an outline of the page (tags, test ids, roles, labels, the repeated item lists), the AI writes the mod, Remold tries it on the page, counts what each selector matched, and if something matched nothing it sends that back and the AI fixes it once before saving. Every mod has an on/off switch, live counts ("5 of 30 filtered"), undo, and can apply to one site or every site.

**Combine (mixes).** Put tabs in a Chrome tab group and hit Combine (side panel, or right-click → "Combine this tab group into one tab"). A new tab joins the group; every other tab in the group is a live source and stays open. Ask for anything across them: Remold reads each source (the item lists on the page with their text, links and images, or the page text), and the AI builds one view: feed, cards, table, board (grouped) or columns (one per source), with items matched across sources shown together. If it needs more, it can visit up to 8 pages per round (two rounds) in background tabs, signed in as you, e.g. a LinkedIn people search for each X poster, then build the view from that. Add a tab to the group and it becomes a source. Live mode rebuilds every two minutes. What it reads is sent to publik's AI for that ask; nothing else.

## Privacy

- Mods, mixes and the filter cache live in your browser (`chrome.storage.local`).
- To write a mod, the page's outline and your request go to publik's AI. Filters send the text of the items they judge. Nothing else leaves your browser.
- Your publik key stays in the extension's local storage and is only sent to publikhq.com.
- Usage counting follows publik's rules (`app_opened`, `active_session`), plus an anonymous count for the builds hub (build, event, a random id; no content, no account).

## Develop

No build step. Load the folder unpacked; edit; click reload on `chrome://extensions`.

```
src/background.js   service worker: publik, AI calls, mod generation, filter cache, mixes
src/publik.js       Sign in with publik, usage counting, publik API
src/prompts.js      the Remold kit as the AI sees it
src/content.js      runs mods on pages and reads pages for the AI
src/panel.*         the side panel
src/mix.*           the combine tab (sources, ask, the combined view)
test/smoke.cjs      loads the extension in Chromium: gate, runtime on YouTube
test/mix.cjs        three real tabs in a group → combine → merge + page visits (with the mock)
test/e2e.cjs        the panel flow end to end (with test/mock-publik.cjs, or real publik)
./build.sh          dist/remold-<version>.zip
```

## Not yet

- Gemini and your own API keys (publik only for now).
- Chrome Web Store listing.
- Combine reads what each tab has rendered (it scrolls a little to load more); very long feeds are sampled.

Built by [@forkthis_ai](https://x.com/forkthis_ai). Free on publik.
