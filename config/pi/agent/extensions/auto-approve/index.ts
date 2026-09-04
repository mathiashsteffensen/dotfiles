import {
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

const logFile = path.join(getAgentDir(), "extensions/auto-approve/results.log");
const rotatedLogFile = `${logFile}.1`;
const maxLogBytes = 1024 * 1024;

const log = (modelId: string, result: string, response: unknown) => {
  const entry = [
    `Model: ${modelId}`,
    `Result: ${result}`,
    `Response: ${JSON.stringify(response, undefined, "  ")}`,
    "",
  ].join("\n");

  try {
    const entryWithNewline = `${entry}\n`;
    const currentLogBytes = fs.existsSync(logFile)
      ? fs.statSync(logFile).size
      : 0;
    const entryBytes = Buffer.byteLength(entryWithNewline, "utf8");

    if (currentLogBytes + entryBytes > maxLogBytes) {
      fs.rmSync(rotatedLogFile, { force: true });
      fs.renameSync(logFile, rotatedLogFile);
    }

    fs.appendFileSync(logFile, entryWithNewline, "utf8");
  } catch {
    // Logging must not change the safety decision.
  }
};

export default function (pi: ExtensionAPI) {
  let currentPrompt = "";

  // Capture the prompt for context
  pi.on("before_agent_start", (event) => {
    currentPrompt = event.prompt;
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;

    const command = event.input.command;
    if (typeof command !== "string") {
      return {
        block: true,
        reason: "Command blocked because its input was invalid",
      };
    }

    const evaluateSafety = async (
      prompt: string,
      cmd: string,
    ): Promise<boolean> => {
      const model = ctx.modelRegistry.find("openai-codex", "gpt-5.6-luna");
      if (!model) {
        log("gpt-5.6-luna", "UNSAFE", { error: "Safety model is unavailable" });
        return false;
      }

      try {
        const data = await ctx.modelRegistry.complete(
          model,
          {
            systemPrompt: [
              "You are a security classifier.",
              "Determine whether the user prompt and shell command are safe to execute.",
              "A command is unsafe if it deletes files, changes permissions, or accesses sensitive information in a way that contradicts the user's intent.",
              "Respond with exactly one token: SAFE or UNSAFE.",
            ].join(" "),
            messages: [
              {
                role: "user",
                content: `User Prompt: ${prompt}\n\nCommand: ${cmd}`,
                timestamp: Date.now(),
              },
            ],
          },
          {
            reasoningEffort: "minimal",
            reasoningSummary: "concise",
            signal: ctx.signal,
            timeoutMs: 30_000,
          },
        );

        const text = data.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("")
          .trim()
          .toUpperCase();
        const isSafe = data.stopReason === "stop" && text === "SAFE";

        log(model.id, isSafe ? "SAFE" : "UNSAFE", {
          reasoning: data.content
            .filter((content) => content.type === "thinking")
            .map((content) => content.thinking)
            .join(". "),
          stopReason: data.stopReason,
          errorMessage: data.errorMessage,
          text,
        });

        return isSafe;
      } catch (error) {
        log(model.id, "UNSAFE", {
          error:
            error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error),
        });
        return false;
      }
    };

    const isSafe = await evaluateSafety(currentPrompt, command);

    if (!isSafe) {
      if (!ctx.hasUI) {
        return {
          block: true,
          reason:
            "Command deemed unsafe by Auto-Approve AI (no UI available for confirmation)",
        };
      }

      const confirmed = await ctx.ui.confirm(
        `⚠️ Auto-Approve AI flagged this command as unsafe:`,
        `Command: ${command}\n\nDo you want to proceed?`,
      );

      if (!confirmed) {
        return {
          block: true,
          reason: "Blocked by user after Auto-Approve AI warning",
        };
      }
    }
  });
}
