#!/bin/sh
#
# docker/workflow/init-mysql.sh —— 共享 MySQL 里「属于本栈」的对象初始化（一次性 job，执行完即退出）。
#
# 谁调用：docker-compose.yml 的 `mysql-init` 服务，显式覆盖 entrypoint 为 ["/bin/sh", "/init/init-mysql.sh"]，
#         本文件以只读方式挂载到容器内 /init/init-mysql.sh（compose 与脚本都不依赖宿主的可执行位）。
# 为什么单独成文件而不内联进 compose：脚本有分支与失败诊断，内联进 YAML 标量后既难 review 也容易被
#         YAML 折叠规则悄悄改写（折行会把注释与后续语句并到同一行）。
# 环境变量（由 compose 显式注入，值来自仓库根 .env / 部署 env）：
#         MYSQL_HOST / MYSQL_DATABASE / MYSQL_USER / MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD
# 只读输入：/schema.sql（上游 docker/volumes/mysql/schema.sql）
#         /opencoze_latest_schema.hcl（上游 docker/atlas/opencoze_latest_schema.hcl）
#
# 幂等：可重复执行，重跑不覆盖既有库 / 账号 / 表。
#   - CREATE DATABASE / CREATE USER 都用 IF NOT EXISTS：MySQL 8 原生支持，比「先查 information_schema 再建」
#     少一次往返、也没有 TOCTOU 窗口（同一版本的上游 schema.sql 也用了这个写法）。
#   - 账号已存在时 MySQL 只发 warning、不改其口令（这正是「不覆盖既有对象」要的行为）；口令与配置漂移
#     由第 ③ 步的自检当场暴露。
#   - Atlas apply 与上游 mysql 容器原先的调用完全一致（同样的 --to / --exclude），重复执行即空操作。
# 失败可诊断：连接失败 / root 认证失败 / 应用账号口令漂移 / schema 未生效，各自有独立文案与非零退出码；
#         退出码会被 compose 的 depends_on: service_completed_successfully 反映到 coze-server 上。

set -e

echo '① 等待共享 MySQL 可用并可认证（最多 300 秒）...'
i=0
until mysql -h "$MYSQL_HOST" -u root -p"$MYSQL_ROOT_PASSWORD" -e 'SELECT 1' >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 150 ]; then
    echo '共享 MySQL 不可用（300 秒内未通过认证），按下面两条分别排查：' >&2
    if mysql -h "$MYSQL_HOST" -u root -p"$MYSQL_ROOT_PASSWORD" -e 'SELECT 1' 2>&1 | grep -qi 'access denied'; then
      echo '  - 服务器可达但 root 认证失败：根 .env 的 MYSQL_ROOT_PASSWORD 与共享实例里的不一致。' >&2
    else
      echo '  - 服务器不可达：docker/deploy.env 的 FENIX_FEATURE_MYSQL 是否为 true、顶层项目是否已起、本容器是否在 fenix-server 网络上。' >&2
    fi
    exit 1
  fi
  sleep 2
done

echo '② 幂等创建库与账号（已存在则跳过，不覆盖既有对象）...'
mysql -h "$MYSQL_HOST" -u root -p"$MYSQL_ROOT_PASSWORD" \
  -e "CREATE DATABASE IF NOT EXISTS $MYSQL_DATABASE CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
mysql -h "$MYSQL_HOST" -u root -p"$MYSQL_ROOT_PASSWORD" \
  -e "CREATE USER IF NOT EXISTS '$MYSQL_USER'@'%' IDENTIFIED BY '$MYSQL_PASSWORD';"
mysql -h "$MYSQL_HOST" -u root -p"$MYSQL_ROOT_PASSWORD" \
  -e "GRANT ALL PRIVILEGES ON $MYSQL_DATABASE.* TO '$MYSQL_USER'@'%';"
mysql -h "$MYSQL_HOST" -u root -p"$MYSQL_ROOT_PASSWORD" -e 'FLUSH PRIVILEGES;'

echo '③ 用应用账号自检（口令与配置不一致时当场失败，不拖到 coze-server 连不上才查）...'
if ! mysql -h "$MYSQL_HOST" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" -e 'SELECT 1' >/dev/null 2>&1; then
  echo '应用账号认证失败：账号已存在但口令与 MYSQL_PASSWORD 不一致（本脚本不覆盖已有账号的口令）。' >&2
  echo '处理：要么把根 .env / 上游 docker/.env 的 MYSQL_PASSWORD 改回实例里的旧口令，要么在实例里 ALTER USER 改口令（会同时影响其他消费方）。' >&2
  exit 1
fi

echo '④ 应用上游 schema（schema.sql + Atlas）...'
mysql -h "$MYSQL_HOST" -u root -p"$MYSQL_ROOT_PASSWORD" < /schema.sql

if ! mysql -h "$MYSQL_HOST" -u root -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE" \
  -e "SHOW TABLES LIKE 'workflow_version';" 2>/dev/null | grep -q workflow_version; then
  echo 'schema.sql 执行后仍找不到 workflow_version 表：检查 schema.sql 是否与上游版本一致' >&2
  exit 1
fi

echo 'Installing Atlas CLI...'
curl -sSf https://atlasgo.sh | sh -s -- -y --community
PATH="$PATH:/root/.local/bin"
export PATH

echo 'Running Atlas migrations...'
atlas schema apply -u "mysql://$MYSQL_USER:$MYSQL_PASSWORD@$MYSQL_HOST:3306/$MYSQL_DATABASE" \
  --to "file:///opencoze_latest_schema.hcl" --exclude "atlas_schema_revisions,table_*" --auto-approve

echo 'mysql-init 完成：库 / 账号 / schema 均已就绪'
