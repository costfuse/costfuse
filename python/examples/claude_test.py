"""
Real-Claude test — uses minimal API spend to verify costfuse works against
the live Anthropic API.

  ANTHROPIC_API_KEY=sk-... python examples/claude_test.py

Forces claude-haiku-4-5 (cheapest) and an artificially low spend cap so the
rule trips after a handful of tiny calls. Total expected spend: < $0.01.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

if not os.environ.get("ANTHROPIC_API_KEY"):
    print("Set ANTHROPIC_API_KEY before running.")
    sys.exit(1)

try:
    from anthropic import Anthropic
except ImportError:
    print("Install anthropic first: pip install anthropic")
    sys.exit(1)

from costfuse import wrap, CostfuseBlocked, CostfuseConfig, summarize_audit  # noqa: E402

AUDIT_PATH = str(Path(__file__).parent / "audit-claude.jsonl")
if os.path.exists(AUDIT_PATH):
    os.remove(AUDIT_PATH)

raw = Anthropic()

claude = wrap(raw, CostfuseConfig(
    # Haiku 4.5: $1 in / $5 out per 1M tokens. Tiny spend cap will trigger after ~5 calls.
    max_spend_per_hour=0.001,
    max_same_prompt_in_window={"count": 2, "window_ms": 60_000},
    max_calls_per_minute=20,
    audit_log_path=AUDIT_PATH,
    actor="local-test",
    on_block=lambda e: print(f"\n>>> Slack/webhook would fire here: {e.rule} -- {e.reason}\n"),
))


def safe_ask(prompt: str):
    try:
        r = claude.messages.create(
            model="claude-haiku-4-5",
            max_tokens=30,
            messages=[{"role": "user", "content": prompt}],
        )
        text = ""
        if hasattr(r, "content") and r.content:
            first = r.content[0]
            text = getattr(first, "text", None) or (first.get("text") if isinstance(first, dict) else "") or ""
        print(f"OK   '{prompt[:30]}...' -> {text[:60]}")
    except CostfuseBlocked as e:
        print(f"STOP '{prompt[:30]}...' blocked by {e.event.rule}")


def main():
    print("\n--- costfuse Python LIVE Claude test (Haiku, ultra-low caps) ---\n")

    # Phase 1: a few normal calls
    safe_ask("Say 'hello' in one word.")
    safe_ask("Say 'world' in one word.")
    safe_ask("Say 'tripwire' in one word.")
    safe_ask("Say 'works' in one word.")
    safe_ask("Say 'great' in one word.")

    # Phase 2: same prompt twice quickly — should trip loop detection
    print("\n[Now firing the same prompt repeatedly to trigger loop detection]")
    safe_ask("repeat-prompt-loop-test")
    safe_ask("repeat-prompt-loop-test")
    safe_ask("repeat-prompt-loop-test")  # expected: BLOCKED

    # Phase 3: keep firing — should hit the spend cap
    print("\n[Now firing varied prompts until spend cap trips]")
    for i in range(10):
        safe_ask(f"varied-{i}: tell me a one-word fact.")

    print("\n--- Compliance summary ---")
    print(summarize_audit(AUDIT_PATH))
    print(f"\nAudit log: {AUDIT_PATH}\n")


if __name__ == "__main__":
    main()
