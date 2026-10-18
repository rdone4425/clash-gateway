import { parse } from "yaml";
import worker from "./src/index.js";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");

const makeConfig = (extraGroup) => `mixed-port: 7890
proxies: []
proxy-groups:
  - name: 🚀 节点选择
    type: select
    use: [remote]
    proxies: [DIRECT]
${extraGroup ? `  - name: ${extraGroup}\n    type: select\n    use: [remote]\n    proxies: [DIRECT]\n` : ""}rules:
  - MATCH,🚀 节点选择
rule-providers:
  ai:
    type: http
    behavior: domain
    format: mrs
    url: https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/openai.mrs
    path: ./ruleset/ai.mrs
    interval: 86400
proxy-providers:
  remote:
    type: http
    url: https://old.example.com/provider/YOUR-PROFILE-ID
    interval: 3600
    path: ./providers/remote.yaml
`;

let currentConfig = makeConfig("");

const SUBSCRIPTION = [
  `ss://${b64("aes-256-gcm:pw")}@203.0.113.10:8388#Test-A`,
  "trojan://pw@203.0.113.11:443#Test-B",
].join("\n");

const store = new Map();
const env = {
  ACCESS_TOKEN: "test-token",
  SUBSCRIPTION_URL: "",
  CONFIG_URL: "https://example.com/config-a.yaml",
  CACHE_TTL: "0",
  PROFILES: {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
    async delete(key) {
      store.delete(key);
    },
  },
};

const ctx = { waitUntil() {}, passThroughOnException() {} };

globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes("config-a.yaml")) {
    return new Response(currentConfig, { status: 200, headers: { "content-type": "text/yaml" } });
  }
  if (url.includes("provider.example.com")) {
    return new Response(b64(SUBSCRIPTION), { status: 200 });
  }
  return new Response("unexpected " + url, { status: 500 });
};

const base = "https://gateway.example.com";
const headers = { authorization: "Bearer test-token", "content-type": "application/json" };

let response = await worker.fetch(
  new Request(`${base}/api/settings`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      config: "https://example.com/config-a.yaml",
      url: "https://provider.example.com/sub",
    }),
  }),
  env,
  ctx,
);
console.log("save settings:", response.status, await response.text());

response = await worker.fetch(new Request(`${base}/api/settings`, { headers }), env, ctx);
console.log("get settings:", response.status, await response.text());

response = await worker.fetch(new Request(`${base}/sub?token=test-token`), env, ctx);
let config = parse(await response.text());
console.log(
  "sub:",
  response.status,
  "| proxies:",
  config.proxies?.length,
  "| groups with use:",
  (config["proxy-groups"] || []).filter((g) => g.use).length,
  "| provider block:",
  Boolean(config["proxy-providers"]),
  "| rules remote:",
  config["rule-providers"].ai.url.startsWith("https://"),
);

response = await worker.fetch(new Request(`${base}/provider?token=test-token`), env, ctx);
const provider = parse(await response.text());
console.log("provider:", response.status, "| nodes:", provider.proxies.map((p) => p.name).join(", "));

currentConfig = makeConfig("🆕 新分组");
response = await worker.fetch(new Request(`${base}/sub?token=test-token`), env, ctx);
config = parse(await response.text());
console.log("hot update:", response.status, "| new group:", config["proxy-groups"].some((g) => g.name === "🆕 新分组"));

response = await worker.fetch(
  new Request(`${base}/api/settings`, {
    method: "POST",
    headers,
    body: JSON.stringify({ config: "https://example.com/config-a.yaml", url: "http://127.0.0.1/sub" }),
  }),
  env,
  ctx,
);
console.log("private url:", response.status, await response.text());

response = await worker.fetch(
  new Request(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ config: "https://example.com/config-a.yaml", url: "https://provider.example.com/sub" }),
  }),
  env,
  ctx,
);
console.log("no token:", response.status);

response = await worker.fetch(
  new Request(`${base}/api/settings`, { method: "DELETE", headers }),
  env,
  ctx,
);
console.log("clear:", response.status);

response = await worker.fetch(new Request(`${base}/provider?token=test-token`), env, ctx);
console.log("provider after clear:", response.status);

const page = await worker.fetch(new Request(`${base}/`), env, ctx);
const html = await page.text();
console.log("page:", page.status, "| form:", html.includes('id="token"'), "| csp script:", (page.headers.get("content-security-policy") || "").includes("script-src"));
