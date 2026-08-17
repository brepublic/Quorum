# 腾讯云 Ubuntu 单机部署手册

本文适用于一台只有腾讯云 Ubuntu Server 26.04 LTS 默认软件的 CVM，将 Quorum 以仓库自带的 Docker Compose 方案部署为单机生产实例。Compose 启动 Caddy、Quorum 应用和 PostgreSQL 16；只有 Caddy 对外监听 80/443，数据库不映射主机端口。

本文中的验收分为两类：

- 部署验收：证明主机、容器、TLS、数据库和持久卷已按预期运行。
- 业务验收：证明身份、委员会、实时事件、文件、权限和恢复流程在真实环境可用。

任何阶段未通过，都先停止并修复，不要继续把实例投入生产。

## 0. 部署前准备

准备以下信息和资源：

- 一台至少 2 vCPU、2 GiB 内存的腾讯云 CVM；生产文件较多时应使用更大的独立云硬盘。
- 一个已完成备案或符合实际接入地区要求的域名，例如 `quorum.example.com`。
- 域名 DNS 管理权限、CVM 公网 IPv4 地址和腾讯云安全组管理权限。
- 能保存恢复材料的独立位置。不要只把备份放在同一台 CVM 或同一块云硬盘。
- 仓库的只读拉取凭据，以及准备部署的明确 tag 或 commit。不要直接部署一个不断移动的分支头。

记录部署参数，但不要把密码、master key、bootstrap secret、Session 或 CSRF token 写入工单、截图和普通日志。

```text
域名：
公网 IPv4：
Ubuntu 版本：
部署 commit：
部署时间：
验收人：
异地备份位置：
```

### 阶段 0 验收

- [ ] 已确定唯一生产域名和固定部署 commit/tag。
- [ ] DNS、安全组和主机均由可联系的管理员控制。
- [ ] 已准备与 CVM 故障域隔离的备份位置。
- [ ] 已确认 2 vCPU、2 GiB 是最低起点，不是容量承诺。

## 1. 配置腾讯云网络和 DNS

在腾讯云安全组配置入站规则：

| 协议和端口 | 来源 | 用途 |
| --- | --- | --- |
| TCP 22 | 管理员固定公网 IP/32，或可信办公网段 | SSH |
| TCP 80 | `0.0.0.0/0`；使用 IPv6 时另加 `::/0` | ACME 校验和 HTTP 跳转 |
| TCP 443 | `0.0.0.0/0`；使用 IPv6 时另加 `::/0` | HTTPS |
| UDP 443 | `0.0.0.0/0`；可选 | HTTP/3 |

不要开放 3000、5432、Docker daemon 或任意管理面板端口。若管理员公网 IP 会变化，应通过堡垒机、VPN 或腾讯云登录能力管理 SSH，而不是长期向全球开放 22。

为域名创建 A 记录，指向 CVM 公网 IPv4。只有在 CVM 确实配置并可路由公网 IPv6 时才创建 AAAA 记录；错误的 AAAA 会使部分客户端和证书校验失败。

在本地管理电脑验证：

```sh
dig +short A quorum.example.com
dig +short AAAA quorum.example.com
```

### 阶段 1 验收

- [ ] A 记录只返回目标 CVM 的公网 IPv4。
- [ ] 不需要 IPv6 时没有 AAAA；需要时 AAAA 可从公网实际到达该主机。
- [ ] 安全组只开放 22/TCP、80/TCP、443/TCP 和可选 443/UDP。
- [ ] 3000/TCP 与 5432/TCP 没有公网入站规则。

## 2. 首次登录、更新与 SSH 保护

用腾讯云控制台给出的默认账号和认证方式登录。镜像和购买方式不同，默认用户名可能不同，不要硬编码假设。

```sh
ssh <默认用户>@<公网IPv4>
whoami
cat /etc/os-release
uname -m
```

应看到 Ubuntu 26.04 LTS，架构应与所购实例一致，通常是 `x86_64` 或 `aarch64`。

更新系统并安装部署所需的基础工具：

