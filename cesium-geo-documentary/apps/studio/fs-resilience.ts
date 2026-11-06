import { copyFile, readFile, rename, rm, writeFile } from "node:fs/promises";

const TRANSIENT_FILE_ERRORS = new Set(["EMFILE", "ENFILE", "EBUSY", "EAGAIN", "EPERM", "EACCES"]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readFileResilient(path: string): Promise<Buffer>;
export async function readFileResilient(path: string, encoding: BufferEncoding): Promise<string>;
export async function readFileResilient(path: string, encoding?: BufferEncoding): Promise<Buffer | string> {
  let attempt = 0;
  while (true) {
    try {
      return encoding ? await readFile(path, encoding) : await readFile(path);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (!TRANSIENT_FILE_ERRORS.has(code) || attempt >= 5) throw error;
      await delay(30 * (2 ** attempt));
      attempt += 1;
    }
  }
}

export async function readJsonResilient<T>(path: string): Promise<T> {
  return JSON.parse(await readFileResilient(path, "utf8")) as T;
}

/**
 * Persist a payload without ever exposing a partially-written file at `path`.
 *
 * Windows scanners and concurrent readers can briefly lock either file, so retry
 * the complete temp-file + rename transaction on transient failures.
 *
 * `allowDirectFallback` lets a caller accept a direct write to `path` when a
 * scanner keeps blocking the adjacent `.tmp` file. That is only safe when a
 * truncated destination is harmless — project snapshots use a never-before-used
 * revision filename, and readers skip incomplete historical revisions. Anything
 * whose *existence* is treated as "this file is complete" (a cached download)
 * must pass `false`.
 */
async function writeAtomicResilient(path: string, payload: string | Buffer, allowDirectFallback: boolean): Promise<void> {
  let attempt = 0;
  while (true) {
    const temporary = `${path}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      await writeFile(temporary, payload);
      try {
        await rename(temporary, path);
      } catch (renameError) {
        const renameCode = renameError && typeof renameError === "object" && "code" in renameError ? String(renameError.code) : "";
        // Unlike POSIX, Windows does not consistently let rename replace an
        // existing file. Copy the already-complete temporary payload over the
        // destination, then remove the temporary file ourselves.
        if (renameCode !== "EEXIST") throw renameError;
        await copyFile(temporary, path);
        await rm(temporary, { force: true });
      }
      return;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (!TRANSIENT_FILE_ERRORS.has(code)) throw error;
      if (attempt >= 6) {
        if (!allowDirectFallback) throw new Error("文件暂时无法写入磁盘，请稍后重试或检查项目文件夹权限", { cause: error });
        // Project snapshots use a new revision filename for every save. If a
        // Windows scanner blocks creation of the adjacent `.tmp` file, writing
        // that still-unused revision directly is safe: readers already ignore
        // incomplete historical snapshots and the next save gets a new name.
        try {
          await writeFile(path, payload, { flag: "wx" });
          return;
        } catch (fallbackError) {
          const fallbackCode = fallbackError && typeof fallbackError === "object" && "code" in fallbackError
            ? String(fallbackError.code)
            : "";
          if (fallbackCode === "EEXIST") return;
          throw new Error("方案暂时无法写入磁盘，请稍后重试或检查项目文件夹权限", { cause: fallbackError });
        }
      }
      await delay(40 * (2 ** attempt));
      attempt += 1;
    }
  }
}

export async function writeJsonAtomicResilient(path: string, value: unknown): Promise<void> {
  return writeAtomicResilient(path, JSON.stringify(value, null, 2), true);
}

/**
 * Persist binary content atomically. `getCachedPhoto` treats a file's mere
 * existence as "this download completed", so a half-written image would be served
 * as the cache hit for every later import and show up truncated in the export.
 */
export async function writeFileAtomicResilient(path: string, data: Buffer): Promise<void> {
  return writeAtomicResilient(path, data, false);
}

/** Write an immutable, never-before-used version snapshot directly. */
export async function writeJsonVersionResilient(path: string, value: unknown): Promise<void> {
  const payload = JSON.stringify(value, null, 2);
  let attempt = 0;
  while (true) {
    try {
      await writeFile(path, payload, { encoding: "utf8", flag: "wx" });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code === "EEXIST") throw error;
      if (!TRANSIENT_FILE_ERRORS.has(code) || attempt >= 7) {
        throw new Error("方案暂时无法写入磁盘，请稍后重试或检查项目文件夹权限", { cause: error });
      }
      await delay(45 * (2 ** attempt));
      attempt += 1;
    }
  }
}
