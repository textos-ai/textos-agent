// Local-script path helper. The only place this repo's scripts learn where
// things live on disk, so a folder rename or move never needs a code change.
//
//   repoPath(...parts)  a path inside THIS repo, resolved from this file's own
//                       location (no absolute paths, no folder names).
//   webPath(...parts)   a path inside the sibling web repo, read from the
//                       VICTORA_WEB_DIR setting (see CLAUDE.md → "Local paths").
//
// No defaults and no "../something" guess: if the setting is missing or points
// at a folder that does not exist, this throws and names the setting.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Root of this repo: two levels up from scripts/lib/. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function repoPath(...parts) {
  return path.join(REPO_ROOT, ...parts);
}

/** Reads a folder path from a named environment setting. Throws if missing or not a folder. */
export function siblingDir(setting) {
  const value = (process.env[setting] || "").trim();
  if (!value) {
    throw new Error(
      `${setting} is not set. Set it to the full path of that repo's folder ` +
        `(a Windows user environment variable; see CLAUDE.md "Local paths"), then open a new terminal.`,
    );
  }
  if (!fs.existsSync(value) || !fs.statSync(value).isDirectory()) {
    throw new Error(`${setting} is set to "${value}", but that folder does not exist.`);
  }
  return path.resolve(value);
}

export function webPath(...parts) {
  return path.join(siblingDir("VICTORA_WEB_DIR"), ...parts);
}
