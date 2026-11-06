export * from "./child-adjacency.js";

const EARTH_RADIUS_KM = 6371.0088;

export function bboxFromCoordinates(points: ReadonlyArray<readonly [number, number]>): [number, number, number, number] {
  if (points.length === 0) throw new Error("Cannot calculate a bounding box for no points");
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [longitude, latitude] of points) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }
  return [west, south, east, north];
}

export function recommendedCameraHeight(bbox: readonly [number, number, number, number]): number {
  const widthKm = Math.abs(bbox[2] - bbox[0]) * 111 * Math.cos(((bbox[1] + bbox[3]) / 2) * Math.PI / 180);
  const heightKm = Math.abs(bbox[3] - bbox[1]) * 111;
  return Math.max(35000, Math.min(900000, Math.max(widthKm, heightKm) * 2200));
}

export function sphericalRingAreaKm2(ring: ReadonlyArray<readonly [number, number]>): number {
  if (ring.length < 4) return 0;
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const current = ring[index];
    const next = ring[index + 1];
    if (!current || !next) continue;
    const lon1 = current[0] * Math.PI / 180;
    const lon2 = next[0] * Math.PI / 180;
    const lat1 = current[1] * Math.PI / 180;
    const lat2 = next[1] * Math.PI / 180;
    sum += (lon2 - lon1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs(sum) * EARTH_RADIUS_KM * EARTH_RADIUS_KM / 2;
}
