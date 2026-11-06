import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AMAP_POI_TYPES, importAmapPoiMaterials, pointInFeature, wgs84ToGcj02 } from "../apps/studio/amap-materials.js";
import { makeProject } from "../apps/studio/project-service.js";
import { buildRenderSpec } from "../packages/render-spec/index.js";

const root = resolve(process.cwd());

test("AMap material options expose all official level-one POI categories", () => {
  assert.equal(AMAP_POI_TYPES.length, 20);
  assert.deepEqual(AMAP_POI_TYPES.map((item) => item.code), [
    "010000", "020000", "030000", "040000", "050000",
    "060000", "070000", "080000", "090000", "100000",
    "110000", "120000", "130000", "140000", "150000",
    "160000", "170000", "180000", "190000", "200000"
  ]);
});

test("point-in-boundary honors polygon holes", () => {
  const feature = { type: "Feature" as const, geometry: { type: "Polygon" as const, coordinates: [
    [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
    [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]
  ] } };
  assert.equal(pointInFeature({ lng: 2, lat: 2 }, feature), true);
  assert.equal(pointInFeature({ lng: 5, lat: 5 }, feature), false);
  assert.equal(pointInFeature({ lng: 12, lat: 2 }, feature), false);
});

test("AMap import uses every returned photo and binds it only to the matching child boundary", async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "geo-amap-test-"));
  await mkdir(join(temporaryRoot, "data", "regions"), { recursive: true });
  await mkdir(join(temporaryRoot, "data", "normalized"), { recursive: true });
  await copyFile(join(root, "data", "regions", "440825106.json"), join(temporaryRoot, "data", "regions", "440825106.json"));
  await copyFile(join(root, "data", "normalized", "440825106-children.geojson"), join(temporaryRoot, "data", "normalized", "440825106-children.geojson"));
  const project = await makeProject(root, "440825106");
  const inside = wgs84ToGcj02(109.9323067, 20.3771338);
  let amapRequests = 0;
  let imageRequests = 0;
  const mockFetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.hostname === "restapi.amap.com") {
      amapRequests += 1;
      return new Response(JSON.stringify({
      status: "1", count: "1", pois: [{ id: "poi-1", name: "西连村示例点", type: "风景名胜", typecode: "110000", location: `${inside.lng},${inside.lat}`,
        photos: [{ title: "一", url: "https://img.example/1.jpg" }, { title: "二", url: "https://img.example/2.jpg" }, { title: "三", url: "https://img.example/3.jpg" }] }]
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.hostname === "img.example") {
      imageRequests += 1;
      // AMap's image CDN can label a valid JPEG as a generic binary stream.
      return new Response(new Uint8Array([255, 216, 255, 217]), { status: 200, headers: { "content-type": "application/octet-stream" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  const imported = await importAmapPoiMaterials(temporaryRoot, project, { enabled: true, apiKey: "test-key", typeCodes: ["110000"] }, mockFetch as typeof fetch);
  assert.equal(imported.summary.totalPhotos, 3);
  assert.equal(imported.project.assets.length, 3);
  const target = imported.project.scenes.find((scene) => scene.childId === "440825106201")!;
  assert.equal(target.placements?.length, 3);
  assert.ok(imported.project.scenes.filter((scene) => scene.section === "child" && scene.childId !== "440825106201").every((scene) => !scene.placements?.length));
  assert.ok(imported.project.assets.every((asset) => asset.scope?.childId === "440825106201" && asset.poi?.childName === "西连村"));
  assert.equal((await readdir(join(temporaryRoot, "workspace", "assets"))).filter((name) => name.endsWith(".asset.json")).length, 3);

  const requestCounts = { amapRequests, imageRequests };
  const importedAgain = await importAmapPoiMaterials(temporaryRoot, imported.project, { enabled: true, apiKey: "test-key", typeCodes: ["110000"] }, mockFetch as typeof fetch);
  assert.deepEqual({ amapRequests, imageRequests }, requestCounts, "a repeated import should be served entirely from caches");
  assert.equal(importedAgain.project.assets.length, 3, "cached photos must not create duplicate project assets");
  assert.equal(target.assetIds?.length, 3);
  assert.equal(target.placements?.length, 3);

  const range = { index: 0, start: 0, end: 6, text: target.narration };
  const isolatedProject = { ...imported.project, scenes: [
    imported.project.scenes.find((scene) => scene.section === "cover")!,
    target,
    imported.project.scenes.find((scene) => scene.section === "outro")!
  ] };
  const outro = isolatedProject.scenes[2]!;
  const spec = buildRenderSpec({
    project: isolatedProject,
    cues: [range, { index: 1, start: 6, end: 8, text: outro.narration }],
    geometrySignature: "test"
  });
  assert.deepEqual(spec.assets.map((asset) => [asset.sequenceIndex, asset.sequenceCount]), [[0, 3], [1, 3], [2, 3]]);
});
