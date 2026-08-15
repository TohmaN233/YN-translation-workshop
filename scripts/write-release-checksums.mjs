import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = process.env.YN_RELEASE_DIR
  ? path.resolve(rootDir, process.env.YN_RELEASE_DIR)
  : path.join(rootDir, "release");
const packageJson = JSON.parse(await readFile(path.join(rootDir, "package.json"), "utf8"));
const installerName = `${packageJson.name}-Setup-${packageJson.version}-x64.exe`;
const files = [
  "latest.yml",
  `${packageJson.name}-Portable-${packageJson.version}-x64.exe`,
  installerName,
  `${installerName}.blockmap`
];

const lines = [];
for (const fileName of files) {
  const content = await readFile(path.join(releaseDir, fileName));
  lines.push(`${createHash("sha256").update(content).digest("hex")}  ${fileName}`);
}

await writeFile(path.join(releaseDir, "SHA256SUMS.txt"), `${lines.join("\n")}\n`, "utf8");
console.log(`Updated ${path.relative(rootDir, releaseDir)}/SHA256SUMS.txt for ${files.length} artifacts.`);
