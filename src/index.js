import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { parseSubscription } from "./parser.js";

const VERSION = "1.1.0";
const DEFAULT_CONFIG_URL =
  "https://rdone4425.github.io/clash-configs/configs/clash-remote.yaml";
const DEFAULT_TTL = 300;
const MAX_TTL = 3600;
const ID_PATTERN = /^[a-f0-9]{32}$/;
const SETTINGS_KEY = "settings:global";
const NODES_KEY = "nodes:global";
const DEFAULT_PERSONAL_RULES_URL =
  "https://rdone4425.github.io/clash-configs/configs/rules/personal-direct.list";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers": "authorization, content-type",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    try {
      const profile = matchProfileRoute(url.pathname);
      if (profile) {
        if (request.method !== "GET") throw new HttpError(405, "只支持 GET");
        if (profile.kind === "sub") {
          return await handleProfileSub(request, env, profile.id);
        }
        return await handleProfileProvider(request, env, ctx, profile.id);
      }

      const ruleMatch = url.pathname.match(/^\/rules\/([A-Za-z0-9!_.-]+)$/);
      if (ruleMatch) {
        if (request.method !== "GET") throw new HttpError(405, "只支持 GET");
        return await handleRule(request, env, ctx, ruleMatch[1]);
      }

      if (url.pathname === "/api/refresh") {
        if (request.method !== "POST") throw new HttpError(405, "只支持 POST");
        requireToken(request, env);
        const record = await refreshNodes(env);
        return json({ ok: true, count: record.count, updatedAt: record.updatedAt });
      }

      if (url.pathname === "/api/settings") {
        if (request.method === "GET") return await handleGetSettings(request, env);
        if (request.method === "POST") return await handleSaveSettings(request, env);
        if (request.method === "DELETE") return await handleDeleteSettings(request, env);
        throw new HttpError(405, "只支持 GET/POST/DELETE");
      }

      if (url.pathname === "/api/profiles") {
        if (request.method === "POST") return await handleCreateProfile(request, env);
        throw new HttpError(405, "只支持 POST");
      }

      const apiMatch = url.pathname.match(/^\/api\/profiles\/([a-f0-9]{32})$/);
      if (apiMatch) {
        if (request.method === "DELETE") {
          return await handleDeleteProfile(request, env, apiMatch[1]);
        }
        throw new HttpError(405, "只支持 DELETE");
      }

      if (request.method !== "GET") {
        throw new HttpError(405, "只支持 GET");
      }

      switch (url.pathname) {
        case "/":
          return html(infoPage(env, request));
        case "/health":
          return json({ status: "ok", version: VERSION });
        case "/sub":
          return await handleSub(request, env);
        case "/stash":
          return await handleSub(request, env, "stash");
        case "/provider":
          return await handleProvider(request, env, ctx);
        default:
          throw new HttpError(404, "Not Found");
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error.message || "服务器错误";
      if (status >= 500) {
        console.error(JSON.stringify({ level: "error", path: url.pathname, status, message }));
      }
      if (url.pathname.startsWith("/api/")) {
        return json({ error: message }, status);
      }
      return new Response(`请求失败：${message}\n`, {
        status,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          ...CORS,
        },
      });
    }
  },
};

/* -------------------------------- 全局设置 -------------------------------- */

