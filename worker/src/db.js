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

export async function createOrder(db, { customer_id, product_id, amount, note }) {
  const orderNo = generateOrderNo();
  const res = await db.prepare(
    'INSERT INTO orders (order_no, customer_id, product_id, amount, note, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(orderNo, customer_id || null, product_id || null, amount, note || null, 'pending').run();
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
  return {
    monthlyRevenue: revenueRow ? revenueRow.total : 0,
    monthlyPaidOrders: paidCountRow ? paidCountRow.n : 0,
    pendingOrders: pendingRow ? pendingRow.n : 0,
    recentOrders,
  };
}
