import type { ThemeRegistration } from "shiki/core";

export const SHIKI_THEME_NAME = "cw-code";

export type SyntaxRole =
  | "comment"
  | "keyword"
  | "control"
  | "string"
  | "regexp"
  | "escape"
  | "number"
  | "constant"
  | "enum"
  | "function"
  | "type"
  | "variable"
  | "parameter"
  | "property"
  | "tag"
  | "tag-punctuation"
  | "attribute"
  | "selector"
  | "operator"
  | "heading"
  | "link"
  | "inserted"
  | "deleted"
  | "invalid";

export function roleColor(role: SyntaxRole): string {
  return `var(--syn-${role})`;
}

const ROLE_SCOPES: ReadonlyArray<{ role: SyntaxRole; scope: string[]; fontStyle?: string }> = [
  { role: "comment", scope: ["comment", "punctuation.definition.comment", "string.comment"] },
  { role: "string", scope: ["string", "meta.embedded.assembly", "markup.inline.raw", "markup.fenced_code.block", "support.constant.property-value", "support.constant.font-name", "support.constant.media-type", "support.constant.media", "constant.other.color.rgb-value", "constant.other.rgb-value", "support.constant.color", "markup.quote"] },
  { role: "regexp", scope: ["string.regexp", "constant.character.character-class.regexp", "constant.other.character-class.regexp"] },
  { role: "escape", scope: ["constant.character.escape", "constant.character", "constant.other.placeholder", "punctuation.definition.template-expression", "punctuation.section.embedded"] },
  { role: "number", scope: ["constant.numeric", "keyword.other.unit", "constant.other.unit"] },
  { role: "constant", scope: ["constant.language", "variable.language", "support.constant.math", "constant.other.boolean"] },
  { role: "enum", scope: ["variable.other.constant", "variable.other.enummember", "constant.other.enum", "entity.name.constant", "constant.other.caps", "support.constant"] },
  { role: "keyword", scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.operator.new", "keyword.operator.expression", "keyword.operator.cast", "keyword.operator.sizeof", "keyword.operator.alignof", "keyword.operator.typeid", "keyword.operator.alignas", "keyword.operator.instanceof", "keyword.operator.logical.python", "keyword.operator.wordlike", "keyword.other.using", "keyword.other.directive", "meta.preprocessor", "entity.name.function.preprocessor", "markup.changed"] },
  { role: "control", scope: ["keyword.control", "source.cpp keyword.operator.new", "keyword.operator.delete", "keyword.other.operator", "entity.name.operator", "keyword.control.flow", "keyword.control.import", "keyword.control.export", "keyword.control.from", "keyword.control.conditional", "keyword.control.loop"] },
  { role: "operator", scope: ["keyword.operator", "punctuation.accessor", "punctuation.separator.key-value"] },
  { role: "function", scope: ["entity.name.function", "support.function", "support.constant.handlebars", "source.powershell variable.other.member", "entity.name.operator.custom-literal", "meta.function-call.generic", "support.function.git-rebase"] },
  { role: "type", scope: ["entity.name.type", "entity.name.class", "entity.name.namespace", "entity.name.scope-resolution", "entity.other.inherited-class", "support.class", "support.type", "entity.name.struct", "entity.name.interface", "entity.name.enum", "storage.type.numeric.go", "storage.type.byte.go", "storage.type.boolean.go", "storage.type.string.go", "storage.type.uintptr.go", "storage.type.error.go", "storage.type.rune.go", "storage.type.cs", "storage.type.generic.cs", "storage.type.modifier.cs", "storage.type.variable.cs", "storage.type.annotation.java", "storage.type.generic.java", "storage.type.java", "storage.type.object.array.java", "storage.type.primitive.array.java", "storage.type.primitive.java", "storage.type.token.java", "storage.type.groovy", "storage.type.annotation.groovy", "storage.type.parameters.groovy", "storage.type.generic.groovy", "storage.type.object.array.groovy", "storage.type.primitive.array.groovy", "storage.type.primitive.groovy", "meta.type.cast.expr", "meta.type.new.expr", "support.constant.dom", "support.constant.json", "entity.other.attribute-name.pseudo-class.css"] },
  { role: "variable", scope: ["variable", "meta.definition.variable.name", "support.variable", "entity.name.variable", "variable.other.readwrite"] },
  { role: "parameter", scope: ["variable.parameter", "meta.parameter", "entity.name.variable.parameter"] },
  { role: "property", scope: ["variable.other.property", "variable.other.object.property", "support.variable.property", "meta.object-literal.key", "support.type.property-name", "entity.name.tag.yaml", "support.type.vendored.property-name", "variable.other.member", "entity.name.variable.field", "entity.name.variable.property"] },
  { role: "tag", scope: ["entity.name.tag", "meta.tag.sgml", "markup.deleted.git_gutter", "support.class.component"] },
  { role: "tag-punctuation", scope: ["punctuation.definition.tag"] },
  { role: "attribute", scope: ["entity.other.attribute-name", "entity.other.attribute-name.html"] },
  { role: "selector", scope: ["entity.other.attribute-name.class.css", "entity.other.attribute-name.class.mixin.css", "entity.other.attribute-name.id.css", "entity.other.attribute-name.parent-selector.css", "entity.other.attribute-name.pseudo-element.css", "source.css.less entity.other.attribute-name.id", "entity.other.attribute-name.scss", "entity.name.tag.css", "entity.other.attribute-name.attribute.scss"] },
  { role: "heading", scope: ["markup.heading", "entity.name.section", "markup.heading.setext"], fontStyle: "bold" },
  { role: "link", scope: ["markup.underline.link", "string.other.link"] },
  { role: "inserted", scope: ["markup.inserted", "meta.diff.header.to-file", "punctuation.definition.inserted"] },
  { role: "deleted", scope: ["markup.deleted", "meta.diff.header.from-file", "punctuation.definition.deleted"] },
  { role: "invalid", scope: ["invalid", "invalid.illegal"] }
];

export const shikiTheme: ThemeRegistration = {
  name: SHIKI_THEME_NAME,
  type: "dark",
  fg: "var(--syn-fg)",
  bg: "transparent",
  settings: [
    { settings: { foreground: "var(--syn-fg)", background: "transparent" } },
    ...ROLE_SCOPES.map(({ role, scope, fontStyle }) => ({
      scope,
      settings: fontStyle ? { foreground: roleColor(role), fontStyle } : { foreground: roleColor(role) }
    })),
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
    { scope: ["markup.strikethrough"], settings: { fontStyle: "strikethrough" } },
    { scope: ["markup.underline"], settings: { fontStyle: "underline" } }
  ]
};
