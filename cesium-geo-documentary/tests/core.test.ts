import test from "node:test";
import assert from "node:assert/strict";
import { bboxFromCoordinates, recommendedCameraHeight, sphericalRingAreaKm2 } from "../packages/geo-utils/index.js";
import { SceneTimelineSchema } from "../packages/timeline-schema/index.js";
import { buildDisplayCues, buildSingleLineCues, normalizeSubtitleSemantics, timelineValues } from "../packages/content-engine/subtitles.js";

test("geospatial utilities calculate stable bounding boxes and camera heights", () => {
  const bbox = bboxFromCoordinates([[110.1, 21.1], [110.6, 21.5], [110.3, 20.9]]);
  assert.deepEqual(bbox, [110.1, 20.9, 110.6, 21.5]);
  const height = recommendedCameraHeight(bbox);
  assert.ok(height >= 35_000 && height <= 900_000);
});

test("spherical area returns a positive result for a closed ring", () => {
  const area = sphericalRingAreaKm2([[110, 21], [110.1, 21], [110.1, 21.1], [110, 21.1], [110, 21]]);
  assert.ok(area > 100 && area < 130);
});

test("timeline schema rejects actions that exceed composition duration", () => {
  const result = SceneTimelineSchema.safeParse({
    duration: 10,
    actions: [{ id: "camera", time: 8, duration: 3, type: "flyToRegion", target: "440800", easing: "linear" }]
  });
  assert.equal(result.success, false);
});

test("subtitle segmentation preserves all text with at most two bounded lines", () => {
  const text = "海岸、港区、街道与岛屿相互嵌合，使这里同时拥有城市密度和开阔海景。";
  const display = buildDisplayCues([{ start: 5.687, end: 13.35, text }], 14);
  assert.equal(display.map((cue) => cue.text).join(""), text);
  assert.ok(display.length >= 2);
  for (const cue of display) {
    assert.ok(cue.lines.length <= 2);
    assert.ok(cue.lines.every((line) => [...line].length <= 14));
  }
});

test("subtitle wrapping does not place punctuation at the start of a line", () => {
  const samples = [
    "2024年末遂溪常住人口89.31万，广阔平原与密集乡镇构成县域主要聚落格局。",
    "一二三四五六七八九十一二三四五六七八。"
  ];
  for (const text of samples) {
    const display = buildDisplayCues([{ start: 8, end: 15, text }], 18);
    assert.equal(display.map((cue) => cue.text).join(""), text);
    assert.ok(display.every((cue) => cue.lines.every((line) => !"，；。！？、：".includes(line[0] ?? ""))));
    assert.ok(display.every((cue) => cue.lines.every((line) => [...line].length <= 18)));
  }
});

test("single-line subtitle mode preserves text without line breaks", () => {
  const text = "2025年湛江地区生产总值3952.94亿元，港口与临港产业共同发展。";
  const display = buildSingleLineCues([{ start: 17, end: 24, text }], 26);
  assert.equal(normalizeSubtitleSemantics(display.map((cue) => cue.text).join("")), normalizeSubtitleSemantics(text));
  assert.ok(display.length >= 2);
  assert.ok(display.every((cue) => cue.lines.length === 1));
  assert.ok(display.every((cue) => [...(cue.lines[0] ?? "")].length <= 26));
});

test("single-line subtitles rebalance short machine-like tail fragments", () => {
  const text = "小棚虾和海水养殖连接成片，红衣花生、板栗番薯和海水稻丰富了岛上农业，";
  const display = buildSingleLineCues([{ start: 46, end: 58, text }], 14);
  assert.equal(normalizeSubtitleSemantics(display.map((cue) => cue.text).join("")), normalizeSubtitleSemantics(text));
  assert.ok(display.every((cue) => [...cue.text].length <= 14));
  assert.ok(display.every((cue) => [...cue.text].length >= 4));
  assert.ok(display.every((cue) => !"，；。！？、：".includes(cue.text[0] ?? "")));
});

