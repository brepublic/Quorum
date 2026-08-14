# Quorum

Quorum 是一款用于模拟联合国委员会管理的免费开源 Web 应用，支持账号与席位、点名、发言名单、核心磋商、动议、决议草案与修正案、正式表决、文件协作、归档和审计。

源码仓库：[github.com/brepublic/Quorum](https://github.com/brepublic/Quorum)

![Quorum 界面截图](public/promo.png)

## 技术栈

- React 18、TypeScript、Vite、Semantic UI React；
- Node.js 22 模块化单体、PostgreSQL 16、同源 API 与 SSE；
- Caddy、Docker Compose、服务器持久卷、S3 compatible provider；
- 可选 Chair Local Agent；
- Vitest 与真实 PostgreSQL integration tests；
- 英语与简体中文界面。

## 本地开发

需要 Node.js 22 和 pnpm。所有项目命令前先加载 WSL 工具链：

```sh
source scripts/wsl-env.sh
```

安装依赖并启动浏览器开发服务器：

```sh
pnpm install --frozen-lockfile
pnpm start
```

浏览器默认访问 [http://localhost:5173](http://localhost:5173)。应用只使用自托管运行路径，并要求同源 `/api/v1` 后端；完整浏览器联调请使用 `deploy/compose.yaml`，或配置本地反向代理。

本地 PostgreSQL 16 测试服务：

```sh
pnpm self-host:test-db:up
pnpm test:self-host:integration
pnpm self-host:test-db:down
```

该服务只绑定 `127.0.0.1:55432` 并使用隔离测试数据。integration tests 通过 `TEST_DATABASE_ADMIN_URL` 创建随机临时数据库，未配置时会明确 skip。

## 测试与构建

```sh
pnpm exec vitest run             # 全仓单元、契约与 HTTP 测试
pnpm test:self-host              # 自托管有限测试集
pnpm test:self-host:integration  # 真实 PostgreSQL integration
pnpm build:self-host             # 完整生产构建
pnpm verify:no-legacy-runtime    # 检查生产源码、依赖、配置与构建产物
pnpm exec tsc --noEmit           # 浏览器类型检查
```

`pnpm test` 会以监听模式运行 Vitest，不会自动退出。生产构建输出到 `build/`。部署、容量、备份与恢复步骤见 [`deploy/README.md`](./deploy/README.md) 和 [`docs/self-hosted/RECOVERY.md`](./docs/self-hosted/RECOVERY.md)。当前架构与延期实机验收分别见 [`PROJECT_ARCHITECTURE.md`](./PROJECT_ARCHITECTURE.md) 和 [`docs/self-hosted/MANUAL_ACCEPTANCE.md`](./docs/self-hosted/MANUAL_ACCEPTANCE.md)。

## 参与贡献

请在 [Quorum Issues](https://github.com/brepublic/Quorum/issues) 报告问题或提出改进建议，并向本仓库提交 Pull Request。社区讨论请前往 [Quorum Discussions](https://github.com/brepublic/Quorum/discussions)。

## 鸣谢

Quorum 基于 [Muncoordinated](https://github.com/MaxwellBo/Muncoordinated-2) 开发。感谢原作者 [Max Bo](https://github.com/MaxwellBo)、原项目的所有贡献者，以及曾协助该项目的 [UQ United Nations Student Association](https://www.facebook.com/UQUNSA/)。

## 许可证

本项目采用 [GNU GPLv3](LICENSE) 许可证。请同时保留原项目的版权与署名信息。
