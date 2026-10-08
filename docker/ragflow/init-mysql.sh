#!/bin/sh
#
# docker/ragflow/init-mysql.sh —— 共享 MySQL 里「属于本栈」的对象初始化（一次性 job，执行完即退出）。
#
# 谁调用：docker-compose.yml 的 ragflow-mysql-init 服务，显式覆盖 entrypoint 为
#         ["/bin/sh", "/init/init-mysql.sh"]，本文件以只读方式挂载到容器内 /init/init-mysql.sh
#         （compose 与脚本都不依赖宿主的可执行位）。
# 为什么单独成文件而不内联进 compose：脚本有分支与失败诊断，内联进 YAML 标量后既难 review，
#         也容易被 YAML 折叠规则悄悄改写（折行会把注释与后续语句并到同一行）。
# 环境变量（由 compose 显式注入；口令分别来自本目录 .env 与主服务 env）：
#         MYSQL_HOST / MYSQL_DATABASE / MYSQL_USER / MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD
#
# 范围：只建库、建账号、授权。**不建表、不跑 schema 迁移**——RAGFlow 镜像自己的启动流程里有
#         mysql_migration.py（docker/entrypoint.sh），schema 归持有它的那一方（§5.1 同一口径）。
#
# 幂等：可重复执行；重跑不重建库、不删数据、不影响共享实例上别的栈的对象。
#   - CREATE DATABASE / CREATE USER 用 IF NOT EXISTS（MySQL 8 原生支持），建库语句写死字符集，
#     与共享实例服务器的默认值（common 的 --character-set-server/--collation-server）以及
#     旧栈内实例保持一致，避免同一份 schema 在两台实例上落到不同字符集。
#   - 「对象已存在」先按信息模式查出来打印：重跑时日志一眼能看出本次是创建还是跳过。
#   - 与 docker/workflow/init-mysql.sh 的唯一差别：这里对**本栈自己的账号**执行 ALTER USER 同步口令。
#     那边不同步，是因为它的账号口令同时写在仓库外的上游 docker/.env 里（「两处同值」是约定，脚本不替它决定）；
#     本栈账号只被本目录使用，于是口令漂移由重跑本脚本收敛，不需要人工进库 ALTER。
#   - 不需要 FLUSH PRIVILEGES：GRANT / CREATE USER 走数据字典、立即生效；FLUSH 只对「直接改 mysql.*
#     授权表」这件事有意义，加在这里是噪音。
# 库名与账号名是 compose 里的字面量，不经部署环境传入（与 docker/litellm/ 的「库名角色名写死」同一口径）：
#         它们不是部署参数，多一个入口只会多一处能改错的地方。
#
# 失败可诊断（各自独立文案 + 非零退出码，退出码经 depends_on: service_completed_successfully 反映到 ragflow）：
#   ① 连不上实例 / root 认证失败；② root 权限不足、DDL 被拒；③ 本栈账号连不上或授权没落地。

set -e

log() { echo "[ragflow-mysql-init] $*"; }
fail() { echo "[ragflow-mysql-init] $*" >&2; exit 1; }

# 口令里的反斜杠与单引号要先转义再拼进 SQL：mysql 客户端的 -e 没有绑定参数，转义只能由调用方做。
# 顺序不能换（先反斜杠再单引号），否则会把自己加进去的转义符再转一次。
sql_quote() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e "s/'/''/g"
}

# 超级用户连接。地址用容器内显式服务名（compose 注入的 MYSQL_HOST），不走宿主键插值（§8.4）。
root_sql() {
  mysql -h "$MYSQL_HOST" -u root -p"$MYSQL_ROOT_PASSWORD" "$@"
}

log '① 等待共享 MySQL 可用并可认证（最多 300 秒）...'
attempt=0
last_error=""
while [ "$attempt" -lt 150 ]; do
  if probe="$(root_sql -N -B -e 'SELECT 1' 2>&1)" && [ "$probe" = "1" ]; then
    log "共享 MySQL 已就绪：$MYSQL_HOST"
    break
  fi
  last_error="$probe"
  attempt=$((attempt + 1))
  if [ "$attempt" -eq 1 ] || [ $((attempt % 30)) -eq 0 ]; then
    log "等待中（第 ${attempt} 次）：${last_error}"
  fi
  sleep 2
done

if [ "$attempt" -ge 150 ]; then
  {
    echo "[ragflow-mysql-init] 初始化中止：共享 MySQL 在 300 秒内不可用。最后一次报错：${last_error}"
    case "$last_error" in
      *"Access denied"*)
        echo "[ragflow-mysql-init] 判定：实例在跑但 root 认证失败 → 主服务 env 的 MYSQL_ROOT_PASSWORD 必须与实例数据目录里的口令一致（口令写在数据目录里，改 .env 不会改库里已有的账号）。"
        ;;
      *)
        echo "[ragflow-mysql-init] 判定：连不上实例 → docker/deploy.env 的 FENIX_FEATURE_MYSQL 是否为 true、顶层项目是否已起（docker compose -f docker-compose.yml ps mysql，期望 healthy）、本容器是否在 fenix-server 网络上（docker network inspect fenix-server）。"
        ;;
    esac
  } >&2
  exit 1
fi