test("single-line subtitles keep numbers with their units and measure phrases", () => {
  const text = "截至2025年，全镇常住人口有43210人，耕地约3.2万亩。";
  const display = buildSingleLineCues([{ start: 10, end: 18, text }], 14);
  assert.equal(normalizeSubtitleSemantics(display.map((cue) => cue.text).join("")), normalizeSubtitleSemantics(text));
  assert.ok(display.some((cue) => cue.text.includes("2025年")));
  assert.ok(display.some((cue) => cue.text.includes("有43210人")));
  assert.ok(display.some((cue) => cue.text.includes("3.2万亩")));
  assert.ok(display.every((cue) => [...cue.text].length <= 14));
  assert.ok(display.every((cue) => !"，；。！？、：,.!?;:".includes(cue.text[0] ?? "")));
});

test("single-line subtitles keep Chinese numerals and statistical labels intact", () => {
  const text = "二零一九年末，全镇户籍人口三万四千二百四十七人，下辖十个行政村。";
  const display = buildSingleLineCues([{ start: 10, end: 20, text }], 14);
  assert.equal(normalizeSubtitleSemantics(display.map((cue) => cue.text).join("")), normalizeSubtitleSemantics(text));
  assert.ok(display.some((cue) => cue.text.includes("户籍人口")));
  assert.ok(display.some((cue) => cue.text.includes("三万四千二百四十七人")));
  assert.ok(display.some((cue) => cue.text.includes("十个行政村")));
  assert.ok(display.every((cue) => !cue.text.endsWith("户籍人")));
  assert.ok(display.every((cue) => [...cue.text].length <= 14));
});

test("single-line subtitle tail balancing keeps a dominant measurement phrase whole", () => {
  const text = "行政区域面积一百四十四平方千米。";
  const display = buildSingleLineCues([{ start: 0, end: 6, text }], 14, ["一百四十四平方千米"]);
  assert.deepEqual(display.map((cue) => cue.text), ["行政区域", "面积一百四十四平方千米"]);
});

test("reviewed single-line overrides preserve speech while improving semantic phrasing", () => {
  const text = "番薯在这里既是产业，也是餐桌滋味，清蒸、烤制，还能做成番薯角、番薯粿和番薯芥菜煲。";
  const chunks = ["番薯在这里既是产业", "也是餐桌滋味", "清蒸、烤制，还能做成番薯角", "番薯粿和番薯芥菜煲"];
  const display = buildSingleLineCues([{ start: 0, end: 9, text }], 14, [], [{ cueIndex: 0, chunks }]);
  assert.deepEqual(display.map((cue) => cue.text), chunks);
  assert.equal(normalizeSubtitleSemantics(display.map((cue) => cue.text).join("")), normalizeSubtitleSemantics(text));
  assert.ok(display.every((cue) => [...cue.text].length <= 14));
  for (let index = 1; index < display.length; index += 1) {
    assert.equal(display[index - 1]?.end, display[index]?.start);
    const previous = timelineValues(display[index - 1]?.start ?? 0, display[index - 1]?.end ?? 0);
    const current = timelineValues(display[index]?.start ?? 0, display[index]?.end ?? 0);
    assert.ok(Number(previous.start) + Number(previous.duration) <= Number(current.start));
  }
});

test("reviewed single-line overrides reject changed spoken text", () => {
  assert.throws(
    () => buildSingleLineCues(
      [{ start: 0, end: 4, text: "第七次人口普查，常住人口为二万人。" }],
      14,
      [],
      [{ cueIndex: 0, chunks: ["常住人口为二万人"] }]
    ),
    /changes spoken semantic text/
  );
});

test("single-line subtitles prefer balanced lengths below the hard maximum", () => {
  const text = "沿海村庄与农田水网彼此连接形成紧凑而清晰的聚落格局";
  const display = buildSingleLineCues([{ start: 20, end: 28, text }], 14);
  assert.equal(display.map((cue) => cue.text).join(""), text);
  assert.ok(display.every((cue) => [...cue.text].length >= 4));
  assert.ok(display.every((cue) => [...cue.text].length <= 12));
});

