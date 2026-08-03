# Chat 流式对话全链路架构

> 状态：理想架构（目标设计基线）
> 范围：浏览器 → 主服务 → Machine 的流式对话链路、关键实体生命周期、数据归属与隔离、典型用户场景。
> 定位：本文档描述**最佳设计与最终形态**，是前端交互式 Chat（YJS 路径）的权威架构契约。实现若与本文档存在差异，以本文档为准并持续推进对齐。
> 约定：本文档不绑定具体代码位置；模块归属以职责域表述。

## 1. 总体架构

```mermaid
flowchart TB
    subgraph Browser["Browser"]
        CP["ChatPanel"]
        CS["ChatStore"]
        SS["SessionStore"]
        YW["YjsWsClient"]
    end

    classDef transport fill:#f6f8fa,stroke:#9aa4b2,stroke-dasharray:4 4,color:#667085

    subgraph CAC["ChatChannelController"]
        YG["Yjs Gateway"]:::transport
        SC["SessionChannel"]
        ACPC["ACPChannel"]
    end
    subgraph CAS["AgentSessionState"]
        DM["DocManager"]
        TR["EventAggregator"]
        BB["YjsBroadcaster"]
        RD[("Redis")]
    end
    subgraph InstanceLayer["AgentController"]
        IM["InstanceManager"]
        INST["Instance"]
        EC["Environment"]
        AC["AgentConfig"]
        AGW["ACP Gateway"]:::transport
    end
    IM -->|"管理：拉起 / 回收"| INST
    INST -->|"归属"| EC
    EC -->|"引用"| AC
    INST -->|"持有"| AGW

    subgraph Machine["Machine"]
        RT["Machine Runtime"]
        AD["AcpDispatcher"]
        AG["Agent Engine"]
    end

    CP -->|"subscribe"| CS & SS
    YW -->|"applyUpdate"| CS & SS
    CP -->|"actions"| YW
    YG <-->|" "| SC
    SC -->|"command"| ACPC
    ACPC <-->|"command / ACP 数据"| AGW
    ACPC -.->|"ensureRunning"| IM
    SC -->|"command / events"| TR
    AGW <-->|"ACP WS"| RT
    RT -->|"管理：拉起 / 回收"| AD
    AD <-->|"ACP 协议"| AG
    ACPC -->|"events"| SC
    TR --> DM
    DM <--> RD
    DM --> BB
    BB -->|"yjs:update"| SC
    YW <-->|"action / keep_alive / yjs:update"| YG

```
