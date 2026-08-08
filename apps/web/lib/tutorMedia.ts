/** Browser helpers for tutor multimodal: mic STT + image attach. */

export function stripDataUrlToBase64(dataUrlOrB64: string): string {
  const raw = (dataUrlOrB64 || "").trim();
  if (raw.startsWith("data:") && raw.includes(",")) {
    return raw.split(",", 1)[1].trim();
  }
  return raw;
}

/** Alias used by api.ts */
export const stripDataUrlBase64 = stripDataUrlToBase64;

export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Resize chat image for vision and return data URL + raw base64. */
export async function fileToTutorImagePayload(
  file: File | Blob,
  maxSide = 768,
  maxBytes = 900 * 1024,
): Promise<{ dataUrl: string; base64: string; mimeType: string }> {
  const type = "type" in file ? file.type : "";
  if (type && !type.startsWith("image/")) {
    throw new Error("Vui lòng chọn tệp ảnh.");
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Không thể xử lý ảnh.");
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  let quality = 0.85;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > maxBytes * 1.37 && quality > 0.45) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > maxBytes * 1.37) {
    throw new Error("Ảnh quá lớn sau khi nén (giới hạn ~900KB).");
  }
  return {
    dataUrl,
    base64: stripDataUrlToBase64(dataUrl),
    mimeType: "image/jpeg",
  };
}

/** Convenience: data URL only (used by TutorInner / MascotChat). */
export async function fileToTutorImageDataUrl(
  file: File | Blob,
  maxBytes = 900 * 1024,
  maxSide = 1280,
): Promise<string> {
  const { dataUrl } = await fileToTutorImagePayload(file, maxSide, maxBytes);
  return dataUrl;
}

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

function getSpeechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

export function canUseWebSpeech(): boolean {
  return Boolean(getSpeechRecognitionCtor());
}

export const browserSpeechSupported = canUseWebSpeech;

/** One-shot browser STT (Chrome/Edge). Resolves on first final result or end. */
export function recognizeSpeechWebApi(
  lang = "vi-VN",
  timeoutMs = 8000,
): Promise<{ text: string; provider: "web-speech" }> {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    return Promise.reject(new Error("Trình duyệt không hỗ trợ Web Speech API."));
  }
  return new Promise((resolve, reject) => {
    const rec = new Ctor();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let settled = false;
    let best = "";
    const timer = window.setTimeout(() => {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      if (!settled) {
        settled = true;
        if (best.trim()) resolve({ text: best.trim(), provider: "web-speech" });
        else reject(new Error("Hết thời gian chờ nhận dạng giọng nói."));
      }
    }, timeoutMs);

    rec.onresult = (ev) => {
      let interim = "";
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        const t = r[0]?.transcript || "";
        if (r.isFinal) best = (best + " " + t).trim();
        else interim += t;
      }
      if (!best && interim) best = interim.trim();
    };
    rec.onerror = (ev) => {
      if (settled) return;
      if (ev.error === "aborted") return;
      settled = true;
      window.clearTimeout(timer);
      reject(
        new Error(
          ev.error === "not-allowed"
            ? "Cần quyền micro để nói."
            : `Lỗi mic: ${ev.error || "unknown"}`,
        ),
      );
    };
    rec.onend = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (best.trim()) resolve({ text: best.trim(), provider: "web-speech" });
      else reject(new Error("Không nhận được lời nói. Thử nói lại rõ hơn."));
    };
    try {
      rec.start();
    } catch (err) {
      window.clearTimeout(timer);
      reject(err instanceof Error ? err : new Error("Không mở được micro."));
    }
  });
}

/**
 * Continuous browser Web Speech for hold/toggle mic.
 * Returns stop() that resolves with the final transcript.
 */
export function startBrowserSpeech(options?: {
  lang?: string;
  onInterim?: (text: string) => void;
}): { stop: () => Promise<string>; abort: () => void } {
  const Ctor = getSpeechRecognitionCtor();
  if (!Ctor) {
    return {
      stop: async () => "",
      abort: () => undefined,
    };
  }

  const recognition = new Ctor();
  recognition.lang = options?.lang || "vi-VN";
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = "";
  let interim = "";
  let settled = false;
  let resolveStop: ((text: string) => void) | null = null;

  recognition.onresult = (ev) => {
    let interimChunk = "";
    for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
      const piece = ev.results[i][0]?.transcript || "";
      if (ev.results[i].isFinal) {
        finalText = `${finalText} ${piece}`.trim();
      } else {
        interimChunk += piece;
      }
    }
    interim = interimChunk.trim();
    options?.onInterim?.([finalText, interim].filter(Boolean).join(" "));
  };

  recognition.onerror = () => {
    if (!settled && resolveStop) {
      settled = true;
      resolveStop((finalText || interim).trim());
    }
  };

  recognition.onend = () => {
    if (!settled && resolveStop) {
      settled = true;
      resolveStop((finalText || interim).trim());
    }
  };

  try {
    recognition.start();
  } catch {
    /* already started */
  }

  return {
    stop: () =>
      new Promise((resolve) => {
        resolveStop = resolve;
        try {
          recognition.stop();
        } catch {
          resolve((finalText || interim).trim());
        }
        window.setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve((finalText || interim).trim());
          }
        }, 1500);
      }),
    abort: () => {
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
      if (!settled && resolveStop) {
        settled = true;
        resolveStop((finalText || interim).trim());
      }
    },
  };
}

/** Record a short audio clip via MediaRecorder (fixed duration). */
export async function recordAudioBlob(
  maxMs = 5000,
  signal?: AbortSignal,
): Promise<Blob> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("Trình duyệt không hỗ trợ ghi âm.");
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime =
    typeof MediaRecorder !== "undefined" &&
    MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const stopped = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    };
    recorder.onerror = () => {
      stream.getTracks().forEach((t) => t.stop());
      reject(new Error("Ghi âm thất bại."));
    };
  });

  const onAbort = () => {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      stream.getTracks().forEach((t) => t.stop());
    }
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  recorder.start();
  await new Promise<void>((r) => window.setTimeout(r, maxMs));
  if (recorder.state !== "inactive") recorder.stop();
  signal?.removeEventListener("abort", onAbort);
  return stopped;
}

/** Push-to-talk MediaRecorder: caller stops when ready. */
export async function recordMicAudio(options?: {
  maxMs?: number;
  mimeType?: string;
}): Promise<{ mimeType: string; stop: () => void; done: Promise<Blob> }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType =
    options?.mimeType ||
    (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "");
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  let resolveDone: (b: Blob) => void = () => undefined;
  const done = new Promise<Blob>((resolve) => {
    resolveDone = resolve;
  });

  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    resolveDone(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
  };

  recorder.start();
  const maxMs = options?.maxMs ?? 20000;
  const timer = window.setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, maxMs);

  const stop = () => {
    window.clearTimeout(timer);
    if (recorder.state === "recording") recorder.stop();
  };

  return {
    mimeType: recorder.mimeType || "audio/webm",
    stop,
    done,
  };
}
