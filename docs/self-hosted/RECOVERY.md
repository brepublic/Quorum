# 自托管备份与恢复

首版不调度自动备份，但仓库提供数据库 dump 与文件 manifest 导出入口。备份目录含内部 provider key 和用户数据校验值，必须按生产秘密保护。

## 创建恢复点

在应用仍连接当前 PostgreSQL 和文件 provider 时执行：

```sh
source scripts/wsl-env.sh
pnpm self-host:backup -- /absolute/new/backup-directory
```

目标目录必须不存在。命令使用 `pg_dump --format=custom`，生成 `database.dump`、`file-manifest.jsonl` 和带 SHA-256 的 `backup-metadata.json`，文件权限为 0600、目录为 0700。数据库 dump 与 provider 字节不是同一瞬间快照；恢复前必须用 manifest 的 blob ID、provider、内部 key、大小和 SHA-256 核对每个实际对象。

## 恢复演练

1. 停止 Quorum app 与 Chair Agent 写入，保留 PostgreSQL 和 provider 的只读副本。
2. 在隔离 PostgreSQL 16 实例创建空数据库；校验 `backup-metadata.json` 中两个文件的 SHA-256，再用 `pg_restore --exit-on-error --clean --if-exists --no-owner --dbname <test-db> database.dump` 恢复。
3. 启动与备份 schema compatibility 匹配的 Quorum 版本，只连接隔离数据库与复制出的服务器卷/S3/Chair Agent 测试目录；不得让演练实例连接生产 provider。
4. 逐行解析 `file-manifest.jsonl`，按 provider 与内部 key 读取对象，核对大小和 SHA-256。缺少、额外或哈希不符均视为恢复失败。
5. 运行 `/health/ready`、`/api/v1/admin/operations/status`、登录、委员会快照、归档导出和授权文件下载；确认 pending delete/migration/Agent/deletion job 会从数据库状态继续收敛。
6. 保存脱敏的命令退出码、schema 版本、manifest 数量、哈希核对汇总和探针结果；销毁隔离演练环境。

不要把数据库 dump、manifest、provider key、邮箱、Session、设备凭据、文件名或正文放入工单和普通日志。生产恢复前必须先演练；恢复会覆盖目标数据库，本文档不提供自动执行的破坏性 restore 命令。
