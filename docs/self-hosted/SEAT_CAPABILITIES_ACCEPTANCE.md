# 独立席位能力：部署与验收（2026-09-17）

## 变更边界

席位类别为 STANDARD、NGO、OBSERVER。表决权、否决权、不得弃权独立保存；否决权和不得弃权均要求具备表决权。前端开启否决权会开启表决权，关闭表决权清除其余两项，切换类型不修改能力。设置页批量开关保留混合态、即时预览、末次点击后 1.5 秒保存，提交最终完整组合。

正式表决保存资格快照，代表选择、投票与改票的弃权限制、否决显示和结果均遵循该场快照。决议草案直接投票继续实时读取当前席位配置，修改席位可改变资格与结果；有否决权席位时，沿用全员投完才显示否决结果的规则。动议直接投票、意向性与匿名投票不新增否决。程序性正式表决现有的否决效果保留，未在本次统一规则。

新增 migration 54，转换当前席位和模板成员的 VETO 类别并重建枚举；独立否决权值保留，不改写审计或正式表决快照。为已有非法组合收敛到约束：无表决权但有否决权的记录补开表决权，其余无表决权记录清除不得弃权。历史 migration 未修改。

## 已验证

- `pnpm build:self-host` 和 app、caddy 两个镜像构建成功。
- `pnpm test:self-host`：82 个测试文件、590 项测试全部通过。包含后端校验、结果计算、设置页批量操作、模板联动、主席和代表的快照资格控件。
- 真实 PostgreSQL 定向验收：8 项通过（其余 98 项按名称筛选跳过）。覆盖从 schema 53 升级、旧否决值保留、审计和正式快照不变、空库完整迁移和重复迁移、三种类别的否决／普通反对票、禁止弃权、代表投票、主席代投、改票、关闭发布、下一场资格变更、直接投票实时变化，以及模板修改、克隆和创建委员会的能力传递。
- 浏览器使用现有 `http://localhost:5173` Vite 入口及重新部署的真实后端。确认关闭表决权清除两项依赖能力；模板中的观察员开启否决权会开启表决权，关闭表决权后保存得到三个关闭值。
- 浏览器正式投票：先创建含中国否决权／不得弃权的正式表决，再关闭中国当前表决权。直接投票名单只剩另外两席；正式表决仍显示中国及否决权，不提供弃权操作，原本无表决权的第四席不在选择器内。中国反对、另两席赞成，关闭并发布后显示“被否决，赞成 2，反对 1，弃权 0”。数据库核对结果为 PUBLISHED / VETOED，原资格仍 hasVeto=true、mustVote=true，当前中国三个能力均为 false。
- 设置页与模板页检查桌面和窄屏布局；长名称换行，窄屏开关附就近标签。浏览器 viewport 请求 1440 与 390 像素；未绕过本机 HTTPS 证书信任错误。

## 验证限制

全量数据库集成入口执行结果为 61 项通过、45 项失败，不能声称全量数据库回归通过。失败涉及 Stage 3/4 和文件模块旧测试仍向邮箱接口传用户 ID、Owner/Chair 和默认权限断言、Stage 5 发言名单尚未开启，以及一项存储 Agent 主机转移测试的预期。不在本次能力拆分中扩修这些模块。首次沙箱内非数据库全量执行出现 Agent 子进程／本机端口限制，最终在允许本机测试端口的环境重跑后 590 项通过。

本次定向数据库复现命令：

```bash
source scripts/wsl-env.sh
TEST_DATABASE_ADMIN_URL=postgresql://quorum_test:quorum_test@127.0.0.1:55432/postgres \
  pnpm test:self-host:integration -t 'independent capabilities|round-trips every capability|PostgreSQL migrations'
```

## 使变更生效

后端和静态前端分别位于 app、caddy 镜像；两者都应重建。只重启旧容器或只运行 build 不会让已有容器切换到新镜像。

```bash
cd /home/makoto/Projects/Quorum
source scripts/wsl-env.sh
docker compose -p quorum-dev --env-file deploy/.env -f deploy/compose.yaml up -d --build --wait app caddy
```

本轮已按用户要求清空当前运行的 `quorum-dev` 数据库及服务器文件卷，并重新部署。验收临时数据也已清理；保留 Caddy 证书卷，停用的另一个 `quorum` 项目不在本次操作范围。再次需要全新开发数据时，使用明确项目与卷名：

最终检查：readiness HTTP 200，schema 54，users=0、committees=0；运行中 app 和 caddy 的镜像摘要与新构建镜像一致。浏览器已显示“初始化管理员”。

```bash
docker compose -p quorum-dev --env-file deploy/.env -f deploy/compose.yaml down
docker volume rm quorum-dev_postgres_data quorum-dev_quorum_files
docker compose -p quorum-dev --env-file deploy/.env -f deploy/compose.yaml up -d --build --wait
```

该清空会删除 quorum-dev 账号、委员会、模板、表决、配对记录和服务器文件。旧主席 Agent 身份需重新配对；主席电脑上的本地目录未删除。

打开开发入口后重新初始化管理员。初始化密钥由新 app 启动时输出一次，可在本机查看：

```bash
docker compose -p quorum-dev --env-file deploy/.env -f deploy/compose.yaml logs app | rg 'Quorum bootstrap secret'
```

管理员创建业务账号后，使用业务账号创建委员会。数据库升级状态应为 54，席位枚举应为 `{STANDARD,NGO,OBSERVER}`。
