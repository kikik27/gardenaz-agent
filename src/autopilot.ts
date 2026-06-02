import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { loadDeploymentConfig } from "./config/contracts";
import { CROP_STRATEGIES } from "./config/crops";
import { hashDecision } from "./nodes/log";
import type {
  AgentContext,
  AiAdvisorSignal,
  AutopilotAction,
  AutopilotDecision,
  AutopilotIntent,
  DeploymentConfig,
  PolicyDecision,
  RiskLevel,
  ScoredYieldOpportunity,
  YieldOpportunity,
} from "./types";

const DEFAULT_MARKET: YieldOpportunity[] = [
  {
    id: "steady-rwa-usdy",
    strategyId: "steady-rwa-usdy",
    protocol: "Mantle RWA USDY Route",
    asset: "USDY",
    expectedApyBps: 520,
    riskLevel: 1,
    liquidityUsd: 1_400_000,
    gasCostUsd: 0.05,
    confidence: 0.92,
    marketCondition: "USDY RWA yield stable",
    consumerTheme: "Rice / Safe Harvest",
    trackFit: "AI x RWA",
    shareLabel: "Safe harvest powered by USDY",
  },
  {
    id: "growth-meth-yield",
    strategyId: "growth-meth-yield",
    protocol: "Mantle mETH Yield Route",
    asset: "mETH",
    expectedApyBps: 960,
    riskLevel: 2,
    liquidityUsd: 950_000,
    gasCostUsd: 0.08,
    confidence: 0.86,
    marketCondition: "mETH staking yield improving",
    consumerTheme: "Corn / Growth Field",
    trackFit: "AI x RWA",
    shareLabel: "Growth field compounding with mETH",
  },
  {
    id: "boost-rwa-meth-dynamic",
    strategyId: "boost-rwa-meth-dynamic",
    protocol: "Mantle Dynamic RWA Route",
    asset: "USDY/mETH",
    expectedApyBps: 1_760,
    riskLevel: 3,
    liquidityUsd: 420_000,
    gasCostUsd: 0.12,
    confidence: 0.72,
    marketCondition: "dynamic RWA and mETH spread opportunity",
    consumerTheme: "Chili / Boost Farm",
    trackFit: "Consumer & Viral DApps",
    shareLabel: "Boost farm caught a spicy RWA spread",
  },
];

export const AutopilotStateAnnotation = Annotation.Root({
  intent: Annotation<AutopilotIntent>,
  deployment: Annotation<DeploymentConfig | undefined>,
  market: Annotation<{ opportunities: YieldOpportunity[] } | undefined>,
  rankedOpportunities: Annotation<ScoredYieldOpportunity[] | undefined>,
  selectedOpportunity: Annotation<ScoredYieldOpportunity | undefined>,
  aiAdvisor: Annotation<AiAdvisorSignal | undefined>,
  policy: Annotation<PolicyDecision | undefined>,
  action: Annotation<AutopilotAction | undefined>,
  summary: Annotation<string | undefined>,
  createdAt: Annotation<string | undefined>,
  decisionHash: Annotation<`0x${string}` | undefined>,
  decision: Annotation<AutopilotDecision | undefined>,
});

export type AutopilotGraphState = typeof AutopilotStateAnnotation.State;
export type AutopilotGraphUpdate = typeof AutopilotStateAnnotation.Update;

function observeMarketNode(state: AutopilotGraphState): AutopilotGraphUpdate {
  return { market: state.market ?? { opportunities: DEFAULT_MARKET } };
}

function rankOpportunity(opportunity: YieldOpportunity): ScoredYieldOpportunity {
  const apy = opportunity.expectedApyBps;
  const riskPenalty = opportunity.riskLevel * 180;
  const gasPenalty = opportunity.gasCostUsd * 20;
  const liquidityPenalty = opportunity.liquidityUsd < 500_000 ? 150 : 0;
  const confidenceBonus = opportunity.confidence * 100;
  const score = apy - riskPenalty - gasPenalty - liquidityPenalty + confidenceBonus;

  return {
    ...opportunity,
    score,
    scoreBreakdown: { apy, riskPenalty, gasPenalty, liquidityPenalty, confidenceBonus },
  };
}

function isPolicyEligible(state: AutopilotGraphState, opportunity: ScoredYieldOpportunity): boolean {
  const amount = Number(state.intent.amount);
  return (
    state.intent.policy.enabled &&
    !state.intent.policy.paused &&
    Number.isFinite(amount) &&
    amount > 0 &&
    amount <= state.intent.policy.maxTxAmount &&
    opportunity.riskLevel <= state.intent.policy.maxRiskLevel &&
    state.intent.policy.allowedProtocols.includes(opportunity.protocol)
  );
}

