/**
 * Mock test — runs in testMode (no real API call, no token spend).
 *
 *   npm run test:mock
 *
 * Exercises every rule and prints whether each one fired correctly.
 */

import { wrap, CostfuseBlocked, summarizeAudit } from "../src/index";
import * as path from "path";
import * as fs from "fs";

const auditPath = path.join(__dirname, "audit-mock.jsonl");
if (fs.existsSync(auditPath)) fs.unlinkSync(auditPath);

// Fake "Anthropic-shaped" client. Returns a fixed usage every call.
const fakeAnthropic = {
  messages: {
    async create(params: any) {
      return {
        id: "msg_fake",
        model: params.model,
        content: [{ type: "text", text: "ok" }],
        usage: { input_tokens: 1000, output_tokens: 500 },
      };
    },
  },
};

async function expectBlocked(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`FAIL  ${label} — expected block, got success`);
  } catch (e) {
    if (e instanceof CostfuseBlocked) {
      console.log(`PASS  ${label} — blocked: ${e.event.rule}`);
    } else {
      console.log(`FAIL  ${label} — wrong error:`, e);
    }
  }
}

async function expectOk(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    console.log(`PASS  ${label} — call succeeded`);
  } catch (e) {
    console.log(`FAIL  ${label} — unexpected block:`, e);
  }
}

async function main() {
  console.log("\n--- costfuse mock test ---\n");

  // Test 1: maxCallsPerMinute
  {
    const client = wrap(fakeAnthropic, {
      maxCallsPerMinute: 3,
      auditLogPath: auditPath,
      testMode: true,
    });
    await expectOk("call 1 of 3", () =>
      client.messages.create({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] })
    );
    await expectOk("call 2 of 3", () =>
      client.messages.create({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi 2" }] })
    );
    await expectOk("call 3 of 3", () =>
      client.messages.create({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi 3" }] })
    );
    await expectBlocked("call 4 should trip rate limit", () =>
      client.messages.create({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi 4" }] })
    );
  }

  // Test 2: maxSamePromptInWindow (loop detection)
  {
    const client = wrap(fakeAnthropic, {
      maxSamePromptInWindow: { count: 3, windowMs: 60_000 },
      auditLogPath: auditPath,
      testMode: true,
    });
    const sameMsg = [{ role: "user", content: "are we there yet?" }];
    await expectOk("loop call 1", () =>
      client.messages.create({ model: "claude-haiku-4-5", messages: sameMsg })
    );
    await expectOk("loop call 2", () =>
      client.messages.create({ model: "claude-haiku-4-5", messages: sameMsg })
    );
    await expectOk("loop call 3", () =>
      client.messages.create({ model: "claude-haiku-4-5", messages: sameMsg })
    );
    await expectBlocked("loop call 4 should trip", () =>
      client.messages.create({ model: "claude-haiku-4-5", messages: sameMsg })
    );
  }

  // Test 3: maxSpendPerHour
  {
    // Each test-mode call costs (50 input + 50 output) * haiku price = ~$0.0003
    // Set the cap below that to trigger after a few calls.
    const client = wrap(fakeAnthropic, {
      maxSpendPerHour: 0.0008,
      auditLogPath: auditPath,
      testMode: true,
    });
    let blocked = false;
    for (let i = 0; i < 10; i++) {
      try {
        await client.messages.create({
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: `query ${i}` }],
        });
      } catch (e) {
        if (e instanceof CostfuseBlocked) {
          console.log(`PASS  spend cap tripped on call ${i + 1}: ${e.event.reason}`);
          blocked = true;
          break;
        }
      }
    }
    if (!blocked) console.log("FAIL  spend cap never tripped");
  }

  // Test 4: onBlock callback fires (Slack/webhook hook point)
  {
    let captured: string | null = null;
    const client = wrap(fakeAnthropic, {
      maxCallsPerMinute: 1,
      onBlock: (e) => {
        captured = e.rule;
      },
      testMode: true,
    });
    await client.messages.create({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "x" }] });
    try {
      await client.messages.create({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "y" }] });
    } catch {
      /* ignore */
    }
    console.log(captured ? `PASS  onBlock callback fired: ${captured}` : "FAIL  onBlock did not fire");
  }

  // Print compliance summary
  console.log("\n--- Audit log summary (this is what you sell as 'compliance evidence') ---");
  console.log(summarizeAudit(auditPath));
  console.log(`\nFull log saved to: ${auditPath}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
