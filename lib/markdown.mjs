// Slack Workflow Builder inserts our `text` variable into a plain-text context,
// so it does NOT render mrkdwn (`*bold*`, `_italic_`, `` `code` ``) and it does
// NOT decode HTML entities (`&amp;`). We therefore flatten Markdown to readable
// plain text and emit raw characters instead of entity escapes.

export function markdownToPlainText(markdown) {
  let text = String(markdown ?? "").replace(/\r\n?/g, "\n");

  // Fenced code blocks: keep the inner code, drop the ``` fences and language.
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_match, code) => `\n${code.replace(/\n+$/, "")}\n`);
  // Inline code: keep the content, drop the backticks.
  text = text.replace(/`([^`]+)`/g, "$1");

  // Images then links: keep the label and the address (Slack auto-links URLs).
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, alt, url) => (alt ? `${alt} (${url})` : url));
  text = text.replace(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_match, label, url) => {
    const trimmed = label.trim();
    return !trimmed || trimmed === url ? url : `${trimmed} (${url})`;
  });

  // Headings, blockquotes, and horizontal rules lose their markers.
  text = text.replace(/^#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "");

  // Bullet list markers become a simple bullet; numbered lists are left alone.
  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, (_match, indent) => `${indent}• `);

  // Emphasis and strikethrough: strip the markers, keep the words.
  // Underscore variants only apply at word boundaries so snake_case survives.
  text = text.replace(/(\*\*\*)(?=\S)([\s\S]+?)(?<=\S)\1/g, "$2");
  text = text.replace(/(^|[^\w_])___(?=\S)([\s\S]+?)(?<=\S)___(?!\w)/g, "$1$2");
  text = text.replace(/(\*\*)(?=\S)([\s\S]+?)(?<=\S)\1/g, "$2");
  text = text.replace(/(^|[^\w_])__(?=\S)([\s\S]+?)(?<=\S)__(?!\w)/g, "$1$2");
  text = text.replace(/(\*)(?=\S)([\s\S]+?)(?<=\S)\1/g, "$2");
  text = text.replace(/(^|[^\w_])_(?=\S)([\s\S]+?)(?<=\S)_(?!\w)/g, "$1$2");
  text = text.replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, "$1");

  // Undo Markdown backslash escapes (\* \_ \` etc.).
  text = text.replace(/\\([\\`*_{}\[\]()#+\-.!>~|])/g, "$1");

  // Decode the handful of HTML entities upstream escaping may have introduced,
  // since a plain-text field would otherwise show them literally.
  text = text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

  // Make any Slack mention/broadcast tokens inert so Pi output can't ping anyone.
  text = neutralizePlainMentions(text);

  // Tidy trailing spaces and collapse excess blank lines.
  return text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}

// Rewrites Slack's angle-bracket mention/link tokens (`<@U…>`, `<#C…|name>`,
// `<!channel>`) into plain, non-notifying text. Removing the angle brackets is
// enough: only the encoded `<…>` form pings; a bare `@name` never does.
export function neutralizePlainMentions(text) {
  return String(text ?? "").replace(/<([@#!])([^>\n]*)>/g, (_match, sigil, body) => {
    const label = body.includes("|") ? body.slice(body.indexOf("|") + 1) : body;
    const clean = label.replace(/^[@#]/, "").trim();
    if (sigil === "!") return clean || "notify"; // <!channel>/<!here> -> channel/here
    if (sigil === "#") return `#${clean}`; // channel reference
    return `@${clean}`; // user mention, now inert
  });
}
