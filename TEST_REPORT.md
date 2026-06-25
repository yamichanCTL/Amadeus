# asrapp 完整测试报告

**日期**: 2026-06-25 → 2026-06-26

**环境**: Python 3.13.5, WSL2 Linux 6.6.87, CUDA GPU, Node.js v22.22.1

**服务状态**: Backend (:8000) ✓ | Higgs TTS (:8002) ✓ | SenseVoice CUDA ✓ | FireRedASR2 ✓ | X-ASR ✓

---

## 一、测试总览

| 测试维度 | 用例数 | 通过 | 失败 | 通过率 | 方法论 |
|----------|--------|------|------|--------|--------|
| 单元测试 | 259 | 259 | 0 | 100% | pytest |
| 端到端功能测试 | 47 | 47 | 0 | 100% | HTTP requests |
| 压力/并发测试 | 6 场景 | — | — | — | ThreadPool + 时序测量 |
| 错误恢复测试 | 10 | 8 | 2 | 80% | 异常输入注入 |
| 前端编译检查 | 2 | 2 | 0 | 100% | tsc + vite build |
| Runner 全链路 | 1 | 1 | 0 | 100% | claude_code CLI 217s |

---

## 二、按功能分类的详细测试

### 2.1 ASR 语音识别

| 测试项 | 方法 | 结果 | 详情 |
|--------|------|------|------|
| 单次转写 (SenseVoice) | 真实模型 + WAV | ✅ | 冷启动 6.9s，热缓存 80ms |
| FireRedASR2 转写 | 真实模型 + WAV | ✅ | 已注册，引擎可加载 |
| X-ASR 流式引擎 | 真实模型 | ✅ | 支持 streaming，4 种 chunk 变体 |
| Qwen3-ASR | 引擎注册 | ✅ | 已注册，未加载 |
| Whisper | 引擎注册 | ✅ | 已注册，未加载 |
| 无效引擎拒绝 | 传入不存在的引擎名 | ❌ **BUG** | 静默 fallback 到 sensevoice，应返回 422 |
| 缺失文件拒绝 | POST 无 file | ✅ | 正确返回 422 |
| 非法 JSON options | 畸形 JSON | ✅ | 正确返回 422 |
| **5 并发转写** | 5 用户同时 | ✅ | mean=1.33s, p95=1.40s |
| **10 并发转写** | 10 用户同时 | ✅ | mean=3.97s, p95=4.26s (**3x 退化**) |
| **15 并发转写** | 15 用户同时 | ✅ | mean=6.14s, p95=6.50s (**4.6x 退化**) |
| **20 并发转写** | 20 用户同时 | ✅ | mean=7.91s, p95=8.61s (**6x 退化**) |

> **关键发现**: ASR 模型串行处理请求。每增加 5 个并发用户，p95 延迟增加 ~2s。20 用户时 p95 延迟 8.6s。SenseVoice 单 GPU 模型在 5 用户以内可用，超过后体验恶化。

**延迟基准线 (单次, 热缓存)**:
| 端点 | mean | p95 | p99 |
|------|------|-----|-----|
| `/v1/health` | 1ms | 1ms | 1ms |
| `/v1/models` | 2ms | 2ms | 2ms |
| `/v1/skills` | 1ms | 2ms | 2ms |
| `/v1/tasks` | 5ms | 6ms | 6ms |
| `/v1/transcribe` (热) | 80-160ms | — | — |

---

### 2.2 TTS 语音合成

| 测试项 | 方法 | 结果 | 详情 |
|--------|------|------|------|
| Higgs TTS 健康检查 | HTTP GET | ✅ | connected=True |
| Higgs 声音列表 | HTTP GET | ✅ | Elysia/chenjie/default/dsm/maoli/wyk (6 个) |
| Higgs voices (远端) | HTTP GET | ⚠️ p95=403ms | 跨服务调用有额外延迟 |
| GPT-SoVITS 服务 | HTTP 端口探测 | ❌ 未运行 | Port 9880 无响应 |
| Simple TTS (fallback) | HTTP POST | ❌ 500 | 依赖 GPT-SoVITS 服务 |
| Voice converter 声音列表 | HTTP GET | ✅ | 1ms 响应 |
| MockTTS 合成 | 单测 | ✅ | 文本截断、时长估算均正确 |
| TTSRequest 输入校验 | 单测 | ✅ | 空文本正确拦截 |

