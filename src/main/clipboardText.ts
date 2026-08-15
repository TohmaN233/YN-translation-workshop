export interface ClipboardTextPort {
  writeText(text: string): void;
  readText(): string;
  clear?(): void;
  write?(data: { text: string }): void;
}

export async function writeClipboardTextVerified(
  clipboard: ClipboardTextPort,
  text: string,
  attempts = 8
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    clipboard.clear?.();
    clipboard.writeText(text);
    if (clipboard.readText() === text) return true;
    clipboard.write?.({ text });
    if (clipboard.readText() === text) return true;
    await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
  }
  return false;
}
