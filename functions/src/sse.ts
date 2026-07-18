// Minimal Server-Sent Events writer for streaming onRequest functions.
// Cloud Functions v2 runs on Cloud Run, which streams response writes as
// long as nothing buffers them: no compression middleware, no-transform
// cache control, and X-Accel-Buffering disabled for any proxy in between.

import type {Response} from "express";

const HEARTBEAT_MS = 15_000;

/**
 * Wraps an Express response as an SSE stream with periodic heartbeat
 * comments so intermediaries don't idle the connection out.
 */
export class SseWriter {
  private heartbeat: NodeJS.Timeout | null = null;
  private closed = false;

  /**
   * @param {Response} res The response to stream over.
   */
  constructor(private readonly res: Response) {}

  /**
   * Writes the SSE headers and starts the heartbeat. Call exactly once,
   * before any send().
   */
  open(): void {
    this.res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    this.res.flushHeaders();
    this.comment("connected");
    this.heartbeat = setInterval(() => this.comment("hb"), HEARTBEAT_MS);
  }

  /**
   * Sends one named event with a JSON payload.
   * @param {string} event The event name.
   * @param {unknown} data The payload (JSON-serialized onto one line).
   */
  send(event: string, data: unknown): void {
    if (this.closed || this.res.writableEnded) return;
    this.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Sends an SSE comment frame (ignored by clients; keeps the pipe warm).
   * @param {string} text The comment text.
   */
  comment(text: string): void {
    if (this.closed || this.res.writableEnded) return;
    this.res.write(`: ${text}\n\n`);
  }

  /**
   * Stops the heartbeat and ends the response. Safe to call repeatedly.
   */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (!this.res.writableEnded) this.res.end();
  }
}
