# Runner 记忆系统

> **父文档**: [← 返回 Runner 总览](README.md)

---

## 设计

基于 JSONL 文件的轻量记忆系统，**无需数据库**。

## 存储结构

```
.runtime/memory/
├── temporary.jsonl    # 临时记忆（带 TTL，会话级）
├── permanent.jsonl    # 持久记忆（跨会话）
├── agent_runs.jsonl   # Agent 执行记录（经验）
└── timings.jsonl      # 管线耗时记录
```

## 记忆记录格式

```json
{
  "source": "agent_run",
  "timestamp": "2026-06-12T10:30:00",
  "summary": "分析了 asrapp 项目结构，共 23 个模块",
  "metadata": {
    "agent": "claude_code",
    "success": true,
    "duration_sec": 5.2
  },
  "confidence": 0.95,
  "ttl": 3600
}
```

## MemoryManager

- `record_task_result(result)` — 记录 Agent 执行结果
- `add_temporary(entry)` — 写入临时记忆
- `add_permanent(entry)` — 写入持久记忆
- `get_recent(n)` — 获取最近 N 条记忆
- `query(keyword)` — 关键词搜索

## Context Compressor

压缩 Agent 的完整 stdout/stderr 为摘要：

- **截断**：保留前 `max_capture_chars` 字符（默认 20000）
- **规则压缩**：移除 ANSI 颜色码、空行、重复行
- **不依赖 LLM**：纯规则，快速可靠

## 原则

1. 不要把完整 stdout/stderr 无脑塞进长期记忆
2. 长输出必须压缩成摘要
3. 临时记忆保存当前任务结果
4. 永久记忆只保存长期有价值的信息
5. 敏感信息不要自动写入永久记忆

---

> 📖 [编排器 →](ORCHESTRATOR.md) | [技能系统 →](SKILLS.md)
