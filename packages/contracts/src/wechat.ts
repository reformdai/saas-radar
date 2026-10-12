export interface WechatGroup {
  account: string;
  group_id: string;
  name: string;
  enabled: boolean;
  reconcile_through: number;
  last_received_at: string | null;
  last_checked_at: string | null;
  message_count?: number;
}

export interface WechatMessage {
  message_id: string;
  group_id: string;
  sender_id: string;
  sender_name: string;
  content: string;
  sent_at: number;
  revoked: boolean;
}

export interface WechatEvent extends WechatMessage {
  group_name: string;
}

export interface WechatIntake {
  account: string;
  groups?: Array<{ id: string; name: string }>;
  initialSince?: number;
  events?: WechatEvent[];
  checkpoints?: Array<{ groupId: string; through: number }>;
}

export interface WechatInbox {
  ready: boolean;
  groups: WechatGroup[];
  candidates: Array<{ account: string; group_id: string; name: string; selected: boolean; last_seen_at: string }>;
  messages: WechatMessage[];
  hasMore: boolean;
}

export interface WechatDigestPoint {
  title: string;
  summary: string;
  evidenceIds: string[];
}

export interface WechatDigest {
  account: string;
  group_id: string;
  name: string;
  day: string;
  status: "pending" | "ready" | "error";
  points: WechatDigestPoint[];
  message_count: number;
  updated_at: string;
  error: string | null;
}

export interface WechatDigestFeed {
  ready: boolean;
  enabled: boolean;
  items: WechatDigest[];
  hasMore: boolean;
}

export interface WechatDigestDetail {
  digest: WechatDigest;
  messages: WechatMessage[];
}
