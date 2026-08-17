import pc from "picocolors";

export type LoggerFn = (text: string, type?: string) => void;

type LogLevel =
  | "info"
  | "success"
  | "warn"
  | "error"
  | "sys"
  | "system"
  | "core";

type SpinnerLike = {
  text?: string;
  start?: () => SpinnerLike;
  stop?: () => SpinnerLike;
  stopAndPersist?: (opts: {
    symbol: string;
    text: string;
  }) => SpinnerLike;
  succeed?: (text?: string) => SpinnerLike;
  fail?: (text?: string) => SpinnerLike;
  info?: (text?: string) => SpinnerLike;
  warn?: (text?: string) => SpinnerLike;
};

type ProgressLike = {
  start: (
    total: number,
    startValue: number,
    payload?: Record<string, unknown>
  ) => void;
  update: (
    value: number,
    payload?: Record<string, unknown>
  ) => void;
  stop: () => void;
};

type LoggerApi = LoggerFn & {
  fca: (text: string) => void;
  sys: (text: string) => void;
  success: (text: string) => void;
  warn: (text: string) => void;
  error: (text: string) => void;
  showBanner: () => Promise<void>;
  startSpinner: (
    text: string
  ) => Promise<SpinnerLike | null>;
  runMethodLoadProgress: (
    loaded: number
  ) => Promise<void>;
  persistCheckpointOk: (
    spinner: SpinnerLike | null
  ) => void;
  persistLoginSuccess: (
    spinner: SpinnerLike | null
  ) => void;
  persistLoginFail: (
    spinner: SpinnerLike | null
  ) => void;
};

let oraFactory:
  | ((options: Record<string, unknown>) => SpinnerLike)
  | null = null;

let progressCtor:
  | (new (
      options: Record<string, unknown>,
      preset?: Record<string, unknown>
    ) => ProgressLike)
  | null = null;

let progressPreset:
  | Record<string, unknown>
  | undefined;

/* ======================================================
 * Helpers
 * ====================================================== */

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function padLabel(
  label: string,
  width = 8
): string {
  return label.length >= width
    ? label
    : `${label}${" ".repeat(width - label.length)}`;
}

function getTimestamp(): string {
  const now = new Date();

  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");

  return `${hh}:${mm}:${ss}`;
}

function parseLabel(
  message: string,
  fallback: string
): {
  label: string;
  body: string;
} {
  const match = message.match(
    /^([A-Z][A-Z0-9 _-]{1,14})\s*:\s*(.+)$/
  );

  if (!match) {
    return {
      label: fallback,
      body: message
    };
  }

  return {
    label: match[1].trim(),
    body: match[2]
  };
}

function formatSuccessBody(
  body: string
): string {
  const match = body.match(
    /^Loaded (\d+) API methods(.*)$/i
  );

  if (match) {
    return (
      pc.dim("Loaded ") +
      pc.cyan(pc.bold(match[1])) +
      pc.dim(` API methods${match[2]}`)
    );
  }

  return pc.white(body);
}

/* ======================================================
 * Optional UI libraries
 * ====================================================== */

async function ensureUiLibs(): Promise<void> {
  if (!oraFactory) {
    try {
      const oraModule =
        (await import("ora")) as unknown as {
          default?: (
            options: Record<string, unknown>
          ) => SpinnerLike;
        };

      if (
        typeof oraModule.default ===
        "function"
      ) {
        oraFactory = oraModule.default;
      }
    } catch {
      /* ora is optional */
    }
  }

  if (!progressCtor) {
    try {
      const progressModule =
        (await import(
          "cli-progress"
        )) as unknown as {
          SingleBar?: new (
            options: Record<string, unknown>,
            preset?: Record<string, unknown>
          ) => ProgressLike;

          Presets?: {
            shades_classic?: Record<string, unknown>;
          };

          default?: {
            SingleBar?: new (
              options: Record<string, unknown>,
              preset?: Record<string, unknown>
            ) => ProgressLike;

            Presets?: {
              shades_classic?: Record<string, unknown>;
            };
          };
        };

      progressCtor =
        progressModule.SingleBar ??
        progressModule.default?.SingleBar ??
        null;

      progressPreset =
        progressModule.Presets
          ?.shades_classic ??
        progressModule.default
          ?.Presets
          ?.shades_classic;
    } catch {
      /* cli-progress is optional */
    }
  }
}

/* ======================================================
 * Logger
 * ====================================================== */

