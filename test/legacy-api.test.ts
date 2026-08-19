import assert from "node:assert";

import { attachLegacyApiSurface } from "../src/app/attach-legacy-api";

const api: Record<string, any> = {
  getAppState: () => [],
  getCookies: () => ""
};

const ctx: Record<string, any> = {
  fbid: "100000000001",
  userID: "100000000001",
  globalOptions: {
    selfListen: false
  },
  loggedIn: true
};

const defaultFuncs: Record<string, any> = {};

const result = attachLegacyApiSurface(
  api,
  defaultFuncs,
  ctx,
  () => {}
);

const requiredMethods = [
  "sendMessage",
  "editMessage",
  "deleteMessage",
  "unsendMessage",
  "forwardAttachment",
  "shareContact",

  "getMessage",
  "markAsRead",
  "markAsReadAll",
  "markAsSeen",
  "markAsDelivered",

  "setMessageReaction",
  "sendTypingIndicator",
  "resolvePhotoUrl",
  "uploadAttachment",

  "getThreadInfo",
  "getThreadList",
  "getThreadHistory",
  "getThreadPictures",
  "searchForThread",

  "createNewGroup",
  "addUserToGroup",
  "removeUserFromGroup",
  "changeAdminStatus",
  "changeArchivedStatus",
  "changeGroupImage",
  "changeNickname",
  "changeThreadColor",
  "changeThreadEmoji",
  "setTitle",
  "deleteThread",

  "getUserID",
  "getUserInfo",
  "getUserInfoV2",
  "getFriendsList",

  "getCurrentUserID",
  "logout",
  "refreshFb_dtsg",

  "listenMqtt"
];

let failed = 0;

for (const name of requiredMethods) {
  if (typeof api[name] !== "function") {
    console.error(`FAIL missing legacy API: ${name}`);
    failed++;
  } else {
    console.log(`PASS legacy API: ${name}`);
  }
}

assert.strictEqual(failed, 0);

console.log("");
console.log(`Legacy API loaded: ${result.loaded}`);
console.log(`Legacy API skipped: ${result.skipped}`);
console.log(`Legacy API checks: ${requiredMethods.length}`);
console.log("ALL LEGACY API TESTS PASSED");
