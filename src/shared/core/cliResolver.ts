export interface CliResolveOptions {
  platform: string;
  pathEnv?: string;
  pathext?: string;
  exists: (candidate: string) => boolean;
  pathSeparator?: string;
  pathJoin?: (dir: string, file: string) => string;
}

export function executableNames(command: string, platform: string, pathext = ""): string[] {
  if (/[\\/]/.test(command)) {
    return [command];
  }
  if (platform !== "win32") {
    return [command];
  }
  const lower = command.toLowerCase();
  const extensions = pathext
    .split(";")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (/\.[a-z0-9]+$/i.test(command) && extensions.some((ext) => lower.endsWith(ext))) {
    return [command];
  }
  const ordered = [".exe", ".cmd", ".bat", ".com", ...extensions].filter((ext, index, array) => array.indexOf(ext) === index);
  return ordered.map((ext) => `${command}${ext}`);
}

export function resolveCliFromPath(command: string, options: CliResolveOptions): string | undefined {
  const join = options.pathJoin ?? ((dir, file) => `${dir.replace(/[\\/]$/, "")}/${file}`);
  const separator = options.pathSeparator ?? (options.platform === "win32" ? ";" : ":");
  const names = executableNames(command, options.platform, options.pathext);
  const direct = names.find((name) => /[\\/]/.test(name) && options.exists(name));
  if (direct) {
    return direct;
  }
  for (const dir of (options.pathEnv ?? "").split(separator).map((item) => item.trim()).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (options.exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}
