#!/usr/bin/env node
/**
 * costfuse CLI — analyse a costfuse audit log without writing code.
 *
 * Usage:
 *   npx costfuse stats [path]       Summary of an audit log (default: ./costfuse-audit.jsonl)
 *   npx costfuse tail  [path] [-n]  Last N events (default: 20)
 *   npx costfuse top   [path] [-n]  Top N most-frequent blocked prompts
 *   npx costfuse --help
 */

const fs = require("fs");
const path = require("path");

const args = process.argv.slice(2);
const cmd = args[0];

if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
  printHelp();
  process.exit(0);
}

const validCommands = ["stats", "tail", "top"];
if (!validCommands.includes(cmd)) {
  console.error(`Unknown command: ${cmd}\n`);
  printHelp();
  process.exit(1);
}

const flagN = args.indexOf("-n");
const limit = flagN !== -1 ? parseInt(args[flagN + 1], 10) || 20 : 20;
const positional = args.slice(1).filter((a, i, arr) => a !== "-n" && arr[i - 1] !== "-n");
const filePath = positional[0] || "./costfuse-audit.jsonl";

if (!fs.existsSync(filePath)) {
  console.error(`Audit log not found: ${filePath}`);
  console.error(`Set the path with: npx costfuse ${cmd} ./your-audit-log.jsonl`);
  process.exit(1);
}

const lines = fs
  .readFileSync(filePath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  })
  .filter(Boolean);

if (cmd === "stats") cmdStats(lines, filePath);
if (cmd === "tail") cmdTail(lines, limit);
if (cmd === "top") cmdTop(lines, limit);

// --------- Commands ---------

function cmdStats(entries, filePath) {
  const totalCalls = entries.length;
  const blocked = entries.filter((e) => e.blocked).length;
  const usage = entries.filter((e) => e.rule === "usage");
  const totalCost = usage.reduce((s, e) => s + (Number(e.cost) || 0), 0);
  const totalInputTokens = usage.reduce((s, e) => s + (Number(e.input_tokens) || 0), 0);
  const totalOutputTokens = usage.reduce((s, e) => s + (Number(e.output_tokens) || 0), 0);

  const byRule = {};
  for (const e of entries) byRule[e.rule] = (byRule[e.rule] || 0) + 1;

  const byModel = {};
  for (const e of usage) {
    const m = e.model || "unknown";
    byModel[m] = (byModel[m] || { calls: 0, cost: 0 });
    byModel[m].calls++;
    byModel[m].cost += Number(e.cost) || 0;
  }

  const byActor = {};
  for (const e of usage) {
    const a = e.actor || "(none)";
    byActor[a] = (byActor[a] || { calls: 0, cost: 0 });
    byActor[a].calls++;
    byActor[a].cost += Number(e.cost) || 0;
  }

  const blockReasons = entries
    .filter((e) => e.blocked)
    .reduce((acc, e) => {
      acc[e.rule] = (acc[e.rule] || 0) + 1;
      return acc;
    }, {});

  const first = entries[0]?.timestamp;
  const last = entries[entries.length - 1]?.timestamp;

  console.log("");
  console.log("┌─────────────────────────────────────────────────────┐");
  console.log("│  costfuse — audit summary                           │");
  console.log("└─────────────────────────────────────────────────────┘");
  console.log("");
  console.log(`  File: ${filePath}`);
  console.log(`  Period: ${first || "—"}`);
  console.log(`        → ${last || "—"}`);
  console.log("");
  console.log(`  Total events: ${totalCalls}`);
  console.log(`  Blocked:      ${blocked}  (${pct(blocked, totalCalls)}%)`);
  console.log(`  Successful:   ${totalCalls - blocked}`);
  console.log("");
  console.log(`  Total spend: $${totalCost.toFixed(6)}`);
  console.log(`  Input tokens:  ${totalInputTokens.toLocaleString()}`);
  console.log(`  Output tokens: ${totalOutputTokens.toLocaleString()}`);
  console.log("");

  if (Object.keys(blockReasons).length > 0) {
    console.log("  Block reasons:");
    for (const [rule, n] of Object.entries(blockReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${rule.padEnd(28)} ${n}`);
    }
    console.log("");
  }

  if (Object.keys(byModel).length > 0) {
    console.log("  Spend by model:");
    const rows = Object.entries(byModel).sort((a, b) => b[1].cost - a[1].cost);
    for (const [m, v] of rows) {
      console.log(`    ${m.padEnd(28)} ${v.calls.toString().padStart(5)} calls   $${v.cost.toFixed(6)}`);
    }
    console.log("");
  }

  if (Object.keys(byActor).length > 1 || (Object.keys(byActor).length === 1 && !byActor["(none)"])) {
    console.log("  Spend by actor:");
    const rows = Object.entries(byActor).sort((a, b) => b[1].cost - a[1].cost).slice(0, 10);
    for (const [a, v] of rows) {
      console.log(`    ${a.padEnd(28)} ${v.calls.toString().padStart(5)} calls   $${v.cost.toFixed(6)}`);
    }
    console.log("");
  }
}

function cmdTail(entries, n) {
  const last = entries.slice(-n);
  console.log(`\nLast ${last.length} events from ${last[0]?.timestamp ?? "—"}\n`);
  for (const e of last) {
    const tag = e.blocked ? "BLOCK" : "OK   ";
    const cost = e.cost != null ? `$${Number(e.cost).toFixed(6).padStart(10)}` : "           ";
    const rule = (e.rule || "").padEnd(24);
    const reason = e.reason ? ` ${e.reason}` : "";
    console.log(`  ${tag}  ${e.timestamp}  ${rule}  ${cost}${reason}`);
  }
  console.log("");
}

function cmdTop(entries, n) {
  // Top blocked rules by frequency
  const blocked = entries.filter((e) => e.blocked);
  if (blocked.length === 0) {
    console.log("\nNo blocked events found in this log.\n");
    return;
  }

  const byRule = {};
  for (const e of blocked) byRule[e.rule] = (byRule[e.rule] || 0) + 1;
  const top = Object.entries(byRule).sort((a, b) => b[1] - a[1]).slice(0, n);

  console.log(`\nTop ${top.length} block reasons:\n`);
  for (const [rule, count] of top) {
    console.log(`  ${count.toString().padStart(4)}  ${rule}`);
  }
  console.log("");
}

function pct(num, denom) {
  if (!denom) return "0";
  return ((num / denom) * 100).toFixed(1);
}

function printHelp() {
  console.log(`
costfuse CLI — analyse a costfuse audit log

Usage:
  npx costfuse stats [path]              Summary report of an audit log
  npx costfuse tail  [path] [-n N]       Last N events (default 20)
  npx costfuse top   [path] [-n N]       Top N block reasons (default 20)
  npx costfuse --help                    This help

Default audit log path: ./costfuse-audit.jsonl

Examples:
  npx costfuse stats
  npx costfuse stats ./examples/audit-mock.jsonl
  npx costfuse tail ./costfuse-audit.jsonl -n 50
  npx costfuse top ./costfuse-audit.jsonl
`);
}
