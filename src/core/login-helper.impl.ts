"use strict";

import EventEmitter from "node:events";
import axios from "axios";
import { DataTypes } from "sequelize";

import { attachLegacyApiSurface } from "../app/attach-legacy-api";
import { attachClientFacade } from "../compat/api-registry";
import models from "../database/models";
import logger from "../func/logger";
import { createRemoteClient } from "../remote/remoteClient";

import {
  saveCookies,
  getAppState
} from "../utils/client";

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

function errMsg(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (
    error &&
    typeof error === "object" &&
    "message" in error
  ) {
    return String((error as Loose).message);
  }

  return String(error);
}

const g = globalThis as Loose;

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function parseRegion(html: string): string {
  try {
    return authCore.parseRegion(html);
  } catch {
    return "PRN";
  }
}

/**
 * Validate Facebook user ID.
 *
 * Facebook may sometimes return:
 * - undefined
 * - null
 * - ""
 * - "0"
 *
 * Never treat those values as a valid session.
 */
function isValidUID(uid: Loose): boolean {
  if (
    uid === undefined ||
    uid === null ||
    uid === ""
  ) {
    return false;
  }

  const value = String(uid);

  if (value === "0") {
    return false;
  }

  return /^\d+$/.test(value) && Number(value) > 0;
}

/**
 * Extract UID from a cookie array.
 */
function getUIDFromCookies(cookies: Loose[]): string | null {
  if (!Array.isArray(cookies)) {
    return null;
  }

  const findCookie = (name: string) =>
    cookies.find(
      (cookie: Loose) =>
        cookie?.key === name ||
        cookie?.name === name
    )?.value;

  const uid =
    findCookie("c_user") ||
    findCookie("i_user");

  return isValidUID(uid)
    ? String(uid)
    : null;
}

/**
 * Extract UID from Facebook HTML.
 */
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

/**
 * Extract UID from either cookies or HTML.
 */
function resolveUID(
  html: Loose,
  cookies: Loose[]
): string | null {
  return (
    getUIDFromCookies(cookies) ||
    getUIDFromHTML(html)
  );
}

/**
 * Check whether Facebook returned a checkpoint page.
 */
function isCheckpointResponse(
  response: Loose
): boolean {
  const url =
    response?.request?.res?.responseUrl ||
    (
      response?.config?.baseURL
        ? new URL(
            String(response.config.url || "/"),
            String(response.config.baseURL)
          ).toString()
        : response?.config?.url || ""
    );

  const value = String(url || "");

  return (
    value.includes("/checkpoint/") ||
    value.includes("checkpoint/601051028565049") ||
    value.includes("/checkpoint/block/?next")
  );
}

/**
 * Safely convert a response body to string.
 */
function responseBody(response: Loose): string {
  if (!response) {
    return "";
  }

  if (typeof response.data === "string") {
    return response.data;
  }

  return String(response.data ?? "");
}

/**
 * Get Facebook cookies from the shared cookie jar.
 */
async function getFacebookCookies(
  cookieJar: Loose
): Promise<Loose[]> {
  try {
    if (
      !cookieJar ||
      typeof cookieJar.getCookies !== "function"
    ) {
      return [];
    }

    const cookies = await Promise.resolve(
      cookieJar.getCookies(
        "https://www.facebook.com"
      )
    );

    return Array.isArray(cookies)
      ? cookies
      : [];
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/* Cookie helpers                                                             */
/* -------------------------------------------------------------------------- */

function cookieHeaderFromJar(
  cookieJar: Loose
): string {
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
        typeof cookieJar?.getCookieStringSync ===
        "function"
      ) {
        cookieString =
          cookieJar.getCookieStringSync(url);
      }
    } catch {
      continue;
    }

    if (!cookieString) {
      continue;
    }

    for (const item of cookieString.split(";")) {
      const cookie = item.trim();

      if (!cookie) {
        continue;
      }

      const separator = cookie.indexOf("=");

      if (separator <= 0) {
        continue;
      }

      const name =
        cookie.slice(0, separator).trim();

      if (!name || seen.has(name)) {
        continue;
      }

      seen.add(name);
      parts.push(cookie);
    }
  }

  return parts.join("; ");
}

/**
 * Set cookies from an appstate array.
 *
 * This function intentionally handles malformed entries
 * without stopping the complete login process.
 */
