import base64, copy, html, json, mimetypes, pathlib, re, urllib.request
from datetime import datetime, timezone

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = pathlib.Path('E:/AI视频/00视频输出/龙门镇')
assert OUT.is_dir()
API = 'http://127.0.0.1:4180'
PID = 'project-mwd9ipal'

def api(path, data=None, method=None):
    req = urllib.request.Request(API + path, data=json.dumps(data, ensure_ascii=False).encode('utf-8') if data is not None else None, headers={'Content-Type':'application/json'}, method=method)
    try:
        return json.load(urllib.request.urlopen(req, timeout=90))
    except urllib.error.HTTPError as e:
        raise RuntimeError(e.read().decode()) from e

old = api('/api/projects/project-mwcalhdd')
new = api('/api/projects/' + PID)
project = copy.deepcopy(old)
project.update(id=PID, name=new['name'], revision=new['revision'], createdAt=new['createdAt'], updatedAt=new['updatedAt'])
project['imagery']['provider'] = 'tianditu-imagery'
project['cover'].update(topic='酱缸与乡音', subtitle='果蔬走远，乡音留下', contentMeta='21个行政村逐一介绍 · 图文核实版', townshipCount=21)
project['voice']['speed'] = 1
project.pop('poiImport', None)

SOURCES = [
('S1','龙门镇各村民小组确认通知','2017-10-16；村民小组名录，并非2026年新统计','https://www.leizhou.gov.cn/pdml/lmz/gzwj/qtwj/content/post_201426.html'),
('S2','雷州市七普公报（第二号）','2020-11-01零时常住人口；2021-06-25公布','https://www.leizhou.gov.cn/xxgk/gmjj/content/post_1466895.html'),
('S3','龙门镇2024年工作报告','2024-06-06；回顾2023年，计划不当作已建成','https://www.leizhou.gov.cn/pdml/lmz/zfgzbg/content/post_1916651.html'),
('S4','南方日报／南方+龙门镇专题','2023-12-05；产业布局、潮溪、平滩、足荣','https://static.nfnews.com/content/202312/05/c8369744.html?enterColumnId=11959'),
('S5','南方+：湛江“镇”能量④','2024-01-15；图注明确的水库、古建、高速照片','https://static.nfnews.com/content/202401/15/c8505474.html?enterColumnId=43796'),
('S6','雷州龙门有个酱油村','2023-12-21；晒酱工艺、白切蘸酱、足荣工坊','https://www.leizhou.gov.cn/pdml/lmz/zwdt/content/post_1846035.html'),
('S7','南方网：陈宇扎根家乡','方言电影节、昌公书局与辣酱产业的报道依据','https://gdxk.southcn.com/zj/xwbd/content/post_740817.html'),
('S8','湛江新闻网：百镇墟日盘点','农历尾数一、四、七；出行前再核实开市情况','https://www.gdzjdaily.com.cn/shizheng/p/2726282.html'),
('S9','龙门镇国土空间总体规划公开文本','2021—2035规划；范围口径不同，不拼接面积与人口','https://www.leizhou.gov.cn/zjlzlm/attachment/0/255/255829/2064074.pdf'),
('S10','龙门镇百科沿革资料','1987年建镇；仅取沿革，不照搬过时经济数字','https://baike.baidu.com/item/龙门镇/4844756'),
('R1','抖音社区自律公约','真实性、原创与他人权利；发布时以平台现行要求为准','https://www.douyin.com/rule/policy'),
('R2','DOU+投放要求','加热另审；版权、人物、联系方式及危险行为重点复核','https://aweme.snssdk.com/falcon/douyin/agreements/?aid=6825907318853470216&hide_nav_bar=1')]
source_urls = {s[0]:s[3] for s in SOURCES}
byasset = {a['id']:a for a in old['assets']}
keep_ids = ['f38fa555-47d6-4fb5-b07b-4342f4bfbfd1','5e9180fc-9db2-4be8-925d-8e7358d9b123','61894816-b5af-4dd4-b9d6-df6a9e884d4e']
assets = [copy.deepcopy(byasset[k]) for k in keep_ids]
assets[0]['sourceUrl'] = source_urls['S6']
assets[0]['name'] = '足荣晒酱工坊 · 搅拌晒缸'
assets[1]['name'] = '足荣茂德公大观园 · 鱼灯展陈'
assets[2]['name'] = '潭边调星森林公园 · 林间实景'
photo_defs = [
('lm-new-reservoir','longmen-20261112-reservoir.jpg','龙门水库 · 水岸全景','S4','龙门水库水碧叶绿，环境优美。受访者供图',''),
('lm-new-highway','longmen-20261112-highway.jpg','G15沈海高速 · 龙门段','S5','G15沈海高速龙门段。莫受智 摄',''),
('lm-new-courtyard','longmen-20261112-courtyard.jpg','王家村辖潮溪 · 古建筑群','S5','一览古建筑的全貌','440882112209')]
for aid, filename, name, sid, caption, child in photo_defs:
    assert (ROOT/'workspace/assets'/filename).is_file()
    a = {'id':aid,'name':name,'path':'/workspace-assets/'+filename,'type':'image','sourceType':'user-provided','sourceUrl':source_urls[sid], 'verifiedReal':True,'prohibitedContent':False,'alt':name+'；原报道图注：'+caption,'scope':{'projectId':PID,'regionId':'440882112'}}
    if child: a['scope']['childId'] = child
    assets.append(a)
