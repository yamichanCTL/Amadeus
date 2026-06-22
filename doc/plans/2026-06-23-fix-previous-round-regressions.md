# 修复上一轮引入的问题 + 新增需求

## Context

上一轮改动引入了几个新问题 + 本轮新增需求：

1. **实时识别 WebSocket 连接超时 (15s)**：`ws:///v1/stream` URL 三斜杠
2. **前端 UI 抑制同时加载多个模型**：`busy` 单字符串阻止并发
3. **模型加载全局信号量反效果**（上一轮遗留）：`_global_load_semaphore(1)` 强制串行加载
4. **托盘/应用图标不显示**（上一轮）
5. **通路监听 toggle 卡死/无效**（上一轮）
6. **需确认上一次修复（虚拟麦克风纯透传）未被破坏**（上一轮）

## 本轮需求

1. 解决实时识别 WebSocket 连接超时 bug（`ws:///v1/stream`）
2. 前端支持同时加载多个模型，加载失败（显存不足等）时正常退出
3. 识别时如果指定模型没加载就自动加载（确认已支持），前后端 X-ASR 默认设置使用 960ms chunk

---

## 问题分析

### 1. 实时识别 WebSocket 连接超时 (15s)

**现象**：
```
WebSocket 连接超时 (15s)。WebSocket 连接失败。已尝试：ws:///v1/stream。
```

**根因**：`audio.ts` 中的 `buildWsUrl()` 函数在 `serverUrl` 为空时使用 `window.location.host` 构建同源 WebSocket URL。在 Electron 环境中，页面通过 `file://` 协议加载，此时 `window.location.host` 为空字符串，导致生成 `ws:///v1/stream`（三斜杠）。

对比 `api.ts` 中的 `normalizeServerUrl()`，该函数已正确处理 `file://`/`app://` 协议并 fallback 到 `http://localhost:8000`。但 `buildWsUrl` 缺少这个 fallback。

**修复**：在 `buildWsUrl()` 中添加与 `normalizeServerUrl()` 一致的 fallback——当协议为 `file://` 或 `app://` 且 serverUrl 为空时，fallback 到 `localhost:8000`。

### 2. 前端 UI 抑制同时加载多个模型

**现象**：Models 页面点击加载一个模型后，`busy` 状态阻止加载其他模型。

**根因**：`Models.tsx` 的 `load()` 函数使用单个 `busy: string` 状态。`if (busy) return` 阻止并发。实际上后端已支持并发加载（per-engine asyncio.Lock）。

**修复**：将 `busy` 改为 `Set<string>`，跟踪正在加载的引擎。加载失败（如 OOM）时显示错误并正常退出，不影响其他模型的加载。

### 3. 自动加载和 960ms chunk 默认

**自动加载**：已支持。后端 `/v1/stream` 端点收到 `config` 消息后调用 `session.prepare()` 自动加载模型。ModelManager 的 `get_engine()` 也支持 lazy loading。无需修改。

**960ms chunk 默认**：当前前端和后端默认使用 `chunk-160ms-model`，改为 `chunk-960ms-model`。

---

## 改动范围

### 1. `frontend/desktop/src/services/audio.ts`

- `buildWsUrl()`：添加 Electron `file://`/`app://` 协议 fallback 到 `localhost:8000`

### 2. `frontend/desktop/src/pages/Models.tsx`

- `busy: string` → `busyEngines: Set<string>`，支持并发加载
- 加载按钮 disabled 条件改为 `busyEngines.has(engine)`
- 加载失败显示具体错误信息

### 3. `frontend/desktop/src/store/useASRStore.ts`

- `DEFAULT_SETTINGS.asrModelConfigs['x-asr'].modelName` → `chunk-960ms-model`

### 4. `frontend/desktop/src/pages/Models.tsx`

- `defaultAsrConfigs['x-asr'].modelName` → `chunk-960ms-model`

### 5. `backend/app/config.py`

- `default_x_asr_model` → `chunk-960ms-model`
- `x_asr_model_dir` 路径更新为 960ms 模型目录

### 6. `backend/app/core/model_manager.py`

- 更新 docstring 移除已废弃的 semaphore 描述

## 验证

1. Electron 环境实时识别 WebSocket 连接成功
2. Models 页面可同时加载多个模型
3. 加载 OOM 时不影响其他已加载模型
4. X-ASR 默认使用 960ms chunk 模型
