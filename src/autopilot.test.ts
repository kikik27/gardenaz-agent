import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAutopilotGraph, runAutopilotTick } from "./autopilot";
import type { AgentContext, AutopilotIntent, YieldOpportunity } from "./types";

const context: AgentContext = {
  deployment: {
    chainId: 5000,
    network: "mantle",
    contracts: {
      agentIdentity: "0x1111111111111111111111111111111111111111",
      decisionLog: "0x2222222222222222222222222222222222222222",
      riskPolicy: "0x3333333333333333333333333333333333333333",
      reputationRegistry: "0x4444444444444444444444444444444444444444",
      validationRegistry: "0x5555555555555555555555555555555555555555",
      autopilotPolicy: "0x6666666666666666666666666666666666666666",
    },
  },
};

const baseIntent: AutopilotIntent = {
  user: "0x7777777777777777777777777777777777777777",
  agentId: "1",
  amount: "1000",
  riskPreference: 2,
  mode: "autopilot",
  currentStrategyId: "steady-lend-usdc",
  minImprovementBps: 50,
  policy: {
    enabled: true,
    paused: false,
    maxTxAmount: 5_000,
    maxRiskLevel: 2,
    rebalanceIntervalSeconds: 3600,
    allowedProtocols: ["Mantle Lending Route", "Mantle Liquidity Route"],
  },
};

const opportunities: YieldOpportunity[] = [
  {
    id: "steady-lend-usdc",
    strategyId: "steady-lend-usdc",
    protocol: "Mantle Lending Route",
    asset: "USDC",
    expectedApyBps: 420,
    riskLevel: 1,
    liquidityUsd: 1_000_000,
    gasCostUsd: 0.05,
    confidence: 0.92,
    marketCondition: "stable lending demand",
  },
  {
    id: "growth-lp-usdc-meth",
    strategyId: "growth-lp-usdc-meth",
    protocol: "Mantle Liquidity Route",
    asset: "USDC/mETH",
    expectedApyBps: 980,
    riskLevel: 2,
    liquidityUsd: 800_000,
    gasCostUsd: 0.08,
    confidence: 0.86,
    marketCondition: "LP fees improving",
  },
  {
    id: "boost-vault-usdc",
    strategyId: "boost-vault-usdc",
    protocol: "Mantle Yield Vault Route",
    asset: "USDC",
    expectedApyBps: 2_100,
    riskLevel: 3,
    liquidityUsd: 250_000,
    gasCostUsd: 0.12,
    confidence: 0.7,
    marketCondition: "volatile incentives",
  },
];

describe("Gardena autopilot LangGraph", () => {
  it("observes live yield opportunities, ranks them, and approves best policy-safe rebalance", async () => {
    const decision = await runAutopilotTick(baseIntent, { ...context, yieldOpportunities: opportunities });

    assert.equal(decision.intent.mode, "autopilot");
    assert.equal(decision.policy.status, "approved");
    assert.equal(decision.selectedOpportunity.strategyId, "growth-lp-usdc-meth");
    assert.equal(decision.action.kind, "rebalance");
    assert.ok(decision.action.reason.includes("improves yield"));
    assert.match(decision.decisionHash, /^0x[0-9a-f]{64}$/);
    assert.equal(decision.erc8004.agentId, "1");
    assert.deepEqual(decision.erc8004.registries, {
      reputationRegistry: "0x4444444444444444444444444444444444444444",
      validationRegistry: "0x5555555555555555555555555555555555555555",
      autopilotPolicy: "0x6666666666666666666666666666666666666666",
    });
  });

  it("blocks unsafe higher-yield strategy when risk exceeds user policy", async () => {
    const decision = await runAutopilotTick(
      { ...baseIntent, policy: { ...baseIntent.policy, allowedProtocols: ["Mantle Yield Vault Route"], maxRiskLevel: 2 } },
      { ...context, yieldOpportunities: [opportunities[2]] },
    );

    assert.equal(decision.policy.status, "blocked");
    assert.equal(decision.action.kind, "hold");
    assert.ok(decision.summary.includes("blocked"));
  });

  it("holds current strategy when improvement is below threshold", async () => {
    const decision = await runAutopilotTick(
      { ...baseIntent, minImprovementBps: 1_000 },
      { ...context, yieldOpportunities: opportunities },
    );

    assert.equal(decision.policy.status, "approved");
    assert.equal(decision.action.kind, "hold");
    assert.ok(decision.action.reason.includes("below threshold"));
  });

  it("exposes a compiled autopilot graph", async () => {
    const graph = createAutopilotGraph();
    const state = await graph.invoke({ intent: baseIntent, deployment: context.deployment, market: { opportunities } });

    assert.equal(typeof graph.invoke, "function");
    assert.equal(state.selectedOpportunity?.strategyId, "growth-lp-usdc-meth");
    assert.equal(state.decision?.action.kind, "rebalance");
  });

  it("defaults to AI x RWA opportunities with USDY and mETH consumer garden metadata", async () => {
    const decision = await runAutopilotTick({
      ...baseIntent,
      currentStrategyId: "steady-rwa-usdy",
      policy: {
        ...baseIntent.policy,
        allowedProtocols: ["Mantle RWA USDY Route", "Mantle mETH Yield Route"],
      },
    });

    const assets = decision.market.opportunities.map((opportunity) => opportunity.asset);
    const protocols = decision.market.opportunities.map((opportunity) => opportunity.protocol);
    const themes = decision.market.opportunities.map((opportunity) => opportunity.consumerTheme);

    assert.ok(assets.includes("USDY"));
    assert.ok(assets.includes("mETH"));
    assert.ok(protocols.includes("Mantle RWA USDY Route"));
    assert.ok(protocols.includes("Mantle mETH Yield Route"));
    assert.ok(themes.includes("Rice / Safe Harvest"));
    assert.ok(themes.includes("Corn / Growth Field"));
    assert.equal(decision.track.primary, "AI x RWA");
    assert.equal(decision.track.secondary, "Consumer & Viral DApps");
  });

  it("includes an AI advisor signal before deterministic policy enforcement", async () => {
    const decision = await runAutopilotTick({
      ...baseIntent,
      currentStrategyId: "steady-rwa-usdy",
      policy: {
        ...baseIntent.policy,
        allowedProtocols: ["Mantle RWA USDY Route", "Mantle mETH Yield Route"],
      },
    });

    assert.ok(decision.aiAdvisor.marketSummary.includes(decision.selectedOpportunity.asset));
    assert.ok(decision.aiAdvisor.riskNotes.length > 0);
    assert.equal(decision.aiAdvisor.recommendedStrategyId, decision.selectedOpportunity.strategyId);
    assert.match(decision.aiAdvisor.confidenceReason, /policy/i);
  });
});
