export type GeoBounds = readonly [west: number, south: number, east: number, north: number];

export interface GeoCameraPreset {
  longitude: number;
  latitude: number;
  height: number;
  heading: number;
  pitch: number;
  roll?: number;
}

const EARTH_DEGREES_TO_METERS = 111_320;
const LATITUDE_DEGREES_TO_METERS = 110_570;
const PORTRAIT_HORIZONTAL_FOV_DEGREES = 36;
const PORTRAIT_VERTICAL_FOV_DEGREES = 58;
const TARGET_WIDTH_COVERAGE = 0.82;
const TARGET_HEIGHT_COVERAGE = 0.74;
const EDGE_SAFETY_SCALE = 1.06;
const MINIMUM_HEIGHT_METERS = 1_800;

function validateBounds(bounds: GeoBounds): [number, number, number, number] {
  const [west, south, east, north] = bounds.map(Number) as [number, number, number, number];
  if (![west, south, east, north].every(Number.isFinite) || east <= west || north <= south) {
    throw new Error("Invalid child boundary bounds");
  }
  return [west, south, east, north];
}

/** Fits the complete direct-child bbox into the portrait safe frame at maximum useful scale. */
export function portraitChildCameraHeight(bounds: GeoBounds): number {
  const [west, south, east, north] = validateBounds(bounds);
  const latitude = (south + north) / 2;
  const widthMeters = (east - west) * EARTH_DEGREES_TO_METERS * Math.cos(latitude * Math.PI / 180);
  const heightMeters = (north - south) * LATITUDE_DEGREES_TO_METERS;
  const horizontalTangent = Math.tan(PORTRAIT_HORIZONTAL_FOV_DEGREES * Math.PI / 360);
  const verticalTangent = Math.tan(PORTRAIT_VERTICAL_FOV_DEGREES * Math.PI / 360);
  const widthFitHeight = widthMeters / (2 * horizontalTangent * TARGET_WIDTH_COVERAGE);
  const heightFitHeight = heightMeters / (2 * verticalTangent * TARGET_HEIGHT_COVERAGE);
  return Math.ceil(Math.max(MINIMUM_HEIGHT_METERS, Math.max(widthFitHeight, heightFitHeight) * EDGE_SAFETY_SCALE));
}

export function portraitChildCameraPreset<T extends GeoCameraPreset>(preset: T, bounds?: GeoBounds): T {
  if (!bounds) return { ...preset };
  const [west, south, east, north] = validateBounds(bounds);
  return {
    ...preset,
    longitude: (west + east) / 2,
    latitude: (south + north) / 2,
    height: portraitChildCameraHeight(bounds)
  };
}
