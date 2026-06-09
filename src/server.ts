import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { OutcomeRecordRequest } from "@gardenaz/agent-types";
import { runAutopilotTick } from "./autopilot";
import { plantGarden, type GardenRequest } from "./garden-agent";
import { loadDeploymentConfig } from "./config/contracts";
import { resolveAllowedProtocols } from "./config/routes";
import { anchorDecision, recordDecisionOutcome, recordPolicyExecution } from "./relayer";
import { executeManagedRoute, executeRealRoute } from "./execution";
import { logger } from "./logger";
import { getAgentLiveReadiness } from "./readiness";
import type { AutopilotIntent, AutopilotPolicyInput, RiskLevel } from "./types";

type AutopilotDecision = Awaited<ReturnType<typeof runAutopilotTick>>;

type AutopilotWorkerConfig = {
  enabled: boolean;
  user?: `0x${string}`;
  crop: "steady" | "growth" | "boost";
  amount: string;
  riskPreference: RiskLevel;
  intervalMs: number;
  execute: boolean;
  executionAuthority: "wallet" | "managed";
};

let autopilotWorkerTimer: NodeJS.Timeout | null = null;
let autopilotWorkerBusy = false;

function loadLocalEnvFile(path: URL) {
  if (!existsSync(path)) return;
  const contents = readFileSync(path, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadLocalEnvFile(new URL("../.env", import.meta.url));

function resolveOpenAiChatEndpoint() {
  const raw = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  const normalized = raw.replace(/\/$/, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/chat/completions`;
  return `${normalized}/chat/completions`;
}

type PlanRequest = {
  user: `0x${string}`;
  amount: string;
  riskPreference: RiskLevel;
  crop?: "steady" | "growth" | "boost";
  agentId?: string;
  currentStrategyId?: string;
  currentPositionId?: string;
  minImprovementBps?: number;
  policy?: Partial<AutopilotPolicyInput>;
  anchor?: boolean;
  execute?: boolean;
};

type GardenPlanRequest = PlanRequest & {
  message?: string;
  userMaxRiskLevel?: RiskLevel;
};

type GardenChatRequest = {
  message: string;
  context?: unknown;
  view?: "canvas" | "shop" | "audit";
  user?: `0x${string}`;
  mode?: "guided" | "autopilot";
};

type AssistantRequestMeta = {
  requestId: string;
  route: "/garden/chat" | "ask_garden_assistant";
  messageLength: number;
  view?: "canvas" | "shop" | "audit";
  contextKeys?: string[];
};

function summarizeAssistantRequest(route: AssistantRequestMeta["route"], body: GardenChatRequest, requestId: string): AssistantRequestMeta {
  return {
    requestId,
    route,
    messageLength: body.message.length,
    view: body.view,
    contextKeys: body.context && typeof body.context === "object" ? Object.keys(body.context as Record<string, unknown>).slice(0, 12) : undefined,
  };
}

function buildAssistantMessages(request: GardenChatRequest) {
  const modeInstruction = request.mode === "autopilot"
    ? "Autopilot mode: do not present the user with options. Report the current action, why it moved, the proof state, and the next review step. Keep it short and operational."
    : "Guided mode: always start with the best option, explain why it is best, give at most one alternative, then state the risk and the next action. Keep it concise and decision-focused.";
  return [
    {
      role: "system" as const,
      content:
        `You are Pak Tani, an English-only autonomous assistant for the Gardenaz AI x RWA moat engine on Mantle. Answer clearly and concisely using the provided context. Focus on dynamic yield strategies, automated risk management, execution readiness, and on-chain proof for Agni stablecoin and WMNT lanes. Do not invent onchain facts. If the user asks about actions, explain the next step and mention the relevant tab or action. If data is missing, say what is missing. Keep the answer short and helpful. ${modeInstruction}`,
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        message: request.message,
        view: request.view,
        context: request.context,
      }),
    },
  ];
}

export function parseAutopilotWorkerConfig(env: NodeJS.ProcessEnv = process.env): AutopilotWorkerConfig | null {
  if (env.AUTOPILOT_WORKER_ENABLED !== "true") return null;

  const crop = (env.AUTOPILOT_WORKER_CROP ?? "steady") as "steady" | "growth" | "boost";
  const amount = String(env.AUTOPILOT_WORKER_AMOUNT ?? "1000");
  const riskPreference = Number(env.AUTOPILOT_WORKER_RISK_LEVEL ?? "1") as RiskLevel;
  const intervalSeconds = Number(env.AUTOPILOT_WORKER_INTERVAL_SECONDS ?? "300");
  const user = env.AUTOPILOT_WORKER_USER;
  const executionAuthority = env.AUTOPILOT_WORKER_EXECUTION_AUTHORITY === "managed" ? "managed" : "wallet";

  return {
    enabled: true,
    user: /^0x[a-fA-F0-9]{40}$/.test(user ?? "") ? user as `0x${string}` : undefined,
    crop,
    amount,
    riskPreference: Number.isFinite(riskPreference) ? riskPreference : 1,
    intervalMs: Math.max(30_000, Math.floor(intervalSeconds * 1000)),
    execute: env.AUTOPILOT_WORKER_EXECUTE !== "false",
    executionAuthority,
  };
}

async function runAutopilotWorkerTick(config: AutopilotWorkerConfig) {
  if (autopilotWorkerBusy) return;
  autopilotWorkerBusy = true;
  const startedAt = Date.now();
  try {
    const deployment = loadDeploymentConfig();
    if (!deployment) {
      logger.warn("autopilot worker skipped: deployment config missing");
      return;
    }

    if (!config.user) {
      logger.warn("autopilot worker skipped: AUTOPILOT_WORKER_USER missing for Agni-first preview mode");
      return;
    }

    const decision = await runAutopilotTick(buildIntent({
      user: config.user,
      crop: config.crop,
      amount: config.amount,
      riskPreference: config.riskPreference,
    }), { deployment });
    const anchor = await anchorDecision(decision);
    const execution = config.execute
      ? config.executionAuthority === "managed"
        ? await executeManagedRoute({
          decision,
          userAddr: config.user,
          amount: config.amount,
        })
        : ({ enabled: false, mode: "disabled", note: "autopilot worker wallet mode cannot sign user transactions", operation: null } as const)
      : ({ enabled: false, mode: "disabled", note: "autopilot worker execute=false", operation: null } as const);

    const anchorMode = "mode" in anchor ? anchor.mode : "disabled";
    logger.info(
      {
        user: config.user,
        decisionHash: decision.decisionHash,
        anchorMode,
        executionMode: execution.mode,
        executionOperation: "operation" in execution ? execution.operation : null,
        durationMs: Date.now() - startedAt,
      },
      "autopilot worker preview tick complete",
    );
  } catch (error) {
    logger.error({ error, durationMs: Date.now() - startedAt }, "autopilot worker tick failed");
  } finally {
    autopilotWorkerBusy = false;
  }
}

function startAutopilotWorker() {
  if (autopilotWorkerTimer) return;
  const config = parseAutopilotWorkerConfig();
  if (!config) {
    logger.info("autopilot worker disabled");
    return;
  }

  logger.info({ intervalMs: config.intervalMs, crop: config.crop, execute: config.execute }, "autopilot worker enabled");
  void runAutopilotWorkerTick(config);
  autopilotWorkerTimer = setInterval(() => {
    void runAutopilotWorkerTick(config);
  }, config.intervalMs);
}

async function callOpenAiAssistant(request: GardenChatRequest): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const model = process.env.OPENAI_MODEL ?? "glm-5";
  const endpoint = resolveOpenAiChatEndpoint();
  const start = Date.now();
  logger.info(
    {
      model,
      endpoint,
      view: request.view ?? "unknown",
      messageLength: request.message.length,
      hasContext: Boolean(request.context),
    },
    "assistant request upstream start",
  );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      stream: false,
      messages: buildAssistantMessages(request),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.warn(
      {
        model,
        endpoint,
        status: response.status,
        durationMs: Date.now() - start,
        errorText: errorText.slice(0, 500),
      },
      "assistant request upstream rejected",
    );
    throw new Error(`assistant upstream HTTP ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    logger.warn(
      {
        model,
        endpoint,
        durationMs: Date.now() - start,
      },
      "assistant request returned empty content",
    );
    throw new Error("assistant returned empty content");
  }

  logger.info(
    {
      model,
      endpoint,
      durationMs: Date.now() - start,
      contentLength: content.length,
    },
    "assistant request upstream success",
  );
  return content;
}

async function streamOpenAiAssistant(request: GardenChatRequest): Promise<ReadableStream<Uint8Array>> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const model = process.env.OPENAI_MODEL ?? "glm-5";
  const endpoint = resolveOpenAiChatEndpoint();
  const start = Date.now();
  logger.info(
    {
      model,
      endpoint,
      view: request.view ?? "unknown",
      messageLength: request.message.length,
      hasContext: Boolean(request.context),
    },
    "assistant stream upstream start",
  );

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      stream: true,
      messages: buildAssistantMessages(request),
    }),
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text().catch(() => "");
    logger.warn(
      {
        model,
        endpoint,
        status: response.status,
        durationMs: Date.now() - start,
        errorText: errorText.slice(0, 500),
      },
      "assistant stream upstream rejected",
    );
    throw new Error(`assistant upstream HTTP ${response.status}: ${errorText.slice(0, 200)}`);
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let boundary = buffer.indexOf("\n\n");
          while (boundary !== -1) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of event.split("\n")) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") {
                logger.info(
                  {
                    model,
                    endpoint,
                    durationMs: Date.now() - start,
                  },
                  "assistant stream upstream done",
                );
                controller.close();
                return;
              }
              try {
                const parsed = JSON.parse(data) as {
                  choices?: Array<{ delta?: { content?: string } }>;
                };
                const delta = parsed.choices?.[0]?.delta?.content ?? "";
                if (delta) controller.enqueue(encoder.encode(delta));
              } catch (error) {
                logger.debug({ error, data: data.slice(0, 200) }, "assistant stream chunk parse skipped");
              }
            }
            boundary = buffer.indexOf("\n\n");
          }
        }

        if (buffer.trim()) {
          for (const line of buffer.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") break;
            try {
              const parsed = JSON.parse(data) as {
                choices?: Array<{ delta?: { content?: string } }>;
              };
              const delta = parsed.choices?.[0]?.delta?.content ?? "";
              if (delta) controller.enqueue(encoder.encode(delta));
            } catch (error) {
              logger.debug({ error, data: data.slice(0, 200) }, "assistant stream trailing chunk parse skipped");
            }
          }
        }

        logger.info(
          {
            model,
            endpoint,
            durationMs: Date.now() - start,
          },
          "assistant stream upstream complete",
        );
        controller.close();
      } catch (error) {
        logger.error({ error }, "assistant stream upstream failed");
        controller.error(error);
      }
    },
  });
}

