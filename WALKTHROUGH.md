# costfuse — Local Walkthrough

This is the step-by-step install and demo experience. Follow it once to:
1. Confirm everything works on your machine
2. Get a feel for the user experience
3. Record a screen-recording demo (optional but recommended for launch posts)

**Total time: ~15 minutes if Python is already installed, ~20 min if not.**

---

## What you'll demo by the end

A user installs costfuse → wraps a fake Anthropic client → triggers all 5 rules → views the audit log → uses the CLI to summarise it.

**No real API spend** in this walkthrough — everything uses the built-in `testMode` flag.

---

## Part 1 — Node SDK demo (5 minutes)

### Step 1.1 — Make a fresh project folder

Open a new Git Bash terminal (or PowerShell) and run:

```bash
mkdir costfuse-demo
cd costfuse-demo
npm init -y
```

You'll see a `package.json` created. That's the start of a fresh project.

### Step 1.2 — Install costfuse from npm (the real registry, public)

```bash
npm install costfuse @anthropic-ai/sdk
```

Should take ~10 seconds. After install, peek at `node_modules/costfuse/` — that's the real package downloaded from the npm registry.

### Step 1.3 — Write a 30-line demo script

Create `demo.mjs`:

```js
import Anthropic from "@anthropic-ai/sdk";
import { wrap, CostfuseBlocked, summarizeAudit } from "costfuse";

// Wrap the real Anthropic client. `testMode: true` means no real network calls.
const claude = wrap(new Anthropic({ apiKey: "sk-ant-fake" }), {
  maxCallsPerMinute: 3,
  maxSamePromptInWindow: { count: 2, windowMs: 60_000 },
  maxSpendPerHour: 0.001,
  auditLogPath: "./costfuse-audit.jsonl",
  actor: "demo-user",
  testMode: true,
  onBlock: (e) => console.log(`*** ALERT *** ${e.rule}: ${e.reason}`),
});

async function safeAsk(label, content) {
  try {
    await claude.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 30,
      messages: [{ role: "user", content }],
    });
    console.log(`OK    ${label}`);
  } catch (e) {
    if (e instanceof CostfuseBlocked) {
      console.log(`STOP  ${label} — ${e.event.rule}`);
    } else {
      throw e;
    }
  }
}

console.log("\n=== firing 5 normal calls (rate limit will trip on 4th) ===\n");
await safeAsk("call 1", "hello");
await safeAsk("call 2", "hi there");
await safeAsk("call 3", "good morning");
await safeAsk("call 4", "how are you");          // expect: STOP rate limit
await safeAsk("call 5", "another one");          // expect: STOP rate limit

console.log("\n=== summary of the audit log ===\n");
console.log(summarizeAudit("./costfuse-audit.jsonl"));
```

### Step 1.4 — Run it

```bash
node demo.mjs
```

Expected output:

```
=== firing 5 normal calls (rate limit will trip on 4th) ===

OK    call 1
OK    call 2
OK    call 3
*** ALERT *** maxCallsPerMinute: 3 calls in last minute, limit 3
[costfuse] BLOCKED: 3 calls in last minute, limit 3
STOP  call 4 — maxCallsPerMinute
*** ALERT *** maxCallsPerMinute: 3 calls in last minute, limit 3
[costfuse] BLOCKED: 3 calls in last minute, limit 3
STOP  call 5 — maxCallsPerMinute

=== summary of the audit log ===
{
  totalCalls: 5,
  totalBlocked: 2,
  totalCostUsd: 0.0009,
  byRule: { usage: 3, maxCallsPerMinute: 2 },
  ...
}
```

✅ The kill works in real time. The audit log captures everything.

### Step 1.5 — Inspect the audit log with the CLI

```bash
npx costfuse stats ./costfuse-audit.jsonl
```

You'll see a pretty summary:

```
┌─────────────────────────────────────────────────────┐
│  costfuse — audit summary                           │
└─────────────────────────────────────────────────────┘

  File: ./costfuse-audit.jsonl
  Period: 2026-04-27T...
        → 2026-04-27T...

  Total events: 5
  Blocked:      2  (40.0%)
  Successful:   3

  Total spend: $0.000900

  Block reasons:
    maxCallsPerMinute            2
```

```bash
npx costfuse tail ./costfuse-audit.jsonl -n 5     # last 5 events
npx costfuse top ./costfuse-audit.jsonl           # top block reasons
```

**That's the full Node experience.** Three commands, no actual API spend, and you can see exactly what's happening.

---

## Part 2 — Python SDK demo (5 minutes)

If you don't have Python yet, install Python 3.11 or newer from https://www.python.org/downloads/ — pick the Windows installer, tick "Add Python to PATH" during install.

Verify it's installed:

```bash
python --version    # should print Python 3.11.x or 3.12.x
pip --version
```

### Step 2.1 — Fresh Python project

