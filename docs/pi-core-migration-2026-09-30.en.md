# Pi core and Session format migration

[中文](pi-core-migration-2026-09-30.md)

YN uses the native Pi Agent and Session. `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` are pinned together at `0.99.1`; the project requires Node.js `>=22.19.0`. See [Pi v0.99.1](https://github.com/earendil-works/pi/releases/tag/v0.99.1).

## Agent and Session

- The Host continues to manage tasks, tools, validation and completion conditions; the Pi core Agent handles model calls and native sessions.
- Sessions use native v4 transactions, branches and compaction retained tails. System prompts and tool declarations are stored in the native Pi system transcript.
- When a Worker changes assignments, it resets its active context before sending the current task's prompt and tool definitions, preventing the previous task from carrying into the new context. The complete history remains in the native JSONL session.
- Stop propagates cancellation to Pi compaction requests. Active owners share a Session handle, which is closed when temporary reads finish or a Worker releases it. Session lists read titles on demand to avoid loading full history.

## v3 Session migration and rollback

- Old v3 Sessions can be read before modification. Before compacting the old format or converting it to the native format, YN saves `<session>.jsonl.v3.backup` using an exclusive atomic operation. Backup conflicts, invalid file formats and conversion failures are reported explicitly; the original file is not silently discarded.
- The first successful write uses Pi's native v3-to-v4 conversion. v4 manages Sessions by native session ID. During migration, it verifies messages, Host state, existing compaction, names and usage data.
- Before rollback, stop the application and retain the complete parent/child Session directories and backups. Restore the application code and Pi dependencies together to a compatible version. If the older version requires v3, restore only from the corresponding backup. The backup does not include v4 conversation added after conversion, and newly created v4 Sessions have no v3 original. Do not downgrade in place or overwrite current v4 files.
- Translation output, glossaries and character bibles are project files, not Session-format assets; retain them separately.
