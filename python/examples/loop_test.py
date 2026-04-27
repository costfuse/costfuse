"""
Simulated runaway-agent test — fakes a $47k LangChain-style retry loop
using a fake-loop client. Burns approximately $0 of real money.

  python examples/loop_test.py

Demonstrates the headline value prop: costfuse kills the loop before it spends.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from costfuse import wrap, CostfuseBlocked, CostfuseConfig  # noqa: E402

real_calls = {"count": 0}


class ExhaustedAgent:
    class _Messages:
        def create(self, **kwargs):
            real_calls["count"] += 1
            return type(
                "FakeResponse",
                (),
                {
                    "id": f"msg_{real_calls['count']}",
                    "model": "claude-opus-4-7",
                    "content": [{"type": "text", "text": "I need clarification on the previous step."}],
                    "usage": type("Usage", (), {"input_tokens": 8000, "output_tokens": 800})(),
                },
            )()

    def __init__(self):
        self.messages = self._Messages()


def on_block(event):
    print(f"\n*** COSTFUSE FIRED *** {event.rule}: {event.reason}\n")


guarded = wrap(ExhaustedAgent(), CostfuseConfig(
    max_spend_per_hour=1.0,
    max_same_prompt_in_window={"count": 3, "window_ms": 60_000},
    on_block=on_block,
))


def main():
    print("\n--- Simulated runaway loop ---")
    print("An unprotected agent in this state would burn ~$0.20/call")
    print("Without costfuse: 250 calls = $50, 2350 calls = $470, overnight = $5,000+\n")

    blocked_at = None
    for i in range(50):
        try:
            guarded.messages.create(
                model="claude-opus-4-7",
                messages=[{"role": "user", "content": "Same prompt every iteration."}],
            )
        except CostfuseBlocked:
            blocked_at = i + 1
            break

    if blocked_at:
        saved = (50 - blocked_at) * 0.2
        print(f">>> First block at call {blocked_at}. Loop stopped.")
        print(f">>> Money saved (vs unprotected): ~${saved:.2f}")

    print(f"\nReal API calls that fired: {real_calls['count']} of 50 attempted.")
    print("Costfuse blocked the rest before they spent money.\n")


if __name__ == "__main__":
    main()
