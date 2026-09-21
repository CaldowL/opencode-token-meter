/** @jsxImportSource @opentui/solid */
/**
 * opencode 输出速度面板（token-meter）
 *
 * 在右侧 sidebar 常驻显示：
 *   Avg(10)  最近 10 轮已完成输出的解码速度平均值（tok/s）
 *   TTFT     最近 10 轮首 token 延迟平均值（秒）
 *   Total    本次会话总 token 用量
 *   Hit      缓存命中率（仅当存在缓存数据时显示）
 *
 * 数据全部来自 api.state（响应式），无需事件监听 / 定时器 / 持久化。
 * 样式对齐宿主内置 sidebar 区块（Context / LSP 等）：加粗标题 + 可点击折叠箭头。
 */
import { createMemo, createSignal, Show, type JSX } from "solid-js"
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"

/** 速度 / TTFT 的滚动窗口大小 */
const WINDOW = 10

/** 内置区块 order：context=100, mcp=200, lsp=300, todo=400, files=500；350 → 紧跟 LSP 之后 */
const ORDER = 350

type Round = {
  /** 轮次完成时间（用于排序取窗口） */
  completed: number
  /** 解码速度 tok/s（TTFT 不进分母） */
  speed: number
  /** 首 token 延迟（秒）；parts 时间戳缺失时为 undefined */
  ttft?: number
  /** 是否使用了粗口径回退（completed - created 作分母）；当前仅统计，不作展示 */
  approx: boolean
}

type Stats = {
  rounds: number
  avgSpeed?: number
  avgTtft?: number
  approx: boolean
  total: number
  /** 0 表示无缓存数据（整行隐藏） */
  cacheRead: number
  hit?: number
}

function isAssistant(m: Message): m is AssistantMessage {
  return m.role === "assistant"
}

/** 该消息第一个内容 part（text / reasoning）的开始时间，即首 token 到达时刻 */
function firstContentStart(api: TuiPluginApi, messageID: string): number | undefined {
  let start: number | undefined
  for (const part of api.state.part(messageID) ?? []) {
    if (part.type !== "text" && part.type !== "reasoning") continue
    const s = part.time?.start
    if (typeof s === "number" && (start === undefined || s < start)) start = s
  }
  return start
}

function collect(api: TuiPluginApi, sessionID: string): Stats {
  const messages = api.state.session.messages(sessionID) ?? []
  const rounds: Round[] = []
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  let cacheWrite = 0

  for (const m of messages) {
    if (!isAssistant(m)) continue
    const t = m.tokens
    if (t) {
      input += t.input || 0
      output += t.output || 0
      reasoning += t.reasoning || 0
      cacheRead += t.cache?.read || 0
      cacheWrite += t.cache?.write || 0
    }

    // 轮次认定：带完成时间戳；进行中的轮次不计入（token 完成时才写入）
    const created = m.time?.created
    const completed = m.time?.completed
    if (!created || !completed || completed <= created) continue
    const out = (t?.output || 0) + (t?.reasoning || 0) // reasoning 计入输出
    if (out <= 0) continue // 异常防护：中转不回传 usage 时跳过该轮

    const start = firstContentStart(api, m.id)
    if (start !== undefined && completed > start) {
      // 精确口径：output ÷ 实际解码时间（TTFT 不进分母）
      const decodeSec = (completed - start) / 1000
      if (decodeSec <= 0) continue
      rounds.push({
        completed,
        speed: out / decodeSec,
        ttft: Math.max(0, (start - created) / 1000),
        approx: false,
      })
    } else {
      // 回退粗口径：parts 时间戳不可用（历史会话 / 压缩后 / 版本差异）
      const decodeSec = (completed - created) / 1000
      if (decodeSec <= 0) continue
      rounds.push({ completed, speed: out / decodeSec, approx: true })
    }
  }

  // 窗口：按完成时间排序取最近 10 轮；不足 10 轮用实际数量
  rounds.sort((a, b) => a.completed - b.completed)
  const recent = rounds.slice(-WINDOW)

  let avgSpeed: number | undefined
  let avgTtft: number | undefined
  if (recent.length > 0) {
    // 算术平均（§4.2）
    avgSpeed = recent.reduce((s, r) => s + r.speed, 0) / recent.length
    const ttfts = recent.flatMap((r) => (r.ttft === undefined ? [] : [r.ttft]))
    if (ttfts.length > 0) avgTtft = ttfts.reduce((s, v) => s + v, 0) / ttfts.length
  }

  // Total：五项之和——真实处理的 token 总量
  const total = input + output + reasoning + cacheRead + cacheWrite

  // Hit：cache.read ÷ (input + cache.read)——Anthropic prompt caching 标准口径；
  // cache.write 是首次写入不算命中。完全没有缓存数据时不显示该行。
  const hit = cacheRead > 0 && input + cacheRead > 0 ? cacheRead / (input + cacheRead) : undefined

  return {
    rounds: recent.length,
    avgSpeed,
    avgTtft,
    approx: recent.some((r) => r.approx),
    total,
    cacheRead,
    hit,
  }
}

