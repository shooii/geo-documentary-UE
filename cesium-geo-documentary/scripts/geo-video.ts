import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(process.cwd());
const python = process.env.PYTHON ?? "python";
const [command = "help", ...args] = process.argv.slice(2);
const regionArg = args.findIndex((value) => value === "--region");
const region = regionArg >= 0 ? args[regionArg + 1] : undefined;
const profileArg = args.findIndex((value) => value === "--profile");
const profile = profileArg >= 0 ? args[profileArg + 1] ?? "landscape" : "landscape";
const regionsArg = args.findIndex((value) => value === "--regions");
const regions = regionsArg >= 0 ? args[regionsArg + 1] : undefined;
const outputArg = args.findIndex((value) => value === "--output");
const output = outputArg >= 0 ? args[outputArg + 1] : undefined;
const stageArg = args.findIndex((value) => value === "--stage");
const stage = stageArg >= 0 ? args[stageArg + 1] ?? "draft" : "draft";

function run(executable: string, commandArgs: string[], cwd = root, shell = process.platform === "win32"): void {
  const result = spawnSync(executable, commandArgs, { cwd, stdio: "inherit", shell });
  if (result.status !== 0) throw new Error(`${executable} ${commandArgs.join(" ")} failed with ${result.status}`);
}

function mark(stage: string, details: Record<string, unknown> = {}): void {
  const path = join(root, ".build-state", `${stage}.json`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ stage, completedAt: new Date().toISOString(), ...details }, null, 2), "utf8");
}

function requireRegion(): string {
  if (!region) throw new Error("This command requires --region <administrative-code>");
  return region;
}

function requireRegions(): string {
  if (!regions) throw new Error("This command requires --regions <id-1,id-2,...>");
  return regions;
}

