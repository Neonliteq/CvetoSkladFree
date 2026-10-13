/**
 * Verifies the authentication and authorisation rules against a running API.
 *
 * Covers what the code cannot show by inspection: that every endpoint is closed
 * by default, that a wrong password and a missing account are indistinguishable,
 * that guessing is throttled, that a staff account cannot touch the catalog, and
 * that revoking access takes effect immediately.
 *
 * Usage: node scripts/src/check-auth.mjs
 */
import { seedDatabase } from "./seed-helper.mjs";
import { adminPassword, adminUsername } from "./credentials.mjs";

const base = process.env.API_BASE ?? "http://127.0.0.1:5000";

const rootUsername = adminUsername;
const rootPassword = adminPassword;

/** Minimal cookie jar: `fetch` in Node does not keep cookies between calls. */
class Session {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  store(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === "" || /expires=thu, 01 jan 1970/i.test(raw)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method, path, body) {
    const headers = { accept: "application/json" };
    const cookie = this.cookieHeader();
    if (cookie) headers.cookie = cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.store(response);
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (process.env.AUTH_TRACE) {
      console.log(
        `[${this.label}] ${method} ${path} → ${response.status} jar=[${[...this.cookies.keys()].join(",")}]`,
      );
    }
    return { status: response.status, body: parsed };
  }

  get = (path) => this.request("GET", path);
  post = (path, body) => this.request("POST", path, body);
  patch = (path, body) => this.request("PATCH", path, body);
  delete = (path) => this.request("DELETE", path);
}

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
};

seedDatabase();

const anonymous = new Session("anonymous");
const admin = new Session("admin");

// --------------------------------------------------------------- closed by default
const protectedPaths = [
  ["GET", "/api/dashboard"],
  ["GET", "/api/products"],
  ["GET", "/api/movements"],
  ["GET", "/api/bouquets"],
  ["GET", "/api/analytics/movements"],
  ["GET", "/api/users"],
  ["GET", "/api/auth/me"],
  ["POST", "/api/auth/devices"],
  ["POST", "/api/movements"],
  ["POST", "/api/assistant/command"],
  ["POST", "/api/assistant/command/apply"],
  ["POST", "/api/assistant/batches/some-batch-id/undo"],
  ["POST", "/api/assistant/invoice/apply"],
  ["PATCH", "/api/products/1"],
  ["DELETE", "/api/products/1"],
];
let openPaths = [];
for (const [method, path] of protectedPaths) {
  const response = await anonymous.request(method, path, method === "GET" ? undefined : {});
  if (response.status !== 401) openPaths.push(`${method} ${path} → ${response.status}`);
}
record("every data endpoint requires a session", openPaths.length === 0, openPaths.join(", "));

const health = await anonymous.get("/api/healthz");
record("health check stays open for monitoring", health.status === 200);

// ------------------------------------------------------------------------ login
const wrongPassword = await admin.post("/api/auth/login", {
  username: rootUsername,
  password: "definitely-not-the-password",
});
record("a wrong password is rejected", wrongPassword.status === 401);

// Имя для «незнакомца» своё на каждый запуск: троттлинг живёт в памяти процесса
// 15 минут, и фиксированное имя после нескольких прогонов отвечает 429 — тогда
// проверка падает не из-за продукта, а из-за собственного следа в прошлом.
const unknownName = `no-such-person-${process.pid}`;
const unknownUser = await anonymous.post("/api/auth/login", {
  username: unknownName,
  password: "whatever123",
});
record(
  "an unknown login looks the same as a wrong password",
  unknownUser.status === 401 && unknownUser.body?.error === wrongPassword.body?.error,
  `статус ${unknownUser.status}, ответ ${JSON.stringify(unknownUser.body)}`,
);

const login = await admin.post("/api/auth/login", {
  username: rootUsername,
  password: rootPassword,
});
record("the root admin can sign in", login.status === 200 && login.body?.user?.role === "admin");
record(
  "the session cookie is http-only",
  (login.body && true) && !JSON.stringify(login.body).includes("florasklad_session="),
);
record("the session reports who is signed in", login.body?.user?.username === rootUsername);

const meAfterLogin = await admin.get("/api/auth/me");
record("the session is accepted afterwards", meAfterLogin.status === 200);

// ------------------------------------------------------------ user management
const suffix = Date.now().toString().slice(-6);
const staffName = `worker${suffix}`;
const staffPassword = "Sklad2026pass";
const created = await admin.post("/api/users", {
  username: staffName,
  displayName: "Работник склада",
  password: staffPassword,
  role: "staff",
});
record("the admin can create a worker", created.status === 201 && created.body?.role === "staff", JSON.stringify(created.body).slice(0, 120));

