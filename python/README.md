# costfuse (Python)

**A fuse box for your AI bill.**

Drop-in budget guardrails and runaway-loop kill switch for AI agents. Wrap your Anthropic or OpenAI client; costfuse kills requests before they spend money you didn't plan for, and writes an audit log you can hand to a regulator.

The Python version of [costfuse](https://github.com/costfuse/costfuse) — feature parity with the Node SDK.

## Install

```bash
pip install costfuse
```

## Use it

```python
from anthropic import Anthropic
from costfuse import wrap, CostfuseConfig

claude = wrap(Anthropic(), CostfuseConfig(
    max_spend_per_hour=5.00,
    max_same_prompt_in_window={"count": 5, "window_ms": 60_000},
    max_calls_per_minute=60,
    audit_log_path="./costfuse-audit.jsonl",
))

# Use it exactly like the original client:
claude.messages.create(
    model="claude-haiku-4-5",
    max_tokens=200,
    messages=[{"role": "user", "content": "Hello."}],
)
```

If a rule trips, the call raises `CostfuseBlocked` before any tokens are spent.

## Rules

| Rule | What it blocks |
| --- | --- |
| `max_spend_per_hour` | Hard USD cap in the last 60 minutes |
| `max_spend_per_day` | Hard USD cap in the last 24 hours |
| `max_calls_per_minute` | Rate limit |
| `max_same_prompt_in_window` | Same prompt fingerprint repeating — runaway-loop detection |
| `max_recursion_depth` | Agent calling itself too deeply |

## OpenAI also supported

```python
from openai import OpenAI
from costfuse import wrap, CostfuseConfig

oai = wrap(OpenAI(), CostfuseConfig(max_spend_per_hour=5.00))
oai.chat.completions.create(model="gpt-4o-mini", messages=[...])
```

## Recommended onboarding: log-only first, enforce later

For your first week, run with `kill_on_breach=False`. Costfuse will observe and write the audit log without blocking anything.

```python
claude = wrap(Anthropic(), CostfuseConfig(
    max_spend_per_hour=10,
    kill_on_breach=False,           # observe-only
    audit_log_path="./costfuse-audit.jsonl",
))
```

## Local testing

Three test scripts ship with the repo:

```bash
cd python
pip install -e ".[dev]"
python examples/mock_test.py          # zero spend, all rules
python examples/loop_test.py          # simulated runaway, zero spend
ANTHROPIC_API_KEY=sk-... python examples/claude_test.py   # real calls, < $0.01 spend
```

## License

Apache-2.0
