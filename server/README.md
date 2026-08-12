# Quorum 自托管后端

当前实现阶段 1 运维边界和阶段 2 身份切片：唯一系统管理员、Argon2id、服务端 Session、CSRF/Origin、登录限流、临时密码、账号禁用与 Session 撤销。委员会授权及议事模块尚未接入。

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
```

`/health/ready` 只有在数据库可访问、所有仓库 migration 已应用且存储目录可读写时返回 200。

首次启动会在服务器控制台显示一次 bootstrap secret。数据库只保存其哈希，管理员初始化成功后立即清除；不要把该控制台行复制到工单、测试证据或普通应用日志。

真实 PostgreSQL 测试使用管理员 URL 创建并清理随机临时数据库：

```sh
TEST_DATABASE_ADMIN_URL=postgresql://... pnpm test:self-host:integration
```

未配置该变量时测试明确 skip，不改用内存数据库。
