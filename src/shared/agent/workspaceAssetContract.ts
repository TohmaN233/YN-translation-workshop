export const CHARACTER_BIBLE_SECTION_TEMPLATE = [
  "# Character Bible",
  "",
  "## <source name> / <target name>",
  "- Source/target name: <source> -> <target>",
  "- Identity/role: <identity, role, faction>",
  "- Gender/pronouns: <gender; pronouns> (confidence: confirmed|inferred|unknown)",
  "- Voice/register: <voice and register>",
  "- Relationships: <known relationships or unknown>",
  "- Terms of address: <forms of address or unknown>",
  "- Required terms: <source -> target; only in this character's quoted speech, never a name>",
  "- Catchphrases: <recurring expressions or unknown>",
  "- Evidence: <file and nearby source context supporting the facts>"
].join("\n");

export const CHARACTER_BIBLE_BUILD_INSTRUCTIONS = [
  "Generate AI_translation/_workspace/character_bible.md before spawning translation subagents.",
  "Write exactly one ## section per character using this Markdown template (replace every angle-bracket value):",
  CHARACTER_BIBLE_SECTION_TEMPLATE,
  "Before writing the character bible, use searchProjectText for every character whose gender/pronouns are not already established, then read the nearby source context that contains pronouns, titles, relationships, or self-identification.",
  "Stop searching that character once the evidence establishes the fact; use unknown only after the available project context and configured canon references remain insufficient.",
  "Required terms use `source -> target` only for that character's quoted speech. Never put a character name there.",
  "Never infer gender from a translated name alone. Evidence must name the supporting file/context, and inferred facts must remain marked inferred."
].join("\n");
