# Development and validation

[中文](development.md) · [Project](../README.en.md)

Requires Node.js >=22.19.0 and the npm lock. Packaged desktop users do not need these commands.

```bash
npm ci
npm run dev
```

```bash
npm run typecheck
npm test
npm run build
```

Existing desktop, LAN, background API and storage checks:

```bash
npm run verify:electron-agent-html
npm run verify:electron-lan-agent
npm run verify:electron-agent-api
npm run verify:electron-storage
```

Windows local packaging and acceptance:

```bash
npm run package:win
npm run verify:release
npm run verify:packaged-launch
```

`package:win` uses the repository electron-builder configuration; listing commands does not authorize public publishing. Bundle version/build/README/checksums must agree. Windows acceptance runs hidden win-unpacked with normal exit, not the known problematic portable shell, and never force-kills test instances.

See the [runtime map](agent-runtime-codegraph.md), [translation child](../translation-protocol/translation-child.md) and [proofread child](../translation-protocol/proofread-child.md) protocols. Internal diagnosis records are not product rankings.

The documentation site uses the Chinese and English Markdown files as its content source. After editing them, run `node docs/yn-guide/build.mjs` to regenerate static pages and the search index; no additional build tool is required.
