import type { AgentMessage } from "@earendil-works/pi-agent-core";

import type {
  PiSessionBootstrap,
  PiSessionCompactRequest,
  PiSessionCompactionResult,
  PiSessionEventEnvelope,
  PiSessionPromptAcceptance,
  PiSessionPromptRequest,
  PiSessionRunState,
  PiSessionSummary
} from "../shared/agent/piSessionContract.ts";
import type { SaveProviderConfigArgs } from "./ipc/agentProviderHandlers.ts";
import { lanSyncJson } from "./lanSyncHttp.ts";

const LAN_AGENT_METHODS = new Set([
  "loadBootstrap", "loadMessages", "loadSubagentMessages", "loadRunState", "loadRecentEvents",
  "createSession", "selectSession", "deleteSession", "sendPrompt", "compact", "abort", "sendInput",
  "getProviderConfig", "listConfiguredModels", "saveProviderConfig"
]);

export interface LanAgentRequest {
  method: string;
  args: Record<string, unknown>;
}

export function normalizeLanAgentRequest(value: unknown): LanAgentRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as { method?: unknown; args?: unknown };
  if (typeof source.method !== "string" || !LAN_AGENT_METHODS.has(source.method)) return undefined;
  return {
    method: source.method,
    args: source.args && typeof source.args === "object" && !Array.isArray(source.args)
      ? source.args as Record<string, unknown>
      : {}
  };
}

interface LanAgentSessionService {
  bootstrap(workspaceDir: string): Promise<PiSessionBootstrap>;
  loadMessages(workspaceDir: string, sessionId: string): Promise<AgentMessage[]>;
  loadSubagentMessages(workspaceDir: string, parentSessionId: string, childSessionId: string): Promise<AgentMessage[]>;
  getRunState(workspaceDir: string, sessionId: string): Promise<PiSessionRunState>;
  listRecentEvents(workspaceDir: string, sessionId: string, afterSequence?: number): PiSessionEventEnvelope[];
  createSession(workspaceDir: string): Promise<PiSessionSummary>;
  selectSession(workspaceDir: string, sessionId: string): Promise<void>;
  deleteSession(workspaceDir: string, sessionId: string): Promise<boolean>;
  prompt(request: PiSessionPromptRequest): Promise<PiSessionPromptAcceptance>;
  compact(request: PiSessionCompactRequest): Promise<PiSessionCompactionResult>;
  abort(workspaceDir: string, sessionId: string): Promise<void>;
  sendInput(workspaceDir: string, sessionId: string, kind: "steer" | "followUp", text: string): Promise<void>;
}

interface LanAgentProviderService {
  getConfig(outputDir: string): Promise<unknown>;
  listConfiguredModels(outputDir: string): Promise<unknown>;
  saveConfig(args: SaveProviderConfigArgs): Promise<unknown>;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value;
}

