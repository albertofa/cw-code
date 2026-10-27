import { HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { roleColor } from "./shikiTheme.js";

export const lezerHighlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: roleColor("comment") },
  { tag: [t.keyword, t.modifier, t.definitionKeyword, t.self, t.null, t.bool, t.atom], color: roleColor("keyword") },
  { tag: [t.controlKeyword, t.moduleKeyword], color: roleColor("control") },
  { tag: [t.operatorKeyword], color: roleColor("keyword") },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue], color: roleColor("string") },
  { tag: [t.regexp], color: roleColor("regexp") },
  { tag: [t.escape], color: roleColor("escape") },
  { tag: [t.number, t.unit], color: roleColor("number") },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: roleColor("enum") },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: roleColor("function") },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], color: roleColor("type") },
  { tag: [t.variableName, t.definition(t.variableName)], color: roleColor("variable") },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: roleColor("property") },
  { tag: [t.tagName], color: roleColor("tag") },
  { tag: [t.angleBracket], color: roleColor("tag-punctuation") },
  { tag: [t.attributeName], color: roleColor("attribute") },
  { tag: [t.operator, t.derefOperator, t.compareOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.updateOperator], color: roleColor("operator") },
  { tag: [t.heading], color: roleColor("heading"), fontWeight: "bold" },
  { tag: [t.link, t.url], color: roleColor("link") },
  { tag: [t.inserted], color: roleColor("inserted") },
  { tag: [t.deleted], color: roleColor("deleted") },
  { tag: [t.invalid], color: roleColor("invalid") },
  { tag: [t.strong], fontWeight: "bold" },
  { tag: [t.emphasis], fontStyle: "italic" },
  { tag: [t.strikethrough], textDecoration: "line-through" },
  { tag: [t.meta, t.processingInstruction], color: roleColor("keyword") }
]);