async function loadSettings(env) {
  if (!env.PROFILES) return null;
  const raw = await env.PROFILES.get(SETTINGS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function handleGetSettings(request, env) {
  requireToken(request, env);
  const settings = await loadSettings(env);
  const nodes = await readNodes(env);
  return json({
    config: settings?.config || env.CONFIG_URL || DEFAULT_CONFIG_URL,
    urls: resolveSubscriptionUrls(settings, env),
    url: settings?.url || "",
    name: await resolveProfileName(env, settings),
    updatedAt: settings?.updatedAt || null,
    nodes: nodes ? { count: nodes.count, updatedAt: nodes.updatedAt } : null,
  });
}

async function handleSaveSettings(request, env) {
  requireToken(request, env);
  if (!env.PROFILES) throw new HttpError(500, "未配置 KV 命名空间 PROFILES");

  const body = await readJson(request);
  let rawUrls = Array.isArray(body.urls) ? body.urls : typeof body.urls === "string" ? body.urls.split(/\r?\n/) : [];
  if (rawUrls.length === 0 && body.url) rawUrls = [body.url];
  const urls = [];
  for (const raw of rawUrls) {
    const value = normalizeSubscriptionUrl(raw);
    if (!urls.includes(value)) urls.push(value);
  }
  if (urls.length === 0) throw new HttpError(400, "至少填写一个订阅地址");

  const configUrl = normalizeConfigUrl(body.config, env);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  const updatedAt = new Date().toISOString();

  await env.PROFILES.put(
    SETTINGS_KEY,
    JSON.stringify({ url: urls[0], urls, config: configUrl, name, updatedAt }),
  );

  return json({ ok: true, config: configUrl, urls, name: name || undefined, updatedAt });
}

async function handleDeleteSettings(request, env) {
  requireToken(request, env);
  if (!env.PROFILES) throw new HttpError(500, "未配置 KV 命名空间 PROFILES");
  await env.PROFILES.delete(SETTINGS_KEY);
  await env.PROFILES.delete(NODES_KEY);
  return json({ ok: true });
}

/* ------------------------------ 远程订阅（KV） ----------------------------- */

function matchProfileRoute(pathname) {
  const sub = pathname.match(/^\/s\/([a-f0-9]{32})$/);
  if (sub) return { kind: "sub", id: sub[1] };
  const provider = pathname.match(/^\/provider\/([a-f0-9]{32})$/);
  if (provider) return { kind: "provider", id: provider[1] };
  return null;
}

async function handleCreateProfile(request, env) {
  requireToken(request, env);
  if (!env.PROFILES) throw new HttpError(500, "未配置 KV 命名空间 PROFILES");

  const body = await readJson(request);
  const subscriptionUrl = normalizeSubscriptionUrl(body.url);
  const configUrl = normalizeConfigUrl(body.config ?? body.configUrl, env);
  const id = randomId();

  await env.PROFILES.put(
    profileKey(id),
    JSON.stringify({ url: subscriptionUrl, config: configUrl, createdAt: new Date().toISOString() }),
  );

  const origin = publicBase(request, env);
  return json(
    {
      id,
      subUrl: `${origin}/s/${id}`,
      providerUrl: `${origin}/provider/${id}`,
      configUrl,
    },
    201,
  );
}

async function handleDeleteProfile(request, env, id) {
  requireToken(request, env);
  if (!env.PROFILES) throw new HttpError(500, "未配置 KV 命名空间 PROFILES");
  await env.PROFILES.delete(profileKey(id));
  return json({ ok: true, id });
}

async function handleProfileSub(request, env, id) {
  const profile = await loadProfile(env, id);
  if (!profile) throw new HttpError(404, "订阅不存在或已删除");

  const { config } = await fetchConfig(profile.config || env.CONFIG_URL, env);
  rewriteRuleProviders(config, publicBase(request, env));
  await applyPersonalRules(config, env, publicBase(request, env));
  applyProvider(config, `${publicBase(request, env)}/provider/${id}`, env);

  return configResponse(await resolveProfileName(env), env, stringifyYaml(config, { lineWidth: 0 }), "text/yaml; charset=utf-8", {
    "x-config-source": profile.config || env.CONFIG_URL || DEFAULT_CONFIG_URL,
  });
}

async function handleProfileProvider(request, env, ctx, id) {
  const profile = await loadProfile(env, id);
  if (!profile) throw new HttpError(404, "订阅不存在或已删除");
  return serveProvider(profile.url, env, ctx, `profile:${id}`);
}

async function loadProfile(env, id) {
  if (!env.PROFILES) throw new HttpError(500, "未配置 KV 命名空间 PROFILES");
  const raw = await env.PROFILES.get(profileKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function profileKey(id) {
  return `profile:${id}`;
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeSubscriptionUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) throw new HttpError(400, "缺少订阅地址 url");

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, "订阅地址不是合法的 URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "只支持 http/https 订阅地址");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new HttpError(400, "不允许使用内网地址");
  }

  return parsed.href;
}

function publicBase(request, env) {
  return (env.PUBLIC_BASE || new URL(request.url).origin).replace(/\/+$/, "");
}

function normalizeConfigUrl(value, env) {
  const fallback = env.CONFIG_URL || DEFAULT_CONFIG_URL;
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new HttpError(400, "配置地址不是合法的 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new HttpError(400, "配置地址只支持 http/https");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new HttpError(400, "配置地址不能是内网地址");
  }

  return parsed.href;
}

function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host.includes(":")) {
    return (
      host === "::1" ||
      host === "::" ||
      host.startsWith("fc") ||
      host.startsWith("fd") ||
      host.startsWith("fe80")
    );
  }

  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/* ------------------------------ 固定订阅模式 ------------------------------ */

async function handleSub(request, env, targetOverride) {
  requireToken(request, env);

  const token = providedToken(request);
  const target = targetOverride || "clash";
  const settings = await loadSettings(env);

  // 每次订阅更新时，顺手把机场节点刷新进 KV
  let nodes = null;
  try {
    nodes = await refreshNodes(env);
  } catch (error) {
    console.error(JSON.stringify({ level: "warn", message: "订阅更新时刷新 KV 失败", error: error.message }));
    nodes = await readNodes(env);
  }

  const { config, configUrl } = await fetchConfig(
    settings?.config || env.CONFIG_URL || DEFAULT_CONFIG_URL,
    env,
  );

  rewriteRuleProviders(config, publicBase(request, env));
  await applyPersonalRules(config, env, publicBase(request, env), { asRules: target === "stash" });

  if (target === "stash") {
    // Stash 不支持 mrs / classical：geosite 转为 yaml 文本规则集，移除 expected-status
    for (const provider of Object.values(config["rule-providers"] || {})) {
      if (!provider || typeof provider.url !== "string") continue;
      if (provider.url.endsWith(".mrs")) {
        provider.url = provider.url.replace(/\.mrs$/, ".list?format=yaml");
        provider.format = "yaml";
      }
    }
    for (const group of config["proxy-groups"] || []) {
      if (group && group["expected-status"] !== undefined) delete group["expected-status"];
    }
  }

  if (nodes?.proxies?.length) {
    applyInlineNodes(config, nodes.proxies);
    applyRegionGroups(config, nodes.proxies);
  } else {
    const providerUrl = `${publicBase(request, env)}/provider?token=${encodeURIComponent(token)}`;
    applyProvider(config, providerUrl, env);
  }

  return configResponse(await resolveProfileName(env, settings), env, stringifyYaml(config, { lineWidth: 0 }), "text/yaml; charset=utf-8", {
    "x-config-source": configUrl,
    "x-node-count": String(nodes?.proxies?.length || 0),
  });
}

async function handleProvider(request, env, ctx) {
  requireToken(request, env);
  return serveGlobalNodes(env, ctx);
}

async function readNodes(env) {
  if (!env.PROFILES) return null;
  const raw = await env.PROFILES.get(NODES_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw);
    return Array.isArray(record?.proxies) && record.proxies.length > 0 ? record : null;
  } catch {
    return null;
  }
}

