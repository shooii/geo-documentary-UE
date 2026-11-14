#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""导出雷州龙门镇方案为自包含 HTML 文档（封面 + 三类场景 + 素材清单）。

用法：python3 scripts/export-longmen-plan-html.py [--project <json>] [--out <html>]
素材按 scenes[].assetIds 关联 assets[]，图片压缩为内嵌 data URI，输出单文件可分发。
"""
import argparse
import base64
import io
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_PROJECT = os.path.join(ROOT, "workspace", "projects", "project-mwdjf53v.v000057.json")
DEFAULT_OUT = os.path.abspath(os.path.join(ROOT, "..", "outputs", "雷州龙门镇-场景方案-v57.html"))

TYPE_LABEL = {
    "cover": "封面",
    "image-card": "图片卡",
    "map-overview": "地图总览",
    "region-focus": "区域聚焦",
    "outro": "收尾",
}

SEGMENTS = {
    "ov-01": "穿云开场",
    "ov-02": "镇域名片",
    "ov-03": "区位格局",
    "ov-04": "历史沿革",
    "ov-05": "人文乡建",
    "ov-06": "人文乡建",
    "ov-07": "人文乡建",
    "ov-08": "非遗民俗",
    "ov-09": "非遗民俗",
    "ov-10": "非遗民俗",
    "ov-11": "山水土地",
    "ov-12": "山水土地",
    "ov-13": "山水土地",
    "ov-14": "山水土地",
    "ov-15": "风味物产",
    "ov-16": "风味物产",
    "ov-17": "风味物产",
    "ov-18": "风味物产",
    "ov-19": "风味物产",
    "ov-20": "转场点名",
}

ASSET_TYPE_LABEL = {"image": "图片", "video": "视频", "audio": "音频"}

SOURCE_LABEL = {
    "user-provided": "用户提供",
    "generated": "生成素材",
    "web": "网络采集",
    "search": "检索采集",
}


def esc(text):
    return (
        str(text)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def mmss(seconds):
    total = int(round(seconds))
    return f"{total // 60}:{total % 60:02d}"


def secs(value):
    return f"{value:.1f}s" if value is not None else "—"


def resolve_asset_path(path):
    if not path:
        return None
    clean = path.replace("/workspace-assets/", "").lstrip("/")
    candidate = os.path.join(ROOT, "workspace", "assets", clean)
    return candidate if os.path.exists(candidate) else None


def thumb_data_uri(file_path, width=760, quality=80):
    if not file_path:
        return None
    try:
        with Image.open(file_path) as im:
            im = im.convert("RGB")
            if im.width > width:
                height = max(1, int(im.height * width / im.width))
                im = im.resize((width, height), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:  # noqa: BLE001
        print(f"  ! 缩略图失败 {file_path}: {exc}", file=sys.stderr)
        return None


def placement_meta(placement):
    if not placement:
        return ""
    bits = []
    if placement.get("fit"):
        bits.append(placement["fit"])
    anim = placement.get("animation")
    if anim:
        bits.append("静态" if anim == "still" else anim)
    if placement.get("entrance"):
        bits.append({"fade": "淡入", "wipe": "擦入"}.get(placement["entrance"], placement["entrance"]))
    if placement.get("minimumDisplaySeconds"):
        bits.append(f"停留 {placement['minimumDisplaySeconds']:.1f}s")
    return " · ".join(bits)


def build_html(project, out_path):
    cover = project["cover"]
    scenes = project["scenes"]
    assets = {a["id"]: a for a in project["assets"]}
    style = project.get("style", {})
    output = project.get("output", {})
    voice = project.get("voice", {})
    template = project.get("template", {})

    cover_scene = next((s for s in scenes if s["section"] == "cover"), None)
    overview = [s for s in scenes if s["section"] == "overview"]
    child = [s for s in scenes if s["section"] == "child"]
    outro = [s for s in scenes if s["section"] == "outro"]
    all_play = overview + child + outro

    total_duration = sum(s["duration"] for s in all_play)
    narration_chars = sum(len(s.get("narration", "")) for s in all_play)

    used_ids = []
    for s in scenes:
        for aid in s.get("assetIds", []):
            if aid not in used_ids and aid in assets:
                used_ids.append(aid)

    cache = {}
    for aid in used_ids:
        cache[aid] = thumb_data_uri(resolve_asset_path(assets[aid].get("path")))

    def asset_usage_index():
        index = {}
        for s in all_play:
            for aid in s.get("assetIds", []):
                index.setdefault(aid, []).append(s)
        return index

    usage = asset_usage_index()

    def scene_card(scene, idx, chapter):
        sid = scene["id"]
        seg = SEGMENTS.get(sid)
        typ = TYPE_LABEL.get(scene.get("type"), scene.get("type", ""))
        tag_class = {
            "图片卡": "t-img",
            "地图总览": "t-map",
            "区域聚焦": "t-region",
            "收尾": "t-outro",
        }.get(typ, "t-img")
        raw_lines = [ln.strip() for ln in scene.get("narration", "").split("\n")]
        raw_lines = [ln for ln in raw_lines if ln]
        narration = "<br>".join(esc(ln) for ln in raw_lines)
        subtitle = scene.get("subtitle", "")
        show_sub = subtitle and subtitle != scene.get("narration", "")

        parts = []
        parts.append(f'<article class="scene" id="s-{esc(sid)}">')
        parts.append('<div class="rail">')
        parts.append(f'<span class="idx">{idx:02d}</span>')
        parts.append(f'<span class="dur">{secs(scene.get("duration"))}</span>')
        parts.append("</div>")
        parts.append('<div class="body">')
        parts.append('<div class="head">')
        parts.append(f'<span class="tag {tag_class}">{esc(typ)}</span>')
        if seg:
            parts.append(f'<span class="seg">{esc(seg)}</span>')
        parts.append(f'<span class="sid">{esc(sid)}</span>')
        parts.append("</div>")
        parts.append(f"<h3>{esc(scene.get('title', ''))}</h3>")

        if narration:
            parts.append('<div class="copy">')
            parts.append('<span class="copy-label">旁白 · 字幕</span>')
            parts.append(f'<p class="narration">{narration}</p>')
            if show_sub:
                parts.append(f'<p class="subtitle">字幕：{esc(subtitle)}</p>')
            parts.append("</div>")
        else:
            parts.append('<div class="copy"><p class="narration empty">（本场景无旁白，仅画面与镜头运动）</p></div>')

        placements = {p["assetId"]: p for p in scene.get("placements", []) if p.get("assetId")}
        aid_list = [a for a in scene.get("assetIds", []) if a in assets]
        if aid_list:
            parts.append('<div class="assets">')
            for aid in aid_list:
                a = assets[aid]
                uri = cache.get(aid)
                meta = placement_meta(placements.get(aid))
                img = (
                    f'<img src="{uri}" alt="{esc(a.get("name", ""))}" loading="lazy">'
                    if uri
                    else '<div class="noimg">素材文件缺失</div>'
                )
                parts.append(
                    '<figure class="shot">'
                    + img
                    + '<figcaption><b>'
                    + esc(a.get("name", "未命名素材"))
                    + "</b><span>"
                    + esc(meta)
                    + "</span></figcaption></figure>"
                )
            parts.append("</div>")
        else:
            parts.append(
                '<div class="assets none"><div class="placeholder">'
                + ("地图镜头 · 无照片素材" if chapter != "outro" else "无绑定素材")
                + "</div></div>"
            )

        cam = scene.get("camera")
        foot = []
        if cam:
            foot.append(
                f'镜头 {cam.get("longitude")}, {cam.get("latitude")} · 高度 {cam.get("height", 0):,} m · pitch {cam.get("pitch")}° · {cam.get("transition")}'
            )
        if scene.get("timing", {}).get("mapHoldSeconds"):
            foot.append(f'地图停留 {scene["timing"]["mapHoldSeconds"]}s')
        if scene.get("assetDisplayCount"):
            foot.append(f'素材位 {scene["assetDisplayCount"]}')
        if foot:
            parts.append('<div class="foot">' + " ｜ ".join(esc(f) for f in foot) + "</div>")
        parts.append("</div></article>")
        return "".join(parts)

    # ---------- 章节内容 ----------
    ch1_cards = []
    for i, s in enumerate(overview, 1):
        ch1_cards.append(scene_card(s, i, "overview"))

    ch2_cards = []
    for i, s in enumerate(child, 1):
        ch2_cards.append(scene_card(s, i, "child"))

    ch3_cards = [scene_card(s, 1, "outro") for s in outro]

    # 目录 chips
    ch2_chips = "".join(
        f'<a class="chip" href="#s-{esc(s["id"])}">{esc(s.get("childName") or s["title"])}</a>' for s in child
    )

    # 素材清单
    rows = []
    for n, aid in enumerate(used_ids, 1):
        a = assets[aid]
        used_in = usage.get(aid, [])
        scenes_txt = "、".join((s.get("childName") or s["title"]) for s in used_in)
        if len(scenes_txt) > 60:
            scenes_txt = scenes_txt[:58] + "…"
        rows.append(
            "<tr>"
            f'<td class="num">{n:02d}</td>'
            f'<td class="name">{esc(a.get("name", ""))}</td>'
            f'<td>{esc(ASSET_TYPE_LABEL.get(a.get("type", ""), a.get("type", "") or "—"))}</td>'
            f'<td>{esc(SOURCE_LABEL.get(a.get("sourceType", ""), a.get("sourceType", "") or "—"))}</td>'
            f'<td>{"是" if a.get("verifiedReal") else "—"}</td>'
            f'<td class="used">{esc(scenes_txt)}</td>'
            "</tr>"
        )

    cover_title = cover.get("topic", "")
    subtitle = cover.get("subtitle", "")
    admin = cover.get("administrativeLabel", "")
    meta_line = cover.get("contentMeta", "")
    font_note = (
        f'{cover.get("fontFamily", "")} · {cover.get("fontSize", "")}px · 字重 {cover.get("fontWeight", "")}'
    )
    cloud_km = template.get("cloudDeckHeightMeters", 45000) / 1000
    start_km = template.get("openingStartHeightMeters", 900000) / 1000
    pitch = template.get("openingStartPitchDegrees", -52)

    css = """
