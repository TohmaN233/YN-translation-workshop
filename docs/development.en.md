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

`package:win` uses the repository electron-builder configuration. Bundle version, build, README and checksums should agree. Windows checks launch `release/win-unpacked/translation-workshop.exe` hidden and wait for its normal smoke-test exit.

See the [runtime map](agent-runtime-codegraph.md), [translation child](../translation-protocol/translation-child.md) and [proofread child](../translation-protocol/proofread-child.md) protocols.

## Documentation site

Chinese and English Markdown files are the source for the static site. After editing them, regenerate the pages, search index, sitemap and project-path robots file with:

```bash
node docs/yn-guide/build.mjs
```

Review the generated page titles, summaries, canonical and language links, and sitemap entries before publishing the static files.

Crawlers read `https://tohman233.github.io/robots.txt`; the generated copy under `/YN-translation-workshop/robots.txt` does not control crawling. Deploy the shared [`robots-root-template.txt`](yn-guide/robots-root-template.txt) at the host root, merging it with any existing site policy. It allows `OAI-SearchBot` and lists the project sitemap. `OAI-SearchBot` serves ChatGPT search; `GPTBot` controls potential training use independently. See [Google's robots.txt guidance](https://developers.google.com/crawling/docs/robots-txt/create-robots-txt) and [OpenAI's crawler documentation](https://developers.openai.com/api/docs/bots).
