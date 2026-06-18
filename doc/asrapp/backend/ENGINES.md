# Backend ASR 引擎管理

> **父文档**: [← 返回 Backend 总览](README.md)
> **子文档**: [ASR 引擎对比](../asr/ENGINES.md) | [流式识别](STREAMING.md)

---

## 引擎注册表

所有引擎在 `core/asr/registry.py` 中注册：

```python
ENGINE_REGISTRY = {
    "fireredasr2": FireRedASR2Config,
    "sensevoice":  SenseVoiceConfig,
    "qwen3asr":    Qwen3ASRConfig,
    "whisper":     WhisperConfig,
}
```

## 模型管理器

`core/model_manager.py` 负责：

- **单例管理**：每个引擎只有一个加载实例
- **懒加载**：首次使用时加载，或启动时预加载 `DEFAULT_ENGINE`
- **热切换**：运行时动态加载/卸载，无需重启
- **状态跟踪**：`is_loaded`、`device`、`compute_type`、`languages`

## API 操作

### 列出引擎状态

```bash
curl http://localhost:8000/v1/models
```

返回：

```json
[
  {
    "engine": "fireredasr2",
    "model_name": "FireRedASR2-AED",
    "is_loaded": true,
    "device": "cuda",
    "languages": ["zh", "en"]
  }
]
```

### 加载引擎

```bash
# Whisper
curl -X POST "http://localhost:8000/v1/models/whisper/load" \
  -H "Content-Type: application/json" \
  -d '{"model_name":"base","device":"cpu","compute_type":"int8"}'

# FireRedASR2
curl -X POST "http://localhost:8000/v1/models/fireredasr2/load" \
  -H "Content-Type: application/json" \
  -d '{"model_name":"FireRedASR2-AED","device":"cuda"}'
```

### 卸载引擎

```bash
curl -X POST "http://localhost:8000/v1/models/fireredasr2/unload"
```

## 路由与合并策略

`core/asr/router.py` 支持单引擎和多引擎联合推理。

| 策略 | 说明 |
|------|------|
| `first` | 取第一个引擎的结果 |
| `vote` | 多引擎投票，选出现最多的文本 |
| `concat` | 拼接所有引擎结果 |

配置方式：`options.merge_strategy` 或 `settings.mergeStrategy`。

## 引擎配置环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DEFAULT_ENGINE` | 默认引擎 | `fireredasr2` |
| `FIREREDASR2_MODEL_DIR` | FireRedASR2 模型路径 | — |
| `DEFAULT_FIREREDASR2_DEVICE` | 设备 | `cuda` |
| `DEFAULT_WHISPER_MODEL` | Whisper 模型大小 | `base` |
| `DEFAULT_WHISPER_DEVICE` | Whisper 设备 | `cuda` |
| `DEFAULT_SENSEVOICE_DEVICE` | SenseVoice 设备 | `cuda:0` |
| `DEFAULT_QWEN3ASR_DEVICE` | Qwen3-ASR 设备 | `cuda:0` |
| `SYNC_MAX_DURATION_SEC` | 同步转写最大时长 | `60` |

---

> 📖 [ASR 引擎横向对比 →](../asr/ENGINES.md) | [流式识别协议 →](STREAMING.md)
