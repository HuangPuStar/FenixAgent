#!/usr/bin/env python3
"""docker/ragflow/init-s3.py —— 本栈自带对象存储（服务 ragflow-rustfs）的**实例能力探测**。

谁在跑它：同目录 docker-compose.yml 的 ragflow-s3-init 服务，以
    entrypoint: ["python3", "/init/init-s3.py"] + ./init-s3.py:/init/init-s3.py:ro 只读挂载执行。
    它在 ragflow 启动前跑，且与目标实例同属一个 Compose 项目（ragflow-net）。

为什么用 python 而不是 sh（与 docker/workflow/、docker/litellm/ 的 .sh 初始化不同）：
    S3 请求要自己算 SigV4 签名与 GetBucketLocation 的 region 协商，用 shell 手搓既不可维护也无法自证；
    而这个镜像里本来就有 RAGFlow 运行期用的同一个客户端（minio-py 7.2.4，见镜像 pyproject 的 minio==7.2.4）。
    于是「初始化」同时是**兼容性验证**：本脚本能建桶、能读写，RAGFlow 就能用同一个客户端读同样的端点——
    path-style 寻址、region 探测、签名、建桶 / 读写 / 删对象权限，全部在 ragflow 启动前走一遍，失败即停，
    不拖到检索时才报。副作用是零新增镜像来源：本服务复用本栈已有的 infiniflow/ragflow:v0.26.0。

为什么本栈自带实例（而不是接共享 rustfs）：这是**用户裁定**的特例。RAGFlow 用多桶模式——每个知识库 kb_id、
    每个文件目录 parent_id 都是实例上的一个**真实桶**，桶名是运行期 UUID，且这是与存量数据一致的布局。于是：
      1) 共享实例只有**全实例一对凭据**，RAGFlow 拿到就能读写实例上任何桶；
      2) 实例侧给不出「按消费方的桶策略」，而多桶模式下桶名不可枚举，也就圈不出「本栈的桶有哪些」；
      3) 两条合起来：共享实例上无法为它建立有效的隔离边界。
    隔离到自己的实例后，越权与跨栈桶命名空间问题同时消失。边界（照抄不放大）：只用 RustFS 镜像、
    不接 `fenix-server`、不发布宿主端口、服务名避开保留名 `rustfs`——见 docker-compose.yml 与 README，
    文档口径见 docs/operations/docker-topology.md §5。

为什么本栈自带实例之后还要这个探测服务：本栈**不设桶名配置**（多桶布局，理由与警告见 docker-compose.yml 与
    README「多桶模式与本栈的键布局」）。逻辑桶——知识库 kb_id、文件目录 parent_id——是运行期才出现的 UUID，
    由 RAGFlow 首次写入时自建（rag/utils/minio_conn.py 的 put()），因此本服务不再、也无法预建本栈的桶。
    它剩下的、也仍然值得留的价值是 **fail-fast 的实例能力探测**：端点可达、凭据可用、path-style 寻址、
    SigV4 签名、region 协商、**建桶权限**，正是 RAGFlow 首次上传会走的路径；任何一项不成立都该在这里停住，
    而不是等用户上传文档时才炸。为此它建的是自己的探测桶（PROBE_BUCKET），不是本栈的业务桶。

环境变量（由 compose 显式注入；凭据是**本栈私有键**，来自本目录 .env 的 RAGFLOW_S3_*）：
    S3_ENDPOINT（host:port，容器内显式值 ragflow-rustfs:9000）/ S3_ACCESS_KEY / S3_SECRET_KEY
    —— 刻意没有「本栈的桶名」：多桶模式下桶名是运行期 UUID，不存在可配置的桶（注入项就是上面这三个，见 compose）。

幂等与自清理：探测对象（PROBE_OBJECT）每次跑完都删；探测桶只在**本次由本服务创建**时才删——PROBE_BUCKET
    已存在时只探测、绝不删除（那更可能是上次中断的残留）。这条不变量不因实例归属本栈而放宽：实例上还有
    RAGFlow 自建的 UUID 桶，本服务对它们一律不做任何决定。重跑既不堆积垃圾，也不会误删既有数据。
失败可诊断：连不上端点 / 凭据被拒（AccessDenied）/ 建桶被拒 / 签名或 region 不匹配 / 服务端没实现该 API，
    各自打印判定；任何失败都以非 0 退出，ragflow 以「本服务成功退出」为前置（service_completed_successfully）。

移除条件：若 RAGFlow 侧将来提供可靠的自检（容器起来即自证端点 / 凭据 / 建桶路径），或本栈实例被证明无需探测
    （实例与端点都固定在本目录编排里、且已有 healthcheck 兜住），可以删掉本服务与 compose 里的 `ragflow-s3-init`。
    当前保留它的代价很小：每轮 up 多一次建桶 + 一次读写往返。
"""

