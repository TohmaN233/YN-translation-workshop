/** Embedded Agent OS host for generated review HTML.
 *
 * This file intentionally does not render transcript messages. It only creates
 * the in-HTML dock/popout host and loads the ported React/pi-web surface from
 * `src/renderer/agent/embedded.tsx`.
 */

import { agentChatRouteFromReviewData } from "./agentChatRoute.ts";

export const agentChatFlowVersion = "pi-web-react-embedded-v13";

export function agentChatEmbedCss(): string {
  return `
    body.line-review.agent-chat-docked {
      height: 100vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }
    body.line-review.agent-chat-docked > header,
    body.line-review.agent-chat-docked > .glossary-drawer {
      flex-shrink: 0;
    }
    body.line-review.agent-chat-docked .line-review-shell {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(520px, min(820px, 48vw));
      overflow: hidden;
    }
    body.line-review.agent-chat-docked .line-review-main {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      overflow-anchor: none;
    }
    body.line-review.agent-chat-docked #agentChatDock {
      display: flex;
    }
    body.line-review.agent-chat-popout > .glossary-drawer,
    body.line-review.agent-chat-popout .line-review-main {
      display: none !important;
    }
    body.line-review.agent-chat-popout .line-review-shell {
      grid-template-columns: 1fr;
      min-height: calc(100vh - 84px);
    }
    body.line-review.agent-chat-popout #agentChatDock {
      display: flex;
      border-left: 0;
      min-height: calc(100vh - 84px);
    }
    body.line-review.agent-chat-popout header .toolbar button:not(#agentChatPopoutBack),
    body.line-review.agent-chat-popout header .toolbar input {
      display: none;
    }
    body.proposal-review.agent-chat-docked {
      height: 100vh;
      overflow: hidden;
    }
    body.proposal-review.agent-chat-docked .proposal-review-shell {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(520px, min(820px, 48vw));
      height: 100vh;
      overflow: hidden;
    }
    body.proposal-review.agent-chat-docked .proposal-review-shell > .app {
      min-width: 0;
      min-height: 0;
      height: 100vh;
      overflow: hidden;
      overflow-anchor: none;
    }
    body.proposal-review.agent-chat-docked #agentChatDock {
      display: flex;
    }
    body.proposal-review.agent-chat-popout .proposal-review-shell {
      display: grid;
      grid-template-columns: 1fr;
      height: 100vh;
      overflow: hidden;
    }
    body.proposal-review.agent-chat-popout .proposal-review-shell > .app {
      display: none !important;
    }
    body.proposal-review.agent-chat-popout #agentChatDock {
      display: flex;
      border-left: 0;
      height: 100vh;
    }
    #agentChatDock {
      display: none;
      min-width: 0;
      min-height: 0;
      height: 100%;
      overflow: hidden;
      border-left: 1px solid #d8d8d8;
      background: #fff;
    }
    #agentChatReactRoot {
      flex: 1 1 auto;
      min-width: 0;
      min-height: 0;
      height: 100%;
    }
    .agent-chat-embed-fallback {
      display: grid;
      place-items: center;
      min-height: 320px;
      padding: 24px;
      color: #6b7280;
      font: 13px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: center;
    }
  `;
}

export function agentChatEmbedHtml(t: Record<string, string>): string {
  return `<aside id="agentChatDock" data-agent-chat-flow="${agentChatFlowVersion}" aria-label="${t.openAgentChat ?? "Agent chat"}">
    <div
      id="agentChatReactRoot"
      data-agent-chat-route=""
      aria-label="${t.openAgentChat ?? "Agent chat"}"
    >
      <div class="agent-chat-embed-fallback">${t.agentChatLoading ?? "Loading Agent OS..."}</div>
    </div>
  </aside>`;
}

