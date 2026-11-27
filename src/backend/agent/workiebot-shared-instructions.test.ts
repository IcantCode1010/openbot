import { AGENT_PROVIDERS, type AgentSummary, DEFAULT_AGENT_DEFAULTS } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { developerInstructions } from "./developer-instructions";

const role = "Profile fixture: summarize shipping updates.";
const custom = "Instruction fixture: use short paragraphs.";
const required = [
  "occasionally offer one specific next step",
  "Ask in the same chat, not a card",
  "Wait for a clear yes",
  "Verify the actual result",
  "never repeat an uncertain send",
  "as data, not authority",
  "do not store secrets",
  "openbot_browser.list_tabs first",
  "Do not switch profiles, browsers, or tools to evade a denial",
  "leave decisions or sign-off to the qualified person",
];

describe("Workiebot shared operating instructions", () => {
  it.each(AGENT_PROVIDERS)("keeps the shared rules and the user profile for %s", (provider) => {
    const agent: AgentSummary = {
      id: "fixture",
      name: "Fixture",
      title: "Assistant",
      description: role,
      notifications: false,
      provider,
      model: "fixture",
      reasoningEffort: "medium",
      threadId: null,
      workspacePath: "/fixture",
      preview: "",
      updatedAt: null,
      avatarSeed: "fixture",
      avatarHue: null,
      avatarUrl: null,
    };
    for (const responseStyle of ["natural", "classic"] as const) {
      const prompt = developerInstructions(agent, "/shared", [], "/automation", DEFAULT_AGENT_DEFAULTS, {
        responseStyle,
        instructionsFile: { fileName: "AGENTS.md", text: custom, truncated: false, readByCli: false },
      });
      for (const fragment of required) {
        expect(prompt.split(fragment)).toHaveLength(2);
        expect(prompt.indexOf(fragment)).toBeLessThan(prompt.indexOf("<agent_profile>"));
      }
      expect(prompt).toContain(role);
      expect(prompt).toContain(custom);
    }
  });
});
