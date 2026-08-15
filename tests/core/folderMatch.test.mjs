import assert from "node:assert/strict";

import { matchFolderFiles } from "../../src/shared/core/folderMatch.ts";

const matches = matchFolderFiles(
  [
    { name: "scene.txt", relativePath: "route-a/scene.txt", path: "source/route-a/scene.txt", lineCount: 2 },
    { name: "scene.txt", relativePath: "route-b/scene.txt", path: "source/route-b/scene.txt", lineCount: 3 }
  ],
  [
    { name: "scene.txt", relativePath: "route-a/scene.txt", path: "translation/route-a/scene.txt", lineCount: 2 },
    { name: "scene.txt", relativePath: "route-b/scene.txt", path: "translation/route-b/scene.txt", lineCount: 3 }
  ]
);

assert.deepEqual(matches.map((match) => ({
  sourceName: match.sourceName,
  translationPath: match.translationPath,
  status: match.status
})), [
  {
    sourceName: "route-a/scene.txt",
    translationPath: "translation/route-a/scene.txt",
    status: "matched"
  },
  {
    sourceName: "route-b/scene.txt",
    translationPath: "translation/route-b/scene.txt",
    status: "matched"
  }
]);

console.log("folderMatch tests passed");
