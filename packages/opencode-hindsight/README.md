# opencode-hindsight

[Hindsight](https://github.com/vectorize-io/hindsight) memory plugin for [OpenCode](https://opencode.ai) — persistent long-term memory for your AI coding agent.

## Install

```bash
opencode plugin opencode-hindsight
```

Or manually add to `.opencode/opencode.json`:

```json
{
  "plugin": [
    [
      "opencode-hindsight",
      {
        "hindsightApiUrl": "https://your-hindsight-instance",
        "hindsightApiToken": "your-api-token",
        "bankId": "your-bank-id"
      }
    ]
  ]
}
```

## Configuration

In priority order:

| Method | Example |
|--------|---------|
| Plugin options (opencode.json) | `["opencode-hindsight", { "hindsightApiUrl": "..." }]` |
| Environment variables | `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN`, `HINDSIGHT_BANK_ID` |
| User config file | `~/.hindsight/opencode.json` |

### Available options

| Option | Default | Description |
|--------|---------|-------------|
| `hindsightApiUrl` | `https://api.hindsight.vectorize.io` | Hindsight API endpoint |
| `hindsightApiToken` | `null` | API authentication token |
| `bankId` | auto-derived | Memory bank identifier |
| `autoRecall` | `true` | Auto-inject relevant memories into context |
| `autoRetain` | `true` | Auto-save conversation history |
| `recallBudget` | `"mid"` | Recall verbosity: `low` / `mid` / `high` |
| `retainEveryNTurns` | `3` | Save conversation every N user turns |
| `debug` | `false` | Enable debug logging |
