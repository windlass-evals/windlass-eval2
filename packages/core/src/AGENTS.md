# Core source

- Keep the request prefix stable: freeze the system prompt and tool list in the baseline until compaction. Append mid-session updates as durable messages; tool specs must not depend on configuration or discovery.
- Append new state through events; do not bypass the reducer. Keep stored tool text unchanged on replay.
