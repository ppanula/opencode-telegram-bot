/**
 * Session forking helpers — "logical fork" of a OpenCode session.
 *
 * A fork is a fresh session in the same project, *primed* with the recent
 * transcript of the session it continues, so the conversation survives when the
 * original can't be used: its exclusive lock is held by another window, or it
 * got throttled / exhausted / stuck mid-turn. Used by:
 *   • lost-session recovery (a persisted session we can't reload), and
 *   • auto-fork-on-error (a transient prompt failure with no streamed output).
 */
import type { SessionStore } from "../sessions/store.js";
import { buildTranscript } from "../sessions/history.js";

/** Read a compact transcript of a session's recent history, or "". */
export function recentTranscript(store: SessionStore, sessionId: string, entries = 24): string {
  try {
    const hist = store.readHistory(sessionId, entries);
    return hist.length > 0 ? buildTranscript(hist) : "";
  } catch {
    return "";
  }
}

/** Priming preamble injected as context into a forked (linked) continuation. */
export function buildPriming(transcript: string): string {
  return transcript
    ? [
        "The conversation below was from a related session which cannot be continued directly.",
        "Use its context to understand what was being worked on, then respond naturally to the user's new prompt.",
        "",
        "--- previous session transcript ---",
        transcript,
        "--- end transcript ---",
      ].join("\n")
    : "";
}
