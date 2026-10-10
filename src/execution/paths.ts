/**
 * Filesystem locations for the execution layer.
 * OWNER: Developer 4.
 *
 * Paths are resolved from this file's location (not process.cwd()), because
 * MCP clients such as WorkBuddy may launch the server from any directory.
 * Environment variables are read on every call so tests can isolate state.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root: <root>/src/execution or <root>/dist/execution -> <root>. */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const APPROVAL_HOST = "127.0.0.1"; // deliberately not configurable

export interface ExecutionPaths {
  dataDir: string;
  databaseFile: string;
  exportsDir: string;
  approvalPort: number;
  approvalBaseUrl: string;
}

export function getPaths(): ExecutionPaths {
  const dataDir = path.resolve(process.env.INTERNGUARD_DATA_DIR ?? path.join(PROJECT_ROOT, "data"));
  const exportsDir = path.resolve(process.env.INTERNGUARD_EXPORTS_DIR ?? path.join(PROJECT_ROOT, "exports"));
  const port = Number(process.env.INTERNGUARD_APPROVAL_PORT);
  const approvalPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : 4317;
  return {
    dataDir,
    databaseFile: path.join(dataDir, "internguard.db"),
    exportsDir,
    approvalPort,
    approvalBaseUrl: `http://${APPROVAL_HOST}:${approvalPort}`,
  };
}

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Resolve `segments` under `root` and refuse anything that escapes it.
 * Segments must already be server-generated; this is a second line of defence.
 */
export function safeJoin(root: string, ...segments: string[]): string {
  for (const seg of segments) {
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(seg) || seg === "." || seg === "..") {
      throw new Error(`Unsafe path segment rejected: ${JSON.stringify(seg)}`);
    }
  }
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Path escapes the exports directory");
  }
  return target;
}

/** Lowercase ASCII slug for folder names: [a-z0-9-], max 40 chars, never empty. */
export function slugify(text: string | null | undefined): string {
  const slug = (text ?? "")
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "application";
}
