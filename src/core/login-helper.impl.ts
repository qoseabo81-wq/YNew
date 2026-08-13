"use strict";

import EventEmitter from "node:events";
import axios from "axios";
import { DataTypes } from "sequelize";

import { attachLegacyApiSurface } from "../app/attach-legacy-api";
import { attachClientFacade } from "../compat/api-registry";
import models from "../database/models";
import logger from "../func/logger";
import { createRemoteClient } from "../remote/remoteClient";
import { saveCookies, getAppState } from "../utils/client";
import { getFrom } from "../utils/constants";

import { createAuthCore } from "./auth-helpers";
import { loadConfig } from "./config";
import { attachMqttCompatibility } from "./mqtt";
import { setOptions } from "./options";
import { createRequestCore } from "./request";
import {
  attachThreadUpdater,
  createApiFacade,
  createFcaState
} from "./state";
import { attachThreadInfoRealtimeSync } from "./thread-info-realtime-sync";

const { config } = loadConfig();

const axiosBase = axios;
const requestCore = createRequestCore();

const {
  get,
  post,
  jar,
  makeDefaults
} = requestCore;

const authCore = createAuthCore({
  config,
  logger,
  axiosBase
});

const REGION_MAP = authCore.REGION_MAP;

const g = globalThis as Loose;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function errMsg(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isValidUID(uid: Loose): uid is string {
  if (uid === undefined || uid === null) {
    return false;
  }

  const value = String(uid).trim();

  if (!value || value === "0") {
    return false;
  }

  if (!/^\d+$/.test(value)) {
    return false;
  }

  return Number(value) > 0;
}

/* -------------------------------------------------------------------------- */
/* Region                                                                     */
/* -------------------------------------------------------------------------- */

function parseRegion(html: string): string {
  return authCore.parseRegion(html);
}

/* -------------------------------------------------------------------------- */
/* API login                                                                  */
/* -------------------------------------------------------------------------- */

async function loginViaAPI(
  email: string,
  password: string,
  twoFactor: string | null = null,
  apiBaseUrl: string | null = null,
  apiKey: string | null = null
) {
  return authCore.loginViaAPI(
    email,
    password,
    twoFactor,
    apiBaseUrl,
    apiKey
  );
}

async function tokensViaAPI(
  email: string,
  password: string,
  twoFactor: string | null | undefined = null,
  apiBaseUrl: string | null | undefined = null
) {
  return authCore.tokensViaAPI(
    email,
    password,
    twoFactor ?? null,
    apiBaseUrl ?? null
  );
}

async function tokens(
  username: string,
  password: string,
  twofactor: string | null | undefined = null
) {
  return tokensViaAPI(
    username,
    password,
    twofactor
  );
}

/* -------------------------------------------------------------------------- */
/* Cookie helpers                                                             */
/* -------------------------------------------------------------------------- */

function normalizeCookieHeaderString(input: string): string[] {
  return authCore.normalizeCookieHeaderString(input);
}

function setJarFromPairs(
  targetJar: Loose,
  pairs: string[],
  domain: string
) {
  return authCore.setJarFromPairs(
    targetJar,
    pairs,
    domain
  );
}

function cookieHeaderFromJar(targetJar: Loose): string {
  const urls = [
    "https://www.facebook.com",
    "https://m.facebook.com"
  ];

  const seen = new Set<string>();
  const parts: string[] = [];

  for (const url of urls) {
    let cookieString = "";

    try {
      if (
        typeof targetJar?.getCookieStringSync === "function"
      ) {
        cookieString =
          targetJar.getCookieStringSync(url) || "";
      }
    } catch {
      cookieString = "";
    }

    if (!cookieString) {
      continue;
    }

    for (const rawCookie of cookieString.split(";")) {
      const cookie = rawCookie.trim();

      if (!cookie) {
        continue;
      }

      const eq = cookie.indexOf("=");

      if (eq <= 0) {
        continue;
      }

      const name = cookie.slice(0, eq).trim();

      if (!name || seen.has(name)) {
        continue;
      }

      seen.add(name);
      parts.push(cookie);
    }
  }

  return parts.join("; ");
}

/* -------------------------------------------------------------------------- */
/* UID extraction                                                             */
/* -------------------------------------------------------------------------- */

function getUIDFromCookies(cookies: Loose[]): string | null {
  if (!Array.isArray(cookies)) {
    return null;
  }

  const candidates = [
    "i_user",
    "c_user"
  ];

  for (const name of candidates) {
    const cookie = cookies.find(
      (item: Loose) =>
        item &&
        (
          item.key === name ||
          item.name === name
        )
    );

    if (cookie && isValidUID(cookie.value)) {
      return String(cookie.value);
    }
  }

  return null;
}

function getUIDFromHTML(body: Loose): string | null {
  const html =
    typeof body === "string"
      ? body
      : String(body ?? "");

  if (!html) {
    return null;
  }

  const patterns = [
    /"USER_ID"\s*:\s*"(\d+)"/,
    /\["CurrentUserInitialData",\[\],\{.*?"USER_ID":"(\d+)".*?\},\d+\]/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match?.[1] && isValidUID(match[1])) {
      return match[1];
    }
  }

  return null;
}

