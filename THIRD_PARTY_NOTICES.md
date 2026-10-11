# Third-Party Notices

This project includes the following third-party runtime, document and UI components.

## Pi

- Source: https://github.com/earendil-works/pi
- Local reference path used during development: `.reference/pi`
- License: MIT
- Copyright (c) 2025 Mario Zechner

Relevant adapted ideas include the Agent lifecycle/event contract
(`agent_start/end`, `turn_start/end`, `message_start/update/end`,
`tool_execution_start/end`), Pi's tool execution batch contract (parallel-safe
tools may execute concurrently while tool-result messages remain source-ordered),
steering/follow-up queue-drain semantics, prompt-cache-friendly session handling,
and subagent orchestration patterns. This project keeps its own
translation/proofreading host tools, artifact validation, and storage model.

The 0.99.1 core migration also source-adapts Pi's MIT-licensed
`harness/session/context.ts` projection in
`src/main/agent/piNative/sessionAccess.ts`, because that helper is not a public
package export. Storage transactions, branches and compaction entries remain
native Pi structures. The disk-indexed Storage implementation in
`src/main/agent/piNative/indexedJsonlStorage.ts` also adapts native Storage query,
list, branch and usage aggregation semantics from Pi 0.99.1 (MIT). It preserves
Pi transaction validation and Session APIs while loading historical payloads
on demand. `src/shared/agent/piLegacyConfiguredModels.ts` contains
official 0.80.6 catalog metadata only for explicitly configured model IDs removed
from 0.99.1; it is a migration input, not a maintained replacement catalog.

MIT permission notice:

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

## PDF components

- PDF.js 6.4.299: https://github.com/mozilla/pdf.js — Apache-2.0. License distributed in `node_modules/pdfjs-dist/LICENSE`.
- pdf-lib 1.17.1: https://github.com/Hopding/pdf-lib — MIT, copyright 2019 Andrew Dillon. License distributed in `node_modules/pdf-lib/LICENSE.md`.
- @pdf-lib/fontkit 1.1.1: https://github.com/Hopding/fontkit — MIT. License declared in the distributed package README.
- @napi-rs/canvas 1.0.11: https://github.com/Brooooooklyn/canvas — MIT, copyright 2020 lynweklm@gmail.com. License distributed in `node_modules/@napi-rs/canvas/LICENSE`.
- Noto Sans SC: https://github.com/google/fonts/tree/main/ofl/notosanssc — SIL Open Font License 1.1, copyright 2014–2021 Adobe. Static weight-400 font, provenance and full license distributed in `assets/fonts/`.

PDF layout mapping was informed by BabelDOC's intermediate-layout design
(https://github.com/funstory-ai/BabelDOC). BabelDOC code and its translation engine
are not bundled or copied.

## pi-web

- Source: https://github.com/agegr/pi-web
- Local reference path used during development: `.reference/pi-web`
- License: MIT
- Copyright (c) 2026 agegr

Relevant adapted ideas include rendering assistant text, thinking, tool calls,
tool results, and subagent/job activity as structured transcript blocks instead
of plain chat text or top-level status tags.

MIT permission notice:

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
