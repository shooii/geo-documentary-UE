export type Tangents = { horizontal:number; vertical:number };
export type GroundPoint = { east:number; north:number };
export function portraitOverviewFrustumTangents(aspect?:number):Tangents;
export function portraitOverviewScreenFractions(east:number,north:number,range:number,pitch:number,tangents?:Tangents):{x:number;y:number};
export function portraitOverviewRange(points:GroundPoint[],pitch:number,safe:number,tangents?:Tangents):number;
export function portraitOverviewExtent(bounds:unknown,geometry:unknown):{longitude:number;latitude:number;points:GroundPoint[]}|null;
export function portraitOverviewProjectedBox(points:GroundPoint[],range:number,pitch:number,tangents?:Tangents):{minX:number;maxX:number;minY:number;maxY:number;centreX:number;centreY:number}|null;
export function portraitOverviewTarget(points:GroundPoint[],pitch:number,safe:number,tangents?:Tangents):{eastMeters:number;northMeters:number;rangeMeters:number};
export function applyPortraitZoomToLayer(region:any,geometry:any):any;
