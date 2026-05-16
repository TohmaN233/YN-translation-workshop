import path from "node:path";

export function backupTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function buildTimestampedBackupPath(targetPath: string, workspaceDir: string, date = new Date()): string {
  return path.join(workspaceDir, "backups", `${path.basename(targetPath)}.${backupTimestamp(date)}.bak`);
}
