import { test } from "node:test";
import assert from "node:assert/strict";
import { countNarrationSentences } from "../apps/studio/render-engine.js";

test("countNarrationSentences splits on Chinese sentence punctuation", () => {
  assert.equal(
    countNarrationSentences("在广东省湛江市徐闻县，西连镇静静地躺在那里。这片土地被分成十八个村落，每个村子都有自己的故事。"),
    2
  );
  assert.equal(
    countNarrationSentences("镜头穿过云层缓缓降落，西连镇的轮廓逐渐清晰。我们将沿着真实的边界，探访每一个村庄。"),
    2
  );
});

test("countNarrationSentences handles one-sentence child and outro paragraphs", () => {
  assert.equal(
    countNarrationSentences("龙腋村是西连镇的一部分，村中可见基督教龙腋堂和龙腋中村小公园，还有瑞记鱼苗场，展现着当地的生活气息。"),
    1
  );
  assert.equal(
    countNarrationSentences("从最后的村级区域拉回西连镇全景，这片土地的故事还在继续。"),
    1
  );
});

test("countNarrationSentences treats exclamation, question, semicolon and ellipsis as boundaries", () => {
  assert.equal(countNarrationSentences("多美啊！这就是西连。"), 2);
  assert.equal(countNarrationSentences("你见过吗？这里是瓜藤村。"), 2);
  assert.equal(countNarrationSentences("往东是海；往西是田。村子居中。"), 3);
  assert.equal(countNarrationSentences("故事还在继续……"), 1);
});

test("countNarrationSentences ignores line breaks and trailing closers without inventing sentences", () => {
  assert.equal(countNarrationSentences("第一句。\n第二句。"), 2);
  assert.equal(countNarrationSentences("他说：“好的。”然后离开了。"), 2);
  assert.equal(countNarrationSentences(""), 0);
  assert.equal(countNarrationSentences("只有一句"), 1); // a terminator-less paragraph counts as one sentence
  assert.equal(countNarrationSentences("。\n。"), 0); // punctuation alone never counts
});
