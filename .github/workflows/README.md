# Releasing

`release.yml` builds Buffers for Windows x64 and attaches the binary to a GitHub
Release. Assets live on the Release, not in git, so clones stay small — one build
of the exe is several MB and git would keep every copy forever.

Buffers is self-contained (unlike Delight, which re-exports Buffers' editor and
language registry and therefore needs both repos checked out), so this workflow
needs no extra checkout and no token beyond the built-in `GITHUB_TOKEN`.

## Cutting a release

The tag must match `version` in `src-tauri/tauri.conf.json`, or the workflow
fails on purpose — a mismatch would ship a binary that reports the wrong version.

```bash
# bump src-tauri/tauri.conf.json first if needed, then:
git tag -a v0.1.0 -m "Buffers 0.1.0"
git push origin v0.1.0
```

The workflow builds, then creates a **draft** release with generated notes.
Review it on the Releases page and hit Publish — the download link below only
resolves once a release is published, since `/releases/latest` skips drafts.

Assets:

- `Buffers-<version>-win_x64-portable.exe` — versioned, for archives
- `Buffers-win_x64-portable.exe` — same binary under a stable name, so
  `/releases/latest/download/Buffers-win_x64-portable.exe` is a permanent link
- `…​.sha256` for each

The exe is standalone and needs the WebView2 runtime, which ships with Windows 11.

## Dry runs

Actions tab → Release → **Run workflow**. It builds and uploads the exe as a
workflow artifact (kept 7 days) without creating a release — the cheap way to
check a change didn't break the build.

## Adding platforms later

- **Windows ARM64** — add `aarch64-pc-windows-msvc` to the toolchain targets and
  a second `--target` build.
- **macOS** — add a `macos-latest` job. It cannot be cross-compiled from Windows;
  `.app`/`.dmg` bundling requires a Mac, and do **not** pass `--no-bundle` there
  (the bare binary isn't usable). Unsigned builds are blocked by Gatekeeper on
  other machines; signing needs an Apple Developer ID plus certs in secrets.
- **Installer** — drop `--no-bundle` to get the NSIS `-setup.exe` back, and add
  it to `files:` with a `-setup` kind in the name.
