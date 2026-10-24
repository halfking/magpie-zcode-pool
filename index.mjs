// magpie-zcode-pool — the ZCode account pool that zcode-switcher keeps on
// this computer, served to magpie as one provider.
//
// The pool lives where zcode-switcher keeps it:
// ~/.zcode/v2/account-profiles/profiles.json lists one profile per signed-in
// ZCode account, and beside it each profile's credentials file holds that
// account's coding-plan key. This plugin reads that pool and serves it as a
// magpie provider (provider id "zcode-pool").
//
// Signing in picks an account of the pool: each sign-in is one magpie
// account of that pool account, so magpie's own accounts, quota cards and
// routing groups can hold several of them and move between them on their
// own. An account whose plan is spent is left alone until the vendor says
// when the limit resets.
//
// The models are the GLM ones a coding plan serves: GLM-5.3, GLM-5.3-Flash,
// GLM-5.2 and GLM-5-Turbo.
//
// The card of an account also says the resets it holds: the five hours' and
// the week's, read from the vendor's own list, the same one magpie reads for
// a GLM Coding plan of its own. Only read: a reset is spent on the vendor's
// page (zcode-switcher does it), never from here.

import { createDecipheriv, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join } from "node:path";

const PROVIDER = "zcode-pool";
const NAME = "ZCode 账号池";

const ZAI_BASE = "https://api.z.ai/api/anthropic";
const BIGMODEL_BASE = "https://open.bigmodel.cn/api/anthropic";

const MODELS = [
  { id: "GLM-5.3", context: 1_000_000, output: 128_000, efforts: ["low", "high", "max"] },
  { id: "GLM-5.3-Flash", context: 1_000_000, output: 128_000, efforts: ["low", "high", "max"] },
  { id: "GLM-5.2", context: 1_000_000, output: 128_000, efforts: ["none", "high", "max"] },
  { id: "GLM-5-Turbo", context: 200_000, output: 64_000, efforts: ["none", "high"] },
];

// poolDir is where the pool is. MAGPIE_ZCODE_POOL moves it, for a test or
// for a computer whose ZCode lives elsewhere.
function poolDir() {
  const said = (process.env.MAGPIE_ZCODE_POOL ?? "").trim();
  if (said) return said.replace(/^~(?=$|\/)/, homedir());
  return join(homedir(), ".zcode", "v2", "account-profiles");
}

// secret is the key ZCode encrypts its credentials with: the sha256 of its
// fallback seed, which names this computer and this user. With
// ZCODE_CREDENTIAL_SECRET said, that seed is used instead.
function secret() {
  let seed = process.env.ZCODE_CREDENTIAL_SECRET;
  if (!seed) {
    let name = "";
    try {
      name = userInfo().username;
    } catch {
      // a user whose name cannot be read is part of the seed as it is
    }
    name = name.slice(name.lastIndexOf("\\") + 1);
    seed = `zcode-credential-fallback:${platform()}:${homedir()}:${name}`;
  }
  return createHash("sha256").update(seed).digest();
}

