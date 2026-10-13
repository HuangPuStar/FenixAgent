#!/bin/sh
#
# docker/workflow/init-s3.sh —— 共享对象存储（rustfs）里「属于本栈」的初始化（一次性 job，执行完即退出）。
#
# 谁调用：docker-compose.yml 的 `s3-init` 服务，显式覆盖 entrypoint 为 ["/bin/sh", "/init/init-s3.sh"]，
#         本文件以只读方式挂载到容器内 /init/init-s3.sh（compose 与脚本都不依赖宿主的可执行位）。
# 为什么单独成文件而不内联进 compose：与本目录的 init-mysql.sh 同一理由——脚本有分支与失败诊断，
#         内联进 YAML 标量后既难 review，也容易被 YAML 折叠规则悄悄改写（折行会把注释与后续语句并到同一行）。
# 为什么用 curl 而不是 mc：建桶需要一个 S3 客户端。仓库里唯一自带 mc 的镜像是 MinIO 镜像——用它就等于把
#         要收敛掉的 MinIO 制品又引回编排里，且「全仓只剩一套对象存储」的检索口径立刻失真。本服务的镜像
#         rustfs/rustfs:1.0.1 是仓库已有镜像（docker/common/ 的 rustfs 同款 tag），镜像内的 curl 8.22.0
#         原生支持 --aws-sigv4，不需要新增任何镜像来源。
# 环境变量（由 compose 显式注入；凭据只来自主服务 env（生产 docker/main/.env、dev 仓库根 .env）的 RUSTFS_*）：S3_ENDPOINT / S3_ACCESS_KEY /
#         S3_SECRET_KEY / S3_REGION。
# 只读输入：/seed/default_icon、/seed/official_plugin_icon（上游 docker/volumes/minio/ 下的静态图标；
#         原先由栈内 minio 容器的 entrypoint 用 `mc cp --recursive` 播种）。
#
# 幂等：可重复执行，重跑不动桶里任何对象。
#   - 建桶是 PUT /<bucket>：200 表示本次创建，409 表示已存在（BucketAlreadyOwnedByYou / BucketAlreadyExists）
#     ——两者都算通过；重跑走的就是 409 分支。
#   - 图标播种是 PUT /<bucket>/<key> 覆盖写：同一份源文件重传内容与 Content-Type 都不变，结果与只跑一次相同。
# 失败可诊断：连不上共享实例 / 建桶被拒 / 自检失败各有独立文案与非零退出码，退出码会被 compose 的
#         depends_on: service_completed_successfully 反映到 coze-server 与 milvus 上（它们不会带着半个桶起来）。
# 例外（有意为之）：图标播种失败**不**阻塞主链路，只告警——对齐上游原行为（那段 `mc cp` 跑在 minio 容器的
#         后台子 shell 里，失败不影响服务启动）。把「图标少一张」升级成「整个栈起不来」不划算，重跑办法见文末。

set -eu

: "${S3_ENDPOINT:?S3_ENDPOINT 未设置：compose 必须注入共享 rustfs 的容器内地址（写显式服务名，不插值宿主键）}"
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY 未设置：compose 从主服务 env 的 RUSTFS_ACCESS_KEY 取值}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY 未设置：compose 从主服务 env 的 RUSTFS_SECRET_KEY 取值}"
# 签名域（SigV4 credential scope 里的 region）。取 RustFS 的默认 region；共享实例若改了 RUSTFS_REGION，
# 这里必须同步，否则所有请求都会被判签名不匹配。
S3_REGION="${S3_REGION:-us-east-1}"

S3_URL_BASE="http://${S3_ENDPOINT}"
# 响应体落盘一份供失败诊断用；容器文件系统是临时的，不需要清理。
BODY_FILE=/tmp/s3-init-body.xml

# 桶名写死在这里，不从环境传：它们不是部署参数，多一个入口只会多一处能改错的地方（与 docker/litellm/init-db.sh
# 持有库名 / 角色名同一取舍）。两处必须同值，改名时要一起改：
#   opencoze —— coze-server 的桶（compose 里 coze-server 的 STORAGE_BUCKET）。平台侧按 `/opencoze/` 前缀识别
#               存储直链（packages/resources/workflow-v2/src/server/services/canvas-passthrough.ts），
#               改名会同时打断画布图片链路。
#   milvus   —— Milvus 的向量数据桶（compose 里 milvus 的 MINIO_BUCKET_NAME）。
OPENCOZE_BUCKET=opencoze
MILVUS_BUCKET=milvus
BUCKETS="${OPENCOZE_BUCKET} ${MILVUS_BUCKET}"

