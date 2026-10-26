export type TopicOp =
  | { op: "upsert"; key: string; value: unknown }
  | { op: "remove"; key: string }
  | { op: "append"; key: string; field: string; text: string }
  | { op: "replace"; value: Record<string, unknown> };

export interface TopicSnapshot<D = Record<string, unknown>> {
  rev: number;
  data: D;
}

export type TopicsSubscribeResult = Record<string, TopicSnapshot>;

export interface TopicPatch {
  topic: string;
  rev: number;
  ops: TopicOp[];
}