async function setJarCookies(
  cookieJar: Loose,
  appState: Loose[]
): Promise<void> {
  if (
    !cookieJar ||
    typeof cookieJar.setCookie !== "function" ||
    !Array.isArray(appState)
  ) {
    return;
  }

  const tasks: Promise<unknown>[] = [];

  for (const cookie of appState) {
    if (!cookie || typeof cookie !== "object") {
      continue;
    }

    const name =
      cookie.key ||
      cookie.name;

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

    try {
      if (
        cookie.expirationDate !== undefined &&
        cookie.expirationDate !== null
      ) {
        let date: Date;

        if (
          typeof cookie.expirationDate === "number"
        ) {
          /*
           * Appstate exports normally use seconds,
           * while some tools use milliseconds.
           */
          const valueNumber =
            cookie.expirationDate;

          date =
            valueNumber < 10_000_000_000
              ? new Date(valueNumber * 1000)
              : new Date(valueNumber);
        } else {
          date =
            new Date(cookie.expirationDate);
        }

        if (!Number.isNaN(date.getTime())) {
          expires =
            `; Expires=${date.toUTCString()}`;
        }
      } else if (cookie.expires) {
        const date =
          new Date(cookie.expires);

        if (!Number.isNaN(date.getTime())) {
          expires =
            `; Expires=${date.toUTCString()}`;
        }
      }
    } catch {
      expires = "";
    }

    const parts = [
      `${name}=${value}${expires}`,
      `Domain=${cookieDomain}`,
      `Path=${cookiePath}`
    ];

    if (cookie.secure === true) {
      parts.push("Secure");
    }

    if (cookie.httpOnly === true) {
      parts.push("HttpOnly");
    }

    if (cookie.sameSite) {
      const sameSite =
        String(cookie.sameSite).toLowerCase();

      if (
        sameSite === "strict" ||
        sameSite === "lax" ||
        sameSite === "none"
      ) {
        parts.push(
          `SameSite=${
            sameSite.charAt(0).toUpperCase() +
            sameSite.slice(1)
          }`
        );
      }
    }

    const cookieString =
      parts.join("; ");

    /*
     * One canonical Facebook URL is enough.
     * The previous implementation repeatedly inserted
     * the same cookie into http/https/www combinations.
     */
    const urls = [
      `https://www.facebook.com${cookiePath}`,
      `https://m.facebook.com${cookiePath}`
    ];

    for (const url of urls) {
      tasks.push(
        Promise.resolve(
          cookieJar.setCookie(
            cookieString,
            url
          )
        ).catch(() => undefined)
      );
    }
  }

  await Promise.all(tasks);
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

function normalizeCookieHeaderString(
  cookieHeader: string
) {
  return authCore.normalizeCookieHeaderString(
    cookieHeader
  );
}

function setJarFromPairs(
  cookieJar: Loose,
  pairs: string[],
  domain: string
) {
  return authCore.setJarFromPairs(
    cookieJar,
    pairs,
    domain
  );
}

/* -------------------------------------------------------------------------- */
/* Backward compatibility                                                     */
/* -------------------------------------------------------------------------- */

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
/* Database backup                                                            */
/* -------------------------------------------------------------------------- */

let uniqueIndexEnsured = false;

function getBackupModel(): Loose | null {
  try {
    if (!models || !models.sequelize) {
      return null;
    }

    const sequelize = models.sequelize;

    if (
      typeof sequelize.define !== "function"
    ) {
      return null;
    }

    /*
     * Reuse the model if it has already been registered.
     * This prevents Sequelize "model already exists" errors.
     */
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

    const textType =
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
            type: textType,
            allowNull: true
          }
        },
        {
          tableName: "app_state_backups",

          timestamps: true,

          indexes: [
            {
              unique: true,
              fields: [
                "userID",
                "type"
              ]
            }
          ]
        }
      );
    } catch (error) {
      logger(
        `Failed to define AppStateBackup model: ${errMsg(error)}`,
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

    if (
      !queryInterface ||
      typeof queryInterface.addIndex !==
        "function"
    ) {
      return;
    }

    await queryInterface.addIndex(
      "app_state_backups",
      [
        "userID",
        "type"
      ],
      {
        unique: true,
        name:
          "app_state_user_type_unique"
      }
    );
  } catch {
    /*
     * The index may already exist.
     * This must never prevent login.
     */
  }

  uniqueIndexEnsured = true;
}

/**
 * Update an existing backup instead of creating duplicates.
 */
async function upsertBackup(
  Model: Loose,
  userID: Loose,
  type: string,
  data: Loose
): Promise<void> {
  if (
    !Model ||
    typeof Model.findOne !== "function" ||
    typeof Model.create !== "function"
  ) {
    return;
  }

  const normalizedUserID =
    String(userID || "");

  if (!normalizedUserID || !type) {
    return;
  }

  const where = {
    userID: normalizedUserID,
    type
  };

  try {
    const row =
      await Model.findOne({
        where
      });

    if (row) {
      if (
        typeof row.update === "function"
      ) {
        await row.update({
          data
        });

        logger(
          `Updated ${type} backup for user ${normalizedUserID}`,
          "sys"
        );
      }

      return;
    }

    await Model.create({
      ...where,
      data
    });

    logger(
      `Created ${type} backup for user ${normalizedUserID}`,
      "sys"
    );
  } catch (error) {
    /*
     * A duplicate can happen when two login flows
     * reach this function simultaneously.
     *
     * Try one final update instead of failing.
     */
    try {
      const existing =
        await Model.findOne({
          where
        });

      if (
        existing &&
        typeof existing.update ===
          "function"
      ) {
        await existing.update({
          data
        });

        logger(
          `Recovered duplicate ${type} backup for user ${normalizedUserID}`,
          "sys"
        );

        return;
      }
    } catch {
      // Ignore secondary database failure.
    }

    throw error;
  }
}

/**
 * Save the current session to SQL.
 *
 * Database failure is intentionally non-fatal.
 * The Facebook session itself must not fail because
 * Mongo/SQLite/MySQL/Postgres is temporarily unavailable.
 */
async function backupAppStateSQL(
  cookieJar: Loose,
  userID: Loose
): Promise<void> {
  try {
    if (!userID) {
      return;
    }

    const Model =
      getBackupModel();

    if (!Model || !models?.sequelize) {
      return;
    }

    /*
     * sync() is deliberately isolated.
     * If the database is unavailable, login continues.
     */
    try {
      if (
        typeof Model.sync === "function"
      ) {
        await Model.sync();
      }
    } catch (error) {
      logger(
        `AppState backup table sync failed: ${errMsg(error)}`,
        "warn"
      );

      return;
    }

    await ensureUniqueIndex(
      models.sequelize
    );

    let appState: Loose[] = [];

    try {
      const result =
        getAppState(cookieJar);

      if (Array.isArray(result)) {
        appState = result;
      }
    } catch {
      appState = [];
    }

    const cookieHeader =
      cookieHeaderFromJar(
        cookieJar
      );

    /*
     * Save AppState only when we actually have
     * something useful.
     */
    if (appState.length > 0) {
      await upsertBackup(
        Model,
        userID,
        "appstate",
        JSON.stringify(appState)
      );
    }

    /*
     * Save cookie header independently.
     * Failure of one backup should not prevent
     * the other from being saved.
     */
    if (cookieHeader) {
      try {
        await upsertBackup(
          Model,
          userID,
          "cookie",
          cookieHeader
        );
      } catch (error) {
        logger(
          `Failed to save cookie backup: ${errMsg(error)}`,
          "warn"
        );
      }
    }

    logger(
      `Session backup completed for user ${String(userID)}`,
      "sys"
    );
  } catch (error) {
    /*
     * NEVER allow database problems to break login.
     */
    logger(
      `Failed to save appstate backup: ${errMsg(error)}`,
      "warn"
    );
  }
}

