# mcloud-dav

> 🤖 **本项目是 vibe coding 的产物。** 代码主要由 AI 生成，功能可用，但未经过严格审查与充分测试，请自行评估风险后使用。

**把一堆移动云盘的分享链接，变成你自己的 WebDAV 媒体库。**
跑在 Cloudflare Workers 免费层，不需要服务器，两分钟上线。

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lastcyh/mcloud-dav)

## 它做什么

- **清洗**：把包含大量 139 分享链接的 Markdown/文本丢进 `data/`，脚本自动提取链接、去重、
  按标题层级建目录
- **服务**：Cloudflare Worker 实现 139 分享协议，对外输出**只读 WebDAV** 和 **302 直链接口**；
  播放视频时 302 直连移动云节点，流量不经过 Worker
- **零维护**：令牌自动续期、目录缓存 + 定时预热、风控自动重试

支持 Infuse / nPlayer / Kodi / rclone 等一切标准 WebDAV 客户端。

> ⚠️ **仅限个人使用。** WebDAV 地址和账号密码不要公开分享——所有访客都在消耗你的
> 139 账号额度与 Cloudflare 免费配额。防爆破是内存级轻量防护（同一 IP 连续 5 次认证失败
> 锁 15 分钟），不是企业级安全。

---

## 5 分钟上手

### 准备