from __future__ import annotations

import os
import sys
import time
from io import BytesIO

from minio import Minio
from minio.error import InvalidResponseError, S3Error

# 等待本栈实例的上限。比 ragflow-mysql-init（300 秒）短得多，因为目标不同：对象存储是同项目服务，
# 健康检查（service_healthy）已经是第一道闸门，这里的等待只兜「健康检查通过但 S3 API 尚未完全就绪」
# 的小窗口；而 mysql-init 等的是**跨项目**的共享实例，窗口要留够冷启动时间。
TIMEOUT_SECONDS = 60
RETRY_INTERVAL_SECONDS = 2.0
# 探测桶：**写死在代码里，不做成环境变量**。它没有部署维度（不像端口、口令那样随部署形态取值），只是本服务
# 用来走一遍「建桶 → 读写 → 删对象 → 删桶」的临时容器；做成可配置只会多一个能被改错、并可能把探测指向
# 别人桶上的旋钮。名字带 `init-probe` 后缀，与 RAGFlow 自建的 UUID 桶不会撞名。
PROBE_BUCKET = "ragflow-init-probe"
# 读写探测用的对象名：固定名（重跑不堆积），每次跑完都删掉；它只存在于上面的探测桶里。
PROBE_OBJECT = "_fenix_init_probe"
PROBE_PAYLOAD = b"fenix-s3-init\n"

# 服务端自陈「稍后重试」的错误码：启动中、过载、限流都归这里，继续等待而不是判定为配置错误。
# 其余 S3 错误码（凭据/签名/未实现）重试没有意义，见 judge()。
TRANSIENT_S3_CODES = frozenset({"SlowDown", "ServiceUnavailable", "InternalError", "RequestTimeout"})


def log(message: str) -> None:
    print(f"[ragflow-s3-init] {message}", flush=True)


def fail(message: str) -> None:
    print(f"[ragflow-s3-init] {message}", file=sys.stderr, flush=True)
    sys.exit(1)


def judge(exc: BaseException) -> str:
    """把客户端异常翻成「判定」文案：排障时要能区分连不上、无权限、协议不兼容三类。"""
    if isinstance(exc, S3Error):
        code = exc.code or ""
        if code in ("AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch"):
            return (
                f"实例在跑但拒绝了本次请求（{code}）：本目录 .env 的 RAGFLOW_S3_ACCESS_KEY / RAGFLOW_S3_SECRET_KEY "
                "必须与实例启动时注入了那份凭据同值（两者都取自同一个变量，改了一边就要重起实例）；"
                "SignatureDoesNotMatch 还要看两台机器的时钟是否漂移。"
            )
        if code in ("NotImplemented", "MethodNotAllowed"):
            return f"服务端没有实现这个 S3 API（{code}）：说明该版本 rustfs 与 RAGFlow 的 minio 客户端不兼容，需要按此调整对象存储实现或版本。"
        return f"服务端返回 S3 错误（{code}）：{exc}"
    if isinstance(exc, InvalidResponseError):
        return f"响应不是合法的 S3 应答（{exc}）：端点很可能不是 S3 兼容服务，或中间有反向代理改写了响应。"
    return (
        f"连不上端点（{exc}）→ 本栈实例是否在跑且健康"
        "（docker compose -f docker/ragflow/docker-compose.yml ps ragflow-rustfs，期望 healthy）、"
        "本服务是否与它同在本项目的 ragflow-net 网络上（两者都由本目录 compose 声明，正常不会错）。"
    )


