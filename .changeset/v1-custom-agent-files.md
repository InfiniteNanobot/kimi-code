---
"@moonshot-ai/kimi-code": minor
---

Support Markdown-defined custom agents on the default engine: agents discovered from user (`~/.kimi-code/agents/`) and project (`.kimi-code/agents/`) directories can be delegated to as sub-agents, `$KIMI_CODE_HOME/SYSTEM.md` overrides the default main agent's system prompt, and `kimi -p --agent/--agent-file` select the main agent without the experimental flag. Add a file like `~/.kimi-code/agents/reviewer.md` to define your own agent.
