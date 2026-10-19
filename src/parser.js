/**
 * 订阅解析：Base64 / 明文链接 / Clash YAML → Clash proxies。
 */
import { parse as parseYaml } from "yaml";

/* ------------------------------- 工具函数 ------------------------------- */

function str(value) {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}

function num(value) {
  const parsed = Number.parseInt(str(value), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeBase64(input) {
  const cleaned = input
    .replace(/\s+/g, "")
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .replace(/=+$/, "");
  const padded = cleaned + "=".repeat((4 - (cleaned.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function tryDecodeBase64(input) {
  try {
    return decodeBase64(input);
  } catch {
    return null;
  }
}

function parseHostPort(input) {
  let value = input.trim();
  if (value.endsWith("/")) value = value.slice(0, -1);

  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end > 0) {
      return { server: value.slice(1, end), port: toPort(value.slice(end + 1).replace(/^:/, "")) };
    }
  }

  const colon = value.lastIndexOf(":");
  if (colon <= 0) return { server: value, port: 0 };
  return { server: value.slice(0, colon), port: toPort(value.slice(colon + 1)) };
}

function toPort(value) {
  const port = Number.parseInt(value, 10);
  return port > 0 && port <= 65535 ? port : 0;
}

function splitUri(uri) {
  const schemeEnd = uri.indexOf("://");
  if (schemeEnd <= 0) return null;

  const scheme = uri.slice(0, schemeEnd).toLowerCase();
  let rest = uri.slice(schemeEnd + 3);

  let name = "";
  const hash = rest.indexOf("#");
  if (hash >= 0) {
    name = safeDecode(rest.slice(hash + 1));
    rest = rest.slice(0, hash);
  }

  let query = "";
  const question = rest.indexOf("?");
  if (question >= 0) {
    query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }

  let userinfo = "";
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    userinfo = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }

  const { server, port } = parseHostPort(rest);
  if (!server) return null;

  return { scheme, userinfo, server, port, params: new URLSearchParams(query), name };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function compact(object) {
  const result = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) continue;
    result[key] = value;
  }
  return result;
}

function transport(params, network) {
  const host = params.get("host") || "";
  const path = params.get("path") || "";
  const result = {};

  if (network === "ws") {
    result["ws-opts"] = { path: path || "/", ...(host ? { headers: { Host: host } } : {}) };
  } else if (network === "grpc") {
    result["grpc-opts"] = { "grpc-service-name": params.get("serviceName") || path || "" };
  } else if (network === "h2") {
    result["h2-opts"] = { path: path || "/", ...(host ? { host: [host] } : {}) };
  } else if (network === "http") {
    result["http-opts"] = {
      method: "GET",
      path: [path || "/"],
      ...(host ? { headers: { Host: [host] } } : {}),
    };
  }

  return result;
}

/* -------------------------------- 各协议 -------------------------------- */

function parseVmess(uri) {
  const body = uri.slice("vmess://".length).trim();
  let json;
  try {
    json = JSON.parse(body.startsWith("{") ? body : decodeBase64(body));
  } catch {
    return null;
  }

  const server = str(json.add) || str(json.host);
  const port = num(json.port);
  const uuid = str(json.id);
  if (!server || !port || !uuid) return null;

  const network = (str(json.net) || "tcp").toLowerCase();
  const tls = str(json.tls).toLowerCase() === "tls";
  const host = str(json.host);
  const path = str(json.path);

  const proxy = {
    name: str(json.ps) || `${server}:${port}`,
    type: "vmess",
    server,
    port,
    uuid,
    alterId: num(json.aid),
    cipher: str(json.scy) || "auto",
    network,
    udp: true,
  };

  if (tls) {
    proxy.tls = true;
    proxy.servername = str(json.sni) || host;
  }
  if (network === "ws") {
    proxy["ws-opts"] = { path: path || "/", ...(host ? { headers: { Host: host } } : {}) };
  } else if (network === "grpc") {
    proxy["grpc-opts"] = { "grpc-service-name": path || "" };
  }

  return compact(proxy);
}

function parseVless(uri) {
  const parts = splitUri(uri);
  if (!parts || !parts.port) return null;

  const uuid = safeDecode(parts.userinfo);
  if (!uuid) return null;

  const params = parts.params;
  const security = (params.get("security") || "none").toLowerCase();
  const network = (params.get("type") || "tcp").toLowerCase();
  const tls = security === "tls" || security === "reality";

  const proxy = {
    name: parts.name || `${parts.server}:${parts.port}`,
    type: "vless",
    server: parts.server,
    port: parts.port,
    uuid,
    network,
    tls,
    udp: true,
    ...transport(params, network),
  };

  if (security === "reality" && params.get("pbk")) {
    proxy["reality-opts"] = {
      "public-key": params.get("pbk"),
      "short-id": params.get("sid") || "",
    };
  }
  if (tls) {
    proxy.servername = params.get("sni") || params.get("host") || parts.server;
    const alpn = params.get("alpn");
    if (alpn) proxy.alpn = alpn.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (params.get("flow")) proxy.flow = params.get("flow");
  if (params.get("fp")) proxy["client-fingerprint"] = params.get("fp");

  return compact(proxy);
}

function parseTrojan(uri) {
  const parts = splitUri(uri);
  if (!parts || !parts.port) return null;

  const password = safeDecode(parts.userinfo);
  if (!password) return null;

  const params = parts.params;
  const network = (params.get("type") || "tcp").toLowerCase();
  const proxy = {
    name: parts.name || `${parts.server}:${parts.port}`,
    type: "trojan",
    server: parts.server,
    port: parts.port,
    password,
    network,
    udp: true,
    ...transport(params, network),
  };

  const sni = params.get("sni") || params.get("peer");
  if (sni) proxy.sni = sni;
  if (params.get("allowInsecure") === "1" || params.get("insecure") === "1") {
    proxy["skip-cert-verify"] = true;
  }
  return compact(proxy);
}

function parseShadowsocks(uri) {
  const body = uri.slice("ss://".length);
  let name = "";
  let rest = body;

  const hash = rest.indexOf("#");
  if (hash >= 0) {
    name = safeDecode(rest.slice(hash + 1));
    rest = rest.slice(0, hash);
  }

  let query = "";
  const question = rest.indexOf("?");
  if (question >= 0) {
    query = rest.slice(question + 1);
    rest = rest.slice(0, question);
  }

  let method = "";
  let password = "";
  let server = "";
  let port = 0;

  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    let userinfo = safeDecode(rest.slice(0, at));
    if (!userinfo.includes(":")) userinfo = tryDecodeBase64(userinfo) || userinfo;
    const colon = userinfo.indexOf(":");
    if (colon <= 0) return null;
    method = userinfo.slice(0, colon);
    password = userinfo.slice(colon + 1);
    ({ server, port } = parseHostPort(rest.slice(at + 1)));
  } else {
    const decoded = tryDecodeBase64(rest);
    if (!decoded) return null;
    const lastAt = decoded.lastIndexOf("@");
    if (lastAt < 0) return null;
    const credential = decoded.slice(0, lastAt);
    const colon = credential.indexOf(":");
    if (colon <= 0) return null;
    method = credential.slice(0, colon);
    password = credential.slice(colon + 1);
    ({ server, port } = parseHostPort(decoded.slice(lastAt + 1)));
  }

  if (!method || !server || !port) return null;

  const proxy = {
    name: name || `${server}:${port}`,
    type: "ss",
    server,
    port,
    cipher: method,
    password,
    udp: true,
  };

  const plugin = new URLSearchParams(query).get("plugin");
  if (plugin) {
    const [rawName, ...options] = plugin.split(";");
    const map = new Map();
    for (const option of options) {
      const equals = option.indexOf("=");
      if (equals < 0) map.set(option.toLowerCase(), "true");
      else map.set(option.slice(0, equals).toLowerCase(), option.slice(equals + 1));
    }
    const pluginName = (rawName || "").toLowerCase();
    if (pluginName === "obfs-local" || pluginName === "simple-obfs") {
      proxy.plugin = "obfs";
      const obfsHost = map.get("obfs-host") || map.get("host") || "";
      proxy["plugin-opts"] = obfsHost
        ? { mode: map.get("obfs") || "http", host: obfsHost }
        : { mode: map.get("obfs") || "http" };
    } else if (pluginName === "v2ray-plugin") {
      proxy.plugin = "v2ray-plugin";
      const pluginHost = map.get("host") || "";
      const pluginOpts = {
        mode: map.get("mode") || "websocket",
        path: map.get("path") || "/",
        tls: map.get("tls") === "true",
      };
      if (pluginHost) pluginOpts.host = pluginHost;
      proxy["plugin-opts"] = pluginOpts;
    }
  }

  return compact(proxy);
}

function parseShadowsocksR(uri) {
  let decoded;
  try {
    decoded = decodeBase64(uri.slice("ssr://".length));
  } catch {
    return null;
  }

  const slash = decoded.indexOf("/?");
  const main = slash >= 0 ? decoded.slice(0, slash) : decoded;
  const query = slash >= 0 ? new URLSearchParams(decoded.slice(slash + 2)) : new URLSearchParams();

  const segments = main.split(":");
  if (segments.length < 6) return null;

  const passwordPart = segments.pop();
  const obfs = segments.pop();
  const method = segments.pop();
  const protocol = segments.pop();
  const portText = segments.pop();
  const host = segments.join(":");
  const { server, port } = parseHostPort(`${host}:${portText}`);
  if (!server || !port || !method) return null;

  let password = "";
  try {
    password = decodeBase64(passwordPart);
  } catch {
    password = passwordPart;
  }

  const decodeParam = (value) => {
    if (!value) return "";
    try {
      return decodeBase64(value);
    } catch {
      return value;
    }
  };

  return compact({
    name: decodeParam(query.get("remarks")) || `${server}:${port}`,
    type: "ssr",
    server,
    port,
    cipher: method,
    password,
    protocol: protocol || "origin",
    obfs: obfs || "plain",
    "protocol-param": decodeParam(query.get("protoparam")),
    "obfs-param": decodeParam(query.get("obfsparam")),
    udp: true,
  });
}

function parseHysteria2(uri) {
  const parts = splitUri(uri);
  if (!parts || !parts.port) return null;

  const password = safeDecode(parts.userinfo);
  if (!password) return null;

  const params = parts.params;
  const proxy = {
    name: parts.name || `${parts.server}:${parts.port}`,
    type: "hysteria2",
    server: parts.server,
    port: parts.port,
    password,
  };

  const sni = params.get("sni") || params.get("peer");
  if (sni) proxy.sni = sni;
  if (params.get("insecure") === "1" || params.get("allowInsecure") === "1") {
    proxy["skip-cert-verify"] = true;
  }
  if (params.get("obfs") && params.get("obfs") !== "none") {
    proxy.obfs = params.get("obfs");
    proxy["obfs-password"] = params.get("obfs-password") || params.get("obfs_password") || "";
  }

  return compact(proxy);
}

function parseTuic(uri) {
  const parts = splitUri(uri);
  if (!parts || !parts.port) return null;

  const credentials = safeDecode(parts.userinfo);
  const colon = credentials.indexOf(":");
  if (colon <= 0) return null;

  const params = parts.params;
  const proxy = {
    name: parts.name || `${parts.server}:${parts.port}`,
    type: "tuic",
    server: parts.server,
    port: parts.port,
    uuid: credentials.slice(0, colon),
    password: credentials.slice(colon + 1),
    udp: true,
  };

  const sni = params.get("sni") || params.get("peer");
  if (sni) proxy.sni = sni;
  if (params.get("congestion_control")) proxy["congestion-controller"] = params.get("congestion_control");
  if (params.get("udp_relay_mode")) proxy["udp-relay-mode"] = params.get("udp_relay_mode");
  if (params.get("alpn")) proxy.alpn = params.get("alpn").split(",");
  if (params.get("allow_insecure") === "1" || params.get("insecure") === "1") {
    proxy["skip-cert-verify"] = true;
  }

  return compact(proxy);
}

function parseSimple(uri) {
  const parts = splitUri(uri);
  if (!parts || !parts.port) return null;

  const isSocks = parts.scheme === "socks" || parts.scheme === "socks5";
  const isHttp = parts.scheme === "http" || parts.scheme === "https";
  if (!isSocks && !isHttp) return null;

  const credentials = safeDecode(parts.userinfo);
  const colon = credentials.indexOf(":");
  const proxy = {
    name: parts.name || `${parts.server}:${parts.port}`,
    type: isSocks ? "socks5" : "http",
    server: parts.server,
    port: parts.port,
  };

  if (colon > 0) {
    proxy.username = credentials.slice(0, colon);
    proxy.password = credentials.slice(colon + 1);
  }
  if (parts.scheme === "https") proxy.tls = true;

  return compact(proxy);
}

const PARSERS = {
  vmess: parseVmess,
  vless: parseVless,
  trojan: parseTrojan,
  ss: parseShadowsocks,
  ssr: parseShadowsocksR,
  hysteria2: parseHysteria2,
  hy2: parseHysteria2,
  tuic: parseTuic,
  socks: parseSimple,
  socks5: parseSimple,
  http: parseSimple,
  https: parseSimple,
};

function parseNode(uri) {
  const match = /^([a-z0-9+.-]+):\/\//i.exec(uri.trim());
  if (!match) return null;
  const parser = PARSERS[match[1].toLowerCase()];
  if (!parser) return null;
  try {
    return parser(uri.trim());
  } catch {
    return null;
  }
}

/* ------------------------------- 订阅解析 ------------------------------- */

function collectNodes(text) {
  const trimmed = text.replace(/^\uFEFF/, "").trim();

  // 订阅本身就是 Clash 配置
  if (/^\s*(proxies|proxy-groups|mixed-port|port)\s*:/m.test(trimmed)) {
    const doc = parseYaml(trimmed);
    const proxies = Array.isArray(doc?.proxies) ? doc.proxies : [];
    return proxies.filter((proxy) => proxy && proxy.name && proxy.server && proxy.port);
  }

  let content = trimmed;
  if (!/:\/\//.test(content)) {
    const decoded = tryDecodeBase64(content);
    if (decoded && /:\/\//.test(decoded)) content = decoded;
  }

  const nodes = [];
  for (const line of content.split(/\r?\n/)) {
    const value = line.trim();
    if (!value || value.startsWith("#") || value.startsWith("//")) continue;
    if (!/^[a-z0-9+.-]+:\/\//i.test(value)) continue;
    const node = parseNode(value);
    if (node) nodes.push(node);
  }
  return nodes;
}

/* ------------------------------- 订阅解析 ------------------------------- */
/* ------------------------------- 对外接口 ------------------------------- */

/** 解析订阅文本，返回 Clash 代理数组 */
export function parseSubscription(text) {
  return collectNodes(text);
}
