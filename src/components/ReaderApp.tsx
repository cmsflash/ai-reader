"use client";

import {
  BookOpen,
  FileText,
  Link as LinkIcon,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { annotateBlocks, type AnnotatedBlock, type SentenceSegment } from "@/lib/sentences";
import type { Article, ArticleSummary, SourceType } from "@/lib/types";

type ArticleListResponse = {
  articles: ArticleSummary[];
};

type ArticleResponse = {
  article: Article;
  summary?: ArticleSummary;
};

type ImportResponse = {
  article: Article;
  summary: ArticleSummary;
};

type PendingImport = {
  id: string;
  title: string;
  detail: string;
  sourceType: SourceType;
};

export function ReaderApp() {
  const [articles, setArticles] = useState<ArticleSummary[]>([]);
  const [pendingImports, setPendingImports] = useState<PendingImport[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [article, setArticle] = useState<Article | null>(null);
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState<string | null>("Loading library...");
  const [error, setError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isArticleLoading, setIsArticleLoading] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [currentSentence, setCurrentSentence] = useState(0);
  const [rate, setRate] = useState(1);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const articleIdRef = useRef<string | null>(null);
  const sentencesRef = useRef<SentenceSegment[]>([]);
  const speechSessionRef = useRef(0);
  const lastTapRef = useRef<{ index: number; time: number } | null>(null);
  const rateRef = useRef(rate);
  const restoredArticleIdRef = useRef<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const annotated = useMemo(() => {
    if (!article) {
      return {
        blocks: [] as AnnotatedBlock[],
        sentences: [] as SentenceSegment[],
      };
    }

    return annotateBlocks(article.blocks);
  }, [article]);

  const selectedPendingImport =
    pendingImports.find((pendingImport) => pendingImport.id === selectedId) ?? null;
  const libraryItems = useMemo(
    () => [
      ...pendingImports.map((pendingImport) => ({
        kind: "pending" as const,
        pendingImport,
      })),
      ...articles.map((articleSummary) => ({
        kind: "article" as const,
        articleSummary,
      })),
    ],
    [articles, pendingImports],
  );

  useEffect(() => {
    articleIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    sentencesRef.current = annotated.sentences;
  }, [annotated.sentences]);

  useEffect(() => {
    rateRef.current = rate;
  }, [rate]);

  const loadArticles = useCallback(async (showLoading = false) => {
    if (showLoading) {
      setStatus("Refreshing library...");
    }

    try {
      const data = await requestJson<ArticleListResponse>("/api/articles");
      setArticles(data.articles);
      setSelectedId((current) => current ?? data.articles[0]?.id ?? null);
      setStatus(null);
      setError(null);
    } catch (loadError) {
      setError(messageFromError(loadError));
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void loadArticles(true);
    const interval = window.setInterval(() => void loadArticles(false), 15000);

    return () => window.clearInterval(interval);
  }, [loadArticles]);

  useEffect(() => {
    if (!selectedId) {
      setArticle(null);
      return;
    }

    if (selectedPendingImport) {
      setArticle(null);
      setIsArticleLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;

    async function loadArticle() {
      setIsArticleLoading(true);
      try {
        const data = await requestJson<ArticleResponse>(`/api/articles/${selectedId}`);
        if (cancelled) {
          return;
        }

        setArticle(data.article);
        setCurrentSentence(data.article.progress.sentenceIndex);
        setError(null);
      } catch (loadError) {
        if (!cancelled) {
          setError(messageFromError(loadError));
          setArticle(null);
        }
      } finally {
        if (!cancelled) {
          setIsArticleLoading(false);
        }
      }
    }

    void loadArticle();

    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedPendingImport]);

  useEffect(() => {
    if (!article || restoredArticleIdRef.current === article.id) {
      return;
    }

    restoredArticleIdRef.current = article.id;
    window.requestAnimationFrame(() => {
      const activeSentence = document.querySelector<HTMLElement>(
        `[data-sentence-index="${article.progress.sentenceIndex}"]`,
      );
      activeSentence?.scrollIntoView({ block: "center", behavior: "instant" });
    });
  }, [article]);

  const saveProgress = useCallback(
    async (sentenceIndex: number) => {
      const id = articleIdRef.current;

      if (!id) {
        return;
      }

      const sentenceCount = sentencesRef.current.length;

      const data = await requestJson<ArticleResponse>(`/api/articles/${id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          progress: {
            sentenceIndex,
            percent: progressPercentForSentence(sentenceIndex, sentenceCount),
          },
        }),
      });

      setArticle((current) => (current?.id === id ? data.article : current));

      if (data.summary) {
        setArticles((current) =>
          current.map((item) => (item.id === id ? data.summary ?? item : item)),
        );
      }
    },
    [],
  );

  const cleanupAudio = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute("src");
      audioRef.current.load();
      audioRef.current = null;
    }

    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const speakWithBrowser = useCallback((text: string, onEnd: () => void) => {
    if (!("speechSynthesis" in window)) {
      throw new Error("No speech engine is available.");
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rateRef.current;
    utterance.onend = onEnd;
    utterance.onerror = () => onEnd();
    window.speechSynthesis.speak(utterance);
  }, []);

  const playElevenLabsAudio = useCallback(
    async (text: string, session: number) => {
      const articleId = articleIdRef.current;
      const response = await fetch("/api/tts", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ text, articleId }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `TTS request failed with ${response.status}.`);
      }

      const costUsd = Number(response.headers.get("x-processing-cost-usd") ?? 0);
      const audioBlob = await response.blob();

      if (speechSessionRef.current !== session) {
        return;
      }

      if (articleId && Number.isFinite(costUsd) && costUsd > 0) {
        setArticle((current) =>
          current?.id === articleId
            ? {
                ...current,
                processingCostUsd: roundCost((current.processingCostUsd ?? 0) + costUsd),
              }
            : current,
        );
        setArticles((current) =>
          current.map((item) =>
            item.id === articleId
              ? {
                  ...item,
                  processingCostUsd: roundCost((item.processingCostUsd ?? 0) + costUsd),
                }
              : item,
          ),
        );
      }

      cleanupAudio();
      const audioUrl = URL.createObjectURL(audioBlob);
      const audio = new Audio(audioUrl);
      audio.playbackRate = rateRef.current;
      audioUrlRef.current = audioUrl;
      audioRef.current = audio;

      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error("Audio playback failed."));
        void audio.play().catch(reject);
      });
    },
    [cleanupAudio],
  );

  const speakFrom = useCallback(
    (sentenceIndex: number) => {
      const sentences = sentencesRef.current;

      if (sentences.length === 0) {
        return;
      }

      const startIndex = Math.min(Math.max(sentenceIndex, 0), sentences.length - 1);
      const session = speechSessionRef.current + 1;
      speechSessionRef.current = session;
      cleanupAudio();
      window.speechSynthesis.cancel();
      setIsSpeaking(true);
      setError(null);

      const speakAt = async (index: number) => {
        if (speechSessionRef.current !== session) {
          return;
        }

        if (index >= sentencesRef.current.length) {
          setIsSpeaking(false);
          return;
        }

        const segment = sentencesRef.current[index];
        setCurrentSentence(segment.sentenceIndex);
        void saveProgress(segment.sentenceIndex).catch((saveError) => {
          setError(messageFromError(saveError));
        });

        try {
          await playElevenLabsAudio(segment.text, session);
          window.setTimeout(() => void speakAt(index + 1), 80);
        } catch (playbackError) {
          if (speechSessionRef.current !== session) {
            return;
          }

          setError(`${messageFromError(playbackError)} Falling back to browser voice.`);
          try {
            speakWithBrowser(segment.text, () => window.setTimeout(() => void speakAt(index + 1), 80));
          } catch (fallbackError) {
            setIsSpeaking(false);
            setError(messageFromError(fallbackError));
          }
        }
      };

      void speakAt(startIndex);
    },
    [cleanupAudio, playElevenLabsAudio, saveProgress, speakWithBrowser],
  );

  const stopSpeaking = useCallback(() => {
    speechSessionRef.current += 1;
    cleanupAudio();
    window.speechSynthesis?.cancel();
    setIsSpeaking(false);
  }, [cleanupAudio]);

  useEffect(() => stopSpeaking, [stopSpeaking]);

  const resumeFromSentence = useCallback(
    (sentenceIndex: number) => {
      setCurrentSentence(sentenceIndex);
      void saveProgress(sentenceIndex).catch((saveError) => {
        setError(messageFromError(saveError));
      });
      speakFrom(sentenceIndex);
    },
    [saveProgress, speakFrom],
  );

  const handleSentenceTap = useCallback(
    (sentenceIndex: number) => {
      const now = Date.now();
      const lastTap = lastTapRef.current;

      if (lastTap?.index === sentenceIndex && now - lastTap.time < 800) {
        resumeFromSentence(sentenceIndex);
        lastTapRef.current = null;
        return;
      }

      lastTapRef.current = {
        index: sentenceIndex,
        time: now,
      };
    },
    [resumeFromSentence],
  );

  async function handleUrlSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!url.trim()) {
      return;
    }

    setIsImporting(true);
    const pendingImport = pendingImportFromUrl(url.trim());
    setPendingImports((current) => [pendingImport, ...current]);
    setSelectedId(pendingImport.id);
    setArticle(null);
    setStatus("Parsing URL...");
    setError(null);

    try {
      const data = await requestJson<ImportResponse>("/api/articles", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ url: url.trim() }),
      });

      setPendingImports((current) => current.filter((item) => item.id !== pendingImport.id));
      setArticles((current) => [data.summary, ...current.filter((item) => item.id !== data.summary.id)]);
      setSelectedId(data.article.id);
      setArticle(data.article);
      setUrl("");
      setStatus(null);
    } catch (submitError) {
      setPendingImports((current) => current.filter((item) => item.id !== pendingImport.id));
      setSelectedId((current) => (current === pendingImport.id ? articles[0]?.id ?? null : current));
      setError(messageFromError(submitError));
      setStatus(null);
    } finally {
      setIsImporting(false);
    }
  }

  async function handleFileUpload(file: File | undefined) {
    if (!file) {
      return;
    }

    const form = new FormData();
    form.append("file", file);
    const pendingImport = pendingImportFromFile(file);
    setIsImporting(true);
    setPendingImports((current) => [pendingImport, ...current]);
    setSelectedId(pendingImport.id);
    setArticle(null);
    setStatus(`Parsing ${file.name}...`);
    setError(null);

    try {
      const data = await requestJson<ImportResponse>("/api/articles", {
        method: "POST",
        body: form,
      });

      setPendingImports((current) => current.filter((item) => item.id !== pendingImport.id));
      setArticles((current) => [data.summary, ...current.filter((item) => item.id !== data.summary.id)]);
      setSelectedId(data.article.id);
      setArticle(data.article);
      setStatus(null);
    } catch (uploadError) {
      setPendingImports((current) => current.filter((item) => item.id !== pendingImport.id));
      setSelectedId((current) => (current === pendingImport.id ? articles[0]?.id ?? null : current));
      setError(messageFromError(uploadError));
      setStatus(null);
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleDeleteArticle() {
    if (!selectedId) {
      return;
    }

    const confirmed = window.confirm("Delete this saved article?");

    if (!confirmed) {
      return;
    }

    stopSpeaking();
    setError(null);

    try {
      await requestJson<{ ok: boolean }>(`/api/articles/${selectedId}`, {
        method: "DELETE",
      });

      const remaining = articles.filter((item) => item.id !== selectedId);
      setArticles(remaining);
      setSelectedId(remaining[0]?.id ?? null);
      setArticle(null);
    } catch (deleteError) {
      setError(messageFromError(deleteError));
    }
  }

  const readableProgress = article ? progressRatio(article) : 0;

  return (
    <main className="reader-app">
      <aside className="library-panel" aria-label="Library">
        <header className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            <BookOpen size={20} />
          </div>
          <div>
            <h1>AI Reader</h1>
            <p>{libraryCountLabel(articles.length, pendingImports.length)}</p>
          </div>
          <button
            className="icon-button"
            type="button"
            title="Refresh"
            aria-label="Refresh"
            onClick={() => void loadArticles(true)}
          >
            <RefreshCw size={18} />
          </button>
        </header>

        <form className="import-form" onSubmit={handleUrlSubmit}>
          <label className="url-field">
            <LinkIcon size={18} />
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com/article"
              type="url"
              disabled={isImporting}
            />
          </label>
          <button className="primary-button" type="submit" disabled={isImporting || !url.trim()}>
            <Plus size={18} />
            Save URL
          </button>
        </form>

        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept=".pdf,.docx,.md,.markdown,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain"
          onChange={(event) => void handleFileUpload(event.target.files?.[0])}
        />

        <button
          className="secondary-button"
          type="button"
          disabled={isImporting}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload size={18} />
          Upload document
        </button>

        <details className="settings-panel">
          <summary>
            <Settings2 size={17} />
            TTS
          </summary>
          <label>
            Voice speed
            <input
              min="0.7"
              max="1.4"
              step="0.05"
              type="range"
              value={rate}
              onChange={(event) => setRate(Number(event.target.value))}
            />
          </label>
        </details>

        {(status || error) && (
          <div className={error ? "notice error" : "notice"} role="status">
            {error ?? status}
          </div>
        )}

        <nav className="article-list" aria-label="Saved articles">
          {libraryItems.length === 0 ? (
            <div className="empty-library">
              <FileText size={22} />
              <span>Save a URL or upload a document.</span>
            </div>
          ) : (
            libraryItems.map((item) =>
              item.kind === "pending" ? (
                <PendingImportRow
                  key={item.pendingImport.id}
                  pendingImport={item.pendingImport}
                  selected={item.pendingImport.id === selectedId}
                  onSelect={() => {
                    stopSpeaking();
                    setSelectedId(item.pendingImport.id);
                  }}
                />
              ) : (
                <ArticleRow
                  key={item.articleSummary.id}
                  item={item.articleSummary}
                  selected={item.articleSummary.id === selectedId}
                  onSelect={() => {
                    stopSpeaking();
                    setSelectedId(item.articleSummary.id);
                  }}
                />
              ),
            )
          )}
        </nav>
      </aside>

      <section className="reader-panel" aria-label="Reader">
        {!selectedId ? (
          <div className="reader-empty">
            <BookOpen size={36} />
            <p>Library is empty.</p>
          </div>
        ) : selectedPendingImport ? (
          <ParsingReader pendingImport={selectedPendingImport} />
        ) : isArticleLoading || !article ? (
          <div className="reader-empty">
            <RefreshCw className="spin" size={32} />
            <p>Loading article...</p>
          </div>
        ) : (
          <>
            <header className="reader-toolbar">
              <div className="article-title-block">
                <span className="source-pill">{sourceLabel(article.sourceType)}</span>
                <h2>{article.title}</h2>
                <div className="article-meta-row" aria-label="Article metadata">
                  <span>{article.wordCount.toLocaleString()} words</span>
                  <span>{article.estimatedMinutes} min audio</span>
                  <span>{formatDate(article.createdAt)}</span>
                  {article.sourceUrl ? <span>{sourceDomain(article.sourceUrl)}</span> : null}
                  <span>{formatCost(article.processingCostUsd ?? 0)} API cost</span>
                </div>
              </div>

              <div className="reader-actions">
                <button
                  className="round-button primary"
                  type="button"
                  title={isSpeaking ? "Pause" : "Read aloud"}
                  aria-label={isSpeaking ? "Pause" : "Read aloud"}
                  onClick={() => {
                    if (isSpeaking) {
                      stopSpeaking();
                    } else {
                      speakFrom(currentSentence);
                    }
                  }}
                >
                  {isSpeaking ? <Pause size={20} /> : <Play size={20} />}
                </button>
                <label className="rate-inline" title="Voice speed">
                  <Volume2 size={18} />
                  <input
                    min="0.7"
                    max="1.4"
                    step="0.05"
                    type="range"
                    value={rate}
                    onChange={(event) => setRate(Number(event.target.value))}
                  />
                </label>
                <button
                  className="round-button danger"
                  type="button"
                  title="Delete"
                  aria-label="Delete"
                  onClick={() => void handleDeleteArticle()}
                >
                  <Trash2 size={19} />
                </button>
              </div>
            </header>

            <div className="progress-strip" aria-hidden="true">
              <span style={{ width: `${readableProgress * 100}%` }} />
            </div>

            <div className="reader-scroll">
              <article className="article-body">
                {annotated.blocks.map((block) => (
                  <ArticleBlockView
                    key={block.id}
                    block={block}
                    articleSourceUrl={article.sourceUrl}
                    currentSentence={currentSentence}
                    onSentenceTap={handleSentenceTap}
                  />
                ))}
              </article>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function ArticleRow({
  item,
  selected,
  onSelect,
}: {
  item: ArticleSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`article-row ${selected ? "selected" : ""}`}
      onClick={onSelect}
    >
      <span className="source-icon" aria-hidden="true">
        {sourceGlyph(item.sourceType)}
      </span>
      <span className="article-row-main">
        <span className="article-row-title">{item.title}</span>
        <span className="article-row-meta">
          {sourceLabel(item.sourceType)} / {item.estimatedMinutes} min /{" "}
          {Math.round(progressRatio(item) * 100)}%
        </span>
        <span className="mini-progress" aria-hidden="true">
          <span style={{ width: `${progressRatio(item) * 100}%` }} />
        </span>
      </span>
    </button>
  );
}

function PendingImportRow({
  pendingImport,
  selected,
  onSelect,
}: {
  pendingImport: PendingImport;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`article-row pending ${selected ? "selected" : ""}`}
      onClick={onSelect}
      aria-busy="true"
    >
      <span className="source-icon pending" aria-hidden="true">
        <RefreshCw className="spin" size={16} />
      </span>
      <span className="article-row-main">
        <span className="article-row-title">{pendingImport.title}</span>
        <span className="article-row-meta">
          {sourceLabel(pendingImport.sourceType)} / Parsing / {pendingImport.detail}
        </span>
        <span className="mini-progress indeterminate" aria-hidden="true">
          <span />
        </span>
      </span>
    </button>
  );
}

function ParsingReader({ pendingImport }: { pendingImport: PendingImport }) {
  return (
    <div className="reader-empty parsing-reader" aria-busy="true">
      <RefreshCw className="spin" size={34} />
      <p>Parsing article...</p>
      <span>{pendingImport.title}</span>
    </div>
  );
}

function ArticleBlockView({
  block,
  articleSourceUrl,
  currentSentence,
  onSentenceTap,
}: {
  block: AnnotatedBlock;
  articleSourceUrl?: string;
  currentSentence: number;
  onSentenceTap: (sentenceIndex: number) => void;
}) {
  if (block.type === "heading") {
    const HeadingTag = `h${Math.min(Math.max(block.level, 2), 4)}` as "h2" | "h3" | "h4";
    return (
      <HeadingTag>
        <SentenceChunks
          chunks={block.chunks}
          currentSentence={currentSentence}
          onSentenceTap={onSentenceTap}
        />
      </HeadingTag>
    );
  }

  if (block.type === "quote") {
    return (
      <blockquote>
        <SentenceChunks
          chunks={block.chunks}
          currentSentence={currentSentence}
          onSentenceTap={onSentenceTap}
        />
      </blockquote>
    );
  }

  if (block.type === "code") {
    return (
      <pre>
        <code>
          <SentenceChunks
            chunks={block.chunks}
            currentSentence={currentSentence}
            onSentenceTap={onSentenceTap}
          />
        </code>
      </pre>
    );
  }

  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";

    return (
      <ListTag>
        {block.itemChunks.map((chunks, index) => (
          <li key={`${block.id}-${index}`}>
            <SentenceChunks
              chunks={chunks}
              currentSentence={currentSentence}
              onSentenceTap={onSentenceTap}
            />
          </li>
        ))}
      </ListTag>
    );
  }

  if (block.type === "image") {
    const src = block.src ? proxiedImageSrc(block.src, articleSourceUrl) : undefined;

    return (
      <figure className="article-image-block">
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element -- Article images come from arbitrary reader URLs.
          <img src={src} alt={block.alt} loading="lazy" />
        ) : (
          <div className="image-placeholder" aria-hidden="true">
            Image
          </div>
        )}
        {block.chunks.length > 0 ? (
          <figcaption>
            <SentenceChunks
              chunks={block.chunks}
              currentSentence={currentSentence}
              onSentenceTap={onSentenceTap}
            />
          </figcaption>
        ) : null}
      </figure>
    );
  }

  if (block.type === "table") {
    return (
      <figure className="article-table-block">
        {block.captionChunks.length > 0 ? (
          <figcaption>
            <SentenceChunks
              chunks={block.captionChunks}
              currentSentence={currentSentence}
              onSentenceTap={onSentenceTap}
            />
          </figcaption>
        ) : null}
        <div className="table-scroll" role="region" aria-label={block.caption ?? "Article table"}>
          <table>
            <tbody>
              {block.cellChunks.map((row, rowIndex) => (
                <tr key={`${block.id}-row-${rowIndex}`}>
                  {row.map((chunks, cellIndex) => {
                    const CellTag = rowIndex < (block.headerRows ?? 0) ? "th" : "td";

                    return (
                      <CellTag key={`${block.id}-cell-${rowIndex}-${cellIndex}`}>
                        {chunks.length > 0 ? (
                          <SentenceChunks
                            chunks={chunks}
                            currentSentence={currentSentence}
                            onSentenceTap={onSentenceTap}
                          />
                        ) : (
                          "\u00a0"
                        )}
                      </CellTag>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </figure>
    );
  }

  return (
    <p>
      <SentenceChunks
        chunks={block.chunks}
        currentSentence={currentSentence}
        onSentenceTap={onSentenceTap}
      />
    </p>
  );
}

function SentenceChunks({
  chunks,
  currentSentence,
  onSentenceTap,
}: {
  chunks: SentenceSegment[];
  currentSentence: number;
  onSentenceTap: (sentenceIndex: number) => void;
}) {
  return chunks.map((chunk, index) => (
    <span
      key={chunk.sentenceIndex}
      className={`sentence ${chunk.sentenceIndex === currentSentence ? "active" : ""}`}
      data-sentence-index={chunk.sentenceIndex}
      role="button"
      tabIndex={0}
      onClick={() => onSentenceTap(chunk.sentenceIndex)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSentenceTap(chunk.sentenceIndex);
        }
      }}
      title="Double-tap to resume"
    >
      {chunk.text}
      {index < chunks.length - 1 ? " " : ""}
    </span>
  ));
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => ({}))) as { error?: string };

  if (!response.ok) {
    throw new Error(data.error ?? `Request failed with ${response.status}`);
  }

  return data as T;
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function pendingImportFromUrl(rawUrl: string): PendingImport {
  return {
    id: pendingImportId(),
    title: titleFromInputUrl(rawUrl),
    detail: sourceDomain(rawUrl),
    sourceType: "url",
  };
}

function pendingImportFromFile(file: File): PendingImport {
  return {
    id: pendingImportId(),
    title: file.name || "Untitled document",
    detail: "Local document",
    sourceType: sourceTypeFromFileName(file.name),
  };
}

function pendingImportId() {
  return `pending-${crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function titleFromInputUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    const lastPath = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1) ?? "");
    return lastPath || parsed.hostname;
  } catch {
    return rawUrl;
  }
}

function sourceTypeFromFileName(fileName: string): SourceType {
  const extension = fileName.split(".").pop()?.toLowerCase();

  if (extension === "pdf") {
    return "pdf";
  }

  if (extension === "docx") {
    return "docx";
  }

  if (extension === "md" || extension === "markdown" || extension === "mdown") {
    return "markdown";
  }

  return "text";
}

function libraryCountLabel(articleCount: number, pendingCount: number) {
  const articleLabel = articleCount === 1 ? "1 article" : `${articleCount} articles`;

  if (pendingCount === 0) {
    return articleLabel;
  }

  const pendingLabel = pendingCount === 1 ? "1 parsing" : `${pendingCount} parsing`;
  return `${articleLabel} / ${pendingLabel}`;
}

function progressRatio(article: Pick<ArticleSummary, "progress" | "sentenceCount">) {
  return progressPercentForSentence(article.progress.sentenceIndex, article.sentenceCount);
}

function progressPercentForSentence(sentenceIndex: number, sentenceCount: number) {
  if (sentenceCount <= 1) {
    return sentenceCount === 1 && sentenceIndex > 0 ? 1 : 0;
  }

  return Math.min(Math.max(sentenceIndex / (sentenceCount - 1), 0), 1);
}

function sourceLabel(sourceType: SourceType) {
  const labels: Record<SourceType, string> = {
    url: "URL",
    pdf: "PDF",
    docx: "DOCX",
    markdown: "Markdown",
    text: "Text",
  };

  return labels[sourceType];
}

function sourceGlyph(sourceType: SourceType) {
  const glyphs: Record<SourceType, string> = {
    url: "URL",
    pdf: "P",
    docx: "D",
    markdown: "M",
    text: "T",
  };

  return glyphs[sourceType];
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function sourceDomain(sourceUrl: string) {
  try {
    return new URL(sourceUrl).hostname;
  } catch {
    return sourceUrl;
  }
}

function formatCost(costUsd: number) {
  if (!Number.isFinite(costUsd) || costUsd <= 0) {
    return "$0.00";
  }

  return costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(2)}`;
}

function roundCost(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function proxiedImageSrc(src: string, sourceUrl?: string) {
  try {
    const imageUrl = new URL(src);

    if (!["http:", "https:"].includes(imageUrl.protocol)) {
      return src;
    }

    const params = new URLSearchParams({ url: imageUrl.href });

    if (sourceUrl) {
      params.set("source", sourceUrl);
    }

    return `/api/image?${params.toString()}`;
  } catch {
    return src;
  }
}
