// The assistant panel's shared state: who is signed in (asked once in the browser, so public pages stay
// the same cacheable HTML for everyone), whether the panel is open, which conversation it shows, and
// the page the administrator is reading. Pages and buttons reach it without prop drilling.
import { useEffect, useSyncExternalStore } from "react";
import type { AdminMe } from "@aihot/contracts/admin";
import type { AgentPageContext } from "@aihot/contracts/agent";

interface State {
  /** undefined until asked; null for a visitor. */
  admin: AdminMe | null | undefined;
  open: boolean;
  conversationId: string | null;
  /** The page being read; sent with the next message unless dismissed. */
  page: AgentPageContext | null;
  pageDismissed: boolean;
}

const STORAGE = "aihot:assistant";
let state: State = { admin: undefined, open: false, conversationId: null, page: null, pageDismissed: false };
const listeners = new Set<() => void>();

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
  if ("open" in patch || "conversationId" in patch) {
    try { localStorage.setItem(STORAGE, JSON.stringify({ open: state.open, conversationId: state.conversationId })); } catch { /* private mode */ }
  }
}

let asked = false;
/** Asks the API once per page load whether this browser holds an admin session. */
export function detectAdmin() {
  if (asked) return;
  asked = true;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE) ?? "{}") as { open?: boolean; conversationId?: string | null };
    state = { ...state, open: !!saved.open, conversationId: saved.conversationId ?? null };
  } catch { /* nothing saved */ }
  fetch("/api/admin/me", { credentials: "same-origin", headers: { accept: "application/json" } })
    .then(async (r) => set({ admin: r.ok ? await r.json() as AdminMe : null }))
    .catch(() => set({ admin: null }));
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const SERVER: State = { admin: undefined, open: false, conversationId: null, page: null, pageDismissed: false };
export function useAssistant(): State {
  return useSyncExternalStore(subscribe, () => state, () => SERVER);
}

export function openAssistant(opts: { page?: AgentPageContext; fresh?: boolean } = {}) {
  set({ open: true, ...(opts.page ? { page: opts.page, pageDismissed: false } : {}), ...(opts.fresh ? { conversationId: null } : {}) });
}
export const closeAssistant = () => set({ open: false });
export const toggleAssistant = () => set({ open: !state.open });
export const showConversation = (conversationId: string | null) => set({ conversationId });
export const dismissPage = () => set({ pageDismissed: true });

/** A page tells the assistant what is being read while it is mounted. */
export function useAssistantPage(page: AgentPageContext | null) {
  const key = page ? `${page.kind}:${page.id}` : "";
  useEffect(() => {
    if (!page) return;
    set({ page, pageDismissed: false });
    return () => { if (state.page && `${state.page.kind}:${state.page.id}` === key) set({ page: null }); };
  }, [key]);
}
