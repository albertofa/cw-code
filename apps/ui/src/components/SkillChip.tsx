import { Package } from "lucide-react";

export function SkillChip({ name, raw }: { name: string; raw: string }) {
  return (
    <span className="skill-chip" title={`Skill: ${name}`} data-raw={raw}>
      <Package size={12} strokeWidth={2} aria-hidden="true" />
      <span className="skill-chip-name">
        <span className="skill-chip-sigil">{raw.charAt(0)}</span>
        {name}
      </span>
    </span>
  );
}
