# Tianquan RPC 客户端（src/tianquan/）

> ⚠️ 此目录是 Remote Procedure Call 客户端，
> 不是仿生智脑引擎。仿生智脑在 `engine/tianquan/`。

职责：通过 TCP 连接天权总线 (:9100)，做消息路由、意图分类、任务分发。

MasterHarris.classifyIntent：决定请求发往哪个域（天权/瑶灵/瑶光）
GlobalBusClient：连接 Python GlobalBus，订阅/发布消息
TianquanRPCClient：与引擎的天权域通信