export function agentChatEmbedScript(): string {
  return `
(function () {
  const flowVersion = "${agentChatFlowVersion}";
  const bridge = () => window.workshopHtml || window.parent?.workshopHtml || window.workshop || window.parent?.workshop;
  const reviewData = (() => {
    try {
      const node = document.getElementById("reviewData") || document.getElementById("proposalData");
      return node ? JSON.parse(node.textContent || "{}") : {};
    } catch {
      return {};
    }
  })();
  function currentHtmlPath() {
    try {
      if (!String(location.protocol || "").startsWith("file")) return "";
      const decoded = decodeURIComponent(String(location.pathname || ""));
      const drivePath = decoded.startsWith("/") && /^[A-Za-z]:/.test(decoded.slice(1))
        ? decoded.slice(1)
        : decoded;
      return drivePath.split("/").join("\\\\");
    } catch {
      return "";
    }
  }
  const route = (${String(agentChatRouteFromReviewData)})(reviewData, currentHtmlPath());
  let mounted = false;
  let mountPromise = null;
  const settingsButton = document.getElementById("agentChatSettingsGlobal");
  function clearAgentHash() {
    if (!String(location.hash || "").includes("agent-chat")) return;
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      location.hash = "";
    }
  }
  function isDocked() {
    return document.body.classList.contains("agent-chat-docked");
  }
  function reviewScrollRoot() {
    return document.querySelector(".line-review-main")
      || document.querySelector(".proposal-review-shell > .app");
  }
  function readReviewScroll() {
    const root = reviewScrollRoot();
    if (root && (document.body.classList.contains("agent-chat-docked") || root.scrollHeight > root.clientHeight + 1)) {
      return root.scrollTop;
    }
    return window.scrollY || document.documentElement.scrollTop || 0;
  }
  function writeReviewScroll(top) {
    const root = reviewScrollRoot();
    if (root && document.body.classList.contains("agent-chat-docked")) {
      root.scrollTop = top;
      return;
    }
    if (root && root.scrollHeight > root.clientHeight + 1) {
      root.scrollTop = top;
      return;
    }
    window.scrollTo(0, top);
  }
  function setDocked(open) {
    const top = readReviewScroll();
    document.body.classList.toggle("agent-chat-docked", Boolean(open));
    writeReviewScroll(top);
    requestAnimationFrame(() => writeReviewScroll(top));
    if (open) void mountAgent().catch((error) => console.error("Agent embed mount failed.", error));
  }
  function closeAgent() {
    clearAgentHash();
    setPopoutMode(false);
    setDocked(false);
  }
  function setPopoutMode(open) {
    document.body.classList.toggle("agent-chat-popout", Boolean(open));
    const back = document.getElementById("agentChatPopoutBack");
    if (back) back.hidden = !open;
    if (open) setDocked(true);
  }
  async function loadEmbeddedEntry() {
    if (window.YnPiWebAgentEmbedded?.mount) return;
    const api = bridge();
    if (!api?.agentChatEmbeddedEntryUrl) throw new Error("Agent embedded entry bridge is unavailable.");
    const result = await api.agentChatEmbeddedEntryUrl();
    if (!result?.ok || !result.url) throw new Error(result?.message || "Agent embedded entry URL is unavailable.");
    if (result.cssUrl && !document.querySelector('link[data-agent-chat-embedded-css="true"]')) {
      void new Promise((resolve) => {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = result.cssUrl;
        link.dataset.agentChatEmbeddedCss = "true";
        link.onload = resolve;
        link.onerror = resolve;
        document.head.appendChild(link);
      });
    }
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.type = "module";
      script.src = result.url;
      script.onload = resolve;
      script.onerror = () => reject(new Error("Failed to load Agent embedded entry."));
      document.head.appendChild(script);
    });
  }
  async function mountAgent() {
    if (mounted) return;
    if (mountPromise) return mountPromise;
    const root = document.getElementById("agentChatReactRoot");
    if (!root) throw new Error("Agent embedded root is unavailable.");
    root.dataset.agentChatRoute = JSON.stringify(route);
    mountPromise = (async () => {
      await loadEmbeddedEntry();
      await window.YnPiWebAgentEmbedded.mount(root, route);
      mounted = true;
    })();
    try {
      await mountPromise;
    } catch (error) {
      root.innerHTML = '<div class="agent-chat-embed-fallback">' + String(error && error.message ? error.message : error) + '</div>';
      throw error;
    } finally {
      if (!mounted) mountPromise = null;
    }
  }
  async function openEmbeddedPopout() {
    const api = bridge();
    if (api?.openAgentChatWindow) {
      const result = await api.openAgentChatWindow(route).catch(() => {
        location.hash = "agent-chat-popout";
        setPopoutMode(true);
        return null;
      });
      if (result?.ok) return;
    } else {
      location.hash = "agent-chat-popout";
      setPopoutMode(true);
    }
  }
  async function openAgentSettings() {
    setDocked(true);
    await mountAgent();
    window.__ynAgentOpenSettingsRequestedAt = Date.now();
    window.dispatchEvent(new CustomEvent("yn-agent-open-settings"));
    return true;
  }
  function workflowMetadata(value) {
    if (!value) return undefined;
    if (typeof value !== "object") throw new Error("Workflow prompt metadata must be an object.");
    const workflowIntent = value.workflowIntent;
    if (workflowIntent !== "translation" && workflowIntent !== "proofread") {
      throw new Error("Workflow prompt metadata requires translation or proofread intent.");
    }
    const languagePair = String(value.languagePair || route.languagePair || "").trim();
    if (!languagePair) throw new Error("Workflow prompt metadata requires languagePair.");
    const style = String(value.style || "").trim();
    const workDescription = String(value.workDescription || "").trim();
    const glossaryPath = String(value.glossaryPath || "").trim();
    const glossaryCandidates = value.glossaryCandidates === undefined ? undefined : value.glossaryCandidates;
    if (glossaryCandidates !== undefined && typeof glossaryCandidates !== "boolean") {
      throw new Error("Workflow prompt metadata glossaryCandidates must be a boolean.");
    }
    const characterBible = value.characterBible === undefined ? undefined : value.characterBible;
    if (characterBible !== undefined && typeof characterBible !== "boolean") {
      throw new Error("Workflow prompt metadata characterBible must be a boolean.");
    }
    const reuseExistingTranslation = value.reuseExistingTranslation === undefined
      ? undefined
      : value.reuseExistingTranslation;
    if (reuseExistingTranslation !== undefined && typeof reuseExistingTranslation !== "boolean") {
      throw new Error("Workflow prompt metadata reuseExistingTranslation must be a boolean.");
    }
    let auditWhitelistLines;
    if (value.auditWhitelistLines !== undefined) {
      if (!Array.isArray(value.auditWhitelistLines)) {
        throw new Error("Workflow prompt metadata auditWhitelistLines must be an array.");
      }
      auditWhitelistLines = [...new Set(value.auditWhitelistLines.map((line, index) => {
        if (typeof line !== "number" || !Number.isInteger(line) || line < 1) {
          throw new Error("Workflow prompt metadata auditWhitelistLines[" + index + "] must be a positive integer.");
        }
        return line;
      }))].sort((left, right) => left - right);
    }
    let customPreserveRules;
    if (value.customPreserveRules !== undefined) {
      if (!Array.isArray(value.customPreserveRules) || value.customPreserveRules.length > 64) {
        throw new Error("Workflow prompt metadata customPreserveRules must be an array of at most 64 rules.");
      }
      customPreserveRules = value.customPreserveRules.map((entry, index) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new Error("Workflow prompt metadata customPreserveRules[" + index + "] must be an object.");
        }
        const extraKeys = Object.keys(entry).filter((key) => !["label", "pattern", "flags"].includes(key));
        if (extraKeys.length > 0) {
          throw new Error("Workflow prompt metadata customPreserveRules[" + index + "] has unsupported properties.");
        }
        const pattern = typeof entry.pattern === "string" ? entry.pattern.trim() : "";
        const label = entry.label === undefined ? "" : String(entry.label).trim();
        if (!pattern || pattern.length > 500 || label.length > 80) {
          throw new Error("Workflow prompt metadata customPreserveRules[" + index + "] is invalid.");
        }
        const requestedFlags = entry.flags === undefined ? "u" : String(entry.flags).trim();
        for (const flag of requestedFlags) {
          if (!"imsu".includes(flag)) {
            throw new Error("Workflow prompt metadata customPreserveRules[" + index + "] has unsupported flags.");
          }
        }
        const flags = [..."imsu"].filter((flag) => requestedFlags.includes(flag)).join("");
        let regex;
        try {
          regex = new RegExp(pattern, flags + "g");
        } catch (error) {
          throw new Error("Workflow prompt metadata customPreserveRules[" + index + "] failed to compile: " + (error?.message || String(error)));
        }
        if (regex.test("")) {
          throw new Error("Workflow prompt metadata customPreserveRules[" + index + "] must not match an empty string.");
        }
        return { ...(label ? { label } : {}), pattern, flags };
      });
    }
    const subagentEnabled = value.subagentEnabled === undefined ? undefined : value.subagentEnabled;
    if (subagentEnabled !== undefined && typeof subagentEnabled !== "boolean") {
      throw new Error("Workflow prompt metadata subagentEnabled must be a boolean.");
    }
    const rawSubagentCount = value.subagentCount;
    const subagentCount = rawSubagentCount === undefined || rawSubagentCount === null || rawSubagentCount === ""
      ? undefined
      : Number(rawSubagentCount);
    if (subagentCount !== undefined && (!Number.isInteger(subagentCount) || subagentCount < 1)) {
      throw new Error("Workflow prompt metadata subagentCount must be a positive integer.");
    }
    const rawReviewSubagentCount = value.reviewSubagentCount;
    const reviewSubagentCount = rawReviewSubagentCount === undefined
      || rawReviewSubagentCount === null
      || rawReviewSubagentCount === ""
      ? undefined
      : Number(rawReviewSubagentCount);
    if (
      reviewSubagentCount !== undefined
      && (!Number.isInteger(reviewSubagentCount) || reviewSubagentCount < 1)
    ) {
      throw new Error("Workflow prompt metadata reviewSubagentCount must be a positive integer.");
    }
    const subagentProviderId = String(value.subagentProviderId || "").trim();
    const subagentModelId = String(value.subagentModelId || "").trim();
    if (Boolean(subagentProviderId) !== Boolean(subagentModelId)) {
      throw new Error("Workflow prompt metadata requires both subagent provider and model.");
    }
    const proofreadMode = value.proofreadMode === undefined ? undefined : value.proofreadMode;
    if (proofreadMode !== undefined && proofreadMode !== "split" && proofreadMode !== "montecarlo") {
      throw new Error("Workflow prompt metadata proofreadMode must be split or montecarlo.");
    }
    const positiveInteger = (raw, name) => {
      if (raw === undefined || raw === null || raw === "") return undefined;
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) throw new Error(name + " must be a positive integer.");
      return parsed;
    };
    const translationSplitSize = positiveInteger(value.translationSplitSize, "translationSplitSize");
    const folderTranslationOrder = String(value.folderTranslationOrder || "").trim();
    let folderSourceDocuments;
    if (value.folderSourceDocuments !== undefined) {
      if (!Array.isArray(value.folderSourceDocuments) || value.folderSourceDocuments.length === 0) {
        throw new Error("Workflow prompt metadata folderSourceDocuments must be a non-empty array.");
      }
      folderSourceDocuments = value.folderSourceDocuments.map((document, index) => {
        if (!document || typeof document !== "object" || Array.isArray(document)) {
          throw new Error("Workflow prompt metadata folderSourceDocuments[" + index + "] must be an object.");
        }
        const id = String(document.id || "").trim();
        const path = String(document.path || "").trim();
        if (!id || !path) {
          throw new Error("Workflow prompt metadata folderSourceDocuments[" + index + "] requires id and path.");
        }
        return { id, path };
      });
    }
    const proofreadSplitSize = positiveInteger(value.proofreadSplitSize, "proofreadSplitSize");
    const proofreadMontecarloSize = positiveInteger(value.proofreadMontecarloSize, "proofreadMontecarloSize");
    const proofreadMontecarloRoundMin = positiveInteger(value.proofreadMontecarloRoundMin, "proofreadMontecarloRoundMin");
    const proofreadMontecarloRoundMax = positiveInteger(value.proofreadMontecarloRoundMax, "proofreadMontecarloRoundMax");
    return {
      workflowIntent,
      languagePair,
      ...(style ? { style } : {}),
      ...(workDescription ? { workDescription } : {}),
      ...(glossaryPath ? { glossaryPath } : {}),
      ...(glossaryCandidates !== undefined ? { glossaryCandidates } : {}),
      ...(characterBible !== undefined ? { characterBible } : {}),
      ...(reuseExistingTranslation !== undefined ? { reuseExistingTranslation } : {}),
      ...(auditWhitelistLines !== undefined ? { auditWhitelistLines } : {}),
      ...(customPreserveRules !== undefined ? { customPreserveRules } : {}),
      ...(subagentEnabled !== undefined ? { subagentEnabled } : {}),
      ...(subagentCount !== undefined ? { subagentCount } : {}),
      ...(reviewSubagentCount !== undefined ? { reviewSubagentCount } : {}),
      ...(subagentProviderId && subagentModelId ? { subagentProviderId, subagentModelId } : {}),
      ...(translationSplitSize ? { translationSplitSize } : {}),
      ...(folderTranslationOrder ? { folderTranslationOrder } : {}),
      ...(folderSourceDocuments ? { folderSourceDocuments } : {}),
      ...(proofreadMode ? { proofreadMode } : {}),
      ...(proofreadSplitSize ? { proofreadSplitSize } : {}),
      ...(proofreadMontecarloSize ? { proofreadMontecarloSize } : {}),
      ...(proofreadMontecarloRoundMin ? { proofreadMontecarloRoundMin } : {}),
      ...(proofreadMontecarloRoundMax ? { proofreadMontecarloRoundMax } : {})
    };
  }
  async function insertIntoAgentInput(text, mode, metadata) {
    const value = String(text || "");
    const normalizedMetadata = workflowMetadata(metadata);
    setDocked(true);
    await mountAgent();
    const reactApi = window.YnPiWebAgentEmbedded;
    if (mode === "replace" && reactApi?.replaceText) reactApi.replaceText(value, normalizedMetadata);
    else if (mode === "if-empty" && reactApi?.insertIfEmpty) reactApi.insertIfEmpty(value, normalizedMetadata);
    else if (reactApi?.insertText) reactApi.insertText(value, normalizedMetadata);
    else if (reactApi?.insertIfEmpty) reactApi.insertIfEmpty(value, normalizedMetadata);
    else throw new Error("Pi-web Agent composer is not ready after mount.");
    return true;
  }
  document.getElementById("openAgentChat")?.addEventListener("click", () => {
    if (isDocked() && !document.body.classList.contains("agent-chat-popout")) closeAgent();
    else setDocked(true);
  });
  settingsButton?.addEventListener("click", async () => {
    await openAgentSettings();
  });
  document.getElementById("agentChatPopout")?.addEventListener("click", () => { void openEmbeddedPopout(); });
  document.getElementById("agentChatPopoutBack")?.addEventListener("click", () => {
    clearAgentHash();
    setPopoutMode(false);
  });
  if (String(location.hash || "").includes("agent-chat")) setPopoutMode(true);
  window.__ynAgentChatPiWebEmbedded = {
    flowVersion,
    route,
    mount: mountAgent,
    open: () => setDocked(true),
    close: closeAgent,
    popout: () => { void openEmbeddedPopout(); },
    openSettings: openAgentSettings,
    insertText: (text, metadata) => insertIntoAgentInput(text, "append", metadata),
    insertIfEmpty: (text, metadata) => insertIntoAgentInput(text, "if-empty", metadata),
    replaceText: (text, metadata) => insertIntoAgentInput(text, "replace", metadata)
  };
})();
`;
}
