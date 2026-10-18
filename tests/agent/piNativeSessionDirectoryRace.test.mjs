import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PiSessionRepository } from "../../src/main/agent/piNative/sessionRepository.ts";

for (const child of [false, true]) {
  for (const operation of ["create", "list"]) {
    test(`${child ? "child" : "parent"} session ${operation} tolerates a concurrent atomic publication`, async () => {
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "yn-session-directory-race-"));
      const repository = new PiSessionRepository(workspace);
      const originalReaddir = fs.readdir;
      try {
        const first = await (child ? repository.createChild("first") : repository.create("first"));
        const directory = path.dirname(first.metadata.path);
        const header = JSON.parse((await fs.readFile(first.metadata.path, "utf8")).split("\n")[0]);
        const published = path.join(directory, "concurrent.jsonl");
        const temporary = `${published}.tmp`;
        await fs.writeFile(temporary, `${JSON.stringify({ ...header, id: "concurrent" })}\n`);
        let renamed = false;
        fs.readdir = async (target, options) => {
          const entries = await originalReaddir(target, options);
          if (!renamed && path.resolve(String(target)) === directory && options?.withFileTypes) {
            renamed = true;
            await fs.rename(temporary, published);
          }
          return entries;
        };
        syncBuiltinESMExports();

        if (operation === "create") {
          await (child ? repository.createChild("next") : repository.create("next"));
        } else {
          await (child ? repository.listChildMetadata() : repository.listMetadata());
        }
        assert.equal(renamed, true, "publish the temporary JSONL after the directory snapshot and before metadata lookup");
        const entries = await (child ? repository.listChildMetadata() : repository.listMetadata());
        assert.deepEqual(entries.map(entry => entry.id).sort(), operation === "create"
          ? ["concurrent", "first", "next"] : ["concurrent", "first"]);
      } finally {
        fs.readdir = originalReaddir;
        syncBuiltinESMExports();
        await repository.close();
        await fs.rm(workspace, { recursive: true, force: true });
      }
    });
  }
}

test("session discovery still rejects errors reading an actual JSONL file", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "yn-session-directory-errors-"));
  const repository = new PiSessionRepository(workspace);
  const originalLstat = fs.lstat;
  try {
    const session = await repository.create("inaccessible");
    fs.lstat = async (target, ...options) => {
      if (path.resolve(String(target)) === session.metadata.path) {
        throw Object.assign(new Error("EACCES: synthetic session access failure"), { code: "EACCES" });
      }
      return originalLstat(target, ...options);
    };
    syncBuiltinESMExports();
    await assert.rejects(repository.listMetadata(), /EACCES/);
  } finally {
    fs.lstat = originalLstat;
    syncBuiltinESMExports();
    await repository.close();
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
