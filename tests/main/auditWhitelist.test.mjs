import { strict as assert } from "node:assert";

import { mergeAuditWhitelistDocument } from "../../src/main/auditWhitelist.ts";

const first = mergeAuditWhitelistDocument({}, {
  documentId: "chapters/a.txt",
  sourcePath: "D:\\project\\chapters\\a.txt",
  lines: [9, 2, 9]
}, "2026-08-10T00:00:00.000Z");
const second = mergeAuditWhitelistDocument(first, {
  documentId: "chapters/b.txt",
  sourcePath: "D:\\project\\chapters\\b.txt",
  lines: [2]
}, "2026-08-10T00:01:00.000Z");

assert.equal(second.version, 2);
assert.equal(Object.keys(second.documents).length, 2);
assert.deepEqual(second.documents["chapters/a.txt"].lines, [2, 9]);
assert.deepEqual(second.documents["chapters/b.txt"].lines, [2]);

const migrated = mergeAuditWhitelistDocument({
  version: 1,
  sourcePath: "D:\\project\\chapters\\old.txt",
  lines: [3],
  updatedAt: "2026-08-09T00:00:00.000Z"
}, {
  documentId: "chapters/new.txt",
  sourcePath: "D:\\project\\chapters\\new.txt",
  lines: [7]
}, "2026-08-10T00:02:00.000Z");

assert.equal(Object.keys(migrated.documents).length, 2);
assert.deepEqual(migrated.documents["d:/project/chapters/old.txt"].lines, [3]);
assert.deepEqual(migrated.documents["chapters/new.txt"].lines, [7]);

const upgradedIdentity = mergeAuditWhitelistDocument({
  version: 2,
  documents: {
    "d:/project/chapters/a.txt": {
      documentId: "",
      sourcePath: "D:\\project\\chapters\\a.txt",
      lines: [],
      updatedAt: "2026-08-10T00:00:00.000Z"
    }
  },
  updatedAt: "2026-08-10T00:00:00.000Z"
}, {
  documentId: "chapters/a.txt",
  sourcePath: "D:\\project\\chapters\\a.txt",
  lines: [11]
}, "2026-08-10T00:03:00.000Z");

assert.deepEqual(Object.keys(upgradedIdentity.documents), ["chapters/a.txt"]);
assert.deepEqual(upgradedIdentity.documents["chapters/a.txt"].lines, [11]);

console.log("audit whitelist document scopes passed");