for a in assets:
    a.setdefault('scope',{})['projectId'] = PID
project['assets'] = assets
byasset = {a['id']:a for a in assets}

# 每个照片场景只绑定一张；不以同镇照片冒充具体村庄。
meta = {}
overview = [
('overview-1','开篇｜一口酱缸，为什么连着一块银幕？','一口酱缸，要等上几个月。一个村庄，却把乡音送上银幕。雷州市龙门镇，为什么能把这两件事放在一起？答案，不只在足荣，更在二十一个村。','f38fa555-47d6-4fb5-b07b-4342f4bfbfd1','S6 S7','开盖舀酱动作起片；首屏只留“酱缸与乡音”，不叠加来源页界面。'),
('overview-2','地理历史｜红土台地上的老圩','雷州半岛中南部，龙门坐落在红土台地之间，镇名沿自龙门圩。一九八七年建镇，老圩留下买卖的记忆，水库与田野撑起日常。','lm-new-reservoir','S9 S10','水库全景只表现地理与水岸，不能冒充龙门河近景或某村航拍。'),
('overview-3','人口习俗｜七万多人的乡音','二〇二〇年第七次人口普查，龙门常住人口七万五千七百三十七人。农历尾数逢一、四、七趁圩，熟悉的雷州话，把买卖喊成家常。','','S2 S8','人口数字卡标注“2020七普”，圩市实拍待补；不播放无来源的模拟叫卖声。'),
('overview-5','社会经济｜生计不只长在田里','甘蔗连着糖业，剑麻连着加工，菠萝和北运菜连着市场。二〇二三年，镇里公布的工业总产值约三点一亿元。龙门的生计，不只长在田里。','','S3 S4','产业文字卡；不把规划中的机场、高铁站当作建成实景。'),
('overview-6','风味｜先记住它的甜','大牛岭菠萝、九斗红橙、红皮花生，都是公开资料点名的龙门风物。果子走得很远，地名也跟着走远。认识龙门，可以先从这几口开始。','','S3 S4','必须分清菠萝、菠萝蜜与红橙；缺本地产地实拍，不配通用水果照。'),
('overview-8-part-2','饮食｜白切的清鲜，靠一口酱提味','在足荣，阳光不只催熟果子，也晒出酱油。白切蘸酱，辣酱佐餐，不必把盘子堆满，饭桌已经有了自己的滋味。酱香背后，是工坊，也是生计。','f38fa555-47d6-4fb5-b07b-4342f4bfbfd1','S6 S7','晒酱照片对应工艺句；白切成菜和辣酱入口特写需当地补拍，不能说已拍齐。'),
('overview-7','人文｜乡村不只能被拍摄','二〇一五年，足荣村创办方言电影节。村庄不只能成为镜头里的背景，也能搭起银幕，让人用自己的语言讲生活。把乡音留下，也是在给远行的人留一个入口。','','S7','电影节银幕、乡音采访实拍待补；不盗用电影片段、颁奖嘉宾或未经授权人物照片。'),
('overview-handcraft','手作｜把手艺摆到眼前','足荣的茂德公大观园，把雷州手作与乡村生活放在一起。眼前这些鱼灯，先让人看见手艺，再想起：地方文化，也可以离日常这么近。','5e9180fc-9db2-4be8-925d-8e7358d9b123','S4 S7','只讲鱼灯展陈，不把这张室内照片当成电影节、国道或晒酱现场。'),
('overview-9-part-4','文旅｜古村仍在过日子','王家村辖下的潮溪，留着老宅、青石巷和朝议第。二〇一二年入选首批中国传统村落。建筑留住了旧时的纹理，今天的人，仍在村里过日子。','lm-new-courtyard','S1 S4 S5','古建筑群完整展示，保留来源水印；展板细字发布前须放大复核。'),
('overview-waterfall','山水｜平滩瀑布，把水声留下','淘汶的平滩一带，龙门河跌过岩层，留下平滩瀑布。足荣的林荫，是另一种安静。山水值得看，也值得保护：不涉险，不攀岩，不把游玩拍成冒险。','','S4 S6','已找到原报道瀑布照，但人物站在近水岩石上，本方案不采用，待补安全岸上无人远景。'),
('overview-10-part-4','交通｜果蔬出发，游客进来','二〇七国道与高速把龙门接向远方。果蔬沿路出发，游客沿路进来。老村落与新产业，并不是互不相干的两条路。','lm-new-highway','S4 S5','仅标注G15龙门段，不将高速航拍标成207国道照片。'),
('overview-11','转场｜二十一个村，一个也不跳过','接下来，二十一个行政村，逐个看。出名的景点要讲，寻常的村庄也要讲。一个龙门，不该只剩下几个好记的名字。','','S1 S3','序号与村名独立显示；社区不混算，自然村不另列成行政村。')]
oldscenes = {s['id']:s for s in old['scenes']}
baseoverview = oldscenes['overview-2']
scenes = [copy.deepcopy(oldscenes['cover'])]
for sid,title,text,asset,source,direction in overview:
    s=copy.deepcopy(oldscenes.get(sid,baseoverview)); s.update(id=sid,title=title,narration=text,subtitle=text,section='overview')
    scenes.append(s); meta[sid]={'source':source,'direction':direction,'asset':asset}

