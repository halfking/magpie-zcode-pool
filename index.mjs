// magpie-zcode-pool — the ZCode account pool that zcode-switcher keeps on
// this computer, served to magpie as one provider.
//
// The pool lives where zcode-switcher keeps it:
// ~/.zcode/v2/account-profiles/profiles.json lists one profile per signed-in
// ZCode account, and beside it each profile's credentials file holds that
// account's coding-plan key. This plugin reads that pool and serves it as a
// single magpie provider (provider id "zcode-pool"): a request the account
// serving it turns away for want of quota is tried again on the next account
// of the pool, so one exhausted plan does not stop the agent.
//
// Signing in is not a paste: it reads the pool. With no account in it, the
// sign-in says so and asks for one in zcode-switcher.
//
// The models are the GLM ones a coding plan serves: GLM-5.3, GLM-5.3-Flash,
// GLM-5.2 and GLM-5-Turbo.

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
      userId: String(profile.user_id ?? ""),
      family,
      key,
      base: family === "zai" ? ZAI_BASE : BIGMODEL_BASE,
    });
  }
  return out;
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

// rotatingFetch sends the request on the first account of the pool that is
// not spent and, when that account's plan is spent, tries the next one. The
// body is read once and sent again, so a retry asks the same thing.
async function rotatingFetch(pool, input, init) {
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
  const free = pool.filter((a) => (spentUntil.get(a.id) ?? 0) <= now);
  const accounts = free.length ? free : pool;
  let last = null;
  for (const account of accounts) {
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

export async function MagpieZcodePoolPlugin({ client }) {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "zcode-pool", level: "info", message } });
    } catch {
      // a log that fails changes nothing
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
      methods: [
        {
          type: "api",
          label: `${NAME}（读取本机 zcode-switcher 的账号）`,
          keyless: true,
          authorize: async () => {
            const pool = readPool();
            if (!pool.length) {
              throw new Error(
                `本机没有 ZCode 账号可读：先在 zcode-switcher 里登录一个账号（账号存在 ${poolDir()}）`,
              );
            }
            log(`sign-in: ${pool.length} account(s) in the pool`);
            return {
              type: "success",
              key: pool[0].key,
              metadata: { pool: pool.length, dir: poolDir(), source: "zcode-switcher" },
            };
          },
        },
      ],

      async loader(getAuth) {
        const stored = await getAuth();
        // the pool is read again on every request, so an account added to it
        // is served and one taken out of it is left alone
        const accounts = () => {
          const pool = readPool();
          if (pool.length) return pool;
          // no pool to read: the key the sign-in kept still serves one account
          if (stored?.key) {
            return [
              {
                id: "signed-in",
                name: "signed-in",
                userId: "",
                family: "bigmodel",
                key: stored.key,
                base: BIGMODEL_BASE,
              },
            ];
          }
          return [];
        };
        const first = accounts();
        if (!first.length) {
          throw new Error("ZCode 账号池是空的：在 zcode-switcher 里登录一个账号，再在 magpie 里登录一次本 provider");
        }
        log(`serving from ${first.length} account(s): ${first.map((a) => a.name).join(", ")}`);
        return {
          baseURL: first[0].base + "/v1",
          apiKey: first[0].key,
          async fetch(input, init) {
            const pool = accounts();
            if (!pool.length) {
              throw new Error("ZCode 账号池是空的：在 zcode-switcher 里登录一个账号");
            }
            return rotatingFetch(pool, input, init);
          },
        };
      },
    },
  };
}
