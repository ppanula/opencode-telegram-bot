/**
 * Executes a scheduled task: opens a fresh session in the task's project,
 * sends the prompt, and delivers the result to the chat.
 *
 * When `taskLiveStream` is on (default), the turn streams live via
 * ResponseStreamer — thinking, tool cards, and prose appear in real-time,
 * just like an interactive turn. When off, the old v2.0.0 behaviour is used:
 * output is collected silently and sent as a single message on completion.
 */
import type { Api } from "grammy";
import { basename } from "node:path";
import type { OpenCodeClient } from "../opencode/client.js";
import type { SessionUpdate } from "../opencode/types.js";
import { createLogger } from "../logger.js";
import { sendMarkdownDoc, safeSend } from "../bot/telegram-io.js";
import { ResponseStreamer } from "../stream/streamer.js";
import { formatToolCall } from "../render/tool-call.js";
import type { Task } from "./types.js";
import type { AppConfig } from "../config.js";

const log = createLogger("task-runner");

export class TaskRunner {
  constructor(
    private readonly api: Api,
    private readonly acp: OpenCodeClient,
    private readonly cfg: AppConfig,
  ) {}

  /** Run a task; resolves true on success, false on error. */
  async run(task: Task): Promise<boolean> {
    if (this.cfg.taskLiveStream) return this.runLive(task);
    return this.runSilent(task);
  }

  // ── Live-streaming mode (taskLiveStream=true, default) ──────────────────

  private async runLive(task: Task): Promise<boolean> {
    log.info(`running task "${task.name}" in ${task.projectPath}`);
    let sessionId = "";

    const project = task.projectName || basename(task.projectPath);

    const streamer = new ResponseStreamer(
      this.api,
      task.chatId,
      this.cfg.streamThrottleMs,
      undefined,
      `\u23F0 **Task:** ${task.name} \u00B7 ${project}`,
    );

    const listener = (sid: string, u: SessionUpdate): void => {
      if (sid !== sessionId) return;

      if (u.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") {
        streamer.appendOutput(u.content.text);
      } else if (u.sessionUpdate === "agent_thought_chunk" && typeof u.content?.text === "string") {
        streamer.appendThought(u.content.text);
      } else if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") {
        if (!this.cfg.showToolCalls) return;
        const md = formatToolCall(u, {
          showDiffs: this.cfg.showEditDiffs,
          diffMaxLines: this.cfg.diffMaxLines,
        });
        if (md) {
          const id = u.toolCallId || `${u.sessionUpdate}:${u.title ?? ""}`;
          streamer.upsertTool(id, md);
        }
      }
    };

    try {
      sessionId = await this.acp.newSession(task.projectPath);
      if (task.agent) {
        try {
          await this.acp.setMode(sessionId, task.agent);
        } catch {
          /* best-effort */
        }
      }
      this.acp.on("session-update", listener);
      await this.acp.prompt(sessionId, [{ type: "text", text: task.prompt }]);
      this.acp.off("session-update", listener);
      streamer.completeFallback();
      await streamer.finalize();

      if (!streamer.hasOutput) {
        await sendMarkdownDoc(
          this.api,
          task.chatId,
          `\u23F0 **Task: ${task.name}** \u00B7 ${project}\n\n_(no text output)_`,
          { loud: true },
        );
      }

      return true;
    } catch (err) {
      this.acp.off("session-update", listener);
      await streamer.finalize();
      await this.deliverError(task, (err as Error).message);
      log.error(`task "${task.name}" failed:`, (err as Error).message);
      return false;
    }
  }

  // ── Silent mode (taskLiveStream=false, v2.0.0 behaviour) ────────────────

  private async runSilent(task: Task): Promise<boolean> {
    log.info(`running task "${task.name}" in ${task.projectPath} (silent)`);
    let sessionId = "";
    let text = "";
    let tools = 0;
    const seen = new Set<string>();

    const listener = (sid: string, u: SessionUpdate): void => {
      if (sid !== sessionId) return;
      if (u.sessionUpdate === "agent_message_chunk" && typeof u.content?.text === "string") {
        text += u.content.text;
      } else if (u.sessionUpdate === "tool_call") {
        const id = u.toolCallId || u.title || String(tools);
        if (!seen.has(id)) {
          seen.add(id);
          tools++;
        }
      }
    };

    try {
      sessionId = await this.acp.newSession(task.projectPath);
      if (task.agent) {
        try {
          await this.acp.setMode(sessionId, task.agent);
        } catch {
          /* best-effort */
        }
      }
      this.acp.on("session-update", listener);
      await this.acp.prompt(sessionId, [{ type: "text", text: task.prompt }]);
      this.acp.off("session-update", listener);
      await this.deliver(task, text, tools);
      return true;
    } catch (err) {
      this.acp.off("session-update", listener);
      await this.deliverError(task, (err as Error).message);
      log.error(`task "${task.name}" failed:`, (err as Error).message);
      return false;
    }
  }

  private async deliver(task: Task, text: string, tools: number): Promise<void> {
    const project = task.projectName || basename(task.projectPath);
    const body = text.trim() || "_(no text output)_";
    const footer = tools > 0 ? `\n\n\u{1F527} ${tools} tool call(s)` : "";
    const header = `\u23F0 **Task: ${task.name}** \u00B7 ${project}`;
    await sendMarkdownDoc(this.api, task.chatId, `${header}\n\n${body}${footer}`, { loud: true });
  }

  private async deliverError(task: Task, message: string): Promise<void> {
    try {
      await safeSend(
        this.api,
        task.chatId,
        `\u274C Task "${task.name}" failed: ${message}`,
        `Task "${task.name}" failed: ${message}`,
        { disable_notification: false },
      );
    } catch {
      /* non-fatal */
    }
  }
}
