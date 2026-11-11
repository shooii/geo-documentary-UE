import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { buildRenderSpec } from "../packages/render-spec/index.js";
import { makeProject } from "../apps/studio/project-service.js";
import { effectiveMapView, isDefaultMapView, type MapView, type VideoProject } from "../packages/project-schema/index.js";

const root = resolve(process.cwd());

const OFFSET_VIEW: MapView = { longitudeOffset: 0.5, latitudeOffset: 0, zoom: 1, headingOffset: 0, pitchOffset: 0 };
const OTHER_VIEW: MapView = { longitudeOffset: -1.2, latitudeOffset: 0.3, zoom: 1.4, headingOffset: 5, pitchOffset: -3 };

type RenderSpecLike = { mapViewTrack?: Array<{ start: number; view: MapView | null }> | undefined };

test("全局视角判定：全默认值等于未设置", () => {
  assert.equal(isDefaultMapView(undefined), true);
  assert.equal(isDefaultMapView(null), true);
  assert.equal(isDefaultMapView({ longitudeOffset: 0, latitudeOffset: 0, zoom: 1, headingOffset: 0, pitchOffset: 0 }), true);
  assert.equal(isDefaultMapView({ longitudeOffset: 0, latitudeOffset: 0, zoom: 1.05, headingOffset: 0, pitchOffset: 0 }), false);
  assert.deepEqual(effectiveMapView({ longitudeOffset: 0, latitudeOffset: 0, zoom: 1, headingOffset: 0, pitchOffset: 0 }), undefined);
  assert.deepEqual(effectiveMapView(OFFSET_VIEW), OFFSET_VIEW);
});

test("导出轨道：场景视角优先，未设置的场景回落全局，都没有才是自动取景", async () => {
  const project = await makeProject(root, "440825112");
  // spokenViews 按「非 cover 场景」的顺序设置（与轨道 range 一致）。
  const withView = (templateMapView: MapView | undefined, spokenViews: Array<MapView | undefined>): RenderSpecLike => {
    let spokenIndex = 0;
    const scenes = project.scenes.map((scene) => {
      if (scene.section === "cover") return scene;
      const view = spokenViews[spokenIndex];
      const label = `旁白文本第${spokenIndex + 1}段`;
      spokenIndex += 1;
      return { ...scene, narration: label, subtitle: label, ...(view ? { mapView: view } : {}) };
    });
    const spoken = scenes.filter((scene) => scene.section !== "cover");
    return buildRenderSpec({
      project: { ...project, template: { ...project.template, ...(templateMapView ? { mapView: templateMapView } : {}) }, scenes } as VideoProject,
      cues: spoken.map((scene, index) => ({ index, start: index, end: index + 1, text: String(scene.narration) })),
      geometrySignature: "test",
      narrationDurationSeconds: spoken.length
    }) as unknown as RenderSpecLike;
  };

  // 没有任何视角：无轨道（自动取景）。
  assert.equal(withView(undefined, [undefined, undefined, undefined]).mapViewTrack, undefined);
  // 只有全局：未设置的场景全部回落全局。
  const globalOnly = withView(OFFSET_VIEW, [undefined, undefined, undefined]);
  assert.ok(globalOnly.mapViewTrack && globalOnly.mapViewTrack.length > 0);
  for (const entry of globalOnly.mapViewTrack!) assert.deepEqual(entry.view, OFFSET_VIEW);
  // 场景视角覆盖全局：设置了的场景用自己的值，未设置的用全局。
  const mixed = withView(OFFSET_VIEW, [OTHER_VIEW, undefined, undefined]);
  assert.deepEqual(mixed.mapViewTrack![0]!.view, OTHER_VIEW);
  assert.deepEqual(mixed.mapViewTrack![1]!.view, OFFSET_VIEW);
  // 全局是全默认值 = 未设置：场景也没有时不生成轨道。
  assert.equal(withView({ longitudeOffset: 0, latitudeOffset: 0, zoom: 1, headingOffset: 0, pitchOffset: 0 }, [undefined, undefined, undefined]).mapViewTrack, undefined);
  // 没有全局但场景有视角：保持旧行为，未设置场景为 null（自动取景）。
  const sceneOnly = withView(undefined, [OTHER_VIEW, undefined, undefined]);
  assert.deepEqual(sceneOnly.mapViewTrack![0]!.view, OTHER_VIEW);
  assert.equal(sceneOnly.mapViewTrack![1]!.view, null);
});
