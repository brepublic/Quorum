# 存储与 Chair Local Agent 规格 v0.1

## 1. 存储提供者

每个委员会有一个活动存储绑定：

```text
SERVER_VOLUME
CHAIR_AGENT
S3_COMPATIBLE
```

数据库始终保存逻辑文件、内容版本、哈希、大小、同步状态和活动提供者。提供者只保存二进制内容，不成为权限或议事状态真相。

### `SERVER_VOLUME`

内容存入挂载到应用容器的持久卷。路径由内部 blob ID 派生，不使用用户文件名直接拼接文件系统路径。

### `S3_COMPATIBLE`

系统管理员创建实例级存储配置，保存 endpoint、region、bucket、prefix 和加密凭据。Chair 只能选择获准配置，不能读取凭据。腾讯云 COS 通过其 S3 兼容接口接入；首版不实现 OneDrive、Google Drive 等 OAuth 网盘。

### `CHAIR_AGENT`

主席电脑上的 Local Agent 是指定文件夹的主机。普通浏览器不直接访问主席电脑；Agent 始终主动向 Quorum 服务器建立 HTTPS 连接。

## 2. 文件数据模型

```text
file_entries
  id, committee_id, logical_name, media_type, status
  current_version_id, created_by_user_id, created_at, deleted_at

file_versions
  id, file_entry_id, revision, blob_id
  original_name, size_bytes, sha256, created_by_user_id, created_at

file_blobs
  id, size_bytes, sha256, storage_binding_id, storage_key
  durability_state, cache_state, created_at

file_uploads
  id, committee_id, expected_size, received_size, sha256?
  staging_key, status, expires_at

file_tombstones
  file_entry_id, last_content_revision, deleted_by_user_id, deleted_at

storage_bindings
  id, committee_id, provider_type, provider_config_id?, status, revision

storage_hosts
  id, committee_id, device_id, user_id
  lease_generation, status, last_seen_at, paired_at, revoked_at
```

逻辑文件删除后立即不可见且内容进入物理删除任务。墓碑不含可恢复内容，只防止离线 Agent 把旧副本重新发布；它至少保留到委员会永久删除。

## 3. 上传和发布

所有提供者使用相同流程：

```text
创建 upload
→ 流式写入服务器持久暂存区
→ 校验大小和 SHA-256
→ 提交目标提供者
→ 目标重新校验
→ 数据库事务创建 file version 和事件
→ 清理暂存内容
```

上传暂存区是唯一副本时属于 durable staging，不参与 LRU。只有目标提供者确认完整保存后才能删除。

Chair Agent 模式状态：

```text
UPLOADING
PENDING_HOST_COMMIT
SYNCING
SYNCED
OUT_OF_SYNC
DELETED
```

服务器可以在 Agent 离线时接收新文件并标记 `PENDING_HOST_COMMIT`。是否临时提供下载由有效服务器暂存副本决定；页面必须显示尚未同步到主席电脑。

## 4. Agent 配对与身份

1. Chair 在委员会存储设置生成一次性配对码。
2. 配对码有短期有效期、只可使用一次，并且只保存哈希。
3. Agent 生成设备密钥并提交配对码。
4. 后端确认调用者仍为 Chair，签发可撤销的设备凭据。
5. 用户在本地选择目录；Agent 写入不含秘密的 `.quorum-storage.json` 标识。
6. 后端为该设备授予新的 `lease_generation`。

设备凭据只能访问其委员会的存储 Agent API，不能调用账号或议事管理接口。

## 5. 单主机与 fencing

一个委员会同一时间只有一个有效 Chair storage host。每个同步请求携带 `lease_generation`。转移或撤销主机时数据库递增 generation；旧 Agent 即使稍后联网也会收到 `409 STALE_STORAGE_LEASE`，不能继续写入。

主机转移：

```text
冻结旧主机的新提交
→ 为新主机同步完整 manifest
→ 校验文件数、revision 和 SHA-256
→ 数据库事务切换 host 与 generation
→ 解冻新主机
```

失败时旧主机继续有效，不产生两个主副本。

## 6. Agent 同步协议

建议使用普通 HTTPS 长轮询或 SSE 接收任务，分块 HTTP 上传和下载内容；不要求入站端口。

核心接口：

```text
POST /api/v1/storage-agent/pair
POST /api/v1/storage-agent/heartbeat
GET  /api/v1/storage-agent/manifest
GET  /api/v1/storage-agent/tasks?after=:sequence
POST /api/v1/storage-agent/tasks/:id/claim
POST /api/v1/storage-agent/tasks/:id/complete
POST /api/v1/storage-agent/tasks/:id/fail
POST /api/v1/storage-agent/local-changes
GET  /api/v1/storage-agent/blobs/:id
POST /api/v1/storage-agent/blobs
```

每个 task 和内容提交都带 task ID、lease generation、file revision、预期大小和 SHA-256。重复完成同一任务必须幂等。

## 7. 本地目录监测

Agent 使用操作系统文件监测作为快速提示，同时定期完整扫描作为最终依据：

1. 比较相对路径、大小和修改时间；
2. 候选变化重新计算 SHA-256；
3. 与最近确认 manifest 比较；
4. 上报新增、修改或删除；
5. 后端按 file revision 和 lease 判断是否接受；
6. 冲突时保留本地内容，要求 Chair 选择版本，不静默覆盖。

路径必须规范化并拒绝越出根目录的 `..`、符号链接逃逸、设备文件和保留系统路径。服务器下发的文件先写临时文件，校验后原子重命名。

## 8. 离线与降级

Agent 心跳超过宽限期后，存储状态变为 `STORAGE_DEGRADED`，但不自动暂停会议：

- 点名、问题、动议、投票和计时器继续运行；
- 页面显示存储主机离线及最后在线时间；
- 服务器缓存或暂存中的有效副本仍可下载；
- 仅存在主席电脑的文件暂时不可下载；
- 新上传留在 durable staging，等待 Agent 恢复；
- 主席可以手动暂停、转移主机或切换提供者。

Agent 重连后先拉取墓碑和服务端 manifest，再上报本地变化，防止删除文件复活。

## 9. 存储切换

三种提供者之间的切换是后台复制任务：

```text
创建目标 binding
→ 复制全部当前 blob
→ 对目标执行 HEAD/读取校验
→ 比较 manifest
→ Chair 确认
→ 原子切换 active binding
→ 按删除策略清理旧副本
```

复制期间旧 provider 继续提供服务。数据库中的文件记录只在整个切换成功后指向新 binding。

## 10. 配额和运行保护

- 默认单文件限制 20 MiB，由系统管理员调高。
- 单委员会文件数量和总字节数设软配额并显示给 Chair。
- 服务器磁盘 80% 告警；90% 拒绝新内容上传。
- 暂存内容有后台清理，但只有已提交、失败且过期或明确取消的 upload 可以删除。
- 下载响应必须使用安全 `Content-Disposition` 和内容类型，禁止把用户上传 HTML 以内联同源页面执行。
- S3 和 Agent 凭据不得出现在日志、事件或审计 payload。

## 11. Agent 发布目标

v1 必须支持 Windows x86-64 与 macOS。Linux 使用相同协议并预留构建，但不作为首个发布阻断项。普通 Quorum Web 前端仍支持 Chromium、Firefox、Safari、iPad 和 Android；只有配置 Chair Computer 主存储的主席电脑需要安装 Agent。