// decrypt is one encrypted value of ZCode's: enc:v1:<iv>.<tag>.<data>, sealed
// with AES-256-GCM under the secret. A value that is not one of those is
// returned as it is, for ZCode keeps some values plain.
function decrypt(value) {
  if (typeof value !== "string") return null;
  if (!value.startsWith("enc:v1:")) return value;
  const parts = value.slice(7).split(".");
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, data] = parts.map((p) => Buffer.from(p.replace(/=+$/, ""), "base64url"));
    const decipher = createDecipheriv("aes-256-gcm", secret(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// codingPlanKey is the account's key for its coding plan, out of its
// credentials: the one named
// account-provider:coding-plan:account:<family>-individual-coding-plan:
// account:<id>:api-key
// It is stored encrypted, so it is opened first. A key that does not look
// like one (no dot in it, a placeholder in it) is not used.
function codingPlanKey(credentials) {
  if (!credentials || typeof credentials !== "object") return "";
  for (const name of Object.keys(credentials)) {
    if (!name.includes(":coding-plan:") || !name.endsWith(":api-key")) continue;
    const value = decrypt(credentials[name]);
    if (typeof value !== "string") continue;
    const key = value.trim();
    if (!key || !key.includes(".") || /[\s{$]/.test(key)) continue;
    return key;
  }
  return "";
}

// readPool is the accounts of the pool, each with the key it serves with.
// A profile whose credentials are gone, or that has no coding-plan key, is
// left out rather than breaking the whole pool.
function readPool() {
  const dir = poolDir();
  const index = join(dir, "profiles.json");
  if (!existsSync(index)) return [];
  let profiles;
  try {
    profiles = JSON.parse(readFileSync(index, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(profiles)) return [];
  const out = [];
  for (const profile of profiles) {
    if (!profile || typeof profile !== "object") continue;
    const file = typeof profile.cred_file === "string" ? profile.cred_file : "";
    if (!file) continue;
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    let credentials;
    try {
      credentials = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    const key = codingPlanKey(credentials);
    if (!key) continue;
    const family = profile.family === "zai" ? "zai" : "bigmodel";
    out.push({
      id: String(profile.id ?? profile.name ?? ""),
      name: String(profile.name ?? profile.id ?? "ZCode"),
      // the address the account gave, already masked by zcode-switcher
      email: String(profile.email ?? ""),
      userId: String(profile.user_id ?? ""),
      family,
      key,
      base: family === "zai" ? ZAI_BASE : BIGMODEL_BASE,
    });
  }
  return out;
}

// accountOf is the pool account a sign-in is for: the one it says, or the
// key it kept when the pool has moved on since.
function accountOf(auth) {
  if (!auth) return null;
  const id = auth?.metadata?.poolAccount ?? auth?.metadata?.account;
  const found = readPool().find((a) => a.id === id);
  if (found) return found;
  const key = typeof auth.key === "string" ? auth.key.trim() : "";
  if (!key) return null;
  const family = auth?.metadata?.family === "zai" ? "zai" : "bigmodel";
  return {
    id: id ?? "signed-in",
    name: auth?.metadata?.name ?? "signed-in",
    userId: "",
    family,
    key,
    base: family === "zai" ? ZAI_BASE : BIGMODEL_BASE,
  };
}

// isNum says a value is a number the vendor told.
function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// compact is a count as magpie says one: whole, else to two places.
function compact(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

// spanOf is how long a window runs, in seconds, out of the vendor's own
// encoding of it: unit 3 is hours (number 5 is the five-hour window), unit
// 6 is weeks, unit 5 is months, unit 4 is days, unit 1 is minutes.
function spanOf(unit, n) {
  n = Math.trunc(Number(n) || 0);
  if (unit === 3 && n <= 0) n = 5;
  n = Math.max(n, 1);
  return { 1: 60, 3: 3600, 4: 86400, 5: 30 * 86400, 6: 7 * 86400 }[unit] * n || 0;
}

// windowName is what magpie's card calls a window of that span.
function windowName(span) {
  if (span === 0) return "Credits";
  if (span < 86400) return `${Math.trunc(span / 3600)} hours`;
  if (span === 7 * 86400) return "Weekly";
  if (span >= 28 * 86400) return "Monthly";
  return `${Math.trunc(span / 86400)} days`;
}

// limitWindows are the vendor's limits as magpie's windows: what is used of
// the whole when both are told (the whole less what remains, or the current
// value), else the percentage given. A window whose count is told carries
// it as the amount of its limit, so magpie's card says the count as used.
function limitWindows(data) {
  const out = [];
  for (const x of data?.limits ?? []) {
    const type = String(x?.type ?? "").toUpperCase();
    const span = spanOf(x?.unit, x?.number);
    const w = { name: windowName(span), used: 0 };
    if (type === "TIME_LIMIT") {
      // the month's MCP tool calls: ZCode shows them, but they never stop
      // the models, so they are a footnote on the card
      w.name = "MCP · Month";
      w.aside = true;
    } else if (type === "TOKENS_LIMIT") {
      w.name = `${windowName(span)} · Tokens`;
    }
    if (isNum(x?.percentage)) w.used = x.percentage;
    if (x?.usage === 0) {
      // no cap on that window (an older plan's): the vendor may still give
      // it as 100% used
      w.used = 0;
      w.aside = true;
    }
    if (isNum(x?.usage) && x.usage > 0) {
      const total = x.usage;
      if (isNum(x?.remaining)) {
        const used = total - x.remaining;
        w.used = (100 * used) / total;
        w.amount = used;
        w.limit = total;
        w.display = `${compact(used)} / ${compact(total)}`;
      } else if (isNum(x.currentValue)) {
        if (!isNum(x.percentage)) w.used = (100 * x.currentValue) / total;
        w.amount = x.currentValue;
        w.limit = total;
        w.display = `${compact(x.currentValue)} / ${compact(total)}`;
      }
    }
    const reset = Math.trunc(Number(x?.nextResetTime) || 0);
    if (reset > 0) w.resetsAt = new Date(reset).toISOString();
    if (span) w.span = span;
    out.push(w);
  }
  return out;
}

// beijing reads a time the vendor writes in Beijing, as ms.
function beijing(s) {
  s = String(s ?? "").trim().replace(" ", "T");
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/.test(s)) return 0;
  const t = Date.parse(s + (s.length === 10 ? "T00:00:00" : "") + "+08:00");
  return Number.isFinite(t) ? t : 0;
}

// term is how long the plan is paid for: the valid subscription's renewal,
// or the end of its time.
function term(subs) {
  for (const x of Array.isArray(subs) ? subs : []) {
    if (String(x?.status ?? "").toUpperCase() !== "VALID") continue;
    const auto = x.autoRenew === true || x.autoRenew === 1;
    const t = beijing(typeof x.nextRenewTime === "string" ? x.nextRenewTime : "");
    if (t) return { until: new Date(t).toISOString(), renew: auto ? "auto" : "off" };
    const ds = String(typeof x.valid === "string" ? x.valid : "").match(/\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?/g) ?? [];
    if (ds.length && !auto) {
      const end = beijing(ds[ds.length - 1]);
      if (end) return { until: new Date(end).toISOString(), renew: "off" };
    }
    return {};
  }
  return {};
}

// vendorGet is one read from the vendor's business API, with the plan key.
async function vendorGet(url, key) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${key}`,
      "User-Agent": "magpie-zcode-pool",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`.trim());
  }
  let env;
  try {
    env = JSON.parse(text);
  } catch {
    throw new Error("the vendor's answer is not JSON");
  }
  const code = env?.code == null ? "" : String(env.code);
  if (code && code !== "0" && code !== "200" && code !== "10000") {
    throw new Error(env?.msg || `error ${code}`);
  }
  return env?.data ?? null;
}

// whenOf is a time the vendor tells, as magpie's own resets read it: a
// string in Beijing time, or a count of seconds (or of milliseconds, when it
// is that big). It is an ISO time, or "" when the vendor told nothing.
function whenOf(v) {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) {
    const ms = v > 1e12 ? v : v * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  }
  const t = beijing(v);
  return t ? new Date(t).toISOString() : "";
}

// readResets is the resets the account's plan holds: the five hours' and the
// week's, of which only those still available count (one that ran out stays
// listed for a week, available false). It is the same list magpie reads for a
// GLM Coding plan of its own (zcode_team.go), asked with the plan's key.
async function readResets(account) {
  const root = account.family === "zai" ? "https://api.z.ai" : "https://open.bigmodel.cn";
  const data = await vendorGet(
    `${root}/api/biz/customer-package-reset/list?targetType=PERSONAL`,
    account.key,
  );
  const each = [];
  let soonest = "";
  const count = (list, window) => {
    let n = 0;
    for (const x of Array.isArray(list) ? list : []) {
      if (x?.available !== true) continue;
      n++;
      const until = whenOf(x?.expireTime);
      if (until && (!soonest || until < soonest)) soonest = until;
      each.push({ until, window });
    }
    return n;
  };
  const fiveHour = count(data?.fiveHourResets, "fiveHour");
  const weekly = count(data?.weekResets, "weekly");
  const total = fiveHour + weekly;
  // none is told as none: a card without a count is better than one that says
  // zero resets are left
  if (!total) return null;
  return { count: total, byWindow: true, fiveHour, weekly, until: soonest, each };
}

// readQuota is the account's allowance: its plan, its windows, how long the
// plan is paid for, and the resets it holds.
async function readQuota(account) {
  const root = account.family === "zai" ? "https://api.z.ai" : "https://open.bigmodel.cn";
  const data = await vendorGet(`${root}/api/monitor/usage/quota/limit`, account.key);
  const out = {};
  const level = typeof data?.level === "string" ? data.level.trim() : "";
  if (level) out.plan = `GLM Coding ${level[0].toUpperCase()}${level.slice(1)}`;
  out.windows = limitWindows(data);
  try {
    const subs = await vendorGet(`${root}/api/biz/subscription/list`, account.key);
    Object.assign(out, term(subs));
  } catch {
    // the term is a nicety: a card without it still shows its windows
  }
  try {
    const resets = await readResets(account);
    if (resets) out.resets = resets;
  } catch {
    // the resets are a nicety too: a card without them still shows its windows
  }
  return out;
}

// The vendor is asked for several accounts' allowance at once, and it
// closes some of those connections when they come at the same time, so the
// reads are one after another with a small gap, each retried, and a reading
// that worked is kept for a while (the card asks again and again).
const READ_TTL = 60 * 1000;
const READ_GAP = 300;
const lastRead = new Map();
let reading = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// quotaOf is the account's allowance, read carefully.
async function quotaOf(account) {
  const cached = lastRead.get(account.id);
  if (cached && Date.now() - cached.at < READ_TTL) return cached.card;
  const run = reading.then(async () => {
    await sleep(READ_GAP);
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const card = await readQuota(account);
        lastRead.set(account.id, { at: Date.now(), card });
        return card;
      } catch (e) {
        last = e;
        if (attempt < 2) await sleep(500 * (attempt + 1));
      }
    }
    throw last;
  });
  reading = run.then(
    () => {},
    () => {},
  );
  return run;
}