```sh
sudo apt update
sudo DEBIAN_FRONTEND=noninteractive apt full-upgrade -y
sudo apt install -y ca-certificates curl git openssl jq dnsutils unattended-upgrades
sudo systemctl enable --now unattended-upgrades
sudo timedatectl set-timezone Asia/Hong_Kong
sudo reboot
```

重启后重新登录。如果默认账号不适合作为长期运维账号，创建专用账号：

```sh
sudo adduser quorumops
sudo usermod -aG sudo quorumops
sudo install -d -m 700 -o quorumops -g quorumops /home/quorumops/.ssh
sudo cp ~/.ssh/authorized_keys /home/quorumops/.ssh/authorized_keys
sudo chown quorumops:quorumops /home/quorumops/.ssh/authorized_keys
sudo chmod 600 /home/quorumops/.ssh/authorized_keys
```

保持当前 SSH 会话不退出，另开终端验证新账号能够用密钥登录和执行 `sudo -v`。只有第二个会话成功后，才考虑在 `/etc/ssh/sshd_config.d/99-quorum-hardening.conf` 禁用密码和 root 登录：

```text
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
```

先检查配置，再重新加载：

```sh
sudo sshd -t
sudo systemctl reload ssh
```

### 阶段 2 验收

- [ ] `/etc/os-release` 显示 Ubuntu 26.04 LTS，系统更新已完成。
- [ ] 重启后时间、DNS、出站 HTTPS 和 SSH 正常。
- [ ] 专用管理员可在第二个会话通过密钥登录并使用 sudo。
- [ ] 若已禁用密码/root 登录，`sudo sshd -t` 无输出且现有密钥登录仍成功。
- [ ] 没有为了“测试”提前关闭唯一可用的 SSH 会话。

## 3. 安装 Docker Engine 与 Compose 插件

使用 Docker 官方 apt 仓库，不使用生产环境不推荐的 convenience script。

```sh
sudo apt remove -y docker.io docker-compose docker-compose-v2 docker-doc \
  docker-buildx podman-docker containerd runc || true
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker version
sudo docker compose version
```

本手册保留 `sudo docker`。把用户加入 `docker` 组等同于授予接近 root 的主机控制权，不是普通的最小权限授权。

Docker 发布容器端口时可能绕过 UFW 规则，因此公网边界以腾讯云安全组为第一道控制；仍须确认 Compose 没有发布非预期端口。

### 阶段 3 验收

- [ ] `docker.service` 为 active，开机自启。
- [ ] `hello-world` 正常退出并打印成功信息。
- [ ] `sudo docker compose version` 可用；不是旧的独立 `docker-compose`。
- [ ] 腾讯云安全组仍未开放 3000、5432 或 Docker daemon 端口。

## 4. 获取并固定 Quorum 版本

选择仅运维账号可写的安装目录：

```sh
sudo install -d -m 0750 -o "$USER" -g "$USER" /opt/quorum
git clone <仓库URL> /opt/quorum/app
cd /opt/quorum/app
git fetch --tags --prune
git checkout --detach <发布tag或完整commit>
git status --short
git rev-parse HEAD
```

`git status --short` 必须为空。把 `git rev-parse HEAD` 的完整值写入变更记录。若仓库为私有仓库，使用只读 deploy key；部署完成后不要在主机保留可推送的个人凭据。

检查 Compose 将要使用的镜像、端口和卷：

```sh
sudo docker compose --env-file deploy/.env.example -f deploy/compose.yaml config --images
grep -nE '(^| )ports:|80:80|443:443|5432|3000' deploy/compose.yaml
grep -nE 'postgres_data|quorum_files|caddy_data|caddy_config' deploy/compose.yaml
```

### 阶段 4 验收

- [ ] HEAD 等于审批过的 tag/commit，而不是未固定的分支头。
- [ ] 工作树无本地修改。
- [ ] Compose 包含 Caddy、app、PostgreSQL 16 和四个命名卷。
- [ ] PostgreSQL 与 app 没有主机端口映射。