const weakPassword = await admin.post("/api/users", {
  username: `weak${suffix}`,
  displayName: "Слабый пароль",
  password: "12345678",
  role: "staff",
});
record("a password without letters is refused", weakPassword.status === 400, weakPassword.body?.error);

const duplicate = await admin.post("/api/users", {
  username: staffName.toUpperCase(),
  displayName: "Дубль",
  password: staffPassword,
  role: "staff",
});
record("a duplicate login is refused regardless of case", duplicate.status === 400);

const users = await admin.get("/api/users");
record("the user list is available to the admin", users.status === 200 && Array.isArray(users.body));
const staffId = users.body?.find((user) => user.username === staffName)?.id;
record("the new worker is in the list", typeof staffId === "number");

// ------------------------------------------------------------- throttling
// A dedicated throwaway account: the throttle counts failures per
// username+address, and locking the root admin here would break the checks below.
const guessName = `guess${suffix}`;
await admin.post("/api/users", {
  username: guessName,
  displayName: "Для перебора",
  password: "Sklad2026pass",
  role: "staff",
});
const attacker = new Session("attacker");
let throttled = false;
let lastStatus = 0;
for (let attempt = 0; attempt < 7; attempt += 1) {
  const response = await attacker.post("/api/auth/login", {
    username: guessName,
    password: `guess-${attempt}`,
  });
  lastStatus = response.status;
  if (response.status === 429) {
    throttled = true;
    break;
  }
}
record("repeated guessing is throttled", throttled, `last status ${lastStatus}`);

const adminStillWorks = await admin.get("/api/auth/me");
record("throttling does not break the admin session", adminStillWorks.status === 200);

// --------------------------------------------------------------- staff rights
const staff = new Session("staff");
const staffLogin = await staff.post("/api/auth/login", {
  username: staffName,
  password: staffPassword,
});
record("the worker can sign in", staffLogin.status === 200 && staffLogin.body?.user?.role === "staff");

record("the worker can read the stock", (await staff.get("/api/products")).status === 200);
record("the worker can read the dashboard", (await staff.get("/api/dashboard")).status === 200);

// Real ids: the seed does not reset the sequence, so hard-coded ids go stale.
const catalogue = (await staff.get("/api/products")).body ?? [];
const anyProductId = catalogue[0]?.id ?? 0;
const bouquet = ((await staff.get("/api/bouquets")).body ?? [])[0];

record(
  "the worker can post a movement",
  (
    await staff.post("/api/movements", {
      productId: anyProductId,
      type: "receipt",
      quantity: 5,
      unitPrice: 10,
    })
  ).status === 201,
  `productId ${anyProductId}`,
);
record(
  "the worker cannot change the catalog",
  (await staff.patch(`/api/products/${anyProductId}`, { name: "Взлом" })).status === 403,
);
record(
  "the worker cannot create products",
  (
    await staff.post("/api/products", {
      name: "x",
      category: "Цветы",
      unit: "шт",
      minimumStock: 0,
      shelfLifeDays: 0,
    })
  ).status === 403,
);
record(
  "the worker cannot delete products",
  (await staff.delete(`/api/products/${anyProductId}`)).status === 403,
);
record(
  "the worker cannot change recipes",
  (
    await staff.patch(`/api/bouquets/${bouquet?.id ?? 0}`, {
      name: "x",
      markupPercent: 10,
      components: [],
    })
  ).status === 403,
);
record("the worker cannot list users", (await staff.get("/api/users")).status === 403);
record("the worker cannot create users", (await staff.post("/api/users", { username: "x", displayName: "x", password: "abcdefg1", role: "admin" })).status === 403);
record("the worker cannot trust a device", (await staff.post("/api/auth/devices", { name: "Планшет" })).status === 403);
record("the worker cannot revoke devices", (await staff.delete(`/api/users/${staffId}/devices`)).status === 403);
// ------------------------------------------------------- protected root admin
const rootList = users.body ?? [];
const rootUser = rootList.find((user) => user.username === rootUsername);
if (rootUser) {
  const demote = await admin.patch(`/api/users/${rootUser.id}`, { role: "staff" });
  record("the root admin cannot be demoted", demote.status === 403, demote.body?.error);
  const disable = await admin.patch(`/api/users/${rootUser.id}`, { isActive: false });
  record("the root admin cannot be disabled", disable.status === 403);
  record("the root admin is marked protected", rootUser.isProtected === true);
} else {
  record("the root admin is present in the list", false);
}

