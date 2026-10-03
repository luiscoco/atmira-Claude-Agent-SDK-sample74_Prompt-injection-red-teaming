import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { deskServer, type DeskCtx } from "../capstone/tools.js";
import type { Store } from "../capstone/store.js";

// #region memory-mcp
/** Calls the REAL registered capstone tools, including their zod schemas, without a model or network. */
export async function withDesk<T>(store: Store, customerId: string, check: (client: Client) => Promise<T>, ctx?: DeskCtx): Promise<T> {
  const server = deskServer(store, customerId, ctx ?? { session: () => "offline-session-51", approver: () => "unit-test approver" });
  const client = new Client({ name: "lesson-51-tests", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    return await check(client);
  } finally {
    await client.close();
    await server.instance.close();
  }
}
// #endregion
