import {test} from 'node:test';
import assert from 'node:assert/strict';
import {triangulateFeature,boundaryAnimation} from '../apps/ue-player/boundary-style.js';
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