# 统一的 S3 调用：SigV4 交给 curl 原生实现（--aws-sigv4 "aws:amz:<region>:s3"），不手拼 Authorization 头——
# 规范化请求的错误形态很难从报错里定位，而 curl 的实现与 S3 规范逐条对齐。
# 凭据经 --user 传入：这会出现在容器内的进程 argv 里（同一容器内可读），与原 minio 容器用 mc alias 存
# 明文凭据属同一可见性级别；本容器不对外暴露、不落盘。
s3_curl() {
    curl -sS --max-time 30 \
        --aws-sigv4 "aws:amz:${S3_REGION}:s3" \
        --user "${S3_ACCESS_KEY}:${S3_SECRET_KEY}" \
        "$@"
}

# 播种一棵目录树：把「挂载点下的相对路径」作为对象键 PUT 到 <桶>/<前缀>/ 下。
# 幂等靠覆盖写：同一源文件重传，内容与 Content-Type 都不变，重跑结果与只跑一次相同。
# 失败即 return 1（由调用方降级成告警）：这里不 exit，因为图标不是主链路的就绪前提。
seed_tree() {
    SRC_DIR="$1"
    DST_PREFIX="$2"
    if [ ! -d "$SRC_DIR" ]; then
        echo "   ${SRC_DIR} 未挂载，跳过（交付时别漏了上游 docker/volumes/minio/ 下的图标目录）" >&2
        return 1
    fi
    # 空目录同样要报出来：bind 挂载在源目录缺失时会被 docker 建成空目录，只看「目录存在」会静默少播种。
    file_count="$(find "$SRC_DIR" -type f | wc -l)"
    if [ "$file_count" -eq 0 ]; then
        echo "   ${SRC_DIR} 里没有文件，跳过（上游图标目录是否完整？）" >&2
        return 1
    fi
    # 逐文件上传。用 find | while read 而不是 for f in $(find ...)：后者按空白切词，文件名带空格时会传错对象。
    # exit 1 发生在管道末端的子 shell 里，管道整体因此返回 1，函数随之为非零——这就是上面 seed_failed 的判据。
    find "$SRC_DIR" -type f | sort | while IFS= read -r file; do
        # 相对路径转对象键：去掉挂载点前缀（find 的输出一定以 "$SRC_DIR"/ 开头）。
        rel="${file#"$SRC_DIR"/}"
        case "$file" in
        *.png) ctype=image/png ;;
        *.jpg | *.jpeg) ctype=image/jpeg ;;
        *.gif) ctype=image/gif ;;
        *.webp) ctype=image/webp ;;
        *.svg) ctype=image/svg+xml ;;
        *) ctype=application/octet-stream ;;
        esac
        # 显式带 Content-Type：原先 mc cp 会按扩展名推导，对象存储不推导——缺了它，浏览器拿到的是
        # application/octet-stream，画布图片与插件图标会走下载而不是渲染。
        code="$(s3_curl -o /dev/null -w '%{http_code}' -X PUT -T "$file" \
            -H "Content-Type: ${ctype}" \
            "${S3_URL_BASE}/${OPENCOZE_BUCKET}/${DST_PREFIX}/${rel}" 2>/dev/null)" || code=000
        if [ "$code" != "200" ]; then
            echo "   上传失败：${DST_PREFIX}/${rel} 返回 ${code}" >&2
            exit 1
        fi
    done
    echo "   ${DST_PREFIX}/ 已播种 ${file_count} 个文件"
}

echo '① 等待共享 rustfs 可用（最多 300 秒）...'
i=0
# 探 /health 而不是 TCP 端口：端口开放不等于 S3 API 已就绪（RustFS 起来后会先建卷与元数据）。
until curl -fsS --max-time 5 "${S3_URL_BASE}/health" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge 150 ]; then
        echo '共享 rustfs 不可用（300 秒内未通过健康检查），按下面两条分别排查：' >&2
        # 第二条探测故意不带 -f：它只回答「连得上吗」，与上一条的「健康吗」分开，避免把两种故障混成一句。
        if curl -sS --max-time 5 -o /dev/null "${S3_URL_BASE}/health" 2>/dev/null; then
            echo '  - 端口可达但健康检查没通过：共享实例还没完成启动，或镜像 tag 与 docker/common/ 的不一致。' >&2
        else
            echo '  - 服务器不可达：docker/deploy.env 的 FENIX_FEATURE_S3 是否为 true、顶层项目是否已起、本容器是否在 fenix-server 网络上。' >&2
        fi
        exit 1
    fi
    sleep 2
done

