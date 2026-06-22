# 多模型加载、开机启动、托盘图标与 UI 优化

## Context

当前 Amadeus 桌面端存在多个待修复问题：模型并发加载可能触发 GPU OOM、缺少开机自启、托盘图标未使用品牌图片、部分 UI 文案过时、通路测试交互不合理。

## 目标

1. 模型加载增加并发限制与 GPU 内存保护
2. 开机自动启动设置与功能
3. 右下角托盘图标使用品牌图片
4. 应用 logo/icon 统一替换为 amadeus.jpg
5. 删除过时的"智能语音工作台""智能语音助手"文案
6. Sidebar 品牌区音频波形图标替换为 amadeus.jpg
7. 通路测试改为持续监听、toggle 式交互（去掉独立停止键和时间限制）

## 改动范围

### 1. 后端 — 模型并发加载保护

**文件**: `backend/app/core/model_manager.py`

- 新增 `_global_load_semaphore = asyncio.Semaphore(1)` 全局信号量
- `_load_engine()` 内用 `async with _global_load_semaphore` 包裹实际加载
- 加载前尝试调用 `torch.cuda.empty_cache()` 清理碎片（若 cuda 可用）
- 加载时捕获 CUDA OOM 错误并抛 `ModelRuntimeError` 含清晰建议（尝试先卸载其他模型）
- `hot_swap` 同样走信号量
- 新增 `get_gpu_memory_info()` 辅助方法用于前端展示

**文件**: `backend/app/core/model_errors.py`

- 扩展 `classify_model_error` 以识别 CUDA OOM 错误并给出中文建议

### 2. 前端 — 开机自动启动

**文件**: `frontend/desktop/src/store/useASRStore.ts`

- Settings 新增 `autoLaunchEnabled: boolean` 字段，默认 `false`
- `normalizeSettings` 中保留该字段

**文件**: `frontend/desktop/src/pages/Settings.tsx`

- 新增 checkbox: "开机自动启动 Amadeus"
- `onChange` 调用 `window.electronAPI?.setAutoLaunch(enabled)`

**文件**: `frontend/desktop/electron/main.ts`

- 新增 IPC handler `app:autoLaunch:get` / `app:autoLaunch:set`
- 使用 `app.setLoginItemSettings({ openAtLogin })` 实现

**文件**: `frontend/desktop/electron/preload.ts`

- 暴露 `getAutoLaunch` / `setAutoLaunch`

### 3. 托盘图标优化

**文件**: `frontend/desktop/electron/main.ts`

- `createTray()` 中 `new Tray(iconPath)` 改为使用项目内的 `img/Amadeus/amadeus.jpg`
- 需要将 jpg 转为 NativeImage 或使用 `.ico`/`.png` 格式
- 简单方案：用 `nativeImage.createFromPath()` 从绝对路径加载

### 4. 应用 Logo 替换

**文件**: `frontend/desktop/electron-builder.yml`

- 确认 productName 已是 Amadeus

**文件**: `frontend/desktop/electron/main.ts`

- `BrowserWindow` 构造中增加 `icon` 属性指向 amadeus.jpg

**文件**: `frontend/desktop/index.html`

- 可选：添加 favicon link

### 5. 删除过时文案

**文件**: `frontend/desktop/src/components/TitleBar.tsx`

- 删除 `<span>智能语音工作台</span>`

**文件**: `frontend/desktop/src/components/Sidebar.tsx`

- 删除 `<small>智能语音助手</small>`
- 将 `<strong>Amadeus</strong>` 下方的 small 替换为空或品牌口号

### 6. Sidebar 品牌图标替换

**文件**: `frontend/desktop/src/components/Sidebar.tsx`

- `brand-mark` div 替换为 `<img>` 标签，src 指向 `img/Amadeus/amadeus.jpg`
- 调整 CSS 保持布局

### 7. 通路测试交互改造

**文件**: `frontend/desktop/src/pages/Settings.tsx`

- 删除单独的"停止"按钮
- "开始监听 5 秒" → "开始监听"（toggle 模式）
- 点击后 `monitoring=true`，按钮文字变为"停止监听"
- 再次点击调用 `stopMonitor()`，`monitoring=false`
- `audioRelayMixer.startMonitor()` 不再传 timeout，改为手动停止
- 更新说明文字

**文件**: `frontend/desktop/src/services/audio.ts`

- `startMonitor()` 改为不强制 timeout：`durationMs = 0` 时不设 setTimeout
- `stopMonitor()` 在 `startMonitor` 的 Promise resolve 逻辑中由调用方控制

## 风险

- GPU OOM 保护依赖 `torch.cuda` 可用性；CPU-only 场景不受影响
- 托盘图标需要图片格式兼容（.jpg 在 Windows tray 可能不理想，可用 nativeImage 缩放）
- 通路测试改为无限监听后，用户需记得手动停止（UI 已提示）

## 验证方式

1. 后端: `cd backend && python -m pytest tests/test_model_errors.py -v`
2. 前端: `cd frontend/desktop && npx tsc --noEmit`
3. 构建: `cd frontend/desktop && npm run build`
4. 实机验证: 多模型并发加载不会 OOM、开机自启生效、托盘图标正确、通路测试 toggle 正常
