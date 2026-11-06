import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent } from 'undici';
import { ImageryService } from '../apps/ue-player/imagery.js';

async function fixture(config = '') {
  const root = await mkdtemp(join(tmpdir(), 'ue-imagery-'));
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'config/project.yaml'), config);
  const agent = new MockAgent(); agent.disableNetConnect();
  return { root, agent, close: async () => { await agent.close(); await rm(root, { recursive:true, force:true }); } };
}
test('Mapbox descriptor returns a local template without credentials', async () => {
  const f=await fixture('map:\n  mapbox_access_token: test-only-key\n  mapbox_map_id: mapbox/satellite-v9\n');
  try {
    const service=new ImageryService(f.root,{},f.agent);
    const descriptor=await service.descriptor('mapbox-satellite','http://127.0.0.1:4174');
    assert.equal(descriptor.provider,'mapbox-satellite');
    assert.match(descriptor.tileTemplate,/^http:\/\/127\.0\.0\.1:4174\/api\/imagery\/mapbox-satellite\//);
    assert.ok(!JSON.stringify(descriptor).includes('test-only-key'));
  }finally{await f.close();}
});
test('Mapbox tiles honor the original style, environment token and deduplicate requests', async () => {
  const f=await fixture('map:\n  mapbox_access_token: config-key\n  mapbox_map_id: mapbox/satellite-v9\n');
  try {
    f.agent.get('https://api.mapbox.com').intercept({path:'/styles/v1/mapbox/satellite-v9/tiles/256/2/3/1?access_token=environment-key'}).reply(200,Buffer.from([255,216,255]),{headers:{'content-type':'image/jpeg'}});
    const service=new ImageryService(f.root,{MAPBOX_ACCESS_TOKEN:'environment-key'},f.agent);
    const [a,b]=await Promise.all([service.tile('mapbox-satellite',2,3,1),service.tile('mapbox-satellite',2,3,1)]);
    assert.equal(a.type,'image/jpeg');assert.deepEqual(a.bytes,b.bytes);
    assert.deepEqual((await service.tile('mapbox-satellite',2,3,1)).bytes,a.bytes);
    f.agent.assertNoPendingInterceptors();
  }finally{await f.close();}
});
test('missing credentials, unsupported providers and invalid coordinates fail clearly', async () => {
  const f=await fixture();
  try {
    const service=new ImageryService(f.root,{},f.agent);
    await assert.rejects(service.descriptor('mapbox-satellite','http://127.0.0.1:4174'),/MAPBOX_ACCESS_TOKEN/);
    await assert.rejects(service.descriptor('unknown','http://127.0.0.1:4174'),/尚未接入/);
    await assert.rejects(service.tile('esri-world-imagery',2,4,0),/坐标无效/);
  }finally{await f.close();}
});
test('upstream authorization errors are redacted and never cached', async () => {
  const f=await fixture();
  try {
    const pool=f.agent.get('https://api.mapbox.com');
    const path='/styles/v1/mapbox/satellite-v9/tiles/256/2/3/1?access_token=test-only-key';
    pool.intercept({path}).reply(401,'test-only-key');
    pool.intercept({path}).reply(200,Buffer.from([255,216,255]),{headers:{'content-type':'image/jpeg'}});
    const service=new ImageryService(f.root,{MAPBOX_ACCESS_TOKEN:'test-only-key'},f.agent);
    await assert.rejects(service.tile('mapbox-satellite',2,3,1),error=>error instanceof Error && /访问令牌/.test(error.message) && !error.message.includes('test-only-key'));
    assert.equal((await service.tile('mapbox-satellite',2,3,1)).type,'image/jpeg');
    f.agent.assertNoPendingInterceptors();
  }finally{await f.close();}
});
