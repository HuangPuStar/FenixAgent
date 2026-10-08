#!/bin/sh
#
# 在共享 postgres 里建 litellm 的库与角色（一次性、幂等）。属 docker/litellm/ 的部署面：独立部署时要随本目录交付。
#
# 谁在跑它：同目录 docker-compose.yml 的 litellm-db-init 服务，以
#   entrypoint: ["/bin/sh", "/init/init-db.sh"] + ./init-db.sh:/init/init-db.sh:ro 只读挂载执行。
# 为什么单独成文件而不内联进 compose 的 command：这段逻辑有分支与 heredoc，内联后 compose 既难 review，
#   脚本里的 shell 变量还会被 compose 的插值吃掉（同仓库 docker/workflow/ 的同类服务就踩过这个坑）。
#
# 幂等：库与角色已存在时不重建、不删数据，只把角色口令同步成环境变量里的值（收敛 .env 与库内的漂移）。
# 失败可诊断：连不上实例 / 认证失败 / 建对象失败分别给出原始报错与判定，任何一步失败都以非 0 退出——
#   litellm 以「本服务成功退出」为前置，失败不会静默变成「网关没有库」。
# 依赖的环境变量（由 compose 注入）：PGHOST / PGUSER / PGPASSWORD / PGDATABASE / LITELLM_DB_PASSWORD。

set -eu

# 就绪等待：跨项目的 depends_on 不成立（compose 只认本项目内已定义的服务名），只能自己探活。
# 判据用真实的 select 而不是 pg_isready：后者在口令不对时同样返回成功，那样「口令漂移」会被放过，
# 直到建库时才以更难读的形式暴露。
attempt=0
last_error=""
while [ "$attempt" -lt 180 ]; do
    if probe="$(psql -tAc 'select 1' 2>&1)" && [ "$probe" = "1" ]; then
        break
    fi
    last_error="$probe"
    attempt=$((attempt + 1))
    if [ "$attempt" -eq 1 ] || [ $((attempt % 30)) -eq 0 ]; then
        echo "等待共享 postgres 就绪（第 ${attempt} 次尝试）：${last_error}" >&2
    fi
    sleep 2
done
if [ "$attempt" -ge 180 ]; then
    echo "初始化中止：共享 postgres 在 360 秒内不可用。最后一次报错：${last_error}" >&2
    case "$last_error" in
        *authentication*)
            echo "判定：实例在跑但认证失败 → 根 .env 的 POSTGRES_PASSWORD 必须与实例数据目录里的口令一致（口令写在数据目录里，改 .env 不会改库里已有的账号）。" >&2
            ;;
        *)
            echo "判定：连不上实例 → 顶层项目是否已起（docker compose -f docker-compose.yml ps postgres，期望 healthy）、fenix-server 网络是否存在（docker network ls）。" >&2
            ;;
    esac
    exit 1
fi

# 下面两条判断只为日志：真正保证幂等的是 SQL 里的条件执行，重跑不会重建、不会删数据。
if [ "$(psql -tAc "select 1 from pg_roles where rolname = 'litellm'")" = "1" ]; then
    echo "角色 litellm 已存在：本次只同步口令。"
else
    echo "创建角色 litellm（LOGIN，非超级用户：不给 SUPERUSER / CREATEDB / CREATEROLE）。"
fi
if [ "$(psql -tAc "select 1 from pg_database where datname = 'litellm'")" = "1" ]; then
    echo "库 litellm 已存在：跳过创建，不动库里任何对象。"
else
    echo "创建库 litellm（属主 litellm）。"
fi

# 库名与角色名写死在这里，与 compose 里 litellm 的 DATABASE_URL 同值：它们不是部署参数，
# 从环境传进来只会多一处能改错的地方。
#
# 为什么不用 DO 块（dollar-quoted 匿名块）：psql 的变量替换不进 dollar-quoted 块（:'pw' 不会被展开），
# 而 CREATE DATABASE 又不能放进 DO / 事务块，两处统一成「SELECT 出 DDL → \gexec 条件执行」。
# 口令经 \getenv 从环境读，不进 argv、不经 shell 拼接，转义交给 psql 的 :'pw'。
# REVOKE CONNECT：库里只有 litellm 一个消费方，把 PUBLIC 的连接权限收回（属主与超级用户不受影响）。
psql -v ON_ERROR_STOP=1 <<'SQL'
\getenv pw LITELLM_DB_PASSWORD
SELECT 'CREATE ROLE litellm LOGIN PASSWORD ' || quote_literal(:'pw')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'litellm')
\gexec
ALTER ROLE litellm WITH LOGIN PASSWORD :'pw';
SELECT 'CREATE DATABASE litellm OWNER litellm'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'litellm')
\gexec
REVOKE CONNECT ON DATABASE litellm FROM PUBLIC;
SQL

echo "初始化完成：库 litellm 与角色 litellm 已就绪，口令与根 .env 一致。"
