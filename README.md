# dsh-balance

利用一条简单的 HTTP 接口，让 DSH 可以直接获取自己剩余的余额。返回的就是 **设置 → 账号与余额** 里那个 `platform.deepseek.com` 钱包（充值额度 + 赠送额度），不是 API key 余额，也不是上下文余量。

A single loopback HTTP request returns the DeepSeek Harness account balance — the same `platform.deepseek.com` wallet DSH shows under **Settings → Account** (recharge credit plus granted bonus).

## 安装

```sh
dsh plugin --profile web add github:EviMing/dsh-balance
```

装完刷新页面即可，无需重启。也可以从本地目录安装：

```sh
dsh plugin --profile web add D:\path\to\dsh-balance
```

## 用法

```sh
curl -s http://127.0.0.1:3080/api/balance
```

```json
{
  "ok": true,
  "currency": "CNY",
  "recharge": 12.416959,
  "bonus": 0,
  "total": 12.416959,
  "fetchedAt": 1794049067812
}
```

只要数字：

```sh
curl -s "http://127.0.0.1:3080/api/balance?format=text"
# 12.416959 CNY
```

字段：`recharge` 充值余额、`bonus` 赠送额度、`total` 两者之和、`fetchedAt` 本次读取时间（毫秒时间戳）。

## 行为

- **只接受 GET**，其他方法返回 `405`。
- **只允许 loopback**：检查 `req.socket.remoteAddress` 和 `Host` 头，非本机请求返回 `403`，局域网里别的机器读不到。
- **15 秒缓存 + single-flight**：同一窗口内重复请求复用上一次读取，并发请求只打一次上游。
- **不保存任何凭据**：余额通过 DSH 自己的 `deepseekAccount` 服务读取，token 仍由 DSH 放在 `~/.dsh/.credentials.yaml` 里管理，插件不碰。
- 端口跟随你的 DSH Web 地址，默认 `127.0.0.1:3080`。

## 错误码

| 状态 | `error` | 含义 |
| --- | --- | --- |
| 401 | `signed-out` | 当前 DSH 没有登录 DeepSeek 账号 |
| 403 | `forbidden` | 请求不是来自本机 |
| 405 | `method-not-allowed` | 不是 GET |
| 502 | `upstream-failed` | 平台查询失败 |
| 503 | `account-unavailable` | 宿主没有挂载 `deepseekAccount` 服务 |

错误响应统一为 `{"ok": false, "error": "...", "message": "..."}`。

## 要求

- DSH 0.2.0 及以上（使用 `webServer.register` 和 `deepseekAccount.getBalance`）。
- 已在 DSH 里登录 DeepSeek 账号。

## 文件

- `index.js` — 路由、缓存、loopback 校验、错误映射
- `cordis.patch.yml` — bundle 插入点
- `locale/` — 市场卡片的中英文标题与描述
- `icon.svg` — 市场图标

## License

MIT
