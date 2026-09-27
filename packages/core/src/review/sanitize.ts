// Every prompt section ocra writes is an XML-like tag starting with `ocra_`
// (<ocra_file>, <ocra_findings>, ...), so ordinary markup in reviewed code
// (<title> in HTML, <description> in a pom.xml) reaches the model unchanged.
export const PROMPT_TAG_PREFIX = "ocra_";

const TAG_PATTERN = new RegExp(`<(/?)(${PROMPT_TAG_PREFIX})`, "gi");

// Untrusted text must not be able to close or open one of our prompt sections
// and smuggle content outside it: any tag with our prefix loses its "<".
export function neutralizeTags(text: string): string {
  return text.replace(TAG_PATTERN, "‹$1$2");
}

export function escapeAttribute(value: string): string {
  return neutralizeTags(value).replaceAll('"', "&quot;");
}