log '② 幂等创建库与账号（已存在则跳过创建，口令同步成 .env 里的值）...'
db_exists="$(root_sql -N -B -e "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name = '$MYSQL_DATABASE'")"
# 账号存在性按 (user, host) 判断：MySQL 的账号是「用户名 + 来源主机」的组合，只看用户名会漏判（§⑤ 同理）。
user_exists="$(root_sql -N -B -e "SELECT COUNT(*) FROM mysql.user WHERE user = '$MYSQL_USER' AND host = '%'")"
if [ "$db_exists" = "1" ]; then
  log "  库 $MYSQL_DATABASE 已存在：跳过创建，不动库里任何对象。"
else
  log "  创建库 $MYSQL_DATABASE（CHARACTER SET utf8mb4 / COLLATE utf8mb4_unicode_ci）。"
fi
if [ "$user_exists" = "1" ]; then
  log "  账号 $MYSQL_USER@% 已存在：只同步口令，不重建、不动它的授权历史。"
else
  log "  创建账号 $MYSQL_USER@%（非超级用户：不授予全局权限，只授本库）。"
fi

pw_escaped="$(sql_quote "$MYSQL_PASSWORD")"
run_ddl() {
  # 统一处理 DDL 失败：原样回显实例的报错，再给一条判定，避免「只说失败不说是哪一类」。
  if ! ddl_error="$(root_sql -e "$1" 2>&1)"; then
    {
      echo "[ragflow-mysql-init] SQL 执行失败：$1"
      echo "[ragflow-mysql-init] 实例返回：${ddl_error}"
      case "$ddl_error" in
        *"command denied"* | *"Access denied"*)
          echo "[ragflow-mysql-init] 判定：root 权限不足（实例在跑、认证也过了，但 root 不允许改库/授权）→ 这是被加固过的实例，需要实例管理员放权；本栈不会改用别的账号绕过。"
          ;;
        *)
          echo "[ragflow-mysql-init] 判定：DDL 被实例拒绝，按上面的原始报错处理（语法/版本差异/资源限制）。"
          ;;
      esac
    } >&2
    exit 1
  fi
}

run_ddl "CREATE DATABASE IF NOT EXISTS \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
run_ddl "CREATE USER IF NOT EXISTS '$MYSQL_USER'@'%' IDENTIFIED BY '$pw_escaped';"
# 已有账号的口令按 .env 收敛（本栈账号只服务本目录，见文件头）；新账号上这两条是同一结果。
run_ddl "ALTER USER '$MYSQL_USER'@'%' IDENTIFIED BY '$pw_escaped';"
run_ddl "GRANT ALL PRIVILEGES ON \`$MYSQL_DATABASE\`.* TO '$MYSQL_USER'@'%';"

log '③ 用本栈账号自检（口令与授权是否真的落地，不拖到 ragflow 起不来才查）...'
if ! app_probe="$(mysql -h "$MYSQL_HOST" -u "$MYSQL_USER" -p"$MYSQL_PASSWORD" -D "$MYSQL_DATABASE" -N -B -e 'SELECT 1' 2>&1)" || [ "$app_probe" != "1" ]; then
  {
    echo "[ragflow-mysql-init] 本栈账号 $MYSQL_USER@% 自检失败：${app_probe}"
    case "$app_probe" in
      *"Access denied"*)
        echo "[ragflow-mysql-init] 判定：认证未通过（第 ② 步已同步过口令，因此更可能是账号以别的 host 模式存在，例如 $MYSQL_USER@'172.%' 或 $MYSQL_USER@'localhost'——本脚本只维护 $MYSQL_USER@'%'；或实例拒绝了下发口令的 ALTER USER）。"
        ;;
      *"Unknown database"*)
        echo "[ragflow-mysql-init] 判定：库 $MYSQL_DATABASE 不存在或不可见 → 第 ② 步的建库语句是否被拒绝（见它上面的输出）。"
        ;;
      *)
        echo "[ragflow-mysql-init] 判定：账号存在但连接/选库失败，按上面的原始报错处理。"
        ;;
    esac
  } >&2
  exit 1
fi

# 授权落地的证据：信息模式里的库级授权 + SHOW GRANTS 原文（写进日志，排障时不必再进库查）。
# grantee 的比较值用单引号包裹并做 SQL 转义（'''…''@''…'''），不依赖 ANSI_QUOTES 是否开启。
grant_count="$(root_sql -N -B -e "SELECT COUNT(*) FROM information_schema.schema_privileges WHERE grantee = '''$MYSQL_USER''@''%''' AND table_schema = '$MYSQL_DATABASE'")"
if [ "$grant_count" = "0" ]; then
  fail "库级授权没查到（information_schema.schema_privileges 无 $MYSQL_USER@% → $MYSQL_DATABASE 的记录）：GRANT 语句可能被实例改写或拒绝，请核对第 ② 步的输出。"
fi
log "  授权条目：${grant_count} 条；SHOW GRANTS 原文："
root_sql -N -B -e "SHOW GRANTS FOR '$MYSQL_USER'@'%'" | sed 's/^/[ragflow-mysql-init]    /'

log "初始化完成：库 $MYSQL_DATABASE 与账号 $MYSQL_USER@% 已就绪（表由 RAGFlow 自己的迁移脚本在启动时创建）。"
