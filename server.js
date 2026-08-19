require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const PDFDocument = require('pdfkit');

const app = express();
const port = Number(process.env.PORT || 3000);
const mongoUri = process.env.MONGODB_URI;

if (!mongoUri) {
  console.error('MONGODB_URI is missing. Copy .env.example to .env and set your MongoDB connection string.');
  process.exit(1);
}

const stateKeys = new Set([
  'bridge_products', 'bridge_users', 'bridge_orders', 'bridge_reviews',
  'seller_ratings', 'bridge_payouts', 'bridge_banned_users',
  'bridge_complaints', 'bridge_inquiries', 'bridge_cart'
]);

const stateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, enum: [...stateKeys] },
  value: { type: mongoose.Schema.Types.Mixed, required: true },
  updatedAt: { type: Date, default: Date.now }
}, { versionKey: false });
const AppState = mongoose.model('AppState', stateSchema);

const otpSchema = new mongoose.Schema({
  contact: { type: String, required: true, index: true },
  fullName: { type: String, default: '' },
  username: { type: String, required: true, index: true },
  role: { type: String, default: '' },
  mobile: { type: String, default: '' },
  email: { type: String, default: '' },
  otpHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
  verifiedAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 }
}, { versionKey: false });
const Otp = mongoose.model('Otp', otpSchema);

const hashOtp = (otp) => crypto.createHash('sha256').update(String(otp)).digest('hex');

// Dedicated collections make the data easy to browse in MongoDB Atlas while
// AppState preserves the exact data format expected by the unchanged frontend.
const documentSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
const collectionModels = {
  bridge_users: mongoose.model('User', documentSchema),
  bridge_products: mongoose.model('Product', documentSchema),
  bridge_orders: mongoose.model('Order', documentSchema),
  bridge_reviews: mongoose.model('Review', documentSchema),
  seller_ratings: mongoose.model('SellerRating', documentSchema, 'ratings'),
  bridge_payouts: mongoose.model('Payout', documentSchema),
  bridge_cart: mongoose.model('Cart', documentSchema, 'carts'),
  bridge_banned_users: mongoose.model('BannedUser', documentSchema),
  bridge_complaints: mongoose.model('Complaint', documentSchema),
  bridge_inquiries: mongoose.model('Inquiry', documentSchema)
};

async function mirrorStateToCollection(key, value) {
  const Model = collectionModels[key];
  if (!Model) return;
  await Model.deleteMany({});
  const entries = Array.isArray(value) ? value : (value && typeof value === 'object' ? [value] : []);
  if (entries.length === 0) return;
  const documents = entries.map((item) => (
    item && typeof item === 'object' && !Array.isArray(item) ? { ...item } : { value: item }
  ));
  // An earlier version of the project created a unique `orderId` index. The
  // frontend uses `id`, so preserve both names to keep that existing index valid.
  if (key === 'bridge_orders') {
    documents.forEach((order) => { order.orderId = order.orderId ?? order.id; });
  }
  if (key === 'bridge_cart') {
    documents.forEach((item) => {
      item.userId = item.userId ?? 'active-cart';
      item.productId = item.productId ?? item.id;
    });
  }
  await Model.insertMany(documents);
}

