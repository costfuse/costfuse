"""
Real-world smoke test: import costfuse and wrap real Anthropic + OpenAI SDK classes.
No API key needed — only verifies the proxy structure works against real classes.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from costfuse import wrap, CostfuseBlocked, CostfuseConfig

passes = 0
fails = 0


def ok(msg):
    global passes
    print(f"  PASS  {msg}")
    passes += 1


def bad(msg):
    global fails
    print(f"  FAIL  {msg}")
    fails += 1


print("\n--- 1. Anthropic SDK integration ---")
try:
    from anthropic import Anthropic
except ImportError:
    bad("anthropic not installed; pip install anthropic")
    sys.exit(1)

ant = Anthropic(api_key="sk-ant-fake")
wrapped = wrap(ant, CostfuseConfig(max_calls_per_minute=5, test_mode=True))

if hasattr(wrapped, "messages"):
    ok("wrapped.messages exists")
else:
    bad("wrapped.messages missing")

if callable(getattr(wrapped.messages, "create", None)):
    ok("wrapped.messages.create is callable")
else:
    bad("wrapped.messages.create not callable")

try:
    res = wrapped.messages.create(
        model="claude-haiku-4-5",
        max_tokens=10,
        messages=[{"role": "user", "content": "hi"}],
    )
    if res and getattr(res, "content", None):
        ok("wrapped Anthropic .create() returned a response")
    else:
        bad(f"unexpected response shape: {res}")
except Exception as e:  # noqa
    bad(f"wrapped Anthropic .create() threw: {e}")

print("\n--- 2. Anthropic rule firing on real class ---")
guarded = wrap(Anthropic(api_key="sk-ant-fake"), CostfuseConfig(
    max_calls_per_minute=2, test_mode=True
))
blocked = False
try:
    guarded.messages.create(model="claude-haiku-4-5", max_tokens=10, messages=[{"role": "user", "content": "1"}])
    guarded.messages.create(model="claude-haiku-4-5", max_tokens=10, messages=[{"role": "user", "content": "2"}])
    guarded.messages.create(model="claude-haiku-4-5", max_tokens=10, messages=[{"role": "user", "content": "3"}])
    bad("Expected 3rd call to throw CostfuseBlocked")
except CostfuseBlocked as e:
    blocked = True
    ok(f"3rd call correctly blocked: {e.event.rule}")
except Exception as e:  # noqa
    bad(f"Unexpected error: {e}")

print("\n--- 3. OpenAI SDK integration ---")
try:
    from openai import OpenAI
except ImportError:
    bad("openai not installed")
    sys.exit(1)

oai = OpenAI(api_key="sk-fake")
wrapped_oai = wrap(oai, CostfuseConfig(max_calls_per_minute=5, test_mode=True))

if hasattr(wrapped_oai, "chat"):
    ok("wrapped.chat exists")
else:
    bad("wrapped.chat missing")

if hasattr(wrapped_oai.chat, "completions"):
    ok("wrapped.chat.completions exists")
else:
    bad("wrapped.chat.completions missing")

try:
    res = wrapped_oai.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "hi"}],
    )
    if res and getattr(res, "choices", None):
        ok("wrapped OpenAI .create() returned a response")
    else:
        bad(f"unexpected response shape: {res}")
except Exception as e:  # noqa
    bad(f"wrapped OpenAI .create() threw: {e}")

print(f"\n=== SMOKE TEST RESULT ===\nPASSED: {passes}\nFAILED: {fails}")
sys.exit(0 if fails == 0 else 1)