---

### 2.3 Skills 技能系统

**注册的 19 个 Skills**:

| 类别 | 技能 | 执行测试 |
|------|------|----------|
| general | `system_info` | ✅ Linux, CPU 32核, 655GB 磁盘 |
| general | `get_context` | ✅ default_engine=sensevoice |
| code | `shell` | ✅ echo 正确输出 |
| code | `run_python` | ✅ `2+3*4=14` |
| code | `git_clone` | ⚠️ 未执行 (需网络) |
| code | `self_improve` | ⚠️ 未执行 (需 CLI agent) |
| fs | `read_file` | ✅ 读取 CLAUDE.md |
| fs | `write_file` | ⚠️ 未执行 (写操作) |
| fs | `list_dir` | ✅ 列出 runner/ 目录 |
| agent | `delegate_agent` | ⚠️ 未执行 (需 CLI agent) |
| audio | `tts` | ⚠️ 需 API token |
| audio | `tts_gpt_sovits` | ⚠️ 需服务 |
| audio | `speak` | ⚠️ 需 API token |
| web | `web_search` | ⚠️ 未执行 (需网络) |
| web | `web_fetch` | ⚠️ 未执行 (需网络) |
| model | `download_model` | ⚠️ 未执行 (网络+存储) |
| model | `tts_download_models` | ⚠️ 未执行 |
| model | `tts_start_server` | ⚠️ 未执行 (服务管理) |
| model | `tts_stop_server` | ⚠️ 未执行 |

**实际执行**: 6/19 (32%) — 其余 13 个依赖外部服务/网络/CLI agent

**延迟基准线 (Skills 执行)**:
| Skill | mean | p95 |
|-------|------|-----|
| system_info | 1ms | 1ms |
| get_context | 1ms | 1ms |
| shell (echo) | 50ms | 230ms |
| read_file | 50ms | 200ms |
| list_dir | 55ms | 130ms |

---

### 2.4 Agent 系统

| 测试项 | 方法 | 结果 |
|--------|------|------|
| AgentRouter 路由 | 单测 9 个 | ✅ 全部通过 |
| Agent 名称检测 (中/英) | 单测 18 个参数化 | ✅ 全部通过 |
| CLI 适配器 (Codex/Claude/OpenCode) | 单测 12 个 | ✅ 11 pass + 1 skip (Claude 已安装) |
| MockAgent fallback | 单测 | ✅ 永不崩溃 |
| Claude Code CLI 真实执行 | Demo 全链路 | ✅ 217s 成功执行 "分析项目结构" |
| Agent context API | HTTP GET | ✅ 1ms |
| Agent reset API | HTTP POST | ✅ 3ms |
| Agent chat (需 LLM) | HTTP POST | ⚠️ 422 — api_token 缺失 (预期行为) |

---

### 2.5 Memory / 存储

| 测试项 | 方法 | 结果 |
|--------|------|------|
| JSONL 写入 | 单测 | ✅ 字段完整 |
| JSONL 读取 (限制) | 单测 | ✅ 正确限制 |
| 上下文压缩 | 单测 | ✅ 截断+摘要 |
| 永久记忆写入 | 单测 | ✅ 不崩溃 |
| Agent fallback 记录 | 单测 | ✅ 正确记录 |
| **Records 查询** (单次) | HTTP GET | ✅ 130-150ms |
| **Records 查询** (5 并发) | HTTP GET 10 次 | 🚨 **82x 退化** (0.15s→12.76s) |

