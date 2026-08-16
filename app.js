(() => {
  const data = window.YN_GUIDE;
  const page = document.body.dataset.page || "overview";
  const LANGUAGE_STORAGE_KEY = "yn-guide-language-v1";
  const requestedLocale = new URLSearchParams(location.search).get("lang");
  const storedLocale = localStorage.getItem(LANGUAGE_STORAGE_KEY);
  const locale = requestedLocale === "en" || requestedLocale === "zh"
    ? requestedLocale
    : storedLocale === "en" ? "en" : "zh";
  localStorage.setItem(LANGUAGE_STORAGE_KEY, locale);
  document.documentElement.lang = locale === "en" ? "en" : "zh-CN";

  const pageMetaZh = {
    overview: { file: "index.html", num: "⌂", label: "阅读入口", section: "home" },
    guides: { file: "guides.html", num: "1", label: "从零开始", section: "tutorial" },
    features: { file: "features.html", num: "2", label: "设置怎么填", section: "tutorial" },
    workflows: { file: "workflows.html", num: "A", label: "两条 Workflow", section: "technical" },
    harness: { file: "harness.html", num: "B", label: "Harness 架构", section: "technical" },
    functions: { file: "functions.html", num: "C", label: "Function 参考", section: "technical" },
    terminology: { file: "terminology.html", num: "0", label: "Agent 术语", section: "technical", navOrder: 1 }
  };
  const english = window.YN_GUIDE_EN;
  const pageMeta = locale === "en" && english?.pageMeta ? english.pageMeta : pageMetaZh;
  const uiZh = {
    navEntry: "入口", navTutorial: "普通用户教程", navTechnical: "技术手册", navDirect: "常用直达",
    directTranslation: "跑一次完整翻译", directRemote: "手机与远程操作", directGlossary: "术语表怎么用", directTerms: "术语更新链路",
    search: "搜索教程或技术词条", searchPlaceholder: "例如：远程、旧译、staging、Host 或 Function 名",
    searchEmpty: "没有匹配词条。可以试试“Host”“staging”“远程”“术语冲突”或 Function 名。",
    handbook: "教程与技术手册", callable: "个调用面", edit: "编辑文字", editing: "正在编辑",
    verified: "依据当前源码和产品实机整理。最后核对", toc: "本页目录", close: "关闭", enlarge: "放大",
    productScreenshot: "产品界面",
    done: "完成", export: "导出全部", import: "导入文案", reset: "恢复当前语言", saved: "已自动保存",
    exported: "全部页面文案已汇总", formatError: "文案文件格式不正确。", importConfirm: "导入会覆盖当前浏览器保存的中英文文案。继续吗？",
    resetConfirm: "将当前页面、当前语言恢复到你保存的基准稿？", editorStatus: "编辑模式", functionCount: "个运行时调用面"
  };
  const ui = locale === "en" && english?.ui ? english.ui : uiZh;

  const LEGACY_COPY_EDIT_STORAGE_KEY = "yn-guide-copy-edits-v1";
  const COPY_DEFAULT_STORAGE_KEY = "yn-guide-copy-defaults-v2";
  const COPY_EDIT_STORAGE_KEY = "yn-guide-copy-edits-v2";
  const COPY_EDIT_MIGRATION_KEY = "yn-guide-copy-migration-v2";
  const COPY_EDIT_EXPORT_VERSION = 3;
  const COPY_EXPORT_MARKER = "yn-guide-copy-export-v3";
  const COPY_EXPORT_FILES = ["index.html", "guides.html", "features.html", "terminology.html", "workflows.html", "harness.html", "functions.html"];
  const LOCAL_COPY_EDITOR = location.protocol === "file:";

  const SCREEN_DIMENSIONS = {
    "workbench.png": [2560, 1540],
    "folder-review.png": [2560, 1540],
    "line-review.png": [2560, 1540],
    "provider-config.png": [961, 975],
    "model-config.png": [1439, 1082],
    "agent-proofread.png": [1385, 996],
    "agent-conversation.png": [1828, 1274],
    "prompt-settings.png": [2314, 975],
    "project-assets.png": [2302, 783],
    "preserve-rules.png": [1237, 1162],
    "html-theme.png": [379, 133],
    "refresh-translation.png": [1254, 263],
    "proofread-review.png": [2558, 1542],
    "glossary-editor.png": [2558, 1520],
    "issue-row.png": [2329, 155],
    "tool-call.png": [774, 752],
    "subagent-card.png": [750, 750],
    "token-telemetry.png": [677, 453],
    "slash-commands.png": [779, 838],
    "lan-settings.png": [2352, 791],
    "lan-browser.png": [2558, 1414],
    "tunnel-terminal.png": [1103, 639],
    "agent-panel.png": [2536, 1368]
  };

  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  const slug = (value) => String(value).normalize("NFKC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();

  function navLinks(section) {
    return Object.entries(pageMeta)
      .filter(([, item]) => item.section === section)
      .map(([key, item]) => `
        <a class="nav-link ${page === key ? "active" : ""}" href="${item.file}" style="order:${item.navOrder ?? 2}">
          <span class="nav-index">${item.num}</span><span>${item.label}</span>
        </a>`).join("");
  }

  function shell() {
    const copyEditorButtons = LOCAL_COPY_EDITOR
      ? `<button class="copy-edit-toggle" id="copy-export-all" type="button">${ui.export}</button><button class="copy-edit-toggle" id="copy-edit-toggle" type="button">${ui.edit}</button>`
      : "";
    const copyEditorBar = LOCAL_COPY_EDITOR ? `
      <div class="copy-editor-bar" id="copy-editor-bar" hidden>
        <span id="copy-editor-status">${ui.editorStatus} · ${locale === "en" ? "English" : "中文"}</span>
        <button type="button" data-copy-action="done">${ui.done}</button>
        <button type="button" data-copy-action="export">${ui.export}</button>
        <button type="button" data-copy-action="import">${ui.import}</button>
        <button type="button" data-copy-action="reset">${ui.reset}</button>
        <input id="copy-import-input" type="file" accept="application/json,.json" hidden>
      </div>` : "";
    document.body.insertAdjacentHTML("afterbegin", `
      <header class="topbar">
        <button class="menu-button" type="button" aria-label="${locale === "en" ? "Open navigation" : "打开导航"}" title="${locale === "en" ? "Open navigation" : "打开导航"}">☰</button>
        <a class="brand" href="index.html">
          <img src="assets/app-icon.png" alt="YN Translation Workshop">
          <strong>YN Translation Workshop</strong>
        </a>
        <button class="search-trigger" type="button" aria-label="${ui.search}">
          <span aria-hidden="true">⌕</span><span>${ui.search}</span><span class="key">Ctrl K</span>
        </button>
        <div class="topmeta"><span>${ui.handbook}</span><a href="functions.html">${data.metrics.callableSurfaces} ${ui.callable}</a>${copyEditorButtons}<div class="language-switch" role="group" aria-label="Language"><button type="button" data-language="zh" aria-pressed="${locale === "zh"}">中</button><button type="button" data-language="en" aria-pressed="${locale === "en"}">EN</button></div></div>
      </header>
      <aside class="sidebar" aria-label="文档导航">
        <div class="nav-section"><p class="nav-label">${ui.navEntry}</p>${navLinks("home")}</div>
        <div class="nav-section"><p class="nav-label">${ui.navTutorial}</p>${navLinks("tutorial")}</div>
        <div class="nav-section"><p class="nav-label">${ui.navTechnical}</p>${navLinks("technical")}</div>
        <div class="nav-section">
          <p class="nav-label">${ui.navDirect}</p>
          <a class="nav-link" href="guides.html#translation"><span class="nav-index">↳</span><span>${ui.directTranslation}</span></a>
          <a class="nav-link" href="guides.html#lan"><span class="nav-index">↳</span><span>${ui.directRemote}</span></a>
          <a class="nav-link" href="guides.html#assets"><span class="nav-index">↳</span><span>${ui.directGlossary}</span></a>
          <a class="nav-link" href="harness.html#terminology"><span class="nav-index">↳</span><span>${ui.directTerms}</span></a>
        </div>
        <div class="sidebar-foot">${ui.verified}<br>${data.verified}</div>
      </aside>
      <main class="layout"><article class="content" id="content"></article></main>
      <aside class="toc" aria-label="${ui.toc}"><strong>${ui.toc}</strong><div id="toc-links"></div></aside>
      <dialog class="search-dialog" id="search-dialog">
        <div class="search-head"><input id="global-search" type="search" placeholder="${ui.searchPlaceholder}" autocomplete="off"><button class="icon-button" type="button" data-close-search aria-label="${ui.close}" title="${ui.close}">×</button></div>
        <div class="search-results" id="search-results"></div>
      </dialog>
      <dialog class="lightbox" id="lightbox"><button class="icon-button" type="button" data-close-lightbox aria-label="${ui.close}" title="${ui.close}">×</button><img alt="${ui.enlarge}"></dialog>
      ${copyEditorBar}
    `);
  }

  const breadcrumb = (label) => `<nav class="breadcrumb"><a href="index.html">${pageMeta.overview.label}</a><span>/</span><span>${label}</span></nav>`;
  const pageHead = (eyebrow, title, subtitle) => `${breadcrumb(title)}<header class="page-head"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></header>`;
  const image = (src, alt, caption) => {
    const [width, height] = SCREEN_DIMENSIONS[src] || [16, 9];
    const compact = width < 800 || width / height > 4 ? " compact" : "";
    return `<figure class="reference-figure${compact}" style="--image-max-width:${width}px"><div class="image-frame" style="--image-ratio:${width} / ${height}"><img src="assets/screens/${src}" alt="${esc(alt)}" width="${width}" height="${height}" loading="lazy"><button type="button" data-lightbox="assets/screens/${src}">${ui.enlarge}</button></div><figcaption class="image-caption"><span>${caption}</span><span>${ui.productScreenshot}</span></figcaption></figure>`;
  };

  function renderOverview() {
    return `${pageHead("先选择你要解决的问题", "YN Translation Workshop", "这套网页分成两本书。第一次使用、填写设置、远程操作，请走教程篇；想理解 Agent、Host、Worker、术语门和 Function，请走技术手册。")}
      <section class="route-grid" aria-label="阅读路线">
        <a class="route-panel route-tutorial" href="guides.html">
          <span class="route-label">普通用户教程</span>
          <h2>我想把翻译跑起来</h2>
          <p>按界面上的名称说明该选什么、填什么、什么时候点哪个按钮。不会拿内部字段名考你。</p>
          <span class="route-action">从零开始 <b>→</b></span>
        </a>
        <a class="route-panel route-technical" href="terminology.html">
          <span class="route-label">技术手册</span>
          <h2>我想看懂它为什么可靠</h2>
          <p>沿两条真实 Workflow 拆解运行时、调度、工具权限、术语冲突、证据与恢复。</p>
          <span class="route-action">进入架构 <b>→</b></span>
        </a>
      </section>

      <h2 id="plain-overview">先用一句话说清楚</h2>
      <p class="lead">它是一个本地翻译与校对工作台：把 TXT 或 EPUB 变成方便阅读和编辑的对照页面，再让 Agent 在受约束的流程里翻译或检查。你可以全程让 AI 做，也可以自己翻译，只在拿不准时把某一行和上下文交给 Agent。</p>
      <div class="plain-strip">
        <div><strong>原文保持只读</strong><span>真正的源文件不会被翻译流程直接改写。</span></div>
        <div><strong>HTML 用来工作</strong><span>逐行编辑、看问题、批量审批和远程同步都在页面里完成。</span></div>
        <div><strong>最后才写 TXT</strong><span>确认结果后再写回真实译文文件，避免误覆盖。</span></div>
      </div>
      <h2 id="what-you-can-do">它能帮你做什么</h2>
      <div class="three-col">
        <article class="topic-card"><span class="num">翻译</span><h3>从空白生成候选译文</h3><p>支持单文件、文件夹和 EPUB。大项目会自动分块并行，并在写入后安排独立检查。</p></article>
        <article class="topic-card"><span class="num">校对</span><h3>检查已有译文</h3><p>译文可以来自 Agent，也可以来自人类。结果会变成逐条可接受、拒绝或手改的审阅页面。</p></article>
        <article class="topic-card"><span class="num">协作</span><h3>随时向 Agent 求助</h3><p>选中原文即可询问翻译；完整流程运行时也能插话、看工具调用和查看子 Agent 的工作。</p></article>
        <article class="topic-card"><span class="num">资产</span><h3>维护术语与角色信息</h3><p>正式术语优先，候选用于收集新译名，角色表和文风指南帮助跨章节保持一致。</p></article>
        <article class="topic-card"><span class="num">远程</span><h3>在手机上继续校对</h3><p>桌面软件保持运行时，同一局域网的手机或平板可以打开同步页面并操作 Agent。</p></article>
        <article class="topic-card"><span class="num">安全</span><h3>把修改留在可检查阶段</h3><p>候选译文、HTML 状态和真实 TXT 分开保存，出现问题时更容易发现、撤回和继续。</p></article>
      </div>

      <h2 id="two-workflows">现在只有两条完整 Workflow</h2>
      <div class="choice-strip">
        <div><span>01</span><strong>初翻</strong><p>读取原文和项目资料，生成候选译文，并在每块写入后进行检查。</p></div>
        <div><span>02</span><strong>校对</strong><p>读取原文与现有译文，找出真正需要处理的问题，生成审阅结果。</p></div>
      </div>
      <p>术语一致性、角色口吻、旧译复用和最终质量检查都在这两条流程中发挥作用。它们是功能环节，不是额外的完整 Workflow。</p>

      <h2 id="recommended-reading">推荐阅读顺序</h2>
      <ol class="step-list">
        <li><strong><a href="guides.html">先照着教程跑通一次</a></strong><br>用默认设置完成“生成 HTML → 翻译 → 同步 → 校对 → 审批 → 写入 TXT”。</li>
        <li><strong><a href="features.html">再按项目调整设置</a></strong><br>理解每个界面选项适合什么情况，尤其是拆分大小、Agent 数量、旧译复用和术语候选。</li>
        <li><strong><a href="terminology.html">需要研究时再看技术手册</a></strong><br>先读 Agent 行业术语，再从两条 Workflow 进入 Harness 和完整 Function Registry。</li>
      </ol>`;
  }

  function renderFeatures() {
    return `${pageHead("普通用户教程 02", "设置怎么填", "截图紧跟它所解释的界面，方便边看边设置。")} 
      <div class="tutorial-banner"><strong>第一次使用的原则</strong><span>只改语言方向、文本类型、作品说明和输出位置，其余先保持默认。跑通一小段后，再按速度与质量调整并发和拆分。</span></div>

      <h2 id="project-inputs">工作台的基本页面和按钮</h2>
      ${image("workbench.png", "YN Translation Workshop 工作台全貌", "这是工作台总览。下面的文件路径、输入模式与网络代理都对应这张图。")} 
      <div class="table-wrap"><table class="field-guide"><thead><tr><th>界面名称</th><th>应该填什么</th><th>实用建议</th></tr></thead><tbody>
        <tr><td><strong>Agent 网络走代理</strong></td><td>只有访问所选模型确实需要代理时才打开，并填写本机代理软件给出的地址。</td><td>默认关闭。DeepSeek、Qwen、GLM 等能直连时不要开；不同代理软件的端口不一样。</td></tr>
        <tr><td><strong>源语言文件 / 文件夹路径</strong></td><td>选择要翻译或校对的原文 TXT、EPUB，或装有多份 TXT 的文件夹。</td><td>游戏脚本常选文件夹；小说单卷可选 TXT 或 EPUB。</td></tr>
        <tr><td><strong>译文文件 / 文件夹路径</strong></td><td>已有译文时选择对应文件或文件夹；从零翻译可以留空。</td><td>校对必须有译文。文件夹模式要保证源文与译文能一一对应。</td></tr>
        <tr><td><strong>输出文件夹</strong></td><td>选择项目工作目录。HTML、候选译文、报告和项目资料都会放在这里。</td><td>必须设置。每个作品使用独立目录，避免项目资产串到一起。</td></tr>
        <tr><td><strong>Glossary 文件路径</strong></td><td>已有正式术语表时导入；没有可以留空。</td><td>正式术语影响全文，建议人工审核。没有术语表也能翻译，后续可从候选中挑选。</td></tr>
        <tr><td><strong>输入模式</strong></td><td>原文与译文分开时选“分离文件”；一行原文一行译文时选“双语文件”。</td><td>双语模式要确认原文和译文分别处于位置 1 还是位置 2。</td></tr>
        <tr><td><strong>每页行数</strong></td><td>生成的 HTML 每页显示多少行。</td><td>只影响浏览，不影响 Agent 每次领取多少内容。大文件电脑较慢时可调小。</td></tr>
      </tbody></table></div>

      <h2 id="model-settings">AI 服务与模型</h2>
      <p>在 Agent 会话的设置里配置模型。Codex 订阅可以使用 OAuth；其他服务可填写兼容 API。先测试连接，再用该服务建立一次普通会话。</p>
      <div class="reference-pair">
        ${image("provider-config.png", "兼容 API 服务配置", "自定义 API 需要填写接口地址、模型 ID、默认模型与密钥。")} 
        ${image("model-config.png", "ChatGPT OAuth 与默认模型", "使用 Codex 订阅时可登录 OAuth，再从服务里选择默认模型。")} 
      </div>
      <p>Agent 会话能正常收发消息，才算配置成功。下面这张图展示模型完成校对后返回结果的状态。</p>
      ${image("agent-proofread.png", "Agent 会话成功完成校对", "配置成功后，工具调用和最终回复都会出现在同一条会话流里。")} 
      <p>“新窗口”会把当前 Agent 会话打开为独立窗口，适合一边看 HTML，一边观察任务进度。</p>
      ${image("agent-conversation.png", "独立 Agent 会话窗口", "独立窗口保留会话列表、工具调用、输入框和模型状态。")} 
      <div class="note warning"><strong>代理不是越开越好</strong>只有模型服务或网页资料确实需要代理时才启用。地址必须来自你正在使用的本机代理软件，不能照抄别人的端口。</div>

      <h2 id="prompt-basics">翻译参数</h2>
      ${image("prompt-settings.png", "翻译参数与文件顺序面板", "语言方向、风格、拆分大小、作品说明、文件顺序和保留规则都在这里填写。")} 
      <div class="table-wrap"><table class="field-guide"><thead><tr><th>界面名称</th><th>怎么填</th><th>例子或建议</th></tr></thead><tbody>
        <tr><td><strong>Language pair</strong></td><td>先写原文语言，再写目标语言。</td><td><code>ja-&gt;zh-CN</code> 表示日语到简体中文。</td></tr>
        <tr><td><strong>风格</strong></td><td>选择最接近的文本类型，再在作品说明中补充语气。</td><td>游戏、轻小说、视觉小说；“自然口语，保留敬称差异”。</td></tr>
        <tr><td><strong>拆分大小</strong></td><td>每个 Agent 一次最多领取的行数。</td><td>对话密集、上下文复杂时调小；第一次先用默认值。</td></tr>
        <tr><td><strong>作品说明</strong></td><td>写世界观、时代、主要角色、特殊称呼和可靠资料链接。</td><td>可以放官方 Wiki 或角色页，帮助 Agent 先理解作品。</td></tr>
        <tr><td><strong>文件翻译顺序</strong></td><td>大括号外严格按顺序；大括号内属于同一并行阶段。</td><td>不需要处理的文件直接从列表删除。本轮列表就是实际清单。</td></tr>
        <tr><td><strong>正则保留规则</strong></td><td>为项目特有的变量、事件码、名字框或控制符添加规则。</td><td>命中内容必须在同一译文行原样保留；先用少量文本验证。</td></tr>
      </tbody></table></div>

      <h2 id="translation-settings">子 Agent、候选与旧译复用</h2>
      ${image("project-assets.png", "子 Agent 与翻译校对设置", "这张图对应下面的并发数量、模型、候选、角色表、旧译复用和校对选项。")} 
      <div class="setting-list">
        <article><h3>子 Agent 数量</h3><p>表示最多可以同时工作的翻译或校对 Agent，不是一定会叫满。新项目默认上限为 3。数量越高通常越快，但瞬时 Token 消耗和接口压力也更高。</p></article>
        <article><h3>审阅 Agent 数量</h3><p>初翻中另有一组只负责检查结果的 Agent。默认跟随翻译 Agent 数量，也可以单独设小一点来控制开销。</p></article>
        <article><h3>子 Agent 模型</h3><p>默认跟随主 Agent。需要节省成本时可把批量初翻交给较便宜的模型；复杂校对和最终判断更适合能力较强的模型。</p></article>
        <article><h3>Glossary candidates</h3><p>打开后会收集新专名。同一原词出现不同译名时，流程会暂缓领取新任务，由主 Agent 选定后优先修正受影响行。关闭只是不新增候选，已有候选仍可只读参考。</p></article>
        <article><h3>Character bible</h3><p>打开后会收集角色名字、性别、代词、称呼和语气证据，供后续章节参考。不确定的信息可以保持未知。</p></article>
        <article><h3>审计并复用已有译文</h3><p>项目中已有一部分可靠译文时打开。软件先筛查，再让 Agent 判断风险行，最后只让你做一次整批选择。关闭时会备份旧候选并干净重翻。</p></article>
      </div>

      <h2 id="proofread-settings">校对参数</h2>
      <div class="two-col">
        <article class="topic-card"><span class="num">完整检查</span><h3>按拆分大小校对</h3><p>每一行都会进入语义检查，拆分大小只控制每批保存与领取的范围。适合最终交付前的系统校对。</p></article>
        <article class="topic-card"><span class="num">抽样检查</span><h3>Monte Carlo</h3><p>优先检查高风险区域，再从其他区域分层抽样。适合快速摸底；持续发现问题时不会假装已经收敛。</p></article>
      </div>
      <div class="table-wrap"><table class="field-guide"><thead><tr><th>界面名称</th><th>怎么理解</th><th>什么时候改</th></tr></thead><tbody>
        <tr><td><strong>H9 候选比例</strong></td><td>译文相对原文过长时触发的机械提醒。</td><td>只是提醒，不会直接判错。语言长度差异明显的项目可适度放宽。</td></tr>
        <tr><td><strong>Monte Carlo 抽样数量</strong></td><td>每轮最多抽多少行。</td><td>项目很大且只想快速摸底时控制预算；数量越大覆盖越广。</td></tr>
        <tr><td><strong>最少轮数 / 最多轮数</strong></td><td>至少检查几轮，以及何时停下来让你决定。</td><td>质量要求高时增加；不要把最多轮数理解成自动合格。</td></tr>
      </tbody></table></div>

      <h2 id="project-assets">进入项目后的其他参数</h2>
      ${image("preserve-rules.png", "项目资产表单与正则保留规则", "进入项目后，可以手动维护正式术语、角色信息、文风指南和项目专用保留规则。")} 
      <p>术语、角色和文风属于项目长期资料。正则项与 HTML 前端同步；无效表达式会直接报错，不会静默忽略。</p>
      ${image("html-theme.png", "HTML 主题色选项", "主题色只改变行审阅 HTML 的外观，不改变译文、问题状态或 Agent 行为。")} 
      <p>主题色可以按阅读习惯选择。它只影响显示，不会写进真实译文。</p>`;
  }

  function renderGuides() {
    return `${pageHead("普通用户教程 01", "从零开始使用", "本页按实际操作顺序讲完整流程，截图紧跟对应步骤。")} 
      <h2 id="quickstart">最快的完整路径</h2>
      <ol class="step-list">
        <li><strong>选择源文和输出文件夹</strong><br>从零翻译可不选译文；校对已有内容时同时选择对应译文。</li>
        <li><strong>生成行对行 HTML</strong><br>打开后先看文件清单和行数是否正常。源文不会被修改。</li>
        <li><strong>配置 AI 服务</strong><br>在 Agent 设置中登录 OAuth 或填写兼容 API。先发一句普通消息确认能回复。</li>
        <li><strong>选择“初翻”并生成提示词</strong><br>第一次保留默认设置，发送后等待 Agent 完成。</li>
        <li><strong>同步译文</strong><br>回到 HTML 刷新候选，浏览几页确认格式和语言方向正常。</li>
        <li><strong>选择“校对”并生成审阅 HTML</strong><br>逐条查看建议，接受、拒绝或直接手改。</li>
        <li><strong>写入 TXT</strong><br>确认页面状态后再写入真实译文；文件夹项目使用批量写入。</li>
      </ol>
      <div class="tutorial-banner"><strong>建议先试 50 到 200 行</strong><span>先验证编码、行对齐、术语和控制码，再处理整个项目。这样发现设置不合适时，返工最少。</span></div>

      <h2 id="html">看懂两种 HTML</h2>
      <h3>HTML 文件夹版前端</h3>
      ${image("folder-review.png", "文件夹版行审阅 HTML", "文件夹版负责选择文件、查看整体状态、打开单文件页面和批量写回。")} 
      ${image("line-review.png", "单文件行审阅 HTML", "单文件版是实际阅读、编辑、搜索和逐条处理校对意见的主要工作区。")} 
      <p>文件夹版像目录和控制台，单文件版才是主要工作区。文件夹版还提供选择文件、打开单文件 HTML 和批量写入功能。真人翻译或校对时，建议从文件夹页打开某个文件，在新标签页里工作。</p>

      <h2 id="translation">跑一次完整翻译</h2>
      <ol class="step-list">
        <li><strong>在“完整 Workflow”选择“初翻”</strong><br>界面只有初翻与校对两个选择，不需要寻找术语或角色的独立流程。</li>
        <li><strong>填写语言、文本类型和作品说明</strong><br>有官方 Wiki 或角色页可以放进作品说明；Agent 会在需要时读取。</li>
        <li><strong>决定是否保留旧译</strong><br>没有可用旧译就保持关闭；已有部分可靠译文才开启“审计并复用已有译文”。</li>
        <li><strong>生成并发送翻译提示词</strong><br>发送前页面会先保存项目设置。保存失败时会停止，避免用旧设置误跑。</li>
        <li><strong>等待流程完成</strong><br>主 Agent 负责规划和汇总，子 Agent 领取有边界的分片。出现旧译选择或术语冲突时再按提示决定。</li>
      </ol>
      <p>最简用法就是：选源文、选项目目录、生成 HTML、配置模型、生成翻译提示词并发送。完成后回到 HTML 点击刷新，把候选译文导入页面。</p>
      ${image("refresh-translation.png", "Agent 译文刷新区域", "Agent 完成后点击这里的“刷新”，页面会重新扫描候选译文。")} 
      <p>刷新后先抽查人名、占位符、空行和章节衔接，再进入校对。HTML 中的候选不会自动写回真实 TXT。</p>

      <h2 id="reuse">已有译文怎么处理</h2>
      <div class="choice-strip">
        <div><span>关闭</span><strong>干净重翻</strong><p>软件先备份旧候选，再清空本轮需要翻译的内容。旧译仍可作为历史参考，但不会直接混入结果。</p></div>
        <div><span>开启</span><strong>审计后复用</strong><p>明显合格的行直接保留，风险行由 Agent 判断。最后你选择保留通过行，或舍弃全部旧译。</p></div>
      </div>
      <p>复用适合已经人工翻过一部分，或旧版本大多数文本可靠的项目。机器粗译质量不稳定时，通常干净重翻更省心。</p>

      <h2 id="proofread">校对已有译文</h2>
      <ol class="step-list">
        <li><strong>确认原文和译文一一对应</strong><br>行数不一致时先修正输入，不要强行开始。</li>
        <li><strong>选择“校对”并发送提示词</strong><br>最终交付建议使用按拆分大小校对；只想快速了解质量可用 Monte Carlo。</li>
        <li><strong>等待校对完成，再生成审阅 HTML</strong><br>软件先扫描格式、占位符、长度和术语风险，再由 Agent 结合上下文判断。</li>
      </ol>
      ${image("proofread-review.png", "校对建议审阅页面", "生成审阅 HTML 后，每条建议都带原文、当前译文和建议修正。")} 
      <p>审阅意见默认处于可应用状态，但强烈建议自己读一遍。你可以接受、拒绝或直接手改；“一键应用”先把建议同步到各 HTML，真正保存到目标文件还需要点击“写入 TXT”或“批量写入 TXT”。</p>

      <h2 id="assets">术语表、候选与角色表</h2>
      <p>正式术语表是最高优先级的项目译名。翻译过程中产生的 Glossary candidate 只是候选，人工确认后才能导入正式表；与已有正式译名冲突时不会静默覆盖。</p>
      ${image("glossary-editor.png", "术语表管理页面", "这里可以查看正式术语与候选、筛选状态、批量替换并导入确认后的候选。")} 
      <p>翻译过程本来就会按当前原文读取命中的正式术语、候选术语和角色记录。你不需要另跑一个“读取术语表 Workflow”。关闭“生成译名表候选”只是不再新增候选，已有资料仍会用于只读参考。</p>

      <h2 id="line-editing">人工翻译与行级操作</h2>
      <p>手动编辑过的内容会显示为黄色；“还原当前行”会回到本次导入的候选。校对问题通常按高、中、低严重程度使用淡红、淡黄和淡蓝提示。</p>
      ${image("issue-row.png", "带 H2 问题标记的译文行", "示例中的译文行带有高优先级 H2 标记；修正后可手动取消问题标记。")} 
      <ul class="plain-check">
        <li>编辑为正确译文后，问题标记不会擅自消失；由你确认后取消。</li>
        <li>在源文中选中文本并使用右键菜单，可以把这一句和必要上下文交给 Agent 询问。</li>
        <li>搜索、跳转和术语替换适合大文件；替换术语前先预览，避免误改普通词。</li>
      </ul>

      <h2 id="agent">看懂 Agent 会话</h2>
      <p>完整流程运行时可以随时询问进度。主 Agent 等待子 Agent 返回时仍可交互；思考和 Function 调用都以可展开的结构化块显示。</p>
      ${image("tool-call.png", "展开后的 Function 调用", "Function 卡片可以展开查看调用内容、运行时间和返回结果。")} 
      ${image("subagent-card.png", "子 Agent 卡片", "子 Agent 卡片显示当前任务和状态，也可以进入查看主 Agent 与它的交互。")} 
      <p>进入子 Agent 卡片后，可以检查它拿到的任务、工具调用与最后结果，而不是只看主 Agent 的一句汇总。</p>
      ${image("token-telemetry.png", "Agent Token 与费用估算", "会话顶部显示输入、输出、缓存 Token 与估算费用。")} 
      <p>费用是 Pi 根据 Token 估算的数值，不一定等于实际账单。订阅制以服务商的用量百分比为准，API 以服务商账单为准。</p>
      ${image("slash-commands.png", "Agent 斜杠命令菜单", "在输入框键入斜杠可查看可用命令；运行中也可以选择插话或排队。")} 
      <p>选择“插话”会在当前工具返回后让同一 Agent 尽快看到补充；选择“排队”则把消息放到当前工作之后。多模态模型还可以接收图片。</p>

      <h2 id="lan">手机、局域网与公网远程</h2>
      <p>在桌面应用内打开 HTML，输入自己的 6 位 PIN 并启动局域网同步。同一网络里的手机、平板或另一台电脑可打开页面给出的地址；桌面应用必须保持运行。</p>
      <div class="reference-pair wide-pair">
        ${image("lan-settings.png", "局域网同步设置", "桌面页面会显示 PIN、本地地址、局域网地址和停止同步按钮。")} 
        ${image("lan-browser.png", "手机浏览器中的同步页面", "远端页面可以编辑译文，也可以打开 Agent 面板继续交互。")} 
      </div>
      <p>需要在外网访问时，可以自行使用 Cloudflare Tunnel、ngrok 等工具，把隧道指向页面显示的本地同步地址。软件本身不内置公网穿透。</p>
      ${image("tunnel-terminal.png", "Cloudflare Tunnel 控制台", "运行隧道命令后，控制台会给出临时公网地址；关闭进程后地址失效。")} 
      <pre class="band"><code>cloudflared tunnel --url http://127.0.0.1:页面显示的端口</code></pre>
      <div class="note danger"><strong>公网地址等于把工作台暴露到互联网</strong>使用不可猜的 PIN，不要公开临时地址，结束后关闭隧道和局域网同步。不要把包含私密文本的项目交给不受信任的穿透服务。</div>
      <p>通过公网地址打开的远程页面同样支持 Agent 面板，出门后也能检查进度、插话或继续人工校对。</p>
      ${image("agent-panel.png", "远程页面中的 Agent 面板", "远程页面中的 Agent 面板可以查看进度、发送消息并继续工作。")} 

      <h2 id="troubleshooting">常见问题先查这里</h2>
      <div class="table-wrap"><table><thead><tr><th>现象</th><th>先检查</th><th>处理</th></tr></thead><tbody>
        <tr><td>Agent 没有回复</td><td>服务、凭证、模型、代理是否匹配</td><td>先在新会话发普通消息；海外服务需要代理时再打开代理开关。</td></tr>
        <tr><td>生成提示词后仍是旧设置</td><td>项目是否保存成功</td><td>页面现在会在保存失败时明确停止。修复路径或权限后重新生成。</td></tr>
        <tr><td>校对无法开始</td><td>源文与译文行数、文件对应关系</td><td>先修到严格对齐；不要用空行填充来掩盖错位。</td></tr>
        <tr><td>术语流程停住</td><td>是否出现同一原词的多个译名</td><td>查看主 Agent 给出的证据并选定译名；系统会先修受影响行，再继续原队列。</td></tr>
        <tr><td>手机打不开</td><td>桌面应用是否运行、是否同网、防火墙是否放行</td><td>重新启动同步，优先使用页面给出的局域网地址。</td></tr>
        <tr><td>Agent 停止后想继续</td><td>会话中是否保留恢复状态</td><td>在同一会话明确要求继续。已写出的可验证候选和审阅证据会尽量复用。</td></tr>
      </tbody></table></div>`;
  }

  function renderWorkflows() {
    return `${pageHead("技术手册 A", "两条 Workflow 的完整链路", "当前 Registry 只暴露初翻与校对两个完整入口。下面关注数据怎样流过 UI、Pi runtime、Host、Worker、验证器和产物，不重复教程里的按钮说明。")}
      <div class="technical-intro"><span>阅读前提</span><p>Workflow 是从入口到完成门槛的一整套运行契约。旧译审计、术语门、局部修复和 Monte Carlo 是流程中的阶段或有界子流程。</p></div>

      <h2 id="registry">Workflow Registry</h2>
      <div class="choice-strip">
        <div><span><code>initial_translation</code></span><strong>初翻</strong><p>产出行对齐的候选译文，包含分片写入、独立审阅、术语协调和最终验证。</p></div>
        <div><span><code>proofread</code></span><strong>校对</strong><p>产出唯一 findings JSON，再由产品生成供人类审批的 HTML。</p></div>
      </div>

      <h2 id="translation-workflow">初翻：从 Prompt 到候选译文</h2>
      <div class="architecture-flow">
        ${["保存项目设置", "建立文件清单", "处理旧译", "分派翻译块", "写 staging", "独立审阅", "术语协调", "全文验证"].map((item, index) => `<div><span>${String(index + 1).padStart(2, "0")}</span><strong>${item}</strong></div>`).join("")}
      </div>
      <div class="workflow-timeline">
        <section class="workflow-step"><div class="workflow-step-index">01</div><div class="workflow-step-main"><h3>UI 保存本轮设置</h3><p>页面先把当前文件绑定、语言、拆分、文件顺序、复用选项和并发上限原子写入项目，再生成带翻译标记的 Prompt。保存失败时不启动运行。</p></div></section>
        <section class="workflow-step"><div class="workflow-step-index">02</div><div class="workflow-step-main"><h3>Host 建立 authoritative manifest</h3><p>单文件、文件夹顺序和 EPUB 提取文本都被归一成文档清单。每项拥有自己的文档身份、原文路径、候选路径、行数和阶段。</p></div></section>
        <section class="workflow-step"><div class="workflow-step-index">03</div><div class="workflow-step-main"><h3>旧译分叉</h3><p>关闭复用时先备份并清空一次；开启时先机械快筛，再把少量风险行交给只读审计 Worker。用户的一次选择会事务性应用到整个清单。</p></div></section>
        <section class="workflow-step"><div class="workflow-step-index">04</div><div class="workflow-step-main"><h3>Host 生成真实债务队列</h3><p>按拆分大小、文件阶段、复用掩码和已有接受证据创建不重叠 assignment。Worker 数限制并发，assignment 数表示工作量。</p></div></section>
        <section class="workflow-step"><div class="workflow-step-index">05</div><div class="workflow-step-main"><h3>翻译 Worker 读取与写入</h3><p>Worker 读取自己的原文、短邻域和直接命中的项目资料，写入 Host 管理的 staging。行数、占位符、标签、控制码和自定义保留规则先由代码检查。</p></div></section>
        <section class="workflow-step"><div class="workflow-step-index">06</div><div class="workflow-step-main"><h3>审阅 Worker 独立判断</h3><p>Host 选出所有机械风险行和稳定的普通行样本。审阅只返回失败行；失败交回原翻译 Worker 精确修复，通过后 staging 才提升为正式候选。</p></div></section>
        <section class="workflow-step"><div class="workflow-step-index">07</div><div class="workflow-step-main"><h3>术语协调形成优先修复波</h3><p>同原词同译名自动合并证据；同原词不同译名关闭新任务领取门。主 Agent 选定译名后，Host 先修受影响行并复审，再开放原队列。</p></div></section>
        <section class="workflow-step"><div class="workflow-step-index">08</div><div class="workflow-step-main"><h3>全文验证与 warning postcheck</h3><p>阻断性问题必须先清零。未被块级审阅覆盖的非阻断警告由主 Agent 读取成对原译文判断；真阳性变成精确修复债务，假阳性保存为当前 hash 的接受证据。</p></div></section>
      </div>

      <h3 id="translation-input-map">输入在哪一步读取</h3>
      <div class="table-wrap"><table><thead><tr><th>输入</th><th>第一次生效</th><th>后续作用</th></tr></thead><tbody>
        <tr><td>语言、文本类型、作品说明</td><td>Prompt 与 parent context</td><td>assignment 语境、目标语言判断、必要的网页资料读取</td></tr>
        <tr><td>拆分大小、文件顺序</td><td>Host 队列规划</td><td>动态领取、阶段屏障、冷恢复时的未完成债务</td></tr>
        <tr><td>正式术语、候选、角色表</td><td>项目上下文检查</td><td>每个 assignment 只注入原文直接命中的完整记录</td></tr>
        <tr><td>正则保留规则</td><td>项目设置归一化</td><td>旧译快筛、分片写入检查、全文验证</td></tr>
        <tr><td>旧候选译文</td><td>复用准备或首次写入前</td><td>保留行形成 baseline；历史备份仍可按需只读</td></tr>
      </tbody></table></div>

      <h2 id="proofread-workflow">校对：从对齐文本到 Findings</h2>
      <div class="architecture-flow compact">
        ${["绑定原译文", "全清单预扫", "规划检查范围", "语义复核", "合并 Findings", "人类审批"].map((item, index) => `<div><span>${String(index + 1).padStart(2, "0")}</span><strong>${item}</strong></div>`).join("")}
      </div>
      <ol class="technical-steps">
        <li><span>01</span><div><strong>绑定</strong><p>每个文档绑定自己的原文和候选译文。行数或身份不一致时在启动 Worker 前失败。</p></div></li>
        <li><span>02</span><div><strong>确定性预扫</strong><p>Host 对所有文档扫描格式、保护载荷、术语、异常长度等信号，并绑定原文、译文和项目资产 hash。</p></div></li>
        <li><span>03</span><div><strong>计划</strong><p>Split 覆盖全部行；Monte Carlo 使用不重复的高、中、低风险分层样本和明确的收敛条件。</p></div></li>
        <li><span>04</span><div><strong>语义 Worker</strong><p>结合原文、译文、邻近上下文和直接命中的资料确认或驳回机械信号，同时发现机械扫描覆盖不到的语义问题。</p></div></li>
        <li><span>05</span><div><strong>唯一报告</strong><p>Findings 按 scope replacement 语义合并到同一 JSON，避免重跑时重复。专名候选需要完成决策后才能 finalise。</p></div></li>
        <li><span>06</span><div><strong>可视化审批</strong><p>HTML 只负责呈现 JSON。最终是否应用建议，以及何时写入真实 TXT，仍由用户决定。</p></div></li>
      </ol>

      <h2 id="completion">两条流程如何判定完成</h2>
      <div class="formula"><code>complete</code><b>=</b><code>清单覆盖</code><b>∧</b><code>任务已接受</code><b>∧</b><code>审阅债务清零</code><b>∧</b><code>共享资产已结算</code><b>∧</b><code>最终验证通过</code></div>
      <p>完成状态来自 Host 持久化的文档、范围、hash 和 verdict。模型提前说“完成了”时，runtime 会把缺少的工作作为同一会话的后续要求交回模型。</p>

      <h2 id="bounded-flows">流程里的有界子流程</h2>
      <div class="table-wrap"><table><thead><tr><th>子流程</th><th>触发点</th><th>结果回到哪里</th></tr></thead><tbody>
        <tr><td>旧译复用审计</td><td>初翻开始且用户打开复用</td><td>生成保留 baseline 与稀疏重译债务</td></tr>
        <tr><td>术语冲突处理</td><td>同一原词观察到不同目标译名</td><td>主 Agent 决策后进入当前翻译批次的优先修复波</td></tr>
        <tr><td>翻译块复审</td><td>每块机械检查通过后</td><td>通过则提交候选，失败则回原 Worker 精确修复</td></tr>
        <tr><td>最终 warning postcheck</td><td>全文阻断问题清零后</td><td>真阳性转成 parent 精确修复，假阳性成为接受证据</td></tr>
        <tr><td>Monte Carlo 上限决策</td><td>达到最多轮数仍有新问题</td><td>用户选择继续三轮、只查高风险区或按当前结果停止</td></tr>
        <tr><td>局部修复 / 调查</td><td>用户明确要求某文件或某几行</td><td>保持精确读写范围，不创建新的完整 Workflow</td></tr>
      </tbody></table></div>`;
  }

  function renderFunctions() {
    const renderItems = (items, runtime) => items.map((item, index) => {
      const detail = data.functionDetails[`${runtime}:${item.name}`] ?? {
        scope: runtime === "parent" ? "Parent Host runtime" : "Child runtime",
        call: item.summary,
        input: item.params.length ? item.params.join("、") : "无模型参数。",
        reads: "见当前运行时绑定。",
        mutates: "见函数摘要。",
        result: "结构化工具结果。",
        failure: "身份、范围、hash 或 schema 不匹配时拒绝。",
        next: "由调用它的 Host 流程决定。",
        source: "源码位置待补充"
      };
      const searchable = [item.name, item.group, item.summary, ...item.params, ...Object.values(detail)].join(" ").toLowerCase();
      return `<details class="function-item" id="${runtime}-${slug(item.name)}" data-function data-runtime="${runtime}" data-group="${esc(item.group)}" data-search="${esc(searchable)}"><summary><span class="function-name">${item.name}</span><span class="function-group">${runtime === "parent" ? "Parent Host" : "Child runtime"} · ${item.group}</span><span class="function-summary">${item.summary}</span><span class="function-caret">›</span></summary><div class="function-body">
        <div class="function-contract"><div><span>所在边界</span><p>${detail.scope}</p></div><div><span>调用时机</span><p>${detail.call}</p></div><div><span>输入</span><p>${detail.input}</p></div><div><span>读取</span><p>${detail.reads}</p></div><div><span>状态变化</span><p>${detail.mutates}</p></div><div><span>返回</span><p>${detail.result}</p></div><div class="danger-cell"><span>拒绝条件</span><p>${detail.failure}</p></div><div><span>下一步</span><p>${detail.next}</p></div></div>
        <div class="function-foot"><div><strong>参数索引</strong><div class="chip-row">${item.params.length ? item.params.map((param) => `<span class="chip">${param}</span>`).join("") : '<span class="chip">无模型参数</span>'}</div></div><code>${detail.source.replace(/:\d+$/, "")}</code><span>本组 ${index + 1} / ${items.length}</span></div>
      </div></details>`;
    }).join("");
    return `${pageHead("技术手册 C", `Function Registry：${data.metrics.callableSurfaces} 个调用面`, `Parent 有 ${data.metrics.parentFunctions} 个调用面，child 有 ${data.metrics.childFunctions} 个。三个只读文件工具在两侧各有受不同权限约束的实现，因此共有 ${data.metrics.uniqueFunctions} 个唯一名称。`)}
      <div class="technical-intro"><span>如何使用本页</span><p>先按运行时或分组筛选，再展开单个 Function。每项只保留边界、输入、读取、状态变化、返回、拒绝条件和下一步。</p></div>

      <h2 id="scope">运行时分工</h2>
      <div class="scope-matrix"><div class="scope-row head"><span>运行时</span><span>读取范围</span><span>允许产出</span><span>终止动作</span></div><div class="scope-row"><strong>Parent</strong><span>当前项目、外部绝对参考、Host state</span><span>调度、候选、Findings、项目资产</span><span>通过 completion gate 汇总</span></div><div class="scope-row"><strong>Translation child</strong><span>负责行、短上下文、命中资产</span><span>自己的 staging 与发现</span><span>验证负责范围</span></div><div class="scope-row"><strong>Review child</strong><span>风险行、样本、短邻域</span><span>只提交失败 verdict</span><span>提交审阅</span></div><div class="scope-row"><strong>Proofread child</strong><span>负责行、信号、批准参考</span><span>Findings 与证据型候选</span><span>写入 Findings</span></div><div class="scope-row"><strong>Reuse child</strong><span>选中的原译文对</span><span>reuse / retranslate verdict</span><span>提交审计</span></div></div>

      <h2 id="registry">完整 Registry</h2>
      <div class="filters"><input id="function-search" type="search" placeholder="搜索函数、资产、失败条件或返回值"><select id="runtime-filter"><option value="">Parent + Child</option><option value="parent">Parent Host</option><option value="child">Child runtime</option></select><select id="group-filter"><option value="">全部分组</option>${[...new Set([...data.parentFunctions, ...data.childFunctions].map((item) => item.group))].sort().map((group) => `<option>${group}</option>`).join("")}</select></div>
      <p id="function-count" class="image-caption"></p>
      <div class="function-list" id="function-list">${renderItems(data.parentFunctions, "parent")}${renderItems(data.childFunctions, "child")}</div>

      <h2 id="composition">四条常见调用链</h2>
      <div class="table-wrap"><table><thead><tr><th>场景</th><th>Parent</th><th>Child</th></tr></thead><tbody>
        <tr><td>完整翻译</td><td><code>inspectTranslationContext</code> → <code>runTranslationSubagents</code> → warnings / final validation</td><td>read source → write staging → validate → independent review</td></tr>
        <tr><td>完整校对</td><td>inspect → prescan → <code>runProofreadSubagents</code> → candidate decisions → finalize</td><td>read context → optional reference → write findings</td></tr>
        <tr><td>精确修复</td><td>write exact lines → inspect alignment → read paired rows → record failures → validate</td><td>read bound rows → repair only Host-authorized lines</td></tr>
        <tr><td>旧译复用</td><td>prepare → run audit → apply one decision</td><td>read selected pairs → submit binary verdicts</td></tr>
      </tbody></table></div>`;
  }

  function renderHarness() {
    return `${pageHead("技术手册 B", "Harness 架构", "从一条用户消息进入 Pi Agent，到 Host 调度、Worker 写入、审阅、术语协调、持久化和完成判定。这里解释结构与数据流，不逐项复述产品文案。")}
      <h2 id="architecture">总体结构</h2>
      <div class="architecture-map">
        <div class="architecture-node ui"><span>界面</span><strong>工作台 / 行审阅 / LAN</strong><small>收集本轮选择，展示 canonical 会话与产物</small></div>
        <b>→</b>
        <div class="architecture-node pi"><span>Pi Runtime</span><strong>Parent Agent</strong><small>推理、调用工具、接收 Steer 与 Follow-up</small></div>
        <b>→</b>
        <div class="architecture-node host"><span>Host</span><strong>Typed DomainRun</strong><small>清单、权限、队列、证据、提交与 completion</small></div>
        <b>⇄</b>
        <div class="architecture-node workers"><span>Pi Children</span><strong>翻译 / 审阅 / 校对 / 复用</strong><small>各自只看到完成 assignment 所需的工具和上下文</small></div>
      </div>
      <p>Parent 和 child 都使用同一种 Pi session 运行时与 append-only JSONL。Host 不替模型写内容，它保存任务身份、文档范围、hash、债务和验证结论，并据此决定哪些工具可用、哪些结果能提交。</p>

      <h2 id="agent-loop">一次 Agent turn 怎样推进</h2>
      <div class="code-flow"><code>User AgentMessage</code><b>→</b><code>Agent.prompt()</code><b>→</b><code>toolCall</code><b>→</b><code>Host execute</code><b>→</b><code>toolResult</code><b>→</b><code>Agent.continue()</code></div>
      <p>工具失败会作为精确结果回到同一 turn，让 Agent 修正调用。成功的 Host-terminal child 工具结束当前工具批次，防止模型在结构化提交后再浪费一次调用复述计数。</p>
      <div class="contract-grid"><div class="contract-cell"><span>Steer</span><p>当前工具返回后尽快消费；child 只有真正写入自己的 Pi session 后才报告接受。</p></div><div class="contract-cell"><span>Follow-up</span><p>在当前工作完成后消费，原始消息在输入框立即可见。</p></div><div class="contract-cell"><span>Child completion</span><p>写入轻量状态并唤醒 Parent；即使同时建立恢复暂停，也会触发一次可见汇报。</p></div></div>

      <h2 id="typed-state">Host 持有的核心状态</h2>
      <div class="table-wrap"><table><thead><tr><th>状态</th><th>包含内容</th><th>解决的问题</th></tr></thead><tbody>
        <tr><td>Workflow identity</td><td>类型、owner session、活动或暂停状态</td><td>普通对话不会意外取得完整流程授权</td></tr>
        <tr><td>Document manifest</td><td>文档身份、原文与候选路径、行数、顺序阶段</td><td>文件夹结果不会记到错误文件</td></tr>
        <tr><td>Assignment</td><td>负责文档、连续范围或精确行、输入 hash、Worker、尝试次数</td><td>读上下文不会扩大写权限</td></tr>
        <tr><td>Review evidence</td><td>staging hash、风险行、稳定样本、verdict、修复债务</td><td>非空候选不会被误当成已通过</td></tr>
        <tr><td>Proofread evidence</td><td>预扫 hash、scope coverage、抽样池、Findings revision</td><td>输入变化时精确失效旧结论</td></tr>
        <tr><td>Scheduler</td><td>Worker 数、任务数、活动批次、阶段门、失败状态</td><td>并发上限和实际工作量分离</td></tr>
      </tbody></table></div>

      <h2 id="tool-projection">工具集如何收紧</h2>
      <p>Host 根据当前 operation scope 构造工具集。完整翻译、完整校对、局部修复和只读调查各自拥有不同的写入边界；child 不再允许启动下一层 subagent。</p>
      <div class="scope-matrix"><div class="scope-row head"><span>角色</span><span>主要读取</span><span>允许改变</span><span>Host 校验</span></div><div class="scope-row"><strong>Parent</strong><span>项目与 Host state</span><span>调度、项目资产、精确局部写入</span><span>session / document / scope</span></div><div class="scope-row"><strong>翻译 Worker</strong><span>负责行与短上下文</span><span>自己的 staging</span><span>行身份 / 保护载荷 / hash</span></div><div class="scope-row"><strong>审阅 Worker</strong><span>选中行与样本</span><span>失败 verdict</span><span>只接收活动页面中的精确行</span></div><div class="scope-row"><strong>校对 Worker</strong><span>负责行、信号与批准参考</span><span>Findings</span><span>范围 / schema / no-op / evidence</span></div></div>

      <h2 id="scheduler">动态队列与双 Worker 池</h2>
      <div class="scheduler-diagram"><div class="scheduler-source"><strong>文件阶段</strong><span>{ A, B } → C → { D, E }</span><small>阶段之间严格等待</small></div><b>→</b><div class="scheduler-queue"><strong>共享任务队列</strong><span>taskCount = 实际债务块</span><small>可多于 Worker 数</small></div><b>→</b><div class="scheduler-pools"><div><strong>翻译池</strong><span>写 staging / 精确修复</span></div><div><strong>审阅池</strong><span>只读风险行与稳定样本</span></div></div></div>
      <p>Worker 先原子领取真实 assignment，再用该任务的文档、模型和标签创建或重置 runtime。完成后领取当前开放阶段的下一块。失败任务留在原 session 有界恢复，不推到队尾换人重做。</p>

      <h2 id="terminology">术语候选更新与冲突门</h2>
      <div class="architecture-flow compact">
        ${["Worker 上报证据", "机械与审阅通过", "Host observed", "合并或建冲突", "Parent 决策", "优先修复", "恢复队列"].map((item, index) => `<div><span>${String(index + 1).padStart(2, "0")}</span><strong>${item}</strong></div>`).join("")}
      </div>
      <ol class="technical-steps">
        <li><span>01</span><div><strong>发现与接受分离</strong><p>翻译 Worker 只能在自己的验证工具中上报专名候选和证据，不能直接写共享术语文件。</p></div></li>
        <li><span>02</span><div><strong>通过后立即 observed</strong><p>assignment 通过机械校验和只读审阅后，Host 才按原词与目标译名 hash 记录观察。</p></div></li>
        <li><span>03</span><div><strong>正式表优先</strong><p>正式术语已覆盖时直接以正式译名为准。同原词同译名合并证据并原子写入 provisional candidate。</p></div></li>
        <li><span>04</span><div><strong>冲突关闭领取门</strong><p>同原词不同译名会持久化 conflict。已在运行的任务可以到达安全门，新 assignment 暂停领取。</p></div></li>
        <li><span>05</span><div><strong>决策变成精确修复</strong><p>Parent 选择译名后，Host 找到当前真正拥有相关文档范围的活动批次，把受影响行合成优先 repair assignment。</p></div></li>
        <li><span>06</span><div><strong>一个提交边界</strong><p>候选文件、DomainRun 术语状态和 Host 持久化按项目串行提交；失败时一起回滚。</p></div></li>
      </ol>
      <div class="note"><strong>关闭候选收集时</strong>现有候选仍可作为只读参考；不构造新候选、不启动冲突门、不恢复候选产生的修复债务。正式术语的机械一致性检查继续运行。</div>

      <h2 id="review-loop">翻译审阅与失败接管</h2>
      <div class="formula"><code>write staging</code><b>→</b><code>mechanical scan</code><b>→</b><code>read-only review</code><b>→</b><code>exact repair</code><b>→</b><code>atomic promote</code></div>
      <p>审阅覆盖全部高风险行，并从普通行按分片长度的平方根取稳定样本。纯目标语言标点或排版差异不会进入修复循环。相同候选再次被拒绝表示没有进展，会立即暴露失败；候选持续变化也只允许有界修复。</p>
      <p>有界修复耗尽但 staging 仍可验证时，Host 会把该范围提升为 parent-owned mutation，把精确失败行交给主 Agent继续修复。只有 provider 传输耗尽或 staging 无法形成可靠交接时，才进入需要用户明确继续的恢复边界。</p>

      <h2 id="warning-postcheck">最终 Warning Postcheck</h2>
      <p>全文验证先处理 blocking finding。剩余 warning 中，已经被同一 hash 的块级 reviewer 接受的“同一行同一代码”不会重复升级；其他 warning 通过成对读取函数分页交给 Parent。</p>
      <div class="code-flow"><code>inspectTranslationWarnings</code><b>→</b><code>canonical source + translation windows</code><b>→</b><code>recordTranslationWarningChecks</code><b>→</b><code>false-positive evidence / exact repair lines</code></div>

      <h2 id="persistence">持久化与恢复</h2>
      <div class="table-wrap"><table><thead><tr><th>存储</th><th>内容</th><th>恢复条件</th></tr></thead><tbody>
        <tr><td>Parent Pi JSONL</td><td>消息、工具调用与结果、compaction、Host custom entries</td><td>session 与项目 owner 匹配</td></tr>
        <tr><td>Child Pi JSONL</td><td>每个 Worker 的完整 assignment 对话与 retry</td><td>Parent ownership 和 child session 引用匹配</td></tr>
        <tr><td>Host state</td><td>manifest、assignment、债务、coverage、批次与恢复边界</td><td>文档和输入身份仍成立</td></tr>
        <tr><td>Translation staging</td><td>hash-current 候选、待审阅或精确修复状态</td><td>路径、行数、范围输入 hash 和候选 hash 匹配</td></tr>
        <tr><td>Reuse audit store</td><td>owner、源译 hash、保留 baseline、逐行 verdict</td><td>同一 parent session 且整批 hash-current</td></tr>
      </tbody></table></div>
      <p>staging 提升、canonical 文件、DomainRun revision、alignment evidence 和 Host JSONL 构成一个可回滚提交。任何一步失败都恢复旧 canonical 与状态，同时保留 staging。</p>

      <h2 id="token-efficiency">Token 为什么能省</h2>
      <div class="formula"><span>单次 Child 上下文</span><b>≈</b><code>系统契约</code><b>+</b><code>负责行</code><b>+</b><code>短边界</code><b>+</b><code>命中资产</code><b>+</b><code>当前债务</code></div>
      <div class="three-col"><article class="topic-card"><span class="num">Host</span><h3>机械工作留在代码</h3><p>清单、行数、hash、保护载荷、风险信号、抽样和覆盖不让模型重复推理。</p></article><article class="topic-card"><span class="num">Index</span><h3>只注入命中资产</h3><p>完整术语表和角色表不随每个 assignment 重复进入上下文。</p></article><article class="topic-card"><span class="num">Sparse</span><h3>只派发真实债务</h3><p>复用行、已接受范围和假阳性 warning 不重新进入翻译队列。</p></article><article class="topic-card"><span class="num">Review</span><h3>通过行保持沉默</h3><p>Reviewer 只上报失败行，不为大量正常行生成解释。</p></article><article class="topic-card"><span class="num">Session</span><h3>Worker 持久但上下文重置</h3><p>复用 runtime，同时在 assignment 间 reset active context，旧对话只留作审计。</p></article><article class="topic-card"><span class="num">State</span><h3>大状态保留在 Host</h3><p>清单、完整 transcript、审计数组和覆盖统计不反复回灌 Parent。</p></article></div>

      <h2 id="observability">可观测性</h2>
      <div class="table-wrap"><table><thead><tr><th>对象</th><th>证据</th><th>能回答的问题</th></tr></thead><tbody>
        <tr><td>Provider</td><td>session、provider、model、脱敏 cause chain、WS 次数</td><td>失败来自模型、代理、WS/SSE 还是 fetch？</td></tr>
        <tr><td>Assignment</td><td>文档、范围、Worker、staging、attempt、review debt</td><td>具体失败在哪一块，是否能续跑？</td></tr>
        <tr><td>术语门</td><td>观察目标、冲突来源、受影响范围、priority queue</td><td>为什么队列暂停，决定后修哪些行？</td></tr>
        <tr><td>UI</td><td>结构化 thinking、tool、queue update、child card</td><td>当前在推理、调用工具、审阅还是等待？</td></tr>
        <tr><td>完成状态</td><td>coverage、accepted scopes、pending assets、validator debt</td><td>为什么模型已回复但流程尚未完成？</td></tr>
      </tbody></table></div>
      <p class="source-note">关键入口：<code>sessionAgentRuntime.ts</code> 维护 Pi loop；<code>ynDomainTools.ts</code> 构造 Parent Host Functions；<code>subagentRunner.ts</code> 构造 child 工具；<code>workflowTemplates.ts</code> 只登记两个完整 Workflow。</p>`;
  }

  function renderTerminology() {
    const terms = window.YN_GUIDE_TERMINOLOGY;
    if (!terms?.entries?.length) throw new Error("YN guide terminology data is missing.");
    const copy = locale === "en" ? {
      eyebrow: "Technical manual 0",
      title: "Agent terminology",
      subtitle: "A plain-language vocabulary for readers who have not worked with Agent systems. Each entry separates the general engineering meaning from its exact use in YN Translation Workshop.",
      introLabel: "Read this first",
      intro: "Words such as Host, Harness, Runtime, staging, and canonical are common in Agent engineering, but teams use them at different scopes. This page defines the scope used by this manual.",
      mapTitle: "The five layers in one picture",
      searchTitle: "Term index",
      searchPlaceholder: "Search Host, staging, scope, JSONL, or a plain-language explanation",
      count: "terms shown",
      plain: "General meaning",
      yn: "Meaning in YN",
      not: "Do not confuse it with"
    } : {
      eyebrow: "技术手册 0",
      title: "Agent 工程术语",
      subtitle: "给没有 Agent 开发背景的读者准备的词汇入口。每个词都会先解释行业里通常指什么，再说明它在 YN Translation Workshop 中具体指哪一层。",
      introLabel: "请先读这里",
      intro: "Host、Harness、Runtime、staging、canonical 等词在 Agent 工程里很常见，但不同团队使用的范围并不完全一样。本页给出这本手册后续统一采用的含义。",
      mapTitle: "先用一张图看五层关系",
      searchTitle: "术语索引",
      searchPlaceholder: "搜索 Host、staging、scope、JSONL 或中文解释",
      count: "个术语",
      plain: "行业常用含义",
      yn: "在 YN 中",
      not: "不要误解为"
    };
    const categoryOptions = Object.entries(terms.categories).map(([key, labels]) => `<option value="${key}">${labels[locale]}</option>`).join("");
    const sections = Object.entries(terms.categories).map(([category, labels]) => {
      const cards = terms.entries.filter((entry) => entry.category === category).map((entry) => {
        const value = entry[locale];
        const searchable = [entry.term, entry.zh.plain, entry.zh.yn, entry.en.plain, entry.en.yn].join(" ").toLocaleLowerCase();
        return `<article class="term-card" id="term-${slug(entry.term)}" data-term data-category="${category}" data-search="${esc(searchable)}"><header><code>${esc(entry.term)}</code></header><dl><div><dt>${copy.plain}</dt><dd class="term-plain">${value.plain}</dd></div><div><dt>${copy.yn}</dt><dd class="term-yn">${value.yn}</dd></div><div class="term-warning"><dt>${copy.not}</dt><dd class="term-not">${value.not}</dd></div></dl></article>`;
      }).join("");
      return `<section class="term-category" data-term-section="${category}"><h2 id="category-${category}">${labels[locale]}</h2><div class="term-grid">${cards}</div></section>`;
    }).join("");
    return `${pageHead(copy.eyebrow, copy.title, copy.subtitle)}
      <div class="technical-intro"><span>${copy.introLabel}</span><p>${copy.intro}</p></div>
      <h2 id="layer-map">${copy.mapTitle}</h2>
      <div class="term-layer-map"><div><span>01</span><strong>${locale === "en" ? "User and interface" : "用户与界面"}</strong><small>Renderer / LAN</small></div><b>→</b><div><span>02</span><strong>Pi Runtime</strong><small>Agent loop / Session</small></div><b>→</b><div><span>03</span><strong>YN Host</strong><small>Contract / Scope / State</small></div><b>→</b><div><span>04</span><strong>Workers</strong><small>Assignment / Tool call</small></div><b>→</b><div><span>05</span><strong>${locale === "en" ? "Artifacts" : "产物"}</strong><small>Staging / Canonical</small></div></div>
      <h2 id="term-index">${copy.searchTitle}</h2>
      <div class="term-filters"><input id="term-search" type="search" placeholder="${copy.searchPlaceholder}"><select id="term-category"><option value="">${locale === "en" ? "All categories" : "全部分类"}</option>${categoryOptions}</select><span id="term-count"></span></div>
      ${sections}`;
  }

  function renderPage() {
    const renderers = { overview: renderOverview, guides: renderGuides, features: renderFeatures, workflows: renderWorkflows, harness: renderHarness, functions: renderFunctions, terminology: renderTerminology };
    const helpers = { pageHead, image, data, esc, slug };
    const renderer = locale === "en" && page !== "terminology" ? english?.renderers?.[page] : undefined;
    if (locale === "en" && page !== "terminology" && !renderer) throw new Error(`Missing English guide renderer for ${page}.`);
    document.getElementById("content").innerHTML = renderer ? renderer(helpers) : renderers[page]();
    document.title = `${pageMeta[page].label} · YN Translation Workshop`;
  }

  function initToc() {
    const headings = [...document.querySelectorAll(".content h2[id], .content h3[id]")];
    const target = document.getElementById("toc-links");
    target.innerHTML = headings.map((heading) => `<a class="level-${heading.tagName === "H3" ? 3 : 2}" href="#${heading.id}">${heading.textContent}</a>`).join("");
    if (!headings.length) return;
    const links = new Map([...target.querySelectorAll("a")].map((link) => [link.getAttribute("href").slice(1), link]));
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (!visible) return;
      links.forEach((link) => link.classList.remove("active"));
      links.get(visible.target.id)?.classList.add("active");
    }, { rootMargin: "-90px 0px -72% 0px" });
    headings.forEach((heading) => observer.observe(heading));
  }

  function searchIndex() {
    const sectionLabel = (section) => locale === "en"
      ? section === "tutorial" ? "User tutorial" : section === "technical" ? "Technical manual" : "Reading guide"
      : section === "tutorial" ? "普通用户教程" : section === "technical" ? "技术手册" : "阅读入口";
    const pages = Object.values(pageMeta).map((item) => ({ title: item.label, detail: sectionLabel(item.section), href: item.file }));
    const tutorialRows = locale === "en" ? [
      ["Full translation tutorial", "Generate HTML, translate, and refresh candidates", "guides.html#translation"],
      ["Full proofreading tutorial", "Bind translation, inspect, and approve suggestions", "guides.html#proofread"],
      ["Phone and remote operation", "LAN PIN and optional external tunnel", "guides.html#lan"],
      ["Settings guide", "Files, models, concurrency, split size, and proofreading", "features.html"],
      ["Glossary and character bible", "Approved terms, candidates, and character records", "guides.html#assets"],
      ["Reuse old translation", "Audit and retain reliable existing rows", "guides.html#reuse"]
    ] : [
      ["完整翻译教程", "从生成 HTML 到同步候选", "guides.html#translation"],
      ["完整校对教程", "从绑定译文到审批建议", "guides.html#proofread"],
      ["手机与远程操作", "局域网 PIN 与外部隧道", "guides.html#lan"],
      ["设置怎么填", "文件、模型、并发、拆分、校对", "features.html"],
      ["术语表和角色表", "正式术语、候选与角色信息", "guides.html#assets"],
      ["旧译复用", "审计并保留已有译文", "guides.html#reuse"]
    ];
    const tutorial = tutorialRows.map(([title, detail, href]) => ({ title, detail, href }));
    const funcs = [
      ...data.parentFunctions.map((item) => ({ ...item, runtime: "parent" })),
      ...data.childFunctions.map((item) => ({ ...item, runtime: "child" }))
    ].map((item) => ({
      title: item.name,
      detail: `${item.runtime} · ${locale === "en" ? (english?.groups?.[item.group] || item.group) : item.group} · ${locale === "en" ? (english?.functionSummaries?.[item.name] || item.name) : item.summary}`,
      href: `functions.html#${item.runtime}-${slug(item.name)}`
    }));
    const terms = (window.YN_GUIDE_TERMINOLOGY?.entries ?? []).map((item) => ({
      title: item.term,
      detail: `${item[locale].plain} ${item[locale].yn}`,
      href: `terminology.html#term-${slug(item.term)}`
    }));
    return [...pages, ...tutorial, ...terms, ...funcs];
  }

  function initSearch() {
    const dialog = document.getElementById("search-dialog");
    const input = document.getElementById("global-search");
    const results = document.getElementById("search-results");
    const entries = searchIndex();
    const render = () => {
      const query = input.value.trim().toLocaleLowerCase();
      const matches = (query ? entries.filter((entry) => `${entry.title} ${entry.detail}`.toLocaleLowerCase().includes(query)) : entries.slice(0, 14)).slice(0, 30);
      results.innerHTML = matches.length ? matches.map((entry) => `<a class="search-result" href="${entry.href}"><strong>${esc(entry.title)}</strong><span>${esc(entry.detail)}</span></a>`).join("") : `<div class="search-empty">${ui.searchEmpty}</div>`;
    };
    const open = () => { dialog.showModal(); render(); setTimeout(() => input.focus(), 0); };
    document.querySelector(".search-trigger").addEventListener("click", open);
    document.querySelector("[data-close-search]").addEventListener("click", () => dialog.close());
    input.addEventListener("input", render);
    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "k") { event.preventDefault(); open(); }
      if (event.key === "Escape" && dialog.open) dialog.close();
    });
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  }

  function initLightbox() {
    const dialog = document.getElementById("lightbox");
    const img = dialog.querySelector("img");
    document.addEventListener("click", (event) => {
      const button = event.target.closest("[data-lightbox]");
      if (!button) return;
      img.src = button.dataset.lightbox;
      dialog.showModal();
    });
    document.querySelector("[data-close-lightbox]").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  }

  function storedObject(key) {
    const source = localStorage.getItem(key);
    if (!source) return {};
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid guide copy storage at ${key}.`);
    }
    return parsed;
  }

  function localePack(key) {
    const value = storedObject(key);
    const readLocale = (language) => {
      if (!Object.prototype.hasOwnProperty.call(value, language)) return {};
      const candidate = value[language];
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error(`Invalid ${language} guide copy storage at ${key}.`);
      }
      return candidate;
    };
    return { zh: readLocale("zh"), en: readLocale("en") };
  }

  function writeLocalePack(key, value) {
    const normalize = (language) => {
      const candidate = value[language] ?? {};
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error(`Invalid ${language} guide copy payload for ${key}.`);
      }
      return candidate;
    };
    localStorage.setItem(key, JSON.stringify({ zh: normalize("zh"), en: normalize("en") }));
  }

  function ensureCopyEditMigration() {
    const legacy = storedObject(LEGACY_COPY_EDIT_STORAGE_KEY);
    const defaults = localePack(COPY_DEFAULT_STORAGE_KEY);
    if (Object.keys(legacy).length > 0) {
      defaults.zh = { ...defaults.zh, ...legacy };
      writeLocalePack(COPY_DEFAULT_STORAGE_KEY, defaults);
    }
    localStorage.setItem(COPY_EDIT_MIGRATION_KEY, "complete");
  }

  function readCopyDefaults(language = locale) {
    const stored = localePack(COPY_DEFAULT_STORAGE_KEY)[language];
    const builtIn = window.YN_GUIDE_COPY_DEFAULTS?.[language] ?? {};
    if (!builtIn || typeof builtIn !== "object" || Array.isArray(builtIn)) {
      throw new Error(`Invalid built-in ${language} guide copy defaults.`);
    }
    return { ...stored, ...builtIn };
  }

  function readCopyEdits(language = locale) {
    return localePack(COPY_EDIT_STORAGE_KEY)[language];
  }

  function writeCopyEdits(edits, language = locale) {
    const pack = localePack(COPY_EDIT_STORAGE_KEY);
    pack[language] = edits;
    writeLocalePack(COPY_EDIT_STORAGE_KEY, pack);
  }

  function currentPageFile() {
    return decodeURIComponent(location.pathname.split("/").pop() || "index.html");
  }

  function copyExportUrl(file, runId, step) {
    const target = new URL(file, location.href);
    target.search = "";
    target.hash = "";
    target.searchParams.set("copyExport", runId);
    target.searchParams.set("copyExportStep", String(step));
    return target.toString();
  }

  function beginMultiPageCopyExport() {
    const returnUrl = new URL(location.href);
    returnUrl.searchParams.delete("copyExport");
    returnUrl.searchParams.delete("copyExportStep");
    const runId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    window.name = JSON.stringify({
      marker: COPY_EXPORT_MARKER,
      runId,
      startedAt: new Date().toISOString(),
      returnUrl: returnUrl.toString(),
      pages: {}
    });
    location.href = copyExportUrl(COPY_EXPORT_FILES[0], runId, 0);
  }

  function continueMultiPageCopyExport(setStatus) {
    const params = new URLSearchParams(location.search);
    const runId = params.get("copyExport");
    const step = Number(params.get("copyExportStep"));
    if (!runId) return;
    if (!Number.isInteger(step) || step < 0 || step >= COPY_EXPORT_FILES.length) {
      throw new Error("Invalid guide copy export step.");
    }
    const session = JSON.parse(window.name || "null");
    if (!session || session.marker !== COPY_EXPORT_MARKER || session.runId !== runId || typeof session.pages !== "object") {
      throw new Error("Guide copy export session is missing or invalid.");
    }
    if (currentPageFile() !== COPY_EXPORT_FILES[step]) {
      throw new Error(`Guide copy export expected ${COPY_EXPORT_FILES[step]} but opened ${currentPageFile()}.`);
    }

    session.pages[page] = {
      file: currentPageFile(),
      defaults: { zh: readCopyDefaults("zh"), en: readCopyDefaults("en") },
      edits: localePack(COPY_EDIT_STORAGE_KEY),
      legacy: storedObject(LEGACY_COPY_EDIT_STORAGE_KEY)
    };
    window.name = JSON.stringify(session);

    const nextStep = step + 1;
    if (nextStep < COPY_EXPORT_FILES.length) {
      location.href = copyExportUrl(COPY_EXPORT_FILES[nextStep], runId, nextStep);
      return;
    }

    const payload = JSON.stringify({
      version: COPY_EDIT_EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      pages: session.pages
    }, null, 2);
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "yn-guide-copy-edits-all.json";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setStatus(ui.exported);
    window.name = "";
    setTimeout(() => {
      URL.revokeObjectURL(url);
      location.href = session.returnUrl;
    }, 250);
  }

  function sanitizeEditableHtml(html) {
    const template = document.createElement("template");
    template.innerHTML = String(html);
    template.content.querySelectorAll("script,style,iframe,object,embed,link,meta").forEach((node) => node.remove());
    template.content.querySelectorAll("*").forEach((node) => {
      [...node.attributes].forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        const value = attribute.value.trim().toLowerCase();
        if (name.startsWith("on") || ((name === "href" || name === "src") && value.startsWith("javascript:"))) {
          node.removeAttribute(attribute.name);
        }
      });
    });
    return template.innerHTML;
  }

  function editableRoot(element) {
    if (element.closest(".content")) return { name: page, node: document.querySelector(".content") };
    if (element.closest(".sidebar")) return { name: "global-sidebar", node: document.querySelector(".sidebar") };
    return { name: "global-topbar", node: document.querySelector(".topbar") };
  }

  function editablePath(element, root) {
    const parts = [];
    let current = element;
    while (current && current !== root) {
      const parent = current.parentElement;
      if (!parent) break;
      const index = [...parent.children].indexOf(current);
      parts.push(`${current.tagName.toLowerCase()}:${index}`);
      current = parent;
    }
    return parts.reverse().join("/");
  }

  function copyEditableElements() {
    const selectors = [
      ".content h1", ".content h2", ".content h3", ".content h4", ".content p",
      ".content .step-list > li", ".content .plain-check > li", ".content th", ".content td",
      ".content figcaption", ".content pre code", ".content .route-label", ".content .route-action",
      ".content .plain-strip strong", ".content .plain-strip span", ".content .choice-strip > div > span",
      ".content .choice-strip > div > strong", ".content .tutorial-banner strong", ".content .tutorial-banner > span",
      ".content .technical-intro > span", ".content .architecture-flow span", ".content .architecture-flow strong",
      ".content .architecture-node span", ".content .architecture-node strong", ".content .architecture-node small",
      ".content .scope-row > span", ".content .scope-row > strong", ".content .contract-cell > span",
      ".content .function-name", ".content .function-group", ".content .function-summary",
      ".content .function-contract > div > span", ".content .function-foot strong",
      ".content .function-foot > code", ".content .function-foot > span", ".content .chip",
      ".content .workflow-step-index", ".content .technical-steps li > span",
      ".content .breadcrumb > *", ".content .topic-card > .num", ".content .note",
      ".content .code-flow", ".content .formula", ".content .technical-steps li strong",
      ".content .scheduler-source", ".content .scheduler-queue", ".content .scheduler-pools > div",
      ".content .term-card header code", ".content .term-card dt", ".content .term-card dd",
      ".content .term-layer-map strong", ".content .term-layer-map small",
      ".topbar .brand strong", ".topbar .search-trigger > span:nth-child(2)", ".topbar .topmeta > span",
      ".topbar .topmeta > a", ".sidebar .nav-label", ".sidebar .nav-link > span:last-child", ".sidebar-foot"
    ];
    return [...new Set(selectors.flatMap((selector) => [...document.querySelectorAll(selector)]))]
      .filter((element) => !element.closest(".copy-editor-bar") && element.id !== "copy-edit-toggle" && element.id !== "copy-export-all");
  }

  function refreshEditedNavigation() {
    document.querySelectorAll("#toc-links a").forEach((link) => {
      const heading = document.getElementById(link.getAttribute("href")?.slice(1));
      if (heading) link.textContent = heading.textContent.trim();
    });
    const h1 = document.querySelector(".content h1");
    if (h1) document.title = `${h1.textContent.trim()} · YN Translation Workshop`;
  }

  function initCopyEditor() {
    ensureCopyEditMigration();
    const toggle = document.getElementById("copy-edit-toggle");
    const exportAll = document.getElementById("copy-export-all");
    const toolbar = document.getElementById("copy-editor-bar");
    const status = document.getElementById("copy-editor-status");
    const importInput = document.getElementById("copy-import-input");
    const elements = copyEditableElements();
    const edits = { ...readCopyDefaults(), ...readCopyEdits() };
    let editing = false;
    let statusTimer;

    elements.forEach((element) => {
      const root = editableRoot(element);
      const key = `${root.name}:${editablePath(element, root.node)}`;
      element.dataset.copyEditKey = key;
      if (Object.prototype.hasOwnProperty.call(edits, key)) {
        element.innerHTML = sanitizeEditableHtml(edits[key]);
      }
    });

    if (!toggle || !exportAll || !toolbar || !status || !importInput) {
      refreshEditedNavigation();
      return;
    }

    const setStatus = (message) => {
      status.textContent = message;
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => { status.textContent = `${ui.editorStatus} · ${locale === "en" ? "English" : "中文"}`; }, 1400);
    };

    const setEditing = (enabled) => {
      editing = enabled;
      document.body.classList.toggle("copy-editing", enabled);
      toolbar.hidden = !enabled;
      toggle.textContent = enabled ? ui.editing : ui.edit;
      toggle.setAttribute("aria-pressed", String(enabled));
      elements.forEach((element) => {
        if (enabled) {
          element.setAttribute("contenteditable", "true");
          element.setAttribute("spellcheck", "false");
        } else {
          element.removeAttribute("contenteditable");
          element.removeAttribute("spellcheck");
        }
      });
      if (!enabled) refreshEditedNavigation();
    };

    toggle.addEventListener("click", () => setEditing(!editing));
    exportAll.addEventListener("click", beginMultiPageCopyExport);
    toolbar.querySelector('[data-copy-action="done"]').addEventListener("click", () => setEditing(false));

    elements.forEach((element) => {
      element.addEventListener("input", () => {
        const current = readCopyEdits();
        current[element.dataset.copyEditKey] = sanitizeEditableHtml(element.innerHTML);
        writeCopyEdits(current);
        setStatus(ui.saved);
        refreshEditedNavigation();
      });
      element.addEventListener("blur", () => {
        if (!editing) return;
        const safe = sanitizeEditableHtml(element.innerHTML);
        if (safe !== element.innerHTML) element.innerHTML = safe;
      });
    });

    document.addEventListener("click", (event) => {
      if (!editing) return;
      const link = event.target.closest("a");
      if (link?.querySelector("[data-copy-edit-key]") || link?.matches("[data-copy-edit-key]")) {
        event.preventDefault();
      }
    }, true);

    toolbar.querySelector('[data-copy-action="export"]').addEventListener("click", beginMultiPageCopyExport);

    toolbar.querySelector('[data-copy-action="import"]').addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        const legacyImport = payload?.version === 1 && payload.edits && typeof payload.edits === "object" && !Array.isArray(payload.edits);
        const currentImport = payload?.version === 2
          && payload.defaults && typeof payload.defaults === "object" && !Array.isArray(payload.defaults)
          && payload.edits && typeof payload.edits === "object" && !Array.isArray(payload.edits);
        const collectedImport = payload?.version === COPY_EDIT_EXPORT_VERSION
          && payload.pages && typeof payload.pages === "object" && !Array.isArray(payload.pages)
          && payload.pages[page]?.defaults && payload.pages[page]?.edits;
        if (!legacyImport && !currentImport && !collectedImport) {
          throw new Error(ui.formatError);
        }
        if (!confirm(ui.importConfirm)) return;
        if (legacyImport) {
          writeLocalePack(COPY_DEFAULT_STORAGE_KEY, { zh: payload.edits, en: {} });
          writeLocalePack(COPY_EDIT_STORAGE_KEY, { zh: {}, en: {} });
        } else if (currentImport) {
          writeLocalePack(COPY_DEFAULT_STORAGE_KEY, payload.defaults);
          writeLocalePack(COPY_EDIT_STORAGE_KEY, payload.edits);
        } else {
          writeLocalePack(COPY_DEFAULT_STORAGE_KEY, payload.pages[page].defaults);
          writeLocalePack(COPY_EDIT_STORAGE_KEY, payload.pages[page].edits);
        }
        localStorage.setItem(COPY_EDIT_MIGRATION_KEY, "complete");
        location.reload();
      } catch (error) {
        setStatus(error instanceof Error ? error.message : ui.formatError);
      } finally {
        importInput.value = "";
      }
    });

    toolbar.querySelector('[data-copy-action="reset"]').addEventListener("click", () => {
      if (!confirm(ui.resetConfirm)) return;
      const current = readCopyEdits();
      const prefixes = [`${page}:`, "global-sidebar:", "global-topbar:"];
      Object.keys(current).forEach((key) => {
        if (prefixes.some((prefix) => key.startsWith(prefix))) delete current[key];
      });
      writeCopyEdits(current);
      location.reload();
    });

    refreshEditedNavigation();
    continueMultiPageCopyExport(setStatus);
  }

  function initFunctionFilter() {
    const input = document.getElementById("function-search");
    const runtime = document.getElementById("runtime-filter");
    const group = document.getElementById("group-filter");
    const count = document.getElementById("function-count");
    if (!input || !runtime || !group) return;
    const items = [...document.querySelectorAll("[data-function]")];
    const apply = () => {
      const query = input.value.trim().toLocaleLowerCase();
      let visible = 0;
      items.forEach((item) => {
        item.hidden = Boolean((query && !item.dataset.search.includes(query)) || (runtime.value && item.dataset.runtime !== runtime.value) || (group.value && item.dataset.group !== group.value));
        if (!item.hidden) visible += 1;
      });
      count.textContent = locale === "en"
        ? `${visible} / ${items.length} ${ui.functionCount}`
        : `显示 ${visible} / ${items.length} ${ui.functionCount}`;
    };
    [input, runtime, group].forEach((control) => control.addEventListener(control.tagName === "INPUT" ? "input" : "change", apply));
    const query = new URLSearchParams(location.search).get("q");
    if (query) input.value = query;
    apply();
  }

  function initTerminologyFilter() {
    const input = document.getElementById("term-search");
    const category = document.getElementById("term-category");
    const count = document.getElementById("term-count");
    if (!input || !category || !count) return;
    const items = [...document.querySelectorAll("[data-term]")];
    const sections = [...document.querySelectorAll("[data-term-section]")];
    const apply = () => {
      const query = input.value.trim().toLocaleLowerCase();
      let visible = 0;
      items.forEach((item) => {
        item.hidden = Boolean((query && !item.dataset.search.includes(query)) || (category.value && item.dataset.category !== category.value));
        if (!item.hidden) visible += 1;
      });
      sections.forEach((section) => {
        section.hidden = !section.querySelector("[data-term]:not([hidden])");
      });
      count.textContent = `${visible} / ${items.length} ${locale === "en" ? "terms" : "个术语"}`;
    };
    input.addEventListener("input", apply);
    category.addEventListener("change", apply);
    apply();
  }

  function initLanguageSwitch() {
    document.querySelectorAll("[data-language]").forEach((button) => {
      button.addEventListener("click", () => {
        const language = button.dataset.language;
        if ((language !== "zh" && language !== "en") || language === locale) return;
        localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
        const target = new URL(location.href);
        target.searchParams.set("lang", language);
        location.href = target.toString();
      });
    });
  }

  function initNavigation() {
    document.querySelector(".menu-button").addEventListener("click", () => document.body.classList.toggle("nav-open"));
    document.addEventListener("click", (event) => {
      if (innerWidth > 900 || !document.body.classList.contains("nav-open")) return;
      if (!event.target.closest(".sidebar") && !event.target.closest(".menu-button")) document.body.classList.remove("nav-open");
    });
  }

  shell();
  renderPage();
  initCopyEditor();
  initToc();
  initSearch();
  initLightbox();
  initFunctionFilter();
  initTerminologyFilter();
  initLanguageSwitch();
  initNavigation();
})();
