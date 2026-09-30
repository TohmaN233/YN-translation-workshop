import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeProviderConfig } from "../../src/main/agent/providerConfigStore.ts";
import { createPiModelSelection } from "../../src/main/agent/piNative/providerRegistry.ts";
import { listThinkingLevelsForModel, resolveThinkingLevelForModel } from "../../src/shared/agent/thinkingLevels.ts";

const projectDir = await mkdtemp(path.join(os.tmpdir(), "tw-grok-effort-"));
try {
  for (const providerId of ["xai-grok", "xai-api"]) {
    await writeProviderConfig(path.join(projectDir, ".translation-workshop"), {
      activeProviderId: providerId,
      providers: {
        [providerId]: {
          id: providerId,
          type: "openai_compatible",
          name: providerId,
          baseUrl: "https://api.x.ai/v1",
          model: "grok-4.7",
          piProviderId: "xai",
          auth: providerId === "xai-grok"
            ? { kind: "oauth", accessToken: "fixture-oauth", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
            : { kind: "api_key", key: "fixture-key" }
        }
      }
    });
    for (const modelId of ["grok-4.7", "grok-4.6", "grok-4.5", "grok-4.3"]) {
      const { models, model } = await createPiModelSelection({ workspaceDir: projectDir, providerId, modelId });
      for (const requested of ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
        const reasoning = resolveThinkingLevelForModel(model, requested);
        let payload;
        const result = await models.streamSimple(model, {
          messages: [{ role: "user", content: [{ type: "text", text: "Hello" }], timestamp: 1 }]
        }, {
          reasoning,
          maxRetries: 0,
          fetch: async (_url, init) => {
            payload = JSON.parse(String(init.body));
            if (payload.reasoning?.effort === "none") {
              return new Response(JSON.stringify({ error: { message: "This model does not support `reasoning_effort` value `none`." } }), {
                status: 400, headers: { "Content-Type": "application/json" }
              });
            }
            const event = { type: "response.completed", response: {
              id: "fixture-response", status: "completed", output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
            } };
            return new Response(`event: response.completed\ndata: ${JSON.stringify(event)}\n\n`, {
              status: 200, headers: { "Content-Type": "text/event-stream" }
            });
          }
        }).result();
        assert.ok(payload, `${providerId}/${modelId}/${requested}: request must reach the native adapter`);
        assert.notEqual(result.stopReason, "error", `${providerId}/${modelId}/${requested}: ${result.errorMessage}`);
        if (modelId === "grok-4.3") {
          assert.equal(payload.reasoning, undefined, "models without a YN official effort contract must leave the server default intact");
        } else {
          const supported = modelId === "grok-4.5" ? ["low", "medium", "high"] : ["low", "medium", "high", "xhigh"];
          assert.deepEqual(listThinkingLevelsForModel(model), supported);
          assert.ok(supported.includes(payload.reasoning?.effort));
          if (["auto", "off", "minimal"].includes(requested)) assert.equal(payload.reasoning.effort, "high");
        }
      }
      console.log(`ok ${providerId}/${modelId}: native request effort is valid for all saved thinking selections`);
    }
  }
} finally {
  await rm(projectDir, { recursive: true, force: true });
}
