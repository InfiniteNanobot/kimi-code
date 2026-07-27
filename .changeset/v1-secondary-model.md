---
"@moonshot-ai/kimi-code": patch
---

Support a secondary model for subagents on the default engine (experimental): with `KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1` and a `[secondary_model]` section in `config.toml`, newly spawned subagents bind the configured secondary model by default, and the `Agent`/`AgentSwarm` tools can pick `primary` or `secondary` per spawn.