echo '② 幂等创建桶（已存在则跳过，不动桶里任何对象）...'
for bucket in $BUCKETS; do
    code="$(s3_curl -o "$BODY_FILE" -w '%{http_code}' -X PUT "${S3_URL_BASE}/${bucket}" 2>/dev/null)" || code=000
    case "$code" in
    200)
        echo "   创建 ${bucket}"
        ;;
    409)
        # 「桶已存在」这一种状态在 S3 里有两种名义：BucketAlreadyOwnedByYou（本账号的，重跑的正常路径）与
        # BucketAlreadyExists（别人占的）。**这里刻意不按名义分叉**：有的实现对自己的桶也回后者，按名义判会
        # 让重跑变成偶发失败，而「可重跑」是硬要求。归属由第 ③ 步实测——它用当前凭据去读桶，不是我们的就
        # 读不到；那一步的报错会直接指向归属，比这里猜响应体的 Code 更可靠。
        note=''
        if grep -q 'BucketAlreadyExists' "$BODY_FILE" 2>/dev/null; then
            note='（响应名义是 BucketAlreadyExists，归属由第 ③ 步实测判定）'
        fi
        echo "   ${bucket} 已存在，跳过${note}"
        ;;
    403)
        echo '建桶被拒（HTTP 403）：共享 rustfs 不接受当前凭据。响应体：' >&2
        cat "$BODY_FILE" >&2 || true
        echo '判定：RUSTFS_ACCESS_KEY / RUSTFS_SECRET_KEY（主服务 env）与共享实例启动时用的那份不一致——' >&2
        echo '      两者同源：common 的 rustfs 容器直接读主服务 env 的同名键，改一处即改两处；不一致只可能来自' >&2
        echo '      「本次 up 用的 env 文件与上一次不同」（独立部署时漏了主服务 env 那一份：dev 是仓库根 .env、生产是 docker/main/.env）。' >&2
        exit 1
        ;;
    *)
        echo "建桶请求失败（HTTP ${code}）：共享 rustfs 不可达或响应异常。响应体：" >&2
        cat "$BODY_FILE" >&2 || true
        echo '处理：先按 ① 的两条分支排查共享实例；仍不明时看上面的响应体。' >&2
        exit 1
        ;;
    esac
done

echo '③ 用同一份凭据自检（桶存在且可读；不一致时当场失败，不拖到 coze-server 上传失败才查）...'
for bucket in $BUCKETS; do
    # 用 ListObjectsV2（max-keys=0）而不是 HEAD：它同时证明「桶在」与「当前凭据能读桶」，
    # 且是 S3 兼容实现里覆盖最广的调用形态。这一步也是第 ② 步「桶已存在」的归属判据。
    code="$(s3_curl -o "$BODY_FILE" -w '%{http_code}' "${S3_URL_BASE}/${bucket}?list-type=2&max-keys=0" 2>/dev/null)" || code=000
    if [ "$code" != "200" ]; then
        echo "自检失败：读 ${bucket} 返回 ${code}（期望 200）。响应体：" >&2
        cat "$BODY_FILE" >&2 || true
        echo '处理：' >&2
        echo '  - 403 AccessDenied：该桶由同一实例上的**别的凭据**创建（桶在，但当前凭据读不了）。换桶名，' >&2
        echo '    或把主服务 env 的 RUSTFS_* 改回创建它的那份；脚本不接管别人的桶。' >&2
        echo '  - 404 NoSuchBucket：第 ② 步的「已存在」是误判（例如请求打到了别的实例）——核对 S3_ENDPOINT。' >&2
        echo '  - 000：共享实例在两步之间掉了，按第 ① 条重跑。' >&2
        exit 1
    fi
done
echo "   ${BUCKETS} 均可读，凭据有效"

echo '④ 播种画布图标（幂等覆盖写；失败只告警，不阻塞 coze-server）...'
seed_failed=0
seed_tree /seed/default_icon default_icon || seed_failed=1
seed_tree /seed/official_plugin_icon official_plugin_icon || seed_failed=1

if [ "$seed_failed" -ne 0 ]; then
    echo '初始化完成，但图标播种有失败项（桶已就绪，coze-server 不受影响）。重跑办法：' >&2
    echo '  docker compose --env-file "$WORKFLOW_STUDIO_DIR/docker/.env" --env-file docker/workflow/.env \' >&2
    echo '    -f docker/workflow/docker-compose.yml up -d --force-recreate s3-init' >&2
    echo '排查方向：源目录是否挂载、上游 docker/volumes/minio/ 下是否还有这些图标文件、上游目录是否被清理过。' >&2
fi

echo "初始化完成：${BUCKETS} 已就绪，凭据与主服务 env 一致。"
