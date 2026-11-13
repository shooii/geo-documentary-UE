import {test} from 'node:test';
import assert from 'node:assert/strict';
import {triangulateFeature,boundaryAnimation,interiorLabelPoint} from '../apps/ue-player/boundary-style.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
test('boundary fills preserve polygon holes and multipart islands',()=>{
 const feature={geometry:{type:'MultiPolygon',coordinates:[[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[1,3],[3,3],[3,1],[1,1]]],[[[5,0],[6,0],[6,1],[5,1],[5,0]]]]}};
 const meshes=triangulateFeature(feature);assert.equal(meshes.length,2);
 let area=0;for(const mesh of meshes)for(let i=0;i<mesh.indices.length;i+=3){const a=mesh.indices[i]!*2,b=mesh.indices[i+1]!*2,c=mesh.indices[i+2]!*2,p=mesh.vertices;area+=Math.abs((p[b]!-p[a]!)*(p[c+1]!-p[a+1]!)-(p[c]!-p[a]!)*(p[b+1]!-p[a+1]!))/2;}
 assert.equal(area,13);
});
test('boundary light head makes one timed lap, then keeps orbiting a toured village',()=>{
 assert.equal(boundaryAnimation(4,5,'child').alpha,0);
 assert.equal(boundaryAnimation(5,5,'child').progress,0);
 assert.equal(boundaryAnimation(5.625,5,'child').progress,.5);
 // The sweep is over, but the village is still being toured: the beam keeps circling its
 // rim for the rest of the shot instead of leaving the boundary dead.
 assert.ok(boundaryAnimation(6.5,5,'child').alpha > 0);
 assert.ok(boundaryAnimation(6.5,5,'child').alpha < .60);
 assert.ok(Math.abs(boundaryAnimation(6.45,5,'child').alpha - boundaryAnimation(6.451,5,'child').alpha) < .001);
 assert.ok(Math.abs(boundaryAnimation(10,5,'child').alpha - .38) < 1e-9);
 assert.ok(boundaryAnimation(8,5,'child').progress>0);
 // The parent rim gets exactly one lap and then goes dark: there is no child to circle.
 assert.equal(boundaryAnimation(6.5,5,'').alpha,0);
 assert.equal(boundaryAnimation(8,5,'').alpha,0);
});

test('UE persistent rim visibility is independent of mesh focus, emphasis and sweep', async () => {
 const source = (await readFile(resolve('unreal/GeoDocumentary/Source/GeoDocumentary/GeoMap.cpp'), 'utf8')).replace(/\r\n/g, '\n');
 const visibility = source.slice(source.indexOf('TSet<FString> VisibleVillages;'), source.indexOf('for (const auto &Fill : Map->Fills)', source.indexOf('TSet<FString> VisibleVillages;')));
 assert.match(visibility, /TryGetArrayField\(TEXT\("visitedIds"\)/);
 assert.match(visibility, /VisibleVillages\.Add\(Current\)/);
 assert.match(visibility, /VisibleVillages\.Contains\(Ring\.Id\)/);
 assert.doesNotMatch(visibility, /BoundaryVisited\.Contains/);
 const base = source.slice(source.indexOf('if (!Stroke.Parent)\n        {\n            Style = 1;'), source.indexOf('// While the county flood layer'));
 assert.ok(base.length > 0);
 assert.match(base, /CopyWithNewOpacity\(float\(InteriorAlpha\)\)/);
 assert.doesNotMatch(base, /continue;|Stroke\.Touring|TraceAlpha/);
 assert.match(source, /if \(Run\.Emphasis > 0\.\)/);
 assert.match(source, /Strength = FMath::Max\(Strength, FMath::Clamp\(Stroke.Accent/);
 assert.ok(source.indexOf('FCanvasTriangleItem Lines(') < source.indexOf('FCanvasTriangleItem Highlight('));
 assert.ok(source.indexOf('FCanvasTriangleItem Highlight(') < source.indexOf('FCanvasTriangleItem Beam('));
});

test('label anchors use the interior center and never a point inside a hole', () => {
 const geometry = {
  type: 'Polygon',
  coordinates: [
   [[0, 0], [6, 0], [6, 6], [0, 6], [0, 0]],
   [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]
  ]
 };
 const point = interiorLabelPoint(geometry);
 assert.ok(point);
 const [x, y] = point;
 assert.ok(x > 0 && x < 6 && y > 0 && y < 6);
 assert.ok(x < 2 || x > 4 || y < 2 || y > 4);
});

test('label anchors stay inside a concave region instead of the bounding-box center', () => {
 const lShape = {
  type: 'Polygon',
  coordinates: [[[0, 0], [6, 0], [6, 2], [2, 2], [2, 6], [0, 6], [0, 0]]]
 };
 const point = interiorLabelPoint(lShape);
 assert.ok(point);
 const [x, y] = point;
 assert.ok(x >= 0 && x <= 6 && y >= 0 && y <= 6);
 assert.ok(x < 2 || y < 2);
 assert.ok(!(Math.abs(x - 3) < .25 && Math.abs(y - 3) < .25));
});

test('multipart region anchors the largest component, not a smaller wider island', () => {
 const main = [[0,0],[10,0],[10,2],[0,2],[0,0]];
 const island = [[20,0],[23,0],[23,3],[20,3],[20,0]];
 const point = interiorLabelPoint({ type:'MultiPolygon', coordinates:[[main],[island]] });
 assert.ok(point && point[0] > 3 && point[0] < 7 && point[1] > .5 && point[1] < 1.5);
});

test('triangulation fallback keeps a valid interior point for legacy callers', () => {
 const geometry = {
  type: 'Polygon',
  coordinates: [
   [[0, 0], [6, 0], [6, 6], [0, 6], [0, 0]],
   [[2, 2], [4, 2], [4, 4], [2, 4], [2, 2]]
  ]
 };
 const triangles = triangulateFeature({ geometry });
 const fallback = interiorLabelPoint(triangles, [3, 3]);
 assert.ok(fallback);
 const [x, y] = fallback;
 assert.ok(x > 0 && x < 6 && y > 0 && y < 6);
 assert.ok(x < 2 || x > 4 || y < 2 || y > 4);
});
