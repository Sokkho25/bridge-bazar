require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');

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
  if (!Array.isArray(value) || value.length === 0) return;
  const documents = value.map((item) => (
    item && typeof item === 'object' && !Array.isArray(item) ? { ...item } : { value: item }
  ));
  // An earlier version of the project created a unique `orderId` index. The
  // frontend uses `id`, so preserve both names to keep that existing index valid.
  if (key === 'bridge_orders') {
    documents.forEach((order) => { order.orderId = order.orderId ?? order.id; });
  }
  await Model.insertMany(documents);
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
    await AppState.findOneAndUpdate(
      { key },
      { value: req.body.value, updatedAt: new Date() },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    await mirrorStateToCollection(key, req.body.value);
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
  res.status(500).json({ error: 'The server could not complete that request.' });
});

mongoose.connect(mongoUri)
  .then(() => {
    app.listen(port, () => {
      console.log(`Bridge Bazar is running at http://localhost:${port}`);
      // Older saved data is migrated after the site is available. A migration
      // problem must never prevent customers from using the application.
      ensureAdminAccount()
        .then(() => AppState.find({}).lean())
        .then((savedState) => Promise.all(savedState.map(({ key, value }) => mirrorStateToCollection(key, value))))
        .catch((error) => console.error('Existing-data migration failed:', error.message));
    });
  })
  .catch((error) => {
    console.error('MongoDB connection failed:', error.message);
    process.exit(1);
  });
