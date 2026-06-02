import { createWalletClient, encodeFunctionData, http, isAddress, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mantle } from "viem/chains";
import type { AutopilotDecision } from "./types";

const DECISION_LOG_ABI: any = [
  {
    type: "function",
    name: "logDecision",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "decisionHash", type: "bytes32" },
      { name: "strategyId", type: "bytes32" },
      { name: "targetProtocol", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "riskLevel", type: "uint8" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export type AnchorResult =
  | { enabled: false; txHash: null; note: string }
  | { enabled: true; txHash: `0x${string}` | null; note: string; mode: "prepared" | "sent"; calldata?: `0x${string}` };

const mantleSepolia = {
  id: 5003,
  name: "Mantle Sepolia",
  nativeCurrency: { decimals: 18, name: "MNT", symbol: "MNT" },
  rpcUrls: { default: { http: ["https://rpc.sepolia.mantle.xyz"] } },
} as const;

function chainFor(chainId: number) {
  if (chainId === mantle.id) return mantle;
  return mantleSepolia;
}

function strategyIdToBytes32(strategyId: string): `0x${string}` {
  const bytes = Buffer.from(strategyId, "utf8").subarray(0, 32);
  return `0x${bytes.toString("hex").padEnd(64, "0")}` as `0x${string}`;
}

function protocolAddress(): `0x${string}` {
  const value = process.env.TARGET_PROTOCOL_ADDRESS;
  return value && isAddress(value) ? value : "0x0000000000000000000000000000000000000000";
}

export async function anchorDecision(decision: AutopilotDecision): Promise<AnchorResult> {
  const enabled = process.env.RELAYER_ENABLED === "true";
  const decisionLog = decision.deployment?.contracts.decisionLog;
  if (!enabled) return { enabled: false, txHash: null, note: "RELAYER_ENABLED disabled" };
  if (!decisionLog) return { enabled: false, txHash: null, note: "DecisionLog address missing" };

  const agentId = BigInt(decision.intent.agentId || "1");
  const amount = parseEther(decision.intent.amount || "0");
  const calldata = encodeFunctionData({
    abi: DECISION_LOG_ABI,
    functionName: "logDecision",
    args: [
      agentId,
      decision.decisionHash,
      strategyIdToBytes32(decision.selectedOpportunity.strategyId),
      protocolAddress(),
      amount,
      decision.selectedOpportunity.riskLevel,
    ],
  });

  const privateKey = process.env.RELAYER_PRIVATE_KEY as `0x${string}` | undefined;
  if (!privateKey) {
    return { enabled: true, txHash: null, note: "Relayer prepared calldata; RELAYER_PRIVATE_KEY missing", mode: "prepared", calldata };
  }

  const account = privateKeyToAccount(privateKey);
  const chain = chainFor(decision.deployment?.chainId ?? mantleSepolia.id);
  const rpcUrl = process.env.MANTLE_RPC_URL ?? process.env.RPC_URL;
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const txHash = await wallet.writeContract({
    address: decisionLog,
    abi: DECISION_LOG_ABI,
    functionName: "logDecision",
    args: [agentId, decision.decisionHash, strategyIdToBytes32(decision.selectedOpportunity.strategyId), protocolAddress(), amount, decision.selectedOpportunity.riskLevel],
  });

  return { enabled: true, txHash, note: "DecisionLog transaction sent by backend relayer", mode: "sent" };
}
