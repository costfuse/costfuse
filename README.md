# costfuse

**A fuse box for your AI bill.**

Drop-in budget guardrails and runaway-loop kill switch for AI agents. Wrap your Anthropic or OpenAI client; costfuse kills requests before they spend money you didn't plan for, and writes an audit log you can hand to a regulator.

> Built after the LangChain agent that ran for 11 days and racked up **$47,000** in API charges, and the news that Uber burned its full 2026 AI R&D budget on Claude Code in 4 months.

## Install

```bash
npm install costfuse
```

## Use it

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrap } from "costfuse";

const claude = wrap(new Anthropic(), {
  maxSpendPerHour: 5.00,
  maxSamePromptInWindow: { count: 5, windowMs: 60_000 },
  maxCallsPerMinute: 60,
  auditLogPath: "./costfuse-audit.jsonl",
  onBlock: (e) => fetch(process.env.SLACK_WEBHOOK!, {
    method: "POST",
    body: JSON.stringify({ text: `[costfuse] ${e.reason}` }),
  }),
});

// Use it exactly like the original client:
await claude.messages.create({
  model: "claude-haiku-4-5",
  max_tokens: 200,
  messages: [{ role: "user", content: "Hello." }],
});
```

If a rule trips, the call throws `CostfuseBlocked` before any tokens are spent.

## Rules

| Rule | What it blocks |
| --- | --- |
| `maxSpendPerHour` | Hard USD cap in the last 60 minutes |
| `maxSpendPerDay` | Hard USD cap in the last 24 hours |
| `maxCallsPerMinute` | Rate limit |
| `maxSamePromptInWindow` | Same prompt fingerprint repeating — runaway-loop detection |
| `maxRecursionDepth` | Agent calling itself too deeply |

## Compliance

`auditLogPath` writes one JSON line per call. That file is your evidence trail for the **EU AI Act** (effective 2 Aug 2026) and the **Colorado AI Act** (effective Jun 2026), both of which require demonstrable kill-switch and human-oversight mechanisms.

## Recommended onboarding: log-only first, enforce later

For your first week, run with `killOnBreach: false`. Costfuse will observe and write the audit log without blocking anything. Look at the log, see what would have been killed in production, then turn enforcement on once the limits feel right.

```ts
const claude = wrap(new Anthropic(), {
  maxSpendPerHour: 10,
  killOnBreach: false,            // observe-only
  auditLogPath: "./costfuse-audit.jsonl",
});
```

## Local testing

Three test scripts ship with the repo. The first two require zero spend.

```bash
npm install
npm run test:mock     # zero spend (uses testMode)
npm run test:loop     # simulated runaway, zero spend
ANTHROPIC_API_KEY=sk-... npm run test:claude   # real calls, < $0.01 spend
```

## What's covered in v0.1 (and what's not yet)

**Covered**

- `client.messages.create({...})` for `@anthropic-ai/sdk`
- `client.chat.completions.create({...})` for `openai`
- Cost tracking for the model list in `src/index.ts` (Claude 3/3.5/4 family, GPT-4 / GPT-4o / GPT-3.5)

**Not yet covered (planned for v0.2)**

- **Streaming responses** — `messages.stream()` and `create({ stream: true })` return AsyncIterables that this proxy doesn't intercept. Use non-streaming for now if you need budget enforcement.
- **Models not in the built-in price table** — calls still go through and rules like `maxCallsPerMinute` and `maxSamePromptInWindow` still fire, but `maxSpendPerHour/Day` won't trigger because cost is calculated as 0. Override prices via the `pricePerMTokens` config option in the meantime.
- **Bedrock / Vertex / other proxied providers** — only direct Anthropic and OpenAI SDKs are tested in v0.1.

If any of these matter to you, please open an issue at https://github.com/costfuse/costfuse/issues — they'll be prioritized for v0.2.

## License

Apache-2.0