async function getLatestBackup(
  userID: Loose,
  type: string
): Promise<string | null> {
  try {
    if (!userID || !type) {
      return null;
    }

    const Model =
      getBackupModel();

    if (
      !Model ||
      typeof Model.findOne !==
        "function"
    ) {
      return null;
    }

    const row =
      await Model.findOne({
        where: {
          userID: String(userID),
          type
        }
      });

    if (!row) {
      return null;
    }

    const data =
      (row as Loose).data;

    return data === undefined ||
      data === null
      ? null
      : String(data);
  } catch {
    return null;
  }
}

async function getLatestBackupAny(
  type: string
): Promise<string | null> {
  try {
    if (!type) {
      return null;
    }

    const Model =
      getBackupModel();

    if (
      !Model ||
      typeof Model.findOne !==
        "function"
    ) {
      return null;
    }

    const row =
      await Model.findOne({
        where: {
          type
        },
        order: [
          [
            "updatedAt",
            "DESC"
          ]
        ]
      });

    if (!row) {
      return null;
    }

    const data =
      (row as Loose).data;

    return data === undefined ||
      data === null
      ? null
      : String(data);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Restore session from database                                              */
/* -------------------------------------------------------------------------- */

async function hydrateJarFromDB(
  userID: Loose
): Promise<boolean> {
  try {
    let cookieBackup:
      | string
      | null = null;

    let appStateBackup:
      | string
      | null = null;

    /*
     * Prefer the requested user's backup.
     * Only fall back to the newest backup when
     * no specific userID was supplied.
     */
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

    /*
     * First try the cookie header.
     */
    if (cookieBackup) {
      try {
        const pairs =
          normalizeCookieHeaderString(
            cookieBackup
          );

        if (pairs.length > 0) {
          setJarFromPairs(
            jar,
            pairs,
            ".facebook.com"
          );

          const cookies =
            await getFacebookCookies(
              jar
            );

          if (
            getUIDFromCookies(
              cookies
            )
          ) {
            return true;
          }
        }
      } catch {
        // Continue to AppState fallback.
      }
    }

    /*
     * If cookie backup isn't usable,
     * restore the AppState backup.
     */
    if (appStateBackup) {
      try {
        const parsed =
          JSON.parse(
            appStateBackup
          );

        if (
          Array.isArray(parsed) &&
          parsed.length > 0
        ) {
          await setJarCookies(
            jar,
            parsed
          );

          const cookies =
            await getFacebookCookies(
              jar
            );

          if (
            getUIDFromCookies(
              cookies
            )
          ) {
            return true;
          }

          /*
           * Some AppState formats contain
           * only key/value pairs.
           */
          const pairs =
            parsed
              .map(
                (cookie: Loose) => {
                  const key =
                    cookie?.key ||
                    cookie?.name;

                  const value =
                    cookie?.value;

                  if (
                    !key ||
                    value === undefined
                  ) {
                    return null;
                  }

                  return `${key}=${value}`;
                }
              )
              .filter(
                (
                  value: string | null
                ): value is string =>
                  Boolean(value)
              );

          if (pairs.length > 0) {
            setJarFromPairs(
              jar,
              pairs,
              ".facebook.com"
            );

            const restoredCookies =
              await getFacebookCookies(
                jar
              );

            if (
              getUIDFromCookies(
                restoredCookies
              )
            ) {
              return true;
            }
          }
        }
      } catch {
        // Invalid AppState; continue normally.
      }
    }

    return false;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Automatic session recovery                                                */
/* -------------------------------------------------------------------------- */

async function tryAutoLoginIfNeeded(
  currentHtml: Loose,
  currentCookies: Loose[],
  globalOptions: Loose,
  ctxRef: Loose,
  hadAppStateInput = false
) {
  let html =
    typeof currentHtml === "string"
      ? currentHtml
      : String(currentHtml ?? "");

  let cookies = Array.isArray(currentCookies)
    ? currentCookies
    : [];

  /*
   * First: check the session we already have.
   */
  let userID =
    resolveUID(html, cookies);

  if (isValidUID(userID)) {
    return {
      html,
      cookies,
      userID
    };
  }

  logger(
    "No valid USER_ID found, attempting session recovery...",
    "warn"
  );

  /*
   * If the user supplied AppState/Cookie,
   * give the current session one chance to refresh.
   */
  if (hadAppStateInput) {
    try {
      const checkpoint =
        html.includes(
          "/checkpoint/block/?next"
        );

      if (!checkpoint) {
        const refreshed =
          await get(
            "https://www.facebook.com/",
            jar,
            null,
            globalOptions
          ).then(
            saveCookies(jar)
          );

        html =
          responseBody(refreshed);

        cookies =
          await getFacebookCookies(
            jar
          );

        userID =
          resolveUID(
            html,
            cookies
          );

        if (isValidUID(userID)) {
          logger(
            `Existing session refreshed successfully: ${userID}`,
            "info"
          );

          return {
            html,
            cookies,
            userID
          };
        }
      }
    } catch (error) {
      logger(
        `Existing session refresh failed: ${errMsg(error)}`,
        "warn"
      );
    }
  }

  /*
   * Second: try restoring the latest database backup.
   */
  try {
    const restored =
      await hydrateJarFromDB(
        null
      );

    if (restored) {
      logger(
        "Trying session restored from database backup...",
        "info"
      );

      const backupResponse =
        await get(
          "https://www.facebook.com/",
          jar,
          null,
          globalOptions
        ).then(
          saveCookies(jar)
        );

      const processed =
        (
          await ctxRef.bypassAutomation(
            backupResponse,
            jar
          )
        ) || backupResponse;

      const backupHtml =
        responseBody(processed);

      if (
        !isCheckpointResponse(
          processed
        )
      ) {
        const backupCookies =
          await getFacebookCookies(
            jar
          );

        const backupUID =
          resolveUID(
            backupHtml,
            backupCookies
          );

        if (
          isValidUID(backupUID)
        ) {
          logger(
            `Database session restored successfully: ${backupUID}`,
            "info"
          );

          return {
            html: backupHtml,
            cookies: backupCookies,
            userID: backupUID
          };
        }
      }

      logger(
        "Database session is no longer valid.",
        "warn"
      );
    }
  } catch (error) {
    logger(
      `Database session recovery failed: ${errMsg(error)}`,
      "warn"
    );
  }

  /* ------------------------------------------------------------------------ */
  /* API login                                                                */
  /* ------------------------------------------------------------------------ */

  if (
    config.autoLogin === false ||
    String(config.autoLogin).toLowerCase() ===
      "false"
  ) {
    throw new Error(
      "AppState expired — Auto-login is disabled"
    );
  }

  const username =
    config.credentials?.email ||
    config.email;

  const password =
    config.credentials?.password ||
    config.password;

  const twoFactor =
    config.credentials?.twofactor ||
    config.twofactor ||
    null;

  if (!username || !password) {
    logger(
      "No credentials configured for automatic login.",
      "error"
    );

    throw new Error(
      "Missing credentials for auto-login (email/password not configured)"
    );
  }

  logger(
    `Attempting API login for ${String(username).slice(0, 3)}***...`,
    "info"
  );

  const result =
    await tokens(
      username,
      password,
      twoFactor
    );

  if (
    !result ||
    !result.status
  ) {
    throw new Error(
      result?.message ||
        "API Login failed"
    );
  }

  logger(
    `API login successful. UID: ${result.uid || "unknown"}`,
    "success"
  );

  /*
   * Normalize cookies returned by the API.
   */
  let cookiePairs: string[] = [];

  const parseCookieValue = (
    value: Loose
  ): string[] => {
    if (!value) {
      return [];
    }

    if (typeof value === "string") {
      return normalizeCookieHeaderString(
        value
      );
    }

    if (Array.isArray(value)) {
      return value
        .map((cookie: Loose) => {
          if (
            typeof cookie === "string"
          ) {
            return cookie;
          }

          if (
            cookie &&
            typeof cookie === "object"
          ) {
            const key =
              cookie.key ||
              cookie.name;

            const val =
              cookie.value;

            if (
              key &&
              val !== undefined &&
              val !== null
            ) {
              return `${key}=${val}`;
            }
          }

          return null;
        })
        .filter(
          (
            value: string | null
          ): value is string =>
            Boolean(value)
        );
    }

    return [];
  };

  cookiePairs =
    parseCookieValue(
      result.cookies
    );

  if (
    cookiePairs.length === 0
  ) {
    cookiePairs =
      parseCookieValue(
        result.cookie
      );
  }

  if (
    cookiePairs.length === 0
  ) {
    throw new Error(
      "API login returned no cookies"
    );
  }

  logger(
    `Received ${cookiePairs.length} cookies from API`,
    "info"
  );

  setJarFromPairs(
    jar,
    cookiePairs,
    ".facebook.com"
  );

  /*
   * Give the cookie jar a moment to settle.
   */
  await new Promise(
    resolve =>
      setTimeout(resolve, 300)
  );

  /* ------------------------------------------------------------------------ */
  /* Establish the new Facebook session                                      */
  /* ------------------------------------------------------------------------ */

  const urls = [
    "https://m.facebook.com/",
    "https://www.facebook.com/"
  ];

  const maxAttempts = 3;

  let lastResponse: Loose = null;
  let lastHtml = "";

  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt++
  ) {
    const url =
      urls[
        Math.min(
          attempt,
          urls.length - 1
        )
      ];

    try {
      logger(
        `Refreshing Facebook session (${attempt + 1}/${maxAttempts}): ${url}`,
        "info"
      );

      const response =
        await get(
          url,
          jar,
          null,
          globalOptions
        ).then(
          saveCookies(jar)
        );

      lastResponse =
        (
          await ctxRef.bypassAutomation(
            response,
            jar
          )
        ) || response;

      lastHtml =
        responseBody(
          lastResponse
        );

      /*
       * Checkpoint after API login means
       * the session cannot be considered valid.
       */
      if (
        isCheckpointResponse(
          lastResponse
        ) ||
        lastHtml.includes(
          "/checkpoint/block/?next"
        )
      ) {
        throw new Error(
          "Checkpoint after API login"
        );
      }

      const responseCookies =
        await getFacebookCookies(
          jar
        );

      const responseUID =
        resolveUID(
          lastHtml,
          responseCookies
        );

      if (
        isValidUID(responseUID)
      ) {
        logger(
          `Session established successfully: USER_ID=${responseUID}`,
          "success"
        );

        return {
          html: lastHtml,
          cookies: responseCookies,
          userID: responseUID
        };
      }

      if (
        attempt <
        maxAttempts - 1
      ) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              700 * (attempt + 1)
            )
        );
      }
    } catch (error) {
      if (
        errMsg(error).includes(
          "Checkpoint after API login"
        )
      ) {
        throw error;
      }

      logger(
        `Session refresh attempt ${attempt + 1} failed: ${errMsg(error)}`,
        "warn"
      );

      if (
        attempt <
        maxAttempts - 1
      ) {
        await new Promise(
          resolve =>
            setTimeout(
              resolve,
              700 * (attempt + 1)
            )
        );
      }
    }
  }

  /*
   * Final fallback:
   * sometimes the API UID is valid even when Facebook's
   * HTML response does not immediately contain USER_ID.
   */
  const finalCookies =
    await getFacebookCookies(
      jar
    );

  const cookieUID =
    getUIDFromCookies(
      finalCookies
    );

  const htmlUID =
    getUIDFromHTML(
      lastHtml
    );

  const apiUID =
    isValidUID(result.uid)
      ? String(result.uid)
      : null;

  const finalUID =
    cookieUID ||
    htmlUID ||
    apiUID;

  if (!isValidUID(finalUID)) {
    throw new Error(
      "Login failed - could not establish a valid Facebook session"
    );
  }

  logger(
    `Using recovered UID=${finalUID} after final validation`,
    "warn"
  );

  return {
    html: lastHtml,
    cookies: finalCookies,
    userID: finalUID
  };
}

