export interface AppNotice {
  level: "error" | "warning";
  title: string;
  message: string;
  detail?: string;
}
