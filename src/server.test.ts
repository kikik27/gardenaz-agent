import assert from "node:assert/strict";
import { describe, it } from "node:test";

const originalEnv = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  AUTOPILOT_WORKER_ENABLED: process.env.AUTOPILOT_WORKER_ENABLED,
};

process.env.OPENAI_API_KEY = "";
delete process.env.OPENAI_BASE_URL;
process.env.AUTOPILOT_WORKER_ENABLED = "false";

const {
  buildGardenRequest,
  buildIntent,
  createAgentService,
  parseAutopilotWorkerConfig,
} = await import("./server");

const user = "0x7777777777777777777777777777777777777777" as const;

function restoreEnv() {
  if (originalEnv.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalEnv.OPENAI_API_KEY;

  if (originalEnv.OPENAI_BASE_URL === undefined) delete process.env.OPENAI_BASE_URL;
  else process.env.OPENAI_BASE_URL = originalEnv.OPENAI_BASE_URL;

  if (originalEnv.AUTOPILOT_WORKER_ENABLED === undefined) delete process.env.AUTOPILOT_WORKER_ENABLED;
  else process.env.AUTOPILOT_WORKER_ENABLED = originalEnv.AUTOPILOT_WORKER_ENABLED;
}

describe("Gardena agent HTTP service", () => {
  it("builds an autopilot intent from app request payload", () => {
    const intent = buildIntent({ user, crop: "growth", amount: "250", riskPreference: 2 });

    assert.equal(intent.mode, "autopilot");
    assert.equal(intent.currentStrategyId, undefined);
    assert.equal(intent.policy.maxRiskLevel, 2);
    assert.equal(intent.policy.executionAuthority, "managed");
    assert.equal(intent.policy.oracleHeartbeatSeconds, 900);
    assert.ok(intent.policy.allowedProtocols.length >= 1);
    assert.deepEqual(intent.policy.allowedExecutors, [process.env.RELAYER_EXECUTOR_ADDRESS ?? user]);
    assert.match(intent.policy.allowedProtocols[0] ?? "", /^0x[a-fA-F0-9]{40}$/);
  });

  it("builds a beginner garden request from app request payload", () => {
    const request = buildGardenRequest({
      user,
      message: "pemula mau aman dulu 1000 USDC",
      amount: "1000",
      riskPreference: 3,
      execute: true,
    });

    assert.equal(request.user, user);
    assert.equal(request.message, "pemula mau aman dulu 1000 USDC");
    assert.equal(request.amount, "1000");
    assert.equal(request.userMaxRiskLevel, 3);
    assert.equal(request.execute, true);
  });

  it("parses autopilot worker config from env", () => {
    const original = {
      enabled: process.env.AUTOPILOT_WORKER_ENABLED,
      crop: process.env.AUTOPILOT_WORKER_CROP,
      amount: process.env.AUTOPILOT_WORKER_AMOUNT,
      risk: process.env.AUTOPILOT_WORKER_RISK_LEVEL,
      interval: process.env.AUTOPILOT_WORKER_INTERVAL_SECONDS,
      execute: process.env.AUTOPILOT_WORKER_EXECUTE,
    };

    try {
      process.env.AUTOPILOT_WORKER_ENABLED = "true";
      process.env.AUTOPILOT_WORKER_CROP = "growth";
      process.env.AUTOPILOT_WORKER_AMOUNT = "250";
      process.env.AUTOPILOT_WORKER_RISK_LEVEL = "2";
      process.env.AUTOPILOT_WORKER_INTERVAL_SECONDS = "60";
      process.env.AUTOPILOT_WORKER_EXECUTE = "false";

      const config = parseAutopilotWorkerConfig();

      assert.ok(config);
      assert.equal(config?.crop, "growth");
      assert.equal(config?.amount, "250");
      assert.equal(config?.riskPreference, 2);
      assert.equal(config?.execute, false);
    } finally {
      process.env.AUTOPILOT_WORKER_ENABLED = original.enabled;
      process.env.AUTOPILOT_WORKER_CROP = original.crop;
      process.env.AUTOPILOT_WORKER_AMOUNT = original.amount;
      process.env.AUTOPILOT_WORKER_RISK_LEVEL = original.risk;
      process.env.AUTOPILOT_WORKER_INTERVAL_SECONDS = original.interval;
      process.env.AUTOPILOT_WORKER_EXECUTE = original.execute;
    }
  });

  it("serves /autopilot/plan with agent-service source and optional relayer anchor", async () => {
    const service = createAgentService();
    await new Promise<void>((resolve) => service.listen(0, resolve));
    const address = service.address();
    assert.equal(typeof address, "object");
    if (!address || typeof address !== "object") throw new Error("missing server address");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/autopilot/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user, crop: "steady", amount: "1000", riskPreference: 1, anchor: false }),
      });
      const json = await res.json() as { ok: boolean; source: string; decision: { decisionHash: string }; anchor: { enabled: boolean } };

      assert.equal(res.status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.source, "agent-service");
      assert.match(json.decision.decisionHash, /^0x[0-9a-f]{64}$/);
      assert.equal(json.anchor.enabled, false);
    } finally {
      await new Promise<void>((resolve) => service.close(() => resolve()));
    }
  });

  it("serves /live/readiness without crashing when relayer env is incomplete", async () => {
    const service = createAgentService();
    await new Promise<void>((resolve) => service.listen(0, resolve));
    const address = service.address();
    assert.equal(typeof address, "object");
    if (!address || typeof address !== "object") throw new Error("missing server address");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/live/readiness`);
      const json = await res.json() as {
        ok: boolean;
        readiness: {
          chainId: number;
          relayer: { enabled: boolean };
          benchmarking: { status: string; notes: string[] };
        };
      };

      assert.equal(res.status, 200);
      assert.equal(json.ok, true);
      assert.equal(typeof json.readiness.chainId, "number");
      assert.equal(typeof json.readiness.relayer.enabled, "boolean");
      assert.ok(Array.isArray(json.readiness.benchmarking.notes));
      assert.match(json.readiness.benchmarking.status, /ready|partial|blocked/);
    } finally {
      await new Promise<void>((resolve) => service.close(() => resolve()));
    }
  });

  it("serves /garden/plan as beginner game-ready agent response", async () => {
    const service = createAgentService();
    await new Promise<void>((resolve) => service.listen(0, resolve));
    const address = service.address();
    assert.equal(typeof address, "object");
    if (!address || typeof address !== "object") throw new Error("missing server address");

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/garden/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ user, message: "pemula mau aman tanam 1000", amount: "1000", riskPreference: 1, execute: false }),
      });
      const json = await res.json() as {
        ok: boolean;
        source: string;
        error?: string;
        result: {
          simulation: { weather: string; crop: string; potSlots: Array<{ strategyId: string }> };
          beginnerExplanation: string;
          decision: { decisionHash: string };
        };
      };

      assert.equal(res.status, 200, json.error);
      assert.equal(json.ok, true, json.error);
      assert.equal(json.source, "garden-agent");
      assert.equal(json.result.simulation.crop, "Rice / Safe Harvest");
      assert.ok(json.result.simulation.potSlots.length > 0);
      assert.match(json.result.decision.decisionHash, /^0x[0-9a-f]{64}$/);
      assert.match(json.result.beginnerExplanation, /beginner|safe|USDC|stable/i);
    } finally {
      await new Promise<void>((resolve) => service.close(() => resolve()));
    }
  });

  it("exposes plan_garden_agent through MCP tool call", async () => {
    const service = createAgentService();
    await new Promise<void>((resolve) => service.listen(0, resolve));
    const address = service.address();
    assert.equal(typeof address, "object");
    if (!address || typeof address !== "object") throw new Error("missing server address");

    try {
      const listRes = await fetch(`http://127.0.0.1:${address.port}/mcp/tools/list`);
      const listJson = await listRes.json() as { tools: Array<{ name: string }> };
      assert.ok(listJson.tools.some((tool) => tool.name === "plan_garden_agent"));

      const callRes = await fetch(`http://127.0.0.1:${address.port}/mcp/tools/call`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "plan_garden_agent",
          arguments: { user, message: "growth tapi tetap aman", amount: "500", riskPreference: 2, execute: false },
        }),
      });
      const callJson = await callRes.json() as { ok: boolean; error?: string; result: { simulation: { actionLabel: string } } };

      assert.equal(callRes.status, 200, callJson.error);
      assert.equal(callJson.ok, true, callJson.error);
      assert.ok(callJson.result.simulation.actionLabel.length > 0);
    } finally {
      await new Promise<void>((resolve) => service.close(() => resolve()));
    }
  });
});

process.on("exit", restoreEnv);