/* -------------------------------------------------------------------------- */
/* Direct login helper                                                        */
/* -------------------------------------------------------------------------- */

function makeLogin(
  cookieJar: Loose,
  email: Loose,
  password: Loose,
  globalOptions: Loose
) {
  return async function () {
    const username =
      email ||
      config.credentials?.email;

    const pass =
      password ||
      config.credentials?.password;

    const twoFactor =
      config.credentials?.twofactor ||
      null;

    if (!username || !pass) {
      throw new Error(
        "Email/password not configured"
      );
    }

    const result =
      await tokens(
        username,
        pass,
        twoFactor
      );

    if (
      !result ||
      !result.status
    ) {
      throw new Error(
        result?.message ||
          "Login failed"
      );
    }

    let pairs: string[] = [];

    if (
      typeof result.cookies ===
      "string"
    ) {
      pairs =
        normalizeCookieHeaderString(
          result.cookies
        );
    } else if (
      Array.isArray(
        result.cookies
      )
    ) {
      pairs =
        result.cookies
          .map(
            (cookie: Loose) => {
              if (
                typeof cookie ===
                "string"
              ) {
                return cookie;
              }

              const key =
                cookie?.key ||
                cookie?.name;

              const value =
                cookie?.value;

              return key &&
                value !== undefined
                ? `${key}=${value}`
                : null;
            }
          )
          .filter(
            (
              value: string | null
            ): value is string =>
              Boolean(value)
          );
    }

    if (
      pairs.length === 0 &&
      result.cookie
    ) {
      if (
        typeof result.cookie ===
        "string"
      ) {
        pairs =
          normalizeCookieHeaderString(
            result.cookie
          );
      } else if (
        Array.isArray(
          result.cookie
        )
      ) {
        pairs =
          result.cookie
            .map(
              (cookie: Loose) => {
                if (
                  typeof cookie ===
                  "string"
                ) {
                  return cookie;
                }

                const key =
                  cookie?.key ||
                  cookie?.name;

                const value =
                  cookie?.value;

                return key &&
                  value !== undefined
                  ? `${key}=${value}`
                  : null;
              }
            )
            .filter(
              (
                value: string | null
              ): value is string =>
                Boolean(value)
            );
      }
    }

    if (
      pairs.length === 0
    ) {
      throw new Error(
        "Login API returned no cookies"
      );
    }

    setJarFromPairs(
      cookieJar,
      pairs,
      ".facebook.com"
    );

    await get(
      "https://www.facebook.com/",
      cookieJar,
      null,
      globalOptions
    ).then(
      saveCookies(cookieJar)
    );
  };
}



