export async function readJsonResponse(response: Response) {
  const text = await response.text();
  if (!text.trim()) throw new Error(`The server returned an empty response (HTTP ${response.status}). It may be restarting. Try Refresh queue once the server is ready.`);
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`The server returned an invalid response (HTTP ${response.status}). Check that npm run dev is running, then try Refresh queue.`); }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${typeof data?.message === "string" ? data.message : "Request failed. Try again once the server is ready."}`);
  return data;
}
