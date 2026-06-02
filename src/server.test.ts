import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIntent, createAgentService } from "./server";

const user = "0x7777777777777777777777777777777777777777" as const;

describe("Gardena agent HTTP service", () => {
  it("builds an autopilot intent from app request payload", () => {
    const intent = buildIntent({ user, crop: "growth", amount: "250", riskPreference: 2 });

    assert.equal(intent.mode, "autopilot");
    assert.equal(intent.currentStrategyId, "growth-meth-yield");
    assert.equal(intent.policy.maxRiskLevel, 2);
    assert.ok(intent.policy.allowedProtocols.includes("Mantle mETH Yield Route"));
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
      service.close();
    }
  });
});
