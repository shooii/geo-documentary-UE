# -*- coding: utf-8 -*-
"""按 E:/AI视频/00视频输出/龙门镇/10.html 在工作台新建「雷州市龙门镇」方案。
文案逐字取自 HTML voice-box；图片逐张取自 HTML <figure>，按 cue 点位绑定。
"""
import base64, copy, html as H, json, mimetypes, pathlib, re, urllib.request, urllib.error, io
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC  = pathlib.Path('E:/AI视频/00视频输出/龙门镇/10.html')
IMG  = ROOT / 'tmp/lm10-img'
OUT  = pathlib.Path('E:/AI视频/00视频输出/龙门镇')
API  = 'http://127.0.0.1:4180'
assert SRC.is_file() and IMG.is_dir() and OUT.is_dir()

def api(path, data=None, method=None, timeout=180):
    body = json.dumps(data, ensure_ascii=False).encode('utf-8') if data is not None else None
    req = urllib.request.Request(API + path, data=body,
        headers={'Content-Type':'application/json'}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r: return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{path}: {e.read().decode()}') from e

h = SRC.read_text(encoding='utf-8')

# ---------- 1. 图片：URL -> 本地字节 ----------
LOCAL = {1:'img1.jpeg',2:'img2.jpeg',3:'img3.jpg',4:'g4.jpg',5:'img5.jpg',6:'img6.jpg',7:'img7.jpg',
 8:'g8.jpg',9:'img9.webp',10:'img10.jpeg',11:'img11.jpg',12:'img12.jpeg',13:'img13.jpeg',
 14:'g14.jpg',15:'img15.jpg',16:'g16.jpg',17:'img17.jpg',18:'img18.jpeg',20:'img20.webp',
 23:'img23.jpg',27:'img27.jpg'}
imglist = json.loads((IMG/'imglist.json').read_text(encoding='utf-8'))
URL2FILE = {x['src']: LOCAL[x['i']] for x in imglist}

figs=[]
for n, blk in enumerate(re.findall(r'<figure class="real-fig">([\s\S]*?)</figure>', h), 1):
    src  = re.search(r'src="([^"]+)"', blk).group(1)
    cap  = re.sub(r'\s+',' ', re.search(r'<b>([\s\S]*?)</b>', blk).group(1)).strip()
    mnode= re.search(r'class="fig-node">([\s\S]*?)</span>', blk)
    node = re.sub(r'\s+',' ',mnode.group(1)).strip() if mnode else ''
    msrc = re.search(r'class="fig-src">[\s\S]*?href="([^"]+)"', blk)
    srcurl = msrc.group(1) if msrc else src
    code = re.search(r'【([^】]+)】', cap)
    figs.append(dict(n=n, code=code.group(1) if code else f'图位{n:02d}', cap=cap,
                     node=node, file=URL2FILE[src], url=src, srcurl=srcurl))
assert len(figs)==30
figby={f['n']:f for f in figs}

# ---------- 2. cue -> 图位（严格按 HTML 标注） ----------
CUE2FIGS = {
 '01':[1],'02':[2],'03':[3],'04':[4],'05':[5],'06':[6],'07':[7],'08':[8],'09':[9],
 '10':[10],'11':[11],'12':[12],'13':[13],'14':[14],'15':[15],'16':[16,17],'17':[18],
 'V01-A':[19],'V01-B':[20],'V01-C':[21],'V02-A':[22,23],'V03-A':[],'V04-A':[24],
 'V05-A':[],'V06-A':[],'V07-A':[],'V08-A':[25],'V09-A':[],'V10-A':[],'V11-A':[],
 'V12-A':[],'V13-A':[],'V14-A':[],'V15-A':[],'V16-A':[],'V17-A':[],'V18-A':[],
 'V19-A':[],'V20-A':[],'V21-A':[],'V22-A':[26,27],
 'END-01':[28],'END-02':[29],'END-03':[30]}
assert sorted(sum(CUE2FIGS.values(),[])) == list(range(1,31))

# ---------- 3. 解析 voice-box：纯文案 + cue 切点 ----------
def clean_voice(inner, mark_cues=True):
    inner = re.sub(r'<span class="voice-label">[\s\S]*?</span>', '', inner)
    inner = re.sub(r'<span class="copy-btn">[\s\S]*?</span>', '', inner)
    inner = re.sub(r'<br\s*/?>', '', inner)
    def mark(m):
        if not mark_cues: return ''
        t = re.sub(r'<[^>]+>','',m.group(1))
        k = re.search(r'(?:配图点位|点位)\s*([0-9]{2}|V\d{2}-[A-Z]|END-\d{2})', t)
        return '\x00'+(k.group(1) if k else '?')+'\x00'
    inner = re.sub(r'<span class="cue-inline">([\s\S]*?)</span>', mark, inner)
    return H.unescape(re.sub(r'<[^>]+>', '', inner))

def split_voice(inner):
    parts = re.split(r'\x00([^\x00]+)\x00', clean_voice(inner))
    segs=[]; cur=parts[0]; i=1
    while i < len(parts):
        cue, after = parts[i], parts[i+1]
        lead = re.match(r'^[，。；！、？]+', after)   # cue 后紧跟的标点归入本句
        if lead:
            cur += lead.group(0); after = after[len(lead.group(0)):]
        segs.append((cue, re.sub(r'\s+',' ',cur).strip()))
        cur = after; i += 2
    return segs, re.sub(r'\s+',' ',cur).strip()

blocks=[]
for m in re.finditer(r'<article class="script-stage">([\s\S]*?)</article>', h):
    blk=m.group(1)
    badge = re.search(r'class="stage-badge">([\s\S]*?)</span>', blk).group(1).strip()
    segs, tail = split_voice(re.search(r'<div class="voice-box">([\s\S]*?)</div>', blk).group(1))
    blocks.append(dict(kind='ending' if '结尾' in badge else 'act', segs=segs, tail=tail,
                       badge=badge, pos=m.start()))
for m in re.finditer(r'<article class="village-card">([\s\S]*?)</article>', h):
    blk=m.group(1)
    title = re.sub(r'\s+',' ', re.sub(r'<[^>]+>','', re.search(r'<h3>([\s\S]*?)</h3>', blk).group(1))).strip()
    code = re.search(r'class="v-code">([\s\S]*?)</span>', blk).group(1).strip()
    segs, tail = split_voice(re.search(r'<div class="voice-box">([\s\S]*?)</div>', blk).group(1))
    blocks.append(dict(kind='village', title=title, code=code, segs=segs, tail=tail, pos=m.start()))
blocks.sort(key=lambda b: b['pos'])   # 严格按 HTML 出现顺序
assert len(blocks)==26
# 完整性：每个 voice-box 的所有分段拼接 == 该 voice-box 去标签纯文本（逐字）
# 按 HTML 中出现顺序取 26 个 voice-box，与 blocks 顺序（3幕+22村+结尾）一致
VBOXES = re.findall(r'<div class="voice-box">([\s\S]*?)</div>', h)
assert len(VBOXES)==26
for b, vb in zip(blocks, VBOXES):
    pure = re.sub(r'\s+','', clean_voice(vb, mark_cues=False))
    joined = re.sub(r'\s+','', ''.join(t for _,t in b['segs']) + b['tail'])
    assert joined == pure, f"文案切分不一致: {joined[:60]!r} vs {pure[:60]!r}"
ALL_PURE = ''.join(re.sub(r'\s+','', clean_voice(vb, mark_cues=False)) for vb in VBOXES)
JOINED = ''.join(re.sub(r'\s+','', ''.join(t for _,t in b['segs']) + b['tail']) for b in blocks)
assert JOINED == ALL_PURE, f'文案切分不一致 {len(JOINED)} vs {len(ALL_PURE)}'
print('文案逐字校验通过：', len(ALL_PURE), '字')

# ---------- 4. 新建方案 ----------
new = api('/api/projects', {'regionId':'440882112','name':'雷州市龙门镇'}, 'POST')
PID = new['id']
print('新建方案', PID, new['name'], 'rev', new['revision'])

# ---------- 5. 上传 30 张图（一图位一素材，名字/alt 固化图文对应） ----------
from PIL import Image
assets=[]
for f in figs:
    raw = (IMG/f['file']).read_bytes()
    im = Image.open(io.BytesIO(raw))
    fmt = (im.format or 'JPEG').upper()
    mime = {'JPEG':'image/jpeg','PNG':'image/png','WEBP':'image/webp','GIF':'image/gif'}.get(fmt,'image/jpeg')
    name = f"【{f['code']}】{re.sub(r'【[^】]+】','',f['cap']).strip()}".replace('.','·')[:110]
    alt  = (f"{f['cap']}｜对应节点：{f['node'] or '按 HTML 图位顺序'}｜来源：{f['srcurl']}")[:290]
    a = api('/api/assets', {'projectId':PID,'name':name,'mimeType':mime,
        'dataUrl':'data:'+mime+';base64,'+base64.b64encode(raw).decode(),'alt':alt}, 'POST')
    f['aid']=a['id']; assets.append(a)
    print(f"  p{f['n']:02d} {f['code']:9s} -> {a['id']}  {fmt:5s} {len(raw):>8d}B")
aidby={f['n']:f['aid'] for f in figs}

# ---------- 6. 相机（child 场景） ----------
region = json.loads((ROOT/'data/regions/440882112.json').read_text(encoding='utf-8'))
cam_by_id={}
for c in region.get('childRegions',[]):
    preset = (c.get('cameraProfiles') or {}).get('portrait') or c.get('cameraPreset') or {}
    cam_by_id[str(c['id'])] = {k:preset[k] for k in ('longitude','latitude','height','heading','pitch') if k in preset}
town_cam = region.get('cameraPreset') or {}
def camera_for(cid):
    c = cam_by_id.get(cid) or {k:town_cam[k] for k in ('longitude','latitude','height','heading','pitch') if k in town_cam}
    return dict(c, transition='fly')

# ---------- 7. 构建场景 ----------
def placement(aid, f, dur):
    return {'assetId':aid,'fit':'contain','crop':{'x':0,'y':0,'width':1,'height':1},
      'focalPoint':{'x':0.5,'y':0.5},'scale':1,'offsetX':0,'offsetY':0,'animation':'still',
      'entrance':'fade','leadSeconds':0,'tailSeconds':0,
      'minimumDisplaySeconds':round(max(2.6,dur),2),'targetDisplaySeconds':0,
      'requiredKeywords':[],'alt':f['cap'][:110],'includeInRender':True}

def duration(text):
    return round(max(2.2, len(re.sub(r'\s','',text))/4.0),2)

def scene(sid, section, stype, title, text, figids, **extra):
    d = duration(text)
    fs = [figby[i] for i in figids]
    pls = [placement(aidby[i], f, d/len(fs)) for i,f in zip(figids,fs)]
    s = {'id':sid,'title':title,'narration':text,'subtitle':text,'type':stype,'section':section,
         'duration':d,'assetIds':[aidby[i] for i in figids],'placements':pls,
         'timing':{'actualNarrationSeconds':0,'preHoldSeconds':0,'postHoldSeconds':0,
                   'minimumVisualSeconds':round(min(120,max(2.6,d)),2),
                   'mapHoldSeconds':2 if section=='child' else 0}}
    if pls: s['assetDisplayCount']=len(pls)
    s.update(extra)
    return s

scenes=[copy.deepcopy(new['scenes'][0])]   # cover
scenes[0]['assetIds']=[]; scenes[0]['placements']=[]
ov=0
for b in blocks:
    if b['kind']=='act':
        for cue,text in b['segs']:
            ov+=1
            scenes.append(scene(f'ov-{ov:02d}','overview','image-card',f'开篇 · 配图点位 {cue}',
                                text,CUE2FIGS[cue]))
        if b['tail']:
            ov+=1
            scenes.append(scene(f'ov-{ov:02d}','overview','map-overview','开篇 · 地图过渡',b['tail'],[]))
    elif b['kind']=='village':
        code=b['code']
        cid = '440882112001' if '—' in code else code.split()[0]
        text = ''.join(t for _,t in b['segs']) + b['tail']
        figids = [i for cue,_ in b['segs'] for i in CUE2FIGS.get(cue,[])]
        name = '镇区与农垦六大社区' if '—' in code else re.sub(r'^\d+\s*','',b['title']).split(' ')[0]
        scenes.append(scene(f'child-{cid}','child','region-focus',name,text,figids,
                            childId=cid,childName=name,camera=camera_for(cid)))
    else:  # ending
        text = ''.join(t for _,t in b['segs']) + b['tail']
        figids = [i for cue,_ in b['segs'] for i in CUE2FIGS.get(cue,[])]
        scenes.append(scene('outro','outro','outro','结尾 · 山河入龙门，烟火抚人心',text,figids))
assert len([s for s in scenes if s['section']=='child'])==22
assert len({s['childId'] for s in scenes if s['section']=='child'})==22
assert len([s for s in scenes if s['section']=='outro'])==1

# ---------- 8. 组装并保存 ----------
project = copy.deepcopy(new)
project['name'] = new['name']
project['voice'] = dict(project.get('voice') or {}, speed=1, enabled=True)
project['cover'].update(topic='三龙会首 · 雷州腹心',
    subtitle='368平方千米红土地 · 21村6社区',
    contentMeta='10分钟抖音图文全案 · 逐字沿用 10.html')
project['assets']=assets
project['scenes']=scenes
project['sourceDocument']={'filename':'10.html','path':str(SRC),
    'note':'场景文案与图片严格取自 10.html；cue 点位与 figure 一一对应',
    'html':h}
saved = api('/api/projects/'+PID, project, 'PUT', timeout=240)
print('保存成功 rev', saved['revision'], 'scenes', len(saved['scenes']), 'assets', len(saved['assets']))

# ---------- 9. 准备检查 ----------
r = api('/api/projects/'+PID+'/validate', {}, 'POST')
print('READY', r['ready'])
for c in r['checks']:
    print(f"  [{'OK' if c['pass'] else ('ADV' if c.get('advisory') else 'FAIL')}] {c['name']}: {c['detail']}")

# ---------- 10. 对照表 ----------
FIGDIR = OUT/'10html-figures'; FIGDIR.mkdir(exist_ok=True)
for f in figs:
    ext = {'JPEG':'jpg','PNG':'png','WEBP':'webp','GIF':'gif'}[(Image.open(io.BytesIO((IMG/f['file']).read_bytes())).format or 'JPEG')]
    (FIGDIR/f"p{f['n']:02d}.{ext}").write_bytes((IMG/f['file']).read_bytes())
    f['disk']=f"p{f['n']:02d}.{ext}"
def fig_html(i):
    f=figby[i]
    return (f'<figure><img loading="lazy" src="10html-figures/{f["disk"]}" alt="{H.escape(f["cap"])}">'
      f'<figcaption><b>{H.escape(f["cap"])}</b>'
      + (f'<span>对应节点：{H.escape(f["node"])}</span>' if f['node'] else '')
      + f'<a href="{H.escape(f["srcurl"])}" target="_blank" rel="noopener">原始图源</a></figcaption></figure>')
rows=[]
for n,s in enumerate(saved['scenes']):
    if s['section']=='cover':
        rows.append(f'<article class="scene cover"><h3>封面</h3><p>雷州市龙门镇 · 三龙会首 雷州腹心</p></article>'); continue
    pics=''.join(fig_html(i) for i in [f['n'] for f in figs if f['aid'] in s.get('assetIds',[])])
    if not pics: pics='<div class="noimg">按 10.html 本段无配图点位 · 工作台保留地图表达</div>'
    rows.append(f'<article class="scene" data-sec="{s["section"]}"><div class="head"><span class="num">{n:02d}</span>'
      f'<h3>{H.escape(s["title"])}</h3><span class="badge">{s["section"]} · {round(s["duration"])}s</span></div>'
      f'<p class="narr">{H.escape(s["narration"])}</p><div class="grid">{pics}</div></article>')
CSS=''':root{--bg:#0b1112;--ink:#f4eee1;--gold:#e5b96e;--mut:#a6b0ab;--line:#ffffff20}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.8 "Microsoft YaHei",system-ui}.wrap{max-width:1160px;margin:auto;padding:0 26px}header{padding:52px 0 34px;border-bottom:1px solid var(--line)}h1{font:700 clamp(28px,4vw,46px)/1.3 "STZhongsong",serif;margin:12px 0}h1 em{color:var(--gold);font-style:normal}.meta{color:var(--mut);font-size:13px}.stats{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}.stat{background:#121c1e;border:1px solid var(--line);border-radius:10px;padding:10px 16px}.stat b{font-size:21px;color:var(--gold);display:block}.stat span{font-size:11.5px;color:var(--mut)}.note{background:#191812;border-left:4px solid var(--gold);padding:14px 18px;border-radius:0 8px 8px 0;margin:22px 0;font-size:13.5px;color:#ebdfc8}.scene{background:#121c1e;border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:16px 0;break-inside:avoid}.head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:10px}.num{font:700 21px Georgia,serif;color:var(--gold)}.head h3{margin:0;font-size:16.5px;flex:1}.badge{font-size:11.5px;color:var(--mut);border:1px solid var(--line);padding:2px 9px;border-radius:99px}.narr{font-size:15px;line-height:1.9;color:#eee7d8;background:#0b111280;border-left:3px solid var(--gold);padding:10px 14px;border-radius:0 6px 6px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;margin-top:12px}figure{margin:0;background:#0c1415;border:1px solid #e5b96e48;border-radius:9px;overflow:hidden;display:flex;flex-direction:column}figure img{width:100%;height:170px;object-fit:contain;background:#070b0c}figcaption{padding:9px 11px;font-size:11.5px;line-height:1.6;display:flex;flex-direction:column;gap:4px}figcaption b{color:var(--gold);font-size:12.5px}figcaption span{color:#d8e0dc}figcaption a{color:var(--gold);text-decoration:none;font-size:11px}.noimg{padding:12px 15px;border:1px dashed var(--line);border-radius:8px;color:var(--mut);font-size:12.5px}footer{padding:34px 0 60px;color:var(--mut);font-size:12px}'''
charcount=sum(len(re.sub(r'\s','',s.get('narration',''))) for s in saved['scenes'])
doc=('<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
 '<title>雷州市龙门镇 · 工作台场景图文对照表（10.html）</title><style>'+CSS+'</style></head><body>'
 '<header><div class="wrap"><div class="meta">VIDEO STUDIO / 场景—文案—图片逐场核对 · 2026-11-12</div>'
 '<h1>雷州市龙门镇<br><em>场景图文对照表</em></h1>'
 '<p class="meta">方案 '+H.escape(saved['name'])+'（'+PID+' · rev '+str(saved['revision'])+'）· 全部文案与图片严格取自 10.html</p>'
 '<div class="stats"><div class="stat"><b>'+str(len(saved['scenes']))+'</b><span>工作台场景</span></div>'
 '<div class="stat"><b>30</b><span>HTML 配图点位</span></div>'
 '<div class="stat"><b>21</b><span>唯一图片文件</span></div>'
 '<div class="stat"><b>'+str(charcount)+'</b><span>旁白字数（逐字）</span></div></div></div></header>'
 '<div class="wrap"><div class="note"><b>核对口径：</b>每个场景的旁白按 10.html 的 <code>cue-inline</code> 点位切分，逐字保留、顺序不变；'
 '图片取自该点位对应的 <code>figure</code>，一图位一素材。图片未做替换、裁切或重写；仅按原始字节转存。'
 '部分网络图片自带水印、字幕或截图界面，以及少量图文语义存疑处，均按用户要求原样沿用（见文末说明）。</div>'
 +''.join(rows)+
 '<div class="note"><b>沿用原图时的已知瑕疵（未改动，仅提示）：</b>'
 '配图点位 02 为短视频截图（含平台界面与文字）；点位 06 含视频字幕；点位 10 石碑题字为「广东省红江农场」，'
 '与「龙门大牛岭菠萝」的图文关联需复核；点位 11 画面为块茎作物采收，与「北运菜／甜竹笋／香芋」并非同一对象；'
 '点位 20 为室内展陈，与图注「大观园雷派古建」不完全一致。商用前请确认版权授权。</div>'
 '<footer>图片离线存于 10html-figures/ · 本对照表由 10.html 自动生成，用于核对工作台方案的图文对应关系。</footer></div></body></html>')
(OUT/'雷州市龙门镇-工作台场景图文对照表.html').write_text(doc,encoding='utf-8')
report={'projectId':PID,'name':saved['name'],'revision':saved['revision'],
        'scenes':len(saved['scenes']),'figures':30,'uniqueImages':len(LOCAL),
        'characters':charcount,'estimatedSeconds':round(sum(s['duration'] for s in saved['scenes']),1),
        'ready':r['ready'],'checks':[{k:c[k] for k in ('id','pass')} for c in r['checks']],
        'comparison':str(OUT/'雷州市龙门镇-工作台场景图文对照表.html')}
(ROOT/'workspace/projects'/(PID+'.10html-check.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
