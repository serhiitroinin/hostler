// Terminal UI helpers: ANSI colors, a simple box table, and a y/N prompt.
// Colors are disabled automatically when NO_COLOR is set or stdout is not a TTY.

const colorEnabled = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(process.stdout.isTTY);
};

const wrap = (code: number) => (text: string): string =>
  colorEnabled() ? `\x1b[${code}m${text}\x1b[0m` : text;

export const red = wrap(31);
export const green = wrap(32);
export const yellow = wrap(33);
export const blue = wrap(34);
export const cyan = wrap(36);
export const bold = wrap(1);
export const dim = wrap(2);

// Convenience printers that mirror the Go version's color.Red / color.Cyan calls.
export const printError = (msg: string): void => console.error(red(`Error: ${msg}`));
export const printWarn = (msg: string): void => console.log(yellow(msg));
export const printInfo = (msg: string): void => console.log(cyan(msg));
export const printOk = (msg: string): void => console.log(green(msg));

export const rule = (): string => "─────────────────────────────────────";

// Render a bordered ASCII table. Header and rows are arrays of cell strings.
// `colorize` may transform a finished cell for display; widths are measured on
// the raw (uncolored) text so alignment stays correct regardless of ANSI codes.
export function table(
  header: string[],
  rows: string[][],
  colorize?: (cell: string, col: number, row: number) => string,
): string {
  const cols = header.length;
  const widths = header.map((h) => visibleLength(h));
  for (const row of rows) {
    for (let c = 0; c < cols; c++) {
      widths[c] = Math.max(widths[c]!, visibleLength(row[c] ?? ""));
    }
  }

  const sep = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const renderRow = (
    cells: string[],
    style: (cell: string, col: number) => string,
  ): string => {
    const rendered = cells.map((cell, c) => {
      const pad = " ".repeat(widths[c]! - visibleLength(cell));
      return ` ${style(cell, c)}${pad} `;
    });
    return "|" + rendered.join("|") + "|";
  };

  const lines = [sep, renderRow(header, (h) => cyan(bold(h))), sep];
  rows.forEach((row, i) =>
    lines.push(renderRow(row, (cell, c) => (colorize ? colorize(cell, c, i) : cell))),
  );
  lines.push(sep);
  return lines.join("\n");
}

// Length of a string ignoring ANSI escape sequences.
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// Prompt for a yes/no answer. Returns true only for an explicit y/Y.
export async function confirm(question: string): Promise<boolean> {
  process.stdout.write(question);
  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }
  return false;
}
