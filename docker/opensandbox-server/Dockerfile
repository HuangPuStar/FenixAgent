FROM docker:27.5.1-dind AS dind

FROM opensandbox/server:v0.2.2

USER root

ENV PATH="/app/.venv/bin:${PATH}"
ENV DOCKER_TLS_CERTDIR=""

RUN apt-get update \
  && apt-get install -y --no-install-recommends docker.io docker-cli iptables ca-certificates skopeo \
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
