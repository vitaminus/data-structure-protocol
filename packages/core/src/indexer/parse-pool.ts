import { Worker } from "node:worker_threads";
import type { LanguageAdapterWorkerSpec, ParseResult } from "../graph/types.ts";

type ParseJob = {
  id: number;
  spec: LanguageAdapterWorkerSpec;
  filePath: string;
  content: string;
  resolve: (result: ParseResult) => void;
  reject: (error: Error) => void;
};

type WorkerSlot = {
  worker: Worker;
  currentJobId?: number;
};

type WorkerReply =
  | {
      jobId: number;
      result: ParseResult;
    }
  | {
      jobId: number;
      error: {
        name?: string;
        message: string;
        stack?: string;
      };
    };

const WORKER_SOURCE = `
  import { parentPort } from "node:worker_threads";

  const parserCache = new Map();
  const moduleCache = new Map();

  async function loadParser(moduleUrl, exportName) {
    const key = \`\${moduleUrl}#\${exportName}\`;
    if (parserCache.has(key)) {
      return parserCache.get(key);
    }
    let mod = moduleCache.get(moduleUrl);
    if (!mod) {
      mod = await import(moduleUrl);
      moduleCache.set(moduleUrl, mod);
    }
    const parser = mod?.[exportName];
    if (typeof parser !== "function") {
      throw new Error(\`Worker parser export not found: \${key}\`);
    }
    parserCache.set(key, parser);
    return parser;
  }

  parentPort?.on("message", async (job) => {
    try {
      const parser = await loadParser(job.moduleUrl, job.exportName);
      const result = await parser(job.filePath, job.content);
      parentPort?.postMessage({ jobId: job.jobId, result });
    } catch (error) {
      parentPort?.postMessage({
        jobId: job.jobId,
        error: {
          name: error?.name,
          message: error?.message ?? String(error),
          stack: error?.stack
        }
      });
    }
  });
`;

function toError(payload: { name?: string; message: string; stack?: string }): Error {
  const error = new Error(payload.message);
  error.name = payload.name ?? "Error";
  if (payload.stack) {
    error.stack = payload.stack;
  }
  return error;
}

export class ParseWorkerPool {
  private readonly size: number;
  private readonly useTsxLoader: boolean;
  private readonly slots: WorkerSlot[] = [];
  private readonly pendingJobs = new Map<number, ParseJob>();
  private readonly queue: ParseJob[] = [];
  private nextJobId = 1;
  private closing = false;

  constructor(size: number, useTsxLoader: boolean) {
    this.size = Math.max(0, size);
    this.useTsxLoader = useTsxLoader;
    for (let index = 0; index < this.size; index += 1) {
      this.slots.push(this.createSlot());
    }
  }

  get enabled(): boolean {
    return this.size > 0;
  }

  run(spec: LanguageAdapterWorkerSpec, filePath: string, content: string): Promise<ParseResult> {
    return new Promise<ParseResult>((resolve, reject) => {
      const job: ParseJob = {
        id: this.nextJobId++,
        spec,
        filePath,
        content,
        resolve,
        reject
      };
      this.queue.push(job);
      this.dispatch();
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const jobs = [...this.pendingJobs.values(), ...this.queue];
    this.queue.length = 0;
    this.pendingJobs.clear();
    for (const job of jobs) {
      job.reject(new Error("Parse worker pool closed"));
    }
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
    this.slots.length = 0;
  }

  private createSlot(): WorkerSlot {
    const worker = new Worker(new URL(`data:text/javascript,${encodeURIComponent(WORKER_SOURCE)}`), {
      execArgv: this.useTsxLoader ? ["--import", "tsx"] : undefined
    });
    const slot: WorkerSlot = { worker };
    worker.on("message", (reply: WorkerReply) => {
      const job = this.pendingJobs.get(reply.jobId);
      if (!job) {
        slot.currentJobId = undefined;
        return;
      }
      this.pendingJobs.delete(reply.jobId);
      slot.currentJobId = undefined;
      if ("error" in reply) {
        job.reject(toError(reply.error));
      } else {
        job.resolve(reply.result);
      }
      this.dispatch();
    });
    worker.on("error", (error) => {
      this.failSlot(slot, error);
    });
    worker.on("exit", (code) => {
      if (!this.closing && code !== 0) {
        this.failSlot(slot, new Error(`Parse worker exited with code ${code}`));
      }
    });
    return slot;
  }

  private failSlot(slot: WorkerSlot, error: Error): void {
    const currentJobId = slot.currentJobId;
    slot.currentJobId = undefined;
    if (currentJobId !== undefined) {
      const job = this.pendingJobs.get(currentJobId);
      if (job) {
        this.pendingJobs.delete(currentJobId);
        job.reject(error);
      }
    }
    if (this.closing) {
      return;
    }
    const slotIndex = this.slots.indexOf(slot);
    if (slotIndex !== -1) {
      this.slots.splice(slotIndex, 1, this.createSlot());
    }
    this.dispatch();
  }

  private dispatch(): void {
    if (this.closing || this.queue.length === 0) {
      return;
    }
    for (const slot of this.slots) {
      if (this.queue.length === 0) {
        return;
      }
      if (slot.currentJobId !== undefined) {
        continue;
      }
      const job = this.queue.shift()!;
      slot.currentJobId = job.id;
      this.pendingJobs.set(job.id, job);
      slot.worker.postMessage({
        jobId: job.id,
        moduleUrl: job.spec.moduleUrl,
        exportName: job.spec.exportName,
        filePath: job.filePath,
        content: job.content
      });
    }
  }
}
