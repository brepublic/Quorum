# Quorum 自托管后端骨架

当前只实现阶段 1 的运维边界：migration、健康检查、版本、request ID、统一错误 envelope 和 JSON 结构化日志。身份、授权、委员会及议事模块尚未接入；现有浏览器仍走 Firebase。

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
```

`/health/ready` 只有在数据库可访问、所有仓库 migration 已应用且存储目录可读写时返回 200。
