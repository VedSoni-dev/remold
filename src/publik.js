// Sign in with publik, usage counting and publik API for a browser extension.
// Adapted from publik's module (publikhq.com/sdk/publik.ts.md) via the vedanttalksai studio kit: an extension is one
// install per browser profile, so this keeps the reference module's shape. The pk_ key lives in chrome.storage.local
// (never synced, never sent anywhere but publikhq.com) and only the service worker reads it.
//   1. provision this browser's install (POST /api/v1/installs) with the builds hub's public app token;
//   2. Sign in with publik until GET /api/v1/wallet says "claimed" (there is no other way in);
//   3. ask once how AI is paid: connect a publik plan (publik only for now);
//   4. count usage: app_opened once per browser session, active_session every 30 min while in use.
import { APP_SLUG, APP_TOKEN, BUILD, BUILD_NAME, HUB_URL, MODELS, PUBLIK_ORIGIN, VERSION } from "./config.js";

const API = `${PUBLIK_ORIGIN}/api/v1`;
const KEY = "publik";            // { key, install_id, claim_url }
const CHOICE = "publikChoice";   // "publik"
const TID = "publikTelemetryId"; // telemetry install id (uuid v4)
const SEEN = "publikSeen";       // session storage: last usage event time
const HUB_ID = "hubId";          // anonymous id for the builds hub beacon

const local = chrome.storage.local;
const session = chrome.storage.session;
const get = async (k, area = local) => (await area.get(k))[k];

function osName() {
  const ua = navigator.userAgent || "";
  const p = (navigator.userAgentData?.platform || ua).toLowerCase();
  if (p.includes("mac")) return "macOS";
  if (p.includes("win")) return "Windows";
  if (p.includes("cros")) return "ChromeOS";
  if (p.includes("linux")) return "Linux";
  return "";
}
/** publik's os field: macos | windows | linux. */
const osCode = () => ({ macOS: "macos", Windows: "windows" })[osName()] ?? "linux";
const deviceName = () => `${BUILD_NAME} · Chrome extension${osName() ? ` on ${osName()}` : ""}`;