## 5. 创建生产环境文件

复制模板并限制权限：

```sh
cd /opt/quorum/app
umask 077
cp deploy/.env.example deploy/.env
chmod 600 deploy/.env
openssl rand -base64 36 | tr -d '\n' > /tmp/quorum-postgres-password
openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n' > /tmp/quorum-master-key
```

编辑 `deploy/.env`：

```dotenv
QUORUM_SITE_ADDRESS=https://quorum.example.com
QUORUM_ALLOWED_ORIGINS=https://quorum.example.com
QUORUM_VERSION=<发布tag或短commit>
QUORUM_MAX_FILE_BYTES=20971520
QUORUM_MAX_UPLOAD_REQUEST_BYTES=22020096
QUORUM_UPLOAD_TTL_SECONDS=86400
QUORUM_STORAGE_WARNING_PERCENT=80
QUORUM_STORAGE_CRITICAL_PERCENT=90
QUORUM_STORAGE_MASTER_KEY=<粘贴/tmp/quorum-master-key内容>
QUORUM_STORAGE_MASTER_KEY_VERSION=1
POSTGRES_USER=quorum
POSTGRES_PASSWORD=<粘贴/tmp/quorum-postgres-password内容>
POSTGRES_DB=quorum
```

要求：

- `QUORUM_SITE_ADDRESS` 与 `QUORUM_ALLOWED_ORIGINS` 使用同一个实际 HTTPS Origin，不带尾部斜杠。
- master key 必须是 32 字节、无填充的 base64url；它用于加密 S3 凭据。遗失或直接替换会使已有密文不可解密。
- 数据库密码和 master key 应立即保存到密码管理器或离线恢复材料；不要提交到 Git。
- 两个 `/tmp` 临时文件确认保存后安全删除：`shred -u /tmp/quorum-postgres-password /tmp/quorum-master-key`。云盘上的 `shred` 不能保证底层块被物理覆写，因此不要把临时文件当作秘密存储。

验证配置展开，不打印包含秘密的完整配置：

```sh
test "$(stat -c %a deploy/.env)" = 600
grep -E '^(QUORUM_SITE_ADDRESS|QUORUM_ALLOWED_ORIGINS|QUORUM_VERSION)=' deploy/.env
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml config --quiet
```

### 阶段 5 验收

- [ ] `deploy/.env` 权限为 600，且未被 Git 跟踪。
- [ ] 域名和 allowed origin 完全一致。
- [ ] 数据库密码与 master key 均为随机值，不含模板占位符。
- [ ] master key 和数据库密码已有 CVM 之外的安全副本。
- [ ] `docker compose ... config --quiet` 退出码为 0。

## 6. 首次构建和启动

先确认资源、端口和 DNS：

```sh
free -h
df -h /var/lib/docker /opt/quorum
sudo ss -ltnup | grep -E ':(80|443|3000|5432)\b' || true
dig +short A quorum.example.com
```

80/443 此时不应被其他程序占用。启动：

```sh
cd /opt/quorum/app
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --build
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml ps
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 app
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 caddy
```

应用首次连接空库时执行带校验和的 migration，并在 app 标准错误中显示一次 bootstrap secret。立刻把 secret 放入密码管理器；不要复制到聊天、工单或 shell history。若日志已经轮转且 secret 丢失，不要尝试从数据库恢复明文；在尚未初始化且无业务数据时按受控重建流程重新创建实例。

等待三个服务进入 running/healthy。若 Caddy 证书申请失败，先检查 A/AAAA、腾讯云安全组、主机端口占用和 Caddy 日志，不要改成明文 HTTP 继续生产部署。

### 阶段 6 验收

- [ ] Compose 构建成功，postgres、app 和 caddy 均持续运行；有 healthcheck 的服务为 healthy。
- [ ] app 日志显示 migration 完成，没有 checksum、schema compatibility 或存储卷错误。
- [ ] 首次 bootstrap secret 已安全保存，未进入工单或普通日志附件。
- [ ] Caddy 日志显示已取得目标域名证书，没有持续 ACME 重试。
- [ ] `docker compose ps` 只发布 80/443，不发布 3000/5432。

