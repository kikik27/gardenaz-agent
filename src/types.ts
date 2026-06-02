export type CropId = "steady" | "growth" | "boost";
export type RiskLevel = 1 | 2 | 3;
export type DecisionStatus = "approved" | "blocked";

export type AgentIntent = {
  user: `0x${string}`;
  crop: CropId;
  amount: string;
  riskPreference: RiskLevel;
};

export type AgentPlan = {
  strategyId: string;
  title: string;
  riskLevel: RiskLevel;
  protocol: string;
  action: string;
  asset: string;
  expectedApy: string;
  steps: string[];
  explanation: string;
};

export type PolicyDecision = {
  allow: boolean;
  status: DecisionStatus;
  reason: string;
  checks: Array<{ label: string; pass: boolean; detail: string }>;
};

export type AgentDecision = {
  intent: AgentIntent;
  plan: AgentPlan;
  policy: PolicyDecision;
  decisionHash: `0x${string}`;
  summary: string;
  createdAt: string;
  deployment?: DeploymentConfig;
};

export type ContractAddresses = {
  agentIdentity: `0x${string}`;
  decisionLog: `0x${string}`;
  riskPolicy: `0x${string}`;
  reputationRegistry?: `0x${string}`;
  validationRegistry?: `0x${string}`;
  autopilotPolicy?: `0x${string}`;
};

export type DeploymentConfig = {
  chainId: number;
  network: string;
  contracts: ContractAddresses;
};

export type AgentContext = {
  deployment?: DeploymentConfig;
  yieldOpportunities?: YieldOpportunity[];
};

export type YieldOpportunity = {
  id: string;
  strategyId: string;
  protocol: string;
  asset: string;
  expectedApyBps: number;
  riskLevel: RiskLevel;
  liquidityUsd: number;
  gasCostUsd: number;
  confidence: number;
  marketCondition: string;
  consumerTheme?: string;
  trackFit?: "AI x RWA" | "Consumer & Viral DApps" | "Agentic Wallets & Economy";
  shareLabel?: string;
};

export type ScoredYieldOpportunity = YieldOpportunity & {
  score: number;
  scoreBreakdown: {
    apy: number;
    riskPenalty: number;
    gasPenalty: number;
    liquidityPenalty: number;
    confidenceBonus: number;
  };
};

export type AiAdvisorSignal = {
  provider: "llm" | "fallback";
  model: string;
  recommendedStrategyId: string;
  marketSummary: string;
  riskNotes: string[];
  confidenceReason: string;
};

export type AutopilotPolicyInput = {
  enabled: boolean;
  paused: boolean;
  maxTxAmount: number;
  maxRiskLevel: RiskLevel;
  rebalanceIntervalSeconds: number;
  allowedProtocols: string[];
};

export type AutopilotIntent = {
  user: `0x${string}`;
  agentId: string;
  amount: string;
  riskPreference: RiskLevel;
  mode: "autopilot";
  currentStrategyId?: string;
  minImprovementBps: number;
  policy: AutopilotPolicyInput;
};

export type AutopilotAction =
  | { kind: "rebalance"; reason: string; fromStrategyId?: string; toStrategyId: string; improvementBps: number }
  | { kind: "hold"; reason: string; currentStrategyId?: string; improvementBps: number };

export type AutopilotDecision = {
  intent: AutopilotIntent;
  market: { opportunities: YieldOpportunity[] };
  rankedOpportunities: ScoredYieldOpportunity[];
  selectedOpportunity: ScoredYieldOpportunity;
  aiAdvisor: AiAdvisorSignal;
  policy: PolicyDecision;
  action: AutopilotAction;
  decisionHash: `0x${string}`;
  summary: string;
  createdAt: string;
  deployment?: DeploymentConfig;
  erc8004: {
    agentId: string;
    registries: {
      reputationRegistry?: `0x${string}`;
      validationRegistry?: `0x${string}`;
      autopilotPolicy?: `0x${string}`;
    };
  };
  track: {
    primary: "AI x RWA";
    secondary: "Consumer & Viral DApps";
    support: "Agentic Wallets & Economy";
  };
};
