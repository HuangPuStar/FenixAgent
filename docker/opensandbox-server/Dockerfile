FROM opensandbox/server:latest

USER root

ENV PATH="/app/.venv/bin:${PATH}"

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io docker-cli iptables ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/opensandbox-server-entrypoint
RUN chmod +x /usr/local/bin/opensandbox-server-entrypoint \
  && mkdir -p /var/lib/docker /var/run/docker

ENTRYPOINT ["/usr/local/bin/opensandbox-server-entrypoint"]