## 7. TLS、探针和网络部署验收

从 CVM 外部的管理电脑执行，替换域名：

```sh
curl -fsS https://quorum.example.com/health/live | jq
curl -fsS https://quorum.example.com/health/ready | jq
curl -fsS https://quorum.example.com/api/v1/version | jq
curl -fsSI http://quorum.example.com/
curl -fsSI https://quorum.example.com/nonexistent-spa-route
openssl s_client -connect quorum.example.com:443 \
  -servername quorum.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -issuer -dates
```

预期：live 返回成功；ready 表示 migration、数据库、持久文件卷和容量采样均就绪；version 与部署版本一致；HTTP 跳转到 HTTPS；未知前端路径由 SPA fallback 返回页面。

从外部确认数据库和 app 端口不可达：

```sh
nc -vz -w 3 <公网IPv4> 3000
nc -vz -w 3 <公网IPv4> 5432
```

这两个命令应失败。再在主机检查监听：

```sh
sudo ss -ltnup | grep -E ':(80|443|3000|5432)\b'
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml ps
```

当前 Caddy 配置会把 `/metrics` 通过 HTTPS 暴露，内容只应包含聚合存储指标。若组织政策不允许公网指标端点，应在上线前修改并评审 Caddy 访问边界，不能仅依赖 UFW。

### 阶段 7 验收

- [ ] 公网 TLS 证书的域名、签发者和有效期正确，浏览器无证书警告。
- [ ] HTTP 自动跳转 HTTPS；live、ready、version 和 SPA fallback 均成功。
- [ ] version 与记录的 commit/tag 对应。
- [ ] 外部连接 3000/5432 失败；主机只通过 Docker 发布 80/443。
- [ ] `/metrics` 的公开范围符合组织政策，且内容不含文件名、路径、邮箱、凭据或正文。

## 8. 首次管理员与身份验收

在可信浏览器访问生产 HTTPS 地址。确认初始化页面后，使用保存的一次性 bootstrap secret 创建唯一系统管理员。完成后：

```sh
curl -fsS https://quorum.example.com/api/v1/bootstrap/status | jq
```

状态应显示已初始化。退出后重新登录，再在另一个浏览器或隐私窗口验证 Session 跨请求有效；尝试错误密码并确认不会泄露账号是否存在或内部错误。

执行以下安全检查：

- 浏览器 Cookie 使用 Secure、HttpOnly 和预期 SameSite 属性。
- 修改状态的请求必须有同源 Origin 和有效 CSRF；跨站或缺少 CSRF 的请求失败。
- bootstrap secret 不能再次使用，数据库不再保留可用的 bootstrap secret hash。
- 系统管理员只能执行系统管理员权限，不自动获得任意委员会 Chair 权限。

### 阶段 8 验收

- [ ] 只能创建一个 bootstrap 管理员，secret 成功后立即失效。
- [ ] 管理员可退出并重新登录，Session 在正常浏览器流程中稳定。
- [ ] Cookie、Origin 和 CSRF 边界符合预期。
- [ ] 错误响应和日志不含密码、bootstrap secret、Session 或 CSRF token。

详细证据要求见 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-101 至 SH-MAN-104。

## 9. 核心业务与实时验收

不要直接用真实会议数据做首次验收。创建测试账号和测试委员会，至少覆盖 Owner、Chair、member、非 member 和未登录访问者。

按顺序验证：

1. 创建 PUBLIC 与 PRIVATE 委员会；验证匿名、非成员、成员、Chair、Owner 的快照字段和 404 隐藏边界。
2. 邀请和分配席位；两个浏览器并发操作，确认冲突返回 409 且客户端重新读取权威状态。
3. 执行点名、出席、暂停/恢复、议题、动议、计时、投票和文档流程。
4. 两个浏览器同时打开同一委员会，制造事件后确认 SSE 实时更新；断网后恢复，确认通过游标补齐而不是丢事件。
5. 修改一个用户权限，确认已有 SSE 连接和后续请求及时失去对应访问能力。
6. 检查浏览器 Network，不应出现 Firebase 或其他旧 BaaS 请求。