function rankStrategiesNode(state: AutopilotGraphState): AutopilotGraphUpdate {
  const opportunities = state.market?.opportunities ?? [];
  if (opportunities.length === 0) {
    throw new Error("Autopilot graph requires at least one yield opportunity");
  }

  const rankedOpportunities = opportunities.map(rankOpportunity).sort((a, b) => b.score - a.score);
  const selectedOpportunity = rankedOpportunities.find((opportunity) => isPolicyEligible(state, opportunity)) ?? rankedOpportunities[0];
  return { rankedOpportunities, selectedOpportunity };
}

function buildFallbackAdvisor(state: AutopilotGraphState): AiAdvisorSignal {
  const selected = state.selectedOpportunity;
  if (!selected) throw new Error("AI advisor requires selected opportunity");
  return {
    provider: "fallback",
    model: process.env.OPENAI_API_KEY ? (process.env.OPENAI_MODEL ?? "gpt-4o-mini") : "deterministic-rwa-advisor",
    recommendedStrategyId: selected.strategyId,
    marketSummary: `${selected.asset} route selected from Mantle RWA market: ${selected.marketCondition}.`,
    riskNotes: [
      `Risk level ${selected.riskLevel} stays behind user max risk ${state.intent.policy.maxRiskLevel}.`,
      `${selected.protocol} must pass deterministic allowlist before execution.`,
    ],
    confidenceReason: `AI recommendation is advisory only; deterministic policy gate selected ${selected.strategyId}.`,
  };
}

function sanitizeAdvisorSignal(state: AutopilotGraphState, input: Partial<AiAdvisorSignal>): AiAdvisorSignal {
  const fallback = buildFallbackAdvisor(state);
  const validStrategyIds = new Set(state.rankedOpportunities?.map((opportunity) => opportunity.strategyId) ?? []);
  const recommendedStrategyId =
    input.recommendedStrategyId && validStrategyIds.has(input.recommendedStrategyId)
      ? input.recommendedStrategyId
      : fallback.recommendedStrategyId;

  return {
    provider: input.provider === "llm" ? "llm" : fallback.provider,
    model: input.model || fallback.model,
    recommendedStrategyId,
    marketSummary: input.marketSummary || fallback.marketSummary,
    riskNotes: Array.isArray(input.riskNotes) && input.riskNotes.length > 0 ? input.riskNotes.slice(0, 4) : fallback.riskNotes,
    confidenceReason: input.confidenceReason || fallback.confidenceReason,
  };
}

async function callOpenAiAdvisor(state: AutopilotGraphState): Promise<AiAdvisorSignal | undefined> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return undefined;

  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const response = await fetch(process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are Gardena AI, an RWA DeFi farming advisor. Return strict JSON only. Recommend only known strategy IDs. Never bypass policy; policy gate remains deterministic.",
        },
        {
          role: "user",
          content: JSON.stringify({
            intent: state.intent,
            selectedByDeterministicRanker: state.selectedOpportunity,
            rankedOpportunities: state.rankedOpportunities,
            requiredShape: {
              recommendedStrategyId: "string",
              marketSummary: "string mentioning asset/protocol",
              riskNotes: ["string"],
              confidenceReason: "string mentioning policy gate",
            },
          }),
        },
      ],
    }),
  });

  if (!response.ok) return undefined;
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return undefined;
  const parsed = JSON.parse(content) as Partial<AiAdvisorSignal>;
  return sanitizeAdvisorSignal(state, { ...parsed, provider: "llm", model });
}

async function aiAdvisorNode(state: AutopilotGraphState): Promise<AutopilotGraphUpdate> {
  try {
    const llmSignal = await callOpenAiAdvisor(state);
    return { aiAdvisor: llmSignal ?? buildFallbackAdvisor(state) };
  } catch {
    return { aiAdvisor: buildFallbackAdvisor(state) };
  }
}

function policyNode(state: AutopilotGraphState): AutopilotGraphUpdate {
  if (!state.selectedOpportunity) {
    throw new Error("Autopilot policy node requires selected opportunity");
  }

  const amount = Number(state.intent.amount);
  const checks = [
    {
      label: "Autopilot enabled",
      pass: state.intent.policy.enabled && !state.intent.policy.paused,
      detail: state.intent.policy.paused ? "Autopilot is paused" : "Autopilot enabled",
    },
    {
      label: "Amount limit",
      pass: Number.isFinite(amount) && amount > 0 && amount <= state.intent.policy.maxTxAmount,
      detail: `Amount ${state.intent.amount} <= ${state.intent.policy.maxTxAmount}`,
    },
    {
      label: "Risk limit",
      pass: state.selectedOpportunity.riskLevel <= state.intent.policy.maxRiskLevel,
      detail: `Opportunity risk ${state.selectedOpportunity.riskLevel} <= policy risk ${state.intent.policy.maxRiskLevel}`,
    },
    {
      label: "Protocol allowlist",
      pass: state.intent.policy.allowedProtocols.includes(state.selectedOpportunity.protocol),
      detail: `${state.selectedOpportunity.protocol} must be allowed by user policy`,
    },
  ];

  const failed = checks.find((check) => !check.pass);
  const policy: PolicyDecision = failed
    ? { allow: false, status: "blocked", reason: failed.detail, checks }
    : { allow: true, status: "approved", reason: "Autopilot opportunity passes deterministic policy checks.", checks };

  return { policy };
}

