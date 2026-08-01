require('dotenv').config({path:'/var/www/html/.env'});
const {S3Client,GetObjectCommand} = require('@aws-sdk/client-s3');
const {execSync} = require('child_process');
const {Client} = require('pg');
const fs = require('fs');
const path = require('path');

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
  {id:7, key:'We Are Christmas BELLS Score.pdf', slug:'we-are-christmas-bells'},
];

async function run() {
  await db.connect();
  for (const p of products) {
    try {
      console.log('Processing:', p.key);
      const tmpPdf = '/tmp/preview_'+p.id+'.pdf';
      const tmpPng = '/tmp/preview_'+p.id;
      const imgDest = '/var/www/html/img/score-preview-'+p.slug+'.png';

      // Download PDF from Spaces
      const cmd = new GetObjectCommand({Bucket:process.env.SPACES_BUCKET, Key:p.key});
      const res = await s3.send(cmd);
      const chunks = [];
      for await (const chunk of res.Body) chunks.push(chunk);
      fs.writeFileSync(tmpPdf, Buffer.concat(chunks));

      // Convert first page to PNG
      execSync('pdftoppm -r 150 -png -f 1 -l 1 '+tmpPdf+' '+tmpPng);
      fs.copyFileSync(tmpPng+'-1.png', imgDest);
      fs.unlinkSync(tmpPdf);
      fs.unlinkSync(tmpPng+'-1.png');

      // Update image_url in DB
      const imgUrl = '/img/score-preview-'+p.slug+'.png';
      await db.query('UPDATE products SET image_url= WHERE id=', [imgUrl, p.id]);
      console.log('Done:', imgUrl);
    } catch(e) {
      console.error('Error on', p.key, e.message);
    }
  }
  await db.end();
}

run();