village_copy = {
'足荣村':('足荣村，酱缸留住时间，电影节留住乡音。茂德公大观园把手作、饮食和乡村旅游连起来。这里的招牌，不只是一处景，而是一套仍在生长的生活。','S1 S4 S6 S7','5e9180fc-9db2-4be8-925d-8e7358d9b123','鱼灯展陈一图一场；晒酱和电影节已在总览分别介绍，不重复堆数字。'),
'德地村':('德地村，辖下名单里有龙门圩，也有昌平、居安、水库仔。要读懂镇上的热闹，不能只看一条商业街，还要记住连着老圩的这些村名。','S1','','补拍龙门圩普通街巷，避开机关门面、电话招牌。'),
'那双村':('那双村，加湖、东山、和禄、姚宅，都在它辖下。还有后塘上、后塘下。一个行政村，可以有许多回家的方向；把小地名说准，乡愁才不会走错地方。','S1','','撤下缺少出处的已建冷链说法；优先找加湖、那双村口实景。'),
'谢家村':('谢家村，辖谢家、竹仔山、谢家新村三个村民小组。老名字和新名字并排出现，这一站不借别人的景，只把属于谢家的来处，清清楚楚说出来。','S1','','谢家和羊觅辖下同名谢家须区分，不以搜索同名图直接入片。'),
'王家村':('王家村，潮溪就在它的辖下。青石巷通向老宅，朝议第留着屋顶走马道。看见精巧的建筑，也别忘了：潮溪是自然村，王家才是这一站的行政村。','S1 S4 S5','lm-new-courtyard','古建群照片对应潮溪，不将人物报道照当作普通游客；不展示仪式场面。'),
'平湖村':('平湖村，北运菜市场是认识这里的一条线索。一头连着地里收成，一头连着外地买家。平湖圩东、圩南、圩西、圩北，这些名字，也留在村民小组名单里。','S1 S3','','补拍装筐称重装车动作；不把廉江包装厂错挂图当平湖市场。'),
'羊觅村':('羊觅村，大牛岭上、大牛岭下都在它名下。大牛岭菠萝，是公开报道反复提到的龙门物产。果子装车离开，果地的名字，也一起被带到了远方。','S1 S3 S4','','限定羊觅大牛岭本地果地；不能用徐闻菠萝的海替代。'),
'淘汶村':('淘汶村，辖下有平滩上、平滩下，平滩瀑布就在这一带。公开报道也写到这里的菠萝基地。游客追着水声来，村庄仍按农时往前走。','S1 S4 S6','','瀑布安全远景和本地菠萝基地优先；现有临水站人图不入片。'),
'禄马村':('禄马村，公开报道把它与北运菜、荔枝基地联系在一起，辖下还有金盘。认识一个村，不一定先找门楼；一季收成，有时就是它的名片。','S1 S4','','补拍经定位核实的荔枝果园、装车动作，不用商店电话门面。'),
'九斗村':('九斗村，红橙是鲜明的地方标识。村民小组名单里，还能找到刺山、曲堰、湖口。记住一口果香，也记住种出它的地方；地名，不只是包装上的字。','S1 S3 S4','','九斗红橙必须配红橙原产地，不以菠萝照片顶替。'),
'排楼村':('排楼村，有排楼南、排楼北，也有排楼圩、油河和常居。村落与圩场，出现在同一张名单里。它不只是一处供游客经过的地方，也是具体人家的来处。','S1','','优先排楼圩正常交易画面，不对名称推演未证实村史。'),
'公树村':('公树村，田港、赤坡、那黄、公圩，都在它的辖下。一个“公树”，并不只有一个村口。那些地图上容易被略过的小名字，才让家乡有了细节。','S1','','补拍田港或公树普通村巷，拒绝机关招牌和异地仙人洞错图。'),
'潭边村':('潭边村，调星上、调星下属于这里，调星森林公园留下林间景观。报道中，它也与禄马一同出现在荔枝基地布局里。果与树，是认识潭边的两条线索。','S1 S4','61894816-b5af-4dd4-b9d6-df6a9e884d4e','林间照片只对应调星景观，不冒充荔枝林。'),
'那宛村':('那宛村，辖那宛、后坑、铁炉三个村民小组。三个名字各有落点。了解一个村，不必先替它安排传奇；先把它与周边的村庄分清，才算真正走近。','S1','','补拍那宛普通村貌；未查实的水库和地名起源不入旁白。'),
'那利村':('那利村，北插、培家、边岭都在它的村落名单里。二〇二四年的工作报告，还提到那利路桥升级安排。这里讲的是当年的计划，不把愿望写成已经完成。','S1 S3','','桥梁现状待实勘；文案保留计划时点，不配外地桥或已建成字样。'),
'横山村':('横山村，与九斗一同出现在龙门红橙基地布局中，辖下还有毛云、新村。果树的生长，要按季节等待；一个村的分量，也不能只凭镜头里的几秒来定。','S1 S4','','旧高德古民居图画面普通且证据有限，本版不凑图；优先本地红橙果园。'),
'竹桥村':('竹桥村，唐家东、唐家西、竹桥纪、竹桥洪，以及竹桥圩、铺仔，都在辖下名单中。一座桥未必能解释村名，但这些具体的名字，能让人准确认出自己的家。','S1','','不编桥名来历；补拍竹桥圩、铺仔生活场景。'),
'后排村':('后排村，有后排上、后排下，也有富行、富行仔、南坡。相近的名字，并不是同一个地方。把它们逐个留下，是因为一个家乡，也可以有不同的来处。','S1','','不把横山毛云照片当后排；村落名牌若含禁用内容则不采。'),
'那尾村':('那尾村，辖下有那尾寮、那平、沙园、加山市、刘宅、谷仓。一个“那尾”，连着七个村民小组。名字说完整，回家的路，才有更清楚的落点。','S1','','优先村巷整体实景，不能以加山市同名异地照片替代。'),
'田墩村':('田墩村，鸡村、徐禄、后坡、潭龙仔、石兰，都在它的名单里。这里不用借一个热门景点证明自己。把这些名字记下来，就是给寻常村庄留一个位置。','S1','','鸡村为官方原名，保留不擅改；实拍未核实前不承诺古迹或特色产业。'),
'宝蓄村':('宝蓄村，辖宝蓄、龙洞、西沟三个村民小组。二十一个行政村，不能少了这一站。大地名让外人找到龙门，小地名让离家的人，找到自己。','S1','','宝蓄必须单列；现有边界缺口只用真实点位，不凭空画村界；古牌坊另核实后再用。')}
for oldscene in old['scenes']:
    if oldscene.get('section') != 'child': continue
    s=copy.deepcopy(oldscene)
    name=s['childName']
    text,source,asset,direction=village_copy[name]
    s.update(title=name,narration=text,subtitle=text)
    scenes.append(s); meta[s['id']]={'source':source,'direction':direction,'asset':asset}
