import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, type Stats } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { parseEnv } from "node:util";

const projectRoot = resolve(process.cwd());
const publicRoot = join(projectRoot, "apps", "cesium-player", "public");
// `.env.local` is where this machine keeps its keys. The server is usually started as a bare
// `tsx`, with nothing exported, so a token that only lived in the file used to read as empty.
const localEnv = (() => {
  try {
    return parseEnv(readFileSync(join(projectRoot, ".env.local"), "utf8")) as Record<string, string | undefined>;
  } catch {
    return {} as Record<string, string | undefined>;
  }
})();
const env = (key: string) => process.env[key] || localEnv[key];
const cesiumRoot = join(projectRoot, "node_modules", "cesium", "Build", "Cesium");
const portArg = process.argv.find((argument) => argument.startsWith("--port="));
const port = Number(portArg?.split("=")[1] ?? process.env.PORT ?? 4173);

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/geo+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg"
};

function safeFile(base: string, pathPart: string): string | null {
  const target = normalize(join(base, pathPart));
  return target.startsWith(normalize(base)) ? target : null;
}

const boundarySnapshotRoot = join(projectRoot, "workspace", "projects");

/**
 * A scheme's frozen boundary lives beside its project record, as
 * `workspace/projects/<projectId>.boundary/`, mirroring the workspace-relative
 * paths under `data/`. When the Studio preview passes `boundary=<projectId>`, a
 * `data/**` request is answered from that mirror first, so re-importing a region
 * cannot change a scheme that was already authored against the older boundary.
 * A miss — or no parameter at all, as in bare `?region=` playback and the
 * frame-capture sandbox — falls through to the live workspace data.
 */
function boundaryScopedFile(boundaryId: string | null, pathname: string): string | null {
  if (!boundaryId) return null;
  const target = safeFile(join(boundarySnapshotRoot, `${boundaryId}.boundary`), pathname.slice(1));
  return target && existsSync(target) ? target : null;
}

function readBoundaryScope(url: URL): string | null {
  const value = url.searchParams.get("boundary");
  return value && /^[a-zA-Z0-9_-]+$/.test(value) ? value : null;
}

function resolveRequest(pathname: string, boundaryId: string | null): string | null {
  if (pathname === "/" || pathname === "/index.html") return join(publicRoot, "index.html");
  if (pathname.startsWith("/Cesium/")) return safeFile(cesiumRoot, pathname.slice("/Cesium/".length));
  if (pathname.startsWith("/data/")) return boundaryScopedFile(boundaryId, pathname) ?? safeFile(join(projectRoot, "data"), pathname.slice("/data/".length));
  if (pathname.startsWith("/content/")) return safeFile(join(projectRoot, "content"), pathname.slice("/content/".length));
  if (pathname.startsWith("/assets/")) return safeFile(join(projectRoot, "assets"), pathname.slice("/assets/".length));
  if (pathname.startsWith("/design/")) return safeFile(join(projectRoot, "design"), pathname.slice("/design/".length));
  return safeFile(publicRoot, pathname.slice(1));
}

function sendError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

interface FileCachePolicy {
  cacheControl: string;
  etag?: string;
  lastModified?: string;
}

/**
 * The preview is authored on the machine that serves it: the operator edits a
 * source shapefile, re-imports the region, and expects the very next preview to
 * show the new boundary. Serving `data/**` with `max-age=31536000, immutable`
 * broke that promise — the browser replayed the pre-import geometry without
 * ever asking the server again, so a re-import looked like a no-op.
 *
 * Only the vendored Cesium build is genuinely immutable. Everything else either
 * revalidates (a cheap 304 when nothing moved) or is not stored at all.
 */
function cachePolicyFor(file: string, info: Stats): FileCachePolicy {
  const target = normalize(file);
  if (target.startsWith(normalize(cesiumRoot))) return { cacheControl: "public, max-age=31536000, immutable" };
  if (target.startsWith(normalize(publicRoot))) return { cacheControl: "no-store" };
  return {
    cacheControl: "no-cache",
    etag: `W/"${info.size.toString(16)}-${Math.round(info.mtimeMs).toString(16)}"`,
    lastModified: new Date(info.mtimeMs).toUTCString()
  };
}

/** RFC 9110 If-None-Match uses weak comparison, so `W/"x"` and `"x"` both match. */
function isNotModified(request: IncomingMessage, policy: FileCachePolicy): boolean {
  const header = request.headers["if-none-match"];
  if (!policy.etag || !header) return false;
  const bare = policy.etag.replace(/^W\//, "");
  return header
    .split(",")
    .some((candidate) => {
      const value = candidate.trim().replace(/^W\//, "");
      return value === "*" || value === bare;
    });
}

const DATA_VERSION_DIRECTORIES: Array<[string, readonly string[]]> = [
  [join("data", "regions"), [".json"]],
  [join("data", "normalized"), [".geojson", ".json"]],
  [join("data", "features"), [".geojson", ".json"]],
  [join("content"), [".json"]]
];

/**
 * Stamp the freshness of everything the map draws. The client appends this to
 * its data requests, so unchanged data still hits the browser cache while a
 * re-import lands on a brand-new URL instead of a stale replay.
 */
function computeDataVersion(): string {
  let newest = 0;
  for (const [relative, extensions] of DATA_VERSION_DIRECTORIES) {
    const directory = join(projectRoot, relative);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !extensions.some((extension) => entry.name.endsWith(extension))) continue;
      try {
        const info = statSync(join(directory, entry.name));
        if (info.mtimeMs > newest) newest = info.mtimeMs;
      } catch {
        // A file that vanished mid-scan is simply not part of the version.
      }
    }
  }
  return newest > 0 ? Math.round(newest).toString(36) : "0";
}

