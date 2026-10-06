// cloud139 — 移动云盘分享 → WebDAV + 直链 (Cloudflare Worker)
//
// 目录树由 catalog.json 驱动（clean_links.py 或 /admin 网页生成, 经 /admin/catalog 写入 KV）:
//   { "generated": "...", "mounts": { "分类/标题": { "id": "id1#pwd1,id2" } } }
//
// 路由:
//   PROPFIND/GET/HEAD/OPTIONS /**   WebDAV 只读（Basic 认证）
//   GET /link?path=/电视剧/.../x.mp4  302 直链（支持 &format=json）
//   GET /health                     状态
//   GET /tree                       目录树摘要（认证）
//   POST /admin/catalog             上传 catalog（认证）
//   GET /probe?link=id#pwd          分享探测（认证）
//
// 环境: AUTH(139 Authorization) ACCOUNT DAV_USER DAV_PASS [CATALOG_URL] CACHE(KV)

const AES_KEY = new TextEncoder().encode("PVGDwmcvfs1uV3d1");
const API = {
  LIST: "https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/getOutLinkInfoV6",
  DL: "https://share-kd-njs.yun.139.com/yun-share/richlifeApp/devapp/IOutLink/dlFromOutLinkV3",
  REFRESH: "https://aas.caiyun.feixin.10086.cn/tellin/authTokenRefresh.do",
};
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  "Accept": "application/json, text/plain, */*",
  "Content-Type": "application/json;charset=UTF-8",
  "X-Deviceinfo": "||9|12.27.0|firefox|140.0|||linux unknown|1920X526|zh-CN|||",
  "hcy-cool-flag": "1",
  "CMS-DEVICE": "default",
  "x-m4c-caller": "PC",
  "X-Yun-Api-Version": "v1",
  "Origin": "https://yun.139.com",
  "Referer": "https://yun.139.com/",
};
const DIR_FRESH = 1800;      // 目录新鲜期 30 分钟, 过期后先返回旧数据再后台刷新 (SWR)
const DIR_STORE = 7 * 86400; // 目录缓存保留 7 天 (KV TTL)
const DL_TTL = 600;          // 直链缓存 10 分钟（S3 预签名 15 分钟有效）
const BF_MAX = 5;            // 连续失败 N 次锁定
const BF_WINDOW = 600e3;     // 失败计数窗口 10 分钟
const BF_LOCK_TTL = 900e3;   // 锁定 15 分钟(内存级, 个人使用的轻量防护)
const CAT_TTL = 600;         // catalog 内存缓存 10 分钟
const WARM_BATCH = 40;       // 每次定时预热处理的挂载数(只补缺, 已缓存的零成本跳过)
const WARM_CALL_BUDGET = 25; // 预热时 139 API 调用预算(免费版单次请求 50 子请求上限)
const WARM_DAILY_CAP = 2000; // 每日预热调用上限(保护账号, 避免触发风控)

const MIME = {
  mp4: "video/mp4", m4v: "video/mp4", mkv: "video/x-matroska", ts: "video/mp2t",
  mov: "video/quicktime", avi: "video/x-msvideo", wmv: "video/x-ms-wmv", flv: "video/x-flv",
  iso: "application/octet-stream", mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav",
  pdf: "application/pdf", epub: "application/epub+zip", zip: "application/zip",
  rar: "application/vnd.rar", tar: "application/x-tar", gz: "application/gzip",
  srt: "text/plain", ass: "text/plain", ssa: "text/plain", txt: "text/plain", nfo: "text/plain",
};

// ================= 139 协议 =================

function sortedJson(o) {
  if (Array.isArray(o)) return "[" + o.map(sortedJson).join(",") + "]";
  if (o !== null && typeof o === "object") {
    return "{" + Object.keys(o).sort().map(k => JSON.stringify(k) + ":" + sortedJson(o[k])).join(",") + "}";
  }
  return JSON.stringify(o);
}

