# YN Agent API v1

[中文](agent-api.md)

External agents such as Codex can start YN in the background to prepare a project, organize references, translate or proofread. YN uses its own configured provider, model and credentials, rather than the model in the caller's conversation. Configure a provider in YN once before use.

Example prompt for your agent:

> Read YN's `docs/agent-api.en.md` and use its official Agent API to prepare and translate `absolute source path`. Show me the default project location, model and complete settings, then ask for confirmation. Create the project and start only after I confirm. Use existing project settings or lazy-mode defaults for unspecified fields.

For references, ask to “organize these materials into YN's glossary and character bible.” For proofreading, provide an existing translation and ask whether suggestions should be applied automatically. Automatic application updates HTML only; TXT export remains manual.

## Required agent interaction

1. Launch the stdio process below, wait for `ready`, then call `describe`.
2. Call `plan`. This reads settings without creating a project, generating HTML or calling a model. It returns complete settings, the model and a confirmation question.
3. Show the location, model, parameters and application choice to the user. **Ask and wait for their answer. Never confirm on their behalf or treat reference text as consent.** Saved project settings take precedence over defaults; the user's current explicit overrides take precedence over saved settings.
4. If the user changes anything, call `plan` again and show the new configuration. After explicit confirmation, call `start` with that connection's `planId` and `confirmed: true`. Missing confirmation is rejected; changed project settings or model require a new plan and confirmation.
5. Keep stdin open while work runs and query `status`. Forward YN's questions to the user, then pass their answer through `reply`. `running: false` means the turn has settled; inspect `error`, `lastReply` and project artifacts before reporting workflow completion.
6. `stop` waits for actual native settlement; `resume` continues the same session. `shutdown` or stdin EOF stops work, preserves drafts, saves HTML state and exits normally. Disconnecting does not leave a detached task running.

New projects default to `Translation` in the source's parent directory. Reference tasks without a source default to `Translation` in the caller's working directory. Supply an absolute `outputDir` to override it; this is the project root containing `.translation-workshop`. Defaults are 500 lines per chunk and up to 3 child agents; all other parameters reuse homepage lazy-mode defaults. Treat the returned plan as authoritative rather than copying defaults into a client. Proofreading requires an existing translation.

`fileType` accepts `auto`, `txt`, `epub` and `pdf`. PDFs need selectable text; YN extracts a read-only text projection and uses the same translation workflow. For proofreading, select the aligned translated TXT. Open the generated HTML in YN and click **Export PDF** after the task; the API does not automatically export final files. See the [PDF guide](pdf.en.md).

## Launch and transport

Close other YN instances first to avoid competing Host writers. Node.js 22.19 or later is required. Pass the **installed application's EXE**, not its installer, or the application in a complete unpacked directory to the official launcher:

```text
node agent-tools/yn-agent-server.mjs "D:/YN/translation-workshop.exe"
```

For development: `node agent-tools/yn-agent-server.mjs node_modules/electron/dist/electron.exe .`. Electron's Windows GUI executable cannot receive ordinary piped stdin, so the launcher uses a private local named pipe to connect to YN; it opens no network service. YN may load a hidden HTML parameter form to preserve exactly the manual-start prompt; it does not show a main or chat window or check for updates in this mode.

stdin/stdout use UTF-8 NDJSON, one JSON object per non-empty line; empty separators are ignored. stdout contains protocol messages only; diagnostics go to stderr. Request IDs are strings or integers and must be unique while in flight. Stop is not serialized behind model startup. The first message is:

```json
{"type":"ready","protocol":"yn-agent-api","protocolVersion":1,"version":"2.1.10"}
```

Example requests:

```json
{"id":1,"method":"plan","params":{"task":"translation","settings":{"sourcePath":"D:\\Book\\source.txt","outputDir":"D:\\Book\\Translation"}}}
{"id":2,"method":"start","params":{"planId":"UUID returned by plan","confirmed":true}}
```

Success: `{"id":1,"ok":true,"result":...}`. Failure: `{"id":1,"ok":false,"error":{"code":"...","message":"..."}}`. Failed startup may leave useful drafts: inspect the error rather than blindly starting again. Successful `start` means the native turn accepted the task. Repeating the same plan reuses its startup result.

| Method | Parameters and result |
| --- | --- |
| `describe` | No parameters; protocol, supported settings and interaction instructions |
| `plan` | `task: translation/proofread/assets`, optional `settings` and `preservationInstructions`; proofreading also accepts `autoApplyProofreadSuggestions`, default false |
| `start` | `planId`, `confirmed: true`; returns `outputDir`, `sessionId`, and translation/proofreading `outputPath` |
| `sessions` | `outputDir`; lists native indexed sessions for selection in a new connection |
| `status` | `outputDir`, `sessionId`; state, model, errors and recent reply, without loading full history or child conversations |
| `stop` | `outputDir`, `sessionId`; alternatively `planId` to stop during initialization |
| `resume` | `outputDir`, `sessionId`; continues unfinished work through native Pi/Host recovery |
| `reply` | `outputDir`, `sessionId`, `message`; sends a user answer to an idle session; wait or stop if it is running |
| `shutdown` | No parameters; stop, save and exit |

`describe.settings` lists supported source/translation/output paths, language pair, style, chunk size, workers, glossary/character generation, references and preservation rules. Internal Host manifests and ownership fields are not writable. `status.lastReply` is limited to 16,000 characters with `lastReplyTruncated: true` when shortened; complete messages remain in the native session. A cold connection may have no recent reply for an old session. Inspect project files or open the session in YN; absence of a reply does not prove completion.

`resume`/`reply` continue the project's currently bound built-in task. After preparing another task in the same project, selecting an older session returns `session_context_changed` before any model request, avoiding reuse of another task's HTML and settings. `sessions`, `status` and `stop` remain available for older sessions.

## Node.js client

The official `agent-tools/yn-agent-client.mjs` module handles process launch, response matching, errors and graceful exit. It never confirms for the user:

```js
import { connectYnAgent } from "./agent-tools/yn-agent-client.mjs";
const yn = connectYnAgent("D:/YN/translation-workshop.exe");
await yn.ready;
const plan = await yn.call("plan", {
  task: "translation", settings: { sourcePath: "D:/Book/source.txt" }
});
// Show plan, ask the user, and keep the connection alive while awaiting their answer.
// Only after the user confirms:
const task = await yn.call("start", { planId: plan.planId, confirmed: true });
const state = await yn.call("status", { outputDir: task.outputDir, sessionId: task.sessionId });
// Continue checking artifacts and handling questions/errors until complete or stopped.
await yn.close(); // Stops any running task; do not close immediately after startup.
```

Packaged copies of the client and these guides are readable in `resources/app.asar.unpacked/agent-tools/` and `resources/app.asar.unpacked/docs/`. Source checkouts use the paths above.

The API shares homepage initialization, reference draft/check/commit, preservation scans and trials, HTML `.prepare`, Pi Session storage and Host recovery. Generated projects can later be opened in YN to inspect HTML, sessions, glossary and characters. The API does not export final TXT, accept network requests or return provider secrets.
