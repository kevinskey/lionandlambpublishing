require('dotenv').config();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { Pool } = require('pg');
const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Resend } = require('resend');
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const AUDIO_DIR = path.join(__dirname, 'audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait 15 minutes and try again.' },
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1',
});
const strictLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait before trying again.' },
  skip: (req) => req.ip === '127.0.0.1' || req.ip === '::1',
});
const resend = new Resend(process.env.RESEND_API_KEY);
// EasyPost shipping
const EasyPostClient = require('@easypost/api');
const easypost = process.env.EASYPOST_API_KEY ? new EasyPostClient(process.env.EASYPOST_API_KEY) : null;

function getFromAddress() {
  return {
    name: process.env.SHIP_FROM_NAME || 'Lion and Lamb Publishing',
    street1: process.env.SHIP_FROM_STREET1 || '',
    city: process.env.SHIP_FROM_CITY || '',
    state: process.env.SHIP_FROM_STATE || '',
    zip: process.env.SHIP_FROM_ZIP || '',
    country: 'US',
    phone: process.env.SHIP_FROM_PHONE || '',
  };
}

const app = express();
app.use(cors({ origin: 'https://lionandlambpublishing.com' }));

// Raw body needed for Stripe webhook signature verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

const pool = new Pool({
  user: 'forteadmin',
  host: 'localhost',
  database: 'fortemusic',
  password: process.env.DB_PASSWORD,
  port: 5432,
});

// Auto-migrate: add album/track columns
pool.query(`
  ALTER TABLE products ADD COLUMN IF NOT EXISTS album TEXT DEFAULT '';
  ALTER TABLE products ADD COLUMN IF NOT EXISTS track_number INTEGER DEFAULT 0;
`).catch(()=>{});

const s3 = new S3Client({
  endpoint: 'https://' + process.env.SPACES_REGION + '.digitaloceanspaces.com',
  region: process.env.SPACES_REGION,
  credentials: {
    accessKeyId: process.env.SPACES_KEY,
    secretAccessKey: process.env.SPACES_SECRET,
  },
});

const BUCKET = process.env.SPACES_BUCKET;
const SPACES_BASE = 'https://' + BUCKET + '.' + process.env.SPACES_REGION + '.digitaloceanspaces.com';

// Exchange a valid admin JWT for the admin key (used by admin.html auto-auth)
app.post('/admin/token', async (req, res) => {
  try {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No token' });
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (!payload.is_admin) return res.status(403).json({ error: 'Not an admin' });
    // Double-check against DB in case is_admin was revoked
    const row = await pool.query('SELECT is_admin FROM users WHERE id=$1', [payload.id]);
    if (!row.rows.length || !row.rows[0].is_admin) return res.status(403).json({ error: 'Not an admin' });
    res.json({ key: process.env.ADMIN_KEY });
  } catch(err) { res.status(401).json({ error: 'Invalid token' }); }
});