function logLine(
  text: string,
  type?: string
): void {
  const level =
    String(type || "info").toLowerCase() as LogLevel;

  const message = String(text ?? "");

  const timestamp = pc.dim(
    `[${getTimestamp()}]`
  );

  /* SUCCESS */

  if (level === "success") {
    const parts = parseLabel(
      message,
      "READY"
    );

    const body =
      parts.label === "READY"
        ? formatSuccessBody(parts.body)
        : pc.white(parts.body);

    const label = pc.green(
      pc.bold(
        padLabel(parts.label)
      )
    );

    writeStdout(
      `${timestamp} ` +
      `${pc.bgGreen(
        pc.black(
          pc.bold(" SUCCESS ")
        )
      )} ` +
      `${label} : ${body}`
    );

    return;
  }

  /* WARN */

  if (level === "warn") {
    const parts = parseLabel(
      message,
      "WARN"
    );

    writeStderr(
      `${timestamp} ` +
      `${pc.yellow(
        pc.bold(
          padLabel(parts.label)
        )
      )} : ` +
      `${pc.yellow(parts.body)}`
    );

    return;
  }

  /* ERROR */

  if (level === "error") {
    const parts = parseLabel(
      message,
      "ERROR"
    );

    writeStderr(
      `${timestamp} ` +
      `${pc.red(
        pc.bold(
          padLabel(parts.label)
        )
      )} : ` +
      `${pc.red(parts.body)}`
    );

    return;
  }

  /* SYSTEM */

  if (
    level === "sys" ||
    level === "system" ||
    level === "core"
  ) {
    const parts = parseLabel(
      message,
      "SYSTEM"
    );

    writeStdout(
      `${timestamp} ` +
      `${pc.blue(
        pc.bold(
          padLabel(parts.label)
        )
      )} : ` +
      `${pc.dim(
        pc.blue(parts.body)
      )}`
    );

    return;
  }

  /* INFO */

  const parts = parseLabel(
    message,
    "SESSION"
  );

  writeStdout(
    `${timestamp} ` +
    `${pc.cyan(
      pc.bold(
        padLabel(parts.label)
      )
    )} : ` +
    `${pc.cyan(parts.body)}`
  );
}

/* ======================================================
 * Public API
 * ====================================================== */

const baseLogger =
  logLine as LoggerApi;

baseLogger.fca = (
  text: string
): void => {
  baseLogger(
    `SESSION: ${text}`,
    "info"
  );
};

baseLogger.sys = (
  text: string
): void => {
  baseLogger(
    `SYSTEM: ${text}`,
    "sys"
  );
};

baseLogger.success = (
  text: string
): void => {
  baseLogger(
    text,
    "success"
  );
};

baseLogger.warn = (
  text: string
): void => {
  baseLogger(
    text,
    "warn"
  );
};

baseLogger.error = (
  text: string
): void => {
  baseLogger(
    text,
    "error"
  );
};

baseLogger.showBanner =
  async (): Promise<void> => {
    /* Kept for API compatibility. */
  };

/* ======================================================
 * Spinner
 * ====================================================== */

baseLogger.startSpinner =
  async (
    text: string
  ): Promise<SpinnerLike | null> => {
    await ensureUiLibs();

    if (
      !oraFactory ||
      !process.stdout.isTTY
    ) {
      return null;
    }

    try {
      const spinner =
        oraFactory({
          text: pc.cyan(
            String(text ?? "")
          ),
          color: "cyan",
          spinner: "dots"
        });

      if (
        typeof spinner.start ===
        "function"
      ) {
        return spinner.start();
      }

      return spinner;
    } catch {
      return null;
    }
  };

/* ======================================================
 * Method loading progress
 * ====================================================== */

baseLogger.runMethodLoadProgress =
  async (
    loaded: number
  ): Promise<void> => {
    await ensureUiLibs();

    const total =
      Number.isFinite(loaded)
        ? Math.max(
            0,
            Math.floor(loaded)
          )
        : 0;

    if (
      !progressCtor ||
      !process.stdout.isTTY ||
      total <= 0
    ) {
      return;
    }

    try {
      const bar =
        new progressCtor(
          {
            format:
              "fca · methods |{bar}| " +
              "{percentage}% | " +
              "{value}/{total}",

            barCompleteChar: "\u2588",
            barIncompleteChar: "\u2591",
            hideCursor: true,
            clearOnComplete: true,
            stopOnComplete: true
          },
          progressPreset
        );

      bar.start(total, 0);

      for (
        let value = 1;
        value <= total;
        value += 1
      ) {
        bar.update(value);
      }

      bar.stop();
    } catch {
      /* UI must never break the application. */
    }
  };

/* ======================================================
 * Login persistence
 * ====================================================== */

function stopSpinner(
  spinner: SpinnerLike | null
): void {
  if (
    !spinner ||
    typeof spinner.stop !==
      "function"
  ) {
    return;
  }

  try {
    spinner.stop();
  } catch {
    /* cosmetic failure */
  }
}

baseLogger.persistCheckpointOk =
  (
    spinner: SpinnerLike | null
  ): void => {
    stopSpinner(spinner);

    baseLogger(
      "SESSION: No checkpoint detected",
      "info"
    );
  };

baseLogger.persistLoginSuccess =
  (
    spinner: SpinnerLike | null
  ): void => {
    stopSpinner(spinner);
  };

baseLogger.persistLoginFail =
  (
    spinner: SpinnerLike | null
  ): void => {
    stopSpinner(spinner);
  };

export default baseLogger;
