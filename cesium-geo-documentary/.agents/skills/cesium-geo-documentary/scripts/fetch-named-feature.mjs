#!/usr/bin/env node
/**
 * Fetch verified geometry for one narrated named feature (river, canal, ridge,
 * coastline reach) and write it as data/features/{id}.geojson.
 *
 * The named-feature layer in apps/cesium-player/public/runtime.js only reads
 * data/features/{ref}.geojson, referenced from `region.featureRefs`. This script
 * is what produces those files, so a feature never becomes a "free-floating
 * decorative line": the geometry, its source, its licence and the river's own
 * national hydrography code all travel with the file.
 *
 * Usage:
 *   node .agents/skills/cesium-geo-documentary/scripts/fetch-named-feature.mjs \
 *     --id leiqing-qingnian-canal \
 *     --region 440882102 \
 *     --name "青年运河" \
 *     --kind canal \
 *     --expand 1.35
 *
 * Options:
 *   --id       output feature id; file is data/features/{id}.geojson (required)
 *   --region   region adcode used for bbox + label placement (required)
 *   --name     name substring to match in OSM (required)
 *   --kind     OSM waterway/natural value; repeatable, default canal+river
 *   --expand   bbox expansion factor for upstream/downstream context (default 1.35)
 *   --simplify Douglas-Peucker tolerance in degrees (default 1e-5, ~1 m)
 *   --label    override the label point as "lon,lat"
 *   --dry-run  report matches without writing
 */

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { resolve, dirname } from "node:path";

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const USER_AGENT = "cesium-geo-documentary/1.0 (named-feature fetch)";
// OSM is the practical open source for a first pass. Replace it with an official
// hydrography dataset for a released master and keep this attribution shape.
const SOURCE_ATTRIBUTION = {
  provider: "OpenStreetMap",
  sourceUrl: "https://www.openstreetmap.org/",
  license: "ODbL-1.0",
  licenseUrl: "https://www.openstreetmap.org/copyright"
};

function parseArgs(argv) {
  const args = { kind: [], expand: 1.35, simplify: 1e-5, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "dry-run") {
      args.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    index += 1;
    if (key === "kind") args.kind.push(value);
    else args[key] = value;
  }
  if (args.kind.length === 0) args.kind = ["canal", "river"];
  return args;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function expandBbox(bbox, factor) {
  const [west, south, east, north] = bbox;
  const centerLon = (west + east) / 2;
  const centerLat = (south + north) / 2;
  const halfLon = Math.max(0.005, (east - west) / 2) * factor;
  const halfLat = Math.max(0.005, (north - south) / 2) * factor;
  return [
    Math.max(-179.9, centerLon - halfLon),
    Math.max(-89.9, centerLat - halfLat),
    Math.min(179.9, centerLon + halfLon),
    Math.min(89.9, centerLat + halfLat)
  ];
}

function buildOverpassQuery(bbox, kinds, name) {
  // Overpass bbox order is (south, west, north, east) - latitude first.
  const [west, south, east, north] = bbox;
  const box = [south, west, north, east].map((value) => value.toFixed(6)).join(",");
  const clauses = kinds
    .map((kind) => `way[waterway=${kind}][name~"${name}"](${box});`)
    .concat(kinds.map((kind) => `way[natural=${kind}][name~"${name}"](${box});`))
    .join("");
  return `[out:json][timeout:60];(${clauses});out geom;`;
}

async function fetchOverpass(query) {
  const response = await fetch(OVERPASS_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": USER_AGENT
    },
    body: new URLSearchParams({ data: query }).toString()
  });
  if (!response.ok) throw new Error(`Overpass ${response.status} ${response.statusText}`);
  return response.json();
}

function perpendicularDistance(point, start, end) {
  const [x, y] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (x1 + clamped * dx), y - (y1 + clamped * dy));
}

function simplify(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDistance = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = perpendicularDistance(points[i], points[0], points.at(-1));
    if (distance > maxDistance) {
      maxDistance = distance;
      index = i;
    }
  }
  if (maxDistance <= tolerance) return [points[0], points.at(-1)];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance)
  ].filter((point, i, list) => i === 0 || point[0] !== list[i - 1][0] || point[1] !== list[i - 1][1]);
}

function lineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += Math.hypot(
      (points[index][0] - points[index - 1][0]) * 100000,
      (points[index][1] - points[index - 1][1]) * 111000
    );
  }
  return total;
}

function samePoint(a, b, tolerance = 1e-7) {
  return Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;
}

