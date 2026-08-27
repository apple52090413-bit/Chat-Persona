#!/usr/bin/env python3
"""Regenerate worker/dashboard-bundle.js from worker/src/*.js.

Strips import/export statements from each source file (keeping
`export default { ... }` in index.js as-is) and concatenates them in
dependency order, with a synthetic `db` namespace object rebuilt after
db.js so adminRoutes.js's `db.xxx(...)` calls keep working when the
`import * as db` is gone.

Run with: python3 worker/build-bundle.py
"""
import re
import os

SRC_DIR = os.path.join(os.path.dirname(__file__), 'src')
OUT_FILE = os.path.join(os.path.dirname(__file__), 'dashboard-bundle.js')

ORDER = [
    'validate.js',
    'anthropic.js',
    'prompts.js',
    'auth.js',
    'newebpay.js',
    'db.js',
    'adminRoutes.js',
    'index.js',
]

DB_FUNCS = [
    'listCustomers', 'createCustomer', 'getCustomer', 'updateCustomer', 'deleteCustomer',
    'listProducts', 'createProduct', 'getProduct', 'updateProduct', 'deleteProduct',
    'listOrders', 'getOrder', 'getOrderByOrderNo', 'createOrder', 'updateOrderStatus',
    'markOrderPaidByOrderNo', 'getDashboardStats', 'logApiUsage', 'getUsageStats',
]

HEADER = """// ============================================================
// Chat Persona API — 單檔打包版（給 Cloudflare Dashboard 線上編輯器用）
// 這個檔案是 worker/src/*.js 自動合併產生的，內容完全相同，
// 只是把所有檔案的 import/export 拆解合併成一份方便貼上。
// 如果你有終端機可以用 wrangler 部署，請改用 worker/src/ 底下的原始檔案。
// ============================================================
"""

DB_SHIM = """// db.js 原本是用 `import * as db` 呼叫，這裡重建一個等價的 db 物件，
// 讓下面 adminRoutes.js 的 db.xxx(...) 呼叫方式維持不變。
const db = {
""" + "".join(f"  {name},\n" for name in DB_FUNCS) + "};\n"

IMPORT_RE = re.compile(r'^import\s.*?;\s*$', re.M | re.S)


def strip_file(name, text):
    # Remove multi-line import statements
    text = re.sub(r'^import\s*\{[^}]*\}\s*from\s*[\'"][^\'"]+[\'"];\s*\n', '', text, flags=re.M)
    text = re.sub(r'^import\s+[^\n]*;\s*\n', '', text, flags=re.M)
    if name == 'index.js':
        # keep `export default {` as-is
        text = re.sub(r'^export function ', 'function ', text, flags=re.M)
        text = re.sub(r'^export const ', 'const ', text, flags=re.M)
        text = re.sub(r'^export async function ', 'async function ', text, flags=re.M)
    else:
        text = re.sub(r'^export function ', 'function ', text, flags=re.M)
        text = re.sub(r'^export async function ', 'async function ', text, flags=re.M)
        text = re.sub(r'^export const ', 'const ', text, flags=re.M)
    return text.strip('\n')


def main():
    parts = [HEADER]
    for name in ORDER:
        path = os.path.join(SRC_DIR, name)
        with open(path, encoding='utf-8') as f:
            raw = f.read()
        cleaned = strip_file(name, raw)
        parts.append(f"\n// ---------- {name} ----------\n{cleaned}\n")
        if name == 'db.js':
            parts.append(f"\n{DB_SHIM}")
    out = ''.join(parts)
    if not out.endswith('\n'):
        out += '\n'
    with open(OUT_FILE, 'w', encoding='utf-8') as f:
        f.write(out)
    print(f"Wrote {OUT_FILE} ({out.count(chr(10))} lines)")


if __name__ == '__main__':
    main()
