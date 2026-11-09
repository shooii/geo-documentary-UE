import {test} from 'node:test';
import assert from 'node:assert/strict';
import {triangulateFeature,boundaryAnimation,interiorLabelPoint} from '../apps/ue-player/boundary-style.js';
test('boundary fills preserve polygon holes and multipart islands',()=>{
 const feature={geometry:{type:'MultiPolygon',coordinates:[[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[1,3],[3,3],[3,1],[1,1]]],[[[5,0],[6,0],[6,1],[5,1],[5,0]]]]}};
 const meshes=triangulateFeature(feature);assert.equal(meshes.length,2);
 let area=0;for(const mesh of meshes)for(let i=0;i<mesh.indices.length;i+=3){const a=mesh.indices[i]!*2,b=mesh.indices[i+1]!*2,c=mesh.indices[i+2]!*2,p=mesh.vertices;area+=Math.abs((p[b]!-p[a]!)*(p[c+1]!-p[a+1]!)-(p[c]!-p[a]!)*(p[b+1]!-p[a+1]!))/2;}
 assert.equal(area,13);
});
test('boundary light head makes one timed lap and disappears after the reveal',()=>{
 assert.equal(boundaryAnimation(4,5,'child').alpha,0);
 assert.equal(boundaryAnimation(5,5,'child').progress,0);
 assert.equal(boundaryAnimation(5.625,5,'child').progress,.5);
 assert.equal(boundaryAnimation(6.5,5,'child').alpha,0);
 assert.equal(boundaryAnimation(8,5,'child').alpha,0);
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
