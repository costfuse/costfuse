/**
 * Simulated runaway-agent test — fakes a $47k LangChain-style retry loop
 * using Haiku and a fake-loop client. Burns approximately $0 of real money.
 *
 *   npm run test:loop
 *
 * Demonstrates the headline value prop: costfuse kills the loop before it spends.
 */

import { wrap, CostfuseBlocked } from "../src/index";

let realCalls = 0;

const exhaustedAgent = {
  messages: {
    async create(_params: any) {
      realCalls++;
      // Simulate the agent always replying with the same "I need clarification"
      return {
        id: `msg_${realCalls}`,
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "I need clarification on the previous step." }],
        // Pretend each call costs ~$0.20 (a real Opus loop would)
        usage: { input_tokens: 8000, output_tokens: 800 },
      };
    },
  },
};

const guarded = wrap(exhaustedAgent, {
  maxSpendPerHour: 1.0, // hard cap: $1 / hour
  maxSamePromptInWindow: { count: 3, windowMs: 60_000 },
  onBlock: (e) =>
    console.log(`\n*** COSTFUSE FIRED *** ${e.rule}: ${e.reason}\n`),
});

async function main() {
  console.log("\n--- Simulated runaway loop ---");
  console.log("An unprotected agent in this state would burn ~$0.20/call");
  console.log("Without costfuse: 250 calls = $50, 2350 calls = $470, overnight = $5,000+\n");

  let blocked = 0;
  for (let i = 0; i < 50; i++) {
    try {
      await guarded.messages.create({
        model: "claude-opus-4-7",
        messages: [{ role: "user", content: "Same prompt every iteration." }],
      });
    } catch (e) {
      if (e instanceof CostfuseBlocked) {
        blocked++;
        if (blocked === 1) {
          console.log(`>>> First block at call ${i + 1}. Loop stopped.`);
          console.log(`>>> Money saved (vs unprotected): ~$${((50 - (i + 1)) * 0.2).toFixed(2)}`);
          break;
        }
      }
    }
  }

  console.log(`\nReal API calls that fired: ${realCalls} of 50 attempted.`);
  console.log("Costfuse blocked the rest before they spent money.\n");
}

main();
