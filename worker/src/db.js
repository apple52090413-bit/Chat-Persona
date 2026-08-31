// ---------- Customers ----------

export async function listCustomers(db) {
  const { results } = await db.prepare('SELECT * FROM customers ORDER BY id DESC').all();
  return results;
}

export async function createCustomer(db, { name, contact, note }) {
  const res = await db.prepare('INSERT INTO customers (name, contact, note) VALUES (?, ?, ?)')
    .bind(name, contact || null, note || null).run();
  return getCustomer(db, res.meta.last_row_id);
}

export async function getCustomer(db, id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first();
}

export async function updateCustomer(db, id, fields) {
  const allowed = ['name', 'contact', 'note'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(fields[key]); }
  }
  if (!sets.length) return getCustomer(db, id);
  values.push(id);
  await db.prepare('UPDATE customers SET ' + sets.join(', ') + ' WHERE id = ?').bind(...values).run();
  return getCustomer(db, id);
}

export async function deleteCustomer(db, id) {
  await db.prepare('DELETE FROM customers WHERE id = ?').bind(id).run();
}

// ---------- Products ----------

export async function listProducts(db) {
  const { results } = await db.prepare('SELECT * FROM products ORDER BY id ASC').all();
  return results;
}

export async function createProduct(db, { name, price, billing_cycle, active }) {
  const res = await db.prepare('INSERT INTO products (name, price, billing_cycle, active) VALUES (?, ?, ?, ?)')
    .bind(name, price, billing_cycle || 'one_time', active === false ? 0 : 1).run();
  return getProduct(db, res.meta.last_row_id);
}

export async function getProduct(db, id) {
  return db.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
}

export async function updateProduct(db, id, fields) {
  const allowed = ['name', 'price', 'billing_cycle', 'active'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) { sets.push(key + ' = ?'); values.push(key === 'active' ? (fields[key] ? 1 : 0) : fields[key]); }
  }
  if (!sets.length) return getProduct(db, id);
  values.push(id);
  await db.prepare('UPDATE products SET ' + sets.join(', ') + ' WHERE id = ?').bind(...values).run();
  return getProduct(db, id);
}

export async function deleteProduct(db, id) {
  await db.prepare('DELETE FROM products WHERE id = ?').bind(id).run();
}

export async function getProductByName(db, name) {
  return db.prepare('SELECT * FROM products WHERE name = ? LIMIT 1').bind(name).first();
}

// ---------- Orders ----------

export async function listOrders(db, { status } = {}) {
  if (status) {
    const { results } = await db.prepare(
      `SELECT orders.*, customers.name AS customer_name, products.name AS product_name
       FROM orders
       LEFT JOIN customers ON customers.id = orders.customer_id
       LEFT JOIN products ON products.id = orders.product_id
       WHERE orders.status = ?
       ORDER BY orders.id DESC`
    ).bind(status).all();
    return results;
  }
  const { results } = await db.prepare(
    `SELECT orders.*, customers.name AS customer_name, products.name AS product_name
     FROM orders
     LEFT JOIN customers ON customers.id = orders.customer_id
     LEFT JOIN products ON products.id = orders.product_id
     ORDER BY orders.id DESC`
  ).all();
  return results;
}

export async function getOrder(db, id) {
  return db.prepare(
    `SELECT orders.*, customers.name AS customer_name, products.name AS product_name
     FROM orders
     LEFT JOIN customers ON customers.id = orders.customer_id
     LEFT JOIN products ON products.id = orders.product_id
     WHERE orders.id = ?`
  ).bind(id).first();
}

export async function getOrderByOrderNo(db, orderNo) {
  return db.prepare('SELECT * FROM orders WHERE order_no = ?').bind(orderNo).first();
}

function generateOrderNo() {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const rand = Math.floor(Math.random() * 9000 + 1000);
  return 'ORD' + stamp + rand;
}

