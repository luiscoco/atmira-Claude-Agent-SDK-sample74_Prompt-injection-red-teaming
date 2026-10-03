/** Shows every raw SDKMessage so you can see exactly what the SDK emits. */
export function MessageLog({ messages }: { messages: any[] }) {
  if (messages.length === 0) return null;
  return (
    <div className="log">
      <h3>Raw SDK message stream ({messages.length})</h3>
      {messages.map((m, i) => (
        <details key={i}>
          <summary>
            <span className={`tag tag-${m.type}`}>{m.type}</span>
            {m.subtype && <span className="subtype">{m.subtype}</span>}
          </summary>
          <pre>{JSON.stringify(m, null, 2)}</pre>
        </details>
      ))}
    </div>
  );
}
