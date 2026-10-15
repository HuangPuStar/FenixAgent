# FenixAgent

[中文](README.md) | [English](README_en.md)

**A unified control plane for connecting, running, and governing enterprise AI agents.**

FenixAgent is built for multi-team enterprise environments. Based on the Agent Client Protocol (ACP), it centrally connects and runs different agent engines. It orchestrates enterprise agent resources and governance policies—including models, Skills, MCP server configurations, permissions, and runtime settings—and securely delivers agent capabilities to business systems through interactive chat, workflows, scheduled tasks, and open APIs.

FenixAgent is an enterprise agent control plane, not a standalone local client for a single agent. The platform manages organizations, configuration, policies, execution environments, and lifecycle; agents can run on the platform host, dedicated remote execution nodes, or on-demand managed sandboxes.

[Platform capabilities](#platform-capabilities) · [Supported agent engines](#supported-agent-engines) · [Quick start](#quick-start) · [Deployment models](#deployment-models) · [Documentation](#documentation-and-examples) · [Contributing](#contributing)

## Why FenixAgent

- **No lock-in to one agent engine**: Built-in support for OpenCode, Claude Code, claude-code-best, DeepSeek Harness (DSH), and other ACP-compatible engines through plugins.
- **Central configuration, on-demand reuse**: Models, Skills, agent configurations, permission policies, and runtime settings are centrally managed rather than maintained separately for every agent.
- **Enterprise capabilities when needed**: Integrate knowledge bases, agent memory, Agent Sites, managed sandboxes, model gateways, and quota governance as required, without taking on unneeded complexity.
- **From interaction to automation**: Use the same agent capabilities through Web Chat, an OpenAI-compatible API, workflows, and scheduled tasks.
- **Unified local and remote scheduling**: Run agents on managed local or remote execution nodes, with cross-machine deployment and lifecycle management.
- **Enterprise governance**: Manage identity, permissions, secrets, and resource isolation with organizations, users, and execution environments (controlled combinations of agent configuration, execution node, and workspace) as boundaries.

## Platform capabilities

### Unified integration and agent lifecycle

FenixAgent uses ACP Relay to manage agent-engine connections, sessions, status, capability discovery, instance creation, reuse, and release, so different engines work through a unified service interface.

### Enterprise resources and configuration

The platform centrally manages agent templates, models, Skills, MCP server configurations, permission policies, and runtime settings, and injects applicable configuration into the target runtime when an instance starts.

### MCP services and tool extensions

External tools are integrated through MCP servers. The platform centrally manages MCP server configurations and injects them when agents start.

### Optional integration: knowledge base

Connect a knowledge base when needed to provide agents with retrieval over enterprise materials.

### Optional integration: agent memory and continuity

Connect an external memory service when needed to provide cross-session continuity and accumulated experience. Memory and knowledge bases are managed separately, so dynamic collaboration experience is not conflated with enterprise documents.

### Optional integration: model gateway and quota governance

Manage model access, credentials, and routing through a unified model gateway, and apply quotas and usage limits by organization, user, or environment.

### Optional integration: managed sandboxes and execution isolation

Agents can run in managed sandboxes that isolate runtime environments, file systems, and resource boundaries, reducing the impact of task execution on the platform and other tenants.

### Runtime, scheduling, and automation

The same agent capability can be invoked through Web Chat, an OpenAI-compatible API, workflows, and scheduled tasks for both interactive use and business automation.

### Optional integration: agent application delivery and hosting

Agent Sites provide a hosted delivery pipeline for applications created by agents, from code submission and automated builds to preview and production release. The platform centrally manages sites, deployment versions, build status, and access endpoints so agent output can be delivered directly to the business.

### Distributed execution and remote nodes

Agent engines can run on the platform host or independent remote nodes. The platform manages node registration, health, scheduling, and Relay communication; nodes only host the actual runtime and workspace execution.

### Multi-tenant security and governance

Organizations, users, environments, workspaces, and secrets are isolated. The platform validates authentication and organization context at protocol entry points, then injects trusted working directories and runtime configuration into agents.

### Open integration

With its OpenAI-compatible API, external API, and MCP, FenixAgent serves as a unified integration layer between enterprise systems and agent engines.

## Supported agent engines

| Agent engine | ACP integration | Runs on platform host | Runs on remote nodes | Notes |
| --- | --- | --- | --- | --- |
| OpenCode | Supported | Supported | Supported | Built-in agent engine |
| Peri | Supported | Supported | Supported | Built-in agent engine (implemented in Rust, compatible with the Claude Code ecosystem, and lightweight); **the default engine for local execution on the platform host** |
| Claude Code | Supported | Supported | Supported | Built-in agent engine |
| claude-code-best (ccb) | Supported | Supported | Supported | Built-in agent engine |
| DeepSeek Harness (DSH) | Native support | Supported | Supported | Connected through the CCB compatibility slot; see the [DSH documentation](docker/sandbox-dsh/README.md) |

Besides the built-in engines, other ACP-compatible engines can be integrated by developing plugins. See [`@fenix/plugin-sdk`](packages/plugin-sdk/README.md) for how to develop and register an engine plugin.

## Quick start

### Docker Compose (recommended)

```bash
# Create local configuration and set RCS_API_KEYS to at least a random value
# (only the main service needs this step).
cp .env.example .env

# Starts PostgreSQL and rcs only; components are added with --profile and need no .env of their own.
docker compose up --build -d
```

Add optional components (litellm / ragflow / hindsight / agent-sites / opensandbox) on demand:

```bash
docker compose --profile litellm --profile ragflow up -d
```

Components bring their own datastore and cache, and their defaults work out of the box (local-only and
insecure by design). To change a default, set the same key in the repository-root `.env` (hindsight
additionally requires `DASHSCOPE_API_KEY` in the same file). The only component needing a `cp` is
opensandbox's node config `sandbox.toml`: `cp docker/dev/sandbox.toml.example docker/dev/sandbox.toml`.
See [docker/dev/README.md](docker/dev/README.md) for the overridable keys and their defaults.

The service is available at <http://localhost:3001/> by default, with the built-in Peri agent engine as the default for local execution.

On first startup, the system creates the administrator account `admin@fenix.com`. Its initial password is written to the file configured by `RCS_SYSTEM_ADMIN_PASSWORD_FILE`, which defaults to `data/password.txt`.

For production deployment, where the target host does not need source code or Dockerfiles, use the production compose file `docker/main/docker-compose.yml` and the one-command entry point `./docker/deploy.sh deploy`. See [Deployment](docs/operations/deployment.md) and [Docker topology](docs/operations/docker-topology.md). The development and production compose files use the same project name and network, so run only one of them.

### Local development

Prerequisites: Bun, Docker, Docker Compose, and a usable Peri agent engine (the default for local execution) on your `PATH`. To use another engine, install its CLI yourself; OpenCode version `opencode-ai@1.17.12` is recommended because newer versions may have compatibility issues.

```bash
# Start only PostgreSQL.
docker compose up -d postgres

# Install dependencies and synchronize the database.
bun install
bun run db:migrate

# Start the local service.
bash restart-server.sh
```

The local service runs at <http://localhost:3000/> by default. For standalone frontend development, run `bun run dev:web`. See the [contribution guide](CONTRIBUTING.md) for the complete development and validation workflow.

## Deployment models

### Single-host deployment

Use the Docker Compose command above to run the control service and default agent engine on one host. This is suitable for evaluation, development, and single-host environments.

See [Docker topology](docs/operations/docker-topology.md) for Docker Compose startup instructions for optional integrations and remote sandboxes.

### Remote execution nodes

`acp-link` runs on a remote machine and bridges an agent engine's ACP stdio communication to FenixAgent. The control service centrally manages nodes and agent instances, while tasks run in workspaces on the remote machine.

```text
FenixAgent Control Plane                    Remote Machine
┌────────────────────────┐                 ┌──────────────────────────┐
│ Console / API / Workflow│────── WebSocket │ acp-link + ACP Runtime   │
│ ACP Relay / Scheduler   │                 │ └── Agent process        │
└────────────────────────┘                 └──────────────────────────┘
```

On Linux, you can start a remote node with the Peri sandbox image. The following example applies when the control service runs on the host via `bun run dev` at port 3000:

```bash
docker build -f docker/sandbox-peri/Dockerfile -t fenix-sandbox .

docker run -d \
  --name fenix-sandbox \
  --add-host host.docker.internal:host-gateway \
  -e RCS_URL=ws://host.docker.internal:3000 \
  -e RCS_SECRET=your-secret \
  -e RCS_MACHINE_ID=mach_xxx \
  fenix-sandbox
```

`RCS_URL`, `RCS_SECRET`, and `RCS_MACHINE_ID` are all required. If the control service runs through Docker Compose as above, use `ws://host.docker.internal:3001` for `RCS_URL`. For other engines, use the corresponding `docker/sandbox-opencode/` (OpenCode), `docker/sandbox-ccb/`, or `docker/sandbox-dsh/` image. See [`packages/acp-link`](packages/acp-link/README.md) for the remote-node program API and ACP bridging capability.

### DeepSeek Harness (DSH)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) natively supports ACP and can be used as an agent engine in FenixAgent. The repository provides a `docker/sandbox-dsh/` image: model configuration is delivered by the control service, API keys are not persisted to disk, and it reuses the platform's Web Chat, OpenAI-compatible API, workflows, session persistence, and multi-tenant workspace isolation.

See the [DSH sandbox documentation](docker/sandbox-dsh/README.md) for setup steps, permission boundaries, and known limitations.

## Architecture overview

```text
Console / External API / Workflow / Scheduler
                     │
                     ▼
          FenixAgent Control Plane
  organization · configuration · policy · orchestration
                     │
                     ▼
               ACP Relay / Runtime
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
 Local Agent Runtime      Remote Agent Runtime
```

The control service decides who can use which agent, with which resources, and where it runs. Execution nodes start agents, forward ACP messages, and perform the actual tasks. See [Agent Instance and Runtime Architecture](docs/arch/22-agent-instance-management.md) for instance lifecycle and runtime responsibilities.

## Documentation and examples

- [Contributing and local development](CONTRIBUTING.md)
- [External API guide](docs/developer/system/external-api.md)
- [External agent engine session integration](docs/developer/system/external-agent-session-guide.md)
- [MCP integration](docs/developer/agent/mcp-integration.md)
- [Skill development](docs/developer/agent/skill-development.md)
- [Engine plugin development](packages/plugin-sdk/README.md)
- [Knowledge base guide](docs/developer/agent/knowledge-base.md)
- [Agent memory architecture (Hindsight)](docs/arch/06-config-hindsight.md)
- [Sandbox architecture](docs/arch/19-sandbox.md)
- [Model and provider architecture](docs/arch/06-config-provider.md)
- [Workflow V2 architecture](docs/arch/25-workflow-v2.md)
- [Agent Sites architecture](docs/arch/18-agent-sites.md)
- [Agent Instance and Runtime Architecture](docs/arch/22-agent-instance-management.md)

## Contributing

Contributions of features, fixes, documentation, and tests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before getting started.

```bash
bun run precheck
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=HuangPuStar/FenixAgent&type=Date)](https://www.star-history.com/#HuangPuStar/FenixAgent&Date)

## License

FenixAgent Community Edition is licensed under the [Apache License 2.0](LICENSE).