function resolveSubscriptionUrls(settings, env) {
  const urls = [];
  const push = (value) => {
    const text = String(value || "").trim();
    if (text && !urls.includes(text)) urls.push(text);
  };
  for (const url of Array.isArray(settings?.urls) ? settings.urls : []) push(url);
  if (urls.length === 0 && settings?.url) push(settings.url);
  if (urls.length === 0 && env.SUBSCRIPTION_URL) push(env.SUBSCRIPTION_URL);
  return urls;
}

async function refreshNodes(env) {
  if (!env.PROFILES) throw new HttpError(500, "未配置 KV 命名空间 PROFILES");

  const settings = await loadSettings(env);
  const urls = resolveSubscriptionUrls(settings, env);
  if (urls.length === 0) {
    throw new HttpError(500, "未配置订阅地址：请在 Worker 首页填写并保存");
  }

  let all = [];
  const failed = [];
  for (const subscriptionUrl of urls) {
    try {
      const text = await fetchSubscription(subscriptionUrl, env);
      const parsed = parseSubscription(text);
      if (parsed.length === 0) throw new Error("没有解析到节点");
      all = all.concat(parsed);
    } catch (error) {
      failed.push(`${new URL(subscriptionUrl).host}: ${error.message}`);
    }
  }

  if (all.length === 0) {
    throw new HttpError(422, `所有订阅都解析失败：${failed.join("；")}`);
  }
  if (failed.length > 0) {
    console.error(JSON.stringify({ level: "warn", message: "部分订阅失败", failed }));
  }

  // 跨订阅去重：同类型 + 同服务器 + 同端口 + 同凭据
  const seen = new Set();
  const unique = [];
  for (const node of all) {
    const key = `${node.type}|${node.server}|${node.port}|${node.uuid || node.password || node.username || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(node);
  }

  // Clash 要求节点名唯一，重名自动加序号
  const used = new Map();
  for (const node of unique) {
    const base = String(node.name || `${node.type}-${node.server}`).trim();
    const times = used.get(base) || 0;
    used.set(base, times + 1);
    node.name = times === 0 ? base : `${base} ${times + 1}`;
  }

  const record = {
    proxies: unique,
    count: unique.length,
    updatedAt: new Date().toISOString(),
  };
  await env.PROFILES.put(NODES_KEY, JSON.stringify(record));
  return record;
}

async function serveGlobalNodes(env, ctx) {
  const ttl = resolveNodeTtl(env);
  let record = await readNodes(env);
  const fresh = record && Date.now() - Date.parse(record.updatedAt) < ttl * 1000;
  let stale = false;

  if (!fresh) {
    try {
      record = await refreshNodes(env);
    } catch (error) {
      if (!record) throw error;
      stale = true;
      console.error(JSON.stringify({ level: "warn", message: "节点刷新失败，使用 KV 旧数据", error: error.message }));
    }
  }

  const yaml = stringifyYaml({ proxies: record.proxies }, { lineWidth: 0 });
  return new Response(yaml, {
    headers: {
      "content-type": "text/yaml; charset=utf-8",
      "cache-control": "public, max-age=60",
      ...CORS,
      "x-node-count": String(record.count),
      "x-nodes-updated": record.updatedAt,
      ...(stale ? { "x-nodes-stale": "1" } : {}),
    },
  });
}

/* -------------------------------- 公共逻辑 -------------------------------- */

async function fetchConfig(configUrl, env) {
  const target = new URL(configUrl);
  // 每分钟一个新 key，避免拿到旧缓存；GitHub Pages 改完 1 分钟内生效
  target.searchParams.set("_", String(Math.floor(Date.now() / 60000)));

  let response;
  try {
    response = await fetch(target.toString(), {
      headers: {
        "user-agent": `clash-gateway/${VERSION}`,
        accept: "text/yaml,text/plain,*/*",
      },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    throw new HttpError(502, `拉取配置模板失败：${error.message}`);
  }

  if (!response.ok) {
    throw new HttpError(502, `拉取配置模板失败：HTTP ${response.status}`);
  }

  const text = await response.text();
  let config;
  try {
    config = parseYaml(text);
  } catch {
    throw new HttpError(502, "配置模板不是合法的 YAML");
  }
  if (!config || typeof config !== "object") {
    throw new HttpError(502, "配置模板内容为空");
  }
  return { config, configUrl };
}

/**
 * 把 jsdelivr 的 mrs 规则地址换成 Worker 自己的 /rules/，避开核心直连失败。
 */
function ruleFetchProxy(config) {
  const groups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
  const main = groups.find((g) => g && g.name === "🚀 节点选择") || groups.find((g) => g && g.type === "select");
  return main ? main.name : "DIRECT";
}

function rewriteRuleProviders(config, base) {
  const providers = config["rule-providers"];
  if (!providers || typeof providers !== "object") return;

  const proxyName = ruleFetchProxy(config);
  const prefix = "https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/";
  for (const provider of Object.values(providers)) {
    if (!provider || typeof provider.url !== "string") continue;
    if (!provider.url.startsWith(prefix)) continue;
    const file = provider.url.slice(prefix.length);
    if (!/^[A-Za-z0-9!_.-]+\.mrs$/.test(file)) continue;
    provider.url = `${base}/rules/${file}`;
    provider.proxy = proxyName;
  }
}

/**
 * 个人规则库：仓库里的 rules/*.list 生成独立 rule-provider，置顶引用。
 * 加域名只需要编辑 list 文件 push，不用动配置模板。
 */
async function applyPersonalRules(config, env, base, options = {}) {
  const groups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
  const proxyName = ruleFetchProxy(config);
  const providers = config["rule-providers"] || (config["rule-providers"] = {});
  const rules = Array.isArray(config.rules) ? config.rules : [];

  const personalSets = [
    { provider: "personal-ai", file: "personal-ai.list", group: "🤖 AI 服务" },
    { provider: "personal-direct", file: "personal-direct.list", group: "🎯 全球直连" },
  ];

  if (options.asRules) {
    // Stash 不支持 classical 规则集：个人规则展开为普通规则置于顶部
    for (const set of personalSets) {
      const target = groups.find((g) => g && g.name === set.group)?.name || "DIRECT";
      try {
        const text = await fetchPersonalList(env, set.file);
        const ruleLines = parsePersonalList(text).map((line) => `${line},${target}`);
        rules.unshift(...ruleLines);
      } catch (error) {
        console.error(JSON.stringify({ level: "warn", message: `个人规则 ${set.file} 加载失败`, error: error.message }));
      }
    }
    config.rules = rules;
    return;
  }

  for (const set of personalSets) {
    const target = groups.find((g) => g && g.name === set.group)?.name || "DIRECT";
    providers[set.provider] = {
      type: "http",
      behavior: "classical",
      format: "text",
      url: `${base}/rules/${set.file}`,
      path: `./ruleset/${set.file}`,
      interval: 1800,
      proxy: proxyName,
    };
    if (!rules.some((rule) => typeof rule === "string" && rule.startsWith(`RULE-SET,${set.provider},`))) {
      rules.unshift(`RULE-SET,${set.provider},${target}`);
    }
  }

  config.rules = rules;
}

async function fetchPersonalList(env, file) {
  const listBase = (env.PERSONAL_RULES_URL || DEFAULT_PERSONAL_RULES_URL).replace(/[^/]*$/, "");
  const response = await fetch(listBase + file, {
    headers: { "user-agent": `clash-gateway/${VERSION}`, accept: "text/plain" },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function parsePersonalList(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * 地区识别表：按节点名匹配（国旗 emoji / ISO 代码 / 中文名 / 常见英文词）。
 */
const REGION_TABLE = [
  { name: "🇭🇰 香港", match: ["HK", "HKG", "HONGKONG", "HONG KONG", "香港", "🇭🇰"] },
  { name: "🇹🇼 台湾", match: ["TW", "TWN", "台湾", "臺灣", "台北", "🇹🇼"] },
  { name: "🇯🇵 日本", match: ["JP", "JPN", "JAPAN", "日本", "东京", "大阪", "🇯🇵"] },
  { name: "🇰🇷 韩国", match: ["KR", "KOR", "KOREA", "韩国", "首尔", "🇰🇷"] },
  { name: "🇸🇬 新加坡", match: ["SG", "SGP", "SINGAPORE", "新加坡", "狮城", "🇸🇬"] },
  { name: "🇺🇸 美国", match: ["US", "USA", "AMERICA", "美国", "洛杉矶", "圣何塞", "🇺🇸"] },
  { name: "🇬🇧 英国", match: ["UK", "GB", "GBR", "英国", "伦敦", "🇬🇧"] },
  { name: "🇩🇪 德国", match: ["DE", "GER", "德国", "法兰克福", "🇩🇪"] },
  { name: "🇫🇷 法国", match: ["FR", "FRA", "法国", "巴黎", "🇫🇷"] },
  { name: "🇳🇱 荷兰", match: ["NL", "NLD", "荷兰", "阿姆斯特丹", "🇳🇱"] },
  { name: "🇷🇺 俄罗斯", match: ["RU", "RUS", "俄罗斯", "莫斯科", "🇷🇺"] },
  { name: "🇲🇾 马来西亚", match: ["MY", "MYS", "马来西亚", "吉隆坡", "🇲🇾"] },
  { name: "🇹🇭 泰国", match: ["TH", "THA", "泰国", "曼谷", "🇹🇭"] },
  { name: "🇻🇳 越南", match: ["VN", "VNM", "越南", "🇻🇳"] },
  { name: "🇵🇭 菲律宾", match: ["PH", "PHL", "菲律宾", "🇵🇭"] },
  { name: "🇮🇳 印度", match: ["IN", "IND", "印度", "孟买", "🇮🇳"] },
  { name: "🇮🇩 印尼", match: ["ID", "IDN", "印尼", "雅加达", "🇮🇩"] },
  { name: "🇨🇦 加拿大", match: ["CA", "CAN", "加拿大", "🇨🇦"] },
  { name: "🇦🇺 澳大利亚", match: ["AU", "AUS", "澳大利亚", "澳洲", "悉尼", "🇦🇺"] },
  { name: "🇧🇷 巴西", match: ["BR", "BRA", "巴西", "🇧🇷"] },
  { name: "🇹🇷 土耳其", match: ["TR", "TUR", "土耳其", "🇹🇷"] },
  { name: "🇦🇷 阿根廷", match: ["AR", "ARG", "阿根廷", "🇦🇷"] },
];

function matchRegion(name, region) {
  const upper = String(name).toUpperCase();
  return region.match.some((kw) => {
    if (!/^[A-Z][A-Z ]*$/i.test(kw)) return upper.includes(kw);
    return new RegExp(`(^|[^A-Z])${kw}([^A-Z]|$)`).test(upper);
  });
}

function buildRegionGroups(nodes) {
  const groups = [];
  for (const region of REGION_TABLE) {
    const members = nodes.filter((node) => matchRegion(node.name, region)).map((node) => node.name);
    if (members.length === 0) continue;
    groups.push({ name: region.name, type: "select", proxies: [...members, "DIRECT"] });
  }
  return groups;
}

/**
 * 按节点地区生成国家组，插到策略组之后，并挂进 🚀 节点选择。
 */
function applyRegionGroups(config, nodes) {
  if (!Array.isArray(nodes) || nodes.length === 0) return;
  const regionGroups = buildRegionGroups(nodes);
  if (regionGroups.length === 0) return;

  const groups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
  const anchor = groups.findIndex((g) => g && g.name === "🔮 负载均衡");
  const insertAt = anchor >= 0 ? anchor + 1 : groups.length;
  groups.splice(insertAt, 0, ...regionGroups);

  const main = groups.find((g) => g && g.name === "🚀 节点选择");
  if (main && Array.isArray(main.proxies)) {
    const names = regionGroups.map((g) => g.name);
    const directIndex = main.proxies.indexOf("DIRECT");
    if (directIndex >= 0) main.proxies.splice(directIndex, 0, ...names);
    else main.proxies.unshift(...names);
  }
}

async function handleRule(request, env, ctx, file) {
  const format = new URL(request.url).searchParams.get("format");
  if (!/^[A-Za-z0-9!_.-]+$/.test(file)) {
    throw new HttpError(404, "规则不存在");
  }

  let upstream;
  let ttl;
  let transform;
  if (/^personal-[a-z0-9-]+\.list$/.test(file)) {
    const listBase = (env.PERSONAL_RULES_URL || DEFAULT_PERSONAL_RULES_URL).replace(/[^/]*$/, "");
    upstream = listBase + file;
    ttl = 300;
  } else if (/\.list$/.test(file)) {
    upstream = `https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/${file}`;
    ttl = 86400;
    transform = "stash-yaml";
  } else if (/\.mrs$/.test(file)) {
    upstream = `https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo/geosite/${file}`;
    ttl = 86400;
  } else {
    throw new HttpError(404, "规则不存在");
  }

  const cache = getCache();
  const cacheKey = cache ? new Request(`https://cache.internal/rules/${file}`, { method: "GET" }) : null;
  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return hit;
  }

  let response;
  try {
    response = await fetch(upstream, {
      headers: { "user-agent": `clash-gateway/${VERSION}`, accept: "*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new HttpError(502, `规则下载失败：${error.message}`);
  }
  if (!response.ok) throw new HttpError(502, `规则下载失败：HTTP ${response.status}`);

  let body;
  let contentType;
  if (transform === "stash-yaml" && format === "yaml") {
    const text = await response.text();
    const entries = String(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    body = ["payload:", ...entries.map((entry) => `  - ${entry}`)].join("\n");
    contentType = "text/yaml; charset=utf-8";
  } else {
    body = await response.arrayBuffer();
    contentType = file.endsWith(".mrs") ? "application/octet-stream" : "text/plain; charset=utf-8";
  }
  const output = new Response(body, {
    headers: {
      "content-type": contentType,
      "cache-control": `public, max-age=${ttl}`,
      "access-control-allow-origin": "*",
      "x-rule-name": file,
    },
  });

  if (cache && cacheKey) {
    ctx.waitUntil(cache.put(cacheKey, output.clone()).catch(() => undefined));
  }
  return output;
}

function applyProvider(config, providerUrl, env) {
  const providers = config["proxy-providers"] || {};
  config["proxy-providers"] = {
    ...providers,
    remote: {
      ...(providers.remote || {}),
      type: "http",
      proxy: "DIRECT",
      url: providerUrl,
      interval: Number(env.PROVIDER_INTERVAL || 3600),
      path: "./providers/remote.yaml",
      "health-check": {
        enable: true,
        url: "http://www.gstatic.com/generate_204",
        interval: 300,
      },
    },
  };
}

/**
 * 把节点直接写进配置文件的 proxies，并展开所有 use: [remote] 的组。
 */
function applyInlineNodes(config, nodes) {
  const names = nodes.map((node) => node.name);
  config.proxies = nodes;
  delete config["proxy-providers"];

  for (const group of config["proxy-groups"] || []) {
    const hadProvider = Array.isArray(group.use) && group.use.length > 0;
    delete group.use;
    if (!hadProvider) continue;

    const proxies = Array.isArray(group.proxies) ? group.proxies : [];
    const directIndex = proxies.indexOf("DIRECT");
    if (directIndex >= 0) {
      proxies.splice(directIndex, 0, ...names);
    } else {
      proxies.push(...names);
    }
    group.proxies = proxies;
  }
}

async function serveProvider(subscriptionUrl, env, ctx, hint) {
  const ttl = resolveTtl(env);
  const cache = getCache();
  const cacheKey =
    cache && ttl > 0
      ? new Request(`https://cache.internal/provider/${await sha256(hint)}`, {
          method: "GET",
        })
      : null;

  if (cache && cacheKey) {
    const hit = await cache.match(cacheKey).catch(() => undefined);
    if (hit) return hit;
  }

  const text = await fetchSubscription(subscriptionUrl, env);
  const nodes = parseSubscription(text);

  if (nodes.length === 0) {
    throw new HttpError(422, "没有解析到节点，请检查订阅地址或 UA");
  }

  const yaml = stringifyYaml({ proxies: nodes }, { lineWidth: 0 });

  const response = new Response(yaml, {
    headers: {
      "content-type": "text/yaml; charset=utf-8",
      "cache-control": ttl > 0 ? `public, max-age=${ttl}` : "no-store",
      ...CORS,
      "x-node-count": String(nodes.length),
    },
  });

  if (cache && cacheKey) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()).catch(() => undefined));
  }

  return response;
}

async function fetchSubscription(url, env) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        "user-agent": env.SUBSCRIPTION_UA || "v2rayN/6.42",
        accept: "*/*",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new HttpError(502, `订阅请求失败：${error.message}`);
  }

  if (!response.ok) {
    throw new HttpError(502, `订阅请求失败：HTTP ${response.status}`);
  }

  const text = await response.text();
  if (!text.trim()) throw new HttpError(502, "订阅内容为空");
  return text;
}

