---
name: agent-platform-api
description: RCS Platform API client. Use this skill to operate the RCS platform — manage environments, sessions, agents, tasks, knowledge bases, workflows, and more. Triggers include requests to "list environments", "create a session", "check agent config", "run a workflow", "manage tasks", "query knowledge base", and any RCS platform operation. Use curl + jq to call REST API.
allowed-tools: Bash
---

# RCS Platform API

## Overview

This skill lets you operate the RCS platform by calling REST API with curl. Authentication is handled automatically via environment variables.

## Authentication

Two environment variables are automatically injected by RCS:

- `$USER_META_BASE_URL` — API server base URL (e.g. `http://localhost:3000`)
- `$USER_META_API_KEY` — Bearer token

All API requests must include `Authorization: Bearer $USER_META_API_KEY` header.

## Quick Start

```bash
# List environments
curl -s -X POST "$USER_META_BASE_URL/web/workflow-defs" \
  -H "Authorization: Bearer $USER_META_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"list"}' | jq .
```

## API Reference

### WorkflowDefApi — `/web/workflow-defs`

All actions use `POST /web/workflow-defs` with JSON body containing `action` field.

| Action | Required Fields | Optional Fields |
|---|---|---|
| `create` | `name` | `description` |
| `save` | `workflowId`, `yaml` | — |
| `publish` | `workflowId` | — |
| `list` | — | — |
| `get` | `workflowId` | — |
| `getVersions` | `workflowId` | — |
| `getVersion` | `workflowId`, `version` | — |
| `setLatest` | `workflowId`, `version` | — |
| `delete` | `workflowId` | — |
| `updateMeta` | `workflowId` | `name`, `description` |
| `restoreToDraft` | `workflowId`, `version` | — |
| `recover` | — | — |
| `recoverApply` | `workflowIds` | — |
| `createTrigger` | `workflowId` | `type` (default "webhook"), `config` |
| `listTriggers` | `workflowId` | — |
| `deleteTrigger` | `triggerId` | — |
| `regenerateHash` | `triggerId` | — |
| `enableTrigger` | `triggerId` | — |
| `disableTrigger` | `triggerId` | — |
| `getParamDefs` | `workflowId` | `version` |

### WorkflowEngineApi — `/web/workflow-engine`

All actions use `POST /web/workflow-engine` with JSON body containing `action` field.

| Action | Required Fields | Optional Fields |
|---|---|---|
| `run` | — | `workflowId`, `yaml`, `params` |
| `dryRun` | — | `yaml` |
| `cancel` | `runId` | — |
| `approve` | `runId`, `nodeId`, `token` | `data` |
| `getRunStatus` | `runId` | — |
| `getEvents` | `runId` | — |
| `getOutput` | `runId`, `nodeId` | — |
| `getPendingApprovals` | `runId` | — |
| `listRuns` | — | `workflowId` |
| `recover` | `runId` | `yaml` |
| `rerunFrom` | `runId` | `yaml`, `fromNodeId`, `workflowId` |

### EnvironmentApi — `/web/environments`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `list` (GET) | — | — |
| `create` (POST) | `name` | `description`, `agentConfigId`, `autoStart` |
| `get` (GET) | `id` (path) | — |
| `update` (PATCH) | `id` (path) | `name`, `description`, `agentConfigId`, `autoStart` |
| `delete` (DELETE) | `id` (path) | — |
| `enter` (POST) | `id` (path) | `instance_number` |
| `listInstances` (GET) | `id` (path) | — |

### SessionApi — `/web/sessions`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `list` (GET) | — | — |
| `create` (POST) | — | any fields |
| `get` (GET) | `id` (path) | — |
| `history` (GET) | `id` (path) | — |

### ControlApi — `/web/sessions/:id/events`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `sendEvent` (POST) | `id` (path) | any payload |
| `control` (POST) | `id` (path) | any payload |
| `interrupt` (POST) | `id` (path) | — |

### InstanceApi — `/web/instances`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `create` (POST) | — | any fields |
| `spawn` (POST) | `environmentId` | `agentConfigId` |
| `list` (GET) | — | — |
| `delete` (DELETE) | `id` (path) | — |

