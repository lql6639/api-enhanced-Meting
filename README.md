# meting-api-enhanced

**完全兼容 meting 协议的网易云音乐 API** — 基于 [api-enhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced)，新增 meting 兼容端点、VIP 解锁、自动解灰、调用统计等增强功能。

[![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-green?style=flat-square&logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org)
[![MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](./LICENSE)

---

## 核心能力对比

| 功能 | 原 api-enhanced | 本项目 |
|------|---------------|--------|
| meting 兼容端点 `/meting` | ❌ 无 | ✅ 完全兼容 |
| VIP Cookie 全链路透传 | ❌ 无 | ✅ 支持 |
| 灰色歌曲自动解灰（酷我/咪咕/QQ） | ❌ 无 | ✅ 支持 |
| 调用统计（总/今日） | ❌ 无 | ✅ api + meting 双统计 |
| 听歌打卡（明文 + NCBL 加密） | ✅ 有 | ✅ 有 |
| ~400 个原生 API 端点 | ✅ 有 | ✅ 有（原封不动） |

---

## 快速开始

### 环境要求

- **Node.js 18+**
- 推荐 **pnpm**

### 安装

```bash
git clone https://github.com/qijie233/meting-api-enhanced.git
cd meting-api-enhanced
pnpm install
```

### 启动

```bash
# 默认端口 3000
node app.js

# 自定义端口（Linux/macOS）
PORT=4000 node app.js

# Windows PowerShell
$env:PORT=4000; node app.js
```

服务启动后访问：

| 页面 | 地址 |
|------|------|
| API 服务首页 | http://localhost:3000/ |
| **meting 文档页** | http://localhost:3000/meting.html |
| 听歌打卡示例 | http://localhost:3000/scrobble.html |

---

## meting 兼容端点 `/meting`

完全兼容 [injahow/meting-api](https://github.com/injahow/meting-api) 协议，APlayer / MetingJS 可直接对接，无需修改任何前端代码。

### 在线测试示例

```
http://localhost:3000/meting/?type=url&id=33894312
http://localhost:3000/meting/?type=url&id=416892104&br=2000      ← FLAC 无损
http://localhost:3000/meting/?type=pic&id=33894312&cover=500
http://localhost:3000/meting/?type=lrc&id=33894312              ← 含中文翻译合并
http://localhost:3000/meting/?type=song&id=33894312
http://localhost:3000/meting/?type=playlist&id=2619366284
http://localhost:3000/meting/?type=search&id=Adele&limit=5
```

### 参数说明

| 参数 | 说明 | 默认值 |
|------|--------|--------|
| `type` | `name` · `artist` · `url` · `pic` · `lrc` · `song` · `playlist` · `search` | **必填** |
| `id` | 歌曲/歌单 ID；`type=search` 时为搜索关键词 | **必填** |
| `server` | 数据源（`netease` · `tencent` · `xiami` · `kugou` · `baidu` · `kuwo`） | `netease`（其他静默忽略） |
| `br` | 音质（仅 `type=url`）：`320` / `192` / `128` / `2000`(flac) | `320` |
| `cover` | 封面分辨率（仅 `type=pic`） | `300` |
| `limit` | `type=search` 返回条数；`type=playlist` 返回歌曲数（不传=整张歌单） | `search:30` / `playlist:不限` |
| `offset` | `type=playlist` 起始偏移（配合 `limit` 做分页） | `0` |
| `page` | 搜索页码（`type=search`） | `1` |
| `search_type` | 平台搜索类型（`type=search`） | `1`（单曲） |

> `type=playlist` 不传 `limit` 时会按整张歌单逐首拉 `detail + url + lyric`（并发 8），
> 上千首的歌单容易超时并触发网易云风控。公网部署建议客户端显式分页：
> `?type=playlist&id=xxx&limit=100&offset=0`。

### APlayer / MetingJS 集成

```html
<script>
  window.meting_api = 'http://你的域名:3000/meting/?server=:server&type=:type&id=:id&auth=:auth&r=:r'
</script>
<script src="https://cdn.jsdelivr.net/npm/meting@2/dist/Meting.min.js"></script>

<meting-js server="netease" type="playlist" id="2619366284"></meting-js>
```

---

## 灰色歌曲自动解灰

歌曲因版权或 VIP 限制无法直接获取时，底层自动调用 `matchID` 走替代音源（酷我、咪咕、QQ 等），**无需任何额外配置**：

```bash
# 自动 302 重定向到可播放的替代音源 URL
curl -I "http://localhost:3000/meting/?type=url&id=灰色歌曲ID"
```

---

## VIP 解锁（原生端点）

所有 ~400 个原生 API 端点均支持 VIP Cookie 透传：

```bash
curl -H "Cookie: MUSIC_U=你的token" \
  "http://localhost:3000/song/url/v1?id=1385117201&level=lossless"
```

---

## 调用统计

实时暴露 `GET /stats` 端点，文档页和首页底部每 10 秒自动刷新：

```json
{
  "api":   { "total_calls": 1234, "today_calls": 56 },
  "meting": { "total_calls": 789,  "today_calls": 34 }
}
```

- **api**：全部 API 请求（不含 `/stats` 自身）
- **meting**：所有带 `type`+`id` 的 `/meting` 请求（不含文档页跳转）
- 跨日自动重置 `today_calls`
- 计数在内存累加，每 10 秒批量落盘一次（进程退出前会补写）；因此 `/stats` 读到的是**含未落盘增量的实时值**
- 只读文件系统（Vercel 等 serverless）上会自动降级为「仅内存计数」，不影响接口响应；多实例部署各自计数，需要精确统计请改用 Redis

---

## Docker 部署

```bash
docker build -t ncm-api .
docker run -d -p 3000:3000 --env-file .env --name ncm-api ncm-api
```

> 镜像默认端口 3000；需要换端口时加 `-e PORT=xxxx` 覆盖（注意同时调整 `-p` 映射）。
> 配置通过 `--env-file` 或 `-e` 注入，**不要**把 `.env` 打进镜像。

---

## 公开模式（PUBLIC_MODE）

默认开启，行为分两层，**不要假设默认会封锁端点**：

1. **默认（什么都不配）**：所有端点都能通过 HTTP 访问。唯一的硬保护是 `/login*` 路由不回落 `NETEASE_COOKIE` —— 调用方自带 cookie 正常工作，无 cookie 时用匿名 token，避免把配置的 `MUSIC_U` 写进陌生人拿到的响应体。
2. **可选封锁**：设置 `PUBLIC_BLOCK_PREFIXES`（逗号分隔前缀，自动补 `/`），命中的路由返回 `404`，与未知路由表现一致。前缀按「整段」匹配，`cloud` 不会误伤 `/cloudsearch`。

公网只对外提供只读音乐接口时，建议直接启用推荐清单：

```bash
PUBLIC_BLOCK_PREFIXES=login,register,activate,captcha,sms,verify,user,cloud,voice,daily_signin,personal_fm,scrobble,msg,event,feed,block,inner,log,clientlog,manhole
```

`/meting` 内部通过 `require()` 直调模块函数（不走 HTTP 路由），因此封锁这些端点**不影响** `/meting` 的 `url`/`pic`/`lrc`/`song`/`playlist`/`search` 任何功能。

自用（需要全部端点且不暴露公网）时设置 `PUBLIC_MODE=false` 关闭公开模式。

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `3000` | 服务端口 |
| `CORS_ALLOW_ORIGIN` | `*` | 允许跨域请求的域名 |
| `ENABLE_PROXY` | `false` | 是否启用反向代理 |
| `PROXY_URL` | — | 代理服务地址（启用代理时） |
| `ENABLE_RANDOM_CN_IP` | `false` | 是否默认启用随机中国 IP |
| `ENABLE_GENERAL_UNBLOCK` | `false` | 是否启用全局自动解灰（不走 `/meting` 内部的按需解灰） |
| `ENABLE_FLAC` | `true` | 是否启用无损音质 |
| `NETEASE_COOKIE` | — | 默认网易云 Cookie（详见下节） |
| `BASE_URL` | — | 项目完整域名（如 `https://your-domain.com`），用于生成绝对 URL；留空则自动从请求 headers 识别 |
| `DEBUG_COOKIE` | — | 设为 `1` 打印 cookie 解析/对象→字符串日志 |
| `DEBUG_URL` | — | 设为 `1` 打印 NCM `song/enhance/player/url` 请求与响应日志 |
| `DEBUG_METING` | — | 设为 `1` 打印 `/meting` 端点内部流向日志 |
| `PUBLIC_MODE` | `true` | 公开模式：默认放行端点 + `/login*` 不回落 `NETEASE_COOKIE`。自用设 `false` |
| `PUBLIC_BLOCK_PREFIXES` | — | 公开模式下要封锁的路径前缀，逗号分隔（详见「公开模式」） |
| `TRUST_PROXY` | `true` | 是否信任 `X-Forwarded-*`（反向代理后保持默认；直连部署设 `false`） |

完整配置示例见 `.env.prod.example`。

### 域名配置（BASE_URL）

meting 端点返回的 URL（`type=song/playlist/search`）支持自动识别部署域名：

- **自动识别**（默认）：从请求 headers 中的 `Host` 和 `X-Forwarded-Proto` 自动获取域名，支持反向代理场景
- **手动设置**：在 `.env` 中配置 `BASE_URL=https://your-domain.com`，强制使用指定域名

```bash
# 自动识别（推荐，支持反向代理）
# 无需配置，自动从请求中获取

# 手动设置域名
BASE_URL=https://music.example.com
```

返回示例：

```json
[
  {
    "name": "歌曲名",
    "artist": "歌手",
    "url": "https://music.example.com/meting/?type=url&server=netease&id=123456&br=320",
    "pic": "https://music.example.com/meting/?type=pic&server=netease&id=123456&cover=300",
    "lrc": "https://music.example.com/meting/?type=lrc&server=netease&id=123456"
  }
]
```

### Cookie 配置（解锁 VIP 歌曲）

本 API 支持通过 `MUSIC_U` cookie 解锁 VIP / 付费歌曲。Cookie 优先级如下：

1. **请求方主动传递**：浏览器/调用方在 `Cookie` 请求头里带 `MUSIC_U=...`（APlayer/MetingJS 透传用户的网易云登录态）
2. **服务端 `.env` 兜底**：当请求方**未携带** cookie 时（典型场景：`curl`、自建脚本、APlayer 未登录用户），服务会用 `NETEASE_COOKIE` 环境变量作为默认账号解锁 VIP

> 💡 **简言之**：要让 API **默认对所有调用方**解锁 VIP，必须把 MUSIC_U 填进 `.env`；只填 MUSIC_U 给浏览器是不够的。

#### 方式一：直接配置 .env（推荐）

**Cookie 填写在 `.env` 文件中**（已被 `.gitignore` 忽略，不会推送到 GitHub）：

```bash
# .env 文件
NETEASE_COOKIE=MUSIC_U=你的MUSIC_U值
```

#### 方式二：nginx 反代注入

如果使用 nginx 做反代，可以在 nginx 配置中注入 cookie：

```nginx
location /meting/ {
    proxy_pass http://localhost:3000/meting/;
    proxy_set_header Cookie "MUSIC_U=你的真实token";
}
```

#### 获取 MUSIC_U

1. 登录 [网易云音乐](https://music.163.com)
2. 按 F12 打开开发者工具 → **Network（网络）** 标签
3. 任意点击一首歌进行播放
4. 在 Network 中找到任意请求，查看 **Request Headers** 或 **Cookies**
5. 找到键为 `MUSIC_U` 的值，复制完整内容

#### 示例

**方式一（.env）**：

```bash
# .env
PORT=3000
NETEASE_COOKIE=MUSIC_U=0073E89B4A1E556FBC730726251369415B7C2FDE26A5018F404B9A9AE45197B7D7E62D839893BF451E44AEDB418B3561A77F16544C001058C58384ED643DA78AA0F5F4530FF252CEE8AD5FF19637BE2257E4B047FD5777E077BD9F2C6B762B7097516B66F98B93AAE07740A0748B77B81343DAF44084CDE7451E76FA3974174CACA35E4117A5606D7AB0B89ED28D1C9F394926CAD5423D807A35CA0CF439F3D212AE5F3CF6B214D2285A2F9F87CA6E7B597E9556F3DF8566698D4E8F5D952B51BE4EF4F070E7E2117E59164C7BE121DA62CC239D17F37057B4E5BE23E82A7116DDD9E1699DC8DE987BB2A8923777BFF0AAAB32BD54BF5DA61C8C1D2C69315FC2254495AA5C54D02CB114328B01202921C3458966EBEB12FDCA5252BA500D46835B44CBEE3D7657B59A9F579BFD283E5FF97E2BD6DABE5A5E27EC3DF0D4834D28D2C5B688A73D2B009899AC1682B05895715F4B41AE61629E0A012D9364E23C3BECA8CEF2867340BFCB6B729116B4F5BB9F4A6232EEFB2824854599FC850C7E8499C4E0E1561AB1D0E2104177A446ACCFE5
```

**方式二（nginx）**：

```nginx
location /meting/ {
    proxy_pass http://localhost:3000/meting/;
    proxy_set_header Cookie "MUSIC_U=0073E89B4A1E556FBC730726251369415B7C2FDE26A5018F404B9A9AE45197B7D7E62D839893BF451E44AEDB418B3561A77F16544C001058C58384ED643DA78AA0F5F4530FF252CEE8AD5FF19637BE2257E4B047FD5777E077BD9F2C6B762B7097516B66F98B93AAE07740A0748B77B81343DAF44084CDE7451E76FA3974174CACA35E4117A5606D7AB0B89ED28D1C9F394926CAD5423D807A35CA0CF439F3D212AE5F3CF6B214D2285A2F9F87CA6E7B597E9556F3DF8566698D4E8F5D952B51BE4EF4F070E7E2117E59164C7BE121DA62CC239D17F37057B4E5BE23E82A7116DDD9E1699DC8DE987BB2A8923777BFF0AAAB32BD54BF5DA61C8C1D2C69315FC2254495AA5C54D02CB114328B01202921C3458966EBEB12FDCA5252BA500D46835B44CBEE3D7657B59A9F579BFD283E5FF97E2BD6DABE5A5E27EC3DF0D4834D28D2C5B688A73D2B009899AC1682B05895715F4B41AE61629E0A012D9364E23C3BECA8CEF2867340BFCB6B729116B4F5BB9F4A6232EEFB2824854599FC850C7E8499C4E0E1561AB1D0E2104177A446ACCFE5";
}
```

#### 提示

- `MUSIC_U` 是登录凭证，**请勿泄露给他人**
- `.env` 文件不会推送到 GitHub（已在 `.gitignore` 中）
- 如无 cookie，VIP 歌曲可能无法播放，但普通歌曲不受影响

---

## 单元测试

```bash
pnpm test
```

---

## 项目结构

```
module/
  meting.js          # meting 兼容端点（/meting）
  stats.js            # 调用统计端点（/stats）
  scrobble.js        # 听歌打卡明文版）
  scrobble_v1.js     # 听歌打卡 NCBL 加密版）
util/
  meting.js          # LRC 合并 / URL 构建 / 并发限流
  stats.js           # 同步原子计数器
  ncbl.js            # NCBL 加密工具
public/
  index.html         # API 服务首页（含 meting 区块 + 统计卡片）
  meting.html        # meting 文档页（含全部测试链接）
  scrobble.html       # 听歌打卡示例
  qrlogin-nocookie.html  # 无 cookie QR 登录
server.js             # Express 服务器（路由 / 中间件 / 自动加载）
main.js               # npm SDK 入口
app.js               # CLI 启动入口
```

---

## 主要功能特性

- 登录/注册/验证码
- 用户信息、歌单、动态、播放记录
- 歌曲、专辑、歌手、MV、歌词、评论、排行榜
- 搜索、推荐、私人 FM、签到、云盘
- **歌曲解锁（解灰）**：自动走替代音源
- **听歌打卡**：`/scrobble`（明文）、`/scrobble/v1`（NCBL 加密）

---

## 致谢

- 原作者 [Binaryify/NeteaseCloudMusicApi](https://github.com/binaryify/NeteaseCloudMusicApi) 为本项目基础
- [MoeFurina/NeteaseCloudMusicApiEnhanced](https://github.com/neteasecloudmusicapienhanced/api-enhanced) 提供持续维护与增强
- [metowolf/Meting](https://github.com/metowolf/Meting) 提供 meting 协议参考
- [injahow/meting-api](https://github.com/injahow/meting-api) 提供 meting 协议实现参考

---

## License

[MIT](./LICENSE)