:root{
  --ink:#0d0c0a; --panel:#16130f; --panel-2:#1d1913; --line:rgba(233,185,110,.16);
  --cream:#f4ecdd; --cream-dim:#c8bda8; --muted:#8d8271;
  --gold:#e9b96e; --gold-soft:#f3d6a5; --clay:#c26a4a; --jade:#6f9c8c;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--ink);color:var(--cream);overflow-x:hidden;
  font-family:"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,sans-serif;
  font-size:15px;line-height:1.75;-webkit-font-smoothing:antialiased}
body::before{content:"";position:fixed;inset:0;pointer-events:none;z-index:0;
  background:
    radial-gradient(1100px 520px at 12% -6%, rgba(233,185,110,.10), transparent 62%),
    radial-gradient(900px 480px at 96% 8%, rgba(111,156,140,.07), transparent 60%),
    repeating-linear-gradient(0deg, rgba(255,255,255,.012) 0 1px, transparent 1px 3px)}
a{color:inherit;text-decoration:none}
.shell{position:relative;z-index:1;max-width:1180px;margin:0 auto;padding:0 28px 90px}

/* 顶栏 */
.topbar{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:18px;
  padding:12px 0;background:rgba(13,12,10,.88);backdrop-filter:blur(10px);
  border-bottom:1px solid var(--line)}
