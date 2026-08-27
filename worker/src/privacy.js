// 隱私遮蔽的「保險層」：prompts.js 裡已經有很明確的指示要求 AI 不要把真實
// 姓名/綽號寫進回覆內容，但那終究是機率性的（AI 有可能忘記、尤其是長對話）。
// 這裡加一層決定性的保護——請 AI 額外回報「對話裡用什麼稱呼指這個人」
// （personAAliases / personBAliases / otherPartyAliases），拿到之後不管
// AI 本來寫的內容有沒有照規則做，程式碼都會把這些稱呼從回傳結果的每一個
// 字串欄位裡強制換成「你」／「對方」，不依賴 AI 自己是否遵守指示。

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 只保留看起來像真的姓名/綽號的字串：至少 2 個字，且不是「你」「對方」「我」
// 這種本來就該用的代稱（避免誤判把正常代稱也拿去做全文取代，弄壞其他句子）。
function sanitizeAliases(aliases) {
  if (!Array.isArray(aliases)) return [];
  const skip = new Set(['你', '我', '他', '她', '對方', '妳']);
  return aliases
    .filter(a => typeof a === 'string')
    .map(a => a.trim())
    .filter(a => a.length >= 2 && !skip.has(a));
}

function redactValue(value, aliasMap) {
  if (typeof value === 'string') {
    let out = value;
    for (const [alias, replacement] of aliasMap) {
      out = out.replace(new RegExp(escapeRegex(alias), 'gi'), replacement);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(v => redactValue(v, aliasMap));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = redactValue(value[key], aliasMap);
    return out;
  }
  return value;
}

// aliasGroups 例如 [{ aliases: result.personAAliases, replacement: '你' }, { aliases: result.personBAliases, replacement: '對方' }]
// 回傳一份新的物件（不修改原本的 result），並把 *Aliases 這種只給系統內部用的
// 欄位拿掉，不需要讓前端看到。
// aliasFieldNames：result 裡面「別名清單本身」放在哪幾個 key（例如
// personAAliases/personBAliases）。這幾個欄位要從取代範圍裡排除，不然清單
// 自己列出的名字會被規則自己取代掉（例如 personBAliases:['小美'] 變成
// ['對方']），之後 refine／followup 想沿用同一份名單就找不到原始名字了。
export function redactAliasesFromResult(result, aliasGroups, aliasFieldNames = []) {
  const pairs = [];
  for (const { aliases, replacement } of aliasGroups) {
    for (const alias of sanitizeAliases(aliases)) pairs.push([alias, replacement]);
  }
  // 長的稱呼先換，避免短稱呼剛好是長稱呼的一部分，把長稱呼提前拆散。
  pairs.sort((a, b) => b[0].length - a[0].length);

  if (!pairs.length) return { ...result };

  const preserved = {};
  const toRedact = { ...result };
  for (const field of aliasFieldNames) {
    if (field in toRedact) {
      preserved[field] = toRedact[field];
      delete toRedact[field];
    }
  }

  return { ...redactValue(toRedact, pairs), ...preserved };
}
