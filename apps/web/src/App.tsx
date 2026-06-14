import { CSSProperties, FormEvent, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ApprovalRequest, ChatMessage, SessionSummary, ServerEvent, TimelineItem, ToolCall, ToolResult } from "@codestate/shared";
import {
  Check,
  ChevronDown,
  Command,
  ChevronRight,
  FileText,
  Folder,
  Menu,
  Moon,
  Plus,
  Search,
  Send,
  Settings,
  Square,
  Sun,
  Trash2,
  X
} from "lucide-react";

type ProjectState = {
  projectRoot: string;
  model: string;
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
  const timelineRef = useRef<HTMLElement | null>(null);
  const timelineEndRef = useRef<HTMLDivElement | null>(null);

  const projectName = project?.projectRoot.split(/[\\/]/).filter(Boolean).at(-1) ?? "Loading project";
  const hasConversation = items.length > 0 || Boolean(streamingText) || busy;

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
      .then((data) => setSessions(data as SessionSummary[]))
      .catch(() => setSessions([]));
  }, []);

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
    setBusy(true);
    setItems((current) => [
      ...current,
      { type: "message", message: { id: crypto.randomUUID(), role: "user", content: message, createdAt: Date.now() } }
    ]);

    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, message, yolo })
    });
    const data = (await response.json()) as { sessionId: string };
    setSessionId(data.sessionId);
    refreshSessions();
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
          <button type="button" className="icon-button sidebar-toggle" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar"><Menu size={16} /></button>
          <button type="button" className="nav-row" onClick={() => void newChat()}><Plus size={15} /> New Chat</button>
          <button type="button" className="nav-row" onClick={() => setPaletteOpen(true)}><Search size={15} /> Search <kbd>⌘K</kbd></button>

          <div className="sessions">
            <span className="section-label">Sessions</span>
            <div className="project-row">
              <ChevronDown size={14} />
              <span className="project-title">{projectName}</span>
              <span className="project-count">{sessions.length}</span>
            </div>
            <div className="thread-list">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className={`thread-row ${session.id === sessionId ? "active" : ""}`}
                  onClick={() => void loadSession(session.id)}
                >
                  <FileText size={13} />
                  <span>{session.title}</span>
                  <button
                    type="button"
                    className="thread-delete"
                    onClick={(e) => void deleteSession(session.id, e)}
                    aria-label="Delete session"
                  >
                    <Trash2 size={12} />
                  </button>
                </button>
              ))}
              {sessions.length === 0 && <span className="empty-sessions">No sessions yet</span>}
            </div>
          </div>

          <div className="status-stack">
            <span className={`status-dot ${busy ? "busy" : ""}`} />
            <span>{pendingApproval ? "APPROVAL" : busy ? "ACTIVE" : "READY"}</span>
          </div>
          <button type="button" className="nav-row settings-button" onClick={() => setSettingsOpen(true)}><Settings size={15} /> Settings</button>
        </aside>
      ) : (
        <button type="button" className="floating-menu" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar"><Menu size={16} /></button>
      )}

      <div className={`main-panel ${sidebarOpen ? "with-sidebar" : ""} ${hasConversation ? "chatting" : "idle"}`}>
        <div className="rail left" />
        <div className="rail right" />

        <main className="chat-canvas">
          <div className="folder-pill"><Folder size={14} /> {projectName}</div>
          {!hasConversation && <h1>What would you like to build today?</h1>}

          <section className="timeline" aria-live="polite" ref={timelineRef}>
            {items.map((item, index) => {
              if (item.type === "message") return <MessageBubble key={item.message.id} message={item.message} />;
              if (item.type === "tool") return <ToolCard key={`${item.call.id}-${index}`} call={item.call} result={item.result} />;
              if (item.resolved !== undefined) return null;
              return <ApprovalCard key={item.request.id} item={item} onRespond={respondToApproval} />;
            })}
            {streamingText && <MessageBubble message={{ id: "stream", role: "assistant", content: streamingText, createdAt: Date.now() }} />}
            <div className="timeline-end" ref={timelineEndRef} />
          </section>

          {busy && <BloomGlow label={pendingApproval ? "waiting for approval" : "agent running"} />}

          <form className="prompt-box" onSubmit={sendMessage}>
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={busy ? "Agent is working... press Stop to cancel" : "Describe a feature, a bug, or @file..."}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage(event);
                }
              }}
            />
            <div className="composer-footer">
              <span>{project?.model ?? "cloud model"}</span>
              <div className="composer-right">
                <button type="button" className={`ay-toggle ${yolo ? "yolo" : ""}`} onClick={() => setYolo((v) => !v)} title={yolo ? "Yolo mode — no approvals" : "Approval mode"}>
                  <span className="ay-knob">A</span>
                  <span className="ay-knob">Y</span>
                </button>
                <button type="submit" className={busy ? "stop-btn" : "send-btn"} disabled={!busy && !draft.trim()} aria-label={busy ? "Stop" : "Send message"}>
                  {busy ? <Square size={14} fill="currentColor" /> : <Send size={16} />}
                </button>
              </div>
            </div>
          </form>
        </main>

        <footer>codestate labs <span>© {new Date().getFullYear()}</span></footer>
      </div>

      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <section className="settings-modal" onClick={(event) => event.stopPropagation()}>
            <header><strong>Settings</strong><button type="button" onClick={() => setSettingsOpen(false)}><X size={15} /></button></header>
            <div className="settings-row project-path"><span>Project</span><strong>{project?.projectRoot ?? "Local project"}</strong></div>
            <div className="settings-row"><span>Atmosphere</span><button type="button" className="mode-toggle" onClick={() => setMode(mode === "dark" ? "light" : "dark")}>{mode === "dark" ? <Moon size={16} /> : <Sun size={16} />}</button></div>
            <span className="section-label">Visual Profile</span>
            <div className="theme-grid">
              {themes.map((item) => (
                <button key={item.name} type="button" className={`theme-swatch ${item.name} ${theme === item.name ? "selected" : ""}`} onClick={() => setTheme(item.name)} title={item.label}>
                  <span>{item.label}</span>{theme === item.name && <Check size={14} />}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {paletteOpen && (
        <div className="cmd-overlay" onClick={() => setPaletteOpen(false)}>
          <section className="cmd-palette" onClick={(event) => event.stopPropagation()}>
            <div className="cmd-input-wrap"><Search size={16} /><input autoFocus value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sessions, prompts..." /><kbd>ESC</kbd></div>
            <div className="cmd-results">
              <span className="section-label">{search ? "Results" : "Sessions"}</span>
              {sessions
                .filter((s) => !search || s.title.toLowerCase().includes(search.toLowerCase()))
                .map((session) => (
                  <button key={session.id} type="button" onClick={() => { void loadSession(session.id); setPaletteOpen(false); }}>
                    <Command size={14} /> <span>{session.title}</span><small>{projectName}</small>
                  </button>
                ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === "assistant") {
    return (
      <article className={`message ${message.role}`}>
        <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>
      </article>
    );
  }
  return <article className={`message ${message.role}`}>{message.content}</article>;
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
    <div className={`dotm-square-8 ${bloom ? "bloom" : ""}`} style={{ width: size, height: size, "--dot-size": `${dotSize}px`, "--speed": `${speed}s` } as CSSProperties}>
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

  return (
    <article className="tool-row">
      <button type="button" className="tool-label" onClick={() => canOpen && setOpen((current) => !current)} disabled={!canOpen} aria-expanded={canOpen ? open : undefined}>
        <ChevronRight className={`tool-chevron ${open ? "open" : ""}`} size={14} />
        <span className={result ? "tool-done-label" : "tool-shimmer-text"}>{label}</span>
      </button>
      {open && output && <pre className={result?.ok ? "tool-output" : "tool-output error"}>{output}</pre>}
    </article>
  );
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
  return (
    <article className="approval-card">
      <div className="approval-header">
        <span className="approval-tool-badge">{toolName}</span>
        <span className="approval-eyebrow">needs your approval</span>
      </div>
      <pre className="approval-preview">{item.request.preview}</pre>
      {item.resolved === undefined ? (
        <div className="approval-actions">
          <button type="button" className="approval-btn approve" onClick={() => onRespond(item.request.id, true)}>
            <Check size={13} /> Approve
          </button>
          <button type="button" className="approval-btn reject" onClick={() => onRespond(item.request.id, false)}>
            <X size={13} /> Reject
          </button>
        </div>
      ) : (
        <div className={`approval-resolved ${item.resolved ? "approved" : "rejected"}`}>
          {item.resolved ? <><Check size={12} /> Approved</> : <><X size={12} /> Rejected</>}
        </div>
      )}
    </article>
  );
}
