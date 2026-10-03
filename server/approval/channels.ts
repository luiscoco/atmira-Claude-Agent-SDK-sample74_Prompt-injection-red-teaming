import type { Approval, Channel } from "./approval.js";

export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
export function messageFor(approval: Approval, baseUrl: string) {
  const url = new URL("/api/c65/review", baseUrl);
  // Fragments are not sent in GET requests, server logs or referrer headers.
  url.hash = new URLSearchParams({ id: approval.id, token: approval.token }).toString();
  const text = `Review refund: ${approval.refund.orderId}, $${(approval.refund.amountCents / 100).toFixed(2)}. Reason: ${approval.refund.reason}. Expires ${new Date(approval.expiresAt).toISOString()}.`;
  const link = url.href;
  const payload = approval.channel === "slack" ? { text, blocks: [
    { type: "section", text: { type: "plain_text", text } },
    { type: "actions", elements: [{ type: "button", action_id: "review_refund", text: { type: "plain_text", text: "Review request" }, url: link }] },
  ] } : approval.channel === "teams" ? { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null,
    content: { $schema: "http://adaptivecards.io/schemas/adaptive-card.json", type: "AdaptiveCard", version: "1.2",
      body: [{ type: "TextBlock", text, wrap: true }], actions: [{ type: "Action.OpenUrl", title: "Review request", url: link }] } }] }
    : { subject: `Approval needed: ${approval.refund.orderId}`, body: { contentType: "HTML", content: `<p>${escapeHtml(text)}</p><p><a href="${escapeHtml(link)}">Review request</a></p>` } };
  return { channel: approval.channel, text, link, payload };
}

export function configured(channel: Channel, env = process.env) {
  try {
    const publicUrl = new URL(env.APPROVAL_PUBLIC_BASE_URL ?? "");
    if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash) return false;
  } catch { return false; }
  if (channel === "slack") return Boolean(env.APPROVAL_SLACK_BOT_TOKEN && env.APPROVAL_SLACK_CHANNEL);
  if (channel === "teams") {
    try { const url = new URL(env.APPROVAL_TEAMS_WORKFLOW_URL ?? ""); return url.protocol === "https:" && !url.username && !url.password; }
    catch { return false; }
  }
  return Boolean(env.APPROVAL_GRAPH_TOKEN && env.APPROVAL_EMAIL_SENDER && env.APPROVAL_EMAIL_TO);
}

/** Invoked only by the user's explicit external-delivery run. Never retries a possibly delivered notification. */
export async function deliver(approval: Approval, message: ReturnType<typeof messageFor>, signal: AbortSignal,
  env = process.env, request: typeof fetch = fetch) {
  if (!configured(approval.channel, env)) throw new Error("Configure this channel and an HTTPS public base URL before external delivery.");
  let endpoint: string; let body: unknown; let authorization: string | undefined;
  if (approval.channel === "slack") {
    endpoint = "https://slack.com/api/chat.postMessage"; authorization = `Bearer ${env.APPROVAL_SLACK_BOT_TOKEN}`;
    body = { ...message.payload, channel: env.APPROVAL_SLACK_CHANNEL, unfurl_links: false, unfurl_media: false };
  } else if (approval.channel === "teams") {
    endpoint = env.APPROVAL_TEAMS_WORKFLOW_URL!; body = message.payload;
  } else {
    endpoint = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(env.APPROVAL_EMAIL_SENDER!)}/sendMail`;
    authorization = `Bearer ${env.APPROVAL_GRAPH_TOKEN}`;
    body = { message: { ...message.payload, toRecipients: [{ emailAddress: { address: env.APPROVAL_EMAIL_TO } }] }, saveToSentItems: true };
  }
  const response = await request(endpoint, { method: "POST", redirect: "error", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
  if (!response.ok) throw new Error(`Notification provider returned HTTP ${response.status}`);
  if (approval.channel === "slack" && !(await response.json()).ok) throw new Error("Slack did not accept the notification.");
}
