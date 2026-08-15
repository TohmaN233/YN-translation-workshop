import { ipcMain } from "electron";

import type {
  PiSessionCompactRequest,
  PiSessionInputRequest,
  PiSessionPromptRequest
} from "../../shared/agent/piSessionContract.ts";
import { broadcastPiSession } from "../agent/piNative/broadcast.ts";
import { PiNativeSessionService, piNativeSessionService } from "../agent/piNative/sessionService.ts";
import { ynInterfaceContextStore } from "../agent/piNative/interfaceContextStore.ts";
import { parsePiSessionInputRequest, parsePiSessionPromptRequest } from "./agentSessionRequest.ts";

function requiredText(value: unknown, name: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${name} is required.`);
  return text;
}

const subscribedServices = new WeakSet<PiNativeSessionService>();
const observedInterfaceSenders = new WeakSet<Electron.WebContents>();

export function registerAgentSessionIpc(options: {
  service?: PiNativeSessionService;
  broadcast?: (channel: string, payload: unknown) => void;
  resolveInterfaceWorkspace?: (sender: Electron.WebContents) => string | undefined;
} = {}): void {
  const service = options.service ?? piNativeSessionService;
  const broadcast = options.broadcast ?? broadcastPiSession;
  if (!subscribedServices.has(service)) {
    service.subscribeEvents((envelope) => {
      broadcast("agent-session:event", envelope);
    });
    service.subscribeState((workspaceDir, state, selectionChange) => {
      broadcast("agent-session:update", { workspaceDir, state, selectionChange });
    });
    subscribedServices.add(service);
  }

  ipcMain.handle("agent-session:bootstrap", async (_event, args: { outputDir?: string }) => {
    return service.bootstrap(requiredText(args?.outputDir, "outputDir"));
  });

  ipcMain.handle("agent-session:create", async (_event, args: { outputDir?: string }) => {
    return service.createSession(requiredText(args?.outputDir, "outputDir"));
  });

  ipcMain.handle("agent-session:select", async (_event, args: { outputDir?: string; sessionId?: string }) => {
    const outputDir = requiredText(args?.outputDir, "outputDir");
    const sessionId = requiredText(args?.sessionId, "sessionId");
    await service.selectSession(outputDir, sessionId);
    return { ok: true };
  });

  ipcMain.handle("agent-session:delete", async (_event, args: { outputDir?: string; sessionId?: string }) => {
    return {
      removed: await service.deleteSession(
        requiredText(args?.outputDir, "outputDir"),
        requiredText(args?.sessionId, "sessionId")
      )
    };
  });

  ipcMain.handle("agent-session:messages", async (_event, args: { outputDir?: string; sessionId?: string }) => {
    return service.loadMessages(
      requiredText(args?.outputDir, "outputDir"),
      requiredText(args?.sessionId, "sessionId")
    );
  });

  ipcMain.handle("agent-session:childMessages", async (_event, args: {
    outputDir?: string;
    parentSessionId?: string;
    childSessionId?: string;
  }) => {
    return service.loadSubagentMessages(
      requiredText(args?.outputDir, "outputDir"),
      requiredText(args?.parentSessionId, "parentSessionId"),
      requiredText(args?.childSessionId, "childSessionId")
    );
  });

  ipcMain.handle("agent-session:events", async (_event, args: {
    outputDir?: string;
    sessionId?: string;
    afterSequence?: number;
  }) => {
    return service.listRecentEvents(
      requiredText(args?.outputDir, "outputDir"),
      requiredText(args?.sessionId, "sessionId"),
      Number.isFinite(args?.afterSequence) ? Number(args.afterSequence) : 0
    );
  });

  ipcMain.handle("agent-session:runState", async (_event, args: { outputDir?: string; sessionId?: string }) => {
    return service.getRunState(
      requiredText(args?.outputDir, "outputDir"),
      requiredText(args?.sessionId, "sessionId")
    );
  });

  ipcMain.handle("agent-session:send", async (_event, raw: Partial<PiSessionPromptRequest>) => {
    return service.prompt(parsePiSessionPromptRequest(raw));
  });

  ipcMain.handle("agent-session:compact", async (_event, raw: Partial<PiSessionCompactRequest>) => {
    return service.compact({
      outputDir: requiredText(raw?.outputDir, "outputDir"),
      sessionId: requiredText(raw?.sessionId, "sessionId"),
      providerId: requiredText(raw?.providerId, "providerId"),
      modelId: requiredText(raw?.modelId, "modelId"),
      thinkingLevel: raw?.thinkingLevel,
      customInstructions: typeof raw?.customInstructions === "string" ? raw.customInstructions : undefined
    });
  });

  ipcMain.handle("agent-session:abort", async (_event, args: { outputDir?: string; sessionId?: string }) => {
    await service.abort(
      requiredText(args?.outputDir, "outputDir"),
      requiredText(args?.sessionId, "sessionId")
    );
    return { ok: true };
  });

  ipcMain.handle("agent-session:input", async (_event, raw: Partial<PiSessionInputRequest>) => {
    const args = parsePiSessionInputRequest(raw);
    await service.sendInput(
      args.outputDir,
      args.sessionId,
      args.kind,
      args.text,
      args.images
    );
    return { ok: true };
  });

  ipcMain.handle("agent-interface:publish", async (event, context: unknown) => {
    const senderId = event.sender.id;
    const trustedOutputDir = options.resolveInterfaceWorkspace?.(event.sender);
    if (!trustedOutputDir) {
      return { ok: false, message: "The current Electron page is not bound to a YN project workspace." };
    }
    try {
      ynInterfaceContextStore.publish(senderId, context, Date.now(), trustedOutputDir);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error)
      };
    }
    if (!observedInterfaceSenders.has(event.sender)) {
      observedInterfaceSenders.add(event.sender);
      event.sender.once("destroyed", () => ynInterfaceContextStore.removeSource(senderId));
    }
    return { ok: true };
  });
}
