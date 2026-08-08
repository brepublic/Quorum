# Quorum

Quorum 是一款用于模拟联合国（Model UN）委员会管理的免费开源 Web 应用。它支持实时协作，涵盖发言名单、核心磋商、动议、决议草案与修正案、表决、文件分享和会场统计等常用流程。

源码仓库：[github.com/brepublic/Quorum](https://github.com/brepublic/Quorum)

![Quorum 界面截图](public/promo.png)

## 技术栈

- React 18、TypeScript、Vite 与 Semantic UI React
- Firebase Authentication、Realtime Database 与 Cloud Storage
- Vitest 单元测试、Cypress 端到端测试
- 英语与简体中文界面

## 本地开发

需要 Node.js 22、pnpm，以及运行 Firebase Emulator Suite 所需的 Java 21 或更高版本。

在 WSL 中，先从仓库根目录加载项目工具链环境：

```sh
source scripts/wsl-env.sh
```

安装依赖并启动开发服务器：

```sh
pnpm install --frozen-lockfile
pnpm start
```

应用默认通过 [http://localhost:5173](http://localhost:5173) 访问。默认配置会连接现有 Firebase 项目；本地开发和测试应优先使用模拟器，避免改动生产数据。

## 使用 Firebase 模拟器

分别在两个终端运行：

```sh
pnpm emulators
```

```sh
VITE_USE_FIREBASE_EMULATORS=true pnpm start
```

模拟器端口为 Auth 9099、Realtime Database 9000、Storage 9199，管理界面位于 4000。

## 测试与构建

```sh
pnpm exec vitest run  # 一次性运行单元测试
pnpm test:e2e         # 使用 Firebase 模拟器运行 Cypress 集成测试
pnpm build            # TypeScript 检查并生成生产构建
```

`pnpm test` 会以监听模式运行 Vitest，不会自动退出。生产构建输出到 `build/`。

## 参与贡献

请在 [Quorum Issues](https://github.com/brepublic/Quorum/issues) 报告问题或提出改进建议，并向本仓库提交 Pull Request。社区讨论请前往 [Quorum Discussions](https://github.com/brepublic/Quorum/discussions)。

## 鸣谢

Quorum 基于 [Muncoordinated](https://github.com/MaxwellBo/Muncoordinated-2) 开发。感谢原作者 [Max Bo](https://github.com/MaxwellBo)、原项目的所有贡献者，以及曾协助该项目的 [UQ United Nations Student Association](https://www.facebook.com/UQUNSA/)。

## 许可证

本项目采用 [GNU GPLv3](LICENSE) 许可证。请同时保留原项目的版权与署名信息。
