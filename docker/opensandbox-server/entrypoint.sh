#!/bin/sh
set -eu

# 当前镜像是单容器 DinD 部署：不要挂载宿主机 /var/run/docker.sock。
# dockerd-entrypoint.sh 来自官方 docker:dind，负责 Docker/containerd 的初始化和 PID 清理。
docker_socket="unix:///var/run/docker.sock"
docker_log_file="${DOCKER_LOG_FILE:-/var/log/dockerd.log}"
docker_pid=""
server_pid=""

stop_children() {
  status=$?
  trap - INT TERM EXIT

  if [ -n "$server_pid" ] && kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi

  if [ -n "$docker_pid" ] && kill -0 "$docker_pid" 2>/dev/null; then
    kill -TERM "$docker_pid" 2>/dev/null || true
    i=0
    while kill -0 "$docker_pid" 2>/dev/null && [ "$i" -lt 15 ]; do
      sleep 1
      i=$((i + 1))
    done
    if kill -0 "$docker_pid" 2>/dev/null; then
      kill -KILL "$docker_pid" 2>/dev/null || true
    fi
    wait "$docker_pid" 2>/dev/null || true
  fi

  exit "$status"
}

trap stop_children INT TERM EXIT

# 不直接调用 dockerd，避免绕过官方 DinD 的 containerd、iptables 和信号处理逻辑。
: >"$docker_log_file"
/usr/local/bin/dockerd-entrypoint.sh >"$docker_log_file" 2>&1 &
docker_pid=$!

i=0
while ! docker -H "$docker_socket" info >/dev/null 2>&1; do
  if ! kill -0 "$docker_pid" 2>/dev/null; then
    echo "docker daemon exited before becoming ready" >&2
    cat "$docker_log_file" >&2 || true
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "docker daemon did not become ready" >&2
    cat "$docker_log_file" >&2 || true
    exit 1
  fi
  sleep 1
done

# 加载构建期预打包的 execd 镜像。
if [ -f /opt/opensandbox/seed-images/opensandbox-execd.tar ] \
  && ! docker -H "$docker_socket" image inspect opensandbox/execd:v1.0.18 >/dev/null 2>&1; then
  echo "Loading seed image opensandbox/execd:v1.0.18"
  docker -H "$docker_socket" load -i /opt/opensandbox/seed-images/opensandbox-execd.tar
fi

# Server 和 dockerd 共用当前容器生命周期；任一进程退出时，另一个进程也会被优雅停止。
"$@" &
server_pid=$!

while kill -0 "$server_pid" 2>/dev/null && kill -0 "$docker_pid" 2>/dev/null; do
  sleep 1
done

if ! kill -0 "$docker_pid" 2>/dev/null; then
  echo "docker daemon exited while OpenSandbox Server was running" >&2
  cat "$docker_log_file" >&2 || true
  kill -TERM "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  exit 1
fi

wait "$server_pid"
