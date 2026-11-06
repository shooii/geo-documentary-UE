import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import sharp from 'sharp';
// Bake the existing reference SVG/CSS cloud envelope once. UE composites these
// textures inside its HUD, so preview and native PNG capture share the effect.
const reference=await readFile('apps/cesium-player/public/index.html','utf8');
const deck=reference.match(/<svg id="cloudDeckOverlay"[\s\S]*?<\/svg>/)?.[0];
if(!deck)throw new Error('Reference cloud deck SVG missing');
const dir=resolve('unreal/assets');await mkdir(dir,{recursive:true});
await sharp(Buffer.from(deck.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '))).resize(540,960).png().toFile(resolve(dir,'cloud-deck.png'));
const pass=`<svg xmlns="http://www.w3.org/2000/svg" width="540" height="960" viewBox="0 0 540 960"><defs>
<radialGradient id="a"><stop stop-color="#e8f3f7" stop-opacity=".9"/><stop offset=".25" stop-color="#d6e6ed" stop-opacity=".68"/><stop offset=".54" stop-color="#a6c1cd" stop-opacity=".34"/><stop offset=".75" stop-color="#a6c1cd" stop-opacity="0"/></radialGradient>
<radialGradient id="b"><stop stop-color="#eff7fa" stop-opacity=".84"/><stop offset=".28" stop-color="#d3e6ed" stop-opacity=".60"/><stop offset=".58" stop-color="#9dbbc9" stop-opacity=".28"/><stop offset=".80" stop-color="#9dbbc9" stop-opacity="0"/></radialGradient>
<filter id="blur"><feGaussianBlur stdDeviation="9"/></filter></defs>
<g filter="url(#blur)"><ellipse cx="189" cy="326" rx="292" ry="365" fill="url(#a)"/><ellipse cx="394" cy="634" rx="248" ry="403" fill="url(#b)"/></g></svg>`;
await sharp(Buffer.from(pass)).png().toFile(resolve(dir,'cloud-pass.png'));
await writeFile(resolve(dir,'README.md'),'Cloud envelopes baked from the Cesium reference SVG/CSS. Run pnpm exec tsx scripts/ue-cloud-assets.ts to regenerate. UE imports and composites them in its own render output.\n');
