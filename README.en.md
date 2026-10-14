<div align="left">
<img src="docs/yn-guide/assets/app-icon.png" alt="YN Translation Workshop logo" width="72">
<h1>YN Translation Workshop</h1>
</div>

[![MIT Licensed](https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square)](LICENSE)

**An open-source AI translation, proofreading and line-review workbench for long-form fiction and game localization.**

YN turns TXT, EPUB and text-layer PDF into editable source/translation views. Glossaries, character references, structural preservation, chunked translation and proofreading belong to one project. Run AI across a whole project or ask about selected lines, then decide what to write to the final file.

[中文](README.md) · [Windows downloads](https://github.com/TohmaN233/YN-translation-workshop/releases) · [User guide](https://tohman233.github.io/YN-translation-workshop/index.en.html) · [Project introduction (Chinese)](https://tgy233.top/tgypage/yn/)

Use it for cross-chapter terminology, game control codes, manual line review and resumable long tasks. It is not a live screen translator. PDF support currently requires selectable text and does not include OCR. Cloud models receive the text needed for their assignments; translation quality still depends on the model, references and human review.

## Requirements

- Current releases target Windows x64. Packaged desktop use does not require Node.js.
- AI features require a provider, model and authorization configured in YN. Manual editing remains available with the Agent off.
- Use TXT, EPUB or a text-layer PDF. Proofreading requires an existing translation aligned with the source.

## Download and installation

Choose `translation-workshop-Setup-2.2.0-x64.exe` or `translation-workshop-Portable-2.2.0-x64.exe` from [Releases](https://github.com/TohmaN233/YN-translation-workshop/releases). Public availability follows the published release; these docs describe 2.2.0.

Installers support in-app updates; portable builds are replaced using the release page. Releases include `SHA256SUMS.txt`.

## Configuration

Configure your provider and model at the top of the start page, then select the source, project location, language direction and style. New tasks default to **500 lines per chunk** and **up to 3 child agents**; explicit settings in existing projects are retained.

Use reference preparation before translation when you already have terminology, characters or project notes. For game text, inspect preservation-rule matches before starting so a regex does not lock translatable dialogue.

## First translation

1. Select the source and confirm the project location. Try a small sample first.
2. Use the translation preparation shortcut and confirm its settings. YN checks the content, trials preservation rules, opens line-review HTML and starts the same translation workflow. Generate HTML first when you prefer more manual control.
3. Refresh the candidate and edit or inspect the rows. Bind an existing translation before starting proofreading.
4. Accept, reject or edit suggestions. Auto-apply changes HTML only; **writing the final TXT is manual**. EPUB/PDF use their export controls.

![Line-review page for comparing source text, editing translations and reviewing suggestions](docs/yn-guide/assets/screens/line-review.png)

[Complete tutorial](https://tohman233.github.io/YN-translation-workshop/guides.en.html) · [PDF guide](docs/pdf.en.md) · [Background Agent API](docs/agent-api.en.md)

## What it helps with

| Need | YN behavior |
| --- | --- |
| Names and character references across chapters | Formal glossary, candidates, character records and direct reference matches; conflicts stay visible |
| Damaged game tags, variables or control codes | Preservation rules and mechanical checks, including proofreading suggestions |
| Human inspection of many rows | Source/target view, search, editing, candidate refresh and suggestion decisions |
| Continue an interrupted translation | Verify drafts and review evidence before resuming; stop blind retries of internal failures |
| PDFs containing code, formulas or figures | Host-protected code/math, on-demand image context and PDF export from HTML |
| Run without opening the main window | External agents preview and confirm a plan through the official background API |

See the [feature guide](docs/features.en.md) for settings, reuse, sampled proofreading, LAN access and artifact locations.

## Projects translated with YN

- **Japanese to Chinese:** [game localization demonstrations by 美希命](https://space.bilibili.com/1863789519), including many localized games.
- **Japanese to Chinese:** [the Steins;Gate “圆环” novel](https://tgy233.top/tgypage/%E7%A7%91%E5%AD%A6ADV%E5%B0%8F%E8%AF%B4%E6%B1%87%E6%80%BB_2026-0828.html).
- **Chinese to English:** [a Robotics;Notes novel translation](https://drive.google.com/file/d/1pPVFPxdwOxNnT_8TO1wJGEY9D3FVFNeK/view).

These examples were supplied by the project author. They show use cases and outputs, not independent benchmarks or proof of zero human editing. See [case notes](docs/examples.en.md).

## Quality and reliability evidence

YN checks line alignment, placeholders, protected content, write scope and recovery proof in code before independent AI review. A model saying “done” does not replace artifact validation. These checks reveal structural and workflow failures; they do not prove every semantic choice is correct.

The [quality and reliability report](docs/quality.en.md) links public tests, reproduction commands, limits and failure handling. It does not claim measured semantic accuracy, a cross-tool ranking or universal cost savings.

## 2.2.0 highlights

- Text-layer PDFs must pass a complete mechanical draft, incremental native Pi structure edits, Host checks and an independent audit before HTML generation. Accepted logical units use code/math/reference protection and on-demand images; export reflows current HTML translations without original prose-box length limits. Academic identifier prescanning and parent-confirmed untranslated false positives remain available.
- Official background Agent API reusing project preparation, translation, proofreading and reference workflows.
- Improved large-session and candidate responsiveness, cancellation, recovery and character-name matching.

See the [Changelog](CHANGELOG.en.md) for full history.

## Documentation and development

[First run](docs/guide.en.md) · [Features](docs/features.en.md) · [Workflows](docs/workflows.en.md) · [Technical terms](docs/terminology.en.md) · [Runtime map](docs/agent-runtime-codegraph.md)

Development requires Node.js `>=22.19.0` and the existing npm lock:

```bash
npm ci
npm run dev
```

```bash
npm test
npm run build
```

See [development and validation](docs/development.en.md) for desktop, LAN and release checks.

## Privacy and license

Project state, assets, sessions and backups live in the project. Provider credentials live in Electron user data. When copying a project, also transfer and rebind external source/reference files. Anyone with the LAN PIN can operate the shared workbench; use trusted networks or controlled tunnels.

[MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)

Thanks to OpenAI Codex and everyone who tested, translated and reported issues.