> **关键发现**: Records 端点扫描 6800+ 归档文件的目录，单次 130ms。并发时 I/O 争用导致 82x 退化。根因: `list_archived_records` 在每次请求时遍历整个目录树。

---

### 2.6 API 端点延迟基准

| 端点 | 方法 | mean | p95 | p99 | ⚠️ |
|------|------|------|-----|-----|-----|
| `/v1/health` | GET | 1ms | 1ms | 1ms | |
| `/v1/health/ready` | GET | 3ms | 3ms | 3ms | |
| `/v1/models` | GET | 2ms | 2ms | 2ms | |
| `/v1/skills` | GET | 1ms | 2ms | 2ms | |
| `/v1/hotwords` | GET | 1ms | 1ms | 1ms | |
| `/v1/llm/defaults` | GET | 1ms | 1ms | 1ms | |
| `/v1/agent/context` | GET | 1ms | 1ms | 1ms | |
| `/v1/tasks` | GET | 5ms | 6ms | 6ms | |
| `/v1/voice/voices` | GET | 1ms | 1ms | 1ms | |
| `/v1/tts/higgs/health` | GET | 10ms | 11ms | 11ms | 跨服务 |
| `/v1/tts/higgs/voices` | GET | **399ms** | 403ms | 403ms | 🚨 跨服务慢 |
| `/v1/records` | GET | **150ms** | 360ms | 360ms | 🚨 I/O 密集 |
| `/v1/records` (5并发) | GET | **12,759ms** | 12,996ms | 12,996ms | 🚨🚨 崩溃 |
| `/v1/skills/execute` | POST | 1-55ms | 230ms | 230ms | |
| `/v1/agent/reset` | POST | 3ms | 10ms | 10ms | |
| `/v1/transcribe` | POST | 80-160ms | — | — | 热缓存 |
| `/v1/transcribe` (冷) | POST | 6,900ms | 6,900ms | 6,900ms | 模型加载 |

---

### 2.7 错误恢复与边界

| 测试项 | 预期 | 实际 | 结果 |
|--------|------|------|------|
| 缺失上传文件 | 422 | 422 | ✅ |
| 无效引擎名 | 422 | **200** (静默fallback) | ❌ **BUG** |
| 畸形 JSON options | 422 | 422 | ✅ |
| 不存在的任务 ID | 404 | 404 | ✅ |
| 空 skill 名 | 422 | 422 | ✅ |
| 不存在的 skill | 200 fail | **404** | ❌ **BUG** |
| 危险命令 (rm -rf /) | 拦截 | 拦截 | ✅ |
| 读取 /etc/passwd | 拦截 | 拦截 | ✅ |
| 超长命令 (10k chars) | 200 或 422 | 200 | ✅ |
| 5 并发模型访问 | 全部成功 | 5/5 200 | ✅ |

---

### 2.8 稳定性与长会话

| 测试 | 参数 | 结果 |
|------|------|------|
| 持续负载 | 30s, 4 workers | 2,257 请求, 75.2 req/s |
| 长会话延迟 | p50 | 3ms |
| 长会话延迟 | p95 | 5ms |
| 长会话延迟 | p99 | 10ms |
| 长会话错误率 | — | 0% |
| 10 并发 health | 100% 成功率 | ✅ |

---

### 2.9 前端编译与构建

| 检查项 | 结果 | 详情 |
|--------|------|------|
| TypeScript 类型检查 | ✅ | `tsc --noEmit` exit 0 |
| Electron 主进程 TypeScript | ✅ | `tsc -p tsconfig.node.json` exit 0 |
| Vite 生产构建 | ✅ | 78 modules, 759ms |
| 构建产物 | ✅ | index.html + CSS + JS (363KB gzip:114KB) |

**前端构建产物**:
```
dist/index.html         0.56 KB
dist/assets/global.css  38.61 KB (gzip 8.36 KB)
dist/assets/mac.css     38.67 KB (gzip 8.37 KB)
dist/assets/index.js   363.54 KB (gzip 114.20 KB)
```

---