function extractYamlScalar(source: string, key: string): string | null {
  const match = source.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"));
  const value = match?.[1];
  return value ? value.replace(/^["']|["']$/g, "") : null;
}

function readCesiumRuntimeConfig(): Record<string, unknown> {
  const configPath = join(projectRoot, "config", "project.yaml");
  const publicImageryConfigPath = join(publicRoot, "imagery-config.json");
  const publicImageryConfig = existsSync(publicImageryConfigPath)
    ? JSON.parse(readFileSync(publicImageryConfigPath, "utf8")) as Record<string, unknown>
    : {};
  const source = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const token = (env("CESIUM_ION_TOKEN") ?? extractYamlScalar(source, "cesium_ion_token") ?? "").trim();
  const imageryProvider = extractYamlScalar(source, "imagery_provider") ?? String(publicImageryConfig.imageryProvider || "cesium-ion-world-imagery");
  const imageryIonAssetId = Number(extractYamlScalar(source, "imagery_ion_asset_id") ?? "2");
  const mapboxAccessToken = env("MAPBOX_ACCESS_TOKEN") ?? extractYamlScalar(source, "mapbox_access_token") ?? String(publicImageryConfig.mapboxAccessToken || "");
  const mapboxMapId = extractYamlScalar(source, "mapbox_map_id") ?? String(publicImageryConfig.mapboxMapId || "mapbox.satellite");
  const bingMapsKey = env("BING_MAPS_KEY") ?? extractYamlScalar(source, "bing_maps_key") ?? String(publicImageryConfig.bingMapsKey || "");
  const tiandituToken = (env("TIANDITU_TOKEN") || extractYamlScalar(source, "tianditu_token") || String(publicImageryConfig.tiandituToken || "")).trim();
  const esriWorldImageryUrl = extractYamlScalar(source, "esri_world_imagery_url") ?? String(publicImageryConfig.esriWorldImageryUrl || "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer");
  const visual = publicImageryConfig.visual && typeof publicImageryConfig.visual === "object"
    ? publicImageryConfig.visual
    : {};
  // `terrain_provider` in config/project.yaml is an operator override for the
  // shipped public default, so a deployment can switch a whole render farm to
  // real terrain (or back to the deterministic ellipsoid) without editing the
  // client config. Anything else in `terrain` stays as published.
  const terrainProvider = extractYamlScalar(source, "terrain_provider");
  const publicTerrain = publicImageryConfig.terrain && typeof publicImageryConfig.terrain === "object"
    ? publicImageryConfig.terrain as Record<string, unknown>
    : {};
  const terrain = terrainProvider ? { ...publicTerrain, provider: terrainProvider } : publicTerrain;
  return { token, imageryProvider, imageryIonAssetId, mapboxAccessToken, mapboxMapId, bingMapsKey, tiandituToken, esriWorldImageryUrl, visual, terrain, dataVersion: computeDataVersion() };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `127.0.0.1:${port}`}`);
  if (url.pathname === "/runtime-config.json") {
    response.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*"
    });
    response.end(JSON.stringify(readCesiumRuntimeConfig()));
    return;
  }
  const file = resolveRequest(decodeURIComponent(url.pathname), readBoundaryScope(url));
  if (!file || !existsSync(file)) {
    sendError(response, 404, `Not found: ${url.pathname}`);
    return;
  }
  const info = statSync(file);
  if (!info.isFile()) {
    sendError(response, 404, `Not found: ${url.pathname}`);
    return;
  }
  const policy = cachePolicyFor(file, info);
  if (isNotModified(request, policy)) {
    response.writeHead(304, {
      ...(policy.etag ? { etag: policy.etag } : {}),
      ...(policy.lastModified ? { "last-modified": policy.lastModified } : {}),
      "cache-control": policy.cacheControl
    });
    response.end();
    return;
  }
  response.writeHead(200, {
    "content-type": mimeTypes[extname(file).toLowerCase()] ?? "application/octet-stream",
    "cache-control": policy.cacheControl,
    ...(policy.etag ? { etag: policy.etag } : {}),
    ...(policy.lastModified ? { "last-modified": policy.lastModified } : {}),
    "access-control-allow-origin": "*"
  });
  createReadStream(file).pipe(response);
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    process.stderr.write(`GEO_PLAYER_PORT_IN_USE 端口 ${port} 已被占用，播放服务可能已在运行：http://127.0.0.1:${port}\n`);
  } else {
    process.stderr.write(`GEO_PLAYER_LISTEN_FAILED ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(1);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`CESIUM_PLAYER_READY http://127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
