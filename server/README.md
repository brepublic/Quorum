# Quorum 自托管后端

当前实现阶段 1–5 和 6.1–6.3：PostgreSQL 已保存文件元数据、不可变版本、blob 完整性、活动存储绑定、删除墓碑和 durable upload 状态；HTTP 内容流可持久暂存并原子提交到服务器卷。下载 HTTP、S3 和 Local Agent 尚未接入。

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
```

`/health/ready` 只有在数据库可访问、所有仓库 migration 已应用且存储目录可读写时返回 200。

首次启动会在服务器控制台显示一次 bootstrap secret。数据库只保存其哈希，管理员初始化成功后立即清除；不要把该控制台行复制到工单、测试证据或普通应用日志。

真实 PostgreSQL 测试使用管理员 URL 创建并清理随机临时数据库：

```sh
TEST_DATABASE_ADMIN_URL=postgresql://... pnpm test:self-host:integration
```

未配置该变量时测试明确 skip，不改用内存数据库。

阶段 6.1 的存储服务是 provider 成功后的内部持久化边界。阶段 6.2 把完整内容停在 `STAGED`。阶段 6.3 从暂存区流式提交到服务器卷，重新校验后在同一数据库事务中发布 upload、blob 和 `file_version`；失败保留可重试字节。