text='二十一个村走下来，龙门不只有一种样子。有人等一缸酱熟，有人赶一季收成；有人守着老巷，有人让乡音走上银幕。果蔬可以走得很远，人也可以去更大的天地。但那句熟悉的雷州话一响起，家乡就有了方向。这里是雷州市龙门镇。把日子过好，把来处记牢。'
s=copy.deepcopy(oldscenes['outro']); s.update(narration=text,subtitle=text,title='结尾｜果蔬走远，乡音留下'); scenes.append(s)
meta['outro']={'source':'S1 S4 S6 S7','direction':'收回龙门水库整体实景，落版全镇名；不强求点赞转发，不做无依据的全镇排名。','asset':'lm-new-reservoir'}
for s in scenes:
    aid=meta.get(s['id'],{}).get('asset','')
    if s['id']=='cover':
        s['assetIds']=[]; s['placements']=[]; continue
    s['duration']=round(max(4,len(re.sub(r'\s','',s['narration']))/4.6),2)
    s['timing']={'actualNarrationSeconds':0,'preHoldSeconds':0,'postHoldSeconds':0,'minimumVisualSeconds':2.6,'mapHoldSeconds':0}
    s['assetIds']=[aid] if aid else []
    s['placements']=[{'assetId':aid,'fit':'contain','crop':{'x':0,'y':0,'width':1,'height':1},'focalPoint':{'x':0.5,'y':0.5},'scale':1,'offsetX':0,'offsetY':0,'animation':'still','entrance':'fade','leadSeconds':0,'tailSeconds':0,'minimumDisplaySeconds':2.6,'targetDisplaySeconds':0,'requiredKeywords':[],'alt':byasset[aid]['name'],'includeInRender':True}] if aid else []
    if aid: s['assetDisplayCount']=1
    else: s.pop('assetDisplayCount',None)
