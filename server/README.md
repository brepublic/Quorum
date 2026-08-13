# Quorum 自托管后端

当前实现阶段 1–6：PostgreSQL 已保存文件元数据、不可变版本、审核状态、blob 完整性、活动存储绑定、删除墓碑、durable upload、物理删除任务、provider migration、fenced staging cleanup 和加密 S3 provider 配置；HTTP 内容流可持久暂存并原子提交到服务器卷或 S3 compatible provider，并提供授权下载、provider 切换、容量保护和维护指标。自托管文件与存储管理 UI 已接入；Local Agent 尚未实施。

本机运行：

```sh
source scripts/wsl-env.sh
export DATABASE_URL=postgresql://quorum_test:quorum_test@127.0.0.1:55432/quorum
pnpm self-host:migrate
pnpm self-host:start
```

探针与版本：

```text
GET /health/live
GET /health/ready
GET /metrics
GET /api/v1/version
GET /api/v1/bootstrap/status
POST /api/v1/bootstrap/admin
POST /api/v1/auth/login
GET /api/v1/auth/me
POST /api/v1/auth/elevate
POST /api/v1/auth/change-password
POST /api/v1/auth/logout
GET|POST /api/v1/admin/users
POST /api/v1/committees
GET  /api/v1/committees/:id/snapshot
PATCH|DELETE /api/v1/committees/:id
POST /api/v1/committees/:id/{archive,chairs,seats,seat-assignments,seat-invitations,operation-mode,status}
POST /api/v1/seat-invitations/redeem
GET|POST /api/v1/rule-packages...
GET|POST /api/v1/{country-templates,committee-templates}
PUT|DELETE /api/v1/{country-templates,committee-templates}/:id
PUT /api/v1/committees/:id/seats/:seatId
POST /api/v1/committees/:id/{notes,text-posts,meeting-sessions,roll-calls,attendance-events,points}
PUT|DELETE /api/v1/{notes,text-posts}/:id
POST /api/v1/meeting-sessions/:id/close
POST /api/v1/roll-calls/:id/{record-response,undo,reset}
POST /api/v1/points/:id/resolve
GET  /api/v1/committees/:id/events
POST /api/v1/committees/:id/{timers,speaker-lists,motions,ballots,strawpolls,resolutions}
POST /api/v1/timers/:id/{start,pause,resume,extend,reset,expire}
POST /api/v1/speaker-lists/:id/{queue,reorder,advance}
POST /api/v1/speaker-lists/:id/speech/{start,pause,resume,complete}
POST /api/v1/speeches/:id/{yield,contributions}
POST /api/v1/motions/:id/{second,decide}
POST /api/v1/ballots/:id/{votes,correct-vote,close,publish}
POST /api/v1/strawpolls/:id/{votes,close}
POST /api/v1/resolutions/:id/amendments
POST /api/v1/documents/:id/{versions,commands,discussion}
GET  /api/v1/committees/:id/files
GET  /api/v1/files/:id
GET  /api/v1/files/:id/download
POST /api/v1/files/:id/{submit-review,publish}
DELETE /api/v1/files/:id
GET  /api/v1/committees/:id/storage-bindings
POST /api/v1/committees/:id/storage-bindings/{server-volume,s3}
GET  /api/v1/storage-provider-configs/s3
POST /api/v1/admin/storage-provider-configs/s3
PUT  /api/v1/admin/storage-provider-configs/:id
POST /api/v1/admin/storage-provider-configs/:id/verify
GET|POST /api/v1/committees/:id/storage-migrations
POST /api/v1/storage-migrations/:id/{retry,confirm,cancel}
```

`/health/ready` 只有在数据库可访问、所有仓库 migration 已应用、存储目录可读写、容量可采样且可用字节不为零时返回 200。仍有可用空间的 warning/critical 状态返回 200 并报告状态，因为下载、议事和清理仍可用；critical 只拒绝新的上传字节和 provider copy。`/metrics` 以 Prometheus text 暴露容量与固定类别清理指标。

首次启动会在服务器控制台显示一次 bootstrap secret。数据库只保存其哈希，管理员初始化成功后立即清除；不要把该控制台行复制到工单、测试证据或普通应用日志。

真实 PostgreSQL 测试使用管理员 URL 创建并清理随机临时数据库：

```sh
TEST_DATABASE_ADMIN_URL=postgresql://... pnpm test:self-host:integration
```

未配置该变量时测试明确 skip，不改用内存数据库。

阶段 6.1 的存储服务是 provider 成功后的内部持久化边界。阶段 6.2 把完整内容停在 `STAGED`。阶段 6.3 从暂存区流式提交到服务器卷。阶段 6.4 使用显式 master key 加密 S3 凭据，通过 SigV4 HTTPS 流式提交并远端重读校验；两种 provider 都在校验后以同一数据库事务发布 upload、blob 和 `file_version`，失败保留可重试暂存。阶段 6.5 增加审核/发布状态机、PUBLIC/member/Chair/Owner 读取授权、安全附件下载和 durable blob delete job。阶段 6.6 的常驻迁移 worker 经 durable staging 逐 blob 复制，旧 binding 在确认事务前始终服务；manifest 变化或故障要求重试，取消的目标副本进入删除任务。阶段 6.7 从实际存储挂载点采样 80%/90% 阈值，启动 fenced maintenance worker，优先完成 blob delete job，再清理严格符合状态的 upload/migration staging；`STAGED`、待重试和退休源副本不会被压力清理。阶段 6.8 增加 binding 状态读取和服务器卷初始化 HTTP，并由 React 工作区接入整个文件生命周期、S3 配置与 provider migration。
