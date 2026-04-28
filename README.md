# costfuse

> **A fuse box for your AI bill.** Drop-in spend protection and runaway-loop circuit breaker for AI agents.
>
> Wrap your Anthropic or OpenAI client → set spend caps + loop limits → costfuse kills requests *before* they spend money you didn't plan for.
>
> **Building AI for clients?** Jump to the [agency setup](#for-ai-agencies--consultancies-multi-client-setup) for per-client budget caps and audit logs.

[![npm](https://img.shields.io/npm/v/costfuse.svg)](https://www.npmjs.com/package/costfuse)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node + Python](https://img.shields.io/badge/SDKs-Node%20%2B%20Python-brightgreen.svg)](#install)

---

## Why this exists

In November 2025, a LangChain agent ran in a retry loop for **11 days** and racked up **$47,000** in API charges. In April 2026, Uber burned its full 2026 AI R&D budget on Claude Code in 4 months. Anthropic pulled Claude Code from the $20 Pro plan because users were costing more than they paid.

Existing tools (Helicone, Langfuse, Sentrial) **show you what already happened**. They don't stop the spend in the moment.

Costfuse is the **circuit breaker** for that exact problem. Three lines, no proxy, no infrastructure.

---

## The 60-second pitch

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrap } from "costfuse";

const claude = wrap(new Anthropic(), {
  maxSpendPerHour: 5.00,                                 // hard $ cap
  maxSamePromptInWindow: { count: 5, windowMs: 60_000 }, // catches runaway loops
  maxCallsPerMinute: 60,
  auditLogPath: "./costfuse-audit.jsonl",
});

// Use it exactly like the original client.
// If a rule trips, the call throws BEFORE any tokens are spent.
await claude.messages.create({ ... });
```

That's it. Apache-2.0, free forever, no signup.

---

## How it works (the picture)

```
┌─────────────────┐    ┌─────────────────┐    ┌──────────────┐
│  your code      │───▶│   costfuse      │───▶│  Anthropic   │
│                 │    │                 │    │  / OpenAI    │
│  claude.msgs    │    │   ✓ check rules │    │              │
│  .create({...}) │    │   ✗ kill on     │    └──────────────┘
└─────────────────┘    │     breach      │
                       │   ✏ audit log   │
                       └─────────────────┘
                              │
                              ▼
                       costfuse-audit.jsonl
                       (compliance evidence)
```

If any rule trips before the call, costfuse throws `CostfuseBlocked` — your code can catch this, fall back to a cheaper model, queue for later, or surface "rate limit hit" to your end-user. **Tokens are never spent.**

---

## The 5 rules

| Rule | What it blocks |
| --- | --- |
| `maxSpendPerHour` | Hard USD cap in the last 60 minutes |
| `maxSpendPerDay` | Hard USD cap in the last 24 hours |
| `maxCallsPerMinute` | Rate limit |
| `maxSamePromptInWindow` | Same prompt fingerprint repeating — **runaway-loop detection**. This is the killer rule. |
| `maxRecursionDepth` | Agent calling itself too deeply |

The `maxSamePromptInWindow` rule is the one that catches the $47k horror story. Each individual call passes a normal rate limit; **the aggregate is what kills you**. Costfuse fingerprints prompts and counts repeats — when the same prompt fires N times in a window, the loop is killed.

---

## How costfuse compares

| | Anthropic / OpenAI native | Helicone / Langfuse | Salus / Sentrial | **costfuse** |
|---|---|---|---|---|
| **Spend caps per hour** | ❌ monthly only | ❌ alerts only | ⚠️ side feature | ✅ |
| **Loop detection (aggregate same-prompt)** | ❌ | ❌ | ⚠️ side feature | ✅ headline feature |
| **Per-end-user budgets** | ❌ | ❌ | ❌ | ✅ (paid tier) |
| **Throws BEFORE the call** | ❌ returns 429 after | ❌ logs after | ✅ | ✅ |
| **Cross-provider unified config** | ❌ | partial | partial | ✅ |
| **Drop-in SDK (no proxy infra)** | n/a | ❌ proxy | ✅ pip install | ✅ npm + pip |
| **Both Python AND Node** | n/a | partial | ❌ Python only | ✅ |
| **Audit log designed for compliance** | ❌ | ❌ | ❌ | ✅ |
| **Free OSS forever** | n/a | partial | ❌ paid | ✅ Apache-2.0 |
| **CLI for log analysis** | ❌ | ❌ | ❌ | ✅ |

We're the **specialist** for spend protection. Other tools do parts of this; nobody focuses on it as the headline feature.

---

## Install

### Node / TypeScript

```bash
npm install costfuse
```

### Python

```bash
pip install costfuse
```

Both have full feature parity. Same rules, same audit log format, same CLI.

---

## For AI agencies & consultancies (multi-client setup)

If you're an agency running AI projects for multiple clients, the `actor` field separates audit logs and budgets per client. Each client gets their own:

- Hard budget cap (so one client's runaway agent doesn't eat your project margin)
- Isolated audit log (clean handoff at project end)
- Per-client cost summary (use the CLI to generate a one-line report)

```ts
// Wrap the same client per project, tagging each call with the client ID
const claude = wrap(new Anthropic(), {
  maxSpendPerHour: 10.00,
  auditLogPath: `./logs/${clientId}-audit.jsonl`,
  actor: clientId,                        // e.g. "acme-corp"
});

await claude.messages.create({ ... });
```

At project handoff:

```bash
npx costfuse stats ./logs/acme-corp-audit.jsonl
```

You hand the client a clean usage report. They keep the audit log for their own compliance / records. Margin protection + professional handoff in one.

---

## Examples

### Node — wrap Anthropic

```ts
import Anthropic from "@anthropic-ai/sdk";
import { wrap, CostfuseBlocked } from "costfuse";

const claude = wrap(new Anthropic(), {
  maxSpendPerHour: 5.00,
  maxSamePromptInWindow: { count: 5, windowMs: 60_000 },
  auditLogPath: "./costfuse-audit.jsonl",
  onBlock: (e) => fetch(process.env.SLACK_WEBHOOK!, {
    method: "POST",
    body: JSON.stringify({ text: `[costfuse] ${e.reason}` }),
  }),
});

try {
  const reply = await claude.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 200,
    messages: [{ role: "user", content: "Hi." }],
  });
} catch (e) {
  if (e instanceof CostfuseBlocked) {
    // Fall back / queue / tell the end-user
    return "AI rate limit hit, please try again in an hour.";
  }
  throw e;
}
```

### Python — wrap Anthropic

```python
from anthropic import Anthropic
from costfuse import wrap, CostfuseConfig, CostfuseBlocked

