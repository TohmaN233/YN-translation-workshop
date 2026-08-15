(() => {
  const data = window.YN_GUIDE;
  const page = document.body.dataset.page || "overview";

  const pageMeta = {
    overview: { file: "index.html", num: "0", label: "整体 Overview", short: "开始" },
    features: { file: "features.html", num: "1", label: "功能与参数", short: "功能与参数" },
    guides: { file: "guides.html", num: "2", label: "具体使用指南", short: "使用指南" },
    workflows: { file: "workflows.html", num: "W", label: "Workflow 图谱", short: "Workflows" },
    functions: { file: "functions.html", num: "F", label: "Function 图鉴", short: "Functions" },
    harness: { file: "harness.html", num: "3", label: "Harness 技术细节", short: "Harness" }
  };

  const esc = (value) => String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

  const slug = (value) => String(value).normalize("NFKC").replace(/[^\p{L}\p{N}_-]+/gu, "-").replace(/^-|-$/g, "").toLowerCase();

  function shell() {
    const nav = Object.entries(pageMeta).map(([key, item]) => `
      <a class="nav-link ${page === key ? "active" : ""}" href="${item.file}">
        <span class="nav-index">${item.num}</span><span>${item.label}</span>
      </a>`).join("");

    document.body.insertAdjacentHTML("afterbegin", `
      <header class="topbar">
        <button class="menu-button" type="button" aria-label="打开导航" title="打开导航">☰</button>
        <a class="brand" href="index.html">
          <img src="assets/app-icon.png" alt="YN Translation Workshop">
          <strong>YN Translation Workshop</strong>
        </a>
        <button class="search-trigger" type="button" aria-label="搜索完整指南">
          <span aria-hidden="true">⌕</span><span>搜索词条、参数或 Function</span><span class="key">Ctrl K</span>
        </button>
        <div class="topmeta"><span>指南 v${data.version}</span><a href="functions.html">${data.metrics.callableSurfaces} 个调用面</a></div>
      </header>
      <aside class="sidebar" aria-label="文档导航">
        <div class="nav-section"><p class="nav-label">完整指南</p>${nav}</div>
        <div class="nav-section">
          <p class="nav-label">快速跳转</p>
          <a class="nav-link" href="workflows.html#translation-workflow"><span class="nav-index">↳</span><span>完整翻译流程</span></a>
          <a class="nav-link" href="workflows.html#proofread-workflow"><span class="nav-index">↳</span><span>完整校对流程</span></a>
          <a class="nav-link" href="features.html#assets"><span class="nav-index">↳</span><span>资产与路径</span></a>
          <a class="nav-link" href="harness.html#token-efficiency"><span class="nav-index">↳</span><span>Token 为什么省</span></a>
        </div>
        <div class="sidebar-foot">内容依据当前 ${data.version} 源码与产品截图整理。<br>最后核对：${data.verified}</div>
      </aside>
      <main class="layout"><article class="content" id="content"></article></main>
      <aside class="toc" aria-label="本页目录"><strong>本页目录</strong><div id="toc-links"></div></aside>
      <dialog class="search-dialog" id="search-dialog">
        <div class="search-head"><input id="global-search" type="search" placeholder="输入 workflow、splitSize、writeTranslationChunk…" autocomplete="off"><button class="icon-button" type="button" data-close-search aria-label="关闭搜索" title="关闭搜索">×</button></div>
        <div class="search-results" id="search-results"></div>
      </dialog>
      <dialog class="lightbox" id="lightbox"><button class="icon-button" type="button" data-close-lightbox aria-label="关闭图片" title="关闭图片">×</button><img alt="放大产品截图"></dialog>
    `);
  }

  const breadcrumb = (label) => `<nav class="breadcrumb"><a href="index.html">完整指南</a><span>/</span><span>${label}</span></nav>`;

  const pageHead = (eyebrow, title, subtitle) => `${breadcrumb(title)}<header class="page-head"><p class="eyebrow">${eyebrow}</p><h1>${title}</h1><p class="page-subtitle">${subtitle}</p></header>`;

  const image = (src, alt, caption) => `<figure><div class="image-frame"><img src="assets/screens/${src}" alt="${esc(alt)}" loading="lazy"><button type="button" data-lightbox="assets/screens/${src}">放大</button></div><figcaption class="image-caption"><span>${caption}</span><span>来自产品实机参考</span></figcaption></figure>`;

  const metricGrid = () => `<div class="metric-grid">
    <div class="metric"><b>${data.metrics.workflowTemplates}</b><span>内置完整 Workflow</span></div>
    <div class="metric"><b>${data.metrics.callableSurfaces}</b><span>可调用函数面：${data.metrics.parentFunctions} parent + ${data.metrics.childFunctions} child</span></div>
    <div class="metric"><b>${data.metrics.coreAssets}</b><span>核心可定制资产类型</span></div>
    <div class="metric"><b>${data.metrics.canonicalWorkflows}</b><span>Canonical full workflow：翻译 + 校对</span></div>
  </div>`;

  function renderOverview() {
    return `${pageHead("0 / Product Overview", "YN Translation Workshop 完整指南", "把翻译工作流变成可检查、可恢复、可协作的工程系统。这里不只说明按钮怎么点，也展开 Host、Pi Agent、Worker、验证器和项目资产如何一起工作。")}
      <div class="workflow-rail" aria-label="产品主流程">
        ${["原文", "Host 规划", "翻译 Worker", "独立审阅", "机械验证", "可审批产物"].map((item, index) => `<div class="workflow-stage"><span><small class="stage-num">0${index + 1}</small>${item}</span></div>`).join("")}
      </div>
      ${metricGrid()}

      <h2 id="what-it-is">它是什么</h2>
      <p class="lead">YN Translation Workshop 是本地优先的翻译与校对工作台。它把 TXT / EPUB、译名表、角色信息、行级编辑、Agent 会话、并行 Worker、审阅建议和最终 TXT 写回放进同一条可追溯链路。用户可以一键跑默认流程，也可以在每个关键节点插手、询问、修改、拒绝或恢复。</p>
      <div class="note"><strong>不是“按一下就相信 AI”</strong>真正的核心是人机协作：源文件只读、候选与真实 TXT 分离、每次写入有行范围、每批工作有验证债务、审阅建议需要人类审批，最终才写回真实文件。</div>
      ${image("workbench.png", "YN Translation Workshop 启动工作台", "项目、输入、Workflow、Prompt 和输出集中在启动工作台。")}

      <h2 id="capability-map">能力地图</h2>
      <div class="three-col">
        <article class="topic-card"><span class="num">01</span><h3>翻译生产</h3><p>Host 按文件顺序与 splitSize 动态派发，翻译 Worker 写 staging，独立审阅 Worker 复核后才提升候选。</p><a href="workflows.html#translation-workflow">查看翻译 Workflow →</a></article>
        <article class="topic-card"><span class="num">02</span><h3>校对与审批</h3><p>机械 H3/H4/H7/H8/H9 扫描先完成，Pi Worker 再判断语义 H/M/L 类问题，最终形成可视化审阅页。</p><a href="guides.html#proofread">查看校对教程 →</a></article>
        <article class="topic-card"><span class="num">03</span><h3>项目资产</h3><p>正式术语、候选术语、角色圣经、文风与翻译记忆都使用 canonical 路径和明确写入责任。</p><a href="features.html#assets">查看资产与路径 →</a></article>
        <article class="topic-card"><span class="num">04</span><h3>Agent OS</h3><p>thinking、tool 与 subagent 是结构化对话块。Prompt、Steer、Follow-up 和图片输入都走同一 Pi runtime。</p><a href="guides.html#agent">查看 Agent 交互 →</a></article>
        <article class="topic-card"><span class="num">05</span><h3>本地与远程</h3><p>桌面端是主入口；LAN 页面可在手机或其他设备同步行审阅并操作 Agent。</p><a href="guides.html#lan">查看远程使用 →</a></article>
        <article class="topic-card"><span class="num">06</span><h3>可观测 Harness</h3><p>Pi JSONL、Host state、hash 证据、staging、恢复暂停与 completion gate 让失败可以定位和继续。</p><a href="harness.html">拆解 Harness →</a></article>
      </div>

      <h2 id="interfaces">你会看到的三个界面</h2>
      <div class="three-col">
        <article><h3>启动工作台</h3><p>选择源文、译文、输出目录与完整 Workflow，生成行对齐 HTML 和 typed Prompt。</p></article>
        <article><h3>行审阅 HTML</h3><p>逐行对照、搜索、术语替换、主题、Agent、LAN 同步、导出/写入 TXT 都在这里完成。</p></article>
        <article><h3>Agent 会话</h3><p>可展开工具调用、thinking 与 child 卡片；运行时仍可 Steer 或排队 Follow-up。</p></article>
      </div>
      ${image("line-review.png", "单文件行审阅界面", "源文与译文保持同一行身份；人工改写与审阅问题有清晰视觉状态。")}

      <h2 id="why-stable">为何能稳定工作</h2>
      <div class="invariant-grid">
        <div class="invariant"><strong>Typed scope</strong><span>用户句子不能偷偷把局部任务扩大成完整 workflow，写权限由 Host contract 决定。</span></div>
        <div class="invariant"><strong>行级所有权</strong><span>每个 assignment 绑定 documentId、fromLine、toLine；并发写不靠“模型自觉”。</span></div>
        <div class="invariant"><strong>Hash 证据</strong><span>源文、候选、资产或范围变化会使旧 prescan / review 证据失效。</span></div>
        <div class="invariant"><strong>原子提交</strong><span>staging、canonical、domain revision 与审阅证据一起跨过提交边界。</span></div>
      </div>

      <h2 id="why-efficient">为何能节约 Token</h2>
      <p>核心不是把 Prompt 写短，而是把不需要模型判断的工作留在 Host：文件清单、行数、placeholder/tag、确定性风险、稳定抽样、术语直接命中、去重、覆盖统计与最终 gate 都由代码计算。模型只看到当前 assignment 必需的原文、短上下文、直接命中的资产和精确失败债务。</p>
      <div class="bar-chart" aria-label="Token 上下文概念对比">
        <div class="bar-row"><span>整份文件 + 全资产反复注入</span><div class="bar-track"><div class="bar" style="width:100%"></div></div><strong>上下文膨胀</strong></div>
        <div class="bar-row"><span>分片 + 直接命中 + Host 证据</span><div class="bar-track"><div class="bar efficient"></div></div><strong>有界</strong></div>
      </div>
      <p class="image-caption">概念图，不代表固定节省比例；实际消耗取决于文本、模型、风险密度和修复轮次。</p>

      <h2 id="start-here">从哪里开始</h2>
      <div class="three-col">
        <article class="topic-card"><span class="num">1</span><h3>先学会跑通</h3><p>用默认参数完成一次：生成 HTML → 发送翻译 Prompt → 同步候选 → 校对 → 审批 → 写入 TXT。</p><a href="guides.html#quickstart">10 分钟快速开始 →</a></article>
        <article class="topic-card"><span class="num">2</span><h3>再调参数</h3><p>理解 splitSize、文件顺序、Worker 上限、复用审计、正则保留与 Monte Carlo。</p><a href="features.html#parameters">参数参考 →</a></article>
        <article class="topic-card"><span class="num">3</span><h3>最后读 Harness</h3><p>理解为什么状态能恢复、审阅能约束写入、以及上下文为什么不会无限增长。</p><a href="harness.html#architecture">技术架构 →</a></article>
      </div>`;
  }

  function renderFeatures() {
    const rows = data.parameters.map((item) => `<tr data-param-row data-area="${esc(item.area)}" data-search="${esc(`${item.key} ${item.area} ${item.effect} ${item.used}`.toLowerCase())}"><td>${esc(item.key)}</td><td>${esc(item.area)}</td><td>${esc(item.def)}</td><td>${esc(item.effect)}</td><td>${esc(item.used)}</td></tr>`).join("");
    const assets = data.assets.map((item) => `<tr><td><strong>${item.name}</strong><br><code>${item.path}</code></td><td>${item.format}</td><td>${item.readers}</td><td>${item.writers}</td><td>${item.rule}</td></tr>`).join("");
    return `${pageHead("1 / Features & Parameters", "基本功能与参数设置", "这一章回答“这个开关到底改变了哪一步”。参数不是装饰文本：它们会进入 typed prompt metadata、Host manifest、调度器、validator 或资产路径。")}
      <h2 id="workbench">启动工作台</h2>
      <p class="lead">最左侧决定项目边界与输入；右侧决定完整 Workflow、输出目录和 Prompt。源文件始终只读，候选译文、HTML 状态和真实 TXT 是不同的安全层。</p>
      ${image("workbench.png", "启动工作台完整界面", "选择文件/文件夹、输入模式、Workflow 和输出，再生成行对齐 HTML 或 typed Prompt。")}

      <h2 id="parameters">完整参数表</h2>
      <div class="filters"><input id="param-search" type="search" placeholder="筛选参数，例如 splitSize"><select id="param-area"><option value="">全部区域</option>${[...new Set(data.parameters.map((item) => item.area))].map((area) => `<option>${area}</option>`).join("")}</select><div class="scope-toggle" aria-label="参数数量"><button class="active" type="button">${data.parameters.length} 项</button></div></div>
      <div class="table-wrap"><table class="param-table"><thead><tr><th>参数</th><th>区域</th><th>默认</th><th>影响</th><th>在哪一步读取</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="note warning"><strong>最容易混淆的两个值</strong><code>pageSize</code> 只改变 HTML 一页显示多少行；<code>splitSize</code> 才决定 Agent assignment 的最大行块。历史 <code>split</code> 不应再被当成独立调度开关。</div>

      <h2 id="folder-order">文件顺序语法</h2>
      <div class="two-col"><div><p><code>folderTranslationOrder</code> 是本轮 authoritative manifest。大括号外按书写顺序形成屏障，大括号内只表示同阶段可并行，不代表为每个文件固定一个 Worker。</p><pre class="band"><code>prologue.txt
{
  common_01.txt
  common_02.txt
}
chapter_01.txt</code></pre></div><div class="note"><strong>Host 如何解释</strong>先完成 <code>prologue.txt</code>；随后两个 common 文件共享并行阶段；二者结算后才开放 chapter。列表中被删除的文件不会被扫描、恢复或占用完成门槛。</div></div>

      <h2 id="assets">资产与 canonical 路径</h2>
      <p>项目资产不是一坨“背景资料”。每种资产都有唯一产品路径、明确的读取时机、写入者和 validator。旧路径只允许一次性迁移。</p>
      <div class="table-wrap"><table><thead><tr><th>资产 / 路径</th><th>格式</th><th>谁读取</th><th>谁写入</th><th>约束</th></tr></thead><tbody>${assets}</tbody></table></div>
      ${image("project-assets.png", "项目资产编辑器", "进入项目后可以直接维护术语、角色和文风；写入仍会经过格式校验。")}

      <h2 id="preserve-rules">自定义正则保留</h2>
      <p>游戏文本里的事件码、变量、标签和控制前缀千差万别。自定义规则会和内置保护规则一起进入复用快筛、翻译写入验证与校对预扫。匹配内容必须原样保留在同一候选行。</p>
      ${image("preserve-rules.png", "正则保留规则编辑器", "每条规则由 label、pattern 和 flags 组成；无效正则会直接报错。")}

      <h2 id="models">Provider、模型与子 Agent</h2>
      <div class="two-col"><div>${image("provider-config.png", "Provider 配置", "支持 OAuth 和兼容 API；代理配置位于启动页。")}</div><div>${image("model-config.png", "模型选择", "parent 与 child 默认同模型；显式覆盖必须同时选择 provider 与 model。")}</div></div>
      <div class="note"><strong>数量是上限，不是填满指标</strong>项目里的 <code>subagentCount</code> / <code>reviewSubagentCount</code> 是 1..N 上限。Host 根据 assignment 数决定实际 Worker。只有用户在当前指令明确写出数量时，才是 exact。</div>

      <h2 id="outputs">输出、HTML 与真实 TXT</h2>
      <ol class="step-list"><li><strong>Agent 候选</strong><br>写入 <code>AI_translation</code> 或 staging，并先过行数、placeholder、tag、保留规则和对齐审阅。</li><li><strong>HTML 状态</strong><br>保存人工编辑、问题标记、审批结果和当前候选绑定。</li><li><strong>真实 TXT</strong><br>只有用户点击写入 TXT / 批量写入 TXT 时才落到真实目标文件。</li></ol>

      <h2 id="theme-lan">主题与 LAN</h2>
      <p>主题色只改变行审阅界面，不进入 Prompt 或校验。LAN PIN 创建本机服务入口；浏览器的低延迟 SSE 不是唯一真相，accepted Prompt/Steer/Follow-up 会继续追踪 durable Pi run state，最终从 canonical JSONL 收敛。</p>
      ${image("lan-settings.png", "LAN 同步设置", "局域网地址、PIN 与 Agent 入口都在生成的 HTML 中配置。")}`;
  }

  function renderGuides() {
    return `${pageHead("2 / How To", "每个功能怎么用", "从第一次生成 HTML，到翻译、校对、术语审批、TXT 写回和手机远程操作。每一步都标出“看到什么才算完成”。")}
      <h2 id="quickstart">10 分钟快速开始</h2>
      <ol class="step-list"><li><strong>选择源语言文件或文件夹</strong><br>TXT 可直接使用；EPUB 会提取成工作 TXT。选择项目输出目录。</li><li><strong>生成行对齐 HTML</strong><br>先打开 HTML，确认源文行数和文件清单正确。</li><li><strong>配置模型</strong><br>OAuth 或兼容 API 均可；能在 Agent 面板正常对话即配置成功。</li><li><strong>生成并发送翻译 Prompt</strong><br>第一次建议保留默认 <code>splitSize=1000</code>，仅按项目规模调整 Worker 上限。</li><li><strong>同步译文</strong><br>Agent 完成并通过 Host validation 后，在 HTML 点击刷新/同步译文。</li><li><strong>校对与审批</strong><br>发送校对 Prompt，生成审阅 HTML，逐条接受、拒绝或人工改写。</li><li><strong>写入真实 TXT</strong><br>确认 HTML 状态后，使用写入 TXT / 批量写入 TXT。</li></ol>
      <div class="note warning"><strong>“完成”不是 Agent 说了算</strong>只有 completion gate 证明所有文档、assignment、审阅证据、术语候选和最终 validator 都结清，完整 workflow 才会完成。</div>

      <h2 id="translation">完整翻译</h2>
      <p class="lead">生成的 Prompt 带精确 marker <code>Workflow: yn-translation-v1</code> 与 typed metadata。Host 先解析 manifest 和资产，再决定是否做旧译复用，最后启动翻译池与独立审阅池。</p>
      <ol class="step-list"><li><strong>先确认资产</strong><br><code>inspectTranslationContext</code> 返回 exists/available；不可用路径不再反复探测。</li><li><strong>决定旧译策略</strong><br>复用关闭：Host 先 SHA-256 备份并清空一次。复用开启：整批快筛 + 高风险语义审计 + 用户一次选择。</li><li><strong>Host 分片</strong><br>按 <code>splitSize</code>、文件顺序和已接受证据生成实际债务队列。</li><li><strong>翻译 Worker</strong><br>读取 assignment 原文、短上下文和直接命中资产，写入 staging 并自检。</li><li><strong>独立审阅 Worker</strong><br>只读检查全部机械风险行和稳定抽样；失败只退回精确行。</li><li><strong>全文验证</strong><br>所有 assignment 结算后只做一次 Host 全文机械验证，再处理术语/角色发现。</li></ol>
      ${image("agent-conversation.png", "Agent 完成一次校对任务", "对话正文只保留用户可理解的进度；工具和 thinking 可按需展开。")}

      <h2 id="reuse">审计并复用已有译文</h2>
      <div class="two-col"><div><h3>机械快筛</h3><p>行数、placeholder、tag、空行、占位文本直接判定重译；源文复制、语言残留、长度异常、重复译文等只成为风险信号。</p><h3>语义二元判断</h3><p>Pi 审计 Worker 只看风险行和邻近上下文，提交 <code>reuse</code> 或 <code>retranslate</code>。信号本身不强迫重译。</p></div><div class="note"><strong>用户只选一次</strong>保留 AI 判定可复用的行，或舍弃全部旧译。应用时事务性备份整批候选，仅清空需要重译的行；保留行不会重新进入翻译队列。</div></div>

      <h2 id="proofread">完整校对</h2>
      <p>校对不直接改译文，默认产出 findings JSON，再转为人类审阅 HTML。先做全量确定性 prescan，再启动语义 Worker。</p>
      <div class="two-col"><div><h3>Split 模式</h3><p>每个 assignment 语义检查自己范围内的每一行；<code>splitSize</code> 是保存/派发间隔，不是“只抽几行”。适合首次全量校对。</p></div><div><h3>Monte Carlo 模式</h3><p>Host 按 HOT/WARM/COLD 规划不重复样本；区域覆盖 80% 后退出。达到最少轮数后连续两轮无新增才算收敛。</p></div></div>
      ${image("proofread-review.png", "校对建议审阅页", "H/M/L 问题按颜色呈现；建议默认可执行，用户仍可拒绝或人工改写。")}

      <h2 id="issue-codes">H / M / L 问题代码</h2>
      <div class="table-wrap"><table><thead><tr><th>等级</th><th>代码</th><th>含义</th><th>判断方式</th></tr></thead><tbody>
        <tr><td rowspan="9"><strong>HIGH</strong></td><td><code>H1</code></td><td>误译：含义错误、反转或实质失真</td><td>语义检查</td></tr>
        <tr><td><code>H2</code></td><td>主语/说话人/对象/指代错误</td><td>语义检查</td></tr>
        <tr><td><code>H3</code></td><td>与确认术语表冲突</td><td>Host 信号 + 语义确认</td></tr>
        <tr><td><code>H4</code></td><td>原语言句子或关键词未翻译</td><td>Host 信号 + 语义确认</td></tr>
        <tr><td><code>H5</code></td><td>遗漏源文信息</td><td>语义检查</td></tr>
        <tr><td><code>H6</code></td><td>加入源文没有的信息</td><td>语义检查</td></tr>
        <tr><td><code>H7</code></td><td>混入分析、助手话术等 AI 污染</td><td>Host 信号 + 语义确认</td></tr>
        <tr><td><code>H8</code></td><td>性别/代词与可靠角色资料冲突</td><td>Host 信号 + 语义确认</td></tr>
        <tr><td><code>H9</code></td><td>异常膨胀，疑似幻觉、串行或填充</td><td>Host 信号 + 语义确认</td></tr>
        <tr><td rowspan="5"><strong>MEDIUM</strong></td><td><code>M1</code></td><td>与邻近上下文不连贯</td><td>语义检查</td></tr>
        <tr><td><code>M2</code></td><td>角色、叙述者或场景语域不符</td><td>语义检查</td></tr>
        <tr><td><code>M3</code></td><td>直译或过度本地化造成文化误解</td><td>语义检查</td></tr>
        <tr><td><code>M4</code></td><td>原文清楚但译文制造不必要歧义</td><td>语义检查</td></tr>
        <tr><td><code>M5</code></td><td>未确认术语在文内漂移</td><td>语义检查</td></tr>
        <tr><td rowspan="4"><strong>LOW</strong></td><td><code>L1</code></td><td>目标语言语法问题</td><td>语义检查</td></tr>
        <tr><td><code>L2</code></td><td>标点、空格、引号或大小写问题</td><td>语义检查</td></tr>
        <tr><td><code>L3</code></td><td>意思正确但措辞生硬、不自然</td><td>语义检查</td></tr>
        <tr><td><code>L4</code></td><td>换行、空行或标签邻接格式错误</td><td>语义检查</td></tr>
      </tbody></table></div>
      <div class="note"><strong>Host 信号不是 finding</strong>H3/H4/H7/H8/H9 与 M0 机械对齐扫描先生成证据，child 仍必须结合原文、译文和上下文确认或驳回。</div>

      <h2 id="human-review">人工审阅与写回</h2>
      <ol class="step-list"><li><strong>读问题说明</strong><br>不要只看建议译文；确认问题类型、原文、当前译文与上下文是否支持结论。</li><li><strong>接受 / 拒绝 / 人工改写</strong><br>可执行语义建议默认 accepted；冲突或只读证据不会自动应用。</li><li><strong>一键应用建议</strong><br>文件夹模式先把 index 内全部 canonical child 同步到当前译文，再提交 sidecar 状态。</li><li><strong>写回 TXT</strong><br>若 index、child、sidecar、基线或行数分叉，批量写回会明确拒绝。</li></ol>

      <h2 id="glossary">术语表与批量替换</h2>
      <p>术语编辑器可以导入、同步、导出、替换当前页或全文，并对标记行做术语审计。正式术语优先，候选用于参考；候选转正时若与正式表冲突会失败而不是覆盖。</p>
      ${image("glossary-editor.png", "术语表侧边编辑器", "左侧原词只读，右侧译名可编辑并执行当前页/全文替换。")}

      <h2 id="agent">Agent 会话、Steer 与 Function</h2>
      <p>运行中可以选择立即 Steer 或排队 Follow-up。前台 tool/child 完成后，同一 Pi harness 会消费队列；最后一次 queue poll 与 <code>agent_end</code> 的竞态通过原生 <code>Agent.continue()</code> 排空。</p>
      <div class="gallery">
        <figure class="image-frame"><img src="assets/screens/slash-commands.png" alt="斜杆命令" loading="lazy"><figcaption>输入 <code>/</code> 浏览可用命令。</figcaption></figure>
        <figure class="image-frame"><img src="assets/screens/tool-call.png" alt="工具调用块" loading="lazy"><figcaption>工具参数与结果是可展开结构化 block。</figcaption></figure>
        <figure class="image-frame"><img src="assets/screens/subagent-card.png" alt="子 Agent 卡片" loading="lazy"><figcaption>parent 只保存轻量 child 状态；展开 Reply 时读取 child JSONL。</figcaption></figure>
        <figure class="image-frame"><img src="assets/screens/token-telemetry.png" alt="Token telemetry" loading="lazy"><figcaption>费用与 Token 是 Pi 估算 telemetry，不等于订阅制实际账单。</figcaption></figure>
      </div>

      <h2 id="lan">局域网与公网穿透</h2>
      <ol class="step-list"><li><strong>输入 6 位 PIN</strong><br>生成局域网 URL，并保持桌面软件运行。</li><li><strong>同网设备打开</strong><br>手机、平板或另一台电脑可同步行编辑与 Agent 面板。</li><li><strong>可选 Cloudflare Tunnel</strong><br>使用 <code>cloudflared --url &lt;局域网地址&gt;</code> 暴露临时公网地址；安全责任由使用者承担。</li></ol>
      ${image("lan-browser.png", "浏览器中的 LAN 同步页", "远端 UI 通过 SSE 快速更新，并独立追踪 durable run state 到终态。")}`;
  }

  const translationStages = [
    { title: "读取项目", body: "Host 解析当前页面的 typed route、源文件或文件夹 manifest、候选路径和项目设置。", reads: ["sourceSelection", "folderSourceDocuments", "project.json"], tools: ["inspectTranslationContext", "selectSourceDocument"], output: "不可变 document manifest + canonical 路径", invariant: "页面绑定优先于 ambient sourcePath；EPUB 使用提取 TXT。" },
    { title: "复用审计", body: "若开启 reuseExistingTranslation，对完整 manifest 做机械快筛，仅把风险行交给语义 Worker。", reads: ["reuseExistingTranslation", "candidate hash", "validation options"], tools: ["prepareTranslationReuseAudit", "runTranslationReuseAudit", "applyTranslationReuseDecision"], output: "保留行基线 + retranslate 债务掩码", invariant: "用户一次整批决定；本轮新产物不能再次被当成旧译。" },
    { title: "Host 分片", body: "按 splitSize 和文件阶段动态创建不重叠 assignment；任务数可大于 Worker 数。", reads: ["splitSize", "folderTranslationOrder", "subagentCount"], tools: ["runTranslationSubagents"], output: "共享 staged assignment queue", invariant: "先原子领取真实 assignment，再创建绑定该任务的 runtime。" },
    { title: "翻译池", body: "持久 Pi Worker 读取分片、短上下文与直接命中资产，写入 staging、校验并上报发现。", reads: ["assigned source", "bounded context", "direct asset matches"], tools: ["readAssignedSource", "readTranslationContext", "writeAssignedTranslation", "validateAssignedTranslation"], output: "hash-current staging + discoveries", invariant: "写权限只覆盖自己的 document/range。" },
    { title: "独立审阅池", body: "只读 Worker 检查所有机械风险行与稳定抽样；通过行不产生逐行理由。", reads: ["risk rows", "sqrt clean sample", "neighbor context"], tools: ["readAssignedTranslationReview", "submitTranslationReview"], output: "精确失败行或 scope accepted", invariant: "同一 hash 再次失败立即暴露无进展，不能盲重试。" },
    { title: "全文验证", body: "assignment 全部结算后，Host 做一次全文 validator、术语债务扫描和 completion gate。", reads: ["canonical candidate", "accepted scopes", "project assets"], tools: ["validateTranslationArtifact", "readTranslationDiscoveries", "resolveTranslationDiscoveries"], output: "已接受候选 + 结清债务", invariant: "模型声称完成不会绕过 Host gate。" },
    { title: "交付", body: "HTML 同步候选并保留人工审批状态；用户明确操作后才写回真实 TXT。", reads: ["candidate", "line-review sidecar", "batch index"], tools: [], output: "可审阅 HTML / TXT", invariant: "候选、HTML 状态和真实 TXT 是三个不同安全层。" }
  ];

  function stageRail() {
    return `<div class="workflow-rail stage-selector">${translationStages.map((stage, index) => `<button type="button" class="workflow-stage ${index === 2 ? "selected" : ""}" data-stage="${index}"><span><small class="stage-num">0${index + 1}</small>${stage.title}</span></button>`).join("")}</div>
      <section class="band" id="stage-detail" aria-live="polite"></section>`;
  }

  function renderWorkflows() {
    const templates = data.workflowTemplates.map((item) => `<tr><td><code>${item.id}</code><br><strong>${item.name}</strong></td><td>${item.kind}</td><td><code>${item.output}</code></td><td>${item.purpose}</td></tr>`).join("");
    const deepDives = data.workflowDeepDives.map((workflow, workflowIndex) => `<article class="workflow-deep" id="workflow-${workflow.id}">
      <header class="workflow-deep-head"><div><p class="eyebrow">Workflow ${String(workflowIndex + 1).padStart(2, "0")}</p><h2>${data.workflowTemplates.find((item) => item.id === workflow.id)?.name ?? workflow.id}</h2><code>${workflow.id}</code></div><span class="runtime-badge">${workflow.runtime}</span></header>
      <div class="note ${workflow.runtime.startsWith("Canonical") ? "" : "warning"}"><strong>源码事实</strong>${workflow.truth}</div>
      <div class="contract-grid">
        <div class="contract-cell"><span>入口</span><p>${workflow.entry}</p></div>
        <div class="contract-cell"><span>参数读取</span><div class="chip-row">${workflow.parameters.map((item) => `<span class="chip">${item}</span>`).join("")}</div></div>
        <div class="contract-cell"><span>资产读取</span><div class="chip-row">${workflow.assets.map((item) => `<span class="chip">${item}</span>`).join("")}</div></div>
      </div>
      <h3 id="${workflow.id}-stages">${data.workflowTemplates.find((item) => item.id === workflow.id)?.name ?? workflow.id}：逐阶段执行</h3>
      <div class="workflow-timeline">${workflow.steps.map((step) => `<section class="workflow-step"><div class="workflow-step-index">${step.phase}</div><div class="workflow-step-main"><div class="workflow-step-title"><div><small>${step.owner}</small><h4>${step.title}</h4></div><a href="functions.html?q=${encodeURIComponent(step.functions.split(/[、；]/u)[0])}" title="在 Function 图鉴中搜索">查看函数</a></div><p>${step.action}</p><dl class="step-contract"><div><dt>读取</dt><dd>${step.reads}</dd></div><div><dt>Function / 执行器</dt><dd>${step.functions}</dd></div><div><dt>产出 / 状态</dt><dd>${step.output}</dd></div><div><dt>硬门槛</dt><dd>${step.gate}</dd></div></dl></div></section>`).join("")}</div>
      <div class="workflow-outcomes"><div><span>完成条件</span><p>${workflow.completion}</p></div><div><span>失败与恢复</span><p>${workflow.failure}</p></div><div><span>Token 策略</span><p>${workflow.token}</p></div></div>
    </article>`).join("");
    return `${pageHead("Workflow Atlas", "所有内置 Workflow 与拼接方式", "产品只提供两个带完整 Host completion gate 的 canonical workflow：翻译与校对。术语、角色口吻和最终 QA 都是这两条流程内部的检查维度，不再维护没有 Host 契约的独立入口。复用审计、局部修复、通用委派等是内部或旁路的有界子流程。")}
      <h2 id="templates">2 个内置 Workflow</h2>
      <div class="table-wrap"><table><thead><tr><th>ID / 名称</th><th>Prompt kind</th><th>产物路径提示</th><th>用途</th></tr></thead><tbody>${templates}</tbody></table></div>
      <div class="note"><strong>入口与 Harness 一一对应</strong>每个可选项都拥有明确的 typed workflowIntent、DomainRun、调度器、产物协议和 completion gate；不存在只生成 Prompt 却没有 Host 约束的伪 Workflow。</div>

      <h2 id="translation-workflow">完整翻译 Workflow</h2>
      <p class="lead">点击阶段查看它读取的参数/资产、主要 Function、输出与不可变约束。</p>
      ${stageRail()}

      <h3 id="translation-assets">参数与资产在哪一步进入</h3>
      <div class="table-wrap"><table><thead><tr><th>输入</th><th>首次读取</th><th>后续复用</th><th>不会发生的事</th></tr></thead><tbody>
        <tr><td><code>languagePair</code> / <code>style</code> / <code>workDescription</code></td><td>生成 typed Prompt 与 parent system prompt</td><td>assignment prompt、validator、hash</td><td>不会让 child 任意改变目标语言或 workflow</td></tr>
        <tr><td><code>splitSize</code> / 文件顺序</td><td>Host manifest 与 queue 规划</td><td>续跑时按同一 scope 恢复</td><td>不会按文件数创建固定 Worker</td></tr>
        <tr><td>正式术语 / 候选 / 角色圣经</td><td><code>inspectTranslationContext</code></td><td>每个 assignment 只注入直接命中记录</td><td>不会每片全文读取所有资产</td></tr>
        <tr><td>自定义保留规则</td><td>Prompt metadata 归一化</td><td>复用快筛、写入校验、最终校验</td><td>不会只靠模型记住格式</td></tr>
        <tr><td>旧候选译文</td><td>复用审计或首次写入前备份/清空</td><td>历史备份可按需只读参考</td><td>关闭复用不等于禁止只读历史</td></tr>
      </tbody></table></div>

      <h2 id="proofread-workflow">完整校对 Workflow</h2>
      <div class="workflow-rail">${["全部文档预扫", "风险热图", "Split / Monte Carlo", "语义 Worker", "Findings 合并", "人类审批"].map((item, index) => `<div class="workflow-stage"><span><small class="stage-num">0${index + 1}</small>${item}</span></div>`).join("")}</div>
      <div class="two-col"><div><h3>确定性层</h3><p>对所有对齐行先完成 H3/H4/H7/H8/H9 扫描，并绑定 source/candidate/glossary/character/style hash。输入变化时旧 prescan 与完成证据一起失效。</p><h3>语义层</h3><p>Worker 必须结合原文、译文和邻近上下文确认或驳回信号，同时检查 H1/H2/H5/H6、M1-M5、L1-L4。机械信号不能直接写成 finding。</p></div><div class="data-flow"><div class="flow-list"><div class="flow-item">proofreadMode / splitSize</div><div class="flow-item">candidateRatio</div><div class="flow-item">Monte Carlo size / rounds</div><div class="flow-item">approved assets + custom rules</div></div><div class="flow-host">Proofread<br>Planner</div></div></div>
      <div class="note"><strong>唯一产物</strong>单文件与文件夹校对都只持久化一份 findings JSON。HTML 是产品对 JSON 的可视化，不再生成 Markdown summary，也不把 report 目录重复拼接。</div>

      <h2 id="bounded-flows">有界子流程</h2>
      <div class="three-col">
        <article class="topic-card"><span class="num">A</span><h3>旧译复用审计</h3><p>机械快筛 → 风险行语义审计 → 用户一次选择 → 生成稀疏重译债务。</p><a href="guides.html#reuse">使用方式 →</a></article>
        <article class="topic-card"><span class="num">B</span><h3>局部翻译修复</h3><p>精确 document/range → parent 直接写或 translation_repair child → 风险/抽样对齐审阅 → 局部验证。</p><a href="functions.html?q=runSubagents">涉及 Functions →</a></article>
        <article class="topic-card"><span class="num">C</span><h3>局部校对修复</h3><p><code>inspectProofreadRange</code> 创建 scope，<code>writeProofreadFindings</code> 原子替换该范围。</p><a href="functions.html?q=inspectProofreadRange">涉及 Functions →</a></article>
        <article class="topic-card"><span class="num">D</span><h3>通用委派</h3><p>parent 先定位具体目标，再把不同目标分别交给 children；不能替换成完整翻译/校对队列。</p><a href="functions.html?q=runSubagents">涉及 Functions →</a></article>
        <article class="topic-card"><span class="num">E</span><h3>术语/角色发现结算</h3><p>child 只上报带证据的发现，parent 分页读取、去重、研究 unknown，再决定写入。</p><a href="functions.html?q=TranslationDiscoveries">涉及 Functions →</a></article>
        <article class="topic-card"><span class="num">F</span><h3>Monte Carlo 上限决策</h3><p>未收敛时必须让用户选择续三轮、只审 HOT 或按当前结果停止。</p><a href="functions.html?q=MontecarloLimit">涉及 Functions →</a></article>
      </div>

      <h2 id="completion">Completion gate 如何拼接</h2>
      <ol class="step-list"><li><strong>文档归属</strong><br>每份完成证据必须匹配 documentId、sourceLineCount 和 hash-current 输入。</li><li><strong>Assignment 结算</strong><br>按已接受 assignment 结果数结算，不按 Worker 数，也不把空闲 Worker 当任务。</li><li><strong>审阅结算</strong><br>每个翻译 chunk 的风险行/样本通过，或精确失败行已修复并复审。</li><li><strong>资产结算</strong><br>pending 术语/角色发现必须被 accept/reject；校对专名候选也必须全部决策。</li><li><strong>最终 validator</strong><br>行数、保护载荷、对齐与 Host-required debt 全部清零。</li></ol>

      <h2 id="all-workflow-details">两条 Workflow 完整拆解</h2>
      <p class="lead">下面逐条列出真实入口、每一步的 owner、参数与资产何时读取、调用链、写出状态、失败门槛、完成条件和 Token 策略。</p>
      <nav class="workflow-jump" aria-label="Workflow 快速跳转">${data.workflowTemplates.map((item, index) => `<a href="#workflow-${item.id}"><span>0${index + 1}</span>${item.name}</a>`).join("")}</nav>
      ${deepDives}`;
  }

  function renderFunctions() {
    const renderItems = (items, runtime) => items.map((item, index) => {
      const detail = data.functionDetails[`${runtime}:${item.name}`];
      const searchable = [item.name, item.group, item.summary, ...item.params, ...Object.values(detail ?? {})].join(" ").toLowerCase();
      return `<details class="function-item" id="${runtime}-${slug(item.name)}" data-function data-runtime="${runtime}" data-group="${esc(item.group)}" data-search="${esc(searchable)}"><summary><span class="function-name">${item.name}</span><span class="function-group">${runtime === "parent" ? "Parent Host" : "Child runtime"} · ${item.group}</span><span class="function-summary">${item.summary}</span><span class="function-caret">›</span></summary><div class="function-body">
        <div class="function-contract"><div><span>运行时边界</span><p>${detail.scope}</p></div><div><span>何时调用</span><p>${detail.call}</p></div><div><span>输入契约</span><p>${detail.input}</p></div><div><span>读取</span><p>${detail.reads}</p></div><div><span>写入 / 状态变化</span><p>${detail.mutates}</p></div><div><span>返回</span><p>${detail.result}</p></div><div class="danger-cell"><span>失败与拒绝</span><p>${detail.failure}</p></div><div><span>正常下一步</span><p>${detail.next}</p></div></div>
        <div class="function-foot"><div><strong>参数索引</strong><div class="chip-row">${item.params.length ? item.params.map((param) => `<span class="chip">${param}</span>`).join("") : '<span class="chip">无模型参数</span>'}</div></div><code>${detail.source}</code><span>本组 ${index + 1} / ${items.length}</span></div>
      </div></details>`;
    }).join("");
    return `${pageHead("Function Reference", "Function 图鉴：49 个唯一名称，52 个运行时调用面", "Parent Host 暴露 35 个函数面，child runtime 暴露 17 个；listProjectDir、searchProjectText、readProjectFile 在两侧各有一套权限收紧后的实现，因此合计 52 个调用面、49 个唯一名称。")}
      ${metricGrid()}
      <h2 id="scope">先理解 Function 可用性</h2>
      <p class="lead">工具不是一个永远开放的“万能箱”。同名工具在 parent、翻译 child、校对 child、审阅 child 或复用审计 child 中会有不同读取策略；写入工具更由 workflow、document、range、hash 和 validator 共同约束。</p>
      <div class="invariant-grid"><div class="invariant"><strong>Parent Host</strong><span>负责清单、调度、completion、资产决策与最终报告。</span></div><div class="invariant"><strong>Translation child</strong><span>只写自己的 assignment staging，可额外读取有界上下文。</span></div><div class="invariant"><strong>Review child</strong><span>严格只读，只提交失败行，不生成通过理由。</span></div><div class="invariant"><strong>Proofread child</strong><span>只写 findings，不修改原文、译文或共享资产。</span></div></div>

      <h2 id="registry">完整 Registry</h2>
      <p>每一项现在都包含八个字段：运行时边界、调用时机、输入契约、读取、状态变化、返回、失败条件和正常下一步。这里记录的是 Agent 真正可调用的 runtime Function，不把内部 helper、IPC API 或 UI 按钮混入 registry。</p>
      <div class="filters"><input id="function-search" type="search" placeholder="搜索函数名、资产、失败条件或返回值"><select id="runtime-filter"><option value="">Parent + Child</option><option value="parent">Parent Host</option><option value="child">Child runtime</option></select><select id="group-filter"><option value="">全部分组</option>${[...new Set([...data.parentFunctions, ...data.childFunctions].map((item) => item.group))].sort().map((group) => `<option>${group}</option>`).join("")}</select></div>
      <p id="function-count" class="image-caption"></p>
      <div class="function-list" id="function-list">${renderItems(data.parentFunctions, "parent")}${renderItems(data.childFunctions, "child")}</div>

      <h2 id="composition">函数如何组合成工作流</h2>
      <div class="table-wrap"><table><thead><tr><th>场景</th><th>Parent 链路</th><th>Child 链路</th></tr></thead><tbody>
        <tr><td>完整翻译</td><td><code>inspectTranslationContext</code> → <code>runTranslationSubagents</code> → <code>validateTranslationArtifact</code></td><td><code>readAssignedSource</code> → <code>writeAssignedTranslation</code> → <code>validateAssignedTranslation</code> → 独立 review</td></tr>
        <tr><td>完整校对</td><td><code>inspectTranslationContext</code> → <code>runProofreadSubagents</code> → candidates 决策 → <code>finalizeProofreadReport</code></td><td><code>readAssignedProofreadContext</code> → 可选 reference → <code>writeAssignedFindings</code></td></tr>
        <tr><td>精确修复</td><td><code>runSubagents</code> 或 <code>writeTranslationChunk</code> → alignment → final validation</td><td><code>readBound*</code> + 受限 repair writer</td></tr>
        <tr><td>旧译复用</td><td>prepare → run audit → apply decision</td><td><code>readAssignedTranslationAudit</code> → <code>submitTranslationAudit</code></td></tr>
      </tbody></table></div>`;
  }

  function renderHarness() {
    return `${pageHead("3 / Harness Internals", "Harness 技术细节", "从 Pi core Agent 到 Host validator：稳定性不是依赖一条超级 Prompt，而是依赖运行时、持久化、typed scope、校验和可恢复提交共同形成的闭环。")}
      <h2 id="architecture">六层架构与所有权</h2>
      <div class="workflow-rail">${["React / HTML UI", "Pi Agent runtime", "YN Host tools", "Domain contracts", "Project artifacts", "Validators"].map((item, index) => `<div class="workflow-stage"><span><small class="stage-num">L${index + 1}</small>${item}</span></div>`).join("")}</div>
      <div class="table-wrap"><table><thead><tr><th>层</th><th>职责</th><th>不拥有的权力</th></tr></thead><tbody>
        <tr><td>UI / route</td><td>收集参数、原子保存设置、生成 marker + typed intent、显示结构化 Pi messages，并提供当前可见页面/焦点行。</td><td>不能创建 Host 债务、写候选或自行宣布完成。</td></tr>
        <tr><td>Pi runtime</td><td>维护 AgentMessage[]、模型 turn、tool result、Steer/Follow-up 队列、retry、continue 与 compaction。</td><td>不能绕过 Function schema、文件所有权或 validator。</td></tr>
        <tr><td>YN Host tools</td><td>把模型意图投影成受限的读、写、调度、审计、资产决策与完成 Function。</td><td>不能按工具名猜授权，也不能把机械风险直接写成语义 finding。</td></tr>
        <tr><td>Domain contract</td><td>记录 workflow kind、owner session、manifest、stage、assignment、workerCount/taskCount、scope、债务和 completion。</td><td>不能被普通自然语言、旧 turn 的 child 数或 renderer 缺失 metadata 改写。</td></tr>
        <tr><td>Durable artifacts</td><td>保存 canonical candidate/report、staging、备份、reuse store、alignment/prescan evidence、Pi JSONL 与项目资产。</td><td>文件存在或非空不等于已被 Host 接受。</td></tr>
        <tr><td>Validators / gates</td><td>验证行身份、保护载荷、范围所有权、hash、资产约束、coverage、review 与 completion debt。</td><td>warning 不能清空 requiredBatchLines；模型 prose 不能覆盖失败。</td></tr>
      </tbody></table></div>

      <h2 id="request-lifecycle">一个请求怎样进入 Harness</h2>
      <ol class="technical-steps">
        <li><span>01</span><div><strong>页面先保存设置</strong><p>生成 Prompt 之前，Electron bridge 将 splitSize、复用、文件顺序、模型与校对参数原子写入 project.json。失败就留在设置面板并停止。</p></div></li>
        <li><span>02</span><div><strong>Renderer 发送 typed request</strong><p>请求包含 route binding、workflowIntent、sourceSelection、项目路径和用户消息。可见 HTML 的绑定优先，不由 ambient sourcePath 覆盖。</p></div></li>
        <li><span>03</span><div><strong>Session runtime 恢复 Pi JSONL</strong><p>使用 active-session 指针选择唯一 session，构造 Session.buildContext()；prompt 本身没有修改 active session 的权力。</p></div></li>
        <li><span>04</span><div><strong>DomainRun 校验授权</strong><p>精确 Workflow marker 可以创建完整 translate/proofread；无 marker 的 typed intent 只能续接同 session 未完成的同类 workflow；冲突立即失败。</p></div></li>
        <li><span>05</span><div><strong>按 operation scope 投影 Functions</strong><p>Parent、translation child、review child、proofread child、reuse audit child 得到不同工具集合。不是先给全工具再靠 Prompt 约束。</p></div></li>
        <li><span>06</span><div><strong>Pi Agent.prompt()</strong><p>模型收到 active messages、system contract 和可用 Function schema，输出普通消息或一个/多个 tool calls。</p></div></li>
        <li><span>07</span><div><strong>Host 执行 Function</strong><p>TypeBox schema 先校验参数，再验证 owner/session/document/range/hash/phase；写入函数在文件锁和 validator 内执行。</p></div></li>
        <li><span>08</span><div><strong>Tool result 回到同一 Pi loop</strong><p>结果作为原生 ToolResult message 写入 JSONL，Agent 根据真实结果决定下一步，不允许错误被包装成“看起来成功”。</p></div></li>
        <li><span>09</span><div><strong>消费 Steer / Follow-up</strong><p>foreground tool 或 child 运行时，queue_update 以原始 AgentMessage[] 贯穿 main、IPC、renderer；工具返回后同一 harness 消费。</p></div></li>
        <li><span>10</span><div><strong>Completion gate 复核</strong><p>模型准备结束时，Host 检查未完成 assignment、review debt、asset decisions、coverage 和 validator；缺项通过原生 follow-up 要求补齐。</p></div></li>
        <li><span>11</span><div><strong>最后竞态排空</strong><p>最后一次 queue poll 到 agent_end 之间如果又收到消息，用 Agent.continue() 继续，不创建 waiting_for_human 或第二条队列。</p></div></li>
        <li><span>12</span><div><strong>Durable end state</strong><p>最终 assistant message、Host custom entries、artifact revision 与 UI 状态都可从 canonical Pi session 重建。</p></div></li>
      </ol>

      <h2 id="pi-loop">Pi Agent loop 与消息模型</h2>
      <p>Parent 与所有 child 都使用同一个 <code>PiSessionAgentRuntime</code> 形态：Pi core <code>Agent</code> + <code>AgentMessage[]</code> + append-only Pi JSONL。没有旧 job/status/transcript 协议混在 IPC 中。</p>
      <div class="code-flow"><code>user AgentMessage</code><b>→</b><code>Agent.prompt()</code><b>→</b><code>assistant toolCall</code><b>→</b><code>Host execute</code><b>→</b><code>toolResult</code><b>→</b><code>Agent.continue()</code><b>→</b><code>assistant / next tool</code></div>
      <div class="contract-grid">
        <div class="contract-cell"><span>Steer</span><p>目标仍处于 foreground turn 时尽快插入；child 只有真正消费并写入自己的 Pi session 后才报告 accepted。</p></div>
        <div class="contract-cell"><span>Follow-up</span><p>排在当前工作之后；UI 立即显示原始排队消息，不能压成一个计数。</p></div>
        <div class="contract-cell"><span>Tool block</span><p>thinking、tool、subagent 是对话流里的结构化 block，参数和结果可展开；顶部只显示轻量状态。</p></div>
        <div class="contract-cell"><span>Agent end</span><p>只有消息队列已排空且 completion gate 没有追加债务 follow-up，当前 run 才真正结束。</p></div>
      </div>

      <h2 id="typed-contract">Typed contract 里到底存什么</h2>
      <div class="table-wrap"><table><thead><tr><th>字段族</th><th>典型字段</th><th>为什么不能只放在 Prompt</th></tr></thead><tbody>
        <tr><td>Workflow identity</td><td>kind、fullWorkflow、ownerSessionId、intent、suspended/recoveryPauseId</td><td>防止另一个会话、普通 follow-up 或旧状态取得 ambient authorization。</td></tr>
        <tr><td>Document manifest</td><td>documentId、sourcePath、candidatePath、sourceLineCount、stage、order</td><td>确保文件夹中每条证据属于正确文件，移除的文件不会继续占完成门槛。</td></tr>
        <tr><td>Assignment</td><td>assignmentId、documentId、fromLine/toLine 或 sparse lines、input hash、attempt、worker</td><td>模型不能把一个分片的结果记到另一文件，也不能因读了上下文扩大写权限。</td></tr>
        <tr><td>Translation evidence</td><td>stagingPath、candidateHash、requiredBatchLines、risk/sample lines、review verdict</td><td>非空候选、普通 validator warning 或旧审阅不能自行结清明确债务。</td></tr>
        <tr><td>Proofread evidence</td><td>prescan hashes、scopeId、coverage、round、HOT/WARM/COLD pools、pending candidates</td><td>输入变化时可精确失效旧证据，Monte Carlo 上限不会伪装成收敛。</td></tr>
        <tr><td>Scheduler state</td><td>workerCount、taskCount、active batch、queue stage、failed worker</td><td>并发数和工作量分离；不会为了填满 N 创建空 Worker 或把 task 数误当 exact child 数。</td></tr>
      </tbody></table></div>

      <h2 id="tool-projection">Function 暴露不是黑名单</h2>
      <p>Harness 先确定 typed operation scope，再构造那一类 runtime 的工具集合。child 工具集禁止再次启动 subagent，写权限也不会因为存在同名 Function 而扩大。</p>
      <div class="scope-matrix"><div class="scope-row head"><span>Runtime</span><span>主要读取</span><span>允许写入</span><span>终止动作</span></div><div class="scope-row"><strong>Parent</strong><span>整个当前项目、外部绝对参考、Host state</span><span>受管 candidate/findings/assets/调度状态</span><span>通过 completion gate 输出最终回复</span></div><div class="scope-row"><strong>Translation child</strong><span>owned source + bounded context + direct matches</span><span>自己的 staging scope 与 discoveries</span><span>validateAssignedTranslation</span></div><div class="scope-row"><strong>Review child</strong><span>风险/样本/短邻域</span><span>只写 failures verdict，不写文件</span><span>submitTranslationReview</span></div><div class="scope-row"><strong>Proofread child</strong><span>owned rows + signals + approved references</span><span>范围 findings + evidence candidates</span><span>writeAssignedFindings</span></div><div class="scope-row"><strong>Reuse child</strong><span>1..80 个选中源译对</span><span>reuse/retranslate verdict</span><span>submitTranslationAudit</span></div></div>
      <p><a href="functions.html">打开 52 个调用面的完整契约 →</a></p>

      <h2 id="stability">稳定性的八个硬约束</h2>
      <div class="two-col"><ol class="step-list"><li><strong>Typed operation scope</strong><br>完整 workflow、局部修复、只读调查分别授权；Function 集合从 scope 构造。</li><li><strong>Authoritative manifest</strong><br>本轮文件顺序原子替换旧 document 集；stage 屏障由 Host 执行。</li><li><strong>Document/range ownership</strong><br>每次写入验证 session、documentId、绝对行、source identity 与 candidate hash。</li><li><strong>Independent review pool</strong><br>翻译 Worker 不能自我证明通过，reviewer 只有只读工具和失败 verdict。</li></ol><ol class="step-list"><li><strong>Hash-current evidence</strong><br>source/candidate/assets/rules 任一变化都会精确失效旧 prescan 或 review。</li><li><strong>Atomic staging commit</strong><br>先 durable staging，再审阅；提升 canonical 与 domain/evidence/JSONL 可回滚。</li><li><strong>Bounded same-session retry</strong><br>失败 assignment 留给原 Worker；重试耗尽持久化 pause，不把文件推到队尾。</li><li><strong>Host completion gate</strong><br>结算真实 taskCount、coverage、资产与 validator，不相信 assistant 的完成文字。</li></ol></div>

      <h2 id="scheduler">持久 Worker 与双池调度</h2>
      <div class="scheduler-diagram"><div class="scheduler-source"><strong>Manifest stages</strong><span>{ A, B } → C → { D, E }</span><small>严格阶段屏障</small></div><b>→</b><div class="scheduler-queue"><strong>Assignment queue</strong><span>taskCount = 实际债务块</span><small>可大于 workerCount</small></div><b>→</b><div class="scheduler-pools"><div><strong>Translation pool</strong><span>写 staging / 精确 repair</span></div><div><strong>Review pool</strong><span>只读风险 + 样本</span></div></div></div>
      <ol class="step-list"><li><strong>数量语义</strong><br>项目设置永远是 1..N 上限；只有本轮用户明确写出的数量才是 exact。assignment 少于上限时不创建空闲 Worker。</li><li><strong>动态领取</strong><br>Worker 完成一个 assignment 后才领取当前开放阶段的下一个；不为每个文件建立私有长队列。</li><li><strong>先领取后建 runtime</strong><br>每次 assignment 都先原子 claim，再用真实 request/provider/model/label 创建或重置 child，避免“种子任务”身份漂移。</li><li><strong>失败不换人</strong><br>文件失败先在原 child Pi session 中有界恢复；耗尽后停止该 Worker，不能把失败项推给另一 Worker制造长尾。</li><li><strong>assignment 间 reset</strong><br>持久 child 使用 resetContext() 丢弃旧 assignment 的 active model context，但完整 JSONL 继续保留审计。</li></ol>

      <h2 id="persistence">持久化与恢复</h2>
      <div class="table-wrap"><table><thead><tr><th>存储</th><th>保存内容</th><th>冷恢复信任条件</th><th>不会被放在哪里</th></tr></thead><tbody>
        <tr><td>Parent Pi JSONL</td><td>parent AgentMessage[]、tool calls/results、compaction、Host custom entries</td><td>sessionId 与项目 ownership 匹配</td><td>不复制完整 child transcript</td></tr>
        <tr><td>Child Pi JSONL</td><td>每个 child 的完整消息、assignment turn、retry 与结果</td><td>parent ownership + child session reference</td><td>折叠卡片后 renderer 不保留 transcript</td></tr>
        <tr><td>Host domain state</td><td>manifest、assignment、scope、debt、coverage、batch、recovery pause</td><td>document/source/candidate identity 仍成立</td><td>不靠 assistant 文本反推</td></tr>
        <tr><td>translation-staging</td><td>刚写出的 hash-current 候选与 pending review/repair</td><td>path、line count、range input hash、current candidate hash 匹配</td><td>Stop/commit failure 不删除</td></tr>
        <tr><td>reuse audit store</td><td>owner、source/candidate hash、masked retained baseline、逐行 verdict</td><td>同一 parent session owner 且全部文档 hash-current</td><td>不把完整逐行 audit 回灌 parent context</td></tr>
        <tr><td>project.json / assets</td><td>canonical splitSize、开关、paths、术语/角色/文风</td><td>设置迁移无冲突且路径可验证</td><td>provider/model/API key 不按项目存储</td></tr>
      </tbody></table></div>
      <p>冷恢复先删除过期 scope，只恢复仍能证明身份的债务。已有 staging 不是“完成”，但也是不可丢的恢复点；已有 canonical 非空文本同样不能替代 accepted evidence。</p>

      <h3 id="atomic-commit">翻译提交为何是事务</h3>
      <div class="code-flow"><code>staging candidate</code><b>+</b><code>canonical candidate</code><b>+</b><code>domain revision</code><b>+</b><code>alignment evidence</code><b>+</b><code>Host JSONL</code></div>
      <p>这些更新构成一个逻辑提交边界。提升前 staging 已落盘；提升过程中任何一步失败，都恢复原 canonical/domain/evidence，保留 staging，并把 assignment 标记为不可盲目重跑的 failure。这样避免出现“文件已变但 Host 仍认为旧 hash 通过”或“Host 说完成但文件没写成功”的分裂状态。</p>

      <h2 id="retry">Provider 与 Tool 失败怎样恢复</h2>
      <div class="failure-ladder"><div><span>1</span><strong>Pi 原生 retry / continue</strong><p>同一 user assignment、同一 child session 恢复，不创建新任务。</p></div><div><span>2</span><strong>Codex WS → SSE fallback</strong><p>WS 异常可临时用 SSE；SSE fetch 失败后清 sticky fallback，再做最后一次 WS。</p></div><div><span>3</span><strong>Durable diagnostics</strong><p>在 provider 把异常压成 fetch failed 前，写定长脱敏 cause chain、provider/model、WS 次数。</p></div><div><span>4</span><strong>Recovery pause</strong><p>有界重试耗尽后停止 Worker、保留 staging/debt；只有新的用户继续可 resume。</p></div></div>
      <p>Function 参数校验、artifact validator、文件锁冲突和模型没有按 contract 调用终止工具，都走显式错误路径。Harness 可以给同一 child 少量 corrective turns 要求提交结构化结果；到上限仍不提交就失败，不用 prose 冒充结果。</p>

      <h2 id="compaction">长会话与 Compaction</h2>
      <ol class="step-list"><li><strong>唯一记忆格式</strong><br>使用 Pi JSONL compaction entry、Pi compact/prepareCompaction 与 Session.buildContext()；没有 YN 自建摘要文件。</li><li><strong>阈值来源</strong><br>由 Pi usage 和固定版本模型目录判断 active context 是否接近阈值；renderer 不自己压缩。</li><li><strong>活动 child 延后</strong><br>活动 child runtime 期间不手动 compact，自动阈值压缩延后但不阻断 parent 交互。</li><li><strong>Reset 后只看 active branch</strong><br>持久 child assignment 间 resetContext() 后，阈值与后续摘要只读取 reset 后仍在 active context 的 session branch。</li><li><strong>审计仍完整</strong><br>旧 assignment 继续留在 child JSONL，只有模型上下文丢弃，不把历史重新注入下一个任务。</li></ol>

      <h2 id="token-efficiency">Token 为何节省</h2>
      <p class="lead">节省不是把 Prompt 写短，而是系统性移除会随项目规模增长的上下文项。可以把一次 child 调用近似看成：</p>
      <div class="formula"><span>Context</span><b>≈</b><code>system contract</code><b>+</b><code>owned rows</code><b>+</b><code>short boundary</code><b>+</b><code>direct asset matches</code><b>+</b><code>current debt</code></div>
      <div class="three-col"><article class="topic-card"><span class="num">Host</span><h3>机械工作不问模型</h3><p>清单、行数、hash、placeholder、tag、控制码、风险信号、抽样与覆盖由代码完成，模型不为确定性问题重复推理。</p></article><article class="topic-card"><span class="num">Index</span><h3>资产直接命中</h3><p>assignment 只注入源文直接命中的完整术语/角色记录；缺失歧义才允许单词精确搜索，不每块重读整库。</p></article><article class="topic-card"><span class="num">Queue</span><h3>持久 Worker + reset</h3><p>Worker 复用 runtime/session 领取下一块，但 reset active context，兼顾启动成本和上下文隔离。</p></article><article class="topic-card"><span class="num">Review</span><h3>通过行保持沉默</h3><p>机械风险全选、正常行 sqrt 抽样；reviewer 只上报失败行，不生成成百上千条 pass 理由。</p></article><article class="topic-card"><span class="num">Sparse</span><h3>只派发真实债务</h3><p>复用保留行、已接受 scope 与当前无风险行不为了连续全文件覆盖重新进入翻译 Worker。</p></article><article class="topic-card"><span class="num">State</span><h3>大状态留在 Host</h3><p>manifest、coverage、audit store、发现分组、完整 child transcript 都不反复注入 parent。</p></article><article class="topic-card"><span class="num">Page</span><h3>分页工具结果</h3><p>discoveries、文件内容、模型目录、搜索结果都带 limit/offset，只把下一步需要的数据送回模型。</p></article><article class="topic-card"><span class="num">Hash</span><h3>复用仍有效的证据</h3><p>hash-current scope 可以冷恢复；只有受影响范围失效，不为一次局部编辑重跑全项目。</p></article><article class="topic-card"><span class="num">JSONL</span><h3>Transcript 按需展开</h3><p>parent 卡片只存 child session 引用和最新状态；完整 reply 只有用户展开时加载，折叠后释放。</p></article></div>
      <div class="bar-chart"><div class="bar-row"><span>传统：全文 + 全资产 + 全历史</span><div class="bar-track"><div class="bar" style="width:100%"></div></div><strong>随规模增长</strong></div><div class="bar-row"><span>YN：assignment + 命中资产 + 精确债务</span><div class="bar-track"><div class="bar efficient"></div></div><strong>有界窗口</strong></div></div>
      <p class="image-caption">这是上下文形态示意。YN 不承诺固定比例；它通过把上下文增长项移出模型来降低浪费。</p>

      <h2 id="review-contract">翻译审阅闭环</h2>
      <ol class="step-list"><li><strong>翻译 Worker 写 staging</strong><br>在进入下一次 provider 调用或审阅交接前，先持久化 staging path 与 pending review。</li><li><strong>Host 选风险 + 稳定样本</strong><br>机械风险全选，普通行按当前 chunk 行数平方根向上取整。</li><li><strong>只读审阅</strong><br>失败只包含绝对行、机器码、短修改说明；同 defect 可扩展到邻近 context 行。</li><li><strong>原 Worker 精确修复</strong><br>同一翻译 Worker 修失败行；候选未变化却再次失败时立即报告无进展。</li><li><strong>提交 canonical</strong><br>staging 提升、domain revision、alignment evidence 与 Host JSONL 构成一个可回滚边界。</li></ol>
      ${image("subagent-card.png", "翻译 Worker 卡片", "卡片只保存最新轻量状态和 child session 引用；完整 transcript 不塞进 parent。")}

      <h2 id="proofread-contract">校对证据链</h2>
      <div class="table-wrap"><table><thead><tr><th>阶段</th><th>Host 保存的证据</th><th>模型负责的判断</th><th>失效条件</th></tr></thead><tbody><tr><td>全清单 prescan</td><td>source/candidate/glossary/character/style hash、H3/H4/H7/H8/H9 signals</td><td>无；此阶段不启动语义 child</td><td>任一输入或规则 hash 变化</td></tr><tr><td>Split assignment</td><td>documentId、owned range、boundary、signals、coverage</td><td>每个 owned row 的 H1/H2/H5/H6、M1-M5、L1-L4 与信号确认/驳回</td><td>source/candidate 或 scope identity 变化</td></tr><tr><td>Monte Carlo</td><td>HOT/WARM/COLD 不重复样本、区域 coverage、round 新增数</td><td>只判断本轮抽中行</td><td>输入变化或用户改变模式</td></tr><tr><td>Report write</td><td>范围 replacement revision、finding ids、candidate decisions</td><td>结构化问题与可执行 suggestedFix</td><td>no-op/越界/schema 或 report binding 失败</td></tr></tbody></table></div>

      <h2 id="completion-math">Completion 不是一句“完成了”</h2>
      <div class="formula"><code>complete</code><b>=</b><code>manifest covered</code><b>∧</b><code>assignments accepted</code><b>∧</b><code>review debt = 0</code><b>∧</b><code>asset debt = 0</code><b>∧</b><code>validator ok</code></div>
      <p>翻译按已接受 assignment 结果数结算，不按 Worker 数；校对按文档/scope coverage 与收敛状态结算。模型若提前输出完成，runtime 不引入新的状态机，而是在同一 Pi conversation 中追加 completion follow-up，把 Host 返回的精确缺口交回模型。</p>

      <h2 id="observability">可观测性</h2>
      <div class="table-wrap"><table><thead><tr><th>观察对象</th><th>证据</th><th>能回答的问题</th></tr></thead><tbody>
        <tr><td>Provider 传输</td><td>durable custom entry：session/provider/model/error/WS 次数/cause chain</td><td>是模型错误、SSE/WS、代理还是 fetch 失败？</td></tr>
        <tr><td>Assignment</td><td>documentId、range、worker、staging、attempt、review debt</td><td>哪个 Worker 在哪一行失败？还能否续跑？</td></tr>
        <tr><td>UI</td><td>结构化 message blocks、queue_update、child cards</td><td>是在思考、跑工具、审阅还是等待用户？</td></tr>
        <tr><td>长会话</td><td>Pi usage、compaction entry、Session.buildContext()</td><td>当前 active context 是否接近阈值？</td></tr>
        <tr><td>远程浏览器</td><td>SSE sequence + durable run-state convergence</td><td>SSE 断线后回复是否仍能收敛？</td></tr>
        <tr><td>Atomic commit</td><td>staging/canonical/domain/evidence revision 与 rollback result</td><td>文件、状态与证据是否在同一提交边界？</td></tr>
        <tr><td>Completion</td><td>每 document 的 sourceLineCount、accepted scopes、pending discoveries/candidates、validator debt</td><td>为什么模型说完成但 Host 仍阻止结束？</td></tr>
      </tbody></table></div>
      <div class="note"><strong>关键源码入口</strong><code>src/main/agent/piNative/sessionAgentRuntime.ts</code> 负责 Pi session loop；<code>ynDomainTools.ts</code> 注册 35 个 Parent Host Function；<code>subagentRunner.ts</code> 构造 17 个 child 调用面；<code>workflowTemplates.ts</code> 只定义两个与 Harness 对齐的 Workflow 入口 metadata。</div>
      <div class="gallery"><figure class="image-frame"><img src="assets/screens/tool-call.png" alt="结构化工具块" loading="lazy"><figcaption>工具调用、参数和结果在对话流中可检查。</figcaption></figure><figure class="image-frame"><img src="assets/screens/agent-panel.png" alt="Agent 面板" loading="lazy"><figcaption>本地与 LAN 面板都从 canonical Pi messages 重建。</figcaption></figure></div>`;
  }

  function renderPage() {
    const renderers = { overview: renderOverview, features: renderFeatures, guides: renderGuides, workflows: renderWorkflows, functions: renderFunctions, harness: renderHarness };
    document.getElementById("content").innerHTML = renderers[page]();
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
    const base = Object.entries(pageMeta).map(([, item]) => ({ title: item.label, detail: "章节", href: item.file }));
    const params = data.parameters.map((item) => ({ title: item.key, detail: `${item.area} · ${item.effect}`, href: "features.html#parameters" }));
    const workflows = data.workflowTemplates.map((item) => ({ title: `${item.name} / ${item.id}`, detail: item.purpose, href: `workflows.html#templates` }));
    const assets = data.assets.map((item) => ({ title: item.name, detail: item.path, href: "features.html#assets" }));
    const funcs = [
      ...data.parentFunctions.map((item) => ({ ...item, runtime: "parent" })),
      ...data.childFunctions.map((item) => ({ ...item, runtime: "child" }))
    ].map((item) => ({ title: item.name, detail: `${item.runtime} · ${item.group} · ${item.summary}`, href: `functions.html#${item.runtime}-${slug(item.name)}` }));
    return [...base, ...params, ...workflows, ...assets, ...funcs];
  }

  function initSearch() {
    const dialog = document.getElementById("search-dialog");
    const input = document.getElementById("global-search");
    const results = document.getElementById("search-results");
    const entries = searchIndex();
    const render = () => {
      const query = input.value.trim().toLocaleLowerCase();
      const matches = (query ? entries.filter((entry) => `${entry.title} ${entry.detail}`.toLocaleLowerCase().includes(query)) : entries.slice(0, 14)).slice(0, 30);
      results.innerHTML = matches.length ? matches.map((entry) => `<a class="search-result" href="${entry.href}"><strong>${esc(entry.title)}</strong><span>${esc(entry.detail)}</span></a>`).join("") : '<div class="search-empty">没有匹配词条。试试 splitSize、复用、staging 或 writeTranslationChunk。</div>';
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

  function initParameterFilter() {
    const input = document.getElementById("param-search");
    const area = document.getElementById("param-area");
    if (!input || !area) return;
    const rows = [...document.querySelectorAll("[data-param-row]")];
    const apply = () => {
      const query = input.value.trim().toLocaleLowerCase();
      rows.forEach((row) => { row.hidden = Boolean((query && !row.dataset.search.includes(query)) || (area.value && row.dataset.area !== area.value)); });
    };
    input.addEventListener("input", apply);
    area.addEventListener("change", apply);
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
      count.textContent = `显示 ${visible} / ${items.length} 个运行时调用面`;
    };
    [input, runtime, group].forEach((control) => control.addEventListener(control.tagName === "INPUT" ? "input" : "change", apply));
    const query = new URLSearchParams(location.search).get("q");
    if (query) input.value = query;
    apply();
  }

  function initStageSelector() {
    const detail = document.getElementById("stage-detail");
    const buttons = [...document.querySelectorAll("[data-stage]")];
    if (!detail || !buttons.length) return;
    const render = (index) => {
      const stage = translationStages[index];
      buttons.forEach((button) => button.classList.toggle("selected", Number(button.dataset.stage) === index));
      detail.innerHTML = `<div class="two-col"><div><p class="eyebrow">当前阶段</p><h3>${stage.title}</h3><p>${stage.body}</p><p><strong>输出：</strong>${stage.output}</p><div class="note"><strong>稳定性约束</strong>${stage.invariant}</div></div><div><h3>本阶段读取</h3><div class="chip-row">${stage.reads.map((item) => `<span class="chip">${item}</span>`).join("")}</div><h3>关键 Function</h3><div class="chip-row">${stage.tools.length ? stage.tools.map((item) => `<a class="chip" href="functions.html?q=${encodeURIComponent(item)}">${item}</a>`).join("") : '<span class="chip">UI / artifact operation</span>'}</div></div></div>`;
    };
    buttons.forEach((button) => button.addEventListener("click", () => render(Number(button.dataset.stage))));
    render(2);
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
  initToc();
  initSearch();
  initLightbox();
  initParameterFilter();
  initFunctionFilter();
  initStageSelector();
  initNavigation();
})();