async function saveState(key, value) {
  await AppState.findOneAndUpdate(
    { key },
    { value, updatedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await mirrorStateToCollection(key, value);
}

// A product is saved individually by the seller endpoint. This avoids deleting
// and re-inserting the full catalogue (and every image) for one small change.
async function saveSingleProductState(products, product) {
  await AppState.findOneAndUpdate(
    { key: 'bridge_products' },
    { value: products, updatedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const Product = collectionModels.bridge_products;
  await Product.deleteMany({ id: product.id });
  await Product.create(product);
}

// Product deletion needs its own database operation too. Product creation and
// updates already use /api/products, so deleting only from a browser cache
// would make the product reappear on another phone or laptop.
async function deleteSingleProductState(products, productId) {
  await AppState.findOneAndUpdate(
    { key: 'bridge_products' },
    { value: products, updatedAt: new Date() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  await collectionModels.bridge_products.deleteMany({ id: productId });
}

// Browser actions can trigger two saves in quick succession. Run writes for
// the same collection one after another so the readable Atlas collection is
// always left with the same latest data as appstates.
const stateSaveQueues = new Map();
function queueStateSave(key, value) {
  const previous = stateSaveQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => undefined).then(() => saveState(key, value));
  stateSaveQueues.set(key, next);
  return next.finally(() => {
    if (stateSaveQueues.get(key) === next) stateSaveQueues.delete(key);
  });
}

// Product creation, edits, and deletions all replace the same catalogue array
// in AppState. Serialize those complete read/write operations so two quick
// deletes cannot each write an old snapshot back over the other one.
let productWriteChain = Promise.resolve();
function queueProductWrite(task) {
  const next = productWriteChain.catch(() => undefined).then(task);
  productWriteChain = next;
  return next;
}

async function ensureAdminAccount() {
  const admin = {
    fullName: 'Website Owner', username: 'hightable', password: 'hightable2026',
    role: 'admin', sellerId: null, phoneVerified: true, isBanned: false
  };
  const state = await AppState.findOne({ key: 'bridge_users' });
  const users = Array.isArray(state?.value) ? state.value : [];
  if (users.some((user) => user.username === admin.username)) return;
  users.push(admin);
  await AppState.findOneAndUpdate(
    { key: 'bridge_users' },
    { value: users, updatedAt: new Date() },
    { upsert: true, new: true }
  );
  await mirrorStateToCollection('bridge_users', users);
}

// Older products were linked only by a numeric sellerId. Add the seller
// username too, so accounts with the same display name remain separate.
async function ensureProductOwners() {
  const [usersState, productsState] = await Promise.all([
    AppState.findOne({ key: 'bridge_users' }).lean(),
    AppState.findOne({ key: 'bridge_products' }).lean()
  ]);
  const users = Array.isArray(usersState?.value) ? usersState.value : [];
  const products = Array.isArray(productsState?.value) ? productsState.value : [];
  let changed = false;
  products.forEach((product) => {
    if (product.sellerUsername) return;
    const seller = users.find((user) => String(user.sellerId ?? '') === String(product.sellerId ?? ''));
    if (seller?.username) {
      product.sellerUsername = seller.username;
      changed = true;
    }
  });
  if (changed) await queueStateSave('bridge_products', products);
}

app.use(express.json({ limit: '12mb' }));

// Demo OTP flow. A production version should replace returning `otp` below
// with an SMS/email provider such as Twilio, AWS SNS, or Resend.
app.post('/api/auth/otp', async (req, res, next) => {
  try {
    const contact = String(req.body.contact || '').trim();
    const username = String(req.body.username || '').trim();
    if (!contact || !username) return res.status(400).json({ error: 'Contact and username are required.' });

    const otp = crypto.randomInt(100000, 1000000).toString();
    await Otp.create({
      contact,
      fullName: String(req.body.fullName || '').trim(),
      username,
      role: String(req.body.role || '').trim(),
      mobile: String(req.body.mobile || '').trim(),
      email: String(req.body.email || '').trim(),
      otpHash: hashOtp(otp),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000)
    });
    res.status(201).json({ otp, expiresIn: 600 });
  } catch (error) { next(error); }
});

app.post('/api/auth/otp/verify', async (req, res, next) => {
  try {
    const contact = String(req.body.contact || '').trim();
    const username = String(req.body.username || '').trim();
    const otp = String(req.body.otp || '').trim();
    const record = await Otp.findOne({ contact, username, verifiedAt: null }).sort({ createdAt: -1 });

    if (!record || record.expiresAt <= new Date()) {
      return res.status(400).json({ error: 'The OTP is invalid or expired.' });
    }
    record.attempts += 1;
    if (record.attempts > 5 || record.otpHash !== hashOtp(otp)) {
      await record.save();
      return res.status(400).json({ error: 'The OTP is invalid or expired.' });
    }
    record.verifiedAt = new Date();
    await record.save();
    res.status(204).end();
  } catch (error) { next(error); }
});

app.post('/api/auth/register', async (req, res, next) => {
  try {
    const candidate = req.body || {};
    const required = ['fullName', 'username', 'address', 'nid', 'password', 'role'];
    if (required.some((field) => !String(candidate[field] || '').trim())) {
      return res.status(400).json({ error: 'Please complete all required fields.' });
    }
    if (!['buyer', 'seller'].includes(candidate.role)) {
      return res.status(400).json({ error: 'Unsupported account role.' });
    }
    const contact = String(candidate.mobile || candidate.email || '').trim();
    const verifiedOtp = await Otp.findOne({
      contact,
      username: String(candidate.username).trim(),
      verifiedAt: { $ne: null }
    }).sort({ createdAt: -1 }).lean();
    if (!contact || !verifiedOtp) {
      return res.status(400).json({ error: 'Please verify your mobile number or email with OTP first.' });
    }
    const state = await AppState.findOne({ key: 'bridge_users' }).lean();
    const users = Array.isArray(state?.value) ? state.value : [];
    if (users.some((user) => user.username === candidate.username || user.nid === candidate.nid)) {
      return res.status(409).json({ error: 'This username or NID is already registered.' });
    }
    const nextSellerId = users.reduce((max, user) => Math.max(max, Number(user.sellerId) || 0), 0) + 1;
    const user = {
      fullName: String(candidate.fullName).trim(),
      username: String(candidate.username).trim(),
      mobile: String(candidate.mobile || '').trim(),
      email: String(candidate.email || '').trim(),
      address: String(candidate.address).trim(),
      nid: String(candidate.nid).trim(),
      password: String(candidate.password),
      role: candidate.role,
      sellerId: candidate.role === 'seller' ? nextSellerId : null,
      phoneVerified: true,
      registeredAt: new Date().toISOString(),
      bkash: '', nagad: '', rocket: '', bankAccount: ''
    };
    users.push(user);
    await queueStateSave('bridge_users', users);
    const { password, ...safeUser } = user;
    res.status(201).json({ user: safeUser });
  } catch (error) { next(error); }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const usernameOrEmail = String(req.body.usernameOrEmail || '').trim();
    const password = String(req.body.password || '');
    const state = await AppState.findOne({ key: 'bridge_users' }).lean();
    const users = Array.isArray(state?.value) ? state.value : [];
    const user = users.find((entry) => entry.username === usernameOrEmail || entry.email === usernameOrEmail);
    if (!user || user.password !== password || user.isBanned) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }
    const { password: _password, ...safeUser } = user;
    res.json({ user: safeUser });
  } catch (error) { next(error); }
});

// Save a profile directly instead of sending the whole users collection from
// the browser. A sellerId is permanent, so products remain connected even if
// the seller edits their username, name, phone number, or payment details.
app.put('/api/users/:username/profile', async (req, res, next) => {
  try {
    const previousUsername = String(req.params.username || '').trim();
    const actorUsername = String(req.body?.actor?.username || '').trim();
    const actorPassword = String(req.body?.actor?.password || '');
    const profile = req.body?.profile || {};
    if (!previousUsername || previousUsername !== actorUsername || !actorPassword) {
      return res.status(401).json({ error: 'Please sign in again before changing your profile.' });
    }

    const state = await AppState.findOne({ key: 'bridge_users' }).lean();
    const users = Array.isArray(state?.value) ? state.value : [];
    const userIndex = users.findIndex((user) =>
      user.username === previousUsername && user.password === actorPassword && !user.isBanned
    );
    if (userIndex === -1) return res.status(401).json({ error: 'Your sign-in session has expired. Please sign in again.' });

    const existingUser = users[userIndex];
    const username = String(profile.username || '').trim();
    const fullName = String(profile.fullName || '').trim();
    const mobile = String(profile.mobile || '').trim();
    const address = String(profile.address || '').trim();
    const nid = String(profile.nid || '').trim();
    const email = String(profile.email || '').trim();
    const password = String(profile.newPassword || '');
    if (!username || !fullName || !mobile || !address || !nid) {
      return res.status(400).json({ error: 'Please complete all required profile fields.' });
    }
    if (users.some((user, index) => index !== userIndex && user.username === username)) {
      return res.status(409).json({ error: 'This username is already in use.' });
    }
    if (users.some((user, index) => index !== userIndex && user.nid === nid)) {
      return res.status(409).json({ error: 'This NID is already registered.' });
    }
    if (password && password.length < 4) {
      return res.status(400).json({ error: 'Password must contain at least 4 characters.' });
    }

    const updatedUser = {
      ...existingUser,
      username,
      fullName,
      mobile,
      email,
      address,
      nid,
      password: password || existingUser.password
    };
    if (existingUser.role === 'seller') {
      updatedUser.bkash = String(profile.bkash || '').trim();
      updatedUser.nagad = String(profile.nagad || '').trim();
      updatedUser.rocket = String(profile.rocket || '').trim();
      updatedUser.bankAccount = String(profile.bankAccount || '').trim();
    }

    users[userIndex] = updatedUser;
    await AppState.findOneAndUpdate(
      { key: 'bridge_users' },
      { value: users, updatedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await collectionModels.bridge_users.findOneAndReplace(
      { username: previousUsername },
      updatedUser,
      { upsert: true, new: true }
    );

    const { password: _password, ...safeUser } = updatedUser;
    res.json({ user: safeUser });
  } catch (error) { next(error); }
});

app.get('/api/receipts/:orderId.pdf', async (req, res, next) => {
  try {
    const state = await AppState.findOne({ key: 'bridge_orders' }).lean();
    const orders = Array.isArray(state?.value) ? state.value : [];
    const order = orders.find((entry) => String(entry.id) === String(req.params.orderId));
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    const pdf = new PDFDocument({ size: 'A4', margin: 48 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="bridge-bazar-receipt-${order.id}.pdf"`);
    pdf.pipe(res);

    const money = (amount) => `BDT ${Number(amount || 0).toFixed(2)}`;
    pdf.rect(0, 0, 595, 112).fill('#0b5e2e');
    pdf.fillColor('#ffe484').font('Helvetica-Bold').fontSize(26).text('BRIDGE BAZAR', 48, 35);
    pdf.fillColor('#ffffff').font('Helvetica').fontSize(10).text('Marketplace purchase receipt', 48, 70);
    pdf.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text(`ORDER #${order.id}`, 390, 50, { width: 155, align: 'right' });

    pdf.moveDown(4).fillColor('#1b4d2a').font('Helvetica-Bold').fontSize(15).text('Payment Summary');
    pdf.moveDown(0.5).font('Helvetica').fontSize(10).fillColor('#333333');
    pdf.text(`Buyer: ${order.buyerName || 'Customer'}`);
    pdf.text(`Seller: ${order.sellerName || 'Seller'}`);
    pdf.text(`Order date: ${new Date(order.orderDate || Date.now()).toLocaleString()}`);
    pdf.text(`Delivery: ${order.deliveryMethod || 'Standard delivery'}`);
    pdf.text(`Payment method: ${order.paymentMethod || 'Cash on delivery'}`);
    pdf.text(`Transaction ID: ${order.transactionId || 'Not applicable'}`);

    const top = pdf.y + 22;
    pdf.rect(48, top, 499, 24).fill('#e8f5e9');
    pdf.fillColor('#1b4d2a').font('Helvetica-Bold').fontSize(10);
    pdf.text('ITEM', 58, top + 7, { width: 265 });
    pdf.text('QTY', 335, top + 7, { width: 50, align: 'center' });
    pdf.text('AMOUNT', 415, top + 7, { width: 120, align: 'right' });

    let y = top + 34;
    pdf.font('Helvetica').fillColor('#333333');
    (order.items || []).forEach((item) => {
      if (y > 690) { pdf.addPage(); y = 60; }
      pdf.text(String(item.name || 'Product'), 58, y, { width: 265 });
      pdf.text(String(item.quantity || 0), 335, y, { width: 50, align: 'center' });
      pdf.text(money((item.price || 0) * (item.quantity || 0)), 415, y, { width: 120, align: 'right' });
      y += 23;
    });

    y += 10;
    pdf.moveTo(330, y).lineTo(547, y).strokeColor('#cfe1c3').stroke();
    y += 12;
    pdf.fillColor('#333333').font('Helvetica').text('Subtotal', 350, y, { width: 90 });
    pdf.text(money(order.subtotal ?? order.total), 440, y, { width: 95, align: 'right' });
    y += 20;
    pdf.text('Courier charge', 350, y, { width: 90 });
    pdf.text(money(order.courierCharge), 440, y, { width: 95, align: 'right' });
    y += 24;
    pdf.fillColor('#0b5e2e').font('Helvetica-Bold').fontSize(13).text('TOTAL', 350, y, { width: 90 });
    pdf.text(money(order.total), 420, y, { width: 115, align: 'right' });
    pdf.fillColor('#5a7a5a').font('Helvetica').fontSize(9).text('Thank you for shopping with Bridge Bazar.', 48, 755, { width: 499, align: 'center' });
    pdf.end();
  } catch (error) { next(error); }
});

// Admin screens refresh orders directly from MongoDB. This avoids depending on
// a browser's older cached state when an order was placed from another device.
app.get('/api/orders', async (_req, res, next) => {
  try {
    const state = await AppState.findOne({ key: 'bridge_orders' }).lean();
    const orders = Array.isArray(state?.value) ? state.value : [];
    res.json({ orders });
  } catch (error) { next(error); }
});

// Product saves use a dedicated endpoint so the seller dashboard is updated
// only after the product has been accepted by MongoDB.
app.post('/api/products', async (req, res, next) => {
  try {
    const input = req.body?.product || {};
    const mode = req.body?.mode === 'update' ? 'update' : 'create';
    const name = String(input.name || '').trim();
    const price = Number(input.price);
    const stock = Number(input.stock);
    if (!name || !Number.isFinite(price) || !Number.isFinite(stock)) {
      return res.status(400).json({ error: 'Product name, price, and stock are required.' });
    }

    const imageList = Array.isArray(input.images) ? input.images : [];
    const images = imageList.filter((image) =>
      typeof image === 'string' && (!image.startsWith('data:') || image.length <= 350000)
    ).slice(0, 4);
    const imageData = typeof input.imageData === 'string' &&
      (!input.imageData.startsWith('data:') || input.imageData.length <= 350000)
      ? input.imageData : (images[0] || null);

    const result = await queueProductWrite(async () => {
      const state = await AppState.findOne({ key: 'bridge_products' }).lean();
      const products = Array.isArray(state?.value) ? state.value : [];
      const requestedId = Number(input.id);
      const existingIndex = mode === 'update'
        ? products.findIndex((product) => Number(product.id) === requestedId) : -1;
      if (mode === 'update' && existingIndex === -1) {
        const error = new Error('This product no longer exists.');
        error.statusCode = 404;
        throw error;
      }

      const nextId = products.reduce((max, product) => Math.max(max, Number(product.id) || 0), 0) + 1;
      const product = {
        ...(existingIndex >= 0 ? products[existingIndex] : {}),
        id: existingIndex >= 0 ? requestedId : nextId,
        name,
        price,
        stock,
        images: images.length ? images : null,
        imageData,
        sellerId: input.sellerId ?? (existingIndex >= 0 ? products[existingIndex].sellerId : null),
        sellerUsername: String(input.sellerUsername || (existingIndex >= 0 ? products[existingIndex].sellerUsername : '')),
        sellerName: String(input.sellerName || (existingIndex >= 0 ? products[existingIndex].sellerName : 'Seller')),
        sellerPhone: String(input.sellerPhone || (existingIndex >= 0 ? products[existingIndex].sellerPhone : ''))
      };
      if (existingIndex >= 0) products[existingIndex] = product;
      else products.push(product);
      await saveSingleProductState(products, product);
      return { product, isUpdate: existingIndex >= 0 };
    });
    res.status(result.isUpdate ? 200 : 201).json({ product: result.product });
  } catch (error) { next(error); }
});

// Only the seller who posted a product or an administrator may remove it.
// The account is checked again against MongoDB so the rule works on every
// device instead of relying only on what the browser happens to display.
app.delete('/api/products/:id', async (req, res, next) => {
  try {
    const productId = Number(req.params.id);
    const actorUsername = String(req.body?.actor?.username || '').trim();
    const actorPassword = String(req.body?.actor?.password || '');
    if (!Number.isFinite(productId) || !actorUsername || !actorPassword) {
      return res.status(400).json({ error: 'Please sign in before deleting a product.' });
    }

    const usersState = await AppState.findOne({ key: 'bridge_users' }).lean();
    const users = Array.isArray(usersState?.value) ? usersState.value : [];
    const actor = users.find((user) =>
      user.username === actorUsername && user.password === actorPassword && !user.isBanned
    );
    if (!actor) return res.status(401).json({ error: 'Your sign-in session has expired. Please sign in again.' });

    await queueProductWrite(async () => {
      const productsState = await AppState.findOne({ key: 'bridge_products' }).lean();
      const products = Array.isArray(productsState?.value) ? productsState.value : [];
      const product = products.find((item) => Number(item.id) === productId);
      if (!product) {
        const error = new Error('This product no longer exists.');
        error.statusCode = 404;
        throw error;
      }

      const isAdmin = actor.role === 'admin';
      const isOwner = actor.role === 'seller' && (
        product.sellerUsername === actor.username ||
        String(product.sellerId ?? '') === String(actor.sellerId ?? '')
      );
      if (!isAdmin && !isOwner) {
        const error = new Error('Only the product owner or an administrator can delete this product.');
        error.statusCode = 403;
        throw error;
      }

      const remainingProducts = products.filter((item) => Number(item.id) !== productId);
      await deleteSingleProductState(remainingProducts, productId);
    });
    res.json({ success: true, deletedProductId: productId });
  } catch (error) { next(error); }
});

// The seller dashboard reads its own product list directly from MongoDB. This
// avoids a stale browser cache hiding products that have already been saved.
app.get('/api/sellers/:username/products', async (req, res, next) => {
  try {
    const username = String(req.params.username || '').trim();
    const [usersState, productsState] = await Promise.all([
      AppState.findOne({ key: 'bridge_users' }).lean(),
      AppState.findOne({ key: 'bridge_products' }).lean()
    ]);
    const users = Array.isArray(usersState?.value) ? usersState.value : [];
    const products = Array.isArray(productsState?.value) ? productsState.value : [];
    const seller = users.find((user) => user.username === username && user.role === 'seller');
    if (!seller) return res.status(404).json({ error: 'Seller account not found.' });
    const sellerProducts = products.filter((product) =>
      product.sellerUsername === seller.username ||
      String(product.sellerId ?? '') === String(seller.sellerId ?? '')
    );
    res.json({ products: sellerProducts });
  } catch (error) { next(error); }
});

// The existing page writes to these endpoints through the small adapter at the
// bottom of index.html. Keeping this API generic lets the unchanged interface
// persist every marketplace feature in MongoDB.
app.get('/api/state', async (_req, res, next) => {
  try {
    const rows = await AppState.find({}, { _id: 0, key: 1, value: 1 }).lean();
    res.json(Object.fromEntries(rows.map(({ key, value }) => [key, value])));
  } catch (error) { next(error); }
});

app.put('/api/state/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    if (!stateKeys.has(key)) return res.status(400).json({ error: 'Unsupported data collection.' });
    if (!Object.prototype.hasOwnProperty.call(req.body, 'value')) {
      return res.status(400).json({ error: 'A value is required.' });
    }
    await queueStateSave(key, req.body.value);
    res.status(204).end();
  } catch (error) { next(error); }
});

app.delete('/api/state/:key', async (req, res, next) => {
  try {
    const { key } = req.params;
    if (!stateKeys.has(key)) return res.status(400).json({ error: 'Unsupported data collection.' });
    await AppState.deleteOne({ key });
    const Model = collectionModels[key];
    if (Model) await Model.deleteMany({});
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/api/health', (_req, res) => res.json({ status: 'ok', database: mongoose.connection.name }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 500).json({ error: error.message || 'The server could not complete that request.' });
});

mongoose.connect(mongoUri)
  .then(() => {
    app.listen(port, () => {
      console.log(`Bridge Bazar is running at http://localhost:${port}`);
      // Older saved data is migrated after the site is available. A migration
      // problem must never prevent customers from using the application.
      ensureAdminAccount()
        .then(() => ensureProductOwners())
        .then(() => AppState.find({}).lean())
        .then((savedState) => Promise.all(savedState.map(({ key, value }) => mirrorStateToCollection(key, value))))
        .catch((error) => console.error('Existing-data migration failed:', error.message));
    });
  })
  .catch((error) => {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  });
