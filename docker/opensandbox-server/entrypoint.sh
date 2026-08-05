#!/bin/sh
set -eu

if [ -S /var/run/docker.sock ]; then
  exec "$@"
fi

mkdir -p /var/run/docker
dockerd \
  --host=unix:///var/run/docker.sock \
  --data-root="${DOCKER_DATA_ROOT:-/var/lib/docker}" \
  >"${DOCKER_LOG_FILE:-/var/log/dockerd.log}" 2>&1 &

docker_pid=$!
trap 'kill "$docker_pid" 2>/dev/null || true' INT TERM EXIT

i=0
while ! docker -H unix:///var/run/docker.sock info >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "docker daemon did not become ready" >&2
    exit 1
  fi
  sleep 1
done

exec "$@"
