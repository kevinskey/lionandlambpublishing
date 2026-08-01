require('dotenv').config();
const {S3Client,GetObjectCommand} = require('@aws-sdk/client-s3');
const {execSync} = require('child_process');
const {Client} = require('pg');
const fs = require('fs');

const s3 = new S3Client({
  region: process.env.SPACES_REGION,
  endpoint: 'https://'+process.env.SPACES_REGION+'.digitaloceanspaces.com',
  credentials: {accessKeyId:process.env.SPACES_KEY, secretAccessKey:process.env.SPACES_SECRET}
});

const db = new Client({
  host:'localhost', port:5432,
  database: process.env.DB_NAME || 'fortemusic',
  user: process.env.DB_USER || 'forteadmin',
  password: process.env.DB_PASSWORD
});

const products = [
  {id:1, key:'All Time Belongs To Him.pdf', slug:'all-time-belongs-to-him'},
  {id:3, key:'RS WHY HAVE YOU ABANDONED ME.pdf', slug:'why-have-you-abandoned-me'},
  {id:4, key:'Adamski Jazz Mass Score.pdf', slug:'adamski-jazz-mass'},
  {id:5, key:'We Are Christmas latest SATB.pdf', slug:'we-are-christmas-satb'},
  {id:6, key:'We Are Christmas latest SSAA.pdf', slug:'we-are-christmas-ssaa'},
];

function findPng(base) {
  for (const suffix of ['-1.png','-01.png','-001.png']) {
    if (fs.existsSync(base+suffix)) return base+suffix;
  }
  return null;
}

async function run() {
  await db.connect();
  for (const p of products) {
    try {
      console.log('Processing:', p.key);
      const tmpPdf = '/tmp/p'+p.id+'.pdf';
      const tmpBase = '/tmp/p'+p.id;
      const imgDest = '/var/www/html/img/score-preview-'+p.slug+'.png';

      if (!fs.existsSync(imgDest)) {
        const res = await s3.send(new GetObjectCommand({Bucket:process.env.SPACES_BUCKET, Key:p.key}));
        const chunks = [];
        for await (const chunk of res.Body) chunks.push(chunk);
        fs.writeFileSync(tmpPdf, Buffer.concat(chunks));
        execSync('pdftoppm -r 150 -png -f 1 -l 1 '+tmpPdf+' '+tmpBase);
        const found = findPng(tmpBase);
        if (!found) throw new Error('No PNG generated');
        fs.copyFileSync(found, imgDest);
        fs.unlinkSync(tmpPdf);
        fs.unlinkSync(found);
      }

      const imgUrl = '/img/score-preview-'+p.slug+'.png';
      const res = await db.query('UPDATE products SET image_url =  WHERE id =  RETURNING id', [imgUrl, p.id]);
      console.log('Updated product', p.id, '->', imgUrl, '| rows:', res.rowCount);
    } catch(e) {
      console.error('Error on', p.key, e.message);
    }
  }
  await db.end();
}

run();