async function getUIDFromJar(
  targetJar: Loose
): Promise<string | null> {
  try {
    if (typeof targetJar?.getCookies !== "function") {
      return null;
    }

    const cookies =
      await targetJar.getCookies(
        "https://www.facebook.com"
      );

    return getUIDFromCookies(cookies);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Cookie conversion                                                          */
/* -------------------------------------------------------------------------- */

function cookieInputToPairs(input: Loose): string[] {
  if (!input) {
    return [];
  }

  if (typeof input === "string") {
    return normalizeCookieHeaderString(input);
  }

  if (Array.isArray(input)) {
    return input
      .map((cookie: Loose) => {
        if (typeof cookie === "string") {
          return cookie;
        }

        if (
          cookie &&
          typeof cookie === "object"
        ) {
          const key =
            cookie.key ||
            cookie.name;

          const value =
            cookie.value;

          if (
            key &&
            value !== undefined &&
            value !== null
          ) {
            return `${key}=${value}`;
          }
        }

        return null;
      })
      .filter(
        (value): value is string =>
          Boolean(value)
      );
  }

  if (
    typeof input === "object"
  ) {
    return Object.entries(input)
      .map(([key, value]) => {
        if (
          value === undefined ||
          value === null
        ) {
          return null;
        }

        return `${key}=${String(value)}`;
      })
      .filter(
        (value): value is string =>
          Boolean(value)
      );
  }

  return [];
}

/* -------------------------------------------------------------------------- */
/* AppState → Cookie jar                                                       */
/* -------------------------------------------------------------------------- */

async function setJarCookies(
  targetJar: Loose,
  appstate: Loose[]
): Promise<void> {
  if (!Array.isArray(appstate)) {
    return;
  }

  const tasks: Promise<unknown>[] = [];

  for (const cookie of appstate) {
    if (!cookie || typeof cookie !== "object") {
      continue;
    }

    const name =
      cookie.name ||
      cookie.key;

    const value =
      cookie.value;

    if (
      !name ||
      value === undefined ||
      value === null
    ) {
      continue;
    }

    const cookieDomain =
      cookie.domain ||
      ".facebook.com";

    const cookiePath =
      cookie.path ||
      "/";

    let expires = "";

    if (
      cookie.expirationDate !== undefined &&
      cookie.expirationDate !== null
    ) {
      try {
        const raw =
          Number(cookie.expirationDate);

        if (Number.isFinite(raw)) {
          const date =
            raw < 2_000_000_000
              ? new Date(raw * 1000)
              : new Date(raw);

          if (!Number.isNaN(date.getTime())) {
            expires =
              `; Expires=${date.toUTCString()}`;
          }
        }
      } catch {
        // Ignore invalid expiration.
      }
    }

    const cookieParts = [
      `${name}=${value}`,
      `Domain=${cookieDomain}`,
      `Path=${cookiePath}`
    ];

    if (expires) {
      cookieParts.push(
        expires.slice(2)
      );
    }

    if (cookie.secure === true) {
      cookieParts.push("Secure");
    }

    if (cookie.httpOnly === true) {
      cookieParts.push("HttpOnly");
    }

    if (cookie.sameSite) {
      const sameSite =
        String(cookie.sameSite)
          .toLowerCase();

      if (
        sameSite === "strict" ||
        sameSite === "lax" ||
        sameSite === "none"
      ) {
        cookieParts.push(
          `SameSite=${
            sameSite.charAt(0).toUpperCase() +
            sameSite.slice(1)
          }`
        );
      }
    }

    const host =
      cookieDomain.replace(/^\./, "");

    const urls = [
      `https://${host}${cookiePath}`,
      `https://www.${host}${cookiePath}`
    ];

    for (const url of urls) {
      try {
        if (
          typeof targetJar?.setCookie ===
          "function"
        ) {
          const result =
            targetJar.setCookie(
              cookieParts.join("; "),
              url
            );

          if (
            result &&
            typeof result.then === "function"
          ) {
            tasks.push(
              result.catch(() => undefined)
            );
          }
        }
      } catch {
        // Ignore individual invalid cookies.
      }
    }
  }

  if (tasks.length) {
    await Promise.allSettled(tasks);
  }
}

/* -------------------------------------------------------------------------- */
/* Session validation                                                         */
/* -------------------------------------------------------------------------- */

interface SessionState {
  html: string;
  cookies: Loose[];
  userID: string | null;
}

async function readFacebookSession(
  targetJar: Loose,
  html = ""
): Promise<SessionState> {
  let cookies: Loose[] = [];

  try {
    if (
      typeof targetJar?.getCookies ===
      "function"
    ) {
      cookies =
        await targetJar.getCookies(
          "https://www.facebook.com"
        );
    }
  } catch {
    cookies = [];
  }

  const cookieUID =
    getUIDFromCookies(cookies);

  const htmlUID =
    getUIDFromHTML(html);

  const userID =
    isValidUID(htmlUID)
      ? htmlUID
      : isValidUID(cookieUID)
        ? cookieUID
        : null;

  return {
    html,
    cookies,
    userID
  };
}

async function refreshFacebookSession(
  targetJar: Loose,
  globalOptions: Loose,
  attempts = 2
): Promise<SessionState> {
  let lastHtml = "";

  for (
    let attempt = 1;
    attempt <= attempts;
    attempt++
  ) {
    try {
      const response =
        await get(
          "https://www.facebook.com/",
          targetJar,
          null,
          globalOptions
        ).then(
          saveCookies(targetJar)
        );

      lastHtml =
        response?.data
          ? String(response.data)
          : "";

      const session =
        await readFacebookSession(
          targetJar,
          lastHtml
        );

      if (session.userID) {
        return session;
      }

      if (attempt < attempts) {
        await sleep(1000 * attempt);
      }
    } catch (error) {
      logger(
        `Session refresh attempt ${attempt} failed: ${errMsg(error)}`,
        "warn"
      );

      if (attempt < attempts) {
        await sleep(1000 * attempt);
      }
    }
  }

  return readFacebookSession(
    targetJar,
    lastHtml
  );
}

/* -------------------------------------------------------------------------- */
/* Database AppState backup                                                   */
/* -------------------------------------------------------------------------- */

let uniqueIndexEnsured = false;

function getBackupModel(): Loose | null {
  try {
    if (
      !models ||
      !models.sequelize ||
      !models.Sequelize
    ) {
      return null;
    }

    const sequelize = models.sequelize;

    if (
      typeof sequelize.define !== "function"
    ) {
      return null;
    }

    if (
      sequelize.models &&
      sequelize.models.AppStateBackup
    ) {
      return sequelize.models.AppStateBackup;
    }

    const dialect =
      typeof sequelize.getDialect === "function"
        ? sequelize.getDialect()
        : "sqlite";

    const LongText =
      dialect === "mysql" ||
      dialect === "mariadb"
        ? DataTypes.TEXT("long")
        : DataTypes.TEXT;

    try {
      return sequelize.define(
        "AppStateBackup",
        {
          id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
          },

          userID: {
            type: DataTypes.STRING,
            allowNull: false
          },

          type: {
            type: DataTypes.STRING,
            allowNull: false
          },

          data: {
            type: LongText
          }
        },
        {
          tableName: "app_state_backups",
          timestamps: true
        }
      );
    } catch (error) {
      logger(
        `Failed to define AppStateBackup: ${errMsg(error)}`,
        "warn"
      );

      return null;
    }
  } catch {
    return null;
  }
}

async function ensureUniqueIndex(
  sequelize: Loose
): Promise<void> {
  if (
    uniqueIndexEnsured ||
    !sequelize ||
    typeof sequelize.getQueryInterface !==
      "function"
  ) {
    return;
  }

  try {
    const queryInterface =
      sequelize.getQueryInterface();

    await queryInterface.addIndex(
      "app_state_backups",
      ["userID", "type"],
      {
        unique: true,
        name: "app_state_user_type_unique"
      }
    );
  } catch {
    /*
     * The index may already exist.
     * This should never prevent login.
     */
  }

  uniqueIndexEnsured = true;
}

async function upsertBackup(
  Model: Loose,
  userID: Loose,
  type: string,
  data: string
): Promise<void> {
  const normalizedUserID =
    String(userID || "");

  if (!normalizedUserID) {
    return;
  }

  const where = {
    userID: normalizedUserID,
    type
  };

  try {
    const existing =
      await Model.findOne({ where });

    if (existing) {
      await existing.update({ data });
      return;
    }

    await Model.create({
      ...where,
      data
    });
  } catch (error) {
    /*
     * A race condition can happen if two login
     * operations create the same backup together.
     *
     * Retry as update instead of killing login.
     */
    try {
      const existing =
        await Model.findOne({ where });

      if (existing) {
        await existing.update({ data });
        return;
      }
    } catch {
      // Ignore backup race.
    }

    throw error;
  }
}

async function backupAppStateSQL(
  targetJar: Loose,
  userID: Loose
): Promise<void> {
  try {
    if (!userID) {
      return;
    }

    const Model =
      getBackupModel();

    if (
      !Model ||
      !models?.sequelize
    ) {
      return;
    }

    await Model.sync();

    await ensureUniqueIndex(
      models.sequelize
    );

    const appState =
      getAppState(targetJar);

    const cookieHeader =
      cookieHeaderFromJar(targetJar);

    await upsertBackup(
      Model,
      userID,
      "appstate",
      JSON.stringify(appState || [])
    );

    await upsertBackup(
      Model,
      userID,
      "cookie",
      cookieHeader
    );

    logger(
      `SESSION: Backup saved for UID ${userID}`,
      "info"
    );
  } catch (error) {
    /*
     * Backup failure must not terminate a valid
     * Facebook session.
     */
    logger(
      `SESSION: Backup failed: ${errMsg(error)}`,
      "warn"
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Database backup retrieval                                                  */
/* -------------------------------------------------------------------------- */

async function getLatestBackup(
  userID: Loose,
  type: string
): Promise<string | null> {
  try {
    const Model =
      getBackupModel();

    if (!Model) {
      return null;
    }

    const row =
      await Model.findOne({
        where: {
          userID: String(userID || ""),
          type
        }
      });

    if (!row) {
      return null;
    }

    return (
      (row as Loose).data ?? null
    );
  } catch (error) {
    logger(
      `SESSION: Failed to read ${type} backup: ${errMsg(error)}`,
      "warn"
    );

    return null;
  }
}

async function getLatestBackupAny(
  type: string
): Promise<string | null> {
  try {
    const Model =
      getBackupModel();

    if (!Model) {
      return null;
    }

    const row =
      await Model.findOne({
        where: { type },
        order: [
          ["updatedAt", "DESC"]
        ]
      });

    if (!row) {
      return null;
    }

    return (
      (row as Loose).data ?? null
    );
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Restore session from database                                              */
/* -------------------------------------------------------------------------- */

async function hydrateJarFromDB(
  targetJar: Loose,
  userID?: Loose
): Promise<boolean> {
  try {
    let cookieBackup: string | null = null;
    let appStateBackup: string | null = null;

    if (userID) {
      cookieBackup =
        await getLatestBackup(
          userID,
          "cookie"
        );

      appStateBackup =
        await getLatestBackup(
          userID,
          "appstate"
        );
    } else {
      cookieBackup =
        await getLatestBackupAny(
          "cookie"
        );

      appStateBackup =
        await getLatestBackupAny(
          "appstate"
        );
    }

    /* ----------------------------- Cookie first -------------------------- */

    if (cookieBackup) {
      const pairs =
        normalizeCookieHeaderString(
          cookieBackup
        );

      if (pairs.length > 0) {
        setJarFromPairs(
          targetJar,
          pairs,
          ".facebook.com"
        );

        const session =
          await refreshFacebookSession(
            targetJar,
            {},
            1
          );

        if (session.userID) {
          logger(
            `SESSION: Restored from cookie backup, UID=${session.userID}`,
            "info"
          );

          return true;
        }
      }
    }

    /* ----------------------------- AppState ------------------------------- */

    if (appStateBackup) {
      try {
        const parsed =
          JSON.parse(
            appStateBackup
          );

        if (Array.isArray(parsed)) {
          await setJarCookies(
            targetJar,
            parsed
          );

          const session =
            await refreshFacebookSession(
              targetJar,
              {},
              1
            );

          if (session.userID) {
            logger(
              `SESSION: Restored from AppState backup, UID=${session.userID}`,
              "info"
            );

            return true;
          }
        }
      } catch (error) {
        logger(
          `SESSION: Invalid AppState backup: ${errMsg(error)}`,
          "warn"
        );
      }
    }

    return false;
  } catch (error) {
    logger(
      `SESSION: Database restore failed: ${errMsg(error)}`,
      "warn"
    );

    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* API cookie installation                                                    */
/* -------------------------------------------------------------------------- */

function installApiCookies(
  targetJar: Loose,
  response: Loose
): number {
  let pairs: string[] = [];

  if (response?.cookies) {
    pairs =
      cookieInputToPairs(
        response.cookies
      );
  }

  if (
    pairs.length === 0 &&
    response?.cookie
  ) {
    pairs =
      cookieInputToPairs(
        response.cookie
      );
  }

  if (!pairs.length) {
    return 0;
  }

  setJarFromPairs(
    targetJar,
    pairs,
    ".facebook.com"
  );

  return pairs.length;
}

/* -------------------------------------------------------------------------- */
/* API login                                                                  */
/* -------------------------------------------------------------------------- */

async function performApiLogin(
  targetJar: Loose,
  email: string,
  password: string,
  twoFactor: string | null,
  globalOptions: Loose
): Promise<SessionState> {
  if (!email || !password) {
    throw new Error(
      "Missing credentials for auto-login"
    );
  }

  logger(
    `AUTH: Starting API login for ${email.slice(0, 3)}***`,
    "info"
  );

  const response =
    await tokens(
      email,
      password,
      twoFactor
    );

  if (
    !response ||
    !response.status
  ) {
    throw new Error(
      response?.message ||
      "API login failed"
    );
  }

  const installed =
    installApiCookies(
      targetJar,
      response
    );

  if (!installed) {
    throw new Error(
      "API login returned no usable cookies"
    );
  }

  logger(
    `AUTH: Installed ${installed} cookies`,
    "info"
  );

  /*
   * Give the cookie jar a moment to finish
   * asynchronous writes before making the
   * validation request.
   */
  await sleep(300);

  const session =
    await refreshFacebookSession(
      targetJar,
      globalOptions,
      3
    );

  if (!session.userID) {
    throw new Error(
      "API login completed but Facebook session could not be validated"
    );
  }

  if (
    session.html.includes(
      "/checkpoint/block/?next"
    )
  ) {
    throw new Error(
      "Facebook returned a checkpoint"
    );
  }

  logger(
    `AUTH: API login validated, UID=${session.userID}`,
    "success"
  );

  return session;
}

/* -------------------------------------------------------------------------- */
/* Automatic session recovery                                                 */
/* -------------------------------------------------------------------------- */

async function tryAutoLoginIfNeeded(
  currentHtml: Loose,
  currentCookies: Loose,
  globalOptions: Loose,
  targetJar: Loose,
  hadAppStateInput = false
): Promise<SessionState> {
  const currentSession =
    await readFacebookSession(
      targetJar,
      typeof currentHtml === "string"
        ? currentHtml
        : ""
    );

  if (currentSession.userID) {
    return currentSession;
  }

  logger(
    "AUTH: Current session is not valid, starting recovery",
    "warn"
  );

  /* ---------------------------------------------------------------------- */
  /* 1. Existing AppState                                                   */
  /* ---------------------------------------------------------------------- */

  if (hadAppStateInput) {
    try {
      const session =
        await refreshFacebookSession(
          targetJar,
          globalOptions,
          2
        );

      if (session.userID) {
        logger(
          `AUTH: Existing AppState is valid, UID=${session.userID}`,
          "info"
        );

        return session;
      }
    } catch (error) {
      logger(
        `AUTH: Existing AppState validation failed: ${errMsg(error)}`,
        "warn"
      );
    }
  }

  /* ---------------------------------------------------------------------- */
  /* 2. Database backup                                                     */
  /* ---------------------------------------------------------------------- */

  const restored =
    await hydrateJarFromDB(
      targetJar
    );

  if (restored) {
    const session =
      await refreshFacebookSession(
        targetJar,
        globalOptions,
        2
      );

    if (session.userID) {
      logger(
        `AUTH: Database session restored, UID=${session.userID}`,
        "success"
      );

      return session;
    }

    logger(
      "AUTH: Database backup exists but is no longer valid",
      "warn"
    );
  }

  /* ---------------------------------------------------------------------- */
  /* 3. Credentials                                                         */
  /* ---------------------------------------------------------------------- */

  if (
    config.autoLogin === false ||
    String(config.autoLogin)
      .toLowerCase() === "false"
  ) {
    throw new Error(
      "AppState expired — Auto-login is disabled"
    );
  }

  const email =
    config.credentials?.email ||
    config.email;

  const password =
    config.credentials?.password ||
    config.password;

  const twoFactor =
    config.credentials?.twofactor ||
    config.twofactor ||
    null;

  if (!email || !password) {
    throw new Error(
      "Missing credentials for auto-login (email/password not configured)"
    );
  }

  const session =
    await performApiLogin(
      targetJar,
      String(email),
      String(password),
      twoFactor
        ? String(twoFactor)
        : null,
      globalOptions
    );

  return session;
}

/* -------------------------------------------------------------------------- */
/* Login context                                                              */
/* -------------------------------------------------------------------------- */

function createLoginContext(
  globalOptions: Loose
) {
  const ctx = {
    globalOptions,
    options: globalOptions,
    reconnectAttempts: 0,
    bypassAutomation: async function (
      response: Loose,
      targetJar: Loose
    ) {
      /*
       * Do not attempt to bypass Facebook security
       * or checkpoint mechanisms.
       *
       * We only normalize the response and allow
       * the caller to validate the session normally.
       */

      try {
        if (!response) {
          return response;
        }

        const responseUrl =
          response?.request?.res?.responseUrl ||
          (
            response?.config?.baseURL
              ? new URL(
                  String(
                    response.config.url || "/"
                  ),
                  String(
                    response.config.baseURL
                  )
                ).toString()
              : response?.config?.url || ""
          );

        const url =
          String(responseUrl || "");

        if (
          url.includes(
            "checkpoint/601051028565049"
          ) ||
          url.includes(
            "/checkpoint/block/"
          )
        ) {
          logger(
            "AUTH: Facebook checkpoint detected",
            "warn"
          );

          return response;
        }

        /*
         * Keep cookies synchronized after every
         * successful normal request.
         */
        try {
          if (
            typeof targetJar?.getCookies ===
            "function"
          ) {
            await targetJar.getCookies(
              "https://www.facebook.com"
            );
          }
        } catch {
          // Cookie synchronization is best-effort.
        }

        return response;
      } catch (error) {
        logger(
          `AUTH: Session processing error: ${errMsg(error)}`,
          "warn"
        );

        return response;
      }
    }
  } as Loose;

  return ctx;
}

/* -------------------------------------------------------------------------- */
/* Login                                                                      */
/* -------------------------------------------------------------------------- */

function makeLogin(
  targetJar: Loose,
  email: Loose,
  password: Loose,
  globalOptions: Loose
) {
  return async function () {
    const username =
      email ||
      config.credentials?.email;

    const secret =
      password ||
      config.credentials?.password;

    const twoFactor =
      config.credentials?.twofactor ||
      null;

    if (!username || !secret) {
      throw new Error(
        "Missing email/password"
      );
    }

    const session =
      await performApiLogin(
        targetJar,
        String(username),
        String(secret),
        twoFactor
          ? String(twoFactor)
          : null,
        globalOptions
      );

    if (!session.userID) {
      throw new Error(
        "Login succeeded but userID is missing"
      );
    }

    return session;
  };
}

/* -------------------------------------------------------------------------- */
/* Main login helper                                                          */
/* -------------------------------------------------------------------------- */

function loginHelper(
  appState: Loose,
  Cookie: Loose,
  email: Loose,
  password: Loose,
  globalOptions: Loose,
  callback: (
    error: Loose | null,
    api?: Loose
  ) => void
) {
  const ui =
    logger as Loose;

  const loginFlow = {
    spinner: null as Loose
  };

  let callbackCalled = false;

  const finish = (
    error: Loose | null,
    api?: Loose
  ) => {
    if (callbackCalled) {
      return;
    }

    callbackCalled = true;

    try {
      callback(error, api);
    } catch (callbackError) {
      logger(
        `AUTH: Login callback error: ${errMsg(callbackError)}`,
        "error"
      );
    }
  };

  const run = async () => {
    if (
      typeof ui.showBanner ===
      "function"
    ) {
      try {
        await ui.showBanner();
      } catch {
        // Banner is cosmetic.
      }
    }

    /* -------------------------------------------------------------------- */
    /* 1. Prepare AppState                                                  */
    /* -------------------------------------------------------------------- */

    let appStateInput =
      appState;

    let userIDFromAppState:
      string | null = null;

    if (Array.isArray(appStateInput)) {
      const userCookie =
        appStateInput.find(
          (cookie: Loose) =>
            cookie &&
            (
              cookie.key === "c_user" ||
              cookie.name === "c_user"
            )
        );

      if (
        userCookie &&
        isValidUID(userCookie.value)
      ) {
        userIDFromAppState =
          String(userCookie.value);
      }

      /*
       * Normalize name -> key without modifying
       * the original array.
       */
      appStateInput =
        appStateInput.map(
          (cookie: Loose) => {
            if (
              !cookie ||
              typeof cookie !== "object"
            ) {
              return cookie;
            }

            if (
              cookie.name &&
              !cookie.key
            ) {
              return {
                ...cookie,
                key: cookie.name
              };
            }

            return cookie;
          }
        );
    }

    if (
      typeof appStateInput ===
      "string"
    ) {
      try {
        const parsed =
          JSON.parse(appStateInput);

        if (Array.isArray(parsed)) {
          appStateInput = parsed;
        }
      } catch {
        /*
         * It may be a normal Cookie header.
         * Convert it to the same representation
         * used by the cookie jar.
         */
        const pairs =
          normalizeCookieHeaderString(
            appStateInput
          );

        if (pairs.length) {
          appStateInput =
            pairs.map(pair => {
              const index =
                pair.indexOf("=");

              if (index <= 0) {
                return null;
              }

              return {
                key: pair.slice(0, index),
                value: pair.slice(index + 1),
                domain: ".facebook.com",
                path: "/"
              };
            }).filter(Boolean);
        }
      }
    }

    /* -------------------------------------------------------------------- */
    /* 2. Install supplied cookies                                           */
    /* -------------------------------------------------------------------- */

    if (
      Array.isArray(appStateInput) &&
      appStateInput.length
    ) {
      await setJarCookies(
        jar,
        appStateInput
      );

      logger(
        `AUTH: Loaded ${appStateInput.length} AppState cookies`,
        "info"
      );
    }

    if (Cookie) {
      const cookiePairs =
        cookieInputToPairs(
          Cookie
        );

      if (cookiePairs.length) {
        setJarFromPairs(
          jar,
          cookiePairs,
          ".facebook.com"
        );

        logger(
          `AUTH: Loaded ${cookiePairs.length} Cookie values`,
          "info"
        );
      }
    }

    /* -------------------------------------------------------------------- */
    /* 3. Initial session check                                              */
    /* -------------------------------------------------------------------- */

    if (
      typeof ui.startSpinner ===
      "function"
    ) {
      try {
        loginFlow.spinner =
          await ui.startSpinner(
            "fca: Checking session status..."
          );
      } catch {
        loginFlow.spinner = null;
      }
    }

    let session:
      SessionState = {
        html: "",
        cookies: [],
        userID: null
      };

    try {
      session =
        await refreshFacebookSession(
          jar,
          globalOptions,
          2
        );
    } catch (error) {
      logger(
        `AUTH: Initial session check failed: ${errMsg(error)}`,
        "warn"
      );
    }

    /* -------------------------------------------------------------------- */
    /* 4. Recover expired session                                             */
    /* -------------------------------------------------------------------- */

    if (!session.userID) {
      logger(
        "AUTH: No valid session found, starting recovery",
        "warn"
      );

      session =
        await tryAutoLoginIfNeeded(
          session.html,
          session.cookies,
          globalOptions,
          jar,
          Boolean(
            appStateInput ||
            Cookie
          )
        );
    }

    if (!session.userID) {
      throw new Error(
        "Unable to establish a valid Facebook session"
      );
    }

    /* -------------------------------------------------------------------- */
    /* 5. Checkpoint handling                                                */
    /* -------------------------------------------------------------------- */

    if (
      session.html.includes(
        "/checkpoint/block/?next"
      )
    ) {
      throw new Error(
        "Facebook checkpoint detected"
      );
    }

    /* -------------------------------------------------------------------- */
    /* 6. Final session refresh                                              */
    /* -------------------------------------------------------------------- */

    let html =
      session.html || "";

    let cookies =
      session.cookies || [];

    /*
     * One final normal request ensures that
     * cookies and response data are synchronized.
     */
    try {
      const finalResponse =
        await get(
          "https://www.facebook.com/",
          jar,
          null,
          globalOptions
        ).then(
          saveCookies(jar)
        );

      const finalHtml =
        finalResponse?.data
          ? String(finalResponse.data)
          : "";

      if (finalHtml) {
        html = finalHtml;
      }

      cookies =
        await jar.getCookies(
          "https://www.facebook.com"
        );
    } catch (error) {
      logger(
        `AUTH: Final refresh failed: ${errMsg(error)}`,
        "warn"
      );
    }

    const htmlUID =
      getUIDFromHTML(html);

    const cookieUID =
      getUIDFromCookies(cookies);

    const userID =
      isValidUID(htmlUID)
        ? htmlUID
        : isValidUID(cookieUID)
          ? cookieUID
          : session.userID;

    if (!isValidUID(userID)) {
      throw new Error(
        "Login validation failed - no valid userID"
      );
    }

    /* -------------------------------------------------------------------- */
    /* 7. Region / MQTT information                                         */
    /* -------------------------------------------------------------------- */

    let mqttEndpoint:
      string | undefined;

    let region = "PRN";
    let fb_dtsg:
      string | undefined;

    let irisSeqID:
      Loose;

    try {
      const endpointMatch =
        html.match(
          /"endpoint":"([^"]+)"/
        ) ||
        html.match(
          /endpoint\\":\\"([^\\"]+)\\"/
        );

      if (endpointMatch?.[1]) {
        mqttEndpoint =
          endpointMatch[1]
            .replace(
              /\\\//g,
              "/"
            );
      }

      region =
        parseRegion(html);

      const regionInfo =
        REGION_MAP.get(region);

      if (regionInfo) {
        logger(
          `REGION: ${region} (${regionInfo.name})`,
          "info"
        );
      } else {
        logger(
          `REGION: ${region}`,
          "info"
        );
      }
    } catch (error) {
      logger(
        `REGION: Failed to parse region: ${errMsg(error)}`,
        "warn"
      );
    }

    /* -------------------------------------------------------------------- */
    /* 8. Facebook user information                                         */
    /* -------------------------------------------------------------------- */

    try {
      const userDataMatch =
        String(html).match(
          /\["CurrentUserInitialData",\[\],({.*?}),\d+\]/
        );

      if (userDataMatch?.[1]) {
        try {
          const info =
            JSON.parse(
              userDataMatch[1]
            );

          if (
            info?.USER_ID &&
            isValidUID(info.USER_ID)
          ) {
            logger(
              `ACCOUNT: ${info.NAME || "Unknown"} (${info.USER_ID})`,
              "info"
            );
          }
        } catch {
          logger(
            `ACCOUNT: UID=${userID}`,
            "info"
          );
        }
      } else {
        logger(
          `ACCOUNT: UID=${userID}`,
          "info"
        );
      }
    } catch {
      logger(
        `ACCOUNT: UID=${userID}`,
        "info"
      );
    }

    /* -------------------------------------------------------------------- */
    /* 9. DTSG                                                               */
    /* -------------------------------------------------------------------- */

    try {
      const tokenMatch =
        html.match(
          /DTSGInitialData.*?token":"(.*?)"/
        );

      if (tokenMatch?.[1]) {
        fb_dtsg =
          tokenMatch[1];
      }
    } catch {
      fb_dtsg = undefined;
    }

    /* -------------------------------------------------------------------- */
    /* 10. Save valid session                                                */
    /* -------------------------------------------------------------------- */

    try {
      await backupAppStateSQL(
        jar,
        userID
      );
    } catch {
      /*
       * backupAppStateSQL is already
       * best-effort, so ignore here.
       */
    }

    /* -------------------------------------------------------------------- */
    /* 11. Database connection                                               */
    /* -------------------------------------------------------------------- */

    Promise.resolve()
      .then(async () => {
        if (
          models?.sequelize &&
          typeof models.sequelize
            .authenticate === "function"
        ) {
          await models.sequelize
            .authenticate();
        }

        if (
          models &&
          typeof models.syncAll ===
            "function"
        ) {
          await models.syncAll();
        }
      })
      .catch(error => {
        logger(
          `Database initialization warning: ${errMsg(error)}`,
          "warn"
        );
      });

    /* -------------------------------------------------------------------- */
    /* 12. FCA state                                                         */
    /* -------------------------------------------------------------------- */

    const emitter =
      new EventEmitter();

    const ctxMain =
      createFcaState({
        userID,
        jar,
        globalOptions,
        lastSeqId: irisSeqID,
        mqttEndpoint,
        region,
        fb_dtsg,
        clientID:
          (
            Math.random() *
            2147483648
          )
            | 0
            .toString(16),
        clientId:
          getFrom(
            html,
            '["MqttWebDeviceID",[],{"clientID":"',
            '"'
          ) || "",
        emitter,
        bypassAutomation:
          async (
            response: Loose,
            targetJar: Loose
          ) => {
            const ctx =
              createLoginContext(
                globalOptions
              );

            return ctx.bypassAutomation(
              response,
              targetJar
            );
          }
      });

    /* -------------------------------------------------------------------- */
    /* 13. Automatic login callback                                         */
    /* -------------------------------------------------------------------- */

    ctxMain.performAutoLogin =
      async () => {
        try {
          const username =
            config.credentials?.email ||
            email;

          const secret =
            config.credentials?.password ||
            password;

          const twoFactor =
            config.credentials?.twofactor ||
            null;

          if (
            !username ||
            !secret
          ) {
            return false;
          }

          const recovered =
            await performApiLogin(
              jar,
              String(username),
              String(secret),
              twoFactor
                ? String(twoFactor)
                : null,
              globalOptions
            );

          return Boolean(
            recovered.userID
          );
        } catch (error) {
          logger(
            `AUTH: Automatic re-login failed: ${errMsg(error)}`,
            "warn"
          );

          return false;
        }
      };

    /* -------------------------------------------------------------------- */
    /* 14. API facade                                                        */
    /* -------------------------------------------------------------------- */

    const api =
      createApiFacade({
        globalOptions,
        jar,
        userID,
        emitter,
        setOptions,
        getAppState,
        cookieHeaderFromJar,
        getLatestBackup
      }) as Loose;

    const defaultFuncs =
      makeDefaults(
        html,
        userID,
        ctxMain
      );

    /* -------------------------------------------------------------------- */
    /* 15. Realtime database updates                                         */
    /* -------------------------------------------------------------------- */

    try {
      attachThreadUpdater(
        ctxMain,
        models,
        logger
      );
    } catch (error) {
      logger(
        `Realtime updater initialization failed: ${errMsg(error)}`,
        "warn"
      );
    }

    try {
      attachThreadInfoRealtimeSync(
        ctxMain,
        models,
        logger,
        api
      );
    } catch (error) {
      logger(
        `Thread realtime sync initialization failed: ${errMsg(error)}`,
        "warn"
      );
    }

    /* -------------------------------------------------------------------- */
    /* 16. Remote control                                                    */
    /* -------------------------------------------------------------------- */

    let remote:
      Loose = null;

    try {
      if (
        config?.remoteControl?.enabled
      ) {
        remote =
          createRemoteClient(
            api,
            ctxMain,
            config.remoteControl
          );
      }
    } catch (error) {
      logger(
        `Remote control initialization failed: ${errMsg(error)}`,
        "warn"
      );
    }

    if (remote) {
      api.remote = remote;
    }

    /* -------------------------------------------------------------------- */
    /* 17. Legacy FCA API                                                    */
    /* -------------------------------------------------------------------- */

    const legacyResult =
      attachLegacyApiSurface(
        api,
        defaultFuncs,
        ctxMain,
        logger
      );

    const {
      loaded,
      skipped,
      namespaces
    } = legacyResult;

    try {
      if (
        typeof ui.runMethodLoadProgress ===
        "function"
      ) {
        await ui.runMethodLoadProgress(
          loaded
        );
      }
    } catch {
      // UI progress is optional.
    }

    /* -------------------------------------------------------------------- */
    /* 18. Client facade                                                     */
    /* -------------------------------------------------------------------- */

    const client =
      attachClientFacade(
        api,
        namespaces
      );

    ctxMain.client =
      client;

    logger(
      `READY: Loaded ${loaded} API methods${
        skipped
          ? `, skipped ${skipped} duplicates`
          : ""
      }`,
      "success"
    );

    /* -------------------------------------------------------------------- */
    /* 19. MQTT compatibility                                                */
    /* -------------------------------------------------------------------- */

    try {
      ctxMain._fbDtsgRefreshInterval =
        attachMqttCompatibility(
          api,
          {
            logger,
            refreshIntervalMs:
              86400000
          }
        );
    } catch (error) {
      logger(
        `MQTT compatibility initialization failed: ${errMsg(error)}`,
        "warn"
      );
    }

    /* -------------------------------------------------------------------- */
    /* 20. Login success                                                      */
    /* -------------------------------------------------------------------- */

    try {
      if (
        typeof ui.persistLoginSuccess ===
        "function"
      ) {
        ui.persistLoginSuccess(
          loginFlow.spinner
        );
      } else if (
        loginFlow.spinner &&
        typeof loginFlow.spinner.succeed ===
          "function"
      ) {
        loginFlow.spinner.succeed(
          "fca: Login successful!"
        );
      }
    } catch {
      // Ignore UI errors.
    }

    loginFlow.spinner =
      null;

    logger(
      `AUTH: Login successful! UID=${userID}`,
      "success"
    );

    return api;
  };

  (async () => {
    try {
      const api =
        await run();

      finish(
        null,
        api
      );
    } catch (error) {
      try {
        if (
          typeof ui.persistLoginFail ===
          "function"
        ) {
          ui.persistLoginFail(
            loginFlow.spinner
          );
        } else if (
          loginFlow.spinner &&
          typeof loginFlow.spinner.fail ===
            "function"
        ) {
          loginFlow.spinner.fail(
            `fca: Login failed - ${errMsg(error)}`
          );
        }
      } catch {
        // Ignore UI errors.
      }

      loginFlow.spinner =
        null;

      logger(
        `AUTH: Login failed - ${errMsg(error)}`,
        "error"
      );

      finish(error);
    }
  })();
}

/* -------------------------------------------------------------------------- */
/* Exports                                                                    */
/* -------------------------------------------------------------------------- */

const exported =
  Object.assign(
    loginHelper,
    {
      loginHelper,
      tokensViaAPI,
      loginViaAPI,
      tokens,
      normalizeCookieHeaderString,
      setJarFromPairs
    }
  );

export default exported;