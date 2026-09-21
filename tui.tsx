/** @jsxImportSource @opentui/solid */
/**
 * opencode 输出速度面板（token-meter）
 *
 * 在右侧 sidebar 常驻显示：
 *   Avg    最近 10 轮已完成输出的解码速度平均值（tok/s）
 *   TTFT   最近 10 轮首 token 延迟平均值（秒）
 *   Total  本次会话总 token 用量
 *   Hit    缓存命中率（仅当存在缓存数据时显示）
 *
 * 统计范围：当前会话 + 其全部子孙子代理（subagent）会话，按轮次完成时间合并排序。
 * 主会话数据走 api.state（响应式）；子会话经 api.client 拉取，
 * 由 session.created / session.idle 事件驱动刷新，无定时轮询、无持久化。
 * 样式对齐宿主内置 sidebar 区块（Context / LSP 等）：加粗标题 + 可点击折叠箭头。
 */
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js"
import type { TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Message, Part } from "@opencode-ai/sdk/v2"

/** 速度 / TTFT 的滚动窗口大小 */
const WINDOW = 10

/** 内置区块 order：context=100, mcp=200, lsp=300, todo=400, files=500；350 → 紧跟 LSP 之后 */
const ORDER = 350

/** 子会话嵌套深度上限（子代理再开子代理） */
const MAX_DEPTH = 5

/** 子会话刷新防抖（session.idle / session.created 事件可能密集） */
const REFRESH_DEBOUNCE_MS = 400

/** 结构化日志：写入 opencode 日志（~/.local/share/opencode/log/opencode.log），用于排查子代理数据链路 */
function log(api: TuiPluginApi, level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) {
  try {
    // 注意：api.client 是 @opencode-ai/sdk/v2 客户端，参数为扁平结构（非 v1 的 { body }）
    void api.client.app.log({ service: "token-meter", level, message, extra }).catch(() => {})
  } catch {}
}

type Round = {
  /** 轮次完成时间（用于排序取窗口） */
  completed: number
  /** 解码速度 tok/s（TTFT 不进分母） */
  speed: number
  /** 首 token 延迟（秒）；parts 时间戳缺失时为 undefined */
  ttft?: number
}

type TokenSums = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

type SessionSlice = {
  rounds: Round[]
  tokens: TokenSums
}

type Stats = {
  rounds: number
  avgSpeed?: number
  avgTtft?: number
  total: number
  /** 0 表示无缓存数据（整行隐藏） */
  cacheRead: number
  hit?: number
}

/** 子会话消息缓存：sessionID → 服务端原始 { info, parts } 列表 */
type ChildMessages = Record<string, { info: Message; parts: Part[] }[]>

/** 子会话元信息（标题用于面板展示） */
type ChildSession = { id: string; title: string }

function isAssistant(m: Message): m is AssistantMessage {
  return m.role === "assistant"
}

/** 该消息第一个内容 part（text / reasoning）的开始时间，即首 token 到达时刻 */
function firstContentStart(parts: readonly Part[] | undefined): number | undefined {
  let start: number | undefined
  for (const part of parts ?? []) {
    if (part.type !== "text" && part.type !== "reasoning") continue
    const s = part.time?.start
    if (typeof s === "number" && (start === undefined || s < start)) start = s
  }
  return start
}

/** 单会话统计切片：速度轮次 + token 五项累计（主会话与子会话共用同一逻辑） */
function collectSlice(
  messages: readonly Message[],
  partsOf: (messageID: string) => readonly Part[] | undefined,
): SessionSlice {
  const rounds: Round[] = []
  const tokens: TokenSums = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

  for (const m of messages) {
    if (!isAssistant(m)) continue
    const t = m.tokens
    if (t) {
      tokens.input += t.input || 0
      tokens.output += t.output || 0
      tokens.reasoning += t.reasoning || 0
      tokens.cacheRead += t.cache?.read || 0
      tokens.cacheWrite += t.cache?.write || 0
    }

    // 轮次认定：带完成时间戳；进行中的轮次不计入（token 完成时才写入）
    const created = m.time?.created
    const completed = m.time?.completed
    if (!created || !completed || completed <= created) continue
    const out = (t?.output || 0) + (t?.reasoning || 0) // reasoning 计入输出
    if (out <= 0) continue // 异常防护：中转不回传 usage 时跳过该轮

    const start = firstContentStart(partsOf(m.id))
    // 精确口径：output ÷ 实际解码时间（TTFT 不进分母）；
    // parts 时间戳不可用（历史会话 / 压缩后 / 版本差异）时回退粗口径 completed - created
    const decodeSec = (start !== undefined && completed > start ? completed - start : completed - created) / 1000
    if (decodeSec <= 0) continue
    rounds.push({
      completed,
      speed: out / decodeSec,
      ttft: start !== undefined && completed > start ? Math.max(0, (start - created) / 1000) : undefined,
    })
  }

  return { rounds, tokens }
}

