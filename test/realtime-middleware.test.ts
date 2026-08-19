import assert from "node:assert";
import { createRealtimeMiddlewareSystem } from "../src/domains/realtime/middleware";

const middleware = createRealtimeMiddlewareSystem();

let calls = 0;
let received: any = null;

middleware.wrapCallback((err, event) => {
  calls++;
  received = event;
})(null, {
  type: "message",
  senderID: "123",
  body: "hello"
});

assert.strictEqual(calls, 1);
assert.strictEqual(received.body, "hello");

console.log("PASS middleware forwards event exactly once");

// Test next()
const middleware2 = createRealtimeMiddlewareSystem();

middleware2.use("test", (event, next) => {
  event.test = true;
  next();
});

let calls2 = 0;
let received2: any = null;

middleware2.wrapCallback((err, event) => {
  calls2++;
  received2 = event;
})(null, {
  type: "message",
  body: "hello"
});

assert.strictEqual(calls2, 1);
assert.strictEqual(received2.test, true);

console.log("PASS middleware next() forwards exactly once");

// Test blocking
const middleware3 = createRealtimeMiddlewareSystem();

middleware3.use("block", (event, next) => {
  return false;
});

let calls3 = 0;

middleware3.wrapCallback(() => {
  calls3++;
})(null, {
  type: "message",
  body: "blocked"
});

assert.strictEqual(calls3, 0);

console.log("PASS middleware can block event");

console.log("ALL REALTIME MIDDLEWARE TESTS PASSED");
