"use client";

import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import mammoth from "mammoth";

type ReaderStatus =
  | "idle"
  | "loading"
  | "ready"
  | "reading"
  | "paused"
  | "error";

type ExtractResult = {
  text: string;
  sourceLabel: string;
};

const chunkText = (input: string) => {
  const cleaned = input.replace(/\s+/g, " ").trim();
  if (!cleaned) {
    return [];
  }

  const sentences =
    cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((sentence) => sentence.trim()) ??
    [];

  const chunks: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    const nextChunk = current ? `${current} ${sentence}` : sentence;

    if (nextChunk.length > 220 && current) {
      chunks.push(current);
      current = sentence;
      continue;
    }

    current = nextChunk;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
};

const formatProgress = (current: number, total: number) => {
  if (!total) {
    return "0%";
  }

  return `${Math.min(100, Math.round((current / total) * 100))}%`;
};

export default function Home() {
  const [status, setStatus] = useState<ReaderStatus>("idle");
  const [message, setMessage] = useState("Load a PDF or Word document to start listening.");
  const [text, setText] = useState("");
  const [sourceLabel, setSourceLabel] = useState("No document loaded");
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceURI, setVoiceURI] = useState("");
  const [rate, setRate] = useState(1);
  const [pitch, setPitch] = useState(1);
  const [currentChunk, setCurrentChunk] = useState(0);
  const [speechSupported, setSpeechSupported] = useState(false);

  const chunks = useMemo(() => chunkText(text), [text]);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const playbackTokenRef = useRef(0);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const synth = window.speechSynthesis;

    if (!synth) {
      setSpeechSupported(false);
      setStatus("error");
      setMessage("This browser does not support the Web Speech API.");
      return;
    }

    setSpeechSupported(true);

    const assignVoices = () => {
      const availableVoices = synth.getVoices();
      setVoices(availableVoices);

      if (!voiceURI && availableVoices.length > 0) {
        const preferred =
          availableVoices.find((voice) => voice.lang.startsWith("en")) ??
          availableVoices[0];
        setVoiceURI(preferred.voiceURI);
      }
    };

    assignVoices();
    synth.addEventListener("voiceschanged", assignVoices);

    return () => {
      synth.cancel();
      synth.removeEventListener("voiceschanged", assignVoices);
    };
  }, [voiceURI]);

  const stopSpeaking = () => {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      return;
    }

    playbackTokenRef.current += 1;
    window.speechSynthesis.cancel();
    utteranceRef.current = null;
  };

  const speakFromChunk = (startIndex: number) => {
    if (!speechSupported || typeof window === "undefined" || chunks.length === 0) {
      return;
    }

    stopSpeaking();

    const synth = window.speechSynthesis;
    const voice = voices.find((item) => item.voiceURI === voiceURI);
    const utterance = new SpeechSynthesisUtterance(chunks[startIndex]);
    const playbackToken = playbackTokenRef.current + 1;

    playbackTokenRef.current = playbackToken;

    utterance.voice = voice ?? null;
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.onend = () => {
      if (playbackTokenRef.current !== playbackToken) {
        return;
      }

      const nextIndex = startIndex + 1;

      if (nextIndex >= chunks.length) {
        utteranceRef.current = null;
        setStatus("ready");
        setMessage("Finished reading the document.");
        setCurrentChunk(chunks.length);
        return;
      }

      setCurrentChunk(nextIndex);
      speakFromChunk(nextIndex);
    };

    utterance.onerror = () => {
      if (playbackTokenRef.current !== playbackToken) {
        return;
      }

      utteranceRef.current = null;
      setStatus("error");
      setMessage("Speech playback failed. Try a different browser voice.");
    };

    utteranceRef.current = utterance;
    setCurrentChunk(startIndex);
    setStatus("reading");
    setMessage(`Reading ${sourceLabel}`);
    synth.speak(utterance);
  };

  const extractTextFromPdf = async (file: File): Promise<ExtractResult> => {
    const pdfjs = await import("pdfjs-dist");

    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();

    const buffer = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buffer }).promise;
    const pages: string[] = [];

    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
      const page = await pdf.getPage(pageIndex);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      pages.push(pageText);
    }

    return {
      text: pages.join("\n\n"),
      sourceLabel: `${file.name} · ${pdf.numPages} page${pdf.numPages > 1 ? "s" : ""}`,
    };
  };

  const extractTextFromWord = async (file: File): Promise<ExtractResult> => {
    const buffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buffer });

    return {
      text: result.value,
      sourceLabel: file.name,
    };
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    stopSpeaking();
    setStatus("loading");
    setMessage(`Extracting text from ${file.name}...`);
    setCurrentChunk(0);

    try {
      let result: ExtractResult;

      if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) {
        result = await extractTextFromPdf(file);
      } else if (file.name.toLowerCase().endsWith(".docx")) {
        result = await extractTextFromWord(file);
      } else if (file.name.toLowerCase().endsWith(".doc")) {
        throw new Error("Legacy .doc files are not supported in-browser. Convert the file to .docx first.");
      } else {
        throw new Error("Unsupported file type. Use a .pdf or .docx file.");
      }

      const normalizedText = result.text.replace(/\n{3,}/g, "\n\n").trim();

      if (!normalizedText) {
        throw new Error("No readable text was found in the file.");
      }

      setText(normalizedText);
      setSourceLabel(result.sourceLabel);
      setStatus("ready");
      setMessage(`Loaded ${result.sourceLabel}`);
    } catch (error) {
      setText("");
      setSourceLabel("No document loaded");
      setStatus("error");
      setMessage(
        error instanceof Error
          ? error.message
          : "The file could not be processed.",
      );
    } finally {
      event.target.value = "";
    }
  };

  const currentPreview = chunks[Math.min(currentChunk, Math.max(chunks.length - 1, 0))] ?? "";
  const progress = formatProgress(currentChunk, chunks.length);

  return (
    <main className="page-shell">
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Browser TTS document reader</p>
          <h1>Read PDFs and Word docs out loud in a clean Next.js app.</h1>
          <p className="lede">
            Upload a file, extract its text in the browser, then listen with the
            built-in speech engine using your preferred voice and pace.
          </p>

          <label className="upload-panel">
            <span className="upload-title">Drop in a file</span>
            <span className="upload-subtitle">Supports `.pdf` and `.docx`.</span>
            <input
              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={handleFileUpload}
              type="file"
            />
          </label>
        </div>

        <div className="hero-stage">
          <div className="orb orb-a" />
          <div className="orb orb-b" />
          <div className="stage-panel">
            <div className="status-row">
              <span>{sourceLabel}</span>
              <span className={`status-badge status-${status}`}>{status}</span>
            </div>

            <p className="status-message">{message}</p>

            <div className="metrics">
              <div>
                <span>Chunks</span>
                <strong>{chunks.length}</strong>
              </div>
              <div>
                <span>Progress</span>
                <strong>{progress}</strong>
              </div>
              <div>
                <span>Preview</span>
                <strong>{text ? `${text.length.toLocaleString()} chars` : "Empty"}</strong>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="workspace">
        <div className="control-strip">
          <div className="field">
            <label htmlFor="voice">Voice</label>
            <select
              id="voice"
              onChange={(event) => setVoiceURI(event.target.value)}
              value={voiceURI}
            >
              {voices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} · {voice.lang}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="rate">Rate</label>
            <input
              id="rate"
              max="2"
              min="0.5"
              onChange={(event) => setRate(Number(event.target.value))}
              step="0.1"
              type="range"
              value={rate}
            />
            <span>{rate.toFixed(1)}x</span>
          </div>

          <div className="field">
            <label htmlFor="pitch">Pitch</label>
            <input
              id="pitch"
              max="2"
              min="0.5"
              onChange={(event) => setPitch(Number(event.target.value))}
              step="0.1"
              type="range"
              value={pitch}
            />
            <span>{pitch.toFixed(1)}</span>
          </div>
        </div>

        <div className="player-panel">
          <div className="button-row">
            <button disabled={chunks.length === 0 || !speechSupported} onClick={() => speakFromChunk(currentChunk)}>
              {status === "paused" ? "Resume chunk" : "Play"}
            </button>
            <button
              disabled={status !== "reading"}
              onClick={() => {
                if (typeof window === "undefined") {
                  return;
                }

                window.speechSynthesis.pause();
                setStatus("paused");
                setMessage(`Paused ${sourceLabel}`);
              }}
            >
              Pause
            </button>
            <button
              disabled={status !== "paused"}
              onClick={() => {
                if (typeof window === "undefined") {
                  return;
                }

                window.speechSynthesis.resume();
                setStatus("reading");
                setMessage(`Reading ${sourceLabel}`);
              }}
            >
              Continue
            </button>
            <button
              disabled={chunks.length === 0}
              onClick={() => {
                stopSpeaking();
                setStatus(text ? "ready" : "idle");
                setCurrentChunk(0);
                setMessage(text ? `Stopped ${sourceLabel}` : "Load a document to begin.");
              }}
            >
              Stop
            </button>
            <button
              disabled={chunks.length === 0 || currentChunk === 0}
              onClick={() => speakFromChunk(Math.max(0, currentChunk - 1))}
            >
              Previous
            </button>
            <button
              disabled={chunks.length === 0 || currentChunk >= Math.max(chunks.length - 1, 0)}
              onClick={() => speakFromChunk(Math.min(chunks.length - 1, currentChunk + 1))}
            >
              Next
            </button>
          </div>

          <input
            aria-label="Reading progress"
            className="timeline"
            disabled={chunks.length === 0}
            max={Math.max(chunks.length - 1, 0)}
            min={0}
            onChange={(event) => setCurrentChunk(Number(event.target.value))}
            type="range"
            value={Math.min(currentChunk, Math.max(chunks.length - 1, 0))}
          />
        </div>

        <div className="content-grid">
          <article className="preview-panel">
            <div className="panel-header">
              <span>Current chunk</span>
              <strong>
                {chunks.length === 0
                  ? "No content"
                  : `${Math.min(currentChunk + 1, chunks.length)} / ${chunks.length}`}
              </strong>
            </div>
            <p>{currentPreview || "Upload a document to preview the current spoken segment."}</p>
          </article>

          <article className="preview-panel">
            <div className="panel-header">
              <span>Extracted text</span>
              <strong>{text ? "Ready" : "Waiting"}</strong>
            </div>
            <textarea readOnly value={text} />
          </article>
        </div>
      </section>
    </main>
  );
}
