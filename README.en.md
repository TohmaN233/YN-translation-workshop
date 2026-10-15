<div align="left">
<img src="docs/yn-guide/assets/app-icon.png" alt="YN Translation Workshop logo" width="72">
<h1>YN Translation Workshop</h1>
</div>

[![MIT Licensed](https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square)](LICENSE)

**An open-source workbench for translators working with AI on long-form fiction and game localization.**

YN brings a translator's judgment, manual editing and AI assistance into one workflow. Translate yourself, ask AI for a draft, or request help with selected lines. You guide terminology, character voice, revisions and the finished text.

TXT, EPUB and text-layer PDF open in aligned source/translation views. Line editing, terminology and character records, format preservation, translation reuse and chunked processing belong to the same project, supporting the close revision, consistent expression and ongoing project maintenance needed in professional translation.

[中文](README.md) · [Windows downloads](https://github.com/TohmaN233/YN-translation-workshop/releases) · [User guide](https://tohman233.github.io/YN-translation-workshop/index.en.html) · [Project introduction (Chinese)](https://tgy233.top/tgypage/yn/) · [Project tutorial](docs/guide.en.md) · [GitHub repository](https://github.com/TohmaN233/YN-translation-workshop)

Use it for file translation that needs cross-chapter terminology, preserved game control codes, manual line review and resumable long tasks. PDFs need horizontal selectable text. AI tasks send the required text to your selected model provider.

## Requirements

- Current releases target Windows x64. Packaged desktop use does not require Node.js.
- AI features require a provider, model and authorization configured in YN. Manual editing remains available with the Agent off.
- Use TXT, EPUB or a text-layer PDF. Proofreading requires an existing translation aligned with the source.

## Download and installation

Download the installer (Setup) or portable build (Portable) from [Releases](https://github.com/TohmaN233/YN-translation-workshop/releases). These docs describe 2.2.0.

Installers support in-app updates; portable builds are replaced using the release page. Releases include `SHA256SUMS.txt`.

## Configuration

Choose the source, project location, language direction and style. Configure a provider and model at the top of the start page when using AI features. New AI tasks default to **500 lines per chunk** and **up to 3 child agents**; explicit settings in existing projects are retained.

Use reference preparation before translation when you already have terminology, characters or project notes. For game text, inspect preservation-rule matches before starting so a regex does not lock translatable dialogue.

## Choose how to work together

1. Select the source and project location. Bind an existing translation when available, keeping its rows aligned with the source.
2. For manual translation or revision, generate review HTML, edit in the page and ask AI when needed. For an AI draft, use the translation preparation shortcut, confirm the settings and start chunked processing.
3. Edit, search and check translations against the source. Give AI context from a selected row, or start proofreading on an existing translation.
4. Accept, reject or edit suggestions. Auto-apply changes HTML only; **writing the final TXT is manual**. EPUB/PDF use their export controls.

[Complete tutorial](https://tohman233.github.io/YN-translation-workshop/guides.en.html) · [PDF guide](docs/pdf.en.md) · [Background Agent API](docs/agent-api.en.md)

## Collaboration designed for translation work

| Translation work | Collaboration support |
| --- | --- |
| Close reading and revision | Aligned source/translation rows, search and direct editing; ask AI about selected lines and edit, accept or reject proofreading suggestions |
| Terminology and characterization | Maintain approved terms, candidates and character records, including forms of address, pronouns, relationships and voice; AI organizes references and flags conflicts |
| Style and project requirements | Translation style, references and editable prompts carry the translator's preferences and the work's requirements |
| Game control codes and formatting | Inspect preservation-rule examples before protecting variables, tags and control codes; translation and proofreading share those requirements |
| Continue an existing translation | Bind aligned previous translations, retain reusable content and continue editing, translating or proofreading |
| Sustained work on long projects | Process chunks, Stop and resume, keeping text, references and review state in one project |
| PDF review and export | Extract prose and formula/figure assets, edit translations in HTML, then reflow them into a PDF |

See the [feature guide](docs/features.en.md) for settings, reuse, sampled proofreading, LAN access and artifact locations.

## Projects translated with YN

- **Japanese to Chinese:** [Megido72 game-text translation demonstration](https://www.bilibili.com/video/BV12ypy68EEF/).
- **Japanese to Chinese:** [game localization demonstrations by 美希命](https://space.bilibili.com/1863789519), including many localized games.
- **Japanese to Chinese:** [the Steins;Gate “圆环” novel](https://tgy233.top/tgypage/%E7%A7%91%E5%AD%A6ADV%E5%B0%8F%E8%AF%B4%E6%B1%87%E6%80%BB_2026-0828.html).
- **Chinese to English:** [a Robotics;Notes novel translation](https://drive.google.com/file/d/1pPVFPxdwOxNnT_8TO1wJGEY9D3FVFNeK/view).

See [case notes](docs/examples.en.md) for more projects.

## Quality checks

YN checks line alignment, placeholders, protected content, write scope and recovery evidence, then runs independent AI review. Findings identify specific rows for repair and human inspection.

[Quality checks](docs/quality.en.md) lists the checks, their test sources and reproduction commands.

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
