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