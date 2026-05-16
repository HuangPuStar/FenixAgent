import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

const DATABASE_URL = process.env.DATABASE_URL || "postgres://rcs:rcs@localhost:5432/rcs";
export const client = postgres(DATABASE_URL);
export const db = drizzle(client, { schema });

export async function initDb() {
  // Suppress NOTICE-level messages from CREATE IF NOT EXISTS / ALTER IF NOT EXISTS
  await client.unsafe(`SET client_min_messages TO WARNING`);

  // Create better-auth tables first — custom tables reference "user"(id) via FK.
  // better-auth's drizzleAdapter auto-creates these on first request, but we need them now.
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS "user" (
      id TEXT PRIMARY KEY,
      name VARCHAR NOT NULL,
      email VARCHAR NOT NULL UNIQUE,
      email_verified BOOLEAN NOT NULL DEFAULT FALSE,
      image TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS "session" (
      id TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ip_address TEXT,
      user_agent TEXT,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS account (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at TIMESTAMPTZ,
      refresh_token_expires_at TIMESTAMPTZ,
      scope TEXT,
      password TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ
    );
  `);

  // Custom tables in dependency order.

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS api_key (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      key VARCHAR NOT NULL UNIQUE,
      label VARCHAR NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_api_key_key ON api_key(key);
    CREATE INDEX IF NOT EXISTS idx_api_key_user_id ON api_key(user_id);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS mcp_tool (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      server_name VARCHAR NOT NULL,
      tool_name VARCHAR NOT NULL,
      description TEXT,
      input_schema JSONB,
      inspected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_tool_server ON mcp_tool(server_name);
    CREATE INDEX IF NOT EXISTS idx_mcp_tool_server_tool ON mcp_tool(server_name, tool_name);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS share_link (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      session_id VARCHAR NOT NULL,
      environment_id VARCHAR NOT NULL,
      token VARCHAR NOT NULL UNIQUE,
      mode VARCHAR(20) NOT NULL CHECK (mode IN ('readonly', 'writable')),
      expires_at TIMESTAMPTZ,
      created_by VARCHAR NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS share_event_snapshot (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      share_link_id UUID REFERENCES share_link(id) ON DELETE CASCADE,
      events JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // F002: 配置表 — provider/model/agent_config 必须在 environment 之前（FK 依赖）

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS provider (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name VARCHAR NOT NULL,
      display_name VARCHAR,
      npm VARCHAR,
      base_url TEXT,
      api_key TEXT,
      extra_options JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_user_name ON provider(user_id, name);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS model (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      provider_id UUID NOT NULL REFERENCES provider(id) ON DELETE CASCADE,
      model_id VARCHAR NOT NULL,
      display_name VARCHAR,
      modalities JSONB,
      limit_config JSONB,
      cost JSONB,
      options JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_model_provider_model ON model(provider_id, model_id);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS agent_config (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name VARCHAR NOT NULL,
      model VARCHAR,
      prompt TEXT,
      steps INTEGER,
      mode VARCHAR(20),
      permission JSONB,
      variant VARCHAR,
      temperature NUMERIC,
      top_p NUMERIC,
      disable BOOLEAN NOT NULL DEFAULT FALSE,
      hidden BOOLEAN NOT NULL DEFAULT FALSE,
      color VARCHAR,
      description TEXT,
      knowledge JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_config_user_name ON agent_config(user_id, name);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS mcp_server (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name VARCHAR NOT NULL,
      type VARCHAR(10) NOT NULL,
      config JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_server_user_name ON mcp_server(user_id, name);
  `);

  // environment 引用 agent_config(id)，所以必须放在 agent_config 之后
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS environment (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      name VARCHAR NOT NULL UNIQUE,
      description TEXT,
      workspace_path VARCHAR NOT NULL,
      agent_name VARCHAR,
      agent_config_id UUID REFERENCES agent_config(id) ON DELETE SET NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'idle',
      machine_name VARCHAR,
      branch VARCHAR,
      git_repo_url VARCHAR,
      max_sessions INTEGER NOT NULL DEFAULT 1,
      worker_type VARCHAR(50) NOT NULL DEFAULT 'acp',
      capabilities JSONB,
      secret VARCHAR NOT NULL,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      auto_start BOOLEAN NOT NULL DEFAULT FALSE,
      last_poll_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_environment_user_id ON environment(user_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_secret ON environment(secret);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_environment_name ON environment(name);
  `);

  // 向已有 environment 表补充 agent_config_id 列（幂等）
  await client.unsafe(`
    DO $$ BEGIN
      ALTER TABLE environment ADD COLUMN IF NOT EXISTS agent_config_id UUID REFERENCES agent_config(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS knowledge_base (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name VARCHAR NOT NULL,
      slug VARCHAR NOT NULL,
      description TEXT,
      provider VARCHAR NOT NULL DEFAULT 'openviking',
      remote_id VARCHAR,
      remote_account_id VARCHAR,
      remote_user_id VARCHAR,
      status VARCHAR(50) NOT NULL DEFAULT 'empty',
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_base_user_slug ON knowledge_base(user_id, slug);
    CREATE INDEX IF NOT EXISTS idx_knowledge_base_user_status ON knowledge_base(user_id, status);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS knowledge_resource (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      knowledge_base_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
      source_type VARCHAR NOT NULL,
      source_name VARCHAR NOT NULL,
      source_path TEXT,
      remote_id VARCHAR,
      status VARCHAR NOT NULL DEFAULT 'pending',
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_resource_kb ON knowledge_resource(knowledge_base_id);
    CREATE INDEX IF NOT EXISTS idx_knowledge_resource_status ON knowledge_resource(status);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS agent_knowledge_binding (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      agent_name VARCHAR NOT NULL,
      knowledge_base_id UUID NOT NULL REFERENCES knowledge_base(id) ON DELETE CASCADE,
      priority INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_knowledge_binding_agent ON agent_knowledge_binding(agent_name);
    CREATE INDEX IF NOT EXISTS idx_agent_knowledge_binding_kb ON agent_knowledge_binding(knowledge_base_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_knowledge_binding_agent_kb ON agent_knowledge_binding(agent_name, knowledge_base_id);
  `);

  // scheduled_task：HTTP Cron 模式（environment_id/task 改为可选）
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS scheduled_task (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name VARCHAR NOT NULL,
      description TEXT,
      cron VARCHAR NOT NULL,
      timezone VARCHAR,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      environment_id UUID REFERENCES environment(id) ON DELETE CASCADE,
      task TEXT,
      timeout_minutes INTEGER NOT NULL DEFAULT 30,
      url TEXT NOT NULL,
      method VARCHAR(10) NOT NULL DEFAULT 'POST',
      headers JSONB,
      body TEXT,
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ,
      last_status VARCHAR,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_task_user_id ON scheduled_task(user_id);
  `);

  // 向已有 scheduled_task 表补充 HTTP Cron 字段（幂等）
  await client.unsafe(`
    DO $$ BEGIN
      ALTER TABLE scheduled_task ADD COLUMN IF NOT EXISTS url TEXT;
      ALTER TABLE scheduled_task ADD COLUMN IF NOT EXISTS method VARCHAR(10) DEFAULT 'POST';
      ALTER TABLE scheduled_task ADD COLUMN IF NOT EXISTS headers JSONB;
      ALTER TABLE scheduled_task ADD COLUMN IF NOT EXISTS body TEXT;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS task_execution_log (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      task_id UUID NOT NULL REFERENCES scheduled_task(id) ON DELETE CASCADE,
      status VARCHAR NOT NULL,
      error TEXT,
      duration INTEGER,
      triggered_by VARCHAR NOT NULL DEFAULT 'cron',
      workspace_path VARCHAR,
      workspace_name VARCHAR,
      environment_id VARCHAR,
      environment_name VARCHAR,
      task_snapshot JSONB,
      skip_reason TEXT,
      result_summary TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_task_execution_log_task_id ON task_execution_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_execution_log_created_at ON task_execution_log(created_at);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS channel_binding (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      platform VARCHAR NOT NULL,
      chat_id VARCHAR,
      agent_id VARCHAR NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_channel_binding_platform ON channel_binding(platform);
    CREATE INDEX IF NOT EXISTS idx_channel_binding_agent_id ON channel_binding(agent_id);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS agent_session (
      id VARCHAR PRIMARY KEY,
      environment_id UUID REFERENCES environment(id) ON DELETE SET NULL,
      title VARCHAR,
      status VARCHAR NOT NULL,
      source VARCHAR NOT NULL,
      permission_mode VARCHAR,
      worker_epoch INTEGER NOT NULL DEFAULT 0,
      username VARCHAR,
      user_id TEXT,
      cwd VARCHAR,
      share_mode VARCHAR(20) NOT NULL DEFAULT 'none',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_session_env ON agent_session(environment_id);
  `);

  // skill 引用 agent_config(id)，放在 agent_config 之后
  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS skill (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      environment_id UUID REFERENCES environment(id) ON DELETE CASCADE,
      agent_config_id UUID REFERENCES agent_config(id) ON DELETE CASCADE,
      name VARCHAR NOT NULL,
      description TEXT,
      content_path TEXT,
      metadata JSONB,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_skill_global ON skill(user_id, name);
    CREATE INDEX IF NOT EXISTS idx_skill_workspace ON skill(user_id, environment_id, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_global_unique ON skill(user_id, name) WHERE environment_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_workspace_unique ON skill(user_id, environment_id, name) WHERE environment_id IS NOT NULL;
  `);

  // 向已有 skill 表补充 agent_config_id 列（幂等）
  await client.unsafe(`
    DO $$ BEGIN
      ALTER TABLE skill ADD COLUMN IF NOT EXISTS agent_config_id UUID REFERENCES agent_config(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_skill_agent_config ON skill(agent_config_id);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS user_config (
      user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
      default_agent VARCHAR,
      current_model VARCHAR,
      small_model VARCHAR,
      permission JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Plan 08: IMChannel + IMChannelRoute

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS im_channel (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name VARCHAR NOT NULL,
      platform VARCHAR NOT NULL,
      credentials JSONB NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'disconnected',
      last_error TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_im_channel_user_platform ON im_channel(user_id, platform, name);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS im_channel_route (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      channel_id UUID NOT NULL REFERENCES im_channel(id) ON DELETE CASCADE,
      chat_id VARCHAR NOT NULL,
      environment_id UUID NOT NULL REFERENCES environment(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_im_channel_route_channel_chat ON im_channel_route(channel_id, chat_id);
    CREATE INDEX IF NOT EXISTS idx_im_channel_route_environment ON im_channel_route(environment_id);
  `);

  // Plan 07: Workflow + WorkflowRun

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS workflow (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      name VARCHAR NOT NULL,
      description TEXT,
      steps JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_user_name ON workflow(user_id, name);
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS workflow_run (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      workflow_id UUID NOT NULL REFERENCES workflow(id) ON DELETE CASCADE,
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      input JSONB,
      output JSONB,
      step_results JSONB,
      triggered_by VARCHAR NOT NULL DEFAULT 'manual',
      error TEXT,
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_run_workflow ON workflow_run(workflow_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_run_status ON workflow_run(status);
  `);

  // Plan 11: Team + TeamMember

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS team (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      name VARCHAR NOT NULL,
      slug VARCHAR NOT NULL UNIQUE,
      description TEXT,
      created_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await client.unsafe(`
    CREATE TABLE IF NOT EXISTS team_member (
      id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
      team_id UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      role VARCHAR(20) NOT NULL DEFAULT 'member',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_team_member_team_user ON team_member(team_id, user_id);
  `);
}
