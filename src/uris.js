/**
 * 把 Clash 代理对象反向编码为节点 URI，
 * 用于生成 Shadowrocket（小火箭）/ v2rayN 等客户端的 base64 订阅。
 */

function utf8Base64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fragment(name) {
  return encodeURIComponent(String(name || "node"));
}

function wsQuery(proxy) {
  if (proxy.network !== "ws" || !proxy["ws-opts"]) return new URLSearchParams();
  const params = new URLSearchParams();
  params.set("type", "ws");
  if (proxy["ws-opts"].path) params.set("path", proxy["ws-opts"].path);
  const host = proxy["ws-opts"].headers?.Host || proxy["ws-opts"].headers?.host;
  if (host) params.set("host", host);
  return params;
}

function vmessUri(proxy) {
  const ws = proxy["ws-opts"] || {};
  const json = {
    v: "2",
    ps: proxy.name,
    add: proxy.server,
    port: String(proxy.port),
    id: proxy.uuid,
    aid: String(proxy.alterId ?? 0),
    scy: proxy.cipher || "auto",
    net: proxy.network || "tcp",
    type: "none",
    host: ws.headers?.Host || "",
    path: ws.path || "",
    tls: proxy.tls ? "tls" : "",
    sni: proxy.servername || "",
  };
  return `vmess://${utf8Base64(JSON.stringify(json))}`;
}

function vlessUri(proxy) {
  const params = new URLSearchParams();
  params.set("type", proxy.network || "tcp");
  if (proxy.tls) params.set("security", proxy["reality-opts"] ? "reality" : "tls");
  const sni = proxy.servername || proxy.sni;
  if (sni) params.set("sni", sni);
  if (proxy["client-fingerprint"]) params.set("fp", proxy["client-fingerprint"]);
  if (proxy.flow) params.set("flow", proxy.flow);
  const reality = proxy["reality-opts"];
  if (reality?.["public-key"]) params.set("pbk", reality["public-key"]);
  if (reality?.["short-id"]) params.set("sid", reality["short-id"]);
  const ws = wsQuery(proxy);
  for (const [key, value] of ws) params.set(key, value);
  const query = params.toString();
  return `vless://${proxy.uuid}@${proxy.server}:${proxy.port}${query ? "?" + query : ""}#${fragment(proxy.name)}`;
}

function trojanUri(proxy) {
  const params = new URLSearchParams();
  const ws = wsQuery(proxy);
  for (const [key, value] of ws) params.set(key, value);
  const sni = proxy.sni || proxy.servername;
  if (sni) params.set("sni", sni);
  if (proxy["skip-cert-verify"]) params.set("allowInsecure", "1");
  const query = params.toString();
  return `trojan://${encodeURIComponent(proxy.password)}@${proxy.server}:${proxy.port}${query ? "?" + query : ""}#${fragment(proxy.name)}`;
}

function ssUri(proxy) {
  const userinfo = utf8Base64(`${proxy.cipher}:${proxy.password}`);
  const base = `ss://${userinfo}@${proxy.server}:${proxy.port}`;
  let plugin = "";
  if (proxy.plugin === "obfs" && proxy["plugin-opts"]) {
    const opts = `obfs-local;obfs=${proxy["plugin-opts"].mode || "http"};obfs-host=${proxy["plugin-opts"].host || ""}`;
    plugin = `?plugin=${encodeURIComponent(opts)}`;
  }
  return `${base}${plugin}#${fragment(proxy.name)}`;
}

function hysteria2Uri(proxy) {
  const params = new URLSearchParams();
  const sni = proxy.sni || proxy.servername;
  if (sni) params.set("sni", sni);
  if (proxy["skip-cert-verify"]) params.set("insecure", "1");
  if (proxy.obfs) {
    params.set("obfs", proxy.obfs);
    if (proxy["obfs-password"]) params.set("obfs-password", proxy["obfs-password"]);
  }
  const query = params.toString();
  return `hysteria2://${encodeURIComponent(proxy.password)}@${proxy.server}:${proxy.port}${query ? "?" + query : ""}#${fragment(proxy.name)}`;
}

function tuicUri(proxy) {
  const params = new URLSearchParams();
  const sni = proxy.sni || proxy.servername;
  if (sni) params.set("sni", sni);
  if (proxy["congestion-controller"]) params.set("congestion_control", proxy["congestion-controller"]);
  if (proxy["udp-relay-mode"]) params.set("udp_relay_mode", proxy["udp-relay-mode"]);
  if (Array.isArray(proxy.alpn)) params.set("alpn", proxy.alpn.join(","));
  if (proxy["skip-cert-verify"]) params.set("allow_insecure", "1");
  const query = params.toString();
  return `tuic://${proxy.uuid}:${encodeURIComponent(proxy.password)}@${proxy.server}:${proxy.port}${query ? "?" + query : ""}#${fragment(proxy.name)}`;
}

function simpleUri(proxy) {
  const auth = proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password || "")}@` : "";
  const scheme = proxy.type === "socks5" ? "socks5" : proxy.tls ? "https" : "http";
  return `${scheme}://${auth}${proxy.server}:${proxy.port}#${fragment(proxy.name)}`;
}

export function proxyToUri(proxy) {
  if (!proxy || !proxy.type || !proxy.server || !proxy.port) return null;
  switch (proxy.type) {
    case "vmess":
      return vmessUri(proxy);
    case "vless":
      return vlessUri(proxy);
    case "trojan":
      return trojanUri(proxy);
    case "ss":
      return ssUri(proxy);
    case "hysteria2":
      return hysteria2Uri(proxy);
    case "tuic":
      return tuicUri(proxy);
    case "socks5":
    case "http":
      return simpleUri(proxy);
    default:
      return null; // ssr 等暂不支持反向编码
  }
}

export function buildBase64Subscription(proxies) {
  const lines = (proxies || []).map((proxy) => proxyToUri(proxy)).filter(Boolean);
  return utf8Base64(lines.join("\n"));
}
