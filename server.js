require('dotenv').config();
const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const cors = require('cors');
const { Pool } = require('pg');
const { S3Client, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
app.use(cors({ origin: 'https://lionandlambpublishing.com' }));
app.use(express.json());

const pool = new Pool({
  user: 'forteadmin',
  host: 'localhost',
  database: 'fortemusic',
  password: process.env.DB_PASSWORD,
  port: 5432,
});

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
    const cmd = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType, ACL: 'public-read' });
    const url = await getSignedUrl(s3, cmd, { expiresIn: 3600 });
    res.json({ uploadUrl: url, publicUrl: SPACES_BASE + '/' + key });
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
    const { ensemble, grade, search } = req.query;
    let query = 'SELECT * FROM products WHERE 1=1';
    const params = [];
    if (ensemble) { params.push(ensemble); query += ' AND ensemble=$' + params.length; }
    if (grade) { params.push(grade); query += ' AND grade=$' + params.length; }
    if (search) { params.push('%' + search + '%'); query += ' AND (title ILIKE $' + params.length + ' OR composer ILIKE $' + params.length + ')'; }
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
app.post('/admin/products', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, stripe_price_print, stripe_price_pdf, stripe_price_bundle, audio_url, pdf_preview_url, image_url, video_url, featured } = req.body;
    const result = await pool.query(
      'INSERT INTO products (title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, stripe_price_print, stripe_price_pdf, stripe_price_bundle, audio_url, pdf_preview_url, image_url, video_url, featured) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
      [title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, stripe_price_print, stripe_price_pdf, stripe_price_bundle, audio_url, pdf_preview_url, image_url, video_url, featured||false]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin: update product
app.put('/admin/products/:id', async (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, stripe_price_print, stripe_price_pdf, stripe_price_bundle, audio_url, pdf_preview_url, image_url, video_url, featured } = req.body;
    const result = await pool.query(
      'UPDATE products SET title=$1, composer=$2, ensemble=$3, grade=$4, format=$5, price_print=$6, price_pdf=$7, price_bundle=$8, stripe_price_print=$9, stripe_price_pdf=$10, stripe_price_bundle=$11, audio_url=$12, pdf_preview_url=$13, image_url=$14, video_url=$15, featured=$16 WHERE id=$17 RETURNING *',
      [title, composer, ensemble, grade, format, price_print, price_pdf, price_bundle, stripe_price_print, stripe_price_pdf, stripe_price_bundle, audio_url, pdf_preview_url, image_url, video_url, featured||false, req.params.id]
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

// Stripe checkout
app.post('/create-checkout-session', async (req, res) => {
  const { items } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: items,
      mode: 'payment',
      success_url: process.env.DOMAIN + '/success.html',
      cancel_url: process.env.DOMAIN + '/cart.html',
    });
    res.json({ url: session.url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(3000, () => console.log('Server running on port 3000'));