// 給客戶自助結帳流程用：一組隨機、無法猜測的權杖，付款完成從藍新導回本站後，
// 前端要拿這組權杖（不是只憑 order_no）跟後端確認這筆訂單真的已經付款，
// 避免有人自己編一個 order_no 或猜別人的訂單就解鎖付費功能。
function generateClientToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function createOrder(db, { customer_id, product_id, amount, note }) {
  const orderNo = generateOrderNo();
  const clientToken = generateClientToken();
  const res = await db.prepare(
    'INSERT INTO orders (order_no, customer_id, product_id, amount, note, status, client_token) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(orderNo, customer_id || null, product_id || null, amount, note || null, 'pending', clientToken).run();
  return getOrder(db, res.meta.last_row_id);
}

export async function updateOrderStatus(db, id, { status, payment_type }) {
  const paidAt = status === 'paid' ? new Date().toISOString() : null;
  await db.prepare('UPDATE orders SET status = ?, payment_type = COALESCE(?, payment_type), paid_at = COALESCE(?, paid_at) WHERE id = ?')
    .bind(status, payment_type || null, paidAt, id).run();
  return getOrder(db, id);
}

export async function markOrderPaidByOrderNo(db, orderNo, { payment_type } = {}) {
  await db.prepare("UPDATE orders SET status = 'paid', payment_type = COALESCE(?, payment_type), paid_at = ? WHERE order_no = ?")
    .bind(payment_type || null, new Date().toISOString(), orderNo).run();
  return getOrderByOrderNo(db, orderNo);
}

// ---------- Dashboard ----------

export async function getDashboardStats(db) {
  const monthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
  const revenueRow = await db.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE status = 'paid' AND substr(paid_at, 1, 7) = ?"
  ).bind(monthPrefix).first();
  const paidCountRow = await db.prepare(
    "SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND substr(paid_at, 1, 7) = ?"
  ).bind(monthPrefix).first();
  const pendingRow = await db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'").first();
  const { results: recentOrders } = await db.prepare(
    `SELECT orders.*, customers.name AS customer_name, products.name AS product_name
     FROM orders
     LEFT JOIN customers ON customers.id = orders.customer_id
     LEFT JOIN products ON products.id = orders.product_id
     ORDER BY orders.id DESC LIMIT 8`
  ).all();
  const usage = await getUsageStats(db);
  return {
    monthlyRevenue: revenueRow ? revenueRow.total : 0,
    monthlyPaidOrders: paidCountRow ? paidCountRow.n : 0,
    pendingOrders: pendingRow ? pendingRow.n : 0,
    recentOrders,
    monthlyApiCalls: usage.monthlyApiCalls,
    monthlyInputTokens: usage.monthlyInputTokens,
    monthlyOutputTokens: usage.monthlyOutputTokens,
  };
}

// ---------- API 用量記錄 ----------
// 每一次呼叫 Claude API 都記一筆，orderId 可以是 null（例如免費版分析目前還沒有
// 對應的訂單）。這個表只是用來看花費趨勢，不影響任何分析結果本身。

export async function logApiUsage(db, { orderId, endpoint, model, inputTokens, outputTokens }) {
  await db.prepare(
    'INSERT INTO api_usage (order_id, endpoint, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)'
  ).bind(orderId || null, endpoint, model, inputTokens || 0, outputTokens || 0).run();
}

export async function getUsageStats(db) {
  const monthPrefix = new Date().toISOString().slice(0, 7); // YYYY-MM
  const row = await db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(input_tokens), 0) AS input_total, COALESCE(SUM(output_tokens), 0) AS output_total
     FROM api_usage WHERE substr(created_at, 1, 7) = ?`
  ).bind(monthPrefix).first();
  return {
    monthlyApiCalls: row ? row.n : 0,
    monthlyInputTokens: row ? row.input_total : 0,
    monthlyOutputTokens: row ? row.output_total : 0,
  };
}
