FROM oven/bun:1 AS base

# Install opencode globally (acp-link spawns "opencode acp" as agent subprocess)
# Pin to 1.14.41 to match the version known to work with ACP session creation
RUN bun install -g opencode-ai@1.14.41 \
    && rm -rf /root/.bun/install/cache /tmp/bun-*

# Trigger opencode to install its built-in provider plugins (needed for ACP model availability)
RUN opencode --help > /dev/null 2>&1 || true

# Create opencode config dir (no custom config needed — defaults work)
RUN mkdir -p /root/.config/opencode

# Copy pre-built acp-link binary (build context is repo root)
# TARGETARCH is set by Docker during multi-platform builds (amd64 / arm64)
ARG TARGETARCH
COPY docker/acp-link/acp-link-linux-${TARGETARCH} /usr/local/bin/acp-link
RUN chmod +x /usr/local/bin/acp-link

ENTRYPOINT ["/usr/local/bin/acp-link"]