## 三、专项 Bug 调查结果

### 🚨 Bug 2: 离线识别后端完成但前端晚几秒才填充文本框

**实测数据**:
| 阶段 | 耗时 | 
|------|------|
| 后端 ASR 处理 (SenseVoice 热缓存) | **90ms** |
| 前端 poll 等待 (setTimeout 1000ms) | **1000ms** |
| Task API 查询 | 4ms |
| injectText IPC (PowerShell timeout) | **1200ms** |
| React 渲染 | 16ms |
| **端到端总延迟** | **~2.4s** |

**根因**:
1. [recordingService.ts:300](frontend/desktop/src/services/recordingService.ts) — `setTimeout(resolve, 1000)` 无论同步还是异步都等待 1 秒
2. [main.ts:1027](frontend/desktop/electron/main.ts) — `injectText()` PowerShell helper 有 1200ms 超时
3. [asr_task.py:277](backend/app/tasks/asr_task.py) — Celery worker 只更新 DB，不发 WebSocket 通知
4. **后端 90ms 完成 → 前端 2.4s 才看到**，**2.3s 是前端浪费**

**修复建议**:
- 同步请求（<60s音频）：直接用 HTTP response 中的结果，不走 poll
- 异步请求：poll 间隔从 1000ms 降到 250ms，或用 WebSocket 推送
- injectText 超时从 1200ms 降到 300ms

---

### 🚨 Bug 1: TTS→ASR→TTS 收音阶段问题

**根因** (代码审计):
1. [audio.ts:128](frontend/desktop/src/services/audio.ts) — `stop()` 内 `setTimeout(finishStop, 1800)` **始终触发**，即使 MediaRecorder.onstop 在 50ms 内完成
2. [audio.ts:53](frontend/desktop/src/services/audio.ts) — `prepare()` 内硬编码 `await setTimeout(350)` 用于噪声抑制沉降
3. VoiceChangerPage 和 recordingService 使用**两个独立的 AudioRecorder 实例**，无互斥守卫 → 可同时抢占麦克风
4. [VoiceChanger.tsx:539](frontend/desktop/src/pages/VoiceChanger.tsx) — 缺少 `blob.size < 800` 守卫（WebM 空容器 100-700 字节会导致 ASR 幻觉）

**录制周期开销**: prepare(350ms) + stop(1800ms) + getUserMedia(200ms) = **最坏 2350ms**

**修复建议**:
- stop() 中：onstop 触发时立即 `clearTimeout`，不要等 1800ms 超时
- prepare() 中：350ms 降到 100ms，或条件化（仅在检测到噪声时启用）
- 统一录音器实例，加互斥锁
- VoiceChanger 加 blob.size < 800 守卫

---

### API 层面 BUG

#### 🚨 BUG-3: Records 端点并发崩溃 (严重)

- **症状**: 5 并发 records 查询，延迟从 150ms 暴增到 12,759ms (**82x 退化**)
- **根因**: `list_archived_records` 每次请求遍历 6800+ 文件目录树。多线程同时 `os.walk` 导致 I/O 争用
- **影响**: 多用户同时查归档记录时系统几乎不可用
- **复现**: `5 并发 GET /v1/records`
- **建议**: 使用数据库索引替代文件系统遍历；或添加缓存层；或限制并发查询数

#### 🚨 BUG-4: ASR 模型串行化瓶颈 (严重)

- **症状**: 20 并发转写用户，p95 延迟 8.6s（6x 退化）
- **根因**: SenseVoice 模型单 GPU，请求排队串行处理
- **影响**: 高并发转写场景延迟不可接受
- **建议**: 批处理推理（batch inference）；或多 worker 多 GPU；或异步队列 + 轮询模式

#### ❌ BUG-5: 无效引擎静默 fallback (中等)

- **症状**: `engine=nonexistent_engine_xyz` 被接受，静默回退到 sensevoice
- **预期**: 返回 422 Validation Error
- **影响**: 用户不知道自己的引擎选择被忽略
- **位置**: transcribe API handler 未校验 engine 是否在可用引擎列表中