// exhausted says a refusal is one another account of the pool can serve:
// the plan is spent (429, 402), or the key was turned away (401, 403).
function exhausted(status) {
  return status === 429 || status === 402 || status === 401 || status === 403;
}

// spentUntil is when each account's plan is spent, by its id. The vendor
// says when the limit resets, so an account that is spent is left alone
// till then instead of being asked again on every request.
const spentUntil = new Map();

// resetAt is the time the vendor's own answer gives for the limit's reset.
function resetAt(text) {
  const m = /(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(text ?? ""));
  if (!m) return 0;
  const at = Date.parse(`${m[1]}T${m[2]}`);
  return Number.isFinite(at) && at > Date.now() ? at : 0;
}

// rotatingFetch sends the request on the first account of the list that is
// not spent and, when that account's plan is spent, tries the next one. The
// body is read once and sent again, so a retry asks the same thing.
async function rotatingFetch(accounts, input, init) {
  const url = String(input instanceof Request ? input.url : input);
  const base = input instanceof Request
    ? {
        method: input.method,
        headers: new Headers(input.headers),
        body: input.body,
        signal: input.signal,
        ...init,
      }
    : { ...init, headers: new Headers(init?.headers ?? {}) };
  let body = base.body;
  if (body != null && typeof body !== "string") {
    try {
      body = await new Response(body).text();
    } catch {
      body = undefined;
    }
  }
  delete base.duplex;
  const now = Date.now();
  const free = accounts.filter((a) => (spentUntil.get(a.id) ?? 0) <= now);
  const list = free.length ? free : accounts;
  let last = null;
  for (const account of list) {
    const headers = new Headers(base.headers);
    headers.delete("authorization");
    headers.set("x-api-key", account.key);
    headers.set("authorization", "Bearer " + account.key);
    const res = await fetch(url, {
      ...base,
      headers,
      body,
    });
    if (!exhausted(res.status)) return res;
    // the refusal is read, so the next try has the body free and the answer
    // can say when the limit resets
    let text = "";
    try {
      text = await res.text();
    } catch {
      // a body that cannot be read leaves the time unknown
    }
    const at = resetAt(text);
    if (res.status === 429) {
      spentUntil.set(account.id, at || now + 30 * 60 * 1000);
    }
    last = { status: res.status, headers: res.headers, text };
  }
  if (!last) throw new Error("ZCode 账号池里没有账号可用");
  return new Response(last.text, { status: last.status, headers: last.headers });
}

