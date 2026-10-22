#
# FenixAgent 部署配置库（docker/lib/config.sh）
# 权威文档：docs/operations/docker-topology.md（§9）
#
# 被 docker/deploy.sh 在定义完日志、目录发现与开关函数之后 source（共享同一 shell 作用域，不单独执行）。
# 依赖调用方已定义：SCRIPT_DIR / REPO_ROOT / TOP_COMPOSE、log / warn / die、discover_deps / feature_enabled。
# 提供：配置项读取（env_file_value）、compose 必填键扫描（collect_required_vars / required_var_hint /
# check_compose_requirements / has_required_key）、依赖运行态注入（apply_dep_runtime_env）、
# 整体必填校验（validate_required_env，汇总写入全局 MISSING_REQUIRED / REQUIRED_REPORT）、
# .env 落地（materialize_env_file）与部署期身份键生成（ensure_workflow_platform_account_email）。
#

# 读取 env 文件里某个键的值：只服务校验，规则与 load_env_file 一致（忽略注释与空行、去掉成对引号）。
env_file_value() {
    local file="$1" key="$2" line k v
    [[ -f "$file" ]] || return 1
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        [[ -z "${line//[[:space:]]/}" ]] && continue
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" == *"="* ]] || continue
        k="$(printf '%s' "${line%%=*}" | tr -d '[:space:]')"
        [[ "$k" == "$key" ]] || continue
        v="${line#*=}"
        v="${v#"${v%%[![:space:]]*}"}"
        case "$v" in
            \"*\") v="${v#\"}" && v="${v%\"}" ;;
            \'*\') v="${v#\'}" && v="${v%\'}" ;;
        esac
        printf '%s' "$v"
        return 0
    done <"$file"
    return 1
}

# 收集 compose 文件声明的必填键：${VAR:?说明}（注释行不计；`:?` 把空值也当缺失，与 Compose 语义一致）。
# `|| true` 是必要的：没有必填项的 compose 会让管道以非零结束，而调用点不都在被测试的位置，
# 那样会触发 set -e 直接中断（无必填项是合法状态，不是错误）。
collect_required_vars() {
    local file="$1"
    [[ -f "$file" ]] || return 0
    {
        grep -v '^[[:space:]]*#' "$file" |
            grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*:\?' |
            sed -E 's/^\$\{([A-Za-z_][A-Za-z0-9_]*):\?$/\1/' |
            sort -u
    } || true
}

# 取 compose 里为该键写的说明（`:?` 与 `}` 之间）：报错时直接回答「缺什么、去哪填」。
required_var_hint() {
    local file="$1" var="$2" hit
    hit="$(grep -v '^[[:space:]]*#' "$file" | grep -oE '\$\{'"$var"':\?[^}]*\}' | head -n1)" || true
    [[ -n "$hit" ]] || return 0
    hit="${hit#*:\?}"
    printf '%s' "${hit%\}}"
}

# 提取 compose 的 env_file 条目，每行输出 "<required>\t<path>"。
# 支持现有两种写法：`- .env` 与 `- path: .env` + `required: false`；required 缺省为 true。
# Compose 默认要求每个 env_file 存在，required: false 才允许缺失；只校验必填插值键会漏掉整份文件缺失。
compose_env_file_entries() {
    local compose="$1" line rest trimmed item child_indent key_indent
    local -a lines=()
    local path required
    while IFS= read -r line || [[ -n "$line" ]]; do
        lines+=("${line%$'\r'}")
    done <"$compose"
    local i=0 total=${#lines[@]}
    while ((i < total)); do
        line="${lines[i]}"
        i=$((i + 1))
        [[ "$line" =~ ^([[:space:]]*)env_file:[[:space:]]*(.*)$ ]] || continue
        key_indent=${#BASH_REMATCH[1]}
        rest="${BASH_REMATCH[2]}"
        if [[ -n "$rest" && "$rest" != \#* ]]; then
            # 单值写法：env_file: .env（去掉行尾注释与引号）
            rest="${rest%%[[:space:]]#*}"
            rest="${rest#"${rest%%[![:space:]]*}"}"
            rest="${rest%"${rest##*[![:space:]]}"}"
            printf 'true\t%s\n' "$rest"
            continue
        fi
        path=""
        required="true"
        while ((i < total)); do
            line="${lines[i]}"
            trimmed="${line#"${line%%[![:space:]]*}"}"
            if [[ -z "$trimmed" || "$trimmed" == \#* ]]; then
                i=$((i + 1))
                continue
            fi
            child_indent=$((${#line} - ${#trimmed}))
            ((child_indent > key_indent)) || break
            i=$((i + 1))
            if [[ "$trimmed" == -* ]]; then
                [[ -z "$path" ]] || printf '%s\t%s\n' "$required" "$path"
                item="${trimmed#-}"
                item="${item#"${item%%[![:space:]]*}"}"
                path=""
                required="true"
                if [[ "$item" =~ ^path:[[:space:]]*(.+)$ ]]; then
                    path="${BASH_REMATCH[1]}"
                elif [[ "$item" != required:* && -n "$item" ]]; then
                    path="$item"
                fi
            elif [[ "$trimmed" =~ ^path:[[:space:]]*(.+)$ ]]; then
                path="${BASH_REMATCH[1]}"
            elif [[ "$trimmed" =~ ^required:[[:space:]]*(true|false)$ ]]; then
                required="${BASH_REMATCH[1]}"
            fi
        done
        [[ -z "$path" ]] || printf '%s\t%s\n' "$required" "$path"
    done
}

# 输出缺失且必需的 env_file 路径（按编排里声明的写法），每行一个。
missing_env_files() {
    local compose="$1" env_dir="$2" required path file
    while IFS=$'\t' read -r required path; do
        [[ "$required" == "false" ]] && continue
        path="${path#\"}"
        path="${path%\"}"
        path="${path#\'}"
        path="${path%\'}"
        path="${path#./}"
        [[ -n "$path" ]] || continue
        file="$path"
        [[ "$file" == /* ]] || file="$env_dir/$path"
        [[ -f "$file" ]] || printf '%s\n' "$path"
    done < <(compose_env_file_entries "$compose")
}

# 校验单个 compose 文件的必填项：先看 shell 环境（脚本已导出主服务 env 与 deploy.env），再看该项目的 .env。
# 为什么不用 `docker compose config` 代劳：它一次只报第一个缺失键，而首次部署需要一次看全。
check_compose_requirements() {
    local label="$1" compose="$2" env_dir="$3" var value hint where env_missing env_file env_where
    local vars missing=""
    vars="$(collect_required_vars "$compose")"
    # 必填值可能来自 deploy.env，但 Compose 仍会在启动时读取各项目的 env_file；文件缺失必须单独报。
    env_missing="$(missing_env_files "$compose" "$env_dir")"
    if [[ -n "$env_missing" ]]; then
        while IFS= read -r env_file; do
            if [[ "$env_file" == /* ]]; then
                env_where="$env_file"
            else
                env_where="${env_dir#"$REPO_ROOT"/}/$env_file"
            fi
            MISSING_REQUIRED=$((MISSING_REQUIRED + 1))
            missing="${missing}    - env_file ${env_where} → 文件不存在（Compose 默认要求存在；不需要时在编排写 required: false）"$'\n'
        done <<<"$env_missing"
    fi
    if [[ -n "$vars" ]]; then
        for var in $vars; do
            [[ -n "${!var:-}" ]] && continue
            value="$(env_file_value "$env_dir/.env" "$var" || true)"
            [[ -n "$value" ]] && continue
            MISSING_REQUIRED=$((MISSING_REQUIRED + 1))
            if [[ "$env_dir" == "$SCRIPT_DIR/main" ]]; then
                where="docker/main/.env"
            else
                where="docker/${env_dir#"$SCRIPT_DIR"/}/.env（该依赖自己的配置；与主服务同值的键若已在主服务 env 中，脚本启动前已带入环境，不会报到这里）"
            fi
            missing="${missing}    - ${var} → 填在 ${where}"$'\n'
            hint="$(required_var_hint "$compose" "$var")"
            [[ -n "$hint" ]] && missing="${missing}      说明：${hint}"$'\n'
        done
    fi
    [[ -n "$missing" ]] || return 0
    REQUIRED_REPORT="${REQUIRED_REPORT}[deploy] ${label}："$'\n'"${missing}"
}

# 该 compose 文件是否把某键声明为必填（`${KEY:?}`）。
has_required_key() {
    local compose="$1" key="$2"
    collect_required_vars "$compose" | grep -qx "$key"
}

# 依赖启动前的运行态注入：RCS_URL（地址）与 RCS_SECRET（共享密钥）。
# 为什么单列：这两个键都**不由主服务 env 供给**，要在这里按同机语义给出——
#   RCS_URL：节点侧的键，唯一读取点是容器内的 acp-runtime-cli，主服务进程不消费它，因此不在主服务 env 模板里
#            （见 scripts/lib/env-example-spec.ts）。节点要的是「主服务可达地址」，同机时即 ws://rcs:3000
#            （依赖 fenix-server 的 DNS）；shell 环境里若残留同名值会被这里的 export 覆盖，独立部署则由该
#            依赖自己的 .env 提供真实地址。
#   RCS_SECRET：节点侧的键名与主服务侧的 REGISTRY_SECRET 不同名，而注册是否通过由后者决定；
#            主服务 env 模板也不声明 RCS_SECRET，缺省时从 REGISTRY_SECRET 派生，避免两处手抄漂移。
# 取值优先级：该依赖自己的 .env ＞ 已导出的 shell 环境（主服务 env） ＞ 注入值。
# 独立部署（不经本脚本）时由该依赖自己的 .env 提供，在别的机器上填真实地址与同值密钥。
apply_dep_runtime_env() {
    local name="$1" compose="$SCRIPT_DIR/$1/docker-compose.yml" value
    if has_required_key "$compose" RCS_URL; then
        value="$(env_file_value "$SCRIPT_DIR/$name/.env" RCS_URL || true)"
        if [[ -z "$value" ]]; then
            value="ws://rcs:3000"
            log "注入 RCS_URL=${value}（$name 与主服务同机；独立部署请在 docker/$name/.env 填主服务可达地址）"
        fi
        if [[ -n "$value" ]]; then
            export RCS_URL="$value"
        fi
    fi
    if has_required_key "$compose" RCS_SECRET; then
        value="$(env_file_value "$SCRIPT_DIR/$name/.env" RCS_SECRET || true)"
        [[ -n "$value" ]] || value="${RCS_SECRET:-}"
        if [[ -z "$value" && -n "${REGISTRY_SECRET:-}" ]]; then
            value="$REGISTRY_SECRET"
            log "注入 RCS_SECRET（同机语义：取自主服务的 REGISTRY_SECRET；独立部署请在 docker/$name/.env 填同值密钥）"
        fi
        if [[ -n "$value" ]]; then
            export RCS_SECRET="$value"
        fi
    fi
}

# 校验将要启动的全部项目（主服务 + 已启用依赖）；返回 1 表示有未填写的必填项（报告写到 stderr）。
# 基础服务（postgres / redis）内联在主服务编排里，随 PROJECT 一并校验。
validate_required_env() {
    local name
    MISSING_REQUIRED=0
    REQUIRED_REPORT=""
    check_compose_requirements "主服务 docker/main/docker-compose.yml" "$TOP_COMPOSE" "$SCRIPT_DIR/main"
    # 镜像 tag 必须显式提供：compose 的缺省值只服务 down / ps 等不启动容器的命令，
    # 否则发布审查里的旧 tag 会被静默部署（up / deploy 会拉错镜像）。
    if [[ -z "${RCS_IMAGE_TAG:-}" ]]; then
        MISSING_REQUIRED=$((MISSING_REQUIRED + 1))
        REQUIRED_REPORT="${REQUIRED_REPORT}[deploy] 主服务镜像 tag："$'\n'"    - RCS_IMAGE_TAG → 填在 docker/main/.env（CI 产出的 sha-<commit>；compose 缺省值只用于 down/ps）"$'\n'
    fi
    for name in $(discover_deps); do
        feature_enabled "$name" || continue
        apply_dep_runtime_env "$name"
        check_compose_requirements "依赖 $name" "$SCRIPT_DIR/$name/docker-compose.yml" "$SCRIPT_DIR/$name"
    done
    if [[ "$MISSING_REQUIRED" -eq 0 ]]; then
        log "必填项校验通过（主服务 + 已启用依赖）"
        return 0
    fi
    {
        printf '%s' "$REQUIRED_REPORT"
        printf '[deploy] 共 %s 项必填项未填写（空值同样不算填写）。\n' "$MISSING_REQUIRED"
        printf '[deploy] 处理：把上面的键填进对应文件后重跑；密钥类值可用 openssl rand -hex 32 生成。\n'
        printf '[deploy]       模板文件缺失时先跑 ./docker/deploy.sh init（把 .env.example 落成 .env）。\n'
    } >&2
    return 1
}

# 把一份 .env.example 落成 .env；已存在则跳过，绝不覆盖（里面可能已经是生产配置）。
materialize_env_file() {
    local example="$1" target="$2" rel
    [[ -f "$example" ]] || return 0
    rel="${target#"$REPO_ROOT"/}"
    if [[ -f "$target" ]]; then
        log "跳过（已存在，不覆盖）：$rel"
        return 0
    fi
    cp "$example" "$target"
    log "生成：$rel ← ${example#"$REPO_ROOT"/}"
}

# 平台上游账号邮箱（WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL）的部署期生成：缺失时派生一个值写进主服务 env。
#
# 为什么需要这一步：该键是**身份**，一旦被上游用作账号就是该账号的所有权，晚了就没法在不换号的前提下补上
# ——而它又不是编排里的 `${VAR:?}` 键，上面的必填项扫描（只看编排插值键）看不见它。因此由脚本在部署期一次定下。
# 注：2026-10-16 起它与另两枚能力键在声明侧都是**可选**（缺失不再阻塞 rcs 启动），本步因此不再是「补必填」，
# 而是「免去人工填身份」——删除它只会让启用画布的部署多一步手填，不会让部署失败。
# 为什么由脚本取值而不是留空要求人工填：它是**身份**不是密钥（不能随机生成后即弃），但部署期也不需要预知——
# 上游账号由平台在首次引导时自助注册（`platform-account-registration.ts`），上游只校验邮箱格式、不发信
# （workflow-v2 账号供给设计 §2.3）。
# 两条取值口径：
#   1. 按主机名派生（`workflow-v2-platform+<主机名>@example.com`）：同一台机器上重跑得到同一个值——
#      即使配置被删掉再跑一次，也不会在上游多出一个账号；主机名让上游侧的账号归属可辨认。
#      域固定用保留域 `example.com`：上游不校验可达性，这个身份也不该落在真实收件域上。
#   2. 已有值（含部署方手填的邮箱）一律不动：改值等于换上游账号，需重新引导并人工清理旧账号
#      （账号供给设计 §5.1），因此只能由部署方显式改。
# 调用点：`init`（落成 .env 之后）与 `up` / `deploy`（动容器之前）。`validate` 与 `config` 干跑只读，不落盘。
ensure_workflow_platform_account_email() {
    local key="WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL"
    local rel="${MAIN_ENV_FILE#"$REPO_ROOT"/}"
    local value slug tmp mode
    local note1="# 由 docker/deploy.sh 于部署期生成并固化：平台上游账号身份（不是密钥）。"
    local note2="# 改值等于换上游账号：需要重新引导，并人工清理上游的旧账号（见 docker/workflow/README.md §5）。"
    if [[ ! -f "$MAIN_ENV_FILE" ]]; then
        warn "缺少 ${rel}：跳过 $key 的部署期生成（先跑 ./docker/deploy.sh init 生成模板）"
        return 0
    fi
    value="$(env_file_value "$MAIN_ENV_FILE" "$key" || true)"
    [[ -z "$value" ]] || return 0

    # 主机名当部署标识：非法字符折成 '-'、去首尾、限长（邮箱本地部分上限 64 字节，这里留足余量）。
    # `-s` 不被支持时退回完整主机名，取不到就留空（走不带后缀的兜底值）——本脚本开着 pipefail，
    # 这里必须把失败收在管道内，否则「主机名取不到」会变成整个部署中断。
    slug="$({ hostname -s 2>/dev/null || hostname 2>/dev/null || true; } | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-')"
    slug="${slug#-}"
    slug="${slug%-}"
    slug="${slug:0:24}"
    value="workflow-v2-platform@example.com"
    [[ -n "$slug" ]] && value="workflow-v2-platform+${slug}@example.com"

    tmp="$(mktemp "${MAIN_ENV_FILE}.XXXXXX")" || die "无法在 $(dirname "$MAIN_ENV_FILE") 下建临时文件：$key 需要写入 $rel"
    if grep -qE "^#[[:space:]]*${key}=" "$MAIN_ENV_FILE"; then
        # 模板里这个键是注释行（模板约定：键行一律注释）：就地激活它，保持「每个键只出现一次」。
        awk -v pattern="^#[[:space:]]*${key}=" -v note1="$note1" -v note2="$note2" -v kv="${key}=${value}" '
            $0 ~ pattern { print note1; print note2; print kv; next }
            { print }
        ' "$MAIN_ENV_FILE" >"$tmp"
    else
        # 手工维护过的 env 文件里没有这一行：追加到末尾，不动既有排版。
        cp "$MAIN_ENV_FILE" "$tmp"
        printf '\n%s\n%s\n%s\n' "$note1" "$note2" "${key}=${value}" >>"$tmp"
    fi
    # 保持原权限（mktemp 建出来的是 0600）：改不动也不该阻塞部署，.env 的权限本来由部署方决定。
    mode="$(stat -c '%a' "$MAIN_ENV_FILE" 2>/dev/null || stat -f '%Lp' "$MAIN_ENV_FILE" 2>/dev/null || true)"
    if [[ -n "$mode" ]]; then
        chmod "$mode" "$tmp" 2>/dev/null || true
    fi
    mv "$tmp" "$MAIN_ENV_FILE"
    log "生成并固化 ${key}=${value}（写入 ${rel}；平台上游账号身份，改值等于换上游账号）"
}
