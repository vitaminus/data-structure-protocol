import fs from "node:fs";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export type TextDecodeResult =
  | {
      kind: "text";
      content: string;
    }
  | {
      kind: "binary" | "invalidUtf8";
    };

export function classifyTextBuffer(buffer: Uint8Array): TextDecodeResult {
  if (buffer.length === 0) {
    return { kind: "text", content: "" };
  }

  let suspiciousBytes = 0;
  const sampleLength = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = buffer[index]!;
    if (byte === 0) {
      return { kind: "binary" };
    }
    if ((byte <= 8 || (byte >= 14 && byte < 32) || byte === 127) && byte !== 9 && byte !== 10 && byte !== 13) {
      suspiciousBytes += 1;
    }
  }
  if (suspiciousBytes / sampleLength > 0.1) {
    return { kind: "binary" };
  }

  try {
    return {
      kind: "text",
      content: UTF8_DECODER.decode(buffer)
    };
  } catch {
    return { kind: "invalidUtf8" };
  }
}

export function readUtf8FileSafe(filePath: string): TextDecodeResult {
  return classifyTextBuffer(fs.readFileSync(filePath));
}

export function readUtf8PrefixSafe(
  filePath: string,
  maxChars: number
): { kind: "text"; content: string; truncated: boolean } | { kind: "binary" | "invalidUtf8" } {
  const maxBytes = Math.max(256, maxChars * 4);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(maxBytes);
    const bytesRead = fs.readSync(fd, buffer, 0, maxBytes, 0);
    const classified = classifyTextBuffer(buffer.subarray(0, bytesRead));
    if (classified.kind !== "text") {
      return classified;
    }
    const stat = fs.fstatSync(fd);
    return {
      kind: "text",
      content: classified.content.slice(0, maxChars),
      truncated: stat.size > bytesRead || classified.content.length >= maxChars
    };
  } finally {
    fs.closeSync(fd);
  }
}