export function buildIntent(body: PlanRequest): AutopilotIntent {
  const deployment = loadDeploymentConfig();
  const allowedProtocols = resolveAllowedProtocols(deployment);
  const riskPreference = Number(body.riskPreference || 1) as RiskLevel;
  const executionAuthority = body.policy?.executionAuthority ?? "managed";
  const relayerExecutor = process.env.RELAYER_EXECUTOR_ADDRESS;
  return {
    user: body.user,
    agentId: body.agentId ?? "1",
    amount: String(body.amount ?? "0"),
    riskPreference,
    mode: "autopilot",
    currentStrategyId: body.currentStrategyId,
    minImprovementBps: body.minImprovementBps ?? 50,
    policy: {
      enabled: body.policy?.enabled ?? true,
      paused: body.policy?.paused ?? false,
      maxTxAmount: body.policy?.maxTxAmount ?? 5_000,
      maxRiskLevel: body.policy?.maxRiskLevel ?? riskPreference,
      rebalanceIntervalSeconds: body.policy?.rebalanceIntervalSeconds ?? 3600,
      oracleHeartbeatSeconds: body.policy?.oracleHeartbeatSeconds ?? 900,
      allowedProtocols: body.policy?.allowedProtocols?.length ? body.policy.allowedProtocols : allowedProtocols,
      allowedExecutors:
        body.policy?.allowedExecutors?.length
          ? body.policy.allowedExecutors
          : executionAuthority === "managed" && /^0x[a-fA-F0-9]{40}$/.test(relayerExecutor ?? "")
            ? [relayerExecutor as `0x${string}`]
            : [body.user],
      allowedStrategies: body.policy?.allowedStrategies?.length ? body.policy.allowedStrategies : [],
      executionAuthority,
    },
  };
}