export function createLanAgentGateway(deps: {
  sessionService: LanAgentSessionService;
  providerService: LanAgentProviderService;
}) {
  return {
    async invoke(outputDir: string | undefined, request: LanAgentRequest): Promise<unknown> {
      if (!outputDir) throw new Error("The shared workspace has no project directory.");
      const args = request.args;
      const sessionId = () => requiredString(args, "sessionId");
      switch (request.method) {
        case "loadBootstrap": return deps.sessionService.bootstrap(outputDir);
        case "loadMessages": return deps.sessionService.loadMessages(outputDir, sessionId());
        case "loadSubagentMessages": return deps.sessionService.loadSubagentMessages(
          outputDir,
          requiredString(args, "parentSessionId"),
          requiredString(args, "childSessionId")
        );
        case "loadRunState": return deps.sessionService.getRunState(outputDir, sessionId());
        case "loadRecentEvents": return deps.sessionService.listRecentEvents(outputDir, sessionId(), Number(args.afterSequence || 0));
        case "createSession": return deps.sessionService.createSession(outputDir);
        case "selectSession": await deps.sessionService.selectSession(outputDir, sessionId()); return { ok: true };
        case "deleteSession": return { removed: await deps.sessionService.deleteSession(outputDir, sessionId()) };
        case "sendPrompt": return deps.sessionService.prompt({ ...args, outputDir } as unknown as PiSessionPromptRequest);
        case "compact": return deps.sessionService.compact({ ...args, outputDir } as unknown as PiSessionCompactRequest);
        case "abort": await deps.sessionService.abort(outputDir, sessionId()); return { ok: true };
        case "sendInput": {
          const kind = args.kind;
          if (kind !== "steer" && kind !== "followUp") throw new Error("kind must be steer or followUp.");
          await deps.sessionService.sendInput(outputDir, sessionId(), kind, requiredString(args, "text"));
          return { ok: true };
        }
        case "getProviderConfig": return deps.providerService.getConfig(outputDir);
        case "listConfiguredModels": return deps.providerService.listConfiguredModels(outputDir);
        case "saveProviderConfig": return deps.providerService.saveConfig({
          ...(args as unknown as SaveProviderConfigArgs),
          outputDir
        });
        default: throw new Error(`Unsupported LAN Agent method: ${request.method}`);
      }
    }
  };
}

