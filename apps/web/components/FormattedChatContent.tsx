"use client";

import type { ReactNode } from "react";

type Block =
  | { type: "p"; lines: string[] }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] };

const BULLET_RE = /^\s*[-*•]\s+(.+)$/;
const NUMBERED_RE = /^\s*\d+\.\s+(.+)$/;

function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let ul: string[] | null = null;
  let ol: string[] | null = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push({ type: "p", lines: para });
      para = [];
    }
  };

  const flushList = () => {
    if (ul) {
      blocks.push({ type: "ul", items: ul });
      ul = null;
    }
    if (ol) {
      blocks.push({ type: "ol", items: ol });
      ol = null;
    }
  };

  for (const line of lines) {
    const bullet = line.match(BULLET_RE);
    const numbered = line.match(NUMBERED_RE);
    if (bullet) {
      flushPara();
      if (ol) flushList();
      if (!ul) ul = [];
      ul.push(bullet[1]);
    } else if (numbered) {
      flushPara();
      if (ul) flushList();
      if (!ol) ol = [];
      ol.push(numbered[1]);
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return <strong key={`${keyPrefix}-b${i}`}>{part.slice(2, -2)}</strong>;
    }
    return part ? <span key={`${keyPrefix}-t${i}`}>{part}</span> : null;
  });
}

function renderLines(lines: string[], keyPrefix: string): ReactNode {
  return lines.map((line, i) => (
    <span key={`${keyPrefix}-l${i}`}>
      {i > 0 && <br />}
      {renderInline(line, `${keyPrefix}-${i}`)}
    </span>
  ));
}

/** Lightweight structure for assistant replies: paragraphs, lists, bold, line breaks. */
export default function FormattedChatContent({ content }: { content: string }) {
  if (!content) return null;

  const blocks = parseBlocks(content);
  if (blocks.length === 0) {
    return <div className="chat-md">{content}</div>;
  }

  return (
    <div className="chat-md">
      {blocks.map((block, i) => {
        if (block.type === "ul") {
          return (
            <ul key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item, `u${i}-${j}`)}</li>
              ))}
            </ul>
          );
        }
        if (block.type === "ol") {
          return (
            <ol key={i}>
              {block.items.map((item, j) => (
                <li key={j}>{renderInline(item, `o${i}-${j}`)}</li>
              ))}
            </ol>
          );
        }
        return <p key={i}>{renderLines(block.lines, `p${i}`)}</p>;
      })}
    </div>
  );
}
