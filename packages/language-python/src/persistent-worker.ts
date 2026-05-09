import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

type WorkerSuccess<T> = {
  id: number;
  ok: true;
  result: T;
};

type WorkerFailure = {
  id: number;
  ok: false;
  error: {
    code?: string;
    message: string;
    syntaxError?: boolean;
  };
};

type WorkerReply<T> = WorkerSuccess<T> | WorkerFailure;

export class PersistentWorkerError extends Error {
  readonly code?: string;
  readonly syntaxError: boolean;

  constructor(message: string, options: { code?: string; syntaxError?: boolean } = {}) {
    super(message);
    this.name = "PersistentWorkerError";
    this.code = options.code;
    this.syntaxError = Boolean(options.syntaxError);
  }
}

export type PersistentJsonlWorkerStats = {
  restarts: number;
  timeouts: number;
};

type PendingRequest<T> = {
  id: number;
  resolve: (result: T) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export class PersistentJsonlWorker<T> {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private stderr = "";
  private nextId = 1;
  private jobsCompleted = 0;
  private pending?: PendingRequest<T>;
  private plannedExitPid?: number;
  private readonly stats: PersistentJsonlWorkerStats = {
    restarts: 0,
    timeouts: 0
  };

  constructor(
    private readonly commandFactory: () => { command: string; args: string[] },
    private readonly options: {
      timeoutMs: number;
      maxJobsPerWorker: number;
    }
  ) {}

  getStats(): PersistentJsonlWorkerStats {
    return { ...this.stats };
  }

  async request(payload: Record<string, unknown>): Promise<T> {
    if (this.pending) {
      throw new Error("Persistent worker does not support concurrent requests");
    }
    if (this.child && this.jobsCompleted >= this.options.maxJobsPerWorker) {
      await this.restart();
    }
    const child = this.ensureChild();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.stats.timeouts += 1;
        const timeoutError = new PersistentWorkerError(
          `Persistent worker timed out after ${this.options.timeoutMs}ms`,
          { code: "timeout" }
        );
        this.rejectPending(timeoutError);
        void this.restart("SIGKILL");
      }, this.options.timeoutMs);
      this.pending = { id, resolve, reject, timeout };
      try {
        child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, "utf8");
      } catch (error) {
        clearTimeout(timeout);
        this.pending = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    this.rejectPending(new Error("Persistent worker closed"));
    await this.stopChild();
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }
    const { command, args } = this.commandFactory();
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4096);
    });
    child.on("error", (error) => {
      this.handleUnexpectedExit(error);
    });
    child.on("exit", (code, signal) => {
      const wasPlanned = child.pid !== undefined && this.plannedExitPid === child.pid;
      if (wasPlanned) {
        this.plannedExitPid = undefined;
      }
      if (this.child === child) {
        this.child = undefined;
        this.buffer = "";
        this.stderr = "";
        this.jobsCompleted = 0;
      }
      if (!wasPlanned && this.pending) {
        this.handleUnexpectedExit(
          new PersistentWorkerError(
            `Persistent worker exited before replying (code: ${code ?? "null"}, signal: ${signal ?? "null"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`,
            { code: "exit" }
          )
        );
      }
    });
    this.child = child;
    this.buffer = "";
    this.stderr = "";
    this.jobsCompleted = 0;
    return child;
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      this.handleReplyLine(line);
    }
  }

  private handleReplyLine(line: string): void {
    let reply: WorkerReply<T>;
    try {
      reply = JSON.parse(line) as WorkerReply<T>;
    } catch {
      this.handleUnexpectedExit(new PersistentWorkerError(`Persistent worker emitted invalid JSON: ${line}`, { code: "invalid_json" }));
      return;
    }
    if (!this.pending || reply.id !== this.pending.id) {
      return;
    }
    const pending = this.pending;
    clearTimeout(pending.timeout);
    this.pending = undefined;
    this.jobsCompleted += 1;
    if (reply.ok) {
      pending.resolve(reply.result);
      return;
    }
    pending.reject(
      new PersistentWorkerError(reply.error.message, {
        code: reply.error.code,
        syntaxError: reply.error.syntaxError
      })
    );
  }

  private handleUnexpectedExit(error: Error): void {
    this.stats.restarts += 1;
    this.rejectPending(error);
    void this.stopChild();
  }

  private rejectPending(error: Error): void {
    if (!this.pending) {
      return;
    }
    const pending = this.pending;
    clearTimeout(pending.timeout);
    this.pending = undefined;
    pending.reject(error);
  }

  private async restart(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    await this.stopChild(signal);
  }

  private async stopChild(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = undefined;
    this.buffer = "";
    this.stderr = "";
    this.jobsCompleted = 0;
    if (child.pid !== undefined) {
      this.plannedExitPid = child.pid;
    }
    child.kill(signal);
    await once(child, "exit").catch(() => undefined);
    if (child.pid !== undefined && this.plannedExitPid === child.pid) {
      this.plannedExitPid = undefined;
    }
  }
}