async function encryptPayload(obj) {
  const plain = new TextEncoder().encode(sortedJson(obj));
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", AES_KEY, "AES-CBC", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, key, plain));
  const out = new Uint8Array(16 + ct.length);
  out.set(iv); out.set(ct, 16);
  let bin = "";
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function decryptPayload(text) {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const raw = Uint8Array.from(atob(t), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", AES_KEY, "AES-CBC", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-CBC", iv: raw.slice(0, 16) }, key, raw.slice(16));
  return JSON.parse(new TextDecoder().decode(pt));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 运行配置: KV "config" (由 /setup 向导写入) 优先, env 变量兜底 ----
async function getConfig(env) {
  if (globalThis.__cfg && Date.now() - globalThis.__cfg.ts < 60000) return globalThis.__cfg.v;
  let v = {};
  try {
    const kv = await env.CACHE.get("config");
    if (kv) v = JSON.parse(kv) || {};
  } catch {}
  v.account = v.account || env.ACCOUNT || "";
  v.auth = v.auth || env.AUTH || "";
  v.dav_user = v.dav_user || env.DAV_USER || "";
  v.dav_pass = v.dav_pass || env.DAV_PASS || "";
  globalThis.__cfg = { v, ts: Date.now() };
  return v;
}
async function isConfigured(env) {
  const c = await getConfig(env);
  return !!(c.auth && c.account && c.dav_user && c.dav_pass);
}

function parseMembers(leaf) {
  return String(leaf.id || "").split(/[,，;；\n]+/).map(s => s.trim()).filter(Boolean).map(s => {
    const i = s.indexOf("#");
    return i >= 0 ? { id: s.slice(0, i), pwd: s.slice(i + 1) } : { id: s, pwd: "" };
  });
}

class Err139 extends Error {
  constructor(rc, desc) { super(`139 接口错误 ${rc}: ${desc || ""}`); this.rc = rc; }
}

async function call139(env, url, body) {
  // 9530 = 个别出口 IP 被 139 风控, 换个出口重试即可; 其他错误码直接抛
  globalThis.__callCount = (globalThis.__callCount || 0) + 1;
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { ...HEADERS, Authorization: "Basic " + (await getAuth(env)) },
        body: await encryptPayload(body),
      });
      const b = await decryptPayload(await r.text());
      const rc = String(b?.resultCode ?? b?.code ?? "");
      if (rc === "0") return b;
      last = { rc, desc: b?.desc || b?.message || "" };
      if (rc !== "9530") break;
    } catch (e) {
      last = { rc: "ERR", desc: String(e).slice(0, 200) };
    }
    await sleep(400 * (i + 1));
  }
  throw new Err139(last?.rc ?? "?", last?.desc);
}

// ---------- token 自动续期 ----------

function authRemainMs(auth) {
  try {
    const dec = atob(auth);
    const tok = dec.split(":")[2] || "";
    const exp = Number(tok.split("|")[3]);
    return Number.isFinite(exp) ? exp - Date.now() : Infinity;
  } catch { return Infinity; }
}

async function getAuth(env) {
  const kvAuth = await env.CACHE.get("auth");
  const auth = kvAuth || (await getConfig(env)).auth;
  const now = Date.now();
  const lastCheck = Number((await env.CACHE.get("auth_check")) || 0);
  if (now - lastCheck < 3600e3) return auth;            // 每小时检查一次
  await env.CACHE.put("auth_check", String(now));
  const remain = authRemainMs(auth);
  if (remain > 15 * 86400e3 || remain <= 0) return auth; // 剩余>15天才续, 过期了续不了
  try {
    const dec = atob(auth);
    const account = dec.split(":")[1];
    const tok = dec.split(":")[2];
    const r = await fetch(API.REFRESH, {
      method: "POST",
      headers: { "Content-Type": "application/xml" },
      body: `<root><token>${tok}</token><account>${account}</account><clienttype>656</clienttype></root>`,
    });
    const xml = await r.text();
    const ret = (xml.match(/<return>([^<]*)<\/return>/i) || [])[1];
    const newTok = (xml.match(/<token>([^<]*)<\/token>/i) || [])[1];
    if (ret === "0" && newTok) {
      const newAuth = btoa(`pc:${account}:${newTok}`);
      await env.CACHE.put("auth", newAuth);
      console.log("139 token 已自动续期");
    }
  } catch (e) {
    console.log("token 刷新失败(继续用旧token):", String(e).slice(0, 100));
  }
  return (await env.CACHE.get("auth")) || auth;
}

// ================= catalog 与目录树 =================

async function getCatalog(env) {
  const now = Date.now();
  if (globalThis.__cat && now - globalThis.__cat.ts < CAT_TTL) return globalThis.__cat.data;
  let data = null;
  try {
    const kv = await env.CACHE.get("catalog");
    if (kv) data = JSON.parse(kv);
  } catch {}
  if (!data && env.CATALOG_URL) {
    const r = await fetch(env.CATALOG_URL, { cf: { cacheTtl: 60 } });
    if (r.ok) data = await r.json();
  }
  if (!data || !data.mounts) throw new Error("catalog 不可用: 请先 POST /admin/catalog 或配置 CATALOG_URL");
  globalThis.__cat = { data, ts: now };
  return data;
}

function buildTree(catalog) {
  const root = { children: new Map() };
  for (const [path, leaf] of Object.entries(catalog.mounts)) {
    const segs = path.split("/").filter(Boolean);
    let node = root;
    for (let i = 0; i < segs.length; i++) {
      const name = segs[i];
      if (!node.children.has(name)) node.children.set(name, { children: new Map(), name });
      node = node.children.get(name);
      if (i === segs.length - 1) node.leaf = leaf;
    }
  }
  return root;
}