export async function MagpieZcodePoolPlugin({ client, magpie }) {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "zcode-pool", level: "info", message } });
    } catch {
      // a log that fails changes nothing
    }
  };
  // the option the user set: whether an account whose plan is spent may be
  // answered by another account of the pool. The host answers false for a
  // key it did not get, so the declared keys are read as a whole: a key
  // that is not declared leaves the pool's own fallback on.
  const fallbackOn = (provider) => {
    try {
      const all = magpie?.options?.(provider ?? PROVIDER);
      if (!all || typeof all !== "object") return true;
      if (!("pool-fallback" in all)) return true;
      return all["pool-fallback"] !== false;
    } catch {
      return true;
    }
  };
  return {
    config: async (cfg) => {
      cfg.provider ??= {};
      const pool = readPool();
      const base = pool[0]?.base ?? BIGMODEL_BASE;
      const was = cfg.provider[PROVIDER] ?? {};
      cfg.provider[PROVIDER] = {
        name: NAME,
        npm: "@ai-sdk/anthropic",
        api: base + "/v1",
        ...was,
        models: {
          ...Object.fromEntries(MODELS.map((m) => [m.id, entry(m)])),
          ...(was.models ?? {}),
        },
      };
    },

    provider: {
      id: PROVIDER,
      async models(provider) {
        const url = typeof provider?.api === "string" ? provider.api : BIGMODEL_BASE + "/v1";
        return Object.fromEntries(MODELS.map((m) => [m.id, model(m, url)]));
      },
    },

    auth: {
      provider: PROVIDER,
      options: [
        {
          key: "pool-fallback",
          label: "Plan spent: serve another account of the pool",
          description:
            "On: when the signed-in account's plan is spent, another account of the pool answers. Off: the request fails, and magpie's own routing moves to another account.",
          default: true,
        },
      ],
      methods: [
        {
          type: "api",
          label: `${NAME}（读取本机 zcode-switcher 的账号）`,
          keyless: true,
          prompts: [
            {
              type: "select",
              key: "account",
              message: "Sign in as which account of the pool?",
              options: readPool().map((a) => ({
                label: a.name,
                value: a.id,
                hint: a.email || (a.family === "zai" ? "z.ai" : "bigmodel"),
              })),
            },
          ],
          authorize: async (inputs) => {
            const pool = readPool();
            if (!pool.length) {
              throw new Error(
                `本机没有 ZCode 账号可读：先在 zcode-switcher 里登录一个账号（账号存在 ${poolDir()}）`,
              );
            }
            const wanted = pool.find((a) => a.id === inputs?.account);
            const account = wanted ?? pool[0];
            log(`sign-in: ${account.name} (${pool.length} in the pool)`);
            return {
              type: "success",
              key: account.key,
              metadata: {
                // magpie names an account by this (accountId, then the
                // address under it), so the pool's own name is what the
                // window shows, not the end of the key
                email: account.email || account.name,
                poolAccount: account.id,
                name: account.name,
                family: account.family,
                pool: pool.length,
                source: "zcode-switcher",
              },
            };
          },
        },
      ],

      async loader(getAuth, provider) {
        const auth = await getAuth();
        const signed = accountOf(auth);
        if (!signed) {
          throw new Error("ZCode 账号池是空的：在 zcode-switcher 里登录一个账号，再在 magpie 里登录一次本 provider");
        }
        // the account this sign-in is for answers first; the rest of the
        // pool is the fallback, unless the user turned it off
        const pool = readPool().filter((a) => a.id !== signed.id);
        const accounts = fallbackOn(provider?.id ?? PROVIDER) ? [signed, ...pool] : [signed];
        log(`serving ${signed.name} (${accounts.length} account(s) in hand)`);
        return {
          baseURL: signed.base + "/v1",
          apiKey: signed.key,
          async fetch(input, init) {
            const fresh = accountOf(await getAuth());
            const list = fresh && fresh.id !== signed.id ? [fresh, ...accounts.slice(1)] : accounts;
            return rotatingFetch(list, input, init);
          },
        };
      },

      async usage(getAuth) {
        const auth = await getAuth();
        const account = accountOf(auth);
        if (!account) return { error: "not signed in", signIn: "kept" };
        try {
          const card = await quotaOf(account);
          return { ...card, user: account.name, signIn: "kept" };
        } catch (e) {
          return { error: e?.message ?? String(e), user: account.name, signIn: "kept" };
        }
      },
    },
  };
}

// entry is a model in the config hook's list.
function entry(m) {
  return {
    id: m.id,
    name: m.id,
    reasoning: m.efforts.some((e) => e !== "none"),
    tool_call: true,
    attachment: false,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: m.context || 0, output: m.output || 0 },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  };
}

// model is a model in the models hook's list.
function model(m, url) {
  const e = entry(m);
  return {
    id: m.id,
    providerID: PROVIDER,
    name: m.id,
    api: { id: m.id, url, npm: "@ai-sdk/anthropic" },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: e.limit,
    options: {},
    headers: {},
    capabilities: {
      temperature: true,
      reasoning: e.reasoning,
      attachment: false,
      toolcall: true,
      input: { text: true, image: false, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
  };
}
