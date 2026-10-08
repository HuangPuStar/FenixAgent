#!/usr/bin/env bash
#
# FenixAgent 环境启动入口（docker/deploy.sh）
# 权威文档：docs/operations/docker-topology.md（§9）
#
# 用法（可在仓库任意位置执行，脚本自定位）：
#   ./docker/deploy.sh init                初始化配置：把各 .env.example 落成 .env（已存在则跳过），并报告还缺哪些必填项
#   ./docker/deploy.sh validate            只校验必填项（与 up / deploy 启动前的检查同一套）
#   ./docker/deploy.sh up                  启动整个环境：顶层（主服务 + 基础服务）+ deploy.env 中启用的依赖
#   ./docker/deploy.sh deploy              发布：拉镜像 → DDL 迁移 → 数据迁移 → 启动
#   ./docker/deploy.sh down [--purge-data --yes]  逆序停止（依赖 → 顶层）；--purge-data 删除数据目录，需 --yes 确认
#   ./docker/deploy.sh ps                  查看顶层与已启用依赖的状态
#   ./docker/deploy.sh logs <rcs|目录名> [--follow]
#   ./docker/deploy.sh config              干跑：只打印将执行的命令，不启动任何容器
#   ./docker/deploy.sh --config <路径> <命令>
#
# 配置：默认读同目录的 deploy.env（首次使用：./docker/deploy.sh init）；同目录只有一份别的 *.env 时用它，
#       有多份则用 --config 指定。
# 镜像：一律固定版本、写在各 compose 文件里；本脚本不做任何镜像变量插值。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TOP_COMPOSE="$REPO_ROOT/docker-compose.yml"
ENV_FILE="$REPO_ROOT/.env"
CONFIG_FILE="$SCRIPT_DIR/deploy.env"
# --config 显式指定过配置文件吗？显式指定时不再做同目录自动发现（见 resolve_config_file）
CONFIG_EXPLICIT=""

DRY_RUN=0

# common 的可选服务：保留名，不对应 docker/ 下的目录（见 docker/common/docker-compose.yml）
# 这套名字必须与 scripts/lib/env-example-spec.ts 的 COMMON_FEATURE_SWITCHES 一致（生成器测试逐项比对）
COMMON_OPTIONAL_FEATURES="REDIS S3 MYSQL"
# 不参与本脚本编排的目录：common 是基础服务（随顶层 include）；prod 是待退役的旧编排（迁移阶段删除）
EXCLUDED_DIRS="common prod"

log() { printf '[deploy] %s\n' "$*"; }
warn() { printf '[deploy] 警告：%s\n' "$*" >&2; }
die() {
    printf '[deploy] 错误：%s\n' "$*" >&2
    exit 1
}

usage() {
    sed -n '3,19p' "$0" | sed 's/^# \{0,1\}//'
}

# 统一执行入口：config 干跑时只打印命令，便于审计与排障。
run() {
    if [[ "$DRY_RUN" == "1" ]]; then
        printf '+ %s\n' "$*"
    else
        "$@"
    fi
}

