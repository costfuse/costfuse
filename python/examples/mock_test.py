"""
Mock test — runs in test mode (no real API call, no token spend).

  python examples/mock_test.py

Exercises every rule and prints whether each one fired correctly.
"""

import os
import sys
from pathlib import Path

# Allow `python examples/mock_test.py` from the python/ directory
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from costfuse import wrap, CostfuseBlocked, CostfuseConfig, summarize_audit  # noqa: E402

AUDIT_PATH = str(Path(__file__).parent / "audit-mock.jsonl")
if os.path.exists(AUDIT_PATH):
    os.remove(AUDIT_PATH)


class FakeMessages:
    def create(self, **kwargs):
        return type(
            "FakeResponse",
            (),
            {
                "id": "msg_fake",
                "model": kwargs.get("model"),
                "content": [{"type": "text", "text": "ok"}],
                "usage": type("Usage", (), {"input_tokens": 1000, "output_tokens": 500})(),
            },
        )()


class FakeAnthropic:
    def __init__(self):
        self.messages = FakeMessages()


def expect_blocked(label, fn):
    try:
        fn()
        print(f"FAIL  {label} — expected block, got success")
        return False
    except CostfuseBlocked as e:
        print(f"PASS  {label} — blocked: {e.event.rule}")
        return True
    except Exception as e:  # noqa
        print(f"FAIL  {label} — wrong error: {e}")
        return False


def expect_ok(label, fn):
    try:
        fn()
        print(f"PASS  {label} — call succeeded")
        return True
    except Exception as e:  # noqa
        print(f"FAIL  {label} — unexpected block: {e}")
        return False


def main():
    print("\n--- costfuse Python mock test ---\n")

    fake_client = FakeAnthropic()

    # Test 1: max_calls_per_minute
    client = wrap(fake_client, CostfuseConfig(
        max_calls_per_minute=3,
        audit_log_path=AUDIT_PATH,
        test_mode=True,
    ))
    expect_ok("call 1 of 3", lambda: client.messages.create(
        model="claude-haiku-4-5", messages=[{"role": "user", "content": "hi"}]))
    expect_ok("call 2 of 3", lambda: client.messages.create(
        model="claude-haiku-4-5", messages=[{"role": "user", "content": "hi 2"}]))
    expect_ok("call 3 of 3", lambda: client.messages.create(
        model="claude-haiku-4-5", messages=[{"role": "user", "content": "hi 3"}]))
    expect_blocked("call 4 should trip rate limit", lambda: client.messages.create(
        model="claude-haiku-4-5", messages=[{"role": "user", "content": "hi 4"}]))

    # Test 2: max_same_prompt_in_window (loop detection)
    client = wrap(FakeAnthropic(), CostfuseConfig(
        max_same_prompt_in_window={"count": 3, "window_ms": 60_000},
        audit_log_path=AUDIT_PATH,
        test_mode=True,
    ))
    same = [{"role": "user", "content": "are we there yet?"}]
    expect_ok("loop call 1", lambda: client.messages.create(model="claude-haiku-4-5", messages=same))
    expect_ok("loop call 2", lambda: client.messages.create(model="claude-haiku-4-5", messages=same))
    expect_ok("loop call 3", lambda: client.messages.create(model="claude-haiku-4-5", messages=same))
    expect_blocked("loop call 4 should trip", lambda: client.messages.create(
        model="claude-haiku-4-5", messages=same))

    # Test 3: max_spend_per_hour
    client = wrap(FakeAnthropic(), CostfuseConfig(
        max_spend_per_hour=0.0008,
        audit_log_path=AUDIT_PATH,
        test_mode=True,
    ))
    blocked = False
    for i in range(10):
        try:
            client.messages.create(model="claude-haiku-4-5",
                                   messages=[{"role": "user", "content": f"q {i}"}])
        except CostfuseBlocked as e:
            print(f"PASS  spend cap tripped on call {i + 1}: {e.event.reason}")
            blocked = True
            break
    if not blocked:
        print("FAIL  spend cap never tripped")

    # Test 4: on_block callback
    captured = {"rule": None}

    def on_block(event):
        captured["rule"] = event.rule

    client = wrap(FakeAnthropic(), CostfuseConfig(
        max_calls_per_minute=1,
        on_block=on_block,
        test_mode=True,
    ))
    client.messages.create(model="claude-haiku-4-5", messages=[{"role": "user", "content": "x"}])
    try:
        client.messages.create(model="claude-haiku-4-5",
                               messages=[{"role": "user", "content": "y"}])
    except CostfuseBlocked:
        pass
    print("PASS  on_block callback fired:", captured["rule"]) if captured["rule"] \
        else print("FAIL  on_block did not fire")

    print("\n--- Audit log summary (compliance evidence preview) ---")
    print(summarize_audit(AUDIT_PATH))
    print(f"\nFull log saved to: {AUDIT_PATH}\n")


if __name__ == "__main__":
    main()
