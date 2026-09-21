# opencode-token-meter

opencode TUI 插件：在右侧 sidebar 常驻显示**输出速度、首 token 延迟、token 用量与缓存命中率**，并可按子代理（subagent）拆分查看。

```
Speed
  Avg    42.7 tok/s
  TTFT   1.3s
Tokens
  Total  128.4k
  Hit    87.3%
Agents (2)
    build
      Avg    38.1 tok/s
      TTFT   1.6s
      Total  12.7k
    explore
      Avg    55.4 tok/s
      TTFT   0.9s
      Total  8.3k
```

## 指标说明

| 指标 | 含义 |
| --- | --- |
| `Avg` | 最近 10 轮已完成输出的解码速度平均值（tok/s），采用算术平均 |
| `TTFT` | 最近 10 轮首 token 延迟平均值（秒）；parts 时间戳不可用时隐藏 |
| `Total` | token 总量：`input + output + reasoning + cache.read + cache.write` |
| `Hit` | 缓存命中率 `cache.read ÷ (input + cache.read)`；无缓存数据时整行隐藏 |

区块：

- **Speed** / **Tokens**：当前会话 **及其全部子孙代理会话** 的合并统计。
- **Agents (N)**：仅在存在子代理时显示；每个子代理一个可折叠条目（标题为其会话标题，超长截断），展示该子代理**独立**的 `Avg` / `TTFT` / `Total` / `Hit`，按最近活动时间倒序排列。

口径细节：

- **解码速度** = 输出 token ÷ 实际解码耗时，**首 token 延迟不计入分母**。
- `reasoning` token 计入输出。
- 首 token 时刻取自该消息首个 `text` / `reasoning` part 的 `time.start`。
- 当 part 时间戳缺失（历史会话、压缩后、上游不回传 usage 等）时回退粗口径 `completed - created`。
- 进行中的轮次（无 `time.completed`）不计入统计。
- 合并统计时，主会话与各子会话的轮次按**完成时间统一排序**后再取最近 10 轮，而非各自取窗口再平均。
- 子代理条目之间不做聚合，各自独立计算。

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

sidebar 会出现 `Speed` / `Tokens`（有子代理时再加 `Agents`）区块，点击标题行可折叠/展开，折叠状态会记住。

## 行为特性

- 主会话数据来自 `api.state`（响应式，无需额外请求）。
- 子代理数据是**非响应式来源**：通过 `api.client.session.children` 递归发现子孙会话、`api.client.session.messages` 拉取消息与 parts。
- 刷新由 `session.created` / `session.idle` 事件驱动，并做 400ms 防抖；事件密集时不会重复拉取。**无定时轮询**。
- 并发刷新用递增序号（seq）守卫，过期响应直接丢弃；会话切换时清空重拉。
- 递归发现子会话深度上限 5 层。
- 子代理数据拉取失败只记日志、不中断渲染（HTTP 错误在 SDK v2 中走 `res.error` 而非抛异常）。
- 区块 `order` 为 `350`，紧跟内置 LSP 区块之后（内置区块：context=100 / mcp=200 / lsp=300 / todo=400 / files=500）。
- 折叠状态通过 `api.kv` 持久化，key 前缀 `token-meter.expanded.`。
- token 计数自动缩写为 `k` / `M`，避免 sidebar 换行。

## 排查

插件通过 `api.client.app.log` 向 opencode 日志写入结构化记录，`service` 为 `token-meter`，可用于排查子代理数据链路：

```bash
tail -f ~/.local/share/opencode/log/opencode.log | grep token-meter
```

包含 `descendants`（发现的子会话）、`children loaded`（拉取完成）、`event session.created` / `event session.idle`（触发刷新）以及拉取失败告警。

## 兼容性

针对 opencode 的 TUI 插件 API（`@opencode-ai/plugin/tui`）与 SDK v2（`@opencode-ai/sdk/v2`）编写。注意 SDK v2 客户端参数为**扁平结构**，与 v1 的 `{ body }` 包装不同；HTTP 错误以 `res.error` 返回。opencode 升级后若 API 变更，可能需要同步调整。

## License

MIT
