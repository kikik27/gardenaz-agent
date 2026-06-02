import { createServer } from "node:http";
import { runAutopilotTick } from "./autopilot";
import { loadDeploymentConfig } from "./config/contracts";
import { anchorDecision } from "./relayer";
import type { AutopilotIntent, AutopilotPolicyInput, RiskLevel } from "./types";

const DEFAULT_PROTOCOLS = ["Mantle RWA USDY Route", "Mantle mETH Yield Route", "Mantle Dynamic RWA Route"];

type PlanRequest = {
  user: `0x${string}`;
  amount: string;
  riskPreference: RiskLevel;
  crop?: "steady" | "growth" | "boost";
  agentId?: string;
  currentStrategyId?: string;
  minImprovementBps?: number;
  policy?: Partial<AutopilotPolicyInput>;
  anchor?: boolean;
};

function currentStrategyFromCrop(crop: PlanRequest["crop"]): string {
  if (crop === "growth") return "growth-meth-yield";
  if (crop === "boost") return "boost-rwa-meth-dynamic";
  return "steady-rwa-usdy";
}

export function buildIntent(body: PlanRequest): AutopilotIntent {
  const riskPreference = Number(body.riskPreference || 1) as RiskLevel;
  return {
    user: body.user,
    agentId: body.agentId ?? "1",
    amount: String(body.amount ?? "0"),
    riskPreference,
    mode: "autopilot",
    currentStrategyId: body.currentStrategyId ?? currentStrategyFromCrop(body.crop),
    minImprovementBps: body.minImprovementBps ?? 50,
    policy: {
      enabled: body.policy?.enabled ?? true,
      paused: body.policy?.paused ?? false,
      maxTxAmount: body.policy?.maxTxAmount ?? 5_000,
      maxRiskLevel: body.policy?.maxRiskLevel ?? riskPreference,
      rebalanceIntervalSeconds: body.policy?.rebalanceIntervalSeconds ?? 3600,
      allowedProtocols: body.policy?.allowedProtocols?.length ? body.policy.allowedProtocols : DEFAULT_PROTOCOLS,
    },
  };
}

async function readJson(req: import("node:http").IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export function createAgentService() {
  return createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/health") {
      res.end(JSON.stringify({ ok: true, service: "gardena-agent" }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/autopilot/plan") {
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }

    try {
      const body = (await readJson(req)) as PlanRequest;
      const decision = await runAutopilotTick(buildIntent(body), { deployment: loadDeploymentConfig() });
      const anchor = body.anchor === false ? { enabled: false, txHash: null, note: "anchor disabled by request" } : await anchorDecision(decision);
      res.end(JSON.stringify({ ok: true, decision: { ...decision, anchorTxHash: anchor.txHash ?? undefined }, anchor, source: "agent-service" }));
    } catch (error) {
      res.statusCode = 400;
      res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "invalid request" }));
    }
  });
}

const isEntrypoint = process.argv[1] ? import.meta.url === new URL(process.argv[1], "file://").href : false;

if (isEntrypoint) {
  const port = Number(process.env.PORT ?? 8787);
  createAgentService().listen(port, () => {
    console.log(`Gardena agent service listening on :${port}`);
  });
}
