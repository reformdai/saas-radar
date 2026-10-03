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
  messages: WechatMessage[];
  hasMore: boolean;
}