.topbar .brand{font-family:"Songti SC","STZhongsong","SimSun",serif;font-size:15px;letter-spacing:.14em;color:var(--gold-soft)}
.topbar .ver{font-size:12px;color:var(--muted);letter-spacing:.08em}
.topbar nav{margin-left:auto;display:flex;gap:4px;flex-wrap:wrap}
.topbar nav a{font-size:12.5px;color:var(--cream-dim);padding:6px 11px;border-radius:99px;border:1px solid transparent}
.topbar nav a:hover{color:var(--gold-soft);border-color:var(--line);background:rgba(233,185,110,.06)}

/* 封面 */
.cover{padding:76px 0 58px;border-bottom:1px solid var(--line)}
.cover .geo{display:flex;gap:10px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);letter-spacing:.16em}
.cover .geo b{color:var(--gold);font-weight:500}
.cover h1{font-family:"Songti SC","STZhongsong","SimSun",serif;font-weight:700;
  font-size:clamp(44px,6.4vw,86px);line-height:1.14;letter-spacing:.04em;margin:26px 0 0;
  background:linear-gradient(180deg,#fff8ea 12%,#e9b96e 118%);-webkit-background-clip:text;background-clip:text;color:transparent}
.cover .sub{font-family:"Songti SC","STZhongsong","SimSun",serif;font-size:clamp(17px,2vw,23px);
  color:var(--cream-dim);margin:20px 0 0;letter-spacing:.06em}
.cover .rule{height:1px;margin:34px 0 26px;background:linear-gradient(90deg,var(--gold),rgba(233,185,110,0))}
.cover .meta{display:flex;gap:26px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.cover .meta b{color:var(--cream);font-weight:500}
.cover .admin{display:inline-block;margin-top:26px;padding:7px 16px;border:1px solid rgba(233,185,110,.45);
  border-radius:99px;font-size:12.5px;letter-spacing:.22em;color:var(--gold-soft)}

/* 统计 */
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;margin:0;background:var(--line);
  border:1px solid var(--line);border-radius:14px;overflow:hidden}
.stats div{background:var(--panel);padding:20px 18px 18px;min-width:0}
.stats .k{font-family:"Songti SC","STZhongsong",serif;font-size:clamp(21px,2.1vw,30px);color:var(--gold-soft);
  line-height:1.15;white-space:nowrap;letter-spacing:-.01em}
.stats .k.sm{font-size:clamp(18px,1.75vw,25px)}
.stats .l{font-size:12px;color:var(--muted);letter-spacing:.14em;margin-top:7px}

/* 区块标题 */
.chapter{margin-top:78px;scroll-margin-top:64px}
.chapter-head{display:flex;align-items:flex-end;gap:18px;border-bottom:1px solid var(--line);padding-bottom:16px}
.chapter-head .no{font-family:"Songti SC","STZhongsong",serif;font-size:52px;line-height:.9;color:rgba(233,185,110,.36)}
.chapter-head h2{margin:0;font-family:"Songti SC","STZhongsong","SimSun",serif;font-size:30px;letter-spacing:.06em}
.chapter-head .count{margin-left:auto;font-size:12.5px;color:var(--muted);letter-spacing:.1em;white-space:nowrap}
.chapter-note{color:var(--cream-dim);font-size:14px;margin:18px 0 30px;max-width:880px}
.chapter.ch1 .chapter-head{border-color:rgba(233,185,110,.3)}
.chapter.ch2 .chapter-head .no,.chapter.ch2 .chapter-head h2{color:rgba(194,106,74,.55)}
.chapter.ch2 .chapter-head h2{color:var(--cream)}
.chapter.ch3 .chapter-head .no{color:rgba(111,156,140,.55)}

/* 目录 chips */
.chips{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 30px}
.chip{font-size:12.5px;color:var(--cream-dim);border:1px solid var(--line);background:var(--panel);
  padding:6px 12px;border-radius:8px}
.chip:hover{border-color:rgba(233,185,110,.45);color:var(--gold-soft)}

/* 场景卡 */
.scene{display:grid;grid-template-columns:76px minmax(0,1fr);gap:22px;padding:30px 0;
  border-top:1px solid rgba(255,255,255,.055);scroll-margin-top:70px}
.scene:first-of-type{border-top:none}
.rail{text-align:right;padding-top:3px;min-width:0}
.body{min-width:0}
.rail .idx{display:block;font-family:"Songti SC","STZhongsong",serif;font-size:26px;color:rgba(233,185,110,.55);line-height:1}
.rail .dur{display:block;font-size:11.5px;color:var(--muted);margin-top:8px;letter-spacing:.06em}
.head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.tag{font-size:11px;letter-spacing:.1em;padding:3px 9px;border-radius:5px;border:1px solid transparent}
.t-img{color:#f3d6a5;background:rgba(233,185,110,.11);border-color:rgba(233,185,110,.3)}
.t-map{color:#9fd3c4;background:rgba(111,156,140,.11);border-color:rgba(111,156,140,.32)}
.t-region{color:#edb59f;background:rgba(194,106,74,.12);border-color:rgba(194,106,74,.36)}
.t-outro{color:#c9d8d2;background:rgba(111,156,140,.1);border-color:rgba(111,156,140,.28)}
.seg{font-size:11.5px;color:var(--muted);letter-spacing:.1em}
.sid{margin-left:auto;font-family:ui-monospace,Consolas,monospace;font-size:11px;color:rgba(255,255,255,.22)}
.scene h3{margin:0 0 14px;font-family:"Songti SC","STZhongsong","SimSun",serif;font-weight:600;
  font-size:19.5px;line-height:1.5;letter-spacing:.02em;color:var(--cream)}
.copy{position:relative;border-left:2px solid rgba(233,185,110,.34);padding:2px 0 2px 18px;margin:0 0 20px}
.copy-label{position:absolute;left:18px;top:-4px;font-size:10.5px;letter-spacing:.18em;color:var(--muted)}
.copy .narration{margin:16px 0 0;font-size:16px;line-height:2;color:#e8dfcd;letter-spacing:.012em}
.copy .narration.empty{color:var(--muted);font-style:italic;font-size:14px;margin-top:6px}
.copy .subtitle{margin:10px 0 0;font-size:12.5px;color:var(--muted)}

.assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(232px,100%),1fr));gap:16px}
.assets.none{grid-template-columns:1fr}
.placeholder{border:1px dashed rgba(255,255,255,.14);border-radius:10px;padding:22px;text-align:center;
  color:var(--muted);font-size:12.5px;letter-spacing:.14em;background:rgba(255,255,255,.015)}
.shot{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--panel);cursor:zoom-in}
.shot img{display:block;width:100%;height:168px;object-fit:cover;transition:transform .5s ease,filter .4s}
.shot:hover img{transform:scale(1.035);filter:saturate(1.06)}
.shot figcaption{padding:9px 11px 10px;display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--line)}
.shot figcaption b{font-size:12.5px;font-weight:500;color:var(--cream);line-height:1.45}
.shot figcaption span{font-size:10.5px;color:var(--muted);letter-spacing:.05em}
.noimg{padding:30px;text-align:center;color:var(--clay);font-size:12px}
.foot{margin-top:14px;font-size:11.5px;color:rgba(255,255,255,.3);letter-spacing:.04em;overflow-wrap:anywhere}

/* 素材表 */
.table-wrap{border:1px solid var(--line);border-radius:12px;overflow-x:auto;margin-top:8px;-webkit-overflow-scrolling:touch}
table{width:100%;min-width:680px;border-collapse:collapse;font-size:12.5px}
thead th{background:var(--panel-2);color:var(--gold-soft);font-weight:500;text-align:left;
  padding:11px 14px;letter-spacing:.08em;font-size:11.5px;white-space:nowrap}
tbody td{padding:10px 14px;border-top:1px solid rgba(255,255,255,.05);color:var(--cream-dim);vertical-align:top}
tbody tr:hover td{background:rgba(233,185,110,.04)}
td.num{color:rgba(255,255,255,.25);font-family:ui-monospace,monospace}
td.name{color:var(--cream)}
td.used{color:var(--muted);font-size:11.5px}

footer{margin-top:80px;padding-top:24px;border-top:1px solid var(--line);
  display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);letter-spacing:.06em}

/* 灯箱 */
.lightbox{position:fixed;inset:0;z-index:99;display:none;place-items:center;padding:40px;
  background:rgba(6,5,4,.94);backdrop-filter:blur(4px)}
.lightbox.on{display:grid}
.lightbox img{max-width:min(1000px,92vw);max-height:82vh;border-radius:8px;box-shadow:0 30px 80px rgba(0,0,0,.7)}
.lightbox .cap{position:absolute;bottom:26px;left:0;right:0;text-align:center;color:var(--cream-dim);font-size:13px}

@media (max-width:720px){
  .shell{padding:0 16px 60px}
  .scene{grid-template-columns:38px minmax(0,1fr);gap:10px}
  .rail .idx{font-size:19px}
  .cover{padding:48px 0 40px}
  .copy .narration{font-size:15px;line-height:1.95}
  .chapter-head .no{font-size:36px}
  .chapter-head h2{font-size:23px}
  .topbar nav{display:none}
}
@media print{
  body{background:#fff;color:#1b1a18}
  body::before{display:none}
  .topbar,.lightbox{display:none!important}
  .cover h1{color:#1b1a18;background:none;-webkit-text-fill-color:#1b1a18}
  .cover .geo,.cover .meta,.chapter-note,.foot,.rail .dur{color:#5c574d}
  .stats div,.chip,.shot,.table-wrap{background:#faf8f3;border-color:#ddd5c4}
  .stats .k,thead th,.topbar .brand{color:#8a6420}
  .scene{page-break-inside:avoid;border-top-color:#e3dccb}
  tbody td{color:#2b2822;border-top-color:#eee6d6}
  thead th{background:#f1ebdd}
  .shot img{height:120px}
  .copy .narration{color:#1b1a18}
}
"""

    js = """
(function(){
  var lb=document.getElementById('lightbox'), img=lb.querySelector('img'), cap=lb.querySelector('.cap');
  document.querySelectorAll('.shot').forEach(function(f){
    f.addEventListener('click',function(){
      var im=f.querySelector('img'); if(!im) return;
      img.src=im.src; cap.textContent=f.querySelector('figcaption b').textContent;
      lb.classList.add('on');
    });
  });
  lb.addEventListener('click',function(){lb.classList.remove('on')});
  document.addEventListener('keydown',function(e){if(e.key==='Escape')lb.classList.remove('on')});

  var links=[].slice.call(document.querySelectorAll('.topbar nav a[data-jump]'));
  var targets=links.map(function(a){return document.querySelector(a.getAttribute('href'))}).filter(Boolean);
  if('IntersectionObserver' in window){
    var io=new IntersectionObserver(function(es){
      es.forEach(function(e){
        if(!e.isIntersecting) return;
        links.forEach(function(a){a.style.color='';a.style.borderColor='transparent'});
        var a=links[targets.indexOf(e.target)];
        if(a){a.style.color='#f3d6a5';a.style.borderColor='rgba(233,185,110,.3)'}
      });
    },{rootMargin:'-20% 0px -70% 0px'});
    targets.forEach(function(t){io.observe(t)});
  }
})();
"""

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{esc(admin)} · {esc(cover_title)} — 场景方案（第 {project.get("revision")} 版）</title>
<style>{css}</style>
</head>
<body>
<div class="lightbox" id="lightbox"><img alt=""><div class="cap"></div></div>
<div class="shell">

  <div class="topbar">
    <span class="brand">{esc(admin)} · 场景方案</span>
    <span class="ver">v{project.get("revision")}</span>
    <nav>
      <a href="#cover" data-jump>封面</a>
      <a href="#ch1" data-jump>穿云与总体介绍</a>
      <a href="#ch2" data-jump>行政村介绍</a>
      <a href="#ch3" data-jump>收尾</a>
      <a href="#appendix" data-jump>素材清单</a>
    </nav>
  </div>

  <section class="cover" id="cover">
    <div class="geo">
      <span>{esc(cover.get("province"))}</span><span>·</span><span>{esc(cover.get("city"))}</span><span>·</span>
      <span>{esc(cover.get("county"))}</span><span>·</span><b>{esc(cover.get("town"))}</b>
    </div>
    <h1>{esc(cover_title)}</h1>
    <p class="sub">{esc(subtitle)}</p>
    <div class="admin">{esc(admin)}</div>
    <div class="rule"></div>
    <div class="meta">
      <span>题材 <b>{esc(meta_line)}</b></span>
      <span>封面字体 <b>{esc(font_note)}</b></span>
      <span>底图 <b>{esc(project.get("imagery", {}).get("provider", "") or "天地图影像")}</b></span>
      <span>配音 <b>{esc(voice.get("voice") or voice.get("voiceName") or "zh-CN-YunyangNeural")}</b></span>
    </div>
  </section>

  <section class="stats" style="margin-top:34px">
    <div><div class="k">{len(all_play)}</div><div class="l">正片场景</div></div>
    <div><div class="k">{mmss(total_duration)}</div><div class="l">设定总时长</div></div>
    <div><div class="k">{len(child)}</div><div class="l">村社分述</div></div>
    <div><div class="k">{len(used_ids)}</div><div class="l">引用实景素材</div></div>
    <div><div class="k">{narration_chars:,}</div><div class="l">旁白字数</div></div>
    <div><div class="k sm">{output.get("width")}×{output.get("height")}</div><div class="l">{esc(output.get("profile"))} · {output.get("fps")}fps</div></div>
  </section>

  <div class="chapter-note" style="margin-top:26px">
    本片以「三龙会首」为地理骨架，按四段推进：<b style="color:var(--gold-soft)">封面</b> → <b style="color:var(--gold-soft)">穿云与总体介绍</b> → <b style="color:var(--gold-soft)">行政村介绍</b> → <b style="color:var(--gold-soft)">收尾</b>。
    开场自 {start_km:,.0f} 千米高空以 {pitch}° 俯角下压，穿过约 {cloud_km:,.0f} 千米云层落到雷州半岛；中段 22 个村社逐一点名；结尾回到山河与烟火。
  </div>

  <section class="chapter ch1" id="ch1">
    <div class="chapter-head">
      <span class="no">01</span>
      <h2>穿云与总体介绍</h2>
      <span class="count">{len(overview)} 个场景 · {secs(sum(s["duration"] for s in overview))}</span>
    </div>
    <p class="chapter-note">
      开场穿云之后进入镇域总览：区位与体量、两千年沿革、崇文尚义的乡建故事、三项国家级非遗、水库移民与红土地产业，最后落到辣酱、酱油、白切鸡、羊粥、虾饼这些具体味道。
      这一段承担「为什么值得看」的任务，为后面的逐村点名做铺垫。
    </p>
    {"".join(ch1_cards)}
  </section>

  <section class="chapter ch2" id="ch2">
    <div class="chapter-head">
      <span class="no">02</span>
      <h2>行政村介绍</h2>
      <span class="count">{len(child)} 个场景 · {secs(sum(s["duration"] for s in child))}</span>
    </div>
    <p class="chapter-note">
      21 个行政村按既定顺序逐一点名，镇区与农垦六大社区合并为一个场景收束。
      每村一段旁白、一次航拍聚焦；已绑定实景照片的场景展示素材与铺排参数，未绑定的为纯地图镜头。
    </p>
    <div class="chips">{ch2_chips}</div>
    {"".join(ch2_cards)}
  </section>

  <section class="chapter ch3" id="ch3">
    <div class="chapter-head">
      <span class="no">03</span>
      <h2>收尾</h2>
      <span class="count">{len(outro)} 个场景 · {secs(sum(s["duration"] for s in outro))}</span>
    </div>
    <p class="chapter-note">以「万物本乎天，人本乎祖」起句，把驻军、落籍、古越稻歌、书局灯火与一勺头抽收在一处，落到山河与烟火。</p>
    {"".join(ch3_cards)}
  </section>

  <section class="chapter" id="appendix">
    <div class="chapter-head">
      <span class="no">附</span>
      <h2>素材清单</h2>
      <span class="count">{len(used_ids)} 项被引用 / 素材库 {len(assets)} 项</span>
    </div>
    <p class="chapter-note">下表按场景引用顺序列出实景素材，来源与核实标记沿用方案原始字段；未在正片中引用的素材不计入。</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>#</th><th>素材名称</th><th>类型</th><th>来源</th><th>已核实</th><th>使用场景</th></tr></thead>
        <tbody>{"".join(rows)}</tbody>
      </table>
    </div>
  </section>

  <footer>
    <span>{esc(admin)} · {esc(cover_title)}</span>
    <span>方案第 {project.get("revision")} 版 · 更新于 {esc(project.get("updatedAt", ""))}</span>
    <span>区域代码 {esc(project.get("regionId", ""))}</span>
    <span>共 {len(scenes)} 个场景节点（含封面）</span>
    <span>本文档依据方案数据自动生成，图片已内嵌，可离线分发与打印</span>
  </footer>
</div>
<script>{js}</script>
</body>
</html>
"""
    with open(out_path, "w", encoding="utf-8") as fh:
        fh.write(html)
    return {
        "out": out_path,
        "scenes": len(all_play),
        "duration": total_duration,
        "assets": len(used_ids),
        "size": os.path.getsize(out_path),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", default=DEFAULT_PROJECT)
    ap.add_argument("--out", default=DEFAULT_OUT)
    args = ap.parse_args()

    with open(args.project, encoding="utf-8") as fh:
        project = json.load(fh)

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    result = build_html(project, args.out)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
