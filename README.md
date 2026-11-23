# Remold

**Make the internet yours again.** Remold is a Chrome extension: open it on any website, say how you want the site to look or behave, and it changes. Free and open source (MIT).

- "Hide posts on X that look AI-written" → an AI reads each post and collapses the ones that are.
- "Get rid of thumbnails and Shorts on YouTube" → gone, on every page of YouTube, every visit.
- "Warm paper colours and a serif font" → the whole site restyled.
- "Open YouTube on my subscriptions" → the home feed redirects.
- Put tabs in a Chrome tab group → **Mix** them into one tab: X and YouTube side by side, resizable, and your mods still run inside each.

![Remold's side panel](docs/img/panel.png)

## Install

Until it's on the Chrome Web Store:

1. Download `remold-0.2.1.zip` from [Releases](https://github.com/VedSoni-dev/remold/releases) and unzip it.
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

**Mixes.** A mix is a Remold page that shows several sites in frames. Sites send headers that stop framing, so for that one mix tab only (a Chrome session rule scoped to its tab id) Remold drops `X-Frame-Options` and `Content-Security-Policy` on its frames. No other tab is touched; the rule is removed when the tab closes. Layouts: columns, rows, grid, focus; drag the edges to resize, drag a pane's header onto another to swap, per-pane zoom, and describe the layout in words. **Unmix** puts them back as a tab group.

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
src/mix.*           the mix tab
test/smoke.cjs      loads the extension in Chromium: gate, runtime on YouTube, a mix
test/e2e.cjs        the panel flow end to end (with test/mock-publik.cjs, or real publik)
./build.sh          dist/remold-<version>.zip
```

## Not yet

- Gemini and your own API keys (publik only for now).
- Chrome Web Store listing.
- Sites that block framing with code, not headers, show a "refused to load" note in a mix.
- Sign-in flows inside a mix pane (Google sign-in won't run in a frame); sign in in a normal tab first.

Built by [@forkthis_ai](https://x.com/forkthis_ai). Free on publik.
