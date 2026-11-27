import type { ClientBrowserTarget } from "@openbot/contracts/team-protocol/client-browser-v1";

export type PageAction =
  | { kind: "snapshot" }
  | { kind: "describe"; target: ClientBrowserTarget; action: "click" | "type" }
  | { kind: "click"; ref: string; label: string; destination?: string }
  | { kind: "type"; ref: string; label: string; value: string }
  | { kind: "scroll"; x: number; y: number }
  | { kind: "wait"; text: string };

export type PageControl = {
  ref: string;
  label: string;
  kind: "click" | "type" | "select";
  link: string | null;
  options?: string[];
  destination?: string;
};
export type PageResponse =
  | { kind: "error"; message: string }
  | { kind: "snapshot"; text: string; links: Array<{ label: string; url: string }>; controls: PageControl[] }
  | { kind: "control"; control: PageControl }
  | { kind: "done" }
  | { kind: "waiting" };

export function operatePage(expected: string, action: PageAction, deadline: number): PageResponse {
  const error = (message: string): PageResponse => ({ kind: "error", message });
  if (Date.now() >= deadline || location.href !== expected) return error("The page changed or the command expired.");
  const root = document.body;
  if (!root) return error("The page does not have visible content yet.");

  const scope: typeof globalThis & {
    openBotPilotControls?: { url: string; refs: Map<string, Element> };
  } = globalThis;
  const excluded = "script, style, noscript, template, iframe, [hidden], [inert], [aria-hidden=true]";
  const privateText = `${excluded}, form, input, textarea, select, [contenteditable], [role=textbox], [role=combobox]`;
  const unsafeNames =
    /password|passcode|one.?time|verification.?code|authenticat|credential|secret|security.?code|card.?number|cvv|cvc|payment|checkout|sign.?in|log.?in/iu;

  function visible(element: Element, exclusion: string): boolean {
    if (!element.isConnected || element.closest(exclusion)) return false;
    const css = getComputedStyle(element);
    return (
      css.visibility === "visible" &&
      css.opacity !== "0" &&
      (css.display === "contents" ||
        element.checkVisibility({
          checkOpacity: true,
          checkVisibilityCSS: true,
        }))
    );
  }

  function labelOf(element: Element): string {
    const labels =
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLButtonElement
        ? [...(element.labels ?? [])]
            .map((label) => {
              const text = label.cloneNode(true);
              if (!(text instanceof HTMLElement)) return "";
              for (const field of text.querySelectorAll("input, select, textarea, button, [aria-hidden=true]"))
                field.remove();
              return text.textContent ?? "";
            })
            .join(" ")
        : "";
    const references = (element.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/u)
      .slice(0, 5)
      .map((id) => document.getElementById(id)?.innerText ?? "")
      .join(" ")
      .trim();
    return (
      element.getAttribute("aria-label") ||
      references ||
      labels.trim() ||
      (element instanceof HTMLAnchorElement ||
      element instanceof HTMLButtonElement ||
      element.getAttribute("role") === "button"
        ? element.textContent
        : "") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      element.getAttribute("name") ||
      ""
    )
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 140);
  }

  function controlOf(element: Element, ref: string): PageControl | null {
    if (
      !visible(element, excluded) ||
      element.matches(":disabled, [aria-disabled=true]") ||
      element.closest("[aria-disabled=true]")
    )
      return null;
    const label = labelOf(element);
    const form =
      element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
        ? element.form
        : element.closest("form");
    if (
      !label ||
      unsafeNames.test(label) ||
      form?.querySelector(
        "input[type=password], [autocomplete*=password i], [autocomplete*=cc- i], [autocomplete=one-time-code i]",
      )
    )
      return null;
    if (element instanceof HTMLAnchorElement) {
      return element.matches("[download]") ? null : { ref, label, kind: "click", link: element.href };
    }
    if (element instanceof HTMLButtonElement || element.getAttribute("role") === "button") {
      if (element.matches("button[type=reset]") || element.closest("[contenteditable]")) return null;
      if (element instanceof HTMLButtonElement && element.type === "submit" && element.form) {
        const dest = new URL(element.hasAttribute("formaction") ? element.formAction : element.form.action, expected);
        if (
          dest.origin !== location.origin ||
          unsafeNames.test(dest.pathname) ||
          ((element.getAttribute("formtarget") ?? element.form.target) !== "" &&
            (element.getAttribute("formtarget") ?? element.form.target) !== "_self")
        )
          return null;
        return { ref, label, kind: "click", link: null, destination: dest.href };
      }
      return { ref, label, kind: "click", link: null };
    }
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLSelectElement
    ) {
      if (
        unsafeNames.test(`${element.name} ${element.id} ${element.autocomplete}`) ||
        /(?:^|\s)(?:cc-[^\s]+|one-time-code|username|webauthn)(?:\s|$)/iu.test(element.autocomplete)
      )
        return null;
      if (element instanceof HTMLSelectElement)
        return element.multiple
          ? null
          : {
              ref,
              label,
              kind: "select",
              link: null,
              options: [...element.options]
                .slice(0, 25)
                .filter((option) => !option.matches(":disabled"))
                .map((option) => option.label.slice(0, 100)),
            };
      if (
        element.readOnly ||
        (element instanceof HTMLInputElement &&
          !["text", "search", "email", "tel", "url", "number"].includes(element.type))
      )
        return null;
      return { ref, label, kind: "type", link: null };
    }
    return null;
  }

  function content(): string {
    const walker = document.createTreeWalker(document.querySelector("main, [role=main]") ?? root, NodeFilter.SHOW_TEXT);
    const lines: string[] = [];
    let size = 0;
    for (let n = 0; n < 12_000 && size < 24_000; n += 1) {
      const node = walker.nextNode();
      if (!node) break;
      const value = node.textContent?.trim().slice(0, 4000);
      if (value && node.parentElement && visible(node.parentElement, privateText)) {
        lines.push(value);
        size += value.length + 1;
      }
    }
    return lines.join("\n").slice(0, 24_000);
  }

  if (action.kind === "scroll") {
    window.scrollBy({ left: action.x, top: action.y, behavior: "instant" });
    return { kind: "done" };
  }
  if (action.kind === "wait") {
    return content().replace(/\s+/gu, " ").toLowerCase().includes(action.text.replace(/\s+/gu, " ").toLowerCase())
      ? { kind: "done" }
      : { kind: "waiting" };
  }

  if (action.kind === "snapshot") {
    const refs = new Map<string, Element>();
    const controls: PageControl[] = [];
    const prefix = crypto.getRandomValues(new Uint32Array(1))[0]?.toString(36);
    const elements = root.querySelectorAll("button, [role=button], input, textarea, select, a[href]");
    for (let index = 0; index < Math.min(2_400, elements.length) && controls.length < 150; index += 1) {
      const element = elements[index];
      if (!element) continue;
      const ref = `p${prefix}-${controls.length + 1}`;
      const control = controlOf(element, ref);
      if (!control) continue;
      refs.set(ref, element);
      controls.push(control);
    }
    scope.openBotPilotControls = { url: expected, refs };
    const links = [
      ...(document.querySelector("main, [role=main]") ?? root).querySelectorAll<HTMLAnchorElement>(
        "a[href]:not([download])",
      ),
    ]
      .slice(0, 1200)
      .filter((element) => visible(element, privateText))
      .slice(0, 120)
      .map((link) => ({ label: labelOf(link), url: link.href }));
    return { kind: "snapshot", text: content(), links, controls };
  }

  const refs = scope.openBotPilotControls?.url === expected ? scope.openBotPilotControls.refs : null;
  if (!refs) return error("Take a fresh snapshot of this tab first.");
  const matches: Array<{ element: Element; control: PageControl }> = [];
  for (const [ref, element] of refs) {
    if (action.kind === "describe") {
      const target = action.target;
      if ("ref" in target && ref !== target.ref) continue;
      if ("x" in target || "css" in target) return error("Use a snapshot reference or the exact visible label.");
    } else if (action.ref !== ref) continue;
    const control = controlOf(element, ref);
    if (!control) continue;
    if (
      action.kind === "describe" &&
      "text" in action.target &&
      control.label.toLowerCase() !== action.target.text.trim().toLowerCase()
    )
      continue;
    if ((action.kind === "describe" ? action.action : action.kind) === "type" && control.kind === "click") continue;
    matches.push({ element, control });
  }
  const matched = matches.length === 1 ? matches[0] : null;
  if (!matched) return error("The control is missing or ambiguous. Take a fresh snapshot and use its reference.");
  const { element, control } = matched;
  if (action.kind === "describe") return { kind: "control", control };
  if (control.label !== action.label) return error("The target label changed after approval.");
  if (action.kind === "click") {
    if (control.destination !== action.destination) return error("The form destination changed after approval.");
    if (!(element instanceof HTMLElement) || control.kind !== "click" || control.link !== null)
      return error("This control does not support a button click.");
    element.click();
    return { kind: "done" };
  }
  if (element instanceof HTMLSelectElement) {
    const options = [...element.options].filter(
      (option) =>
        !option.matches(":disabled") &&
        !option.closest("optgroup[disabled]") &&
        (option.value === action.value || option.label.toLowerCase() === action.value.trim().toLowerCase()),
    );
    if (options.length !== 1 || !options[0]) return error("Use the exact label of one enabled option.");
    element.value = options[0].value;
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, action.value);
  } else return error("This field does not support text entry.");
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { kind: "done" };
}
