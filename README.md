# opencode-token-meter

opencode TUI 插件：在右侧 sidebar 常驻显示**输出速度、首 token 延迟、token 用量与缓存命中率**。

```
Speed
  Avg    42.7 tok/s
  TTFT   1.3s
Tokens
  Total  128.4k
  Hit    87.3%
```

## 指标说明

| 指标 | 含义 |
| --- | --- |
| `Avg` | 最近 10 轮已完成输出的解码速度平均值（tok/s），采用算术平均 |
| `TTFT` | 最近 10 轮首 token 延迟平均值（秒）；parts 时间戳不可用时隐藏 |
| `Total` | 本次会话 token 总量：`input + output + reasoning + cache.read + cache.write` |
| `Hit` | 缓存命中率 `cache.read ÷ (input + cache.read)`；无缓存数据时整行隐藏 |

口径细节：

- **解码速度** = 输出 token ÷ 实际解码耗时，**首 token 延迟不计入分母**。
- `reasoning` token 计入输出。
- 首 token 时刻取自该消息首个 `text` / `reasoning` part 的 `time.start`。
- 当 part 时间戳缺失（历史会话、压缩后、上游不回传 usage 等）时回退粗口径 `completed - created`，并在内部标记 `approx`。
- 进行中的轮次（无 `time.completed`）不计入统计。

## 安装

插件本体只有 `tui.tsx` 一个文件，无需构建。

### 1. 放置文件

```bash
git clone https://github.com/CaldowL/opencode-token-meter.git ~/.config/opencode/token-meter
```

### 2. 安装依赖

插件依赖 `@opentui/solid` 与 `solid-js`：

```bash
cd ~/.config/opencode/token-meter && npm install
```

### 3. 注册插件

编辑 `~/.config/opencode/tui.json`：

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["file:///root/.config/opencode/token-meter/tui.tsx"]
}
```

路径需写成绝对路径的 `file://` URL（Windows 下形如 `file:///C:/Users/you/...`）。

### 4. 重启 opencode

sidebar 会出现 `Speed` / `Tokens` 两个区块，点击标题行可折叠/展开，折叠状态会记住。

## 行为特性

- 数据全部来自 `api.state` 的响应式数据，**不使用事件监听、定时器或磁盘持久化**。
- 区块 `order` 为 `350`，紧跟内置 LSP 区块之后（内置区块：context=100 / mcp=200 / lsp=300 / todo=400 / files=500）。
- 折叠状态通过 `api.kv` 持久化，key 前缀 `token-meter.expanded.`。
- token 计数自动缩写为 `k` / `M`，避免 sidebar 换行。

## 兼容性

针对 opencode 的 TUI 插件 API（`@opencode-ai/plugin/tui`、`@opencode-ai/sdk/v2`）编写。opencode 升级后若 TUI 插件 API 变更，可能需要同步调整。

## License

MIT