export function lanAgentBridgeScript(token: string, route: { outputDir: string; locale?: "zh-CN" | "en-US" }): string {
  return `(() => {
  const token = ${lanSyncJson(token)};
  const route = ${lanSyncJson(route)};
  const authStorageKey = "translation-workshop:lan-auth:" + token;
  const listeners = { event: new Set(), state: new Set(), provider: new Set() };
  let inputConvergence = null;
  const authToken = () => sessionStorage.getItem(authStorageKey) || "";
  const endpoint = (path) => path + (path.includes("?") ? "&" : "?") + "auth=" + encodeURIComponent(authToken());
  const pause = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
  async function call(method, args = {}) {
    const response = await fetch(endpoint("/api/agent/" + encodeURIComponent(token)), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, args, authToken: authToken() })
    });
    if (!response.ok) throw new Error(await response.text() || ("HTTP " + response.status));
    return response.json();
  }
  const subscribe = (kind, listener) => { listeners[kind].add(listener); return () => listeners[kind].delete(listener); };
  const publishState = (state, selectionChange = false) => {
    listeners.state.forEach((listener) => listener({ workspaceDir: route.outputDir, state, selectionChange }));
  };
  async function convergeAcceptedInput(task) {
    let lastSequence = -1;
    let failures = 0;
    while (inputConvergence === task) {
      try {
        const state = await call("loadRunState", { sessionId: task.sessionId });
        if (inputConvergence !== task) return;
        failures = 0;
        const sequence = Number(state?.sequence || 0);
        if (!state?.running && !state?.compacting) {
          inputConvergence = null;
          console.info("[lan-agent] remote input reached durable terminal state", {
            sessionId: task.sessionId,
            sequence
          });
          publishState(state, true);
          return;
        }
        if (sequence !== lastSequence) publishState(state);
        lastSequence = sequence;
      } catch (error) {
        failures += 1;
        if (failures === 1 || failures % 5 === 0) {
          console.warn("[lan-agent] remote input convergence poll failed", {
            sessionId: task.sessionId,
            failures,
            error: error?.message || String(error)
          });
        }
      }
      await pause(failures > 0 ? Math.min(5000, 500 * (2 ** Math.min(failures, 3))) : 750);
    }
  }
  function startInputConvergence(sessionId) {
    const normalized = String(sessionId || "").trim();
    if (!normalized) return;
    const task = { sessionId: normalized };
    inputConvergence = task;
    void convergeAcceptedInput(task);
  }
  async function sendPrompt(args) {
    const accepted = await call("sendPrompt", args);
    startInputConvergence(accepted?.sessionId || args?.sessionId);
    return accepted;
  }
  async function sendInput(args) {
    const accepted = await call("sendInput", args);
    startInputConvergence(args?.sessionId);
    return accepted;
  }
  const agentSession = {
    loadBootstrap: (args) => call("loadBootstrap", args),
    loadMessages: (args) => call("loadMessages", args),
    loadSubagentMessages: (args) => call("loadSubagentMessages", args),
    loadRunState: (args) => call("loadRunState", args),
    loadRecentEvents: (args) => call("loadRecentEvents", args),
    createSession: (args) => call("createSession", args),
    selectSession: (args) => call("selectSession", args),
    deleteSession: (args) => call("deleteSession", args),
    sendPrompt,
    compact: (args) => call("compact", args),
    abort: (args) => call("abort", args),
    sendInput,
    onEvent: (listener) => subscribe("event", listener),
    onSessionUpdate: (listener) => subscribe("state", listener)
  };
  window.workshop = {
    agentSession,
    getAgentProviderConfig: (args) => call("getProviderConfig", args),
    listAgentConfiguredModels: (args) => call("listConfiguredModels", args),
    saveAgentProviderConfig: (args) => call("saveProviderConfig", args),
    onAgentProviderUpdate: (listener) => subscribe("provider", listener),
    copyText: async (text) => { await navigator.clipboard.writeText(text); return true; },
    openAgentChatWindow: async () => ({ ok: true }),
    listAgentProviders: async () => [],
    listAgentModels: async () => [],
    listAgentOAuthProfiles: async () => ({ activeProfileId: "", profiles: [] }),
    setAgentOAuthProfile: async () => { throw new Error("OAuth profile changes are available on the desktop."); },
    connectAgentProviderOAuth: async () => { throw new Error("OAuth login is available on the desktop."); },
    validateAgentProvider: async () => ({ ok: false, detail: "Provider validation is available on the desktop." })
  };
  window.__ynAgentChatPiWebEmbedded = {
    close: () => window.dispatchEvent(new CustomEvent("yn-remote-agent-close"))
  };
  async function resync() {
    const bootstrap = await call("loadBootstrap");
    if (bootstrap.activeSessionId) {
      const state = await call("loadRunState", { sessionId: bootstrap.activeSessionId });
      listeners.state.forEach((listener) => listener({ workspaceDir: route.outputDir, state, selectionChange: true }));
    }
    const config = await call("getProviderConfig");
    listeners.provider.forEach((listener) => listener({ workspaceDir: route.outputDir, config }));
  }
  function connectEvents() {
    if (window.__ynLanAgentEventSource) return Promise.resolve();
    const events = new EventSource(endpoint("/events/" + encodeURIComponent(token)));
    window.__ynLanAgentEventSource = events;
    let opened = false;
    const ready = new Promise((resolve) => {
      events.addEventListener("open", () => {
        if (opened) void resync().catch((error) => console.error("[lan-agent] resync failed", error));
        opened = true;
        resolve();
      });
    });
    events.addEventListener("agent-event", (event) => {
      const payload = JSON.parse(event.data);
      listeners.event.forEach((listener) => listener({ ...payload, workspaceDir: route.outputDir }));
    });
    events.addEventListener("agent-state", (event) => {
      const payload = JSON.parse(event.data);
      listeners.state.forEach((listener) => listener({ ...payload, workspaceDir: route.outputDir }));
    });
    events.addEventListener("agent-provider", (event) => {
      const payload = JSON.parse(event.data);
      listeners.provider.forEach((listener) => listener({ ...payload, workspaceDir: route.outputDir }));
    });
    return ready;
  }
  window.mountRemoteYnAgent = async (target) => {
    if (!window.YnPiWebAgentEmbedded) throw new Error("Pi-web Agent bundle did not load.");
    await connectEvents();
    await window.YnPiWebAgentEmbedded.mount(target, route);
  };
  window.addEventListener("pagehide", () => { inputConvergence = null; }, { once: true });
})();`;
}