- 一个 GitHub 账号，**建议先 Fork 本仓库到你自己的账号**（后续的自动清洗、文档更新都在你自己的仓库进行）
- 一个 Cloudflare 账号，[免费注册](https://dash.cloudflare.com/sign-up) 即可
- 一个移动云盘账号，能登录 [yun.139.com](https://yun.139.com) 网页版

### 第 1 步：一键部署

1. 点上面的 **Deploy to Cloudflare** 按钮（已 Fork 的话，进你 fork 仓库的 README 点按钮，或把按钮链接里的仓库地址换成你的 fork），登录并确认，Cloudflare 会自动创建 KV 存储和 Worker
2. 完成后在面板里找到 Worker 地址，形如 `https://mcloud-dav.你的子域.workers.dev`

不想用按钮，手动部署只要三条命令：

```bash
git clone https://github.com/lastcyh/mcloud-dav && cd mcloud-dav
npx wrangler kv namespace create CACHE   # 把返回的 id 填进 wrangler.toml
npx wrangler deploy
```

### 第 2 步：配置向导

打开 Worker 地址会自动进入配置页，需要填一个 **139 Authorization**，抓取方法：

1. 浏览器登录 [yun.139.com](https://yun.139.com)
2. 按 `F12` 打开开发者工具，切到 **网络** 标签
3. 刷新页面，在过滤框输入 `hcy/file/list`，随便点一条请求
4. 在请求标头里找到 `Authorization`，复制它的值——一长串 base64 编码的令牌
5. 粘贴进配置页，手机号会自动识别，再设置 WebDAV 的用户名密码，保存

令牌有效期约 30 天。Worker 每小时检查一次，剩余不足 15 天会自动调用官方刷新接口续期，
平时完全不用管，只有令牌彻底失效才需要重新抓一次。

### 第 3 步：添加分享

**方式 A：网页粘贴，适合少量**

访问 `/admin` 并用在配置向导里设置的账号密码登录，每行一条粘贴：

```
分类/标题 | 分享链接
```

路径和名字完全由你决定，例如：

```
电影/某电影 | https://yun.139.com/shareweb/#/w/i/xxxxxxxx
剧集/某剧 第一季 | https://caiyun.139.com/m/i?yyyyyyyy
纪录片/某系列 | id1,id2#提取码,id3
```

第三行演示了一个目录绑定多条分享。分享 ID 就是链接里 `/w/i/` 或 `/share/` 后面那一段，
带提取码写成 `ID#提取码`，保存即生效。

**方式 B：批量清洗，适合大量**

把包含分享链接的 Markdown/文本放进仓库的 `data/` 目录，格式参考
[示例合集](data/示例合集.md)，然后：

- 本地执行：`python clean_links.py` 生成 `catalog.json`，
  再 `python upload_catalog.py --url <Worker地址> --user <账号> --pass <密码>` 上传，或者
- 用 GitHub Actions 自动化，见下一节

脚本会自动提取全部链接、去掉画质集数等噪音、按分享 ID 去重，并按文档里的标题层级生成目录树。

### 第 4 步：挂载播放

**rclone：**

```
rclone config
# 类型: webdav | url: https://mcloud-dav.你的子域.workers.dev | 厂商: other | 账号密码: 第 2 步设置的
rclone ls :webdav:
```

**Infuse / nPlayer / Kodi：** 添加共享 → WebDAV → 填地址和账号密码即可。
账号密码就是配置向导里设置的，忘了打开 `/admin` 首屏就能看到。
文件列表按自然排序，`第2集` 排在 `第10集` 前面；分享根目录的套壳文件夹会自动下沉，直接看到视频文件。

**直链接口：** 给下载工具或脚本用，302 跳转到移动云直链，支持 `&format=json` 拿 JSON：

```
GET https://mcloud-dav.你的子域.workers.dev/link?path=电影/某电影/某电影.mp4
```

---

## 自动清洗（GitHub Actions，可选）

在你 Fork 的仓库里：

1. 把链接文档放进 `data/` 并 commit
2. 打开 **Settings → Secrets and variables → Actions**，添加三个 Secret：

| Secret | 值 |
|---|---|
| `WORKER_URL` | 你的 Worker 地址，用 `*.workers.dev` 域名 |
| `DAV_USER` / `DAV_PASS` | 配置向导里设置的 WebDAV 账号密码 |

3. 完成。Actions 每天自动清洗 `data/` 并推送目录树到 Worker，文档更新了重新放一份进去即可。

---

## 目录规则

```
/<标题层级>/
└── <标题>/
    └── 第01集.mp4 …
```

文档里的标题行就是目录层级；同一行写多个链接即可把多条分享绑到同一个挂载。
目录列表按自然排序，`第2集` 在 `第10集` 前；分享根目录的套壳文件夹自动穿透，最多三层。

---

## 接口一览

| 路由 | 说明 |
|---|---|
| `GET /health` | 状态，是否已配置 |
| `GET /link?path=<路径>&format=json` | 302 直链，`format=json` 返回 JSON，需认证 |
| `POST /setup` | 初始配置 / 修改配置，已配置时需认证 |
| `GET /admin` | 网页管理端，需认证 |
| `POST /admin/catalog-lines` | 按行覆盖目录树，需认证 |
| `POST /admin/catalog` | 直接上传 catalog.json，需认证 |
| `GET /probe?link=<分享ID>` | 单个分享连通性探测，需认证 |

WebDAV 就是站点根路径，任意客户端挂载即可；只读，不支持上传。

---

## 常见问题

**workers.dev 打不开？** 境内对 `*.workers.dev` 有干扰。在 Cloudflare 面板给 Worker 绑一个自定义域，或客户端走代理。

**打开目录要等 1-3 秒？** 该目录首次访问需要实时调 139 接口，之后 7 天内都是秒开，过期也会先返回旧数据再后台刷新。另有定时预热任务滚动补缓存。目录里文件特别多时首次会久一点——每 200 项要多调一次接口。

**会撑爆 KV 免费额度吗？** 不会。缓存写入只在首次访问和浏览触发的刷新时发生，预热任务只补缺、从不主动刷新，另有每日调用上限保护账号。

**9530 错误？** 139 对部分数据中心 IP 的风控，Worker 已自动换出口重试，无需处理。

**直链多久过期？** 15 分钟，这是移动云 EOS 的 S3 预签名。不绑 IP，签名只含主机和时间。

**能上传或转存吗？** 不能，这是一个只读媒体库。

**有防爆破吗？** 有，同一 IP 连续 5 次认证失败锁定 15 分钟（内存级轻量防护，跨节点不共享）。
配合强密码与"不公开分发"使用。

---

## 更新教程

更新只替换 Worker 代码，不影响已有配置：139 令牌与 WebDAV 账号密码保存在 KV 中，与代码相互独立。

### 命令行部署

```bash
cd mcloud-dav
git pull
npx wrangler deploy
```

### Deploy to Cloudflare 按钮部署

1. 在 fork 仓库执行 **Sync fork**，同步上游最新代码（未 fork 可跳过此步）
2. 进入 Cloudflare 面板 → **Workers & Pages** → 选择对应的 Worker → **重新部署**（或再次点击 README 顶部的 Deploy 按钮）

更新后无需手动清理缓存，旧缓存会自动失效。

---

## 已知限制

- 一个目录最多显示 **2 万** 项。
- 免费版有请求次数上限，单个目录里文件特别多（近万个）时可能报错。
- 新加的文件，最长 **30 分钟**后才会出现在列表里（有缓存）。
- 只读，不能上传、删除或转存。

---

## 更新日志

### 2026-10-08

- 修复：目录里文件多的时候，只显示前 100 个。
- 修复：新加的文件刷新很慢。原来最长要等 **7 天**（缓存过期才会更新），现在最长 **30 分钟**。
- 修复：查看单个文件时，文件大小显示为 0。
- 修复：同一个目录里，同名的文件和文件夹会互相挤掉。
- 修复：自动清洗一直跑不通——`upload_catalog.py` 缺失，现已补上；同时补上 Worker 的定时预热配置。
- 修复：自动清洗可能拿示例数据覆盖你的真实目录，现在示例文件里的演示链接会被忽略，`data/` 没有有效链接时也不会生成 catalog。
- 修复：WebDAV 密码里含 `:` 时登录不上。
- 修复：管理页改配置时密码留空会报错（界面写的是"留空 = 不修改"）。
- 修复：完整链接后面跟 `#提取码` 会被丢掉。
- 修复：批量清洗其实没去掉「4K / 全12集」这类噪音。
- 修复：目录缓存的时间单位写错了（60 秒被当成 60 毫秒、30 分钟被当成 1.8 秒），目录几乎一直在后台重复刷新、白耗接口配额。
- 修复：在配置页粘贴新令牌后仍在使用旧令牌。
- 修复：多分享绑一个目录时，进到第二层子目录会读错分享。
- 修复：防爆破锁定时间算错（本该 15 分钟，实际约 10 分钟就放开了）。
- 修复：WebDAV 账号密码含中文时登录不上。
- 修复：同一目录里文件与文件夹重名时，那个文件永远打不开。
- 修复：`/w/#/share/` 形式的分享链接会被解析成乱码。
- 修复：目录数据不合法时会被原样保存、之后一访问就报错；现在保存前就校验。
- 修复：批量清洗的跳级标题层级错乱、同一行多个链接的提取码会串。
- 优化：预热任务改成真正的调用上限（之前单个大目录能打上百次接口）。
- 优化：减少对 139 的重复调用。

---

## 致谢与声明

139 分享协议整理自 [OpenList](https://github.com/OpenListTeam/OpenList) 的 `139Yun` 驱动，感谢社区的逆向工作。

本项目不存储任何音视频文件，仅整理用户自己的分享链接并做直链跳转。请遵守当地法律法规，
勿用于商业用途，详见 [DISCLAIMER.md](DISCLAIMER.md)。 · License: [MIT](LICENSE)
