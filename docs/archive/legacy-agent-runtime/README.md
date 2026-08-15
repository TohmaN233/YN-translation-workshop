# Rejected Legacy Agent Runtime Documents

These files describe the former YN Agent Workbench/job/runtime bridge. They are
kept only as historical context and must not guide product implementation.

The current source of truth is:

- `docs/agent-runtime-memory.md`
- `docs/pi-web-migration-map.md`
- `docs/pi-rebase-legacy-boundary-audit.md`
- `docs/agent-runtime-codegraph.md`

Do not restore `runProviderJob`, conversation/job/status stores,
`waiting_for_human`, `domainApproval`, raw host-tool protocols, or a renderer
adapter for those formats. Current work must use the native Pi harness and Pi
message contract described in the source-of-truth documents.