async function readJson(request) {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object") throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "请求体必须是 JSON，例如 {\"url\":\"https://...\"}");
  }
}

function requireToken(request, env) {
  const expected = env.ACCESS_TOKEN;
  if (!expected) throw new HttpError(500, "未配置 ACCESS_TOKEN");

  const provided = providedToken(request);
  if (!timingSafeEqual(provided, expected)) {
    throw new HttpError(401, "token 无效");
  }
}

function providedToken(request) {
  const url = new URL(request.url);
  const header = request.headers.get("authorization") || "";
  const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
  return url.searchParams.get("token")?.trim() || bearer;
}

function timingSafeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  if (left.byteLength !== right.byteLength) return false;

  if (typeof crypto.subtle.timingSafeEqual === "function") {
    try {
      return crypto.subtle.timingSafeEqual(left, right);
    } catch {
      return false;
    }
  }
  return a === b;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resolveTtl(env) {
  const parsed = Number.parseInt(env.CACHE_TTL || String(DEFAULT_TTL), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, MAX_TTL);
}

function resolveNodeTtl(env) {
  const parsed = Number.parseInt(env.NODE_TTL || "1800", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1800;
  return Math.min(parsed, 7200);
}

function getCache() {
  try {
    return typeof caches !== "undefined" && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

async function resolveProfileName(env, settings) {
  const s = settings || (await loadSettings(env));
  return (s?.name || env?.PROFILE_NAME || "Clash 网关订阅").trim() || "Clash 网关订阅";
}

function contentDisposition(name) {
  const label = (name || "Clash 网关订阅").trim() || "Clash 网关订阅";
  return `attachment; filename="clash-gateway"; filename*=UTF-8''${encodeURIComponent(label)}`;
}

function configResponse(name, env, body, contentType, extraHeaders = {}) {
  return new Response(body, {
    headers: {
      "content-type": contentType,
      "content-disposition": contentDisposition(name),
      "profile-update-interval": "1",
      "cache-control": "no-store",
      ...CORS,
      ...extraHeaders,
    },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...CORS,
    },
  });
}

function html(body) {
  return new Response(body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
    },
  });
}