project['scenes']=scenes
assert len([s for s in scenes if s.get('section')=='child'])==21
assert len({s.get('childId') for s in scenes if s.get('section')=='child'})==21
assert all(len(s.get('placements',[]))<=1 for s in scenes)
assert '\u53cd\u5dee' not in json.dumps(project,ensure_ascii=False)
# 先注册素材侧车，保存链只接纳素材库中已存在的资产。
for a in assets:
    sidecar=ROOT/'workspace/assets'/(a['id']+'.asset.json')
    if not sidecar.exists(): sidecar.write_text(json.dumps(a,ensure_ascii=False,indent=2),encoding='utf-8')
saved=api('/api/projects/'+PID,project,'PUT')
for s in saved['scenes']:
    expected=meta.get(s['id'],{}).get('asset','')
    assert s.get('assetIds',[]) == ([expected] if expected else []), (s['id'],s.get('assetIds'),expected)

E=html.escape

def image_uri(a):
    p=ROOT/'workspace/assets'/a['path'].split('/')[-1]
    return 'data:'+ (mimetypes.guess_type(p.name)[0] or 'image/jpeg')+';base64,'+base64.b64encode(p.read_bytes()).decode()

def figure(a):
    poi=a.get('poi',{})
    provenance=('高德POI '+poi.get('poiName','')+' · '+poi.get('poiId','')) if poi else '原报道图注与地点相互核对'
    return '<figure><img loading="lazy" src="'+image_uri(a)+'" alt="'+E(a['name'])+'"><figcaption><b>'+E(a['name'])+'</b><span>'+E(provenance)+'</span><a href="'+E(a.get('sourceUrl',''))+'" target="_blank" rel="noopener">查看来源 · 商用授权待落实</a></figcaption></figure>'

