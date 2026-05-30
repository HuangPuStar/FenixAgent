# Multi-platform acp-link binary image
# Build: docker build --platform linux/amd64,linux/arm64 .
# The correct binary is selected via TARGETARCH build arg.

FROM debian:bookworm-slim
ARG TARGETARCH
COPY acp-link-linux-${TARGETARCH} /usr/local/bin/acp-link
RUN chmod +x /usr/local/bin/acp-link
ENTRYPOINT ["/usr/local/bin/acp-link"]
