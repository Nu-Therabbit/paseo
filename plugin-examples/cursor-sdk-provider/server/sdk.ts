import type { LocalAgentStore } from "@cursor/sdk";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export type CursorSdk = typeof import("@cursor/sdk");

let loading: Promise<CursorSdk> | undefined;

// A failed load is not cached: the next session or status probe retries, so installing the
// missing dependency or fixing the Node version takes effect without reloading the plugin.
// Use `require`, not `import()`: Paseo resolves `server.externals` from the plugin directory
// only through the bundle's require; a dynamic import resolves from the daemon instead.
export function loadCursorSdk(): Promise<CursorSdk> {
  loading ??= Promise.resolve()
    .then(() => require("@cursor/sdk") as CursorSdk)
    .then(
      (sdk) => {
        configureSdk(sdk);
        return sdk;
      },
      (error: unknown) => {
        loading = undefined;
        throw new Error(
          `Cannot load @cursor/sdk. Run "npm install" in the plugin directory (Node >=22.13 is required): ${describe(error)}`,
          { cause: error },
        );
      },
    );
  return loading;
}

function configureSdk(_sdk: CursorSdk): void {
  pointAtPlatformHelpers();
}

// SQLite cannot open paths past the Windows 260-character limit. Keep the margin Windows
// reserves for directory paths (248) so the choice never flips for a workspace near the edge.
const MAX_SQLITE_PATH = 248;
// The deepest file the SQLite store writes: each agent's checkpoint database journal,
// `<root>/agents/agent-<sha256 hex>/store.db-journal`.
const DEEPEST_SQLITE_FILE = path.join("agents", `agent-${"0".repeat(64)}`, "store.db-journal");

// The default local store is SQLite through node:sqlite, under a directory derived from the
// workspace path. Hosts without node:sqlite (some Electron builds) and deep Windows workspaces,
// where that directory passes the path limit, get a JSONL store keyed by the workspace instead.
// The choice depends only on the host and the workspace, so resume finds the same store.
export function localStore(sdk: CursorSdk, cwd: string): LocalAgentStore | undefined {
  const sqlite = Boolean(process.getBuiltinModule?.("node:sqlite"));
  const root = sdk.getDefaultSdkStateRoot(cwd);
  const tooLong =
    process.platform === "win32" && path.join(root, DEEPEST_SQLITE_FILE).length > MAX_SQLITE_PATH;
  if (sqlite && !tooLong) return undefined;
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return new sdk.JsonlLocalAgentStore(path.join(os.homedir(), ".cursor", "sdk", "paseo", key));
}

// The SDK finds ripgrep and the tree-sitter natives by walking up from the host entry
// script and executable. Inside a Paseo plugin subprocess both live in the daemon's
// installation, so point the SDK at the platform package installed next to it here.
function pointAtPlatformHelpers(): void {
  const platformDirectory = findPlatformPackage();
  if (!platformDirectory) return;
  const ripgrep = path.join(
    platformDirectory,
    "bin",
    process.platform === "win32" ? "rg.exe" : "rg",
  );
  if (!process.env.CURSOR_RIPGREP_PATH && existsSync(ripgrep)) {
    process.env.CURSOR_RIPGREP_PATH = ripgrep;
  }
  const vendor = path.join(platformDirectory, "vendor");
  if (!process.env.CURSOR_TREE_SITTER_VENDOR_DIR && existsSync(vendor)) {
    process.env.CURSOR_TREE_SITTER_VENDOR_DIR = vendor;
  }
}

function findPlatformPackage(): string | undefined {
  const cache = createRequire(path.join(os.tmpdir(), "paseo-cursor-sdk.js")).cache;
  const marker = `${path.sep}node_modules${path.sep}@cursor${path.sep}sdk${path.sep}`;
  const sdkModule = Object.keys(cache).find((file) => file.includes(marker));
  if (!sdkModule) return undefined;
  try {
    const manifest = createRequire(sdkModule).resolve(
      `@cursor/sdk-${process.platform}-${process.arch}/package.json`,
    );
    return path.dirname(manifest);
  } catch {
    return undefined;
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