css='''
:root{--bg:#f6f4ef;--paper:#fffefa;--ink:#233d38;--sub:#677871;--line:#dce3d9;--accent:#ae562d;--soft:#edf2e8}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.8 "Microsoft YaHei",system-ui,sans-serif}.wrap{max-width:1180px;margin:auto;padding:0 32px}header{padding:64px 0 48px;border-top:8px solid var(--accent);background:linear-gradient(120deg,#e8eee1,#fbf3e6)}.eyebrow{font-size:12px;letter-spacing:.16em;color:var(--accent);font-weight:700}h1{font:700 clamp(40px,7vw,76px)/1.18 "STZhongsong",serif;margin:22px 0}h1 em{font-style:normal;color:var(--accent)}.lead{max-width:780px;font-size:18px}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:30px}.stat{padding:18px;background:var(--paper);border:1px solid var(--line);border-radius:12px}.stat b{display:block;font-size:27px}.stat span{font-size:12px;color:var(--sub)}nav{position:sticky;top:0;z-index:2;background:#fffefaf2;border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}nav .wrap{display:flex;gap:24px;overflow:auto;padding-top:12px;padding-bottom:12px}a{color:var(--accent);text-underline-offset:4px}nav a{white-space:nowrap;text-decoration:none}section{padding:44px 0;border-bottom:1px solid var(--line)}h2{font:700 30px/1.4 "STZhongsong",serif;margin:0 0 15px}h3{font-size:19px;margin:0 0 12px}.note{padding:18px 22px;border-left:4px solid var(--accent);background:#fbeddc;margin:20px 0;border-radius:0 10px 10px 0}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:18px}.card,.scene{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:24px}.card p{margin:0}.scene{margin:18px 0;break-inside:avoid}.scene-head{display:flex;align-items:center;gap:14px}.num{font-size:23px;color:var(--accent);font-family:Georgia,serif}.badge{margin-left:auto;font-size:12px;color:var(--sub)}.narration{font-size:17px;line-height:1.95;border-left:3px solid #c5d4b7;padding:12px 18px;background:#f2f5ed;margin:15px 0}.stage{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:22px;align-items:start}.meta{color:var(--sub);font-size:12px}.direction{font-size:13px;color:var(--sub)}figure{margin:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#f1f0e9}figure img{display:block;width:100%;height:220px;object-fit:contain;background:#e9ede4}figcaption{padding:12px;font-size:12px}figcaption b,figcaption span{display:block}figcaption span{color:var(--sub)}.missing{padding:30px 20px;background:repeating-linear-gradient(135deg,#edf1e9,#edf1e9 10px,#f2f4ef 10px,#f2f4ef 20px);border:1px dashed #abbca4;border-radius:12px;color:var(--sub);min-height:150px}.missing b{display:block;font-size:18px;color:var(--ink)}.tools{display:flex;gap:12px;flex-wrap:wrap}.tools input{padding:10px 14px;border:1px solid #b5c3af;border-radius:8px;background:white;min-width:250px;font:inherit}button,.button{padding:10px 16px;background:var(--ink);color:white;border:0;border-radius:8px;cursor:pointer;text-decoration:none;font:inherit}.outline{background:white;color:var(--ink);border:1px solid var(--line)}table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:12px;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}th{color:var(--accent)}.tablewrap{overflow:auto}.source{padding:12px 0;border-bottom:1px solid var(--line)}footer{padding:34px 0;color:var(--sub);font-size:12px}.hidden{display:none!important}@media(max-width:700px){.wrap{padding:0 18px}header{padding:34px 0}.stats,.cards{grid-template-columns:1fr 1fr}.grid,.stage{grid-template-columns:1fr}.scene{padding:18px}.scene-head{flex-wrap:wrap}.badge{margin-left:0}.tools input{min-width:0;width:100%}nav .wrap{gap:18px}h2{font-size:25px}}@media print{nav,.tools,.button{display:none}header{padding:20px 0}.scene{box-shadow:none}.wrap{max-width:none}a{color:inherit}section{padding:20px 0}}
'''
charcount=sum(len(re.sub(r'\s','',s.get('narration',''))) for s in saved['scenes'])
duration=sum(s.get('duration',0) for s in saved['scenes'])
children=[s for s in saved['scenes'] if s.get('section')=='child']
photo_children=sum(bool(s.get('assetIds')) for s in children)
scene_html=[]
for i,s in enumerate(saved['scenes']):
    if s['id']=='cover': continue
    m=meta[s['id']]; aid=m['asset']; src=' '.join('<a href="'+E(source_urls[k])+'" target="_blank" rel="noopener">'+k+'</a>' for k in m['source'].split())
    visual=figure(byasset[aid]) if aid else '<div class="missing"><b>未用替代照片</b>暂无符合本地定位、内容和画质要求的照片。工作台保留地图表达；此处是素材缺口，不是已完成拍摄。</div>'
    scene_html.append('<article class="scene" data-group="'+s['section']+'" data-name="'+E(s['title'])+'"><div class="scene-head"><span class="num">'+str(i).zfill(2)+'</span><h3>'+E(s['title'])+'</h3><span class="badge">'+str(round(s['duration']))+'s 估算 · '+('本地实景' if aid else '待补实拍')+'</span></div><div class="stage"><div><p class="narration">'+E(s['narration'])+'</p><p class="direction"><b>画面表达：</b>'+E(m['direction'])+'</p><p class="meta">事实依据：'+src+' · 文学性收束不作为统计事实</p></div>'+visual+'</div></article>')
