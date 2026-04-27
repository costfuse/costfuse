/**
 * costfuse — a fuse box for your AI bill.
 *
 * Drop-in budget guardrails and runaway-loop kill switch for AI agents.
 * Wrap your Anthropic or OpenAI client; Costfuse intercepts every call,
 * enforces budget/loop/recursion rules, writes an audit log, and kills
 * requests before they spend money you didn't plan for.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

// ---------- Public types ----------

export interface CostfuseConfig {
  /** Hard cap on USD spent in any rolling 60-minute window. */
  maxSpendPerHour?: number;

  /** Hard cap on USD spent in any rolling 24-hour window. */
  maxSpendPerDay?: number;

  /** Max API calls allowed per rolling 60-second window. */
  maxCallsPerMinute?: number;

  /**
   * Loop-detection rule. Blocks a call when the same prompt fingerprint has
   * already been sent `count` times within `windowMs` milliseconds.
   */
  maxSamePromptInWindow?: { count: number; windowMs: number };

  /** Max nested wrap-call recursion depth (an agent calling itself). */
  maxRecursionDepth?: number;

  /** When true (default), a breach throws CostfuseBlocked. When false, returns null. */
  killOnBreach?: boolean;

  /** Append-only audit log path (JSON Lines). Used for compliance evidence. */
  auditLogPath?: string;

  /** Override built-in token prices (USD per 1M tokens). */
  pricePerMTokens?: Record<string, { input: number; output: number }>;

  /** Callback fired on every block (Slack/email/webhook hook point). */
  onBlock?: (event: BlockEvent) => void;

  /** When true, no real network call is made — useful for unit tests. */
  testMode?: boolean;

  /** Identifier written to audit log (e.g. user id, tenant id). */
  actor?: string;
}

export interface BlockEvent {
  rule: string;
  reason: string;
  timestamp: string;
  actor?: string;
  context?: Record<string, unknown>;
}

export class CostfuseBlocked extends Error {
  constructor(public event: BlockEvent) {
    super(`[costfuse] ${event.reason}`);
    this.name = "CostfuseBlocked";
  }
}

// ---------- Built-in pricing (April 2026 list prices, USD per 1M tokens) ----------

const DEFAULT_PRICES: Record<string, { input: number; output: number }> = {
  // Anthropic
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-opus-4-7[1m]": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  // OpenAI
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10, output: 30 },
  "gpt-4": { input: 30, output: 60 },
  "gpt-3.5-turbo": { input: 0.5, output: 1.5 },
};

// ---------- Internal state ----------

interface Usage {
  ts: number;
  cost: number;
  promptHash: string;
}

class State {
  usages: Usage[] = [];
  callTimes: number[] = [];

  recordCall(promptHash: string) {
    const now = Date.now();
    this.callTimes.push(now);
    // record a placeholder usage with cost 0; cost is updated post-response
    this.usages.push({ ts: now, cost: 0, promptHash });
    this.prune();
  }

  recordCost(cost: number) {
    if (this.usages.length > 0) {
      this.usages[this.usages.length - 1].cost += cost;
    }
  }

  spentInLastMs(ms: number): number {
    const cutoff = Date.now() - ms;
    return this.usages.filter((u) => u.ts > cutoff).reduce((s, u) => s + u.cost, 0);
  }

  callsInLastMs(ms: number): number {
    const cutoff = Date.now() - ms;
    return this.callTimes.filter((t) => t > cutoff).length;
  }

  samePromptInLastMs(hash: string, ms: number): number {
    const cutoff = Date.now() - ms;
    return this.usages.filter((u) => u.ts > cutoff && u.promptHash === hash).length;
  }

  private prune() {
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    this.usages = this.usages.filter((u) => u.ts > dayAgo);
    this.callTimes = this.callTimes.filter((t) => t > dayAgo);
  }
}

// ---------- Audit log ----------

