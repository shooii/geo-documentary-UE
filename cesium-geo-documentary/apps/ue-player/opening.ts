const clamp=(x:number)=>Math.max(0,Math.min(1,x));
const smooth=(x:number)=>{x=clamp(x);return x*x*x*(x*(x*6-15)+10);};
/** 穿云开场已移除（2026-11-11）：descent ≤0 时开场保持禁用，不再钳到最短 2 秒。 */
export function configureOpening(region:any,overrides:any={}) {
  const base=region.openingDescent || {};
  const seconds=Math.max(0,Math.min(16,Number(overrides.descentSeconds ?? overrides.seconds ?? base.seconds ?? 0)));
  if(seconds<=0)return {...region,openingDescent:{...base,enabled:false,seconds:0,clouds:false}};
  return {...region,openingDescent:{...base,enabled:true,seconds,startHeightMeters:Math.max(800000,Number(overrides.startHeightMeters ?? base.startHeightMeters ?? 900000)),startPitchDegrees:Number(overrides.startPitchDegrees ?? base.startPitchDegrees ?? -52),cloudDeckHeightMeters:Number(overrides.cloudDeckHeightMeters ?? base.cloudDeckHeightMeters ?? 45000),cloudAlphaPeak:Number(overrides.cloudAlphaPeak ?? base.cloudAlphaPeak ?? .95),clouds:overrides.clouds!==false && base.clouds!==false}};
}
export function cloudStateAt(time:number,opening:any,height:number) {
  const seconds=Number(opening?.seconds || 0),raw=seconds?clamp(time/seconds):1;
  if(!seconds || time>=seconds || opening.clouds===false)return {raw,deck:0,veil:0,volume:0};
  const lerp=(a:number,b:number,t:number)=>a+(b-a)*t;
  const deck=raw<.28?lerp(.04,.16,smooth(raw/.28)):raw<.68?lerp(.16,.34,smooth((raw-.28)/.4)):raw<.86?lerp(.34,.26,smooth((raw-.68)/.18)):.26*(1-smooth((raw-.86)/.14));
  const veil=raw<.54?0:raw<.72?.58*smooth((raw-.54)/.18):raw<.86?lerp(.58,.44,smooth((raw-.72)/.14)):.44*(1-smooth((raw-.86)/.14));
  const peak=Number(opening.cloudAlphaPeak ?? .95),altitude=clamp((Number(opening.cloudDeckHeightMeters ?? 45000)*7-height)/(Number(opening.cloudDeckHeightMeters ?? 45000)*6));
  const volume=raw<.36?peak*lerp(.08,.22,smooth(raw/.36))*lerp(.72,1,altitude):raw<.68?peak*lerp(.22,1,smooth((raw-.36)/.32)):raw<.86?peak*lerp(1,.72,smooth((raw-.68)/.18)):peak*.72*(1-smooth((raw-.86)/.14));
  return {raw,deck,veil,volume};
}