// List files in Spaces
app.get('/admin/files', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const prefix = req.query.prefix || '';
    const cmd = new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 200 });
    const result = await s3.send(cmd);
    const files = (result.Contents || []).map(f => ({
      key: f.Key,
      url: SPACES_BASE + '/' + f.Key,
      size: f.Size,
      lastModified: f.LastModified,
    }));
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get presigned upload URL
app.post('/admin/upload-url', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { filename, contentType, folder } = req.body;
    const key = (folder ? folder + '/' : '') + filename;
    const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
    res.json({ uploadUrl: url, publicUrl: SPACES_BASE + '/' + key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Server-side file upload — saves locally and serves as static file
const UPLOADS_DIR = path.join(__dirname, 'img', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = (req.body && req.body.folder) || 'uploads';
    const dir = folder === 'uploads' ? UPLOADS_DIR : path.join(__dirname, 'img', 'uploads');
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._\- ]/g, '_');
    cb(null, safeName);
  }
});
const uploader = multer({ storage: uploadStorage, limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/admin/upload-file', (req, res, next) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}, uploader.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const publicUrl = (process.env.DOMAIN || 'https://lionandlambpublishing.com') + '/img/uploads/' + encodeURIComponent(req.file.filename);
    res.json({ publicUrl, filename: req.file.filename });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Direct MP3 upload — writes to /var/www/html/audio/ and returns public URL
app.post('/admin/upload-mp3', express.raw({ type: '*/*', limit: '100mb' }), async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const originalName = req.headers['x-filename'] || ('upload-' + Date.now() + '.mp3');
    // Sanitise: keep alphanumeric, dots, dashes, spaces
    const safeName = originalName.replace(/[^a-zA-Z0-9._\- ]/g, '_');
    const filePath  = path.join(AUDIO_DIR, safeName);
    fs.writeFileSync(filePath, req.body);
    const publicUrl = process.env.DOMAIN + '/audio/' + encodeURIComponent(safeName);
    res.json({ publicUrl, filename: safeName });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get featured product
app.get('/products/featured', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE featured=TRUE ORDER BY created_at DESC LIMIT 1');
    if (result.rows.length === 0) {
      const fallback = await pool.query('SELECT * FROM products ORDER BY created_at DESC LIMIT 1');
      res.json(fallback.rows[0] || null);
    } else {
      res.json(result.rows[0]);
    }
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get all products
app.get('/products', async (req, res) => {
  try {
    const { ensemble, grade, search, format, theme, is_free } = req.query;
    let query = 'SELECT id, title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, audio_url, pdf_preview_url, image_url, video_url, featured, created_at, stripe_product_id, stripe_price_print, stripe_price_pdf, stripe_price_bundle, download_url, tags, variations, requires_shipping, weight_oz, description, sku, album, track_number, min_qty, stock_qty, is_free, seo_description FROM products WHERE 1=1';
    const params = [];
    if (ensemble) { params.push(ensemble); query += ' AND ensemble=$' + params.length; }
    if (grade) { params.push(grade); query += ' AND grade=$' + params.length; }
    if (search) { params.push('%' + search + '%'); query += ' AND (title ILIKE $' + params.length + ' OR composer ILIKE $' + params.length + ')'; }
    if (format && format !== 'Free') { params.push(format); query += ' AND format=$' + params.length; }
    if (format === 'Free' || is_free === 'true') { query += ' AND is_free=TRUE'; }
    if (theme) { params.push('%' + theme + '%'); query += ' AND tags ILIKE $' + params.length; }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get single product
app.get('/products/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: add product
// Auto-create Stripe Price IDs for a product
async function syncStripeProduct(title, composer, price_print, price_pdf, price_bundle, existingIds) {
  const ids = existingIds || {};
  let stripeProductId = ids.stripe_product_id;
  if (!stripeProductId) {
    const sp = await stripe.products.create({
      name: title + (composer ? ' — ' + composer : ''),
      metadata: { source: 'lionandlambpublishing' }
    });
    stripeProductId = sp.id;
  }
  async function makePrice(amount, nickname, existing) {
    if (!amount || parseFloat(amount) <= 0) return existing || '';
    if (existing) {
      try {
        const p = await stripe.prices.retrieve(existing);
        if (p.unit_amount === Math.round(parseFloat(amount) * 100)) return existing;
      } catch(e) {}
    }
    const p = await stripe.prices.create({
      product: stripeProductId,
      unit_amount: Math.round(parseFloat(amount) * 100),
      currency: 'usd',
      nickname: nickname
    });
    return p.id;
  }
  const results = await Promise.all([
    makePrice(price_print, 'Print', ids.stripe_price_print),
    makePrice(price_pdf, 'PDF', ids.stripe_price_pdf),
    makePrice(price_bundle, 'Bundle', ids.stripe_price_bundle)
  ]);
  return { stripe_product_id: stripeProductId, stripe_price_print: results[0], stripe_price_pdf: results[1], stripe_price_bundle: results[2] };
}

async function syncVariationPrices(stripeProductId, variation, existingVariation = {}) {
  const ens = variation.ensemble || 'Variation';
  async function makeVarPrice(amount, nickname, existing) {
    if (!amount || parseFloat(amount) <= 0) return existing || '';
    if (existing) {
      try {
        const p = await stripe.prices.retrieve(existing);
        if (p.unit_amount === Math.round(parseFloat(amount) * 100)) return existing;
      } catch(e) {}
    }
    const p = await stripe.prices.create({
      product: stripeProductId,
      unit_amount: Math.round(parseFloat(amount) * 100),
      currency: 'usd',
      nickname: ens + ' - ' + nickname
    });
    return p.id;
  }
  const [spp, sppdf, spb] = await Promise.all([
    makeVarPrice(variation.price_print, 'Print', existingVariation.stripe_price_print),
    makeVarPrice(variation.price_pdf, 'PDF', existingVariation.stripe_price_pdf),
    makeVarPrice(variation.price_bundle, 'Bundle', existingVariation.stripe_price_bundle),
  ]);
  return { ...variation, stripe_price_print: spp, stripe_price_pdf: sppdf, stripe_price_bundle: spb };
}

app.post('/admin/products', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, audio_url, pdf_preview_url, image_url, video_url, download_url, featured, tags, variations, requires_shipping, weight_oz, description, sku, seo_description, stock_qty, is_free } = req.body;
    const stripeIds = await syncStripeProduct(title, composer, price_print, price_pdf, price_bundle, {});
    let processedVariations = [];
    if (variations && variations.length > 0) {
      processedVariations = await Promise.all(variations.map(v => syncVariationPrices(stripeIds.stripe_product_id, v, {})));
    }
    const result = await pool.query(
      'INSERT INTO products (title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, stripe_product_id, stripe_price_print, stripe_price_pdf, stripe_price_bundle, audio_url, pdf_preview_url, image_url, video_url, download_url, featured, tags, variations, album, track_number, min_qty, seo_description, stock_qty, is_free) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *',
      [title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, stripeIds.stripe_product_id, stripeIds.stripe_price_print, stripeIds.stripe_price_pdf, stripeIds.stripe_price_bundle, audio_url, pdf_preview_url, image_url, video_url, download_url||null, featured||false, tags||'', JSON.stringify(processedVariations), req.body.album||'', parseInt(req.body.track_number)||0, parseInt(req.body.min_qty)||1, seo_description||null, stock_qty!=null?parseInt(stock_qty):null, is_free||false]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: update product
app.put('/admin/products/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, audio_url, pdf_preview_url, image_url, video_url, download_url, featured, tags, variations, seo_description, stock_qty, is_free } = req.body;
    const existing = await pool.query('SELECT stripe_product_id, stripe_price_print, stripe_price_pdf, stripe_price_bundle, variations FROM products WHERE id=$1', [req.params.id]);
    const existingIds = existing.rows[0] || {};
    const stripeIds = await syncStripeProduct(title, composer, price_print, price_pdf, price_bundle, existingIds);
    let processedVariations = [];
    if (variations && variations.length > 0) {
      const existingVars = existingIds.variations || [];
      processedVariations = await Promise.all(variations.map(v => {
        const existingV = existingVars.find(ev => ev.ensemble === v.ensemble) || {};
        return syncVariationPrices(stripeIds.stripe_product_id, v, existingV);
      }));
    }
    const result = await pool.query(
      'UPDATE products SET title=$1, composer=$2, ensemble=$3, grade=$4, format=$5, price_print=$6, price_pdf=$7, price_bundle=$8, stripe_product_id=$9, stripe_price_print=$10, stripe_price_pdf=$11, stripe_price_bundle=$12, audio_url=$13, pdf_preview_url=$14, image_url=$15, video_url=$16, download_url=$17, featured=$18, tags=$19, variations=$20, album=$21, track_number=$22, min_qty=$23, seo_description=$24, stock_qty=$25, is_free=$26 WHERE id=$27 RETURNING *',
      [title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, stripeIds.stripe_product_id, stripeIds.stripe_price_print, stripeIds.stripe_price_pdf, stripeIds.stripe_price_bundle, audio_url, pdf_preview_url, image_url, video_url, download_url||null, featured||false, tags||'', JSON.stringify(processedVariations), req.body.album||'', parseInt(req.body.track_number)||0, parseInt(req.body.min_qty)||1, seo_description||null, stock_qty!=null?parseInt(stock_qty):null, is_free||false, req.params.id]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: delete product
app.delete('/admin/products/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM products WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// List coupons + promo codes
app.get('/admin/coupons', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [coupons, promos] = await Promise.all([
      stripe.coupons.list({ limit: 50 }),
      stripe.promotionCodes.list({ limit: 50 })
    ]);
    const couponMap = {};
    coupons.data.forEach(c => { couponMap[c.id] = c; });
    const result = promos.data.map(p => ({
      promo_id: p.id,
      code: p.code,
      active: p.active,
      times_redeemed: p.times_redeemed,
      max_redemptions: p.max_redemptions,
      coupon_id: p.coupon.id,
      discount: p.coupon.percent_off ? p.coupon.percent_off + '%' : '$' + (p.coupon.amount_off / 100).toFixed(2),
      duration: p.coupon.duration,
      expires_at: p.expires_at
    }));
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Create coupon + promo code
app.post('/admin/coupons', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { code, percent_off, amount_off, max_redemptions, expires_at } = req.body;
    if (!code) return res.status(400).json({ error: 'Code is required' });
    if (!percent_off && !amount_off) return res.status(400).json({ error: 'Provide percent_off or amount_off' });
    const couponData = { duration: 'once' };
    if (percent_off) couponData.percent_off = parseFloat(percent_off);
    else couponData.amount_off = Math.round(parseFloat(amount_off) * 100), couponData.currency = 'usd';
    const coupon = await stripe.coupons.create(couponData);
    const promoData = { coupon: coupon.id, code: code.toUpperCase() };
    if (max_redemptions) promoData.max_redemptions = parseInt(max_redemptions);
    if (expires_at) promoData.expires_at = Math.floor(new Date(expires_at).getTime() / 1000);
    const promo = await stripe.promotionCodes.create(promoData);
    res.json({ promo_id: promo.id, code: promo.code, discount: percent_off ? percent_off + '%' : '$' + amount_off, active: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deactivate promo code
app.delete('/admin/coupons/:promo_id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await stripe.promotionCodes.update(req.params.promo_id, { active: false });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ---- SCHOOL ACCOUNTS ----

// School applies for an account
app.post('/school-apply', async (req, res) => {
  try {
    const { school_name, director_name, email, phone, address, city, state, zip, district, po_contact_name, po_contact_email } = req.body;
    if (!school_name || !director_name || !email) return res.status(400).json({ error: 'School name, director name, and email are required.' });

    // Check if already applied
    const existing = await pool.query('SELECT id, status FROM school_accounts WHERE email=$1', [email]);
    if (existing.rows.length > 0) {
      const s = existing.rows[0].status;
      if (s === 'approved') return res.status(400).json({ error: 'This email is already approved. Check your inbox for your account code.' });
      if (s === 'pending') return res.status(400).json({ error: 'An application for this email is already under review.' });
    }

    const result = await pool.query(
      'INSERT INTO school_accounts (school_name, director_name, email, phone, address, city, state, zip, district, po_contact_name, po_contact_email) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [school_name, director_name, email, phone||'', address||'', city||'', state||'', zip||'', district||'', po_contact_name||'', po_contact_email||'']
    );

    // Notify admin
    try {
      const mailer = getMailer();
      await mailer.emails.send({
        from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
        to: process.env.SMTP_USER || process.env.EMAIL_FROM || 'orders@lionandlambpublishing.com',
        subject: 'New School Account Application — ' + school_name,
        html: '<h2>New School Application</h2><p><strong>School:</strong> ' + school_name + '</p><p><strong>Director:</strong> ' + director_name + '</p><p><strong>Email:</strong> ' + email + '</p><p><strong>District:</strong> ' + (district||'N/A') + '</p><p><a href="https://lionandlambpublishing.com/admin.html">Review in Admin Panel</a></p>'
      });
    } catch(e) { console.error('Admin notify error:', e.message); }

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List school accounts (admin)
app.get('/admin/schools', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await pool.query('SELECT * FROM school_accounts ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Approve school
app.post('/admin/schools/:id/approve', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const code = 'LAL-' + Math.random().toString(36).substring(2,6).toUpperCase() + '-' + Math.random().toString(36).substring(2,6).toUpperCase();
    const result = await pool.query(
      'UPDATE school_accounts SET status=$1, account_code=$2, approved_at=NOW() WHERE id=$3 RETURNING *',
      ['approved', code, req.params.id]
    );
    const school = result.rows[0];

    // Email the school their approval + account code
    try {
      const mailer = getMailer();
      await mailer.emails.send({
        from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
        to: school.email,
        subject: 'Your School Account is Approved — Lion and Lamb Publishing',
        html: '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f3ec;font-family:Arial,sans-serif">'
          + '<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">'
          + '<div style="background:#7b1f2e;padding:28px 36px"><div style="color:#fff;font-family:Georgia,serif;font-size:1.3rem;font-weight:900">&#119070; Lion and Lamb Publishing</div></div>'
          + '<div style="padding:32px 36px">'
          + '<h2 style="font-family:Georgia,serif;font-size:1.4rem;margin-bottom:8px">Your account is approved!</h2>'
          + '<p style="color:#6b6257;font-size:0.9rem;margin-bottom:24px">Welcome, ' + school.director_name + '. ' + school.school_name + ' is now approved for school invoicing with Net 30 payment terms.</p>'
          + '<div style="background:#f7f3ec;border:1px solid #d6cfc2;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px">'
          + '<div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.1em;color:#6b6257;margin-bottom:6px">Your Account Code</div>'
          + '<div style="font-family:monospace;font-size:1.6rem;font-weight:700;color:#0f0d0a;letter-spacing:0.05em">' + code + '</div>'
          + '<div style="font-size:0.78rem;color:#6b6257;margin-top:6px">Keep this code — you will need it to submit purchase orders.</div>'
          + '</div>'
          + '<p style="font-size:0.88rem;color:#6b6257;margin-bottom:20px"><strong>Payment terms:</strong> Net 30. You may pay by check or online via the invoice link.<br><strong>Checks payable to:</strong> Lion and Lamb Publishing</p>'
          + '<a href="https://lionandlambpublishing.com/for-directors.html" style="display:inline-block;background:#7b1f2e;color:#fff;padding:12px 26px;border-radius:6px;text-decoration:none;font-weight:700;font-size:0.9rem">Submit Your First Order &#8594;</a>'
          + '</div></div></body></html>'
      });
    } catch(e) { console.error('Approval email error:', e.message); }

    res.json({ success: true, code, school });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deny school
app.post('/admin/schools/:id/deny', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { reason } = req.body;
    const result = await pool.query('UPDATE school_accounts SET status=$1, notes=$2 WHERE id=$3 RETURNING *', ['denied', reason||'', req.params.id]);
    const school = result.rows[0];
    try {
      const mailer = getMailer();
      await mailer.emails.send({
        from: process.env.EMAIL_FROM,
        to: school.email,
        subject: 'Lion and Lamb Publishing — Account Application Update',
        html: '<p>Dear ' + school.director_name + ',</p><p>Thank you for applying. Unfortunately we are unable to approve a school invoicing account at this time.' + (reason ? ' ' + reason : '') + '</p><p>You are still welcome to place orders using a credit card at <a href="https://lionandlambpublishing.com">lionandlambpublishing.com</a>.</p><p>Lion and Lamb Publishing</p>'
      });
    } catch(e) {}
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Verify account code for PO submission
app.post('/school-verify', async (req, res) => {
  try {
    const { code, email } = req.body;
    const result = await pool.query('SELECT * FROM school_accounts WHERE account_code=$1 AND email=$2 AND status=$3', [code, email, 'approved']);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid account code or email. Please check and try again.' });
    res.json({ verified: true, school: result.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- INVOICING ----

// List invoices
app.get('/admin/invoices', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const invoices = await stripe.invoices.list({ limit: 50 });
    res.json(invoices.data.map(inv => ({
      id: inv.id,
      number: inv.number,
      customer_name: inv.customer_name,
      customer_email: inv.customer_email,
      status: inv.status,
      amount_due: inv.amount_due,
      amount_paid: inv.amount_paid,
      due_date: inv.due_date,
      created: inv.created,
      hosted_invoice_url: inv.hosted_invoice_url,
      invoice_pdf: inv.invoice_pdf
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Newsletter Subscribe ────────────────────────────────────────────────────

app.post('/subscribe', async (req, res) => {
  const { email, name, source } = req.body;
  const subSource = source || 'website';
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
    return res.status(400).json({ error: 'Valid email required' });
  }
  try {
    // Upsert — re-subscribes if they previously unsubscribed
    const result = await pool.query(
      `INSERT INTO subscribers (email, name, source, active, unsubscribed_at)
       VALUES ($1, $2, $3, TRUE, NULL)
       ON CONFLICT (email) DO UPDATE
         SET active = TRUE, unsubscribed_at = NULL, name = COALESCE($2, subscribers.name),
             source = CASE WHEN subscribers.source IS NULL THEN $3 ELSE subscribers.source END
       RETURNING id, active, (xmax = 0) AS is_new`,
      [email.toLowerCase().trim(), name || null, subSource]
    );
    const isNew = result.rows[0].is_new;

    // Send welcome email via Resend (skip for post-purchase opt-ins)
    if (subSource !== 'post_purchase') { try {
      const tplResult = await pool.query("SELECT subject, html FROM email_templates WHERE type='welcome' ORDER BY updated_at DESC LIMIT 1");
      let subject, html;
      if (tplResult.rows.length) {
        subject = tplResult.rows[0].subject;
        html = tplResult.rows[0].html
          .replace(/{{email}}/g, email)
          .replace(/{{name}}/g, name || 'Friend')
          .replace(/{{unsubscribe_url}}/g, 'https://lionandlambpublishing.com/unsubscribe.html?email=' + encodeURIComponent(email));
      } else {
        subject = isNew ? 'Welcome to the LLP Newsletter!' : 'You\'re back on the list!';
        html = buildWelcomeEmailHtml(email, isNew);
      }
      await resend.emails.send({
        from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
        to: email,
        subject,
        html,
      });
    } catch (emailErr) {
      console.error('Welcome email failed:', emailErr.message);
    } } // end post_purchase guard

    res.json({ ok: true, isNew });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/unsubscribe', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  await pool.query(
    'UPDATE subscribers SET active = FALSE, unsubscribed_at = NOW() WHERE email = $1',
    [email.toLowerCase().trim()]
  );
  res.json({ ok: true });
});

// Admin: list subscribers
app.get('/admin/subscribers', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT id, email, name, source, subscribed_at, active FROM subscribers ORDER BY subscribed_at DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: add subscriber manually
app.post('/admin/subscribers', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { email, name } = req.body;
  if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).json({ error: 'Valid email required' });
  try {
    await pool.query(
      `INSERT INTO subscribers (email, name, source, active) VALUES ($1,$2,'admin',TRUE)
       ON CONFLICT (email) DO UPDATE SET active=TRUE, unsubscribed_at=NULL, name=COALESCE($2, subscribers.name)`,
      [email.toLowerCase().trim(), name||null]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: remove subscriber
app.delete('/admin/subscribers/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM subscribers WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: bulk import subscribers from CSV
app.post('/admin/subscribers/bulk', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { subscribers } = req.body;
  if (!Array.isArray(subscribers) || !subscribers.length) return res.status(400).json({ error: 'No subscribers provided' });
  let added = 0, skipped = 0, errors = [];
  for (const s of subscribers) {
    const email = (s.email||'').toLowerCase().trim();
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) { skipped++; continue; }
    try {
      await pool.query(
        `INSERT INTO subscribers (email, name, source, active) VALUES ($1,$2,'csv_import',TRUE)
         ON CONFLICT (email) DO UPDATE SET active=TRUE, unsubscribed_at=NULL, name=COALESCE($2, subscribers.name)`,
        [email, s.name||null]
      );
      added++;
    } catch(e) { errors.push(email); skipped++; }
  }
  res.json({ added, skipped, errors });
});

// Admin: send broadcast newsletter
app.post('/admin/newsletter/send', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { subject, html } = req.body;
  if (!subject || !html) return res.status(400).json({ error: 'subject and html required' });
  try {
    const r = await pool.query('SELECT email FROM subscribers WHERE active = TRUE');
    const emails = r.rows.map(row => row.email);
    let sent = 0, failed = 0;
    // Send in batches of 50 (Resend batch limit)
    for (let i = 0; i < emails.length; i += 50) {
      const batch = emails.slice(i, i + 50);
      try {
        await Promise.all(batch.map(to => resend.emails.send({
          from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
          to,
          subject,
          html,
        })));
        sent += batch.length;
      } catch (e) { failed += batch.length; }
    }
    res.json({ sent, failed, total: emails.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function buildWelcomeEmailHtml(email, isNew) {
  const headline = isNew ? 'Welcome to the LLP community!' : 'Good to have you back!';
  const body = isNew
    ? `You're now subscribed to the Lion and Lamb Publishing newsletter. Expect new arrivals, director resources, seasonal programming ideas, and exclusive discounts — delivered monthly.`
    : `You've been re-added to our mailing list. We're glad you're back!`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f9f6;font-family:'Helvetica Neue',Arial,sans-serif">
  <div style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(15,13,10,0.08)">
    <div style="background:#0f0d0a;padding:32px 40px;text-align:center">
      <div style="font-family:Georgia,serif;font-size:1.5rem;font-weight:900;color:#fff;letter-spacing:-0.02em">Lion and Lamb Publishing</div>
      <div style="font-size:0.75rem;color:rgba(255,255,255,0.4);letter-spacing:0.1em;text-transform:uppercase;margin-top:4px">Newsletter</div>
    </div>
    <div style="padding:40px">
      <h1 style="font-family:Georgia,serif;font-size:1.4rem;font-weight:800;color:#0f0d0a;margin:0 0 16px">${headline}</h1>
      <p style="color:#5a6672;font-size:0.9rem;line-height:1.7;margin:0 0 24px">${body}</p>
      <a href="https://lionandlambpublishing.com" style="display:inline-block;background:#3ab54a;color:#fff;padding:12px 28px;border-radius:8px;font-size:0.875rem;font-weight:700;text-decoration:none">Browse the Catalog &rarr;</a>
    </div>
    <div style="background:#f5f9f6;padding:20px 40px;border-top:1px solid #c4d9c9;text-align:center">
      <p style="font-size:0.75rem;color:#5a6672;margin:0">You received this because you subscribed at lionandlambpublishing.com.<br>
      <a href="https://lionandlambpublishing.com/unsubscribe.html?email=${encodeURIComponent(email)}" style="color:#3ab54a">Unsubscribe</a></p>
    </div>
  </div>
</body></html>`;
}


// ─── Email Templates ─────────────────────────────────────────────────────────

app.get('/admin/email-templates', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT id, name, type, subject, created_at, updated_at FROM email_templates ORDER BY type, name');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/email-templates/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT * FROM email_templates WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/email-templates', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { name, type, subject, html } = req.body;
  if (!name || !subject || !html) return res.status(400).json({ error: 'name, subject, and html required' });
  try {
    const r = await pool.query(
      'INSERT INTO email_templates (name, type, subject, html) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, type || 'campaign', subject, html]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/admin/email-templates/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { name, type, subject, html } = req.body;
  try {
    const r = await pool.query(
      'UPDATE email_templates SET name=$1, type=$2, subject=$3, html=$4, updated_at=NOW() WHERE id=$5 RETURNING *',
      [name, type || 'campaign', subject, html, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/email-templates/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM email_templates WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Campaigns ───────────────────────────────────────────────────────────────

app.get('/admin/campaigns', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query(`SELECT c.*, t.name AS template_name FROM email_campaigns c
      LEFT JOIN email_templates t ON c.template_id = t.id ORDER BY c.created_at DESC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/campaigns', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { name, template_id, subject, html } = req.body;
  if (!name || !subject || !html) return res.status(400).json({ error: 'name, subject, and html required' });
  try {
    const r = await pool.query(
      'INSERT INTO email_campaigns (name, template_id, subject, html) VALUES ($1,$2,$3,$4) RETURNING *',
      [name, template_id || null, subject, html]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/admin/campaigns/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { name, subject, html, template_id, segment } = req.body;
  try {
    const r = await pool.query(
      'UPDATE email_campaigns SET name=$1, subject=$2, html=$3, template_id=$4, segment=$5 WHERE id=$6 AND status=\'draft\' RETURNING *',
      [name, subject, html, template_id || null, segment || 'all', req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found or already sent' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/campaigns/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query("DELETE FROM email_campaigns WHERE id=$1 AND status='draft'", [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/campaigns/:id/send', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const camp = await pool.query("SELECT * FROM email_campaigns WHERE id=$1 AND status='draft'", [req.params.id]);
    if (!camp.rows.length) return res.status(404).json({ error: 'Campaign not found or already sent' });
    const c = camp.rows[0];

    // Segment filtering
    const segment = c.segment || req.body.segment || 'all';
    let subQuery = 'SELECT email, name FROM subscribers WHERE active=TRUE';
    let subParams = [];
    if (segment === 'buyers') {
      subQuery += ' AND order_count > 0';
    } else if (segment === 'non-buyers') {
      subQuery += ' AND order_count = 0';
    } else if (segment === 'school') {
      subQuery += ` AND email IN (SELECT email FROM school_accounts WHERE status='approved')`;
    } else if (segment.startsWith('tag:')) {
      const tag = segment.slice(4);
      subQuery += ' AND $1 = ANY(tags)';
      subParams = [tag];
    }
    const subs = await pool.query(subQuery, subParams);
    const recipients = subs.rows;
    if (!recipients.length) return res.status(400).json({ error: 'No active subscribers' });

    // Mark as sending
    await pool.query("UPDATE email_campaigns SET status='sending', recipient_count=$1 WHERE id=$2",
      [recipients.length, c.id]);

    // Send in batches of 50
    let sent = 0, failed = 0;
    const FROM = process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>';
    for (let i = 0; i < recipients.length; i += 50) {
      const batch = recipients.slice(i, i + 50);
      const results = await Promise.allSettled(batch.map(sub => {
        const html = c.html
          .replace(/{{email}}/g, sub.email)
          .replace(/{{name}}/g, sub.name || 'Friend')
          .replace(/{{unsubscribe_url}}/g, 'https://lionandlambpublishing.com/unsubscribe.html?email=' + encodeURIComponent(sub.email));
        return resend.emails.send({ from: FROM, to: sub.email, subject: c.subject, html });
      }));
      results.forEach(r => r.status === 'fulfilled' ? sent++ : failed++);
    }

    await pool.query(
      "UPDATE email_campaigns SET status='sent', sent_count=$1, failed_count=$2, sent_at=NOW() WHERE id=$3",
      [sent, failed, c.id]
    );
    res.json({ ok: true, sent, failed, total: recipients.length });
  } catch (err) {
    await pool.query("UPDATE email_campaigns SET status='draft' WHERE id=$1", [req.params.id]);
    res.status(500).json({ error: err.message });
  }
});

// Preview: replace template vars with sample data
app.post('/admin/campaigns/preview', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { html, subject } = req.body;
  const preview = (html || '')
    .replace(/{{email}}/g, 'director@school.edu')
    .replace(/{{name}}/g, 'Director Smith')
    .replace(/{{unsubscribe_url}}/g, '#');
  res.json({ html: preview, subject });
});

// ─── Email Stats ─────────────────────────────────────────────────────────────

app.get('/admin/email-stats', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [subStats, campStats, recentEmails] = await Promise.all([
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE active=TRUE) AS active,
        COUNT(*) FILTER (WHERE active=FALSE) AS unsubscribed,
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE subscribed_at > NOW()-INTERVAL '30 days') AS new_last_30
        FROM subscribers`),
      pool.query(`SELECT
        COUNT(*) FILTER (WHERE status='sent') AS sent_campaigns,
        COALESCE(SUM(sent_count) FILTER (WHERE status='sent'), 0) AS total_sent,
        COALESCE(SUM(failed_count) FILTER (WHERE status='sent'), 0) AS total_failed
        FROM email_campaigns`),
      resend.emails.list().catch(() => ({ data: { data: [] } }))
    ]);

    // Aggregate Resend event stats
    const emails = recentEmails?.data?.data || [];
    const eventCounts = emails.reduce((acc, e) => {
      acc[e.last_event] = (acc[e.last_event] || 0) + 1;
      return acc;
    }, {});

    res.json({
      subscribers: subStats.rows[0],
      campaigns: campStats.rows[0],
      resend: {
        recent_count: emails.length,
        events: eventCounts,
        recent: emails.slice(0, 20).map(e => ({
          to: e.to?.[0],
          subject: e.subject,
          event: e.last_event,
          sent_at: e.created_at
        }))
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ─── Unified Customer Intelligence ───────────────────────────────────────────

app.get('/admin/customers', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query(`
      SELECT
        ae.email,
        COALESCE(u.name, s.name, o_agg.customer_name) AS name,
        u.id AS user_id,
        u.created_at AS account_created,
        u.oauth_provider,
        s.id AS subscriber_id,
        s.active AS subscribed,
        s.subscribed_at,
        s.source AS sub_source,
        s.tags,
        s.notes,
        COALESCE(s.total_spent, o_agg.total_spent_raw, 0) AS total_spent,
        COALESCE(s.order_count, o_agg.order_count, 0) AS order_count,
        COALESCE(s.last_purchase_at, o_agg.last_order_at) AS last_purchase_at,
        o_agg.last_order_at,
        sa.id AS school_account_id,
        sa.school_name,
        sa.status AS school_status
      FROM (
        SELECT DISTINCT email FROM (
          SELECT email FROM users
          UNION SELECT email FROM subscribers
          UNION SELECT customer_email AS email FROM orders WHERE customer_email IS NOT NULL
          UNION SELECT email FROM school_accounts
        ) e WHERE email IS NOT NULL
      ) ae
      LEFT JOIN users u ON LOWER(u.email) = ae.email
      LEFT JOIN subscribers s ON LOWER(s.email) = ae.email
      LEFT JOIN (
        SELECT
          LOWER(customer_email) AS email,
          COUNT(*) AS order_count,
          SUM(amount_total) AS total_spent_raw,
          MAX(created_at) AS last_order_at,
          MIN(customer_name) AS customer_name
        FROM orders GROUP BY LOWER(customer_email)
      ) o_agg ON o_agg.email = ae.email
      LEFT JOIN school_accounts sa ON LOWER(sa.email) = ae.email
      ORDER BY total_spent DESC NULLS LAST, last_purchase_at DESC NULLS LAST
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/customers/:email', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const email = decodeURIComponent(req.params.email).toLowerCase();
  try {
    const [userRow, subRow, ordersRow, schoolRow] = await Promise.all([
      pool.query('SELECT * FROM users WHERE LOWER(email)=$1', [email]),
      pool.query('SELECT * FROM subscribers WHERE LOWER(email)=$1', [email]),
      pool.query('SELECT id, stripe_session_id, customer_name, amount_total, currency, items, created_at, status, tracking_number, shipping_address FROM orders WHERE LOWER(customer_email)=$1 ORDER BY created_at DESC', [email]),
      pool.query('SELECT * FROM school_accounts WHERE LOWER(email)=$1', [email]),
    ]);
    res.json({
      email,
      user: userRow.rows[0] || null,
      subscriber: subRow.rows[0] || null,
      orders: ordersRow.rows,
      school_account: schoolRow.rows[0] || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update subscriber tags/notes from admin
app.patch('/admin/customers/:email', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const email = decodeURIComponent(req.params.email).toLowerCase();
  const { tags, notes, active } = req.body;
  try {
    const updates = [];
    const vals = [email];
    if (tags !== undefined) { vals.push(tags); updates.push(`tags=$${vals.length}`); }
    if (notes !== undefined) { vals.push(notes); updates.push(`notes=$${vals.length}`); }
    if (active !== undefined) { vals.push(active); updates.push(`active=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    await pool.query(`UPDATE subscribers SET ${updates.join(',')} WHERE LOWER(email)=$1`, vals);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin analytics summary
app.get('/admin/analytics', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const [revenue, topProducts, topCustomers, subGrowth, tagCounts] = await Promise.all([
      // Revenue by month (last 6 months)
      pool.query(`
        SELECT DATE_TRUNC('month', created_at) AS month,
               COUNT(*) AS orders,
               SUM(amount_total) AS revenue_cents
        FROM orders
        WHERE created_at > NOW() - INTERVAL '6 months'
        GROUP BY 1 ORDER BY 1
      `),
      // Top purchased products
      pool.query(`
        SELECT item->>'title' AS title, item->>'ensemble' AS ensemble,
               COUNT(*) AS purchase_count
        FROM orders, jsonb_array_elements(items) AS item
        GROUP BY 1,2 ORDER BY 3 DESC LIMIT 10
      `),
      // Top customers by spend
      pool.query(`
        SELECT customer_email, customer_name,
               COUNT(*) AS orders,
               SUM(amount_total) AS total_cents
        FROM orders GROUP BY 1,2 ORDER BY 4 DESC LIMIT 10
      `),
      // Subscriber growth by month
      pool.query(`
        SELECT DATE_TRUNC('month', subscribed_at) AS month, COUNT(*) AS new_subscribers
        FROM subscribers
        WHERE subscribed_at > NOW() - INTERVAL '6 months'
        GROUP BY 1 ORDER BY 1
      `),
      // Tag distribution
      pool.query(`
        SELECT unnest(tags) AS tag, COUNT(*) AS count
        FROM subscribers WHERE tags IS NOT NULL AND array_length(tags,1) > 0
        GROUP BY 1 ORDER BY 2 DESC
      `),
    ]);
    res.json({
      revenue: revenue.rows,
      top_products: topProducts.rows,
      top_customers: topCustomers.rows,
      subscriber_growth: subGrowth.rows,
      tag_distribution: tagCounts.rows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// Create + send invoice
app.post('/admin/invoices', async (req, res) => {
  const isAdmin = req.headers['x-admin-key'] === process.env.ADMIN_KEY;
  const accountCode = req.headers['x-account-code'];
  const accountEmail = req.headers['x-account-email'];
  let isSchoolOrder = false;
  if (!isAdmin && accountCode && accountEmail) {
    const schoolCheck = await pool.query('SELECT id FROM school_accounts WHERE account_code=$1 AND email=$2 AND status=$3', [accountCode, accountEmail, 'approved']);
    isSchoolOrder = schoolCheck.rows.length > 0;
    if (!isSchoolOrder) return res.status(401).json({ error: 'Your account code is invalid or not yet approved.' });
  } else if (!isAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const { customer_name, customer_email, school_name, items, days_until_due, notes } = req.body;
    if (!customer_email || !items || !items.length) return res.status(400).json({ error: 'Email and at least one item required' });

    // Find or create Stripe customer
    const existing = await stripe.customers.list({ email: customer_email, limit: 1 });
    let customer;
    if (existing.data.length > 0) {
      customer = existing.data[0];
      if (customer_name || school_name) {
        customer = await stripe.customers.update(customer.id, {
          name: customer_name || customer.name,
          metadata: { school: school_name || '' }
        });
      }
    } else {
      customer = await stripe.customers.create({
        email: customer_email,
        name: customer_name || '',
        metadata: { school: school_name || '' }
      });
    }

    // Create invoice
    const invoiceData = {
      customer: customer.id,
      collection_method: 'send_invoice',
      days_until_due: parseInt(days_until_due) || 30,
      auto_advance: false
    };
    const checkInstructions = 'Payment by check accepted. Make checks payable to: Lion and Lamb Publishing. Net ' + (days_until_due || 30) + ' payment terms.';
    invoiceData.footer = [notes, checkInstructions].filter(Boolean).join(' | ');
    if (school_name) invoiceData.custom_fields = [{ name: 'School', value: school_name }];
    const invoice = await stripe.invoices.create(invoiceData);

    // Add line items
    for (const item of items) {
      const liData = {
        customer: customer.id,
        invoice: invoice.id,
        quantity: parseInt(item.quantity) || 1
      };
      if (item.price_id) {
        liData.price = item.price_id;
      } else {
        liData.price_data = {
          currency: 'usd',
          product_data: { name: item.description || 'Sheet Music' },
          unit_amount: Math.round(parseFloat(item.unit_amount) * 100)
        };
      }
      await stripe.invoiceItems.create(liData);
    }

    // Finalize and send invoice
    const finalized = await stripe.invoices.finalizeInvoice(invoice.id);
    const sent = await stripe.invoices.sendInvoice(finalized.id);

    // For school PO orders — send PDF download links immediately (don't wait for payment)
    if (isSchoolOrder) {
      try {
        // Find PDF products in the order — match by price_id first, fall back to title matching
        const priceIds = items.map(i => i.price_id).filter(Boolean);
        let matchedProducts = [];
        if (priceIds.length > 0) {
          const r = await pool.query(
            'SELECT * FROM products WHERE stripe_price_pdf = ANY($1) OR stripe_price_bundle = ANY($1)',
            [priceIds]
          );
          matchedProducts = r.rows.filter(p => p.download_url || p.audio_url);
        }
        if (matchedProducts.length === 0) {
          // fallback: match by description contains title
          const descriptions = items.map(i => (i.description || '').toLowerCase());
          const allProducts = await pool.query('SELECT * FROM products');
          matchedProducts = allProducts.rows.filter(p =>
            (p.download_url || p.audio_url) &&
            descriptions.some(d => d.includes(p.title.toLowerCase()))
          );
        }

        if (matchedProducts.length > 0) {
          const emailItems = await Promise.all(matchedProducts.map(async p => {
            let downloadUrl = null;
            try {
              let key = p.download_url || p.audio_url;
              if (key.startsWith('http')) key = new URL(key).pathname.replace(/^\//, '');
              downloadUrl = await getSignedDownloadUrl(key);
            } catch(e) { console.error('Sign URL error:', e.message); }
            return { id: p.id, title: p.title, composer: p.composer, ensemble: p.ensemble, format: p.format, downloadUrl, requires_shipping: p.requires_shipping, weight_oz: p.weight_oz };
          }));

          const html = buildEmailHtml(customer_name, emailItems);
          const mailer = getMailer();
          await mailer.emails.send({
            from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
            to: customer_email,
            subject: 'Your Lion and Lamb Publishing Order — Download Links Inside',
            html
          });
          console.log('School order PDF links sent immediately to', customer_email);
        } else {
          // No matched PDF products — send a confirmation email with invoice link
          const mailer = getMailer();
          const invoiceUrl = sent.hosted_invoice_url || '';
          await mailer.emails.send({
            from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
            to: customer_email,
            subject: 'Your Lion and Lamb Publishing Purchase Order — Confirmed',
            html: buildOrderConfirmHtml(customer_name, school_name, items, invoiceUrl, sent.number)
          });
          console.log('School order confirmation sent to', customer_email);
        }
      } catch (emailErr) {
        console.error('School order email error:', emailErr.message);
      }
    }

    res.json({
      id: sent.id,
      number: sent.number,
      customer_name: sent.customer_name,
      customer_email: sent.customer_email,
      status: sent.status,
      amount_due: sent.amount_due,
      due_date: sent.due_date,
      hosted_invoice_url: sent.hosted_invoice_url,
      invoice_pdf: sent.invoice_pdf
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Void invoice
app.delete('/admin/invoices/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const inv = await stripe.invoices.retrieve(req.params.id);
    let result;
    if (inv.status === 'draft') result = await stripe.invoices.del(req.params.id);
    else result = await stripe.invoices.voidInvoice(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resend invoice
app.post('/admin/invoices/:id/resend', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await stripe.invoices.sendInvoice(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Reset admin key
app.post('/admin/reset-key', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { newKey } = req.body;
  if (!newKey || newKey.length < 16) return res.status(400).json({ error: 'Key must be at least 16 characters' });
  const envPath = path.join(__dirname, '.env');
  let env = fs.readFileSync(envPath, 'utf8');
  env = env.replace(/ADMIN_KEY=.*/, 'ADMIN_KEY=' + newKey);
  fs.writeFileSync(envPath, env);
  process.env.ADMIN_KEY = newKey;
  res.json({ success: true });
});

// Stripe checkout

// Shipping confirmation email
function buildShippingEmailHtml(customerName, items, trackingCode, trackingUrl, carrier, service) {
  const itemRows = items.map(i => '<tr><td style="padding:10px 0;border-bottom:1px solid #e8e0d0;font-size:0.9rem"><strong>' + i.title + '</strong>' + (i.composer ? '<br><span style="color:#6b6257;font-size:0.8rem">' + i.composer + '</span>' : '') + '</td></tr>').join('');
  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f3ec;font-family:Arial,sans-serif">'
    + '<div style="max-width:560px;margin:40px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">'
    + '<div style="background:#7b1f2e;padding:32px 40px"><div style="color:#fff;font-family:Georgia,serif;font-size:1.4rem;font-weight:900">&#119070; Lion and Lamb Publishing</div>'
    + '<div style="color:rgba(255,255,255,0.7);font-size:0.85rem;margin-top:4px">Your Order Has Shipped!</div></div>'
    + '<div style="padding:32px 40px">'
    + '<p style="font-size:1rem;color:#0f0d0a;margin-bottom:8px">Great news' + (customerName ? ', ' + customerName : '') + '!</p>'
    + '<p style="color:#6b6257;font-size:0.9rem;margin-bottom:24px">Your order is on its way via <strong>' + carrier + ' ' + service + '</strong>.</p>'
    + (trackingCode ? '<div style="background:#f7f3ec;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px">'
      + '<div style="font-size:0.75rem;color:#6b6257;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em">Tracking Number</div>'
      + '<div style="font-family:monospace;font-size:1.2rem;font-weight:700;color:#0f0d0a;letter-spacing:0.05em">' + trackingCode + '</div>'
      + (trackingUrl ? '<div style="margin-top:12px"><a href="' + trackingUrl + '" style="background:#7b1f2e;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:700;font-size:0.85rem">Track Your Package</a></div>' : '')
      + '</div>' : '')
    + '<table style="width:100%;border-collapse:collapse"><tbody>' + itemRows + '</tbody></table>'
    + '<p style="color:#6b6257;font-size:0.8rem;margin-top:28px">Questions? Reply to this email or visit <a href="https://lionandlambpublishing.com" style="color:#7b1f2e">lionandlambpublishing.com</a></p>'
    + '</div><div style="background:#f7f3ec;padding:16px 40px;text-align:center;color:#6b6257;font-size:0.75rem;border-top:1px solid #e8e0d0">&copy; 2026 Lion and Lamb Publishing</div></div>'
    + '</body></html>';
}

function getMailer() {
  return new Resend(process.env.RESEND_API_KEY);
}

// Generate a 48-hour signed download URL from Spaces
async function getSignedDownloadUrl(key) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const cmd = new GetObjectCommand({ Bucket: process.env.SPACES_BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: 172800 }); // 48 hours
}

function parseVariations(raw) {
  let vars = raw;
  if (typeof vars === 'string') { try { vars = JSON.parse(vars); } catch(e) { vars = []; } }
  return Array.isArray(vars) ? vars.filter(Boolean) : [];
}

// Sign a stored file reference (Spaces key or full URL); returns null on failure
async function signFileRef(fileRef) {
  if (!fileRef) return null;
  let key = fileRef;
  if (key.startsWith('http')) { try { key = new URL(key).pathname.replace(/^\//, ''); } catch(e){} }
  try { return await getSignedDownloadUrl(key); } catch(e) { console.error('Sign URL error:', e.message); return null; }
}

// One email/order line for a product purchase; variant (if given) overrides
// the ensemble label and delivery file for per-voicing PDFs
async function buildDeliveryItem(p, variant) {
  const fileRef = (variant && variant.download_url) || p.download_url || (p.format === 'PDF' ? p.audio_url : null);
  const downloadUrl = await signFileRef(fileRef);
  return {
    id: p.id, title: p.title, composer: p.composer,
    ensemble: (variant && variant.ensemble) || p.ensemble,
    format: p.format, downloadUrl, download_key: fileRef || null,
    requires_shipping: p.requires_shipping, weight_oz: p.weight_oz
  };
}

// Build HTML email for order confirmation + download links
function buildEmailHtml(customerName, items) {
  const rows = items.map(item => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e8e0d0">
        <strong style="font-family:Georgia,serif;font-size:1rem">${item.title}</strong><br>
        <span style="color:#6b6257;font-size:0.85rem">${item.composer || ''} ${item.ensemble ? '&middot; ' + item.ensemble : ''}</span>
      </td>
      <td style="padding:12px 0;border-bottom:1px solid #e8e0d0;text-align:right;white-space:nowrap">
        ${item.downloadUrl
          ? `<a href="${item.downloadUrl}" style="background:#7b1f2e;color:#fff;padding:8px 16px;border-radius:5px;text-decoration:none;font-size:0.85rem;font-weight:600">Download PDF</a>`
          : `<span style="color:#6b6257;font-size:0.85rem">Print copy</span>`}
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f7f3ec;font-family:'DM Sans',Arial,sans-serif">
<div style="max-width:560px;margin:40px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">
  <div style="background:#7b1f2e;padding:32px 40px">
    <div style="color:#fff;font-family:Georgia,serif;font-size:1.4rem;font-weight:900">&#119070; Lion and Lamb Publishing</div>
    <div style="color:rgba(255,255,255,0.7);font-size:0.85rem;margin-top:4px">Order Confirmation &amp; Download Links</div>
  </div>
  <div style="padding:32px 40px">
    <p style="font-size:1rem;color:#0f0d0a;margin-bottom:8px">Thank you${customerName ? ', ' + customerName : ''}!</p>
    <p style="color:#6b6257;font-size:0.9rem;margin-bottom:28px">Your order is confirmed. Download links below are valid for <strong>48 hours</strong>. Print as many copies as your ensemble needs.</p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    <p style="color:#6b6257;font-size:0.8rem;margin-top:28px">Need help? Reply to this email or visit <a href="https://lionandlambpublishing.com" style="color:#7b1f2e">lionandlambpublishing.com</a></p>
  </div>
  <div style="background:#f7f3ec;padding:20px 40px;text-align:center;color:#6b6257;font-size:0.78rem;border-top:1px solid #e8e0d0">
    &copy; 2026 Lion and Lamb Publishing. All rights reserved.
  </div>
</div>
</body>
</html>`;
}

// Confirmation email for school PO orders (no PDF products matched)
function buildOrderConfirmHtml(name, school, items, invoiceUrl, invoiceNum) {
  const rows = items.map(i =>
    '<tr><td style="padding:10px 0;border-bottom:1px solid #e8e0d0;font-size:0.88rem"><strong>' + (i.description||'Item') + '</strong></td>'
    + '<td style="padding:10px 0;border-bottom:1px solid #e8e0d0;text-align:center;font-size:0.88rem;color:#6b6257">x' + (i.quantity||1) + '</td>'
    + '<td style="padding:10px 0;border-bottom:1px solid #e8e0d0;text-align:right;font-size:0.88rem">$' + parseFloat(i.unit_amount||0).toFixed(2) + '</td></tr>'
  ).join('');
  return '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f3ec;font-family:Arial,sans-serif">'
    + '<div style="max-width:560px;margin:40px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">'
    + '<div style="background:#7b1f2e;padding:32px 40px"><div style="color:#fff;font-family:Georgia,serif;font-size:1.4rem;font-weight:900">&#119070; Lion and Lamb Publishing</div>'
    + '<div style="color:rgba(255,255,255,0.7);font-size:0.85rem;margin-top:4px">Purchase Order Confirmed</div></div>'
    + '<div style="padding:32px 40px">'
    + '<p style="font-size:1rem;color:#0f0d0a;margin-bottom:8px">Thank you' + (name ? ', ' + name : '') + '!</p>'
    + (school ? '<p style="color:#6b6257;font-size:0.88rem;margin-bottom:16px">' + school + '</p>' : '')
    + '<p style="color:#6b6257;font-size:0.9rem;margin-bottom:24px">Your purchase order has been received. An invoice' + (invoiceNum ? ' (' + invoiceNum + ')' : '') + ' has been sent to your email with payment instructions.</p>'
    + '<table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:left;font-size:0.75rem;color:#6b6257;padding-bottom:8px;border-bottom:2px solid #e8e0d0">Item</th><th style="text-align:center;font-size:0.75rem;color:#6b6257;padding-bottom:8px;border-bottom:2px solid #e8e0d0">Qty</th><th style="text-align:right;font-size:0.75rem;color:#6b6257;padding-bottom:8px;border-bottom:2px solid #e8e0d0">Price</th></tr></thead><tbody>' + rows + '</tbody></table>'
    + (invoiceUrl ? '<div style="text-align:center;margin-top:28px"><a href="' + invoiceUrl + '" style="background:#7b1f2e;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:700;font-size:0.9rem">View Invoice & Pay Online</a></div>' : '')
    + '<p style="color:#6b6257;font-size:0.78rem;margin-top:28px">Questions? Reply to this email or visit <a href="https://lionandlambpublishing.com" style="color:#7b1f2e">lionandlambpublishing.com</a></p>'
    + '</div><div style="background:#f7f3ec;padding:16px 40px;text-align:center;color:#6b6257;font-size:0.75rem;border-top:1px solid #e8e0d0">&copy; 2026 Lion and Lamb Publishing</div></div></body></html>';
}

// Stripe Checkout — pass product IDs as metadata
// GET shipping rates — takes to_address + product_ids, returns EasyPost rates
app.post('/shipping-rates', async (req, res) => {
  const { to_address, product_ids } = req.body || {};
  if (!easypost) return res.status(503).json({ error: 'Shipping not configured' });
  if (!to_address || !to_address.street1 || !to_address.zip) return res.status(400).json({ error: 'Address required' });
  try {
    // Get total weight from products
    let weightOz = 4;
    if (product_ids && product_ids.length) {
      const ph = product_ids.map((_, i) => '$' + (i + 1)).join(',');
      const res2 = await pool.query('SELECT COALESCE(weight_oz,4) as weight_oz FROM products WHERE id IN (' + ph + ')', product_ids.map(Number));
      weightOz = Math.max(res2.rows.reduce((s, r) => s + parseFloat(r.weight_oz || 4), 0), 1);
    }
    const shipment = await easypost.Shipment.create({
      from_address: getFromAddress(),
      to_address: {
        name: to_address.name || 'Customer',
        street1: to_address.street1,
        street2: to_address.street2 || '',
        city: to_address.city,
        state: to_address.state,
        zip: to_address.zip,
        country: to_address.country || 'US',
      },
      parcel: { weight: weightOz, length: 12, width: 9, height: 1 },
    });
    const rates = (shipment.rates || [])
      .filter(r => r.carrier && r.rate)
      .sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate))
      .map(r => ({
        id: r.id,
        carrier: r.carrier,
        service: r.service,
        rate: parseFloat(r.rate),
        delivery_days: r.delivery_days,
        est_delivery_date: r.est_delivery_date,
      }));
    res.json({ rates, shipment_id: shipment.id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/create-checkout-session', async (req, res) => {
  const { items, promo_code_id } = req.body;
  try {
    // Filter out any items missing a price_id (e.g. products not yet configured in Stripe)
    const validItems = (items || []).filter(i => i.price_id);
    if (!validItems.length) return res.status(400).json({ error: 'No valid items in cart. Some products may not be available for purchase yet.' });
    const lineItems = validItems.map(i => ({ price: i.price_id, quantity: i.quantity || 1 }));
    const productIds = validItems.map(i => i.product_id).filter(Boolean);

    // Check if any items require physical shipping
    let hasPhysical = false;
    if (productIds.length) {
      const ph = productIds.map((_, i) => '$' + (i + 1)).join(',');
      const physCheck = await pool.query('SELECT id FROM products WHERE id IN (' + ph + ') AND requires_shipping = true', productIds.map(Number));
      hasPhysical = physCheck.rows.length > 0;
    }

    const sessionParams = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: 'payment',
      customer_creation: 'if_required',
      metadata: { product_ids: productIds.join(','), has_physical: hasPhysical ? '1' : '0' },
      success_url: process.env.DOMAIN + '/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: process.env.DOMAIN + '/cart.html',
    };

    // Add shipping address collection + options for physical items
    if (hasPhysical) {
      sessionParams.shipping_address_collection = { allowed_countries: ['US', 'CA', 'GB', 'AU'] };
      sessionParams.shipping_options = [
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 799, currency: 'usd' },
            display_name: 'Standard Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 5 },
              maximum: { unit: 'business_day', value: 7 },
            },
          },
        },
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 1499, currency: 'usd' },
            display_name: 'Priority Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 2 },
              maximum: { unit: 'business_day', value: 3 },
            },
          },
        },
        {
          shipping_rate_data: {
            type: 'fixed_amount',
            fixed_amount: { amount: 2999, currency: 'usd' },
            display_name: 'Express Shipping',
            delivery_estimate: {
              minimum: { unit: 'business_day', value: 1 },
              maximum: { unit: 'business_day', value: 1 },
            },
          },
        },
      ];
    }

    // Apply pre-validated promo code if provided, otherwise allow native promo entry
    if (promo_code_id) {
      sessionParams.discounts = [{ promotion_code: promo_code_id }];
    } else {
      sessionParams.allow_promotion_codes = true;
    }
    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Stripe Webhook — send download links after successful payment
app.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    // GUARD: this Stripe account is shared with tshirtbrothers. Only process
    // checkouts that originated from Lion and Lamb — those always carry
    // metadata.has_physical (set in /create-checkout-session). tshirtbrothers
    // sessions carry quoteId/invoice_id instead and must be ignored, otherwise
    // they get double-recorded as phantom orders here.
    if (!session.metadata || !("has_physical" in session.metadata)) {
      console.log("[webhook] ignoring non-Lion-and-Lamb session", session.id, session.metadata);
      return res.json({ received: true, ignored: true });
    }

    const customerEmail = session.customer_details && session.customer_details.email;
    const customerName = session.customer_details && session.customer_details.name;
    const productIds = (session.metadata && session.metadata.product_ids || '').split(',').filter(Boolean);

    if (!customerEmail) {
      console.log('No customer email in session, skipping email');
      return res.json({ received: true });
    }

    // Which Stripe prices were actually bought — needed to pick per-voicing files
    let purchasedPriceIds = [];
    try {
      const li = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
      purchasedPriceIds = li.data.map(x => x.price && x.price.id).filter(Boolean);
    } catch(e) { console.error('listLineItems error:', e.message); }

    // Look up products — declared here so all subsequent try blocks can access emailItems
    let emailItems = [];
    try {
      if (productIds.length > 0) {
        const placeholders = productIds.map((_, i) => '$' + (i + 1)).join(',');
        const result = await pool.query(
          'SELECT id, title, composer, ensemble, format, download_url, audio_url, requires_shipping, weight_oz, variations, stripe_price_pdf, stripe_price_print, stripe_price_bundle FROM products WHERE id IN (' + placeholders + ')',
          productIds.map(Number)
        );
        for (const p of result.rows) {
          const matchedVars = parseVariations(p.variations).filter(v =>
            [v.stripe_price_pdf, v.stripe_price_print, v.stripe_price_bundle].some(id => id && purchasedPriceIds.includes(id))
          );
          const baseBought = [p.stripe_price_pdf, p.stripe_price_print, p.stripe_price_bundle].some(id => id && purchasedPriceIds.includes(id));
          if (baseBought || matchedVars.length === 0) matchedVars.unshift(null);
          for (const variant of matchedVars) {
            emailItems.push(await buildDeliveryItem(p, variant));
          }
        }
      }
      if (emailItems.length === 0) {
        emailItems = [{ title: 'Your order', composer: '', ensemble: '', downloadUrl: null }];
      }
    } catch (lookupErr) {
      console.error('Product lookup error:', lookupErr.message);
      emailItems = [{ title: 'Your order', composer: '', ensemble: '', downloadUrl: null }];
    }

    try {
      const html = buildEmailHtml(customerName, emailItems);
      const mailer = getMailer();
      const sendResult = await mailer.emails.send({
        from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
        to: customerEmail,
        subject: 'Your Lion and Lamb Publishing Order — Download Links Inside',
        html
      });
      if (sendResult.error) throw new Error(sendResult.error.message || 'Email send failed');
      console.log('Order email sent to', customerEmail);
    } catch (err) {
      console.error('Email send error:', err.message);
    }

    // Save order to database
    let savedOrderId = null;
    try {
      const orderItems = emailItems.map(i => ({ id: i.id, title: i.title, composer: i.composer, ensemble: i.ensemble, format: i.format || null, requires_shipping: i.requires_shipping || false, download_key: i.download_key || null }));
      const userRow = await pool.query('SELECT id FROM users WHERE LOWER(email)=$1', [customerEmail.toLowerCase()]);
      const userId = userRow.rows.length ? userRow.rows[0].id : null;
      const shippingAddr = session.shipping_details && session.shipping_details.address
        ? { ...session.shipping_details.address, name: (session.shipping_details.name || customerName) }
        : null;
      const dbResult = await pool.query(
        'INSERT INTO orders (stripe_session_id, stripe_payment_intent, customer_email, customer_name, amount_total, currency, items, user_id, shipping_address) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (stripe_session_id) DO NOTHING RETURNING id',
        [session.id, session.payment_intent, customerEmail, customerName, session.amount_total, session.currency, JSON.stringify(orderItems), userId, shippingAddr ? JSON.stringify(shippingAddr) : null]
      );
      if (dbResult.rows.length) savedOrderId = dbResult.rows[0].id;
    } catch (dbErr) { console.error('Order DB save error:', dbErr.message); }

    // ── Auto-link subscriber + update customer intelligence ──────────────────
    try {
      const emailLower = customerEmail.toLowerCase();
      // Determine product tags from this purchase
      const purchasedFormats = emailItems.map(i => i.ensemble || i.format || '').filter(Boolean);
      const autoTags = [];
      if (emailItems.some(i => (i.ensemble||'').match(/SATB/i))) autoTags.push('buyer:satb');
      if (emailItems.some(i => (i.ensemble||'').match(/SSAA/i))) autoTags.push('buyer:ssaa');
      if (emailItems.some(i => (i.ensemble||'').match(/TTBB/i))) autoTags.push('buyer:ttbb');
      if (emailItems.some(i => (i.format||'').match(/Merch/i))) autoTags.push('buyer:merch');
      if (emailItems.some(i => (i.format||'').match(/MP3/i))) autoTags.push('buyer:mp3');
      autoTags.push('buyer');

      // Upsert subscriber record — source='checkout', preserve existing name/active status
      const subResult = await pool.query(
        `INSERT INTO subscribers (email, name, source, active, tags, total_spent, order_count, last_purchase_at)
         VALUES ($1, $2, 'checkout', FALSE, $3, $4, 1, NOW())
         ON CONFLICT (email) DO UPDATE SET
           name = COALESCE(subscribers.name, $2),
           user_id = COALESCE(subscribers.user_id, (SELECT id FROM users WHERE LOWER(email)=$1 LIMIT 1)),
           total_spent = subscribers.total_spent + $4,
           order_count = subscribers.order_count + 1,
           last_purchase_at = NOW(),
           tags = (SELECT ARRAY(SELECT DISTINCT unnest(subscribers.tags || $3::text[])))
         RETURNING id`,
        [emailLower, customerName || null, autoTags, session.amount_total || 0]
      );
      const subscriberId = subResult.rows[0]?.id;

      // Link this order to the subscriber
      if (subscriberId && savedOrderId) {
        await pool.query('UPDATE orders SET subscriber_id=$1 WHERE id=$2', [subscriberId, savedOrderId]);
      }

      // Link subscriber to user account if exists
      if (subscriberId) {
        await pool.query(
          'UPDATE subscribers SET user_id=(SELECT id FROM users WHERE LOWER(email)=$1 LIMIT 1) WHERE id=$2 AND user_id IS NULL',
          [emailLower, subscriberId]
        );
      }
      console.log('Customer intelligence updated for', emailLower, '| tags:', autoTags.join(','));
    } catch (ciErr) { console.error('Customer intelligence error:', ciErr.message); }

    // Auto-purchase EasyPost shipping label for physical items
    const hasPhysical = (session.metadata && session.metadata.has_physical) === '1';
    if (hasPhysical && easypost && session.shipping_details) {
      try {
        const addr = session.shipping_details.address;
        const shippingName = session.shipping_details.name || customerName || 'Customer';
        const chosenShipping = session.shipping_cost && session.shipping_cost.amount_total;
        // Map Stripe tier to EasyPost services preference
        let preferredServices = ['First', 'Priority', 'GroundAdvantage']; // standard default
        if (chosenShipping >= 2999) preferredServices = ['Express', 'NextDayAir', 'FEDEX_2_DAY'];
        else if (chosenShipping >= 1499) preferredServices = ['Priority', 'First', '2DAY'];

        // Get product weights
        const physIds = emailItems.filter(i => i.requires_shipping).map(i => i.id).filter(Boolean);
        let weightOz = 4;
        if (physIds.length) {
          const ph = physIds.map((_, i) => '$' + (i + 1)).join(',');
          const wr = await pool.query('SELECT COALESCE(weight_oz,4) as weight_oz FROM products WHERE id IN (' + ph + ')', physIds.map(Number));
          weightOz = Math.max(wr.rows.reduce((s, r) => s + parseFloat(r.weight_oz || 4), 0), 1);
        }

        const shipment = await easypost.Shipment.create({
          from_address: getFromAddress(),
          to_address: {
            name: shippingName,
            street1: addr.line1,
            street2: addr.line2 || '',
            city: addr.city,
            state: addr.state,
            zip: addr.postal_code,
            country: addr.country || 'US',
            email: customerEmail,
          },
          parcel: { weight: weightOz, length: 12, width: 9, height: 1 },
        });

        // Pick best matching rate
        const rates = (shipment.rates || []).sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
        let chosenRate = rates.find(r => preferredServices.some(s => r.service && r.service.includes(s))) || rates[0];
        if (!chosenRate) throw new Error('No rates returned from EasyPost');

        const purchased = await easypost.Shipment.buy(shipment.id, chosenRate.id);
        const trackingCode = purchased.tracker && purchased.tracker.tracking_code;
        const trackingUrl = purchased.tracker && purchased.tracker.public_url;
        const labelUrl = purchased.postage_label && purchased.postage_label.label_url;

        // Update order with tracking info
        if (savedOrderId) {
          await pool.query(
            'UPDATE orders SET tracking_number=$1, tracking_url=$2, easypost_shipment_id=$3, carrier=$4, service=$5, label_url=$6, shipping_label_purchased=true WHERE id=$7',
            [trackingCode, trackingUrl, shipment.id, chosenRate.carrier, chosenRate.service, labelUrl, savedOrderId]
          );
        }

        // Send tracking email
        try {
          const mailer = getMailer();
          await mailer.emails.send({
            from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
            to: customerEmail,
            subject: 'Your Lion and Lamb Publishing Order Has Shipped!',
            html: buildShippingEmailHtml(customerName, emailItems, trackingCode, trackingUrl, chosenRate.carrier, chosenRate.service),
          });
          console.log('Shipping email sent to', customerEmail);
        } catch (mailErr) { console.error('Shipping email error:', mailErr.message); }

        console.log('EasyPost label purchased:', trackingCode, 'via', chosenRate.carrier, chosenRate.service);
      } catch (epErr) {
        console.error('EasyPost label purchase error:', epErr.message);
      }
    }
  }

  if (event.type === 'invoice.payment_succeeded') {
    const invoice = event.data.object;
    const customerEmail = invoice.customer_email;
    const customerName = invoice.customer_name;
    const invoiceUrl = invoice.hosted_invoice_url;
    const invoiceNum = invoice.number;
    if (customerEmail) {
      try {
        const mailer = getMailer();
        await mailer.emails.send({
          from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
          to: customerEmail,
          subject: 'Payment Received — Lion and Lamb Publishing' + (invoiceNum ? ' (' + invoiceNum + ')' : ''),
          html: '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f3ec;font-family:Arial,sans-serif">'
            + '<div style="max-width:520px;margin:40px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08)">'
            + '<div style="background:#7b1f2e;padding:28px 36px"><div style="color:#fff;font-family:Georgia,serif;font-size:1.3rem;font-weight:900">&#119070; Lion and Lamb Publishing</div></div>'
            + '<div style="padding:32px 36px">'
            + '<h2 style="font-family:Georgia,serif;font-size:1.4rem;margin-bottom:8px">Payment received!</h2>'
            + '<p style="color:#6b6257;font-size:0.9rem;margin-bottom:20px">Thank you' + (customerName ? ', ' + customerName : '') + '. We have received your payment' + (invoiceNum ? ' for invoice ' + invoiceNum : '') + '.</p>'
            + (invoiceUrl ? '<div style="text-align:center;margin-bottom:20px"><a href="' + invoiceUrl + '" style="background:#7b1f2e;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:700;font-size:0.9rem">View Invoice</a></div>' : '')
            + '<p style="color:#6b6257;font-size:0.8rem">Questions? Reply to this email or visit <a href="https://lionandlambpublishing.com" style="color:#7b1f2e">lionandlambpublishing.com</a></p>'
            + '</div></div></body></html>'
        });
        console.log('Invoice payment confirmation sent to', customerEmail);
      } catch (err) {
        console.error('Invoice payment email error:', err.message);
      }
    }
  }

  res.json({ received: true });
});

// Get order details by Stripe session ID (for success page)
app.get('/order/:session_id', async (req, res) => {
  try {
    const [session, dbResult] = await Promise.all([
      stripe.checkout.sessions.retrieve(req.params.session_id),
      pool.query('SELECT id, stripe_session_id, customer_name, customer_email, amount_total, currency, items, status, created_at, tracking_number, tracking_url, carrier, service, shipping_address FROM orders WHERE stripe_session_id=$1', [req.params.session_id])
    ]);
    const dbOrder = dbResult.rows[0] || {};
    const items = typeof dbOrder.items === 'string' ? JSON.parse(dbOrder.items) : (dbOrder.items || []);
    res.json({
      email: dbOrder.customer_email || (session.customer_details && session.customer_details.email),
      name: dbOrder.customer_name || (session.customer_details && session.customer_details.name),
      amount: dbOrder.amount_total || session.amount_total,
      currency: dbOrder.currency || session.currency,
      status: dbOrder.status || 'completed',
      items,
      created_at: dbOrder.created_at,
      tracking_number: dbOrder.tracking_number || null,
      tracking_url: dbOrder.tracking_url || null,
      carrier: dbOrder.carrier || null,
      shipping_address: dbOrder.shipping_address || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Auth middleware
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch(e) { res.status(401).json({ error: 'Invalid or expired token' }); }
}

// Register
app.post('/register', authLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!email || !password || !name) return res.status(400).json({ error: 'Name, email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email)=$1', [email.toLowerCase()]);
    if (existing.rows.length) return res.status(409).json({ error: 'An account with that email already exists' });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, name, password_hash) VALUES ($1,$2,$3) RETURNING id, email, name, created_at',
      [email.toLowerCase(), name.trim(), hash]
    );
    const user = result.rows[0];
    // Link any existing orders by email
    await pool.query('UPDATE orders SET user_id=$1 WHERE LOWER(customer_email)=$2 AND user_id IS NULL', [user.id, email.toLowerCase()]);
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Login
app.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  try {
    const result = await pool.query('SELECT id, email, name, password_hash, is_admin FROM users WHERE LOWER(email)=$1', [email.toLowerCase()]);
    if (!result.rows.length) return res.status(401).json({ error: 'No account found with that email' });
    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Incorrect password' });
    const token = jwt.sign({ id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email, name: user.name, is_admin: !!user.is_admin } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Get current user profile + orders
app.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const orders = await pool.query(
      'SELECT id, stripe_session_id, customer_name, amount_total, currency, status, items, created_at, tracking_number, tracking_url, carrier, service FROM orders WHERE user_id=$1 OR LOWER(customer_email)=$2 ORDER BY created_at DESC LIMIT 50',
      [user.id, user.email]
    );
    res.json({ user: { id: user.id, email: user.email, name: user.name }, orders: orders.rows });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Look up orders by customer email

app.get('/my-orders', async (req, res) => {
  const email = (req.query.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  try {
    const result = await pool.query(
      'SELECT id, stripe_session_id, customer_name, amount_total, currency, status, items, created_at, tracking_number, tracking_url, carrier, service FROM orders WHERE LOWER(customer_email)=$1 ORDER BY created_at DESC LIMIT 50',
      [email]
    );
    // Also pull profile from first order
    const nameRow = await pool.query('SELECT customer_name FROM orders WHERE LOWER(customer_email)=$1 AND customer_name IS NOT NULL LIMIT 1', [email]);
    res.json({
      name: nameRow.rows.length ? nameRow.rows[0].customer_name : null,
      email,
      orders: result.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Google OAuth
app.post('/auth/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'No credential provided' });
  if (!googleClient) return res.status(503).json({ error: 'Google Sign-In not configured' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const { sub: googleId, email, name, picture } = payload;
    if (!email) return res.status(400).json({ error: 'No email in Google token' });
    // Find or create user
    let user;
    const existing = await pool.query('SELECT id, email, name, avatar_url, is_admin FROM users WHERE oauth_provider=$1 AND oauth_id=$2', ['google', googleId]);
    if (existing.rows.length) {
      user = existing.rows[0];
      await pool.query('UPDATE users SET name=COALESCE(name,$1), avatar_url=COALESCE(avatar_url,$2) WHERE id=$3', [name, picture, user.id]);
      user.name = user.name || name;
    } else {
      // Check if email already has a password account
      const byEmail = await pool.query('SELECT id, email, name, avatar_url, is_admin FROM users WHERE LOWER(email)=$1', [email.toLowerCase()]);
      if (byEmail.rows.length) {
        // Link OAuth to existing account
        user = byEmail.rows[0];
        await pool.query('UPDATE users SET oauth_provider=$1, oauth_id=$2, avatar_url=COALESCE(avatar_url,$3) WHERE id=$4', ['google', googleId, picture, user.id]);
      } else {
        const result = await pool.query(
          'INSERT INTO users (email, name, avatar_url, oauth_provider, oauth_id) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, name, avatar_url, is_admin',
          [email.toLowerCase(), name, picture, 'google', googleId]
        );
        user = result.rows[0];
      }
    }
    await pool.query('UPDATE orders SET user_id=$1 WHERE LOWER(customer_email)=$2 AND user_id IS NULL', [user.id, email.toLowerCase()]);
    const token = jwt.sign({ id: user.id, email: user.email || email, name: user.name || name, avatar: user.avatar_url || picture, is_admin: !!user.is_admin }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: user.id, email: user.email || email, name: user.name || name, avatar: user.avatar_url || picture, is_admin: !!user.is_admin } });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// Change password
// Validate promo code (customer-facing)
app.post('/validate-promo', authLimiter, async (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'Code required' });
  try {
    const promos = await stripe.promotionCodes.list({ code: code.toUpperCase(), active: true, limit: 1 });
    if (!promos.data.length) {
      const promos2 = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
      if (!promos2.data.length) return res.status(404).json({ error: 'Invalid or expired promo code' });
      const p = promos2.data[0];
      const coupon = p.coupon;
      return res.json({
        id: p.id,
        code: p.code,
        discount: coupon.percent_off ? coupon.percent_off + '% off' : '$' + (coupon.amount_off / 100).toFixed(2) + ' off',
        percent_off: coupon.percent_off || null,
        amount_off: coupon.amount_off || null,
      });
    }
    const p = promos.data[0];
    const coupon = p.coupon;
    res.json({
      id: p.id,
      code: p.code,
      discount: coupon.percent_off ? coupon.percent_off + '% off' : '$' + (coupon.amount_off / 100).toFixed(2) + ' off',
      percent_off: coupon.percent_off || null,
      amount_off: coupon.amount_off || null,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Forgot password
app.post('/forgot-password', strictLimiter, async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const userResult = await pool.query('SELECT id, name FROM users WHERE LOWER(email)=$1', [email.toLowerCase()]);
    // Always return success to prevent email enumeration
    if (!userResult.rows.length) return res.json({ ok: true });
    const user = userResult.rows[0];
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [user.id, token, expires]
    );
    const resetUrl = (process.env.DOMAIN || 'https://lionandlambpublishing.com') + '/director-dashboard.html?reset=' + token;
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
      to: email,
      subject: 'Reset your Lion and Lamb Publishing password',
      html: `<!DOCTYPE html><html><body style="font-family:'Helvetica Neue',Arial,sans-serif;background:#f5f9f6;padding:40px 16px">
        <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:36px;border:1px solid #c4d9c9">
          <div style="font-family:Georgia,serif;font-weight:900;font-size:1.2rem;margin-bottom:20px">Lion and Lamb Publishing</div>
          <h2 style="font-family:Georgia,serif;font-size:1.3rem;margin:0 0 14px">Reset your password</h2>
          <p style="color:#5a6672;font-size:0.9rem;line-height:1.7;margin:0 0 24px">Hi ${user.name||'there'}, we received a request to reset your password. Click the button below to choose a new one. This link expires in 1 hour.</p>
          <a href="${resetUrl}" style="display:inline-block;background:#3ab54a;color:#fff;padding:13px 28px;border-radius:8px;font-weight:700;text-decoration:none;font-size:0.9rem">Reset Password &rarr;</a>
          <p style="color:#aaa;font-size:0.75rem;margin-top:24px">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
        </div>
      </body></html>`,
    });
    res.json({ ok: true });
  } catch (err) { console.error('Forgot password error:', err.message); res.json({ ok: true }); }
});

// Reset password (via token)
app.post('/reset-password', strictLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const tokenResult = await pool.query(
      'SELECT t.*, u.email FROM password_reset_tokens t JOIN users u ON t.user_id=u.id WHERE t.token=$1 AND t.expires_at > NOW()',
      [token]
    );
    if (!tokenResult.rows.length) return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    const { user_id } = tokenResult.rows[0];
    const bcrypt = require('bcrypt');
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, user_id]);
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id=$1', [user_id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Apple Sign-In (stub — requires Apple Developer account)
app.post('/auth/apple', async (req, res) => {
  res.status(501).json({ error: 'Apple Sign-In requires additional configuration. Please use email or Google sign-in.' });
});

app.post('/change-password', authMiddleware, async (req, res) => {
  const { password } = req.body || {};
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  try {
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});


// Admin: list orders with physical items that need labels or have tracking
// All orders (admin)
app.get('/admin/orders', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query(
      `SELECT id, stripe_session_id, customer_email, customer_name, amount_total, currency, items, status,
              created_at, tracking_number, tracking_url, carrier, service, shipping_label_purchased, shipping_address
       FROM orders ORDER BY created_at DESC LIMIT 200`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update order status / tracking
app.patch('/admin/orders/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { status, tracking_number, tracking_url, carrier, service } = req.body;
  try {
    const updates = []; const vals = [];
    if (status !== undefined)          { vals.push(status);          updates.push(`status=$${vals.length}`); }
    if (tracking_number !== undefined) { vals.push(tracking_number); updates.push(`tracking_number=$${vals.length}`); }
    if (tracking_url !== undefined)    { vals.push(tracking_url);    updates.push(`tracking_url=$${vals.length}`); }
    if (carrier !== undefined)         { vals.push(carrier);         updates.push(`carrier=$${vals.length}`); }
    if (service !== undefined)         { vals.push(service);         updates.push(`service=$${vals.length}`); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    await pool.query(`UPDATE orders SET ${updates.join(',')} WHERE id=$${vals.length}`, vals);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resend purchase confirmation email
app.post('/admin/orders/:id/resend-email', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const orderResult = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!orderResult.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderResult.rows[0];
    const rawItems = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
    // Re-fetch products to get download URLs; stored item download_key (per-voicing) wins
    const productIds = rawItems.map(i => i.id).filter(Boolean);
    let emailItems = rawItems;
    if (productIds.length) {
      const ph = productIds.map((_, i) => '$' + (i + 1)).join(',');
      const prodResult = await pool.query(
        'SELECT id, title, composer, ensemble, format, download_url, audio_url, requires_shipping FROM products WHERE id IN (' + ph + ')',
        productIds.map(Number)
      );
      const prodById = {};
      prodResult.rows.forEach(p => { prodById[p.id] = p; });
      emailItems = await Promise.all(rawItems.map(async it => {
        const p = prodById[it.id] || {};
        const fileKey = it.download_key || p.download_url || (p.format !== 'Merch' ? p.audio_url : null);
        const downloadUrl = await signFileRef(fileKey);
        return { id: it.id, title: it.title || p.title, composer: it.composer || p.composer, ensemble: it.ensemble || p.ensemble, downloadUrl };
      }));
    }
    const html = buildEmailHtml(order.customer_name, emailItems);
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
      to: order.customer_email,
      subject: '[Resent] Your Lion and Lamb Publishing Order — Download Links Inside',
      html,
    });
    res.json({ ok: true, sent_to: order.customer_email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/shipments', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await pool.query(
      'SELECT id, stripe_session_id, customer_email, customer_name, amount_total, currency, items, shipping_address, tracking_number, tracking_url, easypost_shipment_id, carrier, service, label_url, shipping_label_purchased, created_at FROM orders WHERE shipping_address IS NOT NULL ORDER BY created_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: manually buy label for an order
app.post('/admin/buy-label/:order_id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!easypost) return res.status(503).json({ error: 'EasyPost not configured' });
  try {
    const { rate_id, shipment_id } = req.body || {};
    const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderRes.rows[0];
    if (!order.shipping_address) return res.status(400).json({ error: 'No shipping address on this order' });

    let finalShipmentId = shipment_id || order.easypost_shipment_id;
    let purchased;

    if (finalShipmentId && rate_id) {
      // Buy specific rate on existing shipment
      purchased = await easypost.Shipment.buy(finalShipmentId, rate_id);
    } else {
      // Create new shipment and buy lowest rate
      const addr = order.shipping_address;
      const items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
      const physIds = items.map(i => i.id).filter(Boolean);
      let weightOz = 4;
      if (physIds.length) {
        const ph = physIds.map((_, i) => '$' + (i + 1)).join(',');
        const wr = await pool.query('SELECT COALESCE(weight_oz,4) as weight_oz FROM products WHERE id IN (' + ph + ')', physIds.map(Number));
        weightOz = Math.max(wr.rows.reduce((s, r) => s + parseFloat(r.weight_oz || 4), 0), 1);
      }
      const shipment = await easypost.Shipment.create({
        from_address: getFromAddress(),
        to_address: {
          name: addr.name || order.customer_name || 'Customer',
          street1: addr.line1 || addr.street1,
          street2: addr.line2 || addr.street2 || '',
          city: addr.city,
          state: addr.state,
          zip: addr.postal_code || addr.zip,
          country: addr.country || 'US',
          email: order.customer_email,
        },
        parcel: { weight: weightOz, length: 12, width: 9, height: 1 },
      });
      finalShipmentId = shipment.id;
      const rates = (shipment.rates || []).sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate));
      const chosenRate = rate_id ? rates.find(r => r.id === rate_id) : rates[0];
      if (!chosenRate) return res.status(400).json({ error: 'No rates available', shipment_id: shipment.id, rates: shipment.rates });
      purchased = await easypost.Shipment.buy(shipment.id, chosenRate.id);
    }

    const trackingCode = purchased.tracker && purchased.tracker.tracking_code;
    const trackingUrl = purchased.tracker && purchased.tracker.public_url;
    const labelUrl = purchased.postage_label && purchased.postage_label.label_url;
    const rate = purchased.selected_rate || {};

    await pool.query(
      'UPDATE orders SET tracking_number=$1, tracking_url=$2, easypost_shipment_id=$3, carrier=$4, service=$5, label_url=$6, shipping_label_purchased=true WHERE id=$7',
      [trackingCode, trackingUrl, finalShipmentId, rate.carrier, rate.service, labelUrl, order.id]
    );

    res.json({ ok: true, tracking_number: trackingCode, tracking_url: trackingUrl, label_url: labelUrl, carrier: rate.carrier, service: rate.service });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: get rates for an order (without buying)
app.get('/admin/order-rates/:order_id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!easypost) return res.status(503).json({ error: 'EasyPost not configured' });
  try {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.order_id]);
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderRes.rows[0];
    if (!order.shipping_address) return res.status(400).json({ error: 'No shipping address' });

    const addr = order.shipping_address;
    const items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
    const physIds = items.map(i => i.id).filter(Boolean);
    let weightOz = 4;
    if (physIds.length) {
      const ph = physIds.map((_, i) => '$' + (i + 1)).join(',');
      const wr = await pool.query('SELECT COALESCE(weight_oz,4) as weight_oz FROM products WHERE id IN (' + ph + ')', physIds.map(Number));
      weightOz = Math.max(wr.rows.reduce((s, r) => s + parseFloat(r.weight_oz || 4), 0), 1);
    }
    const shipment = await easypost.Shipment.create({
      from_address: getFromAddress(),
      to_address: {
        name: addr.name || order.customer_name,
        street1: addr.line1 || addr.street1,
        street2: addr.line2 || addr.street2 || '',
        city: addr.city,
        state: addr.state,
        zip: addr.postal_code || addr.zip,
        country: addr.country || 'US',
      },
      parcel: { weight: weightOz, length: 12, width: 9, height: 1 },
    });
    const rates = (shipment.rates || []).sort((a, b) => parseFloat(a.rate) - parseFloat(b.rate)).map(r => ({
      id: r.id, carrier: r.carrier, service: r.service, rate: parseFloat(r.rate), delivery_days: r.delivery_days,
    }));
    res.json({ shipment_id: shipment.id, rates });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── TESTIMONIALS ─────────────────────────────────────────────────────────────
const ADMIN_CHECK = (req,res) => { if(req.headers['x-admin-key']!==process.env.ADMIN_KEY) { res.status(401).json({error:'Unauthorized'}); return false; } return true; };

app.get('/testimonials', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, quote, name, role, initials, sort_order FROM testimonials WHERE active=TRUE ORDER BY sort_order ASC, id ASC');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/testimonials', async (req, res) => {
  if(!ADMIN_CHECK(req,res)) return;
  try {
    const r = await pool.query('SELECT * FROM testimonials ORDER BY sort_order ASC, id ASC');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/testimonials', async (req, res) => {
  if(!ADMIN_CHECK(req,res)) return;
  const { quote, name, role, initials, active, sort_order } = req.body;
  if (!quote || !name) return res.status(400).json({ error: 'quote and name required' });
  try {
    const r = await pool.query(
      'INSERT INTO testimonials (quote, name, role, initials, active, sort_order, updated_at) VALUES ($1,$2,$3,$4,$5,$6,NOW()) RETURNING *',
      [quote, name, role||null, initials||null, active!==false, sort_order||0]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/testimonials/:id', async (req, res) => {
  if(!ADMIN_CHECK(req,res)) return;
  const { quote, name, role, initials, active, sort_order } = req.body;
  try {
    const r = await pool.query(
      'UPDATE testimonials SET quote=$1, name=$2, role=$3, initials=$4, active=$5, sort_order=$6, updated_at=NOW() WHERE id=$7 RETURNING *',
      [quote, name, role||null, initials||null, active!==false, sort_order||0, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/testimonials/:id', async (req, res) => {
  if(!ADMIN_CHECK(req,res)) return;
  try {
    await pool.query('DELETE FROM testimonials WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── HOMEPAGE VIDEOS ──────────────────────────────────────────────────────────
app.get('/videos', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, youtube_id, title, meta, sort_order FROM homepage_videos WHERE active=TRUE ORDER BY sort_order ASC, id ASC'
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/videos', async (req, res) => {
  if (!ADMIN_CHECK(req, res)) return;
  try {
    const r = await pool.query('SELECT * FROM homepage_videos ORDER BY sort_order ASC, id ASC');
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/videos', async (req, res) => {
  if (!ADMIN_CHECK(req, res)) return;
  const { youtube_id, title, meta, active, sort_order } = req.body;
  if (!youtube_id || !title) return res.status(400).json({ error: 'youtube_id and title required' });
  // Accept full URL or bare ID
  const ytId = youtube_id.replace(/.*(?:youtu\.be\/|v=|embed\/)([A-Za-z0-9_-]{11}).*/, '$1').trim();
  try {
    const r = await pool.query(
      'INSERT INTO homepage_videos (youtube_id, title, meta, active, sort_order, updated_at) VALUES ($1,$2,$3,$4,$5,NOW()) RETURNING *',
      [ytId, title, meta || null, active !== false, sort_order || 0]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/admin/videos/:id', async (req, res) => {
  if (!ADMIN_CHECK(req, res)) return;
  const { youtube_id, title, meta, active, sort_order } = req.body;
  const ytId = (youtube_id || '').replace(/.*(?:youtu\.be\/|v=|embed\/)([A-Za-z0-9_-]{11}).*/, '$1').trim();
  try {
    const r = await pool.query(
      'UPDATE homepage_videos SET youtube_id=$1, title=$2, meta=$3, active=$4, sort_order=$5, updated_at=NOW() WHERE id=$6 RETURNING *',
      [ytId, title, meta || null, active !== false, sort_order || 0, req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/videos/:id', async (req, res) => {
  if (!ADMIN_CHECK(req, res)) return;
  try {
    await pool.query('DELETE FROM homepage_videos WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── SITEMAP (Feature 7) ───────────────────────────────────────────────────────
app.get('/sitemap.xml', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, updated_at, created_at FROM products ORDER BY id');
    const BASE = 'https://lionandlambpublishing.com';
    const staticPages = ['/', '/search.html', '/music.html', '/merch.html', '/about.html', '/for-directors.html', '/blog.html', '/free-resources.html'];
    const staticUrls = staticPages.map(p => `  <url><loc>${BASE}${p}</loc><changefreq>weekly</changefreq><priority>0.8</priority></url>`).join('\n');
    const productUrls = result.rows.map(p => {
      const lastmod = (p.updated_at || p.created_at || new Date()).toISOString().slice(0,10);
      return `  <url><loc>${BASE}/product.html?id=${p.id}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`;
    }).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${staticUrls}\n${productUrls}\n</urlset>`;
    res.set('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) { res.status(500).send('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>'); }
});

// ── REVENUE CHART (Feature 8) ─────────────────────────────────────────────────
app.get('/admin/analytics/revenue', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await pool.query(`
      SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon YYYY') as month,
             DATE_TRUNC('month', created_at) as month_date,
             SUM(amount_total)/100.0 as revenue,
             COUNT(*) as order_count
      FROM orders
      WHERE created_at > NOW() - INTERVAL '6 months'
      GROUP BY DATE_TRUNC('month', created_at)
      ORDER BY DATE_TRUNC('month', created_at) ASC
    `);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message, rows: [] }); }
});

// ── REDOWNLOAD (Feature 9) ────────────────────────────────────────────────────
app.get('/orders/redownload', async (req, res) => {
  const { email, order_id } = req.query;
  if (!email || !order_id) return res.status(400).json({ error: 'email and order_id required' });
  try {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1 AND LOWER(customer_email)=$2', [order_id, email.toLowerCase()]);
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Order not found' });
    const order = orderRes.rows[0];
    const items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
    const productIds = items.map(i => i.id).filter(Boolean);
    if (!productIds.length) return res.json({ downloads: [] });
    const ph = productIds.map((_, i) => '$' + (i + 1)).join(',');
    const prodRes = await pool.query('SELECT id, title, download_url, audio_url, format FROM products WHERE id IN (' + ph + ')', productIds.map(Number));
    const prodById = {};
    prodRes.rows.forEach(p => { prodById[p.id] = p; });
    const downloads = await Promise.all(items.filter(i => i && i.id != null && prodById[i.id]).map(async it => {
      const p = prodById[it.id];
      const fileKey = it.download_key || p.download_url || p.audio_url;
      const downloadUrl = await signFileRef(fileKey);
      return { id: p.id, title: p.title + (it.ensemble ? ' (' + it.ensemble + ')' : ''), format: p.format, downloadUrl };
    }));
    res.json({ downloads });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── REVIEWS (Feature 10) ──────────────────────────────────────────────────────
pool.query(`CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  product_id INTEGER NOT NULL,
  reviewer_name TEXT NOT NULL,
  reviewer_email TEXT,
  rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT,
  approved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});

app.get('/reviews', async (req, res) => {
  const { product_id } = req.query;
  if (!product_id) return res.status(400).json({ error: 'product_id required' });
  try {
    const r = await pool.query('SELECT id, reviewer_name, rating, review_text, created_at FROM reviews WHERE product_id=$1 AND approved=TRUE ORDER BY created_at DESC', [product_id]);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/reviews', async (req, res) => {
  const { product_id, reviewer_name, reviewer_email, rating, review_text } = req.body;
  if (!product_id || !reviewer_name || !rating) return res.status(400).json({ error: 'product_id, reviewer_name, and rating are required' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'rating must be 1-5' });
  try {
    const r = await pool.query('INSERT INTO reviews (product_id, reviewer_name, reviewer_email, rating, review_text) VALUES ($1,$2,$3,$4,$5) RETURNING id', [product_id, reviewer_name, reviewer_email||null, parseInt(rating), review_text||null]);
    res.json({ ok: true, id: r.rows[0].id, message: 'Review submitted! It will appear after approval.' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/reviews', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query(`SELECT rv.*, p.title as product_title FROM reviews rv LEFT JOIN products p ON rv.product_id=p.id ORDER BY rv.created_at DESC`);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/reviews/:id/approve', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('UPDATE reviews SET approved=TRUE WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/reviews/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM reviews WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PRODUCT STATS (Feature 15) ────────────────────────────────────────────────
app.get('/products/:id/stats', async (req, res) => {
  try {
    const id = req.params.id;
    const [reviewStats, purchaseStats] = await Promise.all([
      pool.query('SELECT COUNT(*) as review_count, ROUND(AVG(rating),1) as avg_rating FROM reviews WHERE product_id=$1 AND approved=TRUE', [id]),
      pool.query(`SELECT COUNT(*) as purchase_count FROM orders, jsonb_array_elements(items) as item WHERE (item->>'id')::int = $1`, [parseInt(id)])
    ]);
    const rv = reviewStats.rows[0];
    const pc = purchaseStats.rows[0];
    res.json({
      purchase_count: parseInt(pc.purchase_count) || 0,
      review_count: parseInt(rv.review_count) || 0,
      avg_rating: parseFloat(rv.avg_rating) || null
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GIFT CARDS (Feature 16) ───────────────────────────────────────────────────
pool.query(`CREATE TABLE IF NOT EXISTS gift_cards (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  amount NUMERIC NOT NULL,
  balance NUMERIC NOT NULL,
  purchased_by TEXT,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});

app.post('/admin/gift-cards', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { amount, purchased_by } = req.body;
  if (!amount || parseFloat(amount) <= 0) return res.status(400).json({ error: 'amount required' });
  try {
    const crypto = require('crypto');
    const code = 'GC-' + crypto.randomBytes(2).toString('hex').toUpperCase() + '-' + crypto.randomBytes(2).toString('hex').toUpperCase();
    const r = await pool.query('INSERT INTO gift_cards (code, amount, balance, purchased_by) VALUES ($1,$2,$2,$3) RETURNING *', [code, parseFloat(amount), purchased_by||null]);
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/gift-cards', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT * FROM gift_cards ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/gift-cards/redeem', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const r = await pool.query("SELECT * FROM gift_cards WHERE code=$1 AND status='active'", [code.toUpperCase()]);
    if (!r.rows.length) return res.status(404).json({ error: 'Invalid or used gift card code' });
    const gc = r.rows[0];
    res.json({ valid: true, balance: parseFloat(gc.balance), amount: parseFloat(gc.amount), code: gc.code });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── PURCHASE ORDERS (Feature 17) ─────────────────────────────────────────────
pool.query(`CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  school_name TEXT,
  director_name TEXT,
  email TEXT,
  phone TEXT,
  po_number TEXT,
  products TEXT,
  total_amount NUMERIC,
  notes TEXT,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});

app.post('/purchase-orders', async (req, res) => {
  const { school_name, director_name, email, phone, po_number, products: poProducts, total_amount, notes } = req.body;
  if (!school_name || !director_name || !email) return res.status(400).json({ error: 'school_name, director_name, and email are required' });
  try {
    const r = await pool.query(
      'INSERT INTO purchase_orders (school_name, director_name, email, phone, po_number, products, total_amount, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [school_name, director_name, email, phone||'', po_number||'', poProducts||'', total_amount||0, notes||'']
    );
    try {
      const mailer = getMailer();
      await mailer.emails.send({
        from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
        to: process.env.SMTP_USER || process.env.EMAIL_FROM || 'orders@lionandlambpublishing.com',
        subject: 'New Purchase Order — ' + school_name + (po_number ? ' PO#' + po_number : ''),
        html: '<h2>New Purchase Order</h2><p><strong>School:</strong> ' + school_name + '</p><p><strong>Director:</strong> ' + director_name + '</p><p><strong>Email:</strong> ' + email + '</p><p><strong>Phone:</strong> ' + (phone||'N/A') + '</p><p><strong>PO#:</strong> ' + (po_number||'N/A') + '</p><p><strong>Products:</strong> ' + (poProducts||'N/A') + '</p><p><strong>Total:</strong> $' + parseFloat(total_amount||0).toFixed(2) + '</p><p><strong>Notes:</strong> ' + (notes||'N/A') + '</p>'
      });
    } catch(e) { console.error('PO admin email error:', e.message); }
    res.json({ ok: true, id: r.rows[0].id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SHIPMENT TRACKING EMAIL (Feature 18) ─────────────────────────────────────
app.post('/admin/shipments/:id/notify', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const orderRes = await pool.query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    if (!orderRes.rows.length) return res.status(404).json({ error: 'Shipment/order not found' });
    const order = orderRes.rows[0];
    if (!order.tracking_number) return res.status(400).json({ error: 'No tracking number on this order' });
    const items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
    const mailer = getMailer();
    await mailer.emails.send({
      from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
      to: order.customer_email,
      subject: 'Your Lion and Lamb Publishing Order Has Shipped!',
      html: buildShippingEmailHtml(order.customer_name, items, order.tracking_number, order.tracking_url, order.carrier||'Carrier', order.service||'')
    });
    res.json({ ok: true, sent_to: order.customer_email });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ABANDONED CARTS (Feature 19) ──────────────────────────────────────────────
pool.query(`CREATE TABLE IF NOT EXISTS abandoned_carts (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  cart_data JSONB,
  reminded BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});

app.post('/cart/save', async (req, res) => {
  const { email, cart_data } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    await pool.query(
      'INSERT INTO abandoned_carts (email, cart_data, updated_at) VALUES ($1,$2,NOW()) ON CONFLICT (email) DO UPDATE SET cart_data=$2, updated_at=NOW(), reminded=FALSE',
      [email.toLowerCase(), JSON.stringify(cart_data||[])]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/abandoned-carts', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT id, email, cart_data, reminded, created_at, updated_at FROM abandoned_carts ORDER BY updated_at DESC LIMIT 100');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/abandoned-carts/:id/remind', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT * FROM abandoned_carts WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const cart = r.rows[0];
    const items = cart.cart_data || [];
    const itemList = Array.isArray(items) ? items.map(i => '<li>' + (i.title||'Item') + ' — $' + parseFloat(i.price||0).toFixed(2) + '</li>').join('') : '';
    const cartB64 = Buffer.from(JSON.stringify(cart.cart_data || [])).toString('base64');
    const cartUrl = 'https://lionandlambpublishing.com/cart.html?restore=' + encodeURIComponent(cartB64);
    const mailer = getMailer();
    const sendResult = await mailer.emails.send({
      from: process.env.EMAIL_FROM || 'Lion and Lamb Publishing <orders@lionandlambpublishing.com>',
      to: cart.email,
      subject: 'You left something behind — Lion and Lamb Publishing',
      html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px">
        <h2 style="font-size:1.4rem;margin-bottom:8px">You left something behind 🎵</h2>
        <p style="color:#555;margin-bottom:20px">You have items waiting in your cart at Lion and Lamb Publishing:</p>
        <ul style="padding-left:20px;margin-bottom:24px;color:#333">${itemList}</ul>
        <a href="${cartUrl}" style="display:inline-block;padding:12px 28px;background:#3ab54a;color:#fff;text-decoration:none;border-radius:6px;font-weight:700">Complete My Purchase →</a>
        <p style="margin-top:28px;font-size:0.78rem;color:#aaa">Lion and Lamb Publishing · <a href="https://lionandlambpublishing.com" style="color:#aaa">lionandlambpublishing.com</a></p>
      </div>`
    });
    if (sendResult.error) throw new Error(sendResult.error.message || 'Email send failed');
    await pool.query('UPDATE abandoned_carts SET reminded=TRUE WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── LICENSE TRACKER (Feature 20) ─────────────────────────────────────────────
app.get('/admin/licenses', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query(`
      SELECT
        p.id,
        p.title,
        p.composer,
        p.format,
        COUNT(o.id) as copies_sold,
        COALESCE(SUM(o.amount_total), 0) as total_revenue_cents
      FROM products p
      LEFT JOIN orders o ON o.items::text LIKE '%"id":' || p.id || ',%' OR o.items::text LIKE '%"id":' || p.id || '}%'
      GROUP BY p.id, p.title, p.composer, p.format
      ORDER BY copies_sold DESC
    `);
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── BLOG (Feature 12) ─────────────────────────────────────────────────────────
pool.query(`CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  excerpt TEXT,
  content TEXT,
  image_url TEXT,
  published BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
)`).catch(() => {});

app.get('/blog', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, title, slug, excerpt, image_url, created_at FROM posts WHERE published=TRUE ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/blog/:slug', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM posts WHERE slug=$1 AND published=TRUE', [req.params.slug]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

async function notifyZapier(post) {
  const zapierUrl = process.env.ZAPIER_WEBHOOK_URL;
  if (!zapierUrl || !post.published) return;
  try {
    const postUrl = 'https://lionandlambpublishing.com/blog-post.html?slug=' + encodeURIComponent(post.slug);
    await fetch(zapierUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: post.title,
        excerpt: post.excerpt || '',
        image_url: post.image_url || '',
        post_url: postUrl,
        slug: post.slug
      })
    });
    console.log('Zapier notified for post:', post.slug);
  } catch (e) { console.error('Zapier webhook error:', e.message); }
}

app.post('/admin/blog', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { title, slug, excerpt, content, image_url, published } = req.body;
  if (!title || !slug) return res.status(400).json({ error: 'title and slug required' });
  try {
    const r = await pool.query('INSERT INTO posts (title, slug, excerpt, content, image_url, published) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *', [title, slug, excerpt||null, content||null, image_url||null, published||false]);
    const post = r.rows[0];
    notifyZapier(post);
    res.json(post);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/blog', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const r = await pool.query('SELECT * FROM posts ORDER BY created_at DESC');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/admin/blog/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  const { title, slug, excerpt, content, image_url, published } = req.body;
  try {
    // Check if it was previously unpublished so we only ping Zapier on first publish
    const prev = await pool.query('SELECT published FROM posts WHERE id=$1', [req.params.id]);
    const wasUnpublished = prev.rows.length && !prev.rows[0].published;
    const r = await pool.query('UPDATE posts SET title=$1, slug=$2, excerpt=$3, content=$4, image_url=$5, published=$6, updated_at=NOW() WHERE id=$7 RETURNING *', [title, slug, excerpt||null, content||null, image_url||null, published||false, req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const post = r.rows[0];
    // Only notify Zapier when newly publishing (not on every edit)
    if (published && wasUnpublished) notifyZapier(post);
    res.json(post);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/blog/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    await pool.query('DELETE FROM posts WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(3000, () => console.log('Server running on port 3000'));