source_html=''.join('<div class="source"><b>'+sid+' · '+E(title)+'</b><br><span class="meta">'+E(note)+'</span><br><a href="'+E(url)+'" target="_blank" rel="noopener">阅读原文</a></div>' for sid,title,note,url in SOURCES)
food='''<div class="cards"><div class="card"><h3>大牛岭菠萝 / 九斗红橙</h3><p>龙门的产地识别项，不套外地果园；剥切特写必须同场拍清产地。九斗红橙不是廉江红橙素材的通用替代名。</p></div><div class="card"><h3>足荣酱油 / 本地辣酱</h3><p>拍开盖、舀酱、蘸料三个动作。酱油与辣酱分清，不用一张深色酱油照宣称拍到了红色辣酱成品。</p></div><div class="card"><h3>白切蘸酱</h3><p>报道有雷州白切蘸酱的饮食语境，不包装成龙门独占菜式，不捏造“全镇公认第一家”。当地餐桌实拍待补。</p></div><div class="card"><h3>红皮花生</h3><p>镇工作报告直接点名的农产，适合表现剥壳、炒制与零食场景。照片必须能确认本地产地或真实店家，画面不能带联系方式。</p></div></div>'''
shorts='''<div class="cards"><div class="card"><h3>01｜酱缸为什么连着银幕？</h3><p>45—60秒：开盖动作起片→晒酱工艺→2015年方言电影节→“把滋味和乡音，都留在村里”。电影节素材须另获授权，不用鱼灯假装银幕。</p></div><div class="card"><h3>02｜潮溪不是第22个行政村</h3><p>35—45秒：古宅全貌→屋顶走马道文字解说→明确王家与潮溪层级。只讲有依据的建筑细节，不编豪宅主人传奇。</p></div><div class="card"><h3>03｜龙门的甜，从哪里来？</h3><p>35—50秒：大牛岭菠萝→九斗红橙→红皮花生。三样三镜，缺哪样就补哪样，不用网络通用图混剪。</p></div><div class="card"><h3>04｜21个村，准确点名</h3><p>分3条发布，每条7村。每村独立标题和一句事实，不用“是本地人必须点赞”等话术。以村名和真实记忆自然交流。</p></div></div>'''
head='<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>雷州市龙门镇｜酱缸与乡音 · 图文策划</title><style>'+css+'</style></head><body>'
hero='<header><div class="wrap"><div class="eyebrow">广东 · 湛江 · 雷州 / LONGMEN · 2026.11.12</div><h1>酱缸与乡音<br><em>果蔬走远，乡音留下</em></h1><p class="lead">一边等酱熟，一边把家乡话送上银幕。以足荣为入口，看见整个龙门：不只名村，也给二十一个行政村各留一个清楚的位置。</p><div class="stats"><div class="stat"><b>21</b><span>行政村逐一独立介绍</span></div><div class="stat"><b>'+str(len(saved['scenes']))+'</b><span>工作台场景（含封面与结尾）</span></div><div class="stat"><b>'+str(len(assets))+'</b><span>逐图审查保留的本地照片</span></div><div class="stat"><b>'+str(round(duration/60,1))+'分钟</b><span>按文案估算，尚未生成新旁白</span></div></div></div></header>'
intro='''<section id="logic"><div class="wrap"><h2>01 / 先把龙门讲具体</h2><div class="cards"><div class="card"><h3>开篇不是百科，是一个问题</h3><p>酱缸要等，银幕让乡音出发。问题在第一句提出，随后用产业与人文回答，结尾回收。不编造悬案，不以夸大数字夺眼球。</p></div><div class="card"><h3>一镇，不只一处景点</h3><p>总起覆盖地理、历史、人口、方言圩俗、经济、美食与文旅。中段逐村分述，结尾回到普通人的生活，不把村名当作一串字幕扫过。</p></div><div class="card"><h3>代表性有证据，认同不虚构</h3><p>主线选择公开资料多次提及的足荣晒酱、方言电影节、大牛岭菠萝、九斗红橙、平滩瀑布与潮溪古村。没有民调，不声称“本地人公认第一”。</p></div><div class="card"><h3>图像先过关，再谈好看</h3><p>沿用参考稿的场景—旁白—素材绑定方式，一图一场景。真实照片离线内嵌；拒绝外地示意、电话招牌、机关门面和拼凑弱图。</p></div></div><div class="note"><b>交付状态：</b>文案与工作台新方案已建；21村中目前仅3村绑定合格照片，其余18村明确保留实拍缺口。地图不是本地照片的完成证明。公开可见不等于可商用，全部网络与高德图片仍须取得授权后方可发布或加热。</div><p class="meta">七普常住人口为75,737人（2020口径），不冒充2026现值；面积资料口径不一，本片不拼接数字。村组名单以2017官方通知为基础并对照2024报告，发布前应复核是否有最新行政调整。</p></div></section>'''
body=head+hero+'<nav><div class="wrap"><a href="#logic">策划逻辑</a><a href="#script">逐场脚本</a><a href="#food">地方风味</a><a href="#shorts">切片表达</a><a href="#images">素材对照</a><a href="#rules">发布检查</a><a href="#sources">依据</a></div></nav>'+intro
body+='<section id="script"><div class="wrap"><h2>02 / 可读、可拍、可核对的主片</h2><p>'+str(charcount)+'字（含标点） · 一倍正常语速目标小于10分钟 · 估算约'+str(round(duration/60,1))+'分钟，最终以重新生成音轨为准。</p><div class="tools"><input id="search" aria-label="搜索村名或场景" placeholder="搜索村名 / 场景"><button data-filter="all">全部</button><button class="outline" data-filter="overview">全镇总起</button><button class="outline" data-filter="child">21村分述</button><button class="outline" data-filter="outro">结尾</button><button class="outline" onclick="window.print()">打印</button></div>'+''.join(scene_html)+'</div></section>'
body+='<section id="food"><div class="wrap"><h2>03 / 风味，不编探店榜</h2>'+food+'</div></section><section id="shorts"><div class="wrap"><h2>04 / 主片之外的四组切片</h2>'+shorts+'<p class="meta">建议标题：①《雷州龙门：酱缸旁，为什么还有一块银幕》 ②《果蔬走远，乡音留下：龙门21村》 ③《别把潮溪和王家算成两个行政村》。建议话题：#雷州市龙门镇 #足荣村 #大牛岭菠萝 #九斗红橙 #雷州乡音。以上为创作建议，不承诺播放量、投放通过率或收益。</p></div></section>'
body+='<section id="images"><div class="wrap"><h2>05 / 真实图片墙与取舍</h2><div class="grid">'+''.join(figure(a) for a in assets)+'</div><div class="note"><b>明确不用：</b>带相关纪念文字的足荣入口牌、村委机关门面、电话二维码招牌、廉江公司错挂照片、浙江仙人洞水印照、菠萝冒充红橙、普通老屋弱图，以及游客临水站石的瀑布照片。高德POI定位正确，不代表每张用户上传照片都正确。</div><div class="tablewrap"><table><thead><tr><th>村庄覆盖</th><th>照片状态</th><th>执行方式</th></tr></thead><tbody><tr><td>足荣 / 王家（潮溪） / 潭边</td><td>3村有审查后照片</td><td>同村照片只表达对应对象，不夸大为全村航拍或全部景点</td></tr><tr><td>其余18个行政村</td><td>暂无合格强素材</td><td>工作台保留地图与独立旁白；按各村拍摄说明补拍，不标“配图完成”</td></tr><tr><td>地方菜肴 / 菠萝 / 红橙 / 圩市</td><td>真实成菜及动作镜头待补</td><td>现场确认产地、菜名、授权及禁用内容；无图则不使用通用照片</td></tr></tbody></table></div></div></section>'
body+='''<section id="rules"><div class="wrap"><h2>06 / 发布与加热前的最后一道检查</h2><div class="cards"><div class="card"><h3>文案</h3><p>不用绝对化排名、虚构名人背书、未经验证的本地共识、功效宣传和财富承诺。统计注明年份，计划注明“计划”，建筑历史不用传闻填空。</p></div><div class="card"><h3>画面</h3><p>逐帧复查禁用标识、机关人物、电话、二维码、未成年人、肖像及危险行为。网络图保留来源水印，不通过去水印掩盖版权。</p></div><div class="card"><h3>权利</h3><p>报道照片、高德用户照片、音乐、电影片段都需相应授权。人物出镜另核实肖像许可；未经许可不使用名人或工作人员形象作商业推荐。</p></div><div class="card"><h3>平台</h3><p>本方案按社区真实性与DOU+要求做保守设计，不代表平台预审通过。发布前复核当前规则与加热类别；自然发布可用，不自动等于可加热。</p></div></div><p class="meta">工作台采用天地图影像选项；若本机缺少该服务凭证，地图预览仍需配置。未修改旧方案地图设置，未生成新音轨，未导出MP4。</p></div></section>'''
body+='<section id="sources"><div class="wrap"><h2>07 / 事实与图片依据</h2>'+source_html+'</div></section><footer class="wrap">雷州市龙门镇 · 图文策划核实版 · 2026-11-12。参考岭北素材对照结构与吴阳策划章节组织；未复用两镇照片。本文脚本之外的拍摄说明、取舍记录不进入口播。</footer>'
body+='''<script>let group='all';const q=document.getElementById('search');function filter(){document.querySelectorAll('.scene').forEach(x=>{x.classList.toggle('hidden',(group!=='all'&&x.dataset.group!==group)||!x.textContent.includes(q.value.trim()))})}q.addEventListener('input',filter);document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{group=b.dataset.filter;filter()}));</script></body></html>'''
assert '\u53cd\u5dee' not in body
main=OUT/'雷州市龙门镇-抖音图文策划-20261112.html'
main.write_text(body,encoding='utf-8')
comparison=head.replace('雷州市龙门镇｜酱缸与乡音 · 图文策划','雷州市龙门镇 · 场景素材对照表')+'<header><div class="wrap"><div class="eyebrow">LONGMEN / SCENE MATERIALS</div><h1>龙门镇<br><em>逐场素材对照</em></h1><p class="lead">旁白与主方案完全一致，一图一场，空缺如实标出。'+str(len(assets))+'张合格本地候选，21村中3村有实景、18村待补。商用授权未完成。</p></div></header><main class="wrap">'+''.join(scene_html)+'</main><footer class="wrap">照片全部离线内嵌。来源链接可在对应场景打开；没有拿其他乡镇照片顶替。</footer></body></html>'
(OUT/'雷州市龙门镇-场景素材对照表-20261112.html').write_text(comparison,encoding='utf-8')
report={'projectId':PID,'revision':saved['revision'],'name':saved['name'],'scenes':len(saved['scenes']),'villages':21,'assets':len(assets),'villagesWithPhotos':photo_children,'villagesAwaitingPhotos':21-photo_children,'characters':charcount,'estimatedSeconds':duration,'ttsGenerated':False,'html':str(main)}
(ROOT/'workspace/projects'/(PID+'.delivery-check.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
