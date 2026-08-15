# Third-Party Notices

This project includes Agent runtime and UI design work informed by the following
MIT-licensed projects.

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

MIT permission notice:

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

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
