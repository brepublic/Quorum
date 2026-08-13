# 阶段 6.8 交接 Prompt

```text
继续 Quorum 自托管迁移，只实施阶段 6.8：自托管文件 UI 与阶段 6 收尾。

仓库：/home/makoto/code/Quorum
分支：self-host
基线：阶段 6.7 提交后的 HEAD。开始前用 git log、git status 和 docs/self-hosted/RUNNING_LOG.md 核对，不假定工作区干净。

开始前：
1. 阅读 AGENTS.md、PROJECT_ARCHITECTURE.md，以及 docs/self-hosted/ 下的 ARCHITECTURE.md、DATA_API_SPEC.md、STORAGE_AGENT_SPEC.md、IMPLEMENTATION_PLAN.md 和 MANUAL_ACCEPTANCE.md。
2. 阅读 AGENTS.md 的 User-facing copy 约束；界面文案使用简体中文模拟联合国术语，默认不添加解释性段落。
3. 所有项目命令前执行 source scripts/wsl-env.sh。
4. 复跑阶段 6.7 针对性测试和 pnpm build:self-host。

只实施 6.8：
- 在 `VITE_RUNTIME_MODE=self-hosted` 的委员会工作区接入现有阶段 6 同源 API；Firebase 默认运行时及其文件页面保持不变，不双写。
- 提供文件列表、上传、当前状态、提交审核、发布、下载和永久删除入口。上传在浏览器计算或提供 SHA-256 时必须保持可取消的流式/分块体验，不把完整大文件复制到多份内存；显示真实进度与可重试失败。
- PUBLIC 只显示公开委员会已发布文件；member、Chair、Owner 按服务端契约显示授权内容和操作。前端隐藏或禁用不能替代服务端授权；SYSTEM_ADMIN 不自动显示 Chair 操作。
- 文件状态使用明确的简体中文术语，区分“上传完成”“待审核”“已发布”；删除确认只保留会改变决定所需的警示，不添加防御性安慰文案。
- 下载必须使用服务端 attachment 路由，不把用户文件内容或危险 MIME 注入 DOM、iframe、object、data URL 或同源预览。
- Chair/Owner 提供存储 provider 配置选择、验证状态、迁移创建/进度/失败/重试/确认/取消入口；只有系统管理员可管理 S3 endpoint 和凭据，凭据不能回显或进入浏览器日志。
- 90% 容量、容量未知、provider 故障、revision 冲突、幂等冲突、暂停状态和权限拒绝显示稳定且可操作的短错误；409 后重新获取服务端状态，不静默覆盖。
- SSE 文件/迁移事件只触发安全刷新；未知事件、序号缺口和游标过期继续回退完整快照或列表，不在客户端拼接权威状态。
- 保持现有响应式布局、键盘操作、焦点、可访问名称和触控尺寸；不要在本阶段重做全站视觉主题或动画。
- 不实施 Chair Local Agent、设备配对、lease/fencing、本地目录同步、归档、备份、Firebase 移除或阶段 7 以后后端。

需要测试：
- API client 请求方法、Cookie/CSRF、Idempotency-Key、revision、错误映射和 attachment 下载。
- PUBLIC/member/Chair/Owner/SYSTEM_ADMIN 的显示与操作矩阵；暂停、陈旧 revision、容量 critical 和 provider 失败。
- 上传选择、哈希、进度、取消、重试、同一幂等请求回放，以及成功后列表状态刷新。
- 审核、发布、删除确认和删除后立即不可见；危险 MIME 不进入可执行预览。
- provider 配置不显示凭据；迁移 COPY/FAILED/READY/COMPLETED/CANCELLED 状态及重试/确认/取消。
- 窄屏、触控、键盘、焦点和简体中文长文本；浏览器实际上传/下载与视觉证据写入 MANUAL_ACCEPTANCE.md。
- 未配置真实 PostgreSQL 时集成测试明确 skip；缺少 Cypress/浏览器时如实记录，不以组件测试代替。

完成后运行：
- 针对性 Vitest
- pnpm test:self-host
- pnpm build
- pnpm build:self-host
- pnpm test:self-host:integration
- 可用时 pnpm test:e2e；不可用时记录原因
- git diff --check

更新 PROJECT_ARCHITECTURE.md、相关 README、DATA_API_SPEC.md、IMPLEMENTATION_PLAN.md、MANUAL_ACCEPTANCE.md 和 RUNNING_LOG.md，只描述已经落地的事实。将 6.8 单独提交，确认阶段 6 收尾后继续阶段 7 Chair Local Agent。
```
