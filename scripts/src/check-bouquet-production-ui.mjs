/**
 * Проверяет вкладку букетов и производство с правкой состава.
 *
 * Интерфейс проверяется отдельно от серверной логики: важно, что рецепт
 * редактируется без минимального остатка, что в диалоге сборки можно заменить
 * позицию и поставить свою цену, и что уходит на сервер именно фактический
 * состав.
 *
 * Usage: node scripts/src/check-bouquet-production-ui.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { signIn, signInBrowser } from "./auth-helper.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

// Каталог снимков не хранится в репозитории: на чистой копии его создаём сами.
ensureScreenshotsDir();

const here = path.dirname(fileURLToPath(import.meta.url));
const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const ui = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const port = Number(process.env.CDP_PORT ?? 9405);
seedDatabase();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const session = await signIn(api);
const apiCall = async (method, requestPath, body) => {
  const response = await fetch(`${api}${requestPath}`, {
    method,
    headers: {
      cookie: session.cookieHeader,
      origin: new URL(api).origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  try {
    return { status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, body: text.slice(0, 200) };
  }
};

const bouquets = (await apiCall("GET", "/api/bouquets")).body ?? [];
const bouquet = bouquets.find((item) => item.components.length > 0);
if (!bouquet) throw new Error("В демо-данных нет букета с составом");
console.log(`букет для проверки: ${bouquet.name} (id ${bouquet.id})`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Число в том виде, в каком его показывает интерфейс: «1 500 ₽». */
const formatAmount = (value) =>
  new Intl.NumberFormat("ru-RU", { minimumFractionDigits: 0, maximumFractionDigits: 0 })
    .format(Number(value ?? 0))
    // Разряды разделяются неразрывным пробелом, а интерфейс показывает обычный:
    // для сравнения с текстом страницы приводим к обычному.
    .replace(/\u00a0/g, " ");

