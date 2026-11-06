import { delimiter, resolve } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

export interface PythonRuntime {
  command: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Extra `spawnSync` options every python child in the suite must carry.
 *
 * This sandbox cannot start a process when stdin *and* stdout are piped at the
 * same time: `spawnSync("python", ..., { encoding: "utf8" })` fails with
 * `Error: spawnSync python EBUSY` and both `status` and `stdout` come back as
 * `null`. Because `status === null` is also what a crashed child reports, the
 * failure masquerades as an assertion failure inside the python script — it is
 * not. `dongli-boundary-contract` reported `null !== 0` for weeks on this.
 *
 * Ignoring stdin is enough to make the spawn succeed, and none of these probes
 * read stdin. Verified matrix on this machine:
 *
 *   default (pipe/pipe/pipe)      -> null  EBUSY
 *   windowsHide only              -> null  EBUSY
 *   stdio ['ignore','pipe','pipe'] -> 0     ok
 */
export const PYTHON_SPAWN_OPTIONS: { stdio: ["ignore", "pipe", "pipe"] } = {
  stdio: ["ignore", "pipe", "pipe"]
};

/**
 * Return the project-local native package directory that matches the active
 * CPython minor version. Shapely, pyproj and NumPy contain .pyd files, so a
 * generic PYTHONPATH pointing at an older wheel set makes tests fail with the
 * misleading "No module named shapely.lib" error.
 */
export function projectPythonRuntime(root: string): PythonRuntime {
  const command = process.env.PYTHON || "python";
  const probe = spawnSync(command, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...PYTHON_SPAWN_OPTIONS
  });
  const version = probe.status === 0 ? (probe.stdout || "").trim().split(".").map(Number) : [];
  const major = version[0] || 0;
  const minor = version[1] || 0;
  const packageDirs = major === 3 && minor >= 14
    ? ["runtime-qindou", ".python-packages"]
    : major === 3 && minor >= 13
      ? [".python-packages"]
      : major === 3 && minor >= 12
        ? [".python-geo"]
        : [".python-geo", ".python-packages"];
  const localPaths = packageDirs
    .map((directory) => resolve(root, directory))
    .filter((directory) => existsSync(directory));
  const pythonPath = [...localPaths, process.env.PYTHONPATH]
    .filter(Boolean)
    .join(delimiter);
  return {
    command,
    env: { ...process.env, PYTHONPATH: pythonPath }
  };
}
