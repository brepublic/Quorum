# Quorum 自托管后端

当前实现阶段 1–3：后端与部署骨架、身份、委员会核心领域、Chair 能力、席位、邀请码和规则包。阶段 3 API 尚未接入现有 React 委员会页面，也不包含 SSE 或议事流程。

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
```

`/health/ready` 只有在数据库可访问、所有仓库 migration 已应用且存储目录可读写时返回 200。

首次启动会在服务器控制台显示一次 bootstrap secret。数据库只保存其哈希，管理员初始化成功后立即清除；不要把该控制台行复制到工单、测试证据或普通应用日志。

真实 PostgreSQL 测试使用管理员 URL 创建并清理随机临时数据库：

```sh
TEST_DATABASE_ADMIN_URL=postgresql://... pnpm test:self-host:integration
```

未配置该变量时测试明确 skip，不改用内存数据库。