const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-bouquet-ui-"));
const browser = spawn(
  edge,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,1000",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  let wsUrl = null;
  for (let attempt = 0; attempt < 60 && !wsUrl; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((item) => item.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch {
      // ещё не готов
    }
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error("Не удалось подключиться к Edge");

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const requests = [];
  const seenPosts = [];
  socket.addEventListener("message", (event) => {
    const parsed = JSON.parse(event.data);
    if (parsed.method === "Network.requestWillBeSent") {
      const request = parsed.params?.request;
      if (request?.method === "POST") {
        seenPosts.push(String(request.url));
      }
      if (
        request?.method === "POST" &&
        (String(request.url).includes("/movements") || String(request.url).includes("/produce"))
      ) {
        requests.push(request.postData ?? "");
      }
    }
    const resolve = pending.get(parsed.id);
    if (resolve) {
      pending.delete(parsed.id);
      resolve(parsed.result ?? parsed);
    }
  });
  const cdp = {
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      }),
  };

  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 200));
    }
    return result.result?.value;
  };

  /** Диалог по началу заголовка: на странице их может быть открыто несколько. */
  const dialogExpr = (titleStart) =>
    `[...document.querySelectorAll('[role="dialog"]')].find((node) => (node.querySelector('h2')?.textContent || '').startsWith(${JSON.stringify(titleStart)}))`;

  /** Заполняет поле так, чтобы React заметил изменение: value + событие input. */
  const setFieldByLabel = (label, value) => `(() => {
    const dialog = ${dialogExpr("Производство:")};
    const label_ = [...(dialog?.querySelectorAll('label') ?? [])]
      .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
    const input = label_?.closest('[data-slot="form-item"], .space-y-2')?.querySelector('input');
    if (!input) return 'нет поля ' + ${JSON.stringify(label)};
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`;

  /**
   * Количество конкретной позиции состава.
   *
   * Поле ищется по подписи для программ чтения с экрана: у всех строк состава
   * подпись одинаковая, и «первое поле» — это не то же самое, что вторая строка.
   */
  const setIngredientQuantity = (position, value) => `(() => {
    const dialog = ${dialogExpr("Производство:")};
    const wanted = 'Количество в букете, позиция ' + ${JSON.stringify(String(position))};
    const input = [...(dialog?.querySelectorAll('input') ?? [])]
      .find((node) => node.getAttribute('aria-label') === wanted);
    if (!input) {
      return 'нет поля позиции ' + ${JSON.stringify(String(position))} + ': ' +
        JSON.stringify([...(dialog?.querySelectorAll('input') ?? [])].map((node) => node.getAttribute('aria-label')));
    }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`;

  /** Ставит значение в поле и сообщает React об изменении: value + событие input. */
  const setInputValue = (inputExpr, value) => `(() => {
    const input = ${inputExpr};
    if (!input) return 'нет поля';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(String(value))});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()`;

  /** Вид операции в окне проведения выбирается кнопкой. */
  const pickType = async (label) => {
    const result = await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
      const group = dialog.querySelector('[role="group"][aria-label="Тип операции"]');
      const button = [...group.querySelectorAll('button')]
        .find((node) => (node.textContent || '').trim() === ${JSON.stringify(label)});
      if (!button) return 'нет кнопки ' + ${JSON.stringify(label)};
      button.click();
      return 'выбрано';
    })()`);
    await sleep(700);
    return result;
  };

  /** Товар операции: это по-прежнему выпадающий список. */
  const pickProduct = async (name) => {
    await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
      dialog.querySelectorAll('button[role="combobox"]')[0].click();
      return 'открыт';
    })()`);
    await sleep(800);
    const result = await evaluate(`(() => {
      const option = [...document.querySelectorAll('[role="option"]')]
        .find((node) => (node.textContent || '').includes(${JSON.stringify(name)}));
      if (!option) return 'нет в списке';
      option.click();
      return 'выбрано';
    })()`);
    await sleep(400);
    // Программное нажатие по варианту не закрывает список сам: без Escape он
    // остаётся поверх формы и перекрывает поля. Escape отправляем только когда
    // список действительно открыт — иначе он закроет само окно.
    await evaluate(`(() => {
      if (!document.querySelector('[role="option"]')) return 'список уже закрыт';
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'закрыт';
    })()`);
    await sleep(500);
    return result;
  };

  /**
   * Открывает окно «Новая операция» и ждёт, пока оно появится.
   *
   * Одного нажатия мало: после перехода страница дорисовывается, и окно может
   * появиться на кадр позже — тогда все последующие обращения к нему падают.
   */
  const openMovementDialog = async () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((node) => (node.textContent || '').trim() === 'Новая операция');
        if (button) button.click();
        return 'нажата';
      })()`);
      await sleep(600);
      const opened = await evaluate(`Boolean([...document.querySelectorAll('[role="dialog"]')]
        .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции')))`);
      if (opened) return true;
    }
    return false;
  };

  /**
   * Нажимает кнопку в строке букета.
   *
   * Строку ищем по названию и ждём её появления: после перехода страница
   * дорисовывается, и `row.querySelector(...)` на отсутствующей строке падал с
   * невнятной ошибкой.
   */
  const clickBouquetAction = async (name, labelPrefix) => {
    let lastFailure = "нет попыток";
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const result = await evaluate(`(() => {
        const rows = [...document.querySelectorAll('table tbody tr')];
        const row = rows.find((node) => (node.innerText || '').includes(${JSON.stringify(name)}));
        if (!row) {
          return { ok: false, why: 'нет строки', rows: rows.length,
            names: rows.slice(0, 6).map((node) => (node.innerText || '').replace(/\\s+/g, ' ').slice(0, 30)) };
        }
        const button = [...row.querySelectorAll('button[aria-label]')]
          .find((node) => (node.getAttribute('aria-label') || '').startsWith(${JSON.stringify(labelPrefix)}));
        if (!button) {
          return { ok: false, why: 'нет кнопки',
            labels: [...row.querySelectorAll('button[aria-label]')].map((node) => node.getAttribute('aria-label')) };
        }
        button.click();
        return { ok: true };
      })()`);
      if (result?.ok) return true;
      lastFailure = JSON.stringify(result);
      await sleep(400);
    }
    console.log(`  не удалось нажать «${labelPrefix}»: ${lastFailure}`);
    return false;
  };

  /** Закрывает диалог: подпись кнопки закрытия зависит от языка браузера. */
  const closeDialog = (titleStart) => `(() => {
    const dialog = ${dialogExpr(titleStart)};
    if (!dialog) return 'нет диалога';
    const button = [...dialog.querySelectorAll('button')]
      .find((node) => (node.textContent || '').includes('Закрыть'));
    if (!button) return 'кнопка закрытия не найдена';
    button.click();
    return 'закрыт';
  })()`;

  await signInBrowser(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  // Убираем остатки прошлого запуска: у проверки своя категория, и без уборки
  // список букетов растёт, а фильтры находят не те строки.
  const stale = (await apiCall("GET", "/api/bouquets")).body ?? [];
  for (const item of stale.filter((bouquet) => bouquet.name.startsWith("Букет для проверки"))) {
    await apiCall("DELETE", `/api/products/${item.id}`);
    console.log(`  убрал остаток прошлого запуска: ${item.name}`);
  }
  await cdp.send("Page.navigate", { url: `${ui}/bouquets` });
  await sleep(5000);

  console.log("\n=== 1. Рецепт на вкладке букетов ===");
  const table = await evaluate(`(() => {
    const name = ${JSON.stringify(bouquet.name)};
    const rows = [...document.querySelectorAll('table tbody tr')];
    const row = rows.find((node) => (node.innerText || '').includes(name));
    if (!row) return null;
    const cells = [...row.querySelectorAll('td')];
    return {
      heads: [...document.querySelectorAll('table thead th')].map((node) => node.innerText.trim()),
      columns: cells.length,
      category: (cells[1]?.innerText ?? '').trim(),
      hasRecipe: (cells[2]?.innerText ?? '').includes(${JSON.stringify(bouquet.components[0].productName)}),
      lastProduction: cells[7]?.innerText?.replace(/\\s+/g, ' ').trim() ?? '',
      text: row.innerText.replace(/\\s+/g, ' ').trim().slice(0, 160),
    };
  })()`);
  console.log("  строка букета:", JSON.stringify(table));
  record("букет есть на вкладке", Boolean(table), JSON.stringify(table));
  record(
    "в таблице есть состав и последняя сборка",
    table?.hasRecipe === true && table?.heads?.includes("Последняя сборка"),
    JSON.stringify(table?.heads),
  );
  record(
    "в таблице есть колонка категории",
    table?.heads?.includes("Категория") && (table?.category ?? "").length > 0,
    JSON.stringify({ heads: table?.heads, category: table?.category }),
  );
  record(
    "минимального остатка в рецепте нет",
    !/минимальн|мин\./i.test(table?.text ?? "") && !table?.heads?.includes("Мин. остаток"),
    table?.text,
  );
  record(
    "столбец остатка назван «Собрано»",
    table?.heads?.includes("Собрано") && !(table?.heads ?? []).some((head) => /^Остаток/.test(head)),
    JSON.stringify(table?.heads),
  );

  console.log("\n=== 2. Диалог правки рецепта без минимального остатка ===");
  const openedEdit = await clickBouquetAction(bouquet.name, "Редактировать");
  record("кнопка правки рецепта нажата", openedEdit === true, String(openedEdit));
  await sleep(1200);
  const editDialog = await evaluate(`(() => {
    const dialog = ${dialogExpr("Редактирование:")};
    if (!dialog) return null;
    const category = [...dialog.querySelectorAll('input')]
      .find((node) => node.getAttribute('list')?.startsWith('bouquet-categories'));
    return {
      title: dialog.querySelector('h2')?.textContent?.trim() ?? '',
      labels: [...dialog.querySelectorAll('label')].map((node) => node.textContent.trim()),
      categoryValue: category?.value ?? null,
      categorySuggestions: category
        ? [...(document.getElementById(category.getAttribute('list'))?.querySelectorAll('option') ?? [])]
            .map((option) => option.value)
        : [],
      text: dialog.innerText.replace(/\\s+/g, ' ').slice(0, 2500),
    };
  })()`);
  console.log("  диалог:", JSON.stringify(editDialog).slice(0, 400));
  record("диалог правки открылся", Boolean(editDialog?.title), JSON.stringify(editDialog)?.slice(0, 200));
  record(
    "в рецепте нет поля минимального остатка",
    !(editDialog?.labels ?? []).some((label) => /мин/i.test(label)),
    JSON.stringify(editDialog?.labels),
  );
  record(
    "в рецепте есть поле категории с существующими значениями",
    (editDialog?.labels ?? []).includes("Категория") &&
      (editDialog?.categoryValue ?? "").length > 0 &&
      (editDialog?.categorySuggestions ?? []).includes(editDialog?.categoryValue),
    JSON.stringify({
      labels: editDialog?.labels,
      value: editDialog?.categoryValue,
      suggestions: editDialog?.categorySuggestions,
    }),
  );
  record(
    "в рецепте показаны себестоимость и цена",
    /Себестоимость/.test(editDialog?.text ?? "") && /Цена продажи/.test(editDialog?.text ?? ""),
    editDialog?.text?.slice(-200),
  );
  const closedEdit = await evaluate(closeDialog("Редактирование:"));
  await sleep(800);
  record("диалог правки закрывается", closedEdit === "закрыт", String(closedEdit));

  console.log("\n=== 2б. Фильтр букетов по категории ===");
  // Вторая категория создаётся через API: в демо-данных категория одна, и
  // фильтру нечего было бы показывать.
  const extraCategory = "Проверка сортировки";
  const extra = await apiCall("POST", "/api/bouquets", {
    name: "Букет для проверки категории",
    category: extraCategory,
    markupPercent: 100,
    components: [{ productId: bouquet.components[0].productId, quantity: 1 }],
  });
  record(
    "букет с новой категорией создан",
    extra.status === 201 && extra.body?.category === extraCategory,
    `статус ${extra.status}, категория ${extra.body?.category}`,
  );
  const categoryList = await apiCall("GET", "/api/bouquet-categories");
  record(
    "новая категория попала в список категорий",
    (categoryList.body ?? []).includes(extraCategory),
    JSON.stringify(categoryList.body),
  );

  await cdp.send("Page.navigate", { url: `${ui}/bouquets` });
  await sleep(4000);
  const filterRow = await evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label="Категория букетов"]');
    if (!group) return null;
    return {
      buttons: [...group.querySelectorAll('button')].map((node) => node.textContent.trim()),
      groupHeight: Math.round(group.querySelector('button').getBoundingClientRect().height),
    };
  })()`);
  console.log("  фильтр:", JSON.stringify(filterRow));
  record(
    "появился фильтр категорий со всеми категориями",
    (filterRow?.buttons ?? []).includes("Все категории") &&
      (filterRow?.buttons ?? []).includes(extraCategory),
    JSON.stringify(filterRow?.buttons),
  );
  record(
    "кнопки фильтра одного размера со всеми кнопками страницы",
    (filterRow?.groupHeight ?? 0) >= 40,
    `высота ${filterRow?.groupHeight} px (44 px на телефоне — проверяется ниже)`,
  );

  await evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label="Категория букетов"]');
    const button = [...group.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === ${JSON.stringify(extraCategory)});
    button.click();
    return 'нажата';
  })()`);
  await sleep(1500);
  const filtered = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('table tbody tr')]
      .map((row) => row.innerText.replace(/\\s+/g, ' ').trim());
    const name = ${JSON.stringify(bouquet.name)};
    return {
      rows: rows.length,
      hasOther: rows.some((text) => text.includes(name)),
      hasExtra: rows.some((text) => text.includes('Букет для проверки категории')),
      empty: document.body.innerText.includes('букетов нет'),
    };
  })()`);
  console.log("  после фильтра:", JSON.stringify(filtered));
  record(
    "фильтр оставляет только выбранную категорию",
    filtered?.hasExtra === true && filtered?.hasOther === false,
    JSON.stringify(filtered),
  );
  record("в отфильтрованном списке есть строки", (filtered?.rows ?? 0) > 0, JSON.stringify(filtered));

  // Возвращаем полный список: дальше проверки ищут конкретный букет, а фильтр
  // оставляет только одну категорию.
  await evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label="Категория букетов"]');
    const button = [...group.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === 'Все категории');
    button.click();
    return 'сброшен';
  })()`);
  await sleep(1200);

  // Убираем за собой: букет без истории удаляется окончательно.
  await apiCall("DELETE", `/api/products/${extra.body?.id}`);
  const leftover = (await apiCall("GET", "/api/bouquets")).body ?? [];
  record(
    "проверочный букет убран",
    !leftover.some((item) => item.id === extra.body?.id),
    JSON.stringify(leftover.map((item) => item.name)),
  );

  console.log("\n=== 3. История сборок ===");
  const openedHistory = await clickBouquetAction(bouquet.name, "История сборок");
  record("кнопка истории сборок нажата", openedHistory === true, String(openedHistory));
  await sleep(1800);
  const historyDialog = await evaluate(`(() => {
    const dialog = ${dialogExpr("Сборки:")};
    if (!dialog) return null;
    const text = dialog.innerText.replace(/\\s+/g, ' ');
    return {
      title: dialog.querySelector('h2')?.textContent?.trim() ?? '',
      hasIngredient: text.includes(${JSON.stringify(bouquet.components[0].productName)}),
      text: text.slice(0, 400),
    };
  })()`);
  console.log("  история:", JSON.stringify(historyDialog).slice(0, 300));
  record("история сборок открылась", Boolean(historyDialog?.title), JSON.stringify(historyDialog)?.slice(0, 200));
  record(
    "в истории виден фактический состав",
    historyDialog?.hasIngredient === true && /шт/.test(historyDialog?.text ?? ""),
    historyDialog?.text?.slice(0, 200),
  );
  const closedHistory = await evaluate(closeDialog("Сборки:"));
  await sleep(800);
  record("история закрывается", closedHistory === "закрыт", String(closedHistory));

  console.log("\n=== 4. Сборка с заменой позиции и своей ценой ===");
  const openedProduce = await clickBouquetAction(bouquet.name, "Собрать");
  record("кнопка сборки нажата", openedProduce === true, String(openedProduce));
  await sleep(1500);

  const produceDialog = await evaluate(`(() => {
    const dialog = ${dialogExpr("Производство:")};
    if (!dialog) return null;
    const labels = [...dialog.querySelectorAll('label')].map((node) => node.textContent.trim());
    const comboboxes = dialog.querySelectorAll('button[role="combobox"]').length;
    return {
      title: dialog.querySelector('h2')?.textContent?.trim() ?? '',
      labels,
      comboboxes,
      text: dialog.innerText.replace(/\\s+/g, ' ').slice(0, 400),
    };
  })()`);
  console.log("  диалог сборки:", JSON.stringify(produceDialog).slice(0, 300));
  record("диалог сборки открылся", Boolean(produceDialog?.title), JSON.stringify(produceDialog)?.slice(0, 200));
  record(
    "в сборке есть состав и цена",
    produceDialog?.comboboxes >= bouquet.components.length &&
      (produceDialog?.labels ?? []).some((label) => /Цена продажи/.test(label)),
    JSON.stringify({ comboboxes: produceDialog?.comboboxes, labels: produceDialog?.labels }),
  );

  // Меняем вторую позицию состава на другой товар: это и есть замена цветка.
  const replacement = (await apiCall("GET", "/api/products")).body.find(
    (item) =>
      item.productType === "stock" &&
      item.currentStock >= 5 &&
      !bouquet.components.some((component) => component.productId === item.id),
  );
  if (!replacement) throw new Error("Не нашлось товара для замены");
  console.log(`  замена: ${bouquet.components[1].productName} → ${replacement.name}`);

  await evaluate(`(() => {
    const dialog = ${dialogExpr("Производство:")};
    const comboboxes = [...dialog.querySelectorAll('button[role="combobox"]')];
    comboboxes[1].click();
    return 'открыт список';
  })()`);
  await sleep(900);
  const picked = await evaluate(`(() => {
    const name = ${JSON.stringify(replacement.name)};
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((node) => (node.textContent || '').includes(name));
    if (!option) return { picked: false, options: [...document.querySelectorAll('[role="option"]')].length };
    option.click();
    return { picked: true };
  })()`);
  record("в списке состава есть товары для замены", picked?.picked === true, JSON.stringify(picked));
  await sleep(600);

  const quantitySet = await evaluate(setIngredientQuantity(2, 2));
  const priceSet = await evaluate(setFieldByLabel("Цена продажи за штуку", 1500));
  console.log("  поля:", quantitySet, priceSet);
  record("количество позиции изменено", quantitySet === "ok", String(quantitySet));
  record("цена продажи изменена", priceSet === "ok", String(priceSet));

  const summary = await evaluate(`(() => {
    const dialog = ${dialogExpr("Производство:")};
    return (dialog?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 4000);
  })()`);
  record(
    "диалог показывает прибыль по фактической цене",
    /Прибыль/.test(summary ?? "") && /1 500/.test(summary ?? ""),
    summary?.slice(-240),
  );

  requests.length = 0;
  await evaluate(`(() => {
    const dialog = ${dialogExpr("Производство:")};
    const button = [...dialog.querySelectorAll('button')]
      .find((node) => (node.textContent || '').trim() === 'Собрать');
    button.click();
    return 'отправлено';
  })()`);
  await sleep(3000);

  const sent = requests.length ? JSON.parse(requests[requests.length - 1]) : null;
  console.log("  рецепт из API:", JSON.stringify(bouquet.components.map((c) => [c.productId, c.productName, c.quantity])));
  console.log("  замена:", replacement.id, replacement.name);
  console.log("  отправлено на сервер:", JSON.stringify(sent));
  record("запрос на производство ушёл", requests.length > 0, `запросов ${requests.length}`);
  record("в запросе своя цена продажи", sent?.salePrice === 1500, JSON.stringify(sent?.salePrice));
  const expectedIngredients = bouquet.components.map((component, index) => ({
    productId: index === 1 ? replacement.id : component.productId,
    quantity: index === 1 ? 2 : component.quantity,
  }));
  record(
    "в запросе фактический состав, а не рецепт",
    JSON.stringify(sent?.ingredients) === JSON.stringify(expectedIngredients),
    `отправлено ${JSON.stringify(sent?.ingredients)}, ожидалось ${JSON.stringify(expectedIngredients)}`,
  );
  record("в запросе одна сборка", sent?.quantity === 1, JSON.stringify(sent?.quantity));

  const after = await evaluate(`(() => {
    const name = ${JSON.stringify(bouquet.name)};
    const row = [...document.querySelectorAll('table tbody tr')]
      .find((node) => (node.innerText || '').includes(name));
    if (!row) return null;
    const cells = [...row.querySelectorAll('td')];
    const heads = [...document.querySelectorAll('table thead th')]
      .map((node) => (node.innerText || '').replace(/\\s+/g, ' ').trim());
    const byHead = (label) => {
      const index = heads.indexOf(label);
      return index === -1 ? '' : (cells[index]?.innerText ?? '').replace(/\\s+/g, ' ').trim();
    };
    return {
      heads,
      lastProduction: byHead('Последняя сборка'),
      stock: byHead('Собрано'),
    };
  })()`);
  console.log("  строка после сборки:", JSON.stringify(after));
  // Цена ушла в запросе — это и проверяем. В колонке «Последняя сборка» может
  // стоять другая сборка: проверка идёт не первым запуском, и до неё букет
  // собирали другие проверки, поэтому число там своё.
  const sentPrice = formatAmount(sent?.salePrice);
  const latestBatch = (await apiCall("GET", `/api/production-batches?bouquetId=${bouquet.id}&limit=1`)).body?.[0];
  record(
    "фактическая цена записана в партию сборки",
    latestBatch?.salePrice === 1500 && sentPrice === "1 500",
    JSON.stringify({ sent: sent?.salePrice, batch: latestBatch?.salePrice, shown: after?.lastProduction }),
  );
  // Диалог сборки после успеха остаётся открытым: закрываем его, иначе поиск
  // диалога по заголовку найдёт именно его, а не историю.
  await evaluate(closeDialog("Производство:"));
  await sleep(700);
  const openedHistoryAfterProduce = await clickBouquetAction(bouquet.name, "История сборок");
  await sleep(1800);
  const batchHistory = await evaluate(`(() => {
    const dialog = ${dialogExpr("Сборки:")};
    if (!dialog) return null;
    return {
      title: dialog.querySelector('h2')?.textContent?.trim() ?? '',
      text: (dialog.innerText ?? '').replace(/\\s+/g, ' '),
    };
  })()`);
  console.log("  история после сборки:", JSON.stringify(batchHistory)?.slice(0, 260));
  record(
    "в истории сборок есть новая сборка по своей цене",
    (batchHistory?.text ?? "").includes("1 500") &&
      (batchHistory?.text ?? "").includes("Бумага крафт для букета"),
    JSON.stringify({ opened: openedHistoryAfterProduce, title: batchHistory?.title }),
  );
  await evaluate(closeDialog("Сборки:"));
  await sleep(700);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.resolve(here, "..", "..", "screenshots", "check-bouquet-production.png");
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log(`  снимок: ${shotPath}`);

  console.log("\n=== 4г. Вид операции переключается кнопкой ===");
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(4000);
  // После перехода по странице домен Network включается заново: без этого
  // запросы нового документа не перехватываются.
  await cdp.send("Network.enable");
  await sleep(600);
  const openedForType = await openMovementDialog();
  record("окно операции открылось", openedForType === true, String(openedForType));
  await pickType("Приход");
  await sleep(600);
  const receiptFields = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    return [...dialog.querySelectorAll('label')].map((node) => node.textContent.trim());
  })()`);
  record(
    "для прихода показаны свои поля",
    (receiptFields ?? []).includes("Цена за единицу (Закупка)") &&
      (receiptFields ?? []).includes("Дата прихода"),
    JSON.stringify(receiptFields),
  );
  await pickType("Списание");
  await sleep(600);
  const writeoffFields = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    return [...dialog.querySelectorAll('label')].map((node) => node.textContent.trim());
  })()`);
  record(
    "для списания поля сменились",
    !(writeoffFields ?? []).includes("Дата прихода") &&
      (writeoffFields ?? []).some((label) => label.includes("Списать из")),
    JSON.stringify(writeoffFields),
  );
  record(
    "переключение оставляет нажатой одну кнопку",
    (await evaluate(`(() => {
      const group = document.querySelector('[role="group"][aria-label="Тип операции"]');
      return [...group.querySelectorAll('button')]
        .filter((node) => node.getAttribute('aria-pressed') === 'true')
        .map((node) => node.textContent.trim());
    })()`))?.join("|") === "Списание",
    "нажатых кнопок не одна",
  );
  await pickType("Продажа");
  // Товар берём обычный: у букета нужен ещё выбор сборки, а здесь проверяется
  // отправка операции с типом, выбранным кнопкой.
  await pickProduct("Хризантема белая");
  await sleep(1200);
  await evaluate(setInputValue(
    `[...document.querySelectorAll('[role="dialog"] input[type="number"]')]
      .find((node) => node.offsetParent !== null)`,
    2,
  ));
  await sleep(400);
  requests.length = 0;
  seenPosts.length = 0;
  await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    const button = [...dialog.querySelectorAll('button')]
      .find((node) => (node.textContent || '').trim() === 'Провести');
    button.click();
    return 'отправлено';
  })()`);
  await sleep(2500);
  const sentType = requests.length ? JSON.parse(requests[requests.length - 1]) : null;
  console.log("  POST-запросы:", JSON.stringify(seenPosts.slice(-4)));
  record(
    "запрос уходит с выбранным кнопкой типом",
    sentType?.type === "expense" && sentType?.quantity === 2,
    JSON.stringify({ type: sentType?.type, quantity: sentType?.quantity, posts: seenPosts.slice(-3) }),
  );
  await sleep(1200);

  console.log("\n=== 4д. Отправка операции, выбранной кнопками ===");
  const openedForBouquet = await openMovementDialog();
  record("окно операции открылось повторно", openedForBouquet === true, String(openedForBouquet));
  console.log("\n=== 4д. Продажа букета через кнопки ===");
  const openedForBouquetSale = await openMovementDialog();
  record("окно операции открылось повторно", openedForBouquetSale === true, String(openedForBouquetSale));
  // Букет продаётся, а не «собирается»: расхода в сборку в операциях больше нет,
  // букет собирают на вкладке «Букеты».
  await pickType("Продажа");
  await sleep(500);
  const produceProduct = await pickProduct(bouquet.name);
  console.log("  выбор букета:", produceProduct);
  await sleep(1500);
  const prepareSet = await evaluate(setInputValue(
    `[...document.querySelectorAll('[role="dialog"] input[type="number"]')]
      .find((node) => node.offsetParent !== null)`,
    1,
  ));
  record("количество введено", prepareSet === "ok", String(prepareSet));
  const pressedAfterPick = await evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label="Тип операции"]');
    return [...group.querySelectorAll('button')]
      .filter((node) => node.getAttribute('aria-pressed') === 'true')
      .map((node) => node.textContent.trim());
  })()`);
  record(
    "после выбора товара тип остался «Продажа»",
    JSON.stringify(pressedAfterPick) === JSON.stringify(["Продажа"]),
    JSON.stringify(pressedAfterPick),
  );
  await evaluate(closeDialog("Проведение операции"));
  await sleep(700);

  console.log("\n=== 5. Сборка на телефоне ===");
  // На телефоне диалог узкий: строки состава не должны разъезжаться и
  // вылезать за экран, а кнопки остаются не меньше 44 px.
  await evaluate(closeDialog("Производство:"));
  await sleep(800);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url: `${ui}/bouquets` });
  await sleep(4000);

  const mobileList = await evaluate(`(() => {
    const name = ${JSON.stringify(bouquet.name)};
    const text = document.body.innerText;
    return {
      hasBouquet: text.includes(name),
      hasLastProduction: /Собирали|Ещё не собирали/.test(text),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      produceButton: [...document.querySelectorAll('button')]
        .some((node) => (node.textContent || '').includes('Собрать рецепт')),
    };
  })()`);
  console.log("  карточка букета:", JSON.stringify(mobileList));
  record("на телефоне букет показан карточкой", mobileList?.hasBouquet === true, JSON.stringify(mobileList));
  record("на телефоне видна последняя сборка", mobileList?.hasLastProduction === true, JSON.stringify(mobileList));
  record("экран букетов не едет вбок", (mobileList?.overflowX ?? 1) <= 0, `overflowX ${mobileList?.overflowX}`);

  await evaluate(`(() => {
    const name = ${JSON.stringify(bouquet.name)};
    const button = [...document.querySelectorAll('button[aria-label]')]
      .find((node) => node.getAttribute('aria-label') === 'Собрать ' + name);
    if (!button) return 'нет кнопки';
    button.click();
    return 'открыт';
  })()`);
  await sleep(1500);
  const mobileDialog = await evaluate(`(() => {
    const dialog = ${dialogExpr("Производство:")};
    if (!dialog) return null;
    const rows = dialog.querySelectorAll('button[role="combobox"]').length;
    const removeButtons = [...dialog.querySelectorAll('button[aria-label="Убрать позицию"]')];
    const inputs = [...dialog.querySelectorAll('input')].map((node) => ({
      label: node.getAttribute('aria-label') ?? null,
      width: Math.round(node.getBoundingClientRect().width),
    }));
    return {
      title: dialog.querySelector('h2')?.textContent?.trim() ?? '',
      rows,
      inputs,
      removeHeight: removeButtons[0] ? Math.round(removeButtons[0].getBoundingClientRect().height) : 0,
      overflowX: dialog.scrollWidth - dialog.clientWidth,
      text: dialog.innerText.replace(/\\s+/g, ' ').slice(-200),
    };
  })()`);
  console.log("  диалог на телефоне:", JSON.stringify(mobileDialog));
  record("на телефоне состав редактируется", mobileDialog?.rows >= bouquet.components.length, JSON.stringify({ rows: mobileDialog?.rows }));
  record(
    "диалог сборки не едет вбок",
    (mobileDialog?.overflowX ?? 1) <= 1,
    `overflowX ${mobileDialog?.overflowX}`,
  );
  record(
    "кнопка удаления позиции удобна для пальца",
    (mobileDialog?.removeHeight ?? 0) >= 44,
    `высота ${mobileDialog?.removeHeight} px`,
  );
  record("на телефоне видны итоги сборки", /Прибыль/.test(mobileDialog?.text ?? ""), mobileDialog?.text);

  const mobileShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const mobileShotPath = path.resolve(here, "..", "..", "screenshots", "check-bouquet-production-mobile.png");
  writeFileSync(mobileShotPath, Buffer.from(mobileShot.data, "base64"));
  console.log(`  снимок: ${mobileShotPath}`);

  console.log("\n=== 6. Продажа из конкретной сборки ===");
  await evaluate(closeDialog("Производство:"));
  await sleep(800);
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(4000);

  await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')];
    const button = buttons.find((node) => (node.textContent || '').trim() === 'Новая операция');
    if (!button) return 'нет кнопки';
    button.click();
    return 'открыт';
  })()`);
  await sleep(1200);

  const movementDialog = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    if (!dialog) return null;
    const group = dialog.querySelector('[role="group"][aria-label="Тип операции"]');
    return {
      labels: [...dialog.querySelectorAll('label')].map((node) => node.textContent.trim()),
      comboboxes: dialog.querySelectorAll('button[role="combobox"]').length,
      typeButtons: [...(group?.querySelectorAll('button') ?? [])].map((node) => ({
        text: node.textContent.trim(),
        pressed: node.getAttribute('aria-pressed') === 'true',
      })),
    };
  })()`);
  record("диалог операции открылся", Boolean(movementDialog), JSON.stringify(movementDialog));
  record(
    "тип операции выбирается кнопками",
    (movementDialog?.typeButtons ?? []).map((item) => item.text).join("|") ===
      "Приход|Продажа|Списание",
    JSON.stringify(movementDialog?.typeButtons),
  );
  record(
    "кнопки «Сборка» в операциях больше нет",
    !(movementDialog?.typeButtons ?? []).some((item) => item.text === "Сборка"),
    JSON.stringify(movementDialog?.typeButtons),
  );
  record(
    "выбран ровно один тип",
    (movementDialog?.typeButtons ?? []).filter((item) => item.pressed).length === 1,
    JSON.stringify(movementDialog?.typeButtons),
  );
  record(
    "вид операции больше не выпадающий список",
    (movementDialog?.comboboxes ?? 0) === 1,
    `комбобоксов в окне: ${movementDialog?.comboboxes}`,
  );

  // Вид операции — кнопка, товар и партия — выпадающие списки. Хелперы
  // `pickType` и `pickProduct` объявлены выше: ими пользуются и другие проверки.
  const typePicked = await pickType("Продажа");
  record("вид операции «Продажа» выбирается кнопкой", typePicked === "выбрано", String(typePicked));
  const pressed = await evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label="Тип операции"]');
    return [...group.querySelectorAll('button')]
      .filter((node) => node.getAttribute('aria-pressed') === 'true')
      .map((node) => node.textContent.trim());
  })()`);
  record("нажатая кнопка показывает выбранный тип", JSON.stringify(pressed) === JSON.stringify(["Продажа"]), JSON.stringify(pressed));

  // Снимок окна: кнопки типа операции видны только здесь.
  const typeShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-movement-type-buttons.png"),
    Buffer.from(typeShot.data, "base64"),
  );

  const productPicked = await pickProduct(bouquet.name);
  record("букет выбирается товаром операции", productPicked === "выбрано", String(productPicked));
  await sleep(1500);

  const batchChoice = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    if (!dialog) return null;
    const labels = [...dialog.querySelectorAll('label')].map((node) => node.textContent.trim());
    const options = [...dialog.querySelectorAll('button[role="combobox"]')].length;
    return { labels, options, text: dialog.innerText.replace(/\\s+/g, ' ').slice(0, 400) };
  })()`);
  console.log("  выбор партии:", JSON.stringify(batchChoice).slice(0, 300));
  record(
    "для букета предлагается списание из сборки",
    (batchChoice?.labels ?? []).some((label) => label === "Списать из сборки"),
    JSON.stringify(batchChoice?.labels),
  );

  const batchOptions = await evaluate(`(async () => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    const triggers = [...dialog.querySelectorAll('button[role="combobox"]')];
    const select = triggers[triggers.length - 1];
    select.click();
    return select.textContent.trim();
  })()`);
  await sleep(900);
  const optionTexts = await evaluate(
    `[...document.querySelectorAll('[role="option"]')].map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim())`,
  );
  console.log("  варианты сборок:", JSON.stringify(optionTexts));
  record(
    "в списке есть конкретные сборки с остатком и ценой",
    (optionTexts ?? []).some((text) => text.includes("остаток") && text.includes("продажа")),
    JSON.stringify(optionTexts),
  );
  record("подпись триггера на месте", Boolean(batchOptions), String(batchOptions));

  await evaluate(closeDialog("Проведение операции"));
  await sleep(700);

  console.log("\n=== 6б. Продажу букета без сборки не провести ===");
  // Без выбора сборки форма не отправляет запрос и объясняет причину: у каждой
  // сборки свой состав и своя себестоимость.
  requests.length = 0;
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => (node.textContent || '').trim() === 'Новая операция');
    button.click();
    return 'открыт';
  })()`);
  await sleep(1200);
  await pickType("Продажа");
  await pickProduct(bouquet.name);
  await sleep(1200);
  const noBatchLabels = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    const select = [...dialog.querySelectorAll('button[role="combobox"]')].pop();
    select.click();
    return { selectText: select.textContent.trim() };
  })()`);
  await sleep(800);
  const menuOptions = await evaluate(
    `[...document.querySelectorAll('[role="option"]')].map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim())`,
  );
  // Сборку нужно назвать явно: «автоматически» у букета нет.
  record(
    "у букета в списке нет варианта «автоматически»",
    !(menuOptions ?? []).some((text) => text.includes("Автоматически")),
    JSON.stringify({ selectText: noBatchLabels?.selectText, menuOptions }),
  );
  await evaluate(
    `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  );
  await sleep(500);
  await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    const button = [...dialog.querySelectorAll('button')]
      .find((node) => (node.textContent || '').trim() === 'Провести');
    button.click();
    return 'отправлено';
  })()`);
  await sleep(1500);
  const guard = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    return {
      stillOpen: Boolean(dialog),
      text: (dialog?.innerText ?? '').replace(/\\s+/g, ' ').slice(-200),
    };
  })()`);
  record("без сборки запрос не ушёл", requests.length === 0, `запросов ${requests.length}`);
  record(
    "форма осталась открытой и объяснила причину",
    guard?.stillOpen === true && /сборк/i.test(guard?.text ?? ""),
    JSON.stringify(guard),
  );
  await evaluate(closeDialog("Проведение операции"));
  await sleep(700);

  console.log("\n=== 6в. Тип операции кнопками на телефоне ===");
  // На телефоне кнопки должны быть не меньше 44 px и не разъезжаться за край:
  // по ним попадают пальцем, часто в перчатке.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(4000);
  const openedOnPhone = await openMovementDialog();
  record("на телефоне окно операции открылось", openedOnPhone === true, String(openedOnPhone));
  const mobileType = await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    if (!dialog) return null;
    const group = dialog.querySelector('[role="group"][aria-label="Тип операции"]');
    const buttons = [...group.querySelectorAll('button')];
    return {
      texts: buttons.map((node) => node.textContent.trim()),
      heights: buttons.map((node) => Math.round(node.getBoundingClientRect().height)),
      overflowX: dialog.scrollWidth - dialog.clientWidth,
      groupWidth: Math.round(group.getBoundingClientRect().width),
      widestButton: Math.max(...buttons.map((node) => Math.round(node.getBoundingClientRect().width))),
    };
  })()`);
  console.log("  кнопки на телефоне:", JSON.stringify(mobileType));
  const mobileTypeShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-movement-type-buttons-mobile.png"),
    Buffer.from(mobileTypeShot.data, "base64"),
  );
  record(
    "на телефоне три кнопки на месте",
    (mobileType?.texts ?? []).join("|") === "Приход|Продажа|Списание",
    JSON.stringify(mobileType?.texts),
  );
  record(
    "кнопки не ниже 44 px",
    (mobileType?.heights ?? []).every((height) => height >= 44),
    JSON.stringify(mobileType?.heights),
  );
  record(
    "кнопки не вылезают за окно",
    (mobileType?.widestButton ?? 0) <= (mobileType?.groupWidth ?? 0) &&
      (mobileType?.overflowX ?? 1) <= 1,
    JSON.stringify({ widest: mobileType?.widestButton, group: mobileType?.groupWidth, overflow: mobileType?.overflowX }),
  );
  await evaluate(closeDialog("Проведение операции"));
  await sleep(700);
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  console.log("\n=== 7. Ширина таблиц ===");
  const tables = [
    { route: "/products", min: 780, key: "florasklad:table-width" },
    { route: "/bouquets", min: 760, key: "florasklad:table-width:bouquets" },
    { route: "/movements", min: 760, key: "florasklad:table-width:movements" },
  ];
  await cdp.send("Emulation.clearDeviceMetricsOverride");
  for (const table of tables) {
    await cdp.send("Page.navigate", { url: `${ui}${table.route}` });
    await sleep(3200);
    const measured = await evaluate(`(() => {
      const handle = document.querySelector('[role="separator"][aria-label="Изменить ширину таблицы"]');
      const node = document.querySelector('table');
      if (!handle || !node) return null;
      const rect = handle.getBoundingClientRect();
      const y = Math.round(rect.top + 40);
      const box = node.closest('.overflow-x-auto');
      // Ручка стоит у правого края окна таблицы (не у края самой таблицы: при
      // растягивании таблица уезжает под прокрутку, а окно остаётся на месте) и
      // нажатие действительно достаётся ей, а не соседнему блоку.
      const hits = [0, 1, 2, 3]
        .map((shift) => Math.round(rect.left + shift))
        .filter((x) => document.elementFromPoint(x, y) === handle);
      return {
        tableWidth: Math.round(node.getBoundingClientRect().width),
        boxWidth: box ? Math.round(box.getBoundingClientRect().width) : null,
        handleRight: Math.round(rect.right),
        boxRight: box ? Math.round(box.getBoundingClientRect().right) : null,
        hits,
        min: ${table.min},
      };
    })()`);
    console.log(`  ${table.route}:`, JSON.stringify(measured));
    record(
      `${table.route}: ручка стоит у правого края окна таблицы`,
      Boolean(measured) && Math.abs((measured?.handleRight ?? 0) - (measured?.boxRight ?? 0)) <= 4,
      JSON.stringify(measured),
    );
    record(
      `${table.route}: нажатие достаётся ручке`,
      (measured?.hits ?? []).length > 0,
      JSON.stringify({ hits: measured?.hits }),
    );
    record(
      `${table.route}: таблица не уже минимума`,
      (measured?.tableWidth ?? 0) >= table.min,
      `ширина ${measured?.tableWidth}`,
    );
    // Тянем за ручку настоящими событиями мыши: React слушает pointer-события,
    // а синтетический PointerEvent из скрипта не поднимается до window. Точку
    // берём у левого края полосы захвата: правый край уже за границей контейнера
    // прокрутки, и попадание по нему достаётся контейнеру, а не ручке.
    const handleBox = await evaluate(`(() => {
      const handle = document.querySelector('[role="separator"][aria-label="Изменить ширину таблицы"]');
      if (!handle) return null;
      const rect = handle.getBoundingClientRect();
      const y = Math.round(rect.top + 40);
      let x = Math.round(rect.left + 2);
      if (document.elementFromPoint(x, y) !== handle) {
        const found = [3, 4, 5, 6, 1, 0].map((shift) => Math.round(rect.left + shift))
          .find((candidate) => document.elementFromPoint(candidate, y) === handle);
        if (found === undefined) return null;
        x = found;
      }
      return {
        x,
        y,
        start: Math.round(document.querySelector('table').getBoundingClientRect().width),
      };
    })()`);
    // Точку захвата пересчитываем перед каждым движением: после сужения ручка
    // уезжает влево вместе с краем таблицы.
    const handlePoint = async () => evaluate(`(() => {
      const handle = document.querySelector('[role="separator"][aria-label="Изменить ширину таблицы"]');
      const rect = handle.getBoundingClientRect();
      const y = Math.round(rect.top + 40);
      let x = Math.round(rect.left + 2);
      if (document.elementFromPoint(x, y) !== handle) {
        const found = [3, 4, 5, 6, 1, 0].map((shift) => Math.round(rect.left + shift))
          .find((candidate) => document.elementFromPoint(candidate, y) === handle);
        if (found === undefined) return null;
        x = found;
      }
      return { x, y };
    })()`);
    if (!handleBox) throw new Error("ручка ширины не принимает нажатие");
    const drag = async (offset) => {
      const point = await handlePoint();
      if (!point) throw new Error("ручка ширины не принимает нажатие");
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      });
      for (const step of [0.3, 0.7, 1]) {
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: point.x + Math.round(offset * step),
          y: point.y,
          button: "left",
          buttons: 1,
        });
        await sleep(120);
      }
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x + offset,
        y: point.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      });
      await sleep(400);
    };
    // Сначала сужаем, потом расширяем: широкая таблица упирается в предел
    // свободного места, и проверка «стало шире» на ней ничего бы не показала.
    await drag(-160);
    const narrowed = await evaluate(
      `Math.round(document.querySelector('table').getBoundingClientRect().width)`,
    );
    await drag(120);
    await sleep(400);
    const dragged = await evaluate(`(() => ({
      narrowed: ${narrowed},
      start: ${handleBox.start},
      after: Math.round(document.querySelector('table').getBoundingClientRect().width),
      stored: Number(localStorage.getItem('${table.key}')),
    }))()`);
    console.log(`  ${table.route}: растягивание`, JSON.stringify(dragged));
    record(
      `${table.route}: таблица сужается по краю`,
      (dragged?.narrowed ?? 0) < (dragged?.start ?? 0),
      JSON.stringify(dragged),
    );
    record(
      `${table.route}: ширина запоминается после движения`,
      (dragged?.stored ?? 0) > 0 && (dragged?.stored ?? 0) !== (dragged?.start ?? -1),
      JSON.stringify(dragged),
    );
    record(
      `${table.route}: содержимое не шире окна таблицы`,
      (dragged?.after ?? 0) <= (measured?.boxWidth ?? 0) + 8,
      JSON.stringify({ after: dragged?.after, box: measured?.boxWidth }),
    );
  }

  const widthShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const widthShotPath = path.resolve(here, "..", "..", "screenshots", "check-resizable-tables.png");
  writeFileSync(widthShotPath, Buffer.from(widthShot.data, "base64"));
  console.log(`  снимок: ${widthShotPath}`);

  socket.close();
} catch (error) {
  const details = error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error);
  record("проверка производства в интерфейсе", false, details.slice(0, 600));
} finally {
  browser.kill();
  await sleep(1000);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // уберёт система
  }
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