def main() -> None:
    endpoint = os.environ.get("S3_ENDPOINT", "").strip()
    access_key = os.environ.get("S3_ACCESS_KEY", "")
    secret_key = os.environ.get("S3_SECRET_KEY", "")
    if not endpoint or not access_key or not secret_key:
        fail("初始化中止：S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY 必须都有值（由 compose 注入）。")

    # secure=False：本栈实例只在内网、没有配 TLS（见 docker/ragflow/docker-compose.yml 的 ragflow-rustfs）。
    # region 不显式给：minio 客户端会先 GET /<bucket>?location= 探测，服务端返回空则按 us-east-1 处理；
    # 探测结果在下面打印出来，便于把「实测到的 region」写进排障记录，而不是靠猜。
    client = Minio(endpoint, access_key=access_key, secret_key=secret_key, secure=False)

    log(f"① 等待本栈对象存储可用（{endpoint}，最多 {TIMEOUT_SECONDS} 秒）...")
    attempt = 0
    last_error: BaseException | None = None
    ready = False
    deadline = time.monotonic() + TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        attempt += 1
        try:
            # 列桶同时验证「端点可达 + 凭据可用」；这里读的是实例全量桶清单（本栈实例的凭据就是这么一对）。
            buckets = client.list_buckets()
            log(f"  已就绪：实例内可见 {len(buckets)} 个桶。")
            ready = True
            break
        except S3Error as exc:
            # 服务端已经应答，只是拒绝了这次请求。分两类：实例自陈「稍后重试」的（启动中/过载/限流）继续等；
            # 其余（凭据、签名、未实现）重试不会变好，立即带判定退出。
            if (exc.code or "") in TRANSIENT_S3_CODES:
                last_error = exc
                if attempt == 1 or attempt % 30 == 0:
                    log(f"  等待中（第 {attempt} 次）：{exc}")
                time.sleep(RETRY_INTERVAL_SECONDS)
                continue
            fail(f"初始化中止：{judge(exc)}")
        except Exception as exc:
            # 连接类异常（urllib3 的重试/超时/拒绝）都归到这里：它们会随实例启动而消失，所以按超时重试。
            last_error = exc
            if attempt == 1 or attempt % 30 == 0:
                log(f"  等待中（第 {attempt} 次）：{exc}")
            time.sleep(RETRY_INTERVAL_SECONDS)
    if not ready:
        fail(f"初始化中止：本栈对象存储在 {TIMEOUT_SECONDS} 秒内不可用。最后一次报错：{last_error}\n[ragflow-s3-init] 判定：{judge(last_error) if last_error else '未知'}")

    log(f"② 准备探测桶 {PROBE_BUCKET}（本栈的业务桶由 RAGFlow 运行期自建，这里只验实例能力）...")
    # created_by_us 决定收尾时删不删这个桶：探测桶不是本栈的业务对象，别人（或上一次中断的本服务）建的桶
    # 一律不动。失败判定沿用 judge()，因为「能不能建桶」正是 RAGFlow 首次写入会依赖的能力之一。
    created_by_us = False
    try:
        if client.bucket_exists(PROBE_BUCKET):
            log(f"  桶 {PROBE_BUCKET} 已存在：沿用（通常是上次中断的残留），只探测、不删除。")
        else:
            client.make_bucket(PROBE_BUCKET)
            created_by_us = True
            log(f"  已创建桶 {PROBE_BUCKET}：建桶权限可用（RAGFlow 自建逻辑桶时走的正是这条路径）。")
    except Exception as exc:
        fail(f"初始化中止：探测桶 {PROBE_BUCKET} 准备失败：{judge(exc)}")

    # region 是实测值：minio 客户端为每个桶查一次 GetBucketLocation 并缓存（minio/api.py 的 _get_region）。
    # 用 getattr 读缓存只是为了让日志能回答「实例报告的 region 是什么」；客户端版本随镜像固定，读不到也不影响流程。
    region = getattr(client, "_region_map", {}).get(PROBE_BUCKET)
    log(f"③ 读写探测（探测桶 {PROBE_BUCKET}，region={region or '未探测'}）...")
    # body / size / put_done 先给初值：任何失败都会走 fail()（非 0 退出），初值只是为了让成功路径的变量有定义。
    body: bytes = b""
    size = 0
    put_done = False
    try:
        client.put_object(PROBE_BUCKET, PROBE_OBJECT, BytesIO(PROBE_PAYLOAD), len(PROBE_PAYLOAD))
        put_done = True
        stat = client.stat_object(PROBE_BUCKET, PROBE_OBJECT)
        size = stat.size
        response = client.get_object(PROBE_BUCKET, PROBE_OBJECT)
        try:
            body = response.read()
        finally:
            response.close()
            response.release_conn()
    except Exception as exc:
        # 建桶之后的任何失败都要带判定退出：留着半初始化状态比失败更糟。
        fail(f"初始化中止：探测桶 {PROBE_BUCKET} 读写探测失败：{judge(exc)}")
    finally:
        # 只在确实写进去过之后才删：否则连接失败时还会再报一条「删除失败」，把真正的病因淹掉。
        if put_done:
            try:
                client.remove_object(PROBE_BUCKET, PROBE_OBJECT)
            except Exception as exc:
                # 删除失败不阻断初始化：残留下的是探测桶里的一个诊断键，不影响 RAGFlow 读写自己的桶；
                # 但要留痕，因为它意味着「写入权限有、删除权限没有」，凭据的权限范围需要复核。
                log(f"  警告：探测对象 {PROBE_OBJECT} 未能删除（{exc}）：请复核实例凭据是否缺少删除权限。")

    if body != PROBE_PAYLOAD:
        fail(f"初始化中止：读写探测拿回的内容与写入不一致（写入 {PROBE_PAYLOAD!r}，读回 {body!r}）：对象存储不可信，先查 rustfs 与中间层。")

    # 收尾：只删自己建的桶。这是本服务在本栈实例上的安全不变量——不是我们创建的东西，一律保持原样。
    if created_by_us:
        try:
            client.remove_bucket(PROBE_BUCKET)
        except Exception as exc:
            # 删桶失败同样不阻断：留下的是一个空桶（探测对象已在上一步删掉），不承载业务数据，
            # 也不影响 RAGFlow 自建自己的逻辑桶；但也要留痕——「建桶权限有、删桶权限没有」值得复核。
            log(f"  警告：探测桶 {PROBE_BUCKET} 未能删除（{exc}）：请复核实例凭据是否缺少删桶权限，或手工清掉这个空桶。")
    else:
        log(f"  探测桶 {PROBE_BUCKET} 非本次创建：按安全约定保留原样，不删别人的桶。")

    log(
        f"初始化完成：探测桶 {PROBE_BUCKET} 的建桶 / 读写 / 删对象均通过（对象大小 {size} 字节，region={region or '未探测'}，"
        f"探测桶{'已由本服务删除' if created_by_us else '已存在故保留'}）。"
        "多桶模式：RAGFlow 会为每个知识库 / 文件目录（kb_id / parent_id）在本栈实例上自建桶，本服务不预建、也无法预建这些桶。"
    )


if __name__ == "__main__":
    main()
