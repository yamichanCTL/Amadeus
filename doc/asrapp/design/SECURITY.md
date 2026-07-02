# 安全设计

> **父文档**: [← 返回设计决策](README.md)

---

## 安全边界

```
用户请求
    │
    ▼
┌──────────────┐
│  Auth (JWT)  │  身份验证
└──────┬───────┘
       │
       ▼
┌──────────────────┐
│  Skill Enforcer  │
│  - 路径隔离      │  文件操作限制
│  - 命令白名单    │  只允许安全命令
│  - 危险拦截      │  阻止破坏性操作
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│  Agent Workspace │
│  - 项目根目录    │  子进程隔离
│  - 超时控制      │  防止无限运行
│  - 输出截断      │  防止内存溢出
└──────────────────┘
```

## 多层防护

### 1. 路径隔离

- 文件操作限制在项目根目录内
- 不允许访问 `/etc`、`~/.ssh`、系统敏感路径
- `..` 路径遍历检测

### 2. 命令白名单

只允许预定义的安全命令：

```
ls, find, grep, cat, head, tail, wc,
git, python, echo, mkdir, touch, cp, mv
```

### 3. 危险模式拦截

阻止以下模式：

| 模式 | 示例 |
|------|------|
| 递归删除 | `rm -rf`, `rm -r` |
| 提权操作 | `sudo`, `su` |
| 磁盘操作 | `mkfs`, `dd if=`, `fdisk` |
| 权限修改 | `chmod -R`, `chown -R` |
| 敏感路径删除 | `/home`, `/etc`, `/var` |
| 管道写入 | `> /etc/`, `>> /etc/` |

### 4. JWT 认证

- API 调用使用 Bearer Token
- `ACCESS_TOKEN_EXPIRE_MINUTES` 控制有效期
- 注册/登录接口不限流（dev 阶段）

### 5. Agent 执行约束

| 约束 | 值 |
|------|-----|
| 工作目录 | `~/AI/asrapp` |
| 超时 | 300s |
| 最大输出 | 20000 chars |
| dry-run | 支持（只记录命令，不执行） |

## Desktop 安全

- `nodeIntegration: false` — 渲染进程无法访问 Node.js
- `contextIsolation: true` — 渲染进程只能通过 preload
- `sandbox: true` — 浮窗沙盒隔离
- CSP 限制 — 脚本、样式、连接白名单

## 不要做的事

- ❌ 不要默认访问项目外敏感路径
- ❌ 不要静默删除重要文件
- ❌ 不要自动安装未知依赖
- ❌ 不要执行破坏性命令
- ❌ 敏感信息不要自动写入永久记忆

---

> 📖 [架构总览 →](../ARCHITECTURE.md) | [Runner Skills →](../runner/SKILLS.md)
