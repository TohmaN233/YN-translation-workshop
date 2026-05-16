const { existsSync } = require("node:fs");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const projectDir = context.packager.projectDir;
  const productFilename = context.packager.appInfo.productFilename;
  const productName = context.packager.appInfo.productName;
  const version = context.packager.appInfo.version;
  const exePath = join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = join(projectDir, "build", "icon.ico");
  const rceditPath = join(projectDir, "node_modules", "electron-winstaller", "vendor", "rcedit.exe");

  for (const requiredPath of [exePath, iconPath, rceditPath]) {
    if (!existsSync(requiredPath)) {
      throw new Error(`Missing Windows resource patch input: ${requiredPath}`);
    }
  }

  const result = spawnSync(rceditPath, [
    exePath,
    "--set-icon", iconPath,
    "--set-version-string", "FileDescription", productName,
    "--set-version-string", "ProductName", productName,
    "--set-version-string", "OriginalFilename", `${productFilename}.exe`,
    "--set-version-string", "InternalName", productFilename,
    "--set-file-version", version,
    "--set-product-version", version
  ], {
    stdio: "inherit"
  });

  if (result.status !== 0) {
    throw new Error(`rcedit failed with exit code ${result.status ?? "unknown"}`);
  }
};