// OSM splits a river into many ways that share endpoints. Stitching restores the
// continuous reach so the runtime can reveal it as one directional trace.
function stitchWays(paths) {
  const pending = paths.map((points) => [...points]).filter((points) => points.length >= 2);
  const stitched = [];
  while (pending.length > 0) {
    let current = pending.shift();
    let extended = true;
    while (extended) {
      extended = false;
      for (let index = 0; index < pending.length; index += 1) {
        const candidate = pending[index];
        const head = current[0];
        const tail = current.at(-1);
        if (samePoint(tail, candidate[0])) current = current.concat(candidate.slice(1));
        else if (samePoint(tail, candidate.at(-1))) current = current.concat([...candidate].reverse().slice(1));
        else if (samePoint(head, candidate.at(-1))) current = candidate.concat(current.slice(1));
        else if (samePoint(head, candidate[0])) current = [...candidate].reverse().concat(current.slice(1));
        else continue;
        pending.splice(index, 1);
        extended = true;
        break;
      }
    }
    stitched.push(current);
  }
  return stitched;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const required of ["id", "region", "name"]) {
    if (!args[required]) throw new Error(`Missing --${required}`);
  }
  const projectRoot = resolve(process.cwd());
  const regionPath = resolve(projectRoot, "data", "regions", `${args.region}.json`);
  const region = JSON.parse(await readFile(regionPath, "utf8"));
  const bbox = region.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error(`Region ${args.region} has no bbox`);

  const queryBox = expandBbox(bbox, Number(args.expand));
  const payload = await fetchOverpass(buildOverpassQuery(queryBox, args.kind, args.name));
  const ways = (payload.elements || []).filter((element) => Array.isArray(element.geometry) && element.geometry.length >= 2);
  if (ways.length === 0) throw new Error(`No OSM geometry matched "${args.name}" near region ${args.region}`);

  const paths = ways.map((way) => way.geometry.map((node) => [node.lon, node.lat]));
  const stitched = stitchWays(paths)
    .map((points) => simplify(points, Number(args.simplify)))
    .filter((points) => points.length >= 2);
  if (stitched.length === 0) throw new Error("Stitching produced no usable reach");

  const codes = [...new Set(ways.flatMap((way) => [way.tags?.code, way.tags?.nsdi_code, way.tags?.zhb_code]).filter(Boolean))];
  const officialNames = [...new Set(ways.map((way) => way.tags?.["name:zh"] || way.tags?.name).filter(Boolean))];
  const longest = stitched.reduce((best, points) => (lineLength(points) > lineLength(best) ? points : best), stitched[0]);

  let labelPoint = null;
  if (args.label) {
    labelPoint = args.label.split(",").map(Number);
  } else {
    const childrenPath = resolve(projectRoot, "data", "normalized", `${args.region}-children.geojson`);
    const rings = await exists(childrenPath)
      ? JSON.parse(await readFile(childrenPath, "utf8")).features.flatMap((feature) => ringsOf(feature.geometry))
      : [];
    for (const point of longest) {
      if (rings.some((ring) => pointInRing(point, ring))) {
        labelPoint = point;
        break;
      }
    }
    if (!labelPoint) labelPoint = longest[Math.floor(longest.length / 2)];
  }

  const feature = {
    type: "Feature",
    properties: {
      id: args.id,
      name: officialNames[0] || args.name,
      aliases: officialNames.slice(1),
      type: args.kind[0],
      role: "named-waterway",
      crs: "EPSG:4326",
      labelPoint: [Number(labelPoint[0].toFixed(6)), Number(labelPoint[1].toFixed(6))],
      officialCodes: codes,
      osmWayIds: ways.map((way) => way.id),
      regionId: String(args.region),
      reachBox: queryBox.map((value) => Number(value.toFixed(6))),
      retrievedAt: new Date().toISOString().slice(0, 10),
      ...SOURCE_ATTRIBUTION
    },
    geometry: {
      type: "MultiLineString",
      coordinates: stitched
    }
  };

  const pointCount = stitched.reduce((sum, points) => sum + points.length, 0);
  const summary = {
    id: args.id,
    region: args.region,
    name: feature.properties.name,
    officialCodes: codes,
    osmWays: ways.length,
    reaches: stitched.length,
    points: pointCount,
    labelPoint: feature.properties.labelPoint,
    approximateLengthKm: Number((lineLength(longest) / 1000).toFixed(2))
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (args.dryRun) return;

  const outputPath = resolve(projectRoot, "data", "features", `${args.id}.geojson`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(feature, null, 1)}\n`, "utf8");
  process.stdout.write(`WROTE ${outputPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
});