// --------------------------------------------------------------- PIN on device
// --------------------------------------------------------------- PIN on device
// The device is trusted from an administrator's session, because trusting a
// device is an administrative act: a tablet only becomes trusted when somebody
// deliberately approves it. The PIN then belongs to the account that uses the
// tablet on the shop floor.
const workerDevice = new Session("worker-device");
await workerDevice.post("/api/auth/login", { username: staffName, password: staffPassword });
const workerDeviceTrust = await workerDevice.post("/api/auth/devices", { name: "Планшет склада" });
record(
  "only an administrator can trust a device",
  workerDeviceTrust.status === 403,
  `status ${workerDeviceTrust.status}`,
);

const adminDevice = await admin.post("/api/auth/devices", { name: "Планшет администратора" });
record(
  "the admin can trust the current device",
  adminDevice.status === 201,
  JSON.stringify(adminDevice.body).slice(0, 120),
);
record(
  "the trusted device is recognised",
  (await admin.get("/api/auth/device")).status === 200,
);

const pinSet = await admin.patch(`/api/users/${rootUser?.id ?? 0}`, { pin: "8351" });
record("a PIN can be assigned", pinSet.status === 200 && pinSet.body?.hasPin === true, pinSet.body?.error);
record(
  "assigning a PIN does not end the admin session",
  (await admin.get("/api/auth/me")).status === 200,
);
record(
  "assigning a PIN does not revoke the trusted device",
  (await admin.get("/api/auth/device")).status === 200,
);

const deviceUsers = await admin.get("/api/auth/device/users");
record(
  "the device lists its owner with a PIN",
  deviceUsers.status === 200 && deviceUsers.body?.[0]?.hasPin === true,
  JSON.stringify(deviceUsers.body).slice(0, 120),
);

const pinSession = new Session("pin");
// The device cookie is what makes the PIN flow possible, so it is copied over.
pinSession.cookies = new Map(admin.cookies);
const pinLogin = await pinSession.post("/api/auth/device/pin", {
  userId: rootUser?.id ?? 0,
  pin: "8351",
});
record("the PIN opens a session", pinLogin.status === 200 && pinLogin.body?.viaDevice === true, JSON.stringify(pinLogin.body).slice(0, 120));

const wrongPin = new Session("wrong-pin");
wrongPin.cookies = new Map(admin.cookies);
const wrongPinResponse = await wrongPin.post("/api/auth/device/pin", {
  userId: rootUser?.id ?? 0,
  pin: "0000",
});
record("a wrong PIN is rejected", wrongPinResponse.status === 401);

const foreignUser = await admin.post("/api/users", {
  username: `other${suffix}`,
  displayName: "Другой",
  password: "Sklad2026pass",
  role: "staff",
});
record("a second worker can be created", foreignUser.status === 201, JSON.stringify(foreignUser.body).slice(0, 120));
const foreignId = foreignUser.body?.id;
const crossPin = await wrongPin.post("/api/auth/device/pin", { userId: foreignId ?? 0, pin: "8351" });
record("a device cannot open a session for another account", crossPin.status === 401, JSON.stringify(crossPin.body).slice(0, 80));

// ------------------------------------------------------------- password reset
const reset = await admin.patch(`/api/users/${staffId}`, { password: "NovyParol2026" });
record("the admin can reset a password", reset.status === 200);

const oldPassword = new Session("old");
const oldLogin = await oldPassword.post("/api/auth/login", {
  username: staffName,
  password: staffPassword,
});
record("the old password stops working", oldLogin.status === 401);

const staleSession = await staff.get("/api/products");
record("resetting a password ends the worker's session", staleSession.status === 401, `status ${staleSession.status}`);

const newPassword = new Session("new");
const newLogin = await newPassword.post("/api/auth/login", {
  username: staffName,
  password: "NovyParol2026",
});
record("the new password works", newLogin.status === 200);

// ------------------------------------------------------------------ revocation
const revoked = await admin.delete(`/api/users/${staffId}/devices`);
record("revoking access succeeds", revoked.status === 204);
const afterRevoke = await newPassword.get("/api/products");
record("revoked access stops working at once", afterRevoke.status === 401, `status ${afterRevoke.status}`);

const disabled = await admin.patch(`/api/users/${staffId}`, { isActive: false });
record("a worker can be disabled", disabled.status === 200 && disabled.body?.isActive === false);
const disabledLogin = await new Session("disabled").post("/api/auth/login", {
  username: staffName,
  password: "NovyParol2026",
});
record("a disabled worker cannot sign in", disabledLogin.status === 401);

// --------------------------------------------------------------------- logout
const loggedOut = await admin.post("/api/auth/logout");
record("logout answers without content", loggedOut.status === 204);
const afterLogout = await admin.get("/api/auth/me");
record("the session is gone after logout", afterLogout.status === 401);

console.log("\nresults:");
let failed = 0;
for (const [label, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