### 阶段 9 验收

- [ ] PUBLIC/PRIVATE 和各角色字段矩阵正确，未授权访问不泄露资源存在性。
- [ ] 并发冲突不会静默覆盖，事件、审计和业务状态原子一致。
- [ ] SSE 经 Caddy 实时到达，断线重连能补偿事件，权限撤销及时生效。
- [ ] 点名、动议、投票、计时和文档核心流程可完成。
- [ ] 浏览器没有旧 Firebase/BaaS 网络请求。

完整角色、并发和流程清单见 `MANUAL_ACCEPTANCE.md` 的阶段 3 至阶段 5。

## 10. 文件与 SERVER_VOLUME 验收

默认文件 provider 使用 `quorum_files` 命名卷。用无敏感内容的测试文件执行：

1. 上传普通文件、大文件、中文长文件名和危险 MIME 测试文件。
2. 验证上传进度、取消、断网失败和重试；失败上传不得生成可下载 file version。
3. 提交审核、发布、下载并在客户端重算 SHA-256。
4. 验证所有下载使用 attachment；HTML、JavaScript、SVG 等危险类型不能在同源页面执行。
5. 永久删除后立即确认列表不可见、下载 404，随后观察后台删除任务收敛。
6. 暂停委员会，确认上传完成、审核、发布和删除等改变文件状态的命令被拒绝。
7. 重启容器而不是删除卷，再次确认数据库记录和文件仍存在：

```sh
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml restart
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml ps
curl -fsS https://quorum.example.com/health/ready | jq
```

不要用 `docker compose down -v`；`-v` 会删除命名卷和生产数据。

### 阶段 10 验收

- [ ] 成功文件的服务端大小与 SHA-256 正确，失败/取消上传不产生 file version。
- [ ] 文件名不能改变内部 staging 或最终路径。
- [ ] 各角色的列表、审核、发布、下载和删除权限正确。
- [ ] 下载强制 attachment，危险 MIME 不在同源执行。
- [ ] 容器重启后 PostgreSQL、文件和 Caddy 证书数据仍保留。
- [ ] 删除任务最终收敛，日志和响应不含正文、内部路径或秘密。

详细故障注入标准见 `MANUAL_ACCEPTANCE.md` 的 SH-MAN-501 至 SH-MAN-508。S3 和 Chair Local Agent 是可选 provider；启用前必须分别完成其中对应的真实 endpoint、凭据、SSRF、fencing、离线和恢复验收，不能以 SERVER_VOLUME 验收代替。

## 11. 容量、稳定性与主机重启验收

至少观察 30 分钟，并在测试实例或维护窗口执行一次主机重启：

```sh
sudo docker stats --no-stream
free -h
df -h /var/lib/docker
sudo docker system df
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml ps
sudo journalctl -u docker --since '30 minutes ago' --no-pager
```

确认 app 约 512 MiB、PostgreSQL 约 768 MiB、Caddy 约 128 MiB 的 Compose 内存限制没有导致 OOM 或重启。将 `/var/lib/docker` 所在文件系统纳入腾讯云监控；应用的 80% warning 和 90% critical 阈值不能替代宿主机磁盘告警。

在维护窗口执行：

```sh
sudo reboot
```

重新登录后确认 Docker 自动启动、Compose 服务恢复、ready 成功、登录和测试文件下载正常。Docker 默认 restart policy 应使容器恢复，但真实重启验收不可省略。

### 阶段 11 验收

- [ ] 30 分钟内无 OOM、异常重启、持续错误或容量采样失败。
- [ ] CPU、内存和磁盘有合理余量；已配置宿主机磁盘与实例可用性告警。
- [ ] 主机重启后所有服务自动恢复，TLS、登录、数据库和文件均正常。
- [ ] `health/ready` 在故障时失败、恢复后重新成功，而不是永远返回绿色。