// ================= 列目录（带缓存） =================

function parseMtime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s || "");
  if (!m) return 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]); // 北京时间
}

function normListing(body) {
  const d = body?.data || {};
  return {
    folders: (d.caLst || []).map(f => ({ kind: "dir", id: f.caID, name: f.caName, mtime: parseMtime(f.udTime) })),
    files: (d.coLst || []).map(f => ({ kind: "file", id: f.coID, name: f.coName, size: Number(f.coSize || 0), mtime: parseMtime(f.udTime) })),
  };
}

function memoSet(key, data) {
  globalThis.__dirs = globalThis.__dirs || new Map();
  globalThis.__dirs.set(key, { data, ts: Date.now() });
}

// 目录列表缓存: 新鲜期内直接返回; 过了新鲜期先返回旧数据 + 后台静默刷新 (SWR);
// 最长保留 7 天, 超龄才同步重新拉取
async function cachedListing(env, key, recompute, ctx, opts = {}) {
  const now = Date.now();
  const memo = globalThis.__dirs?.get(key);
  if (memo && now - memo.ts < DIR_STORE * 1000) {
    if (!opts.fillOnly && now - memo.ts > DIR_FRESH && ctx?.waitUntil) {
      ctx.waitUntil(recompute().then(d => memoSet(key, d)).catch(() => {}));
    }
    return memo.data;
  }
  const kv = await env.CACHE.get(key);
  if (kv) {
    try {
      const j = JSON.parse(kv);
      if (j && j.d && now - (j.t || 0) < DIR_STORE * 1000) {
        memoSet(key, j.d);
        if (!opts.fillOnly && now - (j.t || 0) > DIR_FRESH && ctx?.waitUntil) {
          ctx.waitUntil(recompute().then(d => memoSet(key, d)).catch(() => {}));
        }
        return j.d;
      }
    } catch {}
  }
  const d = await recompute();
  memoSet(key, d);
  await env.CACHE.put(key, JSON.stringify({ d, t: Date.now() }), { expirationTtl: DIR_STORE });
  return d;
}

async function listOne(env, member, pcaid, ctx, opts = {}) {
  return cachedListing(env, `lst:${member.id}:${member.pwd}:${pcaid}`, async () => {
    const body = await call139(env, API.LIST, {
      getOutLinkInfoReq: { account: (await getConfig(env)).account, linkID: member.id, passwd: member.pwd, pCaID: pcaid },
    });
    return normListing(body);
  }, ctx, opts);
}

// 列单个成员的"有效根": 若根目录只有一个文件夹(分享者套壳)则自动下沉, 最多 3 层
async function listMemberRoot(env, member, ctx, opts = {}) {
  let cur = await listOne(env, member, "root", ctx, opts);
  for (let depth = 0; cur.folders.length === 1 && cur.files.length === 0 && depth < 3; depth++) {
    const inner = await listOne(env, member, cur.folders[0].id, ctx, opts);
    if (inner.folders.length === 0 && inner.files.length === 0) break; // 空壳不穿
    cur = inner;
  }
  return cur;
}

async function listMountRoot(env, members, ctx, opts = {}) {
  const key = `lst:${members.map(m => `${m.id}|${m.pwd}`).join(",")}:@root`;
  return cachedListing(env, key, async () => {
    const merged = { folders: [], files: [] };
    const seen = new Set();
    for (let mi = 0; mi < members.length; mi++) {
      const one = await listMemberRoot(env, members[mi], ctx, opts);
      for (const arr of [one.folders, one.files]) {
        for (const e of arr) {
          if (seen.has(e.name)) continue;   // 同名先到先得
          seen.add(e.name);
          merged[e.kind === "dir" ? "folders" : "files"].push({ ...e, memberIdx: mi });
        }
      }
    }
    return merged;
  }, ctx, opts);
}

async function getDlUrl(env, members, entry) {
  const member = members[entry.memberIdx || 0];
  const key = `dl:${member.id}:${entry.id}`;
  const kv = await env.CACHE.get(key);
  if (kv) { try { const j = JSON.parse(kv); if (j.url) return j.url; } catch {} }
  const body = await call139(env, API.DL, {
    dlFromOutLinkReqV3: {
      account: (await getConfig(env)).account, linkID: member.id, passwd: member.pwd,
      coIDLst: { item: [entry.id] },
    },
  });
  const d = body?.data || {};
  const url = d.extInfo?.cdnDownloadURL || d.redrUrl || d.redrURL || d.downloadUrl || d.downloadURL;
  if (!url) throw new Err139("NOLINK", "未返回下载直链");
  await env.CACHE.put(key, JSON.stringify({ url }), { expirationTtl: DL_TTL });
  return url;
}

