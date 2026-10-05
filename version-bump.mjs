import fs from "node:fs";

// Type can be patch, minor, major. Defaults to patch.
const bumpType = process.argv[2] || "patch";

const pkgPath = "package.json";
const manifestPath = "manifest.json";
const versionsPath = "versions.json";

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const versions = fs.existsSync(versionsPath)
  ? JSON.parse(fs.readFileSync(versionsPath, "utf8"))
  : {};

const currentVersion = pkg.version || "1.0.0";
const parts = currentVersion.split(".").map(Number);
if (parts.length !== 3 || parts.some(isNaN)) {
  throw new Error(`Invalid semver version in package.json: ${currentVersion}`);
}

let [major, minor, patch] = parts;
if (bumpType === "major") {
  major += 1;
  minor = 0;
  patch = 0;
} else if (bumpType === "minor") {
  minor += 1;
  patch = 0;
} else {
  // Default: patch
  patch += 1;
}

const newVersion = `${major}.${minor}.${patch}`;

// 1. Update package.json
pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

// 2. Update manifest.json
manifest.version = newVersion;
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// 3. Update versions.json
versions[newVersion] = manifest.minAppVersion || "1.5.0";
fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + "\n");

console.log(`Bumped version: ${currentVersion} -> ${newVersion}`);
