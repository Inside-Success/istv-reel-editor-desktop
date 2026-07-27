"use strict";

// Runs once per packed app bundle, i.e. once per --mac arch. Does two things
// that electron-builder cannot do for us on its own:
//
//   1. Drops in the ffmpeg binary matching the arch being packed.
//   2. Ad-hoc code signs the result.
//
// Both exist because a single macOS job builds BOTH arches. See the long
// comments on each step below.
//
// This must be `afterPack`, not `afterSign`: electron-builder only emits
// `afterSign` when signing actually happened, and with no Developer ID it
// skips signing and logs `skipping "afterSign" hook as no signing occurred,
// perhaps you intended "afterPack"?`. `afterPack` also runs before the DMG and
// ZIP are assembled, so the signature and the correct ffmpeg end up inside the
// shipped artifacts rather than being applied too late to matter.

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { Arch } = require("electron-builder");

// ffmpeg-static resolves ONE binary at install time, chosen by npm_config_arch,
// and writes it to this single path. So a checkout can only ever hold one arch's
// ffmpeg at a time, while we need two. CI works around that by running the
// package's installer once per arch and stashing each result in
// FFMPEG_STAGE_DIR as ffmpeg-x64 / ffmpeg-arm64; we copy the right one in here.
//
// Without this the build silently produces a mismatch: the arm64 DMG carries an
// Intel ffmpeg (or vice versa), and the app dies with macOS EBADARCH (-86, "Bad
// CPU type in executable") the first time it shells out to ffmpeg. That is
// exactly what shipped through v0.1.8 — `mac.target` lists both arches, which
// overrides the `--arm64`/`--x64` CLI flag, so each matrix job built both DMGs
// but had only its own arch's ffmpeg on disk, and the later job's uploads
// overwrote the earlier job's.
//
// ffprobe-static needs none of this: it vendors every arch under
// bin/<platform>/<arch>/ and picks at runtime.
const FFMPEG_REL = path.join(
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "node_modules",
  "ffmpeg-static",
  "ffmpeg"
);

// Mach-O slice names are NOT electron-builder's arch names: an Intel slice is
// spelled x86_64, not x64. Comparing the two spellings directly makes the
// verification below reject every perfectly good Intel binary.
const MACHO_ARCH = {
  x64: "x86_64",
  arm64: "arm64",
  ia32: "i386",
};

function archName(arch) {
  const name = Arch[arch];
  if (!name) {
    throw new Error(`afterPack: unrecognised arch ${arch}`);
  }
  return name;
}

// `lipo -archs` prints the slices a Mach-O actually contains. Cheap way to turn
// "wrong ffmpeg shipped" from a runtime crash on a user's Mac into a build
// failure here.
function machOArches(binary) {
  return execFileSync("lipo", ["-archs", binary], { encoding: "utf8" })
    .trim()
    .split(/\s+/);
}

function placeFfmpeg(appPath, target) {
  const dest = path.join(appPath, FFMPEG_REL);
  if (!fs.existsSync(dest)) {
    throw new Error(`afterPack: no bundled ffmpeg at ${dest}`);
  }

  const stageDir = process.env.FFMPEG_STAGE_DIR;
  if (stageDir) {
    const staged = path.join(stageDir, `ffmpeg-${target}`);
    if (!fs.existsSync(staged)) {
      // Hard failure on purpose. Falling back to whatever npm happened to
      // install is how the wrong-arch binary shipped in the first place.
      throw new Error(
        `afterPack: FFMPEG_STAGE_DIR is set but ${staged} is missing — ` +
          `cannot guarantee a ${target} ffmpeg`
      );
    }
    fs.copyFileSync(staged, dest);
    fs.chmodSync(dest, 0o755);
    console.log(`  • afterPack: staged ${target} ffmpeg`);
  } else if (target !== process.arch) {
    // Local cross-arch build with no staging dir: the binary on disk is the
    // host's, so it is wrong for this bundle. Warn rather than throw so
    // `npm run dist:mac` still works for a quick host-arch smoke test.
    console.warn(
      `  ⚠ afterPack: packing ${target} but ffmpeg on disk is ${process.arch} ` +
        `and FFMPEG_STAGE_DIR is unset — this bundle will hit EBADARCH. ` +
        `Set FFMPEG_STAGE_DIR (CI does) for a shippable cross-arch build.`
    );
    return;
  }

  // Universal slices are fine; we only care that the target arch is present.
  const want = MACHO_ARCH[target];
  const arches = machOArches(dest);
  if (!arches.includes(want)) {
    throw new Error(
      `afterPack: ffmpeg is [${arches.join(", ")}] but this bundle is ` +
        `${target} (needs a ${want} slice)`
    );
  }
}

// Ad-hoc signing (`--sign -`) writes a signature with no identity behind it.
//
// It is not about notarization. electron-builder rewrites the Electron binary
// it downloaded — renames it, edits Info.plist, injects resources — which
// INVALIDATES the ad-hoc signature Electron's own prebuilt binary already
// carried. macOS refuses to launch a bundle whose signature is present but
// broken and reports it as "ISTV Reel Editor is damaged and can't be opened.
// You should move it to the Bin", NOT the familiar "unidentified developer"
// prompt. On Apple Silicon this is unconditional: arm64 code must carry a valid
// signature to be exec'd at all, so right-click ▸ Open cannot rescue it.
// Re-signing restores a self-consistent signature and the app launches.
//
// What this does NOT do: the app is still unsigned in the Developer ID sense
// and still un-notarized, so a downloaded copy keeps its quarantine flag and
// Gatekeeper still gates the first launch — the user has to go through System
// Settings ▸ Privacy & Security ▸ "Open Anyway" once. Swap this for a real
// `Developer ID Application` cert plus notarization (CSC_LINK,
// CSC_KEY_PASSWORD, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID) to
// get a clean double-click install; at that point electron-builder signs on its
// own and the signing half of this hook can go away.
function adhocSign(appPath) {
  // Sign inner Mach-O files before the bundle that contains them: codesign
  // seals nested code by hash, so re-signing a nested binary after the outer
  // bundle would invalidate the outer signature again.
  const nested = [
    path.join(appPath, FFMPEG_REL),
    ...["arm64", "x64"].map(a =>
      path.join(
        appPath,
        "Contents",
        "Resources",
        "app.asar.unpacked",
        "node_modules",
        "ffprobe-static",
        "bin",
        "darwin",
        a,
        "ffprobe"
      )
    ),
  ].filter(p => fs.existsSync(p));

  for (const binary of nested) {
    execFileSync(
      "codesign",
      ["--force", "--sign", "-", "--timestamp=none", binary],
      { stdio: "inherit" }
    );
  }

  // --deep so the Electron Framework and the Helper .apps are re-signed too;
  // they were invalidated by the same rewrite that broke the main binary.
  // Apple deprecates --deep for real distribution signing, but for ad-hoc it is
  // the supported way to reseal an entire tree in one pass.
  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
    { stdio: "inherit" }
  );

  // Fail the build rather than upload another "damaged" DMG.
  execFileSync("codesign", ["--verify", "--strict", appPath], {
    stdio: "inherit",
  });
  console.log("  • afterPack: ad-hoc signed and verified");
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const target = archName(context.arch);
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );

  placeFfmpeg(appPath, target);
  adhocSign(appPath);
};
