import { CSSProperties, FormEvent, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ApprovalRequest, ChatMessage, SessionSummary, ServerEvent, TimelineItem, ToolCall, ToolResult } from "@codestate/shared";
import {
  ArrowUp,
  AtSign,
  Bot,
  Check,
  ChevronRight,
  Circle,
  Code,
  FileText,
  Folder,
  History,
  MessageSquarePlus,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  Sparkles,
  Square,
  Sun,
  Terminal,
  Trash2,
  X
} from "lucide-react";
import { cn } from "./lib/utils";

type ProjectState = {
  projectRoot: string;
  model: string;
};

type FileSuggestion = {
  path: string;
  name: string;
};

type ToolItem = { call: ToolCall; result?: ToolResult };

type ActiveFileMention = {
  start: number;
  end: number;
  query: string;
};

type ThemeName = "recode" | "orchid" | "solar" | "glacier" | "forest" | "synth" | "obsidian" | "coral";

const themes: Array<{ name: ThemeName; label: string }> = [
  { name: "recode", label: "Recode" },
  { name: "orchid", label: "Orchid" },
  { name: "solar", label: "Solar" },
  { name: "glacier", label: "Glacier" },
  { name: "forest", label: "Forest" },
  { name: "synth", label: "Synth" },
  { name: "obsidian", label: "Obsidian" },
  { name: "coral", label: "Coral" }
];

