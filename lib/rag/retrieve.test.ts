import assert from "node:assert/strict";
import test from "node:test";
import { isObviousGreetingOrChitchat, retrieveChunks } from "./retrieve";

test("recognizes exact greetings and social chatter", () => {
  assert.equal(isObviousGreetingOrChitchat("  Hello! "), true);
  assert.equal(isObviousGreetingOrChitchat("Thanks"), true);
  assert.equal(isObviousGreetingOrChitchat("hello, what is your return policy?"), false);
  assert.equal(isObviousGreetingOrChitchat("What about that?"), false);
});

test("skips embedding and database retrieval for an obvious greeting", async () => {
  // The greeting guard runs before either dependency is touched. This makes
  // the safe empty-retrieval behavior testable without network credentials.
  assert.deepEqual(await retrieveChunks("Hi!"), []);
});
