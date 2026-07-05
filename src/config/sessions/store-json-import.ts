// Crash-safe archival for JSON stores imported into the canonical SQLite backend.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export type SessionStoreJsonImportArchiveResult = {
  archivedPaths: string[];
  quarantinedPaths: string[];
  complete: boolean;
};

export function listSessionStoreJsonImportStagePaths(jsonPath: string): string[] {
  const dir = path.dirname(jsonPath);
  const prefix = `${path.basename(jsonPath)}.archive-pending.`;
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(dir, name))
      .toSorted();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function pathExists(filePath: string): boolean {
  try {
    fs.statSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Stages and archives an imported JSON source, resuming any stages left by a crashed process.
 * Unique discoverable stages avoid one importer overwriting another importer's claimed source.
 */
export function archiveImportedSessionStoreJson(params: {
  jsonPath: string;
  expectedDigest: string;
  archivePath: (nonce: string) => string;
  quarantinePath: (nonce: string) => string;
}): SessionStoreJsonImportArchiveResult {
  const nonce = `${process.pid}.${crypto.randomUUID()}`;
  const stagedPath = `${params.jsonPath}.archive-pending.${nonce}`;
  try {
    fs.renameSync(params.jsonPath, stagedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const archivedPaths: string[] = [];
  const quarantinedPaths: string[] = [];
  for (const candidate of listSessionStoreJsonImportStagePaths(params.jsonPath)) {
    let currentDigest: string;
    try {
      currentDigest = crypto.createHash("sha256").update(fs.readFileSync(candidate)).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const candidateNonce = candidate.slice(`${params.jsonPath}.archive-pending.`.length);
    const matchesImport = currentDigest === params.expectedDigest;
    const destination = matchesImport
      ? params.archivePath(candidateNonce)
      : params.quarantinePath(candidateNonce);
    try {
      fs.renameSync(candidate, destination);
      (matchesImport ? archivedPaths : quarantinedPaths).push(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  return {
    archivedPaths,
    quarantinedPaths,
    complete:
      !pathExists(params.jsonPath) &&
      listSessionStoreJsonImportStagePaths(params.jsonPath).length === 0,
  };
}
