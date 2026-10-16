// Entry points to 小雷 inside pages; rendered only once the browser knows it holds an admin session, so
// visitors and shared caches get the same HTML as before.
import type { ReactNode } from "react";
import type { AgentPageContext } from "@aihot/contracts/agent";
import { openAssistant, useAssistant } from "./store";

export function AdminOnly({ children }: { children: ReactNode }) {
  return useAssistant().admin ? <>{children}</> : null;
}

/** Opens the panel with this article attached, so "这篇" means it. */
export function AskAssistant({ page, className = "", children = "问小雷关于这篇 →" }: { page: AgentPageContext; className?: string; children?: ReactNode }) {
  if (!useAssistant().admin) return null;
  return <button type="button" onClick={() => openAssistant({ page })} className={className}>{children}</button>;
}