/** token 计数缩写：128.4k / 1.25M，防止 sidebar 换行 */
function fmtCount(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k"
  return (n / 1_000_000).toFixed(2) + "M"
}

/** 标签等宽补齐（纯 ASCII，终端单宽） */
function label(s: string): string {
  return s.padEnd(7, " ")
}

/** 折叠状态持久化 key 前缀 */
const KV_PREFIX = "token-meter.expanded."

/** 与宿主内置区块一致的区块头：▼/▶ 箭头 + 加粗标题，点击标题行折叠/展开 */
function Section(props: {
  api: TuiPluginApi
  id: string
  title: string
  children: JSX.Element
}) {
  const theme = () => props.api.theme.current
  // Solid 信号 + kv 持久化（宿主内置区块用内存信号；这里顺带记住用户选择）
  const [open, setOpen] = createSignal(props.api.kv.get<boolean>(KV_PREFIX + props.id, true))
  const toggle = () => {
    const next = !open()
    setOpen(next)
    props.api.kv.set(KV_PREFIX + props.id, next)
  }

  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseDown={toggle}>
        <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        <text fg={theme().text}>
          <b>{props.title}</b>
        </text>
      </box>
      <Show when={open()}>{props.children}</Show>
    </box>
  )
}

function Panel(props: { api: TuiPluginApi; sessionID: string }) {
  const stats = createMemo(() => collect(props.api, props.sessionID))
  const theme = () => props.api.theme.current

  const speedText = () => {
    const s = stats()
    if (s.avgSpeed === undefined) return "--"
    return s.avgSpeed.toFixed(1) + " tok/s"
  }
  const ttftText = () => {
    const s = stats()
    if (s.avgTtft === undefined) return "--"
    return s.avgTtft.toFixed(1) + "s"
  }

  return (
    <box flexDirection="column" gap={1}>
      <Section api={props.api} id="speed" title="Speed">
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>{label("Avg")}</text>
          <text fg={theme().success}>{speedText()}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>{label("TTFT")}</text>
          <text fg={theme().success}>{ttftText()}</text>
        </box>
      </Section>
      <Section api={props.api} id="tokens" title="Tokens">
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>{label("Total")}</text>
          <text fg={theme().success}>{fmtCount(stats().total)}</text>
        </box>
        <Show when={stats().hit !== undefined}>
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>{label("Hit")}</text>
            <text fg={theme().success}>{((stats().hit ?? 0) * 100).toFixed(1) + "%"}</text>
          </box>
        </Show>
      </Section>
    </box>
  )
}

const plugin: TuiPluginModule = {
  id: "token-meter",
  tui: async (api) => {
    api.slots.register({
      order: ORDER,
      slots: {
        sidebar_content: (_ctx, props) => <Panel api={api} sessionID={props.session_id} />,
      },
    })
  },
}

export default plugin