function currentApyBps(state: AutopilotGraphState): number {
  const current = state.market?.opportunities.find((item) => item.strategyId === state.intent.currentStrategyId);
  if (current) return current.expectedApyBps;
  const plan = Object.values(CROP_STRATEGIES).find((item) => item.strategyId === state.intent.currentStrategyId);
  if (!plan) return 0;
  const match = plan.expectedApy.match(/\d+/);
  return match ? Number(match[0]) * 100 : 0;
}

function simulateNode(state: AutopilotGraphState): AutopilotGraphUpdate {
  if (!state.selectedOpportunity || !state.policy) {
    throw new Error("Autopilot simulate node requires selected opportunity and policy");
  }

  const improvementBps = Math.max(0, state.selectedOpportunity.expectedApyBps - currentApyBps(state));
  let action: AutopilotAction;

  if (!state.policy.allow) {
    action = {
      kind: "hold",
      reason: `Autopilot blocked: ${state.policy.reason}`,
      currentStrategyId: state.intent.currentStrategyId,
      improvementBps,
    };
  } else if (improvementBps < state.intent.minImprovementBps) {
    action = {
      kind: "hold",
      reason: `Best improvement ${improvementBps} bps is below threshold ${state.intent.minImprovementBps} bps.`,
      currentStrategyId: state.intent.currentStrategyId,
      improvementBps,
    };
  } else {
    action = {
      kind: "rebalance",
      reason: `${state.selectedOpportunity.strategyId} improves yield by ${improvementBps} bps after policy checks.`,
      fromStrategyId: state.intent.currentStrategyId,
      toStrategyId: state.selectedOpportunity.strategyId,
      improvementBps,
    };
  }

  const summary =
    action.kind === "rebalance"
      ? `Autopilot approved rebalance to ${state.selectedOpportunity.strategyId}: ${action.reason}`
      : `Autopilot hold: ${action.reason}`;

  return { action, summary, createdAt: new Date().toISOString() };
}

function logNode(state: AutopilotGraphState): AutopilotGraphUpdate {
  if (!state.market || !state.rankedOpportunities || !state.selectedOpportunity || !state.aiAdvisor || !state.policy || !state.action || !state.summary || !state.createdAt) {
    throw new Error("Autopilot log node requires complete state");
  }

  const registries = {
    reputationRegistry: state.deployment?.contracts.reputationRegistry,
    validationRegistry: state.deployment?.contracts.validationRegistry,
    autopilotPolicy: state.deployment?.contracts.autopilotPolicy,
  };

  const decisionHash = hashDecision(
    JSON.stringify({
      intent: state.intent,
      selectedOpportunity: state.selectedOpportunity,
      aiAdvisor: state.aiAdvisor,
      policy: state.policy,
      action: state.action,
      registries,
      createdAt: state.createdAt,
    }),
  );

  const decision: AutopilotDecision = {
    intent: state.intent,
    market: state.market,
    rankedOpportunities: state.rankedOpportunities,
    selectedOpportunity: state.selectedOpportunity,
    aiAdvisor: state.aiAdvisor,
    policy: state.policy,
    action: state.action,
    decisionHash,
    summary: state.summary,
    createdAt: state.createdAt,
    deployment: state.deployment,
    erc8004: { agentId: state.intent.agentId, registries },
    track: {
      primary: "AI x RWA",
      secondary: "Consumer & Viral DApps",
      support: "Agentic Wallets & Economy",
    },
  };

  return { decisionHash, decision };
}

export function createAutopilotGraph() {
  return new StateGraph(AutopilotStateAnnotation)
    .addNode("observe_market", observeMarketNode)
    .addNode("rank_strategies", rankStrategiesNode)
    .addNode("ai_advisor", aiAdvisorNode)
    .addNode("policy_check", policyNode)
    .addNode("simulate", simulateNode)
    .addNode("log", logNode)
    .addEdge(START, "observe_market")
    .addEdge("observe_market", "rank_strategies")
    .addEdge("rank_strategies", "ai_advisor")
    .addEdge("ai_advisor", "policy_check")
    .addEdge("policy_check", "simulate")
    .addEdge("simulate", "log")
    .addEdge("log", END)
    .compile();
}

export const autopilotGraph = createAutopilotGraph();

export async function runAutopilotTick(
  intent: AutopilotIntent,
  context: AgentContext = { deployment: loadDeploymentConfig() },
): Promise<AutopilotDecision> {
  const state = await autopilotGraph.invoke({
    intent,
    deployment: context.deployment,
    market: context.yieldOpportunities ? { opportunities: context.yieldOpportunities } : undefined,
  });

  if (!state.decision) {
    throw new Error("Autopilot graph completed without producing a decision");
  }

  return state.decision;
}

export type { AutopilotDecision, AutopilotIntent, YieldOpportunity } from "./types";