# 语义化版本比较：version_ge 1.2.3 1.2.0 → true
version_ge() {
    [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$2" ]]
}

# 解析 KEY=VALUE 配置并导出为环境变量。
# 为什么不用 source：.env 的值是字面量，source 会展开 $、反引号等字符，密钥可能被意外改写（文档 §8）。
# 仅支持 KEY=VALUE（值可带成对引号、可含 #），这是 deploy.env 与根 .env 的统一格式约定。
load_env_file() {
    local file="$1" line key value
    [[ -f "$file" ]] || return 0
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%$'\r'}"
        [[ -z "${line//[[:space:]]/}" ]] && continue
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" == *"="* ]] || continue
        key="${line%%=*}"
        value="${line#*=}"
        key="$(printf '%s' "$key" | tr -d '[:space:]')"
        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        case "$value" in
            \"*\") value="${value#\"}" && value="${value%\"}" ;;
            \'*\') value="${value#\'}" && value="${value%\'}" ;;
        esac
        printf -v "$key" '%s' "$value"
        export "$key"
    done <"$file"
}

# 目录名 → 开关变量名：sandbox-peri → FENIX_FEATURE_SANDBOX_PERI
feature_var() {
    printf 'FENIX_FEATURE_%s' "$(printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_')"
}

# 扫描依赖目录：docker/*/docker-compose.yml（排除 EXCLUDED_DIRS）；新增依赖零脚本改动。
discover_deps() {
    local dir name skip
    for dir in "$SCRIPT_DIR"/*/; do
        name="$(basename "$dir")"
        [[ -f "$dir/docker-compose.yml" ]] || continue
        for skip in $EXCLUDED_DIRS; do
            [[ "$name" == "$skip" ]] && continue 2
        done
        printf '%s\n' "$name"
    done
}

# 开关是否打开：仅显式 true 视为打开，未声明一律关闭。
feature_enabled() {
    local var
    var="$(feature_var "$1")"
    [[ "${!var:-false}" == "true" ]]
}

# 未知开关是错误：防止拼写错误导致依赖静默不启动（文档 §7 规则）。
validate_config() {
    local var name reserved dir
    while IFS= read -r var; do
        name="${var#FENIX_FEATURE_}"
        for reserved in $COMMON_OPTIONAL_FEATURES; do
            [[ "$name" == "$reserved" ]] && continue 2
        done
        dir="$(printf '%s' "$name" | tr '[:upper:]_' '[:lower:]-')"
        [[ -f "$SCRIPT_DIR/$dir/docker-compose.yml" ]] ||
            die "deploy.env 中的 $var 没有对应依赖目录（docker/$dir/ 不存在）：请修正拼写或删除该开关"
    done < <(compgen -v | grep '^FENIX_FEATURE_' | sort)
}

# 配置初始化与必填项校验（init / validate / up / deploy 共用）：实现在 docker/lib/config.sh。
CONFIG_LIB="$SCRIPT_DIR/lib/config.sh"
[[ -f "$CONFIG_LIB" ]] || die "缺少 ${CONFIG_LIB#"$REPO_ROOT"/}：deploy.sh 的配套库，交付时需完整带 docker/ 目录"
# shellcheck source=lib/config.sh
. "$CONFIG_LIB"

cmd_init() {
    local name existing
    log "初始化配置：把各 .env.example 落成 .env（已存在的一律跳过）"
    if [[ -f "$CONFIG_FILE" ]]; then
        log "跳过（已存在，不覆盖）：docker/deploy.env"
    else
        # 同目录已有自定义名的配置文件时**不**生成规范名：否则 init 之后的 up 会从那份改成这份，
        # 悄悄换了配置来源（比如开关全关的模板 vs 部署方写好的 prod.env）。
        existing="$(list_dir_env_files)"
        if [[ -n "$existing" ]]; then
            while IFS= read -r line; do
                [[ -n "$line" ]] &&
                    log "跳过：同目录已有配置文件 ${line#"$REPO_ROOT"/}（脚本默认用它，不再生成规范名 deploy.env）"
            done <<<"$existing"
        else
            materialize_env_file "$SCRIPT_DIR/deploy.env.example" "$CONFIG_FILE"
        fi
    fi
    materialize_env_file "$REPO_ROOT/.env.example" "$ENV_FILE"
    for name in $(discover_deps); do
        materialize_env_file "$SCRIPT_DIR/$name/.env.example" "$SCRIPT_DIR/$name/.env"
    done

    log "初始化完成，检查必填项："
    resolve_config_file || true
    load_config
    validate_config
    if validate_required_env; then
        log "可以直接启动：./docker/deploy.sh up"
    else
        log "按上面的路径补齐必填项后重跑 ./docker/deploy.sh validate（up / deploy 也会在启动前再校验一次）"
    fi
}

cmd_validate() {
    validate_required_env || die "必填项校验未通过：见上面的清单"
}

check_prerequisites() {
    command -v docker >/dev/null 2>&1 || die "未找到 docker：请先安装 Docker"
    docker compose version >/dev/null 2>&1 || die "未找到 docker compose（v2）：请升级 Docker"
    local version
    version="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
    if [[ -n "$version" ]] && ! version_ge "$version" "2.20.0"; then
        die "Compose 版本为 ${version}：顶层编排使用 include，需要 ≥ 2.20.0"
    fi
    [[ -f "$TOP_COMPOSE" ]] || die "缺少顶层编排：$TOP_COMPOSE"
    [[ -f "$SCRIPT_DIR/common/docker-compose.yml" ]] || die "缺少基础服务编排：docker/common/docker-compose.yml"
    [[ -f "$ENV_FILE" ]] ||
        warn "缺少 ${ENV_FILE}（应用配置与密钥）：跑 ./docker/deploy.sh init 生成模板，缺失的必填键会在启动前报错"
}

# 列出脚本同目录下的部署配置文件（`*.env`，排除 .env 这类隐藏文件）。
list_dir_env_files() {
    find "$SCRIPT_DIR" -maxdepth 1 -type f -name '*.env' ! -name '.*' 2>/dev/null | sort
}

# 解析部署配置文件：默认就是同目录的 deploy.env（`init` 生成的那个）。
# 若它不存在而同目录恰好只有一份 `*.env`，就用那一份——部署方常按机器/环境命名（prod.env、machine-a.env）；
# 有多个候选则要求显式 --config，不替使用者猜。
resolve_config_file() {
    local candidates count
    if [[ -n "$CONFIG_EXPLICIT" ]]; then
        [[ -f "$CONFIG_FILE" ]] || die "--config 指定的配置文件不存在：$CONFIG_FILE"
        return 0
    fi
    [[ -f "$CONFIG_FILE" ]] && return 0
    candidates="$(list_dir_env_files)"
    count=0
    while IFS= read -r line; do
        [[ -n "$line" ]] && count=$((count + 1))
    done <<<"$candidates"
    case "$count" in
    0) return 1 ;;
    1)
        CONFIG_FILE="$candidates"
        log "使用同目录唯一的配置文件：${CONFIG_FILE#"$REPO_ROOT"/}（规范名是 docker/deploy.env；多份配置用 --config 指定）"
        return 0
        ;;
    *)
        warn "docker/ 下有多个配置文件，脚本不替你猜哪一份："
        while IFS= read -r line; do
            [[ -n "$line" ]] && printf '[deploy]   %s\n' "${line#"$REPO_ROOT"/}" >&2
        done <<<"$candidates"
        die "请用 --config <路径> 指定其中一份（或把要用的那份命名为 docker/deploy.env）"
        ;;
    esac
}

load_config() {
    load_env_file "$CONFIG_FILE"
    # 根 .env 同时导出：依赖编排的共享键（POSTGRES_PASSWORD 等）由此提供，保证「随主服务启动」与
    # 「独立部署」两条路径取值一致（文档 §8.5）。RCS_URL / RCS_SECRET 不靠这里传：
    # 它们由 apply_dep_runtime_env 按主服务配置派生（同名不同义 / 与 REGISTRY_SECRET 同值，见 lib/config.sh）。
    load_env_file "$ENV_FILE"
}

compose_top() {
    run docker compose -f "$TOP_COMPOSE" "$@"
}

compose_dep() {
    local name="$1"
    shift
    run docker compose -f "$SCRIPT_DIR/$name/docker-compose.yml" "$@"
}

cmd_up() {
    local profiles="" name
    # 干跑（config）不拦必填项：审计「将要执行什么」不应依赖配置是否已填齐。
    if ! validate_required_env; then
        [[ "$DRY_RUN" == "1" ]] &&
            warn "必填项校验未通过（干跑继续）：上面的键在真正启动前必须补齐" ||
            die "启动前校验未通过：见上面的必填项清单"
    fi
    if feature_enabled S3; then profiles="--profile s3"; fi
    if feature_enabled REDIS; then profiles="$profiles --profile redis"; fi
    # 共享基础设施（mysql）：消费方（如 workflow）按服务名访问它，
    # 因此这个开关必须在**顶层项目**上生效——消费方自己的 up 不带这个 profile。
    if feature_enabled MYSQL; then profiles="$profiles --profile mysql"; fi

    log "启动顶层项目：主服务 + 基础服务"
    # shellcheck disable=SC2086  # profiles 为空时不传参数，为空格分隔的固定值
    compose_top $profiles up -d

    for name in $(discover_deps); do
        if feature_enabled "$name"; then
            apply_dep_runtime_env "$name"
            log "启动依赖：$name"
            compose_dep "$name" up -d
        fi
    done

    log "启动完成，当前状态："
    cmd_ps
}

cmd_deploy() {
    validate_required_env || die "启动前校验未通过：见上面的必填项清单"
    log "1/4 拉取主服务镜像（固定版本见顶层编排 image 行）"
    compose_top pull rcs

    log "2/4 DDL 迁移（镜像内 migrate.js，先于应用进程）"
    compose_top run --rm rcs bun migrate.js

    log "3/4 数据迁移（必须与应用使用相同的数据卷与配置）"
    compose_top run --rm rcs bun data-migration-runner.js

    log "4/4 启动环境"
    cmd_up
}

# 本项目的数据目录：全部是 bind 挂载（相对各自 compose 文件），没有命名卷。
data_dirs() {
    local name
    printf '%s\n' "$REPO_ROOT/data" "$REPO_ROOT/workflow" "$REPO_ROOT/workspaces"
    for name in $(discover_deps); do
        [[ -d "$SCRIPT_DIR/$name/data" ]] && printf '%s\n' "$SCRIPT_DIR/$name/data"
    done
    printf '%s\n' "$SCRIPT_DIR/common/data"
    return 0
}

# 删除数据目录是破坏性操作：先把清单打全，只有显式 --yes 才真删（脚本不替使用者承担数据丢失）。
purge_data_dirs() {
    local confirmed="$1" dir
    if [[ "$confirmed" != "1" ]]; then
        log "以下数据目录不会被删除（未加 --yes，只列出）："
        while IFS= read -r dir; do
            printf '[deploy]   %s\n' "${dir#"$REPO_ROOT"/}"
        done < <(data_dirs)
        log "确认要删除请重跑：./docker/deploy.sh down --purge-data --yes"
        return 0
    fi
    while IFS= read -r dir; do
        if [[ -d "$dir" ]]; then
            log "删除数据目录：${dir#"$REPO_ROOT"/}"
            rm -rf "$dir"
        fi
    done < <(data_dirs)
}

cmd_down() {
    local order="" name purge=0 confirmed=0 arg
    for arg in "$@"; do
        case "$arg" in
            --purge-data) purge=1 ;;
            --yes) confirmed=1 ;;
            *) die "未知参数：${arg}（可用：--purge-data --yes）" ;;
        esac
    done

    for name in $(discover_deps); do
        if feature_enabled "$name"; then
            order="$name $order" # 逆序累积：先停后加的依赖
        fi
    done

    for name in $order; do
        log "停止依赖：$name"
        compose_dep "$name" down
    done

    log "停止顶层项目"
    # 一律带上 common 的全部 profile：`down` 的语义是「停掉这个项目」，而 profile 门控的服务
    # （redis / rustfs / mysql）在开关已关闭时不会随裸 `down` 停掉，会留下来占用
    # fenix-server 网络（网络删不掉、名字仍被解析）。带全 profile 让 down 与 up 可停的集合一致。
    # shellcheck disable=SC2086  # profile 参数是空格分隔的固定值
    compose_top --profile s3 --profile redis --profile mysql down

    if [[ "$purge" == "1" ]]; then
        purge_data_dirs "$confirmed"
    fi
}

cmd_ps() {
    local name
    log "顶层项目状态："
    compose_top ps
    for name in $(discover_deps); do
        if feature_enabled "$name"; then
            log "依赖 $name 状态："
            compose_dep "$name" ps
        fi
    done
}

cmd_logs() {
    local target="${1:-}"
    [[ -n "$target" ]] || die "用法：deploy.sh logs <rcs|依赖目录名> [--follow]"
    shift
    if [[ "$target" == "rcs" ]]; then
        compose_top logs "$@" rcs
    elif [[ -f "$SCRIPT_DIR/$target/docker-compose.yml" ]]; then
        compose_dep "$target" logs "$@"
    else
        die "未知日志目标：${target}（可用：rcs 或 docker/ 下的依赖目录名）"
    fi
}

main() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --config)
                [[ $# -ge 2 ]] || die "--config 需要一个路径"
                CONFIG_FILE="$2"
                CONFIG_EXPLICIT=1
                shift 2
                ;;
            -h | --help)
                usage
                return 0
                ;;
            *) break ;;
        esac
    done

    local cmd="${1:-up}"
    shift || true

    # init 是唯一不需要 docker 与既有配置的命令：它负责把配置模板落成实文件。
    if [[ "$cmd" == "init" ]]; then
        cmd_init "$@"
        return 0
    fi

    resolve_config_file || die "缺少部署配置 ${CONFIG_FILE}（首次使用：./docker/deploy.sh init）"
    check_prerequisites
    load_config
    validate_config

    case "$cmd" in
        validate) cmd_validate "$@" ;;
        up) cmd_up "$@" ;;
        deploy) cmd_deploy "$@" ;;
        down) cmd_down "$@" ;;
        ps) cmd_ps "$@" ;;
        logs) cmd_logs "$@" ;;
        config)
            DRY_RUN=1
            cmd_up "$@"
            ;;
        *)
            usage
            die "未知命令：$cmd"
            ;;
    esac
}

main "$@"