function infoPage(env, request) {
  const configUrl = env.CONFIG_URL || DEFAULT_CONFIG_URL;
  const revealed =
    providedToken(request) && providedToken(request) === env.ACCESS_TOKEN
      ? env.ACCESS_TOKEN
      : "";
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Clash Gateway</title>
<style>
  :root{color-scheme:dark}
  body{margin:0;background:#070a12;color:#e8edf7;font-family:system-ui,-apple-system,"PingFang SC",sans-serif;line-height:1.7}
  main{max-width:760px;margin:0 auto;padding:56px 24px}
  h1{font-size:28px;margin:0 0 8px}
  h2{font-size:15px;margin:0 0 12px;color:#cbd5e1}
  p{color:#8b98ad;margin:6px 0}
  code{font-family:ui-monospace,Consolas,monospace;background:#111725;border:1px solid #1f2937;border-radius:6px;padding:2px 6px;word-break:break-all;font-size:12px}
  .card{margin-top:18px;padding:20px;border:1px solid #1f2937;border-radius:14px;background:#0f1522}
  label{display:block;font-size:12px;color:#8b98ad;margin:12px 0 6px}
  .hint{font-size:12px;color:#5d6a80;margin:6px 0 0}
  input{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #2a3546;border-radius:9px;background:#0b101b;color:#e8edf7;font:inherit;font-size:13px}
  textarea{width:100%;box-sizing:border-box;padding:9px 12px;border:1px solid #2a3546;border-radius:9px;background:#0b101b;color:#e8edf7;font:inherit;font-size:13px;resize:vertical}
  input:focus{outline:none;border-color:#7c5cff}
  .row{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}
  button{padding:8px 16px;border:1px solid transparent;border-radius:9px;background:linear-gradient(110deg,#7c5cff,#4f8cff 60%,#22d3ee);color:#fff;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
  button.ghost{background:transparent;border-color:#2a3546;color:#cbd5e1}
  button:disabled{opacity:.6;cursor:default}
  .status{margin-top:12px;font-size:13px;color:#8b98ad;min-height:20px}
  .status.error{color:#f87171}
  .status.ok{color:#34d399}
  .result{margin-top:16px;padding:12px;border:1px solid #1f2937;border-radius:10px;background:rgba(34,211,238,.06)}
  .result a{display:block;color:#22d3ee;font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all;text-decoration:none}
  .result a:hover{text-decoration:underline}
  ul{margin:8px 0 0;padding-left:20px}
  li{color:#cbd5e1;margin:6px 0;font-size:13px}
</style></head>
<body><main>
  <h1>Clash Gateway</h1>
  <p>把 GitHub 配置链接和机场订阅链接保存到 Worker，然后 Clash 直接用 <code>/sub</code>。</p>

  <div class="card">
    <h2>设置</h2>
    <label for="token">ACCESS_TOKEN</label>
    <input id="token" type="text" autocomplete="off" value="${escapeHtml(revealed)}" placeholder="调用令牌">
    <p class="hint">明文显示：带 <code>?token=你的令牌</code> 打开本页即可看到；直接打开则留空。</p>
    <label for="config">GitHub 配置链接（YAML）</label>
    <input id="config" type="url" value="${escapeHtml(configUrl)}" placeholder="https://.../clash-remote.yaml">
    <label for="url">机场订阅链接（每行一个，可多个，自动合并）</label>
    <textarea id="url" rows="3" placeholder="https://example.com/subscribe-1&#10;https://example.com/subscribe-2"></textarea>
    <label for="pname">订阅名字（导入 Clash 时显示）</label>
    <input id="pname" type="text" placeholder="Clash 网关订阅">
    <div class="row">
      <button id="save" type="submit">保存</button>
      <button id="load" class="ghost" type="button">读取当前设置</button>
      <button id="refresh" class="ghost" type="button">立即更新节点</button>
      <button id="clear" class="ghost" type="button">清除</button>
    </div>
    <div class="status" id="status"></div>
    <div class="status" id="nodes-status"></div>
    <div class="result" id="result" hidden>
      <a id="sub-link" target="_blank" rel="noreferrer"></a>
      <div class="row"><button id="copy" class="ghost" type="button">复制订阅地址</button></div>
      <p class="hint">Clash / Stash（Mihomo）：同上 /sub 链接</p>
    </div>
  </div>

  <div class="card">
    <h2>说明</h2>
    <ul>
      <li>配置里的节点走 <code>/provider</code>，规则走 GitHub 配置里的远程 <code>rule-providers</code></li>
      <li>改了 GitHub 上的分组或规则，Clash 下次刷新订阅就会用新版本</li>
      <li>设置存在 Cloudflare KV，不写入 GitHub</li>
    </ul>
  </div>
</main>
<script>
(function () {
  "use strict";
  var tokenInput = document.getElementById("token");
  var configInput = document.getElementById("config");
  var urlInput = document.getElementById("url");
  var nameInput = document.getElementById("pname");
  var statusBox = document.getElementById("status");
  var nodesStatus = document.getElementById("nodes-status");
  var refreshButton = document.getElementById("refresh");
  var result = document.getElementById("result");
  var subLink = document.getElementById("sub-link");
  var saveButton = document.getElementById("save");

  function setStatus(message, kind) {
    statusBox.textContent = message || "";
    statusBox.className = "status" + (kind ? " " + kind : "");
  }

  function showSub(token) {
    if (!token) return;
    var sub = location.origin + "/sub?token=" + encodeURIComponent(token);
    subLink.textContent = sub;
    subLink.href = sub;
    result.hidden = false;
  }

  function showNodes(nodes) {
    if (!nodes) {
      nodesStatus.textContent = "KV 里还没有节点，点「立即更新节点」";
      return;
    }
    nodesStatus.textContent = "KV 节点：" + nodes.count + " 个，更新于 " + nodes.updatedAt;
  }

  async function refreshNodesNow() {
    if (!token()) { setStatus("先填 ACCESS_TOKEN", "error"); return; }
    refreshButton.disabled = true;
    setStatus("更新节点中…");
    try {
      var response = await fetch("/api/refresh", {
        method: "POST",
        headers: { authorization: "Bearer " + token() },
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
      showNodes({ count: data.count, updatedAt: data.updatedAt });
      setStatus("节点已更新", "ok");
    } catch (error) {
      setStatus("更新失败：" + (error.message || error), "error");
    } finally {
      refreshButton.disabled = false;
    }
  }

  function token() {
    return tokenInput.value.trim();
  }

  async function load() {
    if (!token()) { setStatus("先填 ACCESS_TOKEN", "error"); return; }
    setStatus("读取中…");
    try {
      var response = await fetch("/api/settings", { headers: { authorization: "Bearer " + token() } });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
      configInput.value = data.config || "";
      var urls = data.urls && data.urls.length ? data.urls : (data.url ? [data.url] : []);
      urlInput.value = urls.join("\n");
      nameInput.value = data.name || "";
      localStorage.setItem("clash-gateway-token", token());
      showSub(token());
      showNodes(data.nodes);
      setStatus(data.updatedAt ? "已加载，上次保存：" + data.updatedAt : "还没有保存过设置", data.updatedAt ? "ok" : "");
    } catch (error) {
      setStatus("读取失败：" + (error.message || error), "error");
    }
  }

  async function save() {
    if (!token()) { setStatus("先填 ACCESS_TOKEN", "error"); return; }
    saveButton.disabled = true;
    setStatus("保存中…");
    try {
      var response = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token() },
        body: JSON.stringify({
          config: configInput.value.trim(),
          urls: urlInput.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean),
          name: nameInput.value.trim(),
        }),
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
      localStorage.setItem("clash-gateway-token", token());
      showSub(token());
      setStatus("已保存", "ok");
    } catch (error) {
      setStatus("保存失败：" + (error.message || error), "error");
    } finally {
      saveButton.disabled = false;
    }
  }

  async function clear() {
    if (!token()) { setStatus("先填 ACCESS_TOKEN", "error"); return; }
    try {
      var response = await fetch("/api/settings", {
        method: "DELETE",
        headers: { authorization: "Bearer " + token() },
      });
      if (!response.ok) {
        var data = await response.json().catch(function () { return {}; });
        throw new Error(data.error || "HTTP " + response.status);
      }
      urlInput.value = "";
      result.hidden = true;
      setStatus("已清除", "ok");
    } catch (error) {
      setStatus("清除失败：" + (error.message || error), "error");
    }
  }

  saveButton.addEventListener("click", save);
  document.getElementById("load").addEventListener("click", load);
  refreshButton.addEventListener("click", refreshNodesNow);
  document.getElementById("clear").addEventListener("click", clear);
  document.getElementById("copy").addEventListener("click", function () {
    var text = subLink.textContent;
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { setStatus("已复制", "ok"); });
    } else {
      setStatus("请手动复制", "error");
    }
  });

  var saved = localStorage.getItem("clash-gateway-token");
  if (saved) {
    tokenInput.value = saved;
    load();
  }
})();
</script>
</body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
