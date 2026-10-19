/**
 * 把生成好的 Clash 配置转换为 Surge 配置。
 * 支持 ss / vmess / trojan / hysteria2 / vless（基础）/ socks5 / http；
 * tuic、ssr 等 Surge 不支持的类型以注释保留。
 */

function q(value) {
  const text = String(value ?? "");
  return /[",\s]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function bool(value) {
  return value ? "true" : "false";
}

function surgeLine(parts) {
  return `${parts[0]} = ${parts.slice(1).join(", ")}`;
}

function proxyToSurgeLine(proxy) {
  const { name, server, port } = proxy;

  switch (proxy.type) {
    case "ss": {
      const parts = [name, "ss", server, port, `encrypt-method=${proxy.cipher || "aes-256-gcm"}`, `password=${q(proxy.password)}`, "udp-relay=true"];
      if (proxy.plugin === "obfs") {
        parts.push(`obfs=${proxy["plugin-opts"]?.mode || "http"}`);
        if (proxy["plugin-opts"]?.host) parts.push(`obfs-host=${proxy["plugin-opts"].host}`);
      }
      return surgeLine(parts);
    }
    case "vmess": {
      if (proxy.network === "grpc") return `# 跳过 ${name}：Surge 暂不支持 vmess grpc`;
      const parts = [name, "vmess", server, port, `username=${proxy.uuid}`, `alter-id=${proxy.alterId ?? 0}`, `tls=${bool(proxy.tls)}`];
      if (proxy.network === "ws") {
        parts.push("ws=true");
        if (proxy["ws-opts"]?.path) parts.push(`ws-path=${proxy["ws-opts"].path}`);
        const host = proxy["ws-opts"]?.headers?.Host;
        if (host) parts.push(`ws-headers=Host:"${host}"`);
      }
      const sni = proxy.servername || proxy.sni;
      if (sni) parts.push(`sni=${sni}`);
      if (proxy["skip-cert-verify"]) parts.push("skip-cert-verify=true");
      return surgeLine(parts);
    }
    case "trojan": {
      const parts = [name, "trojan", server, port, `password=${q(proxy.password)}`, "udp-relay=true"];
      const sni = proxy.sni || proxy.servername;
      if (sni) parts.push(`sni=${sni}`);
      if (proxy["skip-cert-verify"]) parts.push("skip-cert-verify=true");
      if (proxy.network === "ws" && proxy["ws-opts"]) {
        parts.push("ws=true");
        if (proxy["ws-opts"].path) parts.push(`ws-path=${proxy["ws-opts"].path}`);
      }
      return surgeLine(parts);
    }
    case "hysteria2": {
      const parts = [name, "hysteria2", server, port, `password=${q(proxy.password)}`];
      const sni = proxy.sni || proxy.servername;
      if (sni) parts.push(`sni=${sni}`);
      if (proxy["skip-cert-verify"]) parts.push("skip-cert-verify=true");
      return surgeLine(parts);
    }
    case "vless": {
      if (proxy["reality-opts"]) return `# 跳过 ${name}：Surge 的 REALITY 参数请手动补充`;
      const parts = [name, "vless", server, port, `username=${proxy.uuid}`, `tls=${bool(proxy.tls)}`];
      if (proxy.flow) parts.push(`flow=${proxy.flow}`);
      const sni = proxy.servername || proxy.sni;
      if (sni) parts.push(`sni=${sni}`);
      if (proxy["skip-cert-verify"]) parts.push("skip-cert-verify=true");
      return surgeLine(parts);
    }
    case "socks5": {
      const parts = [name, "socks5", server, port];
      if (proxy.username) parts.push(`username=${proxy.username}`, `password=${q(proxy.password)}`);
      parts.push("udp-relay=true");
      return surgeLine(parts);
    }
    case "http": {
      const parts = [name, proxy.tls ? "https" : "http", server, port];
      if (proxy.username) parts.push(`username=${proxy.username}`, `password=${q(proxy.password)}`);
      if (proxy["skip-cert-verify"]) parts.push(`skip-cert-verify=${bool(proxy["skip-cert-verify"])}`);
      return surgeLine(parts);
    }
    default:
      return `# 跳过 ${name}：Surge 不支持 ${proxy.type}`;
  }
}

const SURGE_GROUP_TYPES = new Set(["select", "url-test", "fallback", "load-balance"]);

function groupToSurge(group, available) {
  if (!SURGE_GROUP_TYPES.has(group.type)) return null;

  let members = Array.isArray(group.proxies) ? group.proxies : [];
  if (group["include-all"] || group["include-all-proxies"]) {
    members = [...members, ...group._nodeNames];
  }
  members = members.filter((member) => available.has(member));
  if (members.length === 0) return null;

  const parts = [group.name, group.type, ...members];
  if (group.type !== "select") {
    parts.push(`url=${group.url || "http://www.gstatic.com/generate_204"}`);
    parts.push(`interval=${group.interval || 300}`);
    if (group.tolerance) parts.push(`tolerance=${group.tolerance}`);
    if (group.type === "load-balance") {
      parts.push(`strategy=${group.strategy === "round-robin" ? "round-robin" : "pcc"}`);
    }
  }
  return surgeLine(parts);
}

function ruleToSurge(rule, providers, base, available) {
  const parts = String(rule).split(",");
  const type = parts[0];
  const noResolve = parts[parts.length - 1] === "no-resolve";
  const target = noResolve ? parts[parts.length - 2] : parts[parts.length - 1];
  if (!available.has(target)) return null;

  if (type === "MATCH") return `FINAL,${target}`;

  if (type === "RULE-SET") {
    const provider = providers[parts[1]];
    if (!provider || typeof provider.url !== "string") return null;
    const file = provider.url.split("/").pop();
    if (/^personal-[a-z0-9-]+\.list$/.test(file)) return `RULE-SET,${base}/rules/${file},${target}`;
    if (/\.mrs$/.test(file)) return `DOMAIN-SET,${base}/rules/${file.replace(/\.mrs$/, ".list")},${target}`;
    return null;
  }

  if (["DOMAIN", "DOMAIN-SUFFIX", "DOMAIN-KEYWORD", "IP-CIDR", "IP-CIDR6", "GEOIP"].includes(type)) {
    return parts.join(",");
  }

  return null;
}

export function buildSurgeConfig(config, nodes, base) {
  const nodeNames = (nodes || []).map((node) => node.name);

  const available = new Set(nodeNames);
  const proxyLines = [];
  for (const proxy of nodes || []) {
    const line = proxyToSurgeLine(proxy);
    proxyLines.push(line);
    if (!line.startsWith("#")) available.add(proxy.name);
  }

  const providers = config["rule-providers"] || {};
  const groupLines = [];
  for (const group of config["proxy-groups"] || []) {
    available.add(group.name);
  }
  for (const group of config["proxy-groups"] || []) {
    const withNodes = { ...group, _nodeNames: nodeNames };
    const line = groupToSurge(withNodes, available);
    if (line) groupLines.push(line);
  }

  const ruleLines = [];
  for (const rule of config.rules || []) {
    const line = ruleToSurge(rule, providers, base, available);
    if (line) ruleLines.push(line);
  }

  const dnsServers = (config.dns?.nameserver || [])
    .filter((server) => !String(server).startsWith("http"))
    .concat(["223.5.5.5", "119.29.29.29"]);

  const seen = new Set();
  const dns = dnsServers.filter((server) => (seen.has(server) ? false : (seen.add(server), true)));

  return [
    "[General]",
    "loglevel = notify",
    `dns-server = ${dns.join(", ")}`,
    "skip-proxy = 127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, 17.0.0.0/8, localhost, *.local",
    "exclude-simple-hostnames = true",
    "ipv6 = false",
    "",
    "[Proxy]",
    ...proxyLines,
    "",
    "[Proxy Group]",
    ...groupLines,
    "",
    "[Rule]",
    ...ruleLines,
    "",
  ].join("\n");
}
