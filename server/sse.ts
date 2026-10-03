import type { Request, Response } from "express";

/**
 * Streams every item of an async iterable to the browser as Server-Sent Events.
 * Returns an AbortController that fires when the browser disconnects, so the
 * agent run can be cancelled (pass it to the SDK's `abortController` option).
 */
export function openSse(_req: Request, res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const abort = new AbortController();
  res.on("close", () => abort.abort());

  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  async function pipe(stream: AsyncIterable<unknown>) {
    try {
      for await (const msg of stream) send("message", msg);
    } catch (err) {
      if (!abort.signal.aborted) send("error", { message: String(err) });
    } finally {
      send("done", {});
      res.end();
    }
  }

  return { abort, send, pipe };
}
