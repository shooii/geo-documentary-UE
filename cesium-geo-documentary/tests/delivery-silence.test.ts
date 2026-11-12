import test from "node:test";
import assert from "node:assert/strict";
import { unexpectedSilenceEvents } from "../.agents/skills/cesium-geo-documentary/scripts/delivery-silence.js";

const event = (start: number, end: number) => [`[silencedetect] silence_start: ${start}`, `[silencedetect] silence_end: ${end} | silence_duration: ${end - start}`];
const outro = { start: 518.024, end: 522.424 };

test("正式成品封面与显式片尾回拉静音均按配对窗口验证", () => {
  assert.deepEqual(unexpectedSilenceEvents([...event(0, 2.03494), ...event(517.595, 522.526)], 1.95, outro), []);
  assert.equal(unexpectedSilenceEvents(event(517.595, 522.526), 1.95).length, 2);
});

test("窗口之外、跨过旁白和未闭合静音仍拒绝", () => {
  for (const [start, end] of [[10, 12], [516, 522], [517, 524], [0, 3], [0.1, 2]]) {
    assert.equal(unexpectedSilenceEvents(event(start!, end!), 1.95, outro).length, 2);
  }
  assert.equal(unexpectedSilenceEvents([event(517.595, 522.526)[0]!], 1.95, outro).length, 1);
  assert.equal(unexpectedSilenceEvents([event(517.595, 522.526)[1]!], 1.95, outro).length, 1);
});