#### ❌ BUG-6: 不存在的 skill 返回 404 而非 200+fail (中等)

- **症状**: `skill=skill_that_does_not_exist` 返回 404
- **预期**: 返回 200 + `{"success": false, "error": "Unknown skill"}`
- **影响**: 客户端难以区分 "skill 不存在" vs "API 路由不存在"
- **位置**: skills/execute handler 应先查 skill 再决定返回码

#### ⚠️ BUG-7: Higgs TTS voices 端点慢 (低)

- **症状**: `/v1/tts/higgs/voices` p95=403ms
- **根因**: 每次都调用远端 Higgs 服务
- **建议**: 添加本地缓存 (TTL 60s)

---

## 四、多用户场景性能矩阵

| 场景 | 5 用户 | 10 用户 | 15 用户 | 20 用户 |
|------|--------|---------|---------|---------|
| **Health Check** | p95=5ms | — | — | — |
| **Skills 执行** | p95=230ms | — | — | — |
| **ASR 转写 p50** | 1.37s | 4.21s | 6.34s | 8.26s |
| **ASR 转写 p95** | 1.40s | 4.26s | 6.50s | 8.61s |
| **ASR 转写 max** | 1.40s | 4.26s | 6.50s | 8.61s |
| **Records 查询** | **12.76s** | 🚨 | 🚨 | 🚨 |
| **混合负载** | 稳定 | 稳定 | — | — |

> **结论**: 系统在 5 用户以下运行平稳。超过 10 用户时 ASR 延迟恶化，Records 查询在多用户下完全崩溃。

---

## 五、建议修复优先级

| 优先级 | 问题 | 位置 | 建议 |
|--------|------|------|------|
| 🔴 P0 | 前端 poll 1000ms 延迟 | recordingService.ts:300 | 同步请求直接用 response；异步降 poll 到 250ms |
| 🔴 P0 | injectText IPC 1200ms 超时 | main.ts:1027 | 缩短超时到 300ms，或改为异步 fire-and-forget |
| 🔴 P0 | Records 并发崩溃 (82x) | records API | 数据库索引替代 os.walk；添加查询缓存 |
| 🔴 P0 | ASR 串行化瓶颈 (6x) | transcribe API | 批处理推理 / 多 GPU worker / 异步队列 |
| 🟡 P1 | stop() 1800ms 超时 | audio.ts:128 | onstop 触发时 clearTimeout |
| 🟡 P1 | prepare() 350ms 延迟 | audio.ts:53 | 降到 100ms 或条件化 |
| 🟡 P1 | 双录音器实例冲突 | VoiceChanger.tsx + recordingService.ts | 统一为单例 + 互斥锁 |
| 🟡 P1 | 无效引擎静默 fallback | transcribe API | 添加引擎名白名单校验 |
| 🟡 P1 | 不存在 skill 返回 404 | skills API | 改为 200 + success=false |
| 🟡 P1 | VoiceChanger 缺 blob 守卫 | VoiceChanger.tsx:539 | 加 blob.size < 800 检测 |
| 🟢 P2 | Higgs voices 缓存 | tts API | 添加 TTL 缓存 |
| 🟢 P2 | GPT-SoVITS 服务自启动 | tts | 添加 health check + auto-restart |

---

## 六、运行命令

```bash
# 单元测试 (259 用例)
.venv/bin/python -m pytest tests/ backend/tests/ -v

# 端到端功能测试 (47 用例)
.venv/bin/python scripts/e2e_live_test.py

# 压力/并发测试 (6 场景)
.venv/bin/python scripts/stress_test.py

# 前端编译检查
cd frontend/desktop && npx tsc --noEmit && npx tsc -p tsconfig.node.json --noEmit && npx vite build

# Runner 全链路 Demo
.venv/bin/python -m runner.demo.text_to_agent_to_tts_demo "分析项目结构"
```