test("single-line subtitles preserve topic names and editorial compound phrases", () => {
  const protectedPhrases = ["徐闻县和安镇", "革命老区", "水产养殖", "通往周边的道路", "地方底色"];
  const text = "部分自然村保留革命老区记忆，水产养殖连接通往周边的道路，这就是徐闻县和安镇的地方底色。";
  const display = buildSingleLineCues([{ start: 30, end: 42, text }], 14, protectedPhrases);
  assert.equal(normalizeSubtitleSemantics(display.map((cue) => cue.text).join("")), normalizeSubtitleSemantics(text));
  for (const phrase of protectedPhrases) assert.ok(display.some((cue) => cue.text.includes(phrase)), phrase);
  assert.ok(display.every((cue) => [...cue.text].length <= 14));
});

test("single-line subtitle cleanup does not split a protected final phrase to rebalance punctuation", () => {
  const protectedPhrase = "就是徐闻县和安镇的地方底色";
  const text = `九个村域彼此相邻，又各自连接海岸、田地和道路；这份不刻意修饰的秩序，${protectedPhrase}。`;
  const display = buildSingleLineCues([{ start: 177, end: 187, text }], 14, [protectedPhrase, "这份不刻意修饰的秩序"]);
  assert.ok(display.some((cue) => cue.text.includes(protectedPhrase)));
  assert.ok(display.every((cue) => [...cue.text].length >= 4));
  const exact = buildSingleLineCues([{ start: 187, end: 190, text: protectedPhrase }], 14, [protectedPhrase]);
  assert.deepEqual(exact.map((cue) => cue.text), [protectedPhrase]);
});

test("portrait subtitles keep documentary compound phrases intact", () => {
  const protectedPhrases = [
    "支援解放海南岛", "圩镇客厅", "连着日常生活", "拿下三项冠军",
    "圩镇更新同步推进", "南翼种养结合片区", "东西两侧村域"
  ];
  const samples = [
    "陈列从大革命时期到支援解放海南岛的图片和实物。",
    "河头市圩的街道、农贸市场和圩镇客厅连着日常生活。",
    "河头群兴龙狮团拿下三项冠军，锣鼓和高桩腾跃延续着醒狮传统。",
    "风电建设和圩镇更新同步推进，传统与新产业在这里并行。",
    "干塘村位于西南片区，是南翼种养结合片区的一部分。",
    "上坡村居于全镇中部，是东西两侧村域之间的联系节点。"
  ];
  for (const text of samples) {
    const display = buildSingleLineCues([{ start: 0, end: 8, text }], 14, protectedPhrases);
    assert.equal(normalizeSubtitleSemantics(display.map((cue) => cue.text).join("")), normalizeSubtitleSemantics(text));
    assert.ok(display.every((cue) => [...cue.text].length <= 14));
    for (const phrase of protectedPhrases.filter((value) => text.includes(value))) {
      assert.ok(display.some((cue) => cue.text.includes(phrase)), `${phrase}: ${display.map((cue) => cue.text).join(" / ")}`);
    }
  }
});

test("single-line subtitles may drop terminal punctuation to honor the hard maximum", () => {
  const phrase = "是东西两侧村域之间的联系节点";
  const display = buildSingleLineCues([{ start: 0, end: 4, text: `${phrase}。` }], 14, [phrase]);
  assert.deepEqual(display.map((cue) => cue.text), [phrase]);
  assert.ok(display.every((cue) => [...cue.text].length <= 14));
});

test("millisecond timeline values do not create rounded overlap", () => {
  const first = timelineValues(5.687, 7.2004);
  const second = timelineValues(7.2004, 9.1);
  assert.ok(Number(first.start) + Number(first.duration) <= Number(second.start));
});