function appendAudit(p: string | undefined, entry: Record<string, unknown>) {
  if (!p) return;
  try {
    const dir = path.dirname(p);
    if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // never let audit-log failure break the wrapped call
  }
}

// ---------- Helpers ----------

function hashPrompt(params: any): string {
  const payload = JSON.stringify(params?.messages ?? params?.input ?? params ?? "");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

function computeCost(
  response: any,
  model: string | undefined,
  prices: Record<string, { input: number; output: number }>
): number {
  const usage = response?.usage;
  if (!usage || !model) return 0;
  const price = prices[model];
  if (!price) return 0;
  const inTok = usage.input_tokens ?? usage.prompt_tokens ?? 0;
  const outTok = usage.output_tokens ?? usage.completion_tokens ?? 0;
  return (inTok / 1_000_000) * price.input + (outTok / 1_000_000) * price.output;
}

// ---------- Rule engine ----------

function checkRules(
  state: State,
  config: CostfuseConfig,
  promptHash: string,
  recursionDepth: number
): BlockEvent | null {
  const ts = new Date().toISOString();

  if (config.maxSpendPerHour !== undefined) {
    const spent = state.spentInLastMs(60 * 60 * 1000);
    if (spent >= config.maxSpendPerHour) {
      return {
        rule: "maxSpendPerHour",
        reason: `Spent $${spent.toFixed(4)} in last hour, limit $${config.maxSpendPerHour}`,
        timestamp: ts,
        actor: config.actor,
        context: { spent, limit: config.maxSpendPerHour },
      };
    }
  }

  if (config.maxSpendPerDay !== undefined) {
    const spent = state.spentInLastMs(24 * 60 * 60 * 1000);
    if (spent >= config.maxSpendPerDay) {
      return {
        rule: "maxSpendPerDay",
        reason: `Spent $${spent.toFixed(4)} in last 24h, limit $${config.maxSpendPerDay}`,
        timestamp: ts,
        actor: config.actor,
        context: { spent, limit: config.maxSpendPerDay },
      };
    }
  }

  if (config.maxCallsPerMinute !== undefined) {
    const calls = state.callsInLastMs(60 * 1000);
    if (calls >= config.maxCallsPerMinute) {
      return {
        rule: "maxCallsPerMinute",
        reason: `${calls} calls in last minute, limit ${config.maxCallsPerMinute}`,
        timestamp: ts,
        actor: config.actor,
        context: { calls, limit: config.maxCallsPerMinute },
      };
    }
  }

  if (config.maxSamePromptInWindow) {
    const same = state.samePromptInLastMs(promptHash, config.maxSamePromptInWindow.windowMs);
    if (same >= config.maxSamePromptInWindow.count) {
      return {
        rule: "maxSamePromptInWindow",
        reason: `Same prompt fingerprint fired ${same + 1} times — likely runaway loop`,
        timestamp: ts,
        actor: config.actor,
        context: { promptHash, count: same + 1 },
      };
    }
  }

  if (config.maxRecursionDepth !== undefined && recursionDepth >= config.maxRecursionDepth) {
    return {
      rule: "maxRecursionDepth",
      reason: `Recursion depth ${recursionDepth} reached limit ${config.maxRecursionDepth}`,
      timestamp: ts,
      actor: config.actor,
      context: { recursionDepth },
    };
  }

  return null;
}

// ---------- Public API ----------

/**
 * Wrap an Anthropic or OpenAI client. Returns a proxy that enforces the rules
 * before forwarding each request.
 */
export function wrap<T extends object>(client: T, config: CostfuseConfig = {}): T {
  const state = new State();
  const prices = { ...DEFAULT_PRICES, ...(config.pricePerMTokens ?? {}) };
  let recursionDepth = 0;

  const wrappedCreate = (target: any, methodName: string) => {
    const original = target[methodName];
    if (typeof original !== "function") return original;

    return async function (...args: any[]) {
      const params = args[0] ?? {};
      const promptHash = hashPrompt(params);

      const breach = checkRules(state, config, promptHash, recursionDepth);
      if (breach) {
        appendAudit(config.auditLogPath, { ...breach, blocked: true });
        config.onBlock?.(breach);
        // eslint-disable-next-line no-console
        console.warn(`\x1b[33m[costfuse] BLOCKED: ${breach.reason}\x1b[0m`);
        if (config.killOnBreach !== false) {
          throw new CostfuseBlocked(breach);
        }
        return null;
      }

      state.recordCall(promptHash);

      if (config.testMode) {
        const fake = {
          content: [{ type: "text", text: "[costfuse test mode]" }],
          choices: [{ message: { content: "[costfuse test mode]" } }],
          usage: { input_tokens: 50, output_tokens: 50, prompt_tokens: 50, completion_tokens: 50 },
          model: params.model,
        };
        const cost = computeCost(fake, params.model, prices);
        state.recordCost(cost);
        appendAudit(config.auditLogPath, {
          rule: "usage",
          timestamp: new Date().toISOString(),
          actor: config.actor,
          model: params.model,
          cost,
          testMode: true,
          blocked: false,
        });
        return fake;
      }

      recursionDepth++;
      try {
        const response = await original.apply(target, args);
        const cost = computeCost(response, params.model, prices);
        state.recordCost(cost);
        appendAudit(config.auditLogPath, {
          rule: "usage",
          timestamp: new Date().toISOString(),
          actor: config.actor,
          model: params.model,
          cost,
          input_tokens: response?.usage?.input_tokens ?? response?.usage?.prompt_tokens ?? 0,
          output_tokens: response?.usage?.output_tokens ?? response?.usage?.completion_tokens ?? 0,
          blocked: false,
        });
        return response;
      } finally {
        recursionDepth--;
      }
    };
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // Anthropic shape: client.messages.create
      if (prop === "messages" && value && typeof value === "object") {
        return new Proxy(value, {
          get(t, p, r) {
            const inner = Reflect.get(t, p, r);
            if (p === "create") return wrappedCreate(t, "create");
            return typeof inner === "function" ? inner.bind(t) : inner;
          },
        });
      }

      // OpenAI shape: client.chat.completions.create
      if (prop === "chat" && value && typeof value === "object") {
        return new Proxy(value, {
          get(t, p, r) {
            const inner = Reflect.get(t, p, r);
            if (p === "completions" && inner && typeof inner === "object") {
              return new Proxy(inner, {
                get(tt, pp, rr) {
                  const innerFn = Reflect.get(tt, pp, rr);
                  if (pp === "create") return wrappedCreate(tt, "create");
                  return typeof innerFn === "function" ? innerFn.bind(tt) : innerFn;
                },
              });
            }
            return typeof inner === "function" ? inner.bind(t) : inner;
          },
        });
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

/**
 * Generate a simple summary report from an audit log file (compliance preview).
 */
export function summarizeAudit(auditLogPath: string): {
  totalCalls: number;
  totalBlocked: number;
  totalCostUsd: number;
  byRule: Record<string, number>;
  firstEvent: string | null;
  lastEvent: string | null;
} {
  const out = {
    totalCalls: 0,
    totalBlocked: 0,
    totalCostUsd: 0,
    byRule: {} as Record<string, number>,
    firstEvent: null as string | null,
    lastEvent: null as string | null,
  };
  if (!fs.existsSync(auditLogPath)) return out;
  const lines = fs.readFileSync(auditLogPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    out.totalCalls++;
    if (entry.blocked) out.totalBlocked++;
    if (typeof entry.cost === "number") out.totalCostUsd += entry.cost;
    if (entry.rule) out.byRule[entry.rule] = (out.byRule[entry.rule] ?? 0) + 1;
    if (!out.firstEvent) out.firstEvent = entry.timestamp ?? null;
    out.lastEvent = entry.timestamp ?? out.lastEvent;
  }
  return out;
}