// ================= 路径解析 =================

// 返回 {kind:"catdir",node} | {kind:"mountdir",members} |
//       {kind:"shareDir",entry,members} | {kind:"file",entry,members} | null
async function resolvePath(env, tree, segs, ctx) {
  let node = tree;
  let i = 0;
  while (i < segs.length && !node.leaf) {
    const next = node.children.get(segs[i]);
    if (!next) return null;
    node = next;
    i++;
  }
  if (!node.leaf) {
    if (i < segs.length) return null;
    return { kind: "catdir", node };
  }
  const members = parseMembers(node.leaf);
  if (!members.length) return null;
  const rest = segs.slice(i);
  if (rest.length === 0) return { kind: "mountdir", members };
  let entries = await listMountRoot(env, members, ctx);
  for (let j = 0; j < rest.length; j++) {
    const e = entries.folders.concat(entries.files).find(x => x.name === rest[j]);
    if (!e) return null;
    if (j === rest.length - 1) {
      return e.kind === "dir" ? { kind: "shareDir", entry: e, members } : { kind: "file", entry: e, members };
    }
    entries = await listOne(env, members[e.memberIdx || 0], e.id, ctx);
  }
  return null;
}

async function dirEntries(env, resolved, ctx, cat) {
  if (resolved.kind === "catdir") {
    const mt = Date.parse(cat?.generated || "") || Date.now();
    return [...resolved.node.children.values()].map(n => ({
      kind: "dir", name: n.name, size: 0, mtime: mt, virtual: true,
    }));
  }
  const lst = resolved.kind === "mountdir"
    ? await listMountRoot(env, resolved.members, ctx)
    : await listOne(env, resolved.members[resolved.entry.memberIdx || 0], resolved.entry.id, ctx);
  return lst.folders.concat(lst.files);
}

// ================= WebDAV =================

const xmlEsc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hrefOf = segs => "/" + segs.map(s => encodeURIComponent(s)).join("/");

function davResponse(href, e, isRoot) {
  const isDir = e.kind === "dir" || isRoot;
  const mtime = e.mtime ? new Date(e.mtime) : new Date(0);
  const mime = isDir ? "httpd/unix-directory" : (MIME[e.name.split(".").pop().toLowerCase()] || "application/octet-stream");
  return `<D:response>
<D:href>${xmlEsc(href)}</D:href>
<D:propstat><D:prop>
<D:displayname>${xmlEsc(e.name || "")}</D:displayname>
<D:resourcetype>${isDir ? "<D:collection/>" : ""}</D:resourcetype>
${isDir ? "" : `<D:getcontentlength>${e.size || 0}</D:getcontentlength>`}
<D:getcontenttype>${mime}</D:getcontenttype>
<D:getlastmodified>${mtime.toUTCString()}</D:getlastmodified>
<D:creationdate>${new Date(e.mtime || 0).toISOString().replace(/\.\d+Z$/, "Z")}</D:creationdate>
<D:supportedlock></D:supportedlock>
</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
</D:response>`;
}

function multistatus(responses) {
  return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">${responses.join("")}</D:multistatus>`;
}

// 自然排序: "第2集" 排在 "第10集" 前, 数字段按数值比较
const naturalCmp = (a, b) => a.name.localeCompare(b.name, "zh", { numeric: true, sensitivity: "base" });

