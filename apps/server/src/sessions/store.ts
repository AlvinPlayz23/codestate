import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { StoredSession, SessionSummary, TimelineItem } from "@codestate/shared";

type StoredSessionFile = {
  sessions: StoredSession[];
};

export class JsonSessionStore {
  private filePath: string;
  private writeLock: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "sessions.json");
  }

  async init() {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });

    try {
      await readFile(this.filePath, "utf8");
    } catch {
      await this.atomicWrite({ sessions: [] });
    }
  }

  private async readAll(): Promise<StoredSession[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const data = JSON.parse(raw) as StoredSessionFile;
      return data.sessions ?? [];
    } catch {
      return [];
    }
  }

  private atomicWrite(data: StoredSessionFile): Promise<void> {
    const doWrite = async () => {
      const tmp = this.filePath + ".tmp";
      await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
      try {
        await rename(tmp, this.filePath);
      } catch (err: any) {
        if (err.code === "EPERM") {
          await unlink(this.filePath).catch(() => {});
          await rename(tmp, this.filePath);
        } else {
          throw err;
        }
      }
    };
    this.writeLock = this.writeLock.catch(() => {}).then(doWrite);
    return this.writeLock;
  }

  async list(projectRoot: string): Promise<SessionSummary[]> {
    const sessions = await this.readAll();
    return sessions
      .filter((s) => s.projectRoot === projectRoot)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ modelHistory: _mh, timeline: _t, ...summary }) => summary);
  }

  async get(id: string): Promise<StoredSession | undefined> {
    const sessions = await this.readAll();
    return sessions.find((s) => s.id === id);
  }

  async create(input: { id: string; projectRoot: string; model: string; title?: string }): Promise<StoredSession> {
    const sessions = await this.readAll();
    const now = Date.now();
    const session: StoredSession = {
      id: input.id,
      title: input.title ?? "New session",
      projectRoot: input.projectRoot,
      model: input.model,
      createdAt: now,
      updatedAt: now,
      modelHistory: [],
      timeline: []
    };
    sessions.push(session);
    await this.atomicWrite({ sessions });
    return session;
  }

  async updateTitle(id: string, title: string) {
    const sessions = await this.readAll();
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    session.title = title;
    session.updatedAt = Date.now();
    await this.atomicWrite({ sessions });
  }

  async appendTimeline(id: string, item: TimelineItem) {
    const sessions = await this.readAll();
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    session.timeline.push(item);
    session.updatedAt = Date.now();
    await this.atomicWrite({ sessions });
  }

  async updateTimelineItem(id: string, predicate: (item: TimelineItem) => boolean, patch: (item: TimelineItem) => TimelineItem) {
    const sessions = await this.readAll();
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    session.timeline = session.timeline.map((item) => (predicate(item) ? patch(item) : item));
    session.updatedAt = Date.now();
    await this.atomicWrite({ sessions });
  }

  async saveModelHistory(id: string, history: StoredSession["modelHistory"]) {
    const sessions = await this.readAll();
    const session = sessions.find((s) => s.id === id);
    if (!session) return;
    session.modelHistory = history;
    session.updatedAt = Date.now();
    await this.atomicWrite({ sessions });
  }

  async delete(id: string): Promise<boolean> {
    const sessions = await this.readAll();
    const index = sessions.findIndex((s) => s.id === id);
    if (index === -1) return false;
    sessions.splice(index, 1);
    await this.atomicWrite({ sessions });
    return true;
  }
}