claude = wrap(Anthropic(), CostfuseConfig(
    max_spend_per_hour=5.00,
    max_same_prompt_in_window={"count": 5, "window_ms": 60_000},
    audit_log_path="./costfuse-audit.jsonl",
))

try:
    claude.messages.create(model="claude-haiku-4-5", max_tokens=200,
                           messages=[{"role": "user", "content": "Hi."}])
except CostfuseBlocked as e:
    # Fall back / queue / surface error
    print(f"Blocked by rule {e.event.rule}")
```

### Wrap OpenAI

Same `wrap` works on the OpenAI client:

```ts
import OpenAI from "openai";
import { wrap } from "costfuse";

const oai = wrap(new OpenAI(), { maxSpendPerHour: 5.00 });
await oai.chat.completions.create({ model: "gpt-4o-mini", messages: [...] });
```

---

## Recommended onboarding: log-only first, enforce later

Your first week, run with `killOnBreach: false`. Costfuse will observe and write the audit log without blocking anything. Look at the log, see what *would* have been killed in production, then turn enforcement on once the limits feel right.

```ts
const claude = wrap(new Anthropic(), {
  maxSpendPerHour: 10,
  killOnBreach: false,            // observe-only
  auditLogPath: "./costfuse-audit.jsonl",
});
```

---

## CLI — analyse your audit log

After logs accumulate, summarise with the included CLI:

```bash
npx costfuse stats ./costfuse-audit.jsonl
```

Output:

```
┌─────────────────────────────────────────────────────┐
│  costfuse — audit summary                           │
└─────────────────────────────────────────────────────┘

  File: ./costfuse-audit.jsonl
  Period: 2026-04-27T04:09:02.037Z
        → 2026-04-27T04:09:02.045Z

  Total events: 12
  Blocked:      3  (25.0%)
  Successful:   9

  Total spend: $0.002700

  Block reasons:
    maxCallsPerMinute            1
    maxSamePromptInWindow        1
    maxSpendPerHour              1

  Spend by model:
    claude-haiku-4-5             9 calls   $0.002700
