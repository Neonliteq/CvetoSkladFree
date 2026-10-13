/**
 * Verifies messenger access control end to end.
 *
 * The bots themselves talk to Telegram and MAX, but everything that decides who
 * may use them lives in our code, so it is checked here directly: an unknown
 * sender gets a linking code and nothing else, the code links an account, and
 * from then on commands run through the same assistant as the web interface.
 *
 * Usage: node scripts/src/check-channels.mjs
 */
import { spawn } from "node:child_process";
import { seedDatabase } from "./seed-helper.mjs";
import { signIn } from "./auth-helper.mjs";

const api = process.env.API_BASE ?? "http://127.0.0.1:5000";

seedDatabase();

const results = [];
const record = (label, ok, detail) => results.push([label, Boolean(ok), detail]);

const session = await signIn(api);
const adminCookie = session.cookieHeader;

const call = async (method, path, body, cookie = adminCookie) => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      cookie,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
};

/**
 * Messages go through `POST /bots/simulate`, which runs the real bot pipeline —
 * access control, linking and the shared assistant — without needing Telegram or
 * MAX to be reachable from the machine running the check.
 */
const simulate = async (message) => {
  const response = await call("POST", "/api/bots/simulate", message);
  if (response.status !== 200) {
    throw new Error(`simulate failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
};

const stranger = `9${Date.now().toString().slice(-8)}`;

// ------------------------------------------------------- an unknown sender
const strangerReply = (
  await simulate({
    channel: "max",
    externalId: stranger,
    text: "Покажи остатки",
    displayName: "Чужой",
  })
).reply;
console.log("stranger reply:", strangerReply.replace(/\s+/g, " ").slice(0, 120));
record("an unknown messenger account is refused", strangerReply.includes("не привязан"));
record("the refusal carries a linking code", /Код привязки: [A-Z0-9]{6,10}/u.test(strangerReply));
record(
  "the refusal explains what to do",
  strangerReply.includes("Сотрудники") && strangerReply.includes("30 минут"),
);

const code = /Код привязки: ([A-Z0-9]+)/u.exec(strangerReply)?.[1] ?? "";
record("a code was issued", Boolean(code));

// The refusal must not have leaked any stock data.
record(
  "no stock data is disclosed to a stranger",
  !/остат(ок|ки):|Роза|Хризантема/iu.test(strangerReply),
);

// ------------------------------------------------------------- wrong code
const wrongClaim = await call("POST", "/api/channels/claim", { code: "ZZZZZZZZ" });
record("a wrong code is rejected", wrongClaim.status === 400, JSON.stringify(wrongClaim.body).slice(0, 90));

// ------------------------------------------------------------ valid claim
const claim = await call("POST", "/api/channels/claim", { code });
record("the code links the account", claim.status === 200 && claim.body?.channel === "max", JSON.stringify(claim.body).slice(0, 120));
record(
  "the claim reports the signed-in user",
  typeof claim.body?.userDisplayName === "string" && claim.body.userDisplayName.length > 0,
);

const reused = await call("POST", "/api/channels/claim", { code });
record("the code cannot be reused", reused.status === 400, JSON.stringify(reused.body).slice(0, 90));

// -------------------------------------------------- commands now work
const linkedReply = (await simulate({ channel: "max", externalId: stranger, text: "Покажи остатки" })).reply;
console.log("linked reply:", linkedReply.replace(/\s+/g, " ").slice(0, 140));
record("a linked account gets an answer", linkedReply.length > 0 && !linkedReply.includes("не привязан"));

// A write through the messenger goes through the same command layer.
const before = await call("GET", "/api/movements?limit=1");
const writeReply = (await simulate({ channel: "max", externalId: stranger, text: "Добавь приход 3 розы Эквадор красные по 100 рублей" })).reply;
console.log("write reply:", writeReply.replace(/\s+/g, " ").slice(0, 140));
const after = await call("GET", "/api/movements?limit=1");
record("a command from a messenger posts a movement", after.body?.[0]?.id !== before.body?.[0]?.id, writeReply);
record(
  "the movement records the linked user as the author",
  Boolean(after.body?.[0]?.createdBy),
  `createdBy=${after.body?.[0]?.createdBy}`,
);

// ------------------------------------------------------------- the list
const links = await call("GET", "/api/channels");
record("the admin sees the link list", links.status === 200 && Array.isArray(links.body));
const link = links.body?.find((entry) => entry.externalId === stranger);
record("the new link is in the list", Boolean(link), JSON.stringify(links.body).slice(0, 140));
record("the link names the channel", link?.channel === "max");
record("the linked account was seen", Boolean(link?.lastSeenAt));

// ---------------------------------------------------------- revocation
if (link) {
  const unlinked = await call("DELETE", `/api/channels/${link.id}`);
  record("the admin can revoke a link", unlinked.status === 204, `status ${unlinked.status}`);

  const afterRevoke = (await simulate({ channel: "max", externalId: stranger, text: "Покажи остатки" })).reply;
  record(
    "revoking takes effect at once",
    afterRevoke.includes("не привязан"),
    afterRevoke.replace(/\s+/g, " ").slice(0, 90),
  );
}

// ------------------------------------------------- permissions on the list
const staffName = `botworker${Date.now().toString().slice(-6)}`;
await call("POST", "/api/users", {
  username: staffName,
  displayName: "Работник с ботом",
  password: "Sklad2026pass",
  role: "staff",
});
const staffSession = await signIn(api, staffName, "Sklad2026pass");
const staffList = await call("GET", "/api/channels", undefined, staffSession.cookieHeader);
record("a worker cannot list the links", staffList.status === 403, `status ${staffList.status}`);

// A worker may claim their own messenger account, though.
const workerExternal = `7${Date.now().toString().slice(-8)}`;
const workerReply = (await simulate({ channel: "telegram", externalId: workerExternal, text: "привет" })).reply;
const workerCode = /Код привязки: ([A-Z0-9]+)/u.exec(workerReply)?.[1] ?? "";
const workerClaim = await call(
  "POST",
  "/api/channels/claim",
  { code: workerCode },
  staffSession.cookieHeader,
);
record("a worker can link their own messenger", workerClaim.status === 200 && workerClaim.body?.channel === "telegram", JSON.stringify(workerClaim.body).slice(0, 100));

console.log("\nresults:");
let failed = 0;
for (const [label, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