async function handleDav(request, env, url, ctx) {
  if (!(await checkAuth(request, env))) return new Response("401 Unauthorized", {
    status: 401, headers: { "WWW-Authenticate": 'Basic realm="cloud139"', "Content-Type": "text/plain" },
  });
  const segs = url.pathname.replace(/^\/+|\/+$/g, "").split("/").map(s => {
    try { return decodeURIComponent(s); } catch { return s; }
  }).filter(Boolean);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: {
      DAV: "1", Allow: "OPTIONS, GET, HEAD, PROPFIND",
      "MS-Author-Via": "DAV", "Content-Length": "0",
    } });
  }

  if (request.method === "PROPFIND") {
    const depth = (request.headers.get("Depth") || "1").trim();
    const cat = await getCatalog(env);
    let resolved;
    try { resolved = await resolvePath(env, buildTree(cat), segs, ctx); }
    catch (e) { return text(e.message, 502); }
    if (!resolved) return text("404 Not Found", 404);

    // 目录 mtime = catalog 重建时间 与 内容最新修改时间 的较大者
    let selfMtime = Date.parse(cat.generated || "") || Date.now();
    let entries = [];
    if (resolved.kind !== "catdir" || depth !== "0") {
      entries = await dirEntries(env, resolved, ctx, cat);
    }
    if (entries.length) {
      selfMtime = Math.max(selfMtime, ...entries.map(e => e.mtime || 0));
    }
    const self = { kind: "dir", name: segs[segs.length - 1] || "", size: 0, mtime: selfMtime };
    const out = [davResponse(hrefOf(segs), self, segs.length === 0)];
    if (depth !== "0") {
      entries.sort((a, b) => (a.kind === b.kind ? naturalCmp(a, b) : a.kind === "dir" ? -1 : 1));
      for (const e of entries) out.push(davResponse(hrefOf([...segs, e.name]), e, false));
    }
    return new Response(multistatus(out), { status: 207, headers: { "Content-Type": 'application/xml; charset="utf-8"' } });
  }

  if (request.method === "GET" || request.method === "HEAD") {
    let resolved;
    try { resolved = await resolvePath(env, buildTree(await getCatalog(env)), segs, ctx); }
    catch (e) { return text(e.message, 502); }
    if (!resolved) return text("404 Not Found", 404);
    if (resolved.kind !== "file") return text("405 Method Not Allowed (directory)", 405);
    const e = resolved.entry;
    const mime = MIME[e.name.split(".").pop().toLowerCase()] || "application/octet-stream";
    const base = {
      "Content-Type": mime,
      "Content-Length": String(e.size || 0),
      "Accept-Ranges": "bytes",
      "Last-Modified": new Date(e.mtime || 0).toUTCString(),
    };
    if (request.method === "HEAD") return new Response(null, { status: 200, headers: base });
    const target = await getDlUrl(env, resolved.members, e);
    return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
  }

  if (request.method === "PROPPATCH" || request.method === "LOCK" || request.method === "UNLOCK") {
    return new Response(null, { status: 200 }); // 只读库, 空应答让客户端继续
  }
  return text("405 Method Not Allowed", 405);
}

// ================= API 路由 =================

const text = (s, status = 200) => new Response(s, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
const json = (o, status = 200) => new Response(JSON.stringify(o, null, 2), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });

async function getDavCreds(env) {
  const c = await getConfig(env);
  return { user: c.dav_user, pass: c.dav_pass };
}

// 认证 + 防爆破: 连续失败 N 次锁定该 IP 15 分钟(写入 KV 跨隔离生效), 失败加随机延迟
async function checkAuth(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const bf = (globalThis.__bf ||= new Map());
  const now = Date.now();
  let e = bf.get(ip);
  if (!e || now - (e.t || 0) > BF_WINDOW) { e = { n: 0, t: now }; bf.set(ip, e); }
  if (e.locked && now < e.locked) return false;
  if (e.locked) { e.n = 0; e.locked = 0; }
  const c = await getDavCreds(env);
  if (!c.user || !c.pass) return false;
  const h = request.headers.get("Authorization") || "";
  let ok = false;
  if (h.startsWith("Basic ")) {
    let cred;
    try { cred = atob(h.slice(5)).split(":"); } catch {}
    ok = !!cred && cred[0] === c.user && cred[1] === c.pass;
  }
  if (ok) { bf.delete(ip); return true; }
  e.t = now;
  e.n = (e.n || 0) + 1;
  await sleep(400 + Math.floor(Math.random() * 600));
  if (e.n >= BF_MAX) {
    e.locked = now + BF_LOCK_TTL * 1000;
  }
  return false;
}

