"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * "เข้าหลังเพลงก่อนหน้า" (TIMING_LABEL; พี่ 2026-10-19: "รวมให้เป็นตั้งเวลา ติดลบก็คือเล่นซ้อนเหมือนเดิม ถ้าเป็นค่า
 * บวกก็คือรอเพิ่มหลังเพลงก่อนหน้าจบ") — one signed number against the item BEFORE: -5 =
 * comes in 5 s before it ends ("เล่นซ้อน"), 3 = waits 3 s after it ends. It replaced the
 * separate "เล่นซ้อน" and "เผื่อเวลาหลัง" fields, which did two halves of one job (0049
 * folded the old waits into this number) - in the setlist builder, and since 2026-10-23
 * in Quick Show, whose "บัฟเฟอร์" / "สวน" were the same two halves.
 * A controlled numeric field cannot express a minus on a phone: iOS's
 * numeric keypad has no minus key, and even where one exists the intermediate
 * text "-" parses to NaN, so a controlled value would snap back to 0 the instant
 * the minus was typed and the user could never reach "-5". So the text is buffered
 * here and only a COMPLETE number is propagated; blur normalizes and commits.
 */
export function TimingInput({
  id,
  title,
  className,
  "aria-label": ariaLabel,
  seconds,
  disabled,
  onChange,
  onCommit,
}: {
  /** so a <Label htmlFor> can name the field */
  id?: string;
  title?: string;
  /** a smaller field, where the screen around it is (Quick Show's edit row) */
  className?: string;
  "aria-label"?: string;
  seconds: number;
  disabled?: boolean;
  onChange: (s: number) => void;
  onCommit: (s: number) => void;
}) {
  const [text, setText] = useState(String(seconds));
  useEffect(() => {
    setText(String(seconds));
  }, [seconds]);
  const parse = (raw: string): number | null => {
    const t = raw.trim();
    if (t === "" || t === "-") return null; // mid-typing, not a value yet
    const n = Number(t);
    return Number.isFinite(n) ? Math.max(-300, Math.min(300, Math.round(n))) : null;
  };
  return (
    <Input
      id={id}
      title={title}
      type="text"
      inputMode="text"
      placeholder="-5 หรือ 3"
      aria-label={ariaLabel}
      className={cn("num", className)}
      value={text}
      disabled={disabled}
      onChange={(e) => {
        setText(e.target.value);
        const n = parse(e.target.value);
        if (n != null) onChange(n);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      onBlur={(e) => {
        const n = parse(e.target.value) ?? 0;
        setText(String(n));
        // onChange first: clearing the field (or leaving it as a bare "-") never
        // parsed, so the parent still held the OLD value while blur wrote the new
        // one to the DB. The row's เริ่ม/จบ/สะสม, the total and the Hard Out badge
        // are all computed from that stale local copy — and a later version save
        // would have written it back over what the DB now says.
        onChange(n);
        onCommit(n);
      }}
    />
  );
}
