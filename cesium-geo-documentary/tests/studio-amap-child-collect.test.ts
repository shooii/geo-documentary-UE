import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { importAmapPoiMaterials } from "../apps/studio/amap-materials.js";
import { makeProject } from "../apps/studio/project-service.js";
import type { StudioAsset, StudioScene } from "../packages/project-schema/index.js";

const root = resolve(process.cwd());
const REGION = "440825106";
const VILLAGE_A = "440825106201";
const VILLAGE_B = "440825106204";

async function fixture(): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "geo-amap-child-"));
  await mkdir(join(temporaryRoot, "data", "regions"), { recursive: true });
  await mkdir(join(temporaryRoot, "data", "normalized"), { recursive: true });
  await copyFile(join(root, "data", "regions", `${REGION}.json`), join(temporaryRoot, "data", "regions", `${REGION}.json`));
  await copyFile(join(root, "data", "normalized", `${REGION}-children.geojson`), join(temporaryRoot, "data", "normalized", `${REGION}-children.geojson`));
  return temporaryRoot;
}

/**
 * Answers every polygon query with zero POIs and no photos. The unbind rule and
 * the coverage merge are pure bookkeeping over the project, so they can be
 * tested without coaxing real polygon geometry into returning a fixture point.
 */
function emptyAmap(counter: { calls: number }): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input.toString() : input.url);
    if (url.hostname === "restapi.amap.com") {
      counter.calls += 1;
      return new Response(JSON.stringify({ status: "1", count: "0", pois: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`Unexpected URL ${url}`);
  }) as typeof fetch;
}

type SourceType = NonNullable<StudioAsset["sourceType"]>;

function photo(id: string, childId: string, sourceType: SourceType, typeCode: string): StudioAsset {
  return {
    id, name: id, path: `/workspace-assets/${id}.jpg`, type: "image", sourceType,
    verifiedReal: true, prohibitedContent: false, alt: id,
    scope: { regionId: REGION, childId },
    ...(sourceType === "amap-poi"
      ? { poi: { provider: "amap" as const, poiId: id, poiName: id, poiType: "风景名胜", poiTypeCode: typeCode, childId, childName: id, photoIndex: 0, photoTitle: "", retrievedAt: "2026-09-18T00:00:00.000Z" } }
      : {})
  };
}

type Placement = NonNullable<StudioScene["placements"]>[number];

function bind(scene: StudioScene, assetId: string): void {
  const placements = (scene.placements ||= []);
  placements.push({ assetId } as Placement);
  scene.assetIds = [...(scene.assetIds || []), assetId];
}

const boundIds = (scene: StudioScene) => (scene.placements || []).map((placement) => placement.assetId);

function seed(project: Awaited<ReturnType<typeof makeProject>>) {
  const villageA = project.scenes.find((scene) => scene.childId === VILLAGE_A)!;
  const villageB = project.scenes.find((scene) => scene.childId === VILLAGE_B)!;
  const scenery = photo("a-scenery", VILLAGE_A, "amap-poi", "110000");
  const cafe = photo("a-cafe", VILLAGE_A, "amap-poi", "050100");
  const elsewhere = photo("b-scenery", VILLAGE_B, "amap-poi", "110000");
  const upload = photo("a-upload", VILLAGE_A, "user-provided", "110000");
  project.assets = [scenery, cafe, elsewhere, upload];
  bind(villageA, scenery.id); bind(villageA, cafe.id); bind(villageA, upload.id); bind(villageB, elsewhere.id);
  return { villageA, villageB, scenery, cafe, elsewhere, upload };
}

test("a village-scoped run only queries the village it was asked for", async () => {
  const temporaryRoot = await fixture();
  const counter = { calls: 0 };
  const project = await makeProject(root, REGION);
  const result = await importAmapPoiMaterials(temporaryRoot, project, {
    enabled: true, apiKey: "test-key", typeCodes: ["110000"], childIds: [VILLAGE_A]
  }, emptyAmap(counter));

  assert.equal(counter.calls, 1, "one village means one polygon query, not one per village in the town");
  assert.deepEqual(result.summary.children.map((row) => row.childId), [VILLAGE_A]);
});

test("a village-scoped run keeps the coverage of every other village", async () => {
  const temporaryRoot = await fixture();
  const counter = { calls: 0 };
  const project = await makeProject(root, REGION);
  const everything = await importAmapPoiMaterials(temporaryRoot, project, {
    enabled: true, apiKey: "test-key", typeCodes: ["110000"]
  }, emptyAmap(counter));
  assert.ok(everything.summary.children.length > 1, "the create path covers every child boundary");

  const scoped = await importAmapPoiMaterials(temporaryRoot, everything.project, {
    enabled: true, apiKey: "test-key", typeCodes: ["110000"], keyword: "渔港", childIds: [VILLAGE_A]
  }, emptyAmap(counter));

  assert.equal(scoped.summary.children.length, everything.summary.children.length, "a scoped run must not erase the rows it never looked at");
  const before = new Map(everything.summary.children.map((row) => [row.childId, row]));
  for (const row of scoped.summary.children) {
    if (row.childId === VILLAGE_A) continue;
    assert.deepEqual(row, before.get(row.childId));
  }
  assert.equal(scoped.summary.keyword, "渔港", "the summary describes the run that just happened");
});

test("unbind detaches only this village's photos inside the requested type groups", async () => {
  const temporaryRoot = await fixture();
  const project = await makeProject(root, REGION);
  const { villageA, villageB, scenery, cafe, elsewhere, upload } = seed(project);

  const result = await importAmapPoiMaterials(temporaryRoot, project, {
    enabled: true, apiKey: "test-key", typeCodes: ["110000"], childIds: [VILLAGE_A], mode: "unbind"
  }, emptyAmap({ calls: 0 }));

  assert.equal(result.unboundPlacements, 1);
  assert.deepEqual(boundIds(villageA), [cafe.id, upload.id], "only the theme being re-collected leaves the village");
  assert.deepEqual(boundIds(villageB), [elsewhere.id], "another village is never touched even in the same type group");
  // The record stays in the library: it is shared stock, and keeping the id means a
  // photo that comes back re-binds to the same asset instead of minting a new one.
  assert.deepEqual(
    result.project.assets.map((asset) => asset.id).sort(),
    [cafe.id, scenery.id, elsewhere.id, upload.id].sort()
  );
});

test("the default mode only ever adds, so the create path is unchanged", async () => {
  const temporaryRoot = await fixture();
  const project = await makeProject(root, REGION);
  const { villageA, scenery, cafe, upload } = seed(project);

  const result = await importAmapPoiMaterials(temporaryRoot, project, {
    enabled: true, apiKey: "test-key", typeCodes: ["110000"], childIds: [VILLAGE_A]
  }, emptyAmap({ calls: 0 }));

  assert.equal(result.unboundPlacements, 0);
  assert.deepEqual(boundIds(villageA), [scenery.id, cafe.id, upload.id]);
});

test("a child id that matches no scene is refused instead of quietly doing nothing", async () => {
  const temporaryRoot = await fixture();
  const project = await makeProject(root, REGION);
  await assert.rejects(
    () => importAmapPoiMaterials(temporaryRoot, project, {
      enabled: true, apiKey: "test-key", typeCodes: ["110000"], childIds: ["999999999999"]
    }, emptyAmap({ calls: 0 })),
    /没有匹配的下级行政区场景/
  );
});
