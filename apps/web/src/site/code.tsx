import { Fragment, useState } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

const KEYWORDS = new Set(["const", "await", "if", "import", "from", "export", "default", "return", "new", "true", "false", "async"]);

/** A tiny TypeScript highlighter: enough for the snippets on this page, no library. */
function highlight(code: string) {
  const re = /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d[\d_.]*)\b|\b([A-Za-z_$][\w$]*)(?=\s*\()|\b([A-Za-z_$][\w$]*)\b/gm;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(code))) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const [t, comment, str, num, fn, word] = m;
    const cls = comment ? "text-muted-foreground italic" : str ? "text-sol-green" : num ? "text-warning" : fn ? "text-sol-blue" : word && KEYWORDS.has(word) ? "text-sol-purple" : "";
    out.push(cls ? <span className={cls} key={i++}>{t}</span> : <Fragment key={i++}>{t}</Fragment>);
    last = m.index + t.length;
  }
  out.push(code.slice(last));
  return out;
}

export function CodeWindow({ tabs, className }: { tabs: { name: string; code: string }[]; className?: string }) {
  const [active, setActive] = useState(0);
  const [copied, setCopied] = useState(false);
  const tab = tabs[active]!;
  return (
    <div className={cn("overflow-hidden border bg-[#0a0a11]/90 text-left shadow-2xl shadow-sol-purple/10 backdrop-blur", className)}>
      <div className="flex items-center justify-between border-b pr-2">
        <div className="flex" role="tablist">
          {tabs.map((t, i) => (
            <button
              aria-selected={i === active}
              className={cn(
                "border-r px-4 py-2.5 text-xs transition-colors",
                i === active ? "bg-background text-foreground shadow-[inset_0_-1px_0_var(--color-sol-green)]" : "text-muted-foreground hover:text-foreground",
              )}
              key={t.name}
              onClick={() => setActive(i)}
              role="tab"
              type="button"
            >
              {t.name}
            </button>
          ))}
        </div>
        <button
          aria-label="Copy code"
          className="p-1.5 text-muted-foreground hover:text-foreground"
          onClick={async () => {
            await navigator.clipboard.writeText(tab.code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          type="button"
        >
          {copied ? <CheckIcon className="size-4 text-sol-green" /> : <CopyIcon className="size-4" />}
        </button>
      </div>
      <pre className="overflow-x-auto p-5 text-[12.5px] leading-relaxed">
        <code>{highlight(tab.code)}</code>
      </pre>
    </div>
  );
}
