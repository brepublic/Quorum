# 自托管部署骨架

Compose 同时启动 Caddy、Quorum TypeScript 后端和 PostgreSQL。PostgreSQL 没有主机端口映射；只有 Caddy 暴露 80/443。应用启动前会执行带校验和的 migration，并为未初始化实例生成一次性 bootstrap secret。

```sh
cp deploy/.env.example deploy/.env
# 编辑域名、同源 Origin 和数据库密码
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
```

Caddy 将 `/api/v1/*` 和 `/health/*` 反向代理到应用，其余未知路径回退到 `index.html`。`/health/live` 只检查进程，`/health/ready` 检查 PostgreSQL migration 与持久文件卷可写性。

`QUORUM_ALLOWED_ORIGINS` 必须与浏览器实际 HTTPS Origin 完全一致。首次启动的 bootstrap secret 只在应用控制台显示一次；初始化成功后数据库哈希被清除。

本地测试数据库只绑定 `127.0.0.1:55432`，数据放在 tmpfs：

```sh
pnpm self-host:test-db:up
pnpm test:self-host:integration
pnpm self-host:test-db:down
```

`pnpm self-host:test-db:reset` 只删除 `quorum-test-db` Compose 项目的测试数据后重建，不触碰生产 Compose 卷。
