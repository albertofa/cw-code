import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useSidebarStore } from "../stores/sidebarStore.js";
import { requestComposerFocus } from "./composerFocus.js";

export function SidebarToggle({ className = "" }: { className?: string }) {
  const collapsed = useSidebarStore((s) => s.collapsed);
  const toggle = useSidebarStore((s) => s.toggle);
  const label = collapsed ? "Show sidebar (Ctrl+B)" : "Hide sidebar (Ctrl+B)";
  const Icon = collapsed ? PanelLeftOpen : PanelLeftClose;
  return (
    <button
      type="button"
      className={`icon-btn side-toggle${className ? ` ${className}` : ""}`}
      onClick={() => {
        toggle();
        requestComposerFocus();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
    >
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}
