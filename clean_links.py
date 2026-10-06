#!/usr/bin/env python3
"""
把包含 139 分享链接的 Markdown / 文本，清洗成 139dav 的目录树 catalog.json。

规则:
  - "# / ## / ###" 标题行 -> 目录层级
  - 普通行: 行内文字清理后作为标题, 行内所有 139 链接绑定到该挂载
  - 标题自动去掉画质 / 集数等噪音
  - 全文档按分享 ID 去重

用法:
    python clean_links.py                # 处理 data/ 下所有 .md / .txt / .docx
    python clean_links.py 某文件.md      # 处理指定文件

输出 catalog.json 后, 用 upload_catalog.py 上传到你的 Worker 即可。
"""

import glob
import html
import json
import re
import sys
from datetime import datetime


try:
    import docx
except ImportError:
    docx = None

URL_PATTERNS = [
    re.compile(r"yun\.139\.com/(?:shareweb|w)/#/w/i/([0-9A-Za-z]+)"),
    re.compile(r"yun\.139\.com/w/#/share/([0-9A-Za-z]+)"),
    re.compile(r"caiyun\.139\.com/[wm]/i[/?]([0-9A-Za-z]+)"),
]
YEAR_RE = re.compile(r"[（(](\d{4})[）)]")
NOISE_RE = re.compile(
    r"(4K|1080[Pp]|720[Pp]|HDR|DV|60[Ff][Pp][Ss]|高码|高码率|杜比|臻彩|内封|内嵌|简中|繁中|中英文字幕|"
    r"官方中字|未删减|纯净版|多版本|SDR|HQ|WEB-?DL|BluRay|REMUX|全\d+集|\d+集全|更新至第?\d+集).*$"
)
BAD_CHARS = re.compile(r'[\\/:*?"<>|]')
EMOJI_RE = re.compile(
    "[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F900-\U0001F9FF\u2B00-\u2BFF\uFE0F]+",
    flags=re.UNICODE,
)


def extract_ids(line):
    """行内所有 139 分享 ID, 按出现顺序去重"""
    ids = []
    for pat in URL_PATTERNS:
        for m in pat.finditer(line):
            if m.group(1) not in ids:
                ids.append(m.group(1))
    return ids


def clean_title(raw):
    """『某标题 4K 全12集：链接』 -> 『某标题』"""
    t = EMOJI_RE.sub("", raw)
    t = re.sub(r"\]\([^)]*\)", "", t)
    t = re.sub(r"https?://\S+", "", t)
    t = re.sub(r"[\\[\]`#*_|]", "", t)
    t = html.unescape(t).strip().strip("｜|").strip()
    while True:
        t2 = re.sub(r"【[^【】]*】\s*$", "", t).strip().strip("：:").strip()
        if t2 == t:
            break
        t = t2
    year = YEAR_RE.search(t)
    base = t[: year.start()] if year else re.split(r"[：:]", t)[0]
    base = BAD_CHARS.sub(" ", base)
    base = re.sub(r"\s{2,}", " ", base).strip(" -_—·。，,")
    if not base:
        return None
    return f"{base} ({year.group(1)})" if year else base


def iter_lines(path):
    if path.lower().endswith(".docx"):
        if docx is None:
            raise RuntimeError("处理 .docx 需要: pip install python-docx")
        for p in docx.Document(path).paragraphs:
            yield p.text
    else:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                yield line.rstrip("\n")


def parse_file(path):
    """返回按文档顺序的 {路径段, 标题, 链接ID列表} 列表"""
    items, seen = [], set()
    headings = []
    for line in iter_lines(path):
        h = re.match(r"^(#{1,6})\s+(.*)", line)
        if h:
            level, text = len(h.group(1)), h.group(2).strip()
            headings = headings[: level - 1] + [text]
            continue
        ids = extract_ids(line)
        if not ids:
            continue
        new_ids = [i for i in ids if i not in seen]
        if not new_ids:
            continue
        seen.update(new_ids)
        raw = re.sub(r"https?://\S+", "", line)
        raw = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", raw).strip()
        title = clean_title(re.sub(r"^\d+[.、]\s*", "", raw)) or new_ids[0]
        items.append({"path": [h for h in headings if h], "title": title, "ids": new_ids})
    return items


def clean(files):
    mounts, used, total = {}, set(), 0
    for f in files:
        for item in parse_file(f):
            total += len(item["ids"])
            segs = [re.sub(r'[\\/:*?"<>|]', " ", s).strip() for s in item["path"]]
            segs = [s for s in segs if s]
            path = "/".join(segs + [item["title"]])
            key, n = path, 1
            while key in used:
                n += 1
                key = f"{path} ({n})"
            used.add(key)
            mounts[key] = {"id": ",".join(item["ids"])}

    catalog = {"version": 1, "generated": datetime.now().isoformat(timespec="seconds"),
               "mounts": mounts}
    with open("catalog.json", "w", encoding="utf-8") as fp:
        json.dump(catalog, fp, ensure_ascii=False, indent=1)

    print(f"提取 {total} 条链接, 去重后 {len(mounts)} 个挂载 -> catalog.json")
    print("下一步: python upload_catalog.py --url <Worker地址> --user <账号> --pass <密码>")
    return 0


if __name__ == "__main__":
    files = sys.argv[1:] or sorted(glob.glob("data/*.md") + glob.glob("data/*.txt") + glob.glob("data/*.docx"))
    if not files:
        print("data/ 目录下没有找到链接文档, 格式参考 data/示例合集.md")
        sys.exit(1)
    sys.exit(clean(files))
