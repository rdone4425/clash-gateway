> 公开仓库，`wrangler.jsonc` 里不含真实 token。部署前用 `npx wrangler secret put ACCESS_TOKEN` 和 `npx wrangler secret put SUBSCRIPTION_URL` 写入 secret，不要把真实值提交上来。

# Clash Gateway

一个 Cloudflare Worker：从 GitHub Pages 拉取 Clash 配置模板，把 `proxy-providers` 指向自己，再解析机场订阅提供节点。

- 配置模板在 [`rdone4425/clash-configs`](https://github.com/rdone4425/clash-configs) 维护，改完 push 就生效
- 节点只在 Worker 内存和边缘缓存里，不写入 GitHub
- 订阅地址保存在 Worker secret / KV，不出现在前端或仓库

## 架构

```
Clash → /sub?token=...       → 拉 GitHub 模板 → 重写 provider URL → 返回配置
Clash → /provider?token=...  → 拉机场订阅 → 解析节点 → 返回 proxies
```

## 部署

要求：Cloudflare 账号、Node 20+。

```bash
npm install
npx wrangler login
npm run deploy
```

## 配置

必须设置两个 secret：

```bash
npx wrangler secret put ACCESS_TOKEN
npx wrangler secret put SUBSCRIPTION_URL
```

- `ACCESS_TOKEN`：调用 `/sub` 和 `/provider` 的令牌，自己生成一串随机字符
- `SUBSCRIPTION_URL`：机场订阅地址

可选变量在 `wrangler.jsonc`：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CONFIG_URL` | GitHub 上的 `clash-remote.yaml` | 配置模板地址 |
| `CACHE_TTL` | `300` | `/provider` 缓存秒数 |
| `PROVIDER_INTERVAL` | `3600` | Clash 拉节点的间隔 |
| `SUBSCRIPTION_UA` | `v2rayN/6.42` | 拉订阅时的 UA |

## 使用

1. 打开 `https://clash-gateway.rdone.workers.dev/`
2. 填 `ACCESS_TOKEN`、GitHub 配置链接、机场订阅链接，点「保存」
3. 把页面给出的 `/sub?token=...` 填进 Clash

配置和订阅都存在 Worker 的 KV（`settings:global`），不写入 GitHub。改了 GitHub 上的分组或规则，Clash 下次刷新订阅就会用新版本（`profile-update-interval: 1`）。

如果 KV 里没有设置，`/sub` 会回退到 `CONFIG_URL`，`/provider` 会回退到 `SUBSCRIPTION_URL` secret。

## 接口

| 路径 | 说明 |
| --- | --- |
| `/` | 说明页 |
| `/health` | 健康检查 |
| `/api/profiles` | `POST {"url":"https://...","config":"https://...yaml"}`，带 token；`config` 可选，默认用 `CONFIG_URL` |
| `/api/profiles/<id>` | `DELETE`，带 token，删除订阅 |
| `/s/<id>` | 完整配置（节点走 `/provider/<id>`，规则走远程 mrs） |
| `/provider/<id>` | 节点列表（proxy-provider） |
| `/sub?token=` | 固定订阅模式的完整配置 |
| `/provider?token=` | 固定订阅模式的节点列表 |

也支持 `Authorization: Bearer <token>`。

## KV

`/api/profiles` 生成的订阅存在 KV 命名空间 `PROFILES`（binding 已在 `wrangler.jsonc` 中配置），只保存订阅地址和创建时间，不保存解析后的节点。

`/provider/<id>` 不需要 token，id 本身就是凭证（32 位十六进制），不要公开。

## 注意

- `/provider` 返回节点凭据，不要把带 token 的地址公开。
- 改了 GitHub 模板后，下一次 `/sub` 请求就会使用新内容。
- 解析器支持 vmess / vless / trojan / ss / ssr / hysteria2 / tuic / socks5 / http；订阅可以是 Base64、明文链接或 Clash YAML。