```

Other commands:

```bash
npx costfuse tail ./costfuse-audit.jsonl -n 50    # last 50 events
npx costfuse top  ./costfuse-audit.jsonl          # most-frequent block reasons
```

---

## What's covered in v0.2 (and what's not yet)

**Covered:**
- `client.messages.create({...})` for `@anthropic-ai/sdk` (Node) / `anthropic` (Python)
- `client.chat.completions.create({...})` for `openai` (Node + Python)
- All 5 rules with full feature parity between Node and Python
- Cost tracking for the model list in `src/index.ts` (Claude 3/3.5/4 family, GPT-4 / GPT-4o / GPT-3.5)
- JSONL audit log + CLI for inspection

**Not yet covered (planned for v0.3):**
- **Streaming responses** — `messages.stream()` and `create({ stream: true })` return AsyncIterables that aren't yet intercepted. Use non-streaming for now if you need budget enforcement.
- **Models not in the built-in price table** — calls still go through and rules like `maxCallsPerMinute` and `maxSamePromptInWindow` still fire, but `maxSpendPerHour/Day` won't trigger because cost is calculated as 0. Override prices via `pricePerMTokens` config in the meantime.
- **Bedrock / Vertex / other proxied providers** — only direct Anthropic and OpenAI SDKs are tested in v0.2.
- **Embedding-similarity loop detection** (currently exact prompt-hash match only)
- **Tool-use cost tracking** (when agents invoke tools that themselves cost money)

If any of these matter to you, please open an issue at https://github.com/costfuse/costfuse/issues — they'll be prioritized for v0.3.

---

## Compliance — honest positioning

Costfuse provides **one component** of an AI compliance program: an automatic, timestamped halt mechanism with audit log. This is a foundational requirement of:

- **EU AI Act** Article 12 (logging) and Article 14 (human oversight + halt mechanism) — effective 2 Aug 2026
- **Colorado SB-205** (effective Jun 2026) — mandates risk management for high-risk AI systems
- **California AI Transparency Act** (effective Jan 2026) and pending Accountability Act
- Equivalent frameworks coming in Australia, Canada, and the UK

**Costfuse is NOT a complete compliance solution.** It does not cover:
- Algorithmic discrimination / bias testing (Colorado's main requirement)
- Impact assessments (Colorado, California)
- Training data documentation (developer obligations)
- 6-month log retention (free SDK is local file; hosted tier solves this)
- Restart authorization workflows (Article 14)

It IS a useful building block for the technical halt + log requirement. For full compliance, combine with bias-testing tools, impact assessment templates, and a hosted retention service.

---

## Free vs paid

The SDK is **free, open-source, Apache-2.0, forever.** Most of you will never need anything else.

A paid hosted tier is planned for the moment you have:
- Multiple servers and want centralised logs
- Multiple end-users and want per-user budgets (multi-tenant)
- An auditor asking for 6 months of signed audit-chain evidence
- A team that needs Slack/PagerDuty alerts wired up
- Anomaly detection across historical data

If you'd want any of that, [open an issue](https://github.com/costfuse/costfuse/issues) saying "I'd pay for hosted X" — that's how I'm prioritizing what to build.

---

## Local testing

Three test scripts ship in each language. All except the live test require zero token spend.

### Node

```bash
git clone https://github.com/costfuse/costfuse
cd costfuse
npm install
npm run test:mock     # zero spend, exercises all 4 rules
npm run test:loop     # simulated runaway, zero spend
ANTHROPIC_API_KEY=sk-... npm run test:claude   # real calls, < $0.01 spend
```

### Python

```bash
cd python
pip install -e ".[dev]"
python examples/mock_test.py         # zero spend
python examples/loop_test.py         # zero spend
ANTHROPIC_API_KEY=sk-... python examples/claude_test.py
```

---

## License

Apache-2.0. Use it, fork it, ship it.

---

## Status / contributing

Solo-built, validation phase, will respond to every issue and PR within 24 hours. If you've ever had a "what happened to my AI bill?" morning, file an issue with the story — I'm collecting them for the README.
