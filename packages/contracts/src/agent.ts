/** The page the administrator was looking at when sending a message; "这篇" means it. */
export interface AgentPageContext {
  kind: "article";
  id: string;
  title: string;
}

/** A material from the knowledge search that an answer cites as [n]: what the model was given, and where it came from. */
export interface AgentCitation {
  n: number;
  kind: "article" | "wechat_digest" | "wechat_messages";
  title: string;
  source: string;
  at: string | null;
  href: string | null;
  url: string | null;
  quote: string;
}

/** A step in an admin agent conversation, in the order it happened. */
export type AgentMessage =
  | { role: "user"; text: string; at: string; context?: AgentPageContext }
  /** `citations` are the materials an answer marks as [n]; `streaming` while the answer is still being written. */
  | { role: "agent"; text: string; at: string; citations?: AgentCitation[]; streaming?: boolean }
  /** A read-only tool the agent ran on its own; `summary` is what the page shows. */
  | { role: "tool"; tool: string; summary: string; ok: boolean; at: string }
  /** What became of a proposed change: carried out, failed, or called off. */
  | { role: "action"; proposalId: string; title: string; outcome: "done" | "failed" | "cancelled"; detail: string; at: string };

/** A change the agent wants to make; nothing happens until the administrator confirms it. */
export interface AgentProposal {
  id: string;
  tool: string;
  title: string;
  /** Plain lines for the confirmation card: what changes, from what to what. */
  lines: string[];
  /** A rough cost in CNY when the action pays a provider, else null. */
  costCny: number | null;
  costNote: string | null;
  args: Record<string, unknown>;
}

export interface AgentConversation {
  id: string;
  owner: string;
  title: string;
  status: "idle" | "thinking" | "awaiting" | "error";
  messages: AgentMessage[];
  pending: AgentProposal | null;
  error: string | null;
  updatedAt: string;
}

export interface AgentConversationSummary {
  id: string; title: string; status: AgentConversation["status"]; turns: number; updatedAt: string;
}
