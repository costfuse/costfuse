"""
costfuse — a fuse box for your AI bill.

Drop-in budget guardrails and runaway-loop kill switch for AI agents.
Wrap your Anthropic or OpenAI client; costfuse intercepts every call,
enforces budget/loop/recursion rules, writes an audit log, and kills
requests before they spend money you didn't plan for.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

__version__ = "0.2.0"

__all__ = ["wrap", "CostfuseBlocked", "CostfuseConfig", "BlockEvent", "summarize_audit"]


# ---------- Built-in pricing (April 2026 list prices, USD per 1M tokens) ----------

DEFAULT_PRICES: Dict[str, Dict[str, float]] = {
    # Anthropic
    "claude-opus-4-7": {"input": 15.0, "output": 75.0},
    "claude-opus-4-7[1m]": {"input": 15.0, "output": 75.0},
    "claude-sonnet-4-6": {"input": 3.0, "output": 15.0},
    "claude-haiku-4-5": {"input": 1.0, "output": 5.0},
    "claude-haiku-4-5-20251001": {"input": 1.0, "output": 5.0},
    "claude-3-5-sonnet-20241022": {"input": 3.0, "output": 15.0},
    "claude-3-5-haiku-20241022": {"input": 0.8, "output": 4.0},
    "claude-3-haiku-20240307": {"input": 0.25, "output": 1.25},
    # OpenAI
    "gpt-4o": {"input": 2.5, "output": 10.0},
    "gpt-4o-mini": {"input": 0.15, "output": 0.6},
    "gpt-4-turbo": {"input": 10.0, "output": 30.0},
    "gpt-4": {"input": 30.0, "output": 60.0},
    "gpt-3.5-turbo": {"input": 0.5, "output": 1.5},
}


# ---------- Public types ----------


@dataclass
class CostfuseConfig:
    """Configuration for a wrapped client.

    Any of the rule fields can be omitted — only the rules you set are enforced.
    """

    max_spend_per_hour: Optional[float] = None
    """Hard cap on USD spent in any rolling 60-minute window."""

    max_spend_per_day: Optional[float] = None
    """Hard cap on USD spent in any rolling 24-hour window."""

    max_calls_per_minute: Optional[int] = None
    """Max API calls allowed per rolling 60-second window."""

    max_same_prompt_in_window: Optional[Dict[str, int]] = None
    """Loop-detection rule. Dict with keys 'count' and 'window_ms'.
    Blocks when the same prompt fingerprint repeats `count` times within `window_ms` milliseconds.
    """

    max_recursion_depth: Optional[int] = None
    """Max nested wrap-call recursion depth."""

    kill_on_breach: bool = True
    """When True (default), a breach raises CostfuseBlocked. When False, returns None."""

    audit_log_path: Optional[str] = None
    """Append-only audit log path (JSON Lines)."""

    price_per_m_tokens: Optional[Dict[str, Dict[str, float]]] = None
    """Override built-in token prices."""

    on_block: Optional[Callable[["BlockEvent"], None]] = None
    """Callback fired on every block."""

    test_mode: bool = False
    """When True, no real network call is made."""

    actor: Optional[str] = None
    """Identifier written to the audit log (e.g. user id, tenant id)."""


@dataclass
class BlockEvent:
    rule: str
    reason: str
    timestamp: str
    actor: Optional[str] = None
    context: Dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> Dict[str, Any]:
        return {
            "rule": self.rule,
            "reason": self.reason,
            "timestamp": self.timestamp,
            "actor": self.actor,
            "context": self.context,
        }


class CostfuseBlocked(Exception):
    """Raised when a wrapped client call would breach a rule."""

    def __init__(self, event: BlockEvent):
        self.event = event
        super().__init__(f"[costfuse] {event.reason}")


# ---------- Internal state ----------


class _State:
    def __init__(self) -> None:
        self.usages: List[Dict[str, Any]] = []
        self.call_times: List[float] = []

    def record_call(self, prompt_hash: str) -> None:
        now = time.time() * 1000
        self.call_times.append(now)
        self.usages.append({"ts": now, "cost": 0.0, "prompt_hash": prompt_hash})
        self._prune()

    def record_cost(self, cost: float) -> None:
        if self.usages:
            self.usages[-1]["cost"] += cost

    def spent_in_last_ms(self, ms: int) -> float:
        cutoff = time.time() * 1000 - ms
        return sum(u["cost"] for u in self.usages if u["ts"] > cutoff)

    def calls_in_last_ms(self, ms: int) -> int:
        cutoff = time.time() * 1000 - ms
        return sum(1 for t in self.call_times if t > cutoff)

    def same_prompt_in_last_ms(self, prompt_hash: str, ms: int) -> int:
        cutoff = time.time() * 1000 - ms
        return sum(1 for u in self.usages if u["ts"] > cutoff and u["prompt_hash"] == prompt_hash)

    def _prune(self) -> None:
        day_ago = time.time() * 1000 - 24 * 60 * 60 * 1000
        self.usages = [u for u in self.usages if u["ts"] > day_ago]
        self.call_times = [t for t in self.call_times if t > day_ago]


# ---------- Audit log ----------


def _append_audit(path: Optional[str], entry: Dict[str, Any]) -> None:
    if not path:
        return
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry) + "\n")
    except Exception:
        # Never let audit-log failure break the wrapped call.
        pass


# ---------- Helpers ----------


def _hash_prompt(params: Any) -> str:
    if isinstance(params, dict):
        payload = params.get("messages") or params.get("input") or params
    else:
        payload = params
    serialised = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(serialised.encode("utf-8")).hexdigest()[:16]


def _compute_cost(response: Any, model: Optional[str], prices: Dict[str, Dict[str, float]]) -> float:
    usage = None
    if response is None:
        return 0.0
    if hasattr(response, "usage"):
        usage = response.usage
    elif isinstance(response, dict):
        usage = response.get("usage")
    if usage is None or not model:
        return 0.0
    price = prices.get(model)
    if not price:
        return 0.0

    def _g(obj: Any, *keys: str) -> int:
        for k in keys:
            if isinstance(obj, dict) and k in obj:
                return int(obj[k] or 0)
            if hasattr(obj, k):
                v = getattr(obj, k, 0) or 0
                return int(v)
        return 0

    in_tok = _g(usage, "input_tokens", "prompt_tokens")
    out_tok = _g(usage, "output_tokens", "completion_tokens")
    return (in_tok / 1_000_000.0) * price["input"] + (out_tok / 1_000_000.0) * price["output"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---------- Rule engine ----------


def _check_rules(
    state: _State,
    config: CostfuseConfig,
    prompt_hash: str,
    recursion_depth: int,
) -> Optional[BlockEvent]:
    ts = _now_iso()

    if config.max_spend_per_hour is not None:
        spent = state.spent_in_last_ms(60 * 60 * 1000)
        if spent >= config.max_spend_per_hour:
            return BlockEvent(
                rule="maxSpendPerHour",
                reason=f"Spent ${spent:.4f} in last hour, limit ${config.max_spend_per_hour}",
                timestamp=ts,
                actor=config.actor,
                context={"spent": spent, "limit": config.max_spend_per_hour},
            )

    if config.max_spend_per_day is not None:
        spent = state.spent_in_last_ms(24 * 60 * 60 * 1000)
        if spent >= config.max_spend_per_day:
            return BlockEvent(
                rule="maxSpendPerDay",
                reason=f"Spent ${spent:.4f} in last 24h, limit ${config.max_spend_per_day}",
                timestamp=ts,
                actor=config.actor,
                context={"spent": spent, "limit": config.max_spend_per_day},
            )

    if config.max_calls_per_minute is not None:
        calls = state.calls_in_last_ms(60 * 1000)
        if calls >= config.max_calls_per_minute:
            return BlockEvent(
                rule="maxCallsPerMinute",
                reason=f"{calls} calls in last minute, limit {config.max_calls_per_minute}",
                timestamp=ts,
                actor=config.actor,
                context={"calls": calls, "limit": config.max_calls_per_minute},
            )

    if config.max_same_prompt_in_window:
        count = config.max_same_prompt_in_window.get("count", 5)
        window_ms = config.max_same_prompt_in_window.get("window_ms", 60_000)
        same = state.same_prompt_in_last_ms(prompt_hash, window_ms)
        if same >= count:
            return BlockEvent(
                rule="maxSamePromptInWindow",
                reason=f"Same prompt fingerprint fired {same + 1} times — likely runaway loop",
                timestamp=ts,
                actor=config.actor,
                context={"prompt_hash": prompt_hash, "count": same + 1},
            )

    if config.max_recursion_depth is not None and recursion_depth >= config.max_recursion_depth:
        return BlockEvent(
            rule="maxRecursionDepth",
            reason=f"Recursion depth {recursion_depth} reached limit {config.max_recursion_depth}",
            timestamp=ts,
            actor=config.actor,
            context={"recursion_depth": recursion_depth},
        )

    return None


# ---------- Public API ----------


class _WrappedClient:
    """Returned from wrap(). Proxies attribute access to the underlying client,
    intercepting `messages.create` (Anthropic) and `chat.completions.create` (OpenAI)."""

    def __init__(self, client: Any, config: CostfuseConfig) -> None:
        self._client = client
        self._config = config
        self._state = _State()
        self._prices = {**DEFAULT_PRICES, **(config.price_per_m_tokens or {})}
        self._recursion_depth = 0

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._client, name)
        if name == "messages" and attr is not None:
            return _MessagesNamespace(attr, self)
        if name == "chat" and attr is not None:
            return _ChatNamespace(attr, self)
        return attr

    # --- Wrapped call execution (used by namespaces) ---

    def _execute(self, fn: Callable[..., Any], params: Dict[str, Any]) -> Any:
        prompt_hash = _hash_prompt(params)
        breach = _check_rules(self._state, self._config, prompt_hash, self._recursion_depth)
        if breach:
            _append_audit(self._config.audit_log_path, {**breach.as_dict(), "blocked": True})
            if self._config.on_block:
                try:
                    self._config.on_block(breach)
                except Exception:
                    pass
            print(f"\033[33m[costfuse] BLOCKED: {breach.reason}\033[0m")
            if self._config.kill_on_breach:
                raise CostfuseBlocked(breach)
            return None

        self._state.record_call(prompt_hash)

        if self._config.test_mode:
            fake = _FakeResponse(params.get("model"))
            cost = _compute_cost(fake, params.get("model"), self._prices)
            self._state.record_cost(cost)
            _append_audit(
                self._config.audit_log_path,
                {
                    "rule": "usage",
                    "timestamp": _now_iso(),
                    "actor": self._config.actor,
                    "model": params.get("model"),
                    "cost": cost,
                    "test_mode": True,
                    "blocked": False,
                },
            )
            return fake

        self._recursion_depth += 1
        try:
            response = fn(**params) if isinstance(params, dict) else fn(params)
            cost = _compute_cost(response, params.get("model"), self._prices)
            self._state.record_cost(cost)
            usage = getattr(response, "usage", None) or (response.get("usage") if isinstance(response, dict) else None) or {}
            in_tok = (
                getattr(usage, "input_tokens", None)
                or getattr(usage, "prompt_tokens", None)
                or (usage.get("input_tokens") if isinstance(usage, dict) else 0)
                or (usage.get("prompt_tokens") if isinstance(usage, dict) else 0)
                or 0
            )
            out_tok = (
                getattr(usage, "output_tokens", None)
                or getattr(usage, "completion_tokens", None)
                or (usage.get("output_tokens") if isinstance(usage, dict) else 0)
                or (usage.get("completion_tokens") if isinstance(usage, dict) else 0)
                or 0
            )
            _append_audit(
                self._config.audit_log_path,
                {
                    "rule": "usage",
                    "timestamp": _now_iso(),
                    "actor": self._config.actor,
                    "model": params.get("model"),
                    "cost": cost,
                    "input_tokens": int(in_tok),
                    "output_tokens": int(out_tok),
                    "blocked": False,
                },
            )
            return response
        finally:
            self._recursion_depth -= 1


class _FakeResponse:
    def __init__(self, model: Optional[str]) -> None:
        self.content = [{"type": "text", "text": "[costfuse test mode]"}]
        self.choices = [type("Choice", (), {"message": type("Msg", (), {"content": "[costfuse test mode]"})()})()]
        self.usage = type("Usage", (), {"input_tokens": 50, "output_tokens": 50, "prompt_tokens": 50, "completion_tokens": 50})()
        self.model = model


class _MessagesNamespace:
    """Wraps `client.messages` for Anthropic shape."""

    def __init__(self, inner: Any, wrapped: _WrappedClient) -> None:
        self._inner = inner
        self._wrapped = wrapped

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._inner, name)
        if name == "create":
            def _create(**kwargs: Any) -> Any:
                return self._wrapped._execute(attr, kwargs)
            return _create
        return attr


class _ChatNamespace:
    """Wraps `client.chat` for OpenAI shape."""

    def __init__(self, inner: Any, wrapped: _WrappedClient) -> None:
        self._inner = inner
        self._wrapped = wrapped

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._inner, name)
        if name == "completions":
            return _CompletionsNamespace(attr, self._wrapped)
        return attr


class _CompletionsNamespace:
    def __init__(self, inner: Any, wrapped: _WrappedClient) -> None:
        self._inner = inner
        self._wrapped = wrapped

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._inner, name)
        if name == "create":
            def _create(**kwargs: Any) -> Any:
                return self._wrapped._execute(attr, kwargs)
            return _create
        return attr


def wrap(client: Any, config: Optional[CostfuseConfig] = None, **kwargs: Any) -> Any:
    """Wrap an Anthropic or OpenAI client.

    Returns a proxy that enforces the rules before forwarding each request.

    Usage:
        from anthropic import Anthropic
        from costfuse import wrap, CostfuseConfig

        claude = wrap(Anthropic(), CostfuseConfig(
            max_spend_per_hour=5.00,
            max_same_prompt_in_window={"count": 5, "window_ms": 60_000},
            audit_log_path="./costfuse-audit.jsonl",
        ))

        # Use it exactly like the original client:
        claude.messages.create(model="claude-haiku-4-5", max_tokens=200,
                               messages=[{"role": "user", "content": "Hello"}])
    """
    if config is None:
        config = CostfuseConfig(**kwargs)
    elif kwargs:
        # Allow `wrap(client, existing_config, max_spend_per_hour=10)` overrides
        for k, v in kwargs.items():
            setattr(config, k, v)
    return _WrappedClient(client, config)


def summarize_audit(audit_log_path: str) -> Dict[str, Any]:
    """Generate a simple summary report from an audit log file (compliance preview)."""
    out: Dict[str, Any] = {
        "total_calls": 0,
        "total_blocked": 0,
        "total_cost_usd": 0.0,
        "by_rule": {},
        "first_event": None,
        "last_event": None,
    }
    if not os.path.exists(audit_log_path):
        return out
    with open(audit_log_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            out["total_calls"] += 1
            if entry.get("blocked"):
                out["total_blocked"] += 1
            cost = entry.get("cost")
            if isinstance(cost, (int, float)):
                out["total_cost_usd"] += cost
            rule = entry.get("rule")
            if rule:
                out["by_rule"][rule] = out["by_rule"].get(rule, 0) + 1
            ts = entry.get("timestamp")
            if ts:
                if out["first_event"] is None:
                    out["first_event"] = ts
                out["last_event"] = ts
    return out