function pythonGeometryStack(): { ok: boolean; detail: string } {
  const script = join(root, ".agents", "skills", "cesium-geo-documentary", "scripts", "import-shapefile.py");
  if (!existsSync(script)) return { ok: false, detail: `missing ${script}` };
  // stdin must be ignored: piping it alongside stdout cannot start a child in
  // the managed sandbox (`spawnSync ... EBUSY`, status null, no output), which
  // made this probe report a false "python stack broken" failure.
  const result = spawnSync(python, [script, "--help"], {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) return { ok: true, detail: "ok" };
  const detail = `${result.stdout ?? ""}\n${result.stderr ?? ""}`
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
  return { ok: false, detail: detail || `exit ${result.status ?? "null"}` };
}

/** Read one flat scalar out of config/project.yaml, the way the player does. */
function configScalar(key: string): string {
  const configPath = join(root, "config", "project.yaml");
  if (!existsSync(configPath)) return "";
  const match = readFileSync(configPath, "utf8").match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m"));
  return (match?.[1] ?? "").replace(/^["']|["']$/g, "").trim();
}

function doctor(): void {
  // The boundary-import stack is CPython-version specific, so a broken or
  // mismatched interpreter only shows up much later as a failed "create town"
  // click. Probe it here so `pnpm doctor` reports it up front.
  const geometry = pythonGeometryStack();
  // The player resolves the Ion token from the environment first and then from
  // config/project.yaml, so a boolean on the environment alone reported "no
  // token" for a config-supplied one. Report where the token actually comes
  // from, and what terrain is configured, so an absent token can be read as
  // either harmless or fatal instead of just "false".
  const ionTokenFromEnv = (process.env.CESIUM_ION_TOKEN ?? "").trim();
  const ionTokenFromConfig = configScalar("cesium_ion_token");
  const ionToken = ionTokenFromEnv || ionTokenFromConfig;
  const terrainProvider = configScalar("terrain_provider") || "(public default)";
  const terrainNeedsIon = /^(world-terrain|ion:)/.test(terrainProvider);
  const checks = {
    node: process.version,
    python,
    pythonGeometryStack: geometry.detail,
    packageJson: existsSync(join(root, "package.json")),
    cesium: existsSync(join(root, "node_modules", "cesium", "Build", "Cesium", "Cesium.js")),
    hyperframes: existsSync(join(root, "node_modules", ".bin", process.platform === "win32" ? "hyperframes.CMD" : "hyperframes")),
    ffmpegStatic: existsSync(join(root, "node_modules", "ffmpeg-static", "ffmpeg.exe")) || existsSync(join(root, "node_modules", "ffmpeg-static", "ffmpeg")),
    chrome: existsSync("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"),
    cesiumIonToken: ionTokenFromEnv ? "from CESIUM_ION_TOKEN" : ionTokenFromConfig ? "from config/project.yaml" : "absent",
    terrainProvider
  };
  process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  const terrainUnserviceable = terrainNeedsIon && !ionToken;
  if (terrainUnserviceable) {
    process.stderr.write(`CONFIG terrain_provider=${terrainProvider} needs a Cesium Ion token, but none is set. `
      + "Set CESIUM_ION_TOKEN or config/project.yaml:cesium_ion_token, or switch terrain_provider back to ellipsoid.\n");
  }
  if (!geometry.ok || !checks.packageJson || !checks.cesium || !checks.hyperframes || !checks.ffmpegStatic || !checks.chrome || terrainUnserviceable) process.exitCode = 1;
}

function build(): void {
  const id = requireRegion();
  run(python, [".agents/skills/cesium-geo-documentary/scripts/validate-geodata.py", `data/normalized/${id}.geojson`]);
  run("pnpm", ["capture", "--", "--region", id, "--profile", profile, "--encode"]);
  run("pnpm", ["geo-video", "compose", "--region", id, "--profile", profile]);
  run("pnpm", ["geo-video", "qa", "--region", id, "--profile", profile]);
  run("pnpm", ["geo-video", "publish-copy", "--region", id]);
  mark("DELIVERED", { region: id, profile });
}

try {
  switch (command) {
    case "doctor": doctor(); break;
    case "init": mark("INIT"); break;
    case "validate-data": run(python, [".agents/skills/cesium-geo-documentary/scripts/validate-geodata.py", region ? `data/normalized/${region}.geojson` : "data/normalized"]); break;
    case "research": mark("RESEARCH_READY", { region: region ?? "all" }); break;
    case "script": mark("SCRIPT_READY", { region: region ?? "all" }); break;
    case "storyboard": mark("STORYBOARD_READY", { region: region ?? "all" }); break;
    case "design": mark("DESIGN_READY"); break;
    case "imagegen": run("tsx", [".agents/skills/cesium-geo-documentary/scripts/generate-imagegen-manifest.ts"]); break;
    case "cesium": run("pnpm", ["cesium:serve", ...args]); break;
    case "voice": run("tsx", [".agents/skills/cesium-geo-documentary/scripts/generate-narration.ts", "--region", requireRegion()]); break;
    case "capture": run("pnpm", ["capture", "--", ...args]); break;
    case "compose": run("tsx", [".agents/skills/cesium-geo-documentary/scripts/compose-hyperframes.ts", "--region", requireRegion(), "--profile", profile]); break;
    case "qa": run("tsx", [".agents/skills/cesium-geo-documentary/scripts/validate-delivery.ts", "--region", requireRegion(), "--profile", profile, "--stage", stage]); break;
    case "publish-copy": run("tsx", [".agents/skills/cesium-geo-documentary/scripts/generate-publish-copy.ts", "--region", requireRegion()]); break;
    case "render": run("pnpm", ["geo-video", "compose", "--region", requireRegion(), "--profile", profile]); break;
    case "master": run(process.execPath, [
      resolve(root, "node_modules/tsx/dist/cli.mjs"),
      ".agents/skills/cesium-geo-documentary/scripts/build-master-video.ts",
      "--regions", requireRegions(),
      "--profile", profile,
      ...(output ? ["--output", output] : [])
    ], root, false); break;
    case "build": build(); break;
    default:
      process.stdout.write("Commands: doctor init validate-data research script storyboard design imagegen cesium voice capture compose qa publish-copy render master build\n");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
}