export function buildGardenRequest(body: GardenPlanRequest): GardenRequest {
  const riskPreference = Number(body.userMaxRiskLevel ?? body.riskPreference ?? 1) as RiskLevel;
  return {
    user: body.user,
    message: body.message ?? `${body.crop ?? "steady"} ${body.amount ?? "0"}`,
    amount: String(body.amount ?? "0"),
    userMaxRiskLevel: riskPreference,
    execute: body.execute ?? false,
  };
}

async function buildAutopilotDecisionFromVaultState(
  body: PlanRequest,
  deployment: NonNullable<ReturnType<typeof loadDeploymentConfig>> | undefined,
): Promise<{ decision: AutopilotDecision; amount: string }> {
  const amount = String(body.amount ?? "0");
  const decision = await runAutopilotTick(buildIntent({ ...body, amount }), { deployment });
  return {
    decision,
    amount,
  };
}

function toGardenResponse(result: Awaited<ReturnType<typeof plantGarden>>) {
  return {
    intent: {
      user: result.intent.user,
      message: result.parsedIntent.message,
      parsedStrategy: result.parsedIntent.crop,
    },
    marketMood: result.marketMood,
    simulation: {
      crop: result.gardenSimulation.crop,
      weather: result.marketMood.weather,
      background: result.gardenSimulation.background,
      actionLabel: result.gardenSimulation.actionLabel,
      potSlots: result.gardenSimulation.potSlots.map((slot) => ({
        strategyId: slot.id,
        title: slot.label,
        crop: slot.label.split(" /")[0] ?? slot.label,
        apy: Number.parseFloat(slot.apy),
        health: slot.health,
        selected: slot.active,
      })),
    },
    beginnerExplanation: result.beginnerExplanation,
    effectivePolicy: result.effectivePolicy,
    decision: result,
  };
}