export function App() {
  const [project, setProject] = useState<ProjectState | null>(null);
  const [sessionId, setSessionId] = useState<string>(() => crypto.randomUUID());
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [draft, setDraft] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);
  const [yolo, setYolo] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeName>("recode");
  const [mode, setMode] = useState<"dark" | "light">("dark");
  const [search, setSearch] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [fileSuggestions, setFileSuggestions] = useState<FileSuggestion[]>([]);
  const [activeMention, setActiveMention] = useState<ActiveFileMention | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const timelineRef = useRef<HTMLElement | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const projectName = project?.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "Loading project";
  const hasConversation = items.length > 0 || Boolean(streamingText) || busy;
  const activeMentionQuery = activeMention?.query ?? null;

  useEffect(() => {
    if (!hasConversation) return;
    timelineEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [hasConversation, items, streamingText, busy, pendingApproval]);

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then(setProject)
      .catch(() => setProject({ projectRoot: "Unknown project", model: "unknown" }));
  }, []);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data) => {
        const savedSessions = data as SessionSummary[];
        setSessions(savedSessions);
        if (savedSessions[0]) void loadSession(savedSessions[0].id);
      })
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    if (activeMentionQuery === null) {
      setFileSuggestions([]);
      return;
    }

    const controller = new AbortController();
    fetch(`/api/files/search?q=${encodeURIComponent(activeMentionQuery)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { files?: FileSuggestion[] }) => {
        setFileSuggestions(data.files ?? []);
        setMentionIndex(0);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFileSuggestions([]);
      });

    return () => controller.abort();
  }, [activeMentionQuery]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setSettingsOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    const source = new EventSource(`/api/events/${sessionId}`);

    source.addEventListener("message.delta", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as ServerEvent;
      if (data.type === "message.delta") setStreamingText((current) => current + data.content);
    });

    source.addEventListener("message.done", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as ServerEvent;
      if (data.type === "message.done") {
        setItems((current) => [...current, { type: "message", message: data.message }]);
        setStreamingText("");
        setBusy(false);
        refreshSessions();
      }
    });

    source.addEventListener("tool.started", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as ServerEvent;
      if (data.type === "tool.started") setItems((current) => [...current, { type: "tool", call: data.toolCall }]);
    });

    source.addEventListener("tool.output", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as ServerEvent;
      if (data.type !== "tool.output") return;
      setItems((current) =>
        current.map((item) =>
          item.type === "tool" && item.call.id === data.result.callId ? { ...item, result: data.result } : item
        )
      );
    });

    source.addEventListener("approval.requested", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as ServerEvent;
      if (data.type === "approval.requested") {
        setPendingApproval(true);
        setItems((current) => [...current, { type: "approval", request: data.request }]);
      }
    });

    source.addEventListener("approval.resolved", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as ServerEvent;
      if (data.type !== "approval.resolved") return;
      setPendingApproval(false);
      setItems((current) =>
        current.map((item) =>
          item.type === "approval" && item.request.id === data.approvalId ? { ...item, resolved: data.approved } : item
        )
      );
    });

    source.addEventListener("session.error", (event) => {
      const data = JSON.parse((event as MessageEvent).data) as ServerEvent;
      if (data.type === "session.error") {
        setItems((current) => [
          ...current,
          { type: "message", message: { id: crypto.randomUUID(), role: "assistant", content: data.message, createdAt: Date.now() } }
        ]);
        setBusy(false);
        setPendingApproval(false);
      }
    });

    return () => source.close();
  }, [sessionId]);

  function refreshSessions() {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((data) => setSessions(data as SessionSummary[]))
      .catch(() => {});
  }

  function handleDraftChange(value: string, cursor: number | null) {
    setDraft(value);
    updateActiveFileMention(value, cursor ?? value.length);
  }

  function updateActiveFileMention(value: string, cursor: number) {
    const mention = getActiveFileMention(value, cursor);
    setActiveMention(mention);
    if (!mention) setMentionIndex(0);
  }

  function selectFileMention(file: FileSuggestion) {
    if (!activeMention) return;
    const inserted = `@${file.path}`;
    const nextDraft = `${draft.slice(0, activeMention.start)}${inserted} ${draft.slice(activeMention.end)}`;
    const cursor = activeMention.start + inserted.length + 1;
    setDraft(nextDraft);
    setActiveMention(null);
    setFileSuggestions([]);
    window.setTimeout(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(cursor, cursor);
    }, 0);
  }

  async function expandFileMentions(message: string) {
    const paths = getFileMentionPaths(message);
    if (paths.length === 0) return message;

    const files = await Promise.all(
      paths.map(async (filePath) => {
        const response = await fetch(`/api/files/read?path=${encodeURIComponent(filePath)}`);
        if (!response.ok) return { path: filePath, content: `Unable to read ${filePath}.` };
        const data = (await response.json()) as { path?: string; content?: string };
        return { path: data.path ?? filePath, content: data.content ?? "" };
      })
    );

    const context = files
      .map((file) => `--- ${file.path} ---\n${file.content}`)
      .join("\n\n");
    return `${message}\n\nReferenced file context:\n${context}`;
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const message = draft.trim();

    if (busy) {
      fetch("/api/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId })
      }).catch(() => {});
      setBusy(false);
      setPendingApproval(false);
      setStreamingText("");
      return;
    }

    if (!message) return;

    setDraft("");
    setActiveMention(null);
    setFileSuggestions([]);
    setBusy(true);
    setItems((current) => [
      ...current,
      { type: "message", message: { id: crypto.randomUUID(), role: "user", content: message, createdAt: Date.now() } }
    ]);

    try {
      const modelMessage = await expandFileMentions(message);
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message: modelMessage, displayMessage: message, yolo })
      });
      const data = (await response.json()) as { sessionId: string };
      setSessionId(data.sessionId);
      refreshSessions();
    } catch (error) {
      setBusy(false);
      setItems((current) => [
        ...current,
        {
          type: "message",
          message: {
            id: crypto.randomUUID(),
            role: "assistant",
            content: error instanceof Error ? error.message : String(error),
            createdAt: Date.now()
          }
        }
      ]);
    }
  }

  async function respondToApproval(approvalId: string, approved: boolean) {
    await fetch("/api/approval/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approvalId, approved })
    });
  }

  async function newChat() {
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    const session = (await response.json()) as SessionSummary;
    setSessionId(session.id);
    setItems([]);
    setStreamingText("");
    setBusy(false);
    setPendingApproval(false);
    refreshSessions();
  }

  async function loadSession(id: string) {
    const response = await fetch(`/api/sessions/${id}`);
    const data = (await response.json()) as { timeline: TimelineItem[] };
    setSessionId(id);
    setItems(data.timeline ?? []);
    setStreamingText("");
    setBusy(false);
    setPendingApproval(false);
  }

  async function deleteSession(id: string, event: React.MouseEvent) {
    event.stopPropagation();
    await fetch(`/api/sessions/${id}`, { method: "DELETE" });
    if (id === sessionId) {
      await newChat();
    }
    refreshSessions();
  }

  return (
    <div className="codestate-ui" data-theme={theme} data-mode={mode}>
      {sidebarOpen ? (
        <aside className="sidebar">
          <div className="sidebar-head">
            <div className="sidebar-brand">
              <span className="brand-glyph" />
              <span className="brand-label">codestate</span>
            </div>
            <button type="button" className="icon-button" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar">
              <PanelLeftClose size={16} />
            </button>
          </div>

          <div className="sidebar-actions">
            <button type="button" className="action-chip primary" onClick={() => void newChat()}>
              <MessageSquarePlus size={15} /> New Conversation
            </button>
            <button type="button" className="action-chip" onClick={() => setPaletteOpen(true)}>
              <Search size={14} /> Search <kbd>⌘K</kbd>
            </button>
          </div>

          <div className="sessions-area">
            <div className="sessions-head">
              <span className="section-label">Sessions</span>
              <span className="count-badge">{sessions.length}</span>
            </div>
            <div className="thread-list">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className={cn("thread-row", session.id === sessionId && "active")}
                  onClick={() => void loadSession(session.id)}
                >
                  <Circle size={7} fill="currentColor" />
                  <span className="thread-title">{session.title}</span>
                  <button
                    type="button"
                    className="thread-delete"
                    onClick={(e) => void deleteSession(session.id, e)}
                    aria-label="Delete session"
                  >
                    <Trash2 size={11} />
                  </button>
                </button>
              ))}
              {sessions.length === 0 && <span className="empty-sessions">No sessions yet</span>}
            </div>
          </div>

          <div className="sidebar-foot">
            <button type="button" className="action-chip settings-trigger" onClick={() => setSettingsOpen(true)}>
              <Settings size={14} /> Settings
            </button>
            <div className={cn("status-chip", busy && "busy", pendingApproval && "pending")}>
              <span className="status-pip" />
              <span>{pendingApproval ? "AWAITING" : busy ? "ACTIVE" : "READY"}</span>
            </div>
          </div>
        </aside>
      ) : (
        <button type="button" className="sidebar-peek" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar">
          <PanelLeftOpen size={18} />
        </button>
      )}

      <div className={cn("main-panel", sidebarOpen && "with-sidebar", hasConversation ? "chatting" : "idle")}>
        <div className="rail left" />
        <div className="rail right" />

        <header className="top-bar">
          <div className="top-brand">
            <span className="brand-glyph" />
            <span className="brand-label">codestate</span>
          </div>
          <div className="top-project" title={project?.projectRoot}>
            <Folder size={13} />
            <span>{projectName}</span>
          </div>
          <div className="top-spacer" />
          <div className="top-actions">
            <button type="button" className="top-action" onClick={() => setPaletteOpen(true)} aria-label="Search sessions" title="Search sessions (⌘K)">
              <Search size={16} />
            </button>
            <button type="button" className="top-action" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
              <Settings size={16} />
            </button>
          </div>
        </header>

        <main className="chat-canvas">
          {!hasConversation && (
            <div className="welcome-area">
              <div className="folder-badge"><Folder size={13} /> {projectName}</div>
              <h1>What are you building?</h1>
              <div className="suggestion-chips">
                {["Explain this codebase", "Add a dark mode", "Write tests for"].map((text) => (
                  <button key={text} type="button" className="suggestion-chip" onClick={() => setDraft(text + " ")}>
                    {text}
                  </button>
                ))}
              </div>
            </div>
          )}

          <section className="timeline" aria-live="polite" ref={timelineRef}>
            {(() => {
              const nodes: React.ReactNode[] = [];
              let pending: ToolItem[] = [];
              for (const item of items) {
                if (item.type === "tool") {
                  pending.push({ call: item.call, result: item.result });
                } else if (item.type === "message") {
                  nodes.push(<MessageBubble key={item.message.id} message={item.message} tools={pending} />);
                  pending = [];
                } else if (item.resolved === undefined) {
                  nodes.push(<ApprovalCard key={item.request.id} item={item} onRespond={respondToApproval} />);
                  pending = [];
                }
              }
              if (streamingText) {
                nodes.push(<MessageBubble key="stream" message={{ id: "stream", role: "assistant", content: streamingText, createdAt: Date.now() }} tools={pending} />);
              }
              nodes.push(<div key="end" className="timeline-end" ref={timelineEndRef} />);
              return nodes;
            })()}
          </section>

          {busy && <BloomGlow label={pendingApproval ? "waiting for approval" : "agent running"} />}

          <form className="prompt-box" onSubmit={sendMessage}>
            {activeMention && fileSuggestions.length > 0 && (
              <div className="file-mention-menu">
                <span className="section-label">Files</span>
                {fileSuggestions.map((file, index) => (
                  <button
                    key={file.path}
                    type="button"
                    className={cn("mention-row", index === mentionIndex && "active")}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      selectFileMention(file);
                    }}
                  >
                    <FileText size={12} />
                    <span>{file.path}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="prompt-body">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => handleDraftChange(event.target.value, event.target.selectionStart)}
                onClick={(event) => updateActiveFileMention(draft, event.currentTarget.selectionStart)}
                onKeyUp={(event) => {
                  if (["ArrowDown", "ArrowUp", "Tab", "Enter", "Escape"].includes(event.key)) return;
                  updateActiveFileMention(draft, event.currentTarget.selectionStart);
                }}
                placeholder={busy ? "Agent is working... press Stop to cancel" : "Describe a feature, a bug, or @file..."}
                onKeyDown={(event) => {
                  if (activeMention && fileSuggestions.length > 0) {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setMentionIndex((index) => (index + 1) % fileSuggestions.length);
                      return;
                    }
                    if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setMentionIndex((index) => (index - 1 + fileSuggestions.length) % fileSuggestions.length);
                      return;
                    }
                    if (event.key === "Tab" || event.key === "Enter") {
                      event.preventDefault();
                      selectFileMention(fileSuggestions[mentionIndex]);
                      return;
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setActiveMention(null);
                      setFileSuggestions([]);
                      return;
                    }
                  }
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage(event);
                  }
                }}
              />
              <div className="prompt-tray">
                <div className="prompt-tray-left">
                  <span className="model-chip">{project?.model ?? "cloud"}</span>
                </div>
                <div className="prompt-tray-right">
                  <button type="button" className={cn("ay-toggle", yolo && "yolo")} onClick={() => setYolo((v) => !v)} title={yolo ? "Yolo mode — no approvals" : "Approval mode"}>
                    <span className="ay-knob">A</span>
                    <span className="ay-knob">Y</span>
                  </button>
                  <button
                    type="submit"
                    className={cn("action-chip send-chip", busy ? "stop" : "send")}
                    disabled={!busy && !draft.trim()}
                    aria-label={busy ? "Stop" : "Send message"}
                  >
                    {busy ? <Square size={14} fill="currentColor" /> : <ArrowUp size={16} />}
                  </button>
                </div>
              </div>
            </div>
          </form>
        </main>

        <footer><span className="footer-marca">codestate</span><span className="footer-year">© {new Date().getFullYear()}</span></footer>
      </div>

      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <section className="settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-head">
              <strong>Settings</strong>
              <button type="button" className="icon-button" onClick={() => setSettingsOpen(false)}><X size={16} /></button>
            </div>
            <div className="settings-body">
              <div className="settings-tile">
                <span className="tile-label">Project</span>
                <span className="tile-value">{project?.projectRoot ?? "Local project"}</span>
              </div>
              <div className="settings-tile">
                <span className="tile-label">Atmosphere</span>
                <button type="button" className="mode-chip" onClick={() => setMode(mode === "dark" ? "light" : "dark")}>
                  {mode === "dark" ? <Moon size={15} /> : <Sun size={15} />}
                  <span>{mode === "dark" ? "Dark" : "Light"}</span>
                </button>
              </div>
              <span className="section-label">Visual Profile</span>
              <div className="theme-grid">
                {themes.map((item) => (
                  <button key={item.name} type="button" className={cn("theme-tile", item.name, theme === item.name && "selected")} onClick={() => setTheme(item.name)} title={item.label}>
                    <span>{item.label}</span>{theme === item.name && <Check size={13} />}
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {paletteOpen && (
        <div className="cmd-overlay" onClick={() => setPaletteOpen(false)}>
          <section className="cmd-palette" onClick={(event) => event.stopPropagation()}>
            <div className="cmd-input-area"><Search size={15} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sessions..." /><kbd>ESC</kbd></div>
            <div className="cmd-results">
              <span className="section-label">{search ? "Results" : "Recent Sessions"}</span>
              {sessions
                .filter((s) => !search || s.title.toLowerCase().includes(search.toLowerCase()))
                .map((session) => (
                  <button key={session.id} type="button" className="cmd-result-row" onClick={() => { void loadSession(session.id); setPaletteOpen(false); }}>
                    <History size={13} /> <span>{session.title}</span><small>{projectName}</small>
                  </button>
                ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function getActiveFileMention(value: string, cursor: number): ActiveFileMention | null {
  const beforeCursor = value.slice(0, cursor);
  const start = beforeCursor.search(/(?:^|\s)@[^\s@]*$/);
  if (start === -1) return null;
  const at = beforeCursor.indexOf("@", start);
  if (at === -1) return null;
  const query = beforeCursor.slice(at + 1);
  return { start: at, end: cursor, query };
}

function getFileMentionPaths(message: string): string[] {
  const matches = message.matchAll(/(?:^|\s)@([^\s@]+)/g);
  return Array.from(new Set(Array.from(matches, (match) => match[1].replace(/[.,;:!?\])}]+$/, "")).filter(Boolean)));
}

function MessageBubble({ message, tools }: { message: ChatMessage; tools?: ToolItem[] }) {
  return (
    <article className={cn("message-bubble", message.role)}>
      {message.role === "assistant" && (
        <div className="bubble-avatar"><Bot size={13} /></div>
      )}
      <div className="bubble-content">
        {message.role === "assistant" ? (
          <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
        ) : (
          <p>{message.content}</p>
        )}
        {tools && tools.length > 0 && (
          <div className="bubble-tools">
            {tools.map((t, i) => (
              <ToolCard key={t.call.id ?? i} call={t.call} result={t.result} />
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function BloomGlow({ label }: { label: string }) {
  return (
    <div className="bloom-glow" aria-label={label}>
      <DotmSquare8 size={32} dotSize={4} speed={1.2} bloom />
      <span>{label}</span>
    </div>
  );
}

function DotmSquare8({ size, dotSize, speed, bloom }: { size: number; dotSize: number; speed: number; bloom?: boolean }) {
  return (
    <div className={cn("dotm-square-8", bloom && "bloom")} style={{ width: size, height: size, "--dot-size": `${dotSize}px`, "--speed": `${speed}s` } as CSSProperties}>
      {Array.from({ length: 64 }).map((_, index) => {
        const row = Math.floor(index / 8);
        const column = index % 8;
        return <span key={index} style={{ animationDelay: `${column * 55 + row * 22}ms` }} />;
      })}
    </div>
  );
}

function ToolCard({ call, result }: { call: ToolCall; result?: ToolResult }) {
  const [open, setOpen] = useState(false);
  const label = formatToolLabel(call, result);
  const output = result?.output?.trim();
  const canOpen = Boolean(output);
  const icon = toolIcon(call.name);

  return (
    <div className="tool-chip">
      <button type="button" className="tool-chip-btn" onClick={() => canOpen && setOpen((current) => !current)} disabled={!canOpen} aria-expanded={canOpen ? open : undefined}>
        {icon}
        <span className={result ? "tool-chip-done" : "tool-chip-pending"}>{label}</span>
        {canOpen && <ChevronRight size={12} className={cn("tool-chevron", open && "open")} />}
      </button>
      {open && output && <pre className={result?.ok ? "tool-output" : "tool-output error"}>{output}</pre>}
    </div>
  );
}

function toolIcon(name: string) {
  switch (name) {
    case "read": return <FileText size={12} />;
    case "list": return <Folder size={12} />;
    case "search": return <Search size={12} />;
    case "run": return <Terminal size={12} />;
    case "write": return <Code size={12} />;
    case "apply": return <Sparkles size={12} />;
    default: return <FileText size={12} />;
  }
}

function formatToolLabel(call: ToolCall, result?: ToolResult) {
  const inputPath = typeof call.input.path === "string" ? call.input.path : undefined;
  const query = typeof call.input.query === "string" ? call.input.query : undefined;
  const command = typeof call.input.command === "string" ? call.input.command : undefined;

  if (call.name === "read" && inputPath) return `${result ? "read" : "Reading"} ${inputPath}${result ? "" : "..."}`;
  if (call.name === "list" && inputPath) return `${result ? "listed" : "Listing"} ${inputPath}${result ? "" : "..."}`;
  if (call.name === "search" && query) return `${result ? "searched" : "Searching"} for "${query}"${result ? "" : "..."}`;
  if (call.name === "run" && command) return `${result ? "ran" : "Running"} ${command}${result ? "" : "..."}`;
  if (call.name === "write" && inputPath) return `${result ? "wrote" : "Writing"} ${inputPath}${result ? "" : "..."}`;
  if (call.name === "apply") return result ? "applied changes" : "Applying changes...";
  return `${result ? "finished" : "Running"} ${call.name}${result ? "" : "..."}`;
}

function ApprovalCard({ item, onRespond }: { item: Extract<TimelineItem, { type: "approval" }>; onRespond: (id: string, approved: boolean) => void }) {
  const toolName = item.request.toolCall.name;
  const isDiff = toolName === "apply" && item.request.preview.startsWith("---");
  return (
    <div className="approval-card">
      <div className="approval-head">
        <span className="approval-tool-badge">{toolName}</span>
        <span className="approval-caption">requests approval</span>
      </div>
      {isDiff ? (
        <DiffPreview text={item.request.preview} />
      ) : (
        <pre className="approval-pre">{item.request.preview}</pre>
      )}
      {item.resolved === undefined ? (
        <div className="approval-actions">
          <button type="button" className="approval-action allow" onClick={() => onRespond(item.request.id, true)}>
            <Check size={13} /> Approve
          </button>
          <button type="button" className="approval-action deny" onClick={() => onRespond(item.request.id, false)}>
            <X size={13} /> Reject
          </button>
        </div>
      ) : (
        <div className={cn("approval-verdict", item.resolved ? "allowed" : "denied")}>
          {item.resolved ? <><Check size={12} /> Approved</> : <><X size={12} /> Rejected</>}
        </div>
      )}
    </div>
  );
}

function DiffPreview({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="diff-preview">
      {lines.map((line, i) => {
        const cls = line.startsWith("+") && !line.startsWith("+++")
          ? "diff-add"
          : line.startsWith("-") && !line.startsWith("---")
          ? "diff-del"
          : line.startsWith("@@")
          ? "diff-hunk"
          : line.startsWith("---") || line.startsWith("+++")
          ? "diff-header"
          : "diff-ctx";
        return <div key={i} className={cn("diff-line", cls)}>{line || " "}</div>;
      })}
    </div>
  );
}