## 12. 备份和恢复上线关卡

仓库当前备份入口为：

```sh
source scripts/wsl-env.sh
pnpm self-host:backup -- /absolute/new/backup-directory
```

它需要项目 Node/pnpm 工具链和 `pg_dump`，而本手册的最小生产主机只安装 Docker；当前 app runtime 镜像也不承诺包含 `pg_dump`。因此，仅完成前述 Compose 部署并不等于已经具备可执行备份。上线前必须选择并评审以下一种方案：

- 在受控运维环境安装仓库要求的 Node 22、pnpm 和与 PostgreSQL 16 兼容的客户端，并安全连接生产数据库与 provider；或
- 为生产环境增加经过代码评审的专用备份镜像/Compose profile，再按 `RECOVERY.md` 生成完整 dump、manifest 和 metadata。

不要临时把 PostgreSQL 5432 暴露到公网。无论采用哪种方案，都必须生成：

- `database.dump`
- `file-manifest.jsonl`
- `backup-metadata.json`

然后把恢复点复制到异地加密存储，在隔离的 PostgreSQL 16 和 provider 副本上完成恢复演练。逐项核对数据库 dump 与每个 provider 对象的大小和 SHA-256，并验证 ready、登录、委员会快照、归档和授权下载。

### 阶段 12 验收

- [ ] 已有可重复执行的备份运行环境，不依赖临时开放数据库公网端口。
- [ ] 最近一次备份同时含 dump、manifest、metadata，权限和 SHA-256 正确。
- [ ] 备份已复制到与 CVM/云硬盘不同故障域的加密位置。
- [ ] 已在隔离环境成功恢复，并保存脱敏的退出码、schema、对象计数和哈希汇总。
- [ ] 已规定恢复点目标、保留周期、负责人和定期恢复演练周期。

阶段 12 未通过时，不应把实例认定为可恢复的生产系统。破坏性恢复步骤和证据要求见 `RECOVERY.md`。

## 13. 上线审批与日常操作

上线前汇总以下证据：

- 部署 commit、Compose 构建结果和 `docker compose ps`。
- TLS 证书、live/ready/version、外部端口探测结果。
- 唯一管理员、Cookie/Origin/CSRF 和角色矩阵结果。
- 核心业务、SSE、文件 SHA-256、重启持久性结果。
- 资源基线、主机告警、备份产物和隔离恢复演练结果。
- 所有延期项目的负责人、风险接受人和截止日期。

日常命令：

```sh
cd /opt/quorum/app
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml ps
sudo docker compose --env-file deploy/.env -f deploy/compose.yaml logs --tail=200 app
curl -fsS https://quorum.example.com/health/ready | jq
```

更新时先备份并在预生产环境验证目标 commit，然后显式 checkout、重新构建并观察 migration。不要使用 `git pull` 后不记录 commit 的方式更新生产。不要执行 `docker compose down -v`、`docker volume prune` 或 `docker system prune --volumes`。

### 最终验收

- [ ] 阶段 0–12 全部通过，或每项延期已有书面风险接受、负责人和截止日期。
- [ ] 至少两人能够按本文恢复 SSH、域名、环境秘密和异地备份。
- [ ] 发布记录能够把线上版本追溯到唯一 Git commit。
- [ ] 已完成 `MANUAL_ACCEPTANCE.md` 中与实际启用功能对应的真实环境项目。
- [ ] 未启用的 S3、Chair Agent 等 provider 明确标记为未启用，而不是误记为已验收。

## 官方安装依据

- Ubuntu 发布周期：<https://ubuntu.com/about/release-cycle>
- Docker Engine on Ubuntu：<https://docs.docker.com/engine/install/ubuntu/>
- Docker 防火墙注意事项：<https://docs.docker.com/engine/network/packet-filtering-firewalls/>
- Caddy Automatic HTTPS：<https://caddyserver.com/docs/automatic-https>
- 腾讯云安全组配置：<https://cloud.tencent.com/document/product/213/15377>
