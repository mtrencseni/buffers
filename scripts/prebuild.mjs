// Runs before the frontend build (see package.json "build", which tauri.conf.json
// calls as beforeBuildCommand). Everything platform-specific about building lives
// here, so the Tauri config stays cross-platform.
//
// macOS: unlock the signing keychain so `tauri build` can sign with the shared
// "Delight Self Signed" cert without prompting. Everywhere else: nothing to do.
// Failure is never fatal — an unsigned/prompted build still beats a dead build.

import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";

if (platform() === "darwin") {
  const keychain = join(homedir(), "Library/Keychains/delight-signing.keychain-db");
  try {
    execFileSync("security", ["unlock-keychain", "-p", "", keychain], { stdio: "ignore" });
  } catch {
    console.warn("prebuild: could not unlock the signing keychain (continuing)");
  }
}
