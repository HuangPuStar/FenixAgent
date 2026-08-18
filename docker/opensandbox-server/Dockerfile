FROM docker:27.5.1-dind AS dind

FROM opensandbox/server:v0.2.2

ARG FRP_VERSION=0.69.0
ARG TARGETARCH

USER root

ENV PATH="/app/.venv/bin:${PATH}"
ENV DOCKER_TLS_CERTDIR=""

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io docker-cli iptables ca-certificates skopeo curl \
  && case "${TARGETARCH}" in amd64) frp_sha="6b90d1cd28fc661f170c0de90dde03d2c63e4fd7ce0ae2da2ca1c28014b8146e" ;; arm64) frp_sha="24a4fc82b4c041835103419685ea124c4d6a7dbf83d0425481c5831b4ce4b3a4" ;; *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; esac \
  && curl -fsSL -o /tmp/frp.tar.gz "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${TARGETARCH}.tar.gz" \
  && echo "${frp_sha}  /tmp/frp.tar.gz" | sha256sum -c - \
  && tar -xzf /tmp/frp.tar.gz -C /tmp \
  && install -m 0755 "/tmp/frp_${FRP_VERSION}_linux_${TARGETARCH}/frpc" /usr/local/bin/frpc \
  && rm -rf /tmp/frp.tar.gz "/tmp/frp_${FRP_VERSION}_linux_${TARGETARCH}" \
  && rm -rf /var/lib/apt/lists/*

# 复用官方 DinD 的 dockerd 初始化逻辑；Docker daemon 仍使用当前基础镜像安装的 Docker 包。
COPY --from=dind /usr/local/bin/dockerd-entrypoint.sh /usr/local/bin/dockerd-entrypoint.sh
COPY --from=dind /usr/local/bin/docker-init /usr/local/bin/docker-init

# 构建期预拉取 execd 镜像存为 tar,运行时 entrypoint 加载进 DinD,避免每次部署手动下载
RUN mkdir -p /opt/opensandbox/seed-images \
  && skopeo copy --retry-times=3 \
     docker://docker.io/opensandbox/execd:v1.0.18 \
     docker-archive:/opt/opensandbox/seed-images/opensandbox-execd.tar:opensandbox/execd:v1.0.18

COPY entrypoint.sh /usr/local/bin/opensandbox-server-entrypoint
RUN chmod +x /usr/local/bin/opensandbox-server-entrypoint \
  && mkdir -p /var/lib/docker /var/run/docker

ENTRYPOINT ["/usr/local/bin/opensandbox-server-entrypoint"]