/** 汇总统计：主会话 + 全部子会话合并，或单个子会话独立计算（复用同一口径） */
function mergeStats(slices: SessionSlice[]): Stats {
  const allRounds = slices.flatMap((s) => s.rounds)
  // 窗口：跨会话按完成时间排序取最近 10 轮；不足 10 轮用实际数量
  allRounds.sort((a, b) => a.completed - b.completed)
  const recent = allRounds.slice(-WINDOW)

  let avgSpeed: number | undefined
  let avgTtft: number | undefined
  if (recent.length > 0) {
    // 算术平均（§4.2）
    avgSpeed = recent.reduce((s, r) => s + r.speed, 0) / recent.length
    const ttfts = recent.flatMap((r) => (r.ttft === undefined ? [] : [r.ttft]))
    if (ttfts.length > 0) avgTtft = ttfts.reduce((s, v) => s + v, 0) / ttfts.length
  }

  const tokens = slices.reduce<TokenSums>(
    (acc, s) => ({
      input: acc.input + s.tokens.input,
      output: acc.output + s.tokens.output,
      reasoning: acc.reasoning + s.tokens.reasoning,
      cacheRead: acc.cacheRead + s.tokens.cacheRead,
      cacheWrite: acc.cacheWrite + s.tokens.cacheWrite,
    }),
    { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  )

  // Total：五项之和——真实处理的 token 总量
  const total = tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite

  // Hit：cache.read ÷ (input + cache.read)——Anthropic prompt caching 标准口径；
  // cache.write 是首次写入不算命中。完全没有缓存数据时不显示该行。
  const hit =
    tokens.cacheRead > 0 && tokens.input + tokens.cacheRead > 0
      ? tokens.cacheRead / (tokens.input + tokens.cacheRead)
      : undefined

  return { rounds: recent.length, avgSpeed, avgTtft, total, cacheRead: tokens.cacheRead, hit }
}

/** 递归收集子孙会话（含嵌套子代理），深度封顶 MAX_DEPTH */
async function collectDescendants(api: TuiPluginApi, rootID: string): Promise<ChildSession[]> {
  const result: ChildSession[] = []
  const walk = async (id: string, depth: number) => {
    if (depth > MAX_DEPTH) return
    let children: { id: string; title?: string }[] = []
    try {
      // v2 客户端：扁平参数；HTTP 错误不抛异常而是放进 res.error
      const res = await api.client.session.children({ sessionID: id })
      if (res.error) throw new Error(typeof res.error === "string" ? res.error : JSON.stringify(res.error))
      children = (res.data ?? []) as { id: string; title?: string }[]
    } catch (err) {
      log(api, "warn", "session.children failed", { id, error: err instanceof Error ? err.message : String(err) })
      return // 会话不存在或请求失败：跳过该分支
    }
    for (const child of children) {
      result.push({ id: child.id, title: (child.title ?? "").replace(/\s+/g, " ").trim() })
      await walk(child.id, depth + 1)
    }
  }
  await walk(rootID, 1)
  return result
}

/** 拉取一个子会话的全部消息（含 parts：可算精确 TTFT / 解码速度） */
async function fetchMessages(api: TuiPluginApi, sessionID: string): Promise<{ info: Message; parts: Part[] }[]> {
  try {
    const res = await api.client.session.messages({ sessionID })
    if (res.error) throw new Error(typeof res.error === "string" ? res.error : JSON.stringify(res.error))
    return (res.data ?? []) as { info: Message; parts: Part[] }[]
  } catch (err) {
    log(api, "warn", "session.messages failed", { id: sessionID, error: err instanceof Error ? err.message : String(err) })
    return []
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

function fmtSpeed(s: Stats): string {
  return s.avgSpeed === undefined ? "--" : s.avgSpeed.toFixed(1) + " tok/s"
}

function fmtTtft(s: Stats): string {
  return s.avgTtft === undefined ? "--" : s.avgTtft.toFixed(1) + "s"
}

/** 子代理标题截断，防止 sidebar 换行 */
function truncate(s: string, max = 24): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…"
}

/** 折叠状态持久化 key 前缀 */
const KV_PREFIX = "token-meter.expanded."

/** 与宿主内置区块一致的区块头：▼/▶ 箭头 + 加粗标题，点击标题行折叠/展开 */
function Section(props: {
  api: TuiPluginApi
  id: string
  title: string
  /** 标题是否加粗（顶级区块加粗；子代理条目用普通体区分层级） */
  strong?: boolean
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
        <text fg={theme().text}>{props.strong === false ? props.title : <b>{props.title}</b>}</text>
      </box>
      <Show when={open()}>{props.children}</Show>
    </box>
  )
}

function Panel(props: { api: TuiPluginApi; sessionID: string }) {
  const theme = () => props.api.theme.current

  // ── 子代理会话数据（非响应式来源，事件驱动拉取）─────────────────────────
  const [childSessions, setChildSessions] = createSignal<ChildSession[]>([])
  const [childMessages, setChildMessages] = createSignal<ChildMessages>({})
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let refreshSeq = 0

  const refreshChildren = async () => {
    const rootID = props.sessionID
    if (!rootID) {
      setChildSessions([])
      setChildMessages({})
      return
    }
    const seq = ++refreshSeq
    const sessions = await collectDescendants(props.api, rootID)
    if (seq !== refreshSeq || rootID !== props.sessionID) return // 已被更新的请求取代
    log(props.api, "info", "descendants", { sessionID: rootID, count: sessions.length, ids: sessions.map((s) => s.id) })
    if (sessions.length === 0) {
      setChildSessions([])
      setChildMessages({})
      return
    }
    const entries = await Promise.all(sessions.map(async (s) => [s.id, await fetchMessages(props.api, s.id)] as const))
    if (seq !== refreshSeq || rootID !== props.sessionID) return
    setChildSessions(sessions)
    setChildMessages(Object.fromEntries(entries))
    log(props.api, "info", "children loaded", { sessionID: rootID, count: sessions.length })
  }

  const scheduleRefresh = () => {
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined
      void refreshChildren()
    }, REFRESH_DEBOUNCE_MS)
  }

  // 会话切换：清空并重拉
  createEffect(
    on(
      () => props.sessionID,
      () => {
        setChildSessions([])
        setChildMessages({})
        scheduleRefresh()
      },
    ),
  )

  // 新子代理诞生 / 任意会话跑完一轮 → 防抖刷新（token 在完成时才写入，idle 时机正好）
  const offCreated = props.api.event.on("session.created", (e) => {
    log(props.api, "info", "event session.created", { id: (e.properties as { info?: { id?: string } })?.info?.id })
    scheduleRefresh()
  })
  const offIdle = props.api.event.on("session.idle", (e) => {
    log(props.api, "info", "event session.idle", { id: (e.properties as { sessionID?: string })?.sessionID })
    scheduleRefresh()
  })
  onCleanup(() => {
    offCreated()
    offIdle()
    if (refreshTimer !== undefined) clearTimeout(refreshTimer)
  })

  // ── 汇总统计 ────────────────────────────────────────────────────────────
  const stats = createMemo<Stats>(() => {
    const sid = props.sessionID
    const main = collectSlice(props.api.state.session.messages(sid) ?? [], (id) => props.api.state.part(id))
    const children = Object.values(childMessages()).map((list) => {
      const partsMap = new Map(list.map((m) => [m.info.id, m.parts] as const))
      return collectSlice(
        list.map((m) => m.info),
        (messageID) => partsMap.get(messageID),
      )
    })
    return mergeStats([main, ...children])
  })

  // ── 每个子代理的独立统计（最近活动排序，最新在前）─────────────────────────
  const agents = createMemo(() => {
    const msgs = childMessages()
    return childSessions()
      .map((s) => {
        const list = msgs[s.id] ?? []
        const partsMap = new Map(list.map((m) => [m.info.id, m.parts] as const))
        const slice = collectSlice(
          list.map((m) => m.info),
          (messageID) => partsMap.get(messageID),
        )
        const lastCompleted = slice.rounds.reduce((max, r) => Math.max(max, r.completed), 0)
        return { id: s.id, title: s.title || s.id.slice(0, 12), stats: mergeStats([slice]), lastCompleted }
      })
      .sort((a, b) => b.lastCompleted - a.lastCompleted)
  })

  return (
    <box flexDirection="column" gap={1}>
      <Section api={props.api} id="speed" title="Speed">
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>{label("Avg")}</text>
          <text fg={theme().success}>{fmtSpeed(stats())}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>{label("TTFT")}</text>
          <text fg={theme().success}>{fmtTtft(stats())}</text>
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
      <Show when={agents().length > 0}>
        <Section api={props.api} id="agents" title={"Agents (" + agents().length + ")"}>
          {/* 子代理区块整体右缩进，体现层级归属 */}
          <box flexDirection="column" gap={1} paddingLeft={2}>
            <For each={agents()}>
              {(a) => (
                <Section api={props.api} id={"agent." + a.id} title={truncate(a.title)} strong={false}>
                  <box flexDirection="row" gap={1}>
                    <text fg={theme().textMuted}>{label("Avg")}</text>
                    <text fg={theme().success}>{fmtSpeed(a.stats)}</text>
                  </box>
                  <box flexDirection="row" gap={1}>
                    <text fg={theme().textMuted}>{label("TTFT")}</text>
                    <text fg={theme().success}>{fmtTtft(a.stats)}</text>
                  </box>
                  <box flexDirection="row" gap={1}>
                    <text fg={theme().textMuted}>{label("Total")}</text>
                    <text fg={theme().success}>{fmtCount(a.stats.total)}</text>
                  </box>
                  <Show when={a.stats.hit !== undefined}>
                    <box flexDirection="row" gap={1}>
                      <text fg={theme().textMuted}>{label("Hit")}</text>
                      <text fg={theme().success}>{((a.stats.hit ?? 0) * 100).toFixed(1) + "%"}</text>
                    </box>
                  </Show>
                </Section>
              )}
            </For>
          </box>
        </Section>
      </Show>
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
