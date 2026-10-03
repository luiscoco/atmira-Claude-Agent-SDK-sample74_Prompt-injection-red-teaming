/**
 * POSTs JSON and reads the Server-Sent Events response.
 * (EventSource only supports GET, so we parse the stream manually.)
 */
export async function streamPost(
  url: string,
  body: unknown,
  onEvent: (event: string, data: any) => void,
  signal?: AbortSignal,
) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  // A 502 from Vite's proxy means the backend is down or restarting.
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status} ${res.statusText}${res.status === 502 ? " (is the lesson backend running?)" : ""}`);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop()!;
    for (const chunk of chunks) {
      const event = chunk.match(/^event: (.*)$/m)?.[1] ?? "message";
      const data = chunk.match(/^data: (.*)$/m)?.[1];
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}
