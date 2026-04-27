/**
 * Real-Claude test — uses your $10 API credit MINIMALLY.
 *
 *   ANTHROPIC_API_KEY=sk-... npm run test:claude
 *
 * Forces claude-haiku-4-5 (cheapest) and an artificially low spend cap so
 * the rule trips after a handful of tiny calls. Total expected spend: < $0.01.
 */

import Anthropic from "@anthropic-ai/sdk";
import { wrap, CostfuseBlocked, summarizeAudit } from "../src/index";
import * as path from "path";
import * as fs from "fs";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("Set ANTHROPIC_API_KEY before running.");
  process.exit(1);
}

const auditPath = path.join(__dirname, "audit-claude.jsonl");
if (fs.existsSync(auditPath)) fs.unlinkSync(auditPath);

const raw = new Anthropic();

const claude = wrap(raw, {
  // Haiku 4.5: $1 in / $5 out per 1M tokens. ~50 in + 30 out per call ~= $0.0002.
  // A $0.001 cap will fire after ~5 calls.
  maxSpendPerHour: 0.001,
  // Catch a tight loop quickly:
  maxSamePromptInWindow: { count: 2, windowMs: 60_000 },
  // Hard cap, just in case:
  maxCallsPerMinute: 20,
  auditLogPath: auditPath,
  actor: "local-test",
  onBlock: (e) =>
    console.log(`\n>>> Slack/webhook would fire here: ${e.rule} -- ${e.reason}\n`),
});

async function safeAsk(prompt: string) {
  try {
    const r = await claude.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 30,
      messages: [{ role: "user", content: prompt }],
    });
    const text = (r.content[0] as any).text ?? "";
    console.log(`OK   "${prompt.slice(0, 30)}..." -> ${text.slice(0, 60)}`);
  } catch (e) {
    if (e instanceof CostfuseBlocked) {
      console.log(`STOP "${prompt.slice(0, 30)}..." blocked by ${e.event.rule}`);
    } else {
      throw e;
    }
  }
}

async function main() {
  console.log("\n--- costfuse LIVE Claude test (Haiku, ultra-low caps) ---\n");

  // Phase 1: a few normal calls — should succeed and accumulate cost.
  await safeAsk("Say 'hello' in one word.");
  await safeAsk("Say 'world' in one word.");
  await safeAsk("Say 'tripwire' in one word.");
  await safeAsk("Say 'works' in one word.");
  await safeAsk("Say 'great' in one word.");

  // Phase 2: same prompt twice quickly — should trip loop detection.
  console.log("\n[Now firing the same prompt repeatedly to trigger loop detection]");
  await safeAsk("repeat-prompt-loop-test");
  await safeAsk("repeat-prompt-loop-test");
  await safeAsk("repeat-prompt-loop-test"); // expected: BLOCKED

  // Phase 3: keep firing — should hit the spend cap.
  console.log("\n[Now firing varied prompts until spend cap trips]");
  for (let i = 0; i < 10; i++) {
    await safeAsk(`varied-${i}: tell me a one-word fact.`);
  }

  console.log("\n--- Compliance summary (the thing you sell) ---");
  console.log(summarizeAudit(auditPath));
  console.log(`\nAudit log: ${auditPath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