function parseAmount(value?: string) {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

async function readJson(req: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function createAgentService() {
  startAutopilotWorker();
  return createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/health") {
      res.end(JSON.stringify({ ok: true, service: "gardena-agent" }));
      return;
    }
    if (req.method === "GET" && req.url === "/live/readiness") {
      try {
        const readiness = await getAgentLiveReadiness();
        res.end(JSON.stringify({ ok: true, readiness, source: "agent-service" }));
      } catch (error) {
        res.statusCode = 502;
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "failed to read readiness" }));
      }
      return;
    }
    if (req.method === "GET" && req.url === "/mcp/tools/list") {
      res.end(JSON.stringify({
        ok: true,
        tools: [
          { name: "plan_autopilot_strategy", description: "Run LangGraph AI advisor plus deterministic policy for autonomous AI x RWA execution" },
          { name: "plan_garden_agent", description: "Translate user intent into moat weather, strategy slots, and safe autonomous strategy plan" },
          { name: "ask_garden_assistant", description: "Answer user questions about the Gardenaz moat app, positions, proof, and strategy shop" },
          { name: "quote_agni_route", description: "Preview Agni-first execution for the selected strategy without sending an on-chain trade" },
          { name: "execute_agni_route", description: "Prepare the Agni-first execution payload when execution wiring is enabled" },
          { name: "log_decision", description: "Anchor the AI decision into DecisionLog for Mantle benchmarking transparency" },
        ],
      }));
      return;
    }

    if (req.method === "POST" && req.url === "/mcp/tools/call") {
      const body = (await readJson(req)) as { name: string; arguments?: Record<string, unknown> };
      if (body.name === "plan_autopilot_strategy") {
        const deployment = loadDeploymentConfig();
        const { decision } = await buildAutopilotDecisionFromVaultState((body.arguments ?? {}) as PlanRequest, deployment);
        res.end(JSON.stringify({ ok: true, result: decision }));
        return;
      }
      if (body.name === "plan_garden_agent") {
        const result = await plantGarden(buildGardenRequest((body.arguments ?? {}) as GardenPlanRequest), { deployment: loadDeploymentConfig() });
        const garden = toGardenResponse(result);
        res.end(JSON.stringify({ ok: true, result: garden }));
        return;
      }
      if (body.name === "ask_garden_assistant") {
        try {
          const assistantArgs = (body.arguments ?? {}) as {
            message?: string;
            context?: unknown;
            view?: "canvas" | "shop" | "audit";
            user?: `0x${string}`;
          };
          const requestId = randomUUID();
          const request = {
            message: String(assistantArgs.message ?? ""),
            context: assistantArgs.context,
            view: assistantArgs.view,
            user: assistantArgs.user,
          };
          logger.info(summarizeAssistantRequest("ask_garden_assistant", request, requestId), "assistant tool request start");
          const answer = await callOpenAiAssistant({
            ...request,
          });
          logger.info({ requestId, answerLength: answer.length }, "assistant tool request success");
          res.end(JSON.stringify({ ok: true, result: { answer, source: "agent-service" } }));
        } catch (error) {
          logger.error({ error }, "assistant tool request failed");
          res.statusCode = 502;
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "assistant failed" }));
        }
        return;
      }
      if (body.name === "quote_agni_route" || body.name === "execute_agni_route") {
        const args = (body.arguments ?? {}) as PlanRequest;
        const deployment = loadDeploymentConfig();
        const { decision, amount } = await buildAutopilotDecisionFromVaultState(args, deployment);
        const execution = await executeRealRoute({ decision, amount, userAddr: args.user });
        res.end(JSON.stringify({ ok: true, result: execution }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: "unknown tool" }));
      return;
    }

    if (req.method === "POST" && req.url === "/garden/plan") {
      try {
        const body = (await readJson(req)) as GardenPlanRequest;
        logger.info({ user: body.user, amount: body.amount, execute: body.execute ?? false }, "garden plan requested");
        const result = await plantGarden(buildGardenRequest(body), { deployment: loadDeploymentConfig() });
        const garden = toGardenResponse(result);
        const anchor = body.anchor === false ? { enabled: false, txHash: null, note: "anchor disabled by request" } : await anchorDecision(result);
        res.end(JSON.stringify({ ok: true, garden, result: garden, anchor, source: "garden-agent" }));
      } catch (error) {
        res.statusCode = 400;
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid request" }));
      }
      return;
    }

    if (req.method === "POST" && req.url === "/garden/chat") {
      try {
        const body = (await readJson(req)) as GardenChatRequest;
        const requestId = randomUUID();
        logger.info(summarizeAssistantRequest("/garden/chat", body, requestId), "assistant chat request start");
        if ((body as { stream?: boolean }).stream) {
          const stream = await streamOpenAiAssistant(body);
          res.statusCode = 200;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.setHeader("cache-control", "no-cache, no-transform");
          const reader = stream.getReader();
          const encoder = new TextEncoder();
          const pump = async () => {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              res.write(value);
            }
            res.end();
          };
          void pump().catch((error) => {
            logger.error({ error, requestId }, "assistant chat stream response failed");
            if (!res.writableEnded) res.end();
          });
          return;
        }

        const answer = await callOpenAiAssistant(body);
        logger.info({ requestId, answerLength: answer.length }, "assistant chat request success");
        res.end(JSON.stringify({ ok: true, answer, source: "agent-service" }));
      } catch (error) {
        logger.error({ error }, "assistant chat request failed");
        res.statusCode = 502;
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "assistant failed" }));
      }
      return;
    }

    if (req.method !== "POST" || req.url !== "/autopilot/plan") {
      if (req.method === "POST" && req.url === "/benchmark/outcome") {
        try {
          const body = (await readJson(req)) as OutcomeRecordRequest;
          const decisionLog = body.decision.benchmark?.decisionLog;
          const autopilotPolicy = body.decision.deployment?.contracts?.autopilotPolicy;
          const protocolAddress = body.decision.plan.protocolAddress;
          if (!decisionLog) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: "DecisionLog address missing from decision proof payload" }));
            return;
          }

          const result = await recordDecisionOutcome({
            decisionLog,
            decisionHash: body.decision.decisionHash,
            executionTxHash: body.executionTxHash,
            inputAmount: parseAmount(body.quotedInputAmount ?? body.decision.execution?.quotedInputAmount),
            outputAmount: parseAmount(body.quotedOutputAmount ?? body.decision.execution?.quotedOutputAmount),
            success: true,
            metadataURI: `agni://swap/${body.decision.plan.strategyId}`,
            chainId: body.decision.deployment?.chainId,
          });
          const policyExecution = autopilotPolicy && protocolAddress
            ? await recordPolicyExecution({
              autopilotPolicy,
              user: body.decision.intent.user,
              executor: (process.env.RELAYER_EXECUTOR_ADDRESS as `0x${string}` | undefined) ?? body.decision.intent.user,
              protocol: protocolAddress,
              strategyId: body.decision.plan.strategyId,
              amount: BigInt(body.decision.intent.amount),
              riskLevel: body.decision.plan.riskLevel,
              lossAmount: 0n,
              chainId: body.decision.deployment?.chainId,
            })
            : { enabled: false, txHash: null, note: "AutopilotPolicy address or protocol address missing", mode: "disabled" as const };

          res.end(JSON.stringify({ ok: true, result, policyExecution }));
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "failed to record outcome" }));
        }
        return;
      }

      if (req.method === "POST" && req.url === "/autopilot/execute-managed") {
        try {
          const body = (await readJson(req)) as PlanRequest;
          const deployment = loadDeploymentConfig();
          const { decision, amount } = await buildAutopilotDecisionFromVaultState(body, deployment);
          const execution = await executeManagedRoute({
            decision,
            amount,
            userAddr: body.user,
          });
          res.end(JSON.stringify({ ok: true, decision, execution, source: "agent-service" }));
        } catch (error) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid request" }));
        }
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }

    try {
      const body = (await readJson(req)) as PlanRequest;
      logger.info({ user: body.user, amount: body.amount, execute: body.execute ?? false }, "autopilot plan requested");
      const deployment = loadDeploymentConfig();
      const { decision, amount } = await buildAutopilotDecisionFromVaultState(body, deployment);
      const anchor = body.anchor === false ? { enabled: false, txHash: null, note: "anchor disabled by request" } : await anchorDecision(decision);
      const shouldExecute = body.execute && decision.action.kind !== "hold";
      const execution = shouldExecute
        ? await executeRealRoute({
          decision,
          amount,
          userAddr: body.user,
        })
        : ({ enabled: false, mode: "disabled", note: "request execute=false", operation: null } as const);
      res.end(JSON.stringify({ ok: true, decision: { ...decision, anchorTxHash: anchor.txHash ?? null }, anchor, execution, outcome: null, source: "agent-service" }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid request" }));
    }
  });
}

const port = Number(process.env.PORT ?? 8787);
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  createAgentService().listen(port, () => {
    logger.info({ port }, "Gardena agent service listening");
  });
}
