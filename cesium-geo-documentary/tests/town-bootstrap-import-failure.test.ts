import test from "node:test";
import assert from "node:assert/strict";
import { townImportFailureMessage } from "../apps/studio/town-bootstrap.js";

// 草潭镇 (440823113) aborted project creation with
//   自动提取乡镇边界失败（exit 1）：{"ok": false, "regionId": "440823113", ...}
// - the importer's JSON payload, but not its cause and not a next step. The
// importer now explains itself in a `message` field and the studio prefers it
// verbatim, because that string is what the operator reads in the toast.

test("the importer's own explanation is shown to the operator verbatim", () => {
  const explanation =
    "自动提取乡镇边界失败：村级图斑拼不成有效覆盖：0.220 平方米缝隙、0.232 平方米图斑重叠（占区域面积 1.6e-09），已按 5 厘米精度尝试修复仍未通过。请人工核对源边界数据后重试，诊断报告：renders/diagnostics/440823113-shapefile-import.json";
  const stdout = JSON.stringify({
    ok: false,
    regionId: "440823113",
    features: 21,
    report: "renders/diagnostics/440823113-shapefile-import.json",
    message: explanation
  });

  assert.equal(townImportFailureMessage(1, stdout, ""), explanation);
});

test("a payload without a message still names the exit code instead of hiding the streams", () => {
  const stdout = JSON.stringify({ ok: false, regionId: "440823113", features: 21 });
  const message = townImportFailureMessage(1, stdout, "");

  assert.match(message, /^自动提取乡镇边界失败（exit 1）：/);
  assert.ok(message.includes("440823113"), "the raw payload must survive so nothing is swallowed");
});

test("a crash before the JSON is printed falls back to the raw stderr", () => {
  const message = townImportFailureMessage(2, "", "Traceback (most recent call last):\nModuleNotFoundError: No module named 'shapely'\n");

  assert.equal(
    message,
    "自动提取乡镇边界失败（exit 2）：Traceback (most recent call last):\nModuleNotFoundError: No module named 'shapely'"
  );
});

test("an empty message field is treated as absent, not as the whole failure", () => {
  const stdout = JSON.stringify({ ok: false, features: 21, message: "   " });
  const message = townImportFailureMessage(1, stdout, "");

  assert.match(message, /^自动提取乡镇边界失败（exit 1）：/);
});