```bash
mkdir costfuse-py-demo
cd costfuse-py-demo
python -m venv venv
source venv/Scripts/activate     # Git Bash on Windows
# or: venv\Scripts\activate      # PowerShell on Windows
```

### Step 2.2 — Install costfuse from PyPI

```bash
pip install costfuse anthropic
```

### Step 2.3 — Write the same demo in Python

Create `demo.py`:

```python
from anthropic import Anthropic
from costfuse import wrap, CostfuseConfig, CostfuseBlocked, summarize_audit

claude = wrap(Anthropic(api_key="sk-ant-fake"), CostfuseConfig(
    max_calls_per_minute=3,
    max_same_prompt_in_window={"count": 2, "window_ms": 60_000},
    max_spend_per_hour=0.001,
    audit_log_path="./costfuse-audit.jsonl",
    actor="demo-user",
    test_mode=True,
    on_block=lambda e: print(f"*** ALERT *** {e.rule}: {e.reason}"),
))


def safe_ask(label, content):
    try:
        claude.messages.create(
            model="claude-haiku-4-5",
            max_tokens=30,
            messages=[{"role": "user", "content": content}],
        )
        print(f"OK    {label}")
    except CostfuseBlocked as e:
        print(f"STOP  {label} — {e.event.rule}")


print("\n=== firing 5 normal calls (rate limit will trip on 4th) ===\n")
safe_ask("call 1", "hello")
safe_ask("call 2", "hi there")
safe_ask("call 3", "good morning")
safe_ask("call 4", "how are you")
safe_ask("call 5", "another one")

print("\n=== summary of the audit log ===\n")
print(summarize_audit("./costfuse-audit.jsonl"))
```

### Step 2.4 — Run it

```bash
python demo.py
```

Same output structure as Node. **Same audit log format** — you can analyse it with the Node CLI:

```bash
npx costfuse stats ./costfuse-audit.jsonl
```

Same JSON, same CLI. Cross-language compatible.

---

## Part 3 — The runaway-loop demo (3 minutes)

This is the demo that sells the product. Shows costfuse killing a $5,000 overnight loop.

### Step 3.1 — Use the simulation that ships with the repo

```bash
git clone https://github.com/costfuse/costfuse
cd costfuse
npm install
npm run test:loop
```

You'll see:

```
--- Simulated runaway loop ---
An unprotected agent in this state would burn ~$0.20/call
Without costfuse: 250 calls = $50, 2350 calls = $470, overnight = $5,000+

*** COSTFUSE FIRED *** maxSamePromptInWindow: Same prompt fingerprint fired 4 times — likely runaway loop
[costfuse] BLOCKED: Same prompt fingerprint fired 4 times — likely runaway loop
>>> First block at call 4. Loop stopped.
>>> Money saved (vs unprotected): ~$9.20

Real API calls that fired: 3 of 50 attempted.
Costfuse blocked the rest before they spent money.
```

**This is the 30-second demo for any launch post.** Record this screen.

---

## Part 4 — What to record (for launch video)

If you're recording a screen demo for the launch posts:

| Scene | Duration | What it shows |
|---|---|---|
| 1. Title card | 3 sec | "costfuse — a fuse box for your AI bill" |
| 2. Problem | 8 sec | Quote: "$47,000 LangChain agent" + "Uber's full 2026 budget gone in 4 months" |
| 3. Install | 5 sec | `npm install costfuse` running in terminal |
| 4. The 3-line wrap | 8 sec | Code editor showing the `wrap()` call |
| 5. Run the demo | 12 sec | Run `npm run test:loop` — show the kill happen + "Money saved: ~$9.20" |
| 6. CLI stats | 8 sec | Run `npx costfuse stats` — show the audit summary |
| 7. Closing | 6 sec | "Free. Apache 2.0. github.com/costfuse/costfuse" |

**Total: ~50 seconds.** Perfect length for X / LinkedIn / Show HN.

Tools for recording: OBS Studio (free), Loom (free tier), Windows Snipping Tool's screen recorder.

---

## What to do if something doesn't work

| Problem | Fix |
|---|---|
| `npm install costfuse` fails with 404 | We may not be published yet — check https://www.npmjs.com/package/costfuse |
| `pip install costfuse` fails | Same — Python version may not be on PyPI yet |
| `node demo.mjs` errors with "Cannot use import" | Make sure file is named `demo.mjs` not `demo.js` (or add `"type": "module"` to package.json) |
| Audit log doesn't appear | Check the path you set is writable (no `/restricted` paths) |
| Test mode response shape isn't quite right | This is a known limitation in v0.2 — open an issue, will fix |

---

## Done?

If you got through this and everything worked, you've experienced the user journey. **That's exactly what someone landing from Show HN will do.** If anything was confusing or felt clunky, that's a launch-blocker — flag it.

Reply with:
- ✅ Worked smoothly → ship it Monday
- ⚠️ One thing was confusing → tell me what and we fix
- ❌ Major issue → we hold the launch and fix it
