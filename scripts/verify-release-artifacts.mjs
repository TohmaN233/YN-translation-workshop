import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFile, listPackage } from "@electron/asar";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = process.env.YN_RELEASE_DIR
  ? path.resolve(rootDir, process.env.YN_RELEASE_DIR)
  : path.join(rootDir, "release");
const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8"));
const artifactBase = `${packageJson.name}-${packageJson.version}-x64`;
const installerName = `${packageJson.name}-Setup-${packageJson.version}-x64.exe`;
const portableName = `${packageJson.name}-Portable-${packageJson.version}-x64.exe`;
const installerPath = path.join(releaseDir, installerName);
const portablePath = path.join(releaseDir, portableName);
const blockmapPath = `${installerPath}.blockmap`;
const latestPath = path.join(releaseDir, "latest.yml");
const asarPath = path.join(releaseDir, "win-unpacked", "resources", "app.asar");
const appUpdatePath = path.join(releaseDir, "win-unpacked", "resources", "app-update.yml");
const checksumPath = path.join(releaseDir, "SHA256SUMS.txt");

for (const requiredPath of [installerPath, portablePath, blockmapPath, latestPath, asarPath, appUpdatePath, checksumPath]) {
  assert.ok(existsSync(requiredPath), `Missing release artifact: ${requiredPath}`);
}

const latest = readFileSync(latestPath, "utf8");
const latestVersion = latest.match(/^version:\s*(.+)$/m)?.[1]?.trim();
const latestInstaller = latest.match(/^path:\s*(.+)$/m)?.[1]?.trim();
const latestSha512 = latest.match(/^sha512:\s*(.+)$/m)?.[1]?.trim();
const latestSize = Number(latest.match(/^\s+size:\s*(\d+)$/m)?.[1]);
assert.equal(latestVersion, packageJson.version, "latest.yml version does not match package.json");
assert.equal(latestInstaller, installerName, "latest.yml points to the wrong installer");
assert.equal(latestSize, statSync(installerPath).size, "latest.yml installer size is stale");
assert.equal(
  latestSha512,
  createHash("sha512").update(readFileSync(installerPath)).digest("base64"),
  "latest.yml installer SHA-512 is stale",
);

const appUpdate = readFileSync(appUpdatePath, "utf8");
assert.match(appUpdate, /^provider:\s*github$/m, "Packaged app is not configured for GitHub updates");
assert.match(appUpdate, /^owner:\s*TohmaN233$/m, "Packaged update owner is incorrect");
assert.match(appUpdate, /^repo:\s*YN-translation-workshop$/m, "Packaged update repository is incorrect");

const archiveEntries = new Set(listPackage(asarPath).map((entry) => entry.replaceAll("\\", "/")));
for (const requiredEntry of [
  "/dist/main/main.js",
  "/node_modules/cheerio/package.json",
  "/node_modules/electron-updater/package.json",
  "/node_modules/js-yaml/package.json",
]) {
  assert.ok(archiveEntries.has(requiredEntry), `Packaged app is missing ${requiredEntry}`);
}
const packagedScripts = [...archiveEntries].filter((entry) => entry.startsWith("/scripts/"));
assert.deepEqual(packagedScripts, ["/scripts/install-skills.mjs"], "Packaged app contains development-only scripts");

const packedPackage = JSON.parse(extractFile(asarPath, "package.json").toString("utf8"));
const packedUpdater = JSON.parse(
  extractFile(asarPath, path.join("node_modules", "electron-updater", "package.json")).toString("utf8"),
);
const packedCheerio = JSON.parse(
  extractFile(asarPath, path.join("node_modules", "cheerio", "package.json")).toString("utf8"),
);
const packedYaml = JSON.parse(
  extractFile(asarPath, path.join("node_modules", "js-yaml", "package.json")).toString("utf8"),
);
const packedMain = extractFile(asarPath, path.join("dist", "main", "main.js")).toString("utf8");
assert.equal(packedPackage.version, packageJson.version, "Packaged app version is stale");
assert.equal(packedUpdater.version, "6.8.9", "Packaged electron-updater version is unexpected");
assert.equal(packedCheerio.version, "1.2.0", "Packaged web-reference HTML parser version is unexpected");
assert.doesNotMatch(
  packedMain,
  /import\s*\{[^}]*\bautoUpdater\b[^}]*\}\s*from\s*["']electron-updater["']/u,
  "Packaged ESM main uses an unsupported named import from CommonJS electron-updater",
);
const [yamlMajor, yamlMinor, yamlPatch] = packedYaml.version.split(".").map(Number);
assert.ok(
  yamlMajor > 4 || (yamlMajor === 4 && (yamlMinor > 1 || (yamlMinor === 1 && yamlPatch > 1))),
  `Packaged js-yaml ${packedYaml.version} contains GHSA-h67p-54hq-rp68`,
);

const declaredChecksums = new Map(
  readFileSync(checksumPath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/u);
      assert.ok(match, `Invalid SHA256SUMS line: ${line}`);
      return [match[2], match[1]];
    }),
);
for (const fileName of ["latest.yml", portableName, installerName, `${installerName}.blockmap`]) {
  const actual = createHash("sha256").update(readFileSync(path.join(releaseDir, fileName))).digest("hex");
  assert.equal(declaredChecksums.get(fileName), actual, `SHA256SUMS is stale for ${fileName}`);
}

console.log(
  JSON.stringify(
    {
      version: packageJson.version,
      artifactBase,
      installer: { file: installerName, bytes: statSync(installerPath).size },
      portable: { file: portableName, bytes: statSync(portablePath).size },
      updater: { provider: "github", package: packedUpdater.version },
      webReferenceParser: packedCheerio.version,
      productionYaml: packedYaml.version,
      checksums: "verified",
    },
    null,
    2,
  ),
);
