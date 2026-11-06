import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { buildProvinceCatalog, filterAdminDivisions, parseDbfBuffer, parseDbfHeader } from "../apps/studio/admin-catalog.js";
import { makeProject } from "../apps/studio/project-service.js";

const root = resolve(process.cwd());

function tinyDbf(): Buffer {
  const fields = [{ name: "PAC", length: 12 }, { name: "NAME", length: 12 }];
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((sum, field) => sum + field.length, 0);
  const buffer = Buffer.alloc(headerLength + recordLength + 1, 0x20);
  buffer[0] = 0x03; buffer.writeUInt32LE(1, 4); buffer.writeUInt16LE(headerLength, 8); buffer.writeUInt16LE(recordLength, 10);
  let offset = 32;
  for (const field of fields) {
    buffer.write(field.name, offset, "ascii"); buffer[offset + 11] = "C".charCodeAt(0); buffer[offset + 16] = field.length; offset += 32;
  }
  buffer[headerLength - 1] = 0x0d; buffer[headerLength] = 0x20;
  buffer.write("440825112201", headerLength + 1, "ascii"); buffer.write("Xinliao", headerLength + 13, "ascii");
  buffer[buffer.length - 1] = 0x1a;
  return buffer;
}

test("DBF reader parses fixed-width administrative attributes without loading SHP geometry", () => {
  const buffer = tinyDbf();
  const header = parseDbfHeader(buffer, new TextDecoder("utf-8"));
  assert.equal(header.recordCount, 1);
  assert.deepEqual(header.fields.map((field) => field.name), ["PAC", "NAME"]);
  assert.deepEqual(parseDbfBuffer(buffer, "utf-8"), [{ PAC: "440825112201", NAME: "Xinliao" }]);
});

test("Guangdong village DBF produces province-city-county-town cascade for Xinliao", async () => {
  const sourceRoot = resolve(root, "data", "regions", "01【25096】全国村级行政边界数据");
  const nodes = await buildProvinceCatalog(sourceRoot, "44", new Set(["440825112"]));
  const xinliao = nodes.find((node) => node.code === "440825112");
  assert.ok(xinliao);
  assert.equal(xinliao.name, "新寮镇");
  assert.equal(xinliao.parentCode, "440825");
  assert.equal(xinliao.cityCode, "440800");
  assert.equal(xinliao.villageCount, 10);
  assert.equal(xinliao.productionReady, true);
  assert.equal(xinliao.idField, "PAC");
  assert.equal(xinliao.nameField, "NAME");
  assert.equal(xinliao.townField, "乡镇码");
  assert.match(xinliao.breadcrumb, /广东省.*湛江市.*徐闻县.*新寮镇/);
  assert.deepEqual(filterAdminDivisions(nodes, "新寮镇").map((node) => node.code), ["440825112"]);
});

test("an automatically generated town plan restores real child boundaries and editable scenes", async () => {
  const project = await makeProject(root, "440825107");
  const childScenes = project.scenes.filter((scene) => scene.section === "child");
  assert.equal(project.name, "下桥镇地理图说");
  assert.equal(childScenes.length, 11);
  assert.ok(childScenes.every((scene) => scene.camera?.transition === "fly"));
  assert.ok(childScenes.every((scene) => /等待补充/.test(scene.narration)));
  assert.equal(project.assets.length, 0);
});

test("an unprepared catalog town cannot silently fall back to Xinliao project content", async () => {
  await assert.rejects(makeProject(root, "440825999"), /尚未生成可制作的内容项目/);
});
