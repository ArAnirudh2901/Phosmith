---
name: pxpipe-proxy
description: pxpipe token-saving proxy installed globally; user must set ANTHROPIC_BASE_URL themselves (auto mode blocks it)
metadata: 
  node_type: memory
  type: reference
  originSessionId: ec3b4c95-33d6-478c-b132-68b20762e634
---

`pxpipe` (npm `pxpipe-proxy`, github.com/teamchong/pxpipe) is installed globally via bun — binary `~/.bun/bin/pxpipe`, proxy on `http://127.0.0.1:47821`, dashboard at that URL, events in `~/.pxpipe/events.jsonl`. It renders bulky Claude Code context as PNGs to cut input tokens.

The auto-mode classifier hard-blocks Claude from setting `ANTHROPIC_BASE_URL` (settings.json edit AND the update-config skill) — an exfiltration-class change user intent cannot clear. The user applies it manually in `~/.claude/settings.json` env. Don't retry that edit in auto mode; if pxpipe seems inactive, check the proxy process is running and whether the user added the env var.
