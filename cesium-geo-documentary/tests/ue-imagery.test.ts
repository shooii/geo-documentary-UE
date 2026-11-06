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

test('Cesium ion resolves asset 2 and keeps Bing credentials on the server for each viewer session', async () => {
  const f = await fixture();
  try {
    const ion = f.agent.get('https://api.cesium.com');
    ion.intercept({ path: '/v1/assets/2/endpoint', headers: { authorization: 'Bearer local-test-token' } })
      .reply(200, { type: 'IMAGERY', externalType: 'BING', options: { url: 'https://dev.virtualearth.net/', key: 'test-bing-key', mapStyle: 'Aerial' } }).times(2);
    f.agent.get('https://dev.virtualearth.net').intercept({ path: '/REST/v1/Imagery/Metadata/Aerial?incl=ImageryProviders&key=test-bing-key&uriScheme=https' })
      .reply(200, { resourceSets: [{ resources: [{ imageUrl: 'https://{subdomain}.tiles.virtualearth.net/tiles/a{quadkey}.jpeg', imageUrlSubdomains: ['t0'], imageryProviders: [{ attribution: '© Example' }] }] }] }).times(2);
    f.agent.get('https://t0.tiles.virtualearth.net').intercept({ path: '/tiles/a13.jpeg?n=z' })
      .reply(200, Buffer.from([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } });
    const service = new ImageryService(f.root, { CESIUM_ION_TOKEN: 'local-test-token' }, f.agent);
    const provider = 'cesium-ion-world-imagery';
    const origin = 'http://127.0.0.1:4174';
    const descriptor = await service.descriptor(provider, origin, 'viewer-one');
    assert.equal(descriptor.tileTemplate, `${origin}/api/imagery/${provider}/{z}/{x}/{y}?session=viewer-one`);
    assert.match(descriptor.attribution, /© Example/);
    assert.doesNotMatch(JSON.stringify(descriptor), /local-test-token|test-bing-key/);
    assert.deepEqual(await service.descriptor(provider, origin, 'viewer-one'), descriptor);
    assert.equal((await service.tile(provider, 2, 3, 1, 'viewer-one')).type, 'image/jpeg');
    await service.descriptor(provider, origin, 'viewer-two');
    f.agent.assertNoPendingInterceptors();
  } finally { await f.close(); }
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
