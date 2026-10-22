<div align="left">
<img src="docs/yn-guide/assets/app-icon.png" alt="YN Translation Workshop logo" width="72">
<h1>YN: Open-Source AI Novel Translator and Game Localization Tool</h1>
</div>

[![MIT Licensed](https://img.shields.io/badge/license-MIT-brightgreen.svg?style=flat-square)](LICENSE)

**YN is an open-source AI novel translator and game localization tool for long-form fiction and game text, with AI translation and AI proofreading.**

Choose a fully AI workflow, a fully manual workflow, or a mixed workflow with AI for the parts you choose. YN supports TXT, EPUB and text-layer PDF, with aligned editing and project references in one workspace.

Chunked parallel processing, reusable terminology and character references, automatic format preservation and resumable tasks support sustained translation across chapters and files.

[中文](README.md) · [Windows downloads](https://github.com/TohmaN233/YN-translation-workshop/releases) · [User guide](https://tohman233.github.io/YN-translation-workshop/index.en.html) · [Project introduction (Chinese)](https://tgy233.top/tgypage/yn/) · [Project tutorial](docs/guide.en.md) · [GitHub repository](https://github.com/TohmaN233/YN-translation-workshop)

Use it for file translation that needs consistent terminology across chapters, preserved game control codes and resumable long tasks. PDFs need horizontal selectable text. AI tasks send the required text to your selected model provider.

## Main features

- **AI translation:** Translate complete source texts using the selected language direction, style and project references. Preparation checks settings and content, then parallel agents translate line-based chunks. The program validates line counts, placeholders and preserved content; independent AI review covers every mechanically risky row and sampled ordinary rows, with precise automatic repairs for failures. Existing translations can be audited and selectively reused, and long tasks can stop and resume.
- **AI proofreading:** Compare an existing translation with its source for mistranslations, omissions, terminology, forms of address and expression. Split review checks each row; Monte Carlo combines full programmatic scans with stratified AI sampling. Findings include row numbers, evidence and complete replacement suggestions, which can be applied to HTML automatically or accepted, rejected or edited individually.
- **References and consistency:** AI can organize glossary and character records and collect new candidates. Translation and proofreading reuse approved terms, character names and voice, style requirements and existing translations. References can also be maintained manually.
- **Automatic format preservation:** During preparation, AI uses task requirements and real source examples to identify preservation-rule candidates for variables, tags and control codes. The program trials the rules and validates them during translation and proofreading; custom rules can be added when needed.
- **Manual editing and collaboration:** Translate, edit rows, search and manage references in the aligned source/translation view. Ask AI about a selected row or assign only part of the work to AI.
- **PDF extraction and reflow:** Extract prose and formula/figure assets, organize the structure mechanically, then use AI revisions and independent auditing before generating HTML. Translated text and source assets rebuild structured HTML, which automatically reflows into an exported PDF.

See the [feature guide](docs/features.en.md) for settings, translation reuse, proofreading modes, LAN access and artifact locations.

## Requirements

- Current releases target Windows x64. Packaged desktop use does not require Node.js.
- AI features require a provider, model and authorization configured in YN. Manual editing is also available with the Agent closed.
- Use TXT, EPUB or a text-layer PDF. Proofreading requires an existing translation aligned with the source.

## Download and installation

Download the installer (Setup) or portable build (Portable) from [Releases](https://github.com/TohmaN233/YN-translation-workshop/releases). These docs describe 2.2.3.

Installers support in-app updates; portable builds are replaced using the release page. Releases include `SHA256SUMS.txt`.

## Configuration

Choose the source, project location, language direction and translation style. Configure a provider and model at the top of the start page when using AI features. New AI tasks default to **500 lines per chunk** and **up to 3 child agents**; explicit settings in existing projects are retained.

If the project already has a glossary, character bible or reference material, you can organize it before translation. When format preservation is needed, translation preparation uses source examples to propose rule candidates, then the program trials and validates them. Custom regex rules and match examples are optional tools for adjustments.

## Choose how to work

1. Select the source, project location, language direction and style. For proofreading, bind an existing translation aligned with the source.
2. Choose AI translation, AI proofreading, manual editing or a mixed workflow. Start AI translation from the start-page shortcut; proofreading requires an existing translation.
3. When you want to participate manually, edit and search rows in the aligned HTML, ask AI about selected lines, or handle proofreading suggestions one by one.
4. After AI processing or manual editing, use the controls to write the final TXT or export EPUB/PDF. Automatic proofreading application updates HTML; the write/export controls save the final file.

[Complete tutorial](https://tohman233.github.io/YN-translation-workshop/guides.en.html) · [PDF guide](docs/pdf.en.md) · [Background Agent API](docs/agent-api.en.md)

## Projects translated with YN

- **Japanese to Chinese:** [Megido72 game-text translation demonstration](https://www.bilibili.com/video/BV12ypy68EEF/).
- **Japanese to Chinese:** [game localization demonstrations by 美希命](https://space.bilibili.com/1863789519), including many localized games.
- **Japanese to Chinese:** [the Steins;Gate “圆环” novel](https://tgy233.top/tgypage/%E7%A7%91%E5%AD%A6ADV%E5%B0%8F%E8%AF%B4%E6%B1%87%E6%80%BB_2026-0828.html).
- **Chinese to English:** [a Robotics;Notes novel translation](https://drive.google.com/file/d/1pPVFPxdwOxNnT_8TO1wJGEY9D3FVFNeK/view).

See [case notes](docs/examples.en.md) for more projects.

## Quality checks

YN checks line alignment, placeholders, preserved content, write scope and recovery evidence, then runs independent AI review. Findings identify specific rows and can support precise automatic repair or optional manual handling.

[Quality checks](docs/quality.en.md) lists the checks, their test sources and reproduction commands.

## 2.2.3 highlights

- Keep folder review pages usable after applying proofreading, preserving manual edits and the selected file.
- Show unresolved alignment failures and keep repair reads bound to the correct document.

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