async function provision() {
  let installId = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${API}/installs`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ app_token: APP_TOKEN, app_slug: APP_SLUG, app_version: VERSION, os: osCode(), device_name: deviceName(),
        install_id: installId, disclosure_version: 1, dialects: ["chat_completions"] }),
    });
    const b = await res.json().catch(() => ({}));
    if ((res.status === 201 || res.status === 200) && typeof b.key === "string" && b.key.startsWith("pk_")) {
      const cred = { key: b.key, install_id: b.install_id ?? installId, claim_url: b.claim_url ?? null };
      await local.set({ [KEY]: cred });
      return cred;
    }
    if (res.status === 200 || b.error?.type === "install_revoked") { installId = crypto.randomUUID(); continue; }
    throw new Error(b.error?.message ?? `publik could not set up this browser (${res.status}).`);
  }
  throw new Error("publik could not set up this browser.");
}

async function readWallet(key) {
  const res = await fetch(`${API}/wallet`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000), cache: "no-store" });
  const b = await res.json().catch(() => ({}));
  if (!res.ok || typeof b.claim_state !== "string") return { status: res.status, wallet: null, message: b.error?.message ?? null };
  return { status: res.status, message: null, wallet: { ...b, account: b.account ?? null, plan: b.plan ?? { kind: "none", label: null }, balance_micros: b.balance_micros ?? 0 } };
}

const dollars = (m) => `$${(m / 1_000_000).toFixed(2)}`;

/** One step of the gate. The panel draws what this returns. provision: create the install when there is none. */
export async function gate({ provision: make = false } = {}) {
  let cred = await get(KEY);
  try {
    if (!cred) {
      if (!make) return { state: "needs_install" };
      cred = await provision();
    }
    let r = await readWallet(cred.key);
    if (r.status === 401) { // revoked: start again
      await local.remove([KEY, CHOICE]);
      if (!make) return { state: "needs_install" };
      cred = await provision();
      r = await readWallet(cred.key);
    }
    const w = r.wallet;
    if (!w) return { state: "unreachable", message: r.message ?? "publik is not reachable. Check your connection." };
    if (w.claim_state !== "claimed") return { state: "sign_in", claimUrl: w.claim_url ?? cred.claim_url ?? `${PUBLIK_ORIGIN}/wallet` };
    const who = w.account?.handle ? `@${w.account.handle}` : null;
    const choice = await get(CHOICE);
    const hasPlan = w.plan.kind !== "none" || w.balance_micros > 0;
    if (choice !== "publik") {
      return { state: "choose", handle: who, hasPlan, topUpUrl: w.top_up_url ?? `${PUBLIK_ORIGIN}/wallet`,
        what: w.plan.kind === "plan" ? `Your plan: ${w.plan.label ?? "publik"}.` : hasPlan ? `Your balance: ${dollars(w.balance_micros)}.` : null };
    }
    return { state: "ready", handle: who, plan: w.plan.kind === "plan" ? w.plan.label ?? "publik plan" : hasPlan ? dollars(w.balance_micros) : "no plan yet", topUpUrl: w.top_up_url ?? null };
  } catch (e) {
    return { state: "unreachable", message: e instanceof TypeError || /abort|timeout/i.test(e?.name ?? "") ? "publik is not reachable. Check your connection." : String(e?.message ?? e) };
  }
}

export async function setChoice(choice) {
  if (choice) await local.set({ [CHOICE]: choice }); else await local.remove(CHOICE);
}
export async function signOut() { await local.remove([KEY, CHOICE]); }
export async function isReady() { return (await gate()).state === "ready"; }

// ---------- usage counting ----------

export async function sendUsage(event) {
  try {
    const cred = await get(KEY);
    if (!cred) return;
    const last = Number(await get(SEEN, session)) || 0;
    if (event === "app_opened" && last) return;
    if (event === "active_session" && Date.now() - last < 24 * 60_000) return;
    let tid = await get(TID);
    if (!tid) { tid = crypto.randomUUID(); await local.set({ [TID]: tid }); }
    await session.set({ [SEEN]: Date.now() });
    await fetch(`${API}/telemetry`, { method: "POST", signal: AbortSignal.timeout(5_000),
      headers: { "content-type": "application/json", authorization: `Bearer ${cred.key}` },
      body: JSON.stringify({ v: 1, app: APP_SLUG, install_id: tid, event, app_version: VERSION, os: osCode() }) });
    beacon(event);
  } catch { /* never breaks the extension */ }
}

/** Anonymous beacon so the builds hub can split publik's one-listing numbers by build. No content, no account. */
export async function beacon(event) {
  try {
    let id = await get(HUB_ID);
    if (!id) { id = crypto.randomUUID(); await local.set({ [HUB_ID]: id }); }
    const publik = !!(await get(KEY));
    fetch(`${HUB_URL}/api/beacon`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(4000),
      body: JSON.stringify({ v: 1, build: BUILD, event, mode: "publik", install: id, publik, app_version: VERSION }) }).catch(() => {});
  } catch { /* fire and forget */ }
}

// ---------- publik API ----------

export class AIError extends Error {
  constructor(status, message, link = null) { super(message); this.status = status; this.link = link; }
}

/** One chat completion on publik API. tier: fast | balanced | smart. Returns the text. */
export async function chat({ system, messages, tier = "balanced", maxTokens = 4000, signal }) {
  const cred = await get(KEY);
  if (!cred || (await get(CHOICE)) !== "publik") throw new AIError(401, "Sign in with publik first.");
  let res;
  try {
    const timeout = AbortSignal.timeout(120_000);
    res = await fetch(`${API}/chat/completions`, {
      method: "POST", signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { "content-type": "application/json", authorization: `Bearer ${cred.key}` },
      body: JSON.stringify({ model: MODELS[tier] ?? MODELS.balanced, stream: false, max_tokens: maxTokens,
        messages: [...(system ? [{ role: "system", content: system }] : []), ...messages] }),
    });
  } catch {
    throw new AIError(502, "publik API is not reachable right now. Try again in a moment.");
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 402) throw new AIError(402, body.error?.message ?? "Not enough publik balance.", body.error?.top_up_url ?? `${PUBLIK_ORIGIN}/wallet`);
  if (res.status === 401) throw new AIError(401, "Your publik sign-in ended. Sign in again.");
  if (!res.ok) throw new AIError(res.status, body.error?.message ?? `publik API answered ${res.status}.`);
  const c = body.choices?.[0]?.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("") : "";
  beacon("ai_call");
  return text;
}
