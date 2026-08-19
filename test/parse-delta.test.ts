import assert from "node:assert";
import createParseDelta from "../src/domains/realtime/parse-delta";

const parseDelta = createParseDelta({
  parseAndCheckLogin: (_ctx: any, _defaultFuncs: any) => {
    return async (res: any) => res;
  }
});

function createCtx(selfListen: boolean) {
  return {
    userID: "100000000001",
    loggedIn: true,
    globalOptions: {
      selfListen
    }
  };
}

function createMessageDelta(senderID: string, body: string) {
  return {
    class: "NewMessage",

    body,

    messageMetadata: {
      actorFbId: senderID,

      threadKey: {
        threadFbId: "200000000001",
        otherUserFbId: null
      },

      messageId: "mid.test.123",

      timestamp: Date.now(),

      isUnread: false
    },

    attachments: [],

    participants: [
      senderID,
      "100000000001"
    ]
  };
}

function runParse(
  ctx: any,
  delta: any,
  callback: (err: any, event: any) => void
) {
  parseDelta(
    {},
    {
      resolvePhotoUrl: () => {}
    },
    ctx,
    callback,
    { delta }
  );
}

function testOtherUserMessage() {
  const ctx = createCtx(false);

  let calls = 0;
  let received: any = null;

  runParse(
    ctx,
    createMessageDelta(
      "100000000002",
      "hello from another user"
    ),
    (_err, event) => {
      calls++;
      received = event;
    }
  );

  assert.strictEqual(calls, 1);
  assert.ok(received);
  assert.strictEqual(received.type, "message");
  assert.strictEqual(received.senderID, "100000000002");
  assert.strictEqual(received.body, "hello from another user");

  console.log("PASS other user's message is delivered");
}

function testSelfMessageBlocked() {
  const ctx = createCtx(false);

  let calls = 0;

  runParse(
    ctx,
    createMessageDelta(
      "100000000001",
      "message from bot"
    ),
    () => {
      calls++;
    }
  );

  assert.strictEqual(calls, 0);

  console.log(
    "PASS self message is blocked when selfListen=false"
  );
}

function testSelfMessageAllowed() {
  const ctx = createCtx(true);

  let calls = 0;
  let received: any = null;

  runParse(
    ctx,
    createMessageDelta(
      "100000000001",
      "message from bot"
    ),
    (_err, event) => {
      calls++;
      received = event;
    }
  );

  assert.strictEqual(calls, 1);
  assert.ok(received);
  assert.strictEqual(received.senderID, "100000000001");
  assert.strictEqual(received.body, "message from bot");

  console.log(
    "PASS self message is delivered when selfListen=true"
  );
}

function testGroupMessage() {
  const ctx = createCtx(false);

  let received: any = null;

  runParse(
    ctx,
    createMessageDelta(
      "100000000003",
      "hello group"
    ),
    (_err, event) => {
      received = event;
    }
  );

  assert.ok(received);
  assert.strictEqual(received.isGroup, true);
  assert.strictEqual(received.threadID, "200000000001");

  console.log("PASS group message is formatted correctly");
}

function run() {
  testOtherUserMessage();
  testSelfMessageBlocked();
  testSelfMessageAllowed();
  testGroupMessage();

  console.log("ALL PARSE DELTA TESTS PASSED");
}

try {
  run();
} catch (error) {
  console.error("FAIL", error);
  process.exit(1);
}