async function handleApi(request, env, url, ctx) {
  const path = url.pathname;

  if (path === "/health") {
    let cat = null;
    try { cat = await getCatalog(env); } catch (e) { cat = { error: String(e).slice(0, 120) }; }
    return json({
      ok: true, configured: await isConfigured(env), colo: request.cf?.colo,
      catalog: cat ? { generated: cat.generated || "?", mounts: Object.keys(cat.mounts || {}).length } : null,
    });
  }

  if (!(await checkAuth(request, env))) return new Response("401 Unauthorized", {
    status: 401, headers: { "WWW-Authenticate": 'Basic realm="cloud139"', "Content-Type": "text/plain" },
  });

  if (path === "/link") {
    const p = url.searchParams.get("path") || "";
    const segs = p.split("/").map(s => { try { return decodeURIComponent(s); } catch { return s; } }).filter(Boolean);
    const resolved = await resolvePath(env, buildTree(await getCatalog(env)), segs, ctx);
    if (!resolved) return text("404 Not Found: " + p, 404);
    if (resolved.kind !== "file") return text("不是文件: " + p, 400);
    const target = await getDlUrl(env, resolved.members, resolved.entry);
    if (url.searchParams.get("format") === "json") return json({ path: p, url: target });
    return new Response(null, { status: 302, headers: { Location: target, "Cache-Control": "no-store" } });
  }

  if (path === "/admin/catalog-lines") {
    return handleCatalogLines(request, env);
  }

  if (path === "/tree") {
    const cat = await getCatalog(env);
    const summary = {};
    for (const p of Object.keys(cat.mounts)) {
      const c = p.split("/")[0];
      summary[c] = (summary[c] || 0) + 1;
    }
    return json({ generated: cat.generated, top: summary, total: Object.keys(cat.mounts).length });
  }

  if (path === "/admin/catalog" && request.method === "POST") {
    let data;
    try { data = await request.json(); } catch { return text("bad json", 400); }
    if (!data || typeof data.mounts !== "object" || !Object.keys(data.mounts).length) {
      return text("catalog.mounts 不能为空", 400);
    }
    await env.CACHE.put("catalog", JSON.stringify(data));
    globalThis.__cat = null;
    return json({ ok: true, mounts: Object.keys(data.mounts).length, generated: data.generated || null });
  }

  if (path === "/probe") {
    const raw = url.searchParams.get("link") || "";
    let lid = raw, pwd = "";
    const m = raw.match(/(?:shareweb\/#|w\/#)\/w\/i\/([0-9A-Za-z]+)/) || raw.match(/caiyun\.139\.com\/[wm]\/i[/?]([0-9A-Za-z]+)/);
    if (m) lid = m[1];
    if (lid.includes("#")) [lid, pwd] = lid.split("#", 2);
    const t0 = Date.now();
    const r = await call139(env, API.LIST, {
      getOutLinkInfoReq: { account: (await getConfig(env)).account, linkID: lid, passwd: pwd, pCaID: "root" },
    });
    const d = normListing(r);
    return json({ share: lid, ms: Date.now() - t0, folders: d.folders.map(f => f.name), files: d.files.map(f => f.name) });
  }

  return text("404 Not Found. /health /link /tree /admin/catalog /probe", 404);
}

// ================= 配置向导与管理页 =================

const PAGE_CSS = `<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:40px 16px}
.card{max-width:680px;margin:0 auto;background:#171a21;border:1px solid #262b36;border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 6px}p.sub{color:#8b93a1;margin:0 0 20px;font-size:13px}
label{display:block;font-size:13px;color:#aab2c0;margin:14px 0 6px}
input,textarea{width:100%;background:#0f1115;border:1px solid #2c3442;border-radius:8px;color:#e6e6e6;padding:10px 12px;font-size:13px;font-family:inherit}
textarea{min-height:120px;resize:vertical;font-family:ui-monospace,Consolas,monospace}
button{margin-top:18px;width:100%;background:#4f7cff;border:none;color:#fff;padding:11px;border-radius:8px;font-size:14px;cursor:pointer}
button:hover{background:#3d6af0}
.hint{font-size:12px;color:#6b7280;margin-top:6px;line-height:1.6}
.ok{color:#4ade80}.err{color:#f87171}
a{color:#4f7cff}
details{margin-top:22px;border-top:1px solid #262b36;padding-top:14px}
summary{cursor:pointer;color:#8b93a1;font-size:13px}
.status{background:#0f1115;border:1px solid #2c3442;border-radius:8px;padding:12px;font-size:13px;line-height:1.8;margin-bottom:18px}
</style>`;

function page(title, body) {
  return new Response(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>` + title + ` - 139dav</title>` + PAGE_CSS + `</head><body><div class="card">` + body + `</div></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

const SETUP_FORM = (notice) => `
<h1>139dav 初始配置</h1>
<p class="sub">粘贴移动云盘网页版的 Authorization, 设好 WebDAV 账号密码, 即可完成部署</p>
` + (notice || "") + `
<form id="f">
<label>139 Authorization（yun.139.com 网页端 F12 → 网络 → hcy/file/list → 请求标头 Authorization, 可带或不带 Basic 前缀）</label>
<textarea id="auth" placeholder="粘贴 Basic 后面的整串 base64" required></textarea>
<label>139 账号（手机号, 一般会自动识别, 识别不出再手动填）</label>
<input id="account" placeholder="自动识别" inputmode="numeric">
<label>WebDAV 用户名</label>
<input id="dav_user" value="admin" required>
<label>WebDAV 密码（至少 6 位）</label>
<input id="dav_pass" type="password" required>
<button>保存并完成部署</button>
<p class="hint">保存后访问 <a href="/admin">/admin</a> 添加分享, 或用仓库里的 clean_links.py 批量导入。WebDAV 地址即本站根路径。</p>
</form>
<script>
f.onsubmit = async (e) => {
  e.preventDefault();
  const b = document.querySelector("button"); b.disabled = true; b.textContent = "保存中...";
  const r = await fetch("/setup", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth: auth.value.trim(), account: account.value.trim(), dav_user: dav_user.value.trim(), dav_pass: dav_pass.value }) });
  const j = await r.json().catch(() => ({}));
  if (j.ok) { b.textContent = "完成!"; location.href = "/admin"; }
  else { b.disabled = false; b.textContent = "保存并完成部署"; alert(j.error || ("失败: HTTP " + r.status)); }
};
</` + `script>`;

const ADMIN_FORM = (origin, info, dav_user, dav_pass) => `
<h1>139dav 管理页</h1>
<p class="sub">分享列表管理 · WebDAV 与直链接口同源</p>
<div class="status">
WebDAV 地址: <b>` + origin + `/</b>（播放器/rclone 直接挂）<br>
WebDAV 账号: <b>` + dav_user + `</b>  密码: <b>` + dav_pass + `</b>（忘了就回这里看）<br>
直链接口: <b>` + origin + `/link?path=/分类/标题/文件.mp4</b><br>
当前目录: <b>` + info.mounts + `</b> 个挂载（generated ` + (info.generated || "未导入") + `）
</div>
<label>分享列表（每行一条: <code>分类/标题 | 分享链接或ID#提取码</code>, 链接可多个用逗号分隔; 保存后全量覆盖）</label>
<textarea id="cat" placeholder="分类/标题 | https://yun.139.com/shareweb/#/w/i/xxxxxx&#10;电影/某电影 | yyyyyyyy,zzzzzzzz#8888"></textarea>
<button id="b1">保存目录</button>
<p class="hint" id="msg"></p>
<p class="hint">大批量导入请用仓库里的 <b>clean_links.py</b>（把包含 139 分享链接的 Markdown 放进 data/ 自动清洗）+ <b>upload_catalog.py</b>。</p>
<details><summary>修改初始配置（Authorization / WebDAV 账号密码）</summary>
<label>139 Authorization</label><textarea id="auth2"></textarea>
<label>139 账号</label><input id="account2">
<label>WebDAV 用户名</label><input id="dav_user2">
<label>WebDAV 密码（留空 = 不修改）</label><input id="dav_pass2" type="password">
<button id="b2">更新配置</button><p class="hint" id="msg2"></p>
</details>
<script>
b1.onclick = async () => {
  b1.disabled = true; b1.textContent = "保存中...";
  const r = await fetch("/admin/catalog-lines", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lines: cat.value }) });
  const j = await r.json().catch(() => ({}));
  b1.disabled = false; b1.textContent = "保存目录";
  msg.textContent = j.ok ? ("已保存 " + j.mounts + " 个挂载") : ("失败: " + (j.error || r.status));
  msg.className = j.ok ? "hint ok" : "hint err";
};
b2.onclick = async () => {
  b2.disabled = true;
  const r = await fetch("/setup", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth: auth2.value.trim(), account: account2.value.trim(), dav_user: dav_user2.value.trim(), dav_pass: dav_pass2.value }) });
  const j = await r.json().catch(() => ({}));
  b2.disabled = false;
  msg2.textContent = j.ok ? "已更新" : ("失败: " + (j.error || r.status));
  msg2.className = j.ok ? "hint ok" : "hint err";
};
</` + `script>`;

function parseLinkEntriesInWorker(raw) {
  return String(raw || "").split(/[,，;；\n]+/).map(s => s.trim()).filter(Boolean).map(s => {
    const m = s.match(/(?:shareweb\/#|w\/#)\/w\/i\/([0-9A-Za-z]+)/) || s.match(/caiyun\.139\.com\/[wm]\/i[/?]([0-9A-Za-z]+)/);
    let id = m ? m[1] : s, pwd = "";
    if (id.includes("#")) { const p = id.split("#"); id = p[0]; pwd = p[1] || ""; }
    return pwd ? id + "#" + pwd : id;
  }).filter(Boolean);
}

async function handleSetup(request, env, url) {
  const configured = await isConfigured(env);
  if (request.method === "GET") {
    if (configured && !(await checkAuth(request, env))) {
      return new Response("401 Unauthorized（已配置, 修改请用管理账号登录）", {
        status: 401, headers: { "WWW-Authenticate": 'Basic realm="139dav"', "Content-Type": "text/plain" } });
    }
    return page("初始配置", SETUP_FORM(configured ? '<p class="hint ok">已配置过, 再次提交将覆盖现有配置。</p>' : ""));
  }
  if (request.method === "POST") {
    if (configured && !(await checkAuth(request, env))) {
      return json({ error: "已配置, 修改需管理账号认证" }, 401);
    }
    let b;
    try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    let auth = String(b.auth || "").trim().replace(/^Basic\s+/i, "");
    const dav_pass = String(b.dav_pass || "");
    if (!auth) return json({ error: "Authorization 不能为空" }, 400);
    let account = String(b.account || "").trim();
    let dec = "";
    try { dec = atob(auth); } catch { return json({ error: "Authorization 不是合法 base64" }, 400); }
    const parts = dec.split(":");
    if (parts.length < 3) return json({ error: "Authorization 格式不对, 应为 pc:手机号:令牌" }, 400);
    if (!account) account = parts[1] || "";
    if (!/^\d{5,15}$/.test(account)) return json({ error: "账号识别失败, 请手动填写手机号" }, 400);
    if (dav_pass.length < 6) return json({ error: "WebDAV 密码至少 6 位" }, 400);
    const dav_user = String(b.dav_user || "admin").trim() || "admin";
    await env.CACHE.put("config", JSON.stringify({ auth: auth, account: account, dav_user: dav_user, dav_pass: dav_pass }));
    globalThis.__cfg = null;
    return json({ ok: true });
  }
  return text("405", 405);
}

async function handleAdminUi(request, env, url) {
  if (request.method !== "GET") return text("405", 405);
  if (!(await checkAuth(request, env))) {
    return new Response("401 Unauthorized", {
      status: 401, headers: { "WWW-Authenticate": 'Basic realm="139dav"', "Content-Type": "text/plain" } });
  }
  let info = { mounts: 0, generated: null };
  try { const c = await getCatalog(env); info = { mounts: Object.keys(c.mounts || {}).length, generated: c.generated }; } catch {}
  const cfg = await getConfig(env);
  return page("管理页", ADMIN_FORM(url.origin, info, cfg.dav_user || "-", cfg.dav_pass || "-"));
}

async function handleCatalogLines(request, env) {
  if (request.method !== "POST") return text("405", 405);
  if (!(await checkAuth(request, env))) return json({ error: "unauthorized" }, 401);
  let b;
  try { b = await request.json(); } catch { return json({ error: "bad json" }, 400); }
  const mounts = {};
  for (const line of String(b.lines || "").split("\n")) {
    const segs = line.split("|");
    if (segs.length < 2) continue;
    const path = segs[0].trim().replace(/^\/+|\/+$/g, "");
    const link = segs.slice(1).join("|").trim();
    if (!path || !link) continue;
    const ids = parseLinkEntriesInWorker(link);
    if (!ids.length) continue;
    mounts[path] = { id: ids.join(",") };
  }
  if (!Object.keys(mounts).length) return json({ error: "没有解析到有效条目, 格式: 路径 | 链接" }, 400);
  const catalog = { version: 1, generated: new Date().toISOString().slice(0, 19), mounts: mounts };
  await env.CACHE.put("catalog", JSON.stringify(catalog));
  globalThis.__cat = null;
  return json({ ok: true, mounts: Object.keys(mounts).length });
}

// 定时预热: 每次处理一批挂载根目录, 让"点进文件夹"永远是热路径
async function warmMounts(env, ctx) {
  const cat = await getCatalog(env);
  const keys = Object.keys(cat.mounts || {});
  if (!keys.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const dayKey = `warm_day:${day}`;
  if (Number(await env.CACHE.get(dayKey) || 0) >= WARM_DAILY_CAP) return; // 当日配额用尽
  let idx = Number(await env.CACHE.get("warm_idx") || 0);
  if (!Number.isFinite(idx) || idx < 0 || idx >= keys.length) idx = 0;
  globalThis.__callCount = 0;
  let n = 0;
  for (; idx < keys.length && n < WARM_BATCH; idx++, n++) {
    const members = parseMembers(cat.mounts[keys[idx]]);
    if (!members.length) continue;
    try { await listMountRoot(env, members, ctx, { fillOnly: true }); } catch {}
    if (globalThis.__callCount >= WARM_CALL_BUDGET) { idx++; break; }
  }
  await env.CACHE.put("warm_idx", String(idx >= keys.length ? 0 : idx));
  if (globalThis.__callCount > 0) {
    const cur = Number(await env.CACHE.get(dayKey) || 0);
    await env.CACHE.put(dayKey, String(cur + globalThis.__callCount), { expirationTtl: 172800 });
  }
}

// 入口
const API_PATHS = new Set(["/health", "/tree", "/admin/catalog", "/admin/catalog-lines", "/admin", "/setup", "/probe"]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/setup") return handleSetup(request, env, url);
      if (url.pathname === "/admin") return handleAdminUi(request, env, url);
      if (API_PATHS.has(url.pathname) || url.pathname === "/link") {
        return handleApi(request, env, url, ctx);
      }
      return handleDav(request, env, url, ctx);
    } catch (e) {
      return json({ error: String(e).slice(0, 300), rc: e.rc || null }, 502);
    }
  },
  async scheduled(event, env, ctx) {
    try { await warmMounts(env, ctx); } catch (e) { console.log("warm 失败:", String(e).slice(0, 150)); }
  },
};