/* -------------------------------------------------------------------------- */
/* Login helper                                                               */
/* -------------------------------------------------------------------------- */

function loginHelper(
  appState: Loose,
  Cookie: Loose,
  email: Loose,
  password: Loose,
  globalOptions: Loose,
  callback: (
    err: Loose | null,
    api?: Loose
  ) => void
) {
  const domain = ".facebook.com";
  const ui = logger as Loose;

  const loginFlow = {
    spinner: null as Loose
  };

  /*
   * Keep the original AppState UID as a fallback.
   */
  const extractUIDFromAppState = (
    input: Loose
  ): string | null => {
    if (!input) {
      return null;
    }

    let parsed = input;

    if (typeof input === "string") {
      try {
        parsed = JSON.parse(input);
      } catch {
        return null;
      }
    }

    if (!Array.isArray(parsed)) {
      return null;
    }

    return (
      parsed.find(
        (cookie: Loose) =>
          cookie?.key === "c_user" ||
          cookie?.name === "c_user"
      )?.value ||
      parsed.find(
        (cookie: Loose) =>
          cookie?.key === "i_user" ||
          cookie?.name === "i_user"
      )?.value ||
      null
    );
  };

  const userIDFromAppState =
    extractUIDFromAppState(
      appState
    );

  /*
   * Convert string AppState into a normalized array.
   */
  const normalizeAppState = (
    input: Loose
  ): Loose[] | null => {
    if (!input) {
      return null;
    }

    if (Array.isArray(input)) {
      return input.map(
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

    if (typeof input !== "string") {
      return null;
    }

    /*
     * First try JSON.
     */
    try {
      const parsed =
        JSON.parse(input);

      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON. Continue with cookie header.
    }

    /*
     * Then support:
     *
     * c_user=123; xs=...; fr=...
     */
    const result: Loose[] = [];

    for (
      const part of input.split(";")
    ) {
      const item = part.trim();

      if (!item) {
        continue;
      }

      const separator =
        item.indexOf("=");

      if (separator <= 0) {
        continue;
      }

      const key =
        item.slice(
          0,
          separator
        ).trim();

      const value =
        item.slice(
          separator + 1
        ).trim();

      if (!key || !value) {
        continue;
      }

      result.push({
        key,
        value,
        domain: ".facebook.com",
        path: "/"
      });
    }

    return result.length > 0
      ? result
      : null;
  };

  /*
   * Normalize Cookie input.
   */
  const normalizeCookieInput = (
    input: Loose
  ): string[] => {
    if (!input) {
      return [];
    }

    if (typeof input === "string") {
      return normalizeCookieHeaderString(
        input
      );
    }

    if (Array.isArray(input)) {
      return input
        .map((item: Loose) =>
          typeof item === "string"
            ? item
            : item &&
              typeof item === "object"
              ? `${
                  item.key ||
                  item.name ||
                  ""
                }=${item.value ?? ""}`
              : ""
        )
        .filter(Boolean);
    }

    if (
      typeof input ===
      "object"
    ) {
      return Object.entries(
        input
      )
        .map(
          ([key, value]) =>
            `${key}=${String(value)}`
        )
        .filter(Boolean);
    }

    return [];
  };

  /*
   * One shared automation/checkpoint handler.
   *
   * The old implementation had this function duplicated
   * twice inside loginHelper(). This version keeps one copy.
   */
  const createBypassAutomation = (
    loginContext: Loose
  ) => {
    return async function (
      response: Loose,
      cookieJar: Loose
    ) {
      g.fca =
        g.fca || {};

      g.fca.BypassAutomationNotification =
        loginContext.bypassAutomation.bind(
          loginContext
        );

      const body =
        responseBody(response);

      const getCurrentUID =
        async (): Promise<
          string | null
        > => {
          try {
            const cookies =
              await getFacebookCookies(
                cookieJar
              );

            return getUIDFromCookies(
              cookies
            );
          } catch {
            return null;
          }
        };

      const extractToken = (
        html: string
      ) => {
        const fbDtsg =
          getFrom(
            html,
            '"DTSGInitData",[],{"token":"',
            '",'
          ) ||
          html.match(
            /name="fb_dtsg"\s+value="([^"]+)"/
          )?.[1];

        const jazoest =
          getFrom(
            html,
            'name="jazoest" value="',
            '"'
          ) ||
          getFrom(
            html,
            "jazoest=",
            '",'
          ) ||
          html.match(
            /name="jazoest"\s+value="([^"]+)"/
          )?.[1];

        const lsd =
          getFrom(
            html,
            '["LSD",[],{"token":"',
            '"}'
          ) ||
          html.match(
            /name="lsd"\s+value="([^"]+)"/
          )?.[1];

        return {
          fbDtsg,
          jazoest,
          lsd
        };
      };

      const bypassCheckpoint =
        async (
          html: string
        ) => {
          try {
            const uid =
              await getCurrentUID() ||
              getUIDFromHTML(
                html
              );

            if (
              !isValidUID(uid)
            ) {
              logger(
                "Cannot bypass automation warning: USER_ID unavailable",
                "warn"
              );

              return;
            }

            const {
              fbDtsg,
              jazoest,
              lsd
            } =
              extractToken(
                html
              );

            if (
              !fbDtsg &&
              !jazoest &&
              !lsd
            ) {
              logger(
                "Facebook automation warning detected, but required tokens were not found",
                "warn"
              );

              return;
            }

            const form = {
              av: uid,
              fb_dtsg: fbDtsg,
              jazoest,
              lsd,
              fb_api_caller_class:
                "RelayModern",
              fb_api_req_friendly_name:
                "FBScrapingWarningMutation",
              variables:
                "{}",
              server_timestamps:
                true,
              doc_id:
                "6339492849481770"
            };

            await post(
              "https://www.facebook.com/api/graphql/",
              cookieJar,
              form,
              null,
              loginContext.options
            ).then(
              saveCookies(cookieJar)
            );

            loginContext.reconnectAttempts = 0;

            logger(
              "Facebook automation warning handled",
              "warn"
            );
          } catch (error) {
            logger(
              `Automation warning handler failed: ${errMsg(error)}`,
              "warn"
            );
          }
        };

      try {
        /*
         * If we already have a response,
         * inspect it first.
         */
        if (response) {
          if (
            isCheckpointResponse(
              response
            )
          ) {
            await bypassCheckpoint(
              body
            );

            const refreshed =
              await get(
                "https://www.facebook.com/",
                cookieJar,
                null,
                loginContext.options
              ).then(
                saveCookies(
                  cookieJar
                )
              );

            if (
              isCheckpointResponse(
                refreshed
              )
            ) {
              logger(
                "Checkpoint still present after automation handling",
                "warn"
              );
            } else {
              logger(
                "Session refreshed after automation handling",
                "info"
              );
            }

            return refreshed;
          }

          return response;
        }

        /*
         * No response supplied: perform initial request.
         */
        const first =
          await get(
            "https://www.facebook.com/",
            cookieJar,
            null,
            loginContext.options
          ).then(
            saveCookies(
              cookieJar
            )
          );

        if (
          isCheckpointResponse(
            first
          )
        ) {
          await bypassCheckpoint(
            responseBody(first)
          );

          const refreshed =
            await get(
              "https://www.facebook.com/",
              cookieJar,
              null,
              loginContext.options
            ).then(
              saveCookies(
                cookieJar
              )
            );

          return refreshed;
        }

        return first;
      } catch (error) {
        logger(
          `Bypass automation error: ${errMsg(error)}`,
          "warn"
        );

        /*
         * Never destroy an otherwise usable response
         * because the bypass handler itself failed.
         */
        return response;
      }
    };
  };

  /*
   * Main asynchronous login flow.
   */
  (async () => {
    try {
      if (
        typeof ui.showBanner ===
        "function"
      ) {
        await ui.showBanner();
      }

      /* -------------------------------------------------------------------- */
      /* Load AppState / Cookies                                              */
      /* -------------------------------------------------------------------- */

      if (appState) {
        const normalized =
          normalizeAppState(
            appState
          );

        if (
          !normalized ||
          normalized.length === 0
        ) {
          throw new Error(
            "Invalid appState format"
          );
        }

        await setJarCookies(
          jar,
          normalized
        );
      }

      if (Cookie) {
        const pairs =
          normalizeCookieInput(
            Cookie
          );

        if (pairs.length > 0) {
          setJarFromPairs(
            jar,
            pairs,
            domain
          );
        }
      }

      /* -------------------------------------------------------------------- */
      /* Temporary login context                                              */
      /* -------------------------------------------------------------------- */

      const loginContext = {
        globalOptions,
        options: globalOptions,
        reconnectAttempts: 0
      } as Loose;

      loginContext.bypassAutomation =
        createBypassAutomation(
          loginContext
        );

      let response: Loose;

      /*
       * If AppState/Cookie was supplied,
       * use it directly.
       */
      if (
        appState ||
        Cookie
      ) {
        response =
          await get(
            "https://www.facebook.com/",
            jar,
            null,
            globalOptions
          ).then(
            saveCookies(jar)
          );

        response =
          (
            await loginContext.bypassAutomation(
              response,
              jar
            )
          ) || response;
      } else {
        /*
         * No credentials/session supplied.
         * Try database backup first.
         */
        const restored =
          await hydrateJarFromDB(
            null
          );

        if (restored) {
          logger(
            "AppState backup restored from database",
            "info"
          );

          response =
            await get(
              "https://www.facebook.com/",
              jar,
              null,
              globalOptions
            ).then(
              saveCookies(jar)
            );

          response =
            (
              await loginContext.bypassAutomation(
                response,
                jar
              )
            ) || response;
        } else {
          /*
           * No backup — use configured credentials.
           */
          logger(
            "No valid AppState backup found, attempting credential login",
            "warn"
          );

          response =
            await get(
              "https://www.facebook.com/",
              null,
              null,
              globalOptions
            ).then(
              saveCookies(jar)
            );

          await makeLogin(
            jar,
            email,
            password,
            globalOptions
          )();

          response =
            await get(
              "https://www.facebook.com/",
              jar,
              null,
              globalOptions
            ).then(
              saveCookies(jar)
            );
        }
      }

      return {
        response,
        loginContext
      };
    } catch (error) {
      throw error;
    }
  })()
    .then(
      async ({
        response,
        loginContext
      }) => {
        /* ------------------------------------------------------------------ */
        /* Spinner                                                             */
        /* ------------------------------------------------------------------ */

        if (
          typeof ui.startSpinner ===
          "function"
        ) {
          loginFlow.spinner =
            await ui.startSpinner(
              "fca: Checking session status..."
            );
        }

        let processed =
          response;

        /*
         * Run the automation handler once more
         * on the final response.
         */
        processed =
          (
            await loginContext.bypassAutomation(
              processed,
              jar
            )
          ) || processed;

        if (
          typeof ui.persistCheckpointOk ===
          "function"
        ) {
          ui.persistCheckpointOk(
            loginFlow.spinner
          );
        } else if (
          loginFlow.spinner &&
          typeof loginFlow.spinner
            .stopAndPersist ===
            "function"
        ) {
          loginFlow.spinner.stopAndPersist(
            {
              symbol: "ℹ",
              text:
                "fca: No checkpoint detected"
            }
          );
        }

        loginFlow.spinner = null;

        /* ------------------------------------------------------------------ */
        /* Extract session information                                        */
        /* ------------------------------------------------------------------ */

        if (
          typeof ui.startSpinner ===
          "function"
        ) {
          loginFlow.spinner =
            await ui.startSpinner(
              "fca: Finalizing login..."
            );
        }

        let html =
          responseBody(
            processed
          );

        let cookies =
          await getFacebookCookies(
            jar
          );

        let userID =
          resolveUID(
            html,
            cookies
          );

        /*
         * AppState UID is only a fallback.
         */
        if (
          !isValidUID(userID) &&
          isValidUID(
            userIDFromAppState
          )
        ) {
          userID =
            String(
              userIDFromAppState
            );
        }

        /* ------------------------------------------------------------------ */
        /* Automatic recovery                                                 */
        /* ------------------------------------------------------------------ */

        if (
          !isValidUID(userID)
        ) {
          logger(
            "No valid USER_ID detected, starting automatic recovery...",
            "warn"
          );

          const recovered =
            await tryAutoLoginIfNeeded(
              html,
              cookies,
              globalOptions,
              loginContext,
              Boolean(
                appState ||
                Cookie
              )
            );

          html =
            recovered.html;

          cookies =
            recovered.cookies;

          userID =
            recovered.userID;
        }

        if (
          !isValidUID(userID)
        ) {
          throw new Error(
            "Login validation failed - no valid USER_ID found"
          );
        }

        /* ------------------------------------------------------------------ */
        /* Checkpoint validation                                              */
        /* ------------------------------------------------------------------ */

        if (
          html.includes(
            "/checkpoint/block/?next"
          )
        ) {
          logger(
            "AppState expired or checkpoint detected",
            "error"
          );

          throw new Error(
            "Checkpoint"
          );
        }

        if (
          isCheckpointResponse(
            processed
          )
        ) {
          throw new Error(
            "Checkpoint"
          );
        }

        /* ------------------------------------------------------------------ */
        /* Final session refresh                                              */
        /* ------------------------------------------------------------------ */

        let finalHtmlUID =
          getUIDFromHTML(
            html
          );

        if (
          !isValidUID(
            finalHtmlUID
          )
        ) {
          /*
           * Cookies may already contain a valid session.
           * Try one lightweight refresh before failing.
           */
          logger(
            `HTML USER_ID missing, attempting session activation using UID=${userID}`,
            "warn"
          );

          try {
            const refresh =
              await get(
                "https://m.facebook.com/home.php",
                jar,
                null,
                globalOptions
              ).then(
                saveCookies(jar)
              );

            const refreshHtml =
              responseBody(
                refresh
              );

            const refreshUID =
              getUIDFromHTML(
                refreshHtml
              );

            if (
              isValidUID(
                refreshUID
              )
            ) {
              html =
                refreshHtml;

              finalHtmlUID =
                refreshUID;

              userID =
                refreshUID;

              cookies =
                await getFacebookCookies(
                  jar
                );

              logger(
                `Session activated successfully: ${userID}`,
                "info"
              );
            }
          } catch (error) {
            logger(
              `Session activation failed: ${errMsg(error)}`,
              "warn"
            );
          }
        }

        /*
         * A valid cookie UID is sufficient as a final fallback.
         */
        if (
          !isValidUID(userID)
        ) {
          throw new Error(
            "Login validation failed - invalid USER_ID"
          );
        }

        /* ------------------------------------------------------------------ */
        /* Facebook account information                                       */
        /* ------------------------------------------------------------------ */

        let mqttEndpoint:
          | string
          | undefined;

        let region =
          "PRN";

        let fb_dtsg:
          | string
          | undefined;

        let irisSeqID:
          | Loose;

        try {
          const direct =
            html.match(
              /"endpoint":"([^"]+)"/
            );

          const escaped =
            !direct
              ? html.match(
                  /endpoint\\":\\"([^\\"]+)\\"/
                )
              : null;

          const raw =
            direct?.[1] ||
            escaped?.[1];

          if (raw) {
            mqttEndpoint =
              raw.replace(
                /\\\//g,
                "/"
              );
          }

          region =
            parseRegion(
              html
            );

          const regionInfo =
            REGION_MAP.get(
              region
            );

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
            `MQTT endpoint parsing failed: ${errMsg(error)}`,
            "warn"
          );
        }

        /* ------------------------------------------------------------------ */
        /* CurrentUserInitialData                                             */
        /* ------------------------------------------------------------------ */

        try {
          const match =
            html.match(
              /\["CurrentUserInitialData",\[\],({.*?}),\d+\]/
            );

          if (match?.[1]) {
            try {
              const info =
                JSON.parse(
                  match[1]
                );

              if (
                isValidUID(
                  info?.USER_ID
                )
              ) {
                userID =
                  String(
                    info.USER_ID
                  );
              }

              if (
                info?.NAME
              ) {
                logger(
                  `ACCOUNT: ${info.NAME} (${userID})`,
                  "info"
                );
              } else {
                logger(
                  `ACCOUNT: ${userID}`,
                  "info"
                );
              }
            } catch {
              logger(
                `ACCOUNT: ${userID}`,
                "info"
              );
            }
          } else {
            logger(
              `ACCOUNT: ${userID}`,
              "info"
            );
          }
        } catch {
          logger(
            `ACCOUNT: ${userID}`,
            "info"
          );
        }

        /* ------------------------------------------------------------------ */
        /* DTSG                                                                */
        /* ------------------------------------------------------------------ */

        try {
          const tokenMatch =
            html.match(
              /DTSGInitialData.*?token":"(.*?)"/
            );

          if (
            tokenMatch?.[1]
          ) {
            fb_dtsg =
              tokenMatch[1];
          }
        } catch {
          fb_dtsg =
            undefined;
        }

        /*
         * Backup the valid session.
         *
         * This operation is intentionally non-fatal.
         */
        try {
          await backupAppStateSQL(
            jar,
            userID
          );
        } catch (error) {
          logger(
            `Session backup skipped: ${errMsg(error)}`,
            "warn"
          );
        }


        const api = createApiFacade({
          globalOptions,
          jar,
          userID,
          emitter,
          setOptions,
          getAppState,
          cookieHeaderFromJar,
          getLatestBackup
        }) as Loose;

        const defaultFuncs = makeDefaults(
          html,
          userID,
          ctxMain
        );

        // Attach lightweight DB updaters for realtime events (MQTT)
        try {
          if (models) {
            attachThreadUpdater(
              ctxMain,
              models,
              logger
            );
          }
        } catch (e) {
          logger(
            `Thread updater initialization failed: ${errMsg(e)}`,
            "warn"
          );
        }

        // Remote control client
        let remote: Loose = null;

        try {
          if (
            config &&
            config.remoteControl &&
            config.remoteControl.enabled
          ) {
            remote = createRemoteClient(
              api,
              ctxMain,
              config.remoteControl
            );
          }
        } catch (e) {
          logger(
            `Remote control initialization failed: ${errMsg(e)}`,
            "warn"
          );
        }

        if (remote) {
          api.remote = remote;
        }

        // Attach classic FCA API methods
        let loaded = 0;
        let skipped = 0;
        let namespaces: Loose = {};

        try {
          const result = attachLegacyApiSurface(
            api,
            defaultFuncs,
            ctxMain,
            logger
          );

          loaded = Number(result?.loaded || 0);
          skipped = Number(result?.skipped || 0);
          namespaces = result?.namespaces || {};
        } catch (e) {
          logger(
            `Failed to attach legacy API surface: ${errMsg(e)}`,
            "error"
          );
          throw e;
        }

        // Realtime thread information synchronization
        try {
          attachThreadInfoRealtimeSync(
            ctxMain,
            models,
            logger,
            api
          );
        } catch (e) {
          logger(
            `Thread realtime sync initialization failed: ${errMsg(e)}`,
            "warn"
          );
        }

        if (typeof ui.runMethodLoadProgress === "function") {
          try {
            await ui.runMethodLoadProgress(loaded);
          } catch {
            // UI progress must never break login
          }
        }

        // Create modern client facade
        let client: Loose;

        try {
          client = attachClientFacade(
            api,
            namespaces
          );

          ctxMain.client = client;
        } catch (e) {
          logger(
            `Client facade initialization failed: ${errMsg(e)}`,
            "error"
          );
          throw e;
        }

        logger(
          `READY: Loaded ${loaded} API methods${
            skipped
              ? `, skipped ${skipped} duplicates`
              : ""
          }`,
          "success"
        );

        // MQTT compatibility layer
        try {
          ctxMain._fbDtsgRefreshInterval =
            attachMqttCompatibility(api, {
              logger,
              refreshIntervalMs: 86400000
            });
        } catch (e) {
          logger(
            `MQTT compatibility initialization failed: ${errMsg(e)}`,
            "warn"
          );
        }

        // Final login success
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
          // Ignore UI errors
        }

        loginFlow.spinner = null;

        logger(
          "AUTH: Login successful!",
          "success"
        );

        callback(null, api);


      })
      .catch(function (e) {
        try {
          if (
            typeof ui.persistLoginFail === "function"
          ) {
            ui.persistLoginFail(
              loginFlow.spinner
            );
          } else if (
            loginFlow.spinner &&
            typeof loginFlow.spinner.fail === "function"
          ) {
            loginFlow.spinner.fail(
              `fca: Login failed - ${errMsg(e)}`
            );
          }
        } catch {
          // Ignore UI errors
        }

        loginFlow.spinner = null;

        callback(
          e instanceof Error
            ? e
            : new Error(errMsg(e))
        );
      });
  } catch (e) {
    callback(
      e instanceof Error
        ? e
        : new Error(errMsg(e))
    );
  }
}

const exported = Object.assign(
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