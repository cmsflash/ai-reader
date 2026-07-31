"use client";

import {
  ArrowUp,
  AudioLines,
  MessageCircle,
  Mic,
  MicOff,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

export type ArticleDiscussionScope =
  | {
      kind: "whole";
    }
  | {
      kind: "selection";
      text: string;
    };

type DiscussionMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type DiscussionResponse = {
  reply: string;
  responseId?: string;
  incomplete: boolean;
  context: {
    scope: "whole" | "selection";
    truncated: boolean;
    originalCharacters: number;
    includedCharacters: number;
    note?: string;
  };
};

type VoiceState =
  "idle" | "connecting" | "listening" | "thinking" | "speaking" | "error";

type ArticleDiscussionProps = {
  articleId: string;
  articleTitle: string;
  open: boolean;
  scope: ArticleDiscussionScope;
  onClose: () => void;
  onSwitchToWhole: () => void;
  onBeforeVoiceStart: () => void;
};

const maxHistoryItems = 12;
const maxHistoryItemCharacters = 4_000;
const maxHistoryCharacters = 24_000;

export function ArticleDiscussion({
  articleId,
  articleTitle,
  open,
  scope,
  onClose,
  onSwitchToWhole,
  onBeforeVoiceStart,
}: ArticleDiscussionProps) {
  const [messages, setMessages] = useState<DiscussionMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextNote, setContextNote] = useState<string | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const conversationKeyRef = useRef("");
  const drawerRef = useRef<HTMLElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const conversationKey = useMemo(
    () =>
      scope.kind === "whole"
        ? `${articleId}:whole`
        : `${articleId}:selection:${scope.text}`,
    [articleId, scope],
  );
  const {
    state: voiceState,
    muted,
    error: voiceError,
    contextNote: voiceContextNote,
    start: startVoice,
    stop: stopVoice,
    toggleMute,
  } = useArticleVoice({
    articleId,
    scope,
    onBeforeStart: onBeforeVoiceStart,
  });

  useEffect(() => {
    conversationKeyRef.current = conversationKey;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    setMessages([]);
    setDraft("");
    setIsSending(false);
    setError(null);
    setContextNote(null);

    return () => requestControllerRef.current?.abort();
  }, [conversationKey]);

  useEffect(() => {
    if (!open) {
      requestControllerRef.current?.abort();
      requestControllerRef.current = null;
      setIsSending(false);
      stopVoice();
      return;
    }

    previouslyFocusedRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const background = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".app-surface, .selection-discuss-button",
      ),
    );
    const previousInert = background.map((element) =>
      element.hasAttribute("inert"),
    );

    background.forEach((element) => element.setAttribute("inert", ""));
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 80);

    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== "Tab" || !drawerRef.current) {
        return;
      }

      const focusable = focusableElements(drawerRef.current);

      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleDialogKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleDialogKeyDown);
      background.forEach((element, index) => {
        if (!previousInert[index]) {
          element.removeAttribute("inert");
        }
      });
      previouslyFocusedRef.current?.focus();
    };
  }, [onClose, open, stopVoice]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages, isSending]);

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();

    if (!message || isSending) {
      return;
    }

    const userMessage: DiscussionMessage = {
      id: messageId(),
      role: "user",
      content: message,
    };
    const history = boundedDiscussionHistory(messages);
    const capturedConversationKey = conversationKey;
    const controller = new AbortController();

    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    setMessages((current) => [...current, userMessage]);
    setDraft("");
    setError(null);
    setIsSending(true);

    try {
      const response = await fetch("/api/discussion", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          articleId,
          scope: scope.kind,
          selection: scope.kind === "selection" ? scope.text : undefined,
          message,
          history,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as
        DiscussionResponse | { error?: string };

      if (
        controller.signal.aborted ||
        conversationKeyRef.current !== capturedConversationKey
      ) {
        return;
      }

      if (!response.ok || !("reply" in body)) {
        throw new Error(
          "error" in body && body.error
            ? body.error
            : `Discussion request failed with ${response.status}.`,
        );
      }

      setMessages((current) => [
        ...current,
        {
          id: body.responseId ?? messageId(),
          role: "assistant",
          content: body.reply,
        },
      ]);
      setContextNote(
        body.context.note ??
          (body.context.truncated
            ? "The article exceeded the live context limit, so the discussion uses the included portion."
            : null),
      );
      if (body.incomplete) {
        setError(
          "The response stopped early. Ask again or narrow the question.",
        );
      }
    } catch (requestError) {
      if (
        !controller.signal.aborted &&
        conversationKeyRef.current === capturedConversationKey
      ) {
        setError(messageFromError(requestError));
      }
    } finally {
      if (requestControllerRef.current === controller) {
        requestControllerRef.current = null;
        if (conversationKeyRef.current === capturedConversationKey) {
          setIsSending(false);
        }
      }
    }
  }

  if (!open) {
    return null;
  }

  const voiceActive = voiceState !== "idle" && voiceState !== "error";
  const voiceConnected =
    voiceState === "listening" ||
    voiceState === "thinking" ||
    voiceState === "speaking";

  return (
    <>
      <button
        className="discussion-scrim"
        type="button"
        tabIndex={-1}
        aria-label="Close article discussion"
        onClick={onClose}
      />
      <aside
        ref={drawerRef}
        className="discussion-drawer"
        aria-label={`Discuss ${articleTitle}`}
        aria-modal="true"
        role="dialog"
      >
        <header className="discussion-header">
          <div>
            <span className="discussion-eyebrow">
              <MessageCircle size={15} />
              Article discussion
            </span>
            <h3>
              {scope.kind === "selection"
                ? "Selected passage"
                : "Entire article"}
            </h3>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close discussion"
            title="Close discussion"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>

        {scope.kind === "selection" ? (
          <div className="discussion-scope-card">
            <p>“{shortSelection(scope.text)}”</p>
            <button type="button" onClick={onSwitchToWhole}>
              Discuss the entire article instead
            </button>
          </div>
        ) : (
          <div className="discussion-scope-card whole">
            <p>Sol will answer using this article as its source context.</p>
          </div>
        )}

        <section className="voice-panel" aria-label="Voice discussion">
          <div className="voice-panel-copy">
            <span
              className={`voice-orb ${voiceActive ? "active" : ""}`}
              aria-hidden="true"
            >
              <AudioLines size={20} />
            </span>
            <div>
              <strong>Pure voice</strong>
              <span aria-live="polite">
                {voiceError ?? voiceContextNote ?? voiceStateLabel(voiceState)}
              </span>
            </div>
          </div>
          <div className="voice-actions">
            {voiceState === "connecting" ? (
              <button
                className="secondary-button voice-start"
                type="button"
                disabled
              >
                <Mic size={17} />
                Connecting…
              </button>
            ) : voiceConnected ? (
              <>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                  title={muted ? "Unmute microphone" : "Mute microphone"}
                  onClick={toggleMute}
                >
                  {muted ? <MicOff size={17} /> : <Mic size={17} />}
                </button>
                <button
                  className="icon-button voice-stop"
                  type="button"
                  aria-label="Stop voice discussion"
                  title="Stop voice discussion"
                  onClick={stopVoice}
                >
                  <Square size={15} />
                </button>
              </>
            ) : (
              <button
                className="secondary-button voice-start"
                type="button"
                onClick={() => void startVoice()}
              >
                <Mic size={17} />
                Start voice
              </button>
            )}
          </div>
        </section>

        <div className="discussion-messages" aria-live="polite">
          {messages.length === 0 ? (
            <div className="discussion-empty">
              <MessageCircle size={25} />
              <strong>
                {scope.kind === "selection"
                  ? "Ask about only this passage"
                  : "Ask anything grounded in this article"}
              </strong>
              <span>Typed replies use Sol with medium reasoning.</span>
            </div>
          ) : (
            messages.map((message) => (
              <div
                className={`discussion-message ${message.role}`}
                key={message.id}
              >
                <span>{message.role === "assistant" ? "Sol" : "You"}</span>
                <p>{message.content}</p>
              </div>
            ))
          )}
          {isSending ? (
            <div
              className="discussion-message assistant pending"
              aria-label="Sol is thinking"
            >
              <span>Sol</span>
              <div className="thinking-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
            </div>
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        {(contextNote || error) && (
          <div
            className={error ? "discussion-notice error" : "discussion-notice"}
            role="status"
          >
            {error ?? contextNote}
          </div>
        )}

        <form className="discussion-composer" onSubmit={submitMessage}>
          <textarea
            ref={inputRef}
            rows={2}
            maxLength={4_000}
            value={draft}
            placeholder={
              scope.kind === "selection"
                ? "Ask about the selected passage…"
                : "Ask about this article…"
            }
            aria-label="Discussion message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button
            className="discussion-send"
            type="submit"
            disabled={isSending || !draft.trim()}
            aria-label="Send message"
            title="Send message"
          >
            <ArrowUp size={19} />
          </button>
        </form>
      </aside>
    </>
  );
}

function useArticleVoice({
  articleId,
  scope,
  onBeforeStart,
}: {
  articleId: string;
  scope: ArticleDiscussionScope;
  onBeforeStart: () => void;
}) {
  const [state, setState] = useState<VoiceState>("idle");
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contextNote, setContextNote] = useState<string | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const sessionRef = useRef(0);

  const releaseResources = useCallback(() => {
    fetchControllerRef.current?.abort();
    fetchControllerRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
      audioRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    sessionRef.current += 1;
    releaseResources();
    setMuted(false);
    setError(null);
    setContextNote(null);
    setState("idle");
  }, [releaseResources]);

  const fail = useCallback(
    (message: string, session: number) => {
      if (sessionRef.current !== session) {
        return;
      }

      sessionRef.current += 1;
      releaseResources();
      setMuted(false);
      setError(message);
      setState("error");
    },
    [releaseResources],
  );

  useEffect(() => stop, [articleId, scope, stop]);

  const start = useCallback(async () => {
    if (state === "connecting" || peerRef.current) {
      return;
    }

    const session = sessionRef.current + 1;
    sessionRef.current = session;
    setState("connecting");
    setError(null);
    setContextNote(null);
    onBeforeStart();

    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
        throw new Error("This browser does not support live voice discussion.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (sessionRef.current !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      const peer = new RTCPeerConnection();
      peerRef.current = peer;
      stream.getTracks().forEach((track) => peer.addTrack(track, stream));

      const audio = new Audio();
      audio.autoplay = true;
      audio.setAttribute("playsinline", "true");
      audioRef.current = audio;
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        void audio.play().catch(() => {
          fail(
            "Browser audio did not start. Try Start voice again and allow audio playback.",
            session,
          );
        });
      };
      peer.onconnectionstatechange = () => {
        if (sessionRef.current !== session) {
          return;
        }

        if (peer.connectionState === "connected") {
          setState("listening");
        } else if (
          ["failed", "closed", "disconnected"].includes(peer.connectionState)
        ) {
          fail(
            "The voice connection ended. You can start a new session.",
            session,
          );
        }
      };

      const events = peer.createDataChannel("oai-events");
      events.onopen = () => setState("listening");
      events.onmessage = (event) => {
        const type = realtimeEventType(event.data);

        if (type === "input_audio_buffer.speech_started") {
          setState("listening");
        } else if (
          type === "input_audio_buffer.speech_stopped" ||
          type === "response.created"
        ) {
          setState("thinking");
        } else if (
          type.includes("output_audio.delta") ||
          type.includes("audio.delta")
        ) {
          setState("speaking");
        } else if (type === "response.done") {
          setState("listening");
        } else if (type === "error") {
          fail(
            "The live voice session reported an error. You can try again.",
            session,
          );
        }
      };
      events.onerror = () =>
        fail(
          "The live voice event channel failed. You can try again.",
          session,
        );
      events.onclose = () => {
        if (peer.connectionState !== "closed") {
          fail(
            "The live voice event channel closed. You can try again.",
            session,
          );
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      const form = new FormData();
      form.set("sdp", offer.sdp ?? "");
      form.set("articleId", articleId);
      form.set("scope", scope.kind);
      if (scope.kind === "selection") {
        form.set("selection", scope.text);
      }

      const fetchController = new AbortController();
      fetchControllerRef.current = fetchController;
      const response = await fetch("/api/realtime/calls", {
        method: "POST",
        body: form,
        signal: fetchController.signal,
      });
      fetchControllerRef.current = null;

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(
          body.error ?? `Voice setup failed with ${response.status}.`,
        );
      }

      if (response.headers.get("x-ai-reader-context-truncated") === "true") {
        setContextNote(
          "The voice session uses the included portion of this article.",
        );
      }

      const answerSdp = await response.text();
      if (sessionRef.current !== session) {
        return;
      }

      await peer.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });
    } catch (startError) {
      if (sessionRef.current !== session) {
        return;
      }

      fail(messageFromError(startError), session);
    }
  }, [articleId, fail, onBeforeStart, scope, state]);

  const toggleMute = useCallback(() => {
    const nextMuted = !muted;
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setMuted(nextMuted);
  }, [muted]);

  return {
    state,
    muted,
    error,
    contextNote,
    start,
    stop,
    toggleMute,
  };
}

function realtimeEventType(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  try {
    const event = JSON.parse(value) as { type?: unknown };
    return typeof event.type === "string" ? event.type : "";
  } catch {
    return "";
  }
}

function shortSelection(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 360 ? `${normalized.slice(0, 357)}…` : normalized;
}

function boundedDiscussionHistory(messages: DiscussionMessage[]) {
  const selected: Array<Pick<DiscussionMessage, "role" | "content">> = [];
  let remainingCharacters = maxHistoryCharacters;

  for (
    let index = messages.length - 1;
    index >= 0 && selected.length < maxHistoryItems && remainingCharacters > 0;
    index -= 1
  ) {
    const message = messages[index];
    const content = message.content
      .trim()
      .slice(0, Math.min(maxHistoryItemCharacters, remainingCharacters));

    if (!content) {
      continue;
    }

    selected.unshift({
      role: message.role,
      content,
    });
    remainingCharacters -= content.length;
  }

  return selected;
}

function focusableElements(root: HTMLElement) {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      [
        "button:not([disabled])",
        "textarea:not([disabled])",
        "input:not([disabled])",
        "select:not([disabled])",
        "a[href]",
        '[tabindex]:not([tabindex="-1"])',
      ].join(","),
    ),
  ).filter((element) => !element.hasAttribute("inert"));
}

function voiceStateLabel(state: VoiceState) {
  const labels: Record<VoiceState, string> = {
    idle: "Talk naturally with a speech-to-speech model.",
    connecting: "Connecting microphone…",
    listening: "Listening — ask about the article.",
    thinking: "Thinking…",
    speaking: "Speaking — interrupt anytime.",
    error: "Voice is stopped. You can try again.",
  };

  return labels[state];
}

function messageId() {
  return (
    crypto.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}