### Config APIs — `/web/config/:module`

Modules: `providers`, `models`, `agents`, `skills`, `mcp`. All use `POST /web/config/:module` with JSON body containing `action` field.

| Action | Notes |
|---|---|
| `list` | — |
| `get` | requires `name` |
| `set` | requires `name` |
| `create` | requires `name` |
| `delete` | requires `name` |
| `enable` | requires `name` |
| `disable` | requires `name` |
| `test` | requires `name` |

### KnowledgeBaseApi — `/web/knowledgeBases`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `list` (GET) | — | — |
| `create` (POST) | `name` | `description` |
| `get` (GET) | `id` (path) | — |
| `update` (PATCH) | `id` (path) | `name`, `description` |
| `delete` (DELETE) | `id` (path) | — |
| `uploadResources` (POST) | `id` (path) + FormData | — |
| `importUrl` (POST) | `id` (path), `url` | `sourceName` |
| `listResources` (GET) | `id` (path) | — |
| `deleteResource` (DELETE) | `id`, `resourceId` (path) | — |

### TaskApi — `/web/tasks`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `list` (GET) | — | — |
| `create` (POST) | `name` | `cron`, `url`, `method`, `headers`, `body` |
| `get` (GET) | `id` (path) | — |
| `update` (PATCH) | `id` (path) | same as create |
| `delete` (DELETE) | `id` (path) | — |
| `toggle` (POST) | `id` (path) | — |
| `trigger` (POST) | `id` (path) | — |
| `logs` (GET) | `id` (path) | `page`, `pageSize` |
| `clearLogs` (DELETE) | `id` (path) | — |

### OrganizationApi — `/web/organizations`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `list` (GET) | — | — |
| `get` (GET) | `organizationId` (path) | — |
| `create` (POST) | `name` | `slug` |
| `update` (PATCH) | `organizationId` (path) | `name`, `slug` |
| `delete` (DELETE) | `organizationId` (path) | — |
| `setActive` (POST) | `organizationId` (path) | — |
| `listMembers` (GET) | `organizationId` (path) | — |
| `addMember` (POST) | `organizationId` (path), `email`, `role` | — |
| `removeMember` (DELETE) | `organizationId`, `memberId` (path) | — |
| `updateRole` (PATCH) | `organizationId`, `memberId` (path), `role` | — |

### ApiKeyApi — `/web/apiKeys`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `list` (GET) | — | — |
| `create` (POST) | `name` | `expiresIn` |
| `delete` (DELETE) | `id` (path) | — |
| `update` (PATCH) | `id` (path) | any fields |

### FileApi — `/web/environments/:id/user`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `listDir` (GET) | `id` (path) | `path` (query) |
| `readFile` (GET) | `id`, `path` (path) | `preview` (query) |
| `upload` (POST) | `id` (path) + FormData | `path` (query) |
| `writeFile` (POST) | `id`, `path` (path), `content` | — |
| `deleteFile` (DELETE) | `id`, `path` (path) | — |

### MetaAgentApi — `/web/meta-agent`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `ensure` (POST) | — | — |

### V1EnvironmentApi — `/v1/environments`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `registerBridge` (POST) | `machine_name` | — |
| `deregisterBridge` (DELETE) | `id` (path) | — |
| `reconnectBridge` (POST) | `id` (path) | — |
| `pollWork` (GET) | `id` (path) | — |
| `ackWork` (POST) | `id`, `workId` (path) | — |
| `stopWork` (POST) | `id`, `workId` (path) | — |
| `heartbeat` (POST) | `id`, `workId` (path) | — |

### V1SessionApi — `/v1/sessions`

| Action | Required Fields | Optional Fields |
|---|---|---|
| `create` (POST) | — | `environmentId`, `title`, `source` |
| `get` (GET) | `id` (path) | — |
| `update` (PATCH) | `id` (path) | any fields |
| `archive` (DELETE) | `id` (path) | — |
| `sendEvents` (POST) | `id` (path), `events` | — |
